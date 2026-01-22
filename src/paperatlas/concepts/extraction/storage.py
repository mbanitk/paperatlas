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
                        metadata JSON,
                        raw_text LONGTEXT,
                        source_payload JSON
                    )
                    """
                )
                conn.commit()
            finally:
                cursor.close()
        finally:
            conn.close()

    def save(self, record: PaperRecord) -> None:
        paper_id = record.metadata.canonical_id()
        conn = self._connect()
        try:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    """
                    INSERT INTO papers (
                        paper_id,
                        metadata,
                        raw_text,
                        source_payload
                    )
                    VALUES (%s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                        metadata = VALUES(metadata),
                        raw_text = VALUES(raw_text),
                        source_payload = VALUES(source_payload)
                    """,
                    (
                        paper_id,
                        json.dumps(
                            record.metadata.model_dump(mode="json"),
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
