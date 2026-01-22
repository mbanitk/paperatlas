from __future__ import annotations

import logging
from typing import Iterable, Optional

import httpx

from paperatlas.graph.builders.paper_graph import upsert_paper_node
from paperatlas.graph.neo4j_client import Neo4jClient

from .config import get_mysql_config, get_neo4j_bolt_url, parse_neo4j_bolt_url
from .models import PaperIdentifier, PaperMetadata, PaperRecord
from .pdf_parser import PdfParser
from .sources import ArxivClient
from .storage import JsonPaperStore, MySQLPaperStore

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

    def _enrich_record(self, metadata: PaperMetadata) -> PaperRecord:
        raw_text = None
        if metadata.pdf_url:
            raw_text = self._download_and_parse_pdf(metadata.pdf_url)
        return PaperRecord(metadata=metadata, raw_text=raw_text)

    def _download_and_parse_pdf(self, pdf_url: str) -> Optional[str]:
        try:
            response = httpx.get(str(pdf_url), timeout=60.0)
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
