"""match explainers

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-23 15:05:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "matches",
        sa.Column("explainer", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        schema="lab",
    )
    op.add_column(
        "matches",
        sa.Column("explained_at", sa.DateTime(timezone=True), nullable=True),
        schema="lab",
    )


def downgrade() -> None:
    op.drop_column("matches", "explained_at", schema="lab")
    op.drop_column("matches", "explainer", schema="lab")
