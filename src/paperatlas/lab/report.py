"""Phase 5b — HTML report per experiment."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

TEMPLATES = Path(__file__).with_name("templates")
_env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["html"]))


def rounds_chart(results: dict[str, Any], metric: str, width: int = 900, height: int = 220) -> str:
    """Inline SVG: per-round values for baseline vs variant, in run order."""
    points = [(r["round"], r["arm"], r["metrics"].get(metric)) for r in results.get("rounds", [])]
    values = [value for _, _, value in points if value is not None]
    if not values:
        return ""
    low, high = min(values), max(values)
    span = (high - low) or 1.0
    pad = 36
    step = (width - 2 * pad) / max(len(points) - 1, 1)
    colors = {"baseline": "#57606a", "variant": "#0969da"}
    marks = []
    for index, (_, arm, value) in enumerate(points):
        if value is None:
            continue
        x = pad + index * step
        y = height - pad - (value - low) / span * (height - 2 * pad)
        marks.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="5" fill="{colors.get(arm, "#999")}"><title>{arm}: {value:.3f}</title></circle>')
    return (
        f'<svg width="{width}" height="{height}" role="img" aria-label="{metric} per round">'
        f'<rect width="100%" height="100%" fill="#fff" stroke="#d1d9e0" rx="8"/>'
        f'<text x="{pad}" y="20" font-size="12" fill="#59636e">{metric} per round '
        f'(<tspan fill="#57606a">● baseline</tspan>  <tspan fill="#0969da">● variant</tspan>)</text>'
        f'<text x="4" y="{pad + 4}" font-size="10" fill="#59636e">{high:.2f}</text>'
        f'<text x="4" y="{height - pad}" font-size="10" fill="#59636e">{low:.2f}</text>'
        + "".join(marks)
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
        chart=rounds_chart(results, spec["primary_metric"]),
        env_json=json.dumps(verdict.get("environment") or {}, indent=2),
    )
    path.write_text(html, encoding="utf-8")
    return path
