from paperatlas.concepts.extraction.heuristic_extractor import (
    HeuristicConceptExtractor,
)
from paperatlas.concepts.extraction.models import PaperMetadata, normalize_arxiv_id


def test_heuristic_extractor_finds_named_methods():
    text = "We propose AdaGraph, a new method for graph matching."
    extractor = HeuristicConceptExtractor()
    concepts = extractor.extract(
        title="AdaGraph: Matching",
        abstract=None,
        raw_text=text,
    )
    names = [concept["name"] for concept in concepts]
    assert any("AdaGraph" in name for name in names)


def test_canonical_id_prefers_arxiv_and_unifies_arxiv_dois():
    via_arxiv = PaperMetadata(title="T", arxiv_id="2306.14753v2", source="arxiv")
    via_doi = PaperMetadata(title="T", doi="https://doi.org/10.48550/arXiv.2306.14753", source="s2")
    journal = PaperMetadata(title="T", doi="10.1/x", arxiv_id="2306.14753", source="openalex")
    assert via_arxiv.canonical_id() == via_doi.canonical_id() == journal.canonical_id()
    assert via_arxiv.canonical_id() == "arxiv:2306.14753"


def test_normalize_arxiv_id_keeps_old_style_categories():
    assert normalize_arxiv_id("cs.CV/0102003v1") == "cs.cv/0102003"
    assert normalize_arxiv_id("https://arxiv.org/abs/2106.09685v3") == "2106.09685"
