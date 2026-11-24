"""Phase 4b — Run: interleaved A/B benchmarks via the target project's own harness."""

from __future__ import annotations

import json
import logging
import re
import shlex
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Literal, Optional

from sqlalchemy import update

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Experiment, Run
from paperatlas.lab.events import Reporter
from paperatlas.lab.gpu import gpu_lock, wait_for_quiet_gpu
from paperatlas.lab.planner import SAFE_WORKLOAD, _workload_names
from paperatlas.lab.process import run_command
from paperatlas.lab.protocol import comparison_arms, tune_configs, uses_paper_baseline, workload_file
from paperatlas.lab.safety import redact

logger = logging.getLogger(__name__)

REQUIRED_KEYS = ("schema_version", "rounds", "arms", "quality", "environment")


class RunFailed(RuntimeError):
    pass


def validate_results(results: dict[str, Any]) -> list[str]:
    problems = [f"missing key '{key}'" for key in REQUIRED_KEYS if key not in results]
    arms = [round_["arm"] for round_ in results.get("rounds", [])]
    if not {"baseline", "variant"} <= set(arms):
        problems.append(f"rounds must contain baseline and variant arms, got {sorted(set(arms))}")
    elif arms.count("baseline") != arms.count("variant"):
        problems.append(f"unequal rounds per arm: baseline {arms.count('baseline')}, variant {arms.count('variant')}")
    return problems


def check_workload(workload: str, profile: dict[str, Any]) -> str:
    allowed = _workload_names(profile)
    if allowed and workload not in allowed:
        raise RunFailed(f"workload {workload!r} is not one of the profile's workloads {allowed}")
    if not allowed and not SAFE_WORKLOAD.fullmatch(str(workload)):
        raise RunFailed(f"workload {workload!r} must match {SAFE_WORKLOAD.pattern} (the profile lists no workloads)")
    return str(workload)


def render_command(template: str, **values: Any) -> str:
    """Fill the profile's command template with every substituted value shell-quoted (it runs via the shell)."""
    for name in values:
        template = re.sub(rf"""(["'])\{{{name}\}}\1""", f"{{{name}}}", template)
    return template.format(**{name: shlex.quote(str(value)) for name, value in values.items()})


def _set_status(experiment_id: int, status: str) -> None:
    with session_scope() as session:
        session.execute(
            update(Experiment)
            .where(Experiment.id == experiment_id, Experiment.status.notin_(("cancelling", "cancelled")))
            .values(status=status, updated_at=datetime.now(UTC))
        )


def run_benchmark(
    experiment_id: int,
    kind: Literal["smoke", "tune", "eval", "adopt"],
    workdir: Path,
    spec: dict[str, Any],
    profile: dict[str, Any],
    artifacts: Path,
    report: Reporter,
    should_cancel: Callable[[], bool],
    baseline_config: Optional[dict[str, Any]] = None,
    variant_config: Optional[dict[str, Any]] = None,
    rounds: Optional[int] = None,
    quality: bool = True,
    label: str = "",
) -> dict[str, Any]:
    """One interleaved A/B run. smoke/tune/eval use the claim check (paper baseline, paper workload);
    adopt compares the method against the project's default on the project's workload."""
    template = (profile.get("commands") or {}).get("bench_ab")
    if not template:
        raise RunFailed("Project profile has no commands.bench_ab")
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S-%f")
    out = artifacts / f"{kind}-{stamp}.json"
    log_path = artifacts / f"{kind}-{stamp}.log"
    rounds = rounds or (2 if kind == "smoke" else spec["rounds"])
    comparison = "adopt" if kind == "adopt" else "claim"
    arms = comparison_arms(spec, comparison, baseline_config, variant_config)
    if spec.get("baseline_flags") and "{baseline_flags}" not in template:
        report(kind, "bench command has no {baseline_flags} placeholder; prerequisites stay off in the baseline", None, level="warning")
    if uses_paper_baseline(spec) and comparison == "claim" and "{baseline_flags}" not in template:
        raise RunFailed("The claim check needs the paper's baseline mode, but bench_ab has no {baseline_flags} placeholder")
    paper_workload = workload_file(spec, artifacts) if comparison == "claim" else None
    workload = str(paper_workload) if paper_workload else check_workload(spec["workload"], profile)
    workload_label = "paper regime" if paper_workload else spec["workload"]
    command = render_command(
        template,
        model="smoke" if kind == "smoke" else spec["model"],
        flags=",".join(arms["variant_flags"]),
        baseline_flags=",".join(arms["baseline_flags"]),
        workload=workload,
        rounds=int(rounds),
        out=out,
        warmup=int(spec.get("warmup", 1)),
    )
    if "{warmup}" not in template and spec.get("warmup") is not None and "--warmup" not in command:
        command += f" --warmup {int(spec['warmup'])}"
    env = {"R2E_ARM_PARAMS": json.dumps(arms["params"])}
    if not quality:
        env["R2E_NO_QUALITY"] = "1"
    with session_scope() as session:
        run = Run(experiment_id=experiment_id, kind=kind, command=command, results_path=str(out), log_path=str(log_path))
        session.add(run)
        session.flush()
        run_id = run.id

    status, results = "failed", {}
    active_status = {"smoke": "smoke_testing", "tune": "tuning"}.get(kind, "running")

    def on_wait() -> None:
        _set_status(experiment_id, "waiting_gpu")
        report("waiting_gpu", "Waiting for the GPU (another benchmark is running)", None)

    stage = {"adopt": "run", "eval": "run"}.get(kind, kind)
    try:
        with gpu_lock(on_wait=on_wait, should_cancel=should_cancel):
            quiet = wait_for_quiet_gpu(lambda message: report(stage, message, None, level="warning"),
                                       should_cancel=should_cancel) if kind != "smoke" else {"checked": False}
            if quiet.get("checked") and not quiet.get("quiet"):
                report(stage, f"GPU still {quiet['background_gpu_pct']}% busy from other apps after "
                       f"{quiet['waited_s']}s; measuring anyway (expect noisier results)", None, level="warning")
            _set_status(experiment_id, active_status)
            what = {"smoke": "Smoke A/B", "tune": "Tuning", "eval": "Claim check", "adopt": "Adoption check"}[kind]
            report(
                stage,
                f"{what}{f' ({label})' if label else ''}: {rounds} rounds per arm, workload {workload_label}",
                {"command": command, "params": arms["params"]},
            )
            result = run_command(
                command,
                workdir,
                log_path,
                timeout_s=spec.get("smoke_timeout_s" if kind == "smoke" else "eval_timeout_s", 3600),
                env=env,
                should_cancel=should_cancel,
                on_progress=lambda line: report(stage, redact(line)[:300], None),
                progress_every_s=15,
            )
        if not result.ok:
            raise RunFailed(f"{kind} benchmark failed (exit {result.returncode}):\n{redact(result.tail[-2000:])}")
        if not out.exists():
            raise RunFailed(f"{kind} benchmark produced no results file at {out}")
        results = json.loads(out.read_text(encoding="utf-8"))
        problems = validate_results(results)
        if problems:
            raise RunFailed(f"Results do not match the bench contract: {problems}")
        results["background_gpu"] = quiet
        results["comparison"] = {
            "kind": comparison,
            "workload": workload_label,
            "baseline": "paper baseline" if comparison == "claim" and uses_paper_baseline(spec) else "project default",
            "baseline_config": baseline_config or {},
            "variant_config": variant_config or {},
        }
        env_info = results.get("environment") or {}
        if env_info.get("on_ac_power") is False:
            report(stage, "Mac was on battery during the run; results may be noisier", None, level="warning")
        if env_info.get("thermal_warning"):
            report(stage, "Thermal throttling was detected during the run", None, level="warning")
        status = "done"
        return results
    finally:
        with session_scope() as session:
            session.execute(
                update(Run)
                .where(Run.id == run_id)
                .values(status=status, results=results, finished_at=datetime.now(UTC))
            )


def _arm_median(results: dict[str, Any], arm: str, metric: str) -> Optional[float]:
    summary = ((results.get("summary") or {}).get(arm) or {}).get(metric) or {}
    value = summary.get("median")
    return float(value) if isinstance(value, (int, float)) else None


def _better(a: Optional[float], b: Optional[float], direction: str) -> bool:
    if a is None:
        return False
    if b is None:
        return True
    return a > b if direction == "higher_is_better" else a < b


def tune(
    experiment_id: int,
    workdir: Path,
    spec: dict[str, Any],
    profile: dict[str, Any],
    artifacts: Path,
    report: Reporter,
    should_cancel: Callable[[], bool],
) -> dict[str, Any]:
    """Short sweep of the paper's knobs on the eval model. Each arm keeps its own best configuration,
    so the paper's baseline gets the same tuning budget as the method."""
    configs = tune_configs(spec.get("knobs") or [])
    if not spec.get("tune") or len(configs) < 2:
        default = configs[0] if configs else {}
        return {"configs": configs, "trials": [], "baseline": default, "variant": default, "skipped": True}
    metric, direction = spec["primary_metric"], spec["direction"]
    trials: list[dict[str, Any]] = []
    best = {"baseline": (None, configs[0]), "variant": (None, configs[0])}
    for index, config in enumerate(configs, 1):
        label = f"{index}/{len(configs)} " + ", ".join(f"{k}={v}" for k, v in config.items())
        results = run_benchmark(
            experiment_id, "tune", workdir, spec, profile, artifacts, report, should_cancel,
            baseline_config=config, variant_config=config, rounds=int(spec.get("tune_rounds") or 1),
            quality=False, label=label,
        )
        trial = {
            "config": config,
            "baseline": _arm_median(results, "baseline", metric),
            "variant": _arm_median(results, "variant", metric),
        }
        trials.append(trial)
        for arm in ("baseline", "variant"):
            if _better(trial[arm], best[arm][0], direction):
                best[arm] = (trial[arm], config)
        report("tune", f"Config {label}: baseline {trial['baseline']}, method {trial['variant']} ({metric})", {"trial": trial})
    chosen = {
        "configs": configs,
        "trials": trials,
        "metric": metric,
        "baseline": best["baseline"][1] if uses_paper_baseline(spec) else {},
        "variant": best["variant"][1],
        "skipped": False,
    }
    report("tune", f"Tuned: method uses {chosen['variant']}" + (f", paper baseline uses {chosen['baseline']}" if uses_paper_baseline(spec) else ""), {"tuning": chosen})
    return chosen
