# PaperAtlas

PaperAtlas is a modular research assistant stack for:
- extracting concepts from papers,
- embedding text/papers/concepts,
- building/querying a knowledge graph,
- training ranking/graph models,
- serving search/recommendations via an API.

This repo is intentionally scaffolded with **minimal stubs** so you can iterate module-by-module.

## Quickstart (dev)

1. Create a virtualenv and install your preferred deps (FastAPI, Pydantic, etc.).
2. Run the API (after installing FastAPI + Uvicorn):

```bash
uvicorn paperatlas.api.main:app --reload
```

## LLM Configuration

LLM credentials and model defaults are configured in code for Phase 2.

## Phase 1 Ingestion

Phase 1 ingests paper metadata, downloads PDFs when available, stores JSON/MySQL
records, and optionally writes to Neo4j.

Example commands:

```bash
# Search-based ingestion
python -m paperatlas.concepts.extraction.ingest --query "graph neural networks"

# Search only the last year
python -m paperatlas.concepts.extraction.ingest \
  --query "graph neural networks" \
  --last-days 365 \
  --max-results 50

# Ingest by identifiers
python -m paperatlas.concepts.extraction.ingest --doi 10.1038/s41586-020-2649-2
python -m paperatlas.concepts.extraction.ingest --arxiv 2106.09685

# Override MySQL or Neo4j connection strings
python -m paperatlas.concepts.extraction.ingest \
  --query "graph neural networks" \
  --mysql-host "localhost" \
  --mysql-user "root" \
  --mysql-password "" \
  --mysql-database "paperatlas" \
  --neo4j-bolt-url "bolt://neo4j:root@localhost:7687"

# Disable MySQL or Neo4j if not running
python -m paperatlas.concepts.extraction.ingest --query "graph neural networks" --no-mysql
python -m paperatlas.concepts.extraction.ingest --query "graph neural networks" --no-neo4j
```

## Phase 2 Concept Extraction

Run the Phase 2 pipeline (pulls from MySQL, extracts concepts, writes logs):

```bash
python -m paperatlas.concepts.extraction.generate --limit 500 --batch-size 50
```

Optional flags:
- `--offset 0` for pagination
- `--no-neo4j` to skip graph writes
- `--no-llm` or `--offline` to skip LLM calls (heuristics only)
- `--log-dir data/concepts/phase2` to customize output logs

## Notes

- Many modules use **optional dependencies** (MySQL, Neo4j driver, FAISS, PyTorch, Transformers). If they are not installed, the code raises helpful errors at runtime rather than failing on import.
- Configuration lives in `config/settings.yaml` and `config/model.yaml`.


## Setup
```bash
uv venv
source .venv/bin/activate
uv pip install -e .
uvicorn paperatlas.api.main:app --reload
```