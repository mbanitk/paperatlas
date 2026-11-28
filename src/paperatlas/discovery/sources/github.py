"""GitHub engineering sources: merged pull requests and release notes of upstream repositories.

Merged pull requests come from the search API (`repo:… is:pr is:merged merged:>=…`, 100 per page), which returns
titles, labels and descriptions in one call. A token raises the limits from 60 core / 10 search requests to
5,000 / 30: it is read from GITHUB_TOKEN, GH_TOKEN or PAPERATLAS_GITHUB_TOKEN, else from `gh auth token`. Without
one the client still works, just slower and for fewer requests; when GitHub reports that the limit is used up the
run stops asking it and the next run continues from the last completed fetch.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import time
from datetime import UTC, datetime
from typing import Any, Optional

import httpx

from paperatlas.settings import env

from .base import HttpSource, SourceError

logger = logging.getLogger(__name__)

API = "https://api.github.com"
TOKEN_VARIABLES = ("GITHUB_TOKEN", "GH_TOKEN", "PAPERATLAS_GITHUB_TOKEN")
GH_FALLBACK_PATHS = ("/opt/homebrew/bin/gh", "/usr/local/bin/gh")
PAGE_SIZE = 100


class RateLimited(SourceError):
    """GitHub's request budget is used up until `reset` (UTC)."""

    def __init__(self, message: str, reset: Optional[datetime] = None) -> None:
        super().__init__(message)
        self.reset = reset


def github_token() -> Optional[str]:
    """A GitHub token from the environment, else from the GitHub CLI (`gh auth token`), else None."""
    for name in TOKEN_VARIABLES:
        if token := env(name):
            return token
    # launchd jobs get a minimal PATH, so also look where Homebrew installs gh.
    gh = shutil.which("gh") or next((path for path in GH_FALLBACK_PATHS if os.path.exists(path)), None)
    if not gh:
        return None
    try:
        result = subprocess.run([gh, "auth", "token"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    token = result.stdout.strip() if result.returncode == 0 else ""
    return token or None


def parse_time(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class GitHubClient(HttpSource):
    name = "github"
    min_interval = 0.25
    # The search API allows 30 requests a minute with a token and 10 without.
    search_interval_token = 2.1
    search_interval_anonymous = 6.5

    def __init__(
        self, token: Optional[str] = None, use_token: bool = True, timeout: float = 30.0, client: Optional[httpx.Client] = None
    ) -> None:
        super().__init__(timeout, client)
        self.token = (token or github_token()) if use_token else None
        self._last_search = 0.0
        if not self.token:
            logger.warning("No GitHub token (GITHUB_TOKEN or `gh auth login`): using the anonymous limits")

    @property
    def search_interval(self) -> float:
        return self.search_interval_token if self.token else self.search_interval_anonymous

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def get(self, path: str, params: Optional[dict[str, Any]] = None, search: bool = False, retried: bool = False) -> Any:
        if search:
            wait = self.search_interval - (time.monotonic() - self._last_search)
            if wait > 0:
                time.sleep(wait)
            self._last_search = time.monotonic()
        try:
            return self._request("GET", f"{API}{path}", params=params, headers=self._headers()).json()
        except SourceError as exc:
            response = exc.response
            if response is None:
                raise
            if response.status_code == 401 and self.token:
                logger.warning("GitHub rejected the token (HTTP 401); continuing without it")
                self.token = None
                return self.get(path, params, search, retried)
            if response.status_code in (403, 429):
                if response.headers.get("x-ratelimit-remaining") == "0" or "rate limit" in response.text.lower():
                    retry_after = response.headers.get("retry-after", "")
                    if retry_after.isdigit() and int(retry_after) <= 60 and not retried:
                        time.sleep(int(retry_after))
                        return self.get(path, params, search, retried=True)
                    reset = response.headers.get("x-ratelimit-reset", "")
                    reset_at = datetime.fromtimestamp(int(reset), UTC) if reset.isdigit() else None
                    raise RateLimited(f"GitHub rate limit reached (resets {reset_at or 'later'})", reset_at) from exc
            raise

    def merged_pulls(self, repo: str, since: datetime, max_pages: int) -> tuple[list[dict[str, Any]], bool]:
        """Pull requests merged in `repo` since `since` (newest updates first), and whether more were left unread
        because of `max_pages`."""
        query = f"repo:{repo} is:pr is:merged merged:>={_iso(since)}"
        items: list[dict[str, Any]] = []
        total = 0
        for page in range(1, max_pages + 1):
            data = self.get(
                "/search/issues",
                {"q": query, "sort": "updated", "order": "desc", "per_page": PAGE_SIZE, "page": page},
                search=True,
            )
            batch = data.get("items") or []
            total = int(data.get("total_count") or 0)
            items.extend(batch)
            if len(batch) < PAGE_SIZE or len(items) >= total:
                break
        merged = [item for item in items if (moment := merged_at(item)) is not None and moment >= since]
        return merged, total > len(items)

    def releases(self, repo: str, since: datetime, prereleases: bool = False, per_page: int = 30) -> list[dict[str, Any]]:
        """Published releases of `repo` since `since`, newest first (drafts never; pre-releases if asked)."""
        data = self.get(f"/repos/{repo}/releases", {"per_page": per_page})
        found = []
        for release in data or []:
            published = parse_time(release.get("published_at"))
            if release.get("draft") or published is None or published < since:
                continue
            if release.get("prerelease") and not prereleases:
                continue
            found.append(release)
        return found


def merged_at(item: dict[str, Any]) -> Optional[datetime]:
    return parse_time((item.get("pull_request") or {}).get("merged_at"))
