from __future__ import annotations

import logging
from functools import lru_cache
from typing import Dict, List

import numpy as np
from sklearn.metrics.pairwise import cosine_similarity

logger = logging.getLogger(__name__)


def deduplicate_concepts(
    concepts: List[Dict],
    similarity_threshold: float = 0.85,
    model_name: str = "all-MiniLM-L6-v2",
) -> List[Dict]:
    if len(concepts) <= 1:
        return concepts
    names = [concept["name"] for concept in concepts]
    embeddings = _embed(names, model_name)
    if embeddings is None:
        logger.warning("Embedding model unavailable, using string fallback.")
        return _dedup_string_fallback(concepts)
    sims = cosine_similarity(embeddings)
    keep_indices: List[int] = []
    seen = set()
    for idx in range(len(names)):
        if idx in seen:
            continue
        keep_indices.append(idx)
        for other in range(idx + 1, len(names)):
            if sims[idx, other] >= similarity_threshold:
                seen.add(other)
    return [concepts[idx] for idx in keep_indices]


def _embed(texts: List[str], model_name: str) -> np.ndarray | None:
    try:
        model = _get_model(model_name)
    except Exception as exc:  # pragma: no cover - optional dependency
        logger.warning("SentenceTransformer not available: %s", exc)
        return None
    embeddings = model.encode(texts, normalize_embeddings=True)
    return np.asarray(embeddings)


@lru_cache(maxsize=2)
def _get_model(model_name: str):
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(model_name)


def _dedup_string_fallback(concepts: List[Dict]) -> List[Dict]:
    seen = set()
    unique = []
    for concept in concepts:
        name = concept["name"].strip().lower()
        if name in seen:
            continue
        seen.add(name)
        unique.append(concept)
    return unique
