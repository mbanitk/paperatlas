from __future__ import annotations

import re
from typing import Dict, List, Optional


class HeuristicConceptExtractor:
    def __init__(self, max_concepts: int = 25) -> None:
        self.max_concepts = max_concepts

    def extract(
        self,
        title: str,
        abstract: Optional[str],
        raw_text: Optional[str],
    ) -> List[Dict]:
        candidates: List[Dict] = []
        sections = [section for section in [title, abstract, raw_text] if section]
        text = "\n".join(sections)
        if not text:
            return []

        candidates.extend(self._extract_named_methods(text))
        candidates.extend(self._extract_section_headers(raw_text or ""))
        candidates.extend(self._extract_title_phrases(title))

        unique = []
        seen = set()
        for candidate in candidates:
            normalized = candidate["name"].strip().lower()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            unique.append(candidate)
            if len(unique) >= self.max_concepts:
                break
        return unique

    @staticmethod
    def _extract_named_methods(text: str) -> List[Dict]:
        patterns = [
            r"we propose (?P<name>[A-Z][A-Za-z0-9\-\s]{3,80})",
            r"we introduce (?P<name>[A-Z][A-Za-z0-9\-\s]{3,80})",
            r"we present (?P<name>[A-Z][A-Za-z0-9\-\s]{3,80})",
            r"our method (?P<name>[A-Z][A-Za-z0-9\-\s]{3,80})",
            r"our model (?P<name>[A-Z][A-Za-z0-9\-\s]{3,80})",
            r"called (?P<name>[A-Z][A-Za-z0-9\-\s]{3,80})",
        ]
        candidates: List[Dict] = []
        for pattern in patterns:
            for match in re.finditer(pattern, text, flags=re.IGNORECASE):
                name = match.group("name").strip()
                name = re.split(r"[\.;:\n]", name)[0].strip()
                if len(name.split()) > 12:
                    continue
                candidates.append(
                    {
                        "name": name,
                        "source": "heuristic",
                        "evidence": match.group(0)[:200],
                    }
                )
        return candidates

    @staticmethod
    def _extract_section_headers(raw_text: str) -> List[Dict]:
        if not raw_text:
            return []
        candidates: List[Dict] = []
        for line in raw_text.splitlines():
            cleaned = line.strip()
            if not cleaned or len(cleaned) > 120:
                continue
            if re.match(r"^\d+(\.\d+)*\s+[A-Z].+", cleaned):
                name = re.sub(r"^\d+(\.\d+)*\s+", "", cleaned).strip()
                candidates.append(
                    {
                        "name": name,
                        "source": "heuristic",
                        "evidence": cleaned,
                    }
                )
                continue
            if cleaned.isupper() and len(cleaned.split()) <= 8:
                candidates.append(
                    {
                        "name": cleaned.title(),
                        "source": "heuristic",
                        "evidence": cleaned,
                    }
                )
        return candidates

    @staticmethod
    def _extract_title_phrases(title: str) -> List[Dict]:
        if not title:
            return []
        tokens = re.split(r"[:\-–]", title)
        phrases = [token.strip() for token in tokens if len(token.strip()) > 3]
        return [
            {"name": phrase, "source": "heuristic", "evidence": title}
            for phrase in phrases
        ]
