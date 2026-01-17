# **PaperAtlas: A Concept-Centric Research Recommendation Platform**

## **Abstract**

Modern research discovery tools largely operate at the *paper level*, forcing users to read entire papers to extract relevant ideas. This creates significant friction for learners, practitioners, and researchers, especially as the volume of published research continues to grow exponentially.

**PaperAtlas** is a concept-centric research intelligence platform that decomposes research papers into **atomic concepts and contributions**, summarizes them at multiple abstraction levels, and recommends both **concepts and papers** using a hybrid of **graph algorithms, deep learning (PyTorch), and LLM-based agents**.

The system integrates **citation graphs**, **semantic embeddings**, **user modeling**, and **learned ranking models**, while using LLM agents only where reasoning and interpretation are required. The result is a scalable, explainable, and ML-first research recommendation system designed both as a **learning platform for modern ML systems** and a **production-grade architecture**.

---

## **Motivation**

### Industry Context

* Over **5M+ papers** are published annually across domains.
* Existing tools (Google Scholar, Semantic Scholar) optimize for **search**, not **learning paths**.
* Users care about **ideas**, not PDFs.

### User Pain Points

* Papers contain **multiple unrelated concepts**, but are treated as monolithic units.
* Recommendations are opaque and hard to interpret.
* Learners want *progressive depth* (beginner → advanced).
* Researchers want *contextual relevance*, not keyword matches.

### Personal Motivation

This project is explicitly designed to:

* Learn **PyTorch deeply** (ranking models, embeddings, GNNs)
* Build a **realistic ML system**, not toy notebooks
* Understand how **LLMs + classical ML** coexist in production systems

---

## **Problem Statement**

We want to answer:

> *How can we recommend research knowledge in a way that is concept-aware, personalized, explainable, and scalable?*

More formally:

1. Decompose each research paper into **multiple concepts/contributions**
2. Generate **structured summaries** per concept
3. Represent papers, concepts, authors, and citations as a **knowledge graph**
4. Learn **ranking functions** that recommend:

   * Concepts
   * Papers
   * Reading paths
5. Personalize results based on **user interests, skills, and interactions**
6. Provide **transparent explanations** for recommendations

---

## **Project Definition**

### **Core Entity Types**

* **Paper**
* **Concept**
* **Author**
* **Venue**
* **User**

### **Primary Outputs**

* Concept summaries (paragraph + bullets)
* Concept recommendations
* Paper recommendations
* Explainable ranking signals

### **Non-Goals**

* Full paper generation
* Citation plagiarism detection
* Real-time collaborative editing

---

## **System Architecture (High Level)**

```
                ┌────────────────────┐
                │   Data Sources     │
                │ (arXiv, OpenAlex)  │
                └─────────┬──────────┘
                          │
               ┌──────────▼──────────┐
               │  Ingestion Pipeline │
               │  (Parsing, Metadata)│
               └──────────┬──────────┘
                          │
        ┌─────────────────▼─────────────────┐
        │      Concept & Summary Layer      │
        │   (LLM / ADK Agents where needed) │
        └─────────────────┬─────────────────┘
                          │
        ┌─────────────────▼─────────────────┐
        │   Embeddings & Graph Construction │
        │  (PyTorch + Neo4j + FAISS)        │
        └─────────────────┬─────────────────┘
                          │
        ┌─────────────────▼─────────────────┐
        │        ML Ranking Layer           │
        │ (PyTorch Rankers, GNNs)           │
        └─────────────────┬─────────────────┘
                          │
        ┌─────────────────▼─────────────────┐
        │     Recommendation APIs           │
        │        (FastAPI)                  │
        └─────────────────┬─────────────────┘
                          │
                     UI / Client
```

---

## **Key Features**

### **1. Concept Extraction**

* Each paper yields **5–15 concepts**
* Concepts classified as:

  * Background
  * Method
  * Contribution
  * Result

**Tools**

* Google ADK for orchestration
* Heuristic + LLM hybrid extraction

---

### **2. Multi-Level Concept Summarization**

Each concept includes:

* 1 paragraph summary
* 3–5 bullet points
* Optional skill-level variants

**Why LLMs here?**

* This is semantic interpretation, not numeric optimization.

---

### **3. Knowledge Graph**

Graph nodes:

* Paper
* Concept
* Author
* Venue

Edges:

* CITES
* DISCUSSES
* EXTENDS
* SIMILAR_TO
* AUTHORED_BY

Stored in **Neo4j**.

---

### **4. Embedding Layer (PyTorch-Focused)**

* Paper embeddings
* Concept embeddings
* User embeddings

Models:

* SciBERT
* SPECTER
* Instructor-style encoders

Stored in **FAISS**.

---

### **5. Ranking & Recommendation (Core ML Learning Area)**

Ranking score:

```
score =
  α * semantic_similarity
+ β * graph_signal
+ γ * user_interest_match
+ δ * recency
```

Models:

* Pairwise ranking (PyTorch)
* GNNs (GraphSAGE / GAT)
* Learned user embeddings

---

### **6. User Modeling**

User profile includes:

* Skills
* Topics of interest
* Interaction history

Used to:

* Re-rank concepts
* Filter irrelevant depth
* Adapt summaries

---

### **7. Explainability**

Hybrid approach:

* ML produces ranking
* ADK agent explains reasoning in natural language

---

## **Technology Choices & Comparison**

### **Dependency Management**

| Tool   | Why Chosen                 |
| ------ | -------------------------- |
| **uv** | Fast, modern, reproducible |
| pip    | Too slow                   |
| conda  | Heavy, coarse-grained      |

---

### **ML Framework**

| Tool        | Why                         |
| ----------- | --------------------------- |
| **PyTorch** | Research-grade, flexible    |
| TensorFlow  | Less ergonomic for research |

---

### **Graph Storage**

| Tool       | Tradeoff                |
| ---------- | ----------------------- |
| **Neo4j**  | Mature, expressive      |
| ArangoDB   | Multi-model but heavier |
| JanusGraph | Ops complexity          |

---

### **Vector Search**

| Tool      | Reason                   |
| --------- | ------------------------ |
| **FAISS** | Fast, local, ML-friendly |
| Pinecone  | Managed, but opaque      |

---

### **LLMs / Agents**

| Tool           | Role                 |
| -------------- | -------------------- |
| **Google ADK** | Multi-step reasoning |
| Plain prompts  | Fragile              |

---

## **Implementation Plan (Phased)**

### **Phase 1: Foundations**

* Repo setup
* API skeleton
* Data ingestion
* Paper + concept schema

### **Phase 2: Embeddings & Graph**

* PyTorch encoders
* FAISS indexing
* Neo4j graph

### **Phase 3: Concept Ranking**

* Pairwise ranking model
* User embedding learning
* Offline evaluation

### **Phase 4: GNNs**

* GraphSAGE
* Node classification
* Link prediction

### **Phase 5: Explainability & UX**

* ADK explanation agent
* Recommendation justification

---

## **SLAs, Monitoring, and Alerting**

### **SLAs**

| Component                | Target       |
| ------------------------ | ------------ |
| API latency              | <300ms (p95) |
| Recommendation freshness | <24h         |
| Model retraining         | Weekly       |

---

### **Monitoring**

* Request latency
* Recommendation coverage
* Concept extraction success rate
* Embedding drift

---

### **Alerting**

* Graph ingestion failures
* FAISS index corruption
* Model inference errors

---

## **Milestones & Rollout**

| Milestone | Outcome                   |
| --------- | ------------------------- |
| MVP       | Concept summaries + recs  |
| v1        | User-aware ranking        |
| v2        | GNN-based recommendations |
| v3        | Research copilot          |

---

## **Dependencies**

### **Core**

* Python 3.11+
* uv
* PyTorch
* FastAPI
* Neo4j
* FAISS

### **Optional**

* Google ADK
* HuggingFace models
* Grobid (PDF parsing)

---

## **References**

* SPECTER: Cohan et al., ACL
* GraphSAGE: Hamilton et al.
* DeepWalk, Node2Vec
* Semantic Scholar Open Research Corpus
* OpenAlex

---

## **Final Note**

This project is **not a toy**.

If built incrementally as designed, PaperAtlas demonstrates:

* Senior-level ML system design
* Real-world hybrid AI architecture
* Clear separation of concerns
* Strong foundations for research or production

If you want, next we can:

* Convert this into a **README.md**
* Create **JIRA-style tasks**
* Start with **Phase 1 implementation step-by-step**

Just tell me how you want to proceed.
