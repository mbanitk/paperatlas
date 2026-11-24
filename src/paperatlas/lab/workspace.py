"""Git worktrees + environments for experiments in the target project."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Optional

from paperatlas import settings


class WorkspaceError(RuntimeError):
    pass


def git(repo: str | Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=300)
    if check and result.returncode != 0:
        raise WorkspaceError(f"git {' '.join(args)} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout.strip()


def artifacts_dir(experiment_id: int) -> Path:
    path = settings.data_dir().resolve() / "r2e" / "experiments" / str(experiment_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def branch_name(experiment_id: int, flag_name: str) -> str:
    return f"r2e/exp-{experiment_id}-{flag_name.replace('_', '-')}"


BASE_MARKER = "r2e-base"


def create_worktree(repo: str | Path, experiment_id: int, flag_name: str, base: str = "main") -> tuple[Path, str]:
    branch = branch_name(experiment_id, flag_name)
    path = settings.data_dir().resolve() / "r2e" / "worktrees" / f"exp-{experiment_id}"
    if path.exists() and (path / ".git").exists():
        if _read_base(path) is None:
            _record_base(path, git(path, "merge-base", base, "HEAD", check=False) or git(repo, "rev-parse", base))
        return path, branch
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = git(repo, "branch", "--list", branch)
    if existing:
        git(repo, "worktree", "add", str(path), branch)
        base_sha = git(repo, "merge-base", base, branch, check=False) or git(repo, "rev-parse", f"{base}^{{commit}}")
    else:
        base_sha = git(repo, "rev-parse", f"{base}^{{commit}}")
        git(repo, "worktree", "add", "-b", branch, str(path), base_sha)
    _record_base(path, base_sha)
    return path, branch


def _marker_path(worktree: str | Path) -> Path:
    marker = Path(git(worktree, "rev-parse", "--git-path", BASE_MARKER))
    return marker if marker.is_absolute() else Path(worktree) / marker


def _record_base(worktree: str | Path, sha: str) -> None:
    _marker_path(worktree).write_text(sha.strip() + "\n", encoding="utf-8")


def _read_base(worktree: str | Path) -> Optional[str]:
    try:
        sha = _marker_path(worktree).read_text(encoding="utf-8").strip()
    except (OSError, WorkspaceError):
        return None
    if sha and git(worktree, "cat-file", "-t", sha, check=False) == "commit":
        return sha
    return None


def base_ref(worktree: str | Path, fallback: str = "main") -> str:
    """The commit the experiment branch was created from (recorded at worktree creation).

    Falls back to the merge-base with ``fallback`` (the profiled base branch) for older worktrees."""
    return _read_base(worktree) or git(worktree, "merge-base", fallback, "HEAD", check=False) or fallback


def _split_z(output: str) -> list[str]:
    return [item for item in output.split("\0") if item]


def changed_files(worktree: str | Path, base: str = "main") -> list[str]:
    """Files changed since the recorded base: committed, staged, unstaged and untracked (no rename folding)."""
    ref = base_ref(worktree, base)
    committed = _split_z(_git_raw(worktree, "diff", "--name-only", "-z", "--no-renames", f"{ref}...HEAD"))
    pending = _split_z(_git_raw(worktree, "status", "--porcelain", "-z", "--untracked-files=all", "--no-renames"))
    files = set(committed)
    files.update(entry[3:] for entry in pending if len(entry) > 3)
    return sorted(files)


def diff_stat(worktree: str | Path, base: str = "main") -> str:
    return git(worktree, "diff", "--stat", f"{base_ref(worktree, base)}...HEAD", check=False)


def _git_raw(repo: str | Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise WorkspaceError(f"git {' '.join(args)} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


def commit_all(worktree: str | Path, message: str) -> Optional[str]:
    if not git(worktree, "status", "--porcelain"):
        return None
    git(worktree, "add", "-A")
    git(
        worktree,
        "-c",
        "user.name=PaperAtlas R2E",
        "-c",
        "user.email=paperatlas@localhost",
        "commit",
        "-m",
        message,
    )
    return git(worktree, "rev-parse", "HEAD")


def merge_branch(repo: str | Path, branch: str, message: str, base: str = "main") -> str:
    current = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    if current != base:
        raise WorkspaceError(f"{repo} is on '{current}', expected '{base}' to merge into")
    if git(repo, "status", "--porcelain", "--untracked-files=no"):
        raise WorkspaceError(f"{repo} has uncommitted changes; commit or stash them before merging")
    if int(git(repo, "rev-list", "--count", f"{base}..{branch}") or 0) == 0:
        raise WorkspaceError(f"branch {branch} has no commits to merge into {base}")
    git(repo, "merge", "--no-ff", branch, "-m", message)
    return git(repo, "rev-parse", "HEAD")


def remove_worktree(repo: str | Path, worktree: Optional[str | Path], branch: Optional[str], delete_branch: bool) -> None:
    if worktree and Path(worktree).exists():
        git(repo, "worktree", "remove", "--force", str(worktree), check=False)
    git(repo, "worktree", "prune", check=False)
    if delete_branch and branch:
        git(repo, "branch", "-D", branch, check=False)
