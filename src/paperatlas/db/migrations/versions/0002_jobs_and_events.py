"""jobs and events

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-23 13:06:03.808654
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "jobs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("status", sa.Text(), server_default="queued", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "run_after",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("locked_by", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("experiment_id", sa.Integer(), nullable=True),
        sa.Column("triage_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["experiment_id"], ["lab.experiments.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["triage_id"], ["lab.triage.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        schema="lab",
    )
    op.create_index(
        "ix_jobs_status_run_after",
        "jobs",
        ["status", "run_after"],
        unique=False,
        schema="lab",
    )
    op.create_table(
        "events",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("job_id", sa.Integer(), nullable=True),
        sa.Column("experiment_id", sa.Integer(), nullable=True),
        sa.Column("triage_id", sa.Integer(), nullable=True),
        sa.Column("stage", sa.Text(), nullable=False),
        sa.Column("level", sa.Text(), server_default="info", nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("data", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["experiment_id"], ["lab.experiments.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["job_id"], ["lab.jobs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["triage_id"], ["lab.triage.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        schema="lab",
    )
    op.create_index(
        "ix_events_experiment",
        "events",
        ["experiment_id", "id"],
        unique=False,
        schema="lab",
    )
    op.create_index(
        "ix_events_triage", "events", ["triage_id", "id"], unique=False, schema="lab"
    )


def downgrade() -> None:
    op.drop_index("ix_events_triage", table_name="events", schema="lab")
    op.drop_index("ix_events_experiment", table_name="events", schema="lab")
    op.drop_table("events", schema="lab")
    op.drop_index("ix_jobs_status_run_after", table_name="jobs", schema="lab")
    op.drop_table("jobs", schema="lab")
