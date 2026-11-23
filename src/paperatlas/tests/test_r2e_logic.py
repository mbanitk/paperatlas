import pytest

from paperatlas.distill.claims import DISTILLATION_SCHEMA, ClaimEffect
from paperatlas.distill.extractor import parse_distillation
from paperatlas.lab.judge import judge
from paperatlas.lab.matcher import blockers_for, map_metric
from paperatlas.lab.planner import apply_overrides, plan_experiment
from paperatlas.tests.conftest import PROFILE, bench_results, concept


@pytest.mark.parametrize(
    ("value", "unit", "direction", "expected"),
    [
        (30, "%", "decrease", 30.0),
        (2.0, "x", "increase", 100.0),
        (4.0, "x", "decrease", 75.0),
        (0.5, "x", "decrease", 50.0),
        (12, "ms", "decrease", None),
        (10, "%", "none", None),
    ],
)
def test_claimed_gain_normalization(value, unit, direction, expected):
    gain = ClaimEffect(metric="m", value=value, unit=unit, direction=direction).gain_pct()
    assert gain == pytest.approx(expected) if expected is not None else gain is None


def test_absolute_levels_are_not_gains():
    assert ClaimEffect(metric="accuracy", value=87.3, unit="%", direction="increase", relative=False).gain_pct() is None


def test_distillation_schema_is_valid_for_strict_structured_outputs():
    def walk(node):
        if node.get("type") == "object":
            assert node["additionalProperties"] is False
            assert sorted(node["required"]) == sorted(node["properties"])
            for child in node["properties"].values():
                walk(child)
        if node.get("type") == "array":
            walk(node["items"])

    walk(DISTILLATION_SCHEMA)


def test_parse_distillation_skips_only_malformed_concepts():
    good = concept("Prompt lookup decoding")
    bad = {"name": "broken", "kind": "method", "summary": "x", "key_points": [], "claim": {"testable": True}}
    parsed = parse_distillation({"paper_summary": "s", "concepts": [good, bad]})
    assert [c.name for c in parsed.concepts] == [good["name"]]


def test_metric_mapping_and_blockers():
    metrics = ["ttft_ms", "decode_tokens_per_s", "peak_memory_gb"]
    assert map_metric("Time to first token (TTFT)", metrics) == "ttft_ms"
    assert map_metric("decoding speedup", metrics) == "decode_tokens_per_s"
    assert map_metric("KV cache memory footprint", metrics) == "peak_memory_gb"
    assert map_metric("BLEU", metrics) is None

    class ClaimStub:
        requires_cuda = True
        requires_multi_gpu = False
        requires_training = False
        category = "disaggregated_serving"
        testable = True

    assert blockers_for(ClaimStub(), {"cuda": False}, topic_needs_cluster=False) == ["needs CUDA", "needs a GPU cluster"]


def _claim(**overrides):
    return {
        "technique": "Draft tokens with n-gram lookup",
        "change_required": "Replace the decode loop",
        "category": "speculative_decoding",
        "claimed_gain_pct": 8.0,
        "card": {},
        **overrides,
    }


def test_plan_without_llm_respects_claim_and_project():
    spec = plan_experiment(_claim(), PROFILE, "decode_tokens_per_s", llm=None)
    assert spec["primary_metric"] == "decode_tokens_per_s"
    assert spec["direction"] == "higher_is_better"
    assert spec["success_threshold_pct"] <= 8.0
    assert spec["lossless"] and spec["guardrails"]["min_output_agreement"] == 0.95
    assert spec["flag_name"].isidentifier()


def test_spec_overrides_are_validated():
    spec = plan_experiment(_claim(), PROFILE, "decode_tokens_per_s", llm=None)
    updated = apply_overrides(spec, {"primary_metric": "ttft_ms", "rounds": 20}, PROFILE)
    assert updated["direction"] == "lower_is_better" and updated["rounds"] == 20
    with pytest.raises(ValueError):
        apply_overrides(spec, {"guardrails": {}}, PROFILE)
    with pytest.raises(ValueError):
        apply_overrides(spec, {"primary_metric": "bleu"}, PROFILE)
    with pytest.raises(ValueError):
        apply_overrides(spec, {"rounds": 1}, PROFILE)
    with pytest.raises(ValueError):
        apply_overrides(spec, {"flag_name": "Bad Flag!"}, PROFILE)


SPEC = {
    "primary_metric": "decode_tokens_per_s",
    "direction": "higher_is_better",
    "success_threshold_pct": 5.0,
    "claimed_gain_pct": 20.0,
    "guardrails": {"max_exact_match_drop": 0.02, "min_output_agreement": None, "max_peak_memory_increase_pct": 15},
}


@pytest.mark.parametrize(
    ("variant", "quality", "expected"),
    [
        ([122, 121, 119, 120, 123, 121], None, "reproduced"),
        ([108, 107, 108, 109, 107, 108], None, "partial"),
        ([101, 99, 100, 102, 98, 100], None, "not_reproduced"),
        ([90, 91, 89, 90, 92, 90], None, "regression"),
        (
            [122, 121, 119, 120, 123, 121],
            {"baseline": {"exact_match": 0.95}, "variant": {"exact_match": 0.80}, "output_agreement": 0.7},
            "regression",
        ),
    ],
)
def test_verdict_rules(variant, quality, expected):
    results = bench_results([100, 101, 99, 100, 100, 101], variant, quality=quality)
    verdict = judge(results, SPEC, PROFILE)
    assert verdict["verdict"] == expected
    assert verdict["quality_ok"] is (quality is None)


def test_lower_is_better_metrics_count_reductions_as_improvements():
    spec = {**SPEC, "primary_metric": "ttft_ms", "direction": "lower_is_better", "claimed_gain_pct": 10.0}
    results = bench_results([200, 202, 198, 201], [170, 172, 168, 171], metric="ttft_ms")
    verdict = judge(results, spec, PROFILE)
    assert verdict["median_delta_pct"] == pytest.approx(15.0, abs=0.5)
    assert verdict["verdict"] == "reproduced"
