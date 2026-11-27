"""Experiment list filters: search, status, claim/adoption check outcomes, category, measured change, facets, pages."""

import pytest
from fastapi.testclient import TestClient

from paperatlas.lab import service

# title, category, status, claim verdict, claim Δ%, adoption verdict, adoption Δ%
ROWS = [
    ("N-gram drafting", "speculative_decoding", "merged", "reproduced", 21.5, "worth_adopting", 12.0),
    ("KV cache 2-bit", "kv_cache", "awaiting_decision", "partial", 4.2, "regression", -8.0),
    ("Int4 weights", "quantization", "failed", None, None, None, None),
    ("Chunked prefill", "batching_scheduling", "running", None, None, None, None),
    ("Tree drafting", "speculative_decoding", "dropped", "regression", -15.0, "regression", -20.0),
    ("Lookahead decoding", "speculative_decoding", "awaiting_approval", None, None, None, None),
    ("Prompt cache", "kv_cache", "awaiting_decision", "not_reproduced", 0.5, None, None),
]


@pytest.fixture()
def experiments(db):
    from paperatlas.db.engine import session_scope
    from paperatlas.db.schema import Claim, Concept, Experiment, Paper, Project, Verdict

    ids = {}
    with session_scope() as session:
        project = Project(name="demo", repo_path="/demo")
        other = Project(name="other", repo_path="/other")
        session.add_all([project, other])
        session.flush()
        for index, (title, category, status, verdict, delta, adoption, adoption_delta) in enumerate(ROWS):
            paper = Paper(paper_id=f"arxiv:2401.0000{index}", title=f"Paper about {title.lower()}")
            session.add(paper)
            session.flush()
            concept = Concept(paper_id=paper.paper_id, concept_key=f"c{index}", name=title)
            session.add(concept)
            session.flush()
            claim = Claim(paper_id=paper.paper_id, concept_id=concept.id, category=category, technique=f"{title} technique", card={})
            session.add(claim)
            session.flush()
            experiment = Experiment(project_id=project.id, claim_id=claim.id, thread_id=f"t{index}", status=status, flag_name=f"flag_{index}")
            session.add(experiment)
            session.flush()
            if verdict:
                details = {"adoption": {"verdict": adoption, "median_delta_pct": adoption_delta}} if adoption else {"adoption": None}
                session.add(
                    Verdict(experiment_id=experiment.id, verdict=verdict, primary_metric="m", median_delta_pct=delta, quality_ok=True, details=details)
                )
            ids[title] = (experiment.id, claim.id)
        # Another project's experiment: never part of the demo project's list or counts.
        session.add(Experiment(project_id=other.id, claim_id=ids["N-gram drafting"][1], thread_id="other", status="merged"))
        project_id = project.id
    return {"project_id": project_id, "ids": ids}


def titles(result):
    return [item["title"] for item in result["items"]]


def counts(facet):
    return {entry["value"]: entry["count"] for entry in facet}


def test_unfiltered_page_lists_every_experiment_with_facets(experiments):
    result = service.search_experiments(experiments["project_id"])
    assert result["total"] == 7 and len(result["items"]) == 7
    assert titles(result) == [row[0] for row in reversed(ROWS)]  # newest first
    facets = result["facets"]
    assert facets["scope"] == {"needs_you": 3, "active": 4, "all": 7} == result["overall"]
    assert counts(facets["category"]) == {"speculative_decoding": 3, "kv_cache": 2, "quantization": 1, "batching_scheduling": 1}
    assert [entry["value"] for entry in facets["category"]][:2] == ["speculative_decoding", "kv_cache"]
    assert [entry["value"] for entry in facets["verdict"]] == ["reproduced", "partial", "not_reproduced", "regression"]
    assert counts(facets["adoption"]) == {"worth_adopting": 1, "regression": 2}
    assert counts(facets["status"])["awaiting_decision"] == 2


def test_search_matches_title_technique_paper_and_ids(experiments):
    project_id = experiments["project_id"]
    assert titles(service.search_experiments(project_id, q="drafting")) == ["Tree drafting", "N-gram drafting"]
    assert titles(service.search_experiments(project_id, q="tree  DRAFTING")) == ["Tree drafting"]
    assert titles(service.search_experiments(project_id, q="paper about int4")) == ["Int4 weights"]
    assert titles(service.search_experiments(project_id, q="prefill technique")) == ["Chunked prefill"]
    experiment_id, claim_id = experiments["ids"]["KV cache 2-bit"]
    assert titles(service.search_experiments(project_id, q=f"#{experiment_id}")) == ["KV cache 2-bit"]
    _, prompt_claim = experiments["ids"]["Prompt cache"]
    assert "Prompt cache" in titles(service.search_experiments(project_id, q=str(prompt_claim)))
    assert service.search_experiments(project_id, q="50%_")["total"] == 0  # LIKE wildcards are literal


def test_filters_combine_and_facets_ignore_their_own_filter(experiments):
    project_id = experiments["project_id"]
    result = service.search_experiments(project_id, verdicts=["reproduced", "partial"])
    assert titles(result) == ["KV cache 2-bit", "N-gram drafting"]
    # Picking one more outcome would add the others: the verdict facet still counts them.
    assert counts(result["facets"]["verdict"]) == {"reproduced": 1, "partial": 1, "not_reproduced": 1, "regression": 1}
    assert counts(result["facets"]["status"]) == {"awaiting_decision": 1, "merged": 1}
    assert result["facets"]["scope"] == {"needs_you": 1, "active": 1, "all": 2}
    assert result["overall"] == {"needs_you": 3, "active": 4, "all": 7}

    assert titles(service.search_experiments(project_id, statuses=["merged", "dropped"])) == ["Tree drafting", "N-gram drafting"]
    assert titles(service.search_experiments(project_id, adoption=["regression"])) == ["Tree drafting", "KV cache 2-bit"]
    both = service.search_experiments(project_id, categories=["speculative_decoding"], adoption=["regression"], scope="all")
    assert titles(both) == ["Tree drafting"]
    needs = service.search_experiments(project_id, scope="needs_you", categories=["kv_cache"])
    assert titles(needs) == ["Prompt cache", "KV cache 2-bit"]
    assert needs["facets"]["scope"] == {"needs_you": 2, "active": 2, "all": 2}


def test_measured_change_on_the_claim_or_adoption_check(experiments):
    project_id = experiments["project_id"]
    search = lambda **kwargs: titles(service.search_experiments(project_id, **kwargs))  # noqa: E731
    assert search(change="gain") == ["Prompt cache", "KV cache 2-bit", "N-gram drafting"]
    assert search(change="gain", min_change_pct=5) == ["N-gram drafting"]
    assert search(change="loss") == ["Tree drafting"]
    assert search(min_change_pct=5) == ["Tree drafting", "N-gram drafting"]  # either way
    assert search(change="gain", change_of="adoption") == ["N-gram drafting"]
    assert search(change="loss", min_change_pct=10, change_of="adoption") == ["Tree drafting"]
    assert search(min_change_pct=0, change_of="adoption") == ["Tree drafting", "KV cache 2-bit", "N-gram drafting"]


def test_pages_and_validation(experiments):
    project_id = experiments["project_id"]
    page = service.search_experiments(project_id, limit=3, offset=3)
    assert page["total"] == 7 and page["limit"] == 3 and page["offset"] == 3
    assert titles(page) == [row[0] for row in reversed(ROWS)][3:6]
    for kwargs in ({"verdicts": ["worth_adopting"]}, {"statuses": ["done"]}, {"change": "up"}, {"min_change_pct": -1}, {"scope": "mine"}):
        with pytest.raises(service.ServiceError):
            service.search_experiments(project_id, **kwargs)


def test_search_endpoint(experiments):
    from paperatlas.services import lab_api

    client = TestClient(lab_api.app)
    project_id = experiments["project_id"]
    response = client.get("/experiments/search", params={"project_id": project_id, "status": "merged,dropped", "change": "loss"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 1 and body["items"][0]["title"] == "Tree drafting"
    assert body["items"][0]["adoption_verdict"] == "regression"
    repeated = client.get("/experiments/search", params=[("project_id", project_id), ("category", "kv_cache"), ("category", "quantization")])
    assert repeated.json()["total"] == 3
    assert client.get("/experiments/search", params={"verdict": "nope"}).status_code == 400
    assert client.get("/experiments/search", params={"change": "up"}).status_code == 422
    # The plain list (used across the console) keeps its shape.
    assert isinstance(client.get("/experiments", params={"project_id": project_id}).json(), list)
