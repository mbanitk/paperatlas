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

