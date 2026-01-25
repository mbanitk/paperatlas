from __future__ import annotations

from typing import Iterable

from paperatlas.graph.neo4j_client import Neo4jClient
from paperatlas.graph.schema import (
    CONCEPT_ID_FIELD,
    CONCEPT_LABEL,
    DISCUSSES_REL,
    PAPER_ID_FIELD,
    PAPER_LABEL,
)


def upsert_concepts(client: Neo4jClient, rows: Iterable[dict]) -> None:
    query = f"""
        UNWIND $rows AS row
        MERGE (c:{CONCEPT_LABEL} {{{CONCEPT_ID_FIELD}: row.concept_id}})
        SET c.name = row.name,
            c.summary = row.summary,
            c.bullets = row.bullets,
            c.source = row.source
    """
    client.execute_many(query, rows)


def link_papers_to_concepts(client: Neo4jClient, rows: Iterable[dict]) -> None:
    query = f"""
        UNWIND $rows AS row
        MATCH (p:{PAPER_LABEL} {{{PAPER_ID_FIELD}: row.paper_id}})
        MERGE (c:{CONCEPT_LABEL} {{{CONCEPT_ID_FIELD}: row.concept_id}})
        MERGE (p)-[r:{DISCUSSES_REL}]->(c)
        SET r.source = row.source
    """
    client.execute_many(query, rows)
