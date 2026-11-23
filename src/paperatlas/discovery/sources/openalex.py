from __future__ import annotations

import re
from datetime import date
from typing import Any, Optional

from paperatlas.concepts.extraction.models import PaperAuthor, PaperMetadata
from paperatlas.settings import env

from .base import HttpSource, clean_text, parse_date

OPENALEX_WORKS_URL = "https://api.openalex.org/works"
OPENALEX_SELECT = (
    "id,doi,title,publication_date,publication_year,cited_by_count,primary_location,"
    "best_oa_location,locations,authorships,abstract_inverted_index,type"
)
_ARXIV_URL = re.compile(r"arxiv\.org/(?:abs|pdf)/([^/?#]+?)(?:\.pdf)?(?:[?#]|$)")


class OpenAlexSource(HttpSource):
    """OpenAlex works search. Without PAPERATLAS_OPENALEX_API_KEY requests share a tiny
    per-IP daily budget, so a free key is recommended."""

    name = "openalex"
    min_interval = 0.2

    def __init__(self, timeout: float = 30.0, api_key: Optional[str] = None) -> None:
        super().__init__(timeout)
        self.api_key = api_key or env("PAPERATLAS_OPENALEX_API_KEY")
        self.mailto = env("PAPERATLAS_CONTACT_EMAIL")

    def _search(self, query: str, since: Optional[date], limit: int) -> list[PaperMetadata]:
        filters = ["type:article|preprint"]
        if since:
            filters.append(f"from_publication_date:{since.isoformat()}")
        params: dict[str, Any] = {
            "search": query,
            "filter": ",".join(filters),
            "per-page": min(limit, 100),
            "select": OPENALEX_SELECT,
        }
        if self.api_key:
            params["api_key"] = self.api_key
        if self.mailto:
            params["mailto"] = self.mailto
        data = self._request("GET", OPENALEX_WORKS_URL, params=params).json()
        return [paper for item in data.get("results") or [] if (paper := parse_openalex_work(item))]


def abstract_from_inverted_index(index: Optional[dict[str, list[int]]]) -> Optional[str]:
    if not index:
        return None
    positions = sorted((pos, word) for word, slots in index.items() for pos in slots)
    return " ".join(word for _, word in positions) or None


def parse_openalex_work(item: dict[str, Any]) -> Optional[PaperMetadata]:
    title = clean_text(item.get("title"))
    if not title:
        return None
    arxiv_id = None
    pdf_url = (item.get("best_oa_location") or {}).get("pdf_url")
    for location in item.get("locations") or []:
        for url in (location.get("landing_page_url"), location.get("pdf_url")):
            match = _ARXIV_URL.search(url or "")
            if match:
                arxiv_id = match.group(1)
                break
        if arxiv_id:
            break
    primary = item.get("primary_location") or {}
    venue = ((primary.get("source") or {}).get("display_name")) or None
    doi = item.get("doi")
    return PaperMetadata(
        title=title,
        abstract=clean_text(abstract_from_inverted_index(item.get("abstract_inverted_index"))),
        authors=[
            PaperAuthor(name=a["author"]["display_name"])
            for a in item.get("authorships") or []
            if (a.get("author") or {}).get("display_name")
        ],
        publication_year=item.get("publication_year"),
        publication_date=parse_date(item.get("publication_date")),
        venue=venue,
        doi=doi,
        arxiv_id=arxiv_id,
        openalex_id=(item.get("id") or "").rsplit("/", 1)[-1] or None,
        url=primary.get("landing_page_url") or doi or None,
        pdf_url=pdf_url or None,
        citation_count=item.get("cited_by_count"),
        source="openalex",
    )
