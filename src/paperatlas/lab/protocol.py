"""Experiment protocol v2 — test the paper's claim the way the paper measured it, then test adoption.

Two questions, two comparisons:
- claim check: the method vs *the paper's own baseline*, under a workload that mirrors the paper's benchmarks.
  If the paper's baseline is not the project's default behaviour (e.g. "DLoop vs the same speculative decoder
  without DLoop"), the technique implements both behind one flag and the arms differ only in `mode`.
- adoption check: the method vs the project's current default, on the project's own workload.

Knobs are tuned on a small budget before the measured runs (each arm gets its best configuration, so the baseline
is not handicapped), and the technique reports mechanism counters so a verdict can say *why* a number moved.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

PROTOCOL_VERSION = 2
MAX_TUNE_CONFIGS = 4
MAX_PAPER_PROMPTS = 6
MAX_ROUND_TOKENS = 1200
NUMBER = re.compile(r"^-?\d+(\.\d+)?$")


class PaperBaseline(BaseModel):
    description: str = ""
    # project_default: the paper's baseline is what the project already does (flag off).
    # technique_mode: the baseline is another method; the flag implements it as mode="baseline".
    kind: Literal["project_default", "technique_mode"] = "project_default"


class PaperWorkload(BaseModel):
    matches: str = ""
    description: str = ""
    prompts: list[str] = Field(default_factory=list)
    max_new_tokens: int = Field(128, ge=8, le=512)
    concurrency: int = Field(1, ge=1, le=8)
    long_context_tokens: int = Field(0, ge=0, le=16000)

    @field_validator("prompts")
    @classmethod
    def _prompts(cls, value: list[str]) -> list[str]:
        return [p.strip() for p in value if p and p.strip()][:MAX_PAPER_PROMPTS]


class MechanismMetric(BaseModel):
    name: str
    meaning: str = ""
    paper_value: Optional[str] = None

    @field_validator("name")
    @classmethod
    def _snake(cls, value: str) -> str:
        return re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_") or "counter"


class Knob(BaseModel):
    name: str
    meaning: str = ""
    paper_value: Optional[str] = None
    candidates: list[Any] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _snake(cls, value: str) -> str:
        return re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_") or "knob"

    @field_validator("candidates")
    @classmethod
    def _values(cls, value: list[Any]) -> list[Any]:
        out: list[Any] = []
        for item in value[:3]:
            item = _coerce(item)
            if item not in out:
                out.append(item)
        return out


class Fidelity(BaseModel):
    level: Literal["high", "medium", "low"] = "medium"
    gaps: list[str] = Field(default_factory=list)


def _coerce(value: Any) -> Any:
    if isinstance(value, str):
        text = value.strip()
        if text.lower() in {"true", "false"}:
            return text.lower() == "true"
        if NUMBER.match(text):
            return float(text) if "." in text else int(text)
        return text
    return value


def tune_configs(knobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The paper's setting first, then one knob changed at a time (≤ MAX_TUNE_CONFIGS configs)."""
    knobs = [k for k in knobs if k.get("candidates")]
    if not knobs:
        return []
    default = {k["name"]: k["candidates"][0] for k in knobs}
    configs = [default]
    for knob in knobs:
        for value in knob["candidates"][1:]:
            config = {**default, knob["name"]: value}
            if config not in configs:
                configs.append(config)
            if len(configs) >= MAX_TUNE_CONFIGS:
                return configs
    return configs


def uses_paper_baseline(spec: dict[str, Any]) -> bool:
    return (spec.get("paper_baseline") or {}).get("kind") == "technique_mode"


def has_paper_workload(spec: dict[str, Any]) -> bool:
    return bool((spec.get("paper_workload") or {}).get("prompts"))


def needs_adoption_run(spec: dict[str, Any]) -> bool:
    """The adoption check differs from the claim check only if the baseline or the workload differ."""
    return int(spec.get("protocol_version") or 1) >= 2 and (uses_paper_baseline(spec) or has_paper_workload(spec))


def workload_file(spec: dict[str, Any], artifacts: Path) -> Optional[Path]:
    """Write the paper-mirroring workload as a file the bench accepts as `--workload`."""
    workload = spec.get("paper_workload") or {}
    prompts = list(workload.get("prompts") or [])
    if not prompts:
        return None
    max_new = int(workload.get("max_new_tokens") or 128)
    body: dict[str, Any] = {
        "name": "paper_regime",
        "description": f"Mirrors the paper's evaluation: {workload.get('matches') or workload.get('description') or ''}".strip(),
        "max_new_tokens": max_new,
        "concurrency": int(workload.get("concurrency") or 1),
    }
    long_context = int(workload.get("long_context_tokens") or 0)
    if long_context:
        body["synthetic"] = {
            "target_tokens": [long_context] * min(len(prompts), 2),
            "seed": 0,
            "question": prompts[0],
        }
    else:
        body["prompts"] = prompts
    path = artifacts / "paper_workload.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, indent=2), encoding="utf-8")
    return path


def comparison_arms(
    spec: dict[str, Any],
    comparison: Literal["claim", "adopt"],
    baseline_config: Optional[dict[str, Any]] = None,
    variant_config: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Flags and per-technique params of each arm, for the claim check or the adoption check."""
    flag = spec["flag_name"]
    prerequisites = list(spec.get("baseline_flags") or [])
    v2 = int(spec.get("protocol_version") or 1) >= 2
    variant_params = {flag: {"mode": "method", **(variant_config or {})}} if v2 else {}
    if comparison == "claim" and uses_paper_baseline(spec):
        baseline_flags = [*prerequisites, flag]
        baseline_params = {flag: {"mode": "baseline", **(baseline_config or {})}}
    else:
        baseline_flags = prerequisites
        baseline_params = {}
    return {
        "baseline_flags": baseline_flags,
        "variant_flags": [*prerequisites, flag],
        "params": {"baseline": baseline_params, "variant": variant_params},
    }


def method_excerpt(raw_text: Optional[str], abstract: Optional[str], quote: Optional[str], width: int = 6000) -> str:
    """The part of the paper that describes the method (around the claim's evidence quote)."""
    from paperatlas.r2e.explainers import evidence_window

    window = evidence_window(raw_text, quote, width) if raw_text else ""
    return window or (abstract or "")[:width]


def spec_defaults(spec: dict[str, Any]) -> dict[str, Any]:
    """Fill protocol fields on older specs so every consumer can rely on them."""
    out = dict(spec)
    out.setdefault("protocol_version", 1)
    out.setdefault("paper_baseline", PaperBaseline().model_dump())
    out.setdefault("paper_workload", None)
    out.setdefault("mechanism", [])
    out.setdefault("knobs", [])
    out.setdefault("fidelity", Fidelity().model_dump())
    out.setdefault("max_iterations", 1)
    out.setdefault("tune", False)
    return out
