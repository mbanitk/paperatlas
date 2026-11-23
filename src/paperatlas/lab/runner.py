"""Phase 4b — Run: interleaved A/B benchmarks via the target project's own harness."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Literal

from sqlalchemy import update

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Experiment, Run
from paperatlas.lab.events import Reporter
from paperatlas.lab.gpu import gpu_lock
from paperatlas.lab.process import run_command

logger = logging.getLogger(__name__)

REQUIRED_KEYS = ("schema_version", "rounds", "arms", "quality", "environment")


class RunFailed(RuntimeError):
    pass


def validate_results(results: dict[str, Any]) -> list[str]:
    problems = [f"missing key '{key}'" for key in REQUIRED_KEYS if key not in results]
    arms = {round_["arm"] for round_ in results.get("rounds", [])}
    if not {"baseline", "variant"} <= arms:
        problems.append(f"rounds must contain baseline and variant arms, got {sorted(arms)}")
    return problems


def _set_status(experiment_id: int, status: str) -> None:
    with session_scope() as session:
        session.execute(
            update(Experiment)
            .where(Experiment.id == experiment_id, Experiment.status.notin_(("cancelling", "cancelled")))
            .values(status=status, updated_at=datetime.now(UTC))
        )


def run_benchmark(
    experiment_id: int,
    kind: Literal["smoke", "eval"],
    workdir: Path,
    spec: dict[str, Any],
    profile: dict[str, Any],
    artifacts: Path,
    report: Reporter,
    should_cancel: Callable[[], bool],
) -> dict[str, Any]:
    template = (profile.get("commands") or {}).get("bench_ab")
    if not template:
        raise RunFailed("Project profile has no commands.bench_ab")
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    out = artifacts / f"{kind}-{stamp}.json"
    log_path = artifacts / f"{kind}-{stamp}.log"
    rounds = 2 if kind == "smoke" else spec["rounds"]
    baseline_flags = spec.get("baseline_flags") or []
    if baseline_flags and "{baseline_flags}" not in template:
        report(kind, "bench command has no {baseline_flags} placeholder; prerequisites stay off in the baseline", None, level="warning")
    command = template.format(
        model="smoke" if kind == "smoke" else spec["model"],
        flags=",".join([*baseline_flags, spec["flag_name"]]),
        baseline_flags=",".join(baseline_flags),
        workload=spec["workload"],
        rounds=rounds,
        out=out,
        warmup=spec.get("warmup", 1),
    )
    if "{warmup}" not in template and spec.get("warmup") is not None and "--warmup" not in command:
        command += f" --warmup {spec['warmup']}"
    with session_scope() as session:
        run = Run(experiment_id=experiment_id, kind=kind, command=command, results_path=str(out), log_path=str(log_path))
        session.add(run)
        session.flush()
        run_id = run.id

    status, results = "failed", {}
    active_status = "smoke_testing" if kind == "smoke" else "running"

    def on_wait() -> None:
        _set_status(experiment_id, "waiting_gpu")
        report("waiting_gpu", "Waiting for the GPU (another benchmark is running)", None)

    try:
        with gpu_lock(on_wait=on_wait, should_cancel=should_cancel):
            _set_status(experiment_id, active_status)
            report(kind, f"{kind} A/B started: {rounds} rounds per arm, workload {spec['workload']}", {"command": command})
            result = run_command(
                command,
                workdir,
                log_path,
                timeout_s=spec.get("smoke_timeout_s" if kind == "smoke" else "eval_timeout_s", 3600),
                should_cancel=should_cancel,
                on_progress=lambda line: report(kind, line[:300], None),
                progress_every_s=15,
            )
        if not result.ok:
            raise RunFailed(f"{kind} benchmark failed (exit {result.returncode}):\n{result.tail[-2000:]}")
        if not out.exists():
            raise RunFailed(f"{kind} benchmark produced no results file at {out}")
        results = json.loads(out.read_text(encoding="utf-8"))
        problems = validate_results(results)
        if problems:
            raise RunFailed(f"Results do not match the bench contract: {problems}")
        env_info = results.get("environment") or {}
        if env_info.get("on_ac_power") is False:
            report(kind, "Mac was on battery during the run; results may be noisier", None, level="warning")
        if env_info.get("thermal_warning"):
            report(kind, "Thermal throttling was detected during the run", None, level="warning")
        status = "done"
        return results
    finally:
        with session_scope() as session:
            session.execute(
                update(Run)
                .where(Run.id == run_id)
                .values(status=status, results=results, finished_at=datetime.now(UTC))
            )
