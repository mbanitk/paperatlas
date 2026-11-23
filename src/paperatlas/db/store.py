"""PostgreSQL-backed paper / concept / claim store (replaces the old MySQL store)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Iterable, Optional, Sequence

from sqlalchemy import delete, func, or_, select, update

from paperatlas.concepts.extraction.models import PaperMetadata, PaperRecord
from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Claim, Concept, Paper

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


def paper_row(paper: Paper) -> dict[str, Any]:
    return {field: getattr(paper, field) for field in PAPER_ROW_FIELDS}


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
        """Insert new papers or merge new metadata into existing rows. Returns paper ids."""
        raw_texts = raw_texts or {}
        ids: list[str] = []
        with session_scope(self.url) as session:
            for metadata in items:
                paper_id = metadata.canonical_id()
                data = metadata.model_dump(mode="json")
                paper = session.get(Paper, paper_id)
                if paper is None:
                    paper = Paper(
                        paper_id=paper_id,
                        title=clean_text(metadata.title),
                        doc_type=metadata.doc_type,
                        source=metadata.source,
                        sources=[metadata.source],
                        authors=data.get("authors") or [],
                        source_payload=source_payload,
                    )
                    session.add(paper)
                elif metadata.source not in (paper.sources or []):
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
                raw_text = clean_text(raw_texts.get(paper_id))
                if raw_text:
                    paper.raw_text = raw_text
                    paper.text_fetched_at = _now()
                paper.updated_at = _now()
                session.flush()
                ids.append(paper_id)
        return ids

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

    def reset_distillation(self, paper_ids: Optional[Iterable[str]] = None) -> None:
        with session_scope(self.url) as session:
            statement = update(Paper).values(distilled_at=None)
            if paper_ids is not None:
                statement = statement.where(Paper.paper_id.in_(list(paper_ids)))
            session.execute(statement)

    def save_distillation(
        self,
        paper_id: str,
        concepts: Sequence[dict[str, Any]],
    ) -> list[int]:
        """Replace a paper's concepts + claims. Each concept dict carries a `claim` dict.

        Returns the new claim ids.
        """
        claim_ids: list[int] = []
        with session_scope(self.url) as session:
            session.execute(delete(Concept).where(Concept.paper_id == paper_id))
            for concept_data in concepts:
                concept = Concept(
                    paper_id=paper_id,
                    concept_key=concept_data["concept_key"],
                    name=concept_data["name"],
                    kind=concept_data.get("kind"),
                    summary=concept_data.get("summary"),
                    key_points=concept_data.get("key_points") or [],
                    source=concept_data.get("source", "llm"),
                )
                session.add(concept)
                session.flush()
                claim_data = concept_data.get("claim")
                if claim_data:
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
