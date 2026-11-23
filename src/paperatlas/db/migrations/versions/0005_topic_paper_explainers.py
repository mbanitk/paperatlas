"""topic and paper explainers

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-23 15:20:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("topics", "papers"):
        op.add_column(
            table,
            sa.Column("explainer", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            schema="research",
        )


def downgrade() -> None:
    for table in ("topics", "papers"):
        op.drop_column(table, "explainer", schema="research")
