"""Phase 3c — Turn a picked claim into an experiment spec (reviewed at Gate 2)."""

from __future__ import annotations

import logging
import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from paperatlas.lab.protocol import (
    PROTOCOL_VERSION,
    Fidelity,
    Knob,
    MAX_ROUND_TOKENS,
    MechanismMetric,
    PaperBaseline,
    PaperWorkload,
)
from paperatlas.llm.client import LLMClient, LLMError

logger = logging.getLogger(__name__)

SAFE_WORKLOAD = re.compile(r"[A-Za-z0-9_.-]+")
FLAG_MAX_LEN = 41

EDITABLE_FIELDS = (
    "hypothesis",
    "flag_name",
    "primary_metric",
    "success_threshold_pct",
    "rounds",
    "warmup",
    "workload",
    "model",
    "tune",
    "max_iterations",
    # protocol v2 — the reviewer can correct how the paper is reproduced
    "paper_baseline",
    "paper_workload",
    "mechanism",
    "knobs",
    "fidelity",
    "lossless",
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
    # protocol v2: reproduce the paper's comparison, then check adoption (see lab/protocol.py)
    protocol_version: int = PROTOCOL_VERSION
    paper_baseline: PaperBaseline = Field(default_factory=PaperBaseline)
    paper_workload: Optional[PaperWorkload] = None
    mechanism: list[MechanismMetric] = Field(default_factory=list)
    knobs: list[Knob] = Field(default_factory=list)
    fidelity: Fidelity = Field(default_factory=Fidelity)
    tune: bool = True
    tune_rounds: int = Field(1, ge=1, le=4)
    max_iterations: int = Field(3, ge=1, le=5)
    # cost-model prediction for this engine (lab/costmodel.py), shown at Gate 2 and to the analyst
    prediction: Optional[dict[str, Any]] = None
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
    if isinstance(overrides.get("paper_workload"), dict):
        draft = {"paper_workload": dict(overrides["paper_workload"]), "knobs": overrides.get("knobs", spec.get("knobs") or []),
                 "mechanism": overrides.get("mechanism", spec.get("mechanism") or [])}
        _normalize_protocol(draft)
        overrides = {**overrides, "paper_workload": draft["paper_workload"]}
    merged = ExperimentSpec.model_validate({**spec, **overrides})
    metrics = {m["name"]: m for m in profile.get("metrics") or []}
    workloads = _workload_names(profile)
    if merged.primary_metric not in metrics:
        raise ValueError(f"primary_metric must be one of {sorted(metrics)}")
    if workloads and merged.workload not in workloads:
        raise ValueError(f"workload must be one of {workloads}")
    if not workloads and not SAFE_WORKLOAD.fullmatch(merged.workload):
        raise ValueError("workload must be letters, digits, '_', '.' or '-' (the profile lists no workloads)")
    merged.direction = _direction(metrics[merged.primary_metric])
    if "knobs" in overrides and not merged.knobs:
        merged.tune = False
    if "lossless" in overrides:
        merged.guardrails.min_output_agreement = 1.0 if merged.lossless else None
    return merged.model_dump()


def _workload_names(profile: dict[str, Any]) -> list[str]:
    workloads = profile.get("workloads") or []
    if isinstance(workloads, dict):
        return list(workloads)
    return [w["name"] if isinstance(w, dict) else str(w) for w in workloads]


def _direction(metric: dict[str, Any]) -> str:
    return "lower_is_better" if "lower" in str(metric.get("direction", "")) else "higher_is_better"


def _obj(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "required": list(properties), "properties": properties}


PROTOCOL_SCHEMA = {
    "paper_baseline": _obj(
        {
            "description": {"type": "string"},
            "kind": {"type": "string", "enum": ["project_default", "technique_mode"]},
        }
    ),
    "paper_workload": _obj(
        {
            "matches": {"type": "string"},
            "description": {"type": "string"},
            "prompts": {"type": "array", "items": {"type": "string"}},
            "max_new_tokens": {"type": "integer"},
            "concurrency": {"type": "integer"},
            "long_context_tokens": {"type": "integer"},
        }
    ),
    "mechanism": {
        "type": "array",
        "items": _obj({"name": {"type": "string"}, "meaning": {"type": "string"}, "paper_value": {"type": ["string", "null"]}}),
    },
    "knobs": {
        "type": "array",
        "items": _obj(
            {
                "name": {"type": "string"},
                "meaning": {"type": "string"},
                "paper_value": {"type": ["string", "null"]},
                "candidates": {"type": "array", "items": {"type": "string"}},
            }
        ),
    },
    "fidelity": _obj(
        {"level": {"type": "string", "enum": ["high", "medium", "low"]}, "gaps": {"type": "array", "items": {"type": "string"}}}
    ),
}

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

The experiment must test the claim THE WAY THE PAPER MEASURED IT, then separately test whether it helps this project:
- paper_baseline: what exactly the paper's reported number is measured against (read the effects' "baseline"). \
kind=project_default when that baseline is what the project already does with the flag off (e.g. "fp16 attention" \
when the project runs fp16). kind=technique_mode when it is another method the project lacks (e.g. "the same \
speculative decoder without DLoop", "full KV cache with standard batching"): the coding agent will implement BOTH \
behind the one flag, selected by param mode="baseline" vs mode="method", so the claim check compares like with like. \
Never compare a method against plain decoding when the paper compared it against a stronger baseline.
- paper_workload: 3-6 prompts in the style of the paper's evaluation data (write real prompts, e.g. GSM8K-style \
word problems, HumanEval-style function stubs, MT-Bench-style questions, long documents), with max_new_tokens and \
concurrency close to the paper's regime (max_new_tokens ≤ 256, concurrency ≤ 8, prompts × max_new_tokens ≤ 1200). \
Use long_context_tokens (e.g. 4000) only when the paper's effect depends on long prefixes (the bench then generates \
synthetic documents and asks prompts[0] about them); else 0. "matches" names the paper benchmarks mirrored.
- mechanism: 1-4 counters the technique must record (snake_case names, e.g. verifications, drafted_tokens, \
accepted_tokens, evicted_entries, cache_hits) that show whether the paper's mechanism is happening, each with the \
paper's reported value when it gives one (e.g. "34% fewer verifications than block drafting").
- knobs: 0-3 hyperparameters the paper tunes (block size, threshold, budget...), snake_case, with up to 3 candidate \
values each as strings, the paper's setting FIRST; they are swept briefly before the measured runs.
- fidelity: high/medium/low — how faithfully this project can reproduce the paper's setup — and the concrete gaps \
(different model family/size, missing trained draft heads, no fused kernels, hardware...).
- workload (above) is the PROJECT workload for the adoption check; primary_metric is the paper's headline metric.
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
            **PROTOCOL_SCHEMA,
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
                f"- prerequisites (from the paper): {card.get('prerequisites')}",
                f"- risks: {card.get('risks')}",
                "",
                "Paper text around the method (for the exact baseline, benchmarks and hyperparameters):",
                (claim.get("method_excerpt") or "")[:6000],
                "",
                f"Measured engine roofline: {claim.get('roofline_summary') or 'not measured'}",
                f"Cost-model prediction for this claim on this engine: {claim.get('prediction')}",
                "Design the experiment so the technique can work where this engine spends its time (e.g. choose "
                "knob ranges, block sizes and workloads that the roofline says can pay off).",
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

    _normalize_protocol(draft)
    spec = ExperimentSpec(
        **draft,
        prediction=claim.get("prediction"),
        direction=_direction(metrics.get(draft["primary_metric"], {})),
        claimed_gain_pct=claimed,
        model="eval",
        baseline_flags=baseline_flags,
        bundle_claim_ids=[c["id"] for c in companions if c.get("id")],
    )
    if claimed is not None and spec.success_threshold_pct > claimed:
        spec.success_threshold_pct = round(max(1.0, claimed * 0.5), 2)
    if spec.lossless:
        spec.guardrails.min_output_agreement = 1.0
    spec.flag_name = unique_flag_name(spec.flag_name, {t.get("name") for t in profile.get("techniques") or []})
    if not spec.knobs:
        spec.tune = False
    return spec.model_dump()


def unique_flag_name(name: str, existing: set[Any]) -> str:
    candidate, counter = name, 2
    while candidate in existing:
        suffix = f"_v{counter}"
        candidate = name[: FLAG_MAX_LEN - len(suffix)].rstrip("_") + suffix
        counter += 1
    return candidate


def _normalize_protocol(draft: dict[str, Any]) -> None:
    """Clamp the paper workload to the round budget and drop empty sections."""
    workload = draft.get("paper_workload")
    if isinstance(workload, dict):
        prompts = [p for p in workload.get("prompts") or [] if str(p).strip()]
        if not prompts:
            draft["paper_workload"] = None
        else:
            workload["max_new_tokens"] = max(16, min(int(workload.get("max_new_tokens") or 128), 256))
            workload["concurrency"] = max(1, min(int(workload.get("concurrency") or 1), 8))
            workload["long_context_tokens"] = max(0, min(int(workload.get("long_context_tokens") or 0), 16000))
            keep = max(1, min(len(prompts), MAX_ROUND_TOKENS // workload["max_new_tokens"]))
            workload["prompts"] = prompts[:keep]
    draft["knobs"] = [k for k in draft.get("knobs") or [] if k.get("name") and k.get("candidates")][:3]
    draft["mechanism"] = [m for m in draft.get("mechanism") or [] if m.get("name")][:4]


def _flag_from(text: str) -> str:
    words = re.findall(r"[a-z0-9]+", text.lower())[:4]
    name = "_".join(words) or "technique"
    return name if name[0].isalpha() else f"t_{name}"
