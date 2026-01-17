# PaperAtlas — Project Structure & Schema

This document defines the **future-proof structure** of the project: folders, services, schemas, and how everything fits together as the system evolves.

---

## 1. High-Level Project Vision

PaperAtlas is a **concept-centric research intelligence platform**.

Core principles:

* Paper is a container
* Concept is the atomic unit
* Recommendations are driven by concepts, not just citations
* ML models evolve from embeddings → ranking → graph learning

---

## 2. Monorepo Folder Structure (Recommended)

```
paperatlas/
│
├── data/
│   ├── raw/                  # Raw API responses, PDFs
│   ├── processed/            # Cleaned JSON
│   └── cache/                # Cached embeddings, LLM outputs
│
├── ingestion/
│   ├── sources/
│   │   ├── openalex.py
│   │   ├── arxiv.py
│   │   └── semantic_scholar.py
│   ├── pdf/
│   │   └── grobid_parser.py
│   └── pipeline.py
│
├── concepts/
│   ├── extraction/
│   │   ├── llm_extractor.py
│   │   ├── heuristic_extractor.py
│   │   └── prompts/
│   ├── summarization/
│   │   └── concept_summarizer.py
│   └── validation/
│       └── deduplication.py
│
├── embeddings/
│   ├── models/
│   │   ├── scibert.py
│   │   ├── specter.py
│   │   └── instructor.py
│   ├── encoder.py
│   └── faiss_index.py
│
├── graph/
│   ├── schema.py
│   ├── neo4j_client.py
│   ├── builders/
│   │   ├── paper_graph.py
│   │   ├── concept_graph.py
│   │   └── author_graph.py
│   └── analytics/
│       ├── pagerank.py
│       └── community.py
│
├── ml/
│   ├── datasets/
│   │   └── ranking_dataset.py
│   ├── models/
│   │   ├── concept_ranker.py
│   │   ├── user_encoder.py
│   │   └── gnn.py
│   ├── training/
│   │   ├── train_ranker.py
│   │   └── train_gnn.py
│   └── inference/
│       └── scorer.py
│
├── recommender/
│   ├── concept_recommender.py
│   ├── paper_recommender.py
│   └── hybrid_ranker.py
│
├── user/
│   ├── profile.py
│   ├── interaction_logger.py
│   └── interest_model.py
│
├── api/
│   ├── main.py
│   ├── routes/
│   │   ├── search.py
│   │   ├── recommend.py
│   │   └── graph.py
│   └── schemas.py
│
├── ui/                        # Optional later (React, visualization)
│
├── experiments/
│   └── notebooks/
│
├── config/
│   ├── settings.yaml
│   └── model.yaml
│
├── tests/
│
└── README.md
```

---

## 3. Core Data Schemas

### 3.1 Paper Schema

```json
{
  "paper_id": "string (DOI/OpenAlex)",
  "title": "string",
  "abstract": "string",
  "year": 2024,
  "venue": "NeurIPS",
  "authors": ["author_id"],
  "references": ["paper_id"],
  "pagerank": 0.012,
  "embedding_id": "uuid"
}
```

---

### 3.2 Concept Schema (Key Object)

```json
{
  "concept_id": "uuid",
  "paper_id": "paper_id",
  "name": "Low-Rank Adaptation for Efficient Fine-Tuning",
  "type": "discussed | proposed",
  "summary": "One-paragraph explanation...",
  "bullets": [
    "Reduces trainable parameters",
    "Maintains model quality",
    "Enables fast adaptation"
  ],
  "novelty_score": 0.82,
  "importance_score": 0.74,
  "embedding_id": "uuid"
}
```

---

### 3.3 User Schema

```json
{
  "user_id": "uuid",
  "skills": ["machine learning", "nlp"],
  "interest_embedding": "vector",
  "recent_concepts": ["concept_id"],
  "interaction_history": [
    {"concept_id": "...", "action": "view", "timestamp": "..."}
  ]
}
```

---

## 4. Graph Schema (Neo4j)

### Nodes

* `Paper`
* `Concept`
* `Author`
* `User`

### Relationships

```
(Paper)-[:HAS_CONCEPT]->(Concept)
(Paper)-[:CITES]->(Paper)
(Concept)-[:SIMILAR_TO]->(Concept)
(Concept)-[:EXTENDS]->(Concept)
(User)-[:INTERESTED_IN]->(Concept)
(Author)-[:WROTE]->(Paper)
```

---

## 5. Recommendation Flow (Future-Proof)

### Concept-Level Ranking

Features:

* cosine(user_embedding, concept_embedding)
* concept novelty
* concept popularity
* recency

ML:

* PyTorch MLP Ranker

---

### Paper-Level Ranking

Features:

* aggregated concept relevance
* citation score (PageRank)
* venue weight

ML:

* Hybrid (rules + ML)

---

## 6. Feature Roadmap

### Phase 1 (MVP)

* Paper ingestion
* Concept extraction (LLM)
* Concept summaries
* Embeddings
* Similarity-based recommendation

### Phase 2

* User profiles
* Personalized ranking
* Learning-to-rank

### Phase 3

* Graph Neural Networks
* Trend detection
* Concept evolution tracking

---

## 7. Why This Structure Works

* Clear separation of concerns
* Easy to swap LLMs / models
* PyTorch-first ML layer
* Scales from 1k → millions of papers
* Research-grade but production-minded

---

## 8. Next Action

Implement **Step 1: ingestion + concept extraction**.

Once that works, everything else builds naturally on top.
