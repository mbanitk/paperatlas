"""Concept map: how the concepts distilled from one paper relate to each other.

One grounded LLM pass per paper records the order the paper explains its concepts, each
concept's role, typed links (A requires / builds on / complements / is an alternative to /
is evaluated by B) and the bundles of concepts that together produce a reported result.
"""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from typing import Any, Optional

from sqlalchemy import delete, select, update

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Claim, Concept, ConceptLink, Paper
from paperatlas.db.store import clean_json
from paperatlas.llm.client import LLMClient, LLMError, build_default_llm_client

logger = logging.getLogger(__name__)

RELATIONS = ("requires", "builds_on", "complements", "alternative_to", "evaluated_by")
SYMMETRIC = {"complements", "alternative_to"}
ROLES = ("foundation", "core", "extension", "optimization", "evaluation", "limitation")

_INT_LIST = {"type": "array", "items": {"type": "integer"}}


def _obj(properties: dict) -> dict:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


CONCEPT_MAP_SCHEMA = _obj(
    {
        "order": _INT_LIST,
        "roles": {
            "type": "array",
            "items": _obj({"concept": {"type": "integer"}, "role": {"type": "string", "enum": list(ROLES)}}),
        },
        "links": {
            "type": "array",
            "items": _obj(
                {
                    "from": {"type": "integer"},
                    "to": {"type": "integer"},
                    "relation": {"type": "string", "enum": list(RELATIONS)},
                    "why": {"type": "string"},
                    "evidence": {"type": ["string", "null"]},
                }
            ),
        },
        "bundles": {
            "type": "array",
            "items": _obj(
                {
                    "name": {"type": "string"},
                    "concepts": _INT_LIST,
                    "effect": {"type": "string"},
                    "is_headline_result": {"type": "boolean"},
                }
            ),
        },
        "reading_path": {"type": "string"},
    }
)

SYSTEM = """You map how the concepts extracted from ONE paper relate to each other, so an engineer
knows which ideas depend on which, and which must be combined to reach the paper's results.
Concepts are numbered C1..Cn. Fill:
- order: concept numbers in the order the paper introduces and explains them.
- roles: one role per concept: foundation (pre-existing component or background the paper relies
  on), core (main contribution), extension (add-on or refinement of a core idea), optimization
  (implementation/efficiency detail), evaluation (benchmark, metric or empirical finding),
  limitation (failure mode or caveat).
- links (directed, from -> to):
  * requires: `from` cannot work without `to` being in place first.
  * builds_on: `from` extends or refines `to`, but `to` is useful on its own.
  * complements: the two are combined to get the full effect (symmetric; list once).
  * alternative_to: either one can be used, not both (symmetric; list once).
  * evaluated_by: `to` is the finding/benchmark/metric that measures `from`.
  Each link has a one-sentence `why` and a short `evidence` quote or section reference (or null).
  Only add links the paper supports. Prefer few precise links over many weak ones.
- bundles: groups of concepts that are applied TOGETHER to obtain a reported result; `effect`
  states that result with numbers exactly as reported (or 'not quantified'); set
  is_headline_result for the paper's main result.
- reading_path: 1-2 sentences on the order to understand and adopt the ideas.
Use only the material provided; never invent numbers."""


def _headings(raw_text: Optional[str], limit: int = 40) -> list[str]:
    if not raw_text:
        return []
    found = []
    for line in raw_text.splitlines():
        line = line.strip()
        if 3 < len(line) < 90 and re.match(r"^(\d+(\.\d+)*\.?|[IVX]+\.)\s+[A-Z]", line):
            found.append(line)
        if len(found) == limit:
            break
    return found


def build_prompt(paper: Paper, concepts: list[tuple[Concept, Optional[Claim]]]) -> str:
    lines = [f"Paper: {paper.title}", f"Abstract: {paper.abstract or 'not available'}"]
    headings = _headings(paper.raw_text)
    if headings:
        lines.append("Section headings: " + " | ".join(headings))
    lines.append("Concepts:")
    for index, (concept, claim) in enumerate(concepts, start=1):
        card = (claim.card if claim else None) or {}
        lines.append(
            f"C{index}: {concept.name} [{concept.kind}] — {concept.summary} | technique: "
            f"{claim.technique if claim else '-'} | prerequisites: {card.get('prerequisites')} | "
            f"effects: {card.get('effects')} | evidence: {(card.get('evidence') or {}).get('quote')}"
        )
    return "\n".join(lines)


def parse_concept_map(payload: dict[str, Any], concept_ids: list[int]) -> dict[str, Any]:
    """Validate indices, drop self/duplicate links, normalise symmetric relations."""
    count = len(concept_ids)

    def concept_id(index: Any) -> Optional[int]:
        return concept_ids[index - 1] if isinstance(index, int) and 1 <= index <= count else None

    order = [cid for cid in dict.fromkeys(concept_id(i) for i in payload.get("order") or []) if cid]
    order += [cid for cid in concept_ids if cid not in order]
    roles = {cid: item["role"] for item in payload.get("roles") or [] if (cid := concept_id(item.get("concept"))) and item.get("role") in ROLES}
    links, seen = [], set()
    for item in payload.get("links") or []:
        source, target, relation = concept_id(item.get("from")), concept_id(item.get("to")), item.get("relation")
        if not source or not target or source == target or relation not in RELATIONS:
            continue
        if relation in SYMMETRIC:
            source, target = sorted((source, target))
        key = (source, target, relation)
        if key in seen:
            continue
        seen.add(key)
        links.append({"source": source, "target": target, "relation": relation, "why": item.get("why"), "evidence": item.get("evidence")})
    bundles = []
    for item in payload.get("bundles") or []:
        members = [cid for cid in dict.fromkeys(concept_id(i) for i in item.get("concepts") or []) if cid]
        if len(members) >= 2:
            bundles.append(
                {
                    "name": item.get("name") or "Combined",
                    "concept_ids": members,
                    "effect": item.get("effect") or "not quantified",
                    "is_headline_result": bool(item.get("is_headline_result")),
                }
            )
    return {"order": order, "roles": roles, "links": links, "bundles": bundles, "reading_path": payload.get("reading_path") or ""}


def map_paper(paper_id: str, llm: Optional[LLMClient] = None, force: bool = False) -> dict[str, Any]:
    with session_scope() as session:
        paper = session.get(Paper, paper_id)
        if paper is None:
            raise ValueError(f"paper {paper_id} not found")
        if paper.concept_map and not force:
            return paper.concept_map
        concepts = session.execute(
            select(Concept, Claim)
            .outerjoin(Claim, Claim.concept_id == Concept.id)
            .where(Concept.paper_id == paper_id)
            .order_by(Concept.id)
        ).all()
        if len(concepts) < 2:
            return {}
        prompt = build_prompt(paper, concepts)
        concept_ids = [concept.id for concept, _ in concepts]
    llm = llm or build_default_llm_client()
    if llm is None:
        raise LLMError("No LLM configured (set OPENAI_API_KEY) — concept maps need an LLM")
    parsed = parse_concept_map(llm.generate_json(SYSTEM, prompt, "concept_map", CONCEPT_MAP_SCHEMA), concept_ids)
    concept_map = clean_json(
        {
            "order": parsed["order"],
            "roles": {str(cid): role for cid, role in parsed["roles"].items()},
            "bundles": parsed["bundles"],
            "reading_path": parsed["reading_path"],
            "generated_at": datetime.now(UTC).isoformat(),
            "model": llm.model,
        }
    )
    with session_scope() as session:
        session.execute(delete(ConceptLink).where(ConceptLink.paper_id == paper_id))
        for link in parsed["links"]:
            session.add(
                ConceptLink(
                    paper_id=paper_id,
                    source_concept_id=link["source"],
                    target_concept_id=link["target"],
                    relation=link["relation"],
                    why=clean_json(link["why"]),
                    evidence=clean_json(link["evidence"]),
                )
            )
        for position, cid in enumerate(parsed["order"], start=1):
            session.execute(
                update(Concept).where(Concept.id == cid).values(paper_order=position, role=parsed["roles"].get(cid))
            )
        session.execute(update(Paper).where(Paper.paper_id == paper_id).values(concept_map=concept_map))
    return concept_map
