"""Hybrid search over papers and claims: Postgres full-text + pgvector, fused with RRF."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional, Sequence

import numpy as np
from pgvector.sqlalchemy import Vector
from sqlalchemy import bindparam, text

from paperatlas.db.engine import session_scope
from paperatlas.embeddings.text import embed_text
from paperatlas.settings import EMBEDDING_DIM

_TABLES = {
    "claims": ("research.claims", "id"),
    "papers": ("research.papers", "paper_id"),
}


@dataclass
class SearchHit:
    id: str | int
    score: float
    text_rank: Optional[int]
    vector_rank: Optional[int]
    similarity: Optional[float]


def hybrid_search(
    query: str,
    target: Literal["claims", "papers"] = "claims",
    limit: int = 20,
    candidates: int = 100,
    rrf_k: int = 60,
    where: str = "TRUE",
    params: Optional[dict] = None,
    query_embedding: Optional[Sequence[float]] = None,
    url: Optional[str] = None,
) -> list[SearchHit]:
    """Reciprocal-rank fusion of `websearch_to_tsquery` ranking and cosine similarity.

    `where` is a trusted SQL predicate on the target table (aliased `t`).
    """
    table, key = _TABLES[target]
    vector = np.asarray(
        query_embedding if query_embedding is not None else embed_text(query),
        dtype=np.float32,
    )
    sql = text(
        f"""
        WITH q AS (SELECT websearch_to_tsquery('english', :query) AS tsq),
        fts AS (
            SELECT t.{key} AS id,
                   row_number() OVER (ORDER BY ts_rank_cd(t.tsv, q.tsq) DESC) AS r
            FROM {table} t, q
            WHERE t.tsv @@ q.tsq AND ({where})
            ORDER BY ts_rank_cd(t.tsv, q.tsq) DESC
            LIMIT :candidates
        ),
        vec AS (
            SELECT t.{key} AS id,
                   row_number() OVER (ORDER BY t.embedding <=> :embedding) AS r,
                   1 - (t.embedding <=> :embedding) AS similarity
            FROM {table} t
            WHERE t.embedding IS NOT NULL AND ({where})
            ORDER BY t.embedding <=> :embedding
            LIMIT :candidates
        )
        SELECT coalesce(fts.id, vec.id) AS id,
               coalesce(1.0 / (:rrf_k + fts.r), 0) + coalesce(1.0 / (:rrf_k + vec.r), 0) AS score,
               fts.r AS text_rank, vec.r AS vector_rank, vec.similarity
        FROM fts FULL OUTER JOIN vec ON fts.id = vec.id
        ORDER BY score DESC
        LIMIT :limit
        """
    ).bindparams(bindparam("embedding", type_=Vector(EMBEDDING_DIM)))
    with session_scope(url) as session:
        rows = session.execute(
            sql,
            {
                "query": query,
                "embedding": vector,
                "candidates": candidates,
                "rrf_k": rrf_k,
                "limit": limit,
                **(params or {}),
            },
        ).all()
    return [
        SearchHit(
            id=row.id,
            score=float(row.score),
            text_rank=row.text_rank,
            vector_rank=row.vector_rank,
            similarity=float(row.similarity) if row.similarity is not None else None,
        )
        for row in rows
    ]


def nearest_claims(
    embedding: Sequence[float],
    min_similarity: float,
    exclude_id: int,
    limit: int = 10,
    url: Optional[str] = None,
) -> list[tuple[int, float, Optional[str]]]:
    sql = text(
        """
        SELECT id, 1 - (embedding <=> :embedding) AS similarity, category
        FROM research.claims
        WHERE embedding IS NOT NULL AND id <> :exclude_id
        ORDER BY embedding <=> :embedding
        LIMIT :limit
        """
    ).bindparams(bindparam("embedding", type_=Vector(EMBEDDING_DIM)))
    with session_scope(url) as session:
        rows = session.execute(
            sql,
            {
                "embedding": np.asarray(embedding, dtype=np.float32),
                "exclude_id": exclude_id,
                "limit": limit,
            },
        ).all()
    return [
        (row.id, float(row.similarity), row.category)
        for row in rows
        if row.similarity >= min_similarity
    ]
