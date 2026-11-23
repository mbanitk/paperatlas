from __future__ import annotations

from datetime import date
from typing import Any, Optional

from paperatlas.concepts.extraction.models import PaperAuthor, PaperMetadata
from paperatlas.settings import env

from .base import HttpSource, clean_text, parse_date

S2_SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
S2_FIELDS = (
    "title,abstract,year,publicationDate,venue,externalIds,citationCount,"
    "influentialCitationCount,openAccessPdf,authors,url"
)


class SemanticScholarSource(HttpSource):
    """Semantic Scholar Graph API. Works without a key but is heavily rate limited;
    set PAPERATLAS_S2_API_KEY for reliable use."""

    name = "semantic_scholar"

    def __init__(self, timeout: float = 30.0, api_key: Optional[str] = None) -> None:
        super().__init__(timeout)
        self.api_key = api_key or env("PAPERATLAS_S2_API_KEY")
        self.min_interval = 1.1 if self.api_key else 3.0

    def _search(self, query: str, since: Optional[date], limit: int) -> list[PaperMetadata]:
        params: dict[str, Any] = {"query": query, "limit": min(limit, 100), "fields": S2_FIELDS}
        if since:
            params["publicationDateOrYear"] = f"{since.isoformat()}:"
        headers = {"x-api-key": self.api_key} if self.api_key else {}
        data = self._request("GET", S2_SEARCH_URL, params=params, headers=headers).json()
        return [paper for item in data.get("data") or [] if (paper := parse_s2_paper(item))]


def parse_s2_paper(item: dict[str, Any]) -> Optional[PaperMetadata]:
    title = clean_text(item.get("title"))
    if not title:
        return None
    external = item.get("externalIds") or {}
    pdf = (item.get("openAccessPdf") or {}).get("url") or None
    publication_date = parse_date(item.get("publicationDate"))
    return PaperMetadata(
        title=title,
        abstract=clean_text(item.get("abstract")),
        authors=[PaperAuthor(name=a["name"]) for a in item.get("authors") or [] if a.get("name")],
        publication_year=item.get("year"),
        publication_date=publication_date,
        venue=clean_text(item.get("venue")),
        doi=external.get("DOI"),
        arxiv_id=external.get("ArXiv"),
        s2_id=item.get("paperId"),
        url=item.get("url") or None,
        pdf_url=pdf if pdf and pdf.startswith("http") else None,
        citation_count=item.get("citationCount"),
        influential_citation_count=item.get("influentialCitationCount"),
        source="semantic_scholar",
    )
