from sqlalchemy import func, select, text

from paperatlas.concepts.extraction.models import PaperMetadata
from paperatlas.db.engine import get_engine, session_scope
from paperatlas.db.schema import Claim, Paper
from paperatlas.db.search import hybrid_search
from paperatlas.db.store import PaperStore
from paperatlas.distill.extractor import ClaimExtractor
from paperatlas.distill.pipeline import DistillPipeline
from paperatlas.tests.conftest import FakeLLM, concept


def test_upsert_merges_the_same_paper_from_different_sources(db):
    store = PaperStore()
    store.upsert(PaperMetadata(title="KV quant", doi="10.48550/arXiv.2401.00002", source="semantic_scholar", citation_count=5))
    store.upsert(PaperMetadata(title="KV quant", arxiv_id="2401.00002v3", abstract="abc", source="arxiv", citation_count=3, hf_upvotes=9))
    paper = store.get("arxiv:2401.00002")
    assert paper["sources"] == ["semantic_scholar", "arxiv"]
    assert (paper["citation_count"], paper["hf_upvotes"], paper["abstract"]) == (5, 9, "abc")
    with session_scope() as session:
        assert session.scalar(select(func.count()).select_from(Paper)) == 1


def test_distill_stores_claim_cards_groups_duplicates_and_searches(db):
    store = PaperStore()
    store.upsert_many(
        [
            PaperMetadata(title="N-gram drafting", abstract="We draft tokens. " * 30, arxiv_id="2401.00001", source="arxiv"),
            PaperMetadata(title="KV cache 2-bit", abstract="We quantize the KV cache. " * 30, arxiv_id="2401.00002", source="arxiv"),
        ]
    )
    llm = FakeLLM(
        {
            "paper_distillation": lambda prompt: {
                "paper_summary": "s",
                "concepts": [
                    concept("Draft tokens using n-gram lookup from the prompt"),
                    concept("Verify several drafted tokens in one forward pass", metric="latency", value=30, unit="%", direction="decrease"),
                ]
                if "N-gram" in prompt
                else [
                    concept("Quantize KV cache entries to 2-bit integers", category="kv_cache", metric="memory", value=4, direction="decrease"),
                    concept("Draft tokens using n-gram lookup from the prompt text"),
                ],
            }
        }
    )
    stats = DistillPipeline(extractor=ClaimExtractor(llm), concurrency=2).run(limit=10)
    assert (stats.papers, stats.claims, stats.testable_claims) == (2, 4, 4)
    assert store.count_undistilled() == 0

    with session_scope() as session:
        claims = {c.technique: c for c in session.scalars(select(Claim)).all()}
    assert claims["Draft tokens using n-gram lookup from the prompt"].claimed_gain_pct == 100.0
    assert claims["Quantize KV cache entries to 2-bit integers"].claimed_gain_pct == 75.0
    drafted = [c for t, c in claims.items() if t.startswith("Draft tokens")]
    assert drafted[0].group_id is not None and drafted[0].group_id == drafted[1].group_id

    hits = hybrid_search("quantize kv cache to 2-bit", "claims", limit=2)
    assert hits[0].id == claims["Quantize KV cache entries to 2-bit integers"].id
    with get_engine(db).connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM research.claim_groups")).scalar() == 1


def test_llm_responses_are_cached_in_postgres(db, monkeypatch):
    from paperatlas.db.schema import LLMCacheEntry
    from paperatlas.llm.client import LLMCache, LLMClient, LLMConfig

    calls = []

    def fake_call(self, system_prompt, user_prompt, schema):
        calls.append(user_prompt)
        return '{"answer": 42}'

    monkeypatch.setattr(LLMClient, "_call", fake_call)
    schema = ("answer", {"type": "object"})
    first = LLMClient(LLMConfig(api_key="k"), cache=LLMCache()).generate_json("sys", "q", *schema)
    second = LLMClient(LLMConfig(api_key="k"), cache=LLMCache()).generate_json("sys", "q", *schema)
    assert first == second == {"answer": 42}
    assert calls == ["q"]
    with session_scope() as session:
        entry = session.scalars(select(LLMCacheEntry)).one()
    assert (entry.model, entry.schema_name) == (LLMConfig.model, "answer")



def _distill_one(technique="Quantize KV cache entries to 2-bit integers", **overrides):
    llm = FakeLLM({"paper_distillation": lambda prompt: {"paper_summary": "s", "concepts": [{**concept(technique), **overrides}]}})
    return DistillPipeline(extractor=ClaimExtractor(llm), concurrency=1)


def test_redistilling_keeps_papers_whose_claims_have_experiments(db):
    from paperatlas.db.schema import Experiment, Project

    store = PaperStore()
    store.upsert(PaperMetadata(title="KV cache 2-bit", abstract="We quantize the KV cache. " * 30, arxiv_id="2401.00002", source="arxiv"))
    store.upsert(PaperMetadata(title="Other", abstract="Something else entirely. " * 30, arxiv_id="2401.00003", source="arxiv"))
    _distill_one().run(limit=10, group=False, explain=False)
    with session_scope() as session:
        claim = session.scalars(select(Claim).where(Claim.paper_id == "arxiv:2401.00002")).one()
        claim_id = claim.id
        project = Project(name="p", repo_path="/x")
        session.add(project)
        session.flush()
        session.add(Experiment(project_id=project.id, claim_id=claim_id, thread_id="t1"))

    assert store.reset_distillation() == {"arxiv:2401.00002"}
    stats = _distill_one(technique="Something different").run(limit=10, reprocess=True, group=False, explain=False)
    assert stats.papers == 1  # only the unprotected paper was re-distilled
    stats = _distill_one(technique="Something different").run(
        paper_ids=["arxiv:2401.00002"], reprocess=True, group=False, explain=False
    )
    assert stats.papers == 0
    assert store.save_distillation("arxiv:2401.00002", []) == []
    with session_scope() as session:
        assert session.scalar(select(func.count()).select_from(Experiment)) == 1
        assert session.get(Claim, claim_id).technique == "Quantize KV cache entries to 2-bit integers"
        assert session.get(Paper, "arxiv:2401.00002").distilled_at is not None


def test_nul_bytes_are_stripped_and_one_bad_paper_does_not_stop_the_batch(db, monkeypatch):
    from paperatlas.concepts.extraction.models import PaperAuthor

    store = PaperStore()
    store.upsert_many(
        [
            PaperMetadata(title="A\x00", abstract="Alpha text. " * 30, arxiv_id="2401.00011", source="arxiv", authors=[PaperAuthor(name="N\x00ul")]),
            PaperMetadata(title="B", abstract="Beta text. " * 30, arxiv_id="2401.00012", source="arxiv"),
        ],
        source_payload={"raw": "x\x00y"},
    )
    pipeline = _distill_one(technique="Quantize KV\x00 cache entries", name="Na\x00me", summary="su\x00m", key_points=["p\x00t"])
    original = store.save_distillation

    def flaky(paper_id, concepts):
        if paper_id == "arxiv:2401.00012":
            raise RuntimeError("boom")
        return original(paper_id, concepts)

    monkeypatch.setattr(store, "save_distillation", flaky)
    pipeline.store = store
    stats = pipeline.run(limit=10, group=False, explain=False)
    assert stats.papers == 1
    with session_scope() as session:
        from paperatlas.db.schema import Concept

        concept_row = session.scalars(select(Concept)).one()
        assert (concept_row.name, concept_row.summary, concept_row.key_points) == ("Name", "sum", ["pt"])
        paper = session.get(Paper, "arxiv:2401.00011")
        assert (paper.title, paper.authors[0]["name"], paper.source_payload) == ("A", "Nul", {"raw": "xy"})


def test_upsert_merges_doi_only_and_arxiv_records_of_the_same_paper(db):
    store = PaperStore()
    first = store.upsert(PaperMetadata(title="Paged attention", doi="https://doi.org/10.1145/3600006.3613165", source="openalex", citation_count=7))
    second = store.upsert(PaperMetadata(title="Paged attention", doi="10.1145/3600006.3613165", arxiv_id="2309.06180v1", source="semantic_scholar"))
    third = store.upsert(PaperMetadata(title="Paged attention", arxiv_id="2309.06180", source="arxiv"))
    assert first == second == third == "doi:10.1145/3600006.3613165"
    paper = store.get(first)
    assert paper["sources"] == ["openalex", "semantic_scholar", "arxiv"]
    assert paper["citation_count"] == 7
    with session_scope() as session:
        assert session.scalar(select(func.count()).select_from(Paper)) == 1


def test_concurrent_upserts_of_a_new_paper_do_not_conflict(db):
    from concurrent.futures import ThreadPoolExecutor

    store = PaperStore()
    items = [PaperMetadata(title="Race", arxiv_id="2401.09999", source=f"s{i}", citation_count=i) for i in range(8)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        ids = list(pool.map(lambda item: store.upsert(item), items))
    assert set(ids) == {"arxiv:2401.09999"}
    paper = store.get("arxiv:2401.09999")
    assert sorted(paper["sources"]) == sorted(f"s{i}" for i in range(8))
    assert paper["citation_count"] == 7


def test_topic_refresh_replaces_paper_membership(db):
    import numpy as np

    from paperatlas.db.schema import PaperTopic
    from paperatlas.discovery.config import R2EConfig, Seed
    from paperatlas.discovery.topics import Cluster, persist_topics

    store = PaperStore()
    ids = store.upsert_many([PaperMetadata(title=f"P{i}", arxiv_id=f"2401.0010{i}", source="arxiv") for i in range(3)])
    config = R2EConfig(seeds=[Seed(name="s", queries=["q"])])

    def cluster(members, relevance):
        return Cluster(index=0, paper_ids=members, seed="s", centroid=np.ones(384) / np.sqrt(384), relevance=dict(zip(members, relevance)), name="Topic", stats={})

    (topic_id,) = persist_topics([cluster(ids[:2], [0.9, 0.8])], config)
    assert persist_topics([cluster(ids[1:], [0.5, 0.4])], config) == [topic_id]
    with session_scope() as session:
        links = {link.paper_id: link.relevance for link in session.scalars(select(PaperTopic).where(PaperTopic.topic_id == topic_id))}
    assert links == {ids[1]: 0.5, ids[2]: 0.4}


def test_dedup_filters_category_before_the_neighbour_limit(db):
    import numpy as np

    from paperatlas.distill.dedup import assign_claim_groups

    store = PaperStore()
    store.upsert_many([PaperMetadata(title=t, arxiv_id=f"2401.0020{i}", source="arxiv") for i, t in enumerate("AB")])
    base = np.zeros(384, dtype=np.float32)
    base[0] = 1.0
    near = base.copy()
    near[1] = 0.2

    def payload(key, category, embedding):
        return {"concept_key": key, "name": key, "claim": {"category": category, "technique": key, "card": {}, "embedding": embedding}}

    (mine,) = store.save_distillation("arxiv:2401.00200", [payload("a", "kv_cache", base)])
    store.save_distillation(
        "arxiv:2401.00201",
        [payload(f"q{i}", "quantization", base) for i in range(11)] + [payload("kv", "kv_cache", near)],
    )
    assert assign_claim_groups([mine]) == 1
    with session_scope() as session:
        grouped = session.scalars(select(Claim.technique).where(Claim.group_id.is_not(None))).all()
    assert sorted(grouped) == ["a", "kv"]
