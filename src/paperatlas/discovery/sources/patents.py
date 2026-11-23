"""US patents via the USPTO Open Data Portal (ODP).

PatentsView's search API was paused in March 2026 during its move to ODP. The ODP
application search needs a free API key (PAPERATLAS_USPTO_API_KEY) and returns titles
and dates but no abstracts, so abstracts are fetched best-effort from the public
Google Patents page of the publication.
"""

from __future__ import annotations

import html
import logging
import re
from datetime import date
from typing import Any, Optional

from paperatlas.concepts.extraction.models import PaperAuthor, PaperMetadata
from paperatlas.settings import env

from .base import HttpSource, clean_text, parse_date, query_terms

logger = logging.getLogger(__name__)

ODP_SEARCH_URL = "https://api.uspto.gov/api/v1/patent/applications/search"
GOOGLE_PATENTS_URL = "https://patents.google.com/patent/{number}/en"
_META_DESCRIPTION = re.compile(r'<meta\s+name="description"\s+content="([^"]*)"', re.IGNORECASE)


class UsptoPatentSource(HttpSource):
    name = "patents"
    min_interval = 1.1

    def __init__(self, timeout: float = 30.0, api_key: Optional[str] = None, fetch_abstracts: bool = True) -> None:
        super().__init__(timeout)
        self.api_key = api_key or env("PAPERATLAS_USPTO_API_KEY")
        self.fetch_abstracts = fetch_abstracts
        self._warned = False

    @property
    def enabled(self) -> bool:
        if not self.api_key:
            if not self._warned:
                logger.warning("patents source disabled: set PAPERATLAS_USPTO_API_KEY (free USPTO ODP key)")
                self._warned = True
            return False
        return super().enabled

    def _search(self, query: str, since: Optional[date], limit: int) -> list[PaperMetadata]:
        terms = query_terms(query)
        if not terms:
            return []
        body: dict[str, Any] = {
            "q": "applicationMetaData.inventionTitle:(" + " AND ".join(terms) + ")",
            "filters": [{"name": "applicationMetaData.applicationTypeLabelName", "value": ["Utility"]}],
            "pagination": {"offset": 0, "limit": min(limit, 100)},
            "sort": [{"field": "applicationMetaData.filingDate", "order": "desc"}],
        }
        if since:
            body["rangeFilters"] = [
                {
                    "field": "applicationMetaData.filingDate",
                    "valueFrom": since.isoformat(),
                    "valueTo": date.today().isoformat(),
                }
            ]
        data = self._request("POST", ODP_SEARCH_URL, json=body, headers={"X-API-KEY": self.api_key}).json()
        patents = [
            patent for item in data.get("patentFileWrapperDataBag") or [] if (patent := parse_odp_application(item))
        ]
        if self.fetch_abstracts:
            patents = [self._with_abstract(patent) for patent in patents]
        return patents

    def _with_abstract(self, patent: PaperMetadata) -> PaperMetadata:
        if patent.abstract or not patent.patent_number:
            return patent
        try:
            response = self._request("GET", GOOGLE_PATENTS_URL.format(number=patent.patent_number))
        except Exception as exc:  # noqa: BLE001 - best effort enrichment
            logger.debug("No abstract for %s: %s", patent.patent_number, exc)
            return patent
        match = _META_DESCRIPTION.search(response.text)
        if not match:
            return patent
        return patent.model_copy(update={"abstract": clean_text(html.unescape(match.group(1)))})


def parse_odp_application(item: dict[str, Any]) -> Optional[PaperMetadata]:
    meta = item.get("applicationMetaData") or {}
    title = clean_text(meta.get("inventionTitle"))
    if not title:
        return None
    number = meta.get("patentNumber")
    number = f"US{number}" if number and not str(number).startswith("US") else number
    publication = meta.get("earliestPublicationNumber")
    identifier = number or publication or item.get("applicationNumberText")
    filed = parse_date(meta.get("filingDate"))
    published = parse_date(meta.get("grantDate") or meta.get("earliestPublicationDate")) or filed
    inventors = [
        PaperAuthor(name=inventor["inventorNameText"])
        for inventor in meta.get("inventorBag") or []
        if inventor.get("inventorNameText")
    ]
    return PaperMetadata(
        title=title,
        authors=inventors,
        publication_date=published,
        publication_year=published.year if published else None,
        venue=meta.get("firstApplicantName") or "USPTO",
        doc_type="patent",
        patent_number=str(identifier) if identifier else None,
        url=GOOGLE_PATENTS_URL.format(number=identifier) if identifier else None,
        source="patents",
    )
