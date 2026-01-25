from __future__ import annotations

import re
from typing import Dict, List, Optional

from paperatlas.concepts.extraction.llm_extractor import LLMClient


class ConceptSummarizer:
    def __init__(self, llm_client: Optional[LLMClient] = None) -> None:
        self.llm_client = llm_client

    def summarize(
        self,
        concept_text: str,
        concept_name: Optional[str] = None,
    ) -> Dict:
        if self.llm_client:
            prompt = self._build_prompt(concept_text, concept_name)
            response = self.llm_client.generate(self._system_prompt(), prompt)
            parsed = self._parse_response(response)
            if parsed:
                return parsed
        return self._heuristic_summary(concept_text, concept_name)

    @staticmethod
    def _system_prompt() -> str:
        return (
            "You are a technical writer. Summarize the concept in a paragraph "
            "and 3-5 bullets."
        )

    @staticmethod
    def _build_prompt(concept_text: str, concept_name: Optional[str]) -> str:
        title = f"Concept: {concept_name}\n\n" if concept_name else ""
        return (
            f"{title}Source text:\n{concept_text}\n\n"
            "Return JSON with keys: paragraph, bullets."
        )

    @staticmethod
    def _parse_response(response: str) -> Optional[Dict]:
        match = re.search(r"\{.*\}", response, flags=re.DOTALL)
        if not match:
            return None
        try:
            import json

            data = json.loads(match.group(0))
        except Exception:
            return None
        paragraph = data.get("paragraph")
        bullets = data.get("bullets")
        if not paragraph or not isinstance(bullets, list):
            return None
        bullets = [
            str(bullet).strip()
            for bullet in bullets
            if str(bullet).strip()
        ]
        if len(bullets) < 3:
            return None
        return {"paragraph": paragraph.strip(), "bullets": bullets[:5]}

    @staticmethod
    def _heuristic_summary(
        concept_text: str,
        concept_name: Optional[str],
    ) -> Dict:
        sentences = re.split(r"(?<=[.!?])\s+", concept_text.strip())
        sentences = [sentence.strip() for sentence in sentences if sentence.strip()]
        if not sentences and concept_name:
            sentences = [
                f"{concept_name} is a key concept discussed in this paper."
            ]
        paragraph = " ".join(sentences[:3]).strip()
        bullets = _select_bullets(sentences, concept_name)
        return {"paragraph": paragraph, "bullets": bullets}


def _select_bullets(sentences: List[str], concept_name: Optional[str]) -> List[str]:
    candidates = sentences[3:10]
    if len(candidates) < 3:
        candidates = sentences[:5]
    bullets = [sentence for sentence in candidates if len(sentence) > 25]
    if len(bullets) < 3:
        fallback = concept_name or "This concept"
        bullets.extend(
            [
                f"{fallback} introduces a clear technical framing.",
                f"{fallback} highlights practical relevance for researchers.",
                f"{fallback} differentiates itself from prior work.",
            ]
        )
    return bullets[:5]
