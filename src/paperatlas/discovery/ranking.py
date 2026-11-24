"""Rank papers per topic and fetch full text for the best ones (input to Distill)."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional, Sequence

import numpy as np
from sqlalchemy import select

from paperatlas.concepts.extraction.pipeline import download_pdf_text
from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Paper, PaperTopic, Topic
from paperatlas.db.store import PaperStore
from paperatlas.discovery.config import R2EConfig, load_config
from paperatlas.discovery.sources import Source, build_sources
from paperatlas.discovery.topics import Reporter, ensure_paper_embeddings, log_reporter

EXPAND_MIN_RELEVANCE = 0.45


@dataclass
class DiscoverStats:
    topics: int = 0
    candidates: int = 0
    selected: list[str] = field(default_factory=list)
    text_fetched: int = 0


def paper_score(
    relevance: float,
    publication_date: Optional[date],
    citations: Optional[int],
    upvotes: Optional[int],
    has_code: bool,
    is_patent: bool,
    max_citations: int,
    max_upvotes: int,
    weights: dict[str, float],
    half_life_days: float,
) -> float:
    age = (date.today() - publication_date).days if publication_date else half_life_days * 3
    features = {
        "relevance": max(relevance, 0.0),
        "recency": math.exp(-max(age, 0) * math.log(2) / half_life_days),
        "citations": math.log1p(citations or 0) / math.log1p(max_citations) if max_citations else 0.0,
        "upvotes": math.log1p(upvotes or 0) / math.log1p(max_upvotes) if max_upvotes else 0.0,
        "code": 1.0 if has_code else 0.0,
        "patent": 1.0 if is_patent else 0.0,
    }
    return round(sum(weights.get(key, 0.0) * value for key, value in features.items()), 4)


def expand_topic(topic: Topic, sources: Sequence[Source], since: date, per_query: int) -> int:
    """Search the topic's own queries and attach close-enough results to it."""
    store = PaperStore()
    items = [
        metadata
        for query in topic.queries or []
        for source in sources
        if source.enabled
        for metadata in source.search(query, since, per_query)
    ]
    if not items:
        return 0
    ids = list(dict.fromkeys(store.upsert_many(items)))
    ensure_paper_embeddings(store)
    centroid = np.asarray(topic.embedding, dtype=np.float32)
    added = 0
    with session_scope() as session:
        rows = session.execute(select(Paper.paper_id, Paper.embedding).where(Paper.paper_id.in_(ids))).all()
        for paper_id, embedding in rows:
            if embedding is None:
                continue
            relevance = float(np.asarray(embedding) @ centroid)
            if relevance < EXPAND_MIN_RELEVANCE:
                continue
            link = session.get(PaperTopic, (paper_id, topic.id))
            if link is None:
                session.add(PaperTopic(paper_id=paper_id, topic_id=topic.id, relevance=relevance))
                added += 1
    return added


def rank_topic(topic_id: int, config: R2EConfig) -> list[tuple[str, float]]:
    with session_scope() as session:
        rows = session.execute(
            select(PaperTopic, Paper)
            .join(Paper, Paper.paper_id == PaperTopic.paper_id)
            .where(PaperTopic.topic_id == topic_id)
        ).all()
        if not rows:
            return []
        max_citations = max((paper.citation_count or 0) for _, paper in rows)
        max_upvotes = max((paper.hf_upvotes or 0) for _, paper in rows)
        scored = []
        for link, paper in rows:
            link.score = paper_score(
                link.relevance,
                paper.publication_date,
                paper.citation_count,
                paper.hf_upvotes,
                bool(paper.code_url),
                paper.doc_type == "patent",
                max_citations,
                max_upvotes,
                config.ranking.weights,
                config.ranking.half_life_days,
            )
            scored.append((link, paper.paper_id))
        scored.sort(key=lambda item: item[0].score, reverse=True)
        for rank, (link, _) in enumerate(scored, start=1):
            link.rank = rank
        return [(paper_id, link.score) for link, paper_id in scored]


def discover(
    topic_slugs: Optional[Sequence[str]] = None,
    per_topic: Optional[int] = None,
    expand: bool = True,
    fetch_text: bool = True,
    config: Optional[R2EConfig] = None,
    sources: Optional[Sequence[Source]] = None,
    report: Reporter = log_reporter,
) -> DiscoverStats:
    config = config or load_config()
    per_topic = per_topic or config.ranking.per_topic
    sources = sources if sources is not None else build_sources(config.sources)
    since = date.today() - timedelta(days=config.topics.lookback_days)
    store = PaperStore()
    stats = DiscoverStats()

    with session_scope() as session:
        query = select(Topic).where(Topic.rank.is_not(None)).order_by(Topic.rank)
        if topic_slugs:
            query = select(Topic).where(Topic.slug.in_(list(topic_slugs)))
        topics = session.scalars(query).all()

    for topic in topics:
        if expand and topic.queries:
            added = expand_topic(topic, sources, since, max(5, config.topics.per_query // 2))
            report("discover", f"{topic.name}: +{added} papers from topic queries", {"topic": topic.slug})
        ranked = rank_topic(topic.id, config)
        stats.topics += 1
        stats.candidates += len(ranked)
        chosen = [paper_id for paper_id, _ in ranked[:per_topic]]
        stats.selected.extend(chosen)
        report(
            "discover",
            f"{topic.name}: top {len(chosen)} of {len(ranked)} papers selected",
            {"topic": topic.slug, "papers": chosen},
        )
        if fetch_text:
            for row in store.fetch_by_ids(chosen):
                if row["raw_text"] or not row["pdf_url"]:
                    continue
                text = download_pdf_text(row["pdf_url"])
                if text:
                    store.set_raw_text(row["paper_id"], text)
                    stats.text_fetched += 1
    stats.selected = list(dict.fromkeys(stats.selected))
    return stats
