"""Backfill: save the diffs of existing experiments and explain their results from the code change.

Experiments judged before diffs were saved keep their code only in git (branch ``r2e/exp-<id>-<flag>`` and the
worktree ``data/r2e/worktrees/exp-<id>``). This saves each iteration's diff where its commit still exists, sets
``build['code_changes']`` to the measured iteration's summary and adds ``details['code_effect']`` to the verdict.
Updates merge into the JSONB columns, so they never overwrite what the worker writes at the same time.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Optional

from sqlalchemy import select, text

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Experiment, Verdict
from paperatlas.lab import changes as code_changes
from paperatlas.lab import effect as code_effect
from paperatlas.lab import service
from paperatlas.lab.workspace import WorkspaceError

# The worker owns these experiments' build (and soon their verdict): leave them to it.
BUSY_STATUSES = ("approving", "building", "smoke_testing", "tuning", "waiting_gpu", "running", "judging", "finalizing", "cancelling")


def _merge_json(table: str, column: str, key_column: str, key: int, values: dict[str, Any]) -> None:
    with session_scope() as session:
        session.execute(
            text(f"UPDATE {table} SET {column} = coalesce({column}, '{{}}'::jsonb) || CAST(:values AS jsonb) WHERE {key_column} = :key"),
            {"values": json.dumps(values, default=str), "key": key},
        )


def save_diffs(experiment_id: int, context: dict[str, Any], force: bool = False) -> tuple[list[int], Optional[int]]:
    """Save every iteration whose commit still exists; returns (iterations saved now, the measured iteration)."""
    experiment = context["experiment"]
    build = experiment.get("build") or {}
    repo = context["project"]["repo_path"]
    worktree = context["worktree"]
    branch = experiment.get("branch")
    flag = experiment.get("flag_name") or (context["spec"] or {}).get("flag_name")
    base_branch = (context["profile"].get("repo") or {}).get("branch") or "main"
    merge_sha = build.get("merge_sha")
    existing = set(code_changes.stored_iterations(experiment_id))
    saved: list[int] = []
    for entry in build.get("iterations") or []:
        number, sha = entry.get("iteration"), entry.get("sha")
        if not number or not sha or (number in existing and not force) or not code_changes.commit_exists(repo, sha):
            continue
        base = code_changes.base_for(repo, worktree, sha, base_branch, merge_sha)
        if base:
            code_changes.record(experiment_id, repo, base, number, sha, flag, source="backfill")
            saved.append(number)
    measured = build.get("kept_iteration") or build.get("iteration") or (1 if branch else None)
    if measured and measured not in saved and (force or measured not in existing):
        located = code_changes.locate(repo, worktree, branch, base_branch, merge_sha)
        if located:
            git_dir, base, head = located
            code_changes.record(experiment_id, git_dir, base, measured, head, flag, source="backfill")
            saved.append(measured)
    return sorted(saved), measured


def backfill_code_changes(
    experiment_ids: Optional[list[int]] = None,
    explain: bool = True,
    use_llm: bool = True,
    force: bool = False,
    say: Callable[[str], None] = print,
) -> dict[str, int]:
    from paperatlas.llm.client import build_default_llm_client

    with session_scope() as session:
        query = select(Experiment.id).order_by(Experiment.id)
        if experiment_ids:
            query = query.where(Experiment.id.in_(experiment_ids))
        ids = list(session.scalars(query).all())
    llm = build_default_llm_client() if explain and use_llm else None
    counts = {"experiments": 0, "diffs": 0, "explained": 0, "skipped": 0, "no_diff": 0}
    for experiment_id in ids:
        context = service.experiment_context(experiment_id)
        status = context["experiment"]["status"]
        if status in BUSY_STATUSES:
            counts["skipped"] += 1
            say(f"#{experiment_id}: skipped ({status}; its diff is saved when the build is verified)")
            continue
        counts["experiments"] += 1
        try:
            saved, measured = save_diffs(experiment_id, context, force)
        except WorkspaceError as exc:
            saved, measured = [], None
            say(f"#{experiment_id}: could not read git: {str(exc).splitlines()[0]}")
        counts["diffs"] += len(saved)
        # The verdict's own iteration is the code that was measured (an experiment that stopped mid-loop has a
        # newer build whose numbers were never judged).
        measured = _verdict_iteration(experiment_id) or measured
        summary = code_changes.load_summary(experiment_id, measured) if measured else None
        stored = code_changes.stored_iterations(experiment_id)
        if summary is None and stored:
            measured = stored[-1]
            summary = code_changes.load_summary(experiment_id, measured)
        if summary:
            _merge_json("lab.experiments", "build", "id", experiment_id, {"code_changes": code_changes.light(summary)})
        else:
            counts["no_diff"] += 1
        line = f"#{experiment_id} ({status}): " + (
            f"saved iteration{'s' if len(saved) > 1 else ''} {', '.join(map(str, saved))}" if saved
            else ("diff already saved" if summary else "no diff: branch and worktree are gone" if context["experiment"].get("branch") else "nothing built")
        )
        if explain:
            note, explained = _explain(experiment_id, context, measured, llm, force)
            line += f"; {note}"
            counts["explained"] += explained
        say(line)
    return counts


def _verdict_iteration(experiment_id: int) -> Optional[int]:
    with session_scope() as session:
        details = session.scalar(select(Verdict.details).where(Verdict.experiment_id == experiment_id)) or {}
    iteration = details.get("iteration") if isinstance(details, dict) else None
    return int(iteration) if isinstance(iteration, (int, float)) else None


def _explain(experiment_id: int, context: dict[str, Any], measured: Optional[int], llm, force: bool) -> tuple[str, bool]:
    loaded = code_changes.load(experiment_id, measured) if measured else None
    summary, patch = (code_changes.light(loaded[0]), loaded[1]) if loaded else (None, None)
    with session_scope() as session:
        verdict = session.scalar(select(Verdict).where(Verdict.experiment_id == experiment_id))
        if verdict is None:
            return "no verdict to explain", False
        details = dict(verdict.details or {})
        existing = details.get("code_effect")
        # An explanation written without (or for another) diff is regenerated once the diff is saved.
        if existing and not force and existing.get("head") == (summary or {}).get("head"):
            return "already explained", False
        data = {
            **details,
            "verdict": verdict.verdict,
            "primary_metric": verdict.primary_metric,
            "median_delta_pct": verdict.median_delta_pct,
            "ci_low_pct": verdict.ci_low_pct,
            "ci_high_pct": verdict.ci_high_pct,
            "quality_ok": verdict.quality_ok,
        }
    result = code_effect.explain(
        data, context["spec"] or {}, context["claim"], summary, patch, llm, details.get("analysis"), details.get("tuning")
    )
    _merge_json("lab.verdicts", "details", "experiment_id", experiment_id, {"code_effect": result})
    return f"explained: {result['outcome'].replace('_', ' ')} ({result['source']})", True
