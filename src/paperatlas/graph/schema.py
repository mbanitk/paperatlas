from __future__ import annotations

from paperatlas.graph.neo4j_client import Neo4jClient

PAPER_LABEL = "Paper"
PAPER_ID_FIELD = "paper_id"


def initialize_schema(client: Neo4jClient) -> None:
    client.execute_write(
        f"""
        CREATE CONSTRAINT paper_id_unique IF NOT EXISTS
        FOR (p:{PAPER_LABEL})
        REQUIRE p.{PAPER_ID_FIELD} IS UNIQUE
        """
    )
