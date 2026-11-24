"""Group near-duplicate claims across papers (same idea proposed by several papers)."""

from __future__ import annotations

import logging
from typing import Any, Iterable, Optional

import numpy as np
from sqlalchemy import func, select, update

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Claim, ClaimGroup

logger = logging.getLogger(__name__)


def _nearest_same_category(
    embedding: Any,
    category: Optional[str],
    min_similarity: float,
    exclude_id: int,
    limit: int = 10,
    url: Optional[str] = None,
) -> list[int]:
    """Nearest claims of the same category (filtered before the LIMIT, not after)."""
    distance = Claim.embedding.cosine_distance(np.asarray(embedding, dtype=np.float32))
    with session_scope(url) as session:
        rows = session.execute(
            select(Claim.id, (1 - distance).label("similarity"))
            .where(
                Claim.embedding.is_not(None),
                Claim.id != exclude_id,
                Claim.category.is_not_distinct_from(category),
            )
            .order_by(distance)
            .limit(limit)
        ).all()
    return [row.id for row in rows if row.similarity >= min_similarity]


def assign_claim_groups(
    claim_ids: Optional[Iterable[int]] = None,
    min_similarity: float = 0.85,
    url: Optional[str] = None,
) -> int:
    """Attach each claim to the group of its nearest same-category neighbour, creating
    groups as needed. Returns the number of claims that joined a group."""
    with session_scope(url) as session:
        query = select(Claim.id, Claim.embedding, Claim.category, Claim.paper_id).where(
            Claim.embedding.is_not(None), Claim.group_id.is_(None)
        )
        if claim_ids is not None:
            query = query.where(Claim.id.in_(list(claim_ids)))
        pending = session.execute(query.order_by(Claim.id)).all()

    grouped = 0
    for claim_id, embedding, category, paper_id in pending:
        neighbours = _nearest_same_category(
            embedding, category, min_similarity, exclude_id=claim_id, url=url
        )
        if not neighbours:
            continue
        with session_scope(url) as session:
            rows = session.execute(
                select(Claim.id, Claim.group_id, Claim.paper_id, Claim.technique).where(
                    Claim.id.in_([claim_id, *neighbours])
                )
            ).all()
            if all(row.paper_id == paper_id for row in rows):
                continue
            group_id = next((row.group_id for row in rows if row.group_id), None)
            if group_id is None:
                canonical = min(rows, key=lambda row: row.id)
                group = ClaimGroup(
                    label=canonical.technique[:200],
                    category=category,
                    canonical_claim_id=canonical.id,
                )
                session.add(group)
                session.flush()
                group_id = group.id
            member_ids = [row.id for row in rows if row.group_id in (None, group_id)]
            session.execute(update(Claim).where(Claim.id.in_(member_ids)).values(group_id=group_id))
            size = session.scalar(select(func.count()).where(Claim.group_id == group_id))
            session.execute(update(ClaimGroup).where(ClaimGroup.id == group_id).values(size=size))
            grouped += 1
    if grouped:
        logger.info("Grouped %d claims with near-duplicates from other papers", grouped)
    return grouped
