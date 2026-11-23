"""Claim cards: the testable, technical unit distilled from a paper (no social-post prose)."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

CATEGORIES = (
    "kv_cache",
    "speculative_decoding",
    "quantization",
    "batching_scheduling",
    "attention_kernels",
    "memory_management",
    "routing_load_balancing",
    "disaggregated_serving",
    "parallelism_communication",
    "observability",
    "evaluation_quality",
    "cost_energy",
    "compression_pruning",
    "model_architecture",
    "training",
    "other",
)
CONCEPT_KINDS = (
    "method",
    "system",
    "algorithm",
    "finding",
    "evaluation",
    "theory",
    "dataset",
    "limitation",
    "other",
)

Category = Literal[CATEGORIES]  # type: ignore[valid-type]
ConceptKind = Literal[CONCEPT_KINDS]  # type: ignore[valid-type]

_PERCENT_UNITS = {"%", "percent", "pct", "percentage", "percentage points", "pp"}
_RATIO_UNITS = {"x", "×", "times", "fold"}


class ClaimEffect(BaseModel):
    metric: str
    value: Optional[float] = None
    unit: Optional[str] = None
    direction: Literal["increase", "decrease", "none"] = "none"
    baseline: Optional[str] = None
    conditions: Optional[str] = None

    def gain_pct(self) -> Optional[float]:
        """Claimed improvement in %, positive in the claim's own direction."""
        if self.value is None or self.direction == "none":
            return None
        unit = (self.unit or "").strip().lower()
        value = abs(self.value)
        if unit in _PERCENT_UNITS:
            return value
        if unit in _RATIO_UNITS and value > 0:
            if self.direction == "increase":
                return (value - 1.0) * 100.0
            return (1.0 - (1.0 / value if value > 1 else value)) * 100.0
        return None


class PaperSetup(BaseModel):
    hardware: Optional[str] = None
    model: Optional[str] = None
    framework: Optional[str] = None
    batch_size: Optional[str] = None
    sequence_length: Optional[str] = None
    dataset: Optional[str] = None


class Evidence(BaseModel):
    quote: str
    location: Optional[str] = None


class ClaimCard(BaseModel):
    testable: bool
    category: Category
    technique: str
    change_required: str
    effects: list[ClaimEffect] = Field(default_factory=list)
    paper_setup: PaperSetup = Field(default_factory=PaperSetup)
    prerequisites: list[str] = Field(default_factory=list)
    requires_cuda: bool = False
    requires_multi_gpu: bool = False
    requires_training: bool = False
    effort: Literal["low", "medium", "high"] = "medium"
    risks: list[str] = Field(default_factory=list)
    evidence: Evidence

    def primary_effect(self) -> Optional[ClaimEffect]:
        for effect in self.effects:
            if effect.gain_pct() is not None:
                return effect
        return self.effects[0] if self.effects else None

    def claimed_gain_pct(self) -> Optional[float]:
        effect = self.primary_effect()
        return effect.gain_pct() if effect else None

    def search_text(self) -> str:
        effect = self.primary_effect()
        metric = f" Metric: {effect.metric}." if effect else ""
        return f"{self.technique} Change: {self.change_required}.{metric} Category: {self.category}."


class DistilledConcept(BaseModel):
    name: str
    kind: ConceptKind
    summary: str
    key_points: list[str] = Field(default_factory=list)
    claim: ClaimCard


class Distillation(BaseModel):
    paper_summary: str
    concepts: list[DistilledConcept]


def _nullable(schema_type: str) -> dict:
    return {"type": [schema_type, "null"]}


def _obj(properties: dict) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


_STR_LIST = {"type": "array", "items": {"type": "string"}}

CLAIM_SCHEMA = _obj(
    {
        "testable": {"type": "boolean"},
        "category": {"type": "string", "enum": list(CATEGORIES)},
        "technique": {"type": "string"},
        "change_required": {"type": "string"},
        "effects": {
            "type": "array",
            "items": _obj(
                {
                    "metric": {"type": "string"},
                    "value": _nullable("number"),
                    "unit": _nullable("string"),
                    "direction": {"type": "string", "enum": ["increase", "decrease", "none"]},
                    "baseline": _nullable("string"),
                    "conditions": _nullable("string"),
                }
            ),
        },
        "paper_setup": _obj(
            {
                key: _nullable("string")
                for key in (
                    "hardware",
                    "model",
                    "framework",
                    "batch_size",
                    "sequence_length",
                    "dataset",
                )
            }
        ),
        "prerequisites": _STR_LIST,
        "requires_cuda": {"type": "boolean"},
        "requires_multi_gpu": {"type": "boolean"},
        "requires_training": {"type": "boolean"},
        "effort": {"type": "string", "enum": ["low", "medium", "high"]},
        "risks": _STR_LIST,
        "evidence": _obj({"quote": {"type": "string"}, "location": _nullable("string")}),
    }
)

DISTILLATION_SCHEMA = _obj(
    {
        "paper_summary": {"type": "string"},
        "concepts": {
            "type": "array",
            "items": _obj(
                {
                    "name": {"type": "string"},
                    "kind": {"type": "string", "enum": list(CONCEPT_KINDS)},
                    "summary": {"type": "string"},
                    "key_points": _STR_LIST,
                    "claim": CLAIM_SCHEMA,
                }
            ),
        },
    }
)
