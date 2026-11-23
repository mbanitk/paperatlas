"""concept links and experiment modes

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-23 14:43:24.937353
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "concept_links",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("paper_id", sa.Text(), nullable=False),
        sa.Column("source_concept_id", sa.Integer(), nullable=False),
        sa.Column("target_concept_id", sa.Integer(), nullable=False),
        sa.Column("relation", sa.Text(), nullable=False),
        sa.Column("why", sa.Text(), nullable=True),
        sa.Column("evidence", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["paper_id"], ["research.papers.paper_id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["source_concept_id"], ["research.concepts.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["target_concept_id"], ["research.concepts.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_concept_id", "target_concept_id", "relation"),
        schema="research",
    )
    op.create_index(
        "ix_concept_links_paper",
        "concept_links",
        ["paper_id"],
        unique=False,
        schema="research",
    )
    op.add_column(
        "experiments",
        sa.Column("mode", sa.Text(), server_default="single", nullable=False),
        schema="lab",
    )
    op.add_column(
        "experiments",
        sa.Column(
            "bundle_claim_ids",
            postgresql.ARRAY(sa.Integer()),
            server_default="{}",
            nullable=False,
        ),
        schema="lab",
    )
    op.add_column(
        "experiments",
        sa.Column("depends_on_experiment_id", sa.Integer(), nullable=True),
        schema="lab",
    )
    op.create_foreign_key(
        "experiments_depends_on_experiment_id_fkey",
        "experiments",
        "experiments",
        ["depends_on_experiment_id"],
        ["id"],
        source_schema="lab",
        referent_schema="lab",
        ondelete="SET NULL",
    )
    op.add_column(
        "concepts",
        sa.Column("paper_order", sa.Integer(), nullable=True),
        schema="research",
    )
    op.add_column(
        "concepts", sa.Column("role", sa.Text(), nullable=True), schema="research"
    )
    op.add_column(
        "papers",
        sa.Column(
            "concept_map", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
        schema="research",
    )


def downgrade() -> None:
    op.drop_column("papers", "concept_map", schema="research")
    op.drop_column("concepts", "role", schema="research")
    op.drop_column("concepts", "paper_order", schema="research")
    # WARNING: constraint name is None; this directive will fail as
    # rendered.  Add a name, or use a naming convention; see
    # https://alembic.sqlalchemy.org/en/latest/naming.html
    op.drop_constraint(
        "experiments_depends_on_experiment_id_fkey", "experiments", schema="lab", type_="foreignkey"
    )
    op.drop_column("experiments", "depends_on_experiment_id", schema="lab")
    op.drop_column("experiments", "bundle_claim_ids", schema="lab")
    op.drop_column("experiments", "mode", schema="lab")
    op.drop_index(
        "ix_concept_links_paper", table_name="concept_links", schema="research"
    )
    op.drop_table("concept_links", schema="research")
