"""research-api — topics, papers, claim cards, hybrid search; queues discover/distill jobs."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import Query
from pydantic import BaseModel, Field

from paperatlas.discovery.config import load_config
from paperatlas.discovery.topics import list_topics
from paperatlas.distill.claims import CATEGORIES
from paperatlas.lab import service
from paperatlas.lab.events import enqueue, list_jobs
from paperatlas.llm.client import LLMError
from paperatlas.r2e.explainers import explain_paper, explain_topic, topic_insights
from paperatlas.services.common import create_app

app = create_app("research-api", "Discovered research: topics, papers, patents and claim cards.")


class JobQueued(BaseModel):
    job_id: int
    kind: str


class RefreshTopicsRequest(BaseModel):
    use_llm: bool = True


class DiscoverRequest(BaseModel):
    topics: Optional[list[str]] = Field(None, description="Topic slugs (default: all current top topics)")
    per_topic: Optional[int] = Field(None, ge=1, le=50)
    expand: bool = True


class DistillRequest(BaseModel):
    limit: int = Field(30, ge=1, le=500)
    paper_ids: Optional[list[str]] = None
    reprocess: bool = False
    use_llm: bool = True


@app.get("/stats", tags=["overview"])
def get_stats() -> dict[str, Any]:
    return service.stats()


@app.get("/seeds", tags=["topics"])
def get_seeds() -> dict[str, Any]:
    config = load_config()
    return {"seeds": [seed.model_dump() for seed in config.seeds], "sources": config.sources, "topics": config.topics.model_dump()}


class ExplainRequest(BaseModel):
    project_id: Optional[int] = None
    claims_top: int = Field(25, ge=0, le=200)
    papers: bool = True
    topics: bool = True
    maps: bool = True
    force: bool = False


@app.get("/topics", tags=["topics"])
def get_topics(include_archived: bool = False, insights: bool = True) -> list[dict[str, Any]]:
    topics = list_topics(include_archived)
    if insights:
        for topic in topics:
            topic["insights"] = topic_insights(topic["id"])
    return topics


@app.get("/topics/{slug}", tags=["topics"])
def get_topic(slug: str) -> dict[str, Any]:
    topic = next((t for t in list_topics(include_archived=True) if t["slug"] == slug), None)
    if topic is None:
        raise service.ServiceError(f"topic {slug} not found", 404)
    return {**topic, "insights": topic_insights(topic["id"])}


@app.post("/topics/{slug}/explain", tags=["topics"])
def explain_topic_now(slug: str, force: bool = True) -> dict[str, Any]:
    topic = get_topic(slug)
    try:
        return explain_topic(topic["id"], force=force)
    except (ValueError, LLMError) as exc:
        raise service.ServiceError(str(exc)) from exc


@app.post("/explain", tags=["system"], response_model=JobQueued)
def explain_backfill(body: ExplainRequest = ExplainRequest()) -> JobQueued:
    return JobQueued(job_id=enqueue("explain", body.model_dump()), kind="explain")


@app.post("/topics/refresh", tags=["topics"], response_model=JobQueued)
def refresh_topics(body: RefreshTopicsRequest = RefreshTopicsRequest()) -> JobQueued:
    return JobQueued(job_id=enqueue("topics.refresh", body.model_dump()), kind="topics.refresh")


@app.post("/discover", tags=["papers"], response_model=JobQueued)
def discover(body: DiscoverRequest = DiscoverRequest()) -> JobQueued:
    return JobQueued(job_id=enqueue("discover", body.model_dump()), kind="discover")


@app.post("/distill", tags=["claims"], response_model=JobQueued)
def distill(body: DistillRequest = DistillRequest()) -> JobQueued:
    return JobQueued(job_id=enqueue("distill", body.model_dump()), kind="distill")


@app.get("/papers", tags=["papers"])
def get_papers(
    q: Optional[str] = None,
    topic: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    return service.list_papers(q=q, topic=topic, limit=limit, offset=offset)


@app.post("/papers/{paper_id:path}/explain", tags=["papers"])
def explain_paper_now(paper_id: str, force: bool = True) -> dict[str, Any]:
    try:
        return explain_paper(paper_id, force=force)
    except (ValueError, LLMError) as exc:
        raise service.ServiceError(str(exc), 404 if isinstance(exc, ValueError) else 400) from exc


@app.post("/papers/{paper_id:path}/concept-map", tags=["papers"])
def concept_map_now(paper_id: str, force: bool = True) -> dict[str, Any]:
    from paperatlas.distill.concept_map import map_paper
    from paperatlas.distill.relations import paper_concept_map

    try:
        map_paper(paper_id, force=force)
    except (ValueError, LLMError) as exc:
        raise service.ServiceError(str(exc), 404 if isinstance(exc, ValueError) else 400) from exc
    return paper_concept_map(paper_id) or {}


@app.get("/papers/{paper_id:path}", tags=["papers"])
def get_paper(paper_id: str) -> dict[str, Any]:
    return service.get_paper(paper_id)


@app.get("/categories", tags=["claims"])
def get_categories() -> list[str]:
    return list(CATEGORIES)


@app.get("/claims", tags=["claims"])
def get_claims(
    q: Optional[str] = None,
    category: Optional[str] = None,
    topic: Optional[str] = None,
    testable: Optional[bool] = None,
    paper_id: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    project_id: Optional[int] = None,
) -> dict[str, Any]:
    return service.list_claims(q, category, topic, testable, paper_id, limit, offset, project_id)


@app.get("/claims/{claim_id}", tags=["claims"])
def get_claim(claim_id: int, project_id: Optional[int] = None) -> dict[str, Any]:
    return service.get_claim(claim_id, project_id)


@app.get("/jobs", tags=["system"])
def get_jobs(limit: int = 50, status: Optional[str] = None) -> list[dict[str, Any]]:
    return list_jobs(limit, status)
