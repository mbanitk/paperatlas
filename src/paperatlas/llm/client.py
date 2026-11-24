"""Small OpenAI Responses API client: text + strict JSON-schema output, retries, Postgres cache."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import SQLAlchemyError

from paperatlas import settings
from paperatlas.db.engine import session_scope
from paperatlas.db.schema import LLMCacheEntry
from paperatlas.db.store import clean_text

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
    """LLM response cache in Postgres (`research.llm_cache`). Failures never block the LLM call."""

    def __init__(self, database_url: Optional[str] = None) -> None:
        self.database_url = database_url

    @staticmethod
    def key(*parts: Any) -> str:
        blob = json.dumps(parts, sort_keys=True, ensure_ascii=True, default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]

    def get(self, key: str) -> Optional[str]:
        try:
            with session_scope(self.database_url) as session:
                return session.scalar(select(LLMCacheEntry.value).where(LLMCacheEntry.key == key))
        except SQLAlchemyError as exc:
            logger.warning("LLM cache read failed: %s", exc)
            return None

    def set(self, key: str, value: str, model: str, schema_name: Optional[str] = None) -> None:
        row = {"key": key, "model": model, "schema_name": schema_name, "value": clean_text(value)}
        statement = insert(LLMCacheEntry).values(**row)
        statement = statement.on_conflict_do_update(
            index_elements=[LLMCacheEntry.key],
            set_={"model": row["model"], "schema_name": row["schema_name"], "value": row["value"]},
        )
        try:
            with session_scope(self.database_url) as session:
                session.execute(statement)
        except SQLAlchemyError as exc:
            logger.warning("LLM cache write failed: %s", exc)


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
            self.cache.set(key, output, self.config.model, schema[0] if schema else None)
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
        attempt = 0
        while attempt < self.config.max_retries:
            attempt += 1
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
                # Model rejects `temperature`: resend without it; this does not use a retry.
                payload.pop("temperature")
                attempt -= 1
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


class CopilotCliLLMClient(LLMClient):
    """Uses the GitHub Copilot CLI (tools disabled) as the LLM: for when no OpenAI key/credits are available.

    JSON output is requested by embedding the schema in the prompt and parsed from the reply; strict schema
    enforcement is not available, so callers keep validating the shape they receive."""

    def __init__(self, model: Optional[str] = None, timeout: float = 300.0, cache: Optional[LLMCache] = None) -> None:
        super().__init__(LLMConfig(api_key="", model=f"copilot-cli:{model or 'default'}", timeout=timeout), cache)
        self.cli_model = model

    def _call(self, system_prompt: str, user_prompt: str, schema: Optional[tuple]) -> str:
        import shutil
        import subprocess

        if not shutil.which("copilot"):
            raise LLMError("copilot CLI is not on PATH")
        prompt = f"{system_prompt}\n\n{user_prompt}{schema_instruction(schema)}"
        command = ["copilot", "-p", prompt, "--available-tools=", "--no-ask-user", "--no-color", "--no-auto-update",
                   "--no-custom-instructions", "-s"]
        if self.cli_model:
            command += ["--model", self.cli_model]
        last_error = "no output"
        for attempt in range(self.config.max_retries):
            try:
                done = subprocess.run(command, capture_output=True, text=True, timeout=self.config.timeout,
                                      cwd="/tmp", stdin=subprocess.DEVNULL)
            except subprocess.TimeoutExpired:
                last_error = f"timed out after {self.config.timeout:.0f}s"
                continue
            text = (done.stdout or "").strip()
            if done.returncode != 0 or not text:
                last_error = f"exit {done.returncode}: {(done.stderr or text)[-300:]}"
                time.sleep(2 * (attempt + 1))
                continue
            if not schema:
                return text
            try:
                return extract_json_object(text)
            except LLMError as exc:
                last_error = str(exc)
        raise LLMError(f"copilot CLI LLM failed: {last_error}")


THINK_BLOCK = re.compile(r"<think>.*?</think>", re.S)
DEFAULT_MLX_LLM_MODEL = "mlx-community/Qwen3.5-35B-A3B-4bit"
DEFAULT_MLX_LLM_URL = "http://127.0.0.1:8103/v1"


def extract_json_object(text: str) -> str:
    """The outermost JSON object in a model reply (tolerates prose, code fences and <think> blocks)."""
    text = THINK_BLOCK.sub("", text or "")
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise LLMError("reply contained no JSON object")
    candidate = text[start : end + 1]
    try:
        json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise LLMError(f"invalid JSON: {exc}") from exc
    return candidate


def schema_instruction(schema: Optional[tuple]) -> str:
    if not schema:
        return ""
    name, json_schema = schema
    return (
        f"\n\nReply with ONLY one JSON object named {name} that validates against this JSON schema "
        f"(every property required; no prose, no code fences):\n{json.dumps(json_schema)}"
    )


class MlxServerLLMClient(LLMClient):
    """A local model served by `mlx_lm.server` (Apple MLX, OpenAI-compatible chat completions).

    The server shares the Apple GPU with the benchmarks, so every call waits for the GPU lock: an LLM request never
    runs while an A/B benchmark is measuring. If the server is unreachable, calls fall back to `fallback`."""

    def __init__(self, model: str, base_url: str, timeout: float = 600.0, cache: Optional[LLMCache] = None,
                 fallback: Optional[LLMClient] = None) -> None:
        super().__init__(LLMConfig(api_key="", model=f"mlx:{model}", base_url=base_url.rstrip("/"), timeout=timeout,
                                   temperature=0.2), cache)
        self.server_model = model
        self.fallback = fallback

    def _request(self, system_prompt: str, user_prompt: str, schema: Optional[tuple]) -> str:
        from paperatlas.lab.gpu import gpu_lock

        payload = {
            "model": self.server_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt + schema_instruction(schema)},
            ],
            "temperature": self.config.temperature,
            "max_tokens": 8192,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        last_error = "no response"
        for attempt in range(self.config.max_retries):
            with gpu_lock():
                started = time.monotonic()
                response = httpx.post(f"{self.config.base_url}/chat/completions", json=payload, timeout=self.config.timeout)
            if response.status_code >= 400:
                last_error = f"HTTP {response.status_code}: {response.text[:300]}"
                time.sleep(2 * (attempt + 1))
                continue
            data = response.json()
            text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            usage = data.get("usage") or {}
            logger.info("LLM mlx %s: %s in / %s out tokens, %.1fs", self.server_model, usage.get("prompt_tokens"),
                        usage.get("completion_tokens"), time.monotonic() - started)
            if not schema:
                return THINK_BLOCK.sub("", text).strip()
            try:
                return extract_json_object(text)
            except LLMError as exc:
                last_error = str(exc)
        raise LLMError(f"mlx_lm.server LLM failed: {last_error}")

    def _call(self, system_prompt: str, user_prompt: str, schema: Optional[tuple]) -> str:
        try:
            return self._request(system_prompt, user_prompt, schema)
        except httpx.TransportError as exc:
            if self.fallback is None:
                raise LLMError(f"mlx_lm.server unreachable at {self.config.base_url}: {exc}") from exc
            logger.warning("mlx_lm.server unreachable (%s); using %s", exc, self.fallback.model)
            return self.fallback._call(system_prompt, user_prompt, schema)


def mlx_server_command(port: int = 8103) -> list[str]:
    """`mlx_lm.server` for the local LLM, run in its own uv tool environment (keeps MLX out of PaperAtlas's venv)."""
    model = settings.env("PAPERATLAS_MLX_LLM_MODEL", DEFAULT_MLX_LLM_MODEL)
    return ["uvx", "--from", "mlx-lm", "mlx_lm.server", "--model", model, "--host", "127.0.0.1", "--port", str(port)]


def build_default_llm_client(use_cache: bool = True) -> Optional[LLMClient]:
    provider = (settings.env("PAPERATLAS_LLM_PROVIDER") or "").lower()
    if provider == "mlx":
        return MlxServerLLMClient(
            settings.env("PAPERATLAS_MLX_LLM_MODEL", DEFAULT_MLX_LLM_MODEL),
            settings.env("PAPERATLAS_MLX_LLM_URL", DEFAULT_MLX_LLM_URL),
            max(settings.llm_timeout(), 600.0),
            LLMCache() if use_cache else None,
            fallback=CopilotCliLLMClient(settings.env("PAPERATLAS_COPILOT_LLM_MODEL"), settings.llm_timeout()),
        )
    if provider == "copilot":
        return CopilotCliLLMClient(
            settings.env("PAPERATLAS_COPILOT_LLM_MODEL"), settings.llm_timeout(), LLMCache() if use_cache else None
        )
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
