"""triage options

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-23 13:12:18.439371
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "triage",
        sa.Column(
            "options",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        schema="lab",
    )


def downgrade() -> None:
    op.drop_column("triage", "options", schema="lab")
