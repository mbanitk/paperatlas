"""LangGraph orchestration.

Triage graph (per project):  topics? → discover → distill → match → shortlist   (then Gate 1: pick)
Experiment graph (per claim): plan → [Gate 2: approve spec] → build → smoke → run → judge
                              → [Gate 3: merge or drop] → finalize

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

from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from sqlalchemy import select, update

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Experiment, Run, Topic, Triage, Verdict
from paperatlas.lab import service
from paperatlas.lab.builder import build_experiment
from paperatlas.lab.events import reporter
from paperatlas.lab.judge import judge
from paperatlas.lab.planner import plan_experiment
from paperatlas.lab.profiler import register_project
from paperatlas.lab.process import Cancelled
from paperatlas.lab.report import render_report
from paperatlas.lab.runner import run_benchmark
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


def set_experiment(experiment_id: int, **values: Any) -> None:
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


def experiment_step(stage: str) -> Callable:
    """Record failures/cancellation on the experiment row and in events, then re-raise
    so the job fails and the checkpoint stays before this step (retry continues here)."""

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(state: dict) -> dict:
            experiment_id = state["experiment_id"]
            report = reporter(experiment_id=experiment_id)
            try:
                set_experiment(experiment_id, error=None)
                return func(state, report)
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


@experiment_step("plan")
def node_plan(state: ExperimentState, report) -> dict:
    experiment_id = state["experiment_id"]
    context = service.experiment_context(experiment_id)
    set_experiment(experiment_id, status="planning", error=None)
    report("plan", "Writing the experiment spec", None)
    llm = build_default_llm_client()
    if context["experiment"].get("depends_on_experiment_id"):
        register_project(context["project"]["repo_path"], context["project"]["name"])
        context = service.experiment_context(experiment_id)
    spec = plan_experiment(
        {**context["claim"], "bundle": context["bundle"]},
        context["profile"],
        context["match"].get("target_metric") if context["match"] else None,
        llm,
        feedback=state.get("feedback"),
        companions=context["bundle"],
        baseline_flags=context["prerequisite_flags"],
    )
    set_experiment(experiment_id, spec=spec, flag_name=spec["flag_name"], status="awaiting_approval")
    report("approve", "Spec ready — waiting for approval (Gate 2)", {"spec": spec})
    return {"feedback": None}


def node_gate_spec(state: ExperimentState) -> dict:
    experiment_id = state["experiment_id"]
    set_experiment(experiment_id, status="awaiting_approval")
    response = interrupt({"gate": "approve_spec", "experiment_id": experiment_id})
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
    report("build", f"Worktree ready on branch {branch}", {"worktree": str(worktree)})
    info = build_experiment(
        experiment_id,
        worktree,
        spec,
        {**context["claim"], "bundle": context["bundle"]},
        profile,
        artifacts_dir(experiment_id),
        report,
        cancel_checker(experiment_id),
    )
    set_experiment(experiment_id, build=info, status="smoke_testing")
    return {}


@experiment_step("smoke")
def node_smoke(state: ExperimentState, report) -> dict:
    experiment_id = state["experiment_id"]
    context = service.experiment_context(experiment_id)
    set_experiment(experiment_id, status="smoke_testing")
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
    set_experiment(experiment_id, status="running")
    return {}


@experiment_step("run")
def node_run(state: ExperimentState, report) -> dict:
    experiment_id = state["experiment_id"]
    context = service.experiment_context(experiment_id)
    set_experiment(experiment_id, status="running")
    run_benchmark(
        experiment_id,
        "eval",
        context["worktree"],
        context["spec"],
        context["profile"],
        artifacts_dir(experiment_id),
        report,
        cancel_checker(experiment_id),
    )
    set_experiment(experiment_id, status="judging")
    return {}


@experiment_step("judge")
def node_judge(state: ExperimentState, report) -> dict:
    experiment_id = state["experiment_id"]
    context = service.experiment_context(experiment_id)
    results = service.latest_results(experiment_id, "eval")
    verdict = judge(results, context["spec"], context["profile"])
    report_path = artifacts_dir(experiment_id) / "report.html"
    render_report(
        report_path,
        context["experiment"],
        context["project"],
        context["claim"],
        context["paper"],
        context["spec"],
        context["experiment"].get("build") or {},
        verdict,
        results,
    )
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
        row.details = {k: v for k, v in verdict.items() if k not in ("per_metric",)} | {
            "per_metric": {name: {k: v for k, v in m.items() if k != "deltas"} for name, m in verdict["per_metric"].items()}
        }
        row.report_path = str(report_path)
        session.add(row)
    pr_url = _maybe_open_pr(context, verdict, report)
    set_experiment(
        experiment_id,
        status="awaiting_decision",
        build={**(context["experiment"].get("build") or {}), "pr_url": pr_url},
    )
    report("decide", f"Verdict: {verdict['verdict'].replace('_', ' ')} — {verdict['reason']}. Waiting for merge/drop (Gate 3)", {"verdict": verdict["verdict"]})
    return {}


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
    set_experiment(experiment_id, status="awaiting_decision")
    response = interrupt({"gate": "merge", "experiment_id": experiment_id})
    return {"decision": response.get("decision"), "feedback": response.get("comment")}


@experiment_step("finalize")
def node_finalize(state: ExperimentState, report) -> dict:
    experiment_id = state["experiment_id"]
    context = service.experiment_context(experiment_id)
    experiment = context["experiment"]
    repo = context["project"]["repo_path"]
    base = (context["profile"].get("repo") or {}).get("branch") or "main"
    if state.get("decision") == "merge":
        if context["worktree"] and context["worktree"].exists():
            commit_all(context["worktree"], f"r2e: finalize {context['spec']['flag_name']} (experiment {experiment_id})")
        sha = merge_branch(
            repo,
            experiment["branch"],
            f"r2e: merge {context['spec']['flag_name']} (experiment {experiment_id})",
            base,
        )
        remove_worktree(repo, experiment.get("worktree_path"), experiment["branch"], delete_branch=False)
        set_experiment(experiment_id, status="merged", build={**(experiment.get("build") or {}), "merge_sha": sha})
        report("decide", f"Merged into {base} at {sha[:10]} (flag stays off by default)", {"sha": sha})
        register_project(repo, context["project"]["name"])
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
    graph.add_node("run", node_run)
    graph.add_node("judge", node_judge)
    graph.add_node("gate_merge", node_gate_merge)
    graph.add_node("finalize", node_finalize)
    graph.add_edge(START, "plan")
    graph.add_edge("plan", "gate_spec")
    graph.add_conditional_edges("gate_spec", route_after_spec, ["build", "plan", "rejected"])
    graph.add_edge("rejected", END)
    graph.add_edge("build", "smoke")
    graph.add_edge("smoke", "run")
    graph.add_edge("run", "judge")
    graph.add_edge("judge", "gate_merge")
    graph.add_edge("gate_merge", "finalize")
    graph.add_edge("finalize", END)
    return graph


REHYDRATE_AFTER = {
    "awaiting_approval": ("plan", {}),
    "approving": ("gate_spec", {"decision": "approve"}),
    "building": ("gate_spec", {"decision": "approve"}),
    "smoke_testing": ("build", {}),
    "judging": ("run", {}),
    "awaiting_decision": ("judge", {}),
    "finalizing": ("judge", {}),
}
STAGE_REHYDRATE = {
    "approve": ("plan", {}),
    "build": ("gate_spec", {"decision": "approve"}),
    "smoke": ("build", {}),
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
    if status in ("running", "waiting_gpu"):
        return ("smoke" if smoke_done else "build"), {}
    if status in ("failed", "cancelled", "queued"):
        stage = service.stage_of(status, experiment.error)
        if stage == "run":
            return ("smoke" if smoke_done else "build"), {}
        return STAGE_REHYDRATE.get(stage or "", (None, {}))
    return REHYDRATE_AFTER.get(status, (None, {}))


def run_experiment(experiment_id: int, resume: Optional[dict] = None) -> str:
    """Advance an experiment's graph until the next gate or the end. Returns the status."""
    with session_scope() as session:
        thread_id = session.scalar(select(Experiment.thread_id).where(Experiment.id == experiment_id))
    config = {"configurable": {"thread_id": thread_id}}
    with checkpointer() as saver:
        graph = build_experiment_graph().compile(checkpointer=saver)
        snapshot = graph.get_state(config)
        if not snapshot.values:
            as_node, values = rehydration_point(experiment_id)
            if as_node:
                graph.update_state(config, {"experiment_id": experiment_id, **values}, as_node=as_node)
                reporter(experiment_id=experiment_id)(
                    "recover", f"Rebuilt orchestration state after step '{as_node}'", None, level="warning"
                )
                if graph.get_state(config).next[:1] in (("gate_spec",), ("gate_merge",)):
                    graph.invoke(None, config)
                snapshot = graph.get_state(config)
        interrupted = any(task.interrupts for task in snapshot.tasks)
        if resume is not None and interrupted:
            graph.invoke(Command(resume=resume), config)
        elif not snapshot.values:
            graph.invoke({"experiment_id": experiment_id}, config)
        elif snapshot.next:
            pending = [i for task in snapshot.tasks for i in task.interrupts]
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
