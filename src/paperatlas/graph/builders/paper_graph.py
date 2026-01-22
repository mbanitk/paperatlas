from __future__ import annotations

from paperatlas.concepts.extraction.models import PaperRecord
from paperatlas.graph.neo4j_client import Neo4jClient
from paperatlas.graph.schema import PAPER_ID_FIELD, PAPER_LABEL


def upsert_paper_node(client: Neo4jClient, record: PaperRecord) -> None:
    metadata = record.metadata
    properties = {
        "title": metadata.title,
        "abstract": metadata.abstract,
        "year": metadata.publication_year,
        "venue": metadata.venue,
        "doi": metadata.doi,
        "arxiv_id": metadata.arxiv_id,
        "openalex_id": metadata.openalex_id,
        "crossref_id": metadata.crossref_id,
        "url": str(metadata.url) if metadata.url else None,
        "pdf_url": str(metadata.pdf_url) if metadata.pdf_url else None,
        "source": metadata.source,
    }
    query = f"""
        MERGE (p:{PAPER_LABEL} {{{PAPER_ID_FIELD}: $paper_id}})
        SET p += $properties
    """
    client.execute_write(query, {"paper_id": metadata.canonical_id(), "properties": properties})
