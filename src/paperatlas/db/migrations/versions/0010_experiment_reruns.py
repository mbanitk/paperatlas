"""Re-runs: link an experiment to the one it re-runs

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-23 19:25:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "experiments",
        sa.Column(
            "rerun_of_experiment_id",
            sa.Integer(),
            sa.ForeignKey("lab.experiments.id", ondelete="SET NULL"),
            nullable=True,
        ),
        schema="lab",
    )


def downgrade() -> None:
    op.drop_column("experiments", "rerun_of_experiment_id", schema="lab")
