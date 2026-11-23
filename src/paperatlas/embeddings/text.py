"""Sentence embeddings shared by dedup, hybrid search, topic clustering and matching."""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Sequence

import numpy as np

from paperatlas.settings import EMBEDDING_DIM, EMBEDDING_MODEL

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _model():
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(EMBEDDING_MODEL)
    dim = (getattr(model, "get_embedding_dimension", None) or model.get_sentence_embedding_dimension)()
    if dim != EMBEDDING_DIM:
        raise RuntimeError(f"{EMBEDDING_MODEL} has dim {dim}, schema expects {EMBEDDING_DIM}")
    return model


def embed_texts(texts: Sequence[str], batch_size: int = 64) -> np.ndarray:
    """Unit-normalized embeddings, shape (len(texts), EMBEDDING_DIM)."""
    if not texts:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)
    vectors = _model().encode(
        [text or "" for text in texts],
        batch_size=batch_size,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    return np.asarray(vectors, dtype=np.float32)


def embed_text(text: str) -> np.ndarray:
    return embed_texts([text])[0]


def paper_text(title: str | None, abstract: str | None) -> str:
    return f"{title or ''}. {abstract or ''}".strip()
