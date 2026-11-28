"""Engineering sources for a target project: merged pull requests, release notes and blog posts of its upstreams.

A target project lists the repositories and blogs its stack is built on under `upstream` in its lab.yaml. Each scan
reads only what is new since the previous one (a cursor per repository and feed, kept in
`<data dir>/r2e/upstream-cursors.json`; without it a run looks back `initial_lookback_days`), drops bug fixes,
chores and items about hardware the project doesn't run with a keyword filter (`discovery/signal.py`, no LLM),
stores the rest as documents (doc_type pull_request / release / blog; source github_pr / github_release /
engineering_blog) and selects the best few for distillation, so they become claim cards and are matched like papers.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Optional
from xml.etree import ElementTree

import httpx
import numpy as np
import yaml
from sqlalchemy import select

from paperatlas.concepts.extraction.models import PaperAuthor, PaperMetadata, blog_post_id
from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Paper, Project
from paperatlas.db.store import PaperStore
from paperatlas.discovery.config import EngineeringSettings, R2EConfig, Upstream, UpstreamFeed, load_config
from paperatlas.discovery.ranking import rank_upstream
from paperatlas.discovery.signal import Assessment, SignalFilter, clean_body
from paperatlas.discovery.sources.base import SourceError, clean_text
from paperatlas.discovery.sources.feeds import FeedClient, FeedPost
from paperatlas.discovery.sources.github import GitHubClient, RateLimited, merged_at, parse_time
from paperatlas.discovery.topics import Reporter, ensure_paper_embeddings, log_reporter
from paperatlas.settings import data_dir

logger = logging.getLogger(__name__)

PR_OVERLAP = timedelta(hours=1)  # GitHub's search index can lag behind a merge
FEED_OVERLAP = timedelta(days=2)  # feeds often date a post at midnight of its day
MAX_TEXT = 30000
ABSTRACT_CHARS = 1500
POST_TEXT_MIN = 1500  # shorter feed content: read the post page when the post is selected


@dataclass
class Candidate:
    metadata: PaperMetadata
    raw_text: Optional[str]
    assessment: Assessment
    origin: str  # "vllm-project/vllm merged PRs", "Apple Machine Learning Research"

    @property
    def paper_id(self) -> str:
        return self.metadata.canonical_id()


@dataclass
class FetchResult:
    name: str
    fetched: int = 0
    kept: int = 0
    new: int = 0
    truncated: bool = False
    error: Optional[str] = None


@dataclass
class UpstreamStats:
    results: list[FetchResult] = field(default_factory=list)
    kept: list[Candidate] = field(default_factory=list)
    dropped: list[Candidate] = field(default_factory=list)
    stored: list[str] = field(default_factory=list)
    selected: list[str] = field(default_factory=list)
    dry_run: bool = False

    @property
    def fetched(self) -> int:
        return sum(result.fetched for result in self.results)


def project_upstream(profile: dict[str, Any]) -> Upstream:
    return Upstream.model_validate(profile.get("upstream") or {})


def read_lab_upstream(path: str | Path) -> Upstream:
    """The `upstream` section of a lab.yaml file (to try a list before the project is re-profiled)."""
    return project_upstream(yaml.safe_load(Path(path).expanduser().read_text(encoding="utf-8")) or {})


class CursorStore:
    """When each repository / feed was last read (UTC), as JSON under the data directory."""

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = path or data_dir() / "r2e" / "upstream-cursors.json"

    def load(self) -> dict[str, datetime]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return {key: moment for key, value in raw.items() if (moment := parse_time(value))}

    def save(self, cursors: dict[str, datetime]) -> None:
        if not cursors:
            return
        merged = {**self.load(), **cursors}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {key: value.astimezone(UTC).isoformat() for key, value in sorted(merged.items())}
        handle, temp = tempfile.mkstemp(dir=self.path.parent, suffix=".tmp")
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            json.dump(payload, out, indent=2)
        os.replace(temp, self.path)


def _excerpt(text: str, limit: int = ABSTRACT_CHARS) -> Optional[str]:
    text = clean_text(text) or ""
    return (text[:limit].rsplit(" ", 1)[0] + "…" if len(text) > limit else text) or None


def pull_candidate(repo: str, item: dict[str, Any], signal: SignalFilter) -> Candidate:
    title = clean_text(item.get("title")) or f"Pull request #{item.get('number')}"
    labels = [label.get("name", "") for label in item.get("labels") or [] if label.get("name")]
    body = clean_body(item.get("body"))
    merged = merged_at(item)
    author = (item.get("user") or {}).get("login")
    header = [f"Merged pull request #{item.get('number')} in {repo}" + (f" on {merged.date()}" if merged else "")]
    if labels:
        header.append("Labels: " + ", ".join(labels))
    metadata = PaperMetadata(
        title=title,
        abstract=_excerpt(body),
        authors=[PaperAuthor(name=author)] if author else [],
        publication_date=merged.date() if merged else None,
        publication_year=merged.year if merged else None,
        venue=repo,
        doc_type="pull_request",
        url=item.get("html_url") or f"https://github.com/{repo}/pull/{item.get('number')}",
        code_url=f"https://github.com/{repo}",
        keywords=labels,
        source="github_pr",
        doc_id=f"github:{repo}/pull/{item.get('number')}",
    )
    raw_text = "\n".join(header) + "\n\n" + body[:MAX_TEXT] if body else None
    return Candidate(metadata, raw_text, signal.assess(title, labels, body), f"{repo} merged PRs")


def release_candidate(repo: str, release: dict[str, Any], signal: SignalFilter) -> Candidate:
    """A release reduced to its performance lines; dropped when none are left."""
    tag = release.get("tag_name") or str(release.get("id"))
    name = clean_text(release.get("name")) or tag
    lines, read = signal.release_lines(release.get("body") or "")
    kept = [line for line in lines if line.startswith("- ")]
    published = parse_time(release.get("published_at"))
    text = "\n".join(lines)
    metadata = PaperMetadata(
        title=f"{repo} {name} release notes",
        abstract=_excerpt(" ".join(line[2:] for line in kept)),
        publication_date=published.date() if published else None,
        publication_year=published.year if published else None,
        venue=repo,
        doc_type="release",
        url=release.get("html_url") or f"https://github.com/{repo}/releases/tag/{tag}",
        code_url=f"https://github.com/{repo}",
        source="github_release",
        doc_id=f"github:{repo}/releases/{tag}",
    )
    header = f"Release {name} of {repo}" + (f", published {published.date()}" if published else "")
    header += f": the {len(kept)} performance-related lines of its release notes ({read} lines in all)."
    # On the same scale as a pull request's score, so releases with long notes don't crowd out the rest.
    score = signal.settings.min_score + min(len(kept), 5) if kept else 0.0
    assessment = Assessment(
        bool(kept), score, [f"{len(kept)} of {read} lines about performance"] if kept else ["no performance lines"]
    )
    return Candidate(metadata, f"{header}\n\n{text}" if kept else None, assessment, f"{repo} releases")


def post_candidate(feed: UpstreamFeed, post: FeedPost, signal: SignalFilter) -> Candidate:
    published = post.published
    body = post.content or post.summary
    metadata = PaperMetadata(
        title=post.title,
        abstract=_excerpt(post.summary or post.content, 2000),
        authors=[PaperAuthor(name=name) for name in post.authors],
        publication_date=published.date() if published else None,
        publication_year=published.year if published else None,
        venue=feed.name,
        doc_type="blog",
        url=post.url,
        keywords=post.categories,
        source="engineering_blog",
        doc_id=blog_post_id(post.url),
    )
    raw_text = post.content[:MAX_TEXT] if len(post.content) >= POST_TEXT_MIN else None
    # Research posts often have plain titles; their summary can qualify them.
    assessment = signal.assess(post.title, post.categories, body, require_title=False)
    return Candidate(metadata, raw_text, assessment, feed.name)


def _build(make: Callable[..., Candidate], *args: Any) -> Optional[Candidate]:
    """One item; a malformed one (e.g. an invalid URL) is skipped instead of failing its whole source."""
    try:
        return make(*args)
    except ValueError as exc:
        logger.warning("Skipping a malformed upstream item: %s", exc)
        return None


def fetch_upstream(
    upstream: Upstream,
    settings: EngineeringSettings,
    cursors: dict[str, datetime],
    now: Optional[datetime] = None,
    github: Optional[GitHubClient] = None,
    feeds: Optional[FeedClient] = None,
) -> tuple[list[Candidate], list[FetchResult], dict[str, datetime]]:
    """Read what is new in every upstream repository and feed; returns candidates, per-source results and the
    cursors of the sources read completely (a failed or rate-limited source keeps its old cursor)."""
    now = now or datetime.now(UTC)
    signal = SignalFilter(settings, upstream.exclude, upstream.include)
    initial = now - timedelta(days=settings.initial_lookback_days)
    candidates: list[Candidate] = []
    results: list[FetchResult] = []
    advanced: dict[str, datetime] = {}
    blocked: Optional[str] = None
    if upstream.github and github is None:
        github = GitHubClient()
    for spec in upstream.github:
        for kind, label in (("pulls", "merged PRs"), ("releases", "releases")):
            if not getattr(spec, kind):
                continue
            key = f"github:{spec.repo}:{kind}"
            result = FetchResult(f"{spec.repo} {label}")
            results.append(result)
            if blocked:
                result.error = blocked
                continue
            since = cursors[key] - PR_OVERLAP if key in cursors else initial
            try:
                if kind == "pulls":
                    items, result.truncated = github.merged_pulls(spec.repo, since, settings.max_pages)
                    built = [_build(pull_candidate, spec.repo, item, signal) for item in items]
                else:
                    releases = github.releases(spec.repo, since, spec.prereleases)
                    built = [_build(release_candidate, spec.repo, release, signal) for release in releases]
                found = [candidate for candidate in built if candidate]
            except RateLimited as exc:
                blocked = result.error = str(exc)
                logger.warning("%s; the remaining GitHub sources wait for the next run", exc)
                continue
            except (SourceError, httpx.HTTPError, ValueError) as exc:
                result.error = str(exc)[:300]
                logger.warning("%s failed: %s", result.name, exc)
                continue
            result.fetched, result.kept = len(found), sum(candidate.assessment.keep for candidate in found)
            if result.truncated:
                logger.warning("%s: more than %d pages since %s; only the newest were read", result.name, settings.max_pages, since)
            candidates.extend(found)
            advanced[key] = now
    if upstream.feeds and feeds is None:
        feeds = FeedClient()
    for feed in upstream.feeds:
        key = f"feed:{feed.url}"
        result = FetchResult(feed.name)
        results.append(result)
        since = cursors[key] - FEED_OVERLAP if key in cursors else initial
        try:
            posts = [post for post in feeds.posts(feed.url) if post.published is None or post.published >= since]
        except (SourceError, httpx.HTTPError, ValueError, ElementTree.ParseError) as exc:
            result.error = str(exc)[:300]
            logger.warning("Feed %s failed: %s", feed.name, exc)
            continue
        found = [candidate for post in posts if (candidate := _build(post_candidate, feed, post, signal))]
        result.fetched, result.kept = len(found), sum(candidate.assessment.keep for candidate in found)
        candidates.extend(found)
        advanced[key] = now
    return candidates, results, advanced


def _known(paper_ids: list[str]) -> set[str]:
    if not paper_ids:
        return set()
    with session_scope() as session:
        return set(session.scalars(select(Paper.paper_id).where(Paper.paper_id.in_(paper_ids))).all())


def _project(project_id: int) -> tuple[dict[str, Any], Optional[np.ndarray]]:
    with session_scope() as session:
        project = session.get(Project, project_id)
        if project is None:
            raise ValueError(f"project {project_id} not found")
        vector = np.asarray(project.embedding, dtype=np.float32) if project.embedding is not None else None
        return dict(project.profile or {}), vector


def _fetch_post_texts(store: PaperStore, paper_ids: list[str], feeds: Optional[FeedClient]) -> int:
    fetched = 0
    for row in store.fetch_by_ids(paper_ids):
        if row["doc_type"] != "blog" or not row["url"] or len(row["raw_text"] or "") >= POST_TEXT_MIN:
            continue
        feeds = feeds or FeedClient()
        try:
            text = feeds.page_text(row["url"])
        except (SourceError, httpx.HTTPError) as exc:
            logger.warning("No text for %s: %s", row["url"], exc)
            continue
        if text and len(text) > len(row["raw_text"] or ""):
            store.set_raw_text(row["paper_id"], text[:MAX_TEXT])
            fetched += 1
    return fetched


def discover_upstream(
    project_id: Optional[int] = None,
    upstream: Optional[Upstream] = None,
    config: Optional[R2EConfig] = None,
    github: Optional[GitHubClient] = None,
    feeds: Optional[FeedClient] = None,
    cursors: Optional[CursorStore] = None,
    dry_run: bool = False,
    fetch_text: bool = True,
    report: Reporter = log_reporter,
) -> UpstreamStats:
    """Fetch, filter and store the project's new engineering items; select the best undistilled ones to distill.

    `upstream` overrides the project's own list (e.g. read from a lab.yaml being edited). A dry run reads the
    sources and reports what would be kept, without storing items or moving the cursors."""
    config = config or load_config()
    settings = config.engineering
    vector = None
    if project_id is not None:
        profile, vector = _project(project_id)
        upstream = upstream or project_upstream(profile)
    upstream = upstream or Upstream()
    stats = UpstreamStats(dry_run=dry_run)
    if not upstream.github and not upstream.feeds:
        report("discover", "No engineering sources: the project's lab.yaml has no `upstream` section", None)
        return stats
    cursors = cursors or CursorStore()
    candidates, stats.results, advanced = fetch_upstream(upstream, settings, cursors.load(), github=github, feeds=feeds)
    unique: dict[str, Candidate] = {}
    for candidate in candidates:
        unique.setdefault(candidate.paper_id, candidate)
    stats.kept = [candidate for candidate in unique.values() if candidate.assessment.keep]
    stats.dropped = [candidate for candidate in unique.values() if not candidate.assessment.keep]
    known = _known([candidate.paper_id for candidate in stats.kept])
    new = [candidate for candidate in stats.kept if candidate.paper_id not in known]
    by_name = {result.name: result for result in stats.results}
    for candidate in new:
        if result := by_name.get(candidate.origin):
            result.new += 1
    errors = [f"{result.name}: {result.error}" for result in stats.results if result.error]
    report(
        "discover",
        f"Engineering sources: {stats.fetched} items read, {len(stats.kept)} about performance, {len(new)} new"
        + (f"; {len(errors)} sources failed" if errors else ""),
        {"results": [vars(result) for result in stats.results]},
    )
    if dry_run:
        return stats
    store = PaperStore()
    for candidate in new:
        payload = {
            "upstream": {
                "origin": candidate.origin,
                "score": candidate.assessment.score,
                "reasons": candidate.assessment.reasons,
            }
        }
        stats.stored.append(store.upsert(candidate.metadata, candidate.raw_text, payload))
    if stats.stored:
        ensure_paper_embeddings(store, report)
    cursors.save(advanced)
    if settings.per_run:
        ranked = rank_upstream(upstream.venues(), settings, vector, limit=settings.per_run)
        stats.selected = [paper_id for paper_id, _ in ranked]
        if fetch_text and stats.selected:
            _fetch_post_texts(store, stats.selected, feeds)
        if stats.selected:
            report("discover", f"Engineering sources: {len(stats.selected)} items selected to distill", {"papers": stats.selected})
    return stats
