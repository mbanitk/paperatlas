
---

# **PaperAtlas — Engineering Design Document (EDD)**

**Author:** Senior Staff Engineer
**Audience:** Backend, ML, Infra, Data, Platform Engineers
**Status:** Design Review Draft
**Scope:** End-to-end system (ingestion → ML → graph → API → scaling)

---

## **1. Abstract**

PaperAtlas is a production-grade, ML-first research intelligence system that transforms academic papers into a **concept-level knowledge graph**, enabling explainable, personalized recommendations.

The system combines:

* LLM-based concept extraction & summarization
* Graph databases for citation and concept relationships
* PyTorch-based ML ranking and GNNs
* Vector similarity search
* Real-time APIs for recommendation and exploration

This document describes **how to build, deploy, and scale** the system end to end.

---

## **2. Design Principles**

1. **Concepts > Documents**
2. **ML-first, LLM-assisted**
3. **Explainability is non-negotiable**
4. **Batch-first, incremental updates**
5. **Separation of concerns**
6. **Offline learning, online inference**
7. **Scalable to 100M+ papers**

---

## **3. System Overview**

### **High-Level Architecture**

```
┌────────────--┐
│ Data Sources │
│ arXiv, OA    │
└─────┬──────--┘
      ↓
┌────────────┐
│ Ingestion  │
│ Parsing    │
└─────┬──────┘
      ↓
┌────────────┐
│ Concept    │◄── LLM
│ Extraction │
└─────┬──────┘
      ↓
┌────────────┐
│ Summarizer │◄── LLM
└─────┬──────┘
      ↓
┌────────────┐
│ Embeddings │◄── PyTorch
└─────┬──────┘
      ↓
┌────────────┐
│ Knowledge  │
│ Graph DB   │
└─────┬──────┘
      ↓
┌────────────┐
│ Ranking &  │◄── ML / GNN
│ Recommender│
└─────┬──────┘
      ↓
┌────────────┐
│ API Layer  │
└────────────┘
```

---

## **4. Data Model**

### **4.1 Core Entities**

#### **Paper**

```json
{
  "paper_id": "doi/arxiv_id",
  "title": "...",
  "abstract": "...",
  "year": 2024,
  "venue": "NeurIPS",
  "authors": [...],
  "citation_count": 123
}
```

#### **Concept**

```json
{
  "concept_id": "uuid",
  "name": "Graph Attention Mechanism",
  "type": "method|idea|result",
  "summary": {
    "paragraph": "...",
    "bullets": [...]
  },
  "embedding": [float]
}
```

#### **User**

```json
{
  "user_id": "uuid",
  "interests": [...],
  "skill_vector": [float]
}
```

---

## **5. Knowledge Graph Schema**

### **Nodes**

* `Paper`
* `Concept`
* `Author`
* `Venue`

### **Edges**

| Edge            | Direction         | Meaning          |
| --------------- | ----------------- | ---------------- |
| `CITES`         | Paper → Paper     | Citation         |
| `MENTIONS`      | Paper → Paper     | In-text          |
| `HAS_CONCEPT`   | Paper → Concept   | Ownership        |
| `SIMILAR_TO`    | Concept ↔ Concept | Semantic         |
| `EXTENDS`       | Paper → Paper     | Research lineage |
| `INTERESTED_IN` | User → Concept    | Preferences      |

Graph DB: **Neo4j** (v1), extensible to TigerGraph later.

---

## **6. Ingestion Pipeline**

### **6.1 Sources**

* OpenAlex (primary)
* arXiv PDFs
* CrossRef metadata

### **6.2 Pipeline Stages**

1. **Fetch metadata**
2. **Download PDFs**
3. **Parse PDF** (GROBID)
4. **Extract sections**
5. **Store raw text**

All steps are **idempotent** and **replayable**.

---

## **7. Concept Extraction (LLM + Heuristics)**

### **Input**

* Abstract
* Introduction
* Method
* Conclusion

### **LLM Prompting Strategy**

* Few-shot examples
* Structured JSON output
* Strict schema validation

### **Post-processing**

* Deduplication via embedding similarity
* Canonical concept naming
* Confidence scoring

### **Failure Handling**

* Retry with simplified prompt
* Fallback heuristic extractor

---

## **8. Concept Summarization**

Each concept produces:

```json
{
  "summary_text": "...",
  "bullet_points": [
    "...",
    "...",
    "..."
  ]
}
```

### **Design Choices**

* Generated once per concept
* Cached and versioned
* Regenerated only if concept changes

---

## **9. Embedding System (PyTorch)**

### **Models**

* SciBERT / SPECTER
* Instructor-style encoders

### **Embeddings Generated For**

* Concepts
* Papers
* Users

### **Storage**

* FAISS index (offline)
* Vector DB (online inference)

---

## **10. Machine Learning Systems**

### **10.1 Ranking Model (PyTorch)**

#### **Inputs**

* Concept embedding
* User embedding
* Graph features
* Temporal features

#### **Architecture**

* MLP / Transformer
* Pairwise ranking loss

#### **Training Data**

* Implicit feedback
* Citation-derived relevance
* Synthetic negative samples

---

### **10.2 Graph Neural Network**

#### **Purpose**

* Learn structural importance
* Capture citation influence

#### **Model**

* GraphSAGE / GAT
* Offline inference
* Periodic retraining

---

## **11. Recommendation Engine**

### **Recommendation Types**

1. Concept recommendations
2. Paper recommendations
3. Learning path suggestions

### **Scoring Function**

```
score = α * semantic
      + β * graph_rank
      + γ * user_affinity
      + δ * recency
```

---

## **12. Explainability Engine**

Each recommendation stores:

* Top contributing signals
* Graph paths
* Concept overlaps

Generated explanation:

> “Recommended because this concept extends X and is cited by Y, which you previously explored.”

---

## **13. API Layer**

### **Tech**

* FastAPI
* Async-first
* Stateless

### **Endpoints**

* `/search`
* `/recommend/concepts`
* `/recommend/papers`
* `/graph/explore`

---

## **14. Infra & Deployment**

### **Environment**

* uv + pyproject.toml
* Dockerized services
* Kubernetes-ready

### **Services**

* Ingestion workers
* ML training jobs
* Online inference service
* Graph DB

---

## **15. SLAs, Monitoring & Alerting**

### **SLAs**

| Service                  | Target     |
| ------------------------ | ---------- |
| API latency              | <300ms p95 |
| Recommendation freshness | <24h       |
| Ingestion lag            | <6h        |

### **Monitoring**

* Latency
* Error rates
* Concept extraction failures
* Drift detection

---

## **16. Scaling Strategy**

### **Phase 1**

* 100K papers
* Single region
* Batch jobs

### **Phase 2**

* Millions of papers
* Distributed embedding
* Sharded graph

### **Phase 3**

* Real-time personalization
* Online learning

---

## **17. Security & Privacy**

* No full PDF exposure
* PII-free by design
* Read-only academic content

---

## **18. Risks & Tradeoffs**

| Risk            | Mitigation            |
| --------------- | --------------------- |
| LLM cost        | Batch + caching       |
| Concept noise   | Dedup + validation    |
| Graph explosion | Thresholding          |
| Cold start      | Citation-based priors |

---

## **19. Implementation Roadmap**

### **Milestone 1**

* Ingestion + parsing
* Graph schema
* Static recommendations

### **Milestone 2**

* Concept extraction
* Summaries
* Semantic search

### **Milestone 3**

* ML ranking
* User modeling
* Explainability

---

## **20. References**

* OpenAlex
* SPECTER
* GraphSAGE
* Neo4j
* FAISS
* PyTorch

---

## **21. Final Notes**

This system is:

* **Production-viable**
* **ML-rich**
* **Extensible**
* **Excellent for deep PyTorch learning**

If you want next:

* Convert this into **implementation tickets**
* Start **Phase 1 code walkthrough**
* Write **first ingestion service**
* Build **first ranking model**

Tell me how you want to proceed, and we’ll build it for real.


-------------------------------------------------
# **PaperAtlas Implementation Plan (Phase-wise)**
-------------------------------------------------


---

## **Phase 0 — Setup & Foundations**

**Goal:** Prepare the environment, project structure, and basic boilerplate.
This ensures you don’t get lost later and can build incrementally.

**Objectives:**

* Initialize repository and project structure
* Setup virtual environment (uv + pyproject.toml)
* Setup linting, formatting, testing
* Basic FastAPI skeleton

**Deliverables:**

* Project folder as discussed
* pyproject.toml with dependencies:

  * fastapi, uvicorn, pydantic
  * torch, transformers, sentence-transformers
  * networkx, neo4j
  * faiss, numpy, pandas
* Dockerfile for local testing
* Minimal API endpoint (`/healthcheck`)

**Learning Outcomes:**

* Understand project structure
* FastAPI basics
* Python dependency management

---

## **Phase 1 — Data Ingestion & Storage**

**Goal:** Build pipelines to fetch, parse, and store papers.

**Objectives:**

* Fetch metadata from **OpenAlex**, **arXiv**, **CrossRef**
* Parse PDFs using **GROBID** or **PyMuPDF**
* Store raw text and metadata in local **Postgres / JSON storage**
* Define canonical IDs (DOI/arXiv ID)
* Build basic **Neo4j graph** with paper nodes

**Deliverables:**

* Ingestion scripts in `concepts/extraction`
* Initial Neo4j schema (`graph/schema.py`)
* Basic ETL pipeline

**Learning Outcomes:**

* Handling APIs, batch ingestion
* Graph DB setup
* Data validation and cleaning
* Introduce **PyTorch only for embeddings** in next phase

---

## **Phase 2 — Concept Extraction & Summarization**

**Goal:** Extract key concepts and generate summaries (LLM + heuristics).

**Objectives:**

* LLM-based concept extraction (`llm_extractor.py`)
* Heuristic extraction fallback (`heuristic_extractor.py`)
* Concept deduplication (`deduplication.py`)
* Summarization per concept (`concept_summarizer.py`) → paragraph + bullet points
* Link extracted concepts to papers in Neo4j

**Deliverables:**

* Concepts attached to papers
* Summary per concept stored with embeddings
* Test pipeline on 1k papers

**Learning Outcomes:**

* LLM usage for structured outputs
* Handling text-to-graph mapping
* Summarization and bullet generation logic

---

## **Phase 3 — Embeddings & Semantic Search**

**Goal:** Make the graph **ML-aware** for recommendations.

**Objectives:**

* Encode papers & concepts using **SciBERT / SPECTER / Instructor**
* Store embeddings in **FAISS** (offline) or vector DB (online)
* Add `SIMILAR_TO` edges in Neo4j based on embeddings
* Build prototype **semantic search**

**Deliverables:**

* Embeddings stored and retrievable
* Semantic similarity edges in graph
* Example query: “Find concepts similar to X”

**Learning Outcomes:**

* PyTorch embeddings pipeline
* Semantic search basics
* Combining graph + vector similarity

---

## **Phase 4 — ML Ranking & GNN**

**Goal:** Build **personalized, graph-aware recommendations**.

**Objectives:**

* Train a **ranking model**:

  * Input: concept embedding + user profile + graph features
  * Output: relevance score
* Train **GNN (GraphSAGE / GAT)** to learn graph importance
* Combine semantic + graph + user features into hybrid scorer
* Test scoring on a small user profile dataset

**Deliverables:**

* `ml/models/concept_ranker.py`
* `ml/training/train_ranker.py`
* `ml/inference/scorer.py`
* API endpoint `/recommend/concepts` returning ranked concepts

**Learning Outcomes:**

* PyTorch ranking model
* GNN implementation
* ML feature engineering

---

## **Phase 5 — Full Application & Personalization**

**Goal:** Complete **end-to-end application** with APIs, explainability, and UI hooks.

**Objectives:**

* Build FastAPI endpoints:

  * `/search`
  * `/recommend/papers`
  * `/recommend/concepts`
  * `/graph/explore`
* Add **user profiles**, interest vectors, and interaction logging
* Provide **explanations** per recommendation
* Implement **incremental ingestion** for new papers
* Optional: integrate **UI/React** for graph visualization
* Monitor & alert on errors, pipeline delays

**Deliverables:**

* Production-ready API
* Personalization for users
* Explainability engine for recommendations
* Metrics: latency, freshness, coverage

**Learning Outcomes:**

* Production API design
* Personalization using embeddings + graph
* Observability for ML pipelines
* Full-stack understanding (backend + ML + graph)

---

## **Phase 6 — Scaling & Optimization (Optional / Advanced)**

**Goal:** Make system **scalable to millions of papers & concurrent users**.

**Objectives:**

* Distributed graph DB (Neo4j Aura / TigerGraph)
* FAISS / Milvus for millions of embeddings
* Async ingestion + batch updates
* Incremental retraining for ML models
* Auto-scaling APIs and worker nodes

**Deliverables:**

* Sharded graph + vector DB
* Multi-node ingestion
* Online learning / personalization

**Learning Outcomes:**

* Real-world scale architecture
* Batch + streaming ingestion
* ML deployment & orchestration

---

## **Phase Dependencies**

| Phase | Depends On |
| ----- | ---------- |
| 0     | None       |
| 1     | 0          |
| 2     | 1          |
| 3     | 2          |
| 4     | 3          |
| 5     | 4          |
| 6     | 5          |

---

## **Phase Notes / Tips**

1. Each phase **produces incremental value** — you can demo after Phase 2 (concept summaries) or Phase 3 (semantic search).
2. **Keep graph DB schema flexible** — adding new edge types later is easier than restructuring.
3. **Use caching aggressively** for LLM outputs — cost and latency matter.
4. **Focus on learning PyTorch in Phase 3-4** — embeddings + ranking + GNN.
5. **Unit test every stage** — parsing, concept extraction, embeddings, ranking.

---

If you want, I can now **write a Phase 1 implementation guide with scripts, boilerplate, and ready-to-run examples** so you can start building immediately, **without losing track**.

Do you want me to do that next?
