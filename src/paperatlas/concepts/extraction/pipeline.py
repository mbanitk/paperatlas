from __future__ import annotations

import logging
from typing import Iterable, Optional
from urllib.parse import urlparse

import httpx

from paperatlas.db.store import PaperStore

from .models import (
    PaperIdentifier,
    PaperMetadata,
    PaperRecord,
    normalize_arxiv_id,
    normalize_doi,
)
from .pdf_parser import PdfParser
from .sources import ArxivClient

logger = logging.getLogger(__name__)


class IngestionPipeline:
    def __init__(
        self,
        arxiv_client: Optional[ArxivClient] = None,
        parser: Optional[PdfParser] = None,
        store: Optional[PaperStore] = None,
        database_url: Optional[str] = None,
    ) -> None:
        self.arxiv_client = arxiv_client or ArxivClient()
        self.parser = parser or PdfParser()
        self.store = store or PaperStore(database_url)

    def ingest_identifiers(
        self,
        identifiers: Iterable[PaperIdentifier],
    ) -> list[PaperRecord]:
        records = []
        for identifier in identifiers:
            metadata = self._fetch_metadata(identifier)
            if not metadata:
                logger.warning(
                    "No metadata found for %s",
                    identifier.model_dump(),
                )
                continue
            record = self._enrich_record(metadata)
            self._persist(record)
            records.append(record)
        return records

    def ingest_urls(self, urls: Iterable[str]) -> list[PaperRecord]:
        records = []
        for url in urls:
            record = self.ingest_url(url)
            if record:
                records.append(record)
        return records

    def ingest_url(self, url: str) -> Optional[PaperRecord]:
        metadata = self._metadata_from_url(url)
        if not metadata:
            logger.warning("No metadata resolved for URL %s", url)
            return None
        record = self._enrich_record(metadata)
        self._persist(record)
        return record

    def ingest_query(
        self,
        query: str,
        max_results: int = 5,
        from_date: Optional[str] = None,
    ) -> list[PaperRecord]:
        metadata_results = self.arxiv_client.search(
            query,
            max_results=max_results,
            from_date=from_date,
        )
        records = []
        for metadata in metadata_results:
            record = self._enrich_record(metadata)
            self._persist(record)
            records.append(record)
        return records

    def _fetch_metadata(
        self,
        identifier: PaperIdentifier,
    ) -> Optional[PaperMetadata]:
        if identifier.arxiv_id:
            return self.arxiv_client.fetch_by_id(identifier.arxiv_id)
        if identifier.doi:
            logger.warning("DOI ingestion is disabled without OpenAlex.")
        if identifier.openalex_id:
            logger.warning("OpenAlex ingestion is disabled.")
        return None

    def _metadata_from_url(self, url: str) -> Optional[PaperMetadata]:
        cleaned_url = _normalize_http_url(url)
        if not cleaned_url:
            return None
        arxiv_id = _extract_arxiv_id_from_url(cleaned_url)
        if arxiv_id:
            metadata = self.arxiv_client.fetch_by_id(arxiv_id)
            if metadata:
                return metadata
        doi = _extract_doi_from_url(cleaned_url)
        pdf_url = cleaned_url if _looks_like_pdf(cleaned_url) else None
        try:
            return PaperMetadata(
                title=cleaned_url,
                abstract=None,
                authors=[],
                publication_year=None,
                venue=None,
                doi=doi,
                arxiv_id=arxiv_id,
                openalex_id=None,
                crossref_id=None,
                url=cleaned_url,
                pdf_url=pdf_url,
                source="url",
            )
        except Exception:
            return None

    def _enrich_record(self, metadata: PaperMetadata) -> PaperRecord:
        raw_text = None
        if metadata.pdf_url:
            raw_text = download_pdf_text(str(metadata.pdf_url), self.parser)
        return PaperRecord(metadata=metadata, raw_text=raw_text)

    def _persist(self, record: PaperRecord) -> None:
        self.store.save(record)


def download_pdf_text(pdf_url: str, parser: Optional[PdfParser] = None) -> Optional[str]:
    try:
        response = httpx.get(pdf_url, timeout=60.0, follow_redirects=True)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning("Failed to download PDF %s: %s", pdf_url, exc)
        return None
    try:
        return (parser or PdfParser()).parse_bytes(response.content)
    except RuntimeError as exc:
        logger.warning("Failed to parse PDF %s: %s", pdf_url, exc)
        return None


def _normalize_http_url(url: str) -> Optional[str]:
    cleaned = (url or "").strip()
    if not cleaned:
        return None
    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return cleaned


def _looks_like_pdf(url: str) -> bool:
    return url.lower().split("?", 1)[0].endswith(".pdf")


def _extract_arxiv_id_from_url(url: str) -> Optional[str]:
    parsed = urlparse(url)
    if "arxiv.org" not in parsed.netloc:
        return None
    path = parsed.path or ""
    if "/pdf/" in path:
        suffix = path.split("/pdf/", 1)[1]
        suffix = suffix.rsplit(".pdf", 1)[0]
        return normalize_arxiv_id(suffix)
    return normalize_arxiv_id(path)


def _extract_doi_from_url(url: str) -> Optional[str]:
    parsed = urlparse(url)
    if "doi.org" not in parsed.netloc:
        return None
    doi = parsed.path.lstrip("/")
    return normalize_doi(doi)
