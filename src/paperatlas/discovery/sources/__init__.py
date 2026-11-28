from __future__ import annotations

from typing import Iterable

from .arxiv import ArxivSource
from .base import HttpSource, Source
from .hf_papers import HuggingFacePapersSource
from .openalex import OpenAlexSource
from .patents import UsptoPatentSource
from .semantic_scholar import SemanticScholarSource

SOURCE_TYPES: dict[str, type[HttpSource]] = {
    "arxiv": ArxivSource,
    "semantic_scholar": SemanticScholarSource,
    "openalex": OpenAlexSource,
    "hf_papers": HuggingFacePapersSource,
    "patents": UsptoPatentSource,
}
# `source` values of the engineering items a project's `upstream` brings in (discovery/upstream.py); they are not
# searched per topic query like the sources above.
ENGINEERING_SOURCES = ("github_pr", "github_release", "engineering_blog")


def build_sources(names: Iterable[str]) -> list[Source]:
    unknown = set(names) - set(SOURCE_TYPES)
    if unknown:
        raise ValueError(f"Unknown sources: {sorted(unknown)}; choose from {sorted(SOURCE_TYPES)}")
    return [SOURCE_TYPES[name]() for name in names]


__all__ = ["ENGINEERING_SOURCES", "SOURCE_TYPES", "Source", "build_sources"]
