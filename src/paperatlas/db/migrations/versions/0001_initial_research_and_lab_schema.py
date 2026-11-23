"""initial research and lab schema

Revision ID: 0001
Revises:
Create Date: 2026-11-23 12:50:20.402473
"""

from __future__ import annotations

import pgvector.sqlalchemy
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    for schema in ("research", "lab", "agent"):
        op.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
    op.create_table(
        "projects",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("repo_path", sa.Text(), nullable=False),
        sa.Column(
            "profile",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "embedding", pgvector.sqlalchemy.vector.VECTOR(dim=384), nullable=True
        ),
        sa.Column(
            "profiled_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
        schema="lab",
    )
    op.create_table(
        "claim_groups",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("category", sa.Text(), nullable=True),
        sa.Column("canonical_claim_id", sa.Integer(), nullable=True),
        sa.Column("size", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        schema="research",
    )
    op.create_table(
        "papers",
        sa.Column("paper_id", sa.Text(), nullable=False),
        sa.Column("doc_type", sa.Text(), server_default="paper", nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("abstract", sa.Text(), nullable=True),
        sa.Column("venue", sa.Text(), nullable=True),
        sa.Column("source", sa.Text(), nullable=True),
        sa.Column(
            "sources", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("doi", sa.Text(), nullable=True),
        sa.Column("arxiv_id", sa.Text(), nullable=True),
        sa.Column("openalex_id", sa.Text(), nullable=True),
        sa.Column("s2_id", sa.Text(), nullable=True),
        sa.Column("patent_number", sa.Text(), nullable=True),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("pdf_url", sa.Text(), nullable=True),
        sa.Column("code_url", sa.Text(), nullable=True),
        sa.Column("publication_date", sa.Date(), nullable=True),
        sa.Column("publication_year", sa.Integer(), nullable=True),
        sa.Column(
            "authors",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column("citation_count", sa.Integer(), nullable=True),
        sa.Column("influential_citation_count", sa.Integer(), nullable=True),
        sa.Column("hf_upvotes", sa.Integer(), nullable=True),
        sa.Column("raw_text", sa.Text(), nullable=True),
        sa.Column(
            "source_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
        sa.Column(
            "tsv",
            postgresql.TSVECTOR(),
            sa.Computed(
                "setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(abstract, '')), 'B')",
                persisted=True,
            ),
            nullable=True,
        ),
        sa.Column(
            "embedding", pgvector.sqlalchemy.vector.VECTOR(dim=384), nullable=True
        ),
        sa.Column(
            "ingested_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("text_fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("distilled_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("paper_id"),
        schema="research",
    )
    op.create_index(
        "ix_papers_arxiv_id", "papers", ["arxiv_id"], unique=False, schema="research"
    )
    op.create_index("ix_papers_doi", "papers", ["doi"], unique=False, schema="research")
    op.create_index(
        "ix_papers_embedding",
        "papers",
        ["embedding"],
        unique=False,
        schema="research",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )
    op.create_index(
        "ix_papers_tsv",
        "papers",
        ["tsv"],
        unique=False,
        schema="research",
        postgresql_using="gin",
    )
    op.create_table(
        "topics",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("seed", sa.Text(), nullable=True),
        sa.Column(
            "keywords", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column(
            "queries", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("trend_score", sa.Float(), server_default="0", nullable=False),
        sa.Column("rank", sa.Integer(), nullable=True),
        sa.Column(
            "needs_gpu_cluster", sa.Boolean(), server_default="false", nullable=False
        ),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column(
            "stats",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "embedding", pgvector.sqlalchemy.vector.VECTOR(dim=384), nullable=True
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "refreshed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug"),
        schema="research",
    )
    op.create_table(
        "triage",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("thread_id", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="running", nullable=False),
        sa.Column(
            "shortlist",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column(
            "selected",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["lab.projects.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("thread_id"),
        schema="lab",
    )
    op.create_table(
        "concepts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("paper_id", sa.Text(), nullable=False),
        sa.Column("concept_key", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column(
            "key_points",
            postgresql.ARRAY(sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("source", sa.Text(), server_default="llm", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["paper_id"], ["research.papers.paper_id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("paper_id", "concept_key"),
        schema="research",
    )
    op.create_table(
        "paper_topics",
        sa.Column("paper_id", sa.Text(), nullable=False),
        sa.Column("topic_id", sa.Integer(), nullable=False),
        sa.Column("relevance", sa.Float(), server_default="0", nullable=False),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("rank", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["paper_id"], ["research.papers.paper_id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["topic_id"], ["research.topics.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("paper_id", "topic_id"),
        schema="research",
    )
    op.create_table(
        "claims",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("paper_id", sa.Text(), nullable=False),
        sa.Column("concept_id", sa.Integer(), nullable=False),
        sa.Column("category", sa.Text(), nullable=True),
        sa.Column("technique", sa.Text(), nullable=False),
        sa.Column("change_required", sa.Text(), nullable=True),
        sa.Column("primary_metric", sa.Text(), nullable=True),
        sa.Column("claimed_value", sa.Float(), nullable=True),
        sa.Column("claimed_unit", sa.Text(), nullable=True),
        sa.Column("direction", sa.Text(), nullable=True),
        sa.Column("claimed_gain_pct", sa.Float(), nullable=True),
        sa.Column("testable", sa.Boolean(), server_default="false", nullable=False),
        sa.Column(
            "requires_cuda", sa.Boolean(), server_default="false", nullable=False
        ),
        sa.Column(
            "requires_multi_gpu", sa.Boolean(), server_default="false", nullable=False
        ),
        sa.Column(
            "requires_training", sa.Boolean(), server_default="false", nullable=False
        ),
        sa.Column("effort", sa.Text(), nullable=True),
        sa.Column("evidence_quote", sa.Text(), nullable=True),
        sa.Column("card", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("group_id", sa.Integer(), nullable=True),
        sa.Column(
            "tsv",
            postgresql.TSVECTOR(),
            sa.Computed(
                "setweight(to_tsvector('english', coalesce(technique, '')), 'A') || setweight(to_tsvector('english', coalesce(change_required, '')), 'B') || setweight(to_tsvector('english', coalesce(primary_metric, '') || ' ' || coalesce(category, '')), 'B') || setweight(to_tsvector('english', coalesce(evidence_quote, '')), 'C')",
                persisted=True,
            ),
            nullable=True,
        ),
        sa.Column(
            "embedding", pgvector.sqlalchemy.vector.VECTOR(dim=384), nullable=True
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["concept_id"], ["research.concepts.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["group_id"], ["research.claim_groups.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["paper_id"], ["research.papers.paper_id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("concept_id"),
        schema="research",
    )
    op.create_index(
        "ix_claims_embedding",
        "claims",
        ["embedding"],
        unique=False,
        schema="research",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )
    op.create_index(
        "ix_claims_tsv",
        "claims",
        ["tsv"],
        unique=False,
        schema="research",
        postgresql_using="gin",
    )
    op.create_table(
        "experiments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("claim_id", sa.Integer(), nullable=False),
        sa.Column("triage_id", sa.Integer(), nullable=True),
        sa.Column("thread_id", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="planning", nullable=False),
        sa.Column(
            "spec",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("flag_name", sa.Text(), nullable=True),
        sa.Column("branch", sa.Text(), nullable=True),
        sa.Column("worktree_path", sa.Text(), nullable=True),
        sa.Column(
            "build",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["claim_id"], ["research.claims.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["lab.projects.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["triage_id"], ["lab.triage.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("thread_id"),
        schema="lab",
    )
    op.create_table(
        "matches",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("claim_id", sa.Integer(), nullable=False),
        sa.Column("fit", sa.Float(), nullable=False),
        sa.Column("gain", sa.Float(), nullable=False),
        sa.Column("effort_cost", sa.Float(), nullable=False),
        sa.Column("score", sa.Float(), nullable=False),
        sa.Column("testable_here", sa.Boolean(), nullable=False),
        sa.Column(
            "blockers", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("target_metric", sa.Text(), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["claim_id"], ["research.claims.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["lab.projects.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "claim_id"),
        schema="lab",
    )
    op.create_table(
        "runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("experiment_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="running", nullable=False),
        sa.Column("command", sa.Text(), nullable=True),
        sa.Column(
            "results",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("results_path", sa.Text(), nullable=True),
        sa.Column("log_path", sa.Text(), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["experiment_id"], ["lab.experiments.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        schema="lab",
    )
    op.create_table(
        "verdicts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("experiment_id", sa.Integer(), nullable=False),
        sa.Column("verdict", sa.Text(), nullable=False),
        sa.Column("primary_metric", sa.Text(), nullable=False),
        sa.Column("median_delta_pct", sa.Float(), nullable=True),
        sa.Column("ci_low_pct", sa.Float(), nullable=True),
        sa.Column("ci_high_pct", sa.Float(), nullable=True),
        sa.Column("claimed_gain_pct", sa.Float(), nullable=True),
        sa.Column("quality_ok", sa.Boolean(), nullable=False),
        sa.Column(
            "details",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("report_path", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["experiment_id"], ["lab.experiments.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("experiment_id"),
        schema="lab",
    )


def downgrade() -> None:
    op.drop_table("verdicts", schema="lab")
    op.drop_table("runs", schema="lab")
    op.drop_table("matches", schema="lab")
    op.drop_table("experiments", schema="lab")
    op.drop_index(
        "ix_claims_tsv", table_name="claims", schema="research", postgresql_using="gin"
    )
    op.drop_index(
        "ix_claims_embedding",
        table_name="claims",
        schema="research",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )
    op.drop_table("claims", schema="research")
    op.drop_table("paper_topics", schema="research")
    op.drop_table("concepts", schema="research")
    op.drop_table("triage", schema="lab")
    op.drop_table("topics", schema="research")
    op.drop_index(
        "ix_papers_tsv", table_name="papers", schema="research", postgresql_using="gin"
    )
    op.drop_index(
        "ix_papers_embedding",
        table_name="papers",
        schema="research",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )
    op.drop_index("ix_papers_doi", table_name="papers", schema="research")
    op.drop_index("ix_papers_arxiv_id", table_name="papers", schema="research")
    op.drop_table("papers", schema="research")
    op.drop_table("claim_groups", schema="research")
    op.drop_table("projects", schema="lab")
