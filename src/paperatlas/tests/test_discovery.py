from datetime import date, timedelta

import numpy as np

from paperatlas.discovery.ranking import paper_score
from paperatlas.discovery.sources.hf_papers import parse_hf_paper
from paperatlas.discovery.sources.openalex import parse_openalex_work
from paperatlas.discovery.sources.patents import UsptoPatentSource, parse_odp_application
from paperatlas.discovery.sources.semantic_scholar import parse_s2_paper
from paperatlas.discovery.topics import Cluster, score_clusters, select_top


def test_semantic_scholar_parser_maps_ids_and_signals():
    paper = parse_s2_paper(
        {
            "paperId": "abc",
            "title": "  Fast   Decoding ",
            "abstract": "A",
            "year": 2026,
            "publicationDate": "2026-09-01",
            "externalIds": {"ArXiv": "2609.00001", "DOI": "10.48550/arXiv.2609.00001"},
            "citationCount": 12,
            "influentialCitationCount": 3,
            "openAccessPdf": {"url": "https://arxiv.org/pdf/2609.00001"},
            "authors": [{"name": "Ada"}],
        }
    )
    assert paper.title == "Fast Decoding"
    assert paper.canonical_id() == "arxiv:2609.00001"
    assert paper.citation_count == 12 and paper.source == "semantic_scholar"


def test_openalex_parser_rebuilds_abstract_and_finds_arxiv_id():
    paper = parse_openalex_work(
        {
            "id": "https://openalex.org/W1",
            "doi": "https://doi.org/10.1/xyz",
            "title": "KV Cache Eviction",
            "publication_date": "2026-08-04",
            "publication_year": 2026,
            "cited_by_count": 5,
            "abstract_inverted_index": {"cache": [1], "KV": [0], "eviction": [2]},
            "locations": [{"landing_page_url": "https://arxiv.org/abs/2608.03447v2"}],
            "authorships": [{"author": {"display_name": "Bo"}}],
        }
    )
    assert paper.abstract == "KV cache eviction"
    assert paper.canonical_id() == "arxiv:2608.03447"
    assert paper.openalex_id == "W1"


def test_hf_parser_keeps_trend_signals():
    paper = parse_hf_paper(
        {
            "paper": {
                "id": "2611.00001",
                "title": "Lookahead",
                "summary": "s",
                "publishedAt": "2026-11-01T00:00:00.000Z",
                "upvotes": 42,
                "githubRepo": "https://github.com/x/y",
                "ai_keywords": ["speculative decoding"],
            }
        }
    )
    assert (paper.hf_upvotes, paper.code_url, paper.publication_date) == (42, "https://github.com/x/y", date(2026, 11, 1))


def test_patent_source_requires_key_and_parses_odp_records(monkeypatch):
    monkeypatch.delenv("PAPERATLAS_USPTO_API_KEY", raising=False)
    assert UsptoPatentSource(api_key=None).search("kv cache", None, 5) == []
    patent = parse_odp_application(
        {
            "applicationNumberText": "18123456",
            "applicationMetaData": {
                "inventionTitle": "Key-value cache compression for language models",
                "filingDate": "2025-01-02",
                "patentNumber": "12345678",
                "grantDate": "2026-03-04",
                "inventorBag": [{"inventorNameText": "Cy"}],
            },
        }
    )
    assert patent.doc_type == "patent" and patent.canonical_id() == "patent:US12345678"
    assert patent.publication_date == date(2026, 3, 4)


def _cluster(index, seed, size, age_days, citations=0):
    ids = [f"{index}-{i}" for i in range(size)]
    papers = {
        pid: {"publication_date": date.today() - timedelta(days=age_days), "citation_count": citations, "hf_upvotes": 0, "code_url": None}
        for pid in ids
    }
    return Cluster(index, ids, seed, np.zeros(3), {pid: 1.0 for pid in ids}), papers


def test_trend_scores_prefer_large_recent_clusters_and_cap_per_seed():
    clusters, papers = [], {}
    for index, (seed, size, age) in enumerate([("a", 12, 10), ("a", 10, 20), ("a", 9, 15), ("b", 4, 400), ("c", 6, 30)]):
        cluster, members = _cluster(index, seed, size, age)
        clusters.append(cluster)
        papers.update(members)
    score_clusters(clusters, papers, half_life_days=90)
    assert clusters[0].trend_score > clusters[3].trend_score
    top = select_top(clusters, count=3, max_per_seed=2)
    assert [c.seed for c in top].count("a") == 2 and len(top) == 3


def test_paper_score_rewards_relevance_recency_and_code():
    weights = {"relevance": 0.35, "recency": 0.25, "citations": 0.15, "upvotes": 0.1, "code": 0.1, "patent": 0.05}
    recent = paper_score(0.8, date.today(), 10, 50, True, False, 100, 100, weights, 90)
    old = paper_score(0.8, date.today() - timedelta(days=365), 10, 50, False, False, 100, 100, weights, 90)
    assert recent > old
