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
            "You are a technical writer crafting LinkedIn-style micro posts. "
            "Write in a clear, professional tone with no emojis."
        )

    @staticmethod
    def _build_prompt(concept_text: str, concept_name: Optional[str]) -> str:
        title = f"Concept: {concept_name}\n\n" if concept_name else ""
        return (
            f"{title}Source text:\n{concept_text}\n\n"
            "Output plain text with this exact structure:\n"
            "1) A single-sentence hook question (end with '?').\n"
            "2) A short paragraph (2-4 sentences) answering the hook.\n"
            "3) A line that says: Why this matters:\n"
            "4) 3-5 bullet lines, each starting with '- '.\n"
            "5) A one-sentence CTA to explore the paper or concept.\n"
            "Do not output JSON or extra labels."
        )

    @staticmethod
    def _parse_response(response: str) -> Optional[Dict]:
        lines = [
            line.strip()
            for line in response.splitlines()
            if line.strip()
        ]
        if not lines:
            return None
        bullets = [
            line.lstrip("-•").strip()
            for line in lines
            if line.startswith(("-", "•"))
        ]
        if len(bullets) < 3:
            return None
        non_bullets = [
            line for line in lines if not line.startswith(("-", "•"))
        ]
        if not non_bullets:
            return None
        paragraph = "\n\n".join(non_bullets).strip()
        return {"paragraph": paragraph, "bullets": bullets[:5]}

    @staticmethod
    def _heuristic_summary(
        concept_text: str,
        concept_name: Optional[str],
    ) -> Dict:
        sentences = re.split(r"(?<=[.!?])\s+", concept_text.strip())
        sentences = [
            sentence.strip()
            for sentence in sentences
            if sentence.strip()
        ]
        if not sentences and concept_name:
            sentences = [
                f"{concept_name} is a key concept discussed in this paper."
            ]
        paragraph = " ".join(sentences[:3]).strip()
        question = (
            f"How does {concept_name} work?"
            if concept_name
            else "Why does this concept matter?"
        )
        cta = (
            f"If you're exploring {concept_name}, this is worth a closer look."
            if concept_name
            else "If you're exploring this area, it's worth a closer look."
        )
        paragraph = "\n\n".join(
            [question, paragraph, "Why this matters:", cta]
        )
        bullets = _select_bullets(sentences, concept_name)
        return {"paragraph": paragraph, "bullets": bullets}


def _select_bullets(
    sentences: List[str],
    concept_name: Optional[str],
) -> List[str]:
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
