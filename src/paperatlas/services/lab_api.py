"""lab-api — target projects, recommendations, experiments and the three human gates."""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from paperatlas.lab import service
from paperatlas.lab.events import enqueue, events_since, latest_event_id, list_jobs
from paperatlas.lab.profiler import ProfileError, get_project, project_dict, register_project
from paperatlas.services.common import create_app, sse_response

app = create_app("lab-api", "Apply research to a project: recommendations, experiments, gates, live progress.")


class JobQueued(BaseModel):
    job_id: int
    kind: str


class ProjectCreate(BaseModel):
    repo_path: str = Field(..., description="Local path of the target repository (must contain lab.yaml)")
    name: Optional[str] = None


class TriageOptions(BaseModel):
    refresh_topics: bool = False
    explain_top: int = Field(15, ge=0, le=100)
    topics: Optional[list[str]] = None
    per_topic: Optional[int] = Field(None, ge=1, le=50)
    distill_limit: int = Field(60, ge=1, le=500)
    expand: bool = True
    use_llm: bool = True


class PickRequest(BaseModel):
    """Gate 1 — pick the claims to test."""

    project_id: int
    claim_ids: list[int] = Field(..., min_length=1, max_length=5)
    triage_id: Optional[int] = None
    force: bool = Field(False, description="Allow claims the matcher marked as blocked")
    mode: Literal["single", "bundle", "chain"] = Field(
        "single",
        description="single: one experiment per claim; bundle: one experiment with the claim's prerequisites "
        "from the same paper; chain: prerequisite experiments first, dependents start after each merge",
    )


class SpecEdit(BaseModel):
    overrides: dict[str, Any]


class SpecDecision(BaseModel):
    """Gate 2 — approve (optionally with edits), request a revision, or reject."""

    decision: Literal["approve", "revise", "reject"]
    overrides: Optional[dict[str, Any]] = None
    comment: Optional[str] = None


class MergeDecision(BaseModel):
    """Gate 3 — merge the experiment branch or drop it."""

    decision: Literal["merge", "drop"]
    comment: Optional[str] = None


def _project_or_404(project_id: int):
    try:
        return get_project(project_id)
    except ProfileError as exc:
        raise service.ServiceError(str(exc), 404) from exc


@app.get("/projects", tags=["projects"])
def list_projects() -> list[dict[str, Any]]:
    from sqlalchemy import select

    from paperatlas.db.engine import session_scope
    from paperatlas.db.schema import Project

    with session_scope() as session:
        return [project_dict(p) for p in session.scalars(select(Project).order_by(Project.id)).all()]


@app.post("/projects", tags=["projects"])
def add_project(body: ProjectCreate) -> dict[str, Any]:
    try:
        return register_project(body.repo_path, body.name)
    except ProfileError as exc:
        raise service.ServiceError(str(exc)) from exc


@app.get("/projects/{project_id}", tags=["projects"])
def read_project(project_id: int) -> dict[str, Any]:
    return project_dict(_project_or_404(project_id))


@app.post("/projects/{project_id}/profile", tags=["projects"])
def reprofile(project_id: int) -> dict[str, Any]:
    project = _project_or_404(project_id)
    try:
        return register_project(project.repo_path, project.name)
    except ProfileError as exc:
        raise service.ServiceError(str(exc)) from exc


@app.post("/projects/{project_id}/match", tags=["recommendations"], response_model=JobQueued)
def rematch(project_id: int, use_llm: bool = True) -> JobQueued:
    _project_or_404(project_id)
    return JobQueued(job_id=enqueue("match", {"project_id": project_id, "use_llm": use_llm}), kind="match")


@app.post("/projects/{project_id}/roofline", tags=["projects"], response_model=JobQueued)
def roofline(project_id: int, model: str = "eval", rematch: bool = True) -> JobQueued:
    """Measure the engine's roofline (GPU job), then re-rank claims with the cost model."""
    _project_or_404(project_id)
    if model not in ("eval", "smoke"):
        raise service.ServiceError("model must be eval or smoke")
    job_id = enqueue("project.roofline", {"project_id": project_id, "model": model, "rematch": rematch})
    return JobQueued(job_id=job_id, kind="project.roofline")


@app.get("/claims/{claim_id}/prerequisites", tags=["recommendations"])
def prerequisites(claim_id: int) -> list[dict[str, Any]]:
    from paperatlas.distill.relations import prerequisite_chain

    return prerequisite_chain(claim_id)


@app.get("/projects/{project_id}/recommendations", tags=["recommendations"])
def recommendations(
    project_id: int,
    limit: int = Query(30, ge=1, le=200),
    include_blocked: bool = False,
    category: Optional[str] = None,
    topic: Optional[str] = None,
    q: Optional[str] = None,
) -> list[dict[str, Any]]:
    _project_or_404(project_id)
    return service.recommendations(project_id, limit, include_blocked, category, topic, q)


@app.post("/projects/{project_id}/claims/{claim_id}/explain", tags=["recommendations"])
def explain_claim_now(project_id: int, claim_id: int, force: bool = True) -> dict[str, Any]:
    from paperatlas.llm.client import LLMError
    from paperatlas.r2e.explainers import explain_claim

    _project_or_404(project_id)
    try:
        return explain_claim(project_id, claim_id, force=force)
    except (ValueError, LLMError) as exc:
        raise service.ServiceError(str(exc), 404 if isinstance(exc, ValueError) else 400) from exc


@app.post("/projects/{project_id}/triage", tags=["triage"])
def start_triage(project_id: int, body: TriageOptions = TriageOptions()) -> dict[str, Any]:
    return service.start_triage(project_id, body.model_dump())


@app.get("/triage", tags=["triage"])
def list_triage(project_id: Optional[int] = None) -> list[dict[str, Any]]:
    return service.list_triage(project_id)


@app.get("/triage/{triage_id}", tags=["triage"])
def get_triage(triage_id: int) -> dict[str, Any]:
    return service.get_triage(triage_id)


@app.get("/triage/{triage_id}/stream", tags=["triage"])
def stream_triage(triage_id: int, request: Request, after: int = 0):
    return sse_response(lambda cursor: events_since(cursor, triage_id=triage_id), request, after)


@app.post("/experiments", tags=["experiments"])
def pick_claims(body: PickRequest) -> list[dict[str, Any]]:
    return service.create_experiments(body.project_id, body.claim_ids, body.triage_id, body.force, body.mode)


@app.get("/experiments", tags=["experiments"])
def list_experiments(
    project_id: Optional[int] = None,
    status: Optional[str] = Query(None, description="status, 'active' or 'needs_you'"),
) -> list[dict[str, Any]]:
    return service.list_experiments(project_id, status)


def _values(values: Optional[list[str]]) -> list[str]:
    """Repeated (`?status=a&status=b`) or comma-separated (`?status=a,b`) values."""
    return [part.strip() for value in values or [] for part in value.split(",") if part.strip()]


@app.get("/experiments/search", tags=["experiments"])
def search_experiments(
    project_id: Optional[int] = None,
    scope: Literal["all", "needs_you", "active"] = Query("all", description="list tab: needs_you (a gate waits for you), active or all"),
    q: Optional[str] = Query(None, max_length=200, description="words in the title, technique, paper or flag; #12 = experiment or claim 12"),
    status: Optional[list[str]] = Query(None, description="experiment statuses, e.g. building,failed,merged"),
    verdict: Optional[list[str]] = Query(None, description="claim check outcomes: reproduced, partial, not_reproduced, regression, inconclusive"),
    adoption: Optional[list[str]] = Query(None, description="adoption check outcomes: worth_adopting, small_gain, not_reproduced, regression, inconclusive"),
    category: Optional[list[str]] = Query(None, description="technique categories, e.g. kv_cache,quantization"),
    change: Optional[Literal["gain", "loss"]] = Query(None, description="measured change: gains (> 0) or losses (< 0) only"),
    min_change: Optional[float] = Query(None, ge=0, le=100_000, description="minimum size of the measured change in %: at least +x% / −x% with `change`, x% either way without"),
    change_of: Literal["claim", "adoption"] = Query("claim", description="the measured change of the claim check (median_delta_pct) or of the adoption check"),
    limit: int = Query(50, ge=1, le=service.MAX_PAGE),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """Experiments matching every filter (newest first, one page), the total, and per-filter counts (facets)."""
    return service.search_experiments(
        project_id,
        scope,
        q,
        statuses=_values(status),
        verdicts=_values(verdict),
        adoption=_values(adoption),
        categories=_values(category),
        change=change,
        min_change_pct=min_change,
        change_of=change_of,
        limit=limit,
        offset=offset,
    )


@app.get("/experiments/{experiment_id}", tags=["experiments"])
def get_experiment(experiment_id: int) -> dict[str, Any]:
    return service.get_experiment(experiment_id)


@app.patch("/experiments/{experiment_id}/spec", tags=["gates"])
def edit_spec(experiment_id: int, body: SpecEdit) -> dict[str, Any]:
    return service.update_spec(experiment_id, body.overrides)


@app.post("/experiments/{experiment_id}/spec/decision", tags=["gates"])
def decide_spec(experiment_id: int, body: SpecDecision) -> dict[str, Any]:
    return service.decide_spec(experiment_id, body.decision, body.overrides, body.comment)


@app.post("/experiments/{experiment_id}/decision", tags=["gates"])
def decide_merge(experiment_id: int, body: MergeDecision) -> dict[str, Any]:
    return service.decide_merge(experiment_id, body.decision, body.comment)


@app.post("/experiments/{experiment_id}/cancel", tags=["experiments"])
def cancel(experiment_id: int) -> dict[str, Any]:
    return service.cancel_experiment(experiment_id)


class RerunRequest(BaseModel):
    replan: bool = False
    comment: Optional[str] = None


@app.post("/experiments/{experiment_id}/rerun", tags=["experiments"])
def rerun(experiment_id: int, body: Optional[RerunRequest] = None) -> dict[str, Any]:
    """New experiment for the same claim on the current code; reuses the spec (Gate 2) unless replan=true."""
    body = body or RerunRequest()
    return service.rerun_experiment(experiment_id, body.replan, body.comment)


@app.post("/experiments/{experiment_id}/retry", tags=["experiments"])
def retry(experiment_id: int) -> dict[str, Any]:
    return service.retry_experiment(experiment_id)


@app.get("/experiments/{experiment_id}/events", tags=["experiments"])
def experiment_events(experiment_id: int, after: int = 0) -> list[dict[str, Any]]:
    return service.experiment_events(experiment_id, after)


@app.get("/experiments/{experiment_id}/stream", tags=["experiments"])
def stream_experiment(experiment_id: int, request: Request, after: int = 0):
    service.experiment_status(experiment_id)
    return sse_response(lambda cursor: events_since(cursor, experiment_id=experiment_id), request, after)


@app.get("/experiments/{experiment_id}/log", tags=["experiments"])
def experiment_log(experiment_id: int) -> dict[str, Any]:
    return service.experiment_log(experiment_id)


@app.get("/experiments/{experiment_id}/report", tags=["experiments"])
def experiment_report(experiment_id: int) -> FileResponse:
    return FileResponse(service.report_path(experiment_id), media_type="text/html")


@app.get("/activity", tags=["system"])
def activity(limit: int = Query(50, ge=1, le=500)) -> list[dict[str, Any]]:
    return service.recent_activity(limit)


@app.get("/events/stream", tags=["system"])
def stream_all(request: Request, after: int = Query(0, description="event id to start after; -1 = only new events")):
    if after < 0:
        after = latest_event_id()
    return sse_response(lambda cursor: events_since(cursor), request, after)


@app.get("/jobs", tags=["system"])
def get_jobs(limit: int = 50, status: Optional[str] = None) -> list[dict[str, Any]]:
    return list_jobs(limit, status)
