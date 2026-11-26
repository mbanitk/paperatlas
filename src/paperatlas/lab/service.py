"""Service layer shared by the HTTP APIs, the CLI and the orchestrator nodes."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import func, select, update

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import (
    Claim,
    ClaimGroup,
    Concept,
    Event,
    Experiment,
    Job,
    Match,
    Paper,
    PaperTopic,
    Project,
    Run,
    Topic,
    Triage,
    Verdict,
)
from paperatlas.distill.relations import paper_concept_map, prerequisite_chain, related_for_claims
from paperatlas.lab.events import emit, enqueue, event_dict, events_since
from paperatlas.lab.planner import EDITABLE_FIELDS, apply_overrides
from paperatlas.lab.protocol import method_excerpt

ACTIVE_STATUSES = (
    "blocked",
    "queued",
    "planning",
    "awaiting_approval",
    "approving",
    "building",
    "smoke_testing",
    "tuning",
    "waiting_gpu",
    "running",
    "judging",
    "awaiting_decision",
    "finalizing",
    "cancelling",
)
TERMINAL_STATUSES = ("merged", "dropped", "rejected", "failed", "cancelled")
STAGES = ["plan", "approve", "build", "smoke", "tune", "run", "judge", "decide"]
STAGE_OF_STATUS = {
    "blocked": "plan",
    "queued": "plan",
    "planning": "plan",
    "awaiting_approval": "approve",
    "approving": "build",
    "building": "build",
    "smoke_testing": "smoke",
    "tuning": "tune",
    "waiting_gpu": "run",
    "running": "run",
    "judging": "judge",
    "awaiting_decision": "decide",
    "finalizing": "decide",
    "merged": "decide",
    "dropped": "decide",
    "rejected": "approve",
}
GATE_OF_STATUS = {"awaiting_approval": "approve_spec", "awaiting_decision": "merge"}
STEP_TO_STAGE = {"plan": "plan", "approve": "approve", "build": "build", "smoke": "smoke", "tune": "tune",
                 "run": "run", "judge": "judge", "finalize": "decide", "decide": "decide"}


def stage_of(status: str, error: Optional[str]) -> Optional[str]:
    """Current stage; for failed/cancelled experiments, the stage they stopped in."""
    if status in ("failed", "cancelled", "cancelling", "queued") and error:
        return STEP_TO_STAGE.get(error.split(":", 1)[0].strip())
    return STAGE_OF_STATUS.get(status)


class ServiceError(ValueError):
    """Invalid request (maps to HTTP 400/404/409)."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if value is not None else None


# ---- research views ----------------------------------------------------------------


def claim_dict(claim: Claim, concept: Optional[Concept] = None, paper: Optional[Paper] = None) -> dict[str, Any]:
    return {
        "id": claim.id,
        "claim_id": claim.id,
        "paper_id": claim.paper_id,
        "name": concept.name if concept else claim.technique[:80],
        "kind": concept.kind if concept else None,
        "summary": concept.summary if concept else None,
        "key_points": list(concept.key_points or []) if concept else [],
        "category": claim.category,
        "technique": claim.technique,
        "change_required": claim.change_required,
        "primary_metric": claim.primary_metric,
        "claimed_value": claim.claimed_value,
        "claimed_unit": claim.claimed_unit,
        "direction": claim.direction,
        "claimed_gain_pct": claim.claimed_gain_pct,
        "testable": claim.testable,
        "requires_cuda": claim.requires_cuda,
        "requires_multi_gpu": claim.requires_multi_gpu,
        "requires_training": claim.requires_training,
        "effort": claim.effort,
        "evidence_quote": claim.evidence_quote,
        "card": claim.card,
        "group_id": claim.group_id,
        "paper_title": paper.title if paper else None,
        "paper_url": paper.url if paper else None,
        "paper_doc_type": paper.doc_type if paper else None,
        "paper_date": _iso(paper.publication_date) if paper else None,
        "created_at": _iso(claim.created_at),
    }


def _explainers_for(session, claim_ids: list[int], project_id: Optional[int] = None) -> dict[int, dict]:
    if not claim_ids:
        return {}
    query = select(Match.claim_id, Match.explainer).where(Match.claim_id.in_(claim_ids), Match.explainer.is_not(None))
    if project_id:
        query = query.where(Match.project_id == project_id)
    return {claim_id: explainer for claim_id, explainer in session.execute(query.order_by(Match.explained_at)).all()}


def _match_summaries(session, claim_ids: list[int], project_id: Optional[int]) -> dict[int, dict[str, Any]]:
    """Whether each claim is testable on the project, its blockers and the pre-screen (what it needs)."""
    from paperatlas.lab.assets import public_check

    if not project_id or not claim_ids:
        return {}
    rows = session.execute(
        select(Match.claim_id, Match.testable_here, Match.blockers, Match.asset_check).where(
            Match.project_id == project_id, Match.claim_id.in_(claim_ids)
        )
    ).all()
    return {
        claim_id: {
            "project_id": project_id,
            "testable_here": testable,
            "blockers": list(blockers or []),
            "asset_check": public_check(check),
        }
        for claim_id, testable, blockers, check in rows
    }


def get_claim(claim_id: int, project_id: Optional[int] = None) -> dict[str, Any]:
    with session_scope() as session:
        row = session.execute(
            select(Claim, Concept, Paper)
            .join(Concept, Concept.id == Claim.concept_id)
            .join(Paper, Paper.paper_id == Claim.paper_id)
            .where(Claim.id == claim_id)
        ).first()
        if not row:
            raise ServiceError(f"claim {claim_id} not found", 404)
        data = claim_dict(*row)
        data["match"] = _match_summaries(session, [claim_id], project_id).get(claim_id)
        data["explainer"] = _explainers_for(session, [claim_id], project_id).get(claim_id)
        data["related"] = related_for_claims([claim_id], project_id).get(claim_id)
        data["paper_explainer"] = row[2].explainer
        if row[0].group_id:
            group = session.get(ClaimGroup, row[0].group_id)
            siblings = session.execute(
                select(Claim.id, Claim.paper_id, Paper.title)
                .join(Paper, Paper.paper_id == Claim.paper_id)
                .where(Claim.group_id == row[0].group_id, Claim.id != claim_id)
            ).all()
            data["group"] = {
                "id": group.id,
                "label": group.label,
                "size": group.size,
                "other_claims": [{"claim_id": s.id, "paper_id": s.paper_id, "paper_title": s.title} for s in siblings],
            }
        data["experiments"] = [
            {"id": e.id, "status": e.status, "project_id": e.project_id}
            for e in session.scalars(select(Experiment).where(Experiment.claim_id == claim_id)).all()
        ]
        return data


def list_claims(
    q: Optional[str] = None,
    category: Optional[str] = None,
    topic: Optional[str] = None,
    testable: Optional[bool] = None,
    paper_id: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    project_id: Optional[int] = None,
) -> dict[str, Any]:
    if q:
        from paperatlas.db.search import hybrid_search

        hits = hybrid_search(q, "claims", limit=limit + offset)[offset:]
        ids = [hit.id for hit in hits]
        scores = {hit.id: hit.score for hit in hits}
    with session_scope() as session:
        query = (
            select(Claim, Concept, Paper)
            .join(Concept, Concept.id == Claim.concept_id)
            .join(Paper, Paper.paper_id == Claim.paper_id)
        )
        if q:
            query = query.where(Claim.id.in_(ids))
        if category:
            query = query.where(Claim.category == category)
        if testable is not None:
            query = query.where(Claim.testable.is_(testable))
        if paper_id:
            query = query.where(Claim.paper_id == paper_id)
        if topic:
            query = query.join(PaperTopic, PaperTopic.paper_id == Claim.paper_id).join(
                Topic, Topic.id == PaperTopic.topic_id
            ).where(Topic.slug == topic)
        total = session.scalar(select(func.count()).select_from(query.subquery()))
        rows = session.execute(query.order_by(Claim.id.desc()).limit(limit if not q else None).offset(offset if not q else 0)).all()
        items = [claim_dict(*row) for row in rows]
        explainers = _explainers_for(session, [item["id"] for item in items])
        related = related_for_claims([item["id"] for item in items])
        matches = _match_summaries(session, [item["id"] for item in items], project_id)
        for item in items:
            item["explainer"] = explainers.get(item["id"])
            item["related"] = related.get(item["id"])
            if project_id:
                item["match"] = matches.get(item["id"])
    if q:
        items.sort(key=lambda item: scores.get(item["id"], 0), reverse=True)
        for item in items:
            item["search_score"] = scores.get(item["id"])
    return {"total": total, "items": items}


def list_papers(
    q: Optional[str] = None, topic: Optional[str] = None, limit: int = 50, offset: int = 0
) -> dict[str, Any]:
    if q:
        from paperatlas.db.search import hybrid_search

        hits = hybrid_search(q, "papers", limit=limit + offset)[offset:]
        ids = [hit.id for hit in hits]
    with session_scope() as session:
        claims = (
            select(Claim.paper_id, func.count().label("claims"), func.count().filter(Claim.testable).label("testable"))
            .group_by(Claim.paper_id)
            .subquery()
        )
        query = select(Paper, claims.c.claims, claims.c.testable).outerjoin(claims, claims.c.paper_id == Paper.paper_id)
        if q:
            query = query.where(Paper.paper_id.in_(ids))
            offset = 0
        if topic:
            query = (
                query.join(PaperTopic, PaperTopic.paper_id == Paper.paper_id)
                .join(Topic, Topic.id == PaperTopic.topic_id)
                .where(Topic.slug == topic)
                .order_by(PaperTopic.rank.is_(None), PaperTopic.rank)
            )
        else:
            query = query.order_by(Paper.distilled_at.is_(None), Paper.publication_date.desc().nulls_last())
        total = session.scalar(select(func.count()).select_from(query.subquery()))
        rows = session.execute(query.limit(limit).offset(offset)).all()
        return {
            "total": total,
            "items": [
                {
                    "paper_id": paper.paper_id,
                    "doc_type": paper.doc_type,
                    "title": paper.title,
                    "abstract": paper.abstract,
                    "venue": paper.venue,
                    "sources": paper.sources,
                    "url": paper.url,
                    "pdf_url": paper.pdf_url,
                    "code_url": paper.code_url,
                    "publication_date": _iso(paper.publication_date),
                    "citation_count": paper.citation_count,
                    "hf_upvotes": paper.hf_upvotes,
                    "has_full_text": bool(paper.raw_text),
                    "distilled": paper.distilled_at is not None,
                    "claims": n_claims or 0,
                    "testable_claims": n_testable or 0,
                    "explainer": paper.explainer,
                }
                for paper, n_claims, n_testable in rows
            ],
        }


def get_paper(paper_id: str) -> dict[str, Any]:
    with session_scope() as session:
        paper = session.get(Paper, paper_id)
        if paper is None:
            raise ServiceError(f"paper {paper_id} not found", 404)
        topics = session.execute(
            select(Topic.slug, Topic.name, PaperTopic.rank, PaperTopic.score)
            .join(PaperTopic, PaperTopic.topic_id == Topic.id)
            .where(PaperTopic.paper_id == paper_id)
        ).all()
        data = {
            "paper_id": paper.paper_id,
            "doc_type": paper.doc_type,
            "title": paper.title,
            "abstract": paper.abstract,
            "authors": paper.authors,
            "venue": paper.venue,
            "sources": paper.sources,
            "url": paper.url,
            "pdf_url": paper.pdf_url,
            "code_url": paper.code_url,
            "publication_date": _iso(paper.publication_date),
            "citation_count": paper.citation_count,
            "hf_upvotes": paper.hf_upvotes,
            "has_full_text": bool(paper.raw_text),
            "distilled_at": _iso(paper.distilled_at),
            "explainer": paper.explainer,
            "topics": [{"slug": t.slug, "name": t.name, "rank": t.rank, "score": t.score} for t in topics],
        }
    data["claims"] = list_claims(paper_id=paper_id, limit=50)["items"]
    data["concept_map"] = paper_concept_map(paper_id)
    return data


def stats() -> dict[str, Any]:
    with session_scope() as session:
        experiments = dict(
            session.execute(select(Experiment.status, func.count()).group_by(Experiment.status)).all()
        )
        verdicts = dict(session.execute(select(Verdict.verdict, func.count()).group_by(Verdict.verdict)).all())
        return {
            "topics": session.scalar(select(func.count()).where(Topic.rank.is_not(None))),
            "papers": session.scalar(select(func.count()).select_from(Paper)),
            "papers_distilled": session.scalar(select(func.count()).where(Paper.distilled_at.is_not(None))),
            "patents": session.scalar(select(func.count()).where(Paper.doc_type == "patent")),
            "claims": session.scalar(select(func.count()).select_from(Claim)),
            "testable_claims": session.scalar(select(func.count()).where(Claim.testable.is_(True))),
            "projects": session.scalar(select(func.count()).select_from(Project)),
            "experiments": experiments,
            "verdicts": verdicts,
            "awaiting_you": sum(experiments.get(s, 0) for s in GATE_OF_STATUS)
            + session.scalar(select(func.count()).where(Triage.status == "awaiting_pick")),
            "jobs": dict(session.execute(select(Job.status, func.count()).group_by(Job.status)).all()),
        }


# ---- recommendations + Gate 1 -------------------------------------------------------


def recommendations(
    project_id: int,
    limit: int = 30,
    include_blocked: bool = False,
    category: Optional[str] = None,
    topic: Optional[str] = None,
    q: Optional[str] = None,
    include_needs_assets: bool = False,
) -> list[dict[str, Any]]:
    """Ranked matches: testable ones; with `include_needs_assets`, also claims held back only because they need
    assets the project lacks, ranked where they would be with the assets; with `include_blocked`, every claim."""
    from paperatlas.lab.assets import public_check

    search_ids = None
    if q:
        from paperatlas.db.search import hybrid_search

        search_ids = [hit.id for hit in hybrid_search(q, "claims", limit=200)]
    with session_scope() as session:
        latest_experiment = (
            select(Experiment.claim_id, func.max(Experiment.id).label("experiment_id"))
            .where(Experiment.project_id == project_id)
            .group_by(Experiment.claim_id)
            .subquery()
        )
        query = (
            select(Match, Claim, Concept, Paper, latest_experiment.c.experiment_id)
            .join(Claim, Claim.id == Match.claim_id)
            .join(Concept, Concept.id == Claim.concept_id)
            .join(Paper, Paper.paper_id == Claim.paper_id)
            .outerjoin(latest_experiment, latest_experiment.c.claim_id == Claim.id)
            .where(Match.project_id == project_id)
        )
        order = Match.score.desc()
        if include_needs_assets and not include_blocked:
            query = query.where(Match.testable_here.is_(True) | _held_back_for_assets())
            order = func.coalesce(Match.asset_check["base_score"].as_float(), Match.score).desc()
        elif not include_blocked:
            query = query.where(Match.testable_here.is_(True))
        if category:
            query = query.where(Claim.category == category)
        if search_ids is not None:
            query = query.where(Claim.id.in_(search_ids))
        if topic:
            query = query.where(
                Claim.paper_id.in_(
                    select(PaperTopic.paper_id).join(Topic, Topic.id == PaperTopic.topic_id).where(Topic.slug == topic)
                )
            )
        rows = session.execute(query.order_by(order, Match.score.desc()).limit(limit)).all()
        experiment_ids = [row[4] for row in rows if row[4]]
        statuses = dict(
            session.execute(select(Experiment.id, Experiment.status).where(Experiment.id.in_(experiment_ids))).all()
        )
        topics_by_paper: dict[str, list[dict]] = {}
        for paper_id, slug, name in session.execute(
            select(PaperTopic.paper_id, Topic.slug, Topic.name)
            .join(Topic, Topic.id == PaperTopic.topic_id)
            .where(PaperTopic.paper_id.in_([row[3].paper_id for row in rows]), Topic.rank.is_not(None))
        ).all():
            topics_by_paper.setdefault(paper_id, []).append({"slug": slug, "name": name})
        items = []
        related = related_for_claims([row[1].id for row in rows], project_id)
        for rank, (match, claim, concept, paper, experiment_id) in enumerate(rows, start=1):
            item = claim_dict(claim, concept, paper)
            item.update(
                rank=rank,
                project_id=project_id,
                score=match.score,
                fit=match.fit,
                gain=match.gain,
                effort_cost=match.effort_cost,
                testable_here=match.testable_here,
                blockers=list(match.blockers or []),
                target_metric=match.target_metric,
                rationale=match.rationale,
                prediction=match.prediction,
                asset_check=public_check(match.asset_check),
                explainer=match.explainer,
                topics=topics_by_paper.get(paper.paper_id, []),
                experiment_id=experiment_id,
                experiment_status=statuses.get(experiment_id),
                related=related.get(claim.id),
            )
            items.append(item)
        return items


def _held_back_for_assets():
    """Matches whose one blocker is the pre-screen's: testable once the project has the assets (claims without a
    benchmark metric would still be blocked)."""
    return (
        (Match.asset_check["status"].astext == "needs_assets")
        & (func.cardinality(Match.blockers) == 1)
        & Match.target_metric.is_not(None)
    )


def assets_summary(project_id: int) -> dict[str, Any]:
    """The project's capabilities and how many matched claims need assets it doesn't have, by category."""
    from paperatlas.lab.assets import capabilities

    with session_scope() as session:
        project = session.get(Project, project_id)
        if project is None:
            raise ServiceError(f"project {project_id} not found", 404)
        rows = session.execute(
            select(Match.testable_here, Match.asset_check).where(Match.project_id == project_id)
        ).all()
        held_back = session.scalar(
            select(func.count()).where(Match.project_id == project_id, _held_back_for_assets())
        )
        caps = capabilities(project.profile or {})
    by_category: dict[str, int] = {}
    needs_assets = 0
    for _, check in rows:
        if (check or {}).get("status") != "needs_assets":
            continue
        needs_assets += 1
        for category in dict.fromkeys(item.get("category") for item in check.get("missing") or []):
            by_category[category or "other"] = by_category.get(category or "other", 0) + 1
    return {
        "project_id": project_id,
        "capabilities": caps,
        "matched": len(rows),
        "testable": sum(1 for testable, _ in rows if testable),
        "checked": sum(1 for _, check in rows if check),
        "needs_assets": needs_assets,
        "held_back": held_back,
        "by_category": dict(sorted(by_category.items(), key=lambda item: -item[1])),
    }


def _steps_for(project_id: int, claim_ids: list[int], mode: str) -> list[dict[str, Any]]:
    """Experiments to create: [{claim_id, bundle, depends_on_index}] (index into the list)."""
    if mode == "single":
        return [{"claim_id": cid, "bundle": [], "after": None} for cid in claim_ids]
    with session_scope() as session:
        testable = dict(
            session.execute(
                select(Match.claim_id, Match.testable_here).where(Match.project_id == project_id)
            ).all()
        )
    if mode == "bundle":
        primary, members = claim_ids[0], []
        for cid in claim_ids:
            members += [p["claim_id"] for p in prerequisite_chain(cid, project_id) if p["claim_id"]]
            if cid != primary:
                members.append(cid)
        members = [cid for cid in dict.fromkeys(members) if cid != primary]
        return [{"claim_id": primary, "bundle": members, "after": None}]
    steps: list[dict[str, Any]] = []
    for cid in claim_ids:
        pending: list[int] = []
        previous = len(steps) - 1 if steps else None
        for prerequisite in prerequisite_chain(cid, project_id):
            pid = prerequisite["claim_id"]
            if not pid or any(step["claim_id"] == pid for step in steps):
                continue
            if testable.get(pid):
                steps.append({"claim_id": pid, "bundle": pending, "after": previous})
                pending, previous = [], len(steps) - 1
            else:
                pending.append(pid)
        steps.append({"claim_id": cid, "bundle": pending, "after": previous})
    return steps


def create_experiments(
    project_id: int,
    claim_ids: list[int],
    triage_id: Optional[int] = None,
    force: bool = False,
    mode: str = "single",
) -> list[dict[str, Any]]:
    if not claim_ids:
        raise ServiceError("pick at least one claim")
    if mode not in ("single", "bundle", "chain"):
        raise ServiceError("mode must be single, bundle or chain")
    steps = _steps_for(project_id, claim_ids, mode)
    picked = set(claim_ids)
    created: list[int] = []
    blocked: set[int] = set()
    with session_scope() as session:
        if session.get(Project, project_id) is None:
            raise ServiceError(f"project {project_id} not found", 404)
        step_experiment: list[tuple[int, bool]] = []
        for step in steps:
            claim_id = step["claim_id"]
            match = session.scalar(select(Match).where(Match.project_id == project_id, Match.claim_id == claim_id))
            if session.get(Claim, claim_id) is None:
                raise ServiceError(f"claim {claim_id} not found", 404)
            if match and match.blockers and not force and claim_id in picked:
                raise ServiceError(f"claim {claim_id} is blocked here: {', '.join(match.blockers)} (use force)", 409)
            existing = session.execute(
                select(Experiment.id, Experiment.status).where(
                    Experiment.project_id == project_id,
                    Experiment.claim_id == claim_id,
                    Experiment.status.in_((*ACTIVE_STATUSES, "merged")),
                )
            ).first()
            if existing and (claim_id in picked or mode != "chain"):
                if existing.status != "merged":
                    raise ServiceError(f"claim {claim_id} already has active experiment {existing.id} ({existing.status})", 409)
            elif existing:
                step_experiment.append((existing.id, existing.status == "merged"))
                continue
            after, after_merged = step_experiment[step["after"]] if step["after"] is not None else (None, True)
            experiment = Experiment(
                project_id=project_id,
                claim_id=claim_id,
                triage_id=triage_id,
                thread_id=f"exp-{uuid.uuid4()}",
                status="queued" if after_merged else "blocked",
                mode=mode,
                bundle_claim_ids=step["bundle"],
                depends_on_experiment_id=after,
            )
            session.add(experiment)
            session.flush()
            created.append(experiment.id)
            step_experiment.append((experiment.id, False))
            if not after_merged:
                blocked.add(experiment.id)
        if triage_id:
            session.execute(
                update(Triage).where(Triage.id == triage_id).values(status="picked", selected=claim_ids)
            )
    for experiment_id in created:
        if experiment_id in blocked:
            emit("plan", f"Experiment created ({mode}): waits for its prerequisite experiment to be merged",
                 experiment_id=experiment_id, triage_id=triage_id)
            continue
        emit("plan", f"Experiment created (Gate 1: claim picked, {mode})", experiment_id=experiment_id, triage_id=triage_id)
        enqueue("experiment.run", {"experiment_id": experiment_id}, experiment_id=experiment_id)
    return [get_experiment(experiment_id) for experiment_id in created]


def release_dependents(experiment_id: int, merged: bool) -> list[int]:
    """After a prerequisite finishes: start dependents if it was merged, else explain why they wait."""
    with session_scope() as session:
        dependents = session.scalars(
            select(Experiment.id).where(
                Experiment.depends_on_experiment_id == experiment_id, Experiment.status == "blocked"
            )
        ).all()
        for dependent in dependents:
            values = {"status": "queued", "error": None} if merged else {
                "error": f"plan: prerequisite experiment #{experiment_id} was not merged — retry to run without it"
            }
            session.execute(update(Experiment).where(Experiment.id == dependent).values(**values))
    for dependent in dependents:
        if merged:
            emit("plan", f"Prerequisite #{experiment_id} merged — starting", experiment_id=dependent)
            enqueue("experiment.run", {"experiment_id": dependent}, experiment_id=dependent)
        else:
            emit("plan", f"Prerequisite #{experiment_id} was not merged", experiment_id=dependent, level="warning")
    return list(dependents)


# ---- triage -----------------------------------------------------------------------


def start_triage(project_id: int, options: Optional[dict] = None) -> dict[str, Any]:
    with session_scope() as session:
        if session.get(Project, project_id) is None:
            raise ServiceError(f"project {project_id} not found", 404)
        running = session.scalar(
            select(Triage.id).where(
                Triage.project_id == project_id,
                Triage.status.notin_(("awaiting_pick", "picked", "failed", "done")),
            )
        )
        if running:
            raise ServiceError(f"triage {running} is already running for this project", 409)
        triage = Triage(project_id=project_id, thread_id=f"triage-{uuid.uuid4()}", status="queued", options=options or {})
        session.add(triage)
        session.flush()
        triage_id = triage.id
    emit("topics", "Research scan queued", triage_id=triage_id)
    enqueue("triage.run", {"triage_id": triage_id}, triage_id=triage_id)
    return get_triage(triage_id)


def get_triage(triage_id: int) -> dict[str, Any]:
    with session_scope() as session:
        triage = session.get(Triage, triage_id)
        if triage is None:
            raise ServiceError(f"triage {triage_id} not found", 404)
        return {
            "id": triage.id,
            "project_id": triage.project_id,
            "status": triage.status,
            "options": triage.options,
            "shortlist": triage.shortlist,
            "selected": triage.selected,
            "created_at": _iso(triage.created_at),
            "updated_at": _iso(triage.updated_at),
            "events": events_since(0, triage_id=triage_id)[-200:],
        }


def list_triage(project_id: Optional[int] = None, limit: int = 20) -> list[dict[str, Any]]:
    with session_scope() as session:
        query = select(Triage).order_by(Triage.id.desc()).limit(limit)
        if project_id:
            query = query.where(Triage.project_id == project_id)
        return [
            {
                "id": t.id,
                "project_id": t.project_id,
                "status": t.status,
                "options": t.options,
                "shortlist_size": len(t.shortlist or []),
                "created_at": _iso(t.created_at),
                "updated_at": _iso(t.updated_at),
            }
            for t in session.scalars(query).all()
        ]


# ---- experiments + Gates 2 and 3 ---------------------------------------------------------


def experiment_status(experiment_id: int) -> str:
    with session_scope() as session:
        status = session.scalar(select(Experiment.status).where(Experiment.id == experiment_id))
    if status is None:
        raise ServiceError(f"experiment {experiment_id} not found", 404)
    return status


def experiment_context(experiment_id: int) -> dict[str, Any]:
    """Everything the orchestrator nodes need about one experiment."""
    with session_scope() as session:
        experiment = session.get(Experiment, experiment_id)
        if experiment is None:
            raise ServiceError(f"experiment {experiment_id} not found", 404)
        project = session.get(Project, experiment.project_id)
        claim, concept, paper = session.execute(
            select(Claim, Concept, Paper)
            .join(Concept, Concept.id == Claim.concept_id)
            .join(Paper, Paper.paper_id == Claim.paper_id)
            .where(Claim.id == experiment.claim_id)
        ).one()
        match = session.scalar(
            select(Match).where(Match.project_id == project.id, Match.claim_id == claim.id)
        )
        bundle = []
        if experiment.bundle_claim_ids:
            members = session.execute(
                select(Claim, Concept, Paper)
                .join(Concept, Concept.id == Claim.concept_id)
                .join(Paper, Paper.paper_id == Claim.paper_id)
                .where(Claim.id.in_(experiment.bundle_claim_ids))
            ).all()
            by_id = {row[0].id: claim_dict(*row) for row in members}
            bundle = [by_id[cid] for cid in experiment.bundle_claim_ids if cid in by_id]
        prerequisite_flags: list[str] = []
        cursor = experiment.depends_on_experiment_id
        while cursor:
            parent = session.get(Experiment, cursor)
            if parent is None:
                break
            if parent.status == "merged" and parent.flag_name:
                prerequisite_flags.insert(0, parent.flag_name)
            cursor = parent.depends_on_experiment_id
        return {
            "bundle": bundle,
            "prerequisite_flags": prerequisite_flags,
            "experiment": {
                "id": experiment.id,
                "status": experiment.status,
                "branch": experiment.branch,
                "worktree_path": experiment.worktree_path,
                "build": experiment.build or {},
                "flag_name": experiment.flag_name,
                "mode": experiment.mode,
                "depends_on_experiment_id": experiment.depends_on_experiment_id,
                "rerun_of_experiment_id": experiment.rerun_of_experiment_id,
            },
            "project": {"id": project.id, "name": project.name, "repo_path": project.repo_path},
            "profile": project.profile or {},
            "claim": {
                **claim_dict(claim, concept, paper),
                "method_excerpt": method_excerpt(paper.raw_text, paper.abstract, claim.evidence_quote),
            },
            "paper": {"paper_id": paper.paper_id, "title": paper.title, "url": paper.url},
            "match": (
                {"target_metric": match.target_metric, "score": match.score, "prediction": match.prediction}
                if match
                else None
            ),
            "roofline": project.roofline,
            "spec": experiment.spec or {},
            "worktree": Path(experiment.worktree_path) if experiment.worktree_path else None,
        }


def latest_run_id(experiment_id: int, kind: str) -> Optional[int]:
    with session_scope() as session:
        return session.scalar(
            select(Run.id)
            .where(Run.experiment_id == experiment_id, Run.kind == kind, Run.status == "done")
            .order_by(Run.id.desc())
            .limit(1)
        )


def run_results(run_id: int) -> dict[str, Any]:
    with session_scope() as session:
        run = session.get(Run, run_id)
        if run is None or run.status != "done":
            raise ServiceError(f"run {run_id} has no completed results", 409)
        return run.results


def latest_results(experiment_id: int, kind: str) -> dict[str, Any]:
    with session_scope() as session:
        run = session.scalar(
            select(Run)
            .where(Run.experiment_id == experiment_id, Run.kind == kind, Run.status == "done")
            .order_by(Run.id.desc())
        )
        if run is None:
            raise ServiceError(f"no completed {kind} run for experiment {experiment_id}", 409)
        return run.results


def _stage_progress(status: str, error: Optional[str]) -> list[dict[str, str]]:
    current = stage_of(status, error)
    stages = []
    reached = True
    for stage in STAGES:
        if status in ("failed", "cancelled", "cancelling") and stage == current:
            state = status
            reached = False
        elif stage == current:
            state = "done" if status in ("merged", "dropped") else (
                "waiting" if status in GATE_OF_STATUS or status == "blocked" else "active"
            )
            if status == "rejected":
                state = "rejected"
            reached = False
        else:
            state = "done" if reached else "pending"
        stages.append({"stage": stage, "state": state})
    return stages


def experiment_summary(experiment: Experiment, claim: Claim, concept: Concept, paper: Paper, verdict: Optional[Verdict]) -> dict[str, Any]:
    # The adoption check (method vs the project default on its workload) only exists when it ran separately from
    # the claim check; lists show both so a claim-check gain can't hide a regression on the default workload.
    adoption = (verdict.details or {}).get("adoption") if verdict else None
    adoption = adoption if isinstance(adoption, dict) else {}
    return {
        "id": experiment.id,
        "project_id": experiment.project_id,
        "claim_id": experiment.claim_id,
        "triage_id": experiment.triage_id,
        "status": experiment.status,
        "gate": GATE_OF_STATUS.get(experiment.status),
        "stage": stage_of(experiment.status, experiment.error),
        "flag_name": experiment.flag_name,
        "branch": experiment.branch,
        "error": experiment.error,
        "mode": experiment.mode,
        "bundle_claim_ids": list(experiment.bundle_claim_ids or []),
        "depends_on_experiment_id": experiment.depends_on_experiment_id,
        "rerun_of_experiment_id": experiment.rerun_of_experiment_id,
        "title": concept.name,
        "technique": claim.technique,
        "category": claim.category,
        "claimed_gain_pct": claim.claimed_gain_pct,
        "paper_id": paper.paper_id,
        "paper_title": paper.title,
        "verdict": verdict.verdict if verdict else None,
        "median_delta_pct": verdict.median_delta_pct if verdict else None,
        "adoption_verdict": adoption.get("verdict"),
        "adoption_median_delta_pct": adoption.get("median_delta_pct"),
        "created_at": _iso(experiment.created_at),
        "updated_at": _iso(experiment.updated_at),
    }


def list_experiments(project_id: Optional[int] = None, status: Optional[str] = None, limit: int = 100) -> list[dict[str, Any]]:
    with session_scope() as session:
        query = (
            select(Experiment, Claim, Concept, Paper, Verdict)
            .join(Claim, Claim.id == Experiment.claim_id)
            .join(Concept, Concept.id == Claim.concept_id)
            .join(Paper, Paper.paper_id == Claim.paper_id)
            .outerjoin(Verdict, Verdict.experiment_id == Experiment.id)
            .order_by(Experiment.id.desc())
            .limit(limit)
        )
        if project_id:
            query = query.where(Experiment.project_id == project_id)
        if status == "active":
            query = query.where(Experiment.status.in_(ACTIVE_STATUSES))
        elif status == "needs_you":
            query = query.where(Experiment.status.in_(tuple(GATE_OF_STATUS)))
        elif status:
            query = query.where(Experiment.status == status)
        return [experiment_summary(*row) for row in session.execute(query).all()]


def get_experiment(experiment_id: int) -> dict[str, Any]:
    with session_scope() as session:
        row = session.execute(
            select(Experiment, Claim, Concept, Paper, Verdict)
            .join(Claim, Claim.id == Experiment.claim_id)
            .join(Concept, Concept.id == Claim.concept_id)
            .join(Paper, Paper.paper_id == Claim.paper_id)
            .outerjoin(Verdict, Verdict.experiment_id == Experiment.id)
            .where(Experiment.id == experiment_id)
        ).first()
        if row is None:
            raise ServiceError(f"experiment {experiment_id} not found", 404)
        experiment, claim, concept, paper, verdict = row
        project = session.get(Project, experiment.project_id)
        runs = session.scalars(select(Run).where(Run.experiment_id == experiment_id).order_by(Run.id)).all()
        data = experiment_summary(*row)
        profile = project.profile or {}
        data.update(
            project={"id": project.id, "name": project.name, "repo_path": project.repo_path},
            claim=claim_dict(claim, concept, paper),
            spec=experiment.spec or {},
            editable_fields=list(EDITABLE_FIELDS),
            spec_options={
                "metrics": [m.get("name") for m in profile.get("metrics") or []],
                "workloads": _workloads(profile),
                "models": list((profile.get("models") or {}).keys()),
            },
            build=experiment.build or {},
            bundle=[
                {"claim_id": c["id"], "name": c["name"], "technique": c["technique"]}
                for c in experiment_context(experiment_id)["bundle"]
            ] if experiment.bundle_claim_ids else [],
            dependents=[
                {"id": d.id, "status": d.status, "claim_id": d.claim_id}
                for d in session.scalars(select(Experiment).where(Experiment.depends_on_experiment_id == experiment_id)).all()
            ],
            related=related_for_claims([claim.id], experiment.project_id).get(claim.id),
            worktree_path=experiment.worktree_path,
            stages=_stage_progress(experiment.status, experiment.error),
            runs=[
                {
                    "id": run.id,
                    "kind": run.kind,
                    "status": run.status,
                    "command": run.command,
                    "started_at": _iso(run.started_at),
                    "finished_at": _iso(run.finished_at),
                    "summary": (run.results or {}).get("summary"),
                    "quality": (run.results or {}).get("quality"),
                    "model": (run.results or {}).get("model"),
                    "comparison": (run.results or {}).get("comparison"),
                    "mechanism": (run.results or {}).get("mechanism"),
                }
                for run in runs
            ],
            verdict_detail=(
                {
                    "verdict": verdict.verdict,
                    "primary_metric": verdict.primary_metric,
                    "median_delta_pct": verdict.median_delta_pct,
                    "ci_low_pct": verdict.ci_low_pct,
                    "ci_high_pct": verdict.ci_high_pct,
                    "claimed_gain_pct": verdict.claimed_gain_pct,
                    "quality_ok": verdict.quality_ok,
                    "details": verdict.details,
                    "has_report": bool(verdict.report_path and Path(verdict.report_path).exists()),
                }
                if verdict
                else None
            ),
        )
        return data


def _workloads(profile: dict[str, Any]) -> list[str]:
    workloads = profile.get("workloads") or []
    if isinstance(workloads, dict):
        return list(workloads)
    return [w["name"] if isinstance(w, dict) else str(w) for w in workloads]


def report_path(experiment_id: int) -> Path:
    with session_scope() as session:
        path = session.scalar(select(Verdict.report_path).where(Verdict.experiment_id == experiment_id))
    if not path or not Path(path).exists():
        raise ServiceError("report not available yet", 404)
    return Path(path)


def _require_status(experiment_id: int, expected: tuple[str, ...]) -> None:
    status = experiment_status(experiment_id)
    if status not in expected:
        raise ServiceError(f"experiment {experiment_id} is '{status}', expected one of {expected}", 409)


def _lock_experiment(session, experiment_id: int, expected: tuple[str, ...]) -> Experiment:
    """Row-lock the experiment and check its status, so concurrent gate decisions serialize and
    only the first one can make the transition (the others get a 409)."""
    experiment = session.scalar(select(Experiment).where(Experiment.id == experiment_id).with_for_update())
    if experiment is None:
        raise ServiceError(f"experiment {experiment_id} not found", 404)
    if experiment.status not in expected:
        raise ServiceError(f"experiment {experiment_id} is '{experiment.status}', expected one of {expected}", 409)
    return experiment


def _apply_spec_overrides(session, experiment: Experiment, overrides: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    try:
        spec = apply_overrides(experiment.spec or {}, overrides, profile)
    except ValueError as exc:
        raise ServiceError(str(exc)) from exc
    experiment.spec = spec
    experiment.flag_name = spec["flag_name"]
    session.add(
        Event(stage="approve", message=f"Spec edited: {', '.join(sorted(overrides))}", data={"overrides": overrides},
              experiment_id=experiment.id)
    )
    return spec


def update_spec(experiment_id: int, overrides: dict[str, Any]) -> dict[str, Any]:
    profile = experiment_context(experiment_id)["profile"]
    with session_scope() as session:
        experiment = _lock_experiment(session, experiment_id, ("awaiting_approval",))
        return _apply_spec_overrides(session, experiment, overrides, profile)


def _transition_gate(
    session,
    experiment: Experiment,
    gate: str,
    new_status: str,
    stage: str,
    message: str,
    resume: dict[str, Any],
) -> None:
    """Move the experiment off its gate and queue the resume job in the caller's transaction.
    The resume payload names its gate, so the graph ignores it if replayed at another gate."""
    experiment.status = new_status
    experiment.updated_at = func.now()
    session.add(Event(stage=stage, message=message, data={"comment": resume.get("comment")}, experiment_id=experiment.id))
    session.add(
        Job(
            kind="experiment.resume",
            payload={"experiment_id": experiment.id, "resume": {**resume, "gate": gate}},
            experiment_id=experiment.id,
        )
    )


def decide_spec(
    experiment_id: int,
    decision: str,
    overrides: Optional[dict[str, Any]] = None,
    comment: Optional[str] = None,
) -> dict[str, Any]:
    if decision not in ("approve", "reject", "revise"):
        raise ServiceError("decision must be approve, reject or revise")
    _require_status(experiment_id, ("awaiting_approval",))
    if decision == "revise" and not comment:
        raise ServiceError("a comment is required to request a revision")
    profile = experiment_context(experiment_id)["profile"] if overrides else {}
    with session_scope() as session:
        experiment = _lock_experiment(session, experiment_id, ("awaiting_approval",))
        spec = _apply_spec_overrides(session, experiment, overrides, profile) if overrides else (experiment.spec or {})
        _transition_gate(
            session,
            experiment,
            "approve_spec",
            {"approve": "approving", "revise": "planning", "reject": "rejected"}[decision],
            "approve",
            f"Gate 2: {decision} requested",
            {"decision": decision, "comment": comment, "spec": spec},
        )
    return get_experiment(experiment_id)


def decide_merge(experiment_id: int, decision: str, comment: Optional[str] = None) -> dict[str, Any]:
    if decision not in ("merge", "drop"):
        raise ServiceError("decision must be merge or drop")
    with session_scope() as session:
        experiment = _lock_experiment(session, experiment_id, ("awaiting_decision",))
        _transition_gate(
            session,
            experiment,
            "merge",
            "finalizing",
            "decide",
            f"Gate 3: {decision} requested",
            {"decision": decision, "comment": comment},
        )
    return get_experiment(experiment_id)


def cancel_experiment(experiment_id: int) -> dict[str, Any]:
    status = experiment_status(experiment_id)
    if status in TERMINAL_STATUSES:
        raise ServiceError(f"experiment is already {status}", 409)
    with session_scope() as session:
        status = session.scalar(select(Experiment.status).where(Experiment.id == experiment_id).with_for_update())
        if status in TERMINAL_STATUSES:
            raise ServiceError(f"experiment is already {status}", 409)
        queued = session.execute(
            update(Job)
            .where(Job.experiment_id == experiment_id, Job.status == "queued")
            .values(status="cancelled")
        ).rowcount
        running = session.scalar(
            select(func.count()).where(Job.experiment_id == experiment_id, Job.status == "running")
        )
        new_status = "cancelling" if running else "cancelled"
        session.execute(
            update(Experiment)
            .where(Experiment.id == experiment_id)
            .values(status=new_status, error=f"{STAGE_OF_STATUS.get(status, 'plan')}: cancelled by user")
        )
    emit("cancel", f"Cancel requested ({queued} queued job(s) cancelled)", experiment_id=experiment_id, level="warning")
    return get_experiment(experiment_id)


def retry_experiment(experiment_id: int) -> dict[str, Any]:
    with session_scope() as session:
        experiment = _lock_experiment(session, experiment_id, ("failed", "cancelled", "blocked"))
        experiment.status = "queued"
        session.add(Event(stage="retry", message="Retrying from the last completed step", experiment_id=experiment_id))
        session.add(Job(kind="experiment.run", payload={"experiment_id": experiment_id}, experiment_id=experiment_id))
    return get_experiment(experiment_id)


RERUNNABLE_STATUSES = ("awaiting_decision", "merged", "dropped", "rejected", "failed", "cancelled")


def rerun_experiment(experiment_id: int, replan: bool = False, comment: Optional[str] = None) -> dict[str, Any]:
    """Start a new experiment for the same claim (same mode and bundle) on the project's current code.

    By default the new experiment reuses the previous spec and stops at Gate 2 so it can be reviewed or edited;
    with `replan` the spec is written again from the paper, with the previous result as feedback. The previous
    experiment is left untouched (its verdict and branch stay available)."""
    with session_scope() as session:
        old = _lock_experiment(session, experiment_id, RERUNNABLE_STATUSES)
        in_flight = session.execute(
            select(Experiment.id, Experiment.status).where(
                Experiment.project_id == old.project_id,
                Experiment.claim_id == old.claim_id,
                Experiment.id != old.id,
                Experiment.status.notin_(RERUNNABLE_STATUSES),
            )
        ).first()
        if in_flight:
            raise ServiceError(f"claim already has experiment {in_flight.id} in progress ({in_flight.status})", 409)
        spec = {}
        if not replan and old.spec:
            spec = {k: v for k, v in old.spec.items() if k not in ("prediction",)}
        experiment = Experiment(
            project_id=old.project_id,
            claim_id=old.claim_id,
            triage_id=old.triage_id,
            thread_id=f"exp-{uuid.uuid4()}",
            status="queued",
            mode=old.mode,
            bundle_claim_ids=list(old.bundle_claim_ids or []),
            rerun_of_experiment_id=old.id,
            spec=spec,
        )
        session.add(experiment)
        session.flush()
        new_id = experiment.id
        how = "re-planning the spec from the paper" if replan or not spec else "reusing its spec (review it at Gate 2)"
        note = f" — {comment}" if comment else ""
        session.add(Event(stage="plan", message=f"Re-run of #{old.id}: {how}{note}", experiment_id=new_id))
        session.add(Event(stage="plan", message=f"Re-run started as #{new_id}{note}", experiment_id=old.id))
        session.add(Job(kind="experiment.run", payload={"experiment_id": new_id}, experiment_id=new_id))
    return get_experiment(new_id)


def rerun_feedback(experiment_id: int) -> Optional[str]:
    """What the previous run of this claim learned, for the planner when re-planning."""
    with session_scope() as session:
        experiment = session.get(Experiment, experiment_id)
        if experiment is None or not experiment.rerun_of_experiment_id:
            return None
        previous = session.get(Experiment, experiment.rerun_of_experiment_id)
        verdict = session.scalar(select(Verdict).where(Verdict.experiment_id == previous.id))
    if verdict is None:
        return f"This re-runs experiment #{previous.id}, which ended as '{previous.status}' ({previous.error or 'no verdict'})."
    analysis = (verdict.details or {}).get("analysis") or {}
    return (
        f"This re-runs experiment #{previous.id} (previous verdict: {verdict.verdict}, "
        f"{verdict.median_delta_pct if verdict.median_delta_pct is not None else 'n/a'}% on {verdict.primary_metric}). "
        f"Diagnosis then: {analysis.get('diagnosis')} — {analysis.get('summary')}. "
        f"Suggested change then: {analysis.get('next_changes') or 'none'}. Design this run to address it."
    )


def experiment_events(experiment_id: int, after_id: int = 0) -> list[dict[str, Any]]:
    return events_since(after_id, experiment_id=experiment_id)


def experiment_log(experiment_id: int, max_bytes: int = 200_000) -> dict[str, Any]:
    from paperatlas import settings

    experiment_status(experiment_id)
    folder = settings.data_dir().resolve() / "r2e" / "experiments" / str(experiment_id)
    logs = sorted(folder.glob("*.log"), key=lambda p: p.stat().st_mtime) if folder.exists() else []
    if not logs:
        return {"file": None, "text": ""}
    latest = logs[-1]
    data = latest.read_bytes()[-max_bytes:]
    return {"file": latest.name, "files": [p.name for p in logs], "text": data.decode("utf-8", errors="replace")}


def recent_activity(limit: int = 50) -> list[dict[str, Any]]:
    with session_scope() as session:
        events = session.scalars(select(Event).order_by(Event.id.desc()).limit(limit)).all()
        return [event_dict(event) for event in events]


def dump(value: Any) -> str:
    return json.dumps(value, default=str)
