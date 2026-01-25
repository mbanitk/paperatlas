from paperatlas.concepts.extraction.heuristic_extractor import (
    HeuristicConceptExtractor,
)
from paperatlas.concepts.extraction.llm_extractor import (
    LLMConceptExtractor,
)


def test_llm_parse_response_extracts_concepts():
    response = (
        "Concept 1: Graph Contrastive Learning\n"
        "A strong hook.\n\n"
        "Concept 2: Adaptive Sampling\n"
        "Another hook."
    )
    concepts = LLMConceptExtractor._parse_response(response)
    names = [concept["name"] for concept in concepts]
    assert names == ["Graph Contrastive Learning", "Adaptive Sampling"]


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
