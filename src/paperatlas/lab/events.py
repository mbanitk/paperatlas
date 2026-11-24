"""Progress events (for the UI's live view and the CLI) and the Postgres job queue."""

from __future__ import annotations

import logging
import os
import socket
from datetime import UTC, datetime
from typing import Any, Callable, Optional

from sqlalchemy import func, select, text, update

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Event, Job

logger = logging.getLogger(__name__)

Reporter = Callable[[str, str, Optional[dict]], None]

WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"


def _now() -> datetime:
    return datetime.now(UTC)


def emit(
    stage: str,
    message: str,
    data: Optional[dict] = None,
    *,
    experiment_id: Optional[int] = None,
    triage_id: Optional[int] = None,
    job_id: Optional[int] = None,
    level: str = "info",
) -> None:
    log = logger.warning if level in ("warning", "error") else logger.info
    log("[%s] %s", stage, message)
    with session_scope() as session:
        session.add(
            Event(
                stage=stage,
                message=message[:4000],
                data=data,
                level=level,
                experiment_id=experiment_id,
                triage_id=triage_id,
                job_id=job_id,
            )
        )


def reporter(
    experiment_id: Optional[int] = None,
    triage_id: Optional[int] = None,
    job_id: Optional[int] = None,
) -> Reporter:
    def report(stage: str, message: str, data: Optional[dict] = None, level: str = "info") -> None:
        emit(
            stage,
            message,
            data,
            experiment_id=experiment_id,
            triage_id=triage_id,
            job_id=job_id,
            level=level,
        )

    return report


def events_since(
    after_id: int = 0,
    experiment_id: Optional[int] = None,
    triage_id: Optional[int] = None,
    limit: int = 500,
) -> list[dict[str, Any]]:
    with session_scope() as session:
        query = select(Event).where(Event.id > after_id)
        if experiment_id is not None:
            query = query.where(Event.experiment_id == experiment_id)
        if triage_id is not None:
            query = query.where(Event.triage_id == triage_id)
        events = session.scalars(query.order_by(Event.id).limit(limit)).all()
        return [event_dict(event) for event in events]


def latest_event_id() -> int:
    with session_scope() as session:
        return session.scalar(select(func.max(Event.id))) or 0


def event_dict(event: Event) -> dict[str, Any]:
    return {
        "id": event.id,
        "stage": event.stage,
        "level": event.level,
        "message": event.message,
        "data": event.data,
        "experiment_id": event.experiment_id,
        "triage_id": event.triage_id,
        "job_id": event.job_id,
        "created_at": event.created_at.isoformat() if event.created_at else None,
    }


# ---- job queue -------------------------------------------------------------


def enqueue(
    kind: str,
    payload: Optional[dict] = None,
    *,
    experiment_id: Optional[int] = None,
    triage_id: Optional[int] = None,
) -> int:
    with session_scope() as session:
        job = Job(kind=kind, payload=payload or {}, experiment_id=experiment_id, triage_id=triage_id)
        session.add(job)
        session.flush()
        job_id = job.id
    logger.info("Queued job %s (%s)", job_id, kind)
    return job_id


CLAIM_LOCK_KEY = 7_242_002
JOB_LEASE_S = float(os.environ.get("PAPERATLAS_JOB_LEASE_S", "300"))
_RESUMED = text("'{\"resumed\": true}'::jsonb")


def claim_next_job(worker_id: str = WORKER_ID, kinds: Optional[list[str]] = None) -> Optional[dict[str, Any]]:
    """Claim the oldest runnable job. Jobs of an experiment/triage that already has a running job
    are skipped, so at most one graph execution per experiment runs at a time; claims are
    serialized with a transaction-level advisory lock so two workers can't both pass that check."""
    kind_filter = "AND j.kind = ANY(:kinds)" if kinds else ""
    with session_scope() as session:
        session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": CLAIM_LOCK_KEY})
        row = session.execute(
            text(
                f"""
                UPDATE lab.jobs SET status = 'running', locked_by = :worker, started_at = now(),
                       heartbeat_at = now(), attempts = attempts + 1
                WHERE id = (
                    SELECT j.id FROM lab.jobs j
                    WHERE j.status = 'queued' AND j.run_after <= now() {kind_filter}
                      AND NOT EXISTS (
                        SELECT 1 FROM lab.jobs r
                        WHERE r.status = 'running'
                          AND ((j.experiment_id IS NOT NULL AND r.experiment_id = j.experiment_id)
                               OR (j.triage_id IS NOT NULL AND r.triage_id = j.triage_id))
                      )
                    ORDER BY j.id
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                RETURNING id, kind, payload, experiment_id, triage_id, attempts
                """
            ),
            {"worker": worker_id, "kinds": kinds},
        ).first()
    return row._asdict() if row else None


def _owned(job_id: int, worker_id: str):
    """Fence: only the worker that currently holds the job's lease may change its outcome."""
    return update(Job).where(Job.id == job_id, Job.status == "running", Job.locked_by == worker_id)


def finish_job(job_id: int, result: Optional[dict] = None, worker_id: str = WORKER_ID) -> bool:
    with session_scope() as session:
        updated = session.execute(
            _owned(job_id, worker_id).values(status="done", finished_at=_now(), result=result)
        ).rowcount
    if not updated:
        logger.warning("Job %s finished but its lease was lost; outcome not recorded", job_id)
    return bool(updated)


def fail_job(job_id: int, error: str, worker_id: str = WORKER_ID) -> bool:
    with session_scope() as session:
        updated = session.execute(
            _owned(job_id, worker_id).values(status="failed", finished_at=_now(), error=error[:8000])
        ).rowcount
    if not updated:
        logger.warning("Job %s failed but its lease was lost; outcome not recorded", job_id)
    return bool(updated)


def requeue_job(job_id: int, worker_id: str = WORKER_ID) -> bool:
    """Hand a job back to the queue (e.g. interrupted by a worker shutdown); resumes from checkpoints."""
    with session_scope() as session:
        updated = session.execute(
            _owned(job_id, worker_id).values(
                status="queued", locked_by=None, heartbeat_at=None, payload=Job.payload.op("||")(_RESUMED)
            )
        ).rowcount
    return bool(updated)


def heartbeat_jobs(job_ids: list[int], worker_id: str = WORKER_ID) -> int:
    """Renew the lease of the jobs this worker is running."""
    if not job_ids:
        return 0
    with session_scope() as session:
        return session.execute(
            update(Job)
            .where(Job.id.in_(job_ids), Job.status == "running", Job.locked_by == worker_id)
            .values(heartbeat_at=func.now())
        ).rowcount or 0


def _dead_local_workers(worker_ids: list[str]) -> list[str]:
    """Workers on this host whose process is gone (their jobs can be reclaimed without waiting)."""
    host = socket.gethostname()
    dead = []
    for worker_id in worker_ids:
        worker_host, _, pid = (worker_id or "").rpartition(":")
        if worker_host != host or not pid.isdigit() or int(pid) == os.getpid():
            continue
        try:
            os.kill(int(pid), 0)
        except ProcessLookupError:
            dead.append(worker_id)
        except PermissionError:
            pass
    return dead


def requeue_stale_jobs(lease_s: Optional[float] = None) -> int:
    """Re-queue running jobs whose lease expired (no heartbeat for `lease_s`) or whose worker
    process on this host is gone; graphs resume from their checkpoints."""
    lease_s = JOB_LEASE_S if lease_s is None else lease_s
    with session_scope() as session:
        holders = session.scalars(select(Job.locked_by).where(Job.status == "running").distinct()).all()
        dead = _dead_local_workers([holder for holder in holders if holder])
        last_seen = func.coalesce(Job.heartbeat_at, Job.started_at, text("'-infinity'::timestamptz"))
        expired = last_seen < func.now() - func.make_interval(0, 0, 0, 0, 0, 0, lease_s)
        stale = (expired | Job.locked_by.in_(dead)) if dead else expired
        result = session.execute(
            update(Job)
            .where(Job.status == "running", stale)
            .values(status="queued", locked_by=None, heartbeat_at=None, payload=Job.payload.op("||")(_RESUMED))
        )
        return result.rowcount or 0


def job_dict(job: Job) -> dict[str, Any]:
    return {
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "payload": job.payload,
        "attempts": job.attempts,
        "error": job.error,
        "result": job.result,
        "experiment_id": job.experiment_id,
        "triage_id": job.triage_id,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "heartbeat_at": job.heartbeat_at.isoformat() if job.heartbeat_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


def list_jobs(limit: int = 50, status: Optional[str] = None) -> list[dict[str, Any]]:
    with session_scope() as session:
        query = select(Job).order_by(Job.id.desc()).limit(limit)
        if status:
            query = query.where(Job.status == status)
        return [job_dict(job) for job in session.scalars(query).all()]
