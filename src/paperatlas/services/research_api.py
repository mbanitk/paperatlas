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


@app.get("/topics", tags=["topics"])
def get_topics(include_archived: bool = False) -> list[dict[str, Any]]:
    return list_topics(include_archived)


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
) -> dict[str, Any]:
    return service.list_claims(q, category, topic, testable, paper_id, limit, offset)


@app.get("/claims/{claim_id}", tags=["claims"])
def get_claim(claim_id: int) -> dict[str, Any]:
    return service.get_claim(claim_id)


@app.get("/jobs", tags=["system"])
def get_jobs(limit: int = 50, status: Optional[str] = None) -> list[dict[str, Any]]:
    return list_jobs(limit, status)
