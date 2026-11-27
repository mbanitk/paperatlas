"""Worker registry: when each worker was last alive, so a restart can resume work a shutdown interrupted

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-24 20:30:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workers",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("stopped_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("recovered_at", sa.DateTime(timezone=True), nullable=True),
        schema="lab",
    )


def downgrade() -> None:
    op.drop_table("workers", schema="lab")
