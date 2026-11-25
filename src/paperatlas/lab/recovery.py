"""Resume work interrupted by a shutdown (Mac restart, app closed, crash).

Every worker records when it was last alive (`lab.workers`). When a worker starts, it looks at the workers that
are gone. Jobs that failed in the last moments before such a worker stopped failed *because* of the shutdown
(their benchmark server, Postgres or the process itself was being killed), so they go back in the queue instead
of staying failed; experiments then continue from their last completed step (LangGraph checkpoints), like a
retry. Experiments still in progress with no job left to drive them get one too. Failures from well before the
shutdown are real and stay as they are.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Event, Experiment, Job, Triage, Worker
from paperatlas.lab.events import (
    CLAIM_LOCK_KEY,
    JOB_LEASE_S,
    WORKER_ID,
    _dead_local_workers,
)
from paperatlas.settings import env

logger = logging.getLogger(__name__)

# A job that failed this long before its worker was last seen alive counts as interrupted by the shutdown.
SHUTDOWN_WINDOW_S = float(env("PAPERATLAS_SHUTDOWN_WINDOW_S", "120") or 120)
# Experiments updated more recently than this may still be getting their job (e.g. being created right now).
ORPHAN_GRACE_S = 60.0
# Don't keep resuming a job that fails every time.
MAX_ATTEMPTS = 5
# In progress and driven by a job (gates, `blocked` and `cancelling` wait for something else).
IN_PROGRESS = (
    "queued",
    "planning",
    "approving",
    "building",
    "smoke_testing",
    "tuning",
    "waiting_gpu",
    "running",
    "judging",
    "finalizing",
)


def register_worker(worker_id: str = WORKER_ID) -> None:
    """Record this worker as alive (call after `resume_interrupted`, which treats a row with this id as a
    previous process that had the same id, e.g. the same pid after a reboot)."""
    now = func.now()
    with session_scope() as session:
        session.execute(
            insert(Worker)
            .values(id=worker_id)
            .on_conflict_do_update(
                index_elements=[Worker.id],
                set_={"started_at": now, "last_seen_at": now, "stopped_at": None, "recovered_at": None},
            )
        )


def touch_worker(worker_id: str = WORKER_ID) -> None:
    with session_scope() as session:
        session.execute(update(Worker).where(Worker.id == worker_id).values(last_seen_at=func.now()))


def mark_stopped(worker_id: str = WORKER_ID) -> None:
    with session_scope() as session:
        session.execute(update(Worker).where(Worker.id == worker_id).values(last_seen_at=func.now(), stopped_at=func.now()))


def resume_interrupted(worker_id: str = WORKER_ID, window_s: float | None = None) -> dict[str, list[int]]:
    """Re-queue the jobs that gone workers' shutdowns interrupted, and give stranded experiments a job.
    Returns the re-queued/created job ids and the experiments they resume."""
    window = timedelta(seconds=SHUTDOWN_WINDOW_S if window_s is None else window_s)
    resumed: dict[str, list[int]] = {"jobs": [], "experiments": []}
    with session_scope() as session:
        # Same lock as job claims, so nothing is claimed half-way through.
        session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": CLAIM_LOCK_KEY})
        now = session.scalar(select(func.now()))
        workers = session.scalars(select(Worker).where(Worker.recovered_at.is_(None))).all()
        gone_here = set(_dead_local_workers([w.id for w in workers]))
        stale = now - timedelta(seconds=JOB_LEASE_S)
        for worker in workers:
            # A row with our own id is a previous process (we haven't registered yet).
            if not (worker.id == worker_id or worker.stopped_at or worker.id in gone_here or worker.last_seen_at < stale):
                continue
            last_alive = max(t for t in (worker.last_seen_at, worker.stopped_at) if t is not None)
            failed = session.scalars(
                select(Job)
                .where(Job.locked_by == worker.id, Job.status == "failed", Job.finished_at >= last_alive - window)
                .order_by(Job.id)
            ).all()
            for job in failed:
                if _resumable(session, job):
                    _requeue(session, job, "Interrupted by a shutdown", resumed)
            worker.recovered_at = now
        session.flush()

        busy = select(Job.experiment_id).where(Job.status.in_(("queued", "running")), Job.experiment_id.is_not(None))
        stranded = session.scalars(
            select(Experiment)
            .where(
                Experiment.status.in_(IN_PROGRESS),
                Experiment.updated_at < now - timedelta(seconds=ORPHAN_GRACE_S),
                Experiment.id.not_in(busy),
            )
            .order_by(Experiment.id)
        ).all()
        for experiment in stranded:
            last = session.scalars(select(Job).where(Job.experiment_id == experiment.id).order_by(Job.id.desc()).limit(1)).first()
            if last is not None and last.status == "failed":
                if last.attempts < MAX_ATTEMPTS:
                    _requeue(session, last, "Was left without a running job", resumed)
                continue
            job = Job(kind="experiment.run", payload={"experiment_id": experiment.id, "resumed": True}, experiment_id=experiment.id)
            session.add(job)
            session.flush()
            session.add(
                Event(
                    stage="recover",
                    level="warning",
                    message="Was left without a running job; resuming from the last completed step",
                    experiment_id=experiment.id,
                    job_id=job.id,
                )
            )
            resumed["jobs"].append(job.id)
            resumed["experiments"].append(experiment.id)
    return resumed


def _resumable(session: Session, job: Job) -> bool:
    if job.attempts >= MAX_ATTEMPTS:
        return False
    owner = (
        Job.experiment_id == job.experiment_id
        if job.experiment_id
        else Job.triage_id == job.triage_id if job.triage_id else None
    )
    if owner is not None and session.scalar(select(Job.id).where(owner, Job.id > job.id).limit(1)) is not None:
        return False  # superseded: retried, re-run or decided since
    if job.experiment_id:
        status = session.scalar(select(Experiment.status).where(Experiment.id == job.experiment_id))
        return status == "failed" or status in IN_PROGRESS
    if job.triage_id:
        return session.scalar(select(Triage.status).where(Triage.id == job.triage_id)) == "failed"
    return True


def _requeue(session: Session, job: Job, why: str, resumed: dict[str, list[int]]) -> None:
    error = (job.error or "").strip().splitlines()
    when = _clock(job.finished_at)
    job.status, job.locked_by, job.heartbeat_at, job.finished_at, job.error = "queued", None, None, None, None
    job.run_after = func.now()
    job.payload = {**(job.payload or {}), "resumed": True}
    if job.experiment_id:
        # Like a retry: status back to queued, keeping the error so the UI still shows the step it stopped in.
        session.execute(
            update(Experiment)
            .where(Experiment.id == job.experiment_id, Experiment.status == "failed")
            .values(status="queued", updated_at=func.now())
        )
        resumed["experiments"].append(job.experiment_id)
    if job.triage_id:
        session.execute(
            update(Triage).where(Triage.id == job.triage_id, Triage.status == "failed").values(status="queued", updated_at=func.now())
        )
    then = f" at {when}" if when else ""
    session.add(
        Event(
            stage="recover",
            level="warning",
            message=f"{why}{then}; resuming from the last completed step",
            data={"interrupted_error": error[0][:500]} if error else None,
            experiment_id=job.experiment_id,
            triage_id=job.triage_id,
            job_id=job.id,
        )
    )
    resumed["jobs"].append(job.id)
    logger.warning("Re-queued job %s (%s): %s%s", job.id, job.kind, why.lower(), then)


def _clock(moment: datetime | None) -> str:
    return moment.astimezone().strftime("%H:%M") if moment else ""
