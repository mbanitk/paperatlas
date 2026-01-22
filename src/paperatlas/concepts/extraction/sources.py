from __future__ import annotations

import re
from typing import Dict, List, Optional
from xml.etree import ElementTree

import httpx

from .models import PaperAuthor, PaperMetadata, normalize_arxiv_id, normalize_doi

ARXIV_API_URL = "http://export.arxiv.org/api/query"
OPENALEX_API_URL = "https://api.openalex.org"
CROSSREF_API_URL = "https://api.crossref.org"


class OpenAlexClient:
    def __init__(self, timeout_seconds: float = 20.0) -> None:
        self._client = httpx.Client(timeout=timeout_seconds)

    def fetch_by_doi(self, doi: str) -> Optional[PaperMetadata]:
        normalized_doi = normalize_doi(doi)
        if not normalized_doi:
            return None
        url = f"{OPENALEX_API_URL}/works/https://doi.org/{normalized_doi}"
        data = self._get_json(url)
        return self._parse_work(data) if data else None

    def fetch_by_id(self, openalex_id: str) -> Optional[PaperMetadata]:
        url = f"{OPENALEX_API_URL}/works/{openalex_id}"
        data = self._get_json(url)
        return self._parse_work(data) if data else None

    def search(self, query: str, per_page: int = 5) -> List[PaperMetadata]:
        url = f"{OPENALEX_API_URL}/works"
        params = {"search": query, "per-page": per_page}
        data = self._get_json(url, params=params)
        if not data:
            return []
        return [self._parse_work(item) for item in data.get("results", []) if item]

    def _get_json(self, url: str, params: Optional[Dict] = None) -> Optional[Dict]:
        response = self._client.get(url, params=params)
        if response.status_code != 200:
            return None
        return response.json()

    def _parse_work(self, payload: Dict) -> PaperMetadata:
        abstract = _abstract_from_inverted_index(payload.get("abstract_inverted_index"))
        authors = [
            PaperAuthor(name=auth["author"]["display_name"])
            for auth in payload.get("authorships", [])
            if auth.get("author")
        ]
        doi = payload.get("doi")
        return PaperMetadata(
            title=payload.get("title") or "",
            abstract=abstract,
            authors=authors,
            publication_year=payload.get("publication_year"),
            venue=payload.get("host_venue", {}).get("display_name"),
            doi=normalize_doi(doi),
            arxiv_id=_extract_arxiv_id(payload.get("ids", {})),
            openalex_id=payload.get("id"),
            url=payload.get("id"),
            pdf_url=_select_pdf_url(payload),
            source="openalex",
        )


class CrossrefClient:
    def __init__(self, timeout_seconds: float = 20.0) -> None:
        self._client = httpx.Client(timeout=timeout_seconds)

    def fetch_by_doi(self, doi: str) -> Optional[PaperMetadata]:
        normalized_doi = normalize_doi(doi)
        if not normalized_doi:
            return None
        url = f"{CROSSREF_API_URL}/works/{normalized_doi}"
        data = self._get_json(url)
        return self._parse_work(data.get("message")) if data else None

    def search(self, query: str, rows: int = 5) -> List[PaperMetadata]:
        url = f"{CROSSREF_API_URL}/works"
        params = {"query.title": query, "rows": rows}
        data = self._get_json(url, params=params)
        if not data:
            return []
        items = data.get("message", {}).get("items", [])
        return [self._parse_work(item) for item in items if item]

    def _get_json(self, url: str, params: Optional[Dict] = None) -> Optional[Dict]:
        response = self._client.get(url, params=params)
        if response.status_code != 200:
            return None
        return response.json()

    def _parse_work(self, payload: Dict) -> PaperMetadata:
        authors = []
        for author in payload.get("author", []):
            given = author.get("given", "")
            family = author.get("family", "")
            name = " ".join(part for part in [given, family] if part).strip()
            if name:
                authors.append(PaperAuthor(name=name, orcid=author.get("ORCID")))
        abstract = _strip_html(payload.get("abstract"))
        doi = payload.get("DOI")
        return PaperMetadata(
            title=_first(payload.get("title")) or "",
            abstract=abstract,
            authors=authors,
            publication_year=_extract_year(payload),
            venue=_first(payload.get("container-title")),
            doi=normalize_doi(doi),
            crossref_id=payload.get("DOI"),
            url=payload.get("URL"),
            pdf_url=_find_pdf_link(payload.get("link", [])),
            source="crossref",
        )


class ArxivClient:
    def __init__(self, timeout_seconds: float = 20.0) -> None:
        self._client = httpx.Client(timeout=timeout_seconds)

    def fetch_by_id(self, arxiv_id: str) -> Optional[PaperMetadata]:
        normalized_id = normalize_arxiv_id(arxiv_id)
        if not normalized_id:
            return None
        params = {"id_list": normalized_id}
        data = self._get_text(ARXIV_API_URL, params=params)
        return self._parse_feed_entry(data)[0] if data else None

    def search(self, query: str, max_results: int = 5) -> List[PaperMetadata]:
        params = {"search_query": f"all:{query}", "start": 0, "max_results": max_results}
        data = self._get_text(ARXIV_API_URL, params=params)
        return self._parse_feed_entry(data) if data else []

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
            title = (entry.findtext("atom:title", default="", namespaces=namespace) or "").strip()
            summary = (entry.findtext("atom:summary", default="", namespaces=namespace) or "").strip()
            published = entry.findtext("atom:published", default="", namespaces=namespace)
            year = int(published[:4]) if published else None
            arxiv_id = normalize_arxiv_id(entry.findtext("atom:id", default="", namespaces=namespace))
            authors = [
                PaperAuthor(name=(author.findtext("atom:name", default="", namespaces=namespace) or "").strip())
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
                    url=entry.findtext("atom:id", default="", namespaces=namespace),
                    pdf_url=_arxiv_pdf_url(arxiv_id) if arxiv_id else None,
                    source="arxiv",
                )
            )
        return entries


def _abstract_from_inverted_index(inverted_index: Optional[Dict]) -> Optional[str]:
    if not inverted_index:
        return None
    positions = []
    for word, indices in inverted_index.items():
        for index in indices:
            positions.append((index, word))
    return " ".join(word for _, word in sorted(positions))


def _strip_html(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    return re.sub(r"<[^>]+>", "", text).strip()


def _extract_arxiv_id(ids_payload: Dict) -> Optional[str]:
    arxiv_url = ids_payload.get("arxiv")
    return normalize_arxiv_id(arxiv_url) if arxiv_url else None


def _select_pdf_url(payload: Dict) -> Optional[str]:
    for location in payload.get("locations", []) or []:
        pdf_url = location.get("pdf_url")
        if pdf_url:
            return pdf_url
    return None


def _find_pdf_link(links: List[Dict]) -> Optional[str]:
    for link in links:
        if link.get("content-type") == "application/pdf":
            return link.get("URL")
    return None


def _arxiv_categories(entry: ElementTree.Element, namespace: Dict[str, str]) -> List[str]:
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


def _extract_year(payload: Dict) -> Optional[int]:
    for field in ("published-print", "published-online", "created"):
        date_parts = payload.get(field, {}).get("date-parts")
        if date_parts and date_parts[0]:
            try:
                return int(date_parts[0][0])
            except (ValueError, TypeError):
                return None
    return None
