"""Phase 3c — Turn a picked claim into an experiment spec (reviewed at Gate 2)."""

from __future__ import annotations

import logging
import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from paperatlas.llm.client import LLMClient, LLMError

logger = logging.getLogger(__name__)

EDITABLE_FIELDS = (
    "hypothesis",
    "flag_name",
    "primary_metric",
    "success_threshold_pct",
    "rounds",
    "warmup",
    "workload",
    "model",
)


class Guardrails(BaseModel):
    max_exact_match_drop: float = 0.02
    min_output_agreement: Optional[float] = None
    max_peak_memory_increase_pct: float = 15.0


class ExperimentSpec(BaseModel):
    hypothesis: str
    flag_name: str
    technique_summary: str
    implementation_notes: str
    primary_metric: str
    direction: Literal["higher_is_better", "lower_is_better"]
    secondary_metrics: list[str] = Field(default_factory=list)
    workload: str = "short_chat"
    model: Literal["smoke", "eval"] = "eval"
    rounds: int = Field(10, ge=2, le=60)
    warmup: int = Field(1, ge=0, le=5)
    success_threshold_pct: float = Field(5.0, ge=0.0, le=500.0)
    claimed_gain_pct: Optional[float] = None
    lossless: bool = False
    baseline_flags: list[str] = Field(default_factory=list)
    bundle_claim_ids: list[int] = Field(default_factory=list)
    guardrails: Guardrails = Field(default_factory=Guardrails)
    paper_vs_project: Optional[str] = None
    build_timeout_s: int = 3600
    smoke_timeout_s: int = 1800
    eval_timeout_s: int = 3 * 3600

    @field_validator("flag_name")
    @classmethod
    def _snake_case(cls, value: str) -> str:
        value = re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_")
        if not re.match(r"^[a-z][a-z0-9_]{2,40}$", value):
            raise ValueError("flag_name must be snake_case, 3-41 chars, starting with a letter")
        return value


def apply_overrides(spec: dict[str, Any], overrides: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    unknown = set(overrides) - set(EDITABLE_FIELDS)
    if unknown:
        raise ValueError(f"Not editable: {sorted(unknown)}; editable fields are {list(EDITABLE_FIELDS)}")
    if "flag_name" in overrides and not re.fullmatch(r"[a-z][a-z0-9_]{2,40}", str(overrides["flag_name"])):
        raise ValueError("flag_name must be snake_case: 3-41 chars of a-z, 0-9 and _, starting with a letter")
    merged = ExperimentSpec.model_validate({**spec, **overrides})
    metrics = {m["name"]: m for m in profile.get("metrics") or []}
    workloads = _workload_names(profile)
    if merged.primary_metric not in metrics:
        raise ValueError(f"primary_metric must be one of {sorted(metrics)}")
    if workloads and merged.workload not in workloads:
        raise ValueError(f"workload must be one of {workloads}")
    merged.direction = _direction(metrics[merged.primary_metric])
    return merged.model_dump()


def _workload_names(profile: dict[str, Any]) -> list[str]:
    workloads = profile.get("workloads") or []
    if isinstance(workloads, dict):
        return list(workloads)
    return [w["name"] if isinstance(w, dict) else str(w) for w in workloads]


def _direction(metric: dict[str, Any]) -> str:
    return "lower_is_better" if "lower" in str(metric.get("direction", "")) else "higher_is_better"


PLAN_SCHEMA_BASE = {
    "hypothesis": {"type": "string"},
    "flag_name": {"type": "string"},
    "technique_summary": {"type": "string"},
    "implementation_notes": {"type": "string"},
    "secondary_metrics": {"type": "array", "items": {"type": "string"}},
    "lossless": {"type": "boolean"},
    "success_threshold_pct": {"type": "number"},
    "paper_vs_project": {"type": "string"},
}

PLAN_SYSTEM = """You design controlled performance experiments for an LLM inference project.
Given a research claim and the target project's profile, write an experiment spec:
- hypothesis: one falsifiable sentence with the metric and the expected minimum effect.
- flag_name: snake_case name of the feature flag that will enable the technique.
- technique_summary: what to implement, concretely, in 2-4 sentences.
- implementation_notes: how to fit it into the project's extension points (which hooks), \
what must stay unchanged when the flag is off, and pitfalls on the project's hardware.
- primary_metric / secondary_metrics: chosen from the project's metrics.
- workload: the project workload that best exercises the technique.
- lossless: true if outputs must be identical to the baseline under greedy decoding \
(e.g. exact speculative decoding, scheduling, caching); false for approximations \
(quantization, eviction, pruning).
- success_threshold_pct: the minimum improvement on the primary metric (in %) that would \
make adopting the technique worthwhile; usually 3-10, never more than the claimed gain.
- paper_vs_project: how the paper's setup differs from the project (hardware, model size, \
batch size, sequence length) and how that may change the effect.
Use precise technical language."""


def plan_experiment(
    claim: dict[str, Any],
    profile: dict[str, Any],
    target_metric: Optional[str],
    llm: Optional[LLMClient],
    feedback: Optional[str] = None,
    companions: Optional[list[dict[str, Any]]] = None,
    baseline_flags: Optional[list[str]] = None,
) -> dict[str, Any]:
    companions = companions or []
    baseline_flags = baseline_flags or []
    metrics = {m["name"]: m for m in profile.get("metrics") or [] if m.get("name")}
    workloads = _workload_names(profile) or ["short_chat"]
    primary = target_metric if target_metric in metrics else next(iter(metrics), "decode_tokens_per_s")
    claimed = claim.get("claimed_gain_pct")
    draft: dict[str, Any] = {
        "hypothesis": f"Enabling the technique improves {primary} by at least 5% on {workloads[0]}.",
        "flag_name": _flag_from(claim.get("technique") or claim.get("name") or "technique"),
        "technique_summary": claim.get("technique") or "",
        "implementation_notes": claim.get("change_required") or "",
        "secondary_metrics": [m for m in metrics if m != primary][:3],
        "lossless": claim.get("category") in {"speculative_decoding", "batching_scheduling"},
        "success_threshold_pct": 5.0,
        "paper_vs_project": "",
        "primary_metric": primary,
        "workload": workloads[0],
    }
    if llm:
        schema_properties = {
            **PLAN_SCHEMA_BASE,
            "primary_metric": {"type": "string", "enum": list(metrics) or [primary]},
            "workload": {"type": "string", "enum": workloads},
        }
        schema = {
            "type": "object",
            "additionalProperties": False,
            "required": list(schema_properties),
            "properties": schema_properties,
        }
        card = claim.get("card") or {}
        prompt = "\n".join(
            [
                f"Claim (from paper '{claim.get('paper_title')}'):",
                f"- technique: {claim.get('technique')}",
                f"- change required: {claim.get('change_required')}",
                f"- claimed effects: {card.get('effects')}",
                f"- paper setup: {card.get('paper_setup')}",
                f"- evidence: {card.get('evidence')}",
                f"- risks: {card.get('risks')}",
                "",
                f"Project profile: name={profile.get('name')}; description={profile.get('description')}",
                f"hardware={profile.get('hardware')}; models={profile.get('models')}",
                f"metrics={list(metrics.values())}",
                f"workloads={profile.get('workloads')}",
                f"extension points={profile.get('extension_points')}",
                f"constraints={profile.get('constraints')}",
                f"existing techniques={[t.get('name') for t in profile.get('techniques') or []]}",
                f"Suggested target metric: {target_metric}",
            ]
            + (
                [
                    "",
                    "Implement this claim TOGETHER with these related concepts from the same paper "
                    "(prerequisites / complements), behind the same single flag:",
                ]
                + [f"- {c.get('name')}: {c.get('technique')} | change: {c.get('change_required')}" for c in companions]
                if companions
                else []
            )
            + (
                [
                    "",
                    f"Already merged prerequisite techniques (flags {baseline_flags}) are ON in BOTH arms; "
                    "measure only the increment of this technique on top of them.",
                ]
                if baseline_flags
                else []
            )
            + ([f"\nReviewer feedback on the previous spec (address it): {feedback}"] if feedback else [])
        )
        try:
            draft.update(llm.generate_json(PLAN_SYSTEM, prompt, "experiment_spec", schema))
        except LLMError as exc:
            logger.warning("LLM planning failed, using a template spec: %s", exc)

    spec = ExperimentSpec(
        **draft,
        direction=_direction(metrics.get(draft["primary_metric"], {})),
        claimed_gain_pct=claimed,
        model="eval",
        baseline_flags=baseline_flags,
        bundle_claim_ids=[c["id"] for c in companions if c.get("id")],
    )
    if claimed is not None and spec.success_threshold_pct > claimed:
        spec.success_threshold_pct = round(max(1.0, claimed * 0.5), 2)
    if spec.lossless:
        spec.guardrails.min_output_agreement = 0.95
    existing = {t.get("name") for t in profile.get("techniques") or []}
    while spec.flag_name in existing:
        spec.flag_name = f"{spec.flag_name}_v2"[:41]
    return spec.model_dump()


def _flag_from(text: str) -> str:
    words = re.findall(r"[a-z0-9]+", text.lower())[:4]
    name = "_".join(words) or "technique"
    return name if name[0].isalpha() else f"t_{name}"
