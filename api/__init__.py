"""
Compatibility package.

This repo's FastAPI app lives under `paperatlas.api`, but some docs/commands refer to
`api.main:app`. Keeping a tiny top-level `api` package avoids import errors when
running Uvicorn from the repo root.
"""

