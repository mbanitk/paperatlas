"""Explainer fixtures for web/dev/seed_demo.py (topic overviews, paper summaries, claim explanations
with flow diagrams) plus a few background papers per topic so the topic infographics have data.

Shapes follow paperatlas.r2e.explainers (CLAIM/PAPER/TOPIC_EXPLAINER_SCHEMA + clean_diagram).
A few items are deliberately left without an explainer so the "Generate explanation" states show.
"""

from __future__ import annotations

from datetime import date
from typing import Any


def dg(title: str, nodes: list[tuple], edges: list[tuple]) -> dict[str, Any]:
    return {
        "title": title,
        "nodes": [{"id": n[0], "label": n[1], "kind": n[2], "highlight": bool(n[3]) if len(n) > 3 else False} for n in nodes],
        "edges": [
            {"from": e[0], "to": e[1], "label": e[2] if len(e) > 2 else None, "style": e[3] if len(e) > 3 else "normal"} for e in edges
        ],
    }


# ---- topics -------------------------------------------------------------------------------

TOPIC_EXPLAINERS: dict[str, dict[str, Any]] = {
    "speculative-decoding-dynamic-drafts": {
        "summary": "Speculative decoding drafts several tokens cheaply and lets the large model verify them in one pass, so fewer sequential "
        "large-model steps are needed. Recent work makes the drafts adaptive: trees that grow where the drafter is confident, "
        "model-free drafts copied from the prompt, and draft lengths tuned to the acceptance rate.",
        "why_now": "Decode on single machines is memory-bandwidth bound, so verifying several tokens per weight read is almost free; "
        "papers this autumn report 1.3–1.4x lossless speed-ups without retraining.",
        "key_ideas": [
            {"name": "Dynamic draft trees", "one_liner": "Expand the draft tree only where the drafter is confident, so verification compute follows difficulty."},
            {"name": "Model-free drafts", "one_liner": "Copy continuations from the prompt (n-gram lookup) or from Jacobi iterations instead of running a draft model."},
            {"name": "Adaptive draft length", "one_liner": "Choose how many tokens to draft each step from the recent acceptance rate."},
            {"name": "Lossless verification", "one_liner": "Greedy outputs stay identical because the target model checks every drafted token."},
        ],
        "typical_gains": "1.31x decode throughput (lookahead, M3 Max), 1.38x over EAGLE-2 (dynamic trees, H100), +45% on input-grounded tasks (prompt lookup).",
        "open_problems": [
            "Gains shrink with batching: verification work grows with concurrent requests.",
            "Mixture-of-experts targets activate more experts for drafted tokens, raising the per-step cost.",
            "Tree attention masks are slow on backends without fused masked attention.",
        ],
        "relevance": "High — single-stream decode on an M5 Pro is bandwidth-bound and the project already has a draft-model speculative decoder, "
        "so most ideas plug into the decode_step hook without new kernels.",
    },
    "kv-cache-quantization-eviction": {
        "summary": "Shrinks the KV cache — the per-token keys and values attention keeps around — by storing it in fewer bits or by evicting "
        "tokens that attention rarely uses. Both trade a little accuracy for much less memory and bandwidth.",
        "why_now": "Long prompts and multi-turn chats make the KV cache, not the weights, the memory bottleneck; tuning-free 2-bit schemes "
        "and attention-guided eviction now report small quality loss.",
        "key_ideas": [
            {"name": "Asymmetric low-bit KV", "one_liner": "Quantize keys per channel and values per token, keeping recent tokens in full precision."},
            {"name": "Heavy-hitter eviction", "one_liner": "Keep attention sinks, a recent window and the most-attended tokens; drop the rest."},
            {"name": "Residual windows", "one_liner": "A short full-precision window protects the tokens the model attends to most."},
        ],
        "typical_gains": "2.6x less KV memory (KIVI-2, 2-bit), 5x less KV memory and +29% decode at 8k context (H2O-Lite, 20% budget).",
        "open_problems": [
            "Eviction can drop the one token a retrieval question needs (needle-in-a-haystack).",
            "Dequantization cost can cancel the bandwidth win at batch 1 without fused kernels.",
        ],
        "relevance": "Medium-high — 64 GB of unified memory is shared by weights and KV, so memory wins are directly measurable; throughput "
        "gains depend on attention kernels the project does not have yet.",
    },
    "chunked-prefill-scheduling": {
        "summary": "Iteration-level schedulers decide which tokens run in each forward pass. Chunked prefill splits long prompts into small "
        "pieces that ride along with ongoing decodes, so a long prompt never freezes other users' token streams.",
        "why_now": "Interactive serving is judged on tail inter-token latency; stall-free batching papers show large p99 improvements on mixed traces.",
        "key_ideas": [
            {"name": "Token budget per iteration", "one_liner": "Cap how many tokens a forward pass may process and fill it with decodes first."},
            {"name": "Decode piggybacking", "one_liner": "Batch prefill chunks with active decode tokens in the same pass."},
            {"name": "SLO-aware chunk size", "one_liner": "Grow chunks when decodes have latency slack, shrink them near the SLO."},
        ],
        "typical_gains": "−46% p99 inter-token latency at the cost of +9% median TTFT; +18% goodput with SLO-aware chunks.",
        "open_problems": ["Benefits shrink at low concurrency.", "Choosing the token budget per device needs calibration."],
        "relevance": "Medium — only the concurrent_4 workload mixes long prompts with active decodes; single-stream workloads see no change.",
    },
    "low-bit-weight-quantization": {
        "summary": "Stores model weights in 4 bits instead of 16 and dequantizes them inside the matrix multiply. On bandwidth-bound "
        "hardware fewer bytes per token means faster decode.",
        "why_now": "Activation-aware methods now keep accuracy within half a point at 4 bits, and Metal/MLX int4 kernels make it practical on Macs.",
        "key_ideas": [
            {"name": "Activation-aware scaling", "one_liner": "Protect the few weight channels that see large activations before rounding."},
            {"name": "Group quantization", "one_liner": "Share one scale per 128 weights to keep error local."},
            {"name": "Clipping search", "one_liner": "Pick per-group clipping that minimises layer output error."},
        ],
        "typical_gains": "+35% decode throughput and 2.9x less weight memory (AWQ-Metal, M2 Max).",
        "open_problems": ["Mixture-of-experts weights need per-expert calibration.", "Needs an int4 matmul on MPS."],
        "relevance": "High — decode on the M5 Pro is bandwidth-bound and the model_loader hook supports load-time transforms.",
    },
    "prefix-caching-multi-turn": {
        "summary": "Multi-turn chats resend the whole conversation every turn. Prefix caching keeps the KV of earlier turns and reuses it, so only the new message is prefilled.",
        "why_now": "Agents and chat apps resend long shared prefixes; radix-tree caches make reuse automatic.",
        "key_ideas": [
            {"name": "Radix-tree KV cache", "one_liner": "Index cached KV blocks by token ids and match the longest prefix."},
            {"name": "Cache-aware ordering", "one_liner": "Schedule requests that share cached prefixes together to raise the hit rate."},
        ],
        "typical_gains": "−52% time to first token on multi-turn chat; 1.2x throughput with cache-aware ordering.",
        "open_problems": ["Cached prefixes compete with active requests for memory."],
        "relevance": "High — short_chat is multi-turn; experiment #1 reproduced the TTFT win and was merged.",
    },
    "long-context-decode-kernels": {
        "summary": "At batch size one, attention over a long context cannot keep the GPU busy. Split-K kernels divide the context across many threadgroups and merge the partial results.",
        "why_now": "Long-context use grows and Metal ports of flash-decoding appeared this summer.",
        "key_ideas": [
            {"name": "Split-K attention", "one_liner": "Partition the KV sequence across threadgroups and reduce with log-sum-exp."},
            {"name": "Length switch-over", "one_liner": "Use the split kernel only above ~4k tokens."},
        ],
        "typical_gains": "+24% decode throughput at 32k context (M2 Ultra).",
        "open_problems": ["Numerical parity with SDPA in fp16.", "Custom Metal kernel tooling."],
        "relevance": "Medium — matches the hardware, but long_prompt peaks near 8k tokens and experiment #2 failed on parity.",
    },
    "disaggregated-prefill-decode": {
        "summary": "Runs prompt processing and token generation on separate GPU pools and streams the KV cache between them over fast networks.",
        "why_now": "Large deployments want to scale prefill and decode independently to meet latency SLOs at lower cost.",
        "key_ideas": [
            {"name": "Phase splitting", "one_liner": "Dedicated prefill and decode machines sized independently."},
            {"name": "Layer-wise KV streaming", "one_liner": "Send each layer's KV as soon as it is computed to hide transfer time."},
        ],
        "typical_gains": "1.4x throughput per dollar at equal SLOs on 8xH100 clusters.",
        "open_problems": ["Needs RDMA networking and many GPUs."],
        "relevance": "Low — requires multiple GPUs and RDMA; not testable on a single Mac.",
    },
}
# token-level-serving-telemetry is left without an explainer on purpose.

# ---- papers ---------------------------------------------------------------------------------

PAPER_EXPLAINERS: dict[str, dict[str, Any]] = {
    "arxiv:2609.01432": {
        "tldr": "EAGLE-4 grows the speculative draft tree per step from the drafter's confidence, raising accepted tokens per verification without changing outputs.",
        "problem": "Static draft trees waste verification on easy contexts and draft too little on hard ones, capping speculative decoding speed-ups.",
        "approach": [
            "Run the drafter and keep cumulative log-probabilities for each candidate branch.",
            "Expand the top-k branches per depth and prune those below a confidence threshold.",
            "Build the tree attention mask for the pruned tree.",
            "Verify the whole tree in one target forward pass and accept the longest valid path.",
        ],
        "key_results": [
            {"label": "Speed-up vs EAGLE-2", "value": "1.38x", "context": "Vicuna-13B, MT-Bench, batch 1, H100"},
            {"label": "Accepted length", "value": "4.71", "context": "tokens per step, up from 3.62"},
            {"label": "Speed-up vs vanilla", "value": "3.05x", "context": "with the trained feature-level head"},
        ],
        "novelty": "Tree shape adapts per step from drafter confidence instead of a fixed template.",
        "who_should_care": "Teams already running speculative decoding with a draft model.",
        "limitations": ["Measured on H100; mask construction may dominate on smaller GPUs.", "Best numbers need a trained draft head."],
        "diagram": dg(
            "Dynamic draft tree",
            [("p", "Context", "input"), ("d", "Draft model", "model"), ("t", "Confidence-pruned tree", "step", True), ("m", "Tree mask", "data", True), ("v", "Verify in one pass", "model"), ("o", "Accepted tokens", "output")],
            [("p", "d"), ("d", "t", "top-k"), ("t", "m"), ("m", "v"), ("v", "o"), ("v", "d", "next step", "loop")],
        ),
    },
    "arxiv:2608.11873": {
        "tldr": "Prompt lookup drafts tokens by copying from the prompt and verifies them in one pass — no draft model, identical outputs.",
        "problem": "Summaries, RAG answers and code edits copy long spans from the input, yet decoding still generates them one token at a time.",
        "approach": [
            "Take the last n generated tokens (n = 3, falling back to 1).",
            "Find the most recent match of that n-gram in the prompt.",
            "Propose the following up to 10 tokens as the draft.",
            "Verify all drafted tokens with one forward pass of the target model.",
        ],
        "key_results": [
            {"label": "Decode throughput", "value": "+45%", "context": "input-grounded tasks, greedy, Mistral-7B, A100"},
            {"label": "Accepted length gain", "value": "+12%", "context": "adaptive n-gram fallback vs fixed n=3"},
            {"label": "Output change", "value": "0", "context": "bit-identical greedy outputs"},
        ],
        "novelty": "Adds adaptive n-gram fallback and acceptance-aware draft caps to plain prompt lookup.",
        "who_should_care": "Anyone serving summarisation, RAG or code-editing traffic.",
        "limitations": ["Little gain on open-ended chat that does not copy the prompt."],
        "diagram": dg(
            "Prompt lookup decoding",
            [("p", "Prompt tokens", "input"), ("g", "Last n-gram", "step"), ("l", "Prompt lookup", "memory", True), ("v", "Verify drafts", "model"), ("o", "Accepted tokens", "output")],
            [("p", "l", "index"), ("g", "l", "match"), ("l", "v", "≤10 tokens"), ("v", "o"), ("o", "g", "next step", "loop")],
        ),
    },
    "arxiv:2610.04521": {
        "tldr": "KIVI-2 stores the KV cache in 2 bits — keys per channel, values per token — with no fine-tuning and little accuracy loss.",
        "problem": "The KV cache dominates memory for long contexts and large batches, limiting batch size and context length.",
        "approach": [
            "Quantize keys per channel to absorb outlier channels.",
            "Quantize values per token to bound attention output error.",
            "Keep the most recent 128 tokens in fp16 as a residual window.",
            "Dequantize on the fly inside attention.",
        ],
        "key_results": [
            {"label": "KV memory", "value": "2.6x less", "context": "Llama-2-13B, 4k context"},
            {"label": "Batch throughput", "value": "3.47x", "context": "larger batches fit, A100"},
            {"label": "Accuracy loss", "value": "<0.3 pts", "context": "LongBench, GSM8K average"},
        ],
        "novelty": "Tuning-free asymmetric 2-bit scheme with a residual full-precision window.",
        "who_should_care": "Memory-bound deployments serving long contexts or many users.",
        "limitations": ["Throughput gains rely on large batches.", "Fused kernels are Triton-only."],
        "diagram": dg(
            "2-bit KV cache",
            [("k", "New K/V", "data"), ("q", "Asymmetric 2-bit", "step", True), ("c", "Quantized KV cache", "memory", True), ("r", "fp16 recent window", "memory", True), ("a", "Attention", "model"), ("o", "Next token", "output")],
            [("k", "q"), ("k", "r", "last 128"), ("q", "c"), ("c", "a", "dequantize"), ("r", "a"), ("a", "o")],
        ),
    },
    "arxiv:2607.09314": {
        "tldr": "H2O-Lite keeps only attention sinks, a recent window and heavy-hitter tokens in the KV cache, cutting memory 5x on Apple silicon.",
        "problem": "On unified-memory laptops the KV cache of long contexts crowds out the model and slows decode.",
        "approach": [
            "Accumulate attention mass received by each cached token.",
            "Always keep the first 4 tokens (attention sinks) and a recent window.",
            "Keep the highest-scoring heavy hitters within a 20% budget.",
            "Evict everything else when the cache exceeds the budget.",
        ],
        "key_results": [
            {"label": "KV memory", "value": "5x less", "context": "20% budget, 8k context"},
            {"label": "Decode throughput", "value": "+29%", "context": "8k context, batch 1, M2 Max"},
        ],
        "novelty": "Revisits heavy-hitter eviction for unified-memory devices with sink retention.",
        "who_should_care": "Teams running long contexts on laptops or edge devices.",
        "limitations": ["Approximate — can hurt retrieval of rare tokens.", "Needs attention weights, unavailable from fused SDPA."],
        "diagram": dg(
            "Heavy-hitter eviction",
            [("a", "Attention scores", "data"), ("s", "Accumulate mass", "step", True), ("b", "Over budget?", "decision", True), ("e", "Evict low-score", "step", True), ("c", "KV cache", "memory")],
            [("a", "s"), ("s", "b"), ("b", "e", "yes"), ("e", "c"), ("b", "c", "no", "skip")],
        ),
    },
    "arxiv:2609.13377": {
        "tldr": "Sarathi-Serve 2 slices long prefills into token-budgeted chunks that share forward passes with decodes, removing decode stalls.",
        "problem": "A long prompt prefill blocks every other request's next token, inflating tail inter-token latency.",
        "approach": [
            "Set a per-iteration token budget (e.g. 512).",
            "Fill the batch with all active decode tokens first.",
            "Add a chunk of the pending prefill to fill the rest.",
            "Carry partial KV across chunks until the prompt is done.",
        ],
        "key_results": [
            {"label": "p99 inter-token latency", "value": "−46%", "context": "mixed traces, 8–64 concurrent"},
            {"label": "Median TTFT", "value": "+9%", "context": "long prompts"},
            {"label": "Goodput", "value": "+18%", "context": "SLO-aware chunk size"},
        ],
        "novelty": "Adapts chunk size to latency-SLO slack instead of a fixed budget.",
        "who_should_care": "Interactive serving with mixed prompt lengths and many users.",
        "limitations": ["Little effect at low concurrency.", "TTFT rises for long prompts."],
        "diagram": dg(
            "Stall-free batching",
            [("q", "Request queue", "input"), ("b", "Token budget", "decision", True), ("d", "Active decodes", "data"), ("c", "Prefill chunk", "step", True), ("f", "Mixed forward pass", "model"), ("o", "Tokens out", "output")],
            [("q", "b"), ("b", "d", "first"), ("b", "c", "remaining"), ("d", "f"), ("c", "f"), ("f", "o"), ("f", "b", "next iteration", "loop")],
        ),
    },
    "arxiv:2610.00218": {
        "tldr": "Lookahead decoding generates and verifies n-grams with parallel Jacobi iterations — no draft model — and runs 1.31x faster on an M3 Max.",
        "problem": "Speculative decoding needs a separate draft model, which costs memory and must be kept in sync with the target.",
        "approach": [
            "Keep a 2D window of future positions (W=5, N=4).",
            "Update the window with one parallel Jacobi iteration per step.",
            "Collect generated n-grams into a pool keyed by their first token.",
            "Verify pool candidates in the same forward pass and accept matches.",
        ],
        "key_results": [
            {"label": "Decode throughput", "value": "1.31x", "context": "Llama-3-8B fp16, batch 1, M3 Max"},
            {"label": "Device-tuned window", "value": "+9%", "context": "vs default W=15, N=5"},
        ],
        "novelty": "Derives window sizes from the unified-memory compute/bandwidth ratio.",
        "who_should_care": "Single-device Apple silicon servers without a draft model.",
        "limitations": ["Extra FLOPs per step can hurt large MoE models."],
        "diagram": dg(
            "Lookahead decoding",
            [("c", "Current tokens", "input"), ("j", "Jacobi window", "step", True), ("p", "n-gram pool", "memory", True), ("v", "Verify branch", "model"), ("o", "Accepted n-gram", "output")],
            [("c", "j"), ("j", "p", "collect"), ("p", "v", "candidates"), ("c", "v"), ("v", "o"), ("o", "j", "update", "loop")],
        ),
    },
    "arxiv:2608.05219": {
        "tldr": "A Metal port of split-K flash decoding keeps the GPU busy at batch 1 and speeds up decode 24% at 32k context.",
        "problem": "With one query per step, long-context attention under-uses the GPU's threadgroups.",
        "approach": [
            "Split the KV sequence into K chunks.",
            "Compute partial attention per chunk in parallel threadgroups.",
            "Merge partial softmax results with a log-sum-exp reduction.",
        ],
        "key_results": [{"label": "Decode throughput", "value": "+24%", "context": "32k context, batch 1, M2 Ultra"}],
        "novelty": "First split-K decode kernel for Metal.",
        "who_should_care": "Long-context single-stream inference on Apple GPUs.",
        "limitations": ["Below ~4k tokens the reduction costs 3–6%."],
        "diagram": dg(
            "Split-K attention",
            [("q", "Query", "input"), ("s1", "KV split 1", "memory"), ("s2", "KV split K", "memory"), ("p", "Partial softmax", "step", True), ("r", "LSE reduction", "step", True), ("o", "Attention out", "output")],
            [("q", "s1"), ("q", "s2"), ("s1", "p"), ("s2", "p"), ("p", "r"), ("r", "o")],
        ),
    },
    "arxiv:2609.08870": {
        "tldr": "RadixCache reuses the KV of shared prompt prefixes across requests and turns, cutting time to first token by half on multi-turn chat.",
        "problem": "Multi-turn chats and agents resend the whole history, so every turn re-prefills the same tokens.",
        "approach": [
            "Store processed KV blocks in a radix tree keyed by token ids.",
            "On a new request, find the longest cached prefix.",
            "Attach those blocks and prefill only the new suffix.",
            "Evict least-recently-used leaves under a memory cap.",
        ],
        "key_results": [
            {"label": "Time to first token", "value": "−52%", "context": "3–12 turn ShareGPT conversations"},
            {"label": "Throughput", "value": "1.2x", "context": "cache-aware ordering, 16 clients"},
        ],
        "novelty": "Automatic prefix sharing without application hints.",
        "who_should_care": "Chat and agent backends with long, repeated context.",
        "limitations": ["Cached prefixes hold memory that active requests may need."],
        "diagram": dg(
            "Radix prefix cache",
            [("r", "New request", "input"), ("m", "Longest prefix match", "decision", True), ("t", "Radix tree of KV", "memory", True), ("p", "Prefill suffix only", "step", True), ("d", "Decode", "model"), ("o", "Response", "output")],
            [("r", "m"), ("t", "m", "lookup"), ("m", "p", "hit"), ("p", "d"), ("d", "o"), ("p", "t", "insert", "loop")],
        ),
    },
    "arxiv:2610.11002": {
        "tldr": "Splitwise-RDMA separates prefill and decode machines and streams the KV cache layer by layer over GPUDirect RDMA.",
        "problem": "Co-locating prefill and decode forces one GPU type and size to serve two very different workloads.",
        "approach": ["Run prefill on a dedicated pool.", "Stream each layer's KV over RDMA as it is produced.", "Continue decoding on a separate pool."],
        "key_results": [
            {"label": "Throughput per dollar", "value": "1.4x", "context": "equal SLOs, 8xH100 nodes"},
            {"label": "Hidden KV transfer", "value": "85%", "context": "overlapped with prefill"},
        ],
        "novelty": "Layer-wise streaming hides most KV transfer time.",
        "who_should_care": "Large GPU clusters with InfiniBand.",
        "limitations": ["Requires multiple GPUs and RDMA NICs."],
        "diagram": dg(
            "Disaggregated serving",
            [("p", "Prompt", "input"), ("pf", "Prefill pool", "hardware"), ("x", "Layer-wise RDMA", "data", True), ("dc", "Decode pool", "hardware"), ("o", "Tokens", "output")],
            [("p", "pf"), ("pf", "x", "per layer"), ("x", "dc"), ("dc", "o")],
        ),
    },
    "arxiv:2607.12245": {
        "tldr": "AWQ-Metal quantizes weights to 4 bits after protecting salient channels and adds an int4 Metal matmul: +35% decode, 2.9x less memory.",
        "problem": "Decode on Apple silicon is limited by how fast weights stream from memory.",
        "approach": [
            "Run 128 calibration samples and record activation magnitudes.",
            "Scale salient weight channels before rounding.",
            "Quantize weights to int4 with group size 128.",
            "Dequantize inside a fused Metal int4 matmul.",
        ],
        "key_results": [
            {"label": "Decode throughput", "value": "+35%", "context": "batch 1, Mistral-7B, M2 Max"},
            {"label": "Weight memory", "value": "2.9x less", "context": "vs fp16"},
            {"label": "Accuracy loss", "value": "<0.5 pts", "context": "MMLU"},
        ],
        "novelty": "Activation-aware quantization with a native Metal kernel.",
        "who_should_care": "Anyone serving dense models on Macs.",
        "limitations": ["MoE experts need per-expert calibration."],
        "diagram": dg(
            "Activation-aware int4",
            [("c", "Calibration set", "data"), ("s", "Salient channels", "step", True), ("q", "int4 weights", "memory", True), ("m", "int4 matmul", "hardware", True), ("o", "Activations out", "output")],
            [("c", "s"), ("s", "q", "scale + round"), ("q", "m"), ("m", "o")],
        ),
    },
    "patent:US20260183311A1": {
        "tldr": "Patent: adapt the number of drafted tokens each step from the acceptance rate, stop drafting early on low confidence, and batch verification across requests.",
        "problem": "A fixed draft length wastes drafting on hard text and under-drafts on easy text.",
        "approach": [
            "Track an exponential moving average of the acceptance rate.",
            "Set the next draft length from it (bounded 1–8).",
            "Stop drafting early when the drafter's confidence drops.",
            "Verify drafts of concurrent requests in one batched pass.",
        ],
        "key_results": [
            {"label": "Tokens per second", "value": "~+20%", "context": "example embodiment, vs fixed length 5"},
            {"label": "Batched verification", "value": "~1.25x", "context": "4 concurrent requests"},
        ],
        "novelty": "Combines acceptance-driven length control with confidence early exit.",
        "who_should_care": "Teams with speculative decoding in production (check licensing).",
        "limitations": ["Numbers come from an example embodiment, not a benchmark."],
        "diagram": dg(
            "Adaptive draft length",
            [("a", "Acceptance EMA", "data", True), ("l", "Choose length", "decision", True), ("d", "Draft tokens", "model"), ("v", "Verify", "model"), ("o", "Accepted", "output")],
            [("a", "l"), ("l", "d", "1–8"), ("d", "v"), ("v", "o"), ("v", "a", "update", "loop")],
        ),
    },
}
# arxiv:2609.02291 (TokenScope) and arxiv:2611.00872 are left without an explainer on purpose.

# ---- claims (Match.explainer, per project) ----------------------------------------------

CLAIM_EXPLAINERS: dict[str, dict[str, Any]] = {
    "c_h2o": {
        "headline": "Keep only the KV entries attention actually uses; evict the rest under a budget",
        "problem": "Long contexts fill unified memory with KV entries that attention rarely reads.",
        "how_it_works": [
            "Accumulate how much attention each cached token receives.",
            "Always keep the first 4 tokens (attention sinks) and the most recent window.",
            "Keep the top heavy hitters until the cache holds 20% of the tokens.",
            "Evict everything else; attention runs over the smaller cache.",
        ],
        "why_it_helps": "Fewer cached tokens means less memory and less KV traffic per decode step.",
        "claimed_result": {"summary": "5x less KV memory and +29% decode throughput at 8k context (M2 Max, 20% budget)", "is_relative_gain": True},
        "in_this_project": {
            "where": "kv_cache hook plus an attention path that exposes attention weights",
            "change": "Track accumulated attention per cached token and evict above a 20% budget",
            "measure": "peak_memory_gb on long_prompt; watch exact match on the quality set",
        },
        "lossless": False,
        "caveats": ["Fused SDPA on MPS hides attention weights — a slower attention path may cancel the speed-up.", "Can drop tokens a retrieval question needs."],
        "glossary": [
            {"term": "attention sinks", "meaning": "The first few tokens, which absorb a large share of attention and must never be evicted."},
            {"term": "heavy hitters", "meaning": "Tokens that have received the most attention so far."},
        ],
        "diagram": dg(
            "Heavy-hitter KV eviction",
            [("t", "New token", "input"), ("a", "Attention", "model"), ("s", "Score tokens", "step", True), ("b", "Over budget?", "decision", True), ("e", "Evict low scores", "step", True), ("c", "KV cache", "memory")],
            [("t", "a"), ("a", "s", "weights"), ("s", "b"), ("b", "e", "yes"), ("e", "c"), ("b", "c", "no", "skip"), ("c", "a", "next step", "loop")],
        ),
    },
    "c_cache_order": {
        "headline": "Serve requests that share a cached prefix back-to-back to raise cache hits",
        "problem": "First-come-first-served scheduling evicts prefixes right before another request could reuse them.",
        "how_it_works": [
            "Look up each waiting request's longest cached prefix in the radix tree.",
            "Order the queue depth-first by that prefix.",
            "Apply an age limit so requests without shared prefixes are not starved.",
        ],
        "why_it_helps": "More requests hit warm KV, so fewer tokens are prefilled.",
        "claimed_result": {"summary": "1.2x throughput over FCFS with 16 concurrent clients (A10G, SGLang)", "is_relative_gain": True},
        "in_this_project": {
            "where": "scheduler hook, using the merged radix_prefix_cache",
            "change": "Sort the waiting queue by cached-prefix length with a starvation guard",
            "measure": "throughput_tokens_per_s on concurrent_4",
        },
        "lossless": True,
        "caveats": ["With only 4 streams the queue is short, so reordering has little room to help."],
        "glossary": [{"term": "FCFS", "meaning": "First-come, first-served scheduling."}],
        "diagram": None,
    },
    "c_adaptive_ngram": {
        "headline": "Match longer n-grams first and cap drafts by recent acceptance",
        "problem": "Fixed n-gram drafting proposes too many tokens when matches are weak, wasting verification.",
        "how_it_works": ["Try a 4-gram match against the prompt first.", "Fall back to 3, 2, 1 only if needed.", "Cap the draft length by an average of recently accepted lengths."],
        "why_it_helps": "Longer matches are more often correct, and caps avoid verifying tokens that will be rejected.",
        "claimed_result": {"summary": "+12% mean accepted tokens per step vs fixed n=3, k=10 (summarisation)", "is_relative_gain": True},
        "in_this_project": {"where": "decode_step hook, inside prompt_lookup_decoding", "change": "Add fallback matching and an acceptance EMA bounding k to 2–10", "measure": "decode_tokens_per_s on long_prompt"},
        "lossless": True,
        "caveats": ["Only helps once prompt lookup itself is enabled (experiment #3)."],
        "glossary": [{"term": "n-gram", "meaning": "A sequence of n consecutive tokens."}],
        "diagram": dg(
            "Adaptive n-gram drafting",
            [("g", "Last tokens", "input"), ("m4", "Try 4-gram", "decision", True), ("m1", "Fallback n-gram", "step", True), ("cap", "Cap by EMA", "step", True), ("v", "Verify", "model"), ("o", "Accepted", "output")],
            [("g", "m4"), ("m4", "m1", "no match"), ("m4", "cap", "match", "skip"), ("m1", "cap"), ("cap", "v"), ("v", "o")],
        ),
    },
    "c_dyn_tree": {
        "headline": "Grow the draft tree where the drafter is confident; verify it in one pass",
        "problem": "A fixed-shape draft tree verifies many unlikely branches and misses likely long ones.",
        "how_it_works": [
            "Draft with the existing 0.6B draft model and keep branch probabilities.",
            "Expand the top-k most confident branches at each depth.",
            "Prune branches below a cumulative-confidence threshold.",
            "Verify the tree with one target pass using a tree attention mask.",
        ],
        "why_it_helps": "More accepted tokens per expensive target pass on bandwidth-bound decode.",
        "claimed_result": {"summary": "1.38x decode throughput over EAGLE-2 static trees (Vicuna-13B, MT-Bench, H100, batch 1)", "is_relative_gain": True},
        "in_this_project": {"where": "decode_step hook, extending speculative_draft", "change": "Replace the fixed tree with confidence-guided expansion and a dynamic mask", "measure": "decode_tokens_per_s on short_chat"},
        "lossless": True,
        "caveats": ["Arbitrary masks make MPS SDPA fall back to a slower kernel.", "The 30B MoE target activates more experts for wider trees."],
        "glossary": [{"term": "tree attention mask", "meaning": "A mask letting each drafted token attend only to its own branch during verification."}],
        "diagram": dg(
            "Confidence-pruned draft tree",
            [("c", "Context", "input"), ("d", "Draft model", "model"), ("e", "Expand top-k", "step", True), ("p", "Prune by confidence", "decision", True), ("v", "Target verify", "model"), ("o", "Accepted path", "output")],
            [("c", "d"), ("d", "e"), ("e", "p"), ("p", "v", "tree + mask"), ("v", "o"), ("v", "d", "next step", "loop")],
        ),
    },
    "c_awq": {
        "headline": "Store weights in 4 bits, protecting salient channels, to stream fewer bytes",
        "problem": "Each decoded token reads every weight once, so decode speed is capped by memory bandwidth.",
        "how_it_works": [
            "Run a 128-sample calibration set and record activation magnitudes.",
            "Scale the weight channels that see large activations.",
            "Round weights to int4 in groups of 128 with fp16 scales.",
            "Dequantize inside an int4 matmul at run time.",
        ],
        "why_it_helps": "4-bit weights cut bytes per token by ~4x on a bandwidth-bound device.",
        "claimed_result": {"summary": "+35% decode throughput and 2.9x less weight memory (Mistral-7B, M2 Max, batch 1)", "is_relative_gain": True},
        "in_this_project": {"where": "model_loader hook plus an int4 matmul for MPS", "change": "Load-time AWQ pass; keep embeddings and lm_head in bf16", "measure": "decode_tokens_per_s on short_chat with the exact-match guardrail"},
        "lossless": False,
        "caveats": ["Needs an int4 matmul on MPS.", "MoE experts need per-expert calibration.", "Approximate — quality guardrail decides."],
        "glossary": [{"term": "salient channels", "meaning": "The few weight channels multiplied by unusually large activations; rounding them hurts accuracy most."}],
        "diagram": dg(
            "Activation-aware int4 weights",
            [("w", "bf16 weights", "data"), ("c", "Calibration", "step", True), ("q", "int4 + scales", "memory", True), ("m", "int4 matmul", "hardware", True), ("o", "Logits", "output")],
            [("w", "c"), ("c", "q", "scale, round"), ("q", "m", "every token"), ("m", "o")],
        ),
    },
    "c_batched_verify": {
        "headline": "Verify drafts from several requests in a single padded forward pass",
        "problem": "Verifying each request's draft separately reads the weights once per request.",
        "how_it_works": ["Collect drafts from active speculative requests.", "Pad them to the longest draft.", "Run one batched target pass and split the results."],
        "why_it_helps": "Weight reads are amortised across requests.",
        "claimed_result": {"summary": "about 1.25x aggregate throughput with 4 concurrent requests (patent example embodiment)", "is_relative_gain": True},
        "in_this_project": {"where": "scheduler hook together with speculative_draft", "change": "Group verify passes of concurrent speculative requests", "measure": "throughput_tokens_per_s on concurrent_4"},
        "lossless": True,
        "caveats": ["Padding wastes compute when draft lengths differ.", "Patent numbers are illustrative."],
        "glossary": [],
        "diagram": dg(
            "Batched verification",
            [("r1", "Request A draft", "input"), ("r2", "Request B draft", "input"), ("p", "Pad + batch", "step", True), ("v", "One verify pass", "model"), ("s", "Split results", "step", True), ("o", "Per-request tokens", "output")],
            [("r1", "p"), ("r2", "p"), ("p", "v"), ("v", "s"), ("s", "o")],
        ),
    },
    "c_prompt_lookup": {
        "headline": "Draft tokens by copying from the prompt; verify them all in one pass",
        "problem": "Input-grounded tasks repeat long spans of the prompt but still decode them token by token.",
        "how_it_works": [
            "Take the last 3 generated tokens.",
            "Find their most recent match in the prompt.",
            "Propose the next ≤10 prompt tokens as a draft.",
            "Verify the draft with one target pass; keep the matching prefix.",
        ],
        "why_it_helps": "Several tokens are accepted per target pass without running a draft model.",
        "claimed_result": {"summary": "+45% decode throughput on input-grounded tasks (Mistral-7B, A100, greedy)", "is_relative_gain": True},
        "in_this_project": {"where": "decode_step hook, reusing the speculative_draft verifier", "change": "Add a model-free n-gram draft provider", "measure": "decode_tokens_per_s on long_prompt"},
        "lossless": True,
        "caveats": ["Gains vanish on open-ended chat.", "The MoE target makes per-token decode cheaper, so verification overhead weighs more."],
        "glossary": [{"term": "verification", "meaning": "The target model scoring all drafted tokens in one pass and keeping those it would have generated."}],
        "diagram": dg(
            "Prompt lookup decoding",
            [("p", "Prompt", "input"), ("g", "Last 3 tokens", "step"), ("l", "Find in prompt", "memory", True), ("v", "Verify ≤10", "model"), ("o", "Accepted tokens", "output")],
            [("p", "l", "index"), ("g", "l"), ("l", "v", "draft"), ("v", "o"), ("o", "g", "next", "loop")],
        ),
    },
    "c_chunked_prefill": {
        "headline": "Split long prompt prefills into chunks that share passes with active decodes",
        "problem": "A long prompt arriving mid-stream freezes every other stream until its prefill finishes.",
        "how_it_works": [
            "Cap each forward pass at 512 tokens.",
            "Put all active decode tokens into the pass first.",
            "Fill the rest with the next chunk of pending prefill.",
            "Repeat until the prompt is fully prefilled.",
        ],
        "why_it_helps": "Decodes never wait for a whole prefill, so inter-token latency stays flat.",
        "claimed_result": {"summary": "−46% p99 inter-token latency under 8–64 concurrent requests (A100), +9% median TTFT", "is_relative_gain": True},
        "in_this_project": {"where": "scheduler hook", "change": "Token budget per iteration; slice prefills; carry partial KV", "measure": "itl_ms on concurrent_4"},
        "lossless": True,
        "caveats": ["concurrent_4 has few streams, so stalls are rarer than in the paper.", "TTFT may rise."],
        "glossary": [{"term": "TTFT", "meaning": "Time to first token."}, {"term": "p99", "meaning": "The 99th-percentile value — the slow tail."}],
        "diagram": dg(
            "Chunked prefill",
            [("q", "Queue", "input"), ("b", "512-token budget", "decision", True), ("d", "Decode tokens", "data"), ("c", "Prefill chunk", "step", True), ("f", "Mixed pass", "model"), ("o", "Tokens", "output")],
            [("q", "b"), ("b", "d", "first"), ("b", "c", "fill"), ("d", "f"), ("c", "f"), ("f", "o"), ("f", "b", "next", "loop")],
        ),
    },
    "c_kivi": {
        "headline": "Store the KV cache in 2 bits with a small full-precision recent window",
        "problem": "On long prompts the KV cache takes gigabytes of the 64 GB shared with the model.",
        "how_it_works": [
            "Quantize keys per channel and values per token to 2 bits (groups of 32).",
            "Keep the last 128 tokens in fp16.",
            "Dequantize on the fly before attention.",
        ],
        "why_it_helps": "KV memory shrinks ~8x for old tokens while recent, most-attended tokens stay exact.",
        "claimed_result": {"summary": "2.6x less peak KV memory (Llama-2-13B, 4k context); up to 3.47x batch throughput", "is_relative_gain": True},
        "in_this_project": {"where": "kv_cache hook (new QuantizedKVCache)", "change": "int2 packing with fp16 scales; dequantize before SDPA", "measure": "peak_memory_gb on long_prompt"},
        "lossless": False,
        "caveats": ["Weights dominate peak memory, so the end-to-end reduction is much smaller.", "Dequantization may slow decode at batch 1."],
        "glossary": [{"term": "per-channel", "meaning": "One scale per hidden dimension across tokens."}],
        "diagram": dg(
            "2-bit KV cache",
            [("kv", "New K/V", "data"), ("q", "2-bit quantize", "step", True), ("c", "Packed KV", "memory", True), ("r", "fp16 window", "memory"), ("a", "Attention", "model")],
            [("kv", "r", "recent"), ("r", "q", "ages out"), ("q", "c"), ("c", "a", "dequantize"), ("r", "a")],
        ),
    },
    "c_lookahead": {
        "headline": "Generate and verify n-grams in parallel with Jacobi iterations — no draft model",
        "problem": "Speculative decoding normally needs a second model in memory and in sync.",
        "how_it_works": [
            "Keep a lookahead window of W=5 future positions and N=4 steps.",
            "Update the window with one parallel Jacobi iteration per decode step.",
            "Cache completed n-grams in a pool keyed by their first token.",
            "Verify matching pool candidates in the same forward pass.",
        ],
        "why_it_helps": "Accepted n-grams yield several tokens per pass using spare compute on a bandwidth-bound device.",
        "claimed_result": {"summary": "1.31x decode throughput (Llama-3-8B fp16, M3 Max, batch 1)", "is_relative_gain": True},
        "in_this_project": {"where": "decode_step hook", "change": "LookaheadDecoder with an n-gram pool and combined lookahead+verify mask", "measure": "decode_tokens_per_s on short_chat"},
        "lossless": True,
        "caveats": ["Arbitrary masks are slow in MPS SDPA.", "MoE: extra lookahead tokens activate more experts."],
        "glossary": [{"term": "Jacobi iteration", "meaning": "Updating guesses for several future tokens in parallel until they stop changing."}],
        "diagram": dg(
            "Lookahead decoding",
            [("c", "Context", "input"), ("j", "Jacobi window", "step", True), ("p", "n-gram pool", "memory", True), ("v", "Verify branch", "model"), ("o", "Tokens out", "output")],
            [("c", "j"), ("c", "v"), ("j", "p"), ("p", "v", "candidates"), ("v", "o"), ("o", "j", "next step", "loop")],
        ),
    },
    "c_draft_len": {
        "headline": "Draft more tokens when they are being accepted, fewer when they are not",
        "problem": "A fixed draft length of 5 wastes drafting on hard text and under-drafts on easy text.",
        "how_it_works": [
            "Track an exponential moving average of accepted tokens per step.",
            "Choose the next draft length from it, between 1 and 8.",
            "Stop drafting early when the drafter's top-1 probability drops below 0.35.",
        ],
        "why_it_helps": "Verification effort follows how predictable the text currently is.",
        "claimed_result": {"summary": "about 20% more tokens per second than a fixed draft length of 5 (patent example embodiment)", "is_relative_gain": True},
        "in_this_project": {"where": "decode_step hook, inside speculative_draft", "change": "EMA controller (alpha 0.2) plus confidence early exit", "measure": "decode_tokens_per_s on short_chat"},
        "lossless": True,
        "caveats": ["Patent numbers are illustrative, not benchmarked.", "Drafting with a 0.6B model on MPS is already cheap."],
        "glossary": [{"term": "EMA", "meaning": "Exponential moving average — a running average that weights recent steps more."}],
        "diagram": dg(
            "Adaptive draft length",
            [("a", "Acceptance EMA", "data", True), ("l", "Pick length 1–8", "decision", True), ("d", "Draft model", "model"), ("x", "Early exit", "step", True), ("v", "Verify", "model"), ("o", "Accepted", "output")],
            [("a", "l"), ("l", "d"), ("d", "x"), ("x", "v"), ("v", "o"), ("v", "a", "update", "loop")],
        ),
    },
    "c_radix": {
        "headline": "Reuse cached KV for the shared start of a conversation; prefill only new text",
        "problem": "Each chat turn re-prefills the whole conversation history.",
        "how_it_works": [
            "Index processed KV blocks in a radix tree keyed by token ids.",
            "Find the longest cached prefix of a new request.",
            "Attach those blocks and prefill only the suffix.",
            "Evict least-recently-used leaves under a 6 GB cap.",
        ],
        "why_it_helps": "Most of a multi-turn prompt is already cached, so time to first token drops.",
        "claimed_result": {"summary": "−52% time to first token on 3–12 turn ShareGPT chats (A10G, SGLang)", "is_relative_gain": True},
        "in_this_project": {"where": "kv_cache hook over paged_kv blocks", "change": "Radix tree lookup + LRU eviction", "measure": "ttft_ms on short_chat"},
        "lossless": True,
        "caveats": ["Cached prefixes use memory (+6% peak measured)."],
        "glossary": [{"term": "radix tree", "meaning": "A prefix tree that shares common token prefixes between entries."}],
        "diagram": dg(
            "Radix prefix cache",
            [("r", "Request", "input"), ("m", "Prefix match", "decision", True), ("t", "Radix KV tree", "memory", True), ("p", "Prefill suffix", "step"), ("d", "Decode", "model")],
            [("r", "m"), ("t", "m"), ("m", "p", "hit"), ("p", "d"), ("p", "t", "insert", "loop")],
        ),
    },
    "c_split_k": {
        "headline": "Split long-context attention across threadgroups and merge partial results",
        "problem": "At batch 1, attention over long contexts leaves most GPU threadgroups idle.",
        "how_it_works": ["Partition the KV sequence into K splits.", "Compute partial attention per split in parallel.", "Merge with a log-sum-exp reduction."],
        "why_it_helps": "The GPU is fully occupied even with a single query.",
        "claimed_result": {"summary": "+24% decode throughput at 32k context (M2 Ultra, batch 1)", "is_relative_gain": True},
        "in_this_project": {"where": "attention hook (custom Metal kernel)", "change": "Split-K decode path above 4k context", "measure": "decode_tokens_per_s on long_prompt"},
        "lossless": True,
        "caveats": ["fp16 accumulation in the reduction broke parity (experiment #2).", "long_prompt reaches only ~8k tokens."],
        "glossary": [{"term": "log-sum-exp", "meaning": "A numerically stable way to combine softmax results computed in pieces."}],
        "diagram": dg(
            "Split-K attention",
            [("q", "Query", "input"), ("a", "Splits 1…K", "memory"), ("p", "Partial softmax", "step", True), ("r", "LSE merge", "step", True), ("o", "Output", "output")],
            [("q", "a"), ("a", "p", "parallel"), ("p", "r"), ("r", "o")],
        ),
    },
}
# c_lookahead_tuning, c_tokenscope, c_awq_clip and c_slo_chunk are left without an explainer on purpose.

# ---- background papers (topic infographics) ------------------------------------------------

BACKGROUND_PAPERS: dict[str, list[tuple[str, date, list[str], int, int, bool]]] = {
    "speculative-decoding-dynamic-drafts": [
        ("Draft Once, Verify Many: Batched Speculative Decoding for Serving", date(2026, 6, 12), ["arxiv", "openalex"], 21, 88, True),
        ("Acceptance Decay in Long-Context Speculative Decoding", date(2026, 7, 30), ["arxiv", "hf_papers"], 7, 54, False),
        ("Hydra Heads Revisited: Sequentially Dependent Draft Heads", date(2026, 9, 21), ["arxiv", "semantic_scholar"], 12, 97, True),
        ("SpecTr-Lite: Optimal Transport Verification for Small Drafters", date(2026, 10, 18), ["arxiv"], 3, 41, False),
        ("Self-Speculative Decoding with Layer Skipping on Edge Devices", date(2026, 11, 9), ["arxiv", "hf_papers"], 1, 76, True),
        ("Branch-Parallel Drafting for Code Completion", date(2026, 11, 15), ["openalex"], 0, 23, False),
    ],
    "kv-cache-quantization-eviction": [
        ("QuantSpec: Quantized KV Caches for Self-Speculation", date(2026, 7, 8), ["arxiv", "hf_papers"], 9, 65, True),
        ("SnapKV-2: Observation Windows for Prompt KV Compression", date(2026, 8, 25), ["arxiv", "semantic_scholar"], 15, 102, True),
        ("Coupled Quantization of Keys and Values", date(2026, 10, 2), ["openalex"], 2, 18, False),
        ("PyramidKV on Unified Memory", date(2026, 11, 3), ["arxiv"], 0, 37, True),
    ],
    "chunked-prefill-scheduling": [
        ("Fairness-Aware Continuous Batching", date(2026, 6, 30), ["arxiv", "openalex"], 11, 33, False),
        ("Learning Token Budgets for Mixed Prefill/Decode Batches", date(2026, 9, 5), ["arxiv"], 4, 29, True),
        ("SLO Attainment Under Bursty Chat Traffic", date(2026, 10, 27), ["semantic_scholar"], 1, 12, False),
    ],
    "low-bit-weight-quantization": [
        ("GPTQ-Metal: Second-Order Quantization on Apple GPUs", date(2026, 6, 19), ["arxiv", "hf_papers"], 26, 140, True),
        ("FP4 Weights for Bandwidth-Bound Decode", date(2026, 8, 14), ["arxiv"], 8, 61, False),
        ("Mixed-Precision Experts for MoE Inference", date(2026, 10, 9), ["arxiv", "openalex"], 3, 58, True),
    ],
    "prefix-caching-multi-turn": [
        ("Agentic Prefix Reuse Across Tool Calls", date(2026, 9, 29), ["arxiv", "hf_papers"], 2, 47, True),
        ("Cache-Aware Load Balancing for Chat Fleets", date(2026, 11, 1), ["openalex"], 0, 9, False),
    ],
    "long-context-decode-kernels": [
        ("Lean Attention: Stream-K Decode Kernels", date(2026, 7, 17), ["arxiv"], 14, 72, True),
        ("Paged Flash-Decoding on Metal", date(2026, 10, 12), ["arxiv", "hf_papers"], 1, 39, True),
    ],
    "disaggregated-prefill-decode": [
        ("DistServe-2: Goodput-Optimal Disaggregation", date(2026, 8, 3), ["arxiv", "semantic_scholar"], 19, 64, True),
        ("KV Transfer over Ethernet: Is RDMA Necessary?", date(2026, 11, 11), ["arxiv"], 0, 22, False),
    ],
    "token-level-serving-telemetry": [
        ("Tracing the Token: Distributed Tracing for LLM Serving", date(2026, 7, 23), ["openalex"], 5, 14, True),
    ],
}


# ---- v2 plain-language layer (explainer.version 2) ----------------------------------------
# Mirrors the shape the LLM writes for real claims (see claim 288, DLoop): primer, headline_result,
# today_vs_paper, paper_vs_here, what_we_do_differently, key_numbers, theme and a "before" diagram that
# shares node ids with `diagram`. The other claims keep v1 explainers so the fallback rendering shows.

_HERE_HW = "Apple M5 Pro (MPS), 64 GB unified memory with ~48 GB usable by the GPU."
_HERE_MODEL = "Qwen3-30B-A3B-Instruct-2507 (mixture of experts, ~3B active per token), bfloat16."

CLAIM_EXPLAINERS_V2: dict[str, dict[str, Any]] = {
    "c_cache_order": {
        "headline": "Serve requests that share a cached prefix back-to-back to raise cache hits",
        "theme": "throughput",
        "primer": {
            "concept": "Before a model can answer, it reads the whole prompt once (prefill) and stores the result in a KV cache. "
            "Chats often start with the same system prompt or history, so that stored work can be reused. "
            "A radix tree is an index that finds the longest stored prefix for a new request.",
            "analogy": "A barista who groups all the oat-milk orders together only has to fetch the oat milk once.",
        },
        "headline_result": {"value": "1.2×", "metric": "requests served per second", "versus": "first-come-first-served order", "direction": "up"},
        "today_vs_paper": {
            "today": "Requests run in arrival order. A request that could reuse a warm prefix often waits behind unrelated ones, and by its turn the prefix may have been evicted.",
            "with_paper": "The scheduler looks up each waiting request's cached prefix and runs those that share one back-to-back, with an age limit so nobody starves.",
        },
        "paper_vs_here": [
            {"aspect": "hardware", "paper": "NVIDIA A10G 24 GB.", "here": _HERE_HW, "effect": "More memory means fewer evictions, so ordering has less to rescue."},
            {"aspect": "workload", "paper": "16 concurrent ShareGPT multi-turn chats.", "here": "concurrent_4: four streams with a shared system prompt.",
             "effect": "A short queue leaves little room to reorder; expect a smaller gain."},
            {"aspect": "runtime", "paper": "SGLang scheduler.", "here": "inference-lab scheduler hook on top of the merged radix_prefix_cache.",
             "effect": "Same idea, but our prefix cache is newer and less tuned."},
        ],
        "what_we_do_differently": [
            "Reuse the radix prefix cache merged in experiment #1 instead of SGLang's.",
            "Add a 2-second age limit so the 4-stream benchmark cannot starve a request.",
        ],
        "key_numbers": [
            {"value": "1.2×", "label": "Throughput vs FCFS", "meaning": "With 16 concurrent clients on an A10G."},
            {"value": "+38%", "label": "Cache hit rate", "meaning": "More prompt tokens served from the KV cache instead of recomputed."},
        ],
        "diagram_before": dg(
            "First-come-first-served",
            [("q", "Waiting requests", "input"), ("pf", "Prefill uncached part", "model"), ("d", "Decode", "model"), ("o", "Responses", "output")],
            [("q", "pf", "arrival order"), ("pf", "d"), ("d", "o")],
        ),
        "diagram": dg(
            "Cache-aware ordering",
            [("q", "Waiting requests", "input"), ("lk", "Look up cached prefix", "memory", True), ("ord", "Group by shared prefix", "step", True),
             ("pf", "Prefill uncached part", "model"), ("d", "Decode", "model"), ("o", "Responses", "output")],
            [("q", "lk"), ("lk", "ord", "prefix length"), ("ord", "pf", "warm first"), ("pf", "d"), ("d", "o")],
        ),
    },
    "c_h2o": {
        "headline": "Keep only the KV entries attention actually uses; evict the rest under a budget",
        "theme": "memory",
        "primer": {
            "concept": "While generating, the model keeps a KV cache: a memory of every earlier token so it does not recompute them. "
            "It grows with the conversation and can take more memory than the model itself on long prompts. "
            "Attention, the step that decides which earlier tokens matter, uses only a few of them heavily.",
            "analogy": "Like clearing a desk: keep the few documents you keep reaching for and the ones you just opened; file away the rest.",
        },
        "headline_result": {"value": "5× less", "metric": "KV cache memory at 8k context", "versus": "keeping the full KV cache", "direction": "down"},
        "today_vs_paper": {
            "today": "Every past token stays in the KV cache, so memory grows with the prompt and long prompts read a lot of cache each step.",
            "with_paper": "Tokens are scored by how much attention they receive. Only the first few, the recent window and the top scorers stay, capped at 20% of the tokens.",
        },
        "paper_vs_here": [
            {"aspect": "hardware", "paper": "Apple M2 Max, 96 GB.", "here": _HERE_HW, "effect": "Same kind of unified memory, so the memory saving should carry over."},
            {"aspect": "model", "paper": "Llama-2-13B (dense).", "here": _HERE_MODEL, "effect": "Fewer KV heads per layer, so the cache is already smaller and the saving is worth less."},
            {"aspect": "runtime", "paper": "Custom attention that exposes attention weights.", "here": "PyTorch scaled-dot-product attention, which hides the weights on MPS.",
             "effect": "Getting the scores needs a slower attention path that may cancel the speed-up."},
            {"aspect": "context", "paper": "8k-token prompts.", "here": "long_prompt workload (~6k tokens).", "effect": "Shorter prompts leave less to evict."},
        ],
        "what_we_do_differently": [
            "Read attention scores from every 4th step only, to limit the cost of the slower attention path.",
            "Gate on the exact-match quality set, since dropped tokens can change answers.",
        ],
        "key_numbers": [
            {"value": "5×", "label": "Less KV memory", "meaning": "At a 20% budget with 8k-token prompts."},
            {"value": "+29%", "label": "Decode throughput", "meaning": "Less cache to read per generated token."},
            {"value": "20%", "label": "Tokens kept", "meaning": "The budget: first 4 tokens, a recent window and the heaviest hitters."},
        ],
        "diagram_before": dg(
            "Full KV cache",
            [("t", "New token", "input"), ("a", "Attention", "model"), ("c", "KV cache (all tokens)", "memory"), ("o", "Next token", "output")],
            [("t", "a"), ("a", "o"), ("a", "c", "append"), ("c", "a", "next step", "loop")],
        ),
        "diagram": dg(
            "Heavy-hitter KV eviction",
            [("t", "New token", "input"), ("a", "Attention", "model"), ("s", "Score tokens", "step", True), ("b", "Over budget?", "decision", True),
             ("e", "Evict low scores", "step", True), ("c", "KV cache (20% budget)", "memory"), ("o", "Next token", "output")],
            [("t", "a"), ("a", "o"), ("a", "s", "weights"), ("s", "b"), ("b", "e", "yes"), ("e", "c"), ("b", "c", "no", "skip"), ("c", "a", "next step", "loop")],
        ),
    },
    "c_prompt_lookup": {
        "headline": "Draft tokens by copying from the prompt; verify them all in one pass",
        "theme": "speed",
        "primer": {
            "concept": "A language model writes one token at a time, and each token needs a full pass over the large model. "
            "Speculative decoding guesses several tokens cheaply and lets the model check all of them in one pass. "
            "Summaries and answers about a document often repeat phrases from the prompt, so the prompt itself is a good source of guesses.",
            "analogy": "When typing up meeting notes from a transcript, you copy whole sentences instead of retyping them word by word.",
        },
        "headline_result": {"value": "+45%", "metric": "decoding speed on document tasks", "versus": "normal one-token-at-a-time decoding", "direction": "up"},
        "today_vs_paper": {
            "today": "Even when the answer repeats a long passage of the prompt, the model still produces it one token per pass.",
            "with_paper": "The last 3 tokens are looked up in the prompt; the next up to 10 prompt tokens become a draft that one model pass checks.",
        },
        "paper_vs_here": [
            {"aspect": "hardware", "paper": "NVIDIA A100 80 GB.", "here": _HERE_HW, "effect": "Both are memory-bound in decode, so checking 10 tokens costs about as much as 1."},
            {"aspect": "model", "paper": "Mistral-7B (dense).", "here": _HERE_MODEL, "effect": "Each token is already cheap on the MoE model, so verification overhead weighs more."},
            {"aspect": "workload", "paper": "Summarisation and RAG question answering.", "here": "long_prompt and short_chat.", "effect": "Gains should show on long_prompt and vanish on open-ended chat."},
        ],
        "what_we_do_differently": [
            "Reuse the existing speculative verifier instead of a new decode loop.",
            "Report short_chat separately so a chat slowdown is not hidden by the document gain.",
        ],
        "key_numbers": [
            {"value": "+45%", "label": "Decode speed", "meaning": "On input-grounded tasks with greedy decoding."},
            {"value": "≤10", "label": "Draft tokens", "meaning": "Copied from the prompt per step."},
        ],
        "diagram_before": dg(
            "One token per pass",
            [("p", "Prompt", "input"), ("g", "Last token", "step"), ("m", "Model pass", "model"), ("o", "1 new token", "output")],
            [("p", "m"), ("g", "m"), ("m", "o"), ("o", "g", "next", "loop")],
        ),
        "diagram": dg(
            "Prompt lookup decoding",
            [("p", "Prompt", "input"), ("g", "Last 3 tokens", "step"), ("l", "Find match in prompt", "memory", True), ("m", "Verify ≤10 tokens", "model", True), ("o", "Accepted tokens", "output")],
            [("p", "l", "index"), ("g", "l"), ("l", "m", "draft"), ("m", "o"), ("o", "g", "next", "loop")],
        ),
    },
    "c_dyn_tree": {
        "headline": "Grow the draft tree where the drafter is confident; verify it in one pass",
        "theme": "speed",
        "primer": {
            "concept": "A language model normally generates one token at a time, running the large model for each. Speculative decoding lets a small draft model propose "
            "several tokens that the large model checks together. A draft tree proposes several alternative continuations at once, so one check can accept the best branch.",
            "analogy": "A chess player only thinks several moves deep along the lines that look promising, instead of every possible line.",
        },
        "headline_result": {"value": "1.38×", "metric": "decoding speed", "versus": "EAGLE-2 with a fixed-shape draft tree", "direction": "up"},
        "today_vs_paper": {
            "today": "The draft tree has a fixed shape, so the large model checks many unlikely branches and misses likely long ones.",
            "with_paper": "The tree grows only where the draft model is confident and is pruned elsewhere, so each check accepts more tokens.",
        },
        "paper_vs_here": [
            {"aspect": "hardware", "paper": "NVIDIA H100 80 GB.", "here": _HERE_HW, "effect": "Tree attention masks fall back to a slower kernel on MPS, eating into the gain."},
            {"aspect": "draft_model", "paper": "EAGLE-2 draft heads trained for Vicuna-13B.", "here": "The existing Qwen3-0.6B draft model.", "effect": "A weaker drafter accepts fewer tokens per check."},
            {"aspect": "batch", "paper": "Batch size 1.", "here": "Batch 1 (short_chat) and 4 streams (concurrent_4).", "effect": "Wider trees cost more when four streams share the GPU."},
        ],
        "what_we_do_differently": [
            "Keep the 0.6B draft model rather than training EAGLE heads.",
            "Cap the tree at 32 nodes so the MoE target does not activate too many experts.",
        ],
        "key_numbers": [
            {"value": "1.38×", "label": "Speed vs EAGLE-2", "meaning": "Vicuna-13B on MT-Bench, H100, batch 1."},
            {"value": "≈4.1", "label": "Tokens accepted per check", "meaning": "Up from ≈3.6 with the fixed tree."},
        ],
        "diagram_before": dg(
            "Fixed draft tree",
            [("c", "Context", "input"), ("d", "Draft model", "model"), ("f", "Fixed-shape tree", "step"), ("v", "Target verify", "model"), ("o", "Accepted path", "output")],
            [("c", "d"), ("d", "f"), ("f", "v", "tree + mask"), ("v", "o"), ("v", "d", "next step", "loop")],
        ),
        "diagram": dg(
            "Confidence-pruned draft tree",
            [("c", "Context", "input"), ("d", "Draft model", "model"), ("e", "Expand confident branches", "step", True), ("p", "Prune by confidence", "decision", True),
             ("v", "Target verify", "model"), ("o", "Accepted path", "output")],
            [("c", "d"), ("d", "e"), ("e", "p"), ("p", "v", "tree + mask"), ("v", "o"), ("v", "d", "next step", "loop")],
        ),
    },
}

for _key, _extra in CLAIM_EXPLAINERS_V2.items():
    CLAIM_EXPLAINERS[_key] = {**CLAIM_EXPLAINERS[_key], **_extra, "version": 2}
