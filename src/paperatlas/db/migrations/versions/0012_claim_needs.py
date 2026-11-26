"""Pre-screen: what each claim needs (trained drafters, offline artifacts, MoE…), the per-match result, and
when the project's engine last changed

Revision ID: 0012_claim_needs
Revises: 0010
Create Date: 2026-11-25 18:00:00

Branches from 0010 next to 0011 (worker registry, developed in parallel); `paperatlas db upgrade` applies all
heads, so it works with or without 0011.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0012_claim_needs"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "claim_needs",
        sa.Column(
            "claim_id",
            sa.Integer(),
            sa.ForeignKey("research.claims.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("input_hash", sa.Text(), nullable=False),
        sa.Column("needs", JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=True),
        sa.Column("classified_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        schema="research",
    )
    op.add_column("matches", sa.Column("asset_check", JSONB(), nullable=True), schema="lab")
    op.add_column("projects", sa.Column("engine_changed_at", sa.DateTime(timezone=True), nullable=True), schema="lab")
    op.execute("UPDATE lab.projects SET engine_changed_at = profiled_at")


def downgrade() -> None:
    op.drop_column("projects", "engine_changed_at", schema="lab")
    op.drop_column("matches", "asset_check", schema="lab")
    op.drop_table("claim_needs", schema="research")
