"""Phase 2 — Distill: papers in Postgres → concepts + claim cards (+ embeddings, groups)."""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Optional

from sqlalchemy import func, select

from paperatlas import settings
from paperatlas.concepts.extraction.models import canonical_concept_id
from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Claim
from paperatlas.db.store import PaperStore
from paperatlas.distill.claims import DistilledConcept
from paperatlas.distill.dedup import assign_claim_groups
from paperatlas.distill.extractor import ClaimExtractor
from paperatlas.embeddings.text import embed_texts
from paperatlas.llm.client import build_default_llm_client

logger = logging.getLogger(__name__)


@dataclass
class DistillStats:
    papers: int = 0
    concepts: int = 0
    claims: int = 0
    testable_claims: int = 0
    grouped: int = 0
    claim_ids: list[int] = field(default_factory=list)
    log_path: Optional[Path] = None


def concept_payload(concept: DistilledConcept, source: str, embedding: Any) -> dict[str, Any]:
    card = concept.claim
    effect = card.primary_effect()
    return {
        "concept_key": canonical_concept_id(concept.name),
        "name": concept.name,
        "kind": concept.kind,
        "summary": concept.summary,
        "key_points": concept.key_points,
        "source": source,
        "claim": {
            "category": card.category,
            "technique": card.technique,
            "change_required": card.change_required,
            "primary_metric": effect.metric if effect else None,
            "claimed_value": effect.value if effect else None,
            "claimed_unit": effect.unit if effect else None,
            "direction": effect.direction if effect else None,
            "claimed_gain_pct": card.claimed_gain_pct(),
            "testable": card.testable,
            "requires_cuda": card.requires_cuda,
            "requires_multi_gpu": card.requires_multi_gpu,
            "requires_training": card.requires_training,
            "effort": card.effort,
            "evidence_quote": card.evidence.quote,
            "card": card.model_dump(mode="json"),
            "embedding": embedding,
        },
    }


class DistillPipeline:
    def __init__(
        self,
        store: Optional[PaperStore] = None,
        extractor: Optional[ClaimExtractor] = None,
        use_llm: bool = True,
        log_dir: Optional[Path] = None,
        concurrency: int = 4,
    ) -> None:
        self.concurrency = max(1, concurrency)
        self.store = store or PaperStore()
        self.extractor = extractor or ClaimExtractor(build_default_llm_client() if use_llm else None)
        if self.extractor.client is None:
            logger.warning("No LLM configured; falling back to heuristic concept extraction.")
        self.log_dir = log_dir or settings.data_dir() / "distill"

    def distill_row(self, row: dict[str, Any]) -> list[int]:
        return self._persist(row, self.extractor.extract(row))

    def _persist(self, row: dict[str, Any], concepts: list[DistilledConcept]) -> list[int]:
        embeddings = embed_texts([concept.claim.search_text() for concept in concepts])
        payloads = [
            concept_payload(concept, self.extractor.source, embeddings[index])
            for index, concept in enumerate(concepts)
        ]
        claim_ids = self.store.save_distillation(row["paper_id"], payloads)
        self._log(row, concepts)
        return claim_ids

    def run(
        self,
        limit: int = 50,
        paper_ids: Optional[Iterable[str]] = None,
        reprocess: bool = False,
        group: bool = True,
        explain: bool = True,
    ) -> DistillStats:
        stats = DistillStats()
        distilled: list[str] = []
        if paper_ids is not None:
            ids = list(paper_ids)
            if reprocess:
                self.store.reset_distillation(ids)
            rows = [row for row in self.store.fetch_by_ids(ids) if reprocess or not row["distilled_at"]]
        else:
            if reprocess:
                self.store.reset_distillation()
            rows = self.store.fetch_undistilled(limit=limit)
        rows = rows[:limit]
        logger.info("Distilling %d papers (%d in parallel)", len(rows), self.concurrency)
        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            futures = {pool.submit(self.extractor.extract, row): row for row in rows}
            for index, future in enumerate(as_completed(futures), start=1):
                row = futures[future]
                try:
                    concepts = future.result()
                except Exception:  # noqa: BLE001 - one bad paper must not stop the batch
                    logger.exception("Distilling %s failed", row["paper_id"])
                    continue
                claim_ids = self._persist(row, concepts)
                logger.info("[%d/%d] %s: %d claims — %s", index, len(rows), row["paper_id"], len(claim_ids), row["title"][:70])
                stats.papers += 1
                distilled.append(row["paper_id"])
                stats.concepts += len(claim_ids)
                stats.claims += len(claim_ids)
                stats.claim_ids.extend(claim_ids)
        if group and stats.claim_ids:
            stats.grouped = assign_claim_groups(stats.claim_ids)
        if explain and self.extractor.client and distilled:
            from paperatlas.r2e.explainers import _run_all, explain_paper

            _run_all(
                lambda pid: explain_paper(pid, self.extractor.client, force=True),
                distilled,
                self.concurrency,
                "papers",
                lambda stage, message, data=None: logger.info("[%s] %s", stage, message),
            )
        stats.testable_claims = self._count_testable(stats.claim_ids)
        stats.log_path = self._log_path
        return stats

    @staticmethod
    def _count_testable(claim_ids: list[int]) -> int:
        if not claim_ids:
            return 0
        with session_scope() as session:
            return session.scalar(
                select(func.count()).where(Claim.id.in_(claim_ids), Claim.testable.is_(True))
            )

    @property
    def _log_path(self) -> Path:
        if not hasattr(self, "_log_file"):
            self.log_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
            self._log_file = self.log_dir / f"claims_{stamp}.jsonl"
        return self._log_file

    def _log(self, row: dict[str, Any], concepts: list[DistilledConcept]) -> None:
        with self._log_path.open("a", encoding="utf-8") as handle:
            for concept in concepts:
                handle.write(
                    json.dumps(
                        {"paper_id": row["paper_id"], **concept.model_dump(mode="json")},
                        ensure_ascii=True,
                    )
                    + "\n"
                )
