"""Serialize GPU-bound steps (benchmarks) across worker threads/processes with a Postgres
advisory lock, so only one benchmark uses the Apple GPU at a time.

Waiters are served first-come, first-served: each takes a ticket from a sequence and holds a session-level advisory
lock on it while it waits (so a crashed waiter's ticket disappears with its connection). Only the oldest live ticket
may take the GPU. An experiment that releases the GPU between its own stages (smoke → tune → claim → adoption)
gets a new ticket at the back of the queue, so it can't keep re-taking the GPU while others wait."""

from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Callable, Iterator, Optional

import psycopg

from paperatlas.lab.process import Cancelled, WorkerShutdown, shutting_down
from paperatlas.settings import libpq_url

GPU_LOCK_KEY = 7_242_001
GPU_QUEUE_KEY = 7_242_004  # (GPU_QUEUE_KEY, ticket) advisory locks mark the waiters in line

_HEAD_OF_LINE = """
    SELECT min(objid::bigint) FROM pg_locks
    WHERE locktype = 'advisory' AND classid::bigint = %s AND objsubid = 2 AND granted
"""


@contextmanager
def gpu_lock(
    on_wait: Optional[Callable[[], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
    poll_s: float = 2.0,
) -> Iterator[None]:
    with psycopg.connect(libpq_url(), autocommit=True) as conn:
        ticket = conn.execute("SELECT nextval('lab.gpu_ticket_seq') % 2147483647").fetchone()[0]
        conn.execute("SELECT pg_advisory_lock(%s, %s)", (GPU_QUEUE_KEY, ticket))
        in_line = True
        try:
            waited = False
            while True:
                head = conn.execute(_HEAD_OF_LINE, (GPU_QUEUE_KEY,)).fetchone()[0]
                if head in (None, ticket) and conn.execute("SELECT pg_try_advisory_lock(%s)", (GPU_LOCK_KEY,)).fetchone()[0]:
                    break
                if not waited and on_wait:
                    on_wait()
                waited = True
                if shutting_down():
                    raise WorkerShutdown("worker is shutting down")
                if should_cancel and should_cancel():
                    raise Cancelled("cancelled while waiting for the GPU")
                time.sleep(poll_s)
            conn.execute("SELECT pg_advisory_unlock(%s, %s)", (GPU_QUEUE_KEY, ticket))
            in_line = False
            try:
                yield
            finally:
                conn.execute("SELECT pg_advisory_unlock(%s)", (GPU_LOCK_KEY,))
        finally:
            if in_line:
                conn.execute("SELECT pg_advisory_unlock(%s, %s)", (GPU_QUEUE_KEY, ticket))


def gpu_utilization() -> Optional[int]:
    """Current Apple GPU 'Device Utilization %' from the IORegistry (macOS), or None if unavailable."""
    import re
    import subprocess

    try:
        out = subprocess.run(
            ["ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"], capture_output=True, text=True, timeout=5
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = re.search(r'"Device Utilization %"=(\d+)', out)
    return int(match.group(1)) if match else None


def wait_for_quiet_gpu(
    say: Optional[Callable[[str], None]] = None,
    max_wait_s: float = 600.0,
    window_s: float = 10.0,
    threshold: float = 15.0,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> dict:
    """Call while holding the GPU lock, before measuring: other apps (Spotlight / Apple Intelligence indexing,
    video, games) also use the GPU and skew timings. Waits until the mean utilisation over `window_s` is below
    `threshold`% (or `max_wait_s` passes) and reports what it saw."""
    started = time.monotonic()
    announced = False
    while True:
        samples = []
        for _ in range(int(window_s)):
            value = gpu_utilization()
            if value is None:
                return {"checked": False}
            samples.append(value)
            time.sleep(1.0)
        mean = sum(samples) / len(samples)
        waited = time.monotonic() - started
        if mean < threshold or waited >= max_wait_s:
            return {"checked": True, "background_gpu_pct": round(mean, 1), "waited_s": round(waited), "quiet": mean < threshold}
        if should_cancel and should_cancel():
            raise Cancelled("cancelled while waiting for a quiet GPU")
        if say and not announced:
            say(f"Another app is using the GPU ({mean:.0f}% busy); waiting for it to go quiet before measuring")
            announced = True
