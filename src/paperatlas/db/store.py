"""PostgreSQL-backed paper / concept / claim store (replaces the old MySQL store)."""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from typing import Any, Iterable, Optional, Sequence

from sqlalchemy import any_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from paperatlas.concepts.extraction.models import (
    PaperMetadata,
    PaperRecord,
    arxiv_id_from_doi,
    normalize_arxiv_id,
    normalize_doi,
)
from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Claim, Concept, Experiment, Paper

logger = logging.getLogger(__name__)

_MAX_FIELDS = ("citation_count", "influential_citation_count", "hf_upvotes")
_FILL_FIELDS = (
    "abstract",
    "venue",
    "doi",
    "arxiv_id",
    "openalex_id",
    "s2_id",
    "patent_number",
    "url",
    "pdf_url",
    "code_url",
    "publication_date",
    "publication_year",
)
PAPER_ROW_FIELDS = (
    "paper_id",
    "doc_type",
    "title",
    "abstract",
    "venue",
    "source",
    "sources",
    "url",
    "pdf_url",
    "code_url",
    "publication_date",
    "publication_year",
    "citation_count",
    "hf_upvotes",
    "raw_text",
    "distilled_at",
)


def _now() -> datetime:
    return datetime.now(UTC)


def clean_text(value: Optional[str]) -> Optional[str]:
    """PostgreSQL text cannot hold NUL bytes (some PDFs produce them)."""
    return value.replace("\x00", "") if value else value


_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def clean_json(value: Any) -> Any:
    """Recursively strip NUL/control characters (JSONB rejects NUL; others are model glitches)."""
    if isinstance(value, str):
        return _CONTROL.sub("", value)
    if isinstance(value, dict):
        return {key: clean_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [clean_json(item) for item in value]
    return value


def paper_row(paper: Paper) -> dict[str, Any]:
    return {field: getattr(paper, field) for field in PAPER_ROW_FIELDS}


def _find_alias(session: Session, metadata: PaperMetadata) -> Optional[Paper]:
    """An existing paper with the same DOI or arXiv id stored under another canonical id
    (e.g. `doi:…` from a DOI-only source, then `arxiv:…` once the arXiv id is known)."""
    if metadata.patent_number:
        return None
    doi = normalize_doi(metadata.doi)
    arxiv = normalize_arxiv_id(metadata.arxiv_id) or arxiv_id_from_doi(doi)
    conditions = []
    if doi:
        stored_doi = func.regexp_replace(
            func.lower(func.trim(Paper.doi)), "^(https?://(dx\\.)?doi\\.org/|doi:)", ""
        )
        conditions.append(stored_doi == doi)
    if arxiv:
        stored_arxiv = func.regexp_replace(
            func.lower(func.trim(Paper.arxiv_id)), "^arxiv:|v[0-9]+$", "", "g"
        )
        conditions += [stored_arxiv == arxiv, Paper.paper_id == f"arxiv:{arxiv}"]
    if doi:
        conditions.append(Paper.paper_id == f"doi:{doi}")
    if not conditions:
        return None
    return session.scalars(
        select(Paper)
        .where(or_(*conditions), Paper.doc_type == metadata.doc_type)
        .order_by(Paper.paper_id.like("arxiv:%").desc(), Paper.ingested_at)
        .limit(1)
        .with_for_update()
    ).first()


class PaperStore:
    def __init__(self, url: Optional[str] = None) -> None:
        self.url = url

    def save(self, record: PaperRecord) -> str:
        return self.upsert(record.metadata, record.raw_text, record.source_payload)

    def upsert(
        self,
        metadata: PaperMetadata,
        raw_text: Optional[str] = None,
        source_payload: Optional[dict] = None,
    ) -> str:
        return self.upsert_many(
            [metadata], {metadata.canonical_id(): raw_text}, source_payload
        )[0]

    def upsert_many(
        self,
        items: Sequence[PaperMetadata],
        raw_texts: Optional[dict[str, Optional[str]]] = None,
        source_payload: Optional[dict] = None,
    ) -> list[str]:
        """Insert new papers or merge new metadata into existing rows. Returns paper ids.

        Safe under concurrent writers: new rows go in with ON CONFLICT DO NOTHING and every
        row is then merged under a row lock. Papers already stored under another canonical
        id with the same DOI / arXiv id are merged into that row (its id is returned)."""
        raw_texts = raw_texts or {}
        ids: list[Optional[str]] = [None] * len(items)
        source_payload = clean_json(source_payload)
        # Lock rows in a stable order so concurrent batches cannot deadlock.
        order = sorted(range(len(items)), key=lambda index: items[index].canonical_id())
        with session_scope(self.url) as session:
            for index in order:
                metadata = items[index]
                canonical = metadata.canonical_id()
                data = clean_json(metadata.model_dump(mode="json"))
                paper = session.get(Paper, canonical, with_for_update=True)
                if paper is None:
                    paper = _find_alias(session, metadata)
                if paper is None:
                    session.execute(
                        pg_insert(Paper)
                        .values(
                            paper_id=canonical,
                            title=clean_text(metadata.title),
                            doc_type=metadata.doc_type,
                            source=metadata.source,
                            sources=[],
                            authors=data.get("authors") or [],
                            source_payload=source_payload,
                        )
                        .on_conflict_do_nothing(index_elements=[Paper.paper_id])
                    )
                    paper = session.get(
                        Paper, canonical, with_for_update=True, populate_existing=True
                    )
                paper_id = paper.paper_id
                if metadata.source not in (paper.sources or []):
                    paper.sources = [*(paper.sources or []), metadata.source]
                for field in _FILL_FIELDS:
                    value = getattr(metadata, field)
                    if isinstance(value, str):
                        value = clean_text(value)
                    if value is not None and getattr(paper, field) in (None, ""):
                        setattr(
                            paper, field, str(value) if field.endswith("url") else value
                        )
                for field in _MAX_FIELDS:
                    value = getattr(metadata, field)
                    if value is not None:
                        setattr(paper, field, max(value, getattr(paper, field) or 0))
                if not paper.authors and data.get("authors"):
                    paper.authors = data["authors"]
                raw_text = clean_text(raw_texts.get(canonical))
                if raw_text:
                    paper.raw_text = raw_text
                    paper.text_fetched_at = _now()
                paper.updated_at = _now()
                session.flush()
                ids[index] = paper_id
        return ids  # type: ignore[return-value]

    def get(self, paper_id: str) -> Optional[dict[str, Any]]:
        with session_scope(self.url) as session:
            paper = session.get(Paper, paper_id)
            return paper_row(paper) if paper else None

    def set_raw_text(self, paper_id: str, raw_text: str) -> None:
        with session_scope(self.url) as session:
            session.execute(
                update(Paper)
                .where(Paper.paper_id == paper_id)
                .values(
                    raw_text=clean_text(raw_text),
                    text_fetched_at=_now(),
                    updated_at=_now(),
                )
            )

    def papers_missing_embeddings(
        self, limit: int = 1000
    ) -> list[tuple[str, str, Optional[str]]]:
        with session_scope(self.url) as session:
            rows = session.execute(
                select(Paper.paper_id, Paper.title, Paper.abstract)
                .where(Paper.embedding.is_(None))
                .limit(limit)
            ).all()
        return [tuple(row) for row in rows]

    def set_paper_embeddings(self, embeddings: dict[str, Any]) -> None:
        with session_scope(self.url) as session:
            for paper_id, vector in embeddings.items():
                session.execute(
                    update(Paper)
                    .where(Paper.paper_id == paper_id)
                    .values(embedding=vector)
                )

    def _undistilled_filter(self, require_text: bool):
        conditions = [Paper.distilled_at.is_(None)]
        if require_text:
            conditions.append(
                or_(
                    func.length(func.coalesce(Paper.raw_text, "")) > 0,
                    func.length(func.coalesce(Paper.abstract, "")) > 200,
                )
            )
        return conditions

    def count_undistilled(self, require_text: bool = True) -> int:
        with session_scope(self.url) as session:
            return session.scalar(
                select(func.count())
                .select_from(Paper)
                .where(*self._undistilled_filter(require_text))
            )

    def fetch_undistilled(
        self, limit: int = 50, offset: int = 0, require_text: bool = True
    ) -> list[dict[str, Any]]:
        with session_scope(self.url) as session:
            papers = session.scalars(
                select(Paper)
                .where(*self._undistilled_filter(require_text))
                .order_by(Paper.raw_text.is_(None), Paper.ingested_at, Paper.paper_id)
                .limit(limit)
                .offset(offset)
            ).all()
            return [paper_row(paper) for paper in papers]

    def fetch_by_ids(self, paper_ids: Iterable[str]) -> list[dict[str, Any]]:
        ids = list(paper_ids)
        if not ids:
            return []
        with session_scope(self.url) as session:
            papers = session.scalars(select(Paper).where(Paper.paper_id.in_(ids))).all()
            return [paper_row(paper) for paper in papers]

    @staticmethod
    def _with_experiments(session: Session, paper_ids: Optional[Iterable[str]] = None) -> set[str]:
        query = (
            select(Claim.paper_id)
            .join(
                Experiment,
                or_(Experiment.claim_id == Claim.id, Claim.id == any_(Experiment.bundle_claim_ids)),
            )
            .distinct()
        )
        if paper_ids is not None:
            query = query.where(Claim.paper_id.in_(list(paper_ids)))
        return set(session.scalars(query).all())

    def papers_with_experiments(self, paper_ids: Optional[Iterable[str]] = None) -> set[str]:
        """Papers whose claims back lab experiments: their distillation must not be replaced
        (deleting the claims would cascade into experiments, runs, verdicts and jobs)."""
        with session_scope(self.url) as session:
            return self._with_experiments(session, paper_ids)

    def reset_distillation(self, paper_ids: Optional[Iterable[str]] = None) -> set[str]:
        """Mark papers for re-distillation, skipping (and returning) those with experiments."""
        with session_scope(self.url) as session:
            ids = list(paper_ids) if paper_ids is not None else None
            protected = self._with_experiments(session, ids)
            if protected:
                logger.warning(
                    "Not re-distilling %d paper(s) whose claims have lab experiments: %s",
                    len(protected),
                    ", ".join(sorted(protected)[:10]),
                )
            statement = update(Paper).values(distilled_at=None)
            if ids is not None:
                statement = statement.where(Paper.paper_id.in_(ids))
            if protected:
                statement = statement.where(Paper.paper_id.not_in(protected))
            session.execute(statement)
        return protected

    def save_distillation(
        self,
        paper_id: str,
        concepts: Sequence[dict[str, Any]],
    ) -> list[int]:
        """Replace a paper's concepts + claims. Each concept dict carries a `claim` dict.

        Returns the new claim ids. A paper whose claims back lab experiments keeps its
        existing distillation (nothing is deleted) and an empty list is returned.
        """
        claim_ids: list[int] = []
        with session_scope(self.url) as session:
            session.get(Paper, paper_id, with_for_update=True)
            if self._with_experiments(session, [paper_id]):
                logger.warning(
                    "Keeping the existing distillation of %s: its claims have lab experiments",
                    paper_id,
                )
                session.execute(
                    update(Paper)
                    .where(Paper.paper_id == paper_id, Paper.distilled_at.is_(None))
                    .values(distilled_at=_now())
                )
                return []
            session.execute(delete(Concept).where(Concept.paper_id == paper_id))
            for concept_data in concepts:
                concept = Concept(
                    paper_id=paper_id,
                    concept_key=concept_data["concept_key"],
                    name=clean_json(concept_data["name"]),
                    kind=clean_json(concept_data.get("kind")),
                    summary=clean_json(concept_data.get("summary")),
                    key_points=clean_json(concept_data.get("key_points") or []),
                    source=concept_data.get("source", "llm"),
                )
                session.add(concept)
                session.flush()
                claim_data = concept_data.get("claim")
                if claim_data:
                    claim_data = {
                        key: (item if key == "embedding" else clean_json(item)) for key, item in claim_data.items()
                    }
                    claim = Claim(
                        paper_id=paper_id, concept_id=concept.id, **claim_data
                    )
                    session.add(claim)
                    session.flush()
                    claim_ids.append(claim.id)
            session.execute(
                update(Paper)
                .where(Paper.paper_id == paper_id)
                .values(distilled_at=_now())
            )
        return claim_ids
