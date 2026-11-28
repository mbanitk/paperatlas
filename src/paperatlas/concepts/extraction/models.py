from __future__ import annotations

import hashlib
import re
from datetime import date
from typing import Dict, List, Optional
from urllib.parse import urlparse

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
    publication_date: Optional[date] = None
    venue: Optional[str] = None
    doc_type: str = "paper"
    doi: Optional[str] = None
    arxiv_id: Optional[str] = None
    openalex_id: Optional[str] = None
    crossref_id: Optional[str] = None
    s2_id: Optional[str] = None
    patent_number: Optional[str] = None
    url: Optional[HttpUrl] = None
    pdf_url: Optional[HttpUrl] = None
    code_url: Optional[str] = None
    citation_count: Optional[int] = None
    influential_citation_count: Optional[int] = None
    hf_upvotes: Optional[int] = None
    keywords: List[str] = Field(default_factory=list)
    source: str
    # Stable id for documents without a DOI / arXiv id (e.g. "github:owner/repo/pull/123"); used as the paper id.
    doc_id: Optional[str] = None

    def canonical_id(self) -> str:
        if self.doc_id:
            return self.doc_id
        if self.patent_number:
            return f"patent:{self.patent_number.strip().upper()}"
        return canonical_paper_id(
            doi=self.doi,
            arxiv_id=self.arxiv_id,
            fallback=self.openalex_id or self.s2_id or self.crossref_id or self.title,
        )


class PaperRecord(BaseModel):
    metadata: PaperMetadata
    raw_text: Optional[str] = None
    source_payload: Optional[Dict] = None


class PaperIdentifier(BaseModel):
    doi: Optional[str] = None
    arxiv_id: Optional[str] = None
    openalex_id: Optional[str] = None


def normalize_url(url: str) -> str:
    """Scheme-less, lower-case host, no query/fragment/trailing slash: one id per web page."""
    parsed = urlparse(url.strip())
    return f"{parsed.netloc.lower().removeprefix('www.')}{parsed.path.rstrip('/')}"


def blog_post_id(url: str) -> str:
    return f"blog:{hashlib.sha1(normalize_url(url).encode('utf-8')).hexdigest()}"


def canonical_paper_id(doi: Optional[str], arxiv_id: Optional[str], fallback: str) -> str:
    normalized_doi = normalize_doi(doi)
    normalized_arxiv = normalize_arxiv_id(arxiv_id) or arxiv_id_from_doi(normalized_doi)
    if normalized_arxiv:
        return f"arxiv:{normalized_arxiv}"
    if normalized_doi:
        return f"doi:{normalized_doi}"

    digest = hashlib.sha1(fallback.encode("utf-8")).hexdigest()
    return f"hash:{digest}"


def canonical_concept_id(name: str) -> str:
    normalized = " ".join(name.lower().strip().split())
    digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:12]
    return f"concept:{digest}"


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
    for marker in ("abs/", "pdf/"):
        if marker in cleaned:
            cleaned = cleaned.split(marker, 1)[-1]
    cleaned = cleaned.removesuffix(".pdf")
    return re.sub(r"v\d+$", "", cleaned) or None


def arxiv_id_from_doi(doi: Optional[str]) -> Optional[str]:
    if doi and doi.startswith("10.48550/arxiv."):
        return normalize_arxiv_id(doi[len("10.48550/arxiv.") :])
    return None
