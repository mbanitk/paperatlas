"""Serialize GPU-bound steps (benchmarks) across worker threads/processes with a Postgres
advisory lock, so only one benchmark uses the Apple GPU at a time."""

from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Callable, Iterator, Optional

import psycopg

from paperatlas.lab.process import Cancelled, WorkerShutdown, shutting_down
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
            if shutting_down():
                raise WorkerShutdown("worker is shutting down")
            if should_cancel and should_cancel():
                raise Cancelled("cancelled while waiting for the GPU")
            time.sleep(poll_s)
        try:
            yield
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (GPU_LOCK_KEY,))


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
