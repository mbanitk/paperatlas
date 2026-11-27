"""Batch: run every claim that is testable on a project, `parallel` experiments at a time (default 1 = serial).

Each experiment has its own git worktree, so builds (the coding agent, tests) run side by side; GPU benchmarks
always take the GPU lock, so measurements never overlap. A slot frees up when an experiment has finished judging
(it then waits at Gate 3 for a human merge/drop, which does not hold up the queue) or ended (failed, rejected,
cancelled). Gate 2 is approved automatically — the batch is an explicit instruction to run them all. Safe to
restart: claims that already have an experiment are skipped. Only one batch runs per project at a time (a
Postgres advisory lock held for the whole run); a second one exits straight away.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager

from sqlalchemy import select, text

from paperatlas.db.engine import get_engine, session_scope
from paperatlas.db.schema import Experiment, Match, Project
from paperatlas.lab import service

logger = logging.getLogger(__name__)

# The GPU / builder are free once an experiment is in one of these states.
SETTLED = ("awaiting_decision", "finalizing", "merged", "dropped", "rejected", "failed", "cancelled", "blocked")


LIKELIHOOD_ORDER = ("likely", "marginal", "unknown", "unlikely")
BATCH_LOCK_KEY = 7_242_003


@contextmanager
def batch_lock(project_id: int) -> Iterator[bool]:
    """Try to become the project's one running batch; yields whether the lock was taken (held until exit)."""
    keys = {"key": BATCH_LOCK_KEY, "project": project_id}
    engine = get_engine()
    try:
        with engine.connect() as connection:
            held = bool(connection.scalar(text("SELECT pg_try_advisory_lock(:key, :project)"), keys))
            connection.commit()
            try:
                yield held
            finally:
                if held:
                    connection.scalar(text("SELECT pg_advisory_unlock(:key, :project)"), keys)
                    connection.commit()
    finally:
        engine.dispose()


def batch_running(project_id: int) -> bool:
    with batch_lock(project_id) as held:
        return not held


def pending_claims(project_id: int, current_engine_only: bool = False, min_likelihood: str = "unknown") -> list[int]:
    """Testable claims without an experiment, best first. With `current_engine_only`, experiments created before the
    project was last profiled (i.e. on an older engine) don't count, so their claims are tested again."""
    with session_scope() as session:
        query = select(Experiment.claim_id).where(Experiment.project_id == project_id)
        if current_engine_only:
            profiled_at = session.scalar(select(Project.profiled_at).where(Project.id == project_id))
            if profiled_at is not None:
                query = query.where(Experiment.created_at >= profiled_at)
        tried = set(session.scalars(query).all())
        rows = session.execute(
            select(Match.claim_id, Match.prediction)
            .where(Match.project_id == project_id, Match.testable_here.is_(True))
            .order_by(Match.score.desc())
        ).all()
    allowed = set(LIKELIHOOD_ORDER[: LIKELIHOOD_ORDER.index(min_likelihood) + 1])
    return [
        claim_id
        for claim_id, prediction in rows
        if claim_id not in tried and ((prediction or {}).get("likelihood") or "unknown") in allowed
    ]


def busy_experiments(project_id: int) -> list[tuple[int, str]]:
    with session_scope() as session:
        return [
            (e.id, e.status)
            for e in session.scalars(select(Experiment).where(Experiment.project_id == project_id)).all()
            if e.status not in SETTLED
        ]


def approve_waiting(busy: list[tuple[int, str]], say: Callable[[str], None]) -> None:
    for experiment_id, status in busy:
        if status == "awaiting_approval":
            try:
                service.decide_spec(experiment_id, "approve", comment="Approved by the batch run")
                say(f"#{experiment_id}: Gate 2 approved automatically")
            except service.ServiceError as exc:
                say(f"#{experiment_id}: could not approve Gate 2: {exc}")


def run_batch(
    project_id: int,
    limit: int | None = None,
    poll_s: float = 20.0,
    say: Callable[[str], None] = print,
    current_engine_only: bool = False,
    parallel: int = 1,
    min_likelihood: str = "unknown",
) -> list[dict]:
    with batch_lock(project_id) as held:
        if not held:
            say("Another batch is already running for this project; not starting a second one")
            return []
        return _run_batch(project_id, limit, poll_s, say, current_engine_only, parallel, min_likelihood)


def _run_batch(
    project_id: int,
    limit: int | None,
    poll_s: float,
    say: Callable[[str], None],
    current_engine_only: bool,
    parallel: int,
    min_likelihood: str,
) -> list[dict]:
    parallel = max(1, parallel)
    started: list[dict] = []
    reported: set[int] = set()
    skipped: set[int] = set()
    exhausted = False
    while True:
        busy = busy_experiments(project_id)
        approve_waiting(busy, say)
        busy_ids = {experiment_id for experiment_id, _ in busy}
        for item in started:
            if item["id"] not in busy_ids and item["id"] not in reported:
                detail = service.get_experiment(item["id"])
                item.update(status=detail["status"], verdict=detail.get("verdict"))
                reported.add(item["id"])
                say(f"#{item['id']} settled: {detail['status']} · verdict {detail.get('verdict')}")
        room = parallel - len(busy)
        can_start = not exhausted and (limit is None or len(started) < limit)
        if room > 0 and can_start:
            in_flight_claims = {c["claim_id"] for c in started if c["id"] in busy_ids}
            claims = [
                c for c in pending_claims(project_id, current_engine_only, min_likelihood) if c not in skipped and c not in in_flight_claims
            ]
            if not claims:
                exhausted = True
                say("No testable claims left to start")
                continue
            claim_id = claims[0]
            try:
                experiment = service.create_experiments(project_id, [claim_id])[0]
            except service.ServiceError as exc:
                say(f"claim {claim_id} skipped: {exc}")
                skipped.add(claim_id)
                continue
            started.append({"id": experiment["id"], "claim_id": claim_id, "title": experiment.get("title")})
            say(
                f"#{experiment['id']} started for claim {claim_id}: {experiment.get('title')} "
                f"({len(busy) + 1}/{parallel} running, {len(claims) - 1} queued)"
            )
            continue
        if not busy and (not can_start or exhausted):
            break
        time.sleep(poll_s)
    return started
