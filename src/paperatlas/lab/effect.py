"""Why this result: link an experiment's code change to what was measured (a gain, a loss or no change).

The facts — the outcome of each check, whether it is within noise, and whether the technique ran at all (its
mechanism counters) — are computed here from the verdict, so they hold whatever the LLM writes. The LLM (one call,
given the diff) explains the causal chain in plain words; without it, or when it fails, a rule-based text is used.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import Any, Optional

from paperatlas.lab.changes import excerpt
from paperatlas.llm.client import LLMClient, LLMError

logger = logging.getLogger(__name__)

METRIC_LABELS = {
    "decode_tokens_per_s": "decode speed",
    "throughput_tokens_per_s": "throughput",
    "ttft_ms": "time to first token",
    "itl_ms": "inter-token latency",
    "tpot_ms": "time per output token",
    "e2e_latency_ms": "end-to-end latency",
    "peak_memory_gb": "peak memory",
    "prefill_tokens_per_s": "prefill speed",
}
CHECK_LABELS = {"claim": "claim check", "adoption": "adoption check"}
MAX_COUNTERS = 6
MAX_LINKS = 4

EFFECT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["change_summary", "headline", "links", "why"],
    "properties": {
        "change_summary": {"type": "string"},
        "headline": {"type": "string"},
        "links": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["code", "files", "effect"],
                "properties": {
                    "code": {"type": "string"},
                    "files": {"type": "array", "items": {"type": "string"}},
                    "effect": {"type": "string"},
                },
            },
        },
        "why": {"type": "string"},
    },
}

EFFECT_SYSTEM = """You explain to an engineer, in plain language, how the code change an AI coding agent made to an \
LLM inference project caused an experiment's measured result: a gain, a loss, or no change.
You get the technique, the measured checks, the technique's mechanism counters, the changed files and an excerpt \
of the diff. The claim check compares the method with the paper's baseline on a paper-like workload; the adoption \
check (when present) compares it with the project's default on the project's own workload.
Rules:
- `facts` are computed from the measurements and are authoritative. Never contradict an outcome, `triggered` or \
`within_noise`. If a check's triggered is "no", say plainly that the new code never ran there (its counters \
stayed at 0) and explain the result in that light. If a check is within noise, say plainly that the effect is \
within noise (no measurable change), not a gain or a loss. If triggered is "unknown", say the counters can't tell.
- Cite numbers from the input (percent changes with one decimal, counters per request); never invent numbers.
- Name code by file and by the functions/classes visible in the diff; don't paste code.
- change_summary: one line (at most 25 words): what the change does, in behaviour terms, not a list of files.
- headline: one sentence linking the change to the measured outcome (both checks when both exist).
- links: 1 to 4 steps of the causal chain. code = what a specific part of the change does (name the file or \
function); files = paths from the changed files; effect = what the counters or metrics show as its consequence, \
with numbers.
- why: 2 or 3 sentences on why this produced a gain, a loss or no change here (e.g. the work it saves versus the \
overhead it adds, or the code path not triggering on this workload). No hedging boilerplate."""


def metric_label(metric: Optional[str]) -> str:
    if not metric:
        return "the primary metric"
    return METRIC_LABELS.get(metric, metric.replace("_", " "))


def num(value: Optional[float]) -> str:
    """At most ~3 significant digits, for prose."""
    if value is None:
        return "n/a"
    size = abs(value)
    if size >= 1000:
        return f"{value:,.0f}"
    if size >= 100:
        return f"{value:.0f}"
    if size >= 10:
        return f"{value:.1f}".rstrip("0").rstrip(".")
    if size >= 1:
        return f"{value:.2f}".rstrip("0").rstrip(".")
    if size == 0:
        return "0"
    return f"{value:.2g}"


def outcome_of(median: Optional[float], low: Optional[float], high: Optional[float]) -> str:
    """gain / loss when the 95% CI excludes 0 (in the metric's better / worse direction), else no_change."""
    if median is None or low is None or high is None:
        return "unknown"
    if low > 0:
        return "gain"
    if high < 0:
        return "loss"
    return "no_change"


def _rounds(mechanism: dict[str, Any], per_metric: dict[str, Any], primary: str) -> Optional[int]:
    rounds = mechanism.get("rounds")
    if isinstance(rounds, dict) and rounds.get("variant"):
        return int(rounds["variant"])
    pairs = ((per_metric or {}).get(primary) or {}).get("pairs")
    return int(pairs) if pairs else None


def _counter_basis(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The counters that say whether the technique ran: the expected ones when reported, else any."""
    reported = [r for r in rows if r.get("variant_total") is not None]
    expected = [r for r in reported if r.get("expected")]
    return expected or reported


def triggered_of(mechanism: Optional[dict[str, Any]]) -> str:
    basis = _counter_basis((mechanism or {}).get("rows") or [])
    if not basis:
        return "unknown"
    return "no" if all(not r.get("variant_total") for r in basis) else "yes"


def _counters(mechanism: dict[str, Any], requests: Optional[int]) -> list[dict[str, Any]]:
    rows = mechanism.get("rows") or []
    expected = [r for r in rows if r.get("expected")]
    extras = sorted(
        (r for r in rows if not r.get("expected") and r.get("variant_total")),
        key=lambda r: ("." in r["name"], -(r.get("variant_total") or 0)),
    )
    chosen = (expected + extras)[: max(MAX_COUNTERS, len(expected))]
    return [
        {
            "name": r["name"],
            "meaning": r.get("meaning"),
            "expected": bool(r.get("expected")),
            "total": r.get("variant_total"),
            "per_request": (r["variant_total"] / requests) if requests and r.get("variant_total") is not None else None,
            "per_1k_tokens": r.get("variant_per_1k_tokens"),
            "baseline_total": r.get("baseline_total"),
        }
        for r in chosen
    ]


def _workload_name(workload: Any) -> Optional[str]:
    if isinstance(workload, dict):
        return workload.get("name")
    return str(workload) if workload else None


def _check(kind: str, data: dict[str, Any], primary: str, setting: str) -> dict[str, Any]:
    mechanism = data.get("mechanism") or {}
    workload = data.get("workload") or {}
    rounds = _rounds(mechanism, data.get("per_metric") or {}, primary)
    per_round = workload.get("requests_per_round") if isinstance(workload, dict) else None
    requests = int(rounds * per_round) if rounds and per_round else None
    tokens = ((mechanism.get("tokens") or {}).get("variant")) or None
    median, low, high = data.get("median_delta_pct"), data.get("ci_low_pct"), data.get("ci_high_pct")
    outcome = outcome_of(median, low, high)
    return {
        "check": kind,
        "label": CHECK_LABELS[kind].capitalize(),
        "setting": setting,
        "verdict": data.get("verdict"),
        "median_pct": median,
        "ci_low_pct": low,
        "ci_high_pct": high,
        "outcome": outcome,
        "within_noise": outcome == "no_change",
        "quality_ok": data.get("quality_ok"),
        "quality_problems": list(data.get("quality_problems") or []),
        "triggered": triggered_of(mechanism),
        "missing_counters": list(mechanism.get("missing") or []),
        "counters": _counters(mechanism, requests),
        "requests": requests,
        "tokens_per_request": (tokens / requests) if tokens and requests else None,
    }


def facts(verdict: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    """Outcome, noise and trigger facts per check (claim check, and the adoption check when it ran separately)."""
    primary = verdict.get("primary_metric") or spec.get("primary_metric") or ""
    comparison = verdict.get("comparison") or {}
    paper_regime = isinstance(comparison, dict) and comparison.get("workload") == "paper regime"
    claim_setting = "a paper-like workload" if paper_regime else f"the {_workload_name(verdict.get('workload')) or 'project'} workload"
    checks = [_check("claim", verdict, primary, claim_setting)]
    adoption = verdict.get("adoption")
    if isinstance(adoption, dict) and adoption.get("verdict"):
        name = _workload_name(adoption.get("workload"))
        checks.append(_check("adoption", adoption, primary, f"your default workload ({name})" if name else "your default workload"))
    outcomes = {c["outcome"] for c in checks if c["outcome"] != "unknown"}
    overall = "unknown" if not outcomes else outcomes.pop() if len(outcomes) == 1 else "mixed"
    triggered = {c["triggered"] for c in checks}
    return {
        "metric": primary,
        "metric_label": metric_label(primary),
        "outcome": overall,
        "triggered": "yes" if "yes" in triggered else "no" if "no" in triggered else "unknown",
        "checks": checks,
    }


# ---- rule-based text ----------------------------------------------------------------------


def pct(value: float) -> str:
    return f"{abs(value):.1f}%"


def _phrase(check: dict[str, Any], metric: Optional[str] = None) -> str:
    """"decode speed improved 4.0%" (or without the metric name: "improved 4.0%")."""
    median = check["median_pct"]
    subject = f"{metric} " if metric else ""
    if check["outcome"] == "gain":
        return f"{subject}improved {pct(median)}"
    if check["outcome"] == "loss":
        return f"{subject}got {pct(median)} worse"
    if check["outcome"] == "no_change":
        return f"{subject}didn't change measurably ({median:+.1f}%, within noise)"
    return f"{subject}couldn't be measured reliably"


def _counter_text(counter: dict[str, Any]) -> str:
    if counter.get("per_request") is not None:
        return f"`{counter['name']}` {num(counter['per_request'])} per request"
    if counter.get("per_1k_tokens") is not None:
        return f"`{counter['name']}` {num(counter['per_1k_tokens'])} per 1,000 tokens"
    return f"`{counter['name']}` {num(counter.get('total'))} in total"


def mechanism_sentence(check: dict[str, Any]) -> str:
    where = f"In the {check['label'].lower()}"
    if check["triggered"] == "no":
        return f"{where}, the technique's counters stayed at 0: the new code path never ran on these requests."
    if check["triggered"] == "unknown":
        return f"{where}, the technique reported no counters, so the measurements can't show whether the new code ran."
    active = [c for c in check["counters"] if c.get("total")][:3]
    return f"{where}, the counters show it ran: " + ", ".join(_counter_text(c) for c in active) + "."


def _why(check: dict[str, Any], metric: str) -> str:
    outcome, triggered = check["outcome"], check["triggered"]
    if check["quality_ok"] is False:
        return (
            f"The quality guardrail failed ({'; '.join(check['quality_problems']) or 'outputs changed'}), so the "
            f"{check['label'].lower()} counts as a regression whatever the speed."
        )
    if triggered == "no":
        return {
            "no_change": "Since the new code never ran, the flag-on and flag-off runs executed the same work, which is why nothing changed.",
            "loss": "The technique itself never ran, so the loss can only come from extra work the flag adds around it on every step (checks, bookkeeping) or from noise.",
            "gain": "The counters say the technique never ran, yet the metric improved: the gain must come from a side effect of the change, not from the technique, so treat it with caution.",
        }.get(outcome, "The new code never ran, so the result says nothing about the technique itself.")
    if triggered == "yes":
        return {
            "gain": f"The technique ran and {metric} improved: the work it saves outweighs what it adds on this hardware and workload.",
            "loss": f"The technique ran, but it cost more than it saved: the extra work it does per step outweighed the benefit, so {metric} got worse.",
            "no_change": "The technique ran, but what it saves and what it adds roughly cancel out: the difference is within run-to-run noise.",
        }.get(outcome, "The technique ran, but the measurement was not conclusive.")
    return {
        "gain": f"{metric.capitalize()} improved, but without counters it isn't certain the technique is the reason.",
        "loss": f"{metric.capitalize()} got worse; without counters it isn't clear whether the technique ran and cost more than it saved, or only added overhead.",
        "no_change": "Nothing changed measurably; without counters it isn't clear whether the technique even ran.",
    }.get(outcome, "The measurement was not conclusive.")


def notes(fact: dict[str, Any], changes: Optional[dict[str, Any]]) -> list[dict[str, str]]:
    """Plain statements the page always shows ({kind, text}): never triggered, no counters, within noise, quality,
    no saved diff, no engine code changed."""
    metric = fact["metric_label"]
    result = []
    for check in fact["checks"]:
        label = check["label"].lower()
        if check["triggered"] == "no":
            result.append(
                {
                    "kind": "never_triggered",
                    "text": f"Never triggered in the {label}: every counter the technique reports stayed at 0, so the new code path didn't run.",
                }
            )
        elif check["triggered"] == "unknown":
            result.append({"kind": "no_counters", "text": f"No counters reported in the {label}: the numbers can't show whether the new code ran."})
        if check["within_noise"]:
            result.append(
                {
                    "kind": "within_noise",
                    "text": f"Within noise in the {label}: {metric} moved {check['median_pct']:+.1f}%, but the 95% CI "
                    f"({check['ci_low_pct']:+.1f} to {check['ci_high_pct']:+.1f}%) includes 0.",
                }
            )
        if check["quality_ok"] is False:
            problems = "; ".join(check["quality_problems"]) or "outputs changed"
            result.append({"kind": "quality", "text": f"Quality guardrail failed in the {label}: {problems}."})
    if changes is None:
        result.append({"kind": "no_diff", "text": "The diff wasn't saved for this experiment, so this explanation uses the measurements only."})
    elif changes.get("files") and not any(f.get("kind") == "source" for f in changes["files"]):
        result.append({"kind": "no_engine_code", "text": "Only tests, docs or config changed: the engine code itself wasn't modified."})
    return result


def rule_based(fact: dict[str, Any], changes: Optional[dict[str, Any]], flag: Optional[str]) -> dict[str, Any]:
    metric = fact["metric_label"]
    checks = fact["checks"]
    flag_text = f"`{flag}`" if flag else "the flag"
    headline = f"With {flag_text} on, {_phrase(checks[0], metric)} on {checks[0]['setting']}"
    if len(checks) > 1:
        joiner = " and" if checks[1]["outcome"] == checks[0]["outcome"] else " but"
        headline += f"{joiner} {_phrase(checks[1])} on {checks[1]['setting']}"
    headline += "."
    files = [f["path"] for f in (changes or {}).get("files") or [] if f.get("kind") == "source"][:3]
    change_summary = (changes or {}).get("summary") or "The code change wasn't recorded."
    links = [
        {
            "code": change_summary if index == 0 else f"The same code, on {check['setting']}.",
            "files": files,
            "effect": f"{mechanism_sentence(check)} {_phrase(check, metric).capitalize()}.",
        }
        for index, check in enumerate(checks)
    ]
    whys = []
    for check in checks:
        text = _why(check, metric)
        whys.append(text if len(checks) == 1 else f"{check['label']}: {text[0].lower()}{text[1:]}")
    return {"change_summary": change_summary, "headline": headline, "links": links, "why": " ".join(whys)}


# ---- LLM text --------------------------------------------------------------------------------


def _sig(value: Any, digits: int = 3) -> Any:
    """Round to a few significant digits so the model cites readable numbers."""
    if not isinstance(value, float) or value == 0:
        return value
    return float(f"{value:.{digits}g}")


def _compact_check(check: dict[str, Any]) -> dict[str, Any]:
    def rnd(value):
        return round(value, 1) if isinstance(value, float) else value

    return {
        "check": check["check"],
        "setting": check["setting"],
        "verdict": check["verdict"],
        "change_pct": rnd(check["median_pct"]),
        "ci_95_pct": [rnd(check["ci_low_pct"]), rnd(check["ci_high_pct"])],
        "outcome": check["outcome"],
        "within_noise": check["within_noise"],
        "triggered": check["triggered"],
        "quality_ok": check["quality_ok"],
        "quality_problems": check["quality_problems"] or None,
        "requests_measured": check["requests"],
        "tokens_per_request": _sig(check["tokens_per_request"]),
        "counters": [
            {
                "name": c["name"],
                "meaning": c["meaning"],
                "per_request": _sig(c["per_request"]),
                "per_1k_tokens": _sig(c["per_1k_tokens"]),
                "total": _sig(c["total"]),
            }
            for c in check["counters"]
        ],
        "counters_not_reported": check["missing_counters"] or None,
    }


def _clean_llm(result: Any, changes: Optional[dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise LLMError("code_effect reply is not an object")
    headline = str(result.get("headline") or "").strip()
    why = str(result.get("why") or "").strip()
    if not headline or not why:
        raise LLMError("code_effect reply has no headline or why")
    paths = [f["path"] for f in (changes or {}).get("files") or []]
    by_name: dict[str, list[str]] = {}
    for path in paths:
        by_name.setdefault(PurePosixPath(path).name, []).append(path)

    def resolve(name: Any) -> Optional[str]:
        name = str(name).strip().strip("`")
        if name in paths:
            return name
        matches = by_name.get(PurePosixPath(name).name) or []
        return matches[0] if len(matches) == 1 else None

    links = []
    for item in result.get("links") or []:
        if not isinstance(item, dict) or not str(item.get("code") or "").strip() or not str(item.get("effect") or "").strip():
            continue
        files = [p for p in (resolve(f) for f in item.get("files") or []) if p]
        links.append({"code": str(item["code"]).strip(), "files": list(dict.fromkeys(files)), "effect": str(item["effect"]).strip()})
    return {
        "change_summary": str(result.get("change_summary") or "").strip() or (changes or {}).get("summary") or "",
        "headline": headline,
        "links": links[:MAX_LINKS],
        "why": why,
    }


def explain(
    verdict: dict[str, Any],
    spec: dict[str, Any],
    claim: dict[str, Any],
    changes: Optional[dict[str, Any]],
    patch: Optional[str],
    llm: Optional[LLMClient],
    analysis: Optional[dict[str, Any]] = None,
    tuning: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """The "why this result" block stored as ``verdict.details['code_effect']``."""
    fact = facts(verdict, spec)
    text = None
    model = None
    if llm is not None and (changes or fact["outcome"] != "unknown"):
        payload = {
            "technique": claim.get("technique"),
            "paper": claim.get("paper_title"),
            "flag": spec.get("flag_name"),
            "primary_metric": {"id": fact["metric"], "plain": fact["metric_label"], "note": "change_pct > 0 means better"},
            "facts": {"overall_outcome": fact["outcome"], "checks": [_compact_check(c) for c in fact["checks"]]},
            "analyst_diagnosis": {"diagnosis": (analysis or {}).get("diagnosis"), "summary": (analysis or {}).get("summary")}
            if analysis
            else None,
            "tuned_method_config": (tuning or {}).get("variant") or None,
            "changed_files": [
                {k: f.get(k) for k in ("path", "status", "kind", "additions", "deletions")} for f in (changes or {}).get("files") or []
            ][:60]
            or None,
            "diff_excerpt": excerpt(changes or {}, patch) or "(the diff is not available)",
        }
        try:
            text = _clean_llm(
                llm.generate_json(EFFECT_SYSTEM, json.dumps(payload, default=str), "code_effect", EFFECT_SCHEMA), changes
            )
            model = llm.model
        except LLMError as exc:
            logger.warning("Code-effect explanation failed, using the rule-based text: %s", exc)
        except Exception as exc:  # noqa: BLE001 - never let the explanation break judging
            logger.warning("Code-effect explanation crashed, using the rule-based text: %s", exc)
    if text is None:
        text = rule_based(fact, changes, spec.get("flag_name"))
    return {
        **fact,
        **text,
        "notes": notes(fact, changes),
        "iteration": (changes or {}).get("iteration"),
        "head": (changes or {}).get("head"),
        "files_changed": (changes or {}).get("files_changed"),
        "additions": (changes or {}).get("additions"),
        "deletions": (changes or {}).get("deletions"),
        "source": "llm" if model else "rules",
        "model": model,
        "generated_at": datetime.now(UTC).isoformat(),
    }
