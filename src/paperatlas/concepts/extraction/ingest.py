from __future__ import annotations

import argparse
import logging
from typing import List

from paperatlas.concepts.extraction.models import PaperIdentifier
from paperatlas.concepts.extraction.pipeline import IngestionPipeline

logger = logging.getLogger(__name__)


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest papers into local storage.")
    parser.add_argument("--doi", action="append", default=[], help="DOI to ingest")
    parser.add_argument("--arxiv", action="append", default=[], help="arXiv ID to ingest")
    parser.add_argument("--openalex", action="append", default=[], help="OpenAlex work ID to ingest")
    parser.add_argument("--query", help="Search query to ingest")
    parser.add_argument("--max-results", type=int, default=5)
    parser.add_argument("--mysql-host", help="MySQL host override")
    parser.add_argument("--mysql-port", type=int, help="MySQL port override")
    parser.add_argument("--mysql-user", help="MySQL user override")
    parser.add_argument("--mysql-password", help="MySQL password override")
    parser.add_argument("--mysql-database", help="MySQL database override")
    parser.add_argument("--no-mysql", action="store_true", help="Disable MySQL storage")
    parser.add_argument("--neo4j-bolt-url", help="Neo4j Bolt URL override")
    parser.add_argument("--no-neo4j", action="store_true", help="Disable Neo4j storage")
    args = parser.parse_args()

    mysql_config = {
        "host": args.mysql_host,
        "port": args.mysql_port,
        "user": args.mysql_user,
        "password": args.mysql_password,
        "database": args.mysql_database,
    }
    mysql_config = {key: value for key, value in mysql_config.items() if value is not None}

    pipeline = IngestionPipeline(
        mysql_config=mysql_config or None,
        use_mysql=not args.no_mysql,
        neo4j_bolt_url=args.neo4j_bolt_url,
        use_neo4j=not args.no_neo4j,
    )
    if args.query:
        records = pipeline.ingest_query(args.query, max_results=args.max_results)
        logger.info("Ingested %d records from query", len(records))
        return

    identifiers: List[PaperIdentifier] = []
    identifiers.extend(PaperIdentifier(doi=doi) for doi in args.doi)
    identifiers.extend(PaperIdentifier(arxiv_id=arxiv_id) for arxiv_id in args.arxiv)
    identifiers.extend(PaperIdentifier(openalex_id=openalex_id) for openalex_id in args.openalex)
    if not identifiers:
        raise SystemExit("Provide --doi, --arxiv, --openalex, or --query.")
    records = pipeline.ingest_identifiers(identifiers)
    logger.info("Ingested %d records from identifiers", len(records))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
