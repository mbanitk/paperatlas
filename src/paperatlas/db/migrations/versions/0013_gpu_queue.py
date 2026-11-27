"""Fair GPU queue: tickets so benchmarks get the GPU first-come, first-served

Revision ID: 0013_gpu_queue
Revises: 0011, 0012_claim_needs
Create Date: 2026-11-26 19:30:00
"""

from __future__ import annotations

from alembic import op

revision = "0013_gpu_queue"
down_revision = ("0011", "0012_claim_needs")
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE SEQUENCE IF NOT EXISTS lab.gpu_ticket_seq")


def downgrade() -> None:
    op.execute("DROP SEQUENCE IF EXISTS lab.gpu_ticket_seq")
