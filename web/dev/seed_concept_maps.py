"""Concept-map fixtures for seed_demo.py: extra concepts, typed links, reading order, roles and result bundles.

Mirrors what paperatlas.distill.concept_map.map_paper stores: `concepts.paper_order` / `concepts.role`,
`research.concept_links` rows and `papers.concept_map` ({order, roles, bundles, reading_path, ...}).
Relation semantics: A requires B = A needs B first; A builds_on B = A extends B; A evaluated_by B = B measures A;
complements / alternative_to are symmetric.
"""

from __future__ import annotations

from typing import Any


def _effect(metric: str, value: Any, unit: Any, direction: str, baseline: str = "", conditions: str = "") -> dict:
    return {"metric": metric, "value": value, "unit": unit, "direction": direction, "baseline": baseline or None, "conditions": conditions or None}


def _setup(hardware: str, model: str, framework: str, batch: str, seq: str, dataset: str) -> dict:
    return {"hardware": hardware, "model": model, "framework": framework, "batch_size": batch, "sequence_length": seq, "dataset": dataset}


# Extra concepts so a few papers have a richer (5–6 concept) map. Same shape as PAPERS[*]["concepts"].
EXTRA_CONCEPTS: dict[str, list[dict[str, Any]]] = {
    "arxiv:2609.01432": [
        {
            "key": "c_tree_mask", "name": "Tree attention mask for one-pass verification", "kind": "method",
            "summary": "Verify every branch of a draft tree in a single target forward pass by giving each drafted token an attention mask that only sees its own ancestors.",
            "key_points": ["Flatten the tree into one sequence", "Ancestor-only boolean mask", "Positions follow tree depth, not sequence index"],
            "card": {
                "testable": True, "category": "speculative_decoding",
                "technique": "Flatten the draft tree into one sequence and verify it in a single forward pass with an ancestor-only attention mask and depth-based position ids.",
                "change_required": "Let the speculative verify step accept a flattened token tree plus a boolean ancestry mask and per-token position ids (SDPA attn_mask on MPS).",
                "effects": [_effect("tokens verified per target pass", 1.6, "x", "increase", "single-chain verification", "Vicuna-13B, MT-Bench, batch 1")],
                "paper_setup": _setup("1x NVIDIA H100 80GB", "Vicuna-13B", "PyTorch", "1", "<= 2k", "MT-Bench"),
                "prerequisites": ["Draft-model speculative decoding path", "Attention that accepts an arbitrary boolean mask"],
                "effort": "low",
                "risks": ["MPS SDPA falls back to the math kernel with arbitrary masks"],
                "evidence": {"quote": "Verifying the flattened tree with an ancestor-only mask accepts 1.6x more tokens per target forward pass than a single draft chain.", "location": "Section 3.2"},
            },
            "match": {"similarity": 0.58, "target_metric": "decode_tokens_per_s",
                      "rationale": "speculative_draft verifies a single chain today; a tree mask is a small, contained change to the verify step and is the foundation the dynamic tree builds on."},
        },
        {
            "key": "c_accept_eval", "name": "Acceptance length per verify pass", "kind": "evaluation",
            "summary": "Average number of drafted tokens accepted per target forward pass — the paper's main efficiency metric, independent of hardware speed.",
            "key_points": ["Reported per benchmark", "Rises from 3.62 to 4.71 with dynamic trees"],
            "card": {
                "testable": False, "category": "evaluation_quality",
                "technique": "Report the mean number of accepted draft tokens per verification pass alongside wall-clock speed-up.",
                "change_required": "Log accepted tokens per verify step in the speculative decoder.",
                "effects": [_effect("metric definition", None, None, "none")],
                "paper_setup": _setup("1x NVIDIA H100 80GB", "Vicuna-13B, LLaMA-3.1-8B", "PyTorch", "1", "<= 2k", "MT-Bench, HumanEval, GSM8K"),
                "prerequisites": [],
                "effort": "low",
                "risks": [],
                "evidence": {"quote": "Average acceptance length increases from 3.62 to 4.71 tokens.", "location": "Table 3"},
            },
            "match": {"similarity": 0.35, "target_metric": None, "rationale": None},
        },
        {
            "key": "c_batch_limit", "name": "Gains shrink at large batch sizes", "kind": "finding",
            "summary": "At batch sizes above 16 the GPU is compute-bound and the extra verification work of a large tree cancels most of the speed-up.",
            "key_points": ["1.38x at batch 1", "1.05x at batch 32"],
            "card": {
                "testable": False, "category": "speculative_decoding",
                "technique": "Limit or disable tree speculation when the batch is large.",
                "change_required": "Gate the dynamic tree on the current batch size.",
                "effects": [_effect("speed-up at batch 32", None, None, "none", "", "qualitative")],
                "paper_setup": _setup("1x NVIDIA H100 80GB", "Vicuna-13B", "PyTorch", "1-32", "<= 2k", "MT-Bench"),
                "prerequisites": [],
                "effort": "low",
                "risks": [],
                "evidence": {"quote": "The speed-up falls to 1.05x at batch size 32, where verification is compute-bound.", "location": "Figure 6"},
            },
            "match": {"similarity": 0.3, "target_metric": None, "rationale": None},
        },
    ],
    "arxiv:2608.05219": [
        {
            "key": "c_split_heuristic", "name": "Per-head split-count heuristic", "kind": "algorithm",
            "summary": "Pick the number of KV splits per attention head from context length and GPU occupancy instead of a fixed split count.",
            "key_points": ["splits = ceil(ctx / 2048) capped by free cores", "No tuning per model"],
            "card": {
                "testable": True, "category": "attention_kernels",
                "technique": "Choose the split-K factor per decode step from the context length and the number of idle compute units.",
                "change_required": "Compute the split count in the split-K decode attention path instead of using a constant.",
                "effects": [_effect("decode throughput at 32k context", 7, "%", "increase", "fixed 8 splits", "batch 1, 32k context")],
                "paper_setup": _setup("Apple M3 Max", "Llama-3-8B", "MLX", "1", "4k-32k", "synthetic long-context"),
                "prerequisites": ["Split-K flash decoding"],
                "effort": "low",
                "risks": ["Gains only visible at long context"],
                "evidence": {"quote": "Adapting the split count adds a further 7% at 32k tokens over a fixed eight-way split.", "location": "Section 5.3"},
            },
            "match": {"similarity": 0.5, "target_metric": "decode_tokens_per_s",
                      "rationale": "Only matters once split-K decoding exists in the long_prompt path; a one-function change on top of it."},
        },
    ],
}


def _link(source: str, target: str, relation: str, why: str, evidence: str | None = None) -> dict[str, Any]:
    return {"source": source, "target": target, "relation": relation, "why": why, "evidence": evidence}


def _bundle(name: str, keys: list[str], effect: str, headline: bool = False) -> dict[str, Any]:
    return {"name": name, "keys": keys, "effect": effect, "is_headline_result": headline}


# Per paper: reading order (concept keys), roles, links, bundles, reading path. Papers without an entry keep
# `concept_map` NULL (the UI then offers "Map concepts").
CONCEPT_MAPS: dict[str, dict[str, Any]] = {
    "arxiv:2609.01432": {
        "order": ["c_tree_mask", "c_dyn_tree", "c_feature_head", "c_tree_kernel", "c_accept_eval", "c_batch_limit"],
        "roles": {"c_tree_mask": "foundation", "c_dyn_tree": "core", "c_feature_head": "core", "c_tree_kernel": "optimization",
                  "c_accept_eval": "evaluation", "c_batch_limit": "limitation"},
        "links": [
            _link("c_dyn_tree", "c_tree_mask", "requires", "A dynamically shaped tree can only be verified in one pass if each drafted token attends to its own ancestors.", "Section 3.2"),
            _link("c_tree_kernel", "c_tree_mask", "builds_on", "The fused kernel computes the same ancestry mask on the fly instead of materialising it.", "Section 4.3"),
            _link("c_dyn_tree", "c_feature_head", "complements", "The feature-level head gives better-calibrated confidences, which is exactly what the dynamic tree uses to decide where to grow.", "Tables 2 and 3"),
            _link("c_dyn_tree", "c_accept_eval", "evaluated_by", "Acceptance length shows how much of the dynamic tree survives verification.", "Table 3"),
            _link("c_feature_head", "c_accept_eval", "evaluated_by", "A better drafter shows up directly as longer accepted runs.", "Table 2"),
            _link("c_dyn_tree", "c_batch_limit", "evaluated_by", "The batch-size sweep shows where dynamic trees stop paying off.", "Figure 6"),
        ],
        "bundles": [
            _bundle("Full EAGLE-4 (dynamic tree + feature head)", ["c_feature_head", "c_dyn_tree", "c_tree_mask"],
                    "3.05x over vanilla decoding on LLaMA-3.1-8B (MT-Bench, batch 1), lossless", headline=True),
            _bundle("Training-free dynamic tree", ["c_dyn_tree", "c_tree_mask"],
                    "1.38x decode speed-up over EAGLE-2's static tree with identical greedy outputs"),
        ],
        "reading_path": "Start with the tree attention mask (1) that lets one forward pass verify many branches, then the confidence-pruned dynamic tree (2) built on it. "
                        "The feature-level head (3) sharpens the confidences the tree relies on; the fused kernel (4) is an optional CUDA-only speed-up, and 5–6 show where the gains hold.",
    },
    "arxiv:2608.11873": {
        "order": ["c_prompt_lookup", "c_adaptive_ngram"],
        "roles": {"c_prompt_lookup": "core", "c_adaptive_ngram": "extension"},
        "links": [
            _link("c_adaptive_ngram", "c_prompt_lookup", "builds_on", "Adapts the n-gram length and draft cap of the basic prompt-lookup drafter from recent acceptance.", "Section 4"),
        ],
        "bundles": [
            _bundle("Adaptive prompt lookup", ["c_prompt_lookup", "c_adaptive_ngram"], "+12% accepted tokens per step over fixed n=3, k=10 on summarisation", headline=True),
        ],
        "reading_path": "Implement plain prompt lookup (1) first; the adaptive n-gram caps (2) only tune how much it drafts.",
    },
    "arxiv:2610.04521": {
        "order": ["c_kivi", "c_kivi_kernel"],
        "roles": {"c_kivi": "core", "c_kivi_kernel": "optimization"},
        "links": [
            _link("c_kivi_kernel", "c_kivi", "requires", "The kernel reads the asymmetric int2 layout (per-channel K, per-token V) produced by the quantizer.", "Section 4.1"),
        ],
        "bundles": [
            _bundle("KIVI with fused kernel", ["c_kivi", "c_kivi_kernel"], "37% lower attention latency at 4k context (batch 32) with 2-bit KV", headline=True),
        ],
        "reading_path": "The quantization scheme (1) is the contribution; the fused kernel (2) is what turns the memory saving into speed on CUDA.",
    },
    "arxiv:2607.09314": {
        "order": ["c_sinks", "c_h2o"],
        "roles": {"c_sinks": "foundation", "c_h2o": "core"},
        "links": [
            _link("c_h2o", "c_sinks", "requires", "Evicting the first tokens makes perplexity explode, so the eviction policy must always keep the attention sinks.", "Section 3.1"),
        ],
        "bundles": [],
        "reading_path": "Understand why the first tokens act as attention sinks (1) before choosing which other tokens to evict (2).",
    },
    "arxiv:2609.13377": {
        "order": ["c_chunked_prefill", "c_slo_chunk"],
        "roles": {"c_chunked_prefill": "core", "c_slo_chunk": "extension"},
        "links": [
            _link("c_slo_chunk", "c_chunked_prefill", "builds_on", "Sizes each prefill chunk from the decode SLO slack instead of a fixed 512 tokens.", "Section 5"),
        ],
        "bundles": [
            _bundle("SLO-aware chunked prefill", ["c_chunked_prefill", "c_slo_chunk"], "+18% goodput within SLO on the ShareGPT trace", headline=True),
        ],
        "reading_path": "Chunked prefill with decode piggybacking (1) first; the SLO-slack chunk size (2) tunes it per request mix.",
    },
    "arxiv:2610.00218": {
        "order": ["c_lookahead", "c_lookahead_tuning"],
        "roles": {"c_lookahead": "core", "c_lookahead_tuning": "optimization"},
        "links": [
            _link("c_lookahead_tuning", "c_lookahead", "builds_on", "Chooses the lookahead window and n-gram size from memory bandwidth rather than the default W=15, N=5.", "Section 6"),
        ],
        "bundles": [
            _bundle("Tuned lookahead decoding", ["c_lookahead", "c_lookahead_tuning"], "1.31x decode throughput on M3 Max, +9% more with the tuned window", headline=True),
        ],
        "reading_path": "Lookahead decoding (1) is the method; the bandwidth-aware window (2) adapts it to Apple silicon.",
    },
    "arxiv:2608.05219": {
        "order": ["c_split_k", "c_split_heuristic", "c_split_switch"],
        "roles": {"c_split_k": "core", "c_split_heuristic": "optimization", "c_split_switch": "limitation"},
        "links": [
            _link("c_split_heuristic", "c_split_k", "requires", "The heuristic only chooses how many splits the split-K decode kernel uses.", "Section 5.3"),
            _link("c_split_k", "c_split_switch", "evaluated_by", "The context-length sweep shows split-K only pays off above ~4k tokens.", "Figure 4"),
        ],
        "bundles": [
            _bundle("Split-K with adaptive splits", ["c_split_k", "c_split_heuristic"], "+24% decode throughput at 32k context, +7% more with adaptive splits", headline=True),
        ],
        "reading_path": "Split-K decoding (1) first, then the per-head split heuristic (2); the switch-over finding (3) says when to turn it on.",
    },
    "arxiv:2609.08870": {
        "order": ["c_radix", "c_cache_order"],
        "roles": {"c_radix": "foundation", "c_cache_order": "core"},
        "links": [
            _link("c_cache_order", "c_radix", "requires", "Ordering requests by shared prefix only helps if a prefix cache can reuse their KV.", "Section 3.3"),
        ],
        "bundles": [
            _bundle("RadixCache + cache-aware ordering", ["c_radix", "c_cache_order"], "1.2x throughput with 16 concurrent requests vs FCFS", headline=True),
        ],
        "reading_path": "The radix-tree prefix cache (1) is the foundation; cache-aware ordering (2) raises its hit rate.",
    },
    "arxiv:2610.11002": {
        "order": ["c_splitwise", "c_layer_stream"],
        "roles": {"c_splitwise": "core", "c_layer_stream": "optimization"},
        "links": [
            _link("c_layer_stream", "c_splitwise", "requires", "Streaming KV layer by layer only exists when prefill and decode run on separate machines.", "Section 4"),
        ],
        "bundles": [],
        "reading_path": "Phase splitting (1) defines the architecture; layer-wise streaming (2) hides its KV transfer cost.",
    },
    "arxiv:2607.12245": {
        "order": ["c_awq", "c_awq_clip"],
        "roles": {"c_awq": "core", "c_awq_clip": "extension"},
        "links": [
            _link("c_awq", "c_awq_clip", "complements", "Activation-aware scaling and per-group clipping are applied together to reach the reported perplexity.", "Table 4"),
        ],
        "bundles": [
            _bundle("AWQ with clipping", ["c_awq", "c_awq_clip"], "3.1% lower perplexity than without clipping on WikiText-2 (4-bit)", headline=True),
        ],
        "reading_path": "Read the activation-aware scaling (1) first; clipping (2) is a small search applied on top.",
    },
    "patent:US20260183311A1": {
        "order": ["c_draft_len", "c_batched_verify"],
        "roles": {"c_draft_len": "core", "c_batched_verify": "extension"},
        "links": [
            _link("c_draft_len", "c_batched_verify", "alternative_to", "Claim 14 describes batched verification as an alternative embodiment to tuning each request's draft length.", "Claims 12 and 14"),
        ],
        "bundles": [],
        "reading_path": "Claim 12 (1) is the main embodiment; claim 14 (2) is an alternative for concurrent serving.",
    },
}


def apply_concept_maps(session: Any, claims: dict[str, int], stamp_at: Any) -> int:
    """Write roles/order, concept_links and papers.concept_map for every paper in CONCEPT_MAPS. Returns #links."""
    from paperatlas.db.schema import Claim, Concept, ConceptLink, Paper

    concept_of = {key: session.get(Claim, claim_id).concept_id for key, claim_id in claims.items()}
    links = 0
    for paper_id, data in CONCEPT_MAPS.items():
        order = [concept_of[key] for key in data["order"]]
        for position, key in enumerate(data["order"], start=1):
            concept = session.get(Concept, concept_of[key])
            concept.paper_order = position
            concept.role = data["roles"].get(key)
        for link in data["links"]:
            session.add(ConceptLink(paper_id=paper_id, source_concept_id=concept_of[link["source"]], target_concept_id=concept_of[link["target"]],
                                    relation=link["relation"], why=link["why"], evidence=link["evidence"]))
            links += 1
        session.get(Paper, paper_id).concept_map = {
            "order": order,
            "roles": {str(concept_of[key]): role for key, role in data["roles"].items()},
            "bundles": [{"name": b["name"], "concept_ids": [concept_of[k] for k in b["keys"]], "effect": b["effect"],
                         "is_headline_result": b["is_headline_result"]} for b in data["bundles"]],
            "reading_path": data["reading_path"],
            "generated_at": stamp_at.isoformat(),
            "model": "gpt-5-mini (demo fixture)",
        }
    return links
