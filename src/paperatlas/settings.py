"""Runtime settings, read from environment variables (and a local `.env` file)."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

DEFAULT_DATABASE_URL = "postgresql+psycopg://localhost/paperatlas"
DEFAULT_LLM_MODEL = "gpt-5.2"
DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
EMBEDDING_DIM = 384


@lru_cache(maxsize=1)
def load_env() -> None:
    try:
        from dotenv import find_dotenv, load_dotenv
    except ImportError:  # pragma: no cover - optional at import time
        return
    load_dotenv(find_dotenv(usecwd=True), override=False)


def env(name: str, default: str | None = None) -> str | None:
    load_env()
    value = os.getenv(name)
    return value if value not in (None, "") else default


def database_url() -> str:
    return env("PAPERATLAS_DATABASE_URL", DEFAULT_DATABASE_URL)


def libpq_url(url: str | None = None) -> str:
    """Plain libpq URL (no SQLAlchemy driver suffix), for psycopg / LangGraph."""
    url = url or database_url()
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


def data_dir() -> Path:
    path = Path(env("PAPERATLAS_DATA_DIR", "data"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def llm_api_key() -> str | None:
    return env("PAPERATLAS_LLM_API_KEY") or env("OPENAI_API_KEY")


def llm_model() -> str:
    return env("PAPERATLAS_LLM_MODEL", DEFAULT_LLM_MODEL)


def llm_base_url() -> str:
    return env("PAPERATLAS_LLM_BASE_URL", DEFAULT_LLM_BASE_URL)


def llm_timeout() -> float:
    return float(env("PAPERATLAS_LLM_TIMEOUT", "300"))


def copilot_cli_flags(model: str | None = None) -> list[str]:
    """Model, context-tier and reasoning-effort flags for every `copilot` CLI call (LLM and builder)."""
    flags = ["--model", model] if model else []
    if context := env("PAPERATLAS_COPILOT_CONTEXT"):
        flags += ["--context", context]
    if effort := env("PAPERATLAS_COPILOT_REASONING_EFFORT"):
        flags += ["--reasoning-effort", effort]
    return flags
