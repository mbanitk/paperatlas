"""Progress events (for the UI's live view and the CLI) and the Postgres job queue."""

from __future__ import annotations

import logging
import socket
import os
from datetime import UTC, datetime
from typing import Any, Callable, Optional

from sqlalchemy import select, text, update

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


def claim_next_job(worker_id: str = WORKER_ID, kinds: Optional[list[str]] = None) -> Optional[dict[str, Any]]:
    kind_filter = "AND kind = ANY(:kinds)" if kinds else ""
    with session_scope() as session:
        row = session.execute(
            text(
                f"""
                UPDATE lab.jobs SET status = 'running', locked_by = :worker, started_at = now(),
                       attempts = attempts + 1
                WHERE id = (
                    SELECT id FROM lab.jobs
                    WHERE status = 'queued' AND run_after <= now() {kind_filter}
                    ORDER BY id
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                RETURNING id, kind, payload, experiment_id, triage_id, attempts
                """
            ),
            {"worker": worker_id, "kinds": kinds},
        ).first()
    return row._asdict() if row else None


def finish_job(job_id: int, result: Optional[dict] = None) -> None:
    with session_scope() as session:
        session.execute(
            update(Job).where(Job.id == job_id).values(status="done", finished_at=_now(), result=result)
        )


def fail_job(job_id: int, error: str) -> None:
    with session_scope() as session:
        session.execute(
            update(Job)
            .where(Job.id == job_id)
            .values(status="failed", finished_at=_now(), error=error[:8000])
        )


def requeue_stale_jobs() -> int:
    """Jobs left 'running' by a worker that died are queued again (graphs resume from checkpoints)."""
    with session_scope() as session:
        result = session.execute(
            update(Job)
            .where(Job.status == "running")
            .values(status="queued", locked_by=None, payload=Job.payload.op("||")(text("'{\"resumed\": true}'::jsonb")))
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
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


def list_jobs(limit: int = 50, status: Optional[str] = None) -> list[dict[str, Any]]:
    with session_scope() as session:
        query = select(Job).order_by(Job.id.desc()).limit(limit)
        if status:
            query = query.where(Job.status == status)
        return [job_dict(job) for job in session.scalars(query).all()]
