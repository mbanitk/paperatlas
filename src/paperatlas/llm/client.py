"""Small OpenAI Responses API client: text + strict JSON-schema output, retries, disk cache."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import httpx

from paperatlas import settings

logger = logging.getLogger(__name__)

_RETRY_STATUS = {408, 409, 429, 500, 502, 503, 504}


class LLMError(RuntimeError):
    pass


@dataclass
class LLMConfig:
    api_key: str
    model: str = settings.DEFAULT_LLM_MODEL
    base_url: str = settings.DEFAULT_LLM_BASE_URL
    timeout: float = 300.0
    temperature: Optional[float] = 0.2
    max_retries: int = 3


class LLMCache:
    def __init__(self, cache_dir: str | Path | None = None) -> None:
        self.cache_dir = Path(cache_dir) if cache_dir else settings.data_dir() / "llm_cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def key(*parts: Any) -> str:
        blob = json.dumps(parts, sort_keys=True, ensure_ascii=True, default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]

    def get(self, key: str) -> Optional[Any]:
        path = self.cache_dir / f"{key}.json"
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8")).get("value")

    def set(self, key: str, value: Any, meta: Optional[dict] = None) -> None:
        path = self.cache_dir / f"{key}.json"
        path.write_text(
            json.dumps({"meta": meta or {}, "value": value}, ensure_ascii=True, indent=2),
            encoding="utf-8",
        )


class LLMClient:
    def __init__(self, config: LLMConfig, cache: Optional[LLMCache] = None) -> None:
        self.config = config
        self.cache = cache

    @property
    def model(self) -> str:
        return self.config.model

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        return self._cached(system_prompt, user_prompt, None)

    def generate_json(
        self,
        system_prompt: str,
        user_prompt: str,
        schema_name: str,
        schema: dict,
    ) -> dict:
        text_output = self._cached(system_prompt, user_prompt, (schema_name, schema))
        try:
            return json.loads(text_output)
        except json.JSONDecodeError as exc:
            raise LLMError(f"Model returned invalid JSON for {schema_name}: {exc}") from exc

    def _cached(self, system_prompt: str, user_prompt: str, schema: Optional[tuple]) -> str:
        key = None
        if self.cache:
            key = LLMCache.key(self.config.model, system_prompt, user_prompt, schema)
            cached = self.cache.get(key)
            if cached is not None:
                logger.debug("LLM cache hit %s", key)
                return cached
        output = self._call(system_prompt, user_prompt, schema)
        if self.cache and key:
            self.cache.set(key, output, {"model": self.config.model, "schema": schema and schema[0]})
        return output

    def _payload(self, system_prompt: str, user_prompt: str, schema: Optional[tuple]) -> dict:
        payload: dict[str, Any] = {
            "model": self.config.model,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": system_prompt}]},
                {"role": "user", "content": [{"type": "input_text", "text": user_prompt}]},
            ],
        }
        if self.config.temperature is not None:
            payload["temperature"] = self.config.temperature
        if schema:
            name, json_schema = schema
            payload["text"] = {
                "format": {"type": "json_schema", "name": name, "schema": json_schema, "strict": True}
            }
        return payload

    def _call(self, system_prompt: str, user_prompt: str, schema: Optional[tuple]) -> str:
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }
        payload = self._payload(system_prompt, user_prompt, schema)
        for attempt in range(1, self.config.max_retries + 1):
            started = time.monotonic()
            try:
                response = httpx.post(
                    f"{self.config.base_url}/responses",
                    headers=headers,
                    json=payload,
                    timeout=self.config.timeout,
                )
            except httpx.TransportError as exc:
                if attempt == self.config.max_retries:
                    raise LLMError(f"LLM request failed: {exc}") from exc
                time.sleep(2**attempt)
                continue
            if response.status_code == 400 and "temperature" in response.text and "temperature" in payload:
                payload.pop("temperature")
                continue
            if response.status_code in _RETRY_STATUS and attempt < self.config.max_retries:
                logger.warning("LLM %s, retrying (%d/%d)", response.status_code, attempt, self.config.max_retries)
                time.sleep(2**attempt)
                continue
            if response.status_code >= 400:
                raise LLMError(f"LLM error {response.status_code}: {response.text[:500]}")
            data = response.json()
            usage = data.get("usage") or {}
            logger.info(
                "LLM %s: %s in / %s out tokens, %.1fs",
                data.get("model", self.config.model),
                usage.get("input_tokens"),
                usage.get("output_tokens"),
                time.monotonic() - started,
            )
            logger.debug("LLM raw response: %s", data)
            return _output_text(data)
        raise LLMError("LLM request failed after retries")


def _output_text(data: dict) -> str:
    if data.get("status") == "incomplete":
        raise LLMError(f"LLM response incomplete: {data.get('incomplete_details')}")
    for block in data.get("output", []):
        for item in block.get("content") or []:
            if item.get("type") == "output_text":
                return item.get("text", "")
            if item.get("type") == "refusal":
                raise LLMError(f"LLM refused: {item.get('refusal')}")
    raise LLMError("No text output found in LLM response.")


def build_default_llm_client(use_cache: bool = True) -> Optional[LLMClient]:
    api_key = settings.llm_api_key()
    if not api_key:
        return None
    return LLMClient(
        LLMConfig(
            api_key=api_key,
            model=settings.llm_model(),
            base_url=settings.llm_base_url(),
            timeout=settings.llm_timeout(),
        ),
        cache=LLMCache() if use_cache else None,
    )
