"""Protocol v2 fixtures for seed_demo.py ("faithful experiments").

Three experiments that exercise the v2 UI:
- Gate 2: cross-request batched verification — the patent compares against *per-request* verification, so the
  claim check uses technique_mode (same flag, mode=baseline) on a paper-like workload; low fidelity (a patent).
- Gate 3: adaptive n-gram prompt lookup — two iterations (the first build never used 4-grams), tuned knobs,
  mechanism counters (one missing), a partial claim verdict and a worth-adopting adoption verdict, analyst diagnosis.
- In progress: bandwidth-aware lookahead window — status `tuning`, two of four tune configs measured.

Shapes mirror paperatlas.lab.protocol / judge.judge / orchestrator.node_judge / runner.tune.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

GUARDRAILS = {"max_exact_match_drop": 0.02, "min_output_agreement": 0.95, "max_peak_memory_increase_pct": 15.0}
QUALITY = {"baseline": {"exact_match": 0.81, "n": 20}, "variant": {"exact_match": 0.81, "n": 20}, "output_agreement": 1.0}
TOKENS = 10240

SUMMARISE = [
    "Summarise the following news article in three sentences, reusing its key phrases: The city council voted on Tuesday to extend the "
    "night bus network to the airport after a two-year pilot showed ridership rising by a third, with the new routes starting in March.",
    "Write a short summary of this report, quoting its figures exactly: Quarterly revenue grew 12% to $4.1bn, driven by cloud services, "
    "while hardware sales fell 3% and operating margin narrowed to 21% because of higher component costs.",
    "Summarise this article for a newsletter: Researchers released an open dataset of 40,000 annotated satellite images of glaciers, "
    "covering 1990–2025, to help models track ice loss; early results show retreat accelerating in the Alps.",
    "Condense the following press release into two sentences: The museum will reopen its east wing on 1 June after a renovation that "
    "added climate control, step-free access and a new gallery for the permanent textile collection.",
]
CHAT = [
    "A customer asks why their order shows 'shipped' but tracking has not updated for two days. Reply helpfully in four sentences.",
    "Explain to a new teammate how to rebase a feature branch onto main and resolve a conflict, in a short numbered list.",
    "Draft a polite reply declining a meeting invitation next Thursday and proposing two alternative times.",
    "Give three tips for writing a clear bug report, each with a one-sentence example.",
]
MT_BENCH = [
    "Compose an engaging travel blog post about a recent trip to Hawaii, highlighting cultural experiences and must-see attractions.",
    "Write a persuasive email to convince your introverted friend to volunteer as a guest speaker at a local event.",
    "Explain the difference between a list and a tuple in Python, with a short example of when to use each.",
]


def _with(results: dict[str, Any], comparison: dict[str, Any], workload: Any, mechanism: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    results = dict(results)
    results["comparison"] = comparison
    results["workload"] = workload
    if mechanism is not None:
        results["mechanism"] = mechanism
    return results


def _mechanism(flag: str, baseline: dict[str, float], variant: dict[str, float]) -> dict[str, Any]:
    return {
        "baseline": {"techniques": {flag: baseline} if baseline else {}, "tokens": TOKENS},
        "variant": {"techniques": {flag: variant}, "tokens": TOKENS},
    }


def _add_run(seeder: Any, eid: int, kind: str, status: str, started: datetime, finished: Optional[datetime], spec: dict, results: Optional[dict],
             workload_arg: str, label: str = "") -> None:
    from paperatlas.db.engine import session_scope
    from paperatlas.db.schema import Run

    rounds = 2 if kind == "smoke" else int(spec.get("tune_rounds") or 1) if kind == "tune" else spec["rounds"]
    out = f"data/r2e/experiments/{eid}/{kind}-{started:%Y%m%d-%H%M%S}.json"
    command = (f"uv run python -m inference_lab.bench.ab --model {'smoke' if kind == 'smoke' else spec['model']} "
               f"--baseline-flags '{'' if kind == 'adopt' or spec['paper_baseline']['kind'] != 'technique_mode' else spec['flag_name']}' "
               f"--variant-flags {spec['flag_name']} --workload {workload_arg} --rounds {rounds} --warmup {spec['warmup']} --out {out}"
               + (f"  # {label}" if label else ""))
    with session_scope() as session:
        session.add(Run(experiment_id=eid, kind=kind, status=status, command=command, results=results, results_path=out,
                        log_path=out.replace(".json", ".log"), started_at=started, finished_at=finished))


def exp_v2_gate2(seeder: Any, kit: Any, project_id: int, triage_id: int) -> int:
    key = "c_batched_verify"
    created = kit.ago(minutes=25)
    spec = kit.spec_for(
        hypothesis="Batching the verify passes of 4 concurrent speculative requests raises throughput_tokens_per_s by at least 10% over "
        "per-request verification, with identical greedy outputs.",
        flag_name="batched_verification", technique_summary=seeder.claim_rows[key]["card"].technique,
        implementation_notes="In the scheduler hook, collect verify requests from concurrent speculative streams for up to verify_window_ms "
        "(or until max_verify_batch are queued), pad drafts to the longest and run one target forward pass. mode=baseline keeps today's "
        "per-request verification with speculative decoding on; mode=method batches. Report verify_passes, verify_batch_size and padding_tokens.",
        primary_metric="throughput_tokens_per_s", direction="higher_is_better", secondary_metrics=["itl_ms", "e2e_latency_ms", "peak_memory_gb"],
        workload="concurrent_4", model="eval", rounds=10, warmup=1, success_threshold_pct=5.0, claimed_gain_pct=25.0, lossless=True,
        guardrails=GUARDRAILS,
        paper_vs_project="The patent's example embodiment gives only '4 concurrent requests, ~1.25x aggregate throughput' — no hardware, "
        "model or draft length. inference-lab runs Qwen3-30B-A3B on MPS with a 0.6B drafter.",
        paper_baseline={"kind": "technique_mode", "description": "Speculative decoding with per-request verification: each of the 4 "
                        "concurrent streams runs its own verify pass (the patent's comparison)"},
        paper_workload={"matches": "the patent's example: 4 concurrent chat requests (Description [0052])",
                        "description": "Short chat turns served concurrently, speculative decoding on in both arms",
                        "prompts": CHAT, "max_new_tokens": 128, "concurrency": 4, "long_context_tokens": 0},
        mechanism=[
            {"name": "verify_passes", "meaning": "target forward passes spent on verification", "paper_value": "≈ 1 per step instead of 4"},
            {"name": "verify_batch_size", "meaning": "requests verified together per pass", "paper_value": "up to 4"},
            {"name": "padding_tokens", "meaning": "pad tokens added to equalise draft lengths", "paper_value": None},
        ],
        knobs=[
            {"name": "verify_window_ms", "meaning": "how long to wait to group verify requests", "paper_value": "not stated", "candidates": [2, 1, 4]},
            {"name": "max_verify_batch", "meaning": "most requests per verify pass", "paper_value": "4", "candidates": [4, 8]},
        ],
        fidelity={"level": "low", "gaps": [
            "A patent example embodiment: no hardware, model, draft length or dataset is given",
            "Only one regime is described (4 concurrent requests); the claim may not hold at other loads",
            "Throughput is measured on MPS unified memory, where a padded batch costs more than on a datacenter GPU",
        ]},
        tune=True, tune_rounds=1, max_iterations=2,
    )
    eid = seeder._experiment(project_id, key, "awaiting_approval", created, created + timedelta(minutes=2), triage_id=triage_id, spec=spec)
    seeder._artifacts(eid)
    seeder._plan_events(eid, created, spec, triage_id, None)
    seeder.event(created + timedelta(minutes=1, seconds=40), "plan",
                 "Protocol: claim check vs the paper's baseline (per-request verification) on a 4-request paper-like workload; "
                 "adoption check vs the project default on concurrent_4", experiment_id=eid, job=f"run-{eid}")
    return eid


def exp_v2_gate3(seeder: Any, kit: Any, project_id: int, triage_id: int) -> int:
    from paperatlas.db.engine import session_scope
    from paperatlas.db.schema import Verdict
    from paperatlas.lab.judge import judge
    from paperatlas.lab.report import render_report
    from paperatlas.lab.service import get_claim

    key = "c_adaptive_ngram"
    ago, make_results, PROFILE = kit.ago, kit.make_results, kit.profile
    created = ago(hours=9)
    flag = "adaptive_ngram_lookup"
    spec = kit.spec_for(
        hypothesis="Adaptive n-gram matching (4→1 fallback) with acceptance-aware draft caps raises decode_tokens_per_s by at least 8.4% over "
        "fixed n=3, k=10 prompt lookup on summarisation, with identical greedy outputs.",
        flag_name=flag, technique_summary=seeder.claim_rows[key]["card"].technique,
        implementation_notes="Extend the prompt-lookup draft provider: mode=baseline is the paper's fixed n=3, k=10; mode=method matches the "
        "longest n-gram first (max_ngram → 1) and bounds k by an EMA of accepted lengths (2–draft_cap). Report verify_steps, "
        "accepted_draft_tokens, ngram4_matches and draft_cap_adjustments.",
        primary_metric="decode_tokens_per_s", direction="higher_is_better", secondary_metrics=["itl_ms", "e2e_latency_ms", "ttft_ms"],
        workload="long_prompt", model="eval", rounds=10, warmup=1, success_threshold_pct=5.0, claimed_gain_pct=12.0, lossless=True,
        guardrails=GUARDRAILS,
        paper_vs_project="Paper: Mistral-7B on an A100 with CNN/DailyMail articles. Here: Qwen3-30B-A3B on MPS with four representative "
        "summarisation prompts; per-pass verify cost is relatively higher, so longer drafts pay off less.",
        paper_baseline={"kind": "technique_mode", "description": "Prompt lookup with a fixed n-gram size n=3 and draft cap k=10 (the paper's baseline)"},
        paper_workload={"matches": "CNN/DailyMail summarisation (paper §5, Table 4)", "description": "Summaries that copy spans from the input",
                        "prompts": SUMMARISE, "max_new_tokens": 128, "concurrency": 1, "long_context_tokens": 0},
        mechanism=[
            {"name": "verify_steps", "meaning": "target forward passes", "paper_value": "fewer than fixed n=3 (not quantified)"},
            {"name": "accepted_draft_tokens", "meaning": "draft tokens accepted by the target", "paper_value": "+12% per step"},
            {"name": "ngram4_matches", "meaning": "steps drafted from a 4-gram match", "paper_value": None},
            {"name": "draft_cap_adjustments", "meaning": "times the EMA changed the draft cap", "paper_value": "k ∈ [2, 10]"},
        ],
        knobs=[
            {"name": "max_ngram", "meaning": "longest n-gram tried first", "paper_value": "4", "candidates": [4, 3, 5]},
            {"name": "draft_cap", "meaning": "upper bound of the EMA draft length", "paper_value": "10", "candidates": [10, 6]},
        ],
        fidelity={"level": "medium", "gaps": [
            "A100 + Mistral-7B in the paper vs M5 Pro + Qwen3-30B-A3B (MoE) here",
            "Four summarisation prompts stand in for the CNN/DailyMail test set",
        ]},
        tune=True, tune_rounds=1, max_iterations=2,
    )
    eid = seeder._experiment(project_id, key, "awaiting_decision", created, ago(hours=1, minutes=10), triage_id=triage_id, spec=spec)
    branch = f"r2e/exp-{eid}-adaptive-ngram-lookup"
    folder = seeder._artifacts(eid)
    paper_file = f"data/r2e/experiments/{eid}/paper_workload.json"
    approved = created + timedelta(minutes=12)
    seeder._plan_events(eid, created, spec, triage_id, approved)
    job = f"resume-{eid}"
    seeder.job(job, "experiment.resume", {"experiment_id": eid, "resume": {"decision": "approve", "comment": None}}, approved,
               finished=ago(hours=1, minutes=8), experiment_id=eid)
    paper_regime = {"name": "paper_regime", "requests_per_round": 4, "max_new_tokens": 128, "concurrency": 1}
    tuned_1 = {"baseline": {"max_ngram": 3, "draft_cap": 10}, "variant": {"max_ngram": 4, "draft_cap": 10}}
    configs = [{"max_ngram": 4, "draft_cap": 10}, {"max_ngram": 3, "draft_cap": 10}, {"max_ngram": 5, "draft_cap": 10}, {"max_ngram": 4, "draft_cap": 6}]
    trial_values = [(41.6, 43.9), (41.9, 42.7), (41.2, 44.6), (40.7, 42.8)]
    tuning = {
        "configs": configs,
        "trials": [{"config": c, "baseline": b, "variant": v} for c, (b, v) in zip(configs, trial_values)],
        "metric": "decode_tokens_per_s",
        "baseline": {"max_ngram": 3, "draft_cap": 10},
        "variant": {"max_ngram": 5, "draft_cap": 10},
        "skipped": False,
    }

    def claim_cmp(cfg: dict) -> dict:
        return {"kind": "claim", "workload": "paper regime", "baseline": "paper baseline", "baseline_config": cfg["baseline"], "variant_config": cfg["variant"]}

    def adopt_cmp(cfg: dict) -> dict:
        return {"kind": "adopt", "workload": "long_prompt", "baseline": "project default", "baseline_config": {}, "variant_config": cfg["variant"]}

    # ---- iteration 1: built, smoke, claim + adoption checks; the method never used 4-grams ----
    t = approved + timedelta(seconds=10)
    seeder.event(t, "build", f"Worktree ready on branch {branch}", {"worktree": f"data/r2e/worktrees/exp-{eid}"}, experiment_id=eid, job=job)
    seeder.event(t + timedelta(minutes=1), "build", f"copilot is implementing `{flag}` (attempt 1/3)", experiment_id=eid, job=job)
    seeder.event(t + timedelta(minutes=9), "build", "Build verified: 3 files changed, tests pass", experiment_id=eid, job=job)
    t += timedelta(minutes=10)
    smoke = _with(make_results(flag, "long_prompt", 2, {"decode_tokens_per_s": 2.0}, 701, QUALITY, model="smoke"), claim_cmp(tuned_1), paper_regime)
    _add_run(seeder, eid, "smoke", "done", t, t + timedelta(minutes=4), spec, smoke, paper_file)
    seeder.event(t, "smoke", "Smoke A/B: 2 rounds per arm, workload paper regime", experiment_id=eid, job=job)
    seeder.event(t + timedelta(minutes=4), "smoke", "Smoke A/B passed on the small model", experiment_id=eid, job=job)
    seeder.event(t + timedelta(minutes=4, seconds=5), "smoke",
                 "The technique did not report mechanism counters ['draft_cap_adjustments']; the verdict will not be able to say why",
                 experiment_id=eid, job=job, level="warning")
    t += timedelta(minutes=5)
    seeder.event(t, "tune", "Tuned: method uses {'max_ngram': 4, 'draft_cap': 10}, paper baseline uses {'max_ngram': 3, 'draft_cap': 10}",
                 {"tuning": tuned_1}, experiment_id=eid, job=job)
    t += timedelta(minutes=12)
    eval_1 = _with(make_results(flag, "long_prompt", 10, {"decode_tokens_per_s": 1.1, "itl_ms": 0.9}, 702, QUALITY), claim_cmp(tuned_1), paper_regime,
                   _mechanism(flag, {"verify_steps": 3810, "accepted_draft_tokens": 6430, "ngram4_matches": 0},
                              {"verify_steps": 3790, "accepted_draft_tokens": 6461, "ngram4_matches": 0}))
    _add_run(seeder, eid, "eval", "done", t, t + timedelta(minutes=26), spec, eval_1, paper_file)
    seeder.event(t, "run", "Claim check: 10 rounds per arm, workload paper regime", experiment_id=eid, job=job)
    t += timedelta(minutes=27)
    adopt_1 = _with(make_results(flag, "long_prompt", 10, {"decode_tokens_per_s": 14.9, "itl_ms": 12.8}, 703, QUALITY), adopt_cmp(tuned_1), "long_prompt",
                    _mechanism(flag, {}, {"verify_steps": 3720, "accepted_draft_tokens": 6522, "ngram4_matches": 0}))
    _add_run(seeder, eid, "adopt", "done", t, t + timedelta(minutes=28), spec, adopt_1, "long_prompt")
    seeder.event(t, "run", "Adoption check: 10 rounds per arm, workload long_prompt", experiment_id=eid, job=job)
    t += timedelta(minutes=29)
    next_1 = ("Start matching at n=max_ngram (the build starts at n=3, so 4-grams are never tried) and fall back 4→3→2→1; bound the draft "
              "length by the acceptance EMA (2–draft_cap) and report ngram4_matches and draft_cap_adjustments.")
    first = judge(eval_1, spec, PROFILE, adopt_1)
    if first["verdict"] != "not_reproduced":
        print(f"note: v2 Gate 3 fixture iteration 1 judged {first['verdict']}")
    iteration_1 = {
        "iteration": 1, "verdict": first["verdict"], "reason": first["reason"], "median_delta_pct": first["median_delta_pct"],
        "ci_low_pct": first["ci_low_pct"], "ci_high_pct": first["ci_high_pct"],
        "adoption_verdict": (first.get("adoption") or {}).get("verdict"), "adoption_median_delta_pct": (first.get("adoption") or {}).get("median_delta_pct"),
        "diagnosis": "implementation_suspect",
        "summary": "The method arm never drafted from 4-grams (ngram4_matches = 0) and accepted draft tokens barely moved (+0.5%), so the "
                   "adaptive path was not active — the gain over plain decoding is just prompt lookup itself.",
        "next_changes": next_1, "tuned": tuned_1,
    }
    seeder.event(t, "judge", "Analysing the result against the paper", experiment_id=eid, job=job)
    seeder.event(t + timedelta(seconds=40), "judge", f"Iteration 1: not reproduced (implementation suspect). Trying a fix: {next_1[:400]}",
                 {"analysis": {"diagnosis": "implementation_suspect"}}, experiment_id=eid, job=job)

    # ---- iteration 2: fixed build, tuned, measured ----
    t += timedelta(minutes=1)
    seeder.event(t, "build", f"Worktree ready on branch {branch} — iteration 2: applying the analyst's changes", experiment_id=eid, job=job)
    seeder.event(t + timedelta(minutes=7), "build", "Build verified: 3 files changed, tests pass", experiment_id=eid, job=job)
    t += timedelta(minutes=8)
    smoke_2 = _with(make_results(flag, "long_prompt", 2, {"decode_tokens_per_s": 7.0}, 704, QUALITY, model="smoke"), claim_cmp(tuning), paper_regime)
    _add_run(seeder, eid, "smoke", "done", t, t + timedelta(minutes=4), spec, smoke_2, paper_file)
    seeder.event(t + timedelta(minutes=4), "smoke", "Smoke A/B passed on the small model", experiment_id=eid, job=job)
    t += timedelta(minutes=5)
    for index, (config, (b, v)) in enumerate(zip(configs, trial_values), start=1):
        label = f"{index}/{len(configs)} " + ", ".join(f"{k}={val}" for k, val in config.items())
        trial = make_results(flag, "long_prompt", 1, {"decode_tokens_per_s": (v / b - 1) * 100}, 710 + index, {})
        trial = _with(trial, {"kind": "claim", "workload": "paper regime", "baseline": "paper baseline", "baseline_config": config, "variant_config": config}, paper_regime)
        _add_run(seeder, eid, "tune", "done", t, t + timedelta(minutes=3), spec, trial, paper_file, label)
        seeder.event(t, "tune", f"Tuning ({label}): 1 rounds per arm, workload paper regime", experiment_id=eid, job=job)
        seeder.event(t + timedelta(minutes=3), "tune", f"Config {label}: baseline {b}, method {v} (decode_tokens_per_s)",
                     {"trial": {"config": config, "baseline": b, "variant": v}}, experiment_id=eid, job=job)
        t += timedelta(minutes=3, seconds=20)
    seeder.event(t, "tune", "Tuned: method uses {'max_ngram': 5, 'draft_cap': 10}, paper baseline uses {'max_ngram': 3, 'draft_cap': 10}",
                 {"tuning": tuning}, experiment_id=eid, job=job)
    t += timedelta(minutes=1)
    results = _with(
        make_results(flag, "long_prompt", 10, {"decode_tokens_per_s": 6.8, "itl_ms": 6.3, "e2e_latency_ms": 5.9, "throughput_tokens_per_s": 6.5,
                                               "ttft_ms": 0.2}, 1517, QUALITY),
        claim_cmp(tuning), paper_regime,
        _mechanism(flag, {"verify_steps": 3810, "accepted_draft_tokens": 6430, "ngram4_matches": 0},
                   {"verify_steps": 3530, "accepted_draft_tokens": 7050, "ngram4_matches": 1340}),
    )
    _add_run(seeder, eid, "eval", "done", t, t + timedelta(minutes=26), spec, results, paper_file)
    seeder.event(t, "run", "Claim check: 10 rounds per arm, workload paper regime", experiment_id=eid, job=job)
    t += timedelta(minutes=27)
    adopt = _with(
        make_results(flag, "long_prompt", 10, {"decode_tokens_per_s": 21.4, "itl_ms": 18.6, "e2e_latency_ms": 16.9, "throughput_tokens_per_s": 20.7,
                                               "ttft_ms": -0.4}, 1508, QUALITY),
        adopt_cmp(tuning), "long_prompt",
        _mechanism(flag, {}, {"verify_steps": 3460, "accepted_draft_tokens": 7120, "ngram4_matches": 1410}),
    )
    _add_run(seeder, eid, "adopt", "done", t, t + timedelta(minutes=28), spec, adopt, "long_prompt")
    seeder.event(t, "run", "Adoption check: 10 rounds per arm, workload long_prompt", experiment_id=eid, job=job)
    t += timedelta(minutes=29)

    verdict = judge(results, spec, PROFILE, adopt)
    if verdict["verdict"] != "partial" or (verdict.get("adoption") or {}).get("verdict") != "worth_adopting":
        print(f"note: v2 Gate 3 fixture judged {verdict['verdict']} / {(verdict.get('adoption') or {}).get('verdict')}")
    rows = {row["name"]: row for row in verdict["mechanism"]["rows"]}
    accepted = rows["accepted_draft_tokens"]["change_pct"] or 0.0
    analysis = {
        "diagnosis": "partially_reproduced",
        "summary": f"Adaptive n-grams now work as the paper describes — 4-gram matches drive {rows['ngram4_matches']['variant_per_1k_tokens']:.0f} of "
                   f"every 1k tokens and accepted draft tokens rose {accepted:+.1f}% (paper: +12%) — but decode throughput rose only "
                   f"{verdict['median_delta_pct']:+.1f}%, below the {verdict['target_pct']:.1f}% target.",
        "evidence": [
            f"verify_steps per 1k tokens {rows['verify_steps']['baseline_per_1k_tokens']:.0f} → {rows['verify_steps']['variant_per_1k_tokens']:.0f} "
            f"({rows['verify_steps']['change_pct']:+.1f}%)",
            f"accepted_draft_tokens {accepted:+.1f}% vs the paper's +12% per step",
            "draft_cap_adjustments was not reported, so the EMA cap cannot be checked",
            "Tuning picked max_ngram=5 for the method; the paper's max_ngram=4 was 1.6% slower",
        ],
        "paper_comparison": "Paper: +12% mean accepted tokens per step over fixed n=3, k=10 on CNN/DailyMail (Mistral-7B, A100). Here: "
                            f"{accepted:+.1f}% accepted draft tokens and {verdict['median_delta_pct']:+.1f}% decode tokens/s on four summarisation "
                            "prompts (Qwen3-30B-A3B, M5 Pro) — the mechanism transfers, the speed-up only partly.",
        "worth_iterating": True,
        "next_changes": "Report draft_cap_adjustments, and cap drafts at 8 while the EMA of accepted length is below 3 to cut rejected verify work.",
        "expected_effect": "verify_steps −3 to −5% per 1k tokens, decode tokens/s +1 to +2%",
        "model": "gpt-5-mini (demo fixture)",
    }
    iteration_2 = {
        "iteration": 2, "verdict": verdict["verdict"], "reason": verdict["reason"], "median_delta_pct": verdict["median_delta_pct"],
        "ci_low_pct": verdict["ci_low_pct"], "ci_high_pct": verdict["ci_high_pct"],
        "adoption_verdict": (verdict.get("adoption") or {}).get("verdict"), "adoption_median_delta_pct": (verdict.get("adoption") or {}).get("median_delta_pct"),
        "diagnosis": analysis["diagnosis"], "summary": analysis["summary"], "next_changes": analysis["next_changes"],
        "tuned": {"baseline": tuning["baseline"], "variant": tuning["variant"]},
    }
    history = [iteration_1, iteration_2]
    verdict.update(analysis=analysis, iteration=2, iterations=history, tuning=tuning)
    build = {
        "builder": "copilot",
        "attempts": [{"attempt": 1, "agent_exit": 0, "duration_s": 388.4, "problems": [], "log": None}],
        "files": ["src/inference_lab/techniques/prompt_lookup.py", "src/inference_lab/techniques/adaptive_ngram.py", "tests/test_adaptive_ngram.py"],
        "diff_stat": " src/inference_lab/techniques/adaptive_ngram.py | 118 ++++++++++++\n src/inference_lab/techniques/prompt_lookup.py  |  24 ++-\n"
                     " tests/test_adaptive_ngram.py                   |  66 +++++++\n 3 files changed, 202 insertions(+), 6 deletions(-)",
        "agent_summary": "Iteration 2: matching now starts at max_ngram and falls back to 1; the EMA bounds k in [2, draft_cap]. "
                         "Counters verify_steps, accepted_draft_tokens and ngram4_matches are reported via the technique stats hook.",
        "iteration": 2, "iterations": history, "tuning": tuning, "pr_url": None,
    }
    report_path = None
    if folder is not None:
        claim = get_claim(seeder.claims[key])
        report_path = render_report(
            folder / "report.html",
            {"id": eid, "branch": branch, "flag_name": flag},
            {"id": project_id, "name": PROFILE["name"], "repo_path": PROFILE["repo"]["path"]},
            claim, {"paper_id": claim["paper_id"], "title": claim["paper_title"], "url": claim["paper_url"]},
            spec, build, verdict, results,
        )
    strip = lambda per_metric: {n: {k: v for k, v in m.items() if k != "deltas"} for n, m in (per_metric or {}).items()}  # noqa: E731
    details = {k: v for k, v in verdict.items() if k not in ("per_metric", "adoption")}
    details["per_metric"] = strip(verdict["per_metric"])
    if verdict.get("adoption"):
        details["adoption"] = {**verdict["adoption"], "per_metric": strip(verdict["adoption"]["per_metric"])}
    with session_scope() as session:
        session.add(Verdict(
            experiment_id=eid, verdict=verdict["verdict"], primary_metric=verdict["primary_metric"], median_delta_pct=verdict["median_delta_pct"],
            ci_low_pct=verdict["ci_low_pct"], ci_high_pct=verdict["ci_high_pct"], claimed_gain_pct=verdict["claimed_gain_pct"],
            quality_ok=verdict["quality_ok"], details=details, report_path=str(report_path) if report_path else None, created_at=t,
        ))
    seeder.event(t, "judge", "Analysing the result against the paper", experiment_id=eid, job=job)
    adoption = verdict.get("adoption") or {}
    seeder.event(t + timedelta(seconds=50), "decide",
                 f"Verdict: {verdict['verdict'].replace('_', ' ')} — {verdict['reason']}. Adoption: {str(adoption.get('verdict', '')).replace('_', ' ')}. "
                 f"Diagnosis: partially reproduced. Waiting for merge/drop (Gate 3)", {"verdict": verdict["verdict"]}, experiment_id=eid, job=job)
    seeder._set(eid, branch=branch, worktree_path=f"/nonexistent/demo/r2e/worktrees/exp-{eid}", build=build)
    return eid


def exp_v2_tuning(seeder: Any, kit: Any, project_id: int) -> int:
    ago, make_results, spec_for = kit.ago, kit.make_results, kit.spec_for
    key = "c_lookahead_tuning"
    created = ago(minutes=38)
    flag = "bandwidth_aware_lookahead"
    spec = spec_for(
        hypothesis="A bandwidth-aware lookahead window raises decode_tokens_per_s by at least 6.3% over lookahead decoding with the default "
        "W=15, N=5 on MT-Bench-like prompts.",
        flag_name=flag, technique_summary=seeder.claim_rows[key]["card"].technique,
        implementation_notes="mode=baseline runs lookahead decoding with W=15, N=5; mode=method picks W and N from measured memory bandwidth. "
        "Report lookahead_accepted_tokens and verify_steps.",
        primary_metric="decode_tokens_per_s", direction="higher_is_better", secondary_metrics=["itl_ms", "e2e_latency_ms"],
        workload="short_chat", model="eval", rounds=10, warmup=1, success_threshold_pct=5.0, claimed_gain_pct=9.0, lossless=True,
        guardrails=GUARDRAILS, paper_vs_project="Same Apple silicon family (M3 Max → M5 Pro), but MLX in the paper vs PyTorch MPS here.",
        paper_baseline={"kind": "technique_mode", "description": "Lookahead decoding with the paper's default window W=15, N=5"},
        paper_workload={"matches": "MT-Bench single-turn prompts (paper §6)", "description": "Open-ended chat, greedy decoding",
                        "prompts": MT_BENCH, "max_new_tokens": 256, "concurrency": 1, "long_context_tokens": 0},
        mechanism=[
            {"name": "lookahead_accepted_tokens", "meaning": "tokens accepted from the n-gram pool", "paper_value": "≈ 1.9 per step"},
            {"name": "verify_steps", "meaning": "target forward passes", "paper_value": None},
        ],
        knobs=[
            {"name": "window_w", "meaning": "lookahead window", "paper_value": "7 on M3 Max", "candidates": [7, 5, 10]},
            {"name": "ngram_n", "meaning": "n-gram size", "paper_value": "4", "candidates": [4, 3]},
        ],
        fidelity={"level": "high", "gaps": ["MLX in the paper vs PyTorch MPS here"]},
        tune=True, tune_rounds=1, max_iterations=2,
    )
    eid = seeder._experiment(project_id, key, "tuning", created, ago(minutes=4), spec=spec)
    branch = f"r2e/exp-{eid}-bandwidth-aware-lookahead"
    seeder._artifacts(eid)
    approved = created + timedelta(minutes=9)
    seeder._plan_events(eid, created, spec, None, approved)
    job = f"resume-{eid}"
    seeder.job(job, "experiment.resume", {"experiment_id": eid, "resume": {"decision": "approve", "comment": None}}, approved, status="running", experiment_id=eid)
    t = approved + timedelta(seconds=10)
    seeder.event(t, "build", f"Worktree ready on branch {branch}", experiment_id=eid, job=job)
    seeder.event(t + timedelta(minutes=11), "build", "Build verified: 2 files changed, tests pass", experiment_id=eid, job=job)
    t += timedelta(minutes=12)
    paper_file = f"data/r2e/experiments/{eid}/paper_workload.json"
    regime = {"name": "paper_regime", "requests_per_round": 3, "max_new_tokens": 256, "concurrency": 1}
    smoke = _with(make_results(flag, "short_chat", 2, {"decode_tokens_per_s": 4.0}, 801, QUALITY, model="smoke"),
                  {"kind": "claim", "workload": "paper regime", "baseline": "paper baseline", "baseline_config": {}, "variant_config": {}}, regime)
    _add_run(seeder, eid, "smoke", "done", t, t + timedelta(minutes=4), spec, smoke, paper_file)
    seeder.event(t + timedelta(minutes=4), "smoke", "Smoke A/B passed on the small model", experiment_id=eid, job=job)
    t += timedelta(minutes=5)
    configs = [{"window_w": 7, "ngram_n": 4}, {"window_w": 5, "ngram_n": 4}, {"window_w": 10, "ngram_n": 4}]
    values = [(52.4, 55.1), (52.2, 54.0)]
    for index, config in enumerate(configs, start=1):
        label = f"{index}/4 " + ", ".join(f"{k}={v}" for k, v in config.items())
        done = index <= len(values)
        trial = make_results(flag, "short_chat", 1, {"decode_tokens_per_s": (values[index - 1][1] / values[index - 1][0] - 1) * 100}, 810 + index, {}) if done else None
        if trial:
            trial = _with(trial, {"kind": "claim", "workload": "paper regime", "baseline": "paper baseline", "baseline_config": config, "variant_config": config}, regime)
        _add_run(seeder, eid, "tune", "done" if done else "running", t, t + timedelta(minutes=3) if done else None, spec, trial, paper_file, label)
        seeder.event(t, "tune", f"Tuning ({label}): 1 rounds per arm, workload paper regime", experiment_id=eid, job=job)
        if done:
            b, v = values[index - 1]
            seeder.event(t + timedelta(minutes=3), "tune", f"Config {label}: baseline {b}, method {v} (decode_tokens_per_s)",
                         {"trial": {"config": config, "baseline": b, "variant": v}}, experiment_id=eid, job=job)
        t += timedelta(minutes=3, seconds=20)
    seeder._set(eid, branch=branch, worktree_path=f"/nonexistent/demo/r2e/worktrees/exp-{eid}",
                build={"builder": "copilot", "attempts": [{"attempt": 1, "agent_exit": 0, "duration_s": 652.0, "problems": [], "log": None}],
                       "files": ["src/inference_lab/techniques/lookahead.py", "tests/test_lookahead_window.py"], "iteration": 1})
    return eid
