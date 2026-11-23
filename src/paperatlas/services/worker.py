"""worker — executes queued jobs (research scans, experiments) from the Postgres job queue."""

from __future__ import annotations

import logging
import signal
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from paperatlas.db import migrate
from paperatlas.lab.events import WORKER_ID, claim_next_job, emit, fail_job, finish_job, requeue_stale_jobs
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
    )


HANDLERS: dict[str, Callable[[dict, dict], dict]] = {
    "explain": _explain,
    "topics.refresh": _topics_refresh,
    "discover": _discover,
    "distill": _distill,
    "match": _match,
    "triage.run": _triage,
    "experiment.run": _experiment,
    "experiment.resume": _experiment,
}


def execute(job: dict[str, Any]) -> None:
    handler = HANDLERS.get(job["kind"])
    started = time.monotonic()
    try:
        if handler is None:
            raise ValueError(f"no handler for job kind {job['kind']!r}")
        result = handler(job["payload"] or {}, job)
        finish_job(job["id"], result)
        logger.info("Job %s (%s) done in %.1fs", job["id"], job["kind"], time.monotonic() - started)
    except Exception as exc:  # noqa: BLE001 - recorded on the job
        logger.exception("Job %s (%s) failed", job["id"], job["kind"])
        fail_job(job["id"], f"{exc}\n{traceback.format_exc()[-6000:]}")


def run_worker(concurrency: int = 3, poll_s: float = 1.0) -> None:
    from paperatlas.lab.orchestrator import setup_checkpointer

    migrate.upgrade()
    setup_checkpointer()
    requeued = requeue_stale_jobs()
    if requeued:
        logger.info("Re-queued %d job(s) left running by a previous worker", requeued)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
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
    logger.info("Worker stopping; waiting for running jobs to finish")


def main() -> None:
    from paperatlas.services.common import configure_logging

    configure_logging()
    run_worker(int(env("PAPERATLAS_WORKER_CONCURRENCY", "3")))


if __name__ == "__main__":
    main()
