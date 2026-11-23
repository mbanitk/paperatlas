"""Common plumbing for research-source connectors."""

from __future__ import annotations

import logging
import re
import time
from datetime import date
from typing import Any, Optional, Protocol

import httpx

from paperatlas.concepts.extraction.models import PaperMetadata

logger = logging.getLogger(__name__)

USER_AGENT = "PaperAtlas/0.2 (research-to-experiment; +https://github.com/mbanitk/paperatlas)"


class Source(Protocol):
    name: str

    @property
    def enabled(self) -> bool: ...

    def search(self, query: str, since: Optional[date], limit: int) -> list[PaperMetadata]: ...


class SourceError(RuntimeError):
    pass


class HttpSource:
    """HTTP client with polite spacing between calls and retry/backoff on 429/5xx."""

    name = "http"
    min_interval: float = 1.0
    max_retries: int = 3
    disable_after_failures: int = 3

    def __init__(self, timeout: float = 30.0, client: Optional[httpx.Client] = None) -> None:
        self._client = client or httpx.Client(
            timeout=timeout, follow_redirects=True, headers={"User-Agent": USER_AGENT}
        )
        self._last_call = 0.0
        self._failures = 0

    @property
    def enabled(self) -> bool:
        return self._failures < self.disable_after_failures

    def search(self, query: str, since: Optional[date], limit: int) -> list[PaperMetadata]:
        if not self.enabled:
            return []
        try:
            results = self._search(query, since, limit)
        except (SourceError, httpx.HTTPError, ValueError) as exc:
            self._failures += 1
            logger.warning("%s search failed for %r: %s", self.name, query, exc)
            if not self.enabled:
                logger.warning("%s disabled for this run after repeated failures", self.name)
            return []
        self._failures = 0
        return results

    def _search(self, query: str, since: Optional[date], limit: int) -> list[PaperMetadata]:
        raise NotImplementedError

    def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        for attempt in range(1, self.max_retries + 1):
            wait = self.min_interval - (time.monotonic() - self._last_call)
            if wait > 0:
                time.sleep(wait)
            self._last_call = time.monotonic()
            response = self._client.request(method, url, **kwargs)
            if response.status_code in (429, 500, 502, 503, 504) and attempt < self.max_retries:
                retry_after = response.headers.get("retry-after", "")
                delay = float(retry_after) if retry_after.isdigit() else 2.0**attempt
                logger.info("%s HTTP %s, retrying in %.0fs", self.name, response.status_code, delay)
                time.sleep(min(delay, 30.0))
                continue
            if response.status_code >= 400:
                raise SourceError(f"HTTP {response.status_code}: {response.text[:200]}")
            return response
        raise SourceError("retries exhausted")


def parse_date(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def clean_text(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return re.sub(r"\s+", " ", value).strip() or None


def query_terms(query: str) -> list[str]:
    return [term for term in re.findall(r"[A-Za-z0-9][A-Za-z0-9\-\.]*", query) if len(term) > 1]
