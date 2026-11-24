from .models import PaperAuthor, PaperIdentifier, PaperMetadata, PaperRecord
from .sources import ArxivClient

__all__ = [
    "ArxivClient",
    "IngestionPipeline",
    "PaperAuthor",
    "PaperIdentifier",
    "PaperMetadata",
    "PaperRecord",
]


def __getattr__(name: str):
    if name == "IngestionPipeline":
        from .pipeline import IngestionPipeline

        return IngestionPipeline
    raise AttributeError(name)
