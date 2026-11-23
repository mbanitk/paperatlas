"""Plain-language explainers (+ small flow diagrams and stats) for topics, papers and claims.

Explainers are grounded in material already extracted (abstract, concepts, claim cards,
evidence excerpts) and stored in Postgres so the web console can render them instantly.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime
from typing import Any, Callable, Iterable, Optional

from sqlalchemy import func, select, update

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Claim, Concept, Match, Paper, PaperTopic, Project, Topic
from paperatlas.db.store import clean_json
from paperatlas.llm.client import LLMClient, LLMError, build_default_llm_client

logger = logging.getLogger(__name__)

NODE_KINDS = ["input", "model", "step", "decision", "memory", "output", "hardware", "data"]
MAX_NODES = 8

GROUNDING = (
    "Use only the material provided. Copy numbers exactly as reported, with their baseline and "
    "conditions; never invent or round numbers; write 'not reported' when something is missing. "
    "Write for a senior engineer who is new to this specific topic: short, concrete, plain language. "
    "No hype, no emojis, no calls to action."
)
DIAGRAM_GUIDE = (
    "diagram: a small left-to-right flow (3-8 nodes) showing how the approach works at inference "
    "time. Node labels have at most 4 words. kind is one of input, model, step, decision, memory, "
    "output, hardware, data. Set highlight=true on the nodes the technique adds or changes compared "
    "with a standard pipeline. Use style 'loop' for at most one feedback edge and 'skip' for a "
    "shortcut; otherwise 'normal'. Edge labels are optional (at most 3 words)."
)


def _nullable(kind: str) -> dict:
    return {"type": [kind, "null"]}


def _obj(properties: dict) -> dict:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


_STRS = {"type": "array", "items": {"type": "string"}}

DIAGRAM_SCHEMA = _obj(
    {
        "title": {"type": "string"},
        "nodes": {
            "type": "array",
            "items": _obj(
                {
                    "id": {"type": "string"},
                    "label": {"type": "string"},
                    "kind": {"type": "string", "enum": NODE_KINDS},
                    "highlight": {"type": "boolean"},
                }
            ),
        },
        "edges": {
            "type": "array",
            "items": _obj(
                {
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                    "label": _nullable("string"),
                    "style": {"type": "string", "enum": ["normal", "loop", "skip"]},
                }
            ),
        },
    }
)

CLAIM_EXPLAINER_SCHEMA = _obj(
    {
        "headline": {"type": "string"},
        "problem": {"type": "string"},
        "how_it_works": _STRS,
        "why_it_helps": {"type": "string"},
        "claimed_result": _obj({"summary": {"type": "string"}, "is_relative_gain": {"type": "boolean"}}),
        "in_this_project": _obj(
            {"where": {"type": "string"}, "change": {"type": "string"}, "measure": {"type": "string"}}
        ),
        "lossless": {"type": "boolean"},
        "caveats": _STRS,
        "glossary": {"type": "array", "items": _obj({"term": {"type": "string"}, "meaning": {"type": "string"}})},
        "diagram": DIAGRAM_SCHEMA,
    }
)

PAPER_EXPLAINER_SCHEMA = _obj(
    {
        "tldr": {"type": "string"},
        "problem": {"type": "string"},
        "approach": _STRS,
        "key_results": {
            "type": "array",
            "items": _obj({"label": {"type": "string"}, "value": {"type": "string"}, "context": {"type": "string"}}),
        },
        "novelty": {"type": "string"},
        "who_should_care": {"type": "string"},
        "limitations": _STRS,
        "diagram": DIAGRAM_SCHEMA,
    }
)

TOPIC_EXPLAINER_SCHEMA = _obj(
    {
        "summary": {"type": "string"},
        "why_now": {"type": "string"},
        "key_ideas": {"type": "array", "items": _obj({"name": {"type": "string"}, "one_liner": {"type": "string"}})},
        "typical_gains": {"type": "string"},
        "open_problems": _STRS,
        "relevance": {"type": "string"},
    }
)

CLAIM_SYSTEM = f"""You explain one research claim to an engineer deciding whether to try it in their
LLM inference project. Fill the fields:
- headline: what the technique does, at most 14 words.
- problem: the bottleneck or failure it addresses (1-2 sentences).
- how_it_works: 3-5 short steps.
- why_it_helps: the mechanism that produces the gain (1-2 sentences).
- claimed_result.summary: the paper's reported result with numbers, baseline and setup;
  is_relative_gain = true only if it is an improvement relative to a baseline.
- in_this_project: where it plugs into the target project (which extension point / module),
  what changes, and which project metric/workload measures it.
- lossless: true if outputs stay identical to the baseline under greedy decoding.
- caveats: up to 3 risks or reasons it may not transfer to the project's hardware/model.
- glossary: up to 3 terms a newcomer may not know.
- {DIAGRAM_GUIDE}
{GROUNDING}"""

PAPER_SYSTEM = f"""You explain a research paper (or patent) to an engineer skimming many papers. Fill:
- tldr: one sentence on what the paper contributes.
- problem: the problem it tackles (1-2 sentences).
- approach: 3-5 short steps describing the method.
- key_results: 2-4 headline results; label at most 6 words, value as reported (e.g. "+41%",
  "2.1x", "11 GB"), context = baseline/setup.
- novelty: what is new versus prior work (1 sentence).
- who_should_care: which teams/systems benefit (1 sentence).
- limitations: up to 3.
- {DIAGRAM_GUIDE}
{GROUNDING}"""

TOPIC_SYSTEM = f"""You explain a research topic cluster to an engineering team that runs an LLM
inference server on a single Apple Silicon machine. Fill:
- summary: what the topic is about (2 sentences).
- why_now: why it is getting attention now, based on the papers listed (1-2 sentences).
- key_ideas: 3-4 recurring ideas, each with a short name and a one-line explanation.
- typical_gains: the kind and size of improvements these papers report (quote numbers given).
- open_problems: up to 3.
- relevance: how relevant this topic is for a single-machine Apple Silicon inference server and why.
{GROUNDING}"""


# ---- helpers ------------------------------------------------------------------------


def clean_diagram(diagram: dict[str, Any]) -> dict[str, Any]:
    nodes, seen = [], set()
    for node in diagram.get("nodes") or []:
        node_id = str(node.get("id") or "").strip()
        if not node_id or node_id in seen:
            continue
        seen.add(node_id)
        label = " ".join(str(node.get("label") or node_id).split())
        nodes.append(
            {
                "id": node_id,
                "label": label[:32],
                "kind": node.get("kind") if node.get("kind") in NODE_KINDS else "step",
                "highlight": bool(node.get("highlight")),
            }
        )
        if len(nodes) == MAX_NODES:
            break
    ids = {node["id"] for node in nodes}
    edges = [
        {
            "from": edge["from"],
            "to": edge["to"],
            "label": (edge.get("label") or None) and str(edge["label"])[:24],
            "style": edge.get("style") if edge.get("style") in ("normal", "loop", "skip") else "normal",
        }
        for edge in diagram.get("edges") or []
        if edge.get("from") in ids and edge.get("to") in ids and edge.get("from") != edge.get("to")
    ]
    return {"title": str(diagram.get("title") or "")[:80], "nodes": nodes, "edges": edges}


def evidence_window(raw_text: Optional[str], quote: Optional[str], width: int = 2500) -> str:
    if not raw_text:
        return ""
    if quote:
        words = re.findall(r"\w+", quote)[:6]
        if words:
            pattern = r"\W+".join(map(re.escape, words))
            match = re.search(pattern, raw_text, flags=re.IGNORECASE)
            if match:
                start = max(0, match.start() - width // 2)
                return raw_text[start : start + width]
    return raw_text[:width]


def _stamp(payload: dict[str, Any], llm: LLMClient) -> dict[str, Any]:
    return clean_json({**payload, "generated_at": datetime.now(UTC).isoformat(), "model": llm.model})


def _require_llm(llm: Optional[LLMClient]) -> LLMClient:
    llm = llm or build_default_llm_client()
    if llm is None:
        raise LLMError("No LLM configured (set OPENAI_API_KEY) — explainers need an LLM")
    return llm


def project_brief(profile: dict[str, Any]) -> str:
    return "\n".join(
        [
            f"Target project: {profile.get('name')} — {profile.get('description', '')}",
            f"Hardware: {profile.get('hardware')}",
            f"Models: {profile.get('models')}",
            f"Metrics: {[m.get('name') for m in profile.get('metrics') or []]}",
            f"Workloads: {[w.get('name') if isinstance(w, dict) else w for w in profile.get('workloads') or []]}",
            "Extension points: "
            + "; ".join(f"{e.get('name')}: {e.get('description', '')}" for e in profile.get("extension_points") or []),
            f"Existing techniques: {[t.get('name') for t in profile.get('techniques') or []]}",
            f"Constraints: {profile.get('constraints')}",
        ]
    )


# ---- claims ---------------------------------------------------------------------------


def explain_claim(project_id: int, claim_id: int, llm: Optional[LLMClient] = None, force: bool = False) -> dict[str, Any]:
    with session_scope() as session:
        match = session.scalar(select(Match).where(Match.project_id == project_id, Match.claim_id == claim_id))
        if match is None:
            raise ValueError(f"claim {claim_id} has not been matched to project {project_id}")
        if match.explainer and not force:
            return match.explainer
        claim, concept, paper = session.execute(
            select(Claim, Concept, Paper)
            .join(Concept, Concept.id == Claim.concept_id)
            .join(Paper, Paper.paper_id == Claim.paper_id)
            .where(Claim.id == claim_id)
        ).one()
        profile = session.get(Project, project_id).profile or {}
        card = claim.card or {}
        material = "\n".join(
            [
                f"Paper: {paper.title} ({paper.doc_type}, {paper.publication_date})",
                f"Abstract: {paper.abstract or 'not available'}",
                f"Concept: {concept.name} [{concept.kind}] — {concept.summary}",
                f"Key points: {list(concept.key_points or [])}",
                f"Technique: {claim.technique}",
                f"Change required: {claim.change_required}",
                f"Reported effects: {card.get('effects')}",
                f"Paper setup: {card.get('paper_setup')}",
                f"Prerequisites: {card.get('prerequisites')}",
                f"Risks: {card.get('risks')}",
                f"Evidence quote: {(card.get('evidence') or {}).get('quote')}",
                f"Excerpt around the evidence:\n{evidence_window(paper.raw_text, (card.get('evidence') or {}).get('quote'))}",
                "",
                project_brief(profile),
                f"Matcher rationale: {match.rationale or 'n/a'}; target metric: {match.target_metric}",
            ]
        )
    llm = _require_llm(llm)
    payload = llm.generate_json(CLAIM_SYSTEM, material, "claim_explainer", CLAIM_EXPLAINER_SCHEMA)
    payload["diagram"] = clean_diagram(payload.get("diagram") or {})
    payload["how_it_works"] = payload.get("how_it_works", [])[:5]
    payload["caveats"] = payload.get("caveats", [])[:3]
    payload["glossary"] = payload.get("glossary", [])[:3]
    explainer = _stamp(payload, llm)
    with session_scope() as session:
        session.execute(
            update(Match)
            .where(Match.project_id == project_id, Match.claim_id == claim_id)
            .values(explainer=explainer, explained_at=datetime.now(UTC))
        )
    return explainer


# ---- papers ---------------------------------------------------------------------------


def explain_paper(paper_id: str, llm: Optional[LLMClient] = None, force: bool = False) -> dict[str, Any]:
    with session_scope() as session:
        paper = session.get(Paper, paper_id)
        if paper is None:
            raise ValueError(f"paper {paper_id} not found")
        if paper.explainer and not force:
            return paper.explainer
        concepts = session.execute(
            select(Concept, Claim).outerjoin(Claim, Claim.concept_id == Concept.id).where(Concept.paper_id == paper_id)
        ).all()
        lines = [
            f"Title: {paper.title}",
            f"Type: {paper.doc_type}; venue: {paper.venue}; date: {paper.publication_date}",
            f"Abstract: {paper.abstract or 'not available'}",
            "Extracted concepts:",
        ]
        for concept, claim in concepts:
            effects = (claim.card or {}).get("effects") if claim else None
            lines.append(f"- {concept.name} [{concept.kind}]: {concept.summary} | effects: {effects}")
        if paper.raw_text:
            lines.append(f"Beginning of the full text:\n{paper.raw_text[:6000]}")
    llm = _require_llm(llm)
    payload = llm.generate_json(PAPER_SYSTEM, "\n".join(lines), "paper_explainer", PAPER_EXPLAINER_SCHEMA)
    payload["diagram"] = clean_diagram(payload.get("diagram") or {})
    payload["approach"] = payload.get("approach", [])[:5]
    payload["key_results"] = payload.get("key_results", [])[:4]
    payload["limitations"] = payload.get("limitations", [])[:3]
    explainer = _stamp(payload, llm)
    with session_scope() as session:
        session.execute(update(Paper).where(Paper.paper_id == paper_id).values(explainer=explainer))
    return explainer


# ---- topics ---------------------------------------------------------------------------


def _month_key(value: Optional[date]) -> Optional[str]:
    return value.strftime("%Y-%m") if value else None


def topic_insights(topic_id: int, months: int = 6) -> dict[str, Any]:
    """Numbers behind the topic infographics (computed, no LLM)."""
    with session_scope() as session:
        rows = session.execute(
            select(Paper, PaperTopic.score, PaperTopic.rank)
            .join(PaperTopic, PaperTopic.paper_id == Paper.paper_id)
            .where(PaperTopic.topic_id == topic_id)
        ).all()
        paper_ids = [paper.paper_id for paper, _, _ in rows]
        categories = session.execute(
            select(Claim.category, func.count(), func.count().filter(Claim.testable))
            .where(Claim.paper_id.in_(paper_ids))
            .group_by(Claim.category)
        ).all()
        gains = [
            value
            for (value,) in session.execute(
                select(Claim.claimed_gain_pct).where(
                    Claim.paper_id.in_(paper_ids), Claim.claimed_gain_pct.is_not(None), Claim.testable.is_(True)
                )
            ).all()
        ]
    today = date.today()
    month_keys = []
    year, month = today.year, today.month
    for _ in range(months):
        month_keys.append(f"{year:04d}-{month:02d}")
        month -= 1
        if month == 0:
            year, month = year - 1, 12
    month_keys.reverse()
    per_month = Counter(_month_key(paper.publication_date) for paper, _, _ in rows)
    sources: Counter = Counter()
    for paper, _, _ in rows:
        sources.update(paper.sources or [paper.source])
    ranked = sorted((r for r in rows if r[2] is not None), key=lambda r: r[2])[:3]
    gains_sorted = sorted(gains)
    return {
        "papers": len(rows),
        "patents": sum(1 for paper, _, _ in rows if paper.doc_type == "patent"),
        "distilled": sum(1 for paper, _, _ in rows if paper.distilled_at),
        "with_code": sum(1 for paper, _, _ in rows if paper.code_url),
        "citations": sum(paper.citation_count or 0 for paper, _, _ in rows),
        "upvotes": sum(paper.hf_upvotes or 0 for paper, _, _ in rows),
        "monthly": [{"month": key, "papers": per_month.get(key, 0)} for key in month_keys],
        "sources": [{"source": name, "papers": count} for name, count in sources.most_common()],
        "claim_categories": [
            {"category": category or "other", "claims": total, "testable": testable}
            for category, total, testable in sorted(categories, key=lambda row: -row[1])
        ],
        "median_claimed_gain_pct": gains_sorted[len(gains_sorted) // 2] if gains_sorted else None,
        "top_papers": [
            {"paper_id": paper.paper_id, "title": paper.title, "score": score, "rank": rank}
            for paper, score, rank in ranked
        ],
    }


def explain_topic(topic_id: int, llm: Optional[LLMClient] = None, force: bool = False) -> dict[str, Any]:
    with session_scope() as session:
        topic = session.get(Topic, topic_id)
        if topic is None:
            raise ValueError(f"topic {topic_id} not found")
        if topic.explainer and not force:
            return topic.explainer
        papers = session.execute(
            select(Paper.title, Paper.abstract, Paper.publication_date, Paper.citation_count, Paper.hf_upvotes)
            .join(PaperTopic, PaperTopic.paper_id == Paper.paper_id)
            .where(PaperTopic.topic_id == topic_id)
            .order_by(PaperTopic.rank.is_(None), PaperTopic.rank, PaperTopic.relevance.desc())
            .limit(12)
        ).all()
        lines = [
            f"Topic: {topic.name} (seed area: {topic.seed}); description: {topic.description}",
            f"Keywords: {list(topic.keywords or [])}; trend stats: {topic.stats}",
            "Representative papers:",
        ] + [
            f"- {p.title} ({p.publication_date}; citations {p.citation_count}; upvotes {p.hf_upvotes}): {(p.abstract or '')[:500]}"
            for p in papers
        ]
    llm = _require_llm(llm)
    payload = llm.generate_json(TOPIC_SYSTEM, "\n".join(lines), "topic_explainer", TOPIC_EXPLAINER_SCHEMA)
    payload["key_ideas"] = payload.get("key_ideas", [])[:4]
    payload["open_problems"] = payload.get("open_problems", [])[:3]
    explainer = _stamp(payload, llm)
    with session_scope() as session:
        session.execute(update(Topic).where(Topic.id == topic_id).values(explainer=explainer))
    return explainer


# ---- batch ----------------------------------------------------------------------------


def _run_all(func: Callable[[Any], Any], items: Iterable[Any], workers: int, label: str, report) -> int:
    items = list(items)
    done = 0

    def safe(item: Any) -> bool:
        try:
            func(item)
            return True
        except Exception as exc:  # noqa: BLE001 - one failure must not stop the batch
            logger.warning("Explaining %s %s failed: %s", label, item, exc)
            return False

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for ok in pool.map(safe, items):
            done += ok
    if items:
        report("explain", f"Explained {done}/{len(items)} {label}", None)
    return done


def backfill(
    project_id: Optional[int] = None,
    claims_top: int = 25,
    papers: bool = True,
    topics: bool = True,
    force: bool = False,
    workers: int = 4,
    report=lambda stage, message, data=None: logger.info("[%s] %s", stage, message),
) -> dict[str, int]:
    llm = _require_llm(None)
    result = {"topics": 0, "papers": 0, "claims": 0}
    with session_scope() as session:
        topic_ids = session.scalars(select(Topic.id).where(Topic.rank.is_not(None))).all() if topics else []
        paper_query = select(Paper.paper_id).where(Paper.distilled_at.is_not(None))
        if not force:
            paper_query = paper_query.where(Paper.explainer.is_(None))
        paper_ids = session.scalars(paper_query).all() if papers else []
        claim_ids: list[int] = []
        if project_id and claims_top:
            claim_query = (
                select(Match.claim_id)
                .where(Match.project_id == project_id, Match.testable_here.is_(True))
                .order_by(Match.score.desc())
                .limit(claims_top)
            )
            claim_ids = session.scalars(claim_query).all()
    result["topics"] = _run_all(lambda tid: explain_topic(tid, llm, force), topic_ids, workers, "topics", report)
    result["papers"] = _run_all(lambda pid: explain_paper(pid, llm, force), paper_ids, workers, "papers", report)
    result["claims"] = _run_all(
        lambda cid: explain_claim(project_id, cid, llm, force), claim_ids, workers, "claims", report
    )
    return result
