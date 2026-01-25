from paperatlas.concepts.summarization.concept_summarizer import (
    ConceptSummarizer,
)


def test_heuristic_summary_has_bullets():
    summarizer = ConceptSummarizer()
    text = (
        "This concept introduces a new optimization objective. "
        "It balances accuracy with computational cost. "
        "The method outperforms prior baselines on benchmarks. "
        "It is simple to implement and robust to noise. "
        "The results suggest broader applicability."
    )
    summary = summarizer.summarize(text, "Optimization Objective")
    assert "paragraph" in summary
    assert "bullets" in summary
    assert 3 <= len(summary["bullets"]) <= 5
