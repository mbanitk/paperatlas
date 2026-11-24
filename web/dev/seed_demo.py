"""Load realistic demo fixtures for the PaperAtlas web console.

    PAPERATLAS_DATABASE_URL=postgresql+psycopg://localhost/paperatlas_ui \
        .venv/bin/python web/dev/seed_demo.py

Run from the repository root (report/log artifacts go to `$PAPERATLAS_DATA_DIR/r2e/experiments/<id>/`,
default `data/`). The script WIPES every `research.*` and `lab.*` table first, so it refuses to run
unless the database name ends with `_ui` (or `--force` is given). It never starts a worker, never
touches a real repository and needs no LLM key.
"""

from __future__ import annotations

import argparse
import os
import random
import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from seed_concept_maps import EXTRA_CONCEPTS, apply_concept_maps  # noqa: E402
import seed_protocol  # noqa: E402
from seed_explainers import BACKGROUND_PAPERS, CLAIM_EXPLAINERS, PAPER_EXPLAINERS, TOPIC_EXPLAINERS  # noqa: E402

MARKER = ".seed_demo"
NOW = datetime.now(UTC).replace(microsecond=0)


def ago(minutes: float = 0, hours: float = 0, days: float = 0) -> datetime:
    return NOW - timedelta(minutes=minutes, hours=hours, days=days)


def stamp(explainer: dict[str, Any], minutes: float = 0, hours: float = 0) -> dict[str, Any]:
    """Explainer fixture with the metadata the LLM pipeline adds."""
    return {**explainer, "generated_at": ago(minutes=minutes, hours=hours).isoformat(), "model": "gpt-5.2"}


# ---- target project ------------------------------------------------------------------

PROFILE: dict[str, Any] = {
    "name": "inference-lab",
    "description": "Single-node LLM inference server for Apple silicon (PyTorch MPS) with decoding, caching and "
    "scheduling techniques behind feature flags, plus an A/B benchmark harness.",
    "repo_kind": "llm-inference-server",
    "hardware": {
        "chip": "Apple M5 Pro",
        "memory_gb": 64,
        "accelerator": "mps",
        "cuda": False,
        "multi_gpu": False,
    },
    "models": {
        "smoke": {"id": "Qwen/Qwen3-0.6B", "dtype": "bfloat16"},
        "eval": {"id": "Qwen/Qwen3-30B-A3B-Instruct-2507", "dtype": "bfloat16"},
    },
    "metrics": [
        {"name": "ttft_ms", "direction": "lower_is_better", "unit": "ms", "description": "Time to first token"},
        {"name": "itl_ms", "direction": "lower_is_better", "unit": "ms", "description": "Median inter-token latency"},
        {"name": "decode_tokens_per_s", "direction": "higher_is_better", "unit": "tok/s", "description": "Single-stream decode speed"},
        {"name": "e2e_latency_ms", "direction": "lower_is_better", "unit": "ms", "description": "Request end-to-end latency"},
        {"name": "throughput_tokens_per_s", "direction": "higher_is_better", "unit": "tok/s", "description": "Aggregate output tokens/s across concurrent requests"},
        {"name": "peak_memory_gb", "direction": "lower_is_better", "unit": "GB", "description": "Peak MPS driver memory"},
    ],
    "workloads": [
        {"name": "short_chat", "description": "Multi-turn chat, 200–600 token prompts, 256 new tokens, 1 stream"},
        {"name": "long_prompt", "description": "8k-token document prompts (summarise / extract), 512 new tokens, 1 stream"},
        {"name": "concurrent_4", "description": "4 concurrent chat streams with mixed 1k–6k prompts"},
    ],
    "extension_points": [
        {"name": "decode_step", "description": "Replace or wrap the per-step decode (speculative / lookahead decoders)"},
        {"name": "kv_cache", "description": "Pluggable KV cache implementation (paged, quantized, prefix-shared)"},
        {"name": "scheduler", "description": "Iteration-level request scheduler (batching, chunked prefill)"},
        {"name": "attention", "description": "Attention backend selection (SDPA, custom Metal kernels)"},
        {"name": "model_loader", "description": "Load-time transforms such as weight quantization"},
    ],
    "commands": {
        "install": "uv sync --frozen",
        "test": "uv run pytest -q",
        "list_flags": "uv run python -m inference_lab.techniques --json",
        "bench_ab": "uv run python -m inference_lab.bench ab --model {model} --flags {flags} "
        "--workload {workload} --rounds {rounds} --warmup {warmup} --out {out}",
    },
    "constraints": [
        "Apple silicon only — no CUDA, Triton or NCCL",
        "Single device: no tensor or pipeline parallelism",
        "No retraining or fine-tuning of the served models",
        "Every technique ships behind a flag that is OFF by default",
        "Greedy outputs must stay identical for lossless techniques",
    ],
    "techniques": [
        {"name": "paged_kv", "description": "Paged KV cache with 16-token blocks", "requires_reload": False, "hooks": ["kv_cache"]},
        {"name": "speculative_draft", "description": "Draft-model speculative decoding (Qwen3-0.6B drafter)", "requires_reload": True, "hooks": ["decode_step"]},
        {"name": "sdpa_fused", "description": "Fused scaled-dot-product attention on MPS", "requires_reload": False, "hooks": ["attention"]},
    ],
    "repo": {
        "path": "/nonexistent/demo/inference-lab",
        "branch": "main",
        "sha": "4f6c2d1e9a0b7c3d5e8f1a2b3c4d5e6f7a8b9c0d",
        "remote": None,
        "readme_excerpt": "inference-lab — a small, hackable LLM inference server for Apple silicon.",
    },
}


# Engine roofline (`commands.profile`, lab/profiler.measure_roofline): the PyTorch MPS engine decodes at ~26% of the
# memory-bandwidth limit (overhead-bound) and a 0.6B draft token costs about half a 30B step.
ROOFLINE: dict[str, Any] = {
    "kind": "profile",
    "model": {"profile": "eval", "id": "Qwen/Qwen3-30B-A3B-Instruct-2507", "quantization": "4-bit (group 64)",
              "active_params_b": 3.3, "total_params_b": 30.5, "bytes_per_token_gb": 3.3},
    "hardware": {"chip": "Apple M5 Pro", "peak_bandwidth_gbs": 307, "memory_gb": 64},
    "decode": {"tokens_per_s": 24.1, "ms_per_token": 41.5, "achieved_bandwidth_gbs": 79.5, "bandwidth_utilization": 0.26},
    "forward_cost_ms": {"1": 41.5, "2": 42.9, "4": 45.8, "8": 52.6, "16": 66.4},
    "batch_decode_tokens_per_s": {"1": 24.1, "2": 43.6, "4": 74.9, "8": 112.3},
    "prefill_tokens_per_s": 612.0,
    "draft": {"profile": "smoke", "id": "Qwen/Qwen3-0.6B", "ms_per_token": 19.8},
    "environment": {"chip": "Apple M5 Pro", "macos": "26.1", "python": "3.12.8", "torch": "2.9.1", "engine": "pytorch-mps",
                    "on_ac_power": True, "thermal_warning": False},
}


# ---- topics ----------------------------------------------------------------------------

# slug, name, seed area, needs GPU cluster, description, keywords, trend score, cluster size
TOPICS = [
    ("speculative-decoding-dynamic-drafts", "Speculative decoding with dynamic drafts", "Speculative decoding", False,
     "Lossless decoding speed-ups from draft trees, model-free drafts and adaptive speculation length.",
     ["speculative decoding", "draft tree", "lookahead", "acceptance rate"], 0.912, 31),
    ("kv-cache-quantization-eviction", "KV-cache quantization & eviction", "KV-cache management & compression", False,
     "Shrinking the KV cache with low-bit quantization and attention-guided eviction.",
     ["kv cache", "2-bit", "eviction", "heavy hitter"], 0.874, 27),
    ("chunked-prefill-scheduling", "Chunked prefill & stall-free batching", "Batching & scheduling", False,
     "Iteration-level scheduling that mixes prefill chunks with decodes to protect inter-token latency.",
     ["chunked prefill", "continuous batching", "SLO", "goodput"], 0.801, 22),
    ("low-bit-weight-quantization", "Low-bit weight quantization for unified memory", "Quantization", False,
     "Activation-aware 4-bit weights and MoE offloading for memory-bound Apple silicon / edge devices.",
     ["int4", "AWQ", "unified memory", "calibration"], 0.766, 24),
    ("prefix-caching-multi-turn", "Prefix caching for multi-turn chat", "LLM inference engineering", False,
     "Re-using KV for shared prompt prefixes across turns and requests.",
     ["prefix cache", "radix tree", "multi-turn", "TTFT"], 0.731, 18),
    ("long-context-decode-kernels", "Long-context decode attention kernels", "LLM inference engineering", False,
     "Split-K / flash-decoding style kernels that keep the GPU busy at batch 1 with long contexts.",
     ["flash decoding", "split-k", "Metal", "long context"], 0.688, 15),
    ("disaggregated-prefill-decode", "Disaggregated prefill/decode serving", "Disaggregated prefill/decode & KV transfer", True,
     "Separate prefill and decode GPU pools with fast KV transfer between them.",
     ["disaggregation", "RDMA", "KV transfer", "GPUDirect"], 0.652, 19),
    ("token-level-serving-telemetry", "Token-level serving telemetry", "LLM observability", False,
     "Per-token tracing and SLO attainment metrics for LLM serving.",
     ["OpenTelemetry", "TBT", "SLO attainment", "tracing"], 0.597, 12),
]


# ---- papers, concepts and claim cards -----------------------------------------------------


def effect(metric: str, value: Optional[float], unit: Optional[str], direction: str, baseline: str = "", conditions: str = "") -> dict:
    return {"metric": metric, "value": value, "unit": unit, "direction": direction, "baseline": baseline or None, "conditions": conditions or None}


def setup(hardware: str, model: str, framework: str, batch: str, seq: str, dataset: str) -> dict:
    return {"hardware": hardware, "model": model, "framework": framework, "batch_size": batch, "sequence_length": seq, "dataset": dataset}


PAPERS: list[dict[str, Any]] = [
    {
        "paper_id": "arxiv:2609.01432",
        "title": "EAGLE-4: Dynamic Draft Trees for Lossless Speculative Decoding",
        "abstract": "Speculative decoding accelerates autoregressive generation by drafting several tokens and verifying them in a single "
        "forward pass of the target model. Static draft trees waste verification compute on easy contexts and under-speculate on "
        "hard ones. We present EAGLE-4, which grows the draft tree per step from the drafter's cumulative confidence and prunes "
        "low-probability branches before verification. EAGLE-4 raises the average acceptance length from 3.62 to 4.71 tokens and "
        "delivers a 1.38x speed-up over EAGLE-2 with identical greedy outputs across MT-Bench, HumanEval and GSM8K.",
        "venue": "arXiv", "sources": ["arxiv", "semantic_scholar", "hf_papers"], "date": date(2026, 9, 3), "citations": 14, "upvotes": 212,
        "code_url": "https://github.com/example/eagle4",
        "authors": [{"name": "Y. Li"}, {"name": "F. Wei"}, {"name": "C. Zhang"}, {"name": "H. Zhang"}],
        "topics": [("speculative-decoding-dynamic-drafts", 1, 0.93)],
        "concepts": [
            {
                "key": "c_dyn_tree", "name": "Confidence-pruned dynamic draft tree", "kind": "method",
                "summary": "Grow the speculative draft tree each step from the drafter's cumulative log-probabilities and prune weak branches so verification compute follows context difficulty.",
                "key_points": ["Top-k expansion per depth guided by cumulative draft confidence", "Tree attention mask rebuilt per step", "Outputs identical to greedy baseline (lossless)"],
                "card": {
                    "testable": True, "category": "speculative_decoding",
                    "technique": "Expand the draft tree per decoding step using the draft model's cumulative token confidence, pruning branches below a threshold, then verify the whole tree in one target forward pass.",
                    "change_required": "Replace the fixed-shape draft tree in the speculative decoder with per-step top-k expansion guided by draft log-probs and build the tree attention mask dynamically for the verify pass.",
                    "effects": [effect("decode throughput (tokens/s)", 1.38, "x", "increase", "EAGLE-2 static tree", "Vicuna-13B, MT-Bench, batch 1")],
                    "paper_setup": setup("1x NVIDIA H100 80GB", "Vicuna-13B, LLaMA-3.1-8B", "PyTorch", "1", "<= 2k", "MT-Bench, HumanEval, GSM8K"),
                    "prerequisites": ["Existing draft-model speculative decoding path", "Tree attention mask support in the verify step"],
                    "effort": "medium",
                    "risks": ["Mask construction overhead can dominate on small models", "Smaller gains on GPUs with a lower compute/bandwidth ratio"],
                    "evidence": {"quote": "Dynamic draft trees raise the average acceptance length from 3.62 to 4.71 tokens, yielding a 1.38x speedup over EAGLE-2 on MT-Bench at batch size 1 with identical outputs.", "location": "Section 5.2, Table 3"},
                },
                "match": {"similarity": 0.62, "target_metric": "decode_tokens_per_s",
                          "rationale": "inference-lab already ships a draft-model speculative decoder (speculative_draft), so dynamic tree expansion slots into the decode_step hook; batch-1 decode on MPS is bandwidth-bound, which is where longer accepted runs pay off."},
            },
            {
                "key": "c_feature_head", "name": "Feature-level draft head", "kind": "method",
                "summary": "Draft tokens with a small autoregressive head trained on the target model's second-to-top-layer features instead of a separate draft model.",
                "key_points": ["Single decoder layer head", "Trained on ShareGPT for 2 epochs", "Feature uncertainty handled with shifted tokens"],
                "card": {
                    "testable": True, "category": "speculative_decoding",
                    "technique": "Train a one-layer autoregressive draft head on the target model's penultimate hidden states and use it as the drafter.",
                    "change_required": "Train and ship a draft head per served model; wire it into the speculative decoder as a drafter.",
                    "effects": [effect("speedup vs vanilla decoding", 3.05, "x", "increase", "autoregressive decoding", "LLaMA-3.1-8B, MT-Bench")],
                    "paper_setup": setup("8x NVIDIA H100 (training), 1x H100 (inference)", "LLaMA-3.1-8B", "PyTorch", "1", "<= 2k", "ShareGPT (training), MT-Bench"),
                    "prerequisites": ["Training pipeline and GPU time for the head"],
                    "requires_training": True, "effort": "high",
                    "risks": ["Head must be retrained for every model revision"],
                    "evidence": {"quote": "With a single trained decoder layer as the drafter, EAGLE-4 reaches 3.05x over vanilla decoding.", "location": "Table 2"},
                },
                "match": {"similarity": 0.55, "target_metric": "decode_tokens_per_s", "rationale": None},
            },
            {
                "key": "c_tree_kernel", "name": "Fused tree-verification attention kernel", "kind": "system",
                "summary": "A Triton kernel that fuses tree-mask construction with attention during the verification pass.",
                "key_points": ["Avoids materialising the dense tree mask", "Written in Triton for Hopper"],
                "card": {
                    "testable": True, "category": "attention_kernels",
                    "technique": "Fuse tree-mask generation into a Triton attention kernel for the verify pass.",
                    "change_required": "Add a custom Triton attention kernel for tree verification.",
                    "effects": [effect("verification latency", 41, "%", "decrease", "PyTorch SDPA with dense mask", "tree of 64 nodes")],
                    "paper_setup": setup("1x NVIDIA H100 80GB", "Vicuna-13B", "Triton", "1", "2k", "MT-Bench"),
                    "prerequisites": ["Triton / CUDA toolchain"],
                    "requires_cuda": True, "effort": "high",
                    "risks": ["No Triton backend for Metal"],
                    "evidence": {"quote": "Our fused kernel reduces verification latency by 41% relative to SDPA with a dense mask.", "location": "Section 4.3"},
                },
                "match": {"similarity": 0.41, "target_metric": "itl_ms", "rationale": None},
            },
        ],
    },
    {
        "paper_id": "arxiv:2608.11873",
        "title": "Prompt Lookup Decoding Revisited: Model-Free Drafts for Input-Grounded Generation",
        "abstract": "Many production workloads — summarisation, retrieval-augmented QA, code editing — copy long spans from the prompt. "
        "We revisit prompt lookup decoding, which drafts tokens by matching the latest n-gram against the prompt and copying its "
        "continuation, and verify drafts with the target model in a single pass. With adaptive n-gram fallback and acceptance-aware "
        "draft caps, prompt lookup delivers 45% higher decode throughput on input-grounded tasks without any draft model and with "
        "bit-identical greedy outputs.",
        "venue": "arXiv", "sources": ["arxiv", "hf_papers"], "date": date(2026, 8, 19), "citations": 9, "upvotes": 164,
        "code_url": "https://github.com/example/prompt-lookup-revisited",
        "authors": [{"name": "A. Saxena"}, {"name": "R. Gupta"}, {"name": "M. Chen"}],
        "topics": [("speculative-decoding-dynamic-drafts", 2, 0.88)],
        "concepts": [
            {
                "key": "c_prompt_lookup", "name": "Prompt lookup n-gram drafting", "kind": "method",
                "summary": "Draft the next tokens by finding the most recent n-gram match in the prompt and copying its continuation; verify drafts in one target forward pass.",
                "key_points": ["No draft model or extra weights", "n-gram match against prompt token ids (n=3 → 1 fallback)", "Up to k=10 drafted tokens per step", "Lossless under greedy verification"],
                "card": {
                    "testable": True, "category": "speculative_decoding",
                    "technique": "Draft up to k tokens per step by matching the last n generated tokens against the prompt and copying the continuation; verify all drafts in one forward pass of the target model.",
                    "change_required": "Add a draft provider that searches prompt token ids for the most recent n-gram match (n=3 with fallback to 1) and proposes up to 10 tokens to the existing verify step; no draft model needed.",
                    "effects": [
                        effect("decode throughput on input-grounded tasks (tokens/s)", 45, "%", "increase", "greedy autoregressive decoding", "summarisation and RAG QA, greedy"),
                        effect("time to first token", 0, "%", "none", "", "prefill unchanged"),
                    ],
                    "paper_setup": setup("1x NVIDIA A100 40GB", "Mistral-7B-Instruct-v0.3", "HF transformers", "1", "2k–8k prompt", "CNN/DailyMail, NaturalQuestions-RAG, CodeEditorBench"),
                    "prerequisites": ["Batched verification of multiple draft tokens"],
                    "effort": "low",
                    "risks": ["Little or no gain on open-ended chat where outputs do not copy the prompt"],
                    "evidence": {"quote": "On input-grounded tasks prompt lookup improves decode throughput by 45% on average while producing bit-identical greedy outputs.", "location": "Section 4, Figure 2"},
                },
                "match": {"similarity": 0.66, "target_metric": "decode_tokens_per_s",
                          "rationale": "A pure decode_step change with no extra weights — cheap to implement on MPS and directly measurable on the long_prompt workload, which copies heavily from its 8k-token documents."},
            },
            {
                "key": "c_adaptive_ngram", "name": "Adaptive n-gram length with acceptance-aware caps", "kind": "algorithm",
                "summary": "Start matching with long n-grams, fall back to shorter ones only when needed, and cap the draft length by the recent acceptance rate.",
                "key_points": ["n = 4 → 1 fallback", "Draft cap from EMA of accepted length"],
                "card": {
                    "testable": True, "category": "speculative_decoding",
                    "technique": "Match the longest n-gram first (n=4) and cap draft length by an EMA of recent accepted lengths to avoid wasted verification.",
                    "change_required": "Extend the n-gram draft provider with fallback matching and an acceptance-rate EMA that bounds k between 2 and 10.",
                    "effects": [effect("mean accepted tokens per step", 12, "%", "increase", "fixed n=3, k=10", "summarisation")],
                    "paper_setup": setup("1x NVIDIA A100 40GB", "Mistral-7B-Instruct-v0.3", "HF transformers", "1", "2k–8k prompt", "CNN/DailyMail"),
                    "prerequisites": ["Prompt lookup drafting"], "effort": "low",
                    "risks": ["Needs prompt lookup first; incremental gain only"],
                    "evidence": {"quote": "Adaptive n-gram length increases the mean accepted length by 12% over the fixed n=3 configuration.", "location": "Table 4"},
                },
                "match": {"similarity": 0.58, "target_metric": "decode_tokens_per_s",
                          "rationale": "Incremental refinement of prompt lookup; best tested after the base technique is merged."},
            },
        ],
    },
    {
        "paper_id": "arxiv:2610.04521",
        "title": "KIVI-2: Tuning-Free Asymmetric 2-bit KV Cache Quantization",
        "abstract": "The KV cache dominates memory for long contexts and large batches. KIVI-2 quantizes keys per channel and values per "
        "token to 2 bits with small groups, keeping a short residual window in full precision. Without any fine-tuning, KIVI-2 "
        "cuts KV memory by 2.6x and enables up to 3.47x higher batch throughput on Llama-2 and Mistral with negligible accuracy loss.",
        "venue": "arXiv", "sources": ["arxiv", "semantic_scholar", "openalex"], "date": date(2026, 10, 7), "citations": 6, "upvotes": 131,
        "code_url": "https://github.com/example/kivi2",
        "authors": [{"name": "Z. Liu"}, {"name": "J. Yuan"}, {"name": "V. Braverman"}],
        "topics": [("kv-cache-quantization-eviction", 1, 0.9)],
        "concepts": [
            {
                "key": "c_kivi", "name": "Asymmetric 2-bit KV quantization (per-channel K, per-token V)", "kind": "method",
                "summary": "Quantize keys per channel and values per token to 2 bits with group size 32, keeping the most recent 128 tokens in fp16.",
                "key_points": ["Per-channel keys absorb outlier channels", "Per-token values bound attention output error", "fp16 residual window for recent tokens", "Tuning-free"],
                "card": {
                    "testable": True, "category": "kv_cache",
                    "technique": "Quantize keys per channel and values per token to 2 bits (group size 32) with an fp16 residual window of the last 128 tokens; dequantize on the fly inside attention.",
                    "change_required": "Add a quantized KV cache class that packs K per-channel and V per-token to int2 with fp16 scale/zero per group, dequantizes in the attention path and keeps the last R=128 tokens unquantized.",
                    "effects": [
                        effect("peak KV cache memory", 2.6, "x", "decrease", "fp16 KV cache", "Llama-2-13B, 4k context"),
                        effect("batch decode throughput", 3.47, "x", "increase", "fp16 KV cache at max batch", "batch up to 128"),
                    ],
                    "paper_setup": setup("1x NVIDIA A100 80GB", "Llama-2-13B, Mistral-7B", "PyTorch + Triton", "up to 128", "4k", "LongBench, GSM8K"),
                    "prerequisites": ["Pluggable KV cache implementation"], "effort": "medium",
                    "risks": ["Dequantization cost may erase speed-ups at batch 1 on MPS", "Accuracy drop on long-context retrieval"],
                    "evidence": {"quote": "KIVI-2 reduces peak KV cache memory by 2.6x and enables up to 3.47x throughput by fitting larger batches, with less than 0.3 points average accuracy loss.", "location": "Abstract; Table 5"},
                },
                "match": {"similarity": 0.64, "target_metric": "peak_memory_gb",
                          "rationale": "The kv_cache extension point already supports alternative cache classes; on 64 GB unified memory the memory win is directly measurable, though the throughput claim depends on large batches the project does not run."},
            },
            {
                "key": "c_kivi_kernel", "name": "Fused int2 dequantize-attention kernel", "kind": "system",
                "summary": "A Triton kernel that fuses int2 unpacking and dequantization with the attention matmul.",
                "key_points": ["Avoids materialising fp16 K/V", "Triton, Ampere/Hopper only"],
                "card": {
                    "testable": True, "category": "attention_kernels",
                    "technique": "Fuse int2 KV unpacking with QK^T and PV matmuls in a Triton kernel.",
                    "change_required": "Write a fused Triton kernel for quantized attention.",
                    "effects": [effect("attention latency at 4k context", 37, "%", "decrease", "dequantize-then-SDPA", "batch 32")],
                    "paper_setup": setup("1x NVIDIA A100 80GB", "Llama-2-13B", "Triton", "32", "4k", "synthetic"),
                    "prerequisites": ["Triton / CUDA toolchain"], "requires_cuda": True, "effort": "high",
                    "risks": ["No Metal equivalent"],
                    "evidence": {"quote": "The fused kernel lowers attention latency by 37% compared with dequantizing before SDPA.", "location": "Section 5.4"},
                },
                "match": {"similarity": 0.45, "target_metric": "itl_ms", "rationale": None},
            },
        ],
    },
    {
        "paper_id": "arxiv:2607.09314",
        "title": "H2O-Lite: Heavy-Hitter KV Eviction for Memory-Bound Devices",
        "abstract": "We revisit heavy-hitter oracle (H2O) KV eviction for laptops and edge accelerators with unified memory. H2O-Lite keeps "
        "attention sinks, a recent window and tokens with the highest accumulated attention under a fixed budget. At a 20% KV "
        "budget it reduces KV memory 5x and improves decode throughput by 29% at 8k context with small quality loss.",
        "venue": "arXiv", "sources": ["arxiv", "semantic_scholar"], "date": date(2026, 7, 21), "citations": 22, "upvotes": 97,
        "code_url": None,
        "authors": [{"name": "K. Tan"}, {"name": "L. Ortiz"}],
        "topics": [("kv-cache-quantization-eviction", 2, 0.84)],
        "concepts": [
            {
                "key": "c_h2o", "name": "Heavy-hitter + recent-window KV eviction", "kind": "method",
                "summary": "Keep a fixed per-layer KV budget of attention sinks, recent tokens and heavy hitters ranked by accumulated attention; evict the rest.",
                "key_points": ["20% KV budget", "Accumulated attention score per cached token", "Always retain 4 sink tokens"],
                "card": {
                    "testable": True, "category": "kv_cache",
                    "technique": "Evict KV entries outside a fixed budget composed of attention sinks, a recent window and heavy-hitter tokens ranked by accumulated attention mass.",
                    "change_required": "Track accumulated attention mass per cached token in the attention hook and evict the lowest-scoring tokens once the cache exceeds a 20% budget.",
                    "effects": [
                        effect("KV cache memory", 5, "x", "decrease", "full KV cache", "20% budget, 8k context"),
                        effect("decode throughput", 29, "%", "increase", "full KV cache", "8k context, batch 1"),
                    ],
                    "paper_setup": setup("Apple M2 Max 32GB; NVIDIA RTX A6000", "LLaMA-2-7B, OPT-6.7B", "HF transformers", "1–8", "8k", "LongBench, XSum"),
                    "prerequisites": ["Access to attention probabilities in the attention backend"], "effort": "medium",
                    "risks": ["Approximate: can degrade needle-in-a-haystack retrieval", "Fused SDPA does not expose attention weights"],
                    "evidence": {"quote": "With a 20% budget H2O-Lite cuts KV memory by 5x and lifts decode throughput by 29% at 8k context on an M2 Max.", "location": "Section 6.1"},
                },
                "match": {"similarity": 0.6, "target_metric": "peak_memory_gb",
                          "rationale": "Measured on Apple silicon in the paper; needs attention weights, which means a slower non-fused attention path on MPS — expect the throughput gain to shrink."},
            },
            {
                "key": "c_sinks", "name": "Attention-sink retention", "kind": "finding",
                "summary": "Evicting the first few tokens collapses quality; they act as attention sinks and must always be kept.",
                "key_points": ["First 4 tokens absorb excess attention", "Perplexity explodes without them"],
                "card": {
                    "testable": False, "category": "kv_cache",
                    "technique": "Always retain the first four tokens (attention sinks) when evicting KV entries.",
                    "change_required": "Pin the first 4 KV positions in any eviction policy.",
                    "effects": [effect("perplexity under eviction", None, None, "none", "", "qualitative")],
                    "paper_setup": setup("NVIDIA RTX A6000", "LLaMA-2-7B", "HF transformers", "1", "16k", "PG-19"),
                    "prerequisites": [], "effort": "low", "risks": [],
                    "evidence": {"quote": "Removing the initial tokens from the cache causes perplexity to diverge regardless of budget.", "location": "Figure 4"},
                },
                "match": {"similarity": 0.35, "target_metric": None, "rationale": None},
            },
        ],
    },
    {
        "paper_id": "arxiv:2609.13377",
        "title": "Sarathi-Serve 2: Stall-Free Chunked Prefill for Interactive LLM Serving",
        "abstract": "Long prompt prefills stall ongoing decodes in iteration-level schedulers, inflating tail inter-token latency. "
        "Sarathi-Serve 2 splits prefills into token-budgeted chunks that piggyback on decode iterations and adapts the chunk size "
        "to the remaining latency SLO slack. On mixed chat traces it cuts p99 inter-token latency by 46% and raises goodput by 18%.",
        "venue": "OSDI '26 (to appear)", "sources": ["arxiv", "semantic_scholar", "openalex"], "date": date(2026, 9, 15), "citations": 31, "upvotes": 188,
        "code_url": "https://github.com/example/sarathi-serve-2",
        "authors": [{"name": "A. Agrawal"}, {"name": "N. Kedia"}, {"name": "R. Ramjee"}],
        "topics": [("chunked-prefill-scheduling", 1, 0.92)],
        "concepts": [
            {
                "key": "c_chunked_prefill", "name": "Chunked prefill with decode piggybacking", "kind": "method",
                "summary": "Split long prompt prefills into fixed token-budget chunks and co-schedule them with active decodes so decodes never stall behind a long prefill.",
                "key_points": ["Per-iteration token budget (e.g. 512)", "Prefill chunks batched with decode tokens", "Partial KV carried across chunks"],
                "card": {
                    "testable": True, "category": "batching_scheduling",
                    "technique": "Split prompt prefills into chunks of at most a token budget and batch each chunk with the ongoing decode tokens in the same forward pass.",
                    "change_required": "In the scheduler, cap per-iteration tokens to a budget, slice pending prefills into chunks batched with active decode tokens, and carry partial KV across chunks.",
                    "effects": [
                        effect("p99 inter-token latency under concurrent load", 46, "%", "decrease", "prefill-prioritising vLLM scheduler", "8–64 concurrent requests"),
                        effect("time to first token", 9, "%", "increase", "prefill-prioritising scheduler", "long prompts"),
                    ],
                    "paper_setup": setup("1x NVIDIA A100 80GB", "Mistral-7B, Yi-34B", "vLLM fork", "8–64 concurrent", "2k–16k prompt", "arXiv-Summarization, ShareGPT traces"),
                    "prerequisites": ["Iteration-level scheduler with mixed prefill/decode batches"], "effort": "medium",
                    "risks": ["TTFT grows for long prompts", "Gains depend on concurrency"],
                    "evidence": {"quote": "Stall-free batching with chunked prefills reduces p99 TBT by 46% on mixed traces at the cost of a 9% higher median TTFT.", "location": "Section 7.2, Figure 9"},
                },
                "match": {"similarity": 0.63, "target_metric": "itl_ms",
                          "rationale": "The project's scheduler hook already batches prefill and decode at iteration level; concurrent_4 mixes 1k–6k prompts with chats, the exact pattern that stalls decodes today."},
            },
            {
                "key": "c_slo_chunk", "name": "SLO-slack adaptive chunk size", "kind": "algorithm",
                "summary": "Choose the prefill chunk size every iteration from the remaining inter-token-latency SLO slack instead of a fixed budget.",
                "key_points": ["Larger chunks when decodes have slack", "Smaller chunks near SLO violation"],
                "card": {
                    "testable": True, "category": "batching_scheduling",
                    "technique": "Set each iteration's prefill chunk size from the minimum remaining TBT SLO slack of active decodes.",
                    "change_required": "Track per-request TBT slack in the scheduler and size prefill chunks from it.",
                    "effects": [effect("goodput (requests/s within SLO)", 18, "%", "increase", "fixed 512-token chunks", "ShareGPT trace")],
                    "paper_setup": setup("1x NVIDIA A100 80GB", "Mistral-7B", "vLLM fork", "8–64 concurrent", "2k–16k", "ShareGPT"),
                    "prerequisites": ["Chunked prefill"], "effort": "medium", "risks": ["Requires latency SLO configuration"],
                    "evidence": {"quote": "Adapting chunk size to SLO slack raises goodput by 18% over the best fixed chunk size.", "location": "Section 7.4"},
                },
                "match": {"similarity": 0.52, "target_metric": "throughput_tokens_per_s",
                          "rationale": "Builds on chunked prefill; meaningful only with several concurrent streams, which concurrent_4 provides."},
            },
        ],
    },
    {
        "paper_id": "arxiv:2610.00218",
        "title": "Lookahead Decoding on Unified Memory: Jacobi Iterations Without a Draft Model",
        "abstract": "Lookahead decoding generates n-grams with parallel Jacobi iterations and verifies them in the same forward pass, "
        "removing the need for a draft model. We study it on Apple silicon, where unified memory changes the compute/bandwidth "
        "trade-off, and derive device-specific window sizes. On an M3 Max, lookahead decoding speeds up Llama-3-8B decoding by 1.31x "
        "with identical outputs.",
        "venue": "arXiv", "sources": ["arxiv", "hf_papers"], "date": date(2026, 10, 1), "citations": 3, "upvotes": 143,
        "code_url": "https://github.com/example/lookahead-mlx",
        "authors": [{"name": "Y. Fu"}, {"name": "P. Bailis"}, {"name": "S. Iyer"}],
        "topics": [("speculative-decoding-dynamic-drafts", 3, 0.85)],
        "concepts": [
            {
                "key": "c_lookahead", "name": "Lookahead (Jacobi) decoding with an n-gram pool", "kind": "method",
                "summary": "Run parallel Jacobi iterations over a window of future positions, cache the generated n-grams in a pool and verify candidates in the same forward pass — no draft model.",
                "key_points": ["2D lookahead window (W=5, N=4)", "n-gram pool keyed by first token", "Combined lookahead + verify attention mask", "Lossless"],
                "card": {
                    "testable": True, "category": "speculative_decoding",
                    "technique": "Generate candidate n-grams with parallel Jacobi iterations over a lookahead window, keep them in an n-gram pool and verify matching candidates in the same forward pass as the lookahead branch.",
                    "change_required": "Add a lookahead decoder in the decode_step hook: maintain a 2D lookahead window (W=5, N=4) and an n-gram pool, and build the combined lookahead+verify attention mask per step.",
                    "effects": [effect("decode throughput (tokens/s)", 1.31, "x", "increase", "greedy autoregressive decoding", "Llama-3-8B fp16, batch 1, M3 Max")],
                    "paper_setup": setup("Apple M3 Max 64GB", "Llama-3-8B-Instruct", "MLX", "1", "<= 1k output", "MT-Bench, HumanEval"),
                    "prerequisites": ["Custom attention masks in the decode forward pass"], "effort": "medium",
                    "risks": ["Extra FLOPs per step can hurt on large MoE models", "Mask overhead on MPS SDPA"],
                    "evidence": {"quote": "On an M3 Max, lookahead decoding with W=5, N=4 accelerates Llama-3-8B decoding by 1.31x while producing identical greedy outputs.", "location": "Section 5, Table 2"},
                },
                "match": {"similarity": 0.67, "target_metric": "decode_tokens_per_s",
                          "rationale": "Measured on Apple silicon with no draft model — a decode_step-only change; the main question is whether the effect survives the 30B MoE eval model."},
            },
            {
                "key": "c_lookahead_tuning", "name": "Bandwidth-aware lookahead window sizing", "kind": "finding",
                "summary": "On unified-memory devices smaller lookahead windows (W=3–5) are optimal; size W and N from the measured bandwidth/compute ratio.",
                "key_points": ["Device-specific W,N", "Over-wide windows lose 10% on M-series"],
                "card": {
                    "testable": True, "category": "speculative_decoding",
                    "technique": "Choose the lookahead window W and n-gram size N per device from a short calibration run measuring bandwidth/compute ratio.",
                    "change_required": "Add a calibration step that benchmarks a few (W,N) pairs at startup and picks the fastest.",
                    "effects": [effect("decode throughput vs default window", 9, "%", "increase", "W=15, N=5 default", "M3 Max")],
                    "paper_setup": setup("Apple M3 Max 64GB", "Llama-3-8B-Instruct", "MLX", "1", "<= 1k", "MT-Bench"),
                    "prerequisites": ["Lookahead decoding"], "effort": "low", "risks": ["Calibration adds startup time"],
                    "evidence": {"quote": "Device-tuned windows recover 9% throughput over the default configuration on M3 Max.", "location": "Section 5.3"},
                },
                "match": {"similarity": 0.5, "target_metric": "decode_tokens_per_s",
                          "rationale": "Only meaningful once lookahead decoding exists in the project."},
            },
        ],
    },
    {
        "paper_id": "arxiv:2608.05219",
        "title": "FlashDecoding-Metal: Split-K Attention for Long-Context Decode on Apple GPUs",
        "abstract": "At batch size one, decode attention over long contexts under-utilises the GPU because a single query cannot fill all "
        "threadgroups. We port split-K flash decoding to Metal: the KV sequence is partitioned across threadgroups and partial "
        "softmax results are reduced with log-sum-exp. On an M2 Ultra, decode throughput improves by 24% at 32k context.",
        "venue": "arXiv", "sources": ["arxiv"], "date": date(2026, 8, 6), "citations": 5, "upvotes": 58,
        "code_url": "https://github.com/example/flashdecoding-metal",
        "authors": [{"name": "T. Dao"}, {"name": "D. Haziza"}, {"name": "B. Spector"}],
        "topics": [("long-context-decode-kernels", 1, 0.89)],
        "concepts": [
            {
                "key": "c_split_k", "name": "Split-K flash decoding for long contexts", "kind": "method",
                "summary": "Partition the KV sequence into K splits processed by parallel threadgroups and reduce the partial softmax results with log-sum-exp.",
                "key_points": ["Fills the GPU at batch 1", "Log-sum-exp reduction", "Switch on above ~4k tokens"],
                "card": {
                    "testable": True, "category": "attention_kernels",
                    "technique": "Split the KV sequence across parallel threadgroups for decode attention and merge partial softmax outputs with a log-sum-exp reduction.",
                    "change_required": "Implement a split-K decode attention path for MPS (custom Metal kernel) and switch to it above 4k context.",
                    "effects": [effect("decode throughput at 32k context", 24, "%", "increase", "MPS SDPA", "batch 1, 32k context")],
                    "paper_setup": setup("Apple M2 Ultra 192GB", "Llama-2-7B", "Metal", "1", "32k", "synthetic long-context"),
                    "prerequisites": ["Ability to build and load custom Metal kernels"], "effort": "high",
                    "risks": ["Numerical parity with SDPA", "Kernel build tooling on macOS"],
                    "evidence": {"quote": "Split-K decoding improves decode throughput by 24% at 32k context on M2 Ultra.", "location": "Figure 5"},
                },
                "match": {"similarity": 0.57, "target_metric": "decode_tokens_per_s",
                          "rationale": "Targets exactly the project's hardware class; long_prompt reaches 8k context, so expect a smaller effect than the paper's 32k."},
            },
            {
                "key": "c_split_switch", "name": "Context-length switch-over for split-K", "kind": "finding",
                "summary": "Split-K only pays off above roughly 4k tokens; below that the reduction overhead costs 3–6%.",
                "key_points": ["Crossover near 4k tokens"],
                "card": {
                    "testable": False, "category": "attention_kernels",
                    "technique": "Enable split-K attention only above a context-length threshold.",
                    "change_required": "Dispatch on context length.",
                    "effects": [effect("throughput below 4k context", None, None, "none", "", "qualitative")],
                    "paper_setup": setup("Apple M2 Ultra 192GB", "Llama-2-7B", "Metal", "1", "1k–32k", "synthetic"),
                    "prerequisites": ["Split-K kernel"], "effort": "low", "risks": [],
                    "evidence": {"quote": "Below roughly 4k tokens the reduction overhead outweighs the gain.", "location": "Section 4.2"},
                },
                "match": {"similarity": 0.33, "target_metric": None, "rationale": None},
            },
        ],
    },
    {
        "paper_id": "arxiv:2609.08870",
        "title": "RadixCache: Automatic KV Prefix Sharing for Multi-Turn Chat",
        "abstract": "Multi-turn chat and agent workloads resend long shared prefixes. RadixCache stores KV blocks in a radix tree keyed by "
        "token ids, reuses the longest cached prefix for each request and evicts leaves under an LRU policy. On multi-turn "
        "ShareGPT conversations it reduces time to first token by 52% and lifts throughput 1.2x with cache-aware request ordering.",
        "venue": "arXiv", "sources": ["arxiv", "semantic_scholar", "hf_papers"], "date": date(2026, 9, 11), "citations": 18, "upvotes": 176,
        "code_url": "https://github.com/example/radixcache",
        "authors": [{"name": "L. Zheng"}, {"name": "Y. Sheng"}, {"name": "I. Stoica"}],
        "topics": [("prefix-caching-multi-turn", 1, 0.91)],
        "concepts": [
            {
                "key": "c_radix", "name": "Radix-tree prefix KV cache", "kind": "system",
                "summary": "Keep KV blocks of processed prompts in a radix tree keyed by token ids and reuse the longest cached prefix for new requests; evict leaves by LRU.",
                "key_points": ["Longest-prefix match on token ids", "Prefill only the uncached suffix", "LRU eviction of leaves under a memory cap"],
                "card": {
                    "testable": True, "category": "kv_cache",
                    "technique": "Store KV blocks for processed prompts in a radix tree keyed by token ids and reuse the longest cached prefix for each new request, prefilling only the suffix.",
                    "change_required": "Add a prefix cache in the kv_cache hook: look up the longest matching token prefix, attach its KV blocks, prefill only the suffix, and LRU-evict leaves under a memory cap.",
                    "effects": [
                        effect("time to first token on multi-turn chat", 52, "%", "decrease", "no prefix reuse", "3–12 turn ShareGPT conversations"),
                        effect("throughput with cache-aware ordering", 1.2, "x", "increase", "FCFS", "16 concurrent"),
                    ],
                    "paper_setup": setup("1x NVIDIA A10G 24GB", "Llama-3-8B-Instruct", "SGLang", "1–16", "multi-turn, up to 8k", "ShareGPT multi-turn"),
                    "prerequisites": ["Paged / block-structured KV cache"], "effort": "medium",
                    "risks": ["Extra memory held by cached prefixes"],
                    "evidence": {"quote": "Reusing cached prefixes cuts time to first token by 52% on multi-turn ShareGPT conversations.", "location": "Section 6.2, Figure 7"},
                },
                "match": {"similarity": 0.69, "target_metric": "ttft_ms",
                          "rationale": "paged_kv already provides block-structured KV, so prefix sharing is a natural extension; short_chat is multi-turn and re-sends the conversation each turn."},
            },
            {
                "key": "c_cache_order", "name": "Cache-aware request ordering", "kind": "algorithm",
                "summary": "Reorder queued requests depth-first by their longest shared cached prefix to raise the prefix-cache hit rate.",
                "key_points": ["Depth-first traversal of the radix tree", "Starvation guard"],
                "card": {
                    "testable": True, "category": "batching_scheduling",
                    "technique": "Schedule waiting requests in depth-first order of their longest cached prefix in the radix tree.",
                    "change_required": "Sort the scheduler's waiting queue by cached-prefix length with an age-based starvation guard.",
                    "effects": [effect("throughput with cache-aware ordering", 1.2, "x", "increase", "FCFS", "16 concurrent")],
                    "paper_setup": setup("1x NVIDIA A10G 24GB", "Llama-3-8B-Instruct", "SGLang", "16", "multi-turn", "ShareGPT"),
                    "prerequisites": ["Prefix cache"], "effort": "low", "risks": ["Unfair to requests without shared prefixes"],
                    "evidence": {"quote": "Cache-aware scheduling improves throughput by 1.2x over FCFS at 16 concurrent clients.", "location": "Table 6"},
                },
                "match": {"similarity": 0.56, "target_metric": "throughput_tokens_per_s",
                          "rationale": "Now that the radix prefix cache is merged, ordering is a low-effort follow-up measurable on concurrent_4."},
            },
        ],
    },
    {
        "paper_id": "arxiv:2610.11002",
        "title": "Splitwise-RDMA: Disaggregated Prefill and Decode with GPUDirect KV Transfer",
        "abstract": "We split LLM inference into prefill and decode machine pools and stream KV caches layer by layer over InfiniBand with "
        "GPUDirect RDMA. Overlapping transfer with computation hides 85% of the KV transfer cost and delivers 1.4x more "
        "throughput per dollar at the same latency SLOs on 8xH100 clusters.",
        "venue": "arXiv", "sources": ["arxiv", "openalex"], "date": date(2026, 10, 14), "citations": 4, "upvotes": 77,
        "code_url": None,
        "authors": [{"name": "P. Patel"}, {"name": "E. Choukse"}, {"name": "R. Bianchini"}],
        "topics": [("disaggregated-prefill-decode", 1, 0.9)],
        "concepts": [
            {
                "key": "c_splitwise", "name": "Phase-split prefill/decode pools", "kind": "system",
                "summary": "Serve prefill and decode on separate GPU pools sized independently and transfer KV between them.",
                "key_points": ["Independent scaling of phases", "KV handoff after prefill"],
                "card": {
                    "testable": True, "category": "disaggregated_serving",
                    "technique": "Run prefill and decode on separate GPU pools and hand off the KV cache after prefill.",
                    "change_required": "Split the server into prefill and decode workers on different GPUs with a KV transfer layer.",
                    "effects": [effect("throughput per dollar at equal SLO", 1.4, "x", "increase", "co-located serving", "8xH100 cluster")],
                    "paper_setup": setup("4 nodes x 8 NVIDIA H100, InfiniBand", "Llama-3-70B", "vLLM", "continuous", "2k–8k", "Azure LLM traces"),
                    "prerequisites": ["Multiple GPUs", "Fast interconnect"], "requires_cuda": True, "requires_multi_gpu": True, "effort": "high",
                    "risks": ["Only pays off at cluster scale"],
                    "evidence": {"quote": "Phase splitting yields 1.4x higher throughput per dollar under the same latency SLOs.", "location": "Section 8"},
                },
                "match": {"similarity": 0.38, "target_metric": "throughput_tokens_per_s", "rationale": None},
            },
            {
                "key": "c_layer_stream", "name": "Layer-wise KV streaming over RDMA", "kind": "method",
                "summary": "Stream each layer's KV to the decode node as soon as it is computed, overlapping transfer with the remaining prefill.",
                "key_points": ["GPUDirect RDMA", "Overlaps 85% of transfer"],
                "card": {
                    "testable": True, "category": "parallelism_communication",
                    "technique": "Transfer KV per layer over RDMA while later layers are still prefilling.",
                    "change_required": "Add an RDMA KV transport and per-layer send hooks.",
                    "effects": [effect("visible KV transfer time", 85, "%", "decrease", "bulk transfer after prefill", "InfiniBand 400 Gb/s")],
                    "paper_setup": setup("2 nodes x 8 NVIDIA H100, InfiniBand", "Llama-3-70B", "NCCL / UCX", "continuous", "8k", "synthetic"),
                    "prerequisites": ["RDMA-capable NICs", "Multiple GPUs"], "requires_cuda": True, "requires_multi_gpu": True, "effort": "high",
                    "risks": [], "evidence": {"quote": "Layer-wise streaming hides 85% of the KV transfer time behind prefill compute.", "location": "Figure 6"},
                },
                "match": {"similarity": 0.3, "target_metric": "ttft_ms", "rationale": None},
            },
        ],
    },
    {
        "paper_id": "arxiv:2607.12245",
        "title": "AWQ-Metal: Activation-Aware 4-bit Weights for Unified-Memory Inference",
        "abstract": "Decode on Apple silicon is memory-bandwidth bound. AWQ-Metal applies activation-aware weight quantization — scaling "
        "salient channels identified from activation statistics before 4-bit group quantization — and adds an int4 matmul for "
        "Metal. Decode throughput rises 35% and weight memory drops 2.9x on Llama-2-13B and Mistral-7B with under 0.5 points "
        "accuracy loss.",
        "venue": "MLSys '26", "sources": ["arxiv", "semantic_scholar", "openalex", "hf_papers"], "date": date(2026, 7, 28), "citations": 41, "upvotes": 205,
        "code_url": "https://github.com/example/awq-metal",
        "authors": [{"name": "J. Lin"}, {"name": "J. Tang"}, {"name": "S. Han"}],
        "topics": [("low-bit-weight-quantization", 1, 0.9)],
        "concepts": [
            {
                "key": "c_awq", "name": "Activation-aware 4-bit weight quantization", "kind": "method",
                "summary": "Scale salient weight channels found from activation magnitudes on a small calibration set, then quantize weights to int4 with group size 128.",
                "key_points": ["128-sample calibration", "Group size 128", "Embeddings and lm_head stay bf16"],
                "card": {
                    "testable": True, "category": "quantization",
                    "technique": "Quantize linear-layer weights to int4 (group 128) after scaling salient channels identified from activation magnitudes on a small calibration set; dequantize inside the matmul.",
                    "change_required": "Add a load-time quantization pass with a 128-sample calibration set and an int4 matmul path for MPS; keep embeddings and lm_head in bf16.",
                    "effects": [
                        effect("decode throughput (tokens/s)", 35, "%", "increase", "fp16 weights", "batch 1, Mistral-7B, M2 Max"),
                        effect("weight memory", 2.9, "x", "decrease", "fp16 weights", ""),
                    ],
                    "paper_setup": setup("Apple M2 Max 96GB", "Llama-2-13B, Mistral-7B", "MLX", "1", "2k", "WikiText-2, MMLU"),
                    "prerequisites": ["int4 matmul kernel on MPS"], "effort": "medium",
                    "risks": ["Approximate: needs the quality guardrail", "MoE expert weights need per-expert calibration"],
                    "evidence": {"quote": "AWQ-Metal improves decode throughput by 35% and reduces weight memory by 2.9x with less than 0.5 points of accuracy loss.", "location": "Table 4"},
                },
                "match": {"similarity": 0.61, "target_metric": "decode_tokens_per_s",
                          "rationale": "Decode on the M5 Pro is bandwidth-bound, so halving weight bytes should help; the model_loader hook supports load-time transforms, but an MPS int4 matmul is required."},
            },
            {
                "key": "c_awq_clip", "name": "Per-group clipping search", "kind": "algorithm",
                "summary": "Grid-search the per-group clipping ratio to minimise output MSE on the calibration set.",
                "key_points": ["20-point grid", "Minimises layer output MSE"],
                "card": {
                    "testable": True, "category": "quantization",
                    "technique": "Search a per-group weight clipping ratio that minimises layer output MSE before int4 quantization.",
                    "change_required": "Add a clipping search step to the quantization pass.",
                    "effects": [effect("perplexity", 3.1, "%", "decrease", "no clipping", "WikiText-2")],
                    "paper_setup": setup("Apple M2 Max 96GB", "Llama-2-13B", "MLX", "1", "2k", "WikiText-2"),
                    "prerequisites": ["Activation-aware quantization"], "effort": "low", "risks": [],
                    "evidence": {"quote": "Clipping search lowers WikiText-2 perplexity by 3.1% relative to round-to-nearest.", "location": "Table 5"},
                },
                "match": {"similarity": 0.44, "target_metric": "exact_match",
                          "rationale": "A quality refinement for int4 weights; the bench only reports exact match on the quality set, so the effect is hard to see."},
            },
        ],
    },
    {
        "paper_id": "arxiv:2609.02291",
        "title": "TokenScope: Token-Level SLO Telemetry for LLM Serving",
        "abstract": "Request-level latency hides where LLM serving time goes. TokenScope records per-token timestamps in a lock-free ring "
        "buffer and exports OpenTelemetry spans asynchronously with under 1% overhead, and proposes TBT-SLO attainment as the "
        "primary serving health metric.",
        "venue": "arXiv", "sources": ["arxiv"], "date": date(2026, 9, 2), "citations": 2, "upvotes": 41,
        "code_url": "https://github.com/example/tokenscope",
        "authors": [{"name": "M. Kumar"}, {"name": "S. Park"}],
        "topics": [("token-level-serving-telemetry", 1, 0.86)],
        "concepts": [
            {
                "key": "c_tokenscope", "name": "Per-token timing spans with ring-buffer export", "kind": "system",
                "summary": "Record per-token timestamps in a lock-free ring buffer and export OpenTelemetry spans asynchronously.",
                "key_points": ["Enqueue / prefill / decode-step timestamps", "Async exporter thread", "< 1% overhead"],
                "card": {
                    "testable": True, "category": "observability",
                    "technique": "Record per-token timestamps in a lock-free ring buffer and export OpenTelemetry spans from a background thread.",
                    "change_required": "Add timing hooks around scheduler iterations and decode steps plus an async OTLP exporter.",
                    "effects": [effect("serving throughput overhead", 0.8, "%", "none", "no tracing", "concurrent load")],
                    "paper_setup": setup("1x NVIDIA L4", "Llama-3-8B", "vLLM", "32 concurrent", "2k", "ShareGPT"),
                    "prerequisites": [], "effort": "low", "risks": ["No performance gain by design"],
                    "evidence": {"quote": "Token-level tracing costs less than 1% of serving throughput.", "location": "Section 5"},
                },
                "match": {"similarity": 0.4, "target_metric": "decode_tokens_per_s",
                          "rationale": "Useful instrumentation but not a performance technique — an A/B run would only confirm the overhead is negligible."},
            },
            {
                "key": "c_tbt_slo", "name": "TBT-SLO attainment as primary serving metric", "kind": "evaluation",
                "summary": "Report the fraction of tokens delivered within the time-between-tokens SLO instead of mean latency.",
                "key_points": ["Captures stalls that averages hide"],
                "card": {
                    "testable": False, "category": "evaluation_quality",
                    "technique": "Measure serving health as the fraction of tokens within the TBT SLO.",
                    "change_required": "Add an SLO-attainment metric to the benchmark.",
                    "effects": [effect("metric definition", None, None, "none", "", "")],
                    "paper_setup": setup("1x NVIDIA L4", "Llama-3-8B", "vLLM", "32", "2k", "ShareGPT"),
                    "prerequisites": [], "effort": "low", "risks": [],
                    "evidence": {"quote": "Mean TBT hides stalls that SLO attainment exposes.", "location": "Section 3"},
                },
                "match": {"similarity": 0.3, "target_metric": None, "rationale": None},
            },
        ],
    },
    {
        "paper_id": "patent:US20260183311A1",
        "doc_type": "patent",
        "title": "Adaptive speculative token verification for large language model inference",
        "abstract": "A method for accelerating large language model inference in which the number of speculatively drafted tokens is "
        "adjusted at each step by a controller driven by a moving average of the verification acceptance rate, drafting stops "
        "early when the draft model's confidence falls below a threshold, and drafts from multiple concurrent requests are "
        "verified in a single batched forward pass.",
        "venue": "USPTO", "sources": ["patents"], "date": date(2026, 6, 18), "citations": None, "upvotes": None,
        "code_url": None,
        "authors": [{"name": "Example Systems Inc."}],
        "patent_number": "US20260183311A1",
        "url": "https://patents.google.com/patent/US20260183311A1/en",
        "pdf_url": None,
        "topics": [("speculative-decoding-dynamic-drafts", 4, 0.79)],
        "concepts": [
            {
                "key": "c_draft_len", "name": "Acceptance-rate–driven draft length controller", "kind": "method",
                "summary": "Adjust the number of drafted tokens each step from an EMA of the acceptance rate and stop drafting early when the drafter's confidence drops.",
                "key_points": ["EMA of acceptance rate", "Draft length bounded 1–8", "Confidence early-exit in the draft loop"],
                "card": {
                    "testable": True, "category": "speculative_decoding",
                    "technique": "Set the speculative draft length per step with a controller driven by an exponential moving average of the acceptance rate, and stop drafting early when draft confidence falls below a threshold.",
                    "change_required": "In the speculative decoder, replace the fixed num_draft_tokens with an EMA-based controller (bounds 1–8) and stop the draft loop when draft confidence drops.",
                    "effects": [effect("tokens per second", 20, "%", "increase", "fixed draft length 5", "claim 12, example embodiment")],
                    "paper_setup": setup("GPU accelerator (unspecified)", "unspecified transformer LLM", "unspecified", "1", "unspecified", "unspecified"),
                    "prerequisites": ["Draft-model speculative decoding"], "effort": "low",
                    "risks": ["Patent: check licensing before shipping", "Effect size from an example embodiment, not a benchmark"],
                    "evidence": {"quote": "In an example embodiment, adaptive draft length increased generated tokens per second by approximately 20% relative to a fixed draft length of five tokens.", "location": "Description [0047]"},
                },
                "match": {"similarity": 0.6, "target_metric": "decode_tokens_per_s",
                          "rationale": "A small controller inside the existing speculative_draft technique — low effort and easy to A/B on short_chat; treat the patent's 20% as indicative only."},
            },
            {
                "key": "c_batched_verify", "name": "Cross-request batched verification", "kind": "system",
                "summary": "Verify drafts from several concurrent requests in one padded forward pass of the target model.",
                "key_points": ["Padding to the longest draft", "Amortises weight reads"],
                "card": {
                    "testable": True, "category": "batching_scheduling",
                    "technique": "Pad and batch draft verification across concurrent requests into one target forward pass.",
                    "change_required": "Extend the scheduler to group verify passes of concurrent speculative requests.",
                    "effects": [effect("aggregate throughput", 1.25, "x", "increase", "per-request verification", "4 concurrent requests")],
                    "paper_setup": setup("GPU accelerator (unspecified)", "unspecified", "unspecified", "4", "unspecified", "unspecified"),
                    "prerequisites": ["Speculative decoding", "Iteration-level scheduler"], "effort": "medium",
                    "risks": ["Padding waste when draft lengths differ"],
                    "evidence": {"quote": "Batching verification of four concurrent requests increased aggregate throughput by about 1.25 times.", "location": "Description [0052]"},
                },
                "match": {"similarity": 0.5, "target_metric": "throughput_tokens_per_s",
                          "rationale": "Plausible on concurrent_4, but interacts with the scheduler and speculative decoder at once — medium effort."},
            },
        ],
    },
    {
        "paper_id": "arxiv:2611.00872",
        "title": "MoE Expert Offloading with Predictive Prefetch on Unified Memory",
        "abstract": "Mixture-of-experts models exceed device memory on laptops. We predict the next layer's experts from the current "
        "router logits and prefetch them from SSD into unified memory, hiding most of the offloading latency.",
        "venue": "arXiv", "sources": ["arxiv", "hf_papers"], "date": date(2026, 11, 4), "citations": 0, "upvotes": 66,
        "code_url": None,
        "authors": [{"name": "R. Eliseev"}, {"name": "D. Mazur"}],
        "topics": [("low-bit-weight-quantization", 2, 0.74)],
        "concepts": [],
    },
]

for _paper in PAPERS:
    _paper["concepts"].extend(EXTRA_CONCEPTS.get(_paper["paper_id"], []))

ALREADY_TESTED = {"c_radix", "c_split_k", "c_prompt_lookup", "c_chunked_prefill", "c_kivi", "c_lookahead", "c_draft_len",
                  "c_tree_mask", "c_dyn_tree", "c_split_heuristic", "c_awq", "c_batched_verify", "c_adaptive_ngram", "c_lookahead_tuning"}


# ---- experiments ---------------------------------------------------------------------------

def spec_for(**kwargs: Any) -> dict[str, Any]:
    from paperatlas.lab.planner import ExperimentSpec

    return ExperimentSpec(**kwargs).model_dump()


def make_results(
    flag: str,
    workload: str,
    rounds: int,
    effects: dict[str, float],
    seed: int,
    quality: dict[str, Any],
    model: str = "eval",
) -> dict[str, Any]:
    """Synthetic ABBA A/B results following the inference-lab bench contract."""
    rng = random.Random(seed)
    base = {
        "short_chat": {"ttft_ms": 182.0, "itl_ms": 21.4, "decode_tokens_per_s": 46.7, "e2e_latency_ms": 5640.0, "throughput_tokens_per_s": 46.1, "peak_memory_gb": 38.2},
        "long_prompt": {"ttft_ms": 2310.0, "itl_ms": 23.9, "decode_tokens_per_s": 41.8, "e2e_latency_ms": 14560.0, "throughput_tokens_per_s": 40.9, "peak_memory_gb": 41.6},
        "concurrent_4": {"ttft_ms": 1480.0, "itl_ms": 38.5, "decode_tokens_per_s": 25.9, "e2e_latency_ms": 11820.0, "throughput_tokens_per_s": 98.4, "peak_memory_gb": 44.9},
    }[workload]
    if model == "smoke":  # the 0.6B smoke model is much faster and smaller than the eval model
        base = {k: v * 4.5 if k.endswith("_per_s") else (2.1 if k == "peak_memory_gb" else v / 4.5) for k, v in base.items()}
    directions = {m["name"]: m["direction"] for m in PROFILE["metrics"]}
    rows = []
    for pair in range(rounds):
        order = ("baseline", "variant") if pair % 2 == 0 else ("variant", "baseline")
        for arm in order:
            metrics = {}
            for name, value in base.items():
                noise = rng.gauss(0, 0.025 if name != "peak_memory_gb" else 0.006)
                gain = effects.get(name, 0.0) / 100.0 if arm == "variant" else 0.0
                factor = (1 + gain) if directions[name] == "higher_is_better" else (1 - gain)
                metrics[name] = round(value * factor * (1 + noise), 3)
            rows.append({"round": pair, "arm": arm, "metrics": metrics})
    model_info = PROFILE["models"][model]
    summary = {}
    for name in base:
        values = {arm: sorted(r["metrics"][name] for r in rows if r["arm"] == arm) for arm in ("baseline", "variant")}
        summary[name] = {arm: vals[len(vals) // 2] for arm, vals in values.items()}
    return {
        "schema_version": 1,
        "model": {"id": model_info["id"], "dtype": model_info["dtype"], "alias": model},
        "workload": workload,
        "arms": {"baseline": {"flags": []}, "variant": {"flags": [flag]}},
        "rounds": rows,
        "quality": quality,
        "summary": summary,
        "environment": {
            "chip": "Apple M5 Pro", "memory_gb": 64, "macos": "26.1", "python": "3.12.8", "torch": "2.9.1",
            "on_ac_power": True, "thermal_warning": False, "git_sha": PROFILE["repo"]["sha"][:12],
        },
    }


def eval_log(results: dict[str, Any], spec: dict[str, Any]) -> str:
    lines = [f"$ bench ab --flags {spec['flag_name']} --workload {spec['workload']} --rounds {spec['rounds']}",
             f"loading {results['model']['id']} ({results['model']['dtype']}) on mps"]
    metric = spec["primary_metric"]
    for row in results["rounds"]:
        lines.append(f"round {row['round'] + 1}/{spec['rounds']} {row['arm']:<8} {metric}={row['metrics'][metric]}")
    lines.append("results written; environment: Apple M5 Pro, on AC power, no thermal warnings")
    return "\n".join(lines) + "\n"


# ---- seeding ------------------------------------------------------------------------------


class Seeder:
    def __init__(self) -> None:
        from paperatlas.lab.workspace import artifacts_dir

        self.artifacts_dir = artifacts_dir
        self.events: list[dict[str, Any]] = []
        self.jobs: list[dict[str, Any]] = []
        self.claims: dict[str, int] = {}
        self.claim_rows: dict[str, dict[str, Any]] = {}
        self.skipped_artifacts: list[int] = []
        self.experiments = 0
        self.links = 0
        self.predictions: dict[str, Optional[dict[str, Any]]] = {}

    # events / jobs are buffered and inserted in time order so ids follow time (SSE cursors rely on it)
    def event(self, at: datetime, stage: str, message: str, data: Optional[dict] = None, *, experiment_id: Optional[int] = None,
              triage_id: Optional[int] = None, level: str = "info", job: Optional[str] = None) -> None:
        self.events.append(dict(created_at=at, stage=stage, message=message, data=data, experiment_id=experiment_id,
                                triage_id=triage_id, level=level, job=job))

    def job(self, key: str, kind: str, payload: dict, created: datetime, status: str = "done", *,
            finished: Optional[datetime] = None, experiment_id: Optional[int] = None, triage_id: Optional[int] = None,
            error: Optional[str] = None, result: Optional[dict] = None) -> None:
        self.jobs.append(dict(key=key, kind=kind, payload=payload, status=status, created_at=created, run_after=created,
                              started_at=created + timedelta(seconds=2) if status != "queued" else None,
                              finished_at=finished if status in ("done", "failed", "cancelled") else None,
                              locked_by="demo-worker:4242" if status == "running" else None,
                              attempts=0 if status == "queued" else 1,
                              experiment_id=experiment_id, triage_id=triage_id, error=error, result=result))

    def run(self) -> None:
        from sqlalchemy import text

        from paperatlas.db.engine import session_scope
        from paperatlas.db.schema import Base

        names = ", ".join(f"{t.schema}.{t.name}" for t in Base.metadata.sorted_tables if t.schema in ("research", "lab"))
        with session_scope() as session:
            session.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))
        self.seed_research()
        project_id = self.seed_project()
        self.seed_matches(project_id)
        self.seed_triage_and_experiments(project_id)
        self.flush_jobs_and_events()

    # -- research --
    def seed_research(self) -> None:
        from paperatlas.db.engine import session_scope
        from paperatlas.db.schema import Claim, ClaimGroup, Concept, Paper, PaperTopic, Topic
        from paperatlas.distill.claims import ClaimCard

        with session_scope() as session:
            topic_ids = {}
            for rank, (slug, name, seed, cluster, description, keywords, trend, size) in enumerate(TOPICS, start=1):
                rng = random.Random(rank)
                topic = Topic(
                    slug=slug, name=name, description=description, seed=seed, keywords=keywords,
                    queries=[f"{keywords[0]} LLM", f"{keywords[1]} inference"], trend_score=trend, rank=rank,
                    needs_gpu_cluster=cluster, status="active",
                    stats={"size": float(size), "papers": size, "recency": round(0.55 + 0.4 * rng.random(), 3),
                           "velocity": round(0.3 + 0.6 * rng.random(), 3), "citations": round(1 + 2 * rng.random(), 3),
                           "upvotes": round(2 + 3 * rng.random(), 3), "code": round(0.3 + 0.6 * rng.random(), 3)},
                    created_at=ago(days=9), refreshed_at=ago(hours=26),
                )
                session.add(topic)
                session.flush()
                topic_ids[slug] = topic.id
            session.add(Topic(slug="moe-routing-load-balancing", name="MoE expert routing & load balancing",
                              description="Archived after the last refresh.", seed="Request routing & load balancing",
                              keywords=["MoE", "routing"], trend_score=0.41, rank=None, status="archived",
                              stats={"size": 6.0, "papers": 6}, created_at=ago(days=9), refreshed_at=ago(days=9)))

            for paper_data in PAPERS:
                pid = paper_data["paper_id"]
                arxiv = pid.split(":", 1)[1] if pid.startswith("arxiv:") else None
                distilled = bool(paper_data["concepts"])
                session.add(Paper(
                    paper_id=pid, doc_type=paper_data.get("doc_type", "paper"), title=paper_data["title"],
                    abstract=paper_data["abstract"], venue=paper_data["venue"], source=paper_data["sources"][0],
                    sources=paper_data["sources"], arxiv_id=arxiv, patent_number=paper_data.get("patent_number"),
                    url=paper_data.get("url") or (f"https://arxiv.org/abs/{arxiv}" if arxiv else None),
                    pdf_url=paper_data.get("pdf_url", f"https://arxiv.org/pdf/{arxiv}" if arxiv else None),
                    code_url=paper_data.get("code_url"), publication_date=paper_data["date"],
                    publication_year=paper_data["date"].year, authors=paper_data["authors"],
                    citation_count=paper_data.get("citations"), hf_upvotes=paper_data.get("upvotes"),
                    raw_text=(paper_data["abstract"] + "\n\n[full text omitted in demo fixture]") if distilled else None,
                    ingested_at=ago(hours=27), updated_at=ago(hours=27),
                    text_fetched_at=ago(hours=27) if distilled else None,
                    distilled_at=ago(hours=25) if distilled else None,
                ))
                session.flush()
                for slug, rank, score in paper_data["topics"]:
                    session.add(PaperTopic(paper_id=pid, topic_id=topic_ids[slug], relevance=score, score=score, rank=rank))
                for concept_data in paper_data["concepts"]:
                    card = ClaimCard.model_validate(concept_data["card"])
                    primary = card.primary_effect()
                    concept = Concept(
                        paper_id=pid, concept_key=f"concept:{concept_data['key']}", name=concept_data["name"],
                        kind=concept_data["kind"], summary=concept_data["summary"], key_points=concept_data["key_points"],
                        source="llm", created_at=ago(hours=25),
                    )
                    session.add(concept)
                    session.flush()
                    claim = Claim(
                        paper_id=pid, concept_id=concept.id, category=card.category, technique=card.technique,
                        change_required=card.change_required, primary_metric=primary.metric if primary else None,
                        claimed_value=primary.value if primary else None, claimed_unit=primary.unit if primary else None,
                        direction=primary.direction if primary else None, claimed_gain_pct=card.claimed_gain_pct(),
                        testable=card.testable, requires_cuda=card.requires_cuda, requires_multi_gpu=card.requires_multi_gpu,
                        requires_training=card.requires_training, effort=card.effort, evidence_quote=card.evidence.quote,
                        card=card.model_dump(mode="json"), created_at=ago(hours=25),
                    )
                    session.add(claim)
                    session.flush()
                    self.claims[concept_data["key"]] = claim.id
                    self.claim_rows[concept_data["key"]] = {"concept": concept_data, "paper": paper_data, "card": card}
            self.seed_background_papers(session, topic_ids)
            self.links = apply_concept_maps(session, self.claims, ago(hours=23))
            for slug, explainer in TOPIC_EXPLAINERS.items():
                session.query(Topic).filter(Topic.slug == slug).update({"explainer": stamp(explainer, hours=20)})
            for paper_id, explainer in PAPER_EXPLAINERS.items():
                session.get(Paper, paper_id).explainer = stamp(explainer, hours=24)
            group = ClaimGroup(label="Adaptive speculation length", category="speculative_decoding",
                               canonical_claim_id=self.claims["c_draft_len"], size=2)
            session.add(group)
            session.flush()
            for key in ("c_draft_len", "c_adaptive_ngram"):
                session.get(Claim, self.claims[key]).group_id = group.id

    @staticmethod
    def seed_background_papers(session: Any, topic_ids: dict[str, int]) -> None:
        """A few undistilled papers per topic so the topic infographics (papers/month, sources) have data."""
        from paperatlas.db.schema import Paper, PaperTopic

        serial = 40000
        for slug, papers in BACKGROUND_PAPERS.items():
            existing = sum(1 for paper in PAPERS for topic_slug, *_ in paper["topics"] if topic_slug == slug)
            for index, (title, published, sources, citations, upvotes, code) in enumerate(papers, start=1):
                serial += 7
                arxiv = f"{published.year % 100:02d}{published.month:02d}.{serial:05d}"
                pid = f"arxiv:{arxiv}" if "arxiv" in sources else f"doi:10.5555/demo.{serial}"
                session.add(Paper(
                    paper_id=pid, doc_type="paper", title=title, venue="arXiv" if "arxiv" in sources else "preprint",
                    abstract=f"{title}. (Background paper in the demo fixture; not distilled.)", source=sources[0], sources=sources,
                    arxiv_id=arxiv if "arxiv" in sources else None, url=f"https://arxiv.org/abs/{arxiv}" if "arxiv" in sources else None,
                    code_url=f"https://github.com/example/{slug[:18]}-{index}" if code else None, publication_date=published,
                    publication_year=published.year, authors=[{"name": "Demo Author"}], citation_count=citations, hf_upvotes=upvotes,
                    ingested_at=ago(hours=27), updated_at=ago(hours=27),
                ))
                session.flush()
                session.add(PaperTopic(paper_id=pid, topic_id=topic_ids[slug], relevance=0.6, score=round(0.7 - 0.04 * index, 3), rank=existing + index))

    def seed_project(self) -> int:
        from paperatlas.db.engine import session_scope
        from paperatlas.db.schema import Project

        with session_scope() as session:
            measured = ago(hours=3)
            project = Project(name="inference-lab", repo_path=PROFILE["repo"]["path"], profile=PROFILE,
                              profiled_at=ago(days=1, hours=2), created_at=ago(days=8), roofline=ROOFLINE, roofline_at=measured)
            session.add(project)
            session.flush()
            project_id = project.id
        from paperatlas.lab.costmodel import summarize

        job = "roofline"
        start = measured - timedelta(minutes=6)
        self.job(job, "project.roofline", {"project_id": project_id, "model": "eval", "rematch": True}, start, finished=measured + timedelta(minutes=2),
                 result={"decode": ROOFLINE["decode"], "forward_cost_ms": ROOFLINE["forward_cost_ms"]})
        self.event(start + timedelta(seconds=3), "roofline", "Profiling inference-lab (eval) to measure where decode time goes",
                   {"command": "uv run python -m inference_lab.bench.profile --model eval --out roofline.json"}, job=job)
        for i, line in enumerate(["decode: 24.1 tok/s (41.5 ms/token)", "forward cost: 1→41.5 ms, 4→45.8 ms, 16→66.4 ms",
                                  "batched decode: batch 8 → 112.3 tok/s", "draft Qwen/Qwen3-0.6B: 19.8 ms/token"]):
            self.event(start + timedelta(minutes=1 + i), "roofline", line, job=job)
        self.event(measured, "roofline", f"Roofline: {summarize(ROOFLINE)}", {"roofline": ROOFLINE}, job=job)
        self.event(measured + timedelta(minutes=2), "match", "Re-ranked claims with the cost model", job=job)
        return project_id

    def seed_matches(self, project_id: int) -> None:
        """Mirror of paperatlas.lab.matcher scoring (similarity is fixed per claim since embeddings stay NULL)."""
        from paperatlas.db.engine import session_scope
        from paperatlas.db.schema import Match
        from paperatlas.lab.costmodel import blocker as costmodel_blocker
        from paperatlas.lab.costmodel import predict, score_factor

        workloads = [w["name"] for w in PROFILE["workloads"]]
        prior = {"kv_cache": 1.0, "speculative_decoding": 1.0, "batching_scheduling": 0.9, "memory_management": 0.9,
                 "quantization": 0.85, "attention_kernels": 0.8, "observability": 0.7, "evaluation_quality": 0.6,
                 "disaggregated_serving": 0.2, "parallelism_communication": 0.2}
        effort_cost = {"low": 1.0, "medium": 1.6, "high": 2.6}
        cluster_topics = {topic[0] for topic in TOPICS if topic[3]}
        with session_scope() as session:
            for key, row in self.claim_rows.items():
                card, info = row["card"], row["concept"]["match"]
                blockers = []
                if card.requires_cuda:
                    blockers.append("needs CUDA")
                if card.requires_multi_gpu:
                    blockers.append("needs multiple GPUs")
                if card.requires_training:
                    blockers.append("needs training / fine-tuning")
                in_cluster_topic = any(slug in cluster_topics for slug, _rank, _score in row["paper"]["topics"])
                if in_cluster_topic or card.category in ("disaggregated_serving", "parallelism_communication"):
                    blockers.append("needs a GPU cluster")
                if not card.testable:
                    blockers.append("no measurable claim")
                if not info["target_metric"] and not blockers:
                    blockers.append("no matching benchmark metric")
                prediction = predict({"category": card.category, "technique": card.technique, "change_required": card.change_required,
                                      "card": card.model_dump(mode="json")}, ROOFLINE, workloads)
                self.predictions[key] = prediction
                if (cost_blocker := costmodel_blocker(prediction)) and not blockers:
                    blockers.append(cost_blocker)
                fit = 0.5 * prior.get(card.category, 0.3) + 0.5 * info["similarity"]
                gain_pct = card.claimed_gain_pct()
                gain = min(gain_pct, 100.0) / 100.0 if gain_pct is not None else 0.15
                cost = effort_cost[card.effort]
                score = fit * (0.4 + gain) / cost * score_factor(prediction)
                if key in ALREADY_TESTED:
                    score *= 0.3
                if blockers:
                    score *= 0.05
                explainer = CLAIM_EXPLAINERS.get(key)
                extra = {"explainer": stamp(explainer, minutes=50), "explained_at": ago(minutes=50)} if explainer else {}
                session.add(Match(
                    project_id=project_id, claim_id=self.claims[key], fit=round(fit, 4), gain=round(gain, 4),
                    effort_cost=cost, score=round(score, 5), testable_here=not blockers, blockers=blockers,
                    target_metric=info["target_metric"], rationale=info["rationale"], prediction=prediction, created_at=ago(hours=1), **extra,
                ))

    # -- triage + experiments --
    def seed_triage_and_experiments(self, project_id: int) -> None:
        from paperatlas.db.engine import session_scope
        from paperatlas.db.schema import Triage

        options = {"refresh_topics": False, "topics": None, "per_topic": 5, "distill_limit": 60, "expand": True, "use_llm": True}
        triages = [
            ("picked", ago(days=2, hours=3), {**options, "refresh_topics": True}, ["c_prompt_lookup", "c_chunked_prefill"]),
            ("picked", ago(hours=5, minutes=20), options, ["c_lookahead", "c_draft_len"]),
            ("awaiting_pick", ago(minutes=48), {**options, "distill_limit": 40}, []),
        ]
        shortlist_keys = ["c_cache_order", "c_awq", "c_h2o", "c_dyn_tree", "c_adaptive_ngram", "c_slo_chunk",
                          "c_lookahead_tuning", "c_batched_verify", "c_tokenscope", "c_awq_clip"]
        triage_ids = []
        with session_scope() as session:
            for index, (status, created, opts, selected) in enumerate(triages, start=1):
                triage = Triage(
                    project_id=project_id, thread_id=f"triage-demo-{index}", status=status, options=opts,
                    shortlist=[{"claim_id": self.claims[k], "score": round(0.42 - 0.03 * i, 4)} for i, k in enumerate(shortlist_keys)],
                    selected=[self.claims[k] for k in selected], created_at=created, updated_at=created + timedelta(minutes=14),
                )
                session.add(triage)
                session.flush()
                triage_ids.append(triage.id)
        for triage_id, (status, created, opts, _selected) in zip(triage_ids, triages):
            self.triage_events(triage_id, created, opts)

        self.exp_merged(project_id)
        failed = self.exp_failed(project_id)
        self.exp_awaiting_decision(project_id, triage_ids[0])
        self.exp_running(project_id, triage_ids[0])
        self.exp_building(project_id)
        self.exp_awaiting_approval(project_id, triage_ids[1], "c_lookahead", ago(hours=5, minutes=4))
        self.exp_chain_and_bundle(project_id, triage_ids[2], failed_prerequisite=2)
        kit = SimpleNamespace(ago=ago, spec_for=spec_for, make_results=make_results, profile=PROFILE)
        seed_protocol.exp_v2_gate2(self, kit, project_id, triage_ids[2])
        seed_protocol.exp_v2_gate3(self, kit, project_id, triage_ids[1])
        seed_protocol.exp_v2_tuning(self, kit, project_id)
        seed_protocol.exp_v2_kept(self, kit, project_id, triage_ids[1])
        self.exp_rerun(project_id, failed, "engine ported to MLX: the split-K kernel can use mx.fast with fp32 accumulation")

    def triage_events(self, triage_id: int, start: datetime, opts: dict) -> None:
        t = start
        job = f"triage-{triage_id}"
        self.job(job, "triage.run", {"triage_id": triage_id}, start, finished=start + timedelta(minutes=14), triage_id=triage_id)
        self.event(t, "topics", "Research scan queued", triage_id=triage_id)
        if opts.get("refresh_topics"):
            self.event(t + timedelta(seconds=20), "topics", "Finding the top trending topics in the seed areas", triage_id=triage_id, job=job)
            self.event(t + timedelta(minutes=3), "topics", f"{len(TOPICS)} topics: " + ", ".join(x[1] for x in TOPICS), triage_id=triage_id, job=job)
        else:
            self.event(t + timedelta(seconds=20), "topics", "Using the current top topics (refresh not requested)", triage_id=triage_id, job=job)
        for i, seed in enumerate(["Speculative decoding", "KV-cache management & compression", "Batching & scheduling", "Quantization"]):
            self.event(t + timedelta(minutes=3, seconds=30 + 20 * i), "discover", f"Seed '{seed}': {38 + 7 * i} results",
                       {"seed": seed, "results": 38 + 7 * i}, triage_id=triage_id, job=job)
        testable = sum(1 for row in self.claim_rows.values() if row["card"].testable)
        self.event(t + timedelta(minutes=6), "discover", f"Selected {len(PAPERS)} papers across {len(TOPICS)} topics (11 PDFs parsed)", triage_id=triage_id, job=job)
        self.event(t + timedelta(minutes=11), "distill", f"Distilled {len(PAPERS) - 1} papers → {len(self.claims)} claim cards ({testable} testable)", triage_id=triage_id, job=job)
        self.event(t + timedelta(minutes=13), "match", f"Matched {len(self.claims)} claims: 17 testable on this project", {"testable": 17}, triage_id=triage_id, job=job)
        self.event(t + timedelta(minutes=14), "pick", "10 recommendations ready — pick 1–2 claims to test (Gate 1)", triage_id=triage_id, job=job)

    def _experiment(self, project_id: int, key: str, status: str, created: datetime, updated: datetime, *, triage_id: Optional[int] = None,
                    spec: Optional[dict] = None, branch: Optional[str] = None, build: Optional[dict] = None, error: Optional[str] = None,
                    thread_id: Optional[str] = None) -> int:
        from paperatlas.db.engine import session_scope
        from paperatlas.db.schema import Experiment

        if spec and "prediction" in spec and spec["prediction"] is None:
            # the planner copies the match's cost-model prediction into the spec (shown at Gate 2 and Gate 3)
            spec = {**spec, "prediction": self.predictions.get(key)}
        with session_scope() as session:
            experiment = Experiment(
                project_id=project_id, claim_id=self.claims[key], triage_id=triage_id,
                thread_id=thread_id or f"exp-demo-{key}", status=status, spec=spec or {}, flag_name=(spec or {}).get("flag_name"),
                branch=branch, build=build or {}, error=error, created_at=created, updated_at=updated,
            )
            session.add(experiment)
            session.flush()
            if branch:
                experiment.worktree_path = f"/nonexistent/demo/r2e/worktrees/exp-{experiment.id}"
            self.experiments += 1
            return experiment.id

    def _artifacts(self, experiment_id: int) -> Optional[Path]:
        folder = self.artifacts_dir(experiment_id)
        existing = [p for p in folder.iterdir() if p.name != MARKER]
        if existing and not (folder / MARKER).exists():
            self.skipped_artifacts.append(experiment_id)
            return None
        for path in existing:
            if path.is_file():
                path.unlink()
        (folder / MARKER).write_text("created by web/dev/seed_demo.py\n", encoding="utf-8")
        return folder

    @staticmethod
    def _write_log(folder: Optional[Path], name: str, text: str, at: datetime) -> str:
        if folder is None:
            return name
        path = folder / name
        path.write_text(text, encoding="utf-8")
        os.utime(path, (at.timestamp(), at.timestamp()))
        return str(path)

    @staticmethod
    def _set(experiment_id: int, **values: Any) -> None:
        from paperatlas.db.engine import session_scope
        from paperatlas.db.schema import Experiment

        with session_scope() as session:
            experiment = session.get(Experiment, experiment_id)
            for name, value in values.items():
                setattr(experiment, name, value)

    @staticmethod
    def _run(experiment_id: int, kind: str, status: str, started: datetime, finished: Optional[datetime], spec: dict,
             results: dict, folder: Optional[Path]) -> None:
        from paperatlas.db.engine import session_scope
        from paperatlas.db.schema import Run

        out = (folder or Path("artifacts")) / f"{kind}-{started:%Y%m%d-%H%M%S}.json"
        command = PROFILE["commands"]["bench_ab"].format(
            model="smoke" if kind == "smoke" else spec["model"], flags=spec["flag_name"], workload=spec["workload"],
            rounds=2 if kind == "smoke" else spec["rounds"], warmup=spec["warmup"], out=out,
        )
        with session_scope() as session:
            session.add(Run(experiment_id=experiment_id, kind=kind, status=status, command=command, results=results,
                            results_path=str(out), log_path=str(out.with_suffix(".log")), started_at=started, finished_at=finished))

    def _verdict(self, experiment_id: int, key: str, spec: dict, build: dict, branch: str, results: dict,
                 folder: Optional[Path], at: datetime, project_id: int) -> dict:
        from paperatlas.db.engine import session_scope
        from paperatlas.db.schema import Verdict
        from paperatlas.lab.judge import judge
        from paperatlas.lab.report import render_report
        from paperatlas.lab.service import get_claim

        verdict = judge(results, spec, PROFILE)
        report_path = None
        if folder is not None:
            claim = get_claim(self.claims[key])
            report_path = render_report(
                folder / "report.html",
                {"id": experiment_id, "branch": branch, "flag_name": spec["flag_name"]},
                {"id": project_id, "name": PROFILE["name"], "repo_path": PROFILE["repo"]["path"]},
                claim,
                {"paper_id": claim["paper_id"], "title": claim["paper_title"], "url": claim["paper_url"]},
                spec,
                build,
                verdict,
                results,
            )
        with session_scope() as session:
            session.add(Verdict(
                experiment_id=experiment_id, verdict=verdict["verdict"], primary_metric=verdict["primary_metric"],
                median_delta_pct=verdict["median_delta_pct"], ci_low_pct=verdict["ci_low_pct"], ci_high_pct=verdict["ci_high_pct"],
                claimed_gain_pct=verdict["claimed_gain_pct"], quality_ok=verdict["quality_ok"],
                details={k: v for k, v in verdict.items() if k != "per_metric"}
                | {"per_metric": {n: {k: v for k, v in m.items() if k != "deltas"} for n, m in verdict["per_metric"].items()}},
                report_path=str(report_path) if report_path else None, created_at=at,
            ))
        return verdict

    def _plan_events(self, eid: int, start: datetime, spec: dict, triage_id: Optional[int], approved_at: Optional[datetime]) -> None:
        job = f"run-{eid}"
        self.job(job, "experiment.run", {"experiment_id": eid}, start, finished=start + timedelta(minutes=2), experiment_id=eid)
        self.event(start, "plan", "Experiment created (Gate 1: claim picked)", experiment_id=eid, triage_id=triage_id)
        self.event(start + timedelta(seconds=15), "plan", "Writing the experiment spec", experiment_id=eid, job=job)
        self.event(start + timedelta(minutes=1, seconds=50), "approve", "Spec ready — waiting for approval (Gate 2)", {"spec": spec}, experiment_id=eid, job=job)
        if approved_at:
            self.event(approved_at, "approve", "Spec approved", {"comment": None}, experiment_id=eid, job=f"resume-{eid}")

    def _build_events(self, eid: int, start: datetime, branch: str, flag: str, files: list[str], log: str) -> None:
        job = f"resume-{eid}"
        self.event(start, "build", f"Worktree ready on branch {branch}", {"worktree": f"data/r2e/worktrees/exp-{eid}"}, experiment_id=eid, job=job)
        self.event(start + timedelta(seconds=20), "build", "Installing the project environment in the experiment worktree", experiment_id=eid, job=job)
        self.event(start + timedelta(minutes=1), "build", f"copilot is implementing `{flag}` (attempt 1/3)", experiment_id=eid, job=job)
        for i, line in enumerate(log.splitlines()[:4]):
            self.event(start + timedelta(minutes=2 + i), "build", f"copilot: {line}", experiment_id=eid, job=job)
        self.event(start + timedelta(minutes=8), "build", f"Build verified: {len(files)} files changed, tests pass", {"files": files}, experiment_id=eid, job=job)

    def _bench_events(self, eid: int, kind: str, start: datetime, spec: dict, done_at: Optional[datetime], progress: int) -> None:
        job = f"resume-{eid}"
        rounds = 2 if kind == "smoke" else spec["rounds"]
        command = PROFILE["commands"]["bench_ab"].format(model="smoke" if kind == "smoke" else spec["model"], flags=spec["flag_name"],
                                                         workload=spec["workload"], rounds=rounds, warmup=spec["warmup"], out=f"{kind}.json")
        self.event(start, kind, f"{kind} A/B started: {rounds} rounds per arm, workload {spec['workload']}", {"command": command}, experiment_id=eid, job=job)
        for i in range(1, progress + 1):
            arm = "baseline" if i % 2 else "variant"
            self.event(start + timedelta(minutes=2.5 * i), kind, f"round {(i + 1) // 2}/{rounds} {arm}: done", experiment_id=eid, job=job)
        if kind == "smoke" and done_at:
            self.event(done_at, "smoke", "Smoke A/B passed on the small model", experiment_id=eid, job=job)

    def _verdict_event(self, eid: int, verdict: dict, at: datetime) -> None:
        self.event(at, "decide", f"Verdict: {verdict['verdict'].replace('_', ' ')} — {verdict['reason']}. Waiting for merge/drop (Gate 3)",
                   {"verdict": verdict["verdict"]}, experiment_id=eid, job=f"resume-{eid}")

    def exp_merged(self, project_id: int) -> int:
        key = "c_radix"
        created = ago(days=6, hours=4)
        spec = spec_for(
            hypothesis="Reusing cached KV for shared prompt prefixes lowers ttft_ms on multi-turn short_chat by at least 15%.",
            flag_name="radix_prefix_cache", technique_summary=self.claim_rows[key]["card"].technique,
            implementation_notes="Implement a token-id radix tree over paged_kv blocks in the kv_cache hook; prefill only the uncached suffix. "
            "With the flag off the cache must never be consulted. Cap cached blocks at 6 GB and LRU-evict leaves.",
            primary_metric="ttft_ms", direction="lower_is_better", secondary_metrics=["e2e_latency_ms", "peak_memory_gb", "itl_ms"],
            workload="short_chat", model="eval", rounds=12, warmup=1, success_threshold_pct=15.0, claimed_gain_pct=52.0, lossless=True,
            guardrails={"max_exact_match_drop": 0.02, "min_output_agreement": 0.95, "max_peak_memory_increase_pct": 15.0},
            paper_vs_project="Paper: A10G + SGLang with 16 concurrent users; here: single-stream multi-turn chat on unified memory, so TTFT is dominated by prefill of the resent history — the effect should transfer.",
        )
        eid = self._experiment(project_id, key, "merged", created, ago(days=5, hours=1), spec=spec)
        branch = f"r2e/exp-{eid}-radix-prefix-cache"
        folder = self._artifacts(eid)
        files = ["src/inference_lab/techniques/radix_prefix_cache.py", "src/inference_lab/kv/paged.py", "tests/test_radix_prefix_cache.py"]
        build_log = ("Reading AGENTS.md and lab.yaml\nAdding RadixTree over paged KV blocks (token-id keyed)\n"
                     "Hooking lookup into kv_cache.prepare(); prefill only the suffix\nAdded tests: prefix hit, eviction, flag-off parity\n"
                     "uv run pytest -q → 84 passed\nsmoke A/B: ttft_ms 41.2 → 23.9\n")
        approved = created + timedelta(minutes=25)
        log_path = self._write_log(folder, "build-attempt-1.log", build_log, approved + timedelta(minutes=9))
        build = {
            "builder": "copilot",
            "attempts": [{"attempt": 1, "agent_exit": 0, "duration_s": 512.4, "problems": [], "log": log_path}],
            "files": files,
            "diff_stat": " src/inference_lab/kv/paged.py                      |  38 +++++--\n"
            " src/inference_lab/techniques/radix_prefix_cache.py | 214 ++++++++++++++++++\n"
            " tests/test_radix_prefix_cache.py                    |  96 ++++++++\n"
            " 3 files changed, 342 insertions(+), 6 deletions(-)",
            "agent_summary": "Implemented `radix_prefix_cache`: a token-id radix tree over paged KV blocks with LRU leaf eviction (6 GB cap). "
            "Flag off: cache never consulted. Tests: 84 passed. Smoke A/B ttft_ms 41.2 → 23.9 ms.",
            "pr_url": None,
        }
        self._plan_events(eid, created, spec, None, approved)
        eval_start = approved + timedelta(minutes=17)
        eval_end = eval_start + timedelta(hours=2, minutes=40)
        self.job(f"resume-{eid}", "experiment.resume", {"experiment_id": eid, "resume": {"decision": "approve", "comment": None}}, approved,
                 finished=eval_end + timedelta(minutes=2), experiment_id=eid)
        self._build_events(eid, approved + timedelta(seconds=10), branch, spec["flag_name"], files, build_log)
        smoke_start = approved + timedelta(minutes=10)
        smoke = make_results(spec["flag_name"], "short_chat", 2, {"ttft_ms": 42.0}, 11,
                             {"baseline": {"exact_match": 0.8}, "variant": {"exact_match": 0.8}, "output_agreement": 1.0}, model="smoke")
        self._run(eid, "smoke", "done", smoke_start, smoke_start + timedelta(minutes=6), spec, smoke, folder)
        self._bench_events(eid, "smoke", smoke_start, spec, smoke_start + timedelta(minutes=6), 2)
        results = make_results(spec["flag_name"], "short_chat", 12, {"ttft_ms": 47.5, "e2e_latency_ms": 3.1, "peak_memory_gb": -5.8}, 101,
                               {"baseline": {"exact_match": 0.84}, "variant": {"exact_match": 0.84}, "output_agreement": 1.0})
        self._run(eid, "eval", "done", eval_start, eval_end, spec, results, folder)
        self._bench_events(eid, "eval", eval_start, spec, eval_end, 6)
        self._write_log(folder, f"eval-{eval_start:%Y%m%d-%H%M%S}.log", eval_log(results, spec), eval_end)
        verdict = self._verdict(eid, key, spec, build, branch, results, folder, eval_end + timedelta(minutes=1), project_id)
        self._verdict_event(eid, verdict, eval_end + timedelta(minutes=1))
        merged_at = ago(days=5, hours=1)
        comment = "Clear TTFT win, memory within budget."
        self.job(f"merge-{eid}", "experiment.resume", {"experiment_id": eid, "resume": {"decision": "merge", "comment": comment}},
                 merged_at - timedelta(seconds=30), finished=merged_at, experiment_id=eid)
        sha = "9c1e4a7b2d3f5e6a8b0c1d2e3f4a5b6c7d8e9f01"
        self.event(merged_at, "decide", f"Merged into main at {sha[:10]} (flag stays off by default)", {"sha": sha}, experiment_id=eid, job=f"merge-{eid}")
        self._set(eid, branch=branch, build={**build, "merge_sha": sha})
        return eid

    def exp_failed(self, project_id: int) -> int:
        key = "c_split_k"
        created = ago(days=4, hours=2)
        spec = spec_for(
            hypothesis="Split-K decode attention improves decode_tokens_per_s on long_prompt by at least 8%.",
            flag_name="split_k_decode_attention", technique_summary=self.claim_rows[key]["card"].technique,
            implementation_notes="Add a Metal split-K attention kernel via torch.mps custom ops behind the attention hook; dispatch only above 4k context.",
            primary_metric="decode_tokens_per_s", direction="higher_is_better", secondary_metrics=["itl_ms", "peak_memory_gb"],
            workload="long_prompt", model="eval", rounds=10, warmup=1, success_threshold_pct=8.0, claimed_gain_pct=24.0, lossless=True,
            guardrails={"max_exact_match_drop": 0.02, "min_output_agreement": 0.95, "max_peak_memory_increase_pct": 15.0},
            paper_vs_project="Paper measured 32k context on an M2 Ultra; long_prompt peaks at ~8.5k tokens, so expect a smaller effect.",
        )
        error = ("build: Build failed after 3 attempts: Tests failed:\n"
                 "FAILED tests/test_split_k_attention.py::test_parity_with_sdpa[8192] - AssertionError: max abs diff 3.1e-02 > 1e-03\n"
                 "FAILED tests/test_split_k_attention.py::test_parity_with_sdpa[16384] - AssertionError: max abs diff 4.7e-02 > 1e-03\n"
                 "2 failed, 88 passed in 74.12s")
        eid = self._experiment(project_id, key, "failed", created, ago(days=3, hours=20), spec=spec, error=error)
        branch = f"r2e/exp-{eid}-split-k-decode-attention"
        folder = self._artifacts(eid)
        approved = created + timedelta(minutes=40)
        self._plan_events(eid, created, spec, None, approved)
        job = f"resume-{eid}"
        self.event(approved + timedelta(seconds=10), "build", f"Worktree ready on branch {branch}", experiment_id=eid, job=job)
        attempts = []
        t = approved + timedelta(minutes=1)
        for attempt in range(1, 4):
            text = (f"attempt {attempt}: writing Metal kernel split_k_attention.metal\nregistering torch.mps custom op\n"
                    f"uv run pytest -q tests/test_split_k_attention.py\nmax abs diff {0.031 + 0.004 * attempt:.3f} > 1e-3 (fp16 accumulation in reduction)\n")
            path = self._write_log(folder, f"build-attempt-{attempt}.log", text, t + timedelta(minutes=18))
            attempts.append({"attempt": attempt, "agent_exit": 0, "duration_s": round(1012.7 + 90 * attempt, 1),
                             "problems": ["Tests failed:\nFAILED tests/test_split_k_attention.py::test_parity_with_sdpa[8192]"], "log": path})
            self.event(t, "build", f"copilot is implementing `{spec['flag_name']}` (attempt {attempt}/3)", experiment_id=eid, job=job)
            self.event(t + timedelta(minutes=19), "build", "Verification failed: Tests failed: test_parity_with_sdpa[8192] max abs diff > 1e-3",
                       experiment_id=eid, job=job, level="warning")
            t += timedelta(minutes=20)
        self._write_log(folder, "verify-attempt-3.log", error + "\n", t)
        self.event(t, "build", "build failed: Build failed after 3 attempts: parity tests failing (fp16 accumulation in the split-K reduction)",
                   {"traceback": "Traceback (most recent call last):\n  ...\npaperatlas.lab.builder.BuildFailed: Build failed after 3 attempts"},
                   experiment_id=eid, job=job, level="error")
        self.job(job, "experiment.resume", {"experiment_id": eid, "resume": {"decision": "approve", "comment": None}}, approved,
                 status="failed", finished=t, experiment_id=eid, error=error)
        self._set(eid, branch=branch, worktree_path=f"/nonexistent/demo/r2e/worktrees/exp-{eid}",
                  build={"builder": "copilot", "attempts": attempts, "files": [], "diff_stat": "", "agent_summary": ""})
        return eid

    def exp_awaiting_decision(self, project_id: int, triage_id: int) -> int:
        key = "c_prompt_lookup"
        created = ago(days=2, hours=2, minutes=40)
        spec = spec_for(
            hypothesis="Prompt-lookup n-gram drafting improves decode_tokens_per_s on long_prompt by at least 8% with identical greedy outputs.",
            flag_name="prompt_lookup_decoding", technique_summary=self.claim_rows[key]["card"].technique,
            implementation_notes="Add a model-free draft provider in decode_step that matches the last 3 generated tokens against the prompt ids "
            "(fallback to 2, 1) and proposes up to 10 tokens to the existing verify path of speculative_draft. Flag off: unchanged decode loop.",
            primary_metric="decode_tokens_per_s", direction="higher_is_better", secondary_metrics=["itl_ms", "ttft_ms", "e2e_latency_ms"],
            workload="long_prompt", model="eval", rounds=10, warmup=1, success_threshold_pct=8.0, claimed_gain_pct=45.0, lossless=True,
            guardrails={"max_exact_match_drop": 0.02, "min_output_agreement": 0.95, "max_peak_memory_increase_pct": 15.0},
            paper_vs_project="Paper used a 7B dense model on an A100; the 30B-A3B MoE on MPS has a cheaper per-token decode, so verification overhead weighs more and the gain may be smaller.",
        )
        eid = self._experiment(project_id, key, "awaiting_decision", created, ago(days=1, hours=20), triage_id=triage_id, spec=spec)
        branch = f"r2e/exp-{eid}-prompt-lookup-decoding"
        folder = self._artifacts(eid)
        files = ["src/inference_lab/techniques/prompt_lookup_decoding.py", "src/inference_lab/decode/speculative.py", "tests/test_prompt_lookup.py"]
        build_log = ("Reading AGENTS.md and lab.yaml\nAdding PromptLookupDrafter (n=3→1 fallback, k≤10)\n"
                     "Re-using SpeculativeVerifier for batched verification\nTests: greedy parity on 20 prompts, flag-off parity\n"
                     "uv run pytest -q → 91 passed\nsmoke A/B decode_tokens_per_s 212.4 → 251.0\n")
        approved = created + timedelta(minutes=18)
        log_path = self._write_log(folder, "build-attempt-1.log", build_log, approved + timedelta(minutes=9))
        build = {
            "builder": "copilot",
            "attempts": [{"attempt": 1, "agent_exit": 0, "duration_s": 401.9, "problems": [], "log": log_path}],
            "files": files,
            "diff_stat": " src/inference_lab/decode/speculative.py                |  27 ++++-\n"
            " src/inference_lab/techniques/prompt_lookup_decoding.py | 143 ++++++++++++++\n"
            " tests/test_prompt_lookup.py                            |  71 +++++++\n"
            " 3 files changed, 237 insertions(+), 4 deletions(-)",
            "agent_summary": "Implemented `prompt_lookup_decoding` as a draft provider reusing the speculative verifier. Greedy parity verified on 20 prompts; 91 tests pass.",
            "pr_url": None,
        }
        self._plan_events(eid, created, spec, triage_id, approved)
        eval_end = ago(days=1, hours=20, minutes=2)
        self.job(f"resume-{eid}", "experiment.resume", {"experiment_id": eid, "resume": {"decision": "approve", "comment": None}}, approved,
                 finished=eval_end + timedelta(minutes=2), experiment_id=eid)
        self._build_events(eid, approved + timedelta(seconds=10), branch, spec["flag_name"], files, build_log)
        smoke_start = approved + timedelta(minutes=10)
        smoke = make_results(spec["flag_name"], "long_prompt", 2, {"decode_tokens_per_s": 18.0}, 21,
                             {"baseline": {"exact_match": 0.78}, "variant": {"exact_match": 0.78}, "output_agreement": 1.0}, model="smoke")
        self._run(eid, "smoke", "done", smoke_start, smoke_start + timedelta(minutes=5), spec, smoke, folder)
        self._bench_events(eid, "smoke", smoke_start, spec, smoke_start + timedelta(minutes=5), 2)
        eval_start = smoke_start + timedelta(minutes=6)
        self.event(eval_start - timedelta(seconds=30), "waiting_gpu", "Waiting for the GPU (another benchmark is running)", experiment_id=eid, job=f"resume-{eid}")
        results = make_results(spec["flag_name"], "long_prompt", 10,
                               {"decode_tokens_per_s": 18.4, "itl_ms": 15.2, "e2e_latency_ms": 12.9, "ttft_ms": -1.8,
                                "throughput_tokens_per_s": 17.6, "peak_memory_gb": -0.4}, 303,
                               {"baseline": {"exact_match": 0.82}, "variant": {"exact_match": 0.82}, "output_agreement": 1.0})
        self._run(eid, "eval", "done", eval_start, eval_end, spec, results, folder)
        self._bench_events(eid, "eval", eval_start, spec, eval_end, 6)
        self._write_log(folder, f"eval-{eval_start:%Y%m%d-%H%M%S}.log", eval_log(results, spec), eval_end)
        verdict = self._verdict(eid, key, spec, build, branch, results, folder, eval_end + timedelta(minutes=1), project_id)
        self._verdict_event(eid, verdict, eval_end + timedelta(minutes=1))
        self._set(eid, branch=branch, worktree_path=f"/nonexistent/demo/r2e/worktrees/exp-{eid}", build=build)
        return eid

    def exp_running(self, project_id: int, triage_id: int) -> int:
        key = "c_chunked_prefill"
        created = ago(days=2, hours=2, minutes=39)
        spec = spec_for(
            hypothesis="Chunked prefill with decode piggybacking lowers itl_ms on concurrent_4 by at least 10%.",
            flag_name="chunked_prefill", technique_summary=self.claim_rows[key]["card"].technique,
            implementation_notes="In the scheduler hook, cap per-iteration tokens at 512; slice pending prefills into chunks batched with active decodes. "
            "Keep the prefill-first policy when the flag is off.",
            primary_metric="itl_ms", direction="lower_is_better", secondary_metrics=["ttft_ms", "throughput_tokens_per_s", "e2e_latency_ms"],
            workload="concurrent_4", model="eval", rounds=10, warmup=1, success_threshold_pct=10.0, claimed_gain_pct=46.0, lossless=True,
            guardrails={"max_exact_match_drop": 0.02, "min_output_agreement": 0.95, "max_peak_memory_increase_pct": 15.0},
            paper_vs_project="Paper ran 8–64 concurrent requests on an A100; concurrent_4 has far fewer streams, so stalls are rarer and the p99 gain will be smaller; TTFT may rise.",
        )
        approved = ago(minutes=50)
        eval_start = approved + timedelta(minutes=17)
        eid = self._experiment(project_id, key, "running", created, eval_start, triage_id=triage_id, spec=spec)
        branch = f"r2e/exp-{eid}-chunked-prefill"
        folder = self._artifacts(eid)
        files = ["src/inference_lab/scheduler/chunked.py", "src/inference_lab/techniques/chunked_prefill.py", "tests/test_chunked_prefill.py"]
        build_log = ("Reading AGENTS.md and lab.yaml\nAdding token budget (512) to IterationScheduler\n"
                     "Prefill slicing with partial KV carry-over\nTests: chunk boundaries, flag-off ordering, greedy parity\nuv run pytest -q → 89 passed\n")
        log_path = self._write_log(folder, "build-attempt-1.log", build_log, approved + timedelta(minutes=9))
        build = {
            "builder": "copilot",
            "attempts": [{"attempt": 1, "agent_exit": 0, "duration_s": 468.0, "problems": [], "log": log_path}],
            "files": files,
            "diff_stat": " src/inference_lab/scheduler/chunked.py          | 121 ++++++++++++\n"
            " src/inference_lab/techniques/chunked_prefill.py |  58 ++++++\n"
            " tests/test_chunked_prefill.py                   |  84 ++++++++\n"
            " 3 files changed, 263 insertions(+)",
            "agent_summary": "Implemented `chunked_prefill` (512-token iteration budget). 89 tests pass.",
        }
        self._plan_events(eid, created, spec, triage_id, approved)
        self.job(f"resume-{eid}", "experiment.resume",
                 {"experiment_id": eid, "resume": {"decision": "approve", "comment": "Use concurrent_4; ITL is what users feel."}},
                 approved, status="running", experiment_id=eid)
        self._build_events(eid, approved + timedelta(seconds=10), branch, spec["flag_name"], files, build_log)
        smoke_start = approved + timedelta(minutes=10)
        smoke = make_results(spec["flag_name"], "concurrent_4", 2, {"itl_ms": 14.0}, 31,
                             {"baseline": {"exact_match": 0.8}, "variant": {"exact_match": 0.8}, "output_agreement": 1.0}, model="smoke")
        self._run(eid, "smoke", "done", smoke_start, smoke_start + timedelta(minutes=6), spec, smoke, folder)
        self._bench_events(eid, "smoke", smoke_start, spec, smoke_start + timedelta(minutes=6), 2)
        self._run(eid, "eval", "running", eval_start, None, spec, {}, folder)
        self._bench_events(eid, "eval", eval_start, spec, None, 11)
        lines = "\n".join(
            f"[{(eval_start + timedelta(minutes=2.5 * i)):%H:%M:%S}] round {(i + 1) // 2}/10 {'baseline' if i % 2 else 'variant'}: "
            f"itl_ms p50={38.5 - (4.9 if i % 2 == 0 else 0):.1f}"
            for i in range(1, 12)
        )
        self._write_log(folder, f"eval-{eval_start:%Y%m%d-%H%M%S}.log",
                        f"$ bench ab --flags chunked_prefill --workload concurrent_4 --rounds 10\nloading Qwen/Qwen3-30B-A3B-Instruct-2507 (bfloat16) on mps\n{lines}\n",
                        ago(minutes=1))
        self._set(eid, branch=branch, worktree_path=f"/nonexistent/demo/r2e/worktrees/exp-{eid}", build=build)
        return eid

    def exp_building(self, project_id: int) -> int:
        key = "c_kivi"
        created = ago(hours=7, minutes=30)
        spec = spec_for(
            hypothesis="Asymmetric 2-bit KV quantization lowers peak_memory_gb on long_prompt by at least 10% without hurting exact match.",
            flag_name="kivi2_kv_quant", technique_summary=self.claim_rows[key]["card"].technique,
            implementation_notes="New QuantizedKVCache in the kv_cache hook: int2 K per-channel / V per-token, group 32, fp16 residual window of 128 tokens. "
            "Dequantize in PyTorch before SDPA (no custom kernel).",
            primary_metric="peak_memory_gb", direction="lower_is_better", secondary_metrics=["decode_tokens_per_s", "itl_ms"],
            workload="long_prompt", model="eval", rounds=8, warmup=1, success_threshold_pct=10.0, claimed_gain_pct=61.54, lossless=False,
            guardrails={"max_exact_match_drop": 0.02, "min_output_agreement": None, "max_peak_memory_increase_pct": 15.0},
            paper_vs_project="Paper reports KV memory alone; on the project peak memory includes ~30 GB of weights, so the end-to-end reduction will be far smaller than 2.6x.",
        )
        eid = self._experiment(project_id, key, "building", created, ago(minutes=12), spec=spec)
        branch = f"r2e/exp-{eid}-kivi2-kv-quant"
        folder = self._artifacts(eid)
        approved = ago(hours=1, minutes=5)
        self._plan_events(eid, created, spec, None, approved)
        job = f"resume-{eid}"
        self.job(job, "experiment.resume", {"experiment_id": eid, "resume": {"decision": "approve", "comment": None}}, approved, status="running", experiment_id=eid)
        self.event(approved + timedelta(seconds=10), "build", f"Worktree ready on branch {branch}", experiment_id=eid, job=job)
        self.event(approved + timedelta(seconds=25), "build", "Installing the project environment in the experiment worktree", experiment_id=eid, job=job)
        self._write_log(folder, "install.log", "$ uv sync --frozen\nResolved 64 packages\nInstalled 64 packages in 9.8s\n", approved + timedelta(minutes=1))
        self.event(approved + timedelta(minutes=1), "build", "copilot is implementing `kivi2_kv_quant` (attempt 1/3)", experiment_id=eid, job=job)
        a1 = ("Reading AGENTS.md and lab.yaml\nAdding QuantizedKVCache (int2 packing via uint8 lanes)\n"
              "Wiring into kv_cache registry under kivi2_kv_quant\nuv run pytest -q → 1 failed: test_flags_registered\n")
        p1 = self._write_log(folder, "build-attempt-1.log", a1, approved + timedelta(minutes=19))
        for i, line in enumerate(a1.splitlines()[:3]):
            self.event(approved + timedelta(minutes=3 + 4 * i), "build", f"copilot: {line}", experiment_id=eid, job=job)
        problem = "Technique `kivi2_kv_quant` is not registered (list_flags: ['paged_kv', 'speculative_draft', 'sdpa_fused'])."
        self._write_log(folder, "verify-attempt-1.log", problem + "\n", approved + timedelta(minutes=20))
        self.event(approved + timedelta(minutes=20), "build", f"Verification failed: {problem}", experiment_id=eid, job=job, level="warning")
        self.event(approved + timedelta(minutes=21), "build", "copilot is implementing `kivi2_kv_quant` (attempt 2/3)", experiment_id=eid, job=job)
        a2 = ("Fixing registration: add @register_technique('kivi2_kv_quant') in techniques/__init__.py\n"
              "Adding per-group scale/zero tensors in fp16\nRunning focused tests: tests/test_kivi2.py ...\n")
        for i, line in enumerate(a2.splitlines()):
            self.event(approved + timedelta(minutes=24 + 6 * i), "build", f"copilot: {line}", experiment_id=eid, job=job)
        self._write_log(folder, "build-attempt-2.log",
                        a2 + "tests/test_kivi2.py::test_roundtrip_error PASSED\ntests/test_kivi2.py::test_residual_window PASSED\n", ago(minutes=2))
        self._set(eid, branch=branch, worktree_path=f"/nonexistent/demo/r2e/worktrees/exp-{eid}",
                  build={"builder": "copilot", "attempts": [{"attempt": 1, "agent_exit": 0, "duration_s": 1104.2, "problems": [problem], "log": p1}]})
        return eid

    def exp_awaiting_approval(self, project_id: int, triage_id: int, key: str, created: datetime) -> int:
        if key == "c_lookahead":
            spec = spec_for(
                hypothesis="Lookahead (Jacobi) decoding improves decode_tokens_per_s on short_chat by at least 8% with identical greedy outputs.",
                flag_name="lookahead_decoding", technique_summary=self.claim_rows[key]["card"].technique,
                implementation_notes="Implement LookaheadDecoder in the decode_step hook with W=5, N=4 and an n-gram pool keyed by first token (max 64 "
                "candidates). Build the combined lookahead + verify attention mask as a boolean tensor and pass it to SDPA on MPS. "
                "Flag off: the default greedy loop must be untouched. Pitfall: MPS SDPA falls back to the math kernel with arbitrary masks — measure the overhead.",
                primary_metric="decode_tokens_per_s", direction="higher_is_better", secondary_metrics=["itl_ms", "e2e_latency_ms", "peak_memory_gb"],
                workload="short_chat", model="eval", rounds=10, warmup=1, success_threshold_pct=8.0, claimed_gain_pct=31.0, lossless=True,
                guardrails={"max_exact_match_drop": 0.02, "min_output_agreement": 0.95, "max_peak_memory_increase_pct": 15.0},
                paper_vs_project="Paper: dense Llama-3-8B on MLX (M3 Max). Here: Qwen3-30B-A3B MoE on PyTorch MPS (M5 Pro). Extra lookahead tokens activate more experts per step, so the per-step cost grows faster than for a dense model; expect a smaller gain.",
            )
        elif key == "c_tree_mask":
            spec = spec_for(
                hypothesis="Verifying a small draft tree with an ancestor-only attention mask improves decode_tokens_per_s on short_chat by at least 5%.",
                flag_name="tree_verify_mask", technique_summary=self.claim_rows[key]["card"].technique,
                implementation_notes="Extend speculative_draft's verify step to take a flattened 2-branch tree (top-2 at depth 1, chains below) with a boolean "
                "ancestry mask and depth-based position ids passed to SDPA. Flag off: single-chain verification as today. Pitfall: MPS SDPA uses the math "
                "kernel with arbitrary masks — keep the tree under 16 nodes.",
                primary_metric="decode_tokens_per_s", direction="higher_is_better", secondary_metrics=["itl_ms", "peak_memory_gb"],
                workload="short_chat", model="eval", rounds=10, warmup=1, success_threshold_pct=5.0, claimed_gain_pct=None, lossless=True,
                guardrails={"max_exact_match_drop": 0.02, "min_output_agreement": 0.95, "max_peak_memory_increase_pct": 15.0},
                paper_vs_project="Paper: Vicuna-13B on an H100 with 64-node trees. Here: Qwen3-30B-A3B on MPS, where a masked SDPA call is slower; "
                "a small tree is the safe first step before the dynamic tree (chained experiment).",
            )
        else:
            raise ValueError(f"no Gate 2 fixture for {key}")
        eid = self._experiment(project_id, key, "awaiting_approval", created, created + timedelta(minutes=2), triage_id=triage_id, spec=spec)
        self._artifacts(eid)
        self._plan_events(eid, created, spec, triage_id, None)
        return eid

    def exp_rerun(self, project_id: int, old_id: int, comment: str) -> int:
        """Re-run (service.rerun_experiment, replan=false): same claim and spec on the current code, waiting at Gate 2."""
        from paperatlas.db.engine import session_scope
        from paperatlas.db.schema import Experiment

        with session_scope() as session:
            old = session.get(Experiment, old_id)
            key = next(k for k, claim_id in self.claims.items() if claim_id == old.claim_id)
            spec = {**{k: v for k, v in (old.spec or {}).items() if k != "prediction"}, "prediction": None}
            triage_id = old.triage_id
        created = ago(minutes=30)
        eid = self._experiment(project_id, key, "awaiting_approval", created, created + timedelta(seconds=20), triage_id=triage_id, spec=spec,
                               thread_id=f"exp-demo-{key}-rerun")
        self._set(eid, rerun_of_experiment_id=old_id)
        self._artifacts(eid)
        job = f"run-{eid}"
        self.job(job, "experiment.run", {"experiment_id": eid}, created, finished=created + timedelta(seconds=20), experiment_id=eid)
        self.event(created, "plan", f"Re-run of #{old_id}: reusing its spec (review it at Gate 2) — {comment}", experiment_id=eid)
        self.event(created, "plan", f"Re-run started as #{eid} — {comment}", experiment_id=old_id)
        self.event(created + timedelta(seconds=15), "approve", f"Spec copied from #{old_id} — waiting for approval (Gate 2)", {"spec": spec},
                   experiment_id=eid, job=job)
        return eid

    def exp_chain_and_bundle(self, project_id: int, triage_id: int, failed_prerequisite: int) -> None:
        """Gate 1 modes: a chain (prerequisite awaiting approval → dependent blocked), a blocked dependent whose
        prerequisite was not merged, and a bundle experiment implementing a claim together with its partner."""
        created = ago(minutes=40)
        first = self.exp_awaiting_approval(project_id, triage_id, "c_tree_mask", created)
        self._set(first, mode="chain")
        dependent = self._experiment(project_id, "c_dyn_tree", "blocked", created, created, triage_id=triage_id)
        self._set(dependent, mode="chain", depends_on_experiment_id=first)
        self.event(created, "plan", "Experiment created (chain): waits for its prerequisite experiment to be merged",
                   experiment_id=dependent, triage_id=triage_id)

        created = ago(days=3, hours=21)
        orphan = self._experiment(project_id, "c_split_heuristic", "blocked", created, ago(days=3, hours=20),
                                  error=f"plan: prerequisite experiment #{failed_prerequisite} was not merged — retry to run without it")
        self._set(orphan, mode="chain", depends_on_experiment_id=failed_prerequisite)
        self.event(created, "plan", "Experiment created (chain): waits for its prerequisite experiment to be merged", experiment_id=orphan)
        self.event(ago(days=3, hours=20), "plan", f"Prerequisite #{failed_prerequisite} was not merged", experiment_id=orphan, level="warning")

        created = ago(minutes=6)
        bundle = self._experiment(project_id, "c_awq", "planning", created, created + timedelta(seconds=20), triage_id=triage_id)
        self._set(bundle, mode="bundle", bundle_claim_ids=[self.claims["c_awq_clip"]])
        job = f"run-{bundle}"
        self.job(job, "experiment.run", {"experiment_id": bundle}, created, status="running", experiment_id=bundle)
        self.event(created, "plan", "Experiment created (Gate 1: claim picked, bundle)", experiment_id=bundle, triage_id=triage_id)
        self.event(created + timedelta(seconds=15), "plan", "Writing the experiment spec (bundle: AWQ scaling + per-group clipping)",
                   experiment_id=bundle, job=job)

    def flush_jobs_and_events(self) -> None:
        from paperatlas.db.engine import session_scope
        from paperatlas.db.schema import Event, Job

        extra = [
            ("topics.refresh", {"use_llm": True}, ago(days=2, hours=3, minutes=1)),
            ("discover", {"topics": None, "per_topic": 5, "expand": True}, ago(days=1, hours=3)),
            ("distill", {"limit": 30, "paper_ids": None, "reprocess": False, "use_llm": True}, ago(days=1, hours=2, minutes=40)),
            ("match", {"project_id": 1, "use_llm": True}, ago(hours=1)),
        ]
        for index, (kind, payload, at) in enumerate(extra):
            self.job(f"extra-{index}", kind, payload, at, finished=at + timedelta(minutes=6), result={"ok": True})
        job_ids: dict[str, int] = {}
        with session_scope() as session:
            for item in sorted(self.jobs, key=lambda j: j["created_at"]):
                job = Job(**{k: v for k, v in item.items() if k != "key"})
                session.add(job)
                session.flush()
                job_ids[item["key"]] = job.id
            for item in sorted(self.events, key=lambda e: e["created_at"]):
                key = item.pop("job")
                session.add(Event(job_id=job_ids.get(key) if key else None, **item))
                session.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="store_true", help="allow a database whose name does not end with _ui (it will be wiped!)")
    args = parser.parse_args()

    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
    from paperatlas.settings import data_dir, database_url

    url = database_url()
    db_name = url.rsplit("/", 1)[-1].split("?", 1)[0]
    if not db_name.endswith("_ui") and not args.force:
        print(f"Refusing to seed {url!r}: the database name must end with '_ui' (or pass --force). "
              "This script wipes research.* and lab.* tables.", file=sys.stderr)
        return 2

    from paperatlas.db import migrate

    print(f"Migrating {url} ...")
    migrate.upgrade()
    seeder = Seeder()
    seeder.run()
    print(f"Seeded {len(PAPERS)} papers, {len(seeder.claims)} claim cards, {seeder.experiments} experiments, 3 triage runs, {seeder.links} concept links, "
          f"{len(seeder.jobs)} jobs and {len(seeder.events)} events into {db_name}.")
    print(f"Artifacts (reports, logs): {data_dir().resolve() / 'r2e' / 'experiments'}")
    if seeder.skipped_artifacts:
        print(f"WARNING: left existing non-demo artifacts untouched for experiments {seeder.skipped_artifacts} "
              "(set PAPERATLAS_DATA_DIR to an empty folder to get demo reports/logs).", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
