"""Serialize GPU-bound steps (benchmarks) across worker threads/processes with a Postgres
advisory lock, so only one benchmark uses the Apple GPU at a time."""

from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Callable, Iterator, Optional

import psycopg

from paperatlas.lab.process import Cancelled
from paperatlas.settings import libpq_url

GPU_LOCK_KEY = 7_242_001


@contextmanager
def gpu_lock(
    on_wait: Optional[Callable[[], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
    poll_s: float = 5.0,
) -> Iterator[None]:
    with psycopg.connect(libpq_url(), autocommit=True) as conn:
        waited = False
        while not conn.execute("SELECT pg_try_advisory_lock(%s)", (GPU_LOCK_KEY,)).fetchone()[0]:
            if not waited and on_wait:
                on_wait()
            waited = True
            if should_cancel and should_cancel():
                raise Cancelled("cancelled while waiting for the GPU")
            time.sleep(poll_s)
        try:
            yield
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (GPU_LOCK_KEY,))
