"""Phase 5a — Judge: paired deltas, bootstrap CI, verdict vs the paper's claim."""

from __future__ import annotations

from typing import Any, Optional

import numpy as np

VERDICTS = ("reproduced", "partial", "not_reproduced", "regression")
REPRODUCED_FRACTION_OF_CLAIM = 0.7


def improvement_pct(baseline: float, variant: float, direction: str) -> Optional[float]:
    if baseline is None or variant is None or baseline == 0:
        return None
    change = (variant - baseline) / abs(baseline) * 100.0
    return change if direction == "higher_is_better" else -change


def bootstrap_median_ci(values: list[float], resamples: int = 5000, seed: int = 0) -> tuple[float, float]:
    data = np.asarray(values, dtype=float)
    if len(data) == 1:
        return float(data[0]), float(data[0])
    rng = np.random.default_rng(seed)
    medians = np.median(rng.choice(data, size=(resamples, len(data)), replace=True), axis=1)
    low, high = np.percentile(medians, [2.5, 97.5])
    return float(low), float(high)


def paired_deltas(results: dict[str, Any], metric: str, direction: str) -> list[float]:
    baseline = [r["metrics"].get(metric) for r in results["rounds"] if r["arm"] == "baseline"]
    variant = [r["metrics"].get(metric) for r in results["rounds"] if r["arm"] == "variant"]
    deltas = [improvement_pct(b, v, direction) for b, v in zip(baseline, variant)]
    return [d for d in deltas if d is not None and np.isfinite(d)]


def metric_directions(profile: dict[str, Any]) -> dict[str, str]:
    return {
        m["name"]: "lower_is_better" if "lower" in str(m.get("direction")) else "higher_is_better"
        for m in profile.get("metrics") or []
        if m.get("name")
    }


def _per_metric(results: dict[str, Any], directions: dict[str, str]) -> dict[str, dict[str, Any]]:
    per_metric = {}
    for metric, direction in directions.items():
        deltas = paired_deltas(results, metric, direction)
        if not deltas:
            continue
        low, high = bootstrap_median_ci(deltas)
        base = [r["metrics"].get(metric) for r in results["rounds"] if r["arm"] == "baseline"]
        var = [r["metrics"].get(metric) for r in results["rounds"] if r["arm"] == "variant"]
        per_metric[metric] = {
            "direction": direction,
            "baseline_median": float(np.median([v for v in base if v is not None])),
            "variant_median": float(np.median([v for v in var if v is not None])),
            "median_improvement_pct": float(np.median(deltas)),
            "ci_low_pct": low,
            "ci_high_pct": high,
            "pairs": len(deltas),
            "deltas": deltas,
        }
    return per_metric


def _quality_problems(results: dict[str, Any], spec: dict[str, Any], per_metric: dict[str, Any]) -> list[str]:
    quality = results.get("quality") or {}
    guardrails = spec.get("guardrails") or {}
    problems = []
    base_em = (quality.get("baseline") or {}).get("exact_match")
    var_em = (quality.get("variant") or {}).get("exact_match")
    if base_em is None or var_em is None:
        problems.append("the quality set was not measured for both arms")
    elif var_em < base_em - guardrails.get("max_exact_match_drop", 0.02):
        problems.append(f"exact_match dropped from {base_em:.3f} to {var_em:.3f}")
    agreement = quality.get("output_agreement")
    min_agreement = guardrails.get("min_output_agreement")
    if min_agreement is not None:
        if agreement is None:
            problems.append("output agreement was not measured (technique should be lossless)")
        elif agreement < min_agreement:
            problems.append(f"output agreement {agreement:.2f} < required {min_agreement:.2f} (technique should be lossless)")
    memory = per_metric.get("peak_memory_gb")
    max_mem = guardrails.get("max_peak_memory_increase_pct", 15.0)
    if memory and spec.get("primary_metric") != "peak_memory_gb" and -memory["median_improvement_pct"] > max_mem:
        problems.append(f"peak memory increased {-memory['median_improvement_pct']:.1f}% (> {max_mem}%)")
    return problems


def _arm_counts(results: dict[str, Any]) -> tuple[int, int]:
    arms = [r.get("arm") for r in results.get("rounds") or []]
    return arms.count("baseline"), arms.count("variant")


def _decide(stats: Optional[dict[str, Any]], primary: str, problems: list[str], target: float) -> tuple[str, str]:
    if stats is None:
        return "not_reproduced", f"primary metric '{primary}' missing from results"
    median, low, high = stats["median_improvement_pct"], stats["ci_low_pct"], stats["ci_high_pct"]
    if problems:
        return "regression", "; ".join(problems)
    if stats["pairs"] < 2:
        return "not_reproduced", f"only {stats['pairs']} paired round(s) — not enough to estimate an effect"
    if high < 0:
        return "regression", f"{primary} got worse (95% CI {low:+.1f}% to {high:+.1f}%)"
    if low <= 0:
        return "not_reproduced", f"no significant change in {primary} (95% CI includes 0)"
    if median >= target:
        return "reproduced", f"{primary} improved {median:+.1f}% (target ≥ {target:.1f}%)"
    return "partial", f"{primary} improved {median:+.1f}%, below target {target:.1f}%"


def mechanism_table(results: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    """The technique's counters per arm, normalised per 1k generated tokens, next to the paper's values."""
    flag = spec.get("flag_name")
    mechanism = results.get("mechanism") or {}
    expected = {m["name"]: m for m in spec.get("mechanism") or [] if m.get("name")}

    def arm(name: str) -> tuple[dict[str, float], int]:
        data = mechanism.get(name) or {}
        return ((data.get("techniques") or {}).get(flag) or {}), int(data.get("tokens") or 0)

    (base, base_tokens), (var, var_tokens) = arm("baseline"), arm("variant")
    names = list(expected) + sorted((set(base) | set(var)) - set(expected))
    rows = []
    for name in names:
        b, v = base.get(name), var.get(name)
        b_rate = b / base_tokens * 1000 if b is not None and base_tokens else None
        v_rate = v / var_tokens * 1000 if v is not None and var_tokens else None
        change = (v_rate - b_rate) / b_rate * 100 if b_rate and v_rate is not None else None
        meta = expected.get(name) or {}
        rows.append(
            {
                "name": name,
                "meaning": meta.get("meaning"),
                "paper_value": meta.get("paper_value"),
                "expected": name in expected,
                "baseline_total": b,
                "variant_total": v,
                "baseline_per_1k_tokens": b_rate,
                "variant_per_1k_tokens": v_rate,
                "change_pct": change,
            }
        )
    missing = [n for n in expected if var.get(n) is None]
    return {"rows": rows, "missing": missing, "measured": bool(expected) and not missing, "tokens": {"baseline": base_tokens, "variant": var_tokens}}


def judge(
    results: dict[str, Any],
    spec: dict[str, Any],
    profile: dict[str, Any],
    adopt_results: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Claim verdict from the claim check (paper baseline, paper regime) and, when it ran separately,
    an adoption verdict (vs the project's default on the project's workload)."""
    directions = metric_directions(profile)
    primary = spec["primary_metric"]
    per_metric = _per_metric(results, directions)
    problems = _quality_problems(results, spec, per_metric)
    n_base, n_var = _arm_counts(results)
    if n_base != n_var:
        problems.append(f"unequal rounds per arm (baseline {n_base}, variant {n_var})")

    claimed = spec.get("claimed_gain_pct")
    threshold = float(spec.get("success_threshold_pct") or 0.0)
    stats = per_metric.get(primary)
    target = max(threshold, REPRODUCED_FRACTION_OF_CLAIM * claimed) if claimed else threshold
    verdict, reason = _decide(stats, primary, problems, target)
    median = stats["median_improvement_pct"] if stats else None
    low = stats["ci_low_pct"] if stats else None
    high = stats["ci_high_pct"] if stats else None

    adoption = None
    if adopt_results:
        adopt_metrics = _per_metric(adopt_results, directions)
        adopt_problems = _quality_problems(adopt_results, spec, adopt_metrics)
        adopt_stats = adopt_metrics.get(primary)
        adopt_verdict, adopt_reason = _decide(adopt_stats, primary, adopt_problems, threshold)
        adoption = {
            "verdict": {"reproduced": "worth_adopting", "partial": "small_gain"}.get(adopt_verdict, adopt_verdict),
            "reason": adopt_reason,
            "median_delta_pct": adopt_stats["median_improvement_pct"] if adopt_stats else None,
            "ci_low_pct": adopt_stats["ci_low_pct"] if adopt_stats else None,
            "ci_high_pct": adopt_stats["ci_high_pct"] if adopt_stats else None,
            "quality_ok": not adopt_problems,
            "quality_problems": adopt_problems,
            "workload": adopt_results.get("workload"),
            "per_metric": adopt_metrics,
            "mechanism": mechanism_table(adopt_results, spec),
        }
        worth = adoption["verdict"] == "worth_adopting"
    else:
        worth = verdict in ("reproduced", "partial") and median is not None and median >= threshold

    return {
        "verdict": verdict,
        "reason": reason,
        "primary_metric": primary,
        "median_delta_pct": median,
        "ci_low_pct": low,
        "ci_high_pct": high,
        "claimed_gain_pct": claimed,
        "success_threshold_pct": threshold,
        "target_pct": target,
        "quality_ok": not problems,
        "worth_adopting": worth,
        "per_metric": per_metric,
        "quality": results.get("quality") or {},
        "quality_problems": problems,
        "comparison": results.get("comparison") or {"kind": "claim", "baseline": "project default"},
        "mechanism": mechanism_table(results, spec),
        "adoption": adoption,
        "environment": results.get("environment"),
        "model": results.get("model"),
        "workload": results.get("workload"),
    }
