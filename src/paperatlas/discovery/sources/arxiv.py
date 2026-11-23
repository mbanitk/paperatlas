from __future__ import annotations

from datetime import date
from typing import Optional

from paperatlas.concepts.extraction.models import PaperMetadata
from paperatlas.concepts.extraction.sources import ARXIV_API_URL, ArxivClient

from .base import HttpSource, query_terms


class ArxivSource(HttpSource):
    """Newest arXiv submissions matching all query terms."""

    name = "arxiv"
    min_interval = 3.0

    def __init__(self, timeout: float = 30.0) -> None:
        super().__init__(timeout)
        self._parser = ArxivClient(timeout_seconds=timeout)

    def _search(self, query: str, since: Optional[date], limit: int) -> list[PaperMetadata]:
        terms = query_terms(query)
        if not terms:
            return []
        search_query = " AND ".join(f"all:{term}" for term in terms)
        if since:
            search_query += f" AND submittedDate:[{since:%Y%m%d}0000 TO {date.today():%Y%m%d}2359]"
        response = self._request(
            "GET",
            ARXIV_API_URL,
            params={
                "search_query": search_query,
                "start": 0,
                "max_results": min(limit, 100),
                "sortBy": "submittedDate",
                "sortOrder": "descending",
            },
        )
        return self._parser._parse_feed_entry(response.text)[:limit]
