from __future__ import annotations

import argparse
import csv
import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from paperatlas.concepts.extraction.llm_extractor import (
    LLMCache,
    LLMConceptExtractor,
    build_default_llm_client,
)

from paperatlas.concepts.extraction.pipeline import ConceptExtractionPipeline
from paperatlas.concepts.summarization.concept_summarizer import ConceptSummarizer

logger = logging.getLogger(__name__)


def _load_checkpoint(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def _save_checkpoint(path: Path, payload: dict) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run Phase 2 concept extraction."
    )
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--min-concepts", type=int, default=5)
    parser.add_argument("--max-concepts", type=int, default=15)
    parser.add_argument("--dedup-threshold", type=float, default=0.85)
    parser.add_argument("--cache-dir", default="data/llm_cache")
    parser.add_argument("--log-dir", default="data/concepts/phase2")
    parser.add_argument(
        "--paper-id",
        help="Process a single paper_id from MySQL",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume from last successful paper checkpoint",
    )
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--no-llm", action="store_true")
    parser.add_argument("--no-neo4j", action="store_true")
    parser.add_argument("--mysql-host", help="MySQL host override")
    parser.add_argument("--mysql-port", type=int, help="MySQL port override")
    parser.add_argument("--mysql-user", help="MySQL user override")
    parser.add_argument("--mysql-password", help="MySQL password override")
    parser.add_argument("--mysql-database", help="MySQL database override")
    args = parser.parse_args()

    mysql_config = {
        "host": args.mysql_host,
        "port": args.mysql_port,
        "user": args.mysql_user,
        "password": args.mysql_password,
        "database": args.mysql_database,
    }
    mysql_config = {
        key: value for key, value in mysql_config.items() if value is not None
    }

    llm_client = None if args.no_llm else build_default_llm_client()
    llm_extractor = LLMConceptExtractor(
        client=llm_client,
        cache=LLMCache(args.cache_dir),
        offline=args.offline or args.no_llm or llm_client is None,
    )
    summarizer = ConceptSummarizer(llm_client=llm_client)

    pipeline = ConceptExtractionPipeline(
        mysql_config=mysql_config or None,
        llm_extractor=llm_extractor,
        summarizer=summarizer,
        use_neo4j=not args.no_neo4j,
        dedup_threshold=args.dedup_threshold,
    )

    log_dir = Path(args.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    json_path = log_dir / f"concepts_{timestamp}.jsonl"
    csv_path = log_dir / f"concepts_{timestamp}.csv"
    checkpoint_path = Path("data/concepts/checkpoint.json")

    total_processed = 0
    total_concepts = 0
    with json_path.open(
        "w", encoding="utf-8"
    ) as json_handle, csv_path.open(
        "w",
        encoding="utf-8",
        newline="",
    ) as csv_handle:
        writer = csv.DictWriter(
            csv_handle,
            fieldnames=[
                "paper_id",
                "concept_id",
                "concept_name",
                "summary",
                "bullets",
                "source",
            ],
        )
        writer.writeheader()

        if args.paper_id:
            row = pipeline.mysql_store.fetch_paper_by_id(args.paper_id)
            if not row:
                raise SystemExit(f"No paper found for paper_id={args.paper_id}")
            records = pipeline.process_paper(row)
            total_processed = 1
            total_concepts = len(records)
            if len(records) < args.min_concepts or len(records) > args.max_concepts:
                logger.warning(
                    "Paper %s yielded %d concepts (expected %d-%d).",
                    row["paper_id"],
                    len(records),
                    args.min_concepts,
                    args.max_concepts,
                )
            for record in records:
                payload = {
                    "paper_id": record.paper_id,
                    "concept_id": record.concept_id,
                    "concept_name": record.name,
                    "summary": record.summary,
                    "bullets": record.bullets,
                    "source": record.source,
                }
                json_handle.write(json.dumps(payload, ensure_ascii=True) + "\n")
                writer.writerow(
                    {
                        **payload,
                        "bullets": " | ".join(record.bullets),
                    }
                )
        else:
            start_offset = args.offset
            if args.resume and checkpoint_path.exists():
                checkpoint = _load_checkpoint(checkpoint_path)
                if checkpoint:
                    start_offset = int(
                        checkpoint.get("next_offset", start_offset)
                    )
                    logger.info(
                        "Resuming from checkpoint offset %d (paper_id=%s).",
                        start_offset,
                        checkpoint.get("last_paper_id"),
                    )

            for batch_offset in range(
                start_offset,
                args.offset + args.limit,
                args.batch_size,
            ):
                rows = pipeline.mysql_store.fetch_papers(
                    limit=min(
                        args.batch_size,
                        args.offset + args.limit - batch_offset,
                    ),
                    offset=batch_offset,
                )
                if not rows:
                    break
                for index, row in enumerate(rows):
                    records = pipeline.process_paper(row)
                    total_processed += 1
                    total_concepts += len(records)
                    if (
                        len(records) < args.min_concepts
                        or len(records) > args.max_concepts
                    ):
                        logger.warning(
                            "Paper %s yielded %d concepts (expected %d-%d).",
                            row["paper_id"],
                            len(records),
                            args.min_concepts,
                            args.max_concepts,
                        )
                    for record in records:
                        payload = {
                            "paper_id": record.paper_id,
                            "concept_id": record.concept_id,
                            "concept_name": record.name,
                            "summary": record.summary,
                            "bullets": record.bullets,
                            "source": record.source,
                        }
                        json_handle.write(
                            json.dumps(payload, ensure_ascii=True) + "\n"
                        )
                        writer.writerow(
                            {
                                **payload,
                                "bullets": " | ".join(record.bullets),
                            }
                        )
                    next_offset = batch_offset + index + 1
                    _save_checkpoint(
                        checkpoint_path,
                        {
                            "next_offset": next_offset,
                            "last_paper_id": row["paper_id"],
                        },
                    )

    logger.info(
        "Processed %d papers, extracted %d concepts. Logs: %s",
        total_processed,
        total_concepts,
        json_path,
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
