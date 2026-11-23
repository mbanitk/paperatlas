from __future__ import annotations

from alembic import context
from sqlalchemy import create_engine, pool, text

from paperatlas.db.schema import AGENT, LAB, RESEARCH, Base

config = context.config
target_metadata = Base.metadata
SCHEMAS = (RESEARCH, LAB, AGENT)


def _include_name(name, type_, parent_names):
    if type_ == "schema":
        return name in SCHEMAS
    return True


def run_migrations_online() -> None:
    engine = create_engine(
        config.get_main_option("sqlalchemy.url"), poolclass=pool.NullPool
    )
    with engine.connect() as connection:
        connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        for schema in SCHEMAS:
            connection.execute(text(f"CREATE SCHEMA IF NOT EXISTS {schema}"))
        connection.commit()
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_schemas=True,
            include_name=_include_name,
            version_table_schema=RESEARCH,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
