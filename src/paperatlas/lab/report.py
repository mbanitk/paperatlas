"""Phase 5b — HTML report per experiment, with two self-explanatory SVG charts."""

from __future__ import annotations

import json
import math
from html import escape
from pathlib import Path
from typing import Any, Optional

from jinja2 import Environment, FileSystemLoader, select_autoescape

TEMPLATES = Path(__file__).with_name("templates")
_env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["html"]))

INK, MUTED, GRID, AXIS = "#1f2328", "#59636e", "#eaeef2", "#d1d9e0"
BASELINE, VARIANT, BETTER, WORSE, CLAIM, BAR = "#8c959f", "#0969da", "#1a7f37", "#cf222e", "#8250df", "#9a6700"
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"

METRIC_LABELS = {
    "decode_tokens_per_s": ("Decode speed", "tokens/s"),
    "throughput_tokens_per_s": ("Throughput", "tokens/s"),
    "ttft_ms": ("Time to first token", "ms"),
    "itl_ms": ("Inter-token latency", "ms"),
    "e2e_latency_ms": ("End-to-end latency", "ms"),
    "peak_memory_gb": ("Peak memory", "GB"),
}


def metric_label(metric: str) -> tuple[str, str]:
    return METRIC_LABELS.get(metric, (metric.replace("_", " ").capitalize(), ""))


def nice_ticks(low: float, high: float, count: int = 5) -> list[float]:
    """Round tick values covering [low, high]."""
    if high <= low:
        high = low + 1.0
    raw = (high - low) / max(count - 1, 1)
    magnitude = 10 ** math.floor(math.log10(raw))
    step = next(m * magnitude for m in (1, 2, 2.5, 5, 10) if m * magnitude >= raw)
    value = math.floor(low / step) * step
    ticks = [round(value, 10)]
    while value < high - 1e-9:
        value += step
        ticks.append(round(value, 10))
    return ticks if len(ticks) > 1 else ticks + [round(value + step, 10)]


def _fmt(value: float) -> str:
    return f"{value:,.0f}" if abs(value) >= 100 else (f"{value:,.1f}" if abs(value) >= 10 else f"{value:,.2f}")


def _text(x: float, y: float, content: str, size: int = 12, fill: str = MUTED, anchor: str = "start", weight: int = 400) -> str:
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{fill}" text-anchor="{anchor}" '
        f'font-weight="{weight}" font-family="{FONT}">{escape(content)}</text>'
    )


def effect_chart(verdict: dict[str, Any], width: int = 880) -> str:
    """Number line: measured change (dot + 95% CI band) vs paper claim, target and success bar."""
    median, low, high = verdict.get("median_delta_pct"), verdict.get("ci_low_pct"), verdict.get("ci_high_pct")
    if median is None:
        return ""
    claimed = verdict.get("claimed_gain_pct")
    threshold = verdict.get("success_threshold_pct") or 0.0
    target = max(threshold, 0.7 * claimed) if claimed else None
    markers = [m for m in (0.0, median, low, high, claimed, threshold, target) if m is not None]
    ticks = nice_ticks(min(markers), max(markers), 6)
    lo, hi = ticks[0], ticks[-1]
    left, right, axis_y, height = 40, width - 40, 112, 190

    def x(value: float) -> float:
        return left + (value - lo) / (hi - lo) * (right - left)

    color = BETTER if (low or 0) > 0 else (WORSE if (high or 0) < 0 else MUTED)
    parts = [
        f'<rect x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" rx="10" fill="#fff" stroke="{AXIS}"/>',
        _text(20, 28, "Did the claim hold?", 14, INK, weight=600),
        _text(20, 47, "Measured improvement on the primary metric with its 95% confidence band, "
              "compared with what the paper claims.", 12),
        f'<rect x="{x(lo):.1f}" y="{axis_y - 2}" width="{x(hi) - x(lo):.1f}" height="4" rx="2" fill="{GRID}"/>',
    ]
    for tick in ticks:
        parts.append(f'<line x1="{x(tick):.1f}" x2="{x(tick):.1f}" y1="{axis_y + 6}" y2="{axis_y + 10}" stroke="{AXIS}"/>')
        parts.append(_text(x(tick), axis_y + 24, f"{tick:+.0f}%" if tick else "0%", 11, MUTED, "middle"))
    parts.append(f'<line x1="{x(0):.1f}" x2="{x(0):.1f}" y1="{axis_y - 14}" y2="{axis_y + 10}" stroke="{MUTED}" stroke-width="1.5"/>')

    reference = [("Success bar", threshold, BAR, "4 3")]
    if target is not None and target != threshold:
        reference.append(("Target (70% of claim)", target, BAR, "2 3"))
    if claimed is not None:
        reference.append(("Paper claims", claimed, CLAIM, ""))
    placed: list[float] = []
    for label, value, stroke, dash in sorted(reference, key=lambda r: r[1]):
        px = x(value)
        row = 0 if all(abs(px - other) > 120 for other in placed) else 1
        placed.append(px)
        label_y = axis_y - 36 - row * 16
        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        parts.append(f'<line x1="{px:.1f}" x2="{px:.1f}" y1="{label_y + 6}" y2="{axis_y + 2}" stroke="{stroke}" stroke-width="1.5"{dash_attr}/>')
        parts.append(_text(px, label_y, f"{label} {value:+.1f}%", 11, stroke, "middle", 600))

    if low is not None and high is not None:
        parts.append(
            f'<rect x="{x(low):.1f}" y="{axis_y - 9}" width="{max(x(high) - x(low), 3):.1f}" height="18" rx="9" '
            f'fill="{color}" fill-opacity="0.18"/>'
        )
    parts.append(f'<circle cx="{x(median):.1f}" cy="{axis_y}" r="7" fill="{color}" stroke="#fff" stroke-width="2"/>')
    parts.append(_text(x(median), axis_y + 48, f"Measured {median:+.1f}%", 13, color, "middle", 700))
    if low is not None:
        parts.append(_text(x(median), axis_y + 64, f"95% CI {low:+.1f}% … {high:+.1f}%", 11, MUTED, "middle"))
    return (
        f'<svg viewBox="0 0 {width} {height + 4}" width="100%" role="img" '
        f'aria-label="Measured {median:+.1f}% versus paper claim {claimed}%">' + "".join(parts) + "</svg>"
    )


def pairs_chart(
    results: dict[str, Any], metric: str, direction: str, width: int = 880, height: int = 320
) -> str:
    """Dumbbell chart: one column per back-to-back A/B pair (baseline vs variant)."""
    baseline = [r["metrics"].get(metric) for r in results.get("rounds", []) if r["arm"] == "baseline"]
    variant = [r["metrics"].get(metric) for r in results.get("rounds", []) if r["arm"] == "variant"]
    pairs = [(b, v) for b, v in zip(baseline, variant) if b is not None and v is not None]
    if not pairs:
        return ""
    name, unit = metric_label(metric)
    values = [value for pair in pairs for value in pair]
    floor = 0.0 if min(values) >= 0 and min(values) < 0.6 * max(values) else min(values)
    ticks = nice_ticks(floor, max(values), 5)
    lo, hi = ticks[0], ticks[-1]
    left, right, top, bottom = 72, width - 150, 92, height - 46

    def y(value: float) -> float:
        return bottom - (value - lo) / (hi - lo) * (bottom - top)

    step = (right - left) / len(pairs)
    better = "higher" if direction == "higher_is_better" else "lower"
    parts = [
        f'<rect x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" rx="10" fill="#fff" stroke="{AXIS}"/>',
        _text(20, 28, f"{name} in every A/B pair", 14, INK, weight=600),
        _text(20, 47, f"Each column is one pair of back-to-back runs: flag off vs flag on ({better} is better).", 12),
    ]
    decimals = max(0, -math.floor(math.log10(ticks[1] - ticks[0])))
    for tick in ticks:
        parts.append(f'<line x1="{left}" x2="{right}" y1="{y(tick):.1f}" y2="{y(tick):.1f}" stroke="{GRID}"/>')
        parts.append(_text(left - 8, y(tick) + 4, f"{tick:,.{decimals}f}", 11, MUTED, "end"))
    parts.append(
        f'<text transform="translate(18 {(top + bottom) / 2:.0f}) rotate(-90)" font-size="11" fill="{MUTED}" '
        f'text-anchor="middle" font-family="{FONT}">{escape(unit or name)}</text>'
    )
    for index, (b, v) in enumerate(pairs):
        cx = left + step * (index + 0.5)
        improved = (v > b) if direction == "higher_is_better" else (v < b)
        stroke = BETTER if improved else WORSE
        parts.append(f'<line x1="{cx:.1f}" x2="{cx:.1f}" y1="{y(b):.1f}" y2="{y(v):.1f}" stroke="{stroke}" stroke-width="2" stroke-opacity="0.55"/>')
        parts.append(f'<circle cx="{cx:.1f}" cy="{y(b):.1f}" r="5.5" fill="{BASELINE}"><title>pair {index + 1} baseline: {_fmt(b)} {unit}</title></circle>')
        parts.append(f'<circle cx="{cx:.1f}" cy="{y(v):.1f}" r="5.5" fill="{VARIANT}"><title>pair {index + 1} variant: {_fmt(v)} {unit}</title></circle>')
        parts.append(_text(cx, bottom + 18, str(index + 1), 11, MUTED, "middle"))
    parts.append(_text((left + right) / 2, bottom + 36, "A/B pair", 11, MUTED, "middle"))
    for label, series, color in (("Baseline median", [b for b, _ in pairs], BASELINE), ("Variant median", [v for _, v in pairs], VARIANT)):
        median = sorted(series)[len(series) // 2] if len(series) % 2 else sum(sorted(series)[len(series) // 2 - 1 : len(series) // 2 + 1]) / 2
        parts.append(f'<line x1="{left}" x2="{right}" y1="{y(median):.1f}" y2="{y(median):.1f}" stroke="{color}" stroke-dasharray="5 4"/>')
        parts.append(_text(right + 10, y(median) - 2, label, 11, color, weight=600))
        parts.append(_text(right + 10, y(median) + 13, f"{_fmt(median)} {unit}".strip(), 12, INK, weight=600))
    parts.append(f'<circle cx="26" cy="68" r="5" fill="{BASELINE}"/>')
    parts.append(_text(36, 72, "Baseline (flag off)", 12, INK))
    parts.append(f'<circle cx="176" cy="68" r="5" fill="{VARIANT}"/>')
    parts.append(_text(186, 72, "Variant (flag on)", 12, INK))
    parts.append(f'<line x1="316" x2="336" y1="68" y2="68" stroke="{BETTER}" stroke-width="2"/>')
    parts.append(_text(342, 72, "better", 12, INK))
    parts.append(f'<line x1="396" x2="416" y1="68" y2="68" stroke="{WORSE}" stroke-width="2"/>')
    parts.append(_text(422, 72, "worse", 12, INK))
    return (
        f'<svg viewBox="0 0 {width} {height}" width="100%" role="img" aria-label="{escape(name)} per A/B pair">'
        + "".join(parts)
        + "</svg>"
    )


def render_report(
    path: Path,
    experiment: dict[str, Any],
    project: dict[str, Any],
    claim: dict[str, Any],
    paper: dict[str, Any],
    spec: dict[str, Any],
    build: dict[str, Any],
    verdict: dict[str, Any],
    results: dict[str, Any],
) -> Path:
    html = _env.get_template("report.html").render(
        e=experiment,
        project=project,
        claim=claim,
        paper=paper,
        spec=spec,
        build=build or {"attempts": [], "files": []},
        v=verdict,
        effect_chart=effect_chart(verdict),
        pairs_chart=pairs_chart(results, spec["primary_metric"], spec.get("direction", "higher_is_better")),
        metric_name=metric_label(spec["primary_metric"])[0],
        env_json=json.dumps(verdict.get("environment") or {}, indent=2),
    )
    path.write_text(html, encoding="utf-8")
    return path


def rerender_report(experiment_id: int) -> Optional[Path]:
    """Re-judge the stored eval results and re-render the report (e.g. after template changes)."""
    from paperatlas.lab import service
    from paperatlas.lab.judge import judge
    from paperatlas.lab.workspace import artifacts_dir

    from paperatlas.lab.protocol import needs_adoption_run, spec_defaults

    context = service.experiment_context(experiment_id)
    spec = spec_defaults(context["spec"])
    results = service.latest_results(experiment_id, "eval")
    adopt = None
    if needs_adoption_run(spec):
        try:
            adopt = service.latest_results(experiment_id, "adopt")
        except service.ServiceError:
            adopt = None
    verdict = judge(results, spec, context["profile"], adopt)
    stored = service.get_experiment(experiment_id).get("verdict_detail") or {}
    for key in ("analysis", "iteration", "iterations", "tuning", "code_effect"):
        if stored.get("details", {}).get(key) is not None:
            verdict[key] = stored["details"][key]
    return render_report(
        artifacts_dir(experiment_id) / "report.html",
        context["experiment"],
        context["project"],
        context["claim"],
        context["paper"],
        context["spec"],
        context["experiment"].get("build") or {},
        verdict,
        results,
    )
