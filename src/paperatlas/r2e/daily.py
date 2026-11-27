"""Daily research run: find new papers, prepare their claim cards, and keep the experiment batch going.

Scheduled by launchd (`paperatlas r2e schedule --daily --hour 0 --install`). Only new work is done: papers already
in the database are not fetched again, distilled papers are not re-distilled, existing explainers are kept, and the
batch skips claims already tested on the current engine. The run itself is short. It starts the services and the
batch as their own background processes when they are not running and then exits, so a batch that takes days never
blocks the next day's search (launchd doesn't start a job again while it is still running).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from sqlalchemy import func, select

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Match, Paper, Triage, Worker
from paperatlas.settings import data_dir

SCAN_DONE = ("awaiting_pick", "picked", "failed", "done")
SCAN_TIMEOUT_S = 4 * 3600
WORKER_FRESH_S = 120  # workers heartbeat every 30 s


def run_daily(
    project: str,
    parallel: int = 3,
    min_likelihood: str = "marginal",
    per_topic: int | None = None,
    distill_limit: int = 60,
    say: Callable[[str], None] = print,
) -> dict:
    from paperatlas.db import migrate
    from paperatlas.lab.profiler import get_project

    migrate.upgrade()
    project_id = get_project(project).id
    before = _counts(project_id)
    say(f"Daily run for {project}: {before['papers']} papers, {before['testable']} testable claims so far")
    services = ensure_services(say)
    scan_status = scan(project_id, per_topic, distill_limit, say)
    after = _counts(project_id)
    say(
        f"Scan {scan_status}: {after['papers'] - before['papers']} new papers, "
        f"{after['testable'] - before['testable']:+d} testable claims ({after['testable']} in all)"
    )
    explained = prepare(project_id, after["testable"], say)
    batch = ensure_batch(project, project_id, parallel, min_likelihood, say)
    return {"services": services, "scan": scan_status, "explained": explained, "batch": batch, "before": before, "after": after}


def _counts(project_id: int) -> dict[str, int]:
    with session_scope() as session:
        papers = session.scalar(select(func.count()).select_from(Paper))
        testable = session.scalar(
            select(func.count()).where(Match.project_id == project_id, Match.testable_here.is_(True))
        )
    return {"papers": papers or 0, "testable": testable or 0}


def worker_alive() -> bool:
    with session_scope() as session:
        fresh = func.now() - func.make_interval(0, 0, 0, 0, 0, 0, WORKER_FRESH_S)
        return bool(
            session.scalar(select(func.count()).where(Worker.stopped_at.is_(None), Worker.last_seen_at > fresh))
        )


def ensure_services(say: Callable[[str], None], wait_s: float = 120) -> str:
    """Start `paperatlas services up` in the background unless a worker is alive."""
    if worker_alive():
        say("Services are running")
        return "running"
    pid = _spawn(["services", "up"], data_dir() / "logs" / "services.log")
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline and not worker_alive():
        time.sleep(5)
    say(f"Started the services (pid {pid})" + ("" if worker_alive() else "; the worker hasn't checked in yet"))
    return "started"


def scan(project_id: int, per_topic: int | None, distill_limit: int, say: Callable[[str], None]) -> str:
    """Topics → discover → distill → match, run here (only the scan job, never experiment jobs)."""
    from paperatlas.lab import service
    from paperatlas.lab.events import claim_next_job
    from paperatlas.lab.orchestrator import setup_checkpointer
    from paperatlas.services.worker import execute, lease_keeper

    options = {"refresh_topics": True, "per_topic": per_topic, "distill_limit": distill_limit, "use_llm": True}
    try:
        triage_id = service.start_triage(project_id, options)["id"]
    except service.ServiceError as exc:
        if exc.status_code != 409:
            raise
        with session_scope() as session:
            triage_id = session.scalar(
                select(Triage.id).where(Triage.project_id == project_id, Triage.status.notin_(SCAN_DONE)).order_by(Triage.id)
            )
        say(f"Scan {triage_id} was still open; finishing it")
    setup_checkpointer()
    deadline = time.monotonic() + SCAN_TIMEOUT_S
    with lease_keeper():
        while (status := service.get_triage(triage_id)["status"]) not in SCAN_DONE:
            if time.monotonic() > deadline:
                say(f"Scan {triage_id} is still {status} after {SCAN_TIMEOUT_S // 3600} h; moving on")
                break
            job = claim_next_job(kinds=["triage.run"])
            if job is not None:
                execute(job)
            else:
                time.sleep(10)  # the worker is running it
    return status


def prepare(project_id: int, testable: int, say: Callable[[str], None]) -> dict[str, int]:
    """Explainers for new topics, papers, concept maps and testable claim cards (existing ones are kept)."""
    from paperatlas.r2e.explainers import backfill

    try:
        result = backfill(project_id, claims_top=max(testable, 1), report=lambda stage, message, data=None: None)
    except Exception as exc:  # noqa: BLE001 - explanations are for people; experiments don't need them
        say(f"Explanations skipped: {exc}")
        return {}
    say(
        f"Explained {result['topics']} topics, {result['papers']} papers, {result['claims']} claims "
        f"and {result['maps']} concept maps"
    )
    return result


def ensure_batch(project: str, project_id: int, parallel: int, min_likelihood: str, say: Callable[[str], None]) -> str:
    """Start a background batch for untested claims unless one is already running (it picks up new claims itself)."""
    from paperatlas.lab.batch import batch_running, pending_claims

    if batch_running(project_id):
        say("A batch is already running; it will pick up the new claims")
        return "running"
    pending = pending_claims(project_id, current_engine_only=True, min_likelihood=min_likelihood)
    if not pending:
        say("No untested claims; no batch needed")
        return "idle"
    args = ["r2e", "batch", "--project", project, "--retest", "--parallel", str(parallel), "--min-likelihood", min_likelihood]
    pid = _spawn(args, data_dir() / "logs" / "batch.log")
    say(f"Started a batch for {len(pending)} untested claims (pid {pid}, {parallel} at a time)")
    return "started"


def _spawn(args: list[str], log: Path) -> int:
    """Start a long-running `paperatlas` command in its own session (it outlives this run), kept awake."""
    executable = Path(sys.executable).with_name("paperatlas")
    command = [str(executable) if executable.exists() else (shutil.which("paperatlas") or "paperatlas"), *args]
    if caffeinate := shutil.which("caffeinate"):
        command = [caffeinate, "-i", *command]
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a", encoding="utf-8") as out:
        out.write(f"===== {datetime.now():%Y-%m-%d %H:%M:%S} started by the daily run: {' '.join(args)} =====\n")
        out.flush()
        process = subprocess.Popen(
            command, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True
        )
    return process.pid
