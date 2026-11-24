"""LLM response cache in Postgres (replaces data/llm_cache/*.json)

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-23 16:30:00
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "llm_cache",
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("schema_name", sa.Text(), nullable=True),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("key"),
        schema="research",
    )
    _import_cache_files()


def _import_cache_files() -> None:
    """One-off import of the old file cache ({"meta": {...}, "value": str} per <key>.json)."""
    folder = Path(os.environ.get("PAPERATLAS_DATA_DIR", "data")) / "llm_cache"
    if not folder.is_dir():
        return
    rows = []
    for path in sorted(folder.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict) or not isinstance(data.get("value"), str):
            continue
        meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
        rows.append(
            {
                "key": path.stem,
                "model": str(meta.get("model") or ""),
                "schema_name": meta.get("schema"),
                "value": data["value"].replace("\x00", ""),
            }
        )
    if rows:
        op.get_bind().execute(
            sa.text(
                "INSERT INTO research.llm_cache (key, model, schema_name, value) "
                "VALUES (:key, :model, :schema_name, :value) ON CONFLICT (key) DO NOTHING"
            ),
            rows,
        )


def downgrade() -> None:
    op.drop_table("llm_cache", schema="research")
