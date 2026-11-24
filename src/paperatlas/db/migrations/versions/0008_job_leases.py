"""Job leases (heartbeat_at) and the lab.triage.status default aligned with the ORM

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-23 17:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True), schema="lab")
    op.alter_column("triage", "status", server_default="queued", schema="lab")


def downgrade() -> None:
    op.alter_column("triage", "status", server_default="running", schema="lab")
    op.drop_column("jobs", "heartbeat_at", schema="lab")
