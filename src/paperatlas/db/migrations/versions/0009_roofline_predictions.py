"""Hardware roofline per project and predicted gain per match (predict before you build)

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-23 19:10:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("roofline", JSONB(), nullable=True), schema="lab")
    op.add_column("projects", sa.Column("roofline_at", sa.DateTime(timezone=True), nullable=True), schema="lab")
    op.add_column("matches", sa.Column("prediction", JSONB(), nullable=True), schema="lab")


def downgrade() -> None:
    op.drop_column("matches", "prediction", schema="lab")
    op.drop_column("projects", "roofline_at", schema="lab")
    op.drop_column("projects", "roofline", schema="lab")
