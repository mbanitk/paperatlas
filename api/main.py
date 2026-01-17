"""
Compatibility entrypoint for Uvicorn.

Allows running:
  uvicorn api.main:app --reload

even though the actual app is defined in:
  src/paperatlas/api/main.py  (module path: paperatlas.api.main:app)
"""

from __future__ import annotations

import sys
from pathlib import Path


def _ensure_src_on_path() -> None:
    # When running from the repo root without installing the package, `src/` is
    # not on `sys.path`, so `import paperatlas` would fail. Add it defensively.
    repo_root = Path(__file__).resolve().parent.parent
    src_dir = repo_root / "src"
    src_str = str(src_dir)
    if src_dir.exists() and src_str not in sys.path:
        sys.path.insert(0, src_str)


_ensure_src_on_path()

# Re-export FastAPI app for Uvicorn.
from paperatlas.api.main import app  # noqa: E402

