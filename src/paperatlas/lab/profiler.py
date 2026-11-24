"""Phase 3a — Profile a target project from its `lab.yaml` (+ git and technique registry)."""

from __future__ import annotations

import json
import logging
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Optional

import yaml
from sqlalchemy import select

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Project
from paperatlas.embeddings.text import embed_text

logger = logging.getLogger(__name__)

PROFILE_FILE = "lab.yaml"
REQUIRED_KEYS = ("name", "hardware", "models", "metrics", "commands")


class ProfileError(RuntimeError):
    pass


def _git(repo: Path, *args: str) -> Optional[str]:
    try:
        return subprocess.run(
            ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True, timeout=30
        ).stdout.strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return None


def list_techniques(repo: Path, profile: dict[str, Any]) -> list[dict[str, Any]]:
    """Ask the project for its registered techniques; fall back to scanning file names."""
    command = (profile.get("commands") or {}).get("list_flags")
    venv_python = repo / ".venv" / "bin" / "python"
    if command and venv_python.exists():
        try:
            output = subprocess.run(
                command, shell=True, cwd=repo, capture_output=True, text=True, timeout=180, check=True
            ).stdout
            start = output.find("[")
            return json.loads(output[start:]) if start >= 0 else []
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
            logger.warning("list_flags failed in %s: %s", repo, exc)
    techniques_dir = repo / "src"
    names = [
        path.stem
        for path in techniques_dir.glob("*/techniques/*.py")
        if path.stem not in {"__init__", "base"}
    ]
    return [{"name": name, "description": "", "requires_reload": None, "hooks": []} for name in sorted(names)]


def read_profile(repo_path: str | Path) -> dict[str, Any]:
    repo = Path(repo_path).expanduser().resolve()
    path = repo / PROFILE_FILE
    if not path.exists():
        raise ProfileError(f"{path} not found — the target project must describe itself in {PROFILE_FILE}")
    profile = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    missing = [key for key in REQUIRED_KEYS if key not in profile]
    if missing:
        raise ProfileError(f"{path} is missing keys: {missing}")
    readme = repo / "README.md"
    profile["repo"] = {
        "path": str(repo),
        "branch": _git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
        "sha": _git(repo, "rev-parse", "HEAD"),
        "remote": _git(repo, "remote", "get-url", "origin"),
        "readme_excerpt": readme.read_text(encoding="utf-8")[:3000] if readme.exists() else "",
    }
    profile["techniques"] = list_techniques(repo, profile)
    return profile


def profile_text(profile: dict[str, Any]) -> str:
    hardware = profile.get("hardware") or {}
    metrics = ", ".join(m.get("name", "") for m in profile.get("metrics") or [])
    hooks = "; ".join(
        f"{e.get('name')}: {e.get('description', '')}" for e in profile.get("extension_points") or []
    )
    models = profile.get("models") or {}
    return (
        f"{profile.get('name')}: {profile.get('description', '')} "
        f"Kind: {profile.get('repo_kind', '')}. Hardware: {hardware}. Models: {models}. "
        f"Metrics: {metrics}. Extension points: {hooks}. Constraints: {profile.get('constraints', [])}."
    )


def register_project(repo_path: str | Path, name: Optional[str] = None) -> dict[str, Any]:
    profile = read_profile(repo_path)
    project_name = name or profile["name"]
    vector = embed_text(profile_text(profile))
    with session_scope() as session:
        project = session.scalar(select(Project).where(Project.name == project_name)) or Project(
            name=project_name
        )
        project.repo_path = profile["repo"]["path"]
        project.profile = profile
        project.embedding = vector
        project.profiled_at = datetime.now(UTC)
        session.add(project)
        session.flush()
        return project_dict(project)


def project_dict(project: Project) -> dict[str, Any]:
    profile = project.profile or {}
    return {
        "id": project.id,
        "name": project.name,
        "repo_path": project.repo_path,
        "description": profile.get("description"),
        "hardware": profile.get("hardware"),
        "models": profile.get("models"),
        "metrics": profile.get("metrics"),
        "workloads": profile.get("workloads"),
        "constraints": profile.get("constraints"),
        "techniques": profile.get("techniques"),
        "repo": profile.get("repo"),
        "profiled_at": project.profiled_at.isoformat() if project.profiled_at else None,
        "roofline": project.roofline,
        "roofline_at": project.roofline_at.isoformat() if project.roofline_at else None,
    }


def get_project(name_or_id: str | int) -> Project:
    with session_scope() as session:
        if isinstance(name_or_id, int) or str(name_or_id).isdigit():
            project = session.get(Project, int(name_or_id))
        else:
            project = session.scalar(select(Project).where(Project.name == name_or_id))
        if project is None:
            raise ProfileError(f"Unknown project {name_or_id!r}; register it with `paperatlas r2e project add`")
        return project


class RooflineError(RuntimeError):
    pass


def measure_roofline(project_id: int, report: Optional[Any] = None, model: str = "eval") -> dict[str, Any]:
    """Run the project's `commands.profile` (under the GPU lock) and store the roofline on the project."""
    import tempfile

    from paperatlas import settings
    from paperatlas.lab.gpu import gpu_lock
    from paperatlas.lab.process import run_command
    from paperatlas.lab.runner import render_command

    say = report or (lambda stage, message, data=None, **kw: None)
    with session_scope() as session:
        project = session.get(Project, project_id)
        if project is None:
            raise RooflineError(f"project {project_id} not found")
        repo, profile = Path(project.repo_path), dict(project.profile or {})
    template = (profile.get("commands") or {}).get("profile")
    if not template:
        raise RooflineError("lab.yaml has no commands.profile — the project cannot report its roofline")
    folder = settings.data_dir().resolve() / "r2e" / "roofline" / str(project_id)
    folder.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkstemp(suffix=".json", dir=folder)[1])
    command = render_command(template, model=model, out=out)
    say("roofline", f"Profiling {profile.get('name')} ({model}) to measure where decode time goes", {"command": command})
    with gpu_lock(on_wait=lambda: say("roofline", "Waiting for the GPU", None)):
        result = run_command(command, repo, folder / "profile.log", timeout_s=3600,
                             on_progress=lambda line: say("roofline", line[:300], None))
    if not result.ok or not out.exists() or out.stat().st_size == 0:
        raise RooflineError(f"profile command failed (exit {result.returncode}): {result.tail[-1500:]}")
    roofline = json.loads(out.read_text(encoding="utf-8"))
    if roofline.get("kind") != "profile" or "decode" not in roofline:
        raise RooflineError("profile output does not follow the roofline contract (kind=profile, decode, forward_cost_ms)")
    with session_scope() as session:
        project = session.get(Project, project_id)
        project.roofline = roofline
        project.roofline_at = datetime.now(UTC)
    from paperatlas.lab.costmodel import summarize

    say("roofline", f"Roofline: {summarize(roofline)}", {"roofline": roofline})
    return roofline
