from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional

import httpx

from .config import DEFAULT_LLM_API_KEY, DEFAULT_LLM_MODEL

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a world-class research scientist,
technical communicator,
and LinkedIn content strategist and content creator. Your task is to deeply read and analyze
the following research paper and generate a separate, high-impact LinkedIn
post for each distinct concept introduced, proposed, analyzed, or discussed
in the paper.

Your goal is to:
- Extract every meaningful concept from the paper.
- Turn each concept into a standalone LinkedIn post that attracts attention,
  builds curiosity, and motivates readers to explore the paper.
- Present each concept in a way that makes it feel useful, novel, and
  practically valuable to professionals, engineers, and researchers.
- Treat this as a knowledge distillation + attention design task: your job
  is to turn research into insight that makes people want to click, read,
  and learn.

What counts as a concept:
- New models, algorithms, methods, frameworks, or architectures
- Theoretical ideas, principles, assumptions, or hypotheses
- Problem formulations or task definitions
- Training techniques, optimization strategies, or evaluation methods
- Key empirical findings or insights
- Novel metrics, benchmarks, datasets, or protocols
- Important limitations, trade-offs, or failure modes
- Core contributions claimed by the authors

Output Requirements:
- One concept per LinkedIn post.
- Start with a strong hook, such as a question.
  Examples: 
  What if every token could directly "look at" every other token — instantly?
  What if a model could attend to different aspects of a sentence — at the same time?
  Something like this... which starts with a question and then explains the concept.
- Clearly name the concept.
- Explain what it is in simple, compelling language.
- Explain why it matters in real-world or research terms.
- Highlight how it improves on or differs from prior work.
- End with a call to action encouraging readers to explore the paper.
- Use professional, clear, conversational tone — no fluff, emojis, or
  marketing clichés.
- Each post: 120 to 200 words and must stand alone.

Output Structure:

Concept 1: [Concept Name]
[LinkedIn post]

Concept 2: [Concept Name]
[LinkedIn post]

(Continue for all concepts.)

EXAMPLES:

Concept 2: Self-Attention Mechanism
What if every token could directly “look at” every other token — instantly?

That’s the core idea of self-attention. Instead of passing information
step-by-step through time (like RNNs), self-attention lets each token weigh
the relevance of all other tokens in the sequence.

Why it matters:
- Long-range dependencies become easy to model.
- There’s no information bottleneck from sequential processing.
- Representations become more expressive and context-aware.

This concept alone is one of the most important breakthroughs in modern NLP.

If you want to understand why today’s LLMs work so well, this is the concept
to start with.

---

Concept 4: Multi-Head Attention
What if a model could attend to different aspects of a sentence — at the
same time?

That’s exactly what multi-head attention does. Instead of using one attention
mechanism, the Transformer uses multiple attention heads in parallel, each
focusing on different representation subspaces.

Why this is powerful:
- One head might focus on syntax.
- Another on semantics.
- Another on long-range dependencies.

Together, they create richer, more expressive representations than a single
attention head ever could.

This idea is fundamental to modern LLMs — and understanding it changes how
you think about representation learning.

---

Concept 6: Positional Encoding
Attention doesn’t know order — so how does the Transformer understand
sequence structure?

The answer is positional encoding. Since the model has no recurrence or
convolution, it injects position information directly into token embeddings
using sinusoidal functions.

Why this matters:
- Preserves word order.
- Enables reasoning about relative positions.
- Allows generalization to longer sequences than seen in training.

This clever design keeps the model simple — yet sequence-aware.

If you’ve ever wondered how Transformers handle order without time steps,
this is the key.

---

Paper Text:
[Paste paper title + abstract + raw_text here]
"""


@dataclass
class LLMConfig:
    api_key: str
    model: str
    base_url: str = "https://api.openai.com/v1"
    timeout: float = 60.0


class LLMClient:
    def __init__(self, config: LLMConfig) -> None:
        self._config = config

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        headers = {
            "Authorization": f"Bearer {self._config.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self._config.model,
            "input": [
                {
                    "role": "system",
                    "content": [
                        {"type": "input_text", "text": system_prompt},
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": user_prompt},
                    ],
                },
            ],
            "temperature": 0.3,
        }
        response = httpx.post(
            f"{self._config.base_url}/responses",
            headers=headers,
            json=payload,
            timeout=self._config.timeout,
        )
        if response.status_code >= 400:
            logger.error(
                "OpenAI error %s: %s",
                response.status_code,
                response.text,
            )
            response.raise_for_status()
        data = response.json()

        output_blocks = data.get("output", [])
        for block in output_blocks:
            for item in block.get("content", []):
                if item.get("type") == "output_text":
                    return item.get("text", "")
        raise RuntimeError("No text output found in response.")


class LLMCache:
    def __init__(self, cache_dir: str | Path = "data/llm_cache") -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def get(self, cache_key: str) -> Optional[dict]:
        path = self.cache_dir / f"{cache_key}.json"
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)

    def set(self, cache_key: str, payload: dict) -> None:
        path = self.cache_dir / f"{cache_key}.json"
        with path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=True, indent=2)


class LLMConceptExtractor:
    def __init__(
        self,
        client: Optional[LLMClient] = None,
        cache: Optional[LLMCache] = None,
        offline: bool = False,
    ) -> None:
        self.client = client
        self.cache = cache or LLMCache()
        self.offline = offline

    @staticmethod
    def make_cache_key(paper_id: str, prompt: str) -> str:
        digest = hashlib.sha1(prompt.encode("utf-8")).hexdigest()[:12]
        safe_id = re.sub(r"[^a-zA-Z0-9_-]+", "_", paper_id)
        return f"{safe_id}_{digest}"

    def extract(
        self,
        paper_id: str,
        title: str,
        abstract: Optional[str],
        raw_text: Optional[str],
    ) -> List[Dict]:
        prompt = self._build_prompt(title, abstract, raw_text)
        cache_key = self.make_cache_key(paper_id, prompt)
        cached = self.cache.get(cache_key)
        if cached:
            return cached.get("concepts", [])
        if self.offline:
            logger.info("Skipping LLM call for %s (offline mode)", paper_id)
            return []
        if not self.client:
            raise RuntimeError("LLM client not configured for extraction.")
        response_text = self.client.generate(SYSTEM_PROMPT, prompt)
        concepts = self._parse_response(response_text)
        self.cache.set(
            cache_key,
            {
                "paper_id": paper_id,
                "prompt_hash": cache_key,
                "response_text": response_text,
                "concepts": concepts,
            },
        )
        return concepts

    def extract_many(
        self,
        rows: Iterable[dict],
    ) -> dict[str, List[Dict]]:
        results: dict[str, List[Dict]] = {}
        for row in rows:
            paper_id = row["paper_id"]
            concepts = self.extract(
                paper_id=paper_id,
                title=row.get("title") or "",
                abstract=row.get("abstract"),
                raw_text=row.get("raw_text"),
            )
            results[paper_id] = concepts
        return results

    @staticmethod
    def _build_prompt(
        title: str,
        abstract: Optional[str],
        raw_text: Optional[str],
        max_chars: int = 18000,
    ) -> str:
        chunks = [f"Title: {title}"]
        if abstract:
            chunks.append(f"Abstract: {abstract}")
        if raw_text:
            chunks.append(f"Full Text: {raw_text}")
        combined = "\n\n".join(chunks)
        if len(combined) > max_chars:
            combined = combined[:max_chars]
        return f"Paper Text:\n{combined}"

    @staticmethod
    def _parse_response(response_text: str) -> List[Dict]:
        concepts: List[Dict] = []
        pattern = re.compile(r"Concept\s*\d+\s*:\s*(.+)", re.IGNORECASE)
        matches = list(pattern.finditer(response_text))
        if not matches:
            return []
        for idx, match in enumerate(matches):
            start = match.end()
            if idx + 1 < len(matches):
                end = matches[idx + 1].start()
            else:
                end = len(response_text)
            name = match.group(1).strip()
            post = response_text[start:end].strip()
            if not name:
                continue
            concepts.append(
                {
                    "name": name,
                    "post": post,
                    "source": "llm",
                }
            )
        return concepts


def build_default_llm_client() -> Optional[LLMClient]:
    api_key = (
        os.getenv("PAPERATLAS_LLM_API_KEY")
        or os.getenv("OPENAI_API_KEY")
        or DEFAULT_LLM_API_KEY
    )
    if not api_key:
        return None
    model = os.getenv("PAPERATLAS_LLM_MODEL", DEFAULT_LLM_MODEL)
    base_url = os.getenv(
        "PAPERATLAS_LLM_BASE_URL",
        "https://api.openai.com/v1",
    )
    timeout = float(os.getenv("PAPERATLAS_LLM_TIMEOUT", "60"))
    return LLMClient(
        LLMConfig(
            api_key=api_key,
            model=model,
            base_url=base_url,
            timeout=timeout,
        )
    )
