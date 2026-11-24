"""Predict before you build: estimate what a technique can gain on *this* engine and hardware.

Papers report gains in their own regime (usually a bandwidth- or compute-bound NVIDIA GPU). Whether a technique pays
off here depends on where this engine spends its time, which the target project measures with `commands.profile`
(a roofline: decode speed vs the memory-bandwidth limit, the cost of one forward pass for 1..16 new tokens, batched
decode throughput, the draft model's cost). This module turns that profile plus a claim card into a predicted gain
range, the bottleneck it relies on, and a likelihood (likely / marginal / unlikely / unknown).

The estimates are deliberately simple and explainable (each prediction lists its reasons); they rank and filter
claims and give the planner a realistic success bar, they do not replace the A/B measurement.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Optional

LIKELY_GAIN_PCT = 5.0
UNLIKELY_GAIN_PCT = 2.0
DEFAULT_ACCEPTANCE = 0.7  # per-token draft acceptance when the paper reports none (typical for chat/code/math)

SELF_DRAFT = re.compile(r"prompt[- ]lookup|n-?gram|lookahead|jacobi|retriev|suffix|copy", re.I)
HEAD_DRAFT = re.compile(r"\bmtp\b|multi-?token|medusa|eagle|hydra|draft head|self-?specul|layer[- ]skip|early[- ]exit", re.I)
LONG_CONTEXT = re.compile(r"(\d+(?:\.\d+)?)\s*([kK])\b|(\d{4,6})\s*(?:-?token|tok)", re.I)
TAU = re.compile(r"(?:acceptance length|τ|tau)[^0-9]{0,20}(\d+(?:\.\d+)?)", re.I)


def bottleneck(roofline: dict[str, Any]) -> str:
    utilization = (roofline.get("decode") or {}).get("bandwidth_utilization")
    if utilization is None:
        return "unknown"
    if utilization >= 0.6:
        return "bandwidth"
    if utilization < 0.4:
        return "overhead"
    return "mixed"


def forward_ms(roofline: dict[str, Any], tokens: int) -> Optional[float]:
    """Cost of one forward pass that appends `tokens` tokens, interpolated from the measured curve."""
    curve = {int(k): float(v) for k, v in (roofline.get("forward_cost_ms") or {}).items() if v}
    if not curve:
        ms = (roofline.get("decode") or {}).get("ms_per_token")
        return float(ms) if ms else None
    points = sorted(curve.items())
    if tokens <= points[0][0]:
        return points[0][1]
    for (n0, c0), (n1, c1) in zip(points, points[1:]):
        if n0 <= tokens <= n1:
            return c0 + (c1 - c0) * (tokens - n0) / (n1 - n0)
    (n0, c0), (n1, c1) = points[-2:] if len(points) > 1 else (points[0], points[0])
    slope = (c1 - c0) / (n1 - n0) if n1 != n0 else 0.0
    return c1 + slope * (tokens - n1)


def _context_tokens(text: str) -> int:
    best = 0
    for match in LONG_CONTEXT.finditer(text or ""):
        if match.group(1):
            best = max(best, int(float(match.group(1)) * 1000))
        elif match.group(3):
            best = max(best, int(match.group(3)))
    return best


def _paper_acceptance(card: dict[str, Any], text: str) -> Optional[float]:
    """Per-token acceptance implied by a reported acceptance length τ (tokens per verification) with block k≈τ+1."""
    for effect in card.get("effects") or []:
        blob = f"{effect.get('metric', '')} {effect.get('conditions', '')}"
        if re.search(r"acceptance (length|rate)|τ", blob, re.I) and effect.get("value") and not effect.get("relative"):
            value = float(effect["value"])
            if 0 < value < 1:
                return value
            if value >= 1:
                return min(0.95, 1 - 1 / (value + 1))
    match = TAU.search(text)
    if match:
        tau = float(match.group(1))
        if tau >= 1:
            return min(0.95, 1 - 1 / (tau + 1))
    return None


def _spec_speedup(target_ms: float, verify_ms: Callable[[int], Optional[float]], draft_ms: float, acceptance: float) -> tuple[float, int]:
    best, best_k = 0.0, 1
    for k in (1, 2, 3, 4, 6, 8, 12, 16):
        expected = (1 - acceptance ** (k + 1)) / (1 - acceptance) if acceptance < 1 else k + 1
        cost = k * draft_ms + (verify_ms(k + 1) or target_ms)
        speedup = expected * target_ms / cost
        if speedup > best:
            best, best_k = speedup, k
    return best, best_k


def _result(likelihood: str, low: Optional[float], high: Optional[float], relies_on: str, reasons: list[str],
            roofline: dict[str, Any], metric: Optional[str] = None, **extra: Any) -> dict[str, Any]:
    if low is not None and high is not None and low > high:
        low, high = high, low
    return {
        "likelihood": likelihood,
        "predicted_gain_pct": None if low is None else {"low": round(low, 1), "high": round(high, 1)},
        "metric": metric,
        "relies_on": relies_on,
        "bottleneck": bottleneck(roofline),
        "reasons": reasons,
        **extra,
    }


def _likelihood(high: float, low: float) -> str:
    if high < UNLIKELY_GAIN_PCT:
        return "unlikely"
    if low >= LIKELY_GAIN_PCT:
        return "likely"
    return "marginal"


def predict(claim: dict[str, Any], roofline: Optional[dict[str, Any]], workloads: Optional[list[str]] = None) -> dict[str, Any]:
    """Predicted gain of a claim on the profiled engine. `claim` needs category/technique/card (a claim dict)."""
    if not roofline:
        return {"likelihood": "unknown", "predicted_gain_pct": None, "reasons": ["no roofline profile measured yet"],
                "relies_on": None, "bottleneck": "unknown", "metric": None}
    card = claim.get("card") or {}
    category = claim.get("category") or card.get("category") or "other"
    text = " ".join(
        str(x or "")
        for x in (claim.get("technique"), claim.get("change_required"), claim.get("name"), card.get("technique"))
    )
    setup = card.get("paper_setup") or {}
    decode = roofline.get("decode") or {}
    utilization = decode.get("bandwidth_utilization")
    target_ms = forward_ms(roofline, 1) or decode.get("ms_per_token")
    kind = bottleneck(roofline)
    reasons: list[str] = []
    if utilization is not None:
        reasons.append(
            f"engine decodes at {decode.get('tokens_per_s', 0):.0f} tok/s = {utilization:.0%} of the memory-bandwidth limit ({kind}-bound)"
        )

    if category == "speculative_decoding" and target_ms:
        def verify(n: int) -> Optional[float]:
            return forward_ms(roofline, n)

        draft = roofline.get("draft") or {}
        if SELF_DRAFT.search(text):
            draft_ms, source = 0.02 * target_ms, "draft-free (lookup) proposals"
        elif HEAD_DRAFT.search(text):
            draft_ms, source = 0.12 * target_ms, "light draft heads (assumed ~12% of a target step)"
        else:
            draft_ms = float(draft.get("ms_per_token") or 0.25 * target_ms)
            source = f"draft model {draft.get('id') or ''} at {draft_ms:.1f} ms/token"
        measured = (roofline.get("measured") or {}).get("draft_acceptance")
        uses_draft_model = not SELF_DRAFT.search(text) and not HEAD_DRAFT.search(text)
        if uses_draft_model and measured:
            acceptance = float(measured)
            reasons.append(f"measured acceptance of this engine's draft model: {acceptance:.2f} per token")
        else:
            acceptance = _paper_acceptance(card, text) or DEFAULT_ACCEPTANCE
        verify_ratio = (verify(5) or target_ms) / target_ms
        reasons += [
            f"one target step {target_ms:.1f} ms; verifying 5 tokens costs {verify_ratio:.2f}× a step",
            f"drafting: {source}; per-token acceptance assumed {acceptance:.2f}",
        ]
        mid, k = _spec_speedup(target_ms, verify, draft_ms, acceptance)
        low, _ = _spec_speedup(target_ms, verify, draft_ms, max(0.3, acceptance - 0.15))
        high, _ = _spec_speedup(target_ms, verify, draft_ms, min(0.95, acceptance + 0.1))
        reasons.append(f"best block size ≈ {k}: speculative decoding ≈ {mid:.2f}× plain decoding here")
        baselines = " ".join(str(e.get("baseline") or "") for e in card.get("effects") or [])
        incremental = re.search(r"specul|draft|eagle|medusa|underlying|without (?:the )?(?:loop|method|technique)", baselines, re.I)
        if incremental:
            reasons.append("the paper's gain is incremental over another speculative decoder: it inherits this ceiling")
        return _result(_likelihood((high - 1) * 100, (low - 1) * 100), (low - 1) * 100, (high - 1) * 100,
                       "cheap drafting relative to a target step + verification cost that grows slowly with tokens",
                       reasons, roofline, "decode_tokens_per_s", best_block_size=k, acceptance=acceptance)

    if category == "batching_scheduling":
        batch = {int(k): float(v) for k, v in (roofline.get("batch_decode_tokens_per_s") or {}).items() if v}
        if "continuous_batching" in (roofline.get("baseline_features") or []):
            reasons.append("the baseline server already batches concurrent requests; only the scheduling policy "
                           "on top of it can add gains")
            return _result("marginal", 0.0, 10.0, "better ordering/admission than the built-in batcher", reasons,
                           roofline, "throughput_tokens_per_s")
        concurrent = any("concurrent" in w for w in workloads or [])
        if batch.get(1) and len(batch) > 1:
            top = max(batch)
            gain = (batch[top] / batch[1] - 1) * 100
            reasons.append(f"batched decode: {batch[1]:.0f} → {batch[top]:.0f} tok/s at batch {top} (+{gain:.0f}% throughput headroom)")
            if not concurrent:
                reasons.append("no concurrent workload in the project; per-request latency gains will be small")
            return _result(_likelihood(gain, gain * 0.3), gain * 0.3, gain, "unused batch parallelism under concurrency",
                           reasons, roofline, "throughput_tokens_per_s")
        return _result("unknown", None, None, "batch parallelism", reasons + ["batched decode was not profiled"], roofline)

    paper_context = max(_context_tokens(str(setup.get("sequence_length") or "")), _context_tokens(text))
    if category in ("kv_cache", "memory_management", "attention_kernels"):
        long_workload = any("long" in w for w in workloads or [])
        if paper_context >= 8000 and not long_workload:
            reasons.append(f"the paper's effect appears at ~{paper_context // 1000}k-token contexts; project workloads are short")
            return _result("marginal", 0.0, 3.0, "long contexts where KV/attention traffic rivals weight traffic", reasons,
                           roofline, "peak_memory_gb", note="add a long-context workload to test this faithfully")
        if kind == "overhead":
            reasons.append("decode is overhead-bound, so reducing KV/attention bytes barely changes speed; memory can still drop")
            return _result("marginal", 0.0, 4.0, "KV/attention memory traffic", reasons, roofline, "peak_memory_gb")
        if kind == "bandwidth":
            reasons.append("decode is bandwidth-bound: fewer KV/attention bytes per token can speed up long-context decoding")
            return _result("likely" if paper_context >= 2000 else "marginal", 2.0, 15.0, "KV/attention memory traffic",
                           reasons, roofline)
        reasons.append("decode is only partly bandwidth-bound; KV/attention savings mostly show at long contexts")
        return _result("marginal", 0.0, 8.0, "KV/attention memory traffic", reasons, roofline)

    if category == "quantization":
        quant = str((roofline.get("model") or {}).get("quantization") or "")
        unsupported = re.search(r"\bfp[468]\b|e[2-5]m[0-3]|mxfp|nvfp|microscal|tensor core|fp8", text, re.I)
        chip = str((roofline.get("hardware") or {}).get("chip") or "")
        if unsupported and "apple" in chip.lower():
            reasons.append(f"relies on low-precision number formats ({unsupported.group(0)}) that the Apple GPU has no "
                           "native math for; emulating them costs more than it saves")
            return _result("unlikely", -5.0, 1.0, "hardware support for the number format", reasons, roofline)
        if re.search(r"\b[234]\s*-?bit|int4|fp4|nf4", quant, re.I) and not re.search(r"kv|cache|activation", text, re.I):
            reasons.append(f"weights are already {quant}; further weight quantization saves little bandwidth")
            return _result("unlikely", -2.0, 1.5, "fewer weight bytes per token", reasons, roofline)
        if kind == "overhead":
            reasons.append("overhead-bound: fewer bytes per token won't speed up decode much")
            return _result("marginal", 0.0, 5.0, "fewer bytes per token", reasons, roofline)
        return _result("likely", 5.0, 30.0, "fewer bytes per token", reasons, roofline)

    if category in ("routing_load_balancing", "disaggregated_serving", "parallelism_communication"):
        reasons.append("single machine, single model: multi-replica routing/parallelism has nothing to act on")
        return _result("unlikely", 0.0, 1.0, "multiple replicas or devices", reasons, roofline)

    if category in ("observability", "evaluation_quality", "cost_energy"):
        reasons.append("not a speed technique; measure it on its own metric")
        return _result("unknown", None, None, "n/a", reasons, roofline)

    return _result("unknown", None, None, "unclear", reasons + ["no cost model for this category"], roofline)


def score_factor(prediction: Optional[dict[str, Any]]) -> float:
    return {"likely": 1.4, "marginal": 0.8, "unlikely": 0.2}.get((prediction or {}).get("likelihood"), 1.0)


def blocker(prediction: Optional[dict[str, Any]]) -> Optional[str]:
    if (prediction or {}).get("likelihood") != "unlikely":
        return None
    gain = prediction.get("predicted_gain_pct") or {}
    why = "; ".join(prediction.get("reasons") or [])[-240:]
    return f"cost model: at most {gain.get('high', 0):+.1f}% on this engine ({why})"


def summarize(roofline: Optional[dict[str, Any]]) -> Optional[str]:
    if not roofline:
        return None
    decode = roofline.get("decode") or {}
    curve = roofline.get("forward_cost_ms") or {}
    draft = roofline.get("draft") or {}
    parts = [
        f"decode {decode.get('tokens_per_s', 0):.0f} tok/s ({(decode.get('bandwidth_utilization') or 0):.0%} of bandwidth, {bottleneck(roofline)}-bound)",
        "forward cost " + ", ".join(f"{k} tok {float(v):.1f} ms" for k, v in sorted(curve.items(), key=lambda kv: int(kv[0]))),
    ]
    if draft.get("ms_per_token"):
        parts.append(f"draft {draft.get('id')} {float(draft['ms_per_token']):.1f} ms/token")
    if roofline.get("prefill_tokens_per_s"):
        parts.append(f"prefill {float(roofline['prefill_tokens_per_s']):.0f} tok/s")
    return "; ".join(parts)
