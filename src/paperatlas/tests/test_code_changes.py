"""Code changes per experiment (saved diffs, the changes endpoint, the backfill) and the code → effect explanation."""

import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from paperatlas.db.engine import session_scope
from paperatlas.lab import changes, effect, orchestrator, service
from paperatlas.tests import test_orchestrator
from paperatlas.tests.conftest import FakeLLM

drain = test_orchestrator.drain
lab = test_orchestrator.lab  # the experiment-graph fixture (fake build and benchmarks)


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", *args], check=True, capture_output=True, text=True).stdout.strip()


def test_capture_lists_each_file_with_status_kind_counts_and_its_own_diff(demo_repo):
    (demo_repo / "src").mkdir()
    (demo_repo / "src" / "engine.py").write_text("a = 1\nb = 2\n")
    (demo_repo / "docs.md").write_text("old\n")
    (demo_repo / "logo.bin").write_bytes(b"\x00\x01")
    _git(demo_repo, "add", "-A")
    _git(demo_repo, "commit", "-qm", "base")
    base = _git(demo_repo, "rev-parse", "HEAD")
    (demo_repo / "src" / "engine.py").write_text("a = 1\nb = 3\nc = 4\n")
    (demo_repo / "src" / "draft.py").write_text("def draft():\n    return 1\n")
    (demo_repo / "tests").mkdir()
    (demo_repo / "tests" / "test_draft.py").write_text("def test():\n    pass\n")
    _git(demo_repo, "mv", "docs.md", "guide.md")
    (demo_repo / "logo.bin").write_bytes(b"\x00\x02\x03")
    _git(demo_repo, "add", "-A")
    _git(demo_repo, "commit", "-qm", "change")

    summary, patch = changes.capture(demo_repo, base, "HEAD", "draft_flag")
    files = {f["path"]: f for f in summary["files"]}
    assert (files["src/engine.py"]["status"], files["src/engine.py"]["additions"], files["src/engine.py"]["deletions"]) == ("modified", 2, 1)
    assert (files["src/draft.py"]["status"], files["src/draft.py"]["kind"]) == ("added", "source")
    assert files["tests/test_draft.py"]["kind"] == "test"
    assert (files["guide.md"]["status"], files["guide.md"]["old_path"], files["guide.md"]["kind"]) == ("renamed", "docs.md", "docs")
    assert files["logo.bin"]["binary"] and files["logo.bin"]["additions"] is None
    assert (summary["additions"], summary["deletions"]) == (6, 1)
    assert summary["summary"] == "Changes `engine.py` (+2 −1) and `draft.py` (+2) behind the `draft_flag` flag, with tests (+2), docs (±0) and `logo.bin` (±0)."

    chunks = changes.split_patch(patch, summary["files"])
    for file, chunk in zip(summary["files"], chunks):
        assert chunk.startswith("diff --git ") and file["path"] in chunk.splitlines()[0]
    payload = changes.with_patches(summary, patch)
    engine = next(f for f in payload["files"] if f["path"] == "src/engine.py")
    assert "+b = 3" in engine["patch"] and "-b = 2" in engine["patch"]
    assert next(f for f in payload["files"] if f["path"] == "logo.bin")["patch"] is None
    assert changes.describe([{"path": "README.md", "kind": "docs", "additions": 3, "deletions": 0}]).startswith("Only docs (+3) changed")


def _verdict(median, low, high, counters=None, adoption=None, quality_ok=True):
    mechanism = None
    if counters is not None:
        mechanism = {
            "rows": [{"name": name, "expected": True, "variant_total": total, "variant_per_1k_tokens": total} for name, total in counters.items()],
            "missing": [],
            "tokens": {"baseline": 1000, "variant": 1000},
            "rounds": {"baseline": 4, "variant": 4},
        }
    return {
        "verdict": "partial",
        "primary_metric": "decode_tokens_per_s",
        "median_delta_pct": median,
        "ci_low_pct": low,
        "ci_high_pct": high,
        "quality_ok": quality_ok,
        "quality_problems": [] if quality_ok else ["exact_match dropped from 0.900 to 0.700"],
        "workload": {"name": "short_chat", "requests_per_round": 5},
        "mechanism": mechanism,
        "adoption": adoption,
    }


def test_explanation_states_never_triggered_noise_and_gains_from_the_numbers():
    spec = {"flag_name": "draft_flag", "primary_metric": "decode_tokens_per_s"}
    idle = effect.explain(_verdict(0.4, -1.2, 1.9, {"drafted_tokens": 0, "accepted_tokens": 0}), spec, {}, None, None, None)
    assert (idle["outcome"], idle["triggered"], idle["source"]) == ("no_change", "no", "rules")
    kinds = [note["kind"] for note in idle["notes"]]
    assert kinds == ["never_triggered", "within_noise", "no_diff"]
    assert idle["notes"][0]["text"].startswith("Never triggered in the claim check") and "+0.4%" in idle["notes"][1]["text"]
    assert "never ran" in idle["why"] and "didn't change measurably" in idle["headline"]

    adoption = {"verdict": "regression", "median_delta_pct": -8.0, "ci_low_pct": -9.5, "ci_high_pct": -6.0, "quality_ok": True,
                "workload": {"name": "short_chat", "requests_per_round": 5}, "mechanism": None}
    mixed = effect.explain(_verdict(4.0, 2.5, 5.5, {"drafted_tokens": 600}, adoption), spec, {}, None, None, None)
    assert mixed["outcome"] == "mixed" and [c["outcome"] for c in mixed["checks"]] == ["gain", "loss"]
    assert mixed["headline"].startswith("With `draft_flag` on, decode speed improved 4.0%") and "but got 8.0% worse" in mixed["headline"]
    # 600 drafted tokens over 4 rounds × 5 requests
    assert mixed["checks"][0]["counters"][0]["per_request"] == pytest.approx(30.0)
    assert "30 per request" in mixed["links"][0]["effect"]

    broken = effect.explain(_verdict(6.0, 5.0, 7.0, {"drafted_tokens": 10}, quality_ok=False), spec, {}, None, None, None)
    assert broken["outcome"] == "gain" and [n["kind"] for n in broken["notes"]] == ["quality", "no_diff"]


def test_llm_explanation_is_validated_and_falls_back_to_rules():
    spec = {"flag_name": "draft_flag", "primary_metric": "decode_tokens_per_s"}
    summary = {"files": [{"path": "src/demo/draft.py", "kind": "source", "additions": 10, "deletions": 0}], "head": "abc", "iteration": 1}
    reply = {
        "change_summary": "Drafts tokens from the prompt.",
        "headline": "Drafting skipped target steps, so decode got faster.",
        "links": [{"code": "draft() looks up n-grams", "files": ["draft.py", "nope.py"], "effect": "30 drafted per request"}, {"code": "", "files": [], "effect": "x"}],
        "why": "It saves more than it costs.",
    }
    llm = FakeLLM({"code_effect": reply})
    result = effect.explain(_verdict(4.0, 2.5, 5.5, {"drafted_tokens": 600}), spec, {}, summary, "diff --git a/src/demo/draft.py b/src/demo/draft.py\n+x\n", llm)
    assert llm.calls == ["code_effect"] and result["source"] == "llm" and result["model"] == "fake"
    assert result["links"] == [{"code": "draft() looks up n-grams", "files": ["src/demo/draft.py"], "effect": "30 drafted per request"}]
    assert result["outcome"] == "gain" and result["head"] == "abc"

    garbage = effect.explain(_verdict(4.0, 2.5, 5.5), spec, {}, summary, None, FakeLLM({"code_effect": {"headline": ""}}))
    assert garbage["source"] == "rules" and garbage["headline"].startswith("With `draft_flag` on")


def _committing_build(lab, monkeypatch, versions):
    builds = {"n": 0}

    def build(experiment_id, workdir, spec, claim, profile, artifacts, report, should_cancel, **kwargs):
        builds["n"] += 1
        (workdir / "src").mkdir(exist_ok=True)
        (workdir / "src" / "technique.py").write_text(versions[builds["n"] - 1])
        _git(workdir, "add", "-A")
        _git(workdir, "commit", "-qm", f"build {builds['n']}")
        return {"builder": "fake", "attempts": [], "files": ["src/technique.py"], "diff_stat": ""}

    monkeypatch.setattr(orchestrator, "build_experiment", build)


def _approve(lab):
    claim_id = service.recommendations(lab["project"]["id"])[0]["claim_id"]
    experiment_id = service.create_experiments(lab["project"]["id"], [claim_id])[0]["id"]
    drain()
    service.decide_spec(experiment_id, "approve", overrides={"rounds": 4})
    drain()
    return experiment_id


def test_judged_experiment_keeps_its_diff_and_explanation_after_drop(lab, monkeypatch):
    _committing_build(lab, monkeypatch, ["def draft():\n    return 1\n"])
    experiment_id = _approve(lab)
    detail = service.get_experiment(experiment_id)
    assert detail["status"] == "awaiting_decision", detail["error"]
    code = detail["build"]["code_changes"]
    assert (code["iteration"], code["files_changed"], code["additions"]) == (1, 1, 2)
    assert code["summary"].startswith("Adds `technique.py` (+2) behind the")
    explained = detail["verdict_detail"]["details"]["code_effect"]
    assert explained["outcome"] == "gain" and explained["head"] == code["head"] and explained["files_changed"] == 1
    report = service.report_path(experiment_id).read_text()
    assert "Why this result" in report and "src/technique.py" in report

    from paperatlas.services.lab_api import app

    client = TestClient(app)
    response = client.get(f"/experiments/{experiment_id}/changes").json()
    assert response["available"] and not response["live"] and response["iteration"] == 1
    assert "+    return 1" in response["files"][0]["patch"]
    assert client.get(f"/experiments/{experiment_id}/changes", params={"patch": False}).json()["files"][0].get("patch") is None
    assert client.get(f"/experiments/{experiment_id}/changes", params={"iteration": 7}).status_code == 404

    service.decide_merge(experiment_id, "drop")
    drain()
    assert service.experiment_status(experiment_id) == "dropped"
    after = service.experiment_changes(experiment_id)
    assert after["available"] and after["files"][0]["path"] == "src/technique.py"


def test_ratchet_shows_the_kept_iterations_code(lab, monkeypatch):
    from datetime import UTC, datetime

    from paperatlas.db.engine import session_scope
    from paperatlas.db.schema import Run
    from paperatlas.tests.conftest import bench_results

    original_plan = orchestrator.plan_experiment
    monkeypatch.setattr(orchestrator, "plan_experiment", lambda *a, **k: {**original_plan(*a, **k), "max_iterations": 2})
    medians = iter([([100, 101, 99, 100], [121, 122, 120, 121]), ([100, 101, 99, 100], [104, 105, 103, 104])])
    current = {}

    def bench(experiment_id, kind, workdir, spec, profile, artifacts, report, should_cancel, **kwargs):
        if kind == "eval":
            current["pair"] = next(medians)
        results = bench_results(*current.get("pair", ([100, 101, 99, 100], [121, 122, 120, 121])))
        with session_scope() as session:
            session.add(Run(experiment_id=experiment_id, kind=kind, status="done", results=results, finished_at=datetime.now(UTC)))
        return results

    analyses = iter([
        {"diagnosis": "partially_reproduced", "summary": "s", "evidence": [], "paper_comparison": "", "worth_iterating": True, "next_changes": "more", "expected_effect": ""},
        {"diagnosis": "partially_reproduced", "summary": "worse", "evidence": [], "paper_comparison": "", "worth_iterating": False, "next_changes": "", "expected_effect": ""},
    ])
    monkeypatch.setattr(orchestrator, "run_benchmark", bench)
    monkeypatch.setattr(orchestrator, "analyse", lambda *a, **k: next(analyses))
    _committing_build(lab, monkeypatch, ["v = 1\n", "v = 2\nw = 3\nx = 4\n"])
    experiment_id = _approve(lab)

    detail = service.get_experiment(experiment_id)
    assert detail["build"]["kept_iteration"] == 1
    assert (detail["build"]["code_changes"]["iteration"], detail["build"]["code_changes"]["additions"]) == (1, 1)
    iterations = detail["verdict_detail"]["details"]["iterations"]
    assert [entry["changes"]["additions"] for entry in iterations] == [1, 3]
    assert detail["verdict_detail"]["details"]["code_effect"]["iteration"] == 1
    default = service.experiment_changes(experiment_id)
    assert default["iteration"] == 1 and [i["iteration"] for i in default["iterations"]] == [1, 2]
    assert "+v = 1" in default["files"][0]["patch"]
    assert "+w = 3" in service.experiment_changes(experiment_id, 2)["files"][0]["patch"]


def test_backfill_saves_diffs_from_git_and_explains_judged_experiments(lab, monkeypatch):
    _committing_build(lab, monkeypatch, ["def draft():\n    return 1\n"])
    experiment_id = _approve(lab)
    # As if judged before diffs were saved: no files, no summary, no explanation.
    shutil.rmtree(changes.changes_dir(experiment_id))
    from paperatlas.lab.backfill import backfill_code_changes

    with session_scope() as session:
        session.execute(text("UPDATE lab.experiments SET build = build - 'code_changes' WHERE id = :id"), {"id": experiment_id})
        session.execute(text("UPDATE lab.verdicts SET details = details - 'code_effect' WHERE experiment_id = :id"), {"id": experiment_id})
    assert service.experiment_changes(experiment_id)["live"]  # still readable from the worktree

    lines = []
    counts = backfill_code_changes(use_llm=False, say=lines.append)
    assert counts["diffs"] == 1 and counts["explained"] == 1, lines
    detail = service.get_experiment(experiment_id)
    assert detail["build"]["code_changes"]["additions"] == 2 and detail["build"]["builder"] == "fake"
    assert detail["verdict_detail"]["details"]["code_effect"]["source"] == "rules"
    again = backfill_code_changes(use_llm=False, say=lines.append)
    assert again["diffs"] == 0 and again["explained"] == 0


def test_changes_endpoint_explains_why_a_diff_is_missing(lab):
    claim_id = service.recommendations(lab["project"]["id"])[0]["claim_id"]
    experiment_id = service.create_experiments(lab["project"]["id"], [claim_id])[0]["id"]
    drain()
    pending = service.experiment_changes(experiment_id)
    assert not pending["available"] and "after the test plan is approved" in pending["reason"]
    with session_scope() as session:
        session.execute(text("UPDATE lab.experiments SET status = 'dropped', branch = 'r2e/gone' WHERE id = :id"), {"id": experiment_id})
    gone = service.experiment_changes(experiment_id)
    assert not gone["available"] and "were removed before its diff was saved" in gone["reason"]


def test_judge_saves_the_diff_when_the_build_did_not(lab, monkeypatch):
    # e.g. the build ran on a worker from before diffs were saved, or saving failed: judging still has the code.
    _committing_build(lab, monkeypatch, ["def draft():\n    return 1\n"])
    record = changes.record
    calls = {"n": 0}

    def flaky_record(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("disk full")
        return record(*args, **kwargs)

    monkeypatch.setattr(orchestrator.code_changes, "record", flaky_record)
    experiment_id = _approve(lab)
    detail = service.get_experiment(experiment_id)
    assert detail["status"] == "awaiting_decision", detail["error"]
    assert calls["n"] == 2 and detail["build"]["code_changes"]["additions"] == 2
    assert detail["verdict_detail"]["details"]["iterations"][0]["changes"]["files_changed"] == 1
    assert detail["verdict_detail"]["details"]["code_effect"]["files_changed"] == 1
    events = [event["message"] for event in service.experiment_events(experiment_id)]
    assert any("Could not save the diff of iteration 1: disk full" in message for message in events)


def test_response_budget_omits_the_files_after_the_one_it_cuts(monkeypatch):
    files = [{"path": f"src/{name}.py", "kind": "source", "additions": 30, "deletions": 0} for name in "abcd"]
    patch = "".join(
        f"diff --git a/{f['path']} b/{f['path']}\n--- /dev/null\n+++ b/{f['path']}\n@@ -0,0 +1,30 @@\n" + "".join(f"+line {i}\n" for i in range(30))
        for f in files
    )
    monkeypatch.setattr(changes, "MAX_RESPONSE_PATCH_BYTES", 300)
    result = changes.with_patches({"files": files}, patch)
    first, *rest = result["files"]
    assert first["patch_truncated"] and first["patch"].endswith("\n") and len(first["patch"].encode()) <= 300
    assert all(f["omitted"] and f["patch"] is None for f in rest) and result["truncated"]
    # The saved patch itself was cut (4 MB cap) before c.py: files without a chunk are omitted, not "no changes".
    monkeypatch.setattr(changes, "MAX_RESPONSE_PATCH_BYTES", 100_000)
    cut = changes.with_patches({"files": files, "patch_truncated": True}, patch[: patch.index("diff --git a/src/c.py")])
    assert [bool(f.get("omitted")) for f in cut["files"]] == [False, False, True, True]


def test_backfill_explains_the_iteration_the_verdict_measured(lab, monkeypatch):
    _committing_build(lab, monkeypatch, ["v = 1\n"])
    experiment_id = _approve(lab)
    # As if iteration 2 was built after iteration 1's verdict and then the experiment failed.
    worktree = service.experiment_context(experiment_id)["worktree"]
    (worktree / "src" / "technique.py").write_text("v = 2\nw = 3\n")
    _git(worktree, "commit", "-qam", "iteration 2")
    shutil.rmtree(changes.changes_dir(experiment_id))
    with session_scope() as session:
        session.execute(
            text("UPDATE lab.experiments SET status = 'failed', build = (build - 'code_changes' - 'kept_iteration') || '{\"iteration\": 2}' WHERE id = :id"),
            {"id": experiment_id},
        )
        session.execute(text("UPDATE lab.verdicts SET details = details - 'code_effect' WHERE experiment_id = :id"), {"id": experiment_id})
    from paperatlas.lab.backfill import backfill_code_changes

    backfill_code_changes([experiment_id], use_llm=False, say=lambda line: None)
    assert changes.stored_iterations(experiment_id) == [1, 2]
    detail = service.get_experiment(experiment_id)
    assert detail["build"]["code_changes"]["iteration"] == 1
    assert detail["verdict_detail"]["details"]["code_effect"]["iteration"] == 1
