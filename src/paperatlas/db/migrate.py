"""Programmatic Alembic entry points (`paperatlas db upgrade`)."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from alembic import command
from alembic.config import Config

from paperatlas.settings import database_url

MIGRATIONS_DIR = Path(__file__).with_name("migrations")


def alembic_config(url: Optional[str] = None) -> Config:
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    config.set_main_option("sqlalchemy.url", (url or database_url()).replace("%", "%%"))
    return config


def upgrade(url: Optional[str] = None, revision: str = "head") -> None:
    command.upgrade(alembic_config(url), revision)


def downgrade(url: Optional[str] = None, revision: str = "base") -> None:
    command.downgrade(alembic_config(url), revision)


def current(url: Optional[str] = None) -> None:
    command.current(alembic_config(url), verbose=False)
