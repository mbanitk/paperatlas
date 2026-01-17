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

## Notes

- Many modules use **optional dependencies** (Neo4j driver, FAISS, PyTorch, Transformers). If they are not installed, the code raises helpful errors at runtime rather than failing on import.
- Configuration lives in `config/settings.yaml` and `config/model.yaml`.


## Setup
```bash
uv venv
source .venv/bin/activate
uv pip install -e .
uvicorn paperatlas.api.main:app --reload
```