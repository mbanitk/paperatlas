from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
import yaml

TEST_DB = os.environ.get("PAPERATLAS_TEST_DATABASE_URL", "postgresql+psycopg://localhost/paperatlas_test")

PROFILE = {
    "schema_version": 1,
    "name": "demo-lab",
    "description": "Toy LLM inference server used in tests",
    "repo_kind": "llm-inference-server",
    "stack": {"language": "python", "frameworks": ["pytorch"]},
    "hardware": {"chip": "Apple M5 Pro", "memory_gb": 64, "accelerator": "mps", "cuda": False, "multi_gpu": False},
    "models": {"smoke": {"id": "tiny"}, "eval": {"id": "big"}},
    "metrics": [
        {"name": "ttft_ms", "direction": "lower_is_better"},
        {"name": "decode_tokens_per_s", "direction": "higher_is_better"},
        {"name": "peak_memory_gb", "direction": "lower_is_better"},
    ],
    "quality_metrics": [{"name": "exact_match"}, {"name": "output_agreement"}],
    "workloads": [{"name": "short_chat"}, {"name": "long_prompt"}],
    "extension_points": [{"name": "generate", "path": "src/demo/techniques", "description": "decode loop"}],
    "commands": {
        "install": "true",
        "test": "true",
        "list_flags": "echo []",
        "bench_ab": "bench ab --model {model} --variant-flags {flags} --workload {workload} --rounds {rounds} --out {out}",
    },
    "constraints": ["Apple GPU via MPS only"],
}


@pytest.fixture(scope="session")
def database_url():
    from sqlalchemy import create_engine, text

    try:
        with create_engine(TEST_DB).connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"test database unavailable ({exc}); set PAPERATLAS_TEST_DATABASE_URL")
    os.environ["PAPERATLAS_DATABASE_URL"] = TEST_DB
    from paperatlas.db import migrate

    migrate.upgrade(TEST_DB)
    return TEST_DB


@pytest.fixture()
def db(database_url, tmp_path, monkeypatch):
    from sqlalchemy import text

    from paperatlas.db.engine import get_engine

    monkeypatch.setenv("PAPERATLAS_DATABASE_URL", database_url)
    monkeypatch.setenv("PAPERATLAS_DATA_DIR", str(tmp_path / "data"))
    with get_engine(database_url).begin() as connection:
        connection.execute(
            text(
                "TRUNCATE research.papers, research.topics, research.claim_groups, lab.projects, "
                "lab.jobs, lab.events RESTART IDENTITY CASCADE"
            )
        )
    return database_url


@pytest.fixture()
def demo_repo(tmp_path) -> Path:
    repo = tmp_path / "demo-lab"
    repo.mkdir()
    (repo / "lab.yaml").write_text(yaml.safe_dump(PROFILE), encoding="utf-8")
    (repo / "README.md").write_text("# demo-lab\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], check=True
    )
    subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
        check=True,
    )
    return repo


def concept(technique, category="speculative_decoding", metric="decode throughput", value=2.0, unit="x", direction="increase", **claim):
    return {
        "name": technique[:40],
        "kind": "method",
        "summary": f"{technique}.",
        "key_points": ["point"],
        "claim": {
            "testable": True,
            "category": category,
            "technique": technique,
            "change_required": "Add it to the decode loop.",
            "effects": [
                {"metric": metric, "value": value, "unit": unit, "direction": direction, "baseline": "vanilla", "conditions": None}
            ],
            "paper_setup": {k: None for k in ("hardware", "model", "framework", "batch_size", "sequence_length", "dataset")},
            "prerequisites": [],
            "requires_cuda": False,
            "requires_multi_gpu": False,
            "requires_training": False,
            "effort": "low",
            "risks": [],
            "evidence": {"quote": "we observe a speedup", "location": "Table 2"},
            **claim,
        },
    }


class FakeLLM:
    model = "fake"

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def generate_json(self, system, user, schema_name, schema):
        self.calls.append(schema_name)
        response = self.responses.get(schema_name)
        return response(user) if callable(response) else response


def bench_results(baseline, variant, metric="decode_tokens_per_s", quality=None):
    order = []
    rounds = []
    for index, (b, v) in enumerate(zip(baseline, variant)):
        pair = [("baseline", b), ("variant", v)] if index % 2 == 0 else [("variant", v), ("baseline", b)]
        for arm, value in pair:
            order.append(arm)
            rounds.append({"round": len(rounds), "arm": arm, "metrics": {metric: value, "peak_memory_gb": 10.0}})
    return {
        "schema_version": 1,
        "kind": "ab",
        "model": {"profile": "eval", "id": "big"},
        "workload": {"name": "short_chat"},
        "arms": {"baseline": {"flags": []}, "variant": {"flags": ["x"]}},
        "order": order,
        "rounds": rounds,
        "quality": quality
        or {"baseline": {"exact_match": 0.9, "n": 20}, "variant": {"exact_match": 0.9, "n": 20}, "output_agreement": 1.0},
        "environment": {"on_ac_power": True, "thermal_warning": False},
    }
