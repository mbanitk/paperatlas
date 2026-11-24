"""Phase 5b — Analyst: explain a verdict like a careful reviewer, and decide whether another iteration is worthwhile.

The judge says *what* happened (claim check, adoption check, mechanism counters). The analyst says *why*, using the
paper's setup and the builder's fidelity notes, and proposes one concrete change for the coding agent when the
diagnosis is fixable (a wrong or partial implementation, untested knob ranges) — never for causes code cannot change
(hardware, the paper's claim simply not transferring).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

from paperatlas.llm.client import LLMClient, LLMError

logger = logging.getLogger(__name__)

DIAGNOSES = (
    "reproduced",
    "partially_reproduced",
    "implementation_suspect",
    "untuned",
    "regime_mismatch",
    "hardware_mismatch",
    "claim_not_supported",
    "inconclusive",
)
FIXABLE = {"implementation_suspect", "untuned", "partially_reproduced"}

ANALYST_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["diagnosis", "summary", "evidence", "paper_comparison", "worth_iterating", "next_changes", "expected_effect"],
    "properties": {
        "diagnosis": {"type": "string", "enum": list(DIAGNOSES)},
        "summary": {"type": "string"},
        "evidence": {"type": "array", "items": {"type": "string"}},
        "paper_comparison": {"type": "string"},
        "worth_iterating": {"type": "boolean"},
        "next_changes": {"type": "string"},
        "expected_effect": {"type": "string"},
    },
}

ANALYST_SYSTEM = """You review an experiment that tried to reproduce a research paper's performance claim inside a \
real LLM inference project, and explain the result to an engineer.
Diagnoses:
- reproduced: the claim check met the target.
- partially_reproduced: a real improvement, smaller than claimed, with a plausible fixable reason.
- implementation_suspect: the mechanism counters show the technique is not doing what the paper describes \
(e.g. no fewer verifications, acceptance far below the paper's, counters missing or zero), or the build deviates \
from the paper's method in a way that explains the gap.
- untuned: the mechanism works but the tried knob values are far from where the paper operates.
- regime_mismatch: the workload/model regime differs from the paper's in a way that removes the benefit.
- hardware_mismatch: the mechanism works as in the paper but the cost model of this hardware/runtime \
(e.g. per-forward overhead, draft cost relative to a target step, unified memory) cancels the gain. Use \
engine_roofline (forward cost per added token, draft ms/token, bandwidth utilisation) and the cost-model \
prediction to check this quantitatively; say which roofline number explains it.
- claim_not_supported: faithful implementation, paper-like regime, and still no effect.
- inconclusive: not enough evidence (noise, missing counters with no other signal).
Ground every statement in the numbers given; cite them. worth_iterating=true only for implementation_suspect, \
untuned or partially_reproduced AND when a concrete code change could plausibly close the gap. next_changes: \
precise instructions for the coding agent (what to change in the technique, which counters to add, which knob \
values to try), or "" when not iterating. expected_effect: what the change should do to the counters/metric."""


def _round(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, dict):
        return {k: _round(v) for k, v in value.items() if k != "deltas"}
    if isinstance(value, list):
        return [_round(v) for v in value]
    return value


def fidelity_notes(artifacts: Path) -> dict[str, Any]:
    path = artifacts / "fidelity.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def fallback_analysis(verdict: dict[str, Any]) -> dict[str, Any]:
    mechanism = verdict.get("mechanism") or {}
    if verdict["verdict"] == "reproduced":
        diagnosis = "reproduced"
    elif mechanism.get("missing"):
        diagnosis = "implementation_suspect"
    else:
        diagnosis = "inconclusive"
    return {
        "diagnosis": diagnosis,
        "summary": verdict.get("reason", ""),
        "evidence": [f"mechanism counters missing: {mechanism['missing']}"] if mechanism.get("missing") else [],
        "paper_comparison": "",
        "worth_iterating": False,
        "next_changes": "",
        "expected_effect": "",
        "model": None,
    }


def analyse(
    verdict: dict[str, Any],
    spec: dict[str, Any],
    claim: dict[str, Any],
    tuning: Optional[dict[str, Any]],
    fidelity: dict[str, Any],
    history: list[dict[str, Any]],
    llm: Optional[LLMClient],
    roofline_summary: Optional[str] = None,
) -> dict[str, Any]:
    if llm is None:
        return fallback_analysis(verdict)
    card = claim.get("card") or {}
    payload = {
        "claim": {
            "technique": claim.get("technique"),
            "paper": claim.get("paper_title"),
            "effects": card.get("effects"),
            "paper_setup": card.get("paper_setup"),
            "prerequisites": card.get("prerequisites"),
        },
        "protocol": {
            "paper_baseline": spec.get("paper_baseline"),
            "paper_workload": {k: v for k, v in (spec.get("paper_workload") or {}).items() if k != "prompts"},
            "project_workload": spec.get("workload"),
            "primary_metric": spec.get("primary_metric"),
            "target_pct": verdict.get("target_pct"),
            "fidelity": spec.get("fidelity"),
            "mechanism_expected": spec.get("mechanism"),
            "cost_model_prediction": spec.get("prediction"),
        },
        "engine_roofline": roofline_summary,
        "claim_check": {
            "verdict": verdict.get("verdict"),
            "reason": verdict.get("reason"),
            "per_metric": _round(verdict.get("per_metric")),
            "quality": verdict.get("quality"),
            "mechanism": _round(verdict.get("mechanism")),
        },
        "adoption_check": _round(
            {k: v for k, v in (verdict.get("adoption") or {}).items() if k in ("verdict", "reason", "per_metric", "mechanism")}
        )
        or None,
        "tuning": _round(tuning) if tuning and not tuning.get("skipped") else None,
        "builder_fidelity_notes": fidelity or None,
        "previous_iterations": history or None,
    }
    try:
        result = llm.generate_json(ANALYST_SYSTEM, json.dumps(payload, default=str)[:24000], "experiment_analysis", ANALYST_SCHEMA)
    except LLMError as exc:
        logger.warning("Analyst failed, using rule-based diagnosis: %s", exc)
        return fallback_analysis(verdict)
    if result.get("diagnosis") not in FIXABLE:
        result["worth_iterating"] = False
    if not (result.get("next_changes") or "").strip():
        result["worth_iterating"] = False
    result["model"] = llm.model
    return result
