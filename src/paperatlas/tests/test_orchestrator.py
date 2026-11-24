"""End-to-end experiment graph with fake builder/benchmarks: LangGraph interrupts, Postgres
checkpoints, job queue, gates, verdict and report."""

import pytest
from fastapi.testclient import TestClient

from paperatlas.concepts.extraction.models import PaperMetadata
from paperatlas.db.store import PaperStore
from paperatlas.distill.extractor import ClaimExtractor
from paperatlas.distill.pipeline import DistillPipeline
from paperatlas.lab import orchestrator, service
from paperatlas.lab.events import claim_next_job
from paperatlas.lab.matcher import match_project
from paperatlas.lab.profiler import register_project
from paperatlas.services.worker import execute
from paperatlas.tests.conftest import FakeLLM, bench_results, concept


def drain():
    ran = []
    while (job := claim_next_job()) is not None:
        execute(job)
        ran.append(job["kind"])
    return ran


@pytest.fixture()
def lab(db, demo_repo, monkeypatch, tmp_path):
    orchestrator.setup_checkpointer()
    PaperStore().upsert(PaperMetadata(title="N-gram drafting", abstract="We draft tokens. " * 30, arxiv_id="2401.00001", source="arxiv"))
    llm = FakeLLM({"paper_distillation": {"paper_summary": "s", "concepts": [concept("Draft tokens using n-gram prompt lookup", value=20, unit="%")]}})
    DistillPipeline(extractor=ClaimExtractor(llm)).run(limit=5)
    project = register_project(demo_repo)
    match_project(project["id"], use_llm=False)
    monkeypatch.setattr(orchestrator, "build_default_llm_client", lambda: None)

    calls = {"build": 0, "bench": []}

    def fake_build(experiment_id, workdir, spec, claim, profile, artifacts, report, should_cancel, **kwargs):
        calls.setdefault("feedback", []).append(kwargs.get("initial_feedback"))
        calls["build"] += 1
        (workdir / "technique.py").write_text("x = 1\n")
        return {"builder": "fake", "attempts": [{"attempt": 1}], "files": ["technique.py"], "diff_stat": "1 file"}

    def fake_bench(experiment_id, kind, workdir, spec, profile, artifacts, report, should_cancel, **kwargs):
        from datetime import UTC, datetime

        from paperatlas.db.engine import session_scope
        from paperatlas.db.schema import Run

        calls["bench"].append((kind, spec["rounds"]))
        results = bench_results([100, 101, 99, 100], [121, 122, 120, 121])
        with session_scope() as session:
            session.add(Run(experiment_id=experiment_id, kind=kind, status="done", results=results, finished_at=datetime.now(UTC)))
        return results

    monkeypatch.setattr(orchestrator, "build_experiment", fake_build)
    monkeypatch.setattr(orchestrator, "run_benchmark", fake_bench)
    return {"project": project, "calls": calls, "repo": demo_repo}


def test_experiment_runs_through_all_gates_and_merges(lab):
    recommendations = service.recommendations(lab["project"]["id"])
    assert recommendations and recommendations[0]["target_metric"] == "decode_tokens_per_s"

    experiment = service.create_experiments(lab["project"]["id"], [recommendations[0]["claim_id"]])[0]
    drain()
    detail = service.get_experiment(experiment["id"])
    assert detail["status"] == "awaiting_approval" and detail["gate"] == "approve_spec"
    assert detail["spec"]["primary_metric"] == "decode_tokens_per_s"

    with pytest.raises(service.ServiceError):
        service.decide_merge(experiment["id"], "merge")

    service.decide_spec(experiment["id"], "approve", overrides={"rounds": 4})
    drain()
    detail = service.get_experiment(experiment["id"])
    assert detail["status"] == "awaiting_decision", detail["error"]
    assert lab["calls"]["bench"] == [("smoke", 4), ("eval", 4)]
    assert detail["verdict_detail"]["verdict"] == "reproduced"
    assert detail["verdict_detail"]["has_report"]
    assert [s["state"] for s in detail["stages"]] == ["done"] * 7 + ["waiting"]

    service.decide_merge(experiment["id"], "merge")
    drain()
    detail = service.get_experiment(experiment["id"])
    assert detail["status"] == "merged"
    log = orchestrator.git(lab["repo"], "log", "--oneline")
    assert "r2e: merge" in log and (lab["repo"] / "technique.py").exists()


def test_revision_replans_and_reject_ends_experiment(lab):
    claim_id = service.recommendations(lab["project"]["id"])[0]["claim_id"]
    experiment_id = service.create_experiments(lab["project"]["id"], [claim_id])[0]["id"]
    drain()
    with pytest.raises(service.ServiceError):
        service.decide_spec(experiment_id, "revise", overrides={"rounds": 30})
    assert service.get_experiment(experiment_id)["spec"]["rounds"] != 30
    service.decide_spec(experiment_id, "revise", comment="use the long_prompt workload")
    drain()
    assert service.experiment_status(experiment_id) == "awaiting_approval"
    service.decide_spec(experiment_id, "reject", comment="not worth it")
    drain()
    assert service.experiment_status(experiment_id) == "rejected"
    assert lab["calls"]["build"] == 0


def test_cancel_at_gate_then_retry_restores_the_gate(lab):
    claim_id = service.recommendations(lab["project"]["id"])[0]["claim_id"]
    experiment_id = service.create_experiments(lab["project"]["id"], [claim_id])[0]["id"]
    drain()
    assert service.cancel_experiment(experiment_id)["status"] == "cancelled"
    service.retry_experiment(experiment_id)
    drain()
    assert service.experiment_status(experiment_id) == "awaiting_approval"


def test_lab_api_gate_endpoints(lab):
    from paperatlas.services.lab_api import app

    client = TestClient(app)
    project_id = lab["project"]["id"]
    recs = client.get(f"/projects/{project_id}/recommendations").json()
    created = client.post("/experiments", json={"project_id": project_id, "claim_ids": [recs[0]["claim_id"]]})
    assert created.status_code == 200
    experiment_id = created.json()[0]["id"]
    duplicate = client.post("/experiments", json={"project_id": project_id, "claim_ids": [recs[0]["claim_id"]]})
    assert duplicate.status_code == 409
    drain()
    bad = client.patch(f"/experiments/{experiment_id}/spec", json={"overrides": {"primary_metric": "bleu"}})
    assert bad.status_code == 400
    edited = client.patch(f"/experiments/{experiment_id}/spec", json={"overrides": {"success_threshold_pct": 3}})
    assert edited.json()["success_threshold_pct"] == 3
    approved = client.post(f"/experiments/{experiment_id}/spec/decision", json={"decision": "approve"})
    assert approved.json()["status"] == "approving"
    assert client.get(f"/experiments/{experiment_id}/events").json()
    assert client.get("/experiments", params={"status": "active"}).json()[0]["id"] == experiment_id


def test_failed_experiment_reports_the_stage_it_stopped_in(lab, monkeypatch):
    def broken_build(*args, **kwargs):
        raise RuntimeError("compiler exploded")

    monkeypatch.setattr(orchestrator, "build_experiment", broken_build)
    claim_id = service.recommendations(lab["project"]["id"])[0]["claim_id"]
    experiment_id = service.create_experiments(lab["project"]["id"], [claim_id])[0]["id"]
    drain()
    service.decide_spec(experiment_id, "approve")
    drain()
    detail = service.get_experiment(experiment_id)
    assert detail["status"] == "failed" and detail["stage"] == "build"
    assert [s["state"] for s in detail["stages"]] == ["done", "done", "failed"] + ["pending"] * 5
    assert "compiler exploded" in detail["error"]


def test_lost_checkpoint_is_rebuilt_from_the_experiment_row(lab):
    from sqlalchemy import text

    from paperatlas.db.engine import get_engine

    claim_id = service.recommendations(lab["project"]["id"])[0]["claim_id"]
    experiment_id = service.create_experiments(lab["project"]["id"], [claim_id])[0]["id"]
    drain()
    service.decide_spec(experiment_id, "approve")
    drain()
    assert service.experiment_status(experiment_id) == "awaiting_decision"
    with get_engine(lab_db_url()).begin() as connection:
        for table in ("checkpoint_writes", "checkpoint_blobs", "checkpoints"):
            connection.execute(text(f"DELETE FROM agent.{table}"))
    service.decide_merge(experiment_id, "drop")
    drain()
    assert service.experiment_status(experiment_id) == "dropped"
    assert lab["calls"]["build"] == 1
    assert any(e["stage"] == "recover" for e in service.experiment_events(experiment_id))


def lab_db_url():
    import os

    return os.environ["PAPERATLAS_DATABASE_URL"]


CONCEPT_MAP = {
    "order": [1, 2, 3],
    "roles": [{"concept": 1, "role": "foundation"}, {"concept": 2, "role": "core"}, {"concept": 3, "role": "core"}],
    "links": [
        {"from": 3, "to": 2, "relation": "requires", "why": "the loop needs the gate", "evidence": "Sec 3"},
        {"from": 2, "to": 1, "relation": "requires", "why": "the gate scores drafts", "evidence": None},
        {"from": 1, "to": 3, "relation": "complements", "why": "together", "evidence": None},
        {"from": 2, "to": 2, "relation": "builds_on", "why": "self link is dropped", "evidence": None},
        {"from": 9, "to": 1, "relation": "requires", "why": "bad index is dropped", "evidence": None},
    ],
    "bundles": [{"name": "DLoop", "concepts": [1, 2, 3], "effect": "+41% speedup", "is_headline_result": True}],
    "reading_path": "Start with the drafter, then the gate, then the loop.",
}


@pytest.fixture()
def linked(lab):
    from paperatlas.db.engine import session_scope
    from paperatlas.db.schema import Claim, Concept
    from sqlalchemy import select

    PaperStore().upsert(PaperMetadata(title="DLoop", abstract="Looped drafting. " * 30, arxiv_id="2610.07659", source="arxiv"))
    llm = FakeLLM(
        {
            "paper_distillation": {
                "paper_summary": "s",
                "concepts": [
                    concept("Draft tokens with a small model", value=10, unit="%"),
                    concept("Gate on summed log probabilities", value=5, unit="%"),
                    concept("Loop over drafted blocks before verifying", value=41, unit="%"),
                ],
            },
            "concept_map": CONCEPT_MAP,
        }
    )
    DistillPipeline(extractor=ClaimExtractor(llm)).run(paper_ids=["arxiv:2610.07659"])
    match_project(lab["project"]["id"], use_llm=False)
    with session_scope() as session:
        rows = session.execute(
            select(Concept.name, Claim.id).join(Claim, Claim.concept_id == Concept.id).where(Concept.paper_id == "arxiv:2610.07659")
        ).all()
    ids = {name.split()[0]: claim_id for name, claim_id in rows}
    return {**lab, "draft": ids["Draft"], "gate": ids["Gate"], "loop": ids["Loop"]}


def test_concept_map_links_related_claims_and_prerequisites(linked):
    from paperatlas.distill.relations import paper_concept_map, related_for_claims

    related = related_for_claims([linked["loop"]])[linked["loop"]]
    assert [r["claim_id"] for r in related["requires"]] == [linked["gate"]]
    assert [r["claim_id"] for r in related["complements"]] == [linked["draft"]]
    assert [p["claim_id"] for p in related["prerequisites"]] == [linked["draft"], linked["gate"]]
    assert related["bundles"][0]["effect"] == "+41% speedup" and related["order"] == 3
    concept_map = paper_concept_map("arxiv:2610.07659")
    assert [n["claim_id"] for n in concept_map["nodes"]] == [linked["draft"], linked["gate"], linked["loop"]]
    assert len(concept_map["links"]) == 3 and concept_map["nodes"][0]["role"] == "foundation"


def test_bundle_mode_creates_one_experiment_with_prerequisites(linked):
    experiment = service.create_experiments(linked["project"]["id"], [linked["loop"]], mode="bundle")[0]
    assert experiment["bundle_claim_ids"] == [linked["draft"], linked["gate"]]
    drain()
    detail = service.get_experiment(experiment["id"])
    assert detail["status"] == "awaiting_approval"
    assert detail["spec"]["bundle_claim_ids"] == [linked["draft"], linked["gate"]]
    assert [b["claim_id"] for b in detail["bundle"]] == [linked["draft"], linked["gate"]]


def test_chain_mode_runs_prerequisites_first_and_builds_on_merged_flags(linked):
    created = service.create_experiments(linked["project"]["id"], [linked["loop"]], mode="chain")
    assert [(e["claim_id"], e["status"]) for e in created] == [
        (linked["draft"], "queued"),
        (linked["gate"], "blocked"),
        (linked["loop"], "blocked"),
    ]
    first, second, third = (e["id"] for e in created)
    drain()
    service.decide_spec(first, "approve")
    drain()
    service.decide_merge(first, "merge")
    drain()
    assert service.experiment_status(first) == "merged"
    assert service.experiment_status(second) == "awaiting_approval"
    assert service.experiment_status(third) == "blocked"
    first_flag = service.get_experiment(first)["flag_name"]
    assert service.get_experiment(second)["spec"]["baseline_flags"] == [first_flag]

    service.decide_spec(second, "reject", comment="not now")
    drain()
    third_detail = service.get_experiment(third)
    assert third_detail["status"] == "blocked" and "was not merged" in third_detail["error"]


def _at_gate_3(lab):
    claim_id = service.recommendations(lab["project"]["id"])[0]["claim_id"]
    experiment_id = service.create_experiments(lab["project"]["id"], [claim_id])[0]["id"]
    drain()
    service.decide_spec(experiment_id, "approve")
    drain()
    assert service.experiment_status(experiment_id) == "awaiting_decision"
    return experiment_id


def _drop_checkpoints():
    from sqlalchemy import text

    from paperatlas.db.engine import get_engine

    with get_engine(lab_db_url()).begin() as connection:
        for table in ("checkpoint_writes", "checkpoint_blobs", "checkpoints"):
            connection.execute(text(f"DELETE FROM agent.{table}"))


def test_resume_for_another_gate_is_ignored(lab):
    from paperatlas.lab.events import enqueue

    experiment_id = _at_gate_3(lab)
    branch = service.get_experiment(experiment_id)["branch"]
    for resume in ({"gate": "approve_spec", "decision": "approve"}, {"decision": "drop"}):
        enqueue("experiment.resume", {"experiment_id": experiment_id, "resume": resume}, experiment_id=experiment_id)
        drain()
        assert service.experiment_status(experiment_id) == "awaiting_decision"
    assert orchestrator.git(lab["repo"], "branch", "--list", branch)
    service.decide_merge(experiment_id, "merge")
    drain()
    assert service.experiment_status(experiment_id) == "merged"


def test_resume_job_requeued_mid_build_continues_from_checkpoint(lab, monkeypatch):
    from paperatlas.lab.process import WorkerShutdown

    real_build, interrupted = orchestrator.build_experiment, []

    def build_once_interrupted(*args, **kwargs):
        if not interrupted:
            interrupted.append(1)
            raise WorkerShutdown("worker is shutting down")
        return real_build(*args, **kwargs)

    monkeypatch.setattr(orchestrator, "build_experiment", build_once_interrupted)
    claim_id = service.recommendations(lab["project"]["id"])[0]["claim_id"]
    experiment_id = service.create_experiments(lab["project"]["id"], [claim_id])[0]["id"]
    drain()
    service.decide_spec(experiment_id, "approve")
    drain()  # the re-queued resume job runs again in the same drain
    assert interrupted and service.experiment_status(experiment_id) == "awaiting_decision"
    assert lab["calls"]["build"] == 1


def test_finalize_rejects_unknown_decisions():
    with pytest.raises(ValueError, match="Gate 3"):
        orchestrator.node_finalize.__wrapped__({"experiment_id": 1, "decision": "approve"}, None)


def test_concurrent_gate_decisions_make_one_transition(lab):
    import threading

    from paperatlas.db.engine import session_scope
    from paperatlas.db.schema import Job
    from sqlalchemy import func, select

    experiment_id = _at_gate_3(lab)
    barrier, outcomes = threading.Barrier(2), []

    def decide(decision):
        barrier.wait()
        try:
            service.decide_merge(experiment_id, decision)
            outcomes.append("ok")
        except service.ServiceError as exc:
            outcomes.append(exc.status_code)

    threads = [threading.Thread(target=decide, args=(d,)) for d in ("merge", "drop")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(outcomes, key=str) == [409, "ok"]
    with session_scope() as session:
        jobs = session.scalar(
            select(func.count()).where(Job.experiment_id == experiment_id, Job.kind == "experiment.resume", Job.status == "queued")
        )
    assert jobs == 1


def test_claim_skips_experiments_with_a_running_job_and_leases_are_fenced(lab):
    from datetime import UTC, datetime, timedelta

    from paperatlas.db.engine import session_scope
    from paperatlas.db.schema import Job
    from paperatlas.lab.events import enqueue, fail_job, finish_job, heartbeat_jobs, requeue_stale_jobs
    from sqlalchemy import update

    claim_ids = [r["claim_id"] for r in service.recommendations(lab["project"]["id"])]
    first = service.create_experiments(lab["project"]["id"], claim_ids[:1])[0]["id"]
    enqueue("experiment.run", {"experiment_id": first}, experiment_id=first)
    other = enqueue("distill", {})
    job = claim_next_job("w1")
    assert job["experiment_id"] == first
    assert claim_next_job("w2")["id"] == other  # the second job of `first` waits
    assert claim_next_job("w2") is None

    assert heartbeat_jobs([job["id"]], "w1") == 1
    assert requeue_stale_jobs(lease_s=300) == 0  # fresh leases are kept
    with session_scope() as session:
        session.execute(update(Job).where(Job.id == job["id"]).values(heartbeat_at=datetime.now(UTC) - timedelta(minutes=10)))
    assert requeue_stale_jobs(lease_s=300) == 1
    reclaimed = claim_next_job("w3")
    assert reclaimed["id"] == job["id"]
    assert not finish_job(job["id"], {"stale": True}, worker_id="w1")
    assert not fail_job(job["id"], "stale", worker_id="w1")
    assert finish_job(job["id"], {"ok": True}, worker_id="w3")


def test_worker_shutdown_requeues_the_job(db, monkeypatch):
    from paperatlas.db.engine import session_scope
    from paperatlas.db.schema import Job
    from paperatlas.lab.events import enqueue
    from paperatlas.lab.process import WorkerShutdown
    from paperatlas.services import worker

    def interrupted(payload, job):
        raise WorkerShutdown("worker is shutting down")

    monkeypatch.setitem(worker.HANDLERS, "distill", interrupted)
    job_id = enqueue("distill", {})
    execute(claim_next_job())
    with session_scope() as session:
        job = session.get(Job, job_id)
        assert (job.status, job.locked_by, job.payload.get("resumed")) == ("queued", None, True)


def test_cancel_during_planning_is_not_overwritten(lab, monkeypatch):
    from paperatlas.db.engine import session_scope
    from paperatlas.db.schema import Experiment
    from sqlalchemy import update

    real_plan = orchestrator.plan_experiment

    def plan_then_cancel(*args, **kwargs):
        spec = real_plan(*args, **kwargs)
        with session_scope() as session:
            session.execute(update(Experiment).values(status="cancelling"))
        return spec

    monkeypatch.setattr(orchestrator, "plan_experiment", plan_then_cancel)
    claim_id = service.recommendations(lab["project"]["id"])[0]["claim_id"]
    experiment_id = service.create_experiments(lab["project"]["id"], [claim_id])[0]["id"]
    drain()
    detail = service.get_experiment(experiment_id)
    assert detail["status"] == "cancelled" and detail["error"].startswith("plan:")


def test_rejected_experiment_with_lost_checkpoint_is_not_replanned(lab, monkeypatch):
    from paperatlas.lab.events import enqueue

    plans = []
    real_plan = orchestrator.plan_experiment
    monkeypatch.setattr(orchestrator, "plan_experiment", lambda *a, **k: plans.append(1) or real_plan(*a, **k))
    claim_id = service.recommendations(lab["project"]["id"])[0]["claim_id"]
    experiment_id = service.create_experiments(lab["project"]["id"], [claim_id])[0]["id"]
    drain()
    service.decide_spec(experiment_id, "reject", comment="no")
    _drop_checkpoints()
    drain()
    enqueue("experiment.run", {"experiment_id": experiment_id}, experiment_id=experiment_id)
    drain()
    assert service.experiment_status(experiment_id) == "rejected"
    assert plans == [1]


def test_merge_survives_profiling_failure_and_finalize_is_idempotent(lab, monkeypatch):
    from paperatlas.db.engine import session_scope
    from paperatlas.db.schema import Experiment
    from sqlalchemy import update

    def broken_profile(*args, **kwargs):
        raise RuntimeError("profiler exploded")

    experiment_id = _at_gate_3(lab)
    monkeypatch.setattr(orchestrator, "register_project", broken_profile)
    service.decide_merge(experiment_id, "merge")
    drain()
    detail = service.get_experiment(experiment_id)
    assert detail["status"] == "merged", detail["error"]
    sha = detail["build"]["merge_sha"]
    assert any("profiler exploded" in e["message"] for e in service.experiment_events(experiment_id))

    # A finalize interrupted after the git merge (outcome not recorded) is retried without re-merging.
    with session_scope() as session:
        session.execute(
            update(Experiment).where(Experiment.id == experiment_id).values(status="failed", error="finalize: crash", build={})
        )
    _drop_checkpoints()
    service.retry_experiment(experiment_id)
    drain()
    assert service.experiment_status(experiment_id) == "awaiting_decision"
    service.decide_merge(experiment_id, "merge")
    drain()
    detail = service.get_experiment(experiment_id)
    assert detail["status"] == "merged" and detail["build"]["merge_sha"] == sha


def test_finalize_refuses_to_merge_modified_measurement_files(lab):
    experiment_id = _at_gate_3(lab)
    worktree = service.get_experiment(experiment_id)["worktree_path"]
    head = orchestrator.git(lab["repo"], "rev-parse", "main")
    with open(f"{worktree}/lab.yaml", "a", encoding="utf-8") as handle:
        handle.write("# tampered\n")
    service.decide_merge(experiment_id, "merge")
    drain()
    detail = service.get_experiment(experiment_id)
    assert detail["status"] == "failed" and detail["error"].startswith("finalize:")
    assert orchestrator.git(lab["repo"], "rev-parse", "main") == head


def test_fixable_diagnosis_rebuilds_with_the_analysts_changes_then_waits_at_gate_3(lab, monkeypatch):
    original_plan = orchestrator.plan_experiment

    def plan_v2(*args, **kwargs):
        spec = original_plan(*args, **kwargs)
        spec["paper_baseline"] = {"kind": "technique_mode", "description": "the paper's baseline"}
        spec["max_iterations"] = 2
        return spec

    analyses = iter(
        [
            {"diagnosis": "implementation_suspect", "summary": "no fewer verifications", "evidence": ["verifications +0%"],
             "paper_comparison": "", "worth_iterating": True, "next_changes": "gate on the block minimum", "expected_effect": "fewer"},
            {"diagnosis": "reproduced", "summary": "fixed", "evidence": [], "paper_comparison": "", "worth_iterating": False,
             "next_changes": "", "expected_effect": ""},
        ]
    )
    monkeypatch.setattr(orchestrator, "plan_experiment", plan_v2)
    monkeypatch.setattr(orchestrator, "analyse", lambda *args, **kwargs: next(analyses))

    claim_id = service.recommendations(lab["project"]["id"])[0]["claim_id"]
    experiment_id = service.create_experiments(lab["project"]["id"], [claim_id])[0]["id"]
    drain()
    service.decide_spec(experiment_id, "approve", overrides={"rounds": 4})
    drain()
    detail = service.get_experiment(experiment_id)
    assert detail["status"] == "awaiting_decision", detail["error"]
    assert [kind for kind, _ in lab["calls"]["bench"]] == ["smoke", "eval", "adopt", "smoke", "eval", "adopt"]
    assert lab["calls"]["feedback"][0] is None and "gate on the block minimum" in lab["calls"]["feedback"][1]
    details = detail["verdict_detail"]["details"]
    assert [it["diagnosis"] for it in details["iterations"]] == ["implementation_suspect", "reproduced"]
    assert details["analysis"]["diagnosis"] == "reproduced" and details["adoption"]["verdict"] == "worth_adopting"
