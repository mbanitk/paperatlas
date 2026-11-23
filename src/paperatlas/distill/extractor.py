"""Turn a paper (or patent) into 5–10 technical concepts, each with a testable claim card."""

from __future__ import annotations

import logging
import threading
from typing import Any, Optional

from pydantic import ValidationError

from paperatlas.concepts.extraction.heuristic_extractor import HeuristicConceptExtractor
from paperatlas.concepts.validation.deduplication import deduplicate_concepts
from paperatlas.distill.claims import (
    DISTILLATION_SCHEMA,
    ClaimCard,
    DistilledConcept,
    Distillation,
    Evidence,
)
from paperatlas.llm.client import LLMClient, LLMError

logger = logging.getLogger(__name__)
_EMBED_LOCK = threading.Lock()

SYSTEM_PROMPT = """You are a senior ML-systems researcher reviewing a research paper or patent for an \
engineering team that builds and operates LLM inference services.

Extract between {min_concepts} and {max_concepts} distinct technical concepts from the document: \
methods, algorithms, system designs, key empirical findings, evaluation methods and important \
limitations. Prefer concepts an engineer could adopt or test.

For each concept provide:
- name: a short technical name.
- kind: the type of concept.
- summary: 2-4 precise sentences on what it is and how it works.
- key_points: 2-5 terse technical points (mechanism, conditions, trade-offs).
- claim: a claim card describing how an engineer would test the concept in their own system:
  - testable: true only if the document states a measurable effect (latency, TTFT, throughput, \
memory, accuracy, cost, energy, ...) that could be reproduced by changing a system.
  - category: the closest category.
  - technique: 1-2 sentences describing the idea concretely.
  - change_required: the concrete change needed in an existing inference stack to adopt it.
  - effects: each measurable effect the document claims, with value and unit exactly as reported \
(prefer "%" or "x"), the metric's direction, the baseline compared against and the conditions. \
Use null when a value is not stated. Never invent or estimate numbers.
  - paper_setup: the setup behind the claim (null where not stated).
  - prerequisites: hard requirements (e.g. "CUDA kernels", "multiple GPUs", "draft model", \
"fine-tuning", "specialized hardware").
  - requires_cuda / requires_multi_gpu / requires_training: true only if the technique cannot work \
without it.
  - effort: low = configuration change, medium = new module of moderate size, high = custom \
kernels, training or architecture changes.
  - risks: quality, stability or compatibility risks.
  - evidence: a verbatim quote (at most 300 characters) from the document supporting the claim, \
and where it appears (section, table or figure).

Write neutral, precise technical language. Do not write marketing copy, social-media posts, hooks, \
emojis or calls to action. Concepts must be distinct; merge near-duplicates."""


def build_user_prompt(row: dict[str, Any], max_chars: int) -> str:
    header = [
        f"Document type: {row.get('doc_type') or 'paper'}",
        f"Title: {row.get('title') or ''}",
    ]
    if row.get("venue"):
        header.append(f"Venue: {row['venue']}")
    if row.get("publication_year"):
        header.append(f"Year: {row['publication_year']}")
    parts = ["\n".join(header)]
    if row.get("abstract"):
        parts.append(f"Abstract:\n{row['abstract']}")
    if row.get("raw_text"):
        parts.append(f"Full text:\n{row['raw_text']}")
    document = "\n\n".join(parts)
    if len(document) > max_chars:
        document = document[:max_chars] + "\n[truncated]"
    return document


class ClaimExtractor:
    def __init__(
        self,
        client: Optional[LLMClient],
        min_concepts: int = 5,
        max_concepts: int = 10,
        max_chars: int = 60000,
        dedup_threshold: float = 0.85,
    ) -> None:
        self.client = client
        self.min_concepts = min_concepts
        self.max_concepts = max_concepts
        self.max_chars = max_chars
        self.dedup_threshold = dedup_threshold
        self.heuristic = HeuristicConceptExtractor(max_concepts=max_concepts)

    @property
    def source(self) -> str:
        return "llm" if self.client else "heuristic"

    def extract(self, row: dict[str, Any]) -> list[DistilledConcept]:
        concepts: list[DistilledConcept] = []
        if self.client:
            try:
                concepts = self._extract_llm(row)
            except LLMError as exc:
                logger.warning("LLM distillation failed for %s: %s", row.get("paper_id"), exc)
        if not concepts:
            concepts = self._extract_heuristic(row)
        with _EMBED_LOCK:
            unique = deduplicate_concepts(
                [{"name": concept.name, "index": index} for index, concept in enumerate(concepts)],
                similarity_threshold=self.dedup_threshold,
            )
        return [concepts[item["index"]] for item in unique][: self.max_concepts]

    def _extract_llm(self, row: dict[str, Any]) -> list[DistilledConcept]:
        system = SYSTEM_PROMPT.format(
            min_concepts=self.min_concepts, max_concepts=self.max_concepts
        )
        payload = self.client.generate_json(
            system,
            build_user_prompt(row, self.max_chars),
            "paper_distillation",
            DISTILLATION_SCHEMA,
        )
        return parse_distillation(payload).concepts

    def _extract_heuristic(self, row: dict[str, Any]) -> list[DistilledConcept]:
        candidates = self.heuristic.extract(row.get("title") or "", row.get("abstract"), row.get("raw_text"))
        concepts = []
        for candidate in candidates:
            evidence = (candidate.get("evidence") or candidate["name"])[:300]
            concepts.append(
                DistilledConcept(
                    name=candidate["name"],
                    kind="other",
                    summary=evidence,
                    key_points=[],
                    claim=ClaimCard(
                        testable=False,
                        category="other",
                        technique=candidate["name"],
                        change_required="Unknown (heuristic extraction; rerun with an LLM).",
                        evidence=Evidence(quote=evidence),
                    ),
                )
            )
        return concepts


def parse_distillation(payload: dict[str, Any]) -> Distillation:
    """Validate concepts one by one so a single malformed concept does not drop the paper."""
    concepts = []
    for item in payload.get("concepts") or []:
        try:
            concepts.append(DistilledConcept.model_validate(item))
        except ValidationError as exc:
            logger.warning("Skipping malformed concept %r: %s", item.get("name"), exc.errors()[:2])
    return Distillation(paper_summary=payload.get("paper_summary") or "", concepts=concepts)
