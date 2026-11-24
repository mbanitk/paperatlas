"""Phase 2 — Distill papers stored in PostgreSQL into concepts and claim cards.

Kept at this path for backwards compatibility; same as `paperatlas r2e distill`.
"""

from __future__ import annotations

import argparse
import logging

from paperatlas.distill.extractor import ClaimExtractor
from paperatlas.distill.pipeline import DistillPipeline
from paperatlas.llm.client import build_default_llm_client

logger = logging.getLogger(__name__)


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--limit", type=int, default=50, help="Max papers to distill")
    parser.add_argument("--paper-id", action="append", help="Distill specific paper ids")
    parser.add_argument("--min-concepts", type=int, default=5)
    parser.add_argument("--max-concepts", type=int, default=10)
    parser.add_argument("--max-chars", type=int, default=60000, help="Paper text sent to the LLM")
    parser.add_argument("--dedup-threshold", type=float, default=0.85)
    parser.add_argument("--reprocess", action="store_true", help="Re-distill already distilled papers")
    parser.add_argument("--no-llm", "--offline", dest="no_llm", action="store_true", help="Heuristics only")
    parser.add_argument("--no-cache", action="store_true", help="Bypass the LLM response cache")
    parser.add_argument("--no-group", action="store_true", help="Skip cross-paper claim grouping")


def run(args: argparse.Namespace) -> None:
    client = None if args.no_llm else build_default_llm_client(use_cache=not args.no_cache)
    extractor = ClaimExtractor(
        client,
        min_concepts=args.min_concepts,
        max_concepts=args.max_concepts,
        max_chars=args.max_chars,
        dedup_threshold=args.dedup_threshold,
    )
    stats = DistillPipeline(extractor=extractor).run(
        limit=args.limit,
        paper_ids=args.paper_id,
        reprocess=args.reprocess,
        group=not args.no_group,
    )
    logger.info(
        "Distilled %d papers → %d concepts, %d testable claims, %d grouped.",
        stats.papers,
        stats.concepts,
        stats.testable_claims,
        stats.grouped,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Distill papers into concepts and claim cards.")
    add_arguments(parser)
    run(parser.parse_args())


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    main()
