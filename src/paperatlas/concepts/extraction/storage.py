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


def _safe_filename(identifier: str) -> str:
    return identifier.replace("/", "_").replace(":", "_")
