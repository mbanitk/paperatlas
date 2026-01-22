from __future__ import annotations

from typing import Dict, List, Optional
from xml.etree import ElementTree

import httpx

from .models import PaperAuthor, PaperMetadata, normalize_arxiv_id

ARXIV_API_URL = "https://export.arxiv.org/api/query"


class ArxivClient:
    def __init__(self, timeout_seconds: float = 20.0) -> None:
        self._client = httpx.Client(
            timeout=timeout_seconds,
            follow_redirects=True,
        )

    def fetch_by_id(self, arxiv_id: str) -> Optional[PaperMetadata]:
        normalized_id = normalize_arxiv_id(arxiv_id)
        if not normalized_id:
            return None
        params = {"id_list": normalized_id}
        data = self._get_text(ARXIV_API_URL, params=params)
        return self._parse_feed_entry(data)[0] if data else None

    def search(
        self,
        query: str,
        max_results: int = 5,
        from_date: Optional[str] = None,
    ) -> List[PaperMetadata]:
        if max_results <= 0:
            return []

        page_size = 100
        collected: List[PaperMetadata] = []
        start = 0
        total_pages = (max_results + page_size - 1) // page_size
        for page_index in range(total_pages):
            remaining = max_results - len(collected)
            if remaining <= 0:
                break
            batch_size = min(page_size, remaining)
            params = {
                "search_query": f"all:{query}",
                "start": start,
                "max_results": batch_size,
            }
            data = self._get_text(ARXIV_API_URL, params=params)
            batch = self._parse_feed_entry(data) if data else []
            if not batch:
                break
            if from_date:
                try:
                    from_year = int(from_date.split("-", 1)[0])
                except (ValueError, AttributeError):
                    from_year = None
                if from_year:
                    batch = [
                        item
                        for item in batch
                        if item.publication_year
                        and item.publication_year >= from_year
                    ]
            collected.extend(batch)
            start += batch_size
        return collected[:max_results]

    def _get_text(self, url: str, params: Optional[Dict] = None) -> Optional[str]:
        response = self._client.get(url, params=params)
        if response.status_code != 200:
            return None
        return response.text

    def _parse_feed_entry(self, xml_text: str) -> List[PaperMetadata]:
        if not xml_text:
            return []
        root = ElementTree.fromstring(xml_text)
        namespace = {"atom": "http://www.w3.org/2005/Atom"}
        entries = []
        for entry in root.findall("atom:entry", namespace):
            title = (
                entry.findtext(
                    "atom:title",
                    default="",
                    namespaces=namespace,
                )
                or ""
            ).strip()
            summary = (
                entry.findtext(
                    "atom:summary",
                    default="",
                    namespaces=namespace,
                )
                or ""
            ).strip()
            published = entry.findtext(
                "atom:published",
                default="",
                namespaces=namespace,
            )
            year = int(published[:4]) if published else None
            arxiv_id = normalize_arxiv_id(
                entry.findtext(
                    "atom:id",
                    default="",
                    namespaces=namespace,
                )
            )
            authors = [
                PaperAuthor(
                    name=(
                        author.findtext(
                            "atom:name",
                            default="",
                            namespaces=namespace,
                        )
                        or ""
                    ).strip()
                )
                for author in entry.findall("atom:author", namespace)
            ]
            entries.append(
                PaperMetadata(
                    title=title,
                    abstract=summary,
                    authors=authors,
                    publication_year=year,
                    venue=_first(_arxiv_categories(entry, namespace)),
                    arxiv_id=arxiv_id,
                    url=entry.findtext(
                        "atom:id",
                        default="",
                        namespaces=namespace,
                    ),
                    pdf_url=_arxiv_pdf_url(arxiv_id) if arxiv_id else None,
                    source="arxiv",
                )
            )
        return entries


def _arxiv_categories(
    entry: ElementTree.Element,
    namespace: Dict[str, str],
) -> List[str]:
    categories = []
    for category in entry.findall("atom:category", namespace):
        term = category.attrib.get("term")
        if term:
            categories.append(term)
    return categories


def _arxiv_pdf_url(arxiv_id: str) -> str:
    normalized = normalize_arxiv_id(arxiv_id) or arxiv_id
    return f"https://arxiv.org/pdf/{normalized}.pdf"


def _first(value: Optional[List]) -> Optional[str]:
    if not value:
        return None
    return value[0]


