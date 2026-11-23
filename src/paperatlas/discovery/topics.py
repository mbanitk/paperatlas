"""Phase 1 — Discover: auto-pick the top trending topics inside the configured seed areas."""

from __future__ import annotations

import logging
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any, Callable, Optional, Sequence

import numpy as np
from sqlalchemy import select, update

from paperatlas.concepts.extraction.models import PaperMetadata
from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Paper, PaperTopic, Topic
from paperatlas.db.store import PaperStore
from paperatlas.discovery.config import R2EConfig, load_config
from paperatlas.discovery.sources import Source, build_sources
from paperatlas.embeddings.text import embed_texts, paper_text
from paperatlas.llm.client import LLMClient, LLMError, build_default_llm_client

logger = logging.getLogger(__name__)

Reporter = Callable[[str, str, Optional[dict]], None]


def log_reporter(stage: str, message: str, data: Optional[dict] = None) -> None:
    logger.info("[%s] %s", stage, message)


@dataclass
class Cluster:
    index: int
    paper_ids: list[str]
    seed: str
    centroid: np.ndarray
    relevance: dict[str, float]
    stats: dict[str, float] = field(default_factory=dict)
    trend_score: float = 0.0
    needs_gpu_cluster: bool = False
    name: str = ""
    description: str = ""
    keywords: list[str] = field(default_factory=list)
    queries: list[str] = field(default_factory=list)


def collect_pool(
    config: R2EConfig,
    sources: Sequence[Source],
    since: date,
    report: Reporter = log_reporter,
) -> tuple[list[PaperMetadata], dict[str, Counter]]:
    """Search every (seed query × source); return metadata and per-paper seed tags."""
    items: list[PaperMetadata] = []
    seeds_by_paper: dict[str, Counter] = defaultdict(Counter)
    for seed in config.seeds:
        found = 0
        for query in seed.queries:
            for source in sources:
                if not source.enabled:
                    continue
                for metadata in source.search(query, since, config.topics.per_query):
                    items.append(metadata)
                    seeds_by_paper[metadata.canonical_id()][seed.name] += 1
                    found += 1
        report("discover", f"Seed '{seed.name}': {found} results", {"seed": seed.name, "results": found})
    return items, seeds_by_paper


def _minmax(values: Sequence[float]) -> list[float]:
    low, high = min(values), max(values)
    if high - low < 1e-9:
        return [0.5 for _ in values]
    return [(value - low) / (high - low) for value in values]


def score_clusters(clusters: list[Cluster], papers: dict[str, dict], half_life_days: float) -> None:
    today = date.today()
    for cluster in clusters:
        members = [papers[pid] for pid in cluster.paper_ids]
        ages = [
            (today - member["publication_date"]).days if member["publication_date"] else half_life_days * 2
            for member in members
        ]
        cluster.stats = {
            "size": float(len(members)),
            "recency": float(np.mean([math.exp(-max(age, 0) * math.log(2) / half_life_days) for age in ages])),
            "velocity": float(np.mean([age <= 60 for age in ages])),
            "citations": float(np.mean([math.log1p(m["citation_count"] or 0) for m in members])),
            "upvotes": float(np.mean([math.log1p(m["hf_upvotes"] or 0) for m in members])),
            "code": float(np.mean([bool(m["code_url"]) for m in members])),
        }
    weights = {"size": 0.30, "recency": 0.20, "velocity": 0.15, "citations": 0.15, "upvotes": 0.12, "code": 0.08}
    normalized = {key: _minmax([c.stats[key] for c in clusters]) for key in weights}
    for position, cluster in enumerate(clusters):
        cluster.trend_score = round(sum(w * normalized[k][position] for k, w in weights.items()), 4)


def select_top(clusters: list[Cluster], count: int, max_per_seed: int) -> list[Cluster]:
    chosen: list[Cluster] = []
    per_seed: Counter = Counter()
    for cluster in sorted(clusters, key=lambda c: c.trend_score, reverse=True):
        if per_seed[cluster.seed] >= max_per_seed:
            continue
        chosen.append(cluster)
        per_seed[cluster.seed] += 1
        if len(chosen) == count:
            break
    return chosen


def cluster_papers(
    paper_ids: list[str],
    vectors: np.ndarray,
    seeds_by_paper: dict[str, Counter],
    min_size: int,
) -> list[Cluster]:
    from sklearn.cluster import KMeans

    n_clusters = max(2, min(40, len(paper_ids) // 8))
    labels = KMeans(n_clusters=n_clusters, n_init=5, random_state=0).fit_predict(vectors)
    clusters = []
    for index in range(n_clusters):
        member_rows = np.where(labels == index)[0]
        if len(member_rows) < min_size:
            continue
        centroid = vectors[member_rows].mean(axis=0)
        centroid = centroid / (np.linalg.norm(centroid) or 1.0)
        ids = [paper_ids[row] for row in member_rows]
        seed_votes: Counter = Counter()
        for pid in ids:
            seed_votes.update(seeds_by_paper.get(pid, {}))
        clusters.append(
            Cluster(
                index=index,
                paper_ids=ids,
                seed=seed_votes.most_common(1)[0][0] if seed_votes else "unknown",
                centroid=centroid,
                relevance={pid: float(vectors[row] @ centroid) for pid, row in zip(ids, member_rows)},
            )
        )
    return clusters


LABEL_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["topics"],
    "properties": {
        "topics": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["cluster", "name", "description", "keywords", "queries"],
                "properties": {
                    "cluster": {"type": "integer"},
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "keywords": {"type": "array", "items": {"type": "string"}},
                    "queries": {"type": "array", "items": {"type": "string"}},
                },
            },
        }
    },
}

LABEL_SYSTEM = (
    "You name clusters of recent research papers for an LLM-inference engineering team. "
    "For each cluster give: a precise technical topic name (2-6 words, no marketing), a one-sentence "
    "description of the shared technical problem/approach, 3-6 keywords, and 2-3 short search "
    "queries that would find more papers on exactly this topic."
)


def label_clusters(clusters: list[Cluster], papers: dict[str, dict], llm: Optional[LLMClient]) -> None:
    if llm:
        lines = []
        for cluster in clusters:
            titles = sorted(cluster.paper_ids, key=lambda pid: -cluster.relevance[pid])[:8]
            lines.append(f"Cluster {cluster.index} (seed area: {cluster.seed}):")
            lines.extend(f"- {papers[pid]['title']}" for pid in titles)
        try:
            payload = llm.generate_json(LABEL_SYSTEM, "\n".join(lines), "topic_labels", LABEL_SCHEMA)
            by_index = {item["cluster"]: item for item in payload.get("topics", [])}
            for cluster in clusters:
                item = by_index.get(cluster.index)
                if item:
                    cluster.name = item["name"].strip()
                    cluster.description = item["description"].strip()
                    cluster.keywords = item["keywords"][:6]
                    cluster.queries = item["queries"][:3]
        except LLMError as exc:
            logger.warning("Topic labeling via LLM failed, using keyword labels: %s", exc)
    for cluster in clusters:
        if not cluster.name:
            _keyword_label(cluster, papers)


def _keyword_label(cluster: Cluster, papers: dict[str, dict]) -> None:
    from sklearn.feature_extraction.text import TfidfVectorizer

    docs = [paper_text(papers[pid]["title"], papers[pid]["abstract"]) for pid in cluster.paper_ids]
    try:
        tfidf = TfidfVectorizer(ngram_range=(1, 2), stop_words="english", max_features=2000).fit(docs)
        scores = np.asarray(tfidf.transform(docs).mean(axis=0)).ravel()
        terms = [tfidf.get_feature_names_out()[i] for i in scores.argsort()[::-1][:6]]
    except ValueError:
        terms = [cluster.seed]
    cluster.name = terms[0].title() if terms else cluster.seed
    cluster.description = f"Recent work in '{cluster.seed}' about {', '.join(terms[:3])}."
    cluster.keywords = terms
    cluster.queries = terms[:2]


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "topic"


def _paper_signals(paper_ids: list[str]) -> dict[str, dict]:
    with session_scope() as session:
        rows = session.execute(
            select(
                Paper.paper_id,
                Paper.title,
                Paper.abstract,
                Paper.publication_date,
                Paper.citation_count,
                Paper.hf_upvotes,
                Paper.code_url,
                Paper.doc_type,
            ).where(Paper.paper_id.in_(paper_ids))
        ).all()
    return {row.paper_id: row._asdict() for row in rows}


def ensure_paper_embeddings(store: PaperStore, report: Reporter = log_reporter) -> None:
    while True:
        missing = store.papers_missing_embeddings(limit=512)
        if not missing:
            return
        vectors = embed_texts([paper_text(title, abstract) for _, title, abstract in missing])
        store.set_paper_embeddings({pid: vectors[i] for i, (pid, _, _) in enumerate(missing)})
        report("discover", f"Embedded {len(missing)} papers", None)


def _load_vectors(paper_ids: list[str]) -> tuple[list[str], np.ndarray]:
    with session_scope() as session:
        rows = session.execute(
            select(Paper.paper_id, Paper.embedding).where(
                Paper.paper_id.in_(paper_ids), Paper.embedding.is_not(None)
            )
        ).all()
    return [row.paper_id for row in rows], np.asarray([row.embedding for row in rows], dtype=np.float32)


def persist_topics(clusters: list[Cluster], config: R2EConfig) -> list[int]:
    now = datetime.now(UTC)
    topic_ids = []
    used_slugs: set[str] = set()
    with session_scope() as session:
        session.execute(update(Topic).where(Topic.rank.is_not(None)).values(rank=None, status="archived"))
        for rank, cluster in enumerate(clusters, start=1):
            slug = slugify(cluster.name)
            while slug in used_slugs:
                slug = f"{slug}-{rank}"
            used_slugs.add(slug)
            topic = session.scalar(select(Topic).where(Topic.slug == slug)) or Topic(slug=slug)
            seed = config.seed(cluster.seed)
            topic.name = cluster.name
            topic.description = cluster.description
            topic.seed = cluster.seed
            topic.keywords = cluster.keywords
            topic.queries = cluster.queries
            topic.trend_score = cluster.trend_score
            topic.rank = rank
            topic.status = "active"
            topic.needs_gpu_cluster = bool(seed and seed.needs_gpu_cluster)
            topic.stats = {**cluster.stats, "papers": len(cluster.paper_ids)}
            topic.embedding = cluster.centroid
            topic.refreshed_at = now
            session.add(topic)
            session.flush()
            for pid in cluster.paper_ids:
                link = session.get(PaperTopic, (pid, topic.id)) or PaperTopic(paper_id=pid, topic_id=topic.id)
                link.relevance = cluster.relevance[pid]
                session.add(link)
            topic_ids.append(topic.id)
    return topic_ids


def refresh_topics(
    config: Optional[R2EConfig] = None,
    sources: Optional[Sequence[Source]] = None,
    llm: Optional[LLMClient] = None,
    use_llm: bool = True,
    report: Reporter = log_reporter,
) -> list[dict[str, Any]]:
    config = config or load_config()
    sources = sources if sources is not None else build_sources(config.sources)
    since = date.today() - timedelta(days=config.topics.lookback_days)
    store = PaperStore()

    items, seeds_by_paper = collect_pool(config, sources, since, report)
    if not items:
        raise RuntimeError("No papers found from any source; check network / API keys.")
    paper_ids = list(dict.fromkeys(store.upsert_many(items)))
    report("discover", f"Pool: {len(paper_ids)} unique papers/patents", {"papers": len(paper_ids)})
    ensure_paper_embeddings(store, report)

    ids, vectors = _load_vectors(paper_ids)
    clusters = cluster_papers(ids, vectors, seeds_by_paper, config.topics.min_cluster_size)
    papers = _paper_signals(ids)
    score_clusters(clusters, papers, config.ranking.half_life_days)
    top = select_top(clusters, config.topics.count, config.topics.max_per_seed)
    llm = llm if llm is not None else (build_default_llm_client() if use_llm else None)
    label_clusters(top, papers, llm)
    persist_topics(top, config)
    report("discover", f"Selected {len(top)} trending topics", {"topics": [c.name for c in top]})
    return list_topics()


def list_topics(include_archived: bool = False) -> list[dict[str, Any]]:
    with session_scope() as session:
        query = select(Topic).order_by(Topic.rank.is_(None), Topic.rank, Topic.trend_score.desc())
        if not include_archived:
            query = query.where(Topic.rank.is_not(None))
        topics = session.scalars(query).all()
        return [
            {
                "id": t.id,
                "slug": t.slug,
                "name": t.name,
                "description": t.description,
                "seed": t.seed,
                "rank": t.rank,
                "trend_score": t.trend_score,
                "needs_gpu_cluster": t.needs_gpu_cluster,
                "keywords": t.keywords,
                "queries": t.queries,
                "stats": t.stats,
                "status": t.status,
                "refreshed_at": t.refreshed_at,
            }
            for t in topics
        ]
