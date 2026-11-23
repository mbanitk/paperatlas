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

    def fake_build(experiment_id, workdir, spec, claim, profile, artifacts, report, should_cancel):
        calls["build"] += 1
        (workdir / "technique.py").write_text("x = 1\n")
        return {"builder": "fake", "attempts": [{"attempt": 1}], "files": ["technique.py"], "diff_stat": "1 file"}

    def fake_bench(experiment_id, kind, workdir, spec, profile, artifacts, report, should_cancel):
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
    assert [s["state"] for s in detail["stages"]] == ["done"] * 6 + ["waiting"]

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
    assert [s["state"] for s in detail["stages"]][:3] == ["done", "done", "failed"]
    assert "compiler exploded" in detail["error"]
