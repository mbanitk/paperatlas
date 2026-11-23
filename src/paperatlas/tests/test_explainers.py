from paperatlas.concepts.extraction.models import PaperMetadata
from paperatlas.db.store import PaperStore
from paperatlas.distill.extractor import ClaimExtractor
from paperatlas.distill.pipeline import DistillPipeline
from paperatlas.r2e.explainers import clean_diagram, evidence_window, explain_paper, topic_insights
from paperatlas.tests.conftest import FakeLLM, concept


def test_clean_diagram_drops_broken_edges_duplicates_and_caps_size():
    diagram = clean_diagram(
        {
            "title": "Flow",
            "nodes": [{"id": f"n{i}", "label": f"Step {i}", "kind": "weird", "highlight": i == 1} for i in range(12)]
            + [{"id": "n0", "label": "dup", "kind": "model", "highlight": False}],
            "edges": [
                {"from": "n0", "to": "n1", "label": None, "style": "normal"},
                {"from": "n1", "to": "missing", "label": None, "style": "normal"},
                {"from": "n2", "to": "n2", "label": None, "style": "loop"},
                {"from": "n3", "to": "n1", "label": "retry", "style": "bogus"},
            ],
        }
    )
    assert len(diagram["nodes"]) == 8 and diagram["nodes"][0]["kind"] == "step"
    assert [(e["from"], e["to"], e["style"]) for e in diagram["edges"]] == [("n0", "n1", "normal"), ("n3", "n1", "normal")]


def test_evidence_window_centres_on_the_quote():
    text = "intro " * 1000 + "We observe a 41% speedup over autoregressive decoding." + " tail" * 1000
    window = evidence_window(text, "we observe a 41% speedup over", width=200)
    assert "41% speedup" in window and len(window) == 200


PAPER_EXPLAINER = {
    "tldr": "Drafts more tokens before verifying.",
    "problem": "Verification dominates decode time.",
    "approach": ["Draft", "Gate", "Verify"],
    "key_results": [{"label": "Decode speedup", "value": "+41%", "context": "H100, Qwen3-8B"}],
    "novelty": "Looped drafting.",
    "who_should_care": "Serving teams.",
    "limitations": [],
    "diagram": {
        "title": "DLoop",
        "nodes": [
            {"id": "a", "label": "Prompt", "kind": "input", "highlight": False},
            {"id": "b", "label": "Draft block", "kind": "model", "highlight": True},
        ],
        "edges": [{"from": "a", "to": "b", "label": None, "style": "normal"}],
    },
}


def test_paper_explainer_is_generated_after_distill_and_topic_insights_count(db):
    from paperatlas.db.engine import session_scope
    from paperatlas.db.schema import PaperTopic, Topic

    PaperStore().upsert(
        PaperMetadata(title="DLoop", abstract="We draft tokens. " * 30, arxiv_id="2610.07659", source="arxiv", code_url="https://g/x")
    )
    llm = FakeLLM(
        {
            "paper_distillation": {"paper_summary": "s", "concepts": [concept("Looped drafting", value=41, unit="%")]},
            "paper_explainer": PAPER_EXPLAINER,
        }
    )
    DistillPipeline(extractor=ClaimExtractor(llm)).run(limit=5)
    explainer = explain_paper("arxiv:2610.07659")
    assert explainer["tldr"] == PAPER_EXPLAINER["tldr"] and explainer["model"] == "fake"
    assert explainer["diagram"]["nodes"][1]["highlight"] is True

    with session_scope() as session:
        topic = Topic(slug="spec", name="Speculative decoding")
        session.add(topic)
        session.flush()
        session.add(PaperTopic(paper_id="arxiv:2610.07659", topic_id=topic.id, relevance=0.9, rank=1, score=0.5))
        topic_id = topic.id
    insights = topic_insights(topic_id)
    assert insights["papers"] == 1 and insights["with_code"] == 1 and insights["distilled"] == 1
    assert insights["claim_categories"][0] == {"category": "speculative_decoding", "claims": 1, "testable": 1}
    assert insights["median_claimed_gain_pct"] == 41.0 and len(insights["monthly"]) == 6
