"""`paperatlas` command line: database, services, and the Research → Experiment loop.

The CLI and the web console share the same service layer and job queue, so a gate can be
approved from either. Long-running steps are executed by the worker
(`paperatlas services up`, or `paperatlas r2e worker`).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from typing import Any

from paperatlas.services.common import configure_logging


def _print(value: Any) -> None:
    print(json.dumps(value, indent=2, default=str))


def _table(rows: list[dict[str, Any]], columns: list[tuple[str, str, int]]) -> None:
    if not rows:
        print("(none)")
        return
    print("  ".join(f"{title:<{width}}" for _, title, width in columns))
    for row in rows:
        cells = []
        for key, _, width in columns:
            value = row.get(key)
            if isinstance(value, float):
                value = f"{value:.3f}"
            text = "" if value is None else str(value)
            cells.append(f"{text[:width]:<{width}}")
        print("  ".join(cells))


def _project_id(name_or_id: str) -> int:
    from paperatlas.lab.profiler import get_project

    return get_project(name_or_id).id


def _parse_sets(values: list[str]) -> dict[str, Any]:
    overrides: dict[str, Any] = {}
    for item in values or []:
        key, _, raw = item.partition("=")
        try:
            overrides[key.strip()] = json.loads(raw)
        except json.JSONDecodeError:
            overrides[key.strip()] = raw
    return overrides


def _drain(experiment_id: int | None = None) -> None:
    from paperatlas.lab.events import claim_next_job
    from paperatlas.lab.orchestrator import setup_checkpointer
    from paperatlas.services.worker import execute, lease_keeper

    setup_checkpointer()
    with lease_keeper():
        while (job := claim_next_job()) is not None:
            print(f"→ running job {job['id']} ({job['kind']})", flush=True)
            execute(job)


# ---- command handlers ------------------------------------------------------------------


def cmd_db(args: argparse.Namespace) -> None:
    from paperatlas.db import migrate

    if args.action == "upgrade":
        migrate.upgrade()
        print("database schema is up to date")
    else:
        migrate.current()


def cmd_services(args: argparse.Namespace) -> None:
    from paperatlas.services.supervisor import up

    sys.exit(up(args.only, args.host, args.reload))


def cmd_worker(args: argparse.Namespace) -> None:
    if args.once:
        _drain()
        return
    from paperatlas.services.worker import run_worker

    run_worker(args.concurrency)


def cmd_topics(args: argparse.Namespace) -> None:
    from paperatlas.discovery.topics import list_topics, refresh_topics

    topics = refresh_topics(use_llm=not args.no_llm) if args.action == "refresh" else list_topics(args.all)
    _table(topics, [("rank", "#", 3), ("name", "topic", 44), ("seed", "seed area", 32), ("trend_score", "trend", 6), ("needs_gpu_cluster", "cluster?", 8)])


def cmd_discover(args: argparse.Namespace) -> None:
    from paperatlas.discovery.ranking import discover

    stats = discover(args.topic, args.per_topic, expand=not args.no_expand, fetch_text=not args.no_text)
    print(f"{len(stats.selected)} papers selected across {stats.topics} topics; {stats.text_fetched} PDFs parsed")


def cmd_distill(args: argparse.Namespace) -> None:
    from paperatlas.concepts.extraction.generate import run

    run(args)


def cmd_claims(args: argparse.Namespace) -> None:
    from paperatlas.lab import service

    if args.id:
        _print(service.get_claim(args.id))
        return
    result = service.list_claims(args.q, args.category, args.topic, True if args.testable else None, limit=args.limit)
    _table(result["items"], [("id", "id", 5), ("category", "category", 22), ("claimed_gain_pct", "gain%", 7), ("effort", "effort", 6), ("name", "concept", 60)])


def cmd_project(args: argparse.Namespace) -> None:
    from paperatlas.lab.profiler import get_project, project_dict, register_project

    if args.action == "add":
        project = register_project(args.path, args.name)
        print(f"registered project {project['name']} (id {project['id']}) from {project['repo_path']}")
    elif args.action == "profile":
        project = get_project(args.name or args.path)
        _print(register_project(project.repo_path, project.name))
    else:
        from sqlalchemy import select

        from paperatlas.db.engine import session_scope
        from paperatlas.db.schema import Project

        with session_scope() as session:
            rows = [project_dict(p) for p in session.scalars(select(Project)).all()]
        _table(rows, [("id", "id", 4), ("name", "name", 20), ("repo_path", "path", 60)])


def cmd_match(args: argparse.Namespace) -> None:
    from paperatlas.lab.matcher import match_project

    ranked = match_project(_project_id(args.project), use_llm=not args.no_llm, explain_top=args.explain_top)
    print(f"matched {len(ranked)} claims; {sum(1 for r in ranked if not r['blockers'])} testable here")


def cmd_recommend(args: argparse.Namespace) -> None:
    from paperatlas.lab import service

    rows = service.recommendations(_project_id(args.project), args.limit, args.all)
    for row in rows:
        row["blockers"] = ", ".join(row["blockers"])
    _table(rows, [("rank", "#", 3), ("claim_id", "claim", 6), ("score", "score", 6), ("target_metric", "metric", 22), ("claimed_gain_pct", "gain%", 7), ("name", "concept", 48), ("blockers", "blockers", 30)])


def cmd_scan(args: argparse.Namespace) -> None:
    from paperatlas.lab import service

    triage = service.start_triage(
        _project_id(args.project),
        {"refresh_topics": args.refresh_topics, "per_topic": args.per_topic, "distill_limit": args.distill_limit, "use_llm": not args.no_llm},
    )
    print(f"research scan {triage['id']} queued")
    if args.inline:
        _drain()
        print(f"scan status: {service.get_triage(triage['id'])['status']}")


def cmd_pick(args: argparse.Namespace) -> None:
    from paperatlas.lab import service

    experiments = service.create_experiments(_project_id(args.project), args.claim_ids, args.triage, args.force, args.mode)
    for experiment in experiments:
        print(f"experiment {experiment['id']} created for claim {experiment['claim_id']}: {experiment['title']}")
    if args.inline:
        _drain()


def cmd_status(args: argparse.Namespace) -> None:
    from paperatlas.lab import service

    project_id = _project_id(args.project) if args.project else None
    rows = service.list_experiments(project_id, args.filter)
    _table(rows, [("id", "id", 4), ("status", "status", 18), ("gate", "gate", 12), ("verdict", "verdict", 14), ("median_delta_pct", "Δ%", 7), ("flag_name", "flag", 24), ("title", "concept", 40)])


def cmd_show(args: argparse.Namespace) -> None:
    from paperatlas.lab import service

    experiment = service.get_experiment(args.experiment)
    if not args.full:
        experiment.pop("claim", None)
        experiment["events"] = [f"[{e['stage']}] {e['message']}" for e in service.experiment_events(args.experiment)[-15:]]
    _print(experiment)


def cmd_gate(args: argparse.Namespace) -> None:
    from paperatlas.lab import service

    if args.gate_action in ("approve", "revise", "reject"):
        result = service.decide_spec(args.experiment, args.gate_action, _parse_sets(args.set) or None, args.comment)
    else:
        result = service.decide_merge(args.experiment, args.gate_action, args.comment)
    print(f"experiment {result['id']}: {result['status']}")
    if args.inline:
        _drain()


def cmd_control(args: argparse.Namespace) -> None:
    from paperatlas.lab import service

    result = service.cancel_experiment(args.experiment) if args.control == "cancel" else service.retry_experiment(args.experiment)
    print(f"experiment {result['id']}: {result['status']}")


def cmd_watch(args: argparse.Namespace) -> None:
    from paperatlas.lab import service

    cursor = 0
    while True:
        for event in service.experiment_events(args.experiment, cursor):
            cursor = event["id"]
            print(f"{event['created_at'][11:19]} [{event['stage']}] {event['message']}", flush=True)
        status = service.experiment_status(args.experiment)
        if status in service.TERMINAL_STATUSES or status in service.GATE_OF_STATUS:
            print(f"status: {status}")
            return
        time.sleep(2)


def cmd_digest(args: argparse.Namespace) -> None:
    from paperatlas.r2e.digest import write_digest

    path = write_digest(_project_id(args.project), days=args.days)
    print(f"digest written to {path}")


def cmd_batch(args: argparse.Namespace) -> None:
    from datetime import datetime

    from paperatlas.lab.batch import run_batch

    def say(message: str) -> None:
        print(f"{datetime.now():%H:%M:%S} {message}", flush=True)

    run_batch(_project_id(args.project), limit=args.limit, poll_s=args.poll, say=say)


def cmd_report(args: argparse.Namespace) -> None:
    from paperatlas.lab.report import rerender_report

    print(f"report written to {rerender_report(args.experiment)}")


def cmd_explain(args: argparse.Namespace) -> None:
    from paperatlas.r2e.explainers import backfill

    project_id = _project_id(args.project) if args.project else None
    result = backfill(
        project_id, args.claims, not args.no_papers, not args.no_topics, args.force, args.workers, maps=not args.no_maps
    )
    print(
        f"explained {result['topics']} topics, {result['papers']} papers, {result['claims']} claims; "
        f"{result['maps']} concept maps"
    )


def cmd_schedule(args: argparse.Namespace) -> None:
    from paperatlas.r2e.schedule import schedule, unschedule

    if args.remove:
        print("weekly scan removed" if unschedule() else "no weekly scan installed")
        return
    result = schedule(args.project, args.weekday, args.hour, install=args.install)
    print(f"installed {result}" if args.install else result)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="paperatlas", description=__doc__.split("\n")[0])
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    db = sub.add_parser("db", help="database schema")
    db.add_argument("action", choices=["upgrade", "current"])
    db.set_defaults(func=cmd_db)

    services = sub.add_parser("services", help="run the microservices")
    services_sub = services.add_subparsers(dest="action", required=True)
    services_up = services_sub.add_parser("up", help="start gateway, research-api, lab-api and worker")
    services_up.add_argument("--only", nargs="+", choices=["gateway", "research", "lab", "worker"])
    services_up.add_argument("--host", default="127.0.0.1")
    services_up.add_argument("--reload", action="store_true")
    services_up.set_defaults(func=cmd_services)

    r2e = sub.add_parser("r2e", help="Research → Experiment")
    r2e_sub = r2e.add_subparsers(dest="r2e_command", required=True)

    worker = r2e_sub.add_parser("worker", help="run the job worker in the foreground")
    worker.add_argument("--concurrency", type=int, default=3)
    worker.add_argument("--once", action="store_true", help="drain the queue and exit")
    worker.set_defaults(func=cmd_worker)

    topics = r2e_sub.add_parser("topics", help="top trending topics")
    topics.add_argument("action", choices=["list", "refresh"], nargs="?", default="list")
    topics.add_argument("--all", action="store_true", help="include archived topics")
    topics.add_argument("--no-llm", action="store_true")
    topics.set_defaults(func=cmd_topics)

    discover = r2e_sub.add_parser("discover", help="rank papers per topic and fetch full text")
    discover.add_argument("--topic", action="append")
    discover.add_argument("--per-topic", type=int)
    discover.add_argument("--no-expand", action="store_true")
    discover.add_argument("--no-text", action="store_true")
    discover.set_defaults(func=cmd_discover)

    distill = r2e_sub.add_parser("distill", help="papers → concepts → claim cards")
    from paperatlas.concepts.extraction.generate import add_arguments

    add_arguments(distill)
    distill.set_defaults(func=cmd_distill)

    claims = r2e_sub.add_parser("claims", help="list / search claim cards")
    claims.add_argument("id", nargs="?", type=int)
    claims.add_argument("--q")
    claims.add_argument("--category")
    claims.add_argument("--topic")
    claims.add_argument("--testable", action="store_true")
    claims.add_argument("--limit", type=int, default=30)
    claims.set_defaults(func=cmd_claims)

    project = r2e_sub.add_parser("project", help="target projects")
    project.add_argument("action", choices=["add", "list", "profile"])
    project.add_argument("path", nargs="?", help="repo path (add) or project name (profile)")
    project.add_argument("--name")
    project.set_defaults(func=cmd_project)

    match = r2e_sub.add_parser("match", help="score claims against a project")
    match.add_argument("--project", required=True)
    match.add_argument("--no-llm", action="store_true")
    match.add_argument("--explain-top", type=int, default=15, help="generate explainers for the top N")
    match.set_defaults(func=cmd_match)

    recommend = r2e_sub.add_parser("recommend", help="show recommendations for a project")
    recommend.add_argument("--project", required=True)
    recommend.add_argument("--limit", type=int, default=20)
    recommend.add_argument("--all", action="store_true", help="include blocked claims")
    recommend.set_defaults(func=cmd_recommend)

    scan = r2e_sub.add_parser("scan", help="topics → discover → distill → match (ends at Gate 1)")
    scan.add_argument("--project", required=True)
    scan.add_argument("--refresh-topics", action="store_true")
    scan.add_argument("--per-topic", type=int)
    scan.add_argument("--distill-limit", type=int, default=60)
    scan.add_argument("--no-llm", action="store_true")
    scan.add_argument("--inline", action="store_true", help="run now instead of waiting for the worker")
    scan.set_defaults(func=cmd_scan)

    pick = r2e_sub.add_parser("pick", help="Gate 1: pick claims to test")
    pick.add_argument("claim_ids", nargs="+", type=int)
    pick.add_argument("--project", required=True)
    pick.add_argument("--triage", type=int)
    pick.add_argument("--force", action="store_true")
    pick.add_argument("--mode", choices=["single", "bundle", "chain"], default="single",
                      help="bundle: include prerequisites in one experiment; chain: prerequisites first")
    pick.add_argument("--inline", action="store_true")
    pick.set_defaults(func=cmd_pick)

    status = r2e_sub.add_parser("status", help="experiments")
    status.add_argument("--project")
    status.add_argument("--filter", help="status, 'active' or 'needs_you'")
    status.set_defaults(func=cmd_status)

    show = r2e_sub.add_parser("show", help="experiment details")
    show.add_argument("experiment", type=int)
    show.add_argument("--full", action="store_true")
    show.set_defaults(func=cmd_show)

    for gate_action, help_text in [
        ("approve", "Gate 2: approve the spec (optionally --set field=value)"),
        ("revise", "Gate 2: ask for a revised spec (--comment required)"),
        ("reject", "Gate 2: reject the experiment"),
        ("merge", "Gate 3: merge the experiment branch"),
        ("drop", "Gate 3: drop the experiment branch"),
    ]:
        gate = r2e_sub.add_parser(gate_action, help=help_text)
        gate.add_argument("experiment", type=int)
        gate.add_argument("--comment")
        gate.add_argument("--inline", action="store_true")
        if gate_action == "approve":
            gate.add_argument("--set", action="append", metavar="FIELD=VALUE")
        gate.set_defaults(func=cmd_gate, gate_action=gate_action, set=None)

    for control in ("cancel", "retry"):
        command = r2e_sub.add_parser(control, help=f"{control} an experiment")
        command.add_argument("experiment", type=int)
        command.set_defaults(func=cmd_control, control=control)

    watch = r2e_sub.add_parser("watch", help="follow an experiment until its next gate")
    watch.add_argument("experiment", type=int)
    watch.set_defaults(func=cmd_watch)

    digest = r2e_sub.add_parser("digest", help="HTML digest of new testable claims and verdicts")
    digest.add_argument("--project", required=True)
    digest.add_argument("--days", type=int, default=7)
    digest.set_defaults(func=cmd_digest)

    batch = r2e_sub.add_parser(
        "batch", help="run every claim testable on the project, one experiment at a time (auto-approves Gate 2)"
    )
    batch.add_argument("--project", required=True)
    batch.add_argument("--limit", type=int, default=None)
    batch.add_argument("--poll", type=float, default=20.0)
    batch.set_defaults(func=cmd_batch)

    report = r2e_sub.add_parser("report", help="re-render an experiment's HTML report from stored results")
    report.add_argument("experiment", type=int)
    report.set_defaults(func=cmd_report)

    explain = r2e_sub.add_parser("explain", help="generate plain-language explainers + diagrams")
    explain.add_argument("--project", help="also explain the top claims for this project")
    explain.add_argument("--claims", type=int, default=25, help="top N recommendations to explain")
    explain.add_argument("--no-papers", action="store_true")
    explain.add_argument("--no-topics", action="store_true")
    explain.add_argument("--no-maps", action="store_true", help="skip concept maps (links between a paper's concepts)")
    explain.add_argument("--force", action="store_true", help="regenerate existing explainers")
    explain.add_argument("--workers", type=int, default=4)
    explain.set_defaults(func=cmd_explain)

    weekly = r2e_sub.add_parser("schedule", help="weekly scan + digest via launchd (prints the plist unless --install)")
    weekly.add_argument("--project", default="inference-lab")
    weekly.add_argument("--weekday", type=int, default=1, help="0=Sunday … 6=Saturday")
    weekly.add_argument("--hour", type=int, default=8)
    weekly.add_argument("--install", action="store_true")
    weekly.add_argument("--remove", action="store_true")
    weekly.set_defaults(func=cmd_schedule)
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    configure_logging(logging.DEBUG if args.verbose else logging.INFO)
    from paperatlas.lab.service import ServiceError

    try:
        args.func(args)
    except ServiceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
