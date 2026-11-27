"""Phase 5a — Judge: paired deltas, bootstrap CI, verdict vs the paper's claim."""

from __future__ import annotations

from typing import Any, Optional

import numpy as np

VERDICTS = ("reproduced", "partial", "not_reproduced", "regression", "inconclusive")
REPRODUCED_FRACTION_OF_CLAIM = 0.7
MIN_PAIRS = 3
SAMPLE_COUNT_KEYS = ("n", "samples", "count")


def improvement_pct(baseline: float, variant: float, direction: str) -> Optional[float]:
    if baseline is None or variant is None or baseline == 0:
        return None
    change = (variant - baseline) / abs(baseline) * 100.0
    return change if direction == "higher_is_better" else -change


def bootstrap_median_ci(
    values: list[float], resamples: int = 5000, seed: int = 0
) -> tuple[Optional[float], Optional[float]]:
    data = np.asarray(values, dtype=float)
    if len(data) < 2:
        return None, None
    rng = np.random.default_rng(seed)
    medians = np.median(rng.choice(data, size=(resamples, len(data)), replace=True), axis=1)
    low, high = np.percentile(medians, [2.5, 97.5])
    return float(low), float(high)


def _arm(results: dict[str, Any], arm: str) -> list[dict[str, Any]]:
    return [r for r in results.get("rounds") or [] if r.get("arm") == arm]


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and bool(np.isfinite(value))


def paired_deltas(results: dict[str, Any], metric: str, direction: str) -> list[float]:
    baseline = [(r.get("metrics") or {}).get(metric) for r in _arm(results, "baseline")]
    variant = [(r.get("metrics") or {}).get(metric) for r in _arm(results, "variant")]
    deltas = [improvement_pct(b, v, direction) for b, v in zip(baseline, variant) if _finite(b) and _finite(v)]
    return [d for d in deltas if d is not None and np.isfinite(d)]


def arm_problems(results: dict[str, Any], spec: dict[str, Any]) -> list[str]:
    """Structural problems that make the paired comparison unreliable (unequal or missing rounds)."""
    n_base, n_var = len(_arm(results, "baseline")), len(_arm(results, "variant"))
    problems = []
    if n_base != n_var:
        problems.append(f"unequal arms: {n_base} baseline vs {n_var} variant rounds")
    expected = spec.get("rounds")
    if expected and (n_base != expected or n_var != expected):
        problems.append(f"expected {expected} rounds per arm, got {n_base} baseline / {n_var} variant")
    if not problems and n_base < MIN_PAIRS:
        problems.append(f"only {n_base} A/B pairs (need at least {MIN_PAIRS})")
    return problems


def required_quality_metrics(spec: dict[str, Any], profile: dict[str, Any]) -> list[str]:
    guardrails = spec.get("guardrails") or {}
    names = [m.get("name") if isinstance(m, dict) else str(m) for m in profile.get("quality_metrics") or []]
    if guardrails.get("max_exact_match_drop", 0.02) is not None:
        names.append("exact_match")
    if guardrails.get("min_output_agreement") is not None:
        names.append("output_agreement")
    return list(dict.fromkeys(n for n in names if n))


def missing_quality(quality: dict[str, Any], required: list[str]) -> list[str]:
    """Required quality measurements that are absent, non-finite or based on zero samples (fail closed)."""
    if not quality:
        return ["no quality measurements in the results"]
    arms = {arm: quality.get(arm) if isinstance(quality.get(arm), dict) else {} for arm in ("baseline", "variant")}
    problems = []
    for arm, values in arms.items():
        for key in SAMPLE_COUNT_KEYS:
            if key in values and not (_finite(values[key]) and values[key] > 0):
                problems.append(f"{arm} quality has no samples ({key}={values[key]!r})")
    for name in required:
        if name in quality:
            if not _finite(quality[name]):
                problems.append(f"quality metric '{name}' is not a finite number ({quality[name]!r})")
            continue
        bad = [arm for arm, values in arms.items() if not _finite(values.get(name))]
        if bad:
            problems.append(f"quality metric '{name}' missing or non-finite for {'/'.join(bad)}")
    return problems


def metric_directions(profile: dict[str, Any]) -> dict[str, str]:
    return {
        m["name"]: "lower_is_better" if "lower" in str(m.get("direction")) else "higher_is_better"
        for m in profile.get("metrics") or []
        if m.get("name")
    }


def evaluate(results: dict[str, Any], spec: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    """Verdict for one A/B run against the spec's claimed gain and success threshold."""
    directions = metric_directions(profile)
    primary = spec["primary_metric"]
    structural = arm_problems(results, spec)
    per_metric = {}
    for metric, direction in directions.items():
        deltas = [] if structural else paired_deltas(results, metric, direction)
        if not deltas:
            continue
        low, high = bootstrap_median_ci(deltas)
        base = [(r.get("metrics") or {}).get(metric) for r in _arm(results, "baseline")]
        var = [(r.get("metrics") or {}).get(metric) for r in _arm(results, "variant")]
        per_metric[metric] = {
            "direction": direction,
            "baseline_median": float(np.median([v for v in base if _finite(v)])),
            "variant_median": float(np.median([v for v in var if _finite(v)])),
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
    max_em_drop = guardrails.get("max_exact_match_drop", 0.02)
    if max_em_drop is not None and _finite(base_em) and _finite(var_em) and var_em < base_em - max_em_drop:
        problems.append(f"exact_match dropped from {base_em:.3f} to {var_em:.3f}")
    agreement = quality.get("output_agreement")
    min_agreement = guardrails.get("min_output_agreement")
    if min_agreement is not None and _finite(agreement) and agreement < min_agreement:
        problems.append(f"output agreement {agreement:.2f} < required {min_agreement:.2f} (technique should be lossless)")
    memory = per_metric.get("peak_memory_gb")
    max_mem = guardrails.get("max_peak_memory_increase_pct", 15.0)
    if memory and primary != "peak_memory_gb" and -memory["median_improvement_pct"] > max_mem:
        problems.append(f"peak memory increased {-memory['median_improvement_pct']:.1f}% (> {max_mem}%)")
    unmeasured = missing_quality(quality, required_quality_metrics(spec, profile))

    claimed = spec.get("claimed_gain_pct")
    threshold = float(spec.get("success_threshold_pct") or 0.0)
    stats = per_metric.get(primary)
    median = low = high = None
    if stats is not None:
        median, low, high = stats["median_improvement_pct"], stats["ci_low_pct"], stats["ci_high_pct"]
    expected_pairs = len(_arm(results, "baseline"))
    target = max(threshold, REPRODUCED_FRACTION_OF_CLAIM * claimed) if claimed else threshold
    if structural:
        verdict, reason = "inconclusive", "; ".join(structural)
    elif problems:
        verdict, reason = "regression", "; ".join(problems)
    elif stats is None:
        verdict, reason = "inconclusive", f"primary metric '{primary}' missing from results"
    elif stats["pairs"] < expected_pairs or low is None or high is None:
        verdict, reason = "inconclusive", f"{primary} measured in only {stats['pairs']} of {expected_pairs} A/B pairs"
    elif unmeasured:
        verdict, reason = "inconclusive", "quality not measured: " + "; ".join(unmeasured)
    else:
        if high < 0:
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
        "target_pct": target,
        "quality_ok": not problems and not unmeasured,
        "worth_adopting": verdict in ("reproduced", "partial") and median is not None and median >= threshold,
        "per_metric": per_metric,
        "quality": quality,
        "quality_problems": problems + unmeasured,
        "measurement_problems": structural,
        "environment": results.get("environment"),
        "model": results.get("model"),
        "workload": results.get("workload"),
    }


def mechanism_table(results: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    """The technique's counters per arm, normalised per 1k generated tokens, next to the paper's values."""
    flag = spec.get("flag_name")
    mechanism = results.get("mechanism") or {}
    expected = {m["name"]: m for m in spec.get("mechanism") or [] if m.get("name")}

    def arm(name: str) -> tuple[dict[str, float], int]:
        data = mechanism.get(name) or {}
        return ((data.get("techniques") or {}).get(flag) or {}), int(data.get("tokens") or 0)

    def rounds(name: str) -> Optional[int]:
        value = (mechanism.get(name) or {}).get("rounds")
        return int(value) if isinstance(value, (int, float)) else None

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
    return {
        "rows": rows,
        "missing": missing,
        "measured": bool(expected) and not missing,
        "tokens": {"baseline": base_tokens, "variant": var_tokens},
        "rounds": {"baseline": rounds("baseline"), "variant": rounds("variant")},
    }


ADOPTION_VERDICTS = {"reproduced": "worth_adopting", "partial": "small_gain"}


def judge(
    results: dict[str, Any],
    spec: dict[str, Any],
    profile: dict[str, Any],
    adopt_results: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Claim verdict from the claim check (the paper's baseline, a paper-like workload) and, when it ran separately,
    an adoption verdict (the method vs the project's default on the project's workload)."""
    verdict = evaluate(results, spec, profile)
    verdict["comparison"] = results.get("comparison") or {"kind": "claim", "baseline": "project default"}
    verdict["mechanism"] = mechanism_table(results, spec)
    verdict["adoption"] = None
    if adopt_results:
        adopt = evaluate(adopt_results, {**spec, "claimed_gain_pct": None}, profile)
        verdict["adoption"] = {
            "verdict": ADOPTION_VERDICTS.get(adopt["verdict"], adopt["verdict"]),
            "reason": adopt["reason"],
            "median_delta_pct": adopt["median_delta_pct"],
            "ci_low_pct": adopt["ci_low_pct"],
            "ci_high_pct": adopt["ci_high_pct"],
            "quality_ok": adopt["quality_ok"],
            "quality_problems": adopt["quality_problems"],
            "workload": adopt_results.get("workload"),
            "per_metric": adopt["per_metric"],
            "mechanism": mechanism_table(adopt_results, spec),
        }
        verdict["worth_adopting"] = verdict["adoption"]["verdict"] == "worth_adopting"
    return verdict
