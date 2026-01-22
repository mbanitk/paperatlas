from __future__ import annotations

import hashlib
from typing import Dict, List, Optional

from pydantic import BaseModel, Field, HttpUrl


class PaperAuthor(BaseModel):
    name: str
    affiliation: Optional[str] = None
    orcid: Optional[str] = None


class PaperMetadata(BaseModel):
    title: str
    abstract: Optional[str] = None
    authors: List[PaperAuthor] = Field(default_factory=list)
    publication_year: Optional[int] = None
    venue: Optional[str] = None
    doi: Optional[str] = None
    arxiv_id: Optional[str] = None
    openalex_id: Optional[str] = None
    crossref_id: Optional[str] = None
    url: Optional[HttpUrl] = None
    pdf_url: Optional[HttpUrl] = None
    source: str

    def canonical_id(self) -> str:
        return canonical_paper_id(
            doi=self.doi,
            arxiv_id=self.arxiv_id,
            fallback=self.openalex_id or self.crossref_id or self.title,
        )


class PaperRecord(BaseModel):
    metadata: PaperMetadata
    raw_text: Optional[str] = None
    source_payload: Optional[Dict] = None


class PaperIdentifier(BaseModel):
    doi: Optional[str] = None
    arxiv_id: Optional[str] = None
    openalex_id: Optional[str] = None


def canonical_paper_id(doi: Optional[str], arxiv_id: Optional[str], fallback: str) -> str:
    normalized_doi = normalize_doi(doi)
    if normalized_doi:
        return f"doi:{normalized_doi}"

    normalized_arxiv = normalize_arxiv_id(arxiv_id)
    if normalized_arxiv:
        return f"arxiv:{normalized_arxiv}"

    digest = hashlib.sha1(fallback.encode("utf-8")).hexdigest()
    return f"hash:{digest}"


def normalize_doi(doi: Optional[str]) -> Optional[str]:
    if not doi:
        return None
    cleaned = doi.strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if cleaned.startswith(prefix):
            cleaned = cleaned[len(prefix) :]
    return cleaned or None


def normalize_arxiv_id(arxiv_id: Optional[str]) -> Optional[str]:
    if not arxiv_id:
        return None
    cleaned = arxiv_id.strip().lower()
    if cleaned.startswith("arxiv:"):
        cleaned = cleaned[len("arxiv:") :]
    if "abs/" in cleaned:
        cleaned = cleaned.split("abs/", 1)[-1]
    return cleaned.split("v", 1)[0] or None
