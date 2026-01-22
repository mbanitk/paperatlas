## Phase 1 Implementation Notes

This document describes the Phase 1 ingestion and storage implementation added to
the `paperatlas` codebase. It focuses on how metadata is fetched, PDFs are parsed,
data is stored, and paper nodes are written into Neo4j.

### Overview

Phase 1 introduces a minimal but functional ingestion pipeline with these goals:
- Fetch metadata from arXiv.
- Parse PDFs with either GROBID or PyMuPDF (optional dependency).
- Store raw text + metadata in local JSON, with an optional MySQL backend.
- Define canonical paper IDs (DOI or arXiv ID, with a hash fallback).
- Write a basic Neo4j graph with paper nodes.

### Main Components

#### Data Models (`src/paperatlas/concepts/extraction/models.py`)
- `PaperMetadata` holds normalized metadata fields (title, abstract, authors, IDs,
  URLs, venue, publication year, and source).
- `PaperRecord` wraps `PaperMetadata` plus raw text and the original source payload.
- `PaperIdentifier` is a small helper model used when ingesting by DOI/arXiv.
- Canonical ID logic is provided by `canonical_paper_id()`, which:
  1. uses normalized DOI if present,
  2. otherwise uses normalized arXiv ID,
  3. otherwise uses a stable hash of a fallback (title).

This ensures every paper has a stable `paper_id` used across storage backends.

#### Metadata Sources (`src/paperatlas/concepts/extraction/sources.py`)
One lightweight client calls external APIs using `httpx`:
- `ArxivClient` fetches by arXiv ID or search query. It parses the Atom feed and
  normalizes arXiv IDs, including URLs.

Each client returns a `PaperMetadata` object that the pipeline can use directly.

#### PDF Parsing (`src/paperatlas/concepts/extraction/pdf_parser.py`)
`PdfParser` supports two strategies:
- `pymupdf` for local PDF parsing (optional dependency: `pymupdf`).
- `grobid` for server-based parsing via GROBID's TEI output.

The parser can run in `auto` mode, trying PyMuPDF first and falling back to GROBID
if PyMuPDF is unavailable.

#### Storage (`src/paperatlas/concepts/extraction/storage.py`)
Two storage backends are provided:
- `JsonPaperStore` stores each paper as a JSON file in `data/papers/`, using a
  filename-safe version of the canonical paper ID.
- `MySQLPaperStore` stores each paper in a `papers` table with JSON metadata
  and raw text. This backend is optional and only used if MySQL credentials are
  available.

Both backends rely on the same `PaperRecord` schema for consistent data output.

#### Ingestion Pipeline (`src/paperatlas/concepts/extraction/pipeline.py`)
`IngestionPipeline` coordinates metadata fetching, PDF parsing, storage, and graph
writing.

Key flows:
- `ingest_identifiers()` accepts a list of `PaperIdentifier` and fetches metadata
  from arXiv.
- `ingest_query()` searches arXiv and ingests results.
- For each paper, the pipeline:
  1. downloads the PDF (if a URL is available),
  2. parses it into raw text,
  3. saves it to JSON (and optionally MySQL),
  4. upserts a Neo4j Paper node (if a Neo4j client is provided).

#### CLI Entry Point (`src/paperatlas/concepts/extraction/ingest.py`)
Provides a small CLI for local ingestion:
- `--doi` or `--arxiv` to ingest by ID.
- `--query` to ingest by search query.

This is intended to run locally for small batches and quick validation.

#### Graph Storage (`src/paperatlas/graph/`)
- `neo4j_client.py` adds a minimal wrapper for Neo4j sessions.
- `schema.py` defines a unique constraint for `Paper.paper_id`.
- `builders/paper_graph.py` writes/updates a `Paper` node with core properties
  from `PaperMetadata` (title, abstract, year, IDs, URLs, and source).

### How It Fits Together

1. A caller builds identifiers or a query.
2. `IngestionPipeline` fetches metadata from the external sources.
3. The PDF is downloaded and parsed (if available).
4. The paper is stored in JSON (and optionally MySQL).
5. The paper is upserted into Neo4j as a `Paper` node.

This provides a minimal but complete ingestion loop that can be extended with
concept extraction and embeddings in later phases.
