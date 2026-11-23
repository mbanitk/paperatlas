from __future__ import annotations

import argparse
import logging
from datetime import date, timedelta
from typing import List

from paperatlas.concepts.extraction.models import PaperIdentifier
from paperatlas.concepts.extraction.pipeline import IngestionPipeline

logger = logging.getLogger(__name__)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest papers into local storage."
    )
    parser.add_argument(
        "--doi",
        action="append",
        default=[],
        help="DOI to ingest",
    )
    parser.add_argument(
        "--arxiv",
        action="append",
        default=[],
        help="arXiv ID to ingest",
    )
    parser.add_argument(
        "--url",
        action="append",
        default=[],
        help="Paper URL to ingest",
    )
    # OpenAlex ingestion removed; keep CLI focused on arXiv/DOI inputs only.
    parser.add_argument("--query", help="Search query to ingest")
    parser.add_argument("--max-results", type=int, default=5)
    parser.add_argument("--from-date", help="Filter results from YYYY-MM-DD")
    parser.add_argument(
        "--last-days",
        type=int,
        help="Filter results from the last N days",
    )
    parser.add_argument(
        "--database-url",
        help="PostgreSQL URL (default: PAPERATLAS_DATABASE_URL or postgresql+psycopg://localhost/paperatlas)",
    )
    parser.add_argument(
        "--no-db",
        action="store_true",
        help="Only write JSON files under data/papers (skip PostgreSQL)",
    )
    args = parser.parse_args()

    pipeline = IngestionPipeline(use_db=not args.no_db, database_url=args.database_url)
    if args.query:
        from_date = args.from_date
        if args.last_days:
            from_date = (date.today() - timedelta(days=args.last_days)).isoformat()
        records = pipeline.ingest_query(
            args.query,
            max_results=args.max_results,
            from_date=from_date,
        )
        logger.info("Ingested %d records from query", len(records))
        return

    records = []
    if args.url:
        records.extend(pipeline.ingest_urls(args.url))

    identifiers: List[PaperIdentifier] = []
    identifiers.extend(PaperIdentifier(doi=doi) for doi in args.doi)
    identifiers.extend(PaperIdentifier(arxiv_id=arxiv_id) for arxiv_id in args.arxiv)
    if identifiers:
        records.extend(pipeline.ingest_identifiers(identifiers))

    if not records:
        raise SystemExit("Provide --url, --doi, --arxiv, or --query.")
    logger.info("Ingested %d records from inputs", len(records))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
