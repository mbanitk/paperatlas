"""worker — executes queued jobs (research scans, experiments) from the Postgres job queue."""

from __future__ import annotations

import logging
import signal
import threading
import time
import traceback
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Iterator

from paperatlas.db import migrate
from paperatlas.lab.events import (
    WORKER_ID,
    claim_next_job,
    emit,
    fail_job,
    finish_job,
    heartbeat_jobs,
    requeue_job,
    requeue_stale_jobs,
)
from paperatlas.lab.process import WorkerShutdown, request_shutdown
from paperatlas.lab.recovery import mark_stopped, register_worker, resume_interrupted, touch_worker
from paperatlas.settings import env

logger = logging.getLogger(__name__)


def _topics_refresh(payload: dict, job: dict) -> dict:
    from paperatlas.discovery.topics import refresh_topics
    from paperatlas.lab.events import reporter

    topics = refresh_topics(use_llm=payload.get("use_llm", True), report=reporter(job_id=job["id"]))
    return {"topics": [t["slug"] for t in topics]}


def _discover(payload: dict, job: dict) -> dict:
    from paperatlas.discovery.ranking import discover
    from paperatlas.lab.events import reporter

    stats = discover(payload.get("topics"), payload.get("per_topic"), payload.get("expand", True), report=reporter(job_id=job["id"]))
    return {"selected": len(stats.selected), "text_fetched": stats.text_fetched}


def _distill(payload: dict, job: dict) -> dict:
    from paperatlas.distill.extractor import ClaimExtractor
    from paperatlas.distill.pipeline import DistillPipeline
    from paperatlas.llm.client import build_default_llm_client

    llm = build_default_llm_client() if payload.get("use_llm", True) else None
    stats = DistillPipeline(extractor=ClaimExtractor(llm)).run(
        limit=payload.get("limit", 30), paper_ids=payload.get("paper_ids"), reprocess=payload.get("reprocess", False)
    )
    emit("distill", f"Distilled {stats.papers} papers → {stats.claims} claims", job_id=job["id"])
    return {"papers": stats.papers, "claims": stats.claims, "testable": stats.testable_claims}


def _match(payload: dict, job: dict) -> dict:
    from paperatlas.lab.events import reporter
    from paperatlas.lab.matcher import match_project

    ranked = match_project(payload["project_id"], use_llm=payload.get("use_llm", True), report=reporter(job_id=job["id"]))
    return {"matched": len(ranked)}


def _roofline(payload: dict, job: dict) -> dict:
    from paperatlas.lab.events import reporter
    from paperatlas.lab.matcher import match_project
    from paperatlas.lab.profiler import measure_roofline

    report = reporter(job_id=job["id"])
    roofline = measure_roofline(payload["project_id"], report, payload.get("model", "eval"))
    if payload.get("rematch", True):
        match_project(payload["project_id"], use_llm=payload.get("use_llm", True), report=report)
    return {"decode": roofline.get("decode"), "forward_cost_ms": roofline.get("forward_cost_ms")}


def _triage(payload: dict, job: dict) -> dict:
    from paperatlas.lab.orchestrator import run_triage

    return {"status": run_triage(payload["triage_id"])}


def _experiment(payload: dict, job: dict) -> dict:
    from paperatlas.lab.orchestrator import run_experiment

    return {"status": run_experiment(payload["experiment_id"], payload.get("resume"))}


def _explain(payload: dict, job: dict) -> dict:
    from paperatlas.lab.events import reporter
    from paperatlas.r2e.explainers import backfill

    return backfill(
        payload.get("project_id"),
        claims_top=payload.get("claims_top", 25),
        papers=payload.get("papers", True),
        topics=payload.get("topics", True),
        force=payload.get("force", False),
        report=reporter(job_id=job["id"]),
        maps=payload.get("maps", True),
    )


HANDLERS: dict[str, Callable[[dict, dict], dict]] = {
    "explain": _explain,
    "topics.refresh": _topics_refresh,
    "discover": _discover,
    "distill": _distill,
    "match": _match,
    "project.roofline": _roofline,
    "triage.run": _triage,
    "experiment.run": _experiment,
    "experiment.resume": _experiment,
}


HEARTBEAT_S = float(env("PAPERATLAS_JOB_HEARTBEAT_S", "30"))
_running: set[int] = set()
_running_lock = threading.Lock()


def running_job_ids() -> list[int]:
    with _running_lock:
        return list(_running)


def execute(job: dict[str, Any]) -> None:
    handler = HANDLERS.get(job["kind"])
    started = time.monotonic()
    with _running_lock:
        _running.add(job["id"])
    try:
        if handler is None:
            raise ValueError(f"no handler for job kind {job['kind']!r}")
        result = handler(job["payload"] or {}, job)
        finish_job(job["id"], result)
        logger.info("Job %s (%s) done in %.1fs", job["id"], job["kind"], time.monotonic() - started)
    except WorkerShutdown:
        logger.warning("Job %s (%s) interrupted by worker shutdown; re-queued", job["id"], job["kind"])
        requeue_job(job["id"])
    except Exception as exc:  # noqa: BLE001 - recorded on the job
        logger.exception("Job %s (%s) failed", job["id"], job["kind"])
        fail_job(job["id"], f"{exc}\n{traceback.format_exc()[-6000:]}")
    finally:
        with _running_lock:
            _running.discard(job["id"])


def _keep_leases(done: threading.Event, interval_s: float = HEARTBEAT_S) -> None:
    """Renew this worker's job leases and reclaim jobs whose worker stopped heartbeating."""
    while not done.wait(interval_s):
        try:
            touch_worker()
            heartbeat_jobs(running_job_ids())
            requeued = requeue_stale_jobs()
            if requeued:
                logger.warning("Re-queued %d job(s) whose worker lease expired", requeued)
        except Exception:  # noqa: BLE001 - retried on the next beat
            logger.exception("Job heartbeat failed")


@contextmanager
def lease_keeper() -> Iterator[None]:
    """Heartbeat this process's running jobs for as long as the block runs."""
    done = threading.Event()
    thread = threading.Thread(target=_keep_leases, args=(done,), name="job-heartbeat", daemon=True)
    thread.start()
    try:
        yield
    finally:
        done.set()


def run_worker(concurrency: int = 3, poll_s: float = 1.0) -> None:
    from paperatlas.lab.orchestrator import setup_checkpointer

    migrate.upgrade()
    setup_checkpointer()
    requeued = requeue_stale_jobs()
    if requeued:
        logger.info("Re-queued %d job(s) left running by a previous worker", requeued)
    resumed = resume_interrupted()
    if resumed["jobs"]:
        experiments = ", ".join(f"#{i}" for i in dict.fromkeys(resumed["experiments"])) or "none"
        logger.warning("Resumed %d job(s) interrupted by the last shutdown (experiments: %s)", len(resumed["jobs"]), experiments)
    register_worker()
    stop = threading.Event()

    def on_signal(*_: Any) -> None:
        # Running commands kill their process groups (they run in their own sessions) and their
        # jobs are re-queued, so nothing keeps the GPU busy once this worker is gone.
        stop.set()
        request_shutdown()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    try:
        with lease_keeper():
            _serve(stop, concurrency, poll_s)
    finally:
        try:
            mark_stopped()
        except Exception:  # noqa: BLE001 - Postgres may already be gone at shutdown
            logger.warning("Could not record the worker stop", exc_info=True)


def _serve(stop: threading.Event, concurrency: int, poll_s: float) -> None:
    slots = threading.Semaphore(concurrency)
    logger.info("Worker %s started (concurrency %d)", WORKER_ID, concurrency)
    with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="job") as pool:
        while not stop.is_set():
            if not slots.acquire(timeout=poll_s):
                continue
            job = claim_next_job()
            if job is None:
                slots.release()
                stop.wait(poll_s)
                continue
            logger.info("Running job %s (%s)", job["id"], job["kind"])

            def task(job=job) -> None:
                try:
                    execute(job)
                finally:
                    slots.release()

            pool.submit(task)
        logger.info("Worker stopping; interrupting running jobs")


def main() -> None:
    from paperatlas.services.common import configure_logging

    configure_logging()
    run_worker(int(env("PAPERATLAS_WORKER_CONCURRENCY", "3")))


if __name__ == "__main__":
    main()
