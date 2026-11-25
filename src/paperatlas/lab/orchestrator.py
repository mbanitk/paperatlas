"""LangGraph orchestration.

Triage graph (per project):  topics? → discover → distill → match → shortlist   (then Gate 1: pick)
Experiment graph (per claim): plan → [Gate 2: approve spec] → build → smoke → tune → run → judge
                              → (fixable? back to build, ≤ max_iterations) → [Gate 3: merge or drop] → finalize

run = claim check (method vs the paper's baseline, paper-like workload) + adoption check (method vs the project's
default, project workload); judge = verdicts + mechanism counters + an analyst diagnosis (see lab/protocol.py).

Gates are LangGraph interrupts; state is checkpointed in Postgres (schema `agent`), so a
worker restart continues from the last completed step. The experiment row in `lab.experiments`
is the source of truth for the UI (status, spec, build, verdict).
"""

from __future__ import annotations

import logging
import time
import traceback
from contextlib import contextmanager
from datetime import UTC, datetime
from functools import wraps
from typing import Any, Callable, Iterator, Optional, TypedDict

import psycopg
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from sqlalchemy import case, select, update

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Experiment, Run, Topic, Triage, Verdict
from paperatlas.lab import changes as code_changes
from paperatlas.lab import effect as code_effect
from paperatlas.lab import service
from paperatlas.lab.analyst import analyse, fidelity_notes
from paperatlas.lab.builder import build_experiment, ensure_protected_paths
from paperatlas.lab.costmodel import summarize as summarize_roofline
from paperatlas.lab.events import reporter
from paperatlas.lab.judge import judge
from paperatlas.lab.planner import plan_experiment
from paperatlas.lab.profiler import register_project
from paperatlas.lab.process import Cancelled, WorkerShutdown, shutting_down
from paperatlas.lab.report import render_report
from paperatlas.lab.protocol import needs_adoption_run, spec_defaults
from paperatlas.lab.runner import run_benchmark, tune
from paperatlas.lab.workspace import (
    artifacts_dir,
    commit_all,
    create_worktree,
    git,
    merge_branch,
    remove_worktree,
)
from paperatlas.llm.client import build_default_llm_client
from paperatlas.settings import libpq_url

logger = logging.getLogger(__name__)


def agent_db_url() -> str:
    url = libpq_url()
    return url + ("&" if "?" in url else "?") + "options=-csearch_path%3Dagent"


@contextmanager
def checkpointer() -> Iterator[PostgresSaver]:
    with PostgresSaver.from_conn_string(agent_db_url()) as saver:
        yield saver


def setup_checkpointer() -> None:
    with checkpointer() as saver:
        saver.setup()


# ---- helpers ------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(UTC)


CANCEL_STATUSES = ("cancelling", "cancelled")


def _guarded_status(status: str):
    """Status writes from graph nodes never overwrite a user's cancel (a failure while cancelling
    becomes 'cancelled'; a completed merge/drop still wins) and never move an experiment out of 'merged'."""
    keep = Experiment.status
    if status in ("merged", "dropped"):
        # The repo already reflects the outcome, so it wins over a late cancel.
        return case((Experiment.status == "merged", keep), else_=status)
    on_cancel = "cancelled" if status in ("failed", "cancelled") else keep
    return case((Experiment.status == "merged", keep), (Experiment.status.in_(CANCEL_STATUSES), on_cancel), else_=status)


def set_experiment(experiment_id: int, **values: Any) -> None:
    if "status" in values:
        values["status"] = _guarded_status(values["status"])
    with session_scope() as session:
        session.execute(
            update(Experiment).where(Experiment.id == experiment_id).values(updated_at=_now(), **values)
        )


def cancel_checker(experiment_id: int) -> Callable[[], bool]:
    cache = {"at": 0.0, "value": False}

    def should_cancel() -> bool:
        now = time.monotonic()
        if now - cache["at"] > 2.0:
            with session_scope() as session:
                status = session.scalar(select(Experiment.status).where(Experiment.id == experiment_id))
            cache.update(at=now, value=status in ("cancelling", "cancelled"))
        return cache["value"]

    return should_cancel


def _raise_if_cancelled(experiment_id: int) -> None:
    if shutting_down():
        raise WorkerShutdown("worker is shutting down")
    if cancel_checker(experiment_id)():
        raise Cancelled("cancelled by user")


EXPERIMENT_LOCK_NS = 7_242


@contextmanager
def experiment_lock(experiment_id: int, poll_s: float = 2.0) -> Iterator[None]:
    """At most one graph execution per experiment, even if a stale job was reclaimed while its
    old executor is still alive (the queue already avoids claiming jobs of a busy experiment)."""
    with psycopg.connect(libpq_url(), autocommit=True) as conn:
        waited = False
        while not conn.execute(
            "SELECT pg_try_advisory_lock(%s, %s)", (EXPERIMENT_LOCK_NS, experiment_id)
        ).fetchone()[0]:
            if not waited:
                logger.warning("Experiment %s is being advanced by another executor; waiting", experiment_id)
                waited = True
            if shutting_down():
                raise WorkerShutdown("worker is shutting down")
            time.sleep(poll_s)
        try:
            yield
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s, %s)", (EXPERIMENT_LOCK_NS, experiment_id))


def experiment_step(stage: str) -> Callable:
    """Record failures/cancellation on the experiment row and in events, then re-raise
    so the job fails and the checkpoint stays before this step (retry continues here)."""

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(state: dict) -> dict:
            experiment_id = state["experiment_id"]
            report = reporter(experiment_id=experiment_id)
            try:
                _raise_if_cancelled(experiment_id)
                set_experiment(experiment_id, error=None)
                return func(state, report)
            except WorkerShutdown:
                report(stage, f"Interrupted during {stage} by a worker shutdown; it resumes here", None, level="warning")
                raise
            except Cancelled as exc:
                set_experiment(experiment_id, status="cancelled", error=f"{stage}: {exc}")
                report(stage, f"Cancelled during {stage}", None, level="warning")
                raise
            except Exception as exc:  # noqa: BLE001 - surfaced to the UI and re-raised
                if type(exc).__name__ == "GraphInterrupt":
                    raise
                set_experiment(experiment_id, status="failed", error=f"{stage}: {exc}")
                report(stage, f"{stage} failed: {exc}", {"traceback": traceback.format_exc()[-4000:]}, level="error")
                raise

        return wrapper

    return decorator


# ---- experiment graph -----------------------------------------------------------


class ExperimentState(TypedDict, total=False):
    experiment_id: int
    decision: Optional[str]
    feedback: Optional[str]
    iteration: int
    iterate: bool


@experiment_step("plan")
def node_plan(state: ExperimentState, report) -> dict:
    experiment_id = state["experiment_id"]
    context = service.experiment_context(experiment_id)
    set_experiment(experiment_id, status="planning", error=None)
    rerun_of = context["experiment"].get("rerun_of_experiment_id")
    if rerun_of and context["spec"] and not state.get("feedback"):
        spec = _reuse_spec(context)
        _raise_if_cancelled(experiment_id)
        set_experiment(experiment_id, spec=spec, flag_name=spec["flag_name"], status="awaiting_approval")
        report("approve", f"Spec copied from #{rerun_of} — waiting for approval (Gate 2)", {"spec": spec})
        return {"feedback": None}
    report("plan", "Writing the experiment spec", None)
    llm = build_default_llm_client()
    if context["experiment"].get("depends_on_experiment_id"):
        register_project(context["project"]["repo_path"], context["project"]["name"])
        context = service.experiment_context(experiment_id)
    spec = plan_experiment(
        {
            **context["claim"],
            "bundle": context["bundle"],
            "prediction": (context["match"] or {}).get("prediction"),
            "roofline_summary": summarize_roofline(context.get("roofline")),
        },
        context["profile"],
        context["match"].get("target_metric") if context["match"] else None,
        llm,
        feedback=state.get("feedback") or service.rerun_feedback(experiment_id),
        companions=context["bundle"],
        baseline_flags=context["prerequisite_flags"],
    )
    _raise_if_cancelled(experiment_id)
    set_experiment(experiment_id, spec=spec, flag_name=spec["flag_name"], status="awaiting_approval")
    report("approve", "Spec ready — waiting for approval (Gate 2)", {"spec": spec})
    return {"feedback": None}


def _reuse_spec(context: dict) -> dict:
    """A previous run's spec, refreshed for the project as it is now (techniques, prerequisites, prediction)."""
    from paperatlas.lab.planner import ExperimentSpec, unique_flag_name

    spec = ExperimentSpec.model_validate(context["spec"])
    spec.flag_name = unique_flag_name(spec.flag_name, {t.get("name") for t in context["profile"].get("techniques") or []})
    spec.baseline_flags = list(context["prerequisite_flags"])
    spec.prediction = (context["match"] or {}).get("prediction")
    return spec.model_dump()


def _gate_cancel_check(experiment_id: int, stage: str) -> None:
    try:
        _raise_if_cancelled(experiment_id)
    except WorkerShutdown:
        raise
    except Cancelled as exc:
        set_experiment(experiment_id, status="cancelled", error=f"{stage}: {exc}")
        reporter(experiment_id=experiment_id)(stage, f"Cancelled before {stage}", None, level="warning")
        raise


def _gate_response(response: Any, gate: str, decisions: tuple[str, ...]) -> dict:
    """run_experiment only resumes a gate with a payload for that gate; this is a last check."""
    if not isinstance(response, dict) or response.get("gate") != gate or response.get("decision") not in decisions:
        raise ValueError(f"resume payload {response!r} does not match gate {gate!r} (expected one of {decisions})")
    return response


def node_gate_spec(state: ExperimentState) -> dict:
    experiment_id = state["experiment_id"]
    _gate_cancel_check(experiment_id, "approve")
    set_experiment(experiment_id, status="awaiting_approval")
    response = interrupt({"gate": "approve_spec", "experiment_id": experiment_id})
    response = _gate_response(response, "approve_spec", ("approve", "revise", "reject"))
    decision = response.get("decision")
    report = reporter(experiment_id=experiment_id)
    if decision == "approve":
        values: dict[str, Any] = {"status": "building"}
        if response.get("spec"):
            values.update(spec=response["spec"], flag_name=response["spec"]["flag_name"])
        set_experiment(experiment_id, **values)
        report("approve", "Spec approved", {"comment": response.get("comment")})
    elif decision == "revise":
        set_experiment(experiment_id, status="planning")
        report("approve", "Revision requested", {"comment": response.get("comment")})
    else:
        report("approve", "Spec rejected", {"comment": response.get("comment")}, level="warning")
    return {"decision": decision, "feedback": response.get("comment")}


def route_after_spec(state: ExperimentState) -> str:
    return {"approve": "build", "revise": "plan"}.get(state.get("decision") or "", "rejected")


def node_rejected(state: ExperimentState) -> dict:
    set_experiment(state["experiment_id"], status="rejected")
    service.release_dependents(state["experiment_id"], merged=False)
    return {}


@experiment_step("build")
def node_build(state: ExperimentState, report) -> dict:
    experiment_id = state["experiment_id"]
    context = service.experiment_context(experiment_id)
    spec, profile = context["spec"], context["profile"]
    base = (profile.get("repo") or {}).get("branch") or "main"
    worktree, branch = create_worktree(context["project"]["repo_path"], experiment_id, spec["flag_name"], base)
    set_experiment(experiment_id, status="building", branch=branch, worktree_path=str(worktree))
    iteration = int(state.get("iteration") or 1)
    previous = context["experiment"].get("build") or {}
    feedback = state.get("feedback") if state.get("iterate") else None
    report(
        "build",
        f"Worktree ready on branch {branch}" + (f" — iteration {iteration}: applying the analyst's changes" if feedback else ""),
        {"worktree": str(worktree)},
    )
    info = build_experiment(
        experiment_id,
        worktree,
        spec,
        {**context["claim"], "bundle": context["bundle"]},
        profile,
        artifacts_dir(experiment_id),
        report,
        cancel_checker(experiment_id),
        initial_feedback=feedback,
    )
    info["iteration"] = iteration
    if previous.get("iterations"):
        info["iterations"] = previous["iterations"]
    info["code_changes"] = _record_changes(experiment_id, worktree, base, iteration, spec["flag_name"], report)
    set_experiment(experiment_id, build=info, status="smoke_testing")
    return {"iterate": False, "feedback": None}


def _record_changes(
    experiment_id: int, worktree, base: str, iteration: int, flag: str, report, head: str = "HEAD"
) -> Optional[dict]:
    """Persist the verified build's diff (branches and worktrees don't outlive a drop); never fails the build."""
    try:
        summary = code_changes.record(
            experiment_id, worktree, code_changes.base_ref(worktree, base), iteration, head, flag, source="build"
        )
    except Exception as exc:  # noqa: BLE001 - the diff is a record, not a prerequisite
        report("build", f"Could not save the diff of iteration {iteration}: {exc}", None, level="warning")
        return None
    report(
        "build",
        f"Saved the diff of iteration {iteration}: {summary['files_changed']} files, +{summary['additions']} −{summary['deletions']}",
        {"iteration": iteration, "files_changed": summary["files_changed"]},
    )
    return code_changes.light(summary)


def _iteration_changes(context: dict, iteration: int, sha: Optional[str], report) -> Optional[dict]:
    """The saved diff summary of an iteration, saving it now if its build predates diff saving."""
    experiment_id = context["experiment"]["id"]
    summary = code_changes.load_summary(experiment_id, iteration)
    worktree = context["worktree"]
    if summary is None and worktree and worktree.exists() and code_changes.commit_exists(worktree, sha or "HEAD"):
        base = (context["profile"].get("repo") or {}).get("branch") or "main"
        flag = context["spec"].get("flag_name") or context["experiment"].get("flag_name")
        summary = _record_changes(experiment_id, worktree, base, iteration, flag, report, head=sha or "HEAD")
    return summary


def _kept_changes(experiment_id: int, iteration: int, build: dict) -> tuple[Optional[dict], Optional[str]]:
    """Summary and patch of the measured (kept) iteration's code, from the saved diff."""
    stored = code_changes.load(experiment_id, iteration)
    if stored:
        return code_changes.light(stored[0]), stored[1]
    current = build.get("code_changes")
    if current and current.get("iteration") in (None, iteration):
        return current, None
    return None, None


def _explain_result(experiment_id: int, verdict: dict, spec: dict, claim: dict, changes, patch, llm, analysis, tuning, report) -> Optional[dict]:
    try:
        return code_effect.explain(verdict, spec, claim, changes, patch, llm, analysis, tuning)
    except Exception as exc:  # noqa: BLE001 - the explanation must never block Gate 3
        report("judge", f"Could not explain the result from the code change: {exc}", None, level="warning")
        return None


@experiment_step("smoke")
def node_smoke(state: ExperimentState, report) -> dict:
    experiment_id = state["experiment_id"]
    context = service.experiment_context(experiment_id)
    set_experiment(experiment_id, status="smoke_testing")
    ensure_protected_paths(context["worktree"], context["profile"])
    results = run_benchmark(
        experiment_id,
        "smoke",
        context["worktree"],
        context["spec"],
        context["profile"],
        artifacts_dir(experiment_id),
        report,
        cancel_checker(experiment_id),
    )
    agreement = (results.get("quality") or {}).get("output_agreement")
    if context["spec"].get("lossless") and agreement is not None and agreement < 1.0:
        report("smoke", f"Lossless technique changed outputs on the smoke model (agreement {agreement:.2f})", None, level="warning")
    report("smoke", "Smoke A/B passed on the small model", None)
    expected = [m["name"] for m in context["spec"].get("mechanism") or [] if m.get("name")]
    flag = context["spec"]["flag_name"]
    reported = (((results.get("mechanism") or {}).get("variant") or {}).get("techniques") or {}).get(flag) or {}
    missing = [name for name in expected if name not in reported]
    if missing:
        report("smoke", f"The technique did not report mechanism counters {missing}; the verdict will not be able to say why", None, level="warning")
    set_experiment(experiment_id, status="tuning")
    return {}


@experiment_step("tune")
def node_tune(state: ExperimentState, report) -> dict:
    experiment_id = state["experiment_id"]
    context = service.experiment_context(experiment_id)
    spec = spec_defaults(context["spec"])
    set_experiment(experiment_id, status="tuning")
    chosen = tune(
        experiment_id,
        context["worktree"],
        spec,
        context["profile"],
        artifacts_dir(experiment_id),
        report,
        cancel_checker(experiment_id),
    )
    build = service.experiment_context(experiment_id)["experiment"].get("build") or {}
    set_experiment(experiment_id, build={**build, "tuning": chosen}, status="running")
    return {}


@experiment_step("run")
def node_run(state: ExperimentState, report) -> dict:
    experiment_id = state["experiment_id"]
    context = service.experiment_context(experiment_id)
    set_experiment(experiment_id, status="running")
    ensure_protected_paths(context["worktree"], context["profile"])
    spec = spec_defaults(context["spec"])
    tuning = (context["experiment"].get("build") or {}).get("tuning") or {}
    common = dict(
        workdir=context["worktree"],
        spec=spec,
        profile=context["profile"],
        artifacts=artifacts_dir(experiment_id),
        report=report,
        should_cancel=cancel_checker(experiment_id),
        baseline_config=tuning.get("baseline") or None,
        variant_config=tuning.get("variant") or None,
    )
    run_benchmark(experiment_id, "eval", **common)
    if needs_adoption_run(spec):
        run_benchmark(experiment_id, "adopt", **common)
    set_experiment(experiment_id, status="judging")
    return {}


def _strip_deltas(per_metric: dict[str, Any]) -> dict[str, Any]:
    return {name: {k: v for k, v in m.items() if k != "deltas"} for name, m in (per_metric or {}).items()}


def _iteration_entry(iteration: int, verdict: dict, analysis: dict, tuning: dict) -> dict[str, Any]:
    adoption = verdict.get("adoption") or {}
    return {
        "iteration": iteration,
        "verdict": verdict["verdict"],
        "reason": verdict["reason"],
        "median_delta_pct": verdict.get("median_delta_pct"),
        "ci_low_pct": verdict.get("ci_low_pct"),
        "ci_high_pct": verdict.get("ci_high_pct"),
        "adoption_verdict": adoption.get("verdict"),
        "adoption_median_delta_pct": adoption.get("median_delta_pct"),
        "diagnosis": analysis.get("diagnosis"),
        "summary": analysis.get("summary"),
        "next_changes": analysis.get("next_changes") if analysis.get("worth_iterating") else "",
        "tuned": {"baseline": tuning.get("baseline"), "variant": tuning.get("variant")} if tuning else None,
    }


def _score(entry: dict[str, Any]) -> float:
    """Ratchet score of an iteration: the claim-check median, but only if quality held."""
    if entry.get("quality_ok") is False or entry.get("median_delta_pct") is None:
        return float("-inf")
    return float(entry["median_delta_pct"])


def _judge_runs(experiment_id: int, spec: dict, profile: dict, eval_run_id: Optional[int], adopt_run_id: Optional[int]):
    results = service.run_results(eval_run_id) if eval_run_id else service.latest_results(experiment_id, "eval")
    adopt = service.run_results(adopt_run_id) if adopt_run_id else None
    return results, judge(results, spec, profile, adopt)


def _save_verdict(experiment_id: int, verdict: dict, report_path) -> None:
    with session_scope() as session:
        row = session.scalar(select(Verdict).where(Verdict.experiment_id == experiment_id)) or Verdict(
            experiment_id=experiment_id
        )
        row.verdict = verdict["verdict"]
        row.primary_metric = verdict["primary_metric"]
        row.median_delta_pct = verdict["median_delta_pct"]
        row.ci_low_pct = verdict["ci_low_pct"]
        row.ci_high_pct = verdict["ci_high_pct"]
        row.claimed_gain_pct = verdict["claimed_gain_pct"]
        row.quality_ok = verdict["quality_ok"]
        details = {k: v for k, v in verdict.items() if k not in ("per_metric", "adoption")}
        details["per_metric"] = _strip_deltas(verdict["per_metric"])
        if verdict.get("adoption"):
            details["adoption"] = {**verdict["adoption"], "per_metric": _strip_deltas(verdict["adoption"]["per_metric"])}
        row.details = details
        row.report_path = str(report_path)
        session.add(row)


@experiment_step("judge")
def node_judge(state: ExperimentState, report) -> dict:
    experiment_id = state["experiment_id"]
    context = service.experiment_context(experiment_id)
    spec = spec_defaults(context["spec"])
    eval_run_id = service.latest_run_id(experiment_id, "eval")
    adopt_run_id = service.latest_run_id(experiment_id, "adopt") if needs_adoption_run(spec) else None
    if needs_adoption_run(spec) and adopt_run_id is None:
        report("judge", "No adoption check results; judging the claim check only", None, level="warning")
    results, verdict = _judge_runs(experiment_id, spec, context["profile"], eval_run_id, adopt_run_id)
    build = context["experiment"].get("build") or {}
    tuning = build.get("tuning") or {}
    iteration = int(state.get("iteration") or build.get("iteration") or 1)
    history = list(build.get("iterations") or [])
    report("judge", "Analysing the result against the paper", None)
    llm = build_default_llm_client()
    analysis = analyse(
        verdict,
        spec,
        context["claim"],
        tuning,
        fidelity_notes(artifacts_dir(experiment_id)),
        history,
        llm,
        summarize_roofline(context.get("roofline")),
    )
    entry = _iteration_entry(iteration, verdict, analysis, tuning)
    entry.update(
        sha=git(context["worktree"], "rev-parse", "HEAD", check=False) or None,
        eval_run_id=eval_run_id,
        adopt_run_id=adopt_run_id,
        quality_ok=verdict["quality_ok"],
        analysis=analysis,
    )
    current_changes = _iteration_changes(context, iteration, entry["sha"], report)
    if current_changes:
        entry["changes"] = {k: current_changes.get(k) for k in ("files_changed", "additions", "deletions", "summary")}
        build = {**build, "code_changes": code_changes.light(current_changes)}
    history.append(entry)
    best = max(history, key=_score)
    iterate = bool(analysis.get("worth_iterating")) and iteration < int(spec.get("max_iterations") or 1)
    diagnosis = (analysis.get("diagnosis") or "").replace("_", " ")
    report_path = artifacts_dir(experiment_id) / "report.html"
    if iterate:
        verdict.update(analysis=analysis, iteration=iteration, iterations=history, tuning=tuning or None)
        _save_verdict(experiment_id, verdict, report_path)
        set_experiment(experiment_id, status="building", build={**build, "iterations": history})
        report(
            "judge",
            f"Iteration {iteration}: {verdict['verdict'].replace('_', ' ')} ({diagnosis}). Trying a fix: {analysis['next_changes'][:400]}",
            {"analysis": analysis},
        )
        ratchet = ""
        if best is not entry and _score(best) > _score(entry):
            ratchet = (
                f"\nNote: iteration {best['iteration']} (commit {best.get('sha') or '?'}) is still the best so far "
                f"({best.get('median_delta_pct') or 0:+.1f}%); build on what worked there."
            )
        feedback = (
            f"Iteration {iteration} result: claim check {verdict['verdict']} — {verdict['reason']}.\n"
            f"Diagnosis ({analysis.get('diagnosis')}): {analysis.get('summary')}\n"
            f"Evidence: {'; '.join(analysis.get('evidence') or [])}\n"
            f"Change the existing implementation as follows: {analysis['next_changes']}\n"
            f"Expected: {analysis.get('expected_effect')}{ratchet}"
        )
        return {"iterate": True, "iteration": iteration + 1, "feedback": feedback}

    if best is not entry and _score(best) > _score(entry) and best.get("sha"):
        # Keep the best iteration: revert the worktree to its commit and report its measurements.
        git(context["worktree"], "reset", "--hard", best["sha"])
        results, verdict = _judge_runs(experiment_id, spec, context["profile"], best.get("eval_run_id"), best.get("adopt_run_id"))
        analysis = best.get("analysis") or analysis
        diagnosis = (analysis.get("diagnosis") or "").replace("_", " ")
        report(
            "judge",
            f"Kept iteration {best['iteration']} ({best.get('median_delta_pct') or 0:+.1f}%) and reverted later changes "
            f"(iteration {iteration}: {entry.get('median_delta_pct') or 0:+.1f}%)",
            {"kept_iteration": best["iteration"], "sha": best["sha"]},
        )
    kept = best if _score(best) > _score(entry) and best.get("sha") else entry
    verdict.update(analysis=analysis, iteration=kept["iteration"], iterations=history, tuning=tuning or None)
    kept_changes, kept_patch = _kept_changes(experiment_id, kept["iteration"], build)
    report("judge", "Explaining the result from the code change", None)
    verdict["code_effect"] = _explain_result(
        experiment_id, verdict, spec, context["claim"], kept_changes, kept_patch, llm, analysis, tuning, report
    )
    render_report(
        report_path,
        context["experiment"],
        context["project"],
        context["claim"],
        context["paper"],
        spec,
        {**build, "code_changes": kept_changes} if kept_changes else build,
        verdict,
        results,
    )
    _save_verdict(experiment_id, verdict, report_path)
    pr_url = _maybe_open_pr(context, verdict, report)
    final_build = {**build, "iterations": history, "kept_iteration": kept["iteration"], "pr_url": pr_url}
    if kept_changes:
        final_build["code_changes"] = kept_changes
    set_experiment(experiment_id, status="awaiting_decision", build=final_build)
    adoption = verdict.get("adoption")
    adopt_text = f" Adoption: {adoption['verdict'].replace('_', ' ')}." if adoption else ""
    report(
        "decide",
        f"Verdict: {verdict['verdict'].replace('_', ' ')} — {verdict['reason']}.{adopt_text} Diagnosis: {diagnosis}. Waiting for merge/drop (Gate 3)",
        {"verdict": verdict["verdict"], "analysis": analysis},
    )
    return {"iterate": False}


def route_after_judge(state: ExperimentState) -> str:
    return "build" if state.get("iterate") else "gate_merge"


def _maybe_open_pr(context: dict, verdict: dict, report) -> Optional[str]:
    """If the target repo has a GitHub remote, push the branch and open a draft PR."""
    repo = context["project"]["repo_path"]
    if not git(repo, "remote", "get-url", "origin", check=False):
        return None
    import subprocess

    branch = context["experiment"]["branch"]
    try:
        git(context["worktree"], "push", "-u", "origin", branch)
        body = f"Automated experiment #{context['experiment']['id']} — verdict: {verdict['verdict']} ({verdict['reason']})"
        out = subprocess.run(
            ["gh", "pr", "create", "--draft", "--head", branch, "--title", f"r2e: {context['spec']['flag_name']}", "--body", body],
            cwd=context["worktree"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        url = out.stdout.strip().splitlines()[-1] if out.returncode == 0 and out.stdout.strip() else None
        if url:
            report("decide", f"Opened draft PR {url}", {"pr_url": url})
        return url
    except Exception as exc:  # noqa: BLE001 - optional convenience
        report("decide", f"Could not open a PR: {exc}", None, level="warning")
        return None


def node_gate_merge(state: ExperimentState) -> dict:
    experiment_id = state["experiment_id"]
    _gate_cancel_check(experiment_id, "decide")
    set_experiment(experiment_id, status="awaiting_decision")
    response = interrupt({"gate": "merge", "experiment_id": experiment_id})
    response = _gate_response(response, "merge", ("merge", "drop"))
    return {"decision": response.get("decision"), "feedback": response.get("comment")}


def _merge_message(flag_name: str, experiment_id: int) -> str:
    return f"r2e: merge {flag_name} (experiment {experiment_id})"


def _existing_merge(repo: str, branch: Optional[str], base: str, message: str) -> Optional[str]:
    """The merge commit of an earlier, interrupted finalize (branch already merged into base)."""
    if not branch or not git(repo, "branch", "--list", "--merged", base, branch, check=False):
        return None
    return git(repo, "log", base, "--merges", "-F", f"--grep={message}", "--format=%H", "-1", check=False) or None


@experiment_step("finalize")
def node_finalize(state: ExperimentState, report) -> dict:
    experiment_id = state["experiment_id"]
    decision = state.get("decision")
    if decision not in ("merge", "drop"):
        raise ValueError(f"unknown Gate 3 decision {decision!r}; expected merge or drop")
    context = service.experiment_context(experiment_id)
    experiment = context["experiment"]
    repo = context["project"]["repo_path"]
    base = (context["profile"].get("repo") or {}).get("branch") or "main"
    if decision == "merge":
        build = experiment.get("build") or {}
        message = _merge_message(context["spec"]["flag_name"], experiment_id)
        sha = build.get("merge_sha") or _existing_merge(repo, experiment["branch"], base, message)
        if sha:
            report("decide", f"Already merged into {base} at {sha[:10]}", {"sha": sha})
        else:
            if context["worktree"] and context["worktree"].exists():
                commit_all(context["worktree"], f"r2e: finalize {context['spec']['flag_name']} (experiment {experiment_id})")
                ensure_protected_paths(context["worktree"], context["profile"])
            sha = merge_branch(repo, experiment["branch"], message, base)
        set_experiment(experiment_id, status="merged", build={**build, "merge_sha": sha})
        report("decide", f"Merged into {base} at {sha[:10]} (flag stays off by default)", {"sha": sha})
        try:
            remove_worktree(repo, experiment.get("worktree_path"), experiment["branch"], delete_branch=False)
            register_project(repo, context["project"]["name"])
        except Exception as exc:  # noqa: BLE001 - the merge stands; dependents re-profile before planning
            report("decide", f"Merged, but cleanup/re-profiling failed: {exc}", None, level="warning")
        service.release_dependents(experiment_id, merged=True)
    else:
        remove_worktree(repo, experiment.get("worktree_path"), experiment["branch"], delete_branch=True)
        set_experiment(experiment_id, status="dropped")
        report("decide", "Dropped: branch and worktree removed; results kept", None)
        service.release_dependents(experiment_id, merged=False)
    return {}


def build_experiment_graph() -> StateGraph:
    graph = StateGraph(ExperimentState)
    graph.add_node("plan", node_plan)
    graph.add_node("gate_spec", node_gate_spec)
    graph.add_node("rejected", node_rejected)
    graph.add_node("build", node_build)
    graph.add_node("smoke", node_smoke)
    graph.add_node("tune", node_tune)
    graph.add_node("run", node_run)
    graph.add_node("judge", node_judge)
    graph.add_node("gate_merge", node_gate_merge)
    graph.add_node("finalize", node_finalize)
    graph.add_edge(START, "plan")
    graph.add_edge("plan", "gate_spec")
    graph.add_conditional_edges("gate_spec", route_after_spec, ["build", "plan", "rejected"])
    graph.add_edge("rejected", END)
    graph.add_edge("build", "smoke")
    graph.add_edge("smoke", "tune")
    graph.add_edge("tune", "run")
    graph.add_edge("run", "judge")
    graph.add_conditional_edges("judge", route_after_judge, ["build", "gate_merge"])
    graph.add_edge("gate_merge", "finalize")
    graph.add_edge("finalize", END)
    return graph


REHYDRATE_AFTER = {
    "awaiting_approval": ("plan", {}),
    "approving": ("gate_spec", {"decision": "approve"}),
    "building": ("gate_spec", {"decision": "approve"}),
    "smoke_testing": ("build", {}),
    "tuning": ("smoke", {}),
    "judging": ("run", {}),
    "awaiting_decision": ("judge", {}),
    "finalizing": ("judge", {}),
    "rejected": ("gate_spec", {"decision": "reject"}),
    "merged": ("finalize", {}),
    "dropped": ("finalize", {}),
}
STAGE_REHYDRATE = {
    "approve": ("plan", {}),
    "build": ("gate_spec", {"decision": "approve"}),
    "smoke": ("build", {}),
    "tune": ("smoke", {}),
    "judge": ("run", {}),
    "decide": ("judge", {}),
}


def rehydration_point(experiment_id: int) -> tuple[Optional[str], dict]:
    """Where to rebuild a lost checkpoint from, based on the experiment row (source of truth)."""
    with session_scope() as session:
        experiment = session.get(Experiment, experiment_id)
        smoke_done = session.scalar(
            select(Run.id).where(Run.experiment_id == experiment_id, Run.kind == "smoke", Run.status == "done")
        )
    status = experiment.status
    tuned = bool((experiment.build or {}).get("tuning"))
    after_smoke = ("tune" if tuned else "smoke") if smoke_done else "build"
    if status in ("running", "waiting_gpu"):
        return after_smoke, {}
    if status in ("failed", "cancelled", "queued"):
        stage = service.stage_of(status, experiment.error)
        if stage == "run":
            return after_smoke, {}
        return STAGE_REHYDRATE.get(stage or "", (None, {}))
    return REHYDRATE_AFTER.get(status, (None, {}))


def run_experiment(experiment_id: int, resume: Optional[dict] = None) -> str:
    """Advance an experiment's graph until the next gate or the end. Returns the status."""
    with session_scope() as session:
        thread_id = session.scalar(select(Experiment.thread_id).where(Experiment.id == experiment_id))
    config = {"configurable": {"thread_id": thread_id}}
    with experiment_lock(experiment_id), checkpointer() as saver:
        graph = build_experiment_graph().compile(checkpointer=saver)
        snapshot = graph.get_state(config)
        rehydrated = False
        if not snapshot.values:
            as_node, values = rehydration_point(experiment_id)
            if as_node:
                rehydrated = True
                graph.update_state(config, {"experiment_id": experiment_id, **values}, as_node=as_node)
                reporter(experiment_id=experiment_id)(
                    "recover", f"Rebuilt orchestration state after step '{as_node}'", None, level="warning"
                )
                if graph.get_state(config).next[:1] == ("rejected",):
                    graph.invoke(None, config)
                snapshot = graph.get_state(config)
        pending = [i for task in snapshot.tasks for i in task.interrupts]
        if not pending and snapshot.next[:1] in (("gate_spec",), ("gate_merge",)):
            # Run up to the gate's interrupt so a decision can be applied to it.
            graph.invoke(None, config)
            snapshot = graph.get_state(config)
            pending = [i for task in snapshot.tasks for i in task.interrupts]
        if resume is not None and pending:
            gate = (pending[0].value or {}).get("gate")
            if resume.get("gate") == gate:
                graph.invoke(Command(resume=resume), config)
            else:
                # A stale/replayed decision for another gate must never act on this one.
                reporter(experiment_id=experiment_id)(
                    "recover",
                    f"Ignored a decision for gate {resume.get('gate')!r} while waiting at gate {gate!r}",
                    {"resume": resume},
                    level="warning",
                )
        elif resume is not None and not rehydrated:
            # The gate this decision was for has already been passed: either a replayed job, or a
            # resume job re-queued mid-step (shutdown / expired lease). Don't re-apply the decision,
            # but continue the graph from its checkpoint so the experiment isn't left stranded.
            if snapshot.next:
                reporter(experiment_id=experiment_id)(
                    "recover", f"Gate {resume.get('gate')!r} already decided; continuing from checkpoint", None, level="warning"
                )
                set_experiment(experiment_id, error=None)
                graph.invoke(None, config)
            else:
                reporter(experiment_id=experiment_id)(
                    "recover", f"Ignored a decision for gate {resume.get('gate')!r}: no gate is pending", None, level="warning"
                )
        elif not snapshot.values:
            graph.invoke({"experiment_id": experiment_id}, config)
        elif snapshot.next:
            if pending:
                gate = (pending[0].value or {}).get("gate")
                set_experiment(
                    experiment_id,
                    status="awaiting_approval" if gate == "approve_spec" else "awaiting_decision",
                    error=None,
                )
            else:
                set_experiment(experiment_id, error=None)
                graph.invoke(None, config)
    if service.experiment_status(experiment_id) == "cancelling":
        set_experiment(experiment_id, status="cancelled")
    return service.experiment_status(experiment_id)


# ---- triage graph ------------------------------------------------------------------


class TriageState(TypedDict, total=False):
    triage_id: int
    project_id: int
    options: dict


def _triage_report(state: TriageState):
    return reporter(triage_id=state["triage_id"])


def _set_triage(triage_id: int, **values: Any) -> None:
    with session_scope() as session:
        session.execute(update(Triage).where(Triage.id == triage_id).values(updated_at=_now(), **values))


def triage_step(stage: str) -> Callable:
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(state: TriageState) -> dict:
            report = _triage_report(state)
            try:
                _set_triage(state["triage_id"], status=stage)
                return func(state, report)
            except Exception as exc:  # noqa: BLE001
                _set_triage(state["triage_id"], status="failed")
                report(stage, f"{stage} failed: {exc}", {"traceback": traceback.format_exc()[-4000:]}, level="error")
                raise

        return wrapper

    return decorator


@triage_step("topics")
def node_topics(state: TriageState, report) -> dict:
    options = state.get("options") or {}
    with session_scope() as session:
        has_topics = session.scalar(select(Topic.id).where(Topic.rank.is_not(None)).limit(1)) is not None
    if options.get("refresh_topics") or not has_topics:
        from paperatlas.discovery.topics import refresh_topics

        report("topics", "Finding the top trending topics in the seed areas", None)
        topics = refresh_topics(use_llm=options.get("use_llm", True), report=report)
        report("topics", f"{len(topics)} topics: " + ", ".join(t["name"] for t in topics), None)
    else:
        report("topics", "Using the current top topics (refresh not requested)", None)
    return {}


@triage_step("discover")
def node_discover(state: TriageState, report) -> dict:
    from paperatlas.discovery.ranking import discover

    options = state.get("options") or {}
    stats = discover(
        topic_slugs=options.get("topics"),
        per_topic=options.get("per_topic"),
        expand=options.get("expand", True),
        report=report,
    )
    report("discover", f"Selected {len(stats.selected)} papers across {stats.topics} topics ({stats.text_fetched} PDFs parsed)", None)
    return {"options": {**options, "paper_ids": stats.selected}}


@triage_step("distill")
def node_distill(state: TriageState, report) -> dict:
    from paperatlas.distill.extractor import ClaimExtractor
    from paperatlas.distill.pipeline import DistillPipeline

    options = state.get("options") or {}
    llm = build_default_llm_client() if options.get("use_llm", True) else None
    pipeline = DistillPipeline(extractor=ClaimExtractor(llm))
    paper_ids = options.get("paper_ids") or []
    stats = pipeline.run(limit=options.get("distill_limit", 60), paper_ids=paper_ids or None)
    report("distill", f"Distilled {stats.papers} papers → {stats.claims} claim cards ({stats.testable_claims} testable)", None)
    return {}


@triage_step("match")
def node_match(state: TriageState, report) -> dict:
    from paperatlas.lab.matcher import match_project

    options = state.get("options") or {}
    match_project(
        state["project_id"],
        use_llm=options.get("use_llm", True),
        report=report,
        explain_top=options.get("explain_top", 15),
    )
    return {}


@triage_step("shortlist")
def node_shortlist(state: TriageState, report) -> dict:
    shortlist = service.recommendations(state["project_id"], limit=15)
    _set_triage(
        state["triage_id"],
        status="awaiting_pick",
        shortlist=[{"claim_id": item["claim_id"], "score": item["score"]} for item in shortlist],
    )
    report("pick", f"{len(shortlist)} recommendations ready — pick 1–2 claims to test (Gate 1)", None)
    return {}


def build_triage_graph() -> StateGraph:
    graph = StateGraph(TriageState)
    for name, node in [
        ("topics", node_topics),
        ("discover", node_discover),
        ("distill", node_distill),
        ("match", node_match),
        ("shortlist", node_shortlist),
    ]:
        graph.add_node(name, node)
    graph.add_edge(START, "topics")
    graph.add_edge("topics", "discover")
    graph.add_edge("discover", "distill")
    graph.add_edge("distill", "match")
    graph.add_edge("match", "shortlist")
    graph.add_edge("shortlist", END)
    return graph


def run_triage(triage_id: int) -> str:
    with session_scope() as session:
        triage = session.get(Triage, triage_id)
        thread_id, project_id = triage.thread_id, triage.project_id
        options = triage.options or {}
    config = {"configurable": {"thread_id": thread_id}}
    with checkpointer() as saver:
        graph = build_triage_graph().compile(checkpointer=saver)
        snapshot = graph.get_state(config)
        if not snapshot.values:
            graph.invoke({"triage_id": triage_id, "project_id": project_id, "options": options}, config)
        elif snapshot.next:
            graph.invoke(None, config)
    with session_scope() as session:
        return session.scalar(select(Triage.status).where(Triage.id == triage_id))
