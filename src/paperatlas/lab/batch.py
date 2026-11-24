"""One-at-a-time batch: run every claim that is testable on a project, strictly in series.

The next experiment starts only when the previous one has finished judging (it then waits at Gate 3 for a human
merge/drop, which does not hold up the queue) or ended (failed, rejected, cancelled). Gate 2 is approved
automatically — the batch is an explicit instruction to run them all. Safe to restart: claims that already have
an experiment are skipped.
"""

from __future__ import annotations

import logging
import time
from typing import Callable, Optional

from sqlalchemy import select

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Experiment, Match, Project
from paperatlas.lab import service

logger = logging.getLogger(__name__)

# The GPU / builder are free once an experiment is in one of these states.
SETTLED = ("awaiting_decision", "finalizing", "merged", "dropped", "rejected", "failed", "cancelled", "blocked")


def pending_claims(project_id: int, current_engine_only: bool = False) -> list[int]:
    """Testable claims without an experiment, best first. With `current_engine_only`, experiments created before the
    project was last profiled (i.e. on an older engine) don't count, so their claims are tested again."""
    with session_scope() as session:
        query = select(Experiment.claim_id).where(Experiment.project_id == project_id)
        if current_engine_only:
            profiled_at = session.scalar(select(Project.profiled_at).where(Project.id == project_id))
            if profiled_at is not None:
                query = query.where(Experiment.created_at >= profiled_at)
        tried = set(session.scalars(query).all())
        rows = session.scalars(
            select(Match.claim_id)
            .where(Match.project_id == project_id, Match.testable_here.is_(True))
            .order_by(Match.score.desc())
        ).all()
    return [claim_id for claim_id in rows if claim_id not in tried]


def busy_experiments(project_id: int) -> list[tuple[int, str]]:
    with session_scope() as session:
        return [
            (e.id, e.status)
            for e in session.scalars(select(Experiment).where(Experiment.project_id == project_id)).all()
            if e.status not in SETTLED
        ]


def wait_until_settled(project_id: int, poll_s: float, say: Callable[[str], None]) -> None:
    """Block while any experiment is in flight; approve Gate 2 for those waiting on it."""
    while busy := busy_experiments(project_id):
        for experiment_id, status in busy:
            if status == "awaiting_approval":
                service.decide_spec(experiment_id, "approve", comment="Approved by the one-at-a-time batch run")
                say(f"#{experiment_id}: Gate 2 approved automatically")
        time.sleep(poll_s)


def run_batch(
    project_id: int,
    limit: Optional[int] = None,
    poll_s: float = 20.0,
    say: Callable[[str], None] = print,
    current_engine_only: bool = False,
) -> list[dict]:
    done: list[dict] = []
    skipped: set[int] = set()
    while True:
        wait_until_settled(project_id, poll_s, say)
        if done and "status" not in done[-1]:
            last = service.get_experiment(done[-1]["id"])
            done[-1].update(status=last["status"], verdict=last.get("verdict"))
            say(f"#{last['id']} settled: {last['status']} · verdict {last.get('verdict')}")
        if limit is not None and len(done) >= limit:
            break
        claims = [c for c in pending_claims(project_id, current_engine_only) if c not in skipped]
        if not claims:
            say("No testable claims left")
            break
        claim_id = claims[0]
        try:
            experiment = service.create_experiments(project_id, [claim_id])[0]
        except service.ServiceError as exc:
            say(f"claim {claim_id} skipped: {exc}")
            skipped.add(claim_id)
            continue
        done.append({"id": experiment["id"], "claim_id": claim_id, "title": experiment.get("title")})
        say(f"#{experiment['id']} started for claim {claim_id}: {experiment.get('title')} ({len(claims) - 1} left after it)")
    return done
