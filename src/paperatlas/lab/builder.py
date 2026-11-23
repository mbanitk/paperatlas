"""Phase 4a — Build: a coding agent implements the technique behind a flag, then we verify."""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional, Protocol

from paperatlas.lab.events import Reporter
from paperatlas.lab.process import CommandResult, run_command
from paperatlas.lab.workspace import changed_files, commit_all, diff_stat
from paperatlas.settings import env

logger = logging.getLogger(__name__)

PROTECTED_PATHS = ("configs/workloads.yaml", "configs/quality.jsonl", "lab.yaml")


class BuildFailed(RuntimeError):
    pass


class BuilderAdapter(Protocol):
    name: str

    def available(self) -> bool: ...

    def implement(
        self,
        workdir: Path,
        prompt: str,
        log_path: Path,
        timeout_s: float,
        should_cancel: Optional[Callable[[], bool]],
        on_progress: Optional[Callable[[str], None]],
    ) -> CommandResult: ...


class CopilotCliBuilder:
    name = "copilot"

    def available(self) -> bool:
        return shutil.which("copilot") is not None

    def implement(self, workdir, prompt, log_path, timeout_s, should_cancel, on_progress) -> CommandResult:
        command = [
            "copilot",
            "-p",
            prompt,
            "--allow-all-tools",
            "--no-ask-user",
            "--no-color",
            "--no-auto-update",
            "--share",
            str(log_path.with_suffix(".session.md")),
        ]
        model = env("PAPERATLAS_BUILDER_MODEL")
        if model:
            command += ["--model", model]
        return run_command(
            command, workdir, log_path, timeout_s=timeout_s, should_cancel=should_cancel, on_progress=on_progress
        )


class CodexCliBuilder:
    name = "codex"

    def available(self) -> bool:
        return shutil.which("codex") is not None

    def implement(self, workdir, prompt, log_path, timeout_s, should_cancel, on_progress) -> CommandResult:
        return run_command(
            ["codex", "exec", "--full-auto", prompt],
            workdir,
            log_path,
            timeout_s=timeout_s,
            should_cancel=should_cancel,
            on_progress=on_progress,
        )


BUILDERS: dict[str, type] = {"copilot": CopilotCliBuilder, "codex": CodexCliBuilder}


def get_builder(name: Optional[str] = None) -> BuilderAdapter:
    builder_name = name or env("PAPERATLAS_BUILDER", "copilot")
    if builder_name not in BUILDERS:
        raise BuildFailed(f"Unknown builder {builder_name!r}; choose from {sorted(BUILDERS)}")
    builder = BUILDERS[builder_name]()
    if not builder.available():
        raise BuildFailed(f"Builder {builder_name!r} is not installed / not on PATH")
    return builder


def build_prompt(
    spec: dict[str, Any], claim: dict[str, Any], profile: dict[str, Any], feedback: Optional[str]
) -> str:
    commands = profile.get("commands") or {}
    smoke = commands.get("bench_ab", "").format(
        model="smoke", flags=spec["flag_name"], workload=spec["workload"], rounds=2, out="/tmp/r2e-smoke.json"
    )
    card = claim.get("card") or {}
    lines = [
        f"Implement a research technique in this repository ({profile.get('name')}) as an opt-in feature flag.",
        "Read AGENTS.md and lab.yaml first and follow them.",
        "",
        f"Flag / technique name: `{spec['flag_name']}`",
        f"What to implement: {spec['technique_summary']}",
        f"Implementation notes: {spec['implementation_notes']}",
        f"Source: \"{claim.get('paper_title')}\" — claim: {claim.get('technique')}",
        f"Evidence from the paper: \"{(card.get('evidence') or {}).get('quote', '')}\"",
        f"Expected effect: {spec['primary_metric']} ({spec['direction']}), paper claims {spec.get('claimed_gain_pct')}%.",
        "",
        "Requirements:",
        f"- Register a technique named exactly `{spec['flag_name']}`. It must be OFF by default and the "
        "behaviour with the flag off must be unchanged.",
        f"- Target hardware: {profile.get('hardware')}. Constraints: {profile.get('constraints')}.",
        "- Lossless: greedy outputs with the flag on must be identical to the baseline."
        if spec.get("lossless")
        else "- Approximate technique: keep quality loss minimal; the quality set is a guardrail.",
        f"- Add focused tests under tests/. `{commands.get('test', 'pytest -q')}` must pass.",
        f"- Run a smoke A/B and fix any error: `{smoke}`",
        f"- Do not modify the measurement setup ({', '.join(PROTECTED_PATHS)}) or the benchmark harness.",
        "- Do not add heavy dependencies. No network access is needed beyond the existing model cache.",
        "- Commit your work on the current branch with a clear message.",
        "When finished, reply with a short summary of what you changed and the smoke A/B result.",
    ]
    if feedback:
        lines += ["", "A previous attempt did not pass verification. Fix these problems:", feedback]
    return "\n".join(lines)


def registered_flags(workdir: Path, command: str, log_path: Path) -> list[str]:
    completed = subprocess.run(command, shell=True, cwd=workdir, capture_output=True, text=True, timeout=600)
    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"$ {command}\n{completed.stdout}{completed.stderr}[exit {completed.returncode}]\n")
    start = completed.stdout.find("[")
    try:
        return [item["name"] for item in json.loads(completed.stdout[start:])] if start >= 0 else []
    except (json.JSONDecodeError, KeyError, TypeError):
        return []


@dataclass
class Verification:
    ok: bool
    problems: list[str]
    files: list[str]


def verify_build(workdir: Path, spec: dict[str, Any], profile: dict[str, Any], log_path: Path) -> Verification:
    commands = profile.get("commands") or {}
    problems: list[str] = []
    files = changed_files(workdir)
    if not files:
        problems.append("No changes were made.")
    touched_protected = [path for path in files if path in PROTECTED_PATHS]
    if touched_protected:
        problems.append(f"Measurement files must not change: {touched_protected}")
    if commands.get("list_flags"):
        names = registered_flags(workdir, commands["list_flags"], log_path)
        if spec["flag_name"] not in names:
            problems.append(f"Technique `{spec['flag_name']}` is not registered (list_flags: {names}).")
    if commands.get("test"):
        result = run_command(commands["test"], workdir, log_path, timeout_s=1800)
        if not result.ok:
            problems.append("Tests failed:\n" + "\n".join(result.tail.splitlines()[-25:]))
    return Verification(ok=not problems, problems=problems, files=files)


def build_experiment(
    experiment_id: int,
    workdir: Path,
    spec: dict[str, Any],
    claim: dict[str, Any],
    profile: dict[str, Any],
    artifacts: Path,
    report: Reporter,
    should_cancel: Callable[[], bool],
    max_attempts: int = 3,
    builder: Optional[BuilderAdapter] = None,
) -> dict[str, Any]:
    builder = builder or get_builder()
    commands = profile.get("commands") or {}
    if commands.get("install"):
        report("build", "Installing the project environment in the experiment worktree", None)
        result = run_command(commands["install"], workdir, artifacts / "install.log", timeout_s=1800, should_cancel=should_cancel)
        if not result.ok:
            raise BuildFailed("Environment install failed:\n" + result.tail[-2000:])
    feedback = None
    attempts: list[dict[str, Any]] = []
    for attempt in range(1, max_attempts + 1):
        report("build", f"{builder.name} is implementing `{spec['flag_name']}` (attempt {attempt}/{max_attempts})", None)
        log_path = artifacts / f"build-attempt-{attempt}.log"
        result = builder.implement(
            workdir,
            build_prompt(spec, claim, profile, feedback),
            log_path,
            spec.get("build_timeout_s", 3600),
            should_cancel,
            lambda line: report("build", f"{builder.name}: {line[:300]}", None),
        )
        commit_all(workdir, f"r2e: implement {spec['flag_name']} (experiment {experiment_id})")
        verification = verify_build(workdir, spec, profile, artifacts / f"verify-attempt-{attempt}.log")
        attempts.append(
            {
                "attempt": attempt,
                "agent_exit": result.returncode,
                "duration_s": round(result.duration_s, 1),
                "problems": verification.problems,
                "log": str(log_path),
            }
        )
        if verification.ok:
            info = {
                "builder": builder.name,
                "attempts": attempts,
                "files": verification.files,
                "diff_stat": diff_stat(workdir),
                "agent_summary": result.tail[-3000:],
            }
            report("build", f"Build verified: {len(verification.files)} files changed, tests pass", {"files": verification.files})
            return info
        feedback = "\n".join(verification.problems)
        report("build", f"Verification failed: {feedback[:500]}", None, level="warning")
    raise BuildFailed(f"Build failed after {max_attempts} attempts: {feedback}")
