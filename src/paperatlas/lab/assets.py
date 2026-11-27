"""Pre-screen claims: what each one needs before it can be tested faithfully, and whether the project has it.

Most failed experiments needed something the target project doesn't have (a trained draft model or EAGLE
head, an offline-quantized checkpoint, calibration data, an MoE model) and either hung at the smoke test or
tested a stand-in that removed the paper's benefit. To catch them before any build or GPU time is spent:

1. `classify` lists each claim's hard prerequisites in fixed categories: one LLM call per batch of claims, with
   keyword rules as the fallback. Results are stored per claim in `research.claim_needs`, keyed by a hash of the
   claim text, so re-matching doesn't re-classify unchanged claims.
2. `capabilities` reads what the project provides from `lab.yaml` (`capabilities:`). Missing keys get
   conservative defaults: no drafters, MTP heads, artifacts, calibration data or adapters, with the architecture
   and accelerator inferred from `models`/`hardware`.
3. `check_needs` compares the two. Unmet prerequisites become one "needs assets: …" blocker on the match, so the
   claim leaves `testable_here` and the batch but stays listed, with what's missing, when blocked claims are
   shown. `reassess_project` repeats the comparison after a re-profile, without LLM calls.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Iterable, Optional

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from paperatlas.db.engine import session_scope
from paperatlas.db.schema import Claim, ClaimNeeds, Match, Project
from paperatlas.llm.client import LLMClient

logger = logging.getLogger(__name__)

# Bump when the prompt or the rules change in a way that should re-classify every claim.
PROMPT_VERSION = 1
ASSET_BLOCKER = "needs assets: "
# The matcher multiplies a blocked claim's score by this; `reassess_project` applies it the same way.
BLOCKED_SCORE_FACTOR = 0.05
NO_METRIC_BLOCKER = "no matching benchmark metric"

CATEGORIES: dict[str, str] = {
    "draft_model": "a trained draft model or speculative heads (EAGLE, Medusa, Hydra, DFlash, a learned drafter or corrector)",
    "mtp_heads": "native multi-token-prediction (MTP) heads in the served model's checkpoint",
    "offline_artifact": "an offline-quantized checkpoint or another artifact prepared offline (AWQ/GPTQ/HQQ weights, "
    "codebooks, rotations, saved statistics, a converted checkpoint)",
    "calibration_data": "a calibration dataset",
    "architecture": "a particular model architecture (MoE vs dense, a diffusion LM, …)",
    "custom_kernels": "CUDA/Triton/custom GPU kernels",
    "multi_gpu": "multiple GPUs or distributed serving",
    "min_context": "a minimum context length",
    "training": "model training or fine-tuning",
    "trained_adapter": "trained adapter or auxiliary weights (LoRA, a learned predictor, router or compressor)",
    "other": "anything else (not checked against the project)",
}
DEFAULT_LABELS: dict[str, str] = {
    "draft_model": "a trained draft model or speculative heads",
    "mtp_heads": "native MTP heads in the served model",
    "offline_artifact": "an offline-quantized checkpoint or prepared artifact",
    "calibration_data": "a calibration dataset",
    "architecture": "a different model architecture",
    "custom_kernels": "CUDA/Triton kernels",
    "multi_gpu": "multiple GPUs",
    "min_context": "a longer context window",
    "training": "model training or fine-tuning",
    "trained_adapter": "trained adapter weights",
    "other": "a prerequisite this project may not have",
}

# ---- what the project provides --------------------------------------------------------------------------

CAPABILITY_KEYS = (
    "architecture",
    "draft_models",
    "mtp_heads",
    "offline_artifacts",
    "calibration_data",
    "max_context_tokens",
    "trained_adapters",
    "accelerator",
)
LIST_CAPABILITIES = ("draft_models", "offline_artifacts", "trained_adapters")
DEFAULT_CONTEXT_TOKENS = 32768
CONTEXT_SLACK = 0.9
MOE_PATTERN = re.compile(r"\bmoe\b|mixture[- ]of[- ]experts|\d+(?:\.\d+)?b-a\d+(?:\.\d+)?b", re.I)


def _int(value: Any) -> Optional[int]:
    try:
        return int(value) if value is not None and not isinstance(value, bool) else None
    except (TypeError, ValueError):
        return None


def _accelerator(hardware: dict[str, Any]) -> str:
    text = f"{hardware.get('accelerator') or ''} {hardware.get('chip') or ''}".lower()
    if hardware.get("cuda") or "cuda" in text or "nvidia" in text:
        return "cuda"
    if any(word in text for word in ("apple", "metal", "mlx", "mps")):
        return "apple-gpu-mlx"
    return text.strip() or "unknown"


def capabilities(profile: dict[str, Any]) -> dict[str, Any]:
    """What the project provides: `lab.yaml`'s `capabilities`, with conservative defaults for any key it doesn't
    declare. `assumed` lists the keys that were inferred rather than declared."""
    hardware = profile.get("hardware") or {}
    models = profile.get("models") or {}
    declared = profile.get("capabilities") if isinstance(profile.get("capabilities"), dict) else {}
    served = models.get("eval") if isinstance(models.get("eval"), dict) else {}
    served_text = " ".join(str(served.get(key) or "") for key in ("architecture", "id", "source"))
    inferred: dict[str, Any] = {
        "architecture": "moe" if MOE_PATTERN.search(served_text) else "dense",
        "draft_models": [],
        "mtp_heads": False,
        "offline_artifacts": [],
        "calibration_data": False,
        "max_context_tokens": _int(served.get("max_context_tokens") or served.get("context_length"))
        or DEFAULT_CONTEXT_TOKENS,
        "trained_adapters": [],
        "accelerator": _accelerator(hardware),
    }
    caps = {key: declared[key] if declared.get(key) is not None else inferred[key] for key in CAPABILITY_KEYS}
    for key in LIST_CAPABILITIES:
        value = caps[key]
        caps[key] = [str(item) for item in (value if isinstance(value, list) else [value]) if item not in (None, "")]
    caps["architecture"] = str(caps["architecture"]).strip().lower() or "dense"
    caps["accelerator"] = str(caps["accelerator"]).strip().lower()
    caps["mtp_heads"] = bool(caps["mtp_heads"])
    caps["calibration_data"] = bool(caps["calibration_data"])
    caps["max_context_tokens"] = _int(caps["max_context_tokens"]) or DEFAULT_CONTEXT_TOKENS
    # How lab.yaml describes the served model (e.g. "dense hybrid … Gated DeltaNet"), for architecture needs beyond
    # dense/MoE such as SSM or linear-attention layers.
    caps["model_architecture"] = served_text.strip()
    caps["multi_gpu"] = bool(hardware.get("multi_gpu"))
    caps["cuda"] = bool(hardware.get("cuda")) or "cuda" in caps["accelerator"]
    caps["assumed"] = [key for key in CAPABILITY_KEYS if declared.get(key) is None]
    return caps


# ---- comparing needs with capabilities --------------------------------------------------------------------

GENERIC_WORDS = {
    "a", "an", "the", "any", "and", "or", "of", "for", "with", "to", "trained", "pretrained", "learned", "offline",
    "prepared", "precomputed", "quantized", "quantization", "checkpoint", "checkpoints", "artifact", "artifacts",
    "weights", "weight", "model", "models", "draft", "drafter", "drafters", "drafting", "head", "heads",
    "adapter", "adapters", "calibration", "calib", "data", "dataset", "datasets", "set", "samples", "stats",
    "statistics", "file", "files", "native", "table", "tables", "lm", "llm", "low", "bit", "bits", "small",
    "smaller", "compatible", "speculative", "converted", "generic",
}
CUDA_TOOLCHAINS = {
    "cuda", "triton", "cutlass", "flashinfer", "flashattention", "ptx", "nvidia", "tensorrt", "cudnn", "tensorcore",
    "tensorcores",
}
DENSE_ARCHITECTURES = {"dense", "transformer", "decoder", "autoregressive", "ar"}
# Recurrent-state layers (SSM, linear attention): a need for one is met by a model with any of them.
RECURRENT_ARCHITECTURES = {
    "ssm", "ssms", "mamba", "mamba2", "deltanet", "gdn", "rwkv", "hybrid", "statespace", "linear",
}


def _tokens(text: Any) -> set[str]:
    value = re.sub(r"([a-z])[-_ ]+(\d)", r"\1\2", str(text or "").lower())
    return {token for token in re.findall(r"[a-z0-9#]+", value) if token}


def _specific(text: Any) -> set[str]:
    return {token for token in _tokens(text) - GENERIC_WORDS if not token.isdigit()}


def _provided(key: str, provided: Iterable[str]) -> bool:
    """Whether a capability list covers the asset `key`: every specific word of the key (e.g. `eagle3`, `awq`)
    matches a word of one entry (prefixes count, so `eagle` covers `eagle3`); a generic key needs any entry."""
    provided = list(provided)
    wanted = _specific(key)
    if not wanted:
        return bool(provided)
    for entry in provided:
        have = _tokens(entry)
        if all(any(word.startswith(item) or item.startswith(word) for item in have) for word in wanted):
            return True
    return False


def context_tokens(value: Any) -> Optional[int]:
    """`262144`, `262k`, `128K tokens`, `1M` → tokens; None when there's no number."""
    match = re.search(r"(\d+(?:\.\d+)?)\s*([km])?", str(value or "").lower().replace(",", ""))
    if not match:
        return None
    number = float(match.group(1)) * {"k": 1024, "m": 1024 * 1024}.get(match.group(2) or "", 1)
    return int(number) if number > 0 else None


def need_met(need: dict[str, Any], caps: dict[str, Any]) -> Optional[bool]:
    """True/False when the project does/doesn't provide it; None when it can't be checked (category `other`)."""
    category, key = need.get("category"), str(need.get("key") or "").strip().lower()
    if category == "draft_model":
        if not _specific(key):
            return bool(caps["draft_models"])
        return _provided(key, caps["trained_adapters"] + caps["draft_models"])
    if category == "mtp_heads":
        return caps["mtp_heads"] or _provided("mtp", caps["trained_adapters"])
    if category == "offline_artifact":
        return _provided(key, caps["offline_artifacts"])
    if category == "calibration_data":
        return caps["calibration_data"] or _provided(key, [a for a in caps["offline_artifacts"] if "calib" in a.lower()])
    if category == "trained_adapter":
        return _provided(key, caps["trained_adapters"])
    if category == "architecture":
        wanted = _tokens(key) - GENERIC_WORDS - {"model", "architecture", "target"}
        have = caps["architecture"]
        if not wanted or "any" in wanted:
            return True
        if wanted & {"moe", "experts", "expert", "mixture"}:
            return have == "moe"
        if wanted <= DENSE_ARCHITECTURES:
            return have != "moe" and have in DENSE_ARCHITECTURES | {"dense"}
        described = _tokens(f"{have} {caps.get('model_architecture') or ''}")
        if wanted & RECURRENT_ARCHITECTURES and described & RECURRENT_ARCHITECTURES:
            return True
        return (wanted - DENSE_ARCHITECTURES) <= described
    if category == "custom_kernels":
        # Custom kernels in general can be written for the project's own GPU (e.g. Metal via MLX); CUDA ones can't.
        return caps["cuda"] if _tokens(key) & CUDA_TOOLCHAINS else True
    if category == "multi_gpu":
        return caps["multi_gpu"]
    if category == "min_context":
        # 10% slack: "1k prompt + 32k generation" is the same regime as a 32K window.
        tokens = context_tokens(key)
        return tokens is None or caps["max_context_tokens"] >= tokens * CONTEXT_SLACK
    if category == "training":
        return False
    return None


def check_needs(record: Optional[dict[str, Any]], caps: dict[str, Any]) -> Optional[dict[str, Any]]:
    """The pre-screen result stored on a match: every need with whether it's met, and the essential unmet ones."""
    if record is None:
        return None
    needs, missing = [], []
    for need in record.get("needs") or []:
        met = need_met(need, caps) if need.get("essential", True) else None
        needs.append({**need, "met": met})
        if met is False and not any(item["label"] == need["label"] for item in missing):
            missing.append({"category": need["category"], "key": need.get("key") or "", "label": need["label"]})
    return {
        "status": "needs_assets" if missing else "ok",
        "missing": missing,
        "needs": needs,
        "source": record.get("source"),
        "assumed": list(caps.get("assumed") or []),
        "classified_at": record.get("classified_at"),
    }


def asset_blocker(missing: list[dict[str, Any]]) -> str:
    return ASSET_BLOCKER + "; ".join(item["label"] for item in missing)


def is_asset_blocker(blocker: str) -> bool:
    return blocker.startswith(ASSET_BLOCKER)


# ---- classifying a claim's needs -----------------------------------------------------------------------


def claim_input(claim: Claim) -> dict[str, Any]:
    card = claim.card or {}
    setup = card.get("paper_setup") if isinstance(card.get("paper_setup"), dict) else {}
    return {
        "category": claim.category,
        "technique": claim.technique,
        "change_required": claim.change_required,
        "prerequisites": [str(item) for item in card.get("prerequisites") or []],
        "risks": [str(item) for item in card.get("risks") or []],
        "paper_setup": {key: setup.get(key) for key in ("model", "framework", "hardware", "sequence_length")},
        "effects": [
            {key: effect.get(key) for key in ("metric", "value", "unit", "conditions")}
            for effect in (card.get("effects") or [])[:3]
            if isinstance(effect, dict)
        ],
    }


def input_hash(claim: Claim) -> str:
    """Changes when the claim's text, the prompt or PROMPT_VERSION does, so only those claims are re-classified."""
    blob = json.dumps([PROMPT_VERSION, NEEDS_SYSTEM, claim_input(claim)], sort_keys=True, ensure_ascii=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]


NEEDS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["claim_id", "needs"],
                "properties": {
                    "claim_id": {"type": "integer"},
                    "needs": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["category", "key", "label", "essential", "why"],
                            "properties": {
                                "category": {"type": "string", "enum": list(CATEGORIES)},
                                "key": {"type": "string"},
                                "label": {"type": "string"},
                                "essential": {"type": "boolean"},
                                "why": {"type": "string"},
                            },
                        },
                    },
                },
            },
        }
    },
}

NEEDS_SYSTEM = (
    "You pre-screen research claims before an engineer reproduces them in an LLM inference engine. For each claim, "
    "list its hard prerequisites: things that must already exist for the technique to run faithfully and deliver "
    "the paper's benefit, and that a coding agent can't write as code in a few hours. Typical ones: a trained "
    "draft model or speculative heads (EAGLE, Medusa, Hydra, DFlash, a learned drafter or corrector); the served "
    "model's own MTP heads; an offline-quantized checkpoint or another artifact prepared offline (AWQ/GPTQ/HQQ "
    "weights, codebooks, rotations, saved statistics); a calibration dataset; a particular architecture (MoE "
    "experts, a diffusion LM); CUDA/Triton kernels; several GPUs; a minimum context length; training or "
    "fine-tuning; trained adapter weights.\n"
    "Don't list code to write, hyperparameters, benchmarks or workloads, the hardware or framework the paper "
    "happened to use when the idea is portable, statistics the technique gathers online while serving, or "
    "n-gram/suffix/prompt-lookup/Jacobi drafting (no trained drafter needed). When the claimed gain was measured at, "
    "or only appears at, long contexts, list min_context with the context length it was measured at. List "
    "custom_kernels only when the technique depends on CUDA/Triton-specific hardware features or libraries; a custom "
    "kernel that could be written for any GPU is not a prerequisite. training means training or fine-tuning weights "
    "before serving; fitting small predictors or statistics on the fly while serving is part of the technique. "
    "calibration_data means a corpus for offline calibration (activation statistics, Hessians, quantization); a "
    "held-out prompt set for evaluation or threshold tuning is not a prerequisite. List architecture only for "
    "something many current decoder-only LLMs lack (MoE experts, SSM or linear-attention layers, MLA, a sparse-"
    "attention indexer, diffusion decoding, vision inputs), not for standard features such as grouped-query "
    "attention or RoPE. Return an empty list when nothing is needed.\n"
    "Fields of each need:\n"
    "- category: one of "
    + "; ".join(f"{name} = {text}" for name, text in CATEGORIES.items())
    + ".\n"
    "- key: a short lowercase identifier to match against the project's capability list. The method or asset for "
    "draft_model, trained_adapter, offline_artifact and calibration_data (eagle3, medusa, dflash, awq, hqq, gptq…), "
    'or "any" when any such asset works (e.g. any smaller draft model with the same tokenizer); the architecture '
    "for architecture (moe, dense, diffusion, ssm); the toolchain for custom_kernels (cuda, triton); the number of "
    'tokens for min_context (e.g. 262144); otherwise "".\n'
    '- label: what\'s missing in at most 8 words, completing "needs …", e.g. "a trained EAGLE-3 draft head".\n'
    "- essential: true when the technique can't run, or loses the paper's benefit, without it; false when it only helps.\n"
    "- why: at most 15 words of evidence from the claim."
)


def _claim_prompt(claim: Claim) -> str:
    data = claim_input(claim)
    setup = ", ".join(f"{key}={value}" for key, value in data["paper_setup"].items() if value)
    return "\n".join(
        line
        for line in (
            f"claim_id={claim.id} [{data['category']}]",
            f"technique: {data['technique']}",
            f"change: {data['change_required']}" if data["change_required"] else "",
            f"paper's prerequisites: {data['prerequisites']}" if data["prerequisites"] else "",
            f"risks: {data['risks']}" if data["risks"] else "",
            f"paper setup: {setup}" if setup else "",
            *(
                f"claimed: {effect['value']} {effect['unit'] or ''} {effect['metric']} ({effect['conditions'] or 'no conditions'})"
                for effect in data["effects"]
            ),
        )
        if line
    )


def _clean_needs(raw: Any) -> list[dict[str, Any]]:
    needs = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        category = item.get("category") if item.get("category") in CATEGORIES else "other"
        label = str(item.get("label") or "").strip() or DEFAULT_LABELS[category]
        label = re.sub(r"^needs\s+", "", label, flags=re.I)
        needs.append(
            {
                "category": category,
                "key": str(item.get("key") or "").strip().lower()[:60],
                "label": label[:160],
                "essential": item.get("essential") is not False,
                "why": str(item.get("why") or "").strip()[:200],
            }
        )
    return needs[:8]


def _classify_llm(llm: LLMClient, claims: list[Claim]) -> Optional[dict[int, list[dict[str, Any]]]]:
    prompt = "Claims:\n\n" + "\n\n".join(_claim_prompt(claim) for claim in claims)
    try:
        payload = llm.generate_json(NEEDS_SYSTEM, prompt, "claim_needs", NEEDS_SCHEMA)
    except Exception as exc:  # noqa: BLE001 - a failed batch falls back to the rules and is retried next match
        logger.warning("claim pre-screen failed for %d claims: %s", len(claims), exc)
        return None
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return None
    ids = {claim.id for claim in claims}
    return {
        item["claim_id"]: _clean_needs(item.get("needs"))
        for item in items
        if isinstance(item, dict) and item.get("claim_id") in ids
    }


# Keyword rules (the fallback): (category, pattern, key, label). `key`/`label` may use the match's text via {m}.
RULES: list[tuple[str, re.Pattern[str], str, str]] = [
    ("draft_model", re.compile(r"\b(eagle[- ]?\d?|medusa|hydra|dflash|lafa|redrafter)\b", re.I), "{m}",
     "a trained {M} draft head or model"),
    ("draft_model", re.compile(r"\b(draft(?:ing)? models?|drafters?|draft heads?|(?:small|smaller|auxiliary) "
                               r"(?:language )?models? (?:as|for) (?:the )?draft)", re.I), "any", "a draft model"),
    ("mtp_heads", re.compile(r"\b(mtp|multi[- ]token[- ]prediction)\b", re.I), "mtp", "native MTP heads in the served model"),
    ("offline_artifact", re.compile(r"\b(awq|gptq|hqq|quip#?|aqlm|squeezellm|spinquant|quarot|omniquant|gguf|exl2|"
                                    r"kronq|gptaq|biip)\b", re.I), "{m}", "offline {M} artifacts or checkpoint"),
    ("offline_artifact", re.compile(r"\b(pre-?quantized|offline[- ]quantized|quantized checkpoint|converted checkpoint|"
                                    r"checkpoint_dir|re-?convert\w*)", re.I), "any",
     "an offline-quantized or converted checkpoint"),
    ("calibration_data", re.compile(r"\b(calibration (?:data|dataset|set|samples|corpus|tokens|run)|calibrat\w* (?:on|with|"
                                    r"using) (?:a |the )?[\w-]+ (?:data|dataset|samples|corpus))", re.I), "any",
     "a calibration dataset"),
    ("architecture", re.compile(r"\b(moe|mixture[- ]of[- ]experts|experts? (?:routing|dispatch|parallel\w*))\b", re.I),
     "moe", "an MoE (mixture-of-experts) model"),
    ("architecture", re.compile(r"\b(diffusion (?:language )?models?|dllms?|masked diffusion)\b", re.I), "diffusion",
     "a diffusion language model"),
    ("custom_kernels", re.compile(r"\b(cuda|triton|cutlass|flashinfer|ptx|tensor cores?)\b", re.I), "{m}",
     "CUDA/Triton kernels"),
    ("multi_gpu", re.compile(r"(multi-?gpu|multiple gpus|tensor[- ]parallel\w*|pipeline[- ]parallel\w*|across \d+ gpus|"
                             r"nvlink)", re.I), "", "multiple GPUs"),
    ("training", re.compile(r"\b(fine-?tun\w*|retrain\w*|re-train\w*|train(?:ed|ing)? (?:a|the|an) (?:model|drafter|"
                            r"head|predictor|corrector)|distillation training)\b", re.I), "", "model training or fine-tuning"),
    ("trained_adapter", re.compile(r"\b(lora|adapter weights?|trained adapters?)\b", re.I), "{m}",
     "trained adapter weights"),
]
CONTEXT_RULE = re.compile(
    r"(\d+(?:\.\d+)?\s*[km])[- ]?(?:token)?s?\s*(?:of\s+)?(?:context|ctx)|context (?:length|window)s? (?:of |up to )?"
    r"(\d[\d,]*\s*[km]?)",
    re.I,
)
# Drafting that needs no trained model: n-gram, suffix, prompt-lookup, Jacobi, self-speculative.
MODEL_FREE_DRAFT = re.compile(r"\b(n-?grams?|suffix\w*|lookup|jacobi|self[- ]\w*|retrieval|lookahead)\b[^.;]{0,25}$", re.I)
NEGATION = re.compile(r"\b(no|without|not|never|avoid\w*|instead of|rather than|replac\w*|free of)\b[^.;]{0,30}$", re.I)


def _negated(text: str, start: int, end: int) -> bool:
    return bool(NEGATION.search(text[max(0, start - 40) : start])) or text[end : end + 5].lower() == "-free"


def classify_rules(claim: Claim) -> list[dict[str, Any]]:
    """Keyword fallback over the claim's technique, change, prerequisites and the risks that state a requirement."""
    data = claim_input(claim)
    parts = [data["technique"] or "", data["change_required"] or "", *data["prerequisites"]]
    parts += [risk for risk in data["risks"] if re.search(r"\brequir", risk, re.I)]
    text = " .; ".join(parts)
    needs: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def add(category: str, key: str, label: str, why: str) -> None:
        if (category, key) not in seen:
            seen.add((category, key))
            needs.append({"category": category, "key": key, "label": label, "essential": True, "why": why[:200]})

    for category, pattern, key, label in RULES:
        for match in pattern.finditer(text):
            if _negated(text, match.start(), match.end()):
                continue
            if category == "draft_model" and key == "any" and MODEL_FREE_DRAFT.search(text[max(0, match.start() - 40) : match.start()]):
                continue
            name = match.group(1).strip()
            add(category, key.format(m=re.sub(r"[^a-z0-9#]+", "", name.lower())), label.format(M=name.upper()),
                text[max(0, match.start() - 40) : match.end() + 40].strip())
            break
    for match in CONTEXT_RULE.finditer(text):
        tokens = context_tokens(match.group(1) or match.group(2))
        if tokens and tokens > 8192 and not _negated(text, match.start(), match.end()):
            add("min_context", str(tokens), f"a {tokens // 1024}K-token context window", match.group(0))
            break
    return needs


# ---- storage --------------------------------------------------------------------------------------------


def _record(row: ClaimNeeds) -> dict[str, Any]:
    return {
        "input_hash": row.input_hash,
        "needs": list(row.needs or []),
        "source": row.source,
        "model": row.model,
        "classified_at": row.classified_at.isoformat() if row.classified_at else None,
    }


def stored_needs(claims: Iterable[Claim]) -> dict[int, dict[str, Any]]:
    """Stored classifications that still match each claim's text."""
    hashes = {claim.id: input_hash(claim) for claim in claims}
    if not hashes:
        return {}
    with session_scope() as session:
        rows = session.scalars(select(ClaimNeeds).where(ClaimNeeds.claim_id.in_(list(hashes)))).all()
        return {row.claim_id: _record(row) for row in rows if row.input_hash == hashes[row.claim_id]}


def _store(results: dict[int, dict[str, Any]], hashes: dict[int, str]) -> None:
    if not results:
        return
    with session_scope() as session:
        for claim_id, result in results.items():
            values = {
                "input_hash": hashes[claim_id],
                "needs": result["needs"],
                "source": result["source"],
                "model": result.get("model"),
                "classified_at": func.now(),
            }
            statement = insert(ClaimNeeds).values(claim_id=claim_id, **values)
            session.execute(statement.on_conflict_do_update(index_elements=[ClaimNeeds.claim_id], set_=values))


def classify(
    claims: list[Claim],
    llm: Optional[LLMClient],
    force: bool = False,
    batch_size: int = 10,
    workers: int = 3,
    say: Optional[Callable[[str], None]] = None,
) -> dict[int, dict[str, Any]]:
    """Each claim's needs: stored ones when the claim text is unchanged (an LLM classification is kept even
    without an LLM; a rule-based one is redone when an LLM is available), new ones otherwise."""
    hashes = {claim.id: input_hash(claim) for claim in claims}
    stored = {} if force else stored_needs(claims)
    todo = [claim for claim in claims if claim.id not in stored or (llm is not None and stored[claim.id]["source"] != "llm")]
    if not todo:
        return stored
    results: dict[int, dict[str, Any]] = {}
    if llm is not None:
        batches = [todo[index : index + batch_size] for index in range(0, len(todo), batch_size)]
        if say:
            say(f"Pre-screening {len(todo)} claims for missing assets ({len(batches)} LLM calls)")
        with ThreadPoolExecutor(max_workers=max(1, min(workers, len(batches)))) as pool:
            for batch, output in zip(batches, pool.map(lambda batch: _classify_llm(llm, batch), batches)):
                for claim in batch:
                    if output is not None and claim.id in output:
                        results[claim.id] = {"needs": output[claim.id], "source": "llm", "model": llm.model}
    for claim in todo:
        results.setdefault(claim.id, {"needs": classify_rules(claim), "source": "rules", "model": None})
    _store(results, hashes)
    return {**stored, **stored_needs(todo)}


# ---- applying the result to matches ----------------------------------------------------------------------


def apply_check(match: Match, check: Optional[dict[str, Any]]) -> None:
    """Replace the match's asset blocker with `check`'s, keeping its other blockers, and update `testable_here`
    and the score (blocked claims keep `BLOCKED_SCORE_FACTOR` of their unblocked score)."""
    previous = match.asset_check or {}
    old_blockers = list(match.blockers or [])
    blockers = [blocker for blocker in old_blockers if not is_asset_blocker(blocker) and blocker != NO_METRIC_BLOCKER]
    if check and check["missing"]:
        blockers.append(asset_blocker(check["missing"]))
    if not blockers and not match.target_metric:
        blockers.append(NO_METRIC_BLOCKER)
    base = previous.get("base_score")
    if base is None:
        base = (match.score or 0.0) / BLOCKED_SCORE_FACTOR if old_blockers else (match.score or 0.0)
    match.blockers = blockers
    match.testable_here = not blockers
    match.score = round(base * (BLOCKED_SCORE_FACTOR if blockers else 1.0), 5)
    match.asset_check = {**check, "base_score": base} if check else None


def reassess_project(
    project_id: int, dry_run: bool = False, profile: Optional[dict[str, Any]] = None
) -> dict[str, Any]:
    """Compare stored claim needs with the project's capabilities (after a re-profile; no LLM calls). With
    `dry_run`, nothing is written; `profile` overrides the stored one (e.g. a lab.yaml not registered yet)."""
    counts: dict[str, Any] = {"checked": 0, "needs_assets": 0, "newly_blocked": [], "newly_testable": []}
    with session_scope() as session:
        project = session.get(Project, project_id)
        if project is None:
            return counts
        caps = capabilities(profile if profile is not None else project.profile or {})
        rows = session.execute(
            select(Match, Claim, ClaimNeeds)
            .join(Claim, Claim.id == Match.claim_id)
            .join(ClaimNeeds, ClaimNeeds.claim_id == Match.claim_id)
            .where(Match.project_id == project_id)
        ).all()
        for match, claim, row in rows:
            if row.input_hash != input_hash(claim):
                continue
            was_testable = bool(match.testable_here)
            apply_check(match, check_needs(_record(row), caps))
            counts["checked"] += 1
            counts["needs_assets"] += match.asset_check["status"] == "needs_assets"
            if was_testable and not match.testable_here:
                counts["newly_blocked"].append(claim.id)
            elif not was_testable and match.testable_here:
                counts["newly_testable"].append(claim.id)
        if dry_run:
            session.rollback()
    return counts


def backfill(
    project_id: int,
    llm: Optional[LLMClient],
    force: bool = False,
    every_claim: bool = False,
    dry_run: bool = False,
    reprofile: bool = False,
    workers: int = 3,
    say: Callable[[str], None] = print,
) -> dict[str, Any]:
    """Classify the project's matched claims (by default the testable ones, those blocked only for missing assets,
    and every claim it has experimented on), re-check them against its capabilities and report the effect.
    `reprofile` re-reads lab.yaml first (with `dry_run`, only for the comparison)."""
    from paperatlas.db.schema import Experiment, Verdict
    from paperatlas.lab.profiler import read_profile, register_project

    with session_scope() as session:
        project = session.get(Project, project_id)
        repo_path, name = project.repo_path, project.name
        rows = session.execute(
            select(Match, Claim).join(Claim, Claim.id == Match.claim_id).where(Match.project_id == project_id)
        ).all()
        tested = set(session.scalars(select(Experiment.claim_id).where(Experiment.project_id == project_id)).all())
        before = {match.claim_id for match, _ in rows if match.testable_here}
        claims = [
            claim
            for match, claim in rows
            if every_claim
            or claim.id in tested
            or not [b for b in match.blockers or [] if not is_asset_blocker(b) and b != NO_METRIC_BLOCKER]
        ]
        session.expunge_all()
    say(f"{len(rows)} matched claims; classifying {len(claims)} ({len(before)} testable now)")
    classify(claims, llm, force=force, workers=workers, say=say)
    profile = None
    if reprofile and dry_run:
        profile = read_profile(repo_path)
    elif reprofile:
        register_project(repo_path, name)  # re-checks every claim against the new capabilities
    counts = reassess_project(project_id, dry_run=dry_run, profile=profile)
    with session_scope() as session:
        caps = capabilities(profile if profile is not None else session.get(Project, project_id).profile or {})
        checks = {claim.id: check_needs(record, caps) for claim, record in _records(session, claims)}
        after = before - set(counts["newly_blocked"]) | set(counts["newly_testable"])
        if not dry_run:
            after = set(
                session.scalars(
                    select(Match.claim_id).where(Match.project_id == project_id, Match.testable_here.is_(True))
                ).all()
            )
        experiments = session.execute(
            select(Experiment.id, Experiment.claim_id, Experiment.status, Verdict.verdict, Claim.technique)
            .join(Claim, Claim.id == Experiment.claim_id)
            .outerjoin(Verdict, Verdict.experiment_id == Experiment.id)
            .where(Experiment.project_id == project_id)
            .order_by(Experiment.id)
        ).all()

    def missing(claim_id: int) -> list[dict[str, Any]]:
        return (checks.get(claim_id) or {}).get("missing") or []

    held_back = sorted(cid for cid in before - after if missing(cid))
    by_category: dict[str, int] = {}
    for cid in held_back:
        for category in dict.fromkeys(item["category"] for item in missing(cid)):
            by_category[category] = by_category.get(category, 0) + 1
    return {
        "project_id": project_id,
        "dry_run": dry_run,
        "capabilities": caps,
        "classified": len(claims),
        "sources": {
            source: sum(1 for check in checks.values() if check and check["source"] == source) for source in ("llm", "rules")
        },
        "testable_before": len(before),
        "testable_after": len(after),
        "needs_assets": sum(1 for check in checks.values() if check and check["missing"]),
        "newly_needs_assets": [
            {"claim_id": cid, "missing": [item["label"] for item in missing(cid)]} for cid in held_back
        ],
        "newly_testable": sorted(after - before),
        "by_category": dict(sorted(by_category.items(), key=lambda item: -item[1])),
        "experiments": [
            {
                "experiment_id": experiment_id,
                "claim_id": claim_id,
                "status": status,
                "verdict": verdict,
                "technique": technique,
                "needs_assets": bool(missing(claim_id)),
                "missing": [item["label"] for item in missing(claim_id)],
            }
            for experiment_id, claim_id, status, verdict, technique in experiments
        ],
    }


def _records(session, claims: list[Claim]) -> list[tuple[Claim, dict[str, Any]]]:
    hashes = {claim.id: input_hash(claim) for claim in claims}
    rows = session.scalars(select(ClaimNeeds).where(ClaimNeeds.claim_id.in_(list(hashes)))).all() if hashes else []
    by_id = {row.claim_id: row for row in rows if row.input_hash == hashes[row.claim_id]}
    return [(claim, _record(by_id[claim.id])) for claim in claims if claim.id in by_id]


def public_check(check: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """The stored check without internal bookkeeping (for the API)."""
    if not check:
        return None
    return {key: value for key, value in check.items() if key != "base_score"}
