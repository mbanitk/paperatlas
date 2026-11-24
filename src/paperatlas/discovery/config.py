from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, Field

from paperatlas.settings import env

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config" / "r2e.yaml"


class Seed(BaseModel):
    name: str
    queries: list[str]
    needs_gpu_cluster: bool = False


class TopicSettings(BaseModel):
    count: int = 10
    lookback_days: int = 180
    per_query: int = 20
    min_cluster_size: int = 3
    max_per_seed: int = 2


class RankingSettings(BaseModel):
    per_topic: int = 5
    half_life_days: float = Field(default=90, gt=0, allow_inf_nan=False)
    weights: dict[str, float] = Field(
        default_factory=lambda: {
            "relevance": 0.35,
            "recency": 0.25,
            "citations": 0.15,
            "upvotes": 0.10,
            "code": 0.10,
            "patent": 0.05,
        }
    )


class R2EConfig(BaseModel):
    seeds: list[Seed]
    sources: list[str] = Field(default_factory=lambda: ["arxiv"])
    topics: TopicSettings = Field(default_factory=TopicSettings)
    ranking: RankingSettings = Field(default_factory=RankingSettings)

    def seed(self, name: str) -> Optional[Seed]:
        return next((seed for seed in self.seeds if seed.name == name), None)


@lru_cache(maxsize=4)
def load_config(path: Optional[str] = None) -> R2EConfig:
    config_path = Path(path or env("PAPERATLAS_R2E_CONFIG") or DEFAULT_CONFIG)
    return R2EConfig.model_validate(yaml.safe_load(config_path.read_text(encoding="utf-8")))
