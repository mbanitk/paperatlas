from __future__ import annotations

import logging
from typing import Iterable, Optional
from urllib.parse import urlparse

import httpx

from paperatlas.graph.builders.paper_graph import upsert_paper_node
from paperatlas.graph.neo4j_client import Neo4jClient
from paperatlas.graph.builders.concept_graph import (
    link_papers_to_concepts,
    upsert_concepts,
)

from .config import get_mysql_config, get_neo4j_bolt_url, parse_neo4j_bolt_url
from .heuristic_extractor import HeuristicConceptExtractor
from .llm_extractor import LLMConceptExtractor, build_default_llm_client
from .models import (
    ConceptCandidate,
    ConceptRecord,
    ConceptSummary,
    PaperIdentifier,
    PaperMetadata,
    PaperRecord,
    canonical_concept_id,
    normalize_arxiv_id,
    normalize_doi,
)
from .storage import JsonPaperStore, MySQLPaperStore
from ..summarization.concept_summarizer import ConceptSummarizer
from ..validation.deduplication import deduplicate_concepts
from .pdf_parser import PdfParser
from .sources import ArxivClient

logger = logging.getLogger(__name__)


class IngestionPipeline:
    def __init__(
        self,
        arxiv_client: Optional[ArxivClient] = None,
        parser: Optional[PdfParser] = None,
        json_store: Optional[JsonPaperStore] = None,
        mysql_store: Optional[MySQLPaperStore] = None,
        mysql_config: Optional[dict] = None,
        use_mysql: bool = True,
        neo4j_client: Optional[Neo4jClient] = None,
        neo4j_bolt_url: Optional[str] = None,
        use_neo4j: bool = True,
    ) -> None:
        self.arxiv_client = arxiv_client or ArxivClient()
        self.parser = parser or PdfParser()
        self.json_store = json_store or JsonPaperStore()
        self.mysql_store = mysql_store
        if self.mysql_store is None and use_mysql:
            config = mysql_config or get_mysql_config()
            try:
                self.mysql_store = MySQLPaperStore(config)
            except RuntimeError as exc:
                logger.warning("MySQL store disabled: %s", exc)
        self.neo4j_client = neo4j_client
        if self.neo4j_client is None and use_neo4j:
            bolt_url = (neo4j_bolt_url or get_neo4j_bolt_url()).strip()
            if bolt_url:
                try:
                    uri, user, password = parse_neo4j_bolt_url(bolt_url)
                    self.neo4j_client = Neo4jClient(uri, user, password)
                except (RuntimeError, ValueError) as exc:
                    logger.warning("Neo4j client disabled: %s", exc)

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
            raw_text = self._download_and_parse_pdf(metadata.pdf_url)
        return PaperRecord(metadata=metadata, raw_text=raw_text)

    def _download_and_parse_pdf(self, pdf_url: str) -> Optional[str]:
        try:
            response = httpx.get(
                str(pdf_url),
                timeout=60.0,
                follow_redirects=True,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("Failed to download PDF %s: %s", pdf_url, exc)
            return None
        try:
            return self.parser.parse_bytes(response.content)
        except RuntimeError as exc:
            logger.warning("Failed to parse PDF %s: %s", pdf_url, exc)
            return None

    def _persist(self, record: PaperRecord) -> None:
        self.json_store.save(record)
        if self.mysql_store:
            self.mysql_store.save(record)
        if self.neo4j_client:
            upsert_paper_node(self.neo4j_client, record)


class ConceptExtractionPipeline:
    def __init__(
        self,
        mysql_store: Optional[MySQLPaperStore] = None,
        mysql_config: Optional[dict] = None,
        llm_extractor: Optional[LLMConceptExtractor] = None,
        heuristic_extractor: Optional[HeuristicConceptExtractor] = None,
        summarizer: Optional[ConceptSummarizer] = None,
        neo4j_client: Optional[Neo4jClient] = None,
        neo4j_bolt_url: Optional[str] = None,
        use_neo4j: bool = True,
        dedup_threshold: float = 0.85,
    ) -> None:
        self.mysql_store = mysql_store
        if self.mysql_store is None:
            config = mysql_config or get_mysql_config()
            self.mysql_store = MySQLPaperStore(config)

        if llm_extractor:
            self.llm_extractor = llm_extractor
        else:
            llm_client = build_default_llm_client()
            self.llm_extractor = LLMConceptExtractor(
                client=llm_client,
                offline=llm_client is None,
            )
        self.heuristic_extractor = (
            heuristic_extractor or HeuristicConceptExtractor()
        )
        self.summarizer = summarizer or ConceptSummarizer(
            llm_client=self.llm_extractor.client
        )
        self.dedup_threshold = dedup_threshold
        self.neo4j_client = neo4j_client
        if self.neo4j_client is None and use_neo4j:
            bolt_url = (neo4j_bolt_url or get_neo4j_bolt_url()).strip()
            if bolt_url:
                try:
                    uri, user, password = parse_neo4j_bolt_url(bolt_url)
                    self.neo4j_client = Neo4jClient(uri, user, password)
                except (RuntimeError, ValueError) as exc:
                    logger.warning("Neo4j client disabled: %s", exc)

    def process_paper(self, row: dict) -> list[ConceptRecord]:
        paper_id = row["paper_id"]
        title = row.get("title") or ""
        abstract = row.get("abstract")
        raw_text = row.get("raw_text")

        concepts = self.llm_extractor.extract(
            paper_id,
            title,
            abstract,
            raw_text,
        )
        if not concepts:
            concepts = self.heuristic_extractor.extract(
                title,
                abstract,
                raw_text,
            )
        concepts = deduplicate_concepts(
            concepts,
            similarity_threshold=self.dedup_threshold,
        )
        records = []
        for concept in concepts:
            candidate = ConceptCandidate(**concept)
            summary_payload = self.summarizer.summarize(
                candidate.post or candidate.evidence or candidate.name,
                candidate.name,
            )
            summary = ConceptSummary(**summary_payload)
            concept_id = canonical_concept_id(candidate.name)
            record = ConceptRecord(
                concept_id=concept_id,
                paper_id=paper_id,
                name=candidate.name,
                summary=summary.paragraph,
                bullets=summary.bullets,
                source=candidate.source,
            )
            records.append(record)
        if self.mysql_store and records:
            payload = [
                {
                    "paper_id": record.paper_id,
                    "concept_id": record.concept_id,
                    "name": record.name,
                    "summary": record.summary,
                    "bullets": record.bullets,
                    "source": record.source,
                }
                for record in records
            ]
            self.mysql_store.save_concepts(payload)
        if self.neo4j_client and records:
            rows = [record.model_dump() for record in records]
            upsert_concepts(self.neo4j_client, rows)
            link_papers_to_concepts(self.neo4j_client, rows)
        return records

    def process_paper_id(self, paper_id: str) -> list[ConceptRecord]:
        row = self.mysql_store.fetch_paper_by_id(paper_id)
        if not row:
            return []
        return self.process_paper(row)

    def process_batch(
        self,
        limit: int,
        offset: int = 0,
    ) -> list[ConceptRecord]:
        rows = self.mysql_store.fetch_papers(
            limit=limit,
            offset=offset,
        )
        all_records: list[ConceptRecord] = []
        for row in rows:
            all_records.extend(self.process_paper(row))
        return all_records


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
