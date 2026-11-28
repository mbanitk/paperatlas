from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

import yaml
from pydantic import BaseModel, Field, field_validator

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


class EngineeringSettings(BaseModel):
    """Engineering sources: merged pull requests, release notes and blogs of the projects a target builds on.

    Which repositories and feeds is up to each target project (`upstream` in its lab.yaml); these settings decide
    how far back to look, what counts as a performance change (no LLM) and how many items are distilled per scan.
    """

    initial_lookback_days: int = Field(default=14, ge=1)
    max_pages: int = Field(default=5, ge=1)
    max_age_days: int = Field(default=60, ge=1)
    per_run: int = Field(default=8, ge=0)
    min_score: float = 4.0
    release_lines: int = Field(default=40, ge=1)
    perf_tags: list[str] = Field(
        default_factory=lambda: ["perf", "performance", "optimization", "optimisation", "speedup", "speed"]
    )
    noise_tags: list[str] = Field(
        default_factory=lambda: [
            "ci", "ci/build", "ci / packaging", "build", "doc", "docs", "documentation", "test", "tests", "testing",
            "chore", "misc", "refactor", "style", "lint", "format", "dependencies", "deps", "github_actions",
            "release", "revert", "typo", "governance", "security", "recipe", "examples", "devops", "nix",
            "new model", "new-model", "new_model", "model", "frontend", "ui", "server/ui", "server/webui",
            "tool calling", "tool-calling", "parser", "chat parser", "jinja parser", "benchmark", "benchmarks", "bench",
        ]  # fmt: skip
    )
    fix_tags: list[str] = Field(default_factory=lambda: ["fix", "bugfix", "bug", "hotfix", "bug-unconfirmed"])
    improvement_words: list[str] = Field(
        default_factory=lambda: [
            "faster", "speed up", "speeds up", "speedup", "speed-up", "optimize", "optimise", "optimized", "optimised",
            "optimization", "optimisation", "accelerate", "reduce", "reduces", "lower", "improve", "improves",
            "fuse", "fused", "fusion", "avoid", "efficient", "overlap", "vectorize", "vectorized", "tune", "tuned",
            "cheaper", "less memory", "fewer",
        ]  # fmt: skip
    )
    metric_words: list[str] = Field(
        default_factory=lambda: [
            "throughput", "latency", "ttft", "tpot", "itl", "tok/s", "tokens/s", "tokens per second", "memory usage",
            "peak memory", "memory footprint", "bandwidth", "overhead", "performance", "perf",
        ]  # fmt: skip
    )
    topic_words: list[str] = Field(
        default_factory=lambda: [
            "kernel", "kernels", "attention", "sdpa", "flash attention", "flash-attention", "flashattention",
            "prefill", "decode", "decoding", "kv cache", "kv-cache", "prefix cache", "prompt cache", "cache", "batch",
            "batching", "batched", "scheduler", "scheduling", "quantize", "quantized", "quantization", "int4", "int8",
            "fp8", "fp4", "nvfp4", "mxfp4", "speculative", "spec decode", "draft", "mtp", "eagle", "lookahead", "gemm",
            "matmul", "gemv", "mma", "split-k", "moe", "sampling", "sampler", "memory", "compile", "graph", "async",
            "pipeline", "chunked", "paged", "offload", "offloading", "ngram", "n-gram",
        ]  # fmt: skip
    )


class UpstreamRepo(BaseModel):
    repo: str = Field(pattern=r"^[\w.-]+/[\w.-]+$")
    pulls: bool = True
    releases: bool = True
    prereleases: bool = False


class UpstreamFeed(BaseModel):
    name: str
    url: str = Field(pattern=r"^https?://")


class Upstream(BaseModel):
    """A target project's `upstream` section in lab.yaml: the repositories and blogs its stack is built on.

    `exclude` drops items about hardware or backends the project doesn't run (matched in title tags, titles and
    labels, e.g. CUDA); `include` keeps them anyway when they also mention one of its terms (e.g. Metal).
    """

    github: list[UpstreamRepo] = Field(default_factory=list)
    feeds: list[UpstreamFeed] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)
    include: list[str] = Field(default_factory=list)

    @field_validator("github", mode="before")
    @classmethod
    def _repo_strings(cls, value: Any) -> Any:
        return [{"repo": item} if isinstance(item, str) else item for item in value or []]

    def venues(self) -> list[str]:
        return [item.repo for item in self.github] + [feed.name for feed in self.feeds]


class R2EConfig(BaseModel):
    seeds: list[Seed]
    sources: list[str] = Field(default_factory=lambda: ["arxiv"])
    topics: TopicSettings = Field(default_factory=TopicSettings)
    ranking: RankingSettings = Field(default_factory=RankingSettings)
    engineering: EngineeringSettings = Field(default_factory=EngineeringSettings)

    def seed(self, name: str) -> Optional[Seed]:
        return next((seed for seed in self.seeds if seed.name == name), None)


@lru_cache(maxsize=4)
def load_config(path: Optional[str] = None) -> R2EConfig:
    config_path = Path(path or env("PAPERATLAS_R2E_CONFIG") or DEFAULT_CONFIG)
    return R2EConfig.model_validate(yaml.safe_load(config_path.read_text(encoding="utf-8")))
