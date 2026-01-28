from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from .models import PaperRecord


class JsonPaperStore:
    def __init__(self, base_dir: str | Path = "data/papers") -> None:
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def save(self, record: PaperRecord) -> Path:
        paper_id = record.metadata.canonical_id()
        safe_id = _safe_filename(paper_id)
        payload = {
            "paper_id": paper_id,
            "metadata": record.metadata.model_dump(mode="json"),
            "raw_text": record.raw_text,
            "source_payload": record.source_payload,
        }
        path = self.base_dir / f"{safe_id}.json"
        with path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=True, indent=2)
        return path

    def load(self, paper_id: str) -> Optional[dict]:
        path = self.base_dir / f"{_safe_filename(paper_id)}.json"
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)


class MySQLPaperStore:
    def __init__(self, config: dict) -> None:
        self._config = config
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        conn = self._connect()
        try:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS papers (
                        paper_id VARCHAR(255) PRIMARY KEY,
                        title TEXT,
                        abstract LONGTEXT,
                        venue VARCHAR(255),
                        source VARCHAR(50),
                        doi VARCHAR(255),
                        arxiv_id VARCHAR(255),
                        openalex_id VARCHAR(255),
                        crossref_id VARCHAR(255),
                        url TEXT,
                        pdf_url TEXT,
                        publication_year INT,
                        authors JSON,
                        raw_text LONGTEXT,
                        source_payload JSON
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS paper_concepts (
                        paper_id VARCHAR(255) NOT NULL,
                        concept_id VARCHAR(64) NOT NULL,
                        concept_name TEXT,
                        summary LONGTEXT,
                        source VARCHAR(50),
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (paper_id, concept_id)
                    )
                    """
                )
                cursor.execute("SELECT DATABASE()")
                database = cursor.fetchone()[0]
                cursor.execute(
                    """
                    SELECT COLUMN_NAME
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'papers'
                    """,
                    (database,),
                )
                existing_columns = {row[0] for row in cursor.fetchall()}
                for column, column_type in _column_definitions().items():
                    if column in existing_columns:
                        continue
                    cursor.execute(
                        f"ALTER TABLE papers ADD COLUMN {column} {column_type}"
                    )
                conn.commit()
            finally:
                cursor.close()
        finally:
            conn.close()

    def save(self, record: PaperRecord) -> None:
        paper_id = record.metadata.canonical_id()
        metadata = record.metadata.model_dump(mode="json")
        conn = self._connect()
        try:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    """
                    INSERT INTO papers (
                        paper_id,
                        title,
                        abstract,
                        venue,
                        source,
                        doi,
                        arxiv_id,
                        openalex_id,
                        crossref_id,
                        url,
                        pdf_url,
                        publication_year,
                        authors,
                        raw_text,
                        source_payload
                    )
                    VALUES (
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s
                    )
                    ON DUPLICATE KEY UPDATE
                        title = VALUES(title),
                        abstract = VALUES(abstract),
                        venue = VALUES(venue),
                        source = VALUES(source),
                        doi = VALUES(doi),
                        arxiv_id = VALUES(arxiv_id),
                        openalex_id = VALUES(openalex_id),
                        crossref_id = VALUES(crossref_id),
                        url = VALUES(url),
                        pdf_url = VALUES(pdf_url),
                        publication_year = VALUES(publication_year),
                        authors = VALUES(authors),
                        raw_text = VALUES(raw_text),
                        source_payload = VALUES(source_payload)
                    """,
                    (
                        paper_id,
                        metadata.get("title"),
                        metadata.get("abstract"),
                        metadata.get("venue"),
                        metadata.get("source"),
                        metadata.get("doi"),
                        metadata.get("arxiv_id"),
                        metadata.get("openalex_id"),
                        metadata.get("crossref_id"),
                        metadata.get("url"),
                        metadata.get("pdf_url"),
                        metadata.get("publication_year"),
                        json.dumps(
                            metadata.get("authors") or [],
                            ensure_ascii=True,
                        ),
                        record.raw_text,
                        json.dumps(
                            record.source_payload,
                            ensure_ascii=True,
                        )
                        if record.source_payload
                        else None,
                    ),
                )
            finally:
                cursor.close()
            conn.commit()
        finally:
            conn.close()

    def fetch_papers(
        self,
        limit: int = 100,
        offset: int = 0,
        require_raw_text: bool = True,
    ) -> list[dict]:
        conn = self._connect()
        try:
            cursor = conn.cursor(dictionary=True)
            try:
                if require_raw_text:
                    condition = "WHERE raw_text IS NOT NULL AND raw_text != ''"
                else:
                    condition = ""
                query = f"""
                    SELECT
                        paper_id,
                        title,
                        abstract,
                        venue,
                        source,
                        doi,
                        arxiv_id,
                        openalex_id,
                        crossref_id,
                        url,
                        pdf_url,
                        publication_year,
                        authors,
                        raw_text,
                        source_payload
                    FROM papers
                    {condition}
                    ORDER BY paper_id
                    LIMIT %s OFFSET %s
                """
                cursor.execute(query, (limit, offset))
                rows = cursor.fetchall()
            finally:
                cursor.close()
        finally:
            conn.close()
        for row in rows:
            if row.get("authors"):
                try:
                    row["authors"] = json.loads(row["authors"])
                except Exception:
                    row["authors"] = []
            if row.get("source_payload"):
                try:
                    row["source_payload"] = json.loads(row["source_payload"])
                except Exception:
                    row["source_payload"] = None
        return rows

    def count_unprocessed_papers(self, require_raw_text: bool = True) -> int:
        """Count papers that haven't been processed yet (not in paper_concepts table)."""
        conn = self._connect()
        try:
            cursor = conn.cursor()
            try:
                text_condition = (
                    "AND p.raw_text IS NOT NULL AND p.raw_text != ''"
                    if require_raw_text
                    else ""
                )
                query = f"""
                    SELECT COUNT(*) as count
                    FROM papers p
                    LEFT JOIN paper_concepts pc ON p.paper_id = pc.paper_id
                    WHERE pc.paper_id IS NULL
                    {text_condition}
                """
                cursor.execute(query)
                result = cursor.fetchone()
                return result[0] if result else 0
            finally:
                cursor.close()
        finally:
            conn.close()

    def fetch_unprocessed_papers(
        self,
        limit: int = 100,
        offset: int = 0,
        require_raw_text: bool = True,
    ) -> list[dict]:
        """Fetch papers that haven't been processed yet (not in paper_concepts table)."""
        conn = self._connect()
        try:
            cursor = conn.cursor(dictionary=True)
            try:
                text_condition = (
                    "AND p.raw_text IS NOT NULL AND p.raw_text != ''"
                    if require_raw_text
                    else ""
                )
                query = f"""
                    SELECT
                        p.paper_id,
                        p.title,
                        p.abstract,
                        p.venue,
                        p.source,
                        p.doi,
                        p.arxiv_id,
                        p.openalex_id,
                        p.crossref_id,
                        p.url,
                        p.pdf_url,
                        p.publication_year,
                        p.authors,
                        p.raw_text,
                        p.source_payload
                    FROM papers p
                    LEFT JOIN paper_concepts pc ON p.paper_id = pc.paper_id
                    WHERE pc.paper_id IS NULL
                    {text_condition}
                    ORDER BY p.paper_id
                    LIMIT %s OFFSET %s
                """
                cursor.execute(query, (limit, offset))
                rows = cursor.fetchall()
            finally:
                cursor.close()
        finally:
            conn.close()
        for row in rows:
            if row.get("authors"):
                try:
                    row["authors"] = json.loads(row["authors"])
                except Exception:
                    row["authors"] = []
            if row.get("source_payload"):
                try:
                    row["source_payload"] = json.loads(row["source_payload"])
                except Exception:
                    row["source_payload"] = None
        return rows

    def fetch_paper_by_id(self, paper_id: str) -> Optional[dict]:
        conn = self._connect()
        try:
            cursor = conn.cursor(dictionary=True)
            try:
                cursor.execute(
                    """
                    SELECT
                        paper_id,
                        title,
                        abstract,
                        venue,
                        source,
                        doi,
                        arxiv_id,
                        openalex_id,
                        crossref_id,
                        url,
                        pdf_url,
                        publication_year,
                        authors,
                        raw_text,
                        source_payload
                    FROM papers
                    WHERE paper_id = %s
                    LIMIT 1
                    """,
                    (paper_id,),
                )
                row = cursor.fetchone()
            finally:
                cursor.close()
        finally:
            conn.close()
        if not row:
            return None
        if row.get("authors"):
            try:
                row["authors"] = json.loads(row["authors"])
            except Exception:
                row["authors"] = []
        if row.get("source_payload"):
            try:
                row["source_payload"] = json.loads(row["source_payload"])
            except Exception:
                row["source_payload"] = None
        return row

    def save_concepts(self, records: list[dict]) -> None:
        if not records:
            return
        conn = self._connect()
        try:
            cursor = conn.cursor()
            try:
                cursor.executemany(
                    """
                    INSERT INTO paper_concepts (
                        paper_id,
                        concept_id,
                        concept_name,
                        summary,
                        source
                    )
                    VALUES (%s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                        concept_name = VALUES(concept_name),
                        summary = VALUES(summary),
                        source = VALUES(source)
                    """,
                    [
                        (
                            record["paper_id"],
                            record["concept_id"],
                            record["name"],
                            record["summary"],
                            record["source"],
                        )
                        for record in records
                    ],
                )
            finally:
                cursor.close()
            conn.commit()
        finally:
            conn.close()

    def _connect(self):
        try:
            import mysql.connector  # type: ignore
        except Exception as exc:  # pragma: no cover - optional dependency
            raise RuntimeError(
                "mysql-connector-python is required for MySQL storage. "
                "Install it with `pip install mysql-connector-python`."
            ) from exc
        return mysql.connector.connect(**self._config)


def _safe_filename(identifier: str) -> str:
    return identifier.replace("/", "_").replace(":", "_")


def _column_definitions() -> dict[str, str]:
    return {
        "title": "TEXT",
        "abstract": "LONGTEXT",
        "venue": "VARCHAR(255)",
        "source": "VARCHAR(50)",
        "doi": "VARCHAR(255)",
        "arxiv_id": "VARCHAR(255)",
        "openalex_id": "VARCHAR(255)",
        "crossref_id": "VARCHAR(255)",
        "url": "TEXT",
        "pdf_url": "TEXT",
        "publication_year": "INT",
        "authors": "JSON",
        "raw_text": "LONGTEXT",
        "source_payload": "JSON",
    }
