from __future__ import annotations

from contextlib import contextmanager
from functools import lru_cache
from typing import Iterator, Optional

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from paperatlas.settings import database_url


@lru_cache(maxsize=4)
def get_engine(url: Optional[str] = None) -> Engine:
    return create_engine(url or database_url(), pool_pre_ping=True)


@contextmanager
def session_scope(url: Optional[str] = None) -> Iterator[Session]:
    session = sessionmaker(bind=get_engine(url), expire_on_commit=False)()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
