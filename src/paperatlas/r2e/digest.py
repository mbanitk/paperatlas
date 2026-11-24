"""Weekly digest: new trending topics, new testable claims for a project, and recent verdicts."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from jinja2 import Environment, select_autoescape
from sqlalchemy import select

from paperatlas import settings
from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Claim, Experiment, Match, Project, Verdict
from paperatlas.discovery.topics import list_topics
from paperatlas.lab import service

TEMPLATE = """<!doctype html><html><head><meta charset="utf-8"><title>PaperAtlas digest — {{ project.name }}</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328;max-width:900px;margin:24px auto;padding:0 20px}
h1{font-size:22px}h2{font-size:16px;border-bottom:1px solid #d1d9e0;padding-bottom:4px;margin-top:28px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d1d9e0;padding:6px 8px;text-align:left;font-size:13px}
.muted{color:#59636e}</style></head><body>
<h1>PaperAtlas digest — {{ project.name }}</h1>
<p class="muted">{{ since.date() }} → {{ now.date() }}</p>
<h2>Top topics</h2><ol>{% for t in topics %}<li><b>{{ t.name }}</b> <span class="muted">({{ t.seed }}, trend {{ '%.2f'|format(t.trend_score) }}{% if t.needs_gpu_cluster %}, needs GPU cluster{% endif %})</span></li>{% endfor %}</ol>
<h2>New testable claims for {{ project.name }} ({{ claims|length }})</h2>
<table><tr><th>score</th><th>claim</th><th>paper</th><th>claimed</th><th>metric</th></tr>
{% for c in claims %}<tr><td>{{ '%.3f'|format(c.score) }}</td><td>{{ c.name }}</td><td>{{ c.paper_title }}</td>
<td>{% if c.claimed_gain_pct is not none %}{{ '%+.0f'|format(c.claimed_gain_pct) }}%{% endif %}</td><td>{{ c.target_metric }}</td></tr>{% endfor %}</table>
<h2>Verdicts ({{ verdicts|length }})</h2>
<table><tr><th>experiment</th><th>claim</th><th>verdict</th><th>measured</th><th>claimed</th></tr>
{% for v in verdicts %}<tr><td>#{{ v.experiment_id }}</td><td>{{ v.technique }}</td><td>{{ v.verdict }}</td>
<td>{% if v.median is not none %}{{ '%+.1f'|format(v.median) }}%{% endif %}</td><td>{% if v.claimed is not none %}{{ '%+.0f'|format(v.claimed) }}%{% endif %}</td></tr>{% endfor %}</table>
<h2>Waiting for you</h2><ul>{% for e in waiting %}<li>#{{ e.id }} {{ e.title }} — {{ e.gate }}</li>{% else %}<li>nothing</li>{% endfor %}</ul>
</body></html>"""


def build_digest(project_id: int, days: int = 7) -> dict[str, Any]:
    now = datetime.now(UTC)
    since = now - timedelta(days=days)
    with session_scope() as session:
        project = session.get(Project, project_id)
        new_claim_ids = set(
            session.scalars(
                select(Claim.id)
                .join(Match, Match.claim_id == Claim.id)
                .where(Match.project_id == project_id, Match.testable_here.is_(True), Claim.created_at >= since)
            ).all()
        )
        verdict_rows = session.execute(
            select(Verdict, Claim.technique)
            .join(Experiment, Experiment.id == Verdict.experiment_id)
            .join(Claim, Claim.id == Experiment.claim_id)
            .where(Experiment.project_id == project_id, Verdict.created_at >= since)
        ).all()
        project_info = {"id": project.id, "name": project.name}
    claims = [c for c in service.recommendations(project_id, limit=200) if c["claim_id"] in new_claim_ids][:25]
    return {
        "project": project_info,
        "now": now,
        "since": since,
        "topics": list_topics(),
        "claims": claims,
        "verdicts": [
            {
                "experiment_id": v.experiment_id,
                "technique": technique,
                "verdict": v.verdict,
                "median": v.median_delta_pct,
                "claimed": v.claimed_gain_pct,
            }
            for v, technique in verdict_rows
        ],
        "waiting": service.list_experiments(project_id, "needs_you"),
    }


def write_digest(project_id: int, days: int = 7) -> Path:
    data = build_digest(project_id, days)
    html = Environment(autoescape=select_autoescape(["html"])).from_string(TEMPLATE).render(**data)
    folder = settings.data_dir().resolve() / "r2e" / "digests"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"digest-{data['project']['name']}-{data['now']:%Y%m%d}.html"
    path.write_text(html, encoding="utf-8")
    return path
