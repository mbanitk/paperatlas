"""Code changes: the diff an experiment made to the target project, persisted per iteration.

Experiment branches and worktrees are removed when an experiment is dropped (and the worktree when merged), so the
diff is saved under ``data/r2e/experiments/<id>/changes/`` as soon as a build is verified:

- ``iteration-<n>.patch``: the unified diff from the experiment's base commit to that iteration's commit;
- ``iteration-<n>.json``: a summary (files with status, kind and +/- counts, totals, a one-line description).

``lab.experiments.build['code_changes']`` holds the summary of the iteration that was measured (the kept one).
"""

from __future__ import annotations

import json
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Optional

from paperatlas import settings
from paperatlas.lab.workspace import WorkspaceError, artifacts_dir, base_ref, git

MAX_STORED_PATCH_BYTES = 4_000_000
MAX_SUMMARY_FILES = 300
DIFF_OPTIONS = ("--no-color", "--no-ext-diff", "--no-textconv", "--find-renames")
STATUS = {"A": "added", "M": "modified", "D": "deleted", "R": "renamed", "C": "copied", "T": "type_changed"}

SOURCE_SUFFIXES = {
    ".py", ".pyx", ".pxd", ".c", ".cc", ".cpp", ".cu", ".cuh", ".h", ".hpp", ".m", ".mm", ".metal", ".swift",
    ".rs", ".go", ".java", ".kt", ".js", ".jsx", ".ts", ".tsx", ".sh", ".zig",
}
DOC_SUFFIXES = {".md", ".rst", ".txt", ".adoc"}
CONFIG_SUFFIXES = {".yaml", ".yml", ".toml", ".json", ".cfg", ".ini", ".lock", ".jsonl"}


def classify(path: str) -> str:
    """source | test | docs | config | other — used to order the diff and describe the change."""
    posix = PurePosixPath(path)
    name = posix.name.lower()
    parts = {part.lower() for part in posix.parts[:-1]}
    if parts & {"tests", "test", "testing", "__tests__"} or name.startswith("test_") or re.search(r"(_test|\.test|\.spec)\.\w+$", name):
        return "test"
    suffix = posix.suffix.lower()
    if suffix in DOC_SUFFIXES or "docs" in parts or "doc" in parts:
        return "docs"
    if suffix in SOURCE_SUFFIXES:
        return "source"
    if suffix in CONFIG_SUFFIXES or name in ("makefile", "dockerfile"):
        return "config"
    return "other"


def _git_text(repo: str | Path, *args: str) -> str:
    """git output decoded leniently (diffs can contain bytes that aren't UTF-8)."""
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, timeout=300)
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise WorkspaceError(f"git {' '.join(args)} failed: {message}")
    return result.stdout.decode("utf-8", "replace")


def _parse_numstat(output: str) -> list[dict[str, Any]]:
    tokens = output.split("\0")
    files: list[dict[str, Any]] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if not token:
            index += 1
            continue
        added, deleted, path = token.split("\t", 2)
        old_path = None
        if path == "":  # rename/copy with -z: the old and new paths follow
            old_path, path = tokens[index + 1], tokens[index + 2]
            index += 3
        else:
            index += 1
        binary = added == "-" and deleted == "-"
        files.append(
            {
                "path": path,
                "old_path": old_path,
                "additions": None if binary else int(added),
                "deletions": None if binary else int(deleted),
                "binary": binary,
            }
        )
    return files


def _parse_name_status(output: str) -> dict[str, str]:
    tokens = output.split("\0")
    status: dict[str, str] = {}
    index = 0
    while index < len(tokens) and tokens[index]:
        code = tokens[index]
        if code[:1] in ("R", "C"):
            path = tokens[index + 2]
            index += 3
        else:
            path = tokens[index + 1]
            index += 2
        status[path] = STATUS.get(code[:1], "modified")
    return status


def split_patch(patch: str, files: list[dict[str, Any]]) -> list[str]:
    """The patch cut into one chunk per file, in the order of ``files`` ('' when a file has no chunk)."""
    chunks: list[str] = []
    current: list[str] = []
    for line in patch.splitlines(keepends=True):
        if line.startswith("diff --git ") and current:
            chunks.append("".join(current))
            current = []
        current.append(line)
    if current:
        chunks.append("".join(current))
    if len(chunks) == len(files):
        return chunks

    def owner(chunk: str) -> Optional[str]:
        header = chunk.split("\n", 1)[0]
        for file in files:
            if header.endswith(f" b/{file['path']}") or header.endswith(f' "b/{file["path"]}"'):
                return file["path"]
        return None

    by_path = {}
    for chunk in chunks:
        path = owner(chunk)
        if path and path not in by_path:
            by_path[path] = chunk
    return [by_path.get(file["path"], "") for file in files]


def _signed(additions: Optional[int], deletions: Optional[int]) -> str:
    parts = []
    if additions:
        parts.append(f"+{additions:,}")
    if deletions:
        parts.append(f"−{deletions:,}")
    return " ".join(parts) or "±0"


def _group_phrase(kind: str, files: list[dict[str, Any]]) -> str:
    added = sum(f.get("additions") or 0 for f in files)
    deleted = sum(f.get("deletions") or 0 for f in files)
    noun = {"test": "tests", "docs": "docs", "config": "config", "other": "other files"}.get(kind, kind)
    if kind in ("config", "other") and len(files) == 1:
        noun = f"`{PurePosixPath(files[0]['path']).name}`"
    return f"{noun} ({_signed(added, deleted)})"


def describe(files: list[dict[str, Any]], flag_name: Optional[str] = None) -> str:
    """One line on what the diff touches, e.g. "Adds `suffix_decoding.py` (+540) behind the `suffix_decoding` flag,
    with tests (+405) and docs (+69)"."""
    if not files:
        return "No changes to tracked files."
    groups: dict[str, list[dict[str, Any]]] = {}
    for file in files:
        groups.setdefault(file.get("kind") or classify(file["path"]), []).append(file)
    source = sorted(groups.pop("source", []), key=lambda f: -((f.get("additions") or 0) + (f.get("deletions") or 0)))
    extras = [_group_phrase(kind, groups[kind]) for kind in ("test", "docs", "config", "other") if groups.get(kind)]
    if not source:
        return "Only " + _join(extras) + " changed: no engine code was modified."
    verb = "Adds" if all(f.get("status") == "added" for f in source) else "Changes"
    if len(source) <= 2:
        subject = _join([f"`{PurePosixPath(f['path']).name}` ({_signed(f.get('additions'), f.get('deletions'))})" for f in source])
    else:
        added = sum(f.get("additions") or 0 for f in source)
        deleted = sum(f.get("deletions") or 0 for f in source)
        top = source[0]
        subject = f"{len(source)} source files ({_signed(added, deleted)}, mostly `{PurePosixPath(top['path']).name}`)"
    line = f"{verb} {subject}"
    if flag_name:
        line += f" behind the `{flag_name}` flag"
    if extras:
        line += ", with " + _join(extras)
    return line + "."


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def capture(repo: str | Path, base: str, head: str = "HEAD", flag_name: Optional[str] = None) -> tuple[dict[str, Any], str]:
    """Summary and unified diff of ``base..head`` (committed changes only)."""
    base_sha = git(repo, "rev-parse", f"{base}^{{commit}}")
    head_sha = git(repo, "rev-parse", f"{head}^{{commit}}")
    numstat = _git_text(repo, "diff", *DIFF_OPTIONS, "--numstat", "-z", base_sha, head_sha)
    status = _git_text(repo, "diff", *DIFF_OPTIONS, "--name-status", "-z", base_sha, head_sha)
    patch = _git_text(repo, "-c", "core.quotePath=false", "diff", *DIFF_OPTIONS, base_sha, head_sha)
    files = _parse_numstat(numstat)
    statuses = _parse_name_status(status)
    for file in files:
        file["status"] = statuses.get(file["path"], "modified")
        file["kind"] = classify(file["path"])
    summary = {
        "base": base_sha,
        "head": head_sha,
        "files": files,
        "files_changed": len(files),
        "additions": sum(f["additions"] or 0 for f in files),
        "deletions": sum(f["deletions"] or 0 for f in files),
        "summary": describe(files, flag_name),
        "captured_at": datetime.now(UTC).isoformat(),
    }
    return summary, patch


def changes_dir(experiment_id: int) -> Path:
    """Where an experiment's diffs are stored (not created here: reads must not make folders)."""
    return settings.data_dir().resolve() / "r2e" / "experiments" / str(experiment_id) / "changes"


def save(experiment_id: int, iteration: int, summary: dict[str, Any], patch: str) -> dict[str, Any]:
    folder = artifacts_dir(experiment_id) / "changes"
    folder.mkdir(parents=True, exist_ok=True)
    data = patch.encode("utf-8")
    truncated = len(data) > MAX_STORED_PATCH_BYTES
    if truncated:
        data = data[:MAX_STORED_PATCH_BYTES].decode("utf-8", "ignore").encode("utf-8")
    patch_path = folder / f"iteration-{iteration}.patch"
    patch_path.write_bytes(data)
    summary = {
        **summary,
        "iteration": iteration,
        "patch_file": f"changes/{patch_path.name}",
        "patch_bytes": len(patch.encode("utf-8")),
        "patch_truncated": truncated,
    }
    (folder / f"iteration-{iteration}.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    return summary


def record(
    experiment_id: int,
    repo: str | Path,
    base: str,
    iteration: int,
    head: str = "HEAD",
    flag_name: Optional[str] = None,
    source: str = "build",
) -> dict[str, Any]:
    summary, patch = capture(repo, base, head, flag_name)
    return save(experiment_id, iteration, {**summary, "source": source}, patch)


def stored_iterations(experiment_id: int) -> list[int]:
    folder = changes_dir(experiment_id)
    if not folder.exists():
        return []
    found = []
    for path in folder.glob("iteration-*.json"):
        match = re.fullmatch(r"iteration-(\d+)\.json", path.name)
        if match and path.with_suffix(".patch").exists():
            found.append(int(match.group(1)))
    return sorted(found)


def load_summary(experiment_id: int, iteration: int) -> Optional[dict[str, Any]]:
    path = changes_dir(experiment_id) / f"iteration-{iteration}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def load(experiment_id: int, iteration: int) -> Optional[tuple[dict[str, Any], str]]:
    summary = load_summary(experiment_id, iteration)
    if summary is None:
        return None
    try:
        patch = (changes_dir(experiment_id) / f"iteration-{iteration}.patch").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return summary, patch


def light(summary: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """The summary as stored in the experiment row (file list capped)."""
    if not summary:
        return None
    files = summary.get("files") or []
    return {**summary, "files": files[:MAX_SUMMARY_FILES], "files_omitted": max(0, len(files) - MAX_SUMMARY_FILES)}


# ---- where the code lives ------------------------------------------------------------------


def commit_exists(repo: str | Path, sha: Optional[str]) -> bool:
    return bool(sha) and git(repo, "cat-file", "-t", sha, check=False) == "commit"


def branch_exists(repo: str | Path, branch: Optional[str]) -> bool:
    return bool(branch) and bool(git(repo, "rev-parse", "--verify", "-q", f"refs/heads/{branch}", check=False))


def locate(
    repo: str | Path,
    worktree: Optional[str | Path],
    branch: Optional[str],
    base_branch: str = "main",
    merge_sha: Optional[str] = None,
) -> Optional[tuple[Path, str, str]]:
    """(git dir, base commit, head) of an experiment's current code, or None when it is gone.

    Prefers the worktree (whose base commit was recorded at creation); then a merge commit (its second parent is
    the branch tip); then the branch, diffed against its merge-base with the project's base branch."""
    if worktree and Path(worktree).exists() and (Path(worktree) / ".git").exists():
        return Path(worktree), base_ref(worktree, base_branch), "HEAD"
    if not repo or not Path(repo).exists():
        return None
    if merge_sha and commit_exists(repo, merge_sha) and git(repo, "rev-parse", "-q", "--verify", f"{merge_sha}^2", check=False):
        tip = git(repo, "rev-parse", f"{merge_sha}^2")
        base = git(repo, "merge-base", f"{merge_sha}^1", tip, check=False)
        if base:
            return Path(repo), base, tip
    if branch_exists(repo, branch):
        base = git(repo, "merge-base", base_branch, branch, check=False)
        if base:
            return Path(repo), base, branch
    return None


def base_for(
    repo: str | Path,
    worktree: Optional[str | Path],
    sha: str,
    base_branch: str = "main",
    merge_sha: Optional[str] = None,
) -> Optional[str]:
    """The base commit to diff an iteration's commit against (the fork point, also once the branch was merged)."""
    if worktree and Path(worktree).exists() and (Path(worktree) / ".git").exists():
        return base_ref(worktree, base_branch)
    if merge_sha and commit_exists(repo, merge_sha):
        return git(repo, "merge-base", f"{merge_sha}^1", sha, check=False) or None
    return git(repo, "merge-base", base_branch, sha, check=False) or None


# ---- API payload ----------------------------------------------------------------------------

MAX_FILE_PATCH_LINES = 1500
MAX_RESPONSE_PATCH_BYTES = 900_000


def with_patches(summary: dict[str, Any], patch: Optional[str], include_patch: bool = True) -> dict[str, Any]:
    """Summary files with each file's diff attached, truncated per file and in total for the browser."""
    files = [dict(f) for f in summary.get("files") or []]
    truncated = bool(summary.get("patch_truncated"))
    if include_patch and patch is not None:
        chunks = split_patch(patch, files)
        budget = MAX_RESPONSE_PATCH_BYTES
        order = sorted(range(len(files)), key=lambda i: (KIND_ORDER.get(files[i].get("kind"), 9), i))
        for index in order:
            file, chunk = files[index], chunks[index]
            lines = chunk.splitlines(keepends=True)
            file["patch_lines"] = len(lines)
            if file.get("binary") or not chunk:
                file["patch"] = None
                continue
            if budget <= 0:
                file["patch"], file["omitted"] = None, True
                truncated = True
                continue
            if len(lines) > MAX_FILE_PATCH_LINES:
                lines = lines[:MAX_FILE_PATCH_LINES]
                file["patch_truncated"] = True
            text = "".join(lines)
            if len(text.encode("utf-8")) > budget:
                text = text.encode("utf-8")[:budget].decode("utf-8", "ignore")
                text = text[: text.rfind("\n") + 1]
                file["patch_truncated"] = True
            budget -= len(text.encode("utf-8"))
            file["patch"] = text
            truncated = truncated or bool(file.get("patch_truncated"))
    return {**{k: v for k, v in summary.items() if k != "files"}, "files": files, "truncated": truncated}


KIND_ORDER = {"source": 0, "config": 1, "other": 2, "test": 3, "docs": 4}


def excerpt(summary: dict[str, Any], patch: Optional[str], budget: int = 16_000) -> str:
    """A bounded slice of the diff for an LLM prompt: engine code first, tests and docs abbreviated."""
    if not patch:
        return ""
    files = summary.get("files") or []
    chunks = split_patch(patch, files)
    order = sorted(range(len(files)), key=lambda i: (KIND_ORDER.get(files[i].get("kind"), 9), -(files[i].get("additions") or 0)))
    parts: list[str] = []
    omitted: list[str] = []
    for index in order:
        file, chunk = files[index], chunks[index]
        if not chunk:
            continue
        limit = 2_000 if file.get("kind") in ("test", "docs") else 8_000
        piece = chunk if len(chunk) <= limit else chunk[:limit] + f"\n… ({len(chunk.splitlines())} lines in this file's diff, truncated)\n"
        if len(piece) > budget:
            if budget > 800:
                parts.append(piece[:budget] + "\n… (truncated)\n")
                budget = 0
            else:
                omitted.append(file["path"])
            continue
        parts.append(piece)
        budget -= len(piece)
    if omitted:
        parts.append(f"\n(diff omitted for: {', '.join(omitted)})\n")
    return "".join(parts)
