"""PostgreSQL schema.

`research` holds discovered material (topics, papers, concepts, claim cards);
`lab` holds what we do with it (target projects, matches, experiments, runs, verdicts).
LangGraph checkpoints live in the `agent` schema and are managed by LangGraph itself.
Links (Paper → Concept → Claim → Experiment → Verdict) are foreign keys.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    Computed,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, TSVECTOR
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from paperatlas.settings import EMBEDDING_DIM

RESEARCH = "research"
LAB = "lab"
AGENT = "agent"


class Base(DeclarativeBase):
    pass


def _now() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


def _hnsw(name: str) -> Index:
    return Index(
        name,
        "embedding",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )


class Topic(Base):
    __tablename__ = "topics"
    __table_args__ = {"schema": RESEARCH}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[Optional[str]] = mapped_column(Text)
    seed: Mapped[Optional[str]] = mapped_column(Text)
    keywords: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    queries: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    trend_score: Mapped[float] = mapped_column(Float, server_default="0")
    rank: Mapped[Optional[int]] = mapped_column(Integer)
    needs_gpu_cluster: Mapped[bool] = mapped_column(Boolean, server_default="false")
    status: Mapped[str] = mapped_column(Text, server_default="active")
    stats: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    explainer: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    embedding = mapped_column(Vector(EMBEDDING_DIM), nullable=True)
    created_at: Mapped[datetime] = _now()
    refreshed_at: Mapped[datetime] = _now()


class Paper(Base):
    __tablename__ = "papers"
    __table_args__ = (
        Index("ix_papers_tsv", "tsv", postgresql_using="gin"),
        _hnsw("ix_papers_embedding"),
        Index("ix_papers_arxiv_id", "arxiv_id"),
        Index("ix_papers_doi", "doi"),
        {"schema": RESEARCH},
    )

    paper_id: Mapped[str] = mapped_column(Text, primary_key=True)
    doc_type: Mapped[str] = mapped_column(Text, server_default="paper")
    title: Mapped[str] = mapped_column(Text)
    abstract: Mapped[Optional[str]] = mapped_column(Text)
    venue: Mapped[Optional[str]] = mapped_column(Text)
    source: Mapped[Optional[str]] = mapped_column(Text)
    sources: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    doi: Mapped[Optional[str]] = mapped_column(Text)
    arxiv_id: Mapped[Optional[str]] = mapped_column(Text)
    openalex_id: Mapped[Optional[str]] = mapped_column(Text)
    s2_id: Mapped[Optional[str]] = mapped_column(Text)
    patent_number: Mapped[Optional[str]] = mapped_column(Text)
    url: Mapped[Optional[str]] = mapped_column(Text)
    pdf_url: Mapped[Optional[str]] = mapped_column(Text)
    code_url: Mapped[Optional[str]] = mapped_column(Text)
    publication_date: Mapped[Optional[date]] = mapped_column(Date)
    publication_year: Mapped[Optional[int]] = mapped_column(Integer)
    authors: Mapped[list[Any]] = mapped_column(JSONB, server_default="[]")
    citation_count: Mapped[Optional[int]] = mapped_column(Integer)
    influential_citation_count: Mapped[Optional[int]] = mapped_column(Integer)
    hf_upvotes: Mapped[Optional[int]] = mapped_column(Integer)
    raw_text: Mapped[Optional[str]] = mapped_column(Text)
    source_payload: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    explainer: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    tsv = mapped_column(
        TSVECTOR,
        Computed(
            "setweight(to_tsvector('english', coalesce(title, '')), 'A') || "
            "setweight(to_tsvector('english', coalesce(abstract, '')), 'B')",
            persisted=True,
        ),
    )
    embedding = mapped_column(Vector(EMBEDDING_DIM), nullable=True)
    ingested_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()
    text_fetched_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    distilled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class PaperTopic(Base):
    __tablename__ = "paper_topics"
    __table_args__ = {"schema": RESEARCH}

    paper_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey(f"{RESEARCH}.papers.paper_id", ondelete="CASCADE"),
        primary_key=True,
    )
    topic_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey(f"{RESEARCH}.topics.id", ondelete="CASCADE"),
        primary_key=True,
    )
    relevance: Mapped[float] = mapped_column(Float, server_default="0")
    score: Mapped[Optional[float]] = mapped_column(Float)
    rank: Mapped[Optional[int]] = mapped_column(Integer)


class Concept(Base):
    __tablename__ = "concepts"
    __table_args__ = (UniqueConstraint("paper_id", "concept_key"), {"schema": RESEARCH})

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    paper_id: Mapped[str] = mapped_column(
        Text, ForeignKey(f"{RESEARCH}.papers.paper_id", ondelete="CASCADE")
    )
    concept_key: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    kind: Mapped[Optional[str]] = mapped_column(Text)
    summary: Mapped[Optional[str]] = mapped_column(Text)
    key_points: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    source: Mapped[str] = mapped_column(Text, server_default="llm")
    created_at: Mapped[datetime] = _now()


class ClaimGroup(Base):
    __tablename__ = "claim_groups"
    __table_args__ = {"schema": RESEARCH}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    label: Mapped[str] = mapped_column(Text)
    category: Mapped[Optional[str]] = mapped_column(Text)
    canonical_claim_id: Mapped[Optional[int]] = mapped_column(Integer)
    size: Mapped[int] = mapped_column(Integer, server_default="1")
    created_at: Mapped[datetime] = _now()


class Claim(Base):
    __tablename__ = "claims"
    __table_args__ = (
        Index("ix_claims_tsv", "tsv", postgresql_using="gin"),
        _hnsw("ix_claims_embedding"),
        {"schema": RESEARCH},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    paper_id: Mapped[str] = mapped_column(
        Text, ForeignKey(f"{RESEARCH}.papers.paper_id", ondelete="CASCADE")
    )
    concept_id: Mapped[int] = mapped_column(
        Integer, ForeignKey(f"{RESEARCH}.concepts.id", ondelete="CASCADE"), unique=True
    )
    category: Mapped[Optional[str]] = mapped_column(Text)
    technique: Mapped[str] = mapped_column(Text)
    change_required: Mapped[Optional[str]] = mapped_column(Text)
    primary_metric: Mapped[Optional[str]] = mapped_column(Text)
    claimed_value: Mapped[Optional[float]] = mapped_column(Float)
    claimed_unit: Mapped[Optional[str]] = mapped_column(Text)
    direction: Mapped[Optional[str]] = mapped_column(Text)
    claimed_gain_pct: Mapped[Optional[float]] = mapped_column(Float)
    testable: Mapped[bool] = mapped_column(Boolean, server_default="false")
    requires_cuda: Mapped[bool] = mapped_column(Boolean, server_default="false")
    requires_multi_gpu: Mapped[bool] = mapped_column(Boolean, server_default="false")
    requires_training: Mapped[bool] = mapped_column(Boolean, server_default="false")
    effort: Mapped[Optional[str]] = mapped_column(Text)
    evidence_quote: Mapped[Optional[str]] = mapped_column(Text)
    card: Mapped[dict[str, Any]] = mapped_column(JSONB)
    group_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey(f"{RESEARCH}.claim_groups.id", ondelete="SET NULL")
    )
    tsv = mapped_column(
        TSVECTOR,
        Computed(
            "setweight(to_tsvector('english', coalesce(technique, '')), 'A') || "
            "setweight(to_tsvector('english', coalesce(change_required, '')), 'B') || "
            "setweight(to_tsvector('english', coalesce(primary_metric, '') || ' ' || "
            "coalesce(category, '')), 'B') || "
            "setweight(to_tsvector('english', coalesce(evidence_quote, '')), 'C')",
            persisted=True,
        ),
    )
    embedding = mapped_column(Vector(EMBEDDING_DIM), nullable=True)
    created_at: Mapped[datetime] = _now()


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = {"schema": LAB}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(Text, unique=True)
    repo_path: Mapped[str] = mapped_column(Text)
    profile: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    embedding = mapped_column(Vector(EMBEDDING_DIM), nullable=True)
    profiled_at: Mapped[datetime] = _now()
    created_at: Mapped[datetime] = _now()


class Match(Base):
    __tablename__ = "matches"
    __table_args__ = (UniqueConstraint("project_id", "claim_id"), {"schema": LAB})

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        Integer, ForeignKey(f"{LAB}.projects.id", ondelete="CASCADE")
    )
    claim_id: Mapped[int] = mapped_column(
        Integer, ForeignKey(f"{RESEARCH}.claims.id", ondelete="CASCADE")
    )
    fit: Mapped[float] = mapped_column(Float)
    gain: Mapped[float] = mapped_column(Float)
    effort_cost: Mapped[float] = mapped_column(Float)
    score: Mapped[float] = mapped_column(Float)
    testable_here: Mapped[bool] = mapped_column(Boolean)
    blockers: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    target_metric: Mapped[Optional[str]] = mapped_column(Text)
    rationale: Mapped[Optional[str]] = mapped_column(Text)
    explainer: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    explained_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()


class Triage(Base):
    """One pass of discover → distill → match that ends at the 'pick claims' gate."""

    __tablename__ = "triage"
    __table_args__ = {"schema": LAB}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        Integer, ForeignKey(f"{LAB}.projects.id", ondelete="CASCADE")
    )
    thread_id: Mapped[str] = mapped_column(Text, unique=True)
    status: Mapped[str] = mapped_column(Text, server_default="queued")
    options: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    shortlist: Mapped[list[Any]] = mapped_column(JSONB, server_default="[]")
    selected: Mapped[list[Any]] = mapped_column(JSONB, server_default="[]")
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class Experiment(Base):
    __tablename__ = "experiments"
    __table_args__ = {"schema": LAB}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        Integer, ForeignKey(f"{LAB}.projects.id", ondelete="CASCADE")
    )
    claim_id: Mapped[int] = mapped_column(
        Integer, ForeignKey(f"{RESEARCH}.claims.id", ondelete="CASCADE")
    )
    triage_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey(f"{LAB}.triage.id", ondelete="SET NULL")
    )
    thread_id: Mapped[str] = mapped_column(Text, unique=True)
    status: Mapped[str] = mapped_column(Text, server_default="planning")
    spec: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    flag_name: Mapped[Optional[str]] = mapped_column(Text)
    branch: Mapped[Optional[str]] = mapped_column(Text)
    worktree_path: Mapped[Optional[str]] = mapped_column(Text)
    build: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    error: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class Run(Base):
    __tablename__ = "runs"
    __table_args__ = {"schema": LAB}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    experiment_id: Mapped[int] = mapped_column(
        Integer, ForeignKey(f"{LAB}.experiments.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default="running")
    command: Mapped[Optional[str]] = mapped_column(Text)
    results: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    results_path: Mapped[Optional[str]] = mapped_column(Text)
    log_path: Mapped[Optional[str]] = mapped_column(Text)
    started_at: Mapped[datetime] = _now()
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class Verdict(Base):
    __tablename__ = "verdicts"
    __table_args__ = {"schema": LAB}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    experiment_id: Mapped[int] = mapped_column(
        Integer, ForeignKey(f"{LAB}.experiments.id", ondelete="CASCADE"), unique=True
    )
    verdict: Mapped[str] = mapped_column(Text)
    primary_metric: Mapped[str] = mapped_column(Text)
    median_delta_pct: Mapped[Optional[float]] = mapped_column(Float)
    ci_low_pct: Mapped[Optional[float]] = mapped_column(Float)
    ci_high_pct: Mapped[Optional[float]] = mapped_column(Float)
    claimed_gain_pct: Mapped[Optional[float]] = mapped_column(Float)
    quality_ok: Mapped[bool] = mapped_column(Boolean)
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    report_path: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = _now()


class Job(Base):
    """Postgres-backed job queue consumed by the worker service (FOR UPDATE SKIP LOCKED)."""

    __tablename__ = "jobs"
    __table_args__ = (
        Index("ix_jobs_status_run_after", "status", "run_after"),
        {"schema": LAB},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    status: Mapped[str] = mapped_column(Text, server_default="queued")
    attempts: Mapped[int] = mapped_column(Integer, server_default="0")
    run_after: Mapped[datetime] = _now()
    locked_by: Mapped[Optional[str]] = mapped_column(Text)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    error: Mapped[Optional[str]] = mapped_column(Text)
    result: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    experiment_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey(f"{LAB}.experiments.id", ondelete="CASCADE")
    )
    triage_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey(f"{LAB}.triage.id", ondelete="CASCADE")
    )
    created_at: Mapped[datetime] = _now()


class Event(Base):
    """Progress events for the UI (streamed over SSE) and the CLI."""

    __tablename__ = "events"
    __table_args__ = (
        Index("ix_events_experiment", "experiment_id", "id"),
        Index("ix_events_triage", "triage_id", "id"),
        {"schema": LAB},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    job_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey(f"{LAB}.jobs.id", ondelete="SET NULL")
    )
    experiment_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey(f"{LAB}.experiments.id", ondelete="CASCADE")
    )
    triage_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey(f"{LAB}.triage.id", ondelete="CASCADE")
    )
    stage: Mapped[str] = mapped_column(Text)
    level: Mapped[str] = mapped_column(Text, server_default="info")
    message: Mapped[str] = mapped_column(Text)
    data: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = _now()
