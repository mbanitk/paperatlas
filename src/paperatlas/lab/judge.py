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


def judge(results: dict[str, Any], spec: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    directions = metric_directions(profile)
    primary = spec["primary_metric"]
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

    quality = results.get("quality") or {}
    guardrails = spec.get("guardrails") or {}
    problems = []
    base_em = (quality.get("baseline") or {}).get("exact_match")
    var_em = (quality.get("variant") or {}).get("exact_match")
    if base_em is not None and var_em is not None and var_em < base_em - guardrails.get("max_exact_match_drop", 0.02):
        problems.append(f"exact_match dropped from {base_em:.3f} to {var_em:.3f}")
    agreement = quality.get("output_agreement")
    min_agreement = guardrails.get("min_output_agreement")
    if min_agreement is not None and agreement is not None and agreement < min_agreement:
        problems.append(f"output agreement {agreement:.2f} < required {min_agreement:.2f} (technique should be lossless)")
    memory = per_metric.get("peak_memory_gb")
    max_mem = guardrails.get("max_peak_memory_increase_pct", 15.0)
    if memory and primary != "peak_memory_gb" and -memory["median_improvement_pct"] > max_mem:
        problems.append(f"peak memory increased {-memory['median_improvement_pct']:.1f}% (> {max_mem}%)")

    claimed = spec.get("claimed_gain_pct")
    threshold = float(spec.get("success_threshold_pct") or 0.0)
    stats = per_metric.get(primary)
    if stats is None:
        verdict, reason = "not_reproduced", f"primary metric '{primary}' missing from results"
        median = low = high = None
    else:
        median, low, high = stats["median_improvement_pct"], stats["ci_low_pct"], stats["ci_high_pct"]
        target = max(threshold, REPRODUCED_FRACTION_OF_CLAIM * claimed) if claimed else threshold
        if problems:
            verdict, reason = "regression", "; ".join(problems)
        elif high < 0:
            verdict, reason = "regression", f"{primary} got worse (95% CI {low:+.1f}% to {high:+.1f}%)"
        elif low <= 0:
            verdict, reason = "not_reproduced", f"no significant change in {primary} (95% CI includes 0)"
        elif median >= target:
            verdict, reason = "reproduced", f"{primary} improved {median:+.1f}% (target ≥ {target:.1f}%)"
        else:
            verdict, reason = "partial", f"{primary} improved {median:+.1f}%, below target {target:.1f}%"

    return {
        "verdict": verdict,
        "reason": reason,
        "primary_metric": primary,
        "median_delta_pct": median,
        "ci_low_pct": low,
        "ci_high_pct": high,
        "claimed_gain_pct": claimed,
        "success_threshold_pct": threshold,
        "quality_ok": not problems,
        "worth_adopting": verdict in ("reproduced", "partial") and median is not None and median >= threshold,
        "per_metric": per_metric,
        "quality": quality,
        "quality_problems": problems,
        "environment": results.get("environment"),
        "model": results.get("model"),
        "workload": results.get("workload"),
    }
