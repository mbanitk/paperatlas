"""Phase 3b — Match claim cards to a target project and rank them (recommendations)."""

from __future__ import annotations

import logging
from typing import Any, Optional

import numpy as np
from sqlalchemy import func, select

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Claim, Experiment, Match, Paper, PaperTopic, Project, Topic, Verdict
from paperatlas.lab.events import Reporter
from paperatlas.llm.client import LLMClient, LLMError, build_default_llm_client

logger = logging.getLogger(__name__)

CATEGORY_PRIOR = {
    "llm-inference-server": {
        "kv_cache": 1.0,
        "speculative_decoding": 1.0,
        "batching_scheduling": 0.9,
        "memory_management": 0.9,
        "quantization": 0.85,
        "attention_kernels": 0.8,
        "observability": 0.7,
        "compression_pruning": 0.6,
        "cost_energy": 0.6,
        "evaluation_quality": 0.6,
        "routing_load_balancing": 0.5,
        "model_architecture": 0.3,
        "other": 0.3,
        "disaggregated_serving": 0.2,
        "parallelism_communication": 0.2,
        "training": 0.1,
    }
}
CLUSTER_CATEGORIES = {"disaggregated_serving", "parallelism_communication"}
EFFORT_COST = {"low": 1.0, "medium": 1.6, "high": 2.6}
METRIC_KEYWORDS = [
    (("time to first token", "ttft", "prefill latency", "first-token"), "ttft_ms"),
    (("inter-token", "itl", "tpot", "time per output token", "per-token latency"), "itl_ms"),
    (("requests per second", "serving throughput", "system throughput", "goodput"), "throughput_tokens_per_s"),
    (("throughput", "tokens/s", "tokens per second", "speedup", "decode speed", "generation speed"), "decode_tokens_per_s"),
    (("latency", "end-to-end", "response time"), "e2e_latency_ms"),
    (("memory", "footprint", "kv cache size", "cache size"), "peak_memory_gb"),
    (("accuracy", "quality", "perplexity", "exact match"), "exact_match"),
]


def map_metric(claim_metric: Optional[str], project_metrics: list[str]) -> Optional[str]:
    text = (claim_metric or "").lower()
    for keywords, metric in METRIC_KEYWORDS:
        if any(keyword in text for keyword in keywords) and (metric in project_metrics or metric == "exact_match"):
            return metric
    return None


def blockers_for(claim: Claim, hardware: dict[str, Any], topic_needs_cluster: bool) -> list[str]:
    blockers = []
    if claim.requires_cuda and not hardware.get("cuda"):
        blockers.append("needs CUDA")
    if claim.requires_multi_gpu and not hardware.get("multi_gpu"):
        blockers.append("needs multiple GPUs")
    if claim.requires_training:
        blockers.append("needs training / fine-tuning")
    if topic_needs_cluster or claim.category in CLUSTER_CATEGORIES:
        blockers.append("needs a GPU cluster")
    if not claim.testable:
        blockers.append("no measurable claim")
    return blockers


def verdict_priors(project_id: int) -> dict[str, float]:
    """Categories whose past claims reproduced get a boost; repeated failures get damped."""
    with session_scope() as session:
        rows = session.execute(
            select(Claim.category, Verdict.verdict, func.count())
            .join(Experiment, Experiment.claim_id == Claim.id)
            .join(Verdict, Verdict.experiment_id == Experiment.id)
            .where(Experiment.project_id == project_id)
            .group_by(Claim.category, Verdict.verdict)
        ).all()
    weight = {"reproduced": 1.0, "partial": 0.5, "not_reproduced": -1.0, "regression": -1.0}
    totals: dict[str, list[float]] = {}
    for category, verdict, count in rows:
        totals.setdefault(category, []).extend([weight.get(verdict, 0.0)] * count)
    return {category: min(1.2, max(0.7, 1.0 + 0.15 * float(np.mean(values)))) for category, values in totals.items()}


REVIEW_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["claim_id", "target_metric", "feasible", "blocker", "rationale"],
                "properties": {
                    "claim_id": {"type": "integer"},
                    "target_metric": {"type": "string"},
                    "feasible": {"type": "boolean"},
                    "blocker": {"type": ["string", "null"]},
                    "rationale": {"type": "string"},
                },
            },
        }
    },
}

REVIEW_SYSTEM = (
    "You are the tech lead of the target project described below. For each research claim, decide "
    "whether it can be implemented as an opt-in technique in this project and measured with its "
    "benchmark on its hardware. If not, give the concrete blocker (e.g. needs CUDA kernels, needs "
    "multiple GPUs, needs retraining). Pick the project metric that best measures the claim. "
    "Write one precise sentence of rationale. Be strict about hardware constraints."
)


def _llm_review(
    llm: LLMClient, profile: dict[str, Any], claims: list[Claim], metrics: list[str]
) -> dict[int, dict[str, Any]]:
    lines = [
        f"Project: {profile.get('name')} — {profile.get('description', '')}",
        f"Hardware: {profile.get('hardware')}",
        f"Constraints: {profile.get('constraints')}",
        f"Extension points: {[e.get('name') for e in profile.get('extension_points') or []]}",
        f"Metrics (choose target_metric from these): {metrics}",
        "",
        "Claims:",
    ]
    for claim in claims:
        card = claim.card or {}
        lines.append(
            f"- claim_id={claim.id} [{claim.category}] {claim.technique} | change: {claim.change_required} | "
            f"effects: {card.get('effects')} | prerequisites: {card.get('prerequisites')}"
        )
    try:
        payload = llm.generate_json(REVIEW_SYSTEM, "\n".join(lines), "claim_review", REVIEW_SCHEMA)
    except LLMError as exc:
        logger.warning("LLM claim review failed: %s", exc)
        return {}
    return {item["claim_id"]: item for item in payload.get("items", [])}


def match_project(
    project_id: int,
    use_llm: bool = True,
    llm_review_top: int = 20,
    llm: Optional[LLMClient] = None,
    report: Optional[Reporter] = None,
) -> list[dict[str, Any]]:
    with session_scope() as session:
        project = session.get(Project, project_id)
        profile = project.profile or {}
        project_vector = np.asarray(project.embedding, dtype=np.float32)
        hardware = profile.get("hardware") or {}
        metrics = [m["name"] for m in profile.get("metrics") or [] if m.get("name")]
        priors = CATEGORY_PRIOR.get(profile.get("repo_kind", ""), CATEGORY_PRIOR["llm-inference-server"])
        cluster_papers = set(
            session.scalars(
                select(PaperTopic.paper_id)
                .join(Topic, Topic.id == PaperTopic.topic_id)
                .where(Topic.needs_gpu_cluster.is_(True))
            ).all()
        )
        claims = session.scalars(select(Claim).join(Paper, Paper.paper_id == Claim.paper_id)).all()
        tested = set(
            session.scalars(select(Experiment.claim_id).where(Experiment.project_id == project_id)).all()
        )
        session.expunge_all()
    if not claims:
        return []
    verdict_prior = verdict_priors(project_id)

    scored = []
    for claim in claims:
        similarity = float(np.asarray(claim.embedding, dtype=np.float32) @ project_vector) if claim.embedding is not None else 0.0
        fit = 0.5 * priors.get(claim.category or "other", 0.3) + 0.5 * max(similarity, 0.0)
        gain_pct = claim.claimed_gain_pct
        gain = min(gain_pct, 100.0) / 100.0 if gain_pct is not None else 0.15
        blockers = blockers_for(claim, hardware, claim.paper_id in cluster_papers)
        score = fit * (0.4 + gain) / EFFORT_COST.get(claim.effort or "medium", 1.6)
        score *= verdict_prior.get(claim.category or "other", 1.0)
        if claim.id in tested:
            score *= 0.3
        scored.append(
            {
                "claim": claim,
                "fit": round(fit, 4),
                "gain": round(gain, 4),
                "effort_cost": EFFORT_COST.get(claim.effort or "medium", 1.6),
                "score": round(score, 5),
                "blockers": blockers,
                "target_metric": map_metric(claim.primary_metric, metrics),
                "rationale": None,
            }
        )

    llm = llm if llm is not None else (build_default_llm_client() if use_llm else None)
    candidates = sorted((s for s in scored if not s["blockers"]), key=lambda s: s["score"], reverse=True)
    if llm and candidates:
        review = _llm_review(llm, profile, [s["claim"] for s in candidates[:llm_review_top]], metrics)
        for item in candidates[:llm_review_top]:
            verdict = review.get(item["claim"].id)
            if not verdict:
                continue
            item["rationale"] = verdict["rationale"]
            if verdict["target_metric"] in metrics:
                item["target_metric"] = verdict["target_metric"]
            if not verdict["feasible"]:
                item["blockers"].append(verdict["blocker"] or "not feasible in this project")
    for item in scored:
        if not item["target_metric"] and not item["blockers"]:
            item["blockers"].append("no matching benchmark metric")
        if item["blockers"]:
            item["score"] = round(item["score"] * 0.05, 5)

    with session_scope() as session:
        for item in scored:
            claim = item["claim"]
            match = session.scalar(
                select(Match).where(Match.project_id == project_id, Match.claim_id == claim.id)
            ) or Match(project_id=project_id, claim_id=claim.id)
            match.fit = item["fit"]
            match.gain = item["gain"]
            match.effort_cost = item["effort_cost"]
            match.score = item["score"]
            match.blockers = item["blockers"]
            match.testable_here = not item["blockers"]
            match.target_metric = item["target_metric"]
            match.rationale = item["rationale"] or match.rationale
            session.add(match)
    testable = sum(1 for item in scored if not item["blockers"])
    if report:
        report("match", f"Matched {len(scored)} claims: {testable} testable on this project", {"testable": testable})
    return sorted(
        [
            {"claim_id": s["claim"].id, "score": s["score"], "blockers": s["blockers"], "target_metric": s["target_metric"]}
            for s in scored
        ],
        key=lambda s: s["score"],
        reverse=True,
    )
