from __future__ import annotations

import logging
from datetime import date
from typing import Any, Optional

import httpx

from paperatlas.concepts.extraction.models import PaperAuthor, PaperMetadata

from .base import HttpSource, SourceError, clean_text, parse_date, query_terms

logger = logging.getLogger(__name__)

HF_SEARCH_URL = "https://huggingface.co/api/papers/search"
HF_DAILY_URL = "https://huggingface.co/api/daily_papers"
MAX_FEED_PAGES = 80


class HuggingFacePapersSource(HttpSource):
    """Hugging Face Papers: community upvotes and linked code (trend signals).

    The search endpoint's index lags, so recent papers come from the daily-papers feed
    (paged back to `since` once per process) filtered by the query terms.
    """

    name = "hf_papers"
    min_interval = 0.4

    def __init__(self, timeout: float = 30.0) -> None:
        super().__init__(timeout)
        self._feed: Optional[list[PaperMetadata]] = None
        self._feed_since: Optional[date] = None

    def _search(self, query: str, since: Optional[date], limit: int) -> list[PaperMetadata]:
        terms = [term.lower() for term in query_terms(query)]
        found: dict[str, PaperMetadata] = {}
        if since:
            for paper in self._daily_feed(since):
                haystack = f"{paper.title} {paper.abstract or ''} {' '.join(paper.keywords)}".lower()
                if all(term in haystack for term in terms):
                    found[paper.canonical_id()] = paper
        try:
            data = self._request("GET", HF_SEARCH_URL, params={"q": query, "limit": 100}).json()
        except (SourceError, httpx.HTTPError, ValueError) as exc:
            if not found:
                raise
            # Search is best-effort on top of the daily feed: keep the feed matches.
            logger.warning("hf_papers search failed for %r, using daily-feed matches: %s", query, exc)
            data = []
        for item in data or []:
            paper = parse_hf_paper(item)
            if paper and (not since or (paper.publication_date and paper.publication_date >= since)):
                found.setdefault(paper.canonical_id(), paper)
        ranked = sorted(found.values(), key=lambda p: (p.hf_upvotes or 0), reverse=True)
        return ranked[:limit]

    def _daily_feed(self, since: date) -> list[PaperMetadata]:
        if self._feed is not None and self._feed_since and self._feed_since <= since:
            return self._feed
        feed: list[PaperMetadata] = []
        for page in range(MAX_FEED_PAGES):
            items = self._request("GET", HF_DAILY_URL, params={"limit": 100, "p": page}).json()
            if not items:
                break
            papers = [paper for item in items if (paper := parse_hf_paper(item))]
            feed.extend(p for p in papers if p.publication_date and p.publication_date >= since)
            oldest = min((p.publication_date for p in papers if p.publication_date), default=None)
            if oldest is None or oldest < since:
                break
        logger.info("hf_papers: loaded %d daily papers since %s", len(feed), since)
        self._feed, self._feed_since = feed, since
        return feed


def parse_hf_paper(item: dict[str, Any]) -> Optional[PaperMetadata]:
    paper = item.get("paper") or item
    title = clean_text(paper.get("title") or item.get("title"))
    arxiv_id = paper.get("id")
    if not title or not arxiv_id:
        return None
    published = parse_date(paper.get("publishedAt") or item.get("publishedAt"))
    return PaperMetadata(
        title=title,
        abstract=clean_text(paper.get("summary") or item.get("summary")),
        authors=[PaperAuthor(name=a["name"]) for a in paper.get("authors") or [] if a.get("name")],
        publication_date=published,
        publication_year=published.year if published else None,
        arxiv_id=arxiv_id,
        url=f"https://huggingface.co/papers/{arxiv_id}",
        pdf_url=f"https://arxiv.org/pdf/{arxiv_id}",
        code_url=paper.get("githubRepo") or None,
        hf_upvotes=paper.get("upvotes"),
        keywords=paper.get("ai_keywords") or [],
        source="hf_papers",
    )
