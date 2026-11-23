"""Read side of concept maps: related claims for cards, prerequisite chains, paper maps."""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable, Optional

from sqlalchemy import or_, select

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Claim, Concept, ConceptLink, Match, Paper

OUTGOING = {"requires": "requires", "builds_on": "builds_on", "evaluated_by": "evaluated_by"}
INCOMING = {"requires": "required_by", "builds_on": "extended_by", "evaluated_by": "evaluates"}
SYMMETRIC = {"complements": "complements", "alternative_to": "alternatives"}
RELATED_KEYS = ("requires", "required_by", "builds_on", "extended_by", "complements", "alternatives", "evaluated_by", "evaluates")


def _concept_rows(session, concept_ids: Iterable[int]) -> dict[int, dict[str, Any]]:
    rows = session.execute(
        select(Concept, Claim)
        .outerjoin(Claim, Claim.concept_id == Concept.id)
        .where(Concept.id.in_(list(concept_ids)))
    ).all()
    claim_ids = [claim.id for _, claim in rows if claim]
    headlines = dict(
        session.execute(
            select(Match.claim_id, Match.explainer["headline"].astext).where(
                Match.claim_id.in_(claim_ids), Match.explainer.is_not(None)
            )
        ).all()
    )
    testable_here = dict(
        session.execute(select(Match.claim_id, Match.testable_here).where(Match.claim_id.in_(claim_ids))).all()
    )
    return {
        concept.id: {
            "concept_id": concept.id,
            "claim_id": claim.id if claim else None,
            "name": concept.name,
            "kind": concept.kind,
            "role": concept.role,
            "order": concept.paper_order,
            "category": claim.category if claim else None,
            "testable": bool(claim and claim.testable),
            "testable_here": testable_here.get(claim.id) if claim else None,
            "claimed_gain_pct": claim.claimed_gain_pct if claim else None,
            "headline": headlines.get(claim.id) if claim else None,
        }
        for concept, claim in rows
    }


def related_for_claims(claim_ids: Iterable[int]) -> dict[int, dict[str, Any]]:
    """For each claim: concepts it requires / builds on / complements …, bundles and its position."""
    claim_ids = list(claim_ids)
    if not claim_ids:
        return {}
    with session_scope() as session:
        claims = session.execute(
            select(Claim.id, Claim.concept_id, Claim.paper_id).where(Claim.id.in_(claim_ids))
        ).all()
        concept_of = {claim_id: concept_id for claim_id, concept_id, _ in claims}
        concept_ids = set(concept_of.values())
        links = session.scalars(
            select(ConceptLink).where(
                or_(ConceptLink.source_concept_id.in_(concept_ids), ConceptLink.target_concept_id.in_(concept_ids))
            )
        ).all()
        papers = {
            paper_id: concept_map
            for paper_id, concept_map in session.execute(
                select(Paper.paper_id, Paper.concept_map).where(Paper.paper_id.in_({p for _, _, p in claims}))
            ).all()
        }
        others = {link.source_concept_id for link in links} | {link.target_concept_id for link in links} | concept_ids
        for concept_map in papers.values():
            for bundle in (concept_map or {}).get("bundles", []):
                others.update(bundle["concept_ids"])
        info = _concept_rows(session, others)
        totals = defaultdict(int)
        for paper_id, count in session.execute(
            select(Concept.paper_id, Concept.id).where(Concept.paper_id.in_(list(papers)))
        ).all():
            totals[paper_id] += 1

    result: dict[int, dict[str, Any]] = {}
    for claim_id, concept_id, paper_id in claims:
        related: dict[str, list] = {key: [] for key in RELATED_KEYS}
        for link in links:
            entry = None
            if link.source_concept_id == concept_id:
                key = OUTGOING.get(link.relation) or SYMMETRIC.get(link.relation)
                entry = (key, link.target_concept_id)
            elif link.target_concept_id == concept_id:
                key = INCOMING.get(link.relation) or SYMMETRIC.get(link.relation)
                entry = (key, link.source_concept_id)
            if entry and entry[0]:
                related[entry[0]].append({**info[entry[1]], "why": link.why})
        concept_map = papers.get(paper_id) or {}
        bundles = [
            {
                "name": bundle["name"],
                "effect": bundle["effect"],
                "is_headline_result": bundle["is_headline_result"],
                "members": [info[cid] for cid in bundle["concept_ids"] if cid in info],
            }
            for bundle in concept_map.get("bundles", [])
            if concept_id in bundle["concept_ids"]
        ]
        me = info.get(concept_id, {})
        result[claim_id] = {
            **related,
            "bundles": bundles,
            "order": me.get("order"),
            "role": me.get("role"),
            "concepts_in_paper": totals.get(paper_id, 0),
            "has_map": bool(concept_map),
            "prerequisites": prerequisite_chain(claim_id),
        }
    return result


def prerequisite_chain(claim_id: int) -> list[dict[str, Any]]:
    """Transitive `requires` closure for a claim, dependencies first (excludes the claim itself)."""
    with session_scope() as session:
        start = session.scalar(select(Claim.concept_id).where(Claim.id == claim_id))
        if start is None:
            return []
        paper_id = session.scalar(select(Concept.paper_id).where(Concept.id == start))
        edges = session.execute(
            select(ConceptLink.source_concept_id, ConceptLink.target_concept_id).where(
                ConceptLink.paper_id == paper_id, ConceptLink.relation == "requires"
            )
        ).all()
        needs = defaultdict(list)
        for source, target in edges:
            needs[source].append(target)
        ordered: list[int] = []
        visiting: set[int] = set()

        def visit(node: int) -> None:
            if node in ordered or node in visiting:
                return
            visiting.add(node)
            for dependency in needs.get(node, []):
                visit(dependency)
            visiting.discard(node)
            ordered.append(node)

        visit(start)
        chain = [cid for cid in ordered if cid != start]
        info = _concept_rows(session, chain) if chain else {}
    return [info[cid] for cid in chain if cid in info]


def paper_concept_map(paper_id: str) -> Optional[dict[str, Any]]:
    with session_scope() as session:
        concept_map = session.scalar(select(Paper.concept_map).where(Paper.paper_id == paper_id))
        concept_ids = session.scalars(select(Concept.id).where(Concept.paper_id == paper_id)).all()
        if not concept_ids:
            return None
        info = _concept_rows(session, concept_ids)
        links = session.scalars(select(ConceptLink).where(ConceptLink.paper_id == paper_id)).all()
    order = (concept_map or {}).get("order") or sorted(concept_ids)
    nodes = [info[cid] for cid in order if cid in info] + [info[cid] for cid in concept_ids if cid not in order]
    return {
        "nodes": nodes,
        "links": [
            {"source": l.source_concept_id, "target": l.target_concept_id, "relation": l.relation, "why": l.why, "evidence": l.evidence}
            for l in links
        ],
        "bundles": [
            {**bundle, "members": [info[cid] for cid in bundle["concept_ids"] if cid in info]}
            for bundle in (concept_map or {}).get("bundles", [])
        ],
        "reading_path": (concept_map or {}).get("reading_path"),
        "generated": bool(concept_map),
    }
