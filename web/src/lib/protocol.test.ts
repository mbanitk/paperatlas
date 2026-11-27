import { describe, expect, it } from 'vitest'
import type { Experiment, ExperimentSpec } from '../api/types'
import {
  chosenBy,
  claimTarget,
  currentIteration,
  describeProtocolValue,
  needsAdoptionCheck,
  parseCandidates,
  PROTOCOL_FIELDS,
  protocolOf,
  protocolOverrides,
  protocolToForm,
  plainDuration,
  rebaseProtocol,
  recommendDecision,
  recommendForSummary,
  runKindLabel,
  summarizeFailure,
  tuneConfigs,
  validateProtocol,
} from './protocol'

const V2: Partial<ExperimentSpec> = {
  protocol_version: 2,
  paper_baseline: { kind: 'technique_mode', description: 'Prompt lookup with fixed n=3, k=10' },
  paper_workload: { matches: 'CNN/DailyMail', description: '', prompts: ['Summarise A', 'Summarise B'], max_new_tokens: 128, concurrency: 1, long_context_tokens: 0 },
  mechanism: [{ name: 'verify_steps', meaning: 'target verify passes', paper_value: null }],
  knobs: [{ name: 'max_ngram', meaning: '', paper_value: '4', candidates: [4, 3, 5] }],
  fidelity: { level: 'medium', gaps: ['A100 → MPS'] },
  lossless: true,
  tune: true,
  max_iterations: 2,
}

describe('protocolOf', () => {
  it('fills v1 specs with the backend defaults', () => {
    const protocol = protocolOf({ hypothesis: 'x' })
    expect(protocol).toMatchObject({ version: 1, paper_baseline: { kind: 'project_default', description: '' }, paper_workload: null, knobs: [], tune: false, max_iterations: 1 })
    expect(needsAdoptionCheck({ hypothesis: 'x' })).toBe(false)
  })

  it('needs an adoption check when the claim check uses the paper baseline or workload', () => {
    expect(needsAdoptionCheck(V2)).toBe(true)
    expect(needsAdoptionCheck({ ...V2, paper_baseline: { kind: 'project_default', description: '' }, paper_workload: null })).toBe(false)
    expect(needsAdoptionCheck({ ...V2, paper_baseline: { kind: 'project_default', description: '' } })).toBe(true)
  })
})

describe('protocolOverrides', () => {
  it('sends nothing for an untouched form and only the changed fields otherwise', () => {
    const form = protocolToForm(V2)
    expect(protocolOverrides(V2, form, PROTOCOL_FIELDS)).toEqual({})
    const edited = { ...form, max_iterations: 3, knobs: [{ ...form.knobs[0], candidates: '4, 6' }] }
    expect(protocolOverrides(V2, edited, PROTOCOL_FIELDS)).toEqual({
      max_iterations: 3,
      knobs: [{ name: 'max_ngram', meaning: '', paper_value: '4', candidates: [4, 6] }],
    })
  })

  it('turns a disabled paper workload into null and ignores fields the backend does not allow', () => {
    const form = protocolToForm(V2)
    const off = { ...form, paper_workload: { ...form.paper_workload, enabled: false } }
    expect(protocolOverrides(V2, off, ['paper_workload'])).toEqual({ paper_workload: null })
    expect(protocolOverrides(V2, { ...form, tune: false }, ['max_iterations'])).toEqual({})
  })

  it('keeps unsaved protocol edits when the server spec changes', () => {
    const base = protocolToForm(V2)
    const form = { ...base, tune: false }
    const updated = { ...V2, max_iterations: 3 }
    expect(rebaseProtocol(base, form, updated, PROTOCOL_FIELDS)).toMatchObject({ tune: false, max_iterations: 3 })
  })
})

describe('validateProtocol', () => {
  it('flags missing descriptions, prompts, knob values and ranges', () => {
    const form = protocolToForm(V2)
    const bad = {
      ...form,
      paper_baseline: { kind: 'technique_mode' as const, description: ' ' },
      paper_workload: { ...form.paper_workload, prompts: [' '], concurrency: '9' },
      knobs: [{ name: 'k', meaning: '', paper_value: '', candidates: '1, 2, 3, 4' }],
      max_iterations: 6,
    }
    expect(Object.keys(validateProtocol(bad)).sort()).toEqual(
      ['knobs.0.candidates', 'max_iterations', 'paper_baseline.description', 'paper_workload.concurrency', 'paper_workload.prompts'].sort(),
    )
    expect(validateProtocol(form)).toEqual({})
    expect(validateProtocol({ ...form, max_iterations: 5 })).toEqual({})
  })
})

describe('helpers', () => {
  it('snake-cases names and caps prompts by the round token budget like the backend', () => {
    const form = protocolToForm(V2)
    const named = { ...form, mechanism: [...form.mechanism, { name: 'Draft Tokens Wasted', meaning: '', paper_value: '' }] }
    expect((protocolOverrides(V2, named, ['mechanism']).mechanism as { name: string }[]).map((m) => m.name)).toEqual(['verify_steps', 'draft_tokens_wasted'])
    const long = { ...form, paper_workload: { ...form.paper_workload, prompts: ['a', 'b', 'c', 'd', 'e'], max_new_tokens: '256' } }
    expect(validateProtocol(long)['paper_workload.prompts']).toMatch(/At most 4 prompts at 256/)
  })

  it('parses knob candidates like the backend', () => {
    expect(parseCandidates('4, 4, 0.5, true, greedy, ')).toEqual([4, 0.5, true, 'greedy'])
  })

  it('lists the paper setting first, then one knob at a time (max 4)', () => {
    const configs = tuneConfigs([
      { name: 'a', meaning: '', paper_value: null, candidates: [1, 2, 3] },
      { name: 'b', meaning: '', paper_value: null, candidates: [10, 20] },
    ])
    expect(configs).toEqual([{ a: 1, b: 10 }, { a: 2, b: 10 }, { a: 3, b: 10 }, { a: 1, b: 20 }])
  })

  it('computes the claim target and describes values', () => {
    expect(claimTarget(12, 5)).toBeCloseTo(8.4)
    expect(claimTarget(null, 5)).toBe(5)
    expect(describeProtocolValue('paper_workload', null)).toMatch(/project workload/)
    expect(describeProtocolValue('knobs', V2.knobs)).toBe('max_ngram ∈ {4, 3, 5}')
    expect(runKindLabel('adopt')).toBe('Adoption check')
  })

  it('marks the configs each arm chose', () => {
    expect(chosenBy({ baseline: { a: 1 }, variant: { a: 2 } }, { a: 2 })).toEqual(['method'])
    expect(chosenBy({ baseline: {}, variant: { a: 1 } }, { a: 1 })).toEqual(['method'])
  })

  it('counts the iteration in flight after a loop back to build', () => {
    const experiment = (status: string, iterations: number, iteration?: number) =>
      ({ status, build: { iteration, iterations: Array.from({ length: iterations }, (_, i) => ({ iteration: i + 1 })) }, verdict_detail: null }) as unknown as Experiment
    expect(currentIteration(experiment('building', 0))).toBe(1)
    expect(currentIteration(experiment('building', 1))).toBe(2)
    expect(currentIteration(experiment('awaiting_decision', 2, 2))).toBe(2)
  })
})

describe('recommendDecision', () => {
  it('does not recommend merging a gain the judge doubts', () => {
    const adoption = { verdict: 'worth_adopting', median_delta_pct: 63.2, quality_ok: true, quality_problems: [], validity_warnings: ['drifted on the same server'] }
    const rec = recommendDecision({ verdict: 'reproduced', median_delta_pct: 70.1, quality_ok: true, details: { adoption } })
    expect(rec.action).toBe('your_call')
    expect(rec.warnings).toEqual(['drifted on the same server'])
    expect(recommendDecision({ verdict: 'reproduced', median_delta_pct: 70.1, quality_ok: true, details: { adoption: { ...adoption, validity_warnings: [] } } }).action).toBe('merge')
    const row = { verdict: 'reproduced' as const, median_delta_pct: 70.1, claimed_gain_pct: null, adoption_verdict: 'worth_adopting', adoption_median_delta_pct: 63.2 }
    expect(recommendForSummary(row)?.action).toBe('merge')
    expect(recommendForSummary({ ...row, validity_warning: true })?.action).toBe('your_call')
  })

  const CLAIMS = ['reproduced', 'partial', 'not_reproduced', 'regression', 'inconclusive']
  const ADOPTIONS = ['worth_adopting', 'small_gain', 'not_reproduced', 'regression', 'inconclusive']
  const verdict = (claim: string, adoption: string | null, quality: { claim?: boolean; adoption?: boolean } = {}) => ({
    verdict: claim,
    primary_metric: 'throughput_tokens_per_s',
    median_delta_pct: 2.8,
    claimed_gain_pct: null,
    quality_ok: quality.claim ?? true,
    details: {
      success_threshold_pct: 5,
      quality_problems: quality.claim === false ? ['output agreement 0.80 < 0.95'] : [],
      adoption: adoption
        ? { verdict: adoption, median_delta_pct: -63.1, quality_ok: quality.adoption ?? true, quality_problems: quality.adoption === false ? ['exact match dropped 4 pts'] : [] }
        : null,
    },
  })

  it('follows the adoption check for every claim/adoption/quality combination', () => {
    for (const claim of CLAIMS)
      for (const adoption of ADOPTIONS)
        for (const [claimOk, adoptionOk] of [[true, true], [false, true], [true, false]]) {
          const result = recommendDecision(verdict(claim, adoption, { claim: claimOk, adoption: adoptionOk }))
          const failed = (!claimOk && claim === 'regression') || (!adoptionOk && adoption === 'regression')
          const expected = failed || adoption === 'regression' ? 'drop' : adoption === 'worth_adopting' ? 'merge' : 'your_call'
          expect(result.action, `${claim} / ${adoption} / quality ${claimOk},${adoptionOk}`).toBe(expected)
          expect(result.separateAdoption).toBe(true)
        }
  })

  it('states the bottom line for experiment #6 (partial claim, regression here)', () => {
    const result = recommendDecision(verdict('partial', 'regression'))
    expect(result).toMatchObject({ action: 'drop', label: 'Drop', tone: 'negative' })
    expect(result.reason).toBe('Throughput (tokens/s) is 63.1% worse than the current default on your workload.')
    expect(result.claimSentence).toBe('The paper’s claim partly held here (+2.8% vs a +5% target).')
    expect(result.recap).toBe('Claim check: Partly reproduced +2.8% · Adoption check: Worse than default −63.1%')
  })

  it('treats unmeasured quality as inconclusive, not as a failed guardrail', () => {
    const result = recommendDecision({ verdict: 'inconclusive', quality_ok: false, details: { quality_problems: ['no quality measurements in the results'] } })
    expect(result).toMatchObject({ action: 'your_call' })
    expect(result.claim.quality).toBe('unmeasured')
    expect(recommendDecision(verdict('reproduced', 'inconclusive', { adoption: false })).adoption.quality).toBe('unmeasured')
  })

  it('names the failed guardrail', () => {
    const result = recommendDecision(verdict('reproduced', 'regression', { adoption: false }))
    expect(result.action).toBe('drop')
    expect(result.reason).toMatch(/quality guardrail failed: exact match dropped 4 pts/)
  })

  it('reads the claim check as the adoption check when none ran separately', () => {
    expect(recommendDecision(verdict('regression', null)).adoption.verdict).toBe('regression')
    expect(recommendDecision(verdict('regression', null)).action).toBe('drop')
    expect(recommendDecision({ ...verdict('reproduced', null), details: { worth_adopting: true } }).action).toBe('merge')
    expect(recommendDecision({ ...verdict('partial', null), details: { worth_adopting: false } }).adoption.verdict).toBe('small_gain')
    const notReproduced = recommendDecision({ ...verdict('not_reproduced', null), median_delta_pct: 0 })
    expect(notReproduced).toMatchObject({ action: 'your_call', separateAdoption: false })
    expect(notReproduced.recap).toBe('Claim check (on your workload): Not reproduced 0%')
    // A claim check on the paper's workload alone says nothing about the project default.
    const paperOnly = recommendDecision({ ...verdict('reproduced', null), details: { worth_adopting: true, comparison: { kind: 'claim', baseline: 'project default', workload: 'paper regime' } } })
    expect(paperOnly).toMatchObject({ action: 'your_call' })
    expect(paperOnly.adoption.delta).toBeNull()
  })

  it('mentions the paper’s number and the target only when they exist', () => {
    expect(recommendDecision({ ...verdict('regression', null), median_delta_pct: -66.8, claimed_gain_pct: 41 }).claimSentence).toBe(
      'Against the paper’s setup it was worse than the baseline (−66.8%). The paper reports +41%.',
    )
    expect(recommendDecision({ verdict: 'reproduced', median_delta_pct: 5.4 }).claimSentence).toBe('The paper’s claim held here (+5.4%).')
  })

  it('recommends from list rows only when the API sends the adoption check', () => {
    const row = { verdict: 'partial' as const, median_delta_pct: 2.8, claimed_gain_pct: null }
    expect(recommendForSummary(row)).toBeNull()
    expect(recommendForSummary({ ...row, adoption_verdict: 'regression', adoption_median_delta_pct: -63.1 })?.action).toBe('drop')
    expect(recommendForSummary({ ...row, adoption_verdict: null })).toBeNull()
    // Only the detail page knows whether a claim-check regression was a quality failure.
    expect(recommendForSummary({ ...row, verdict: 'regression', adoption_verdict: 'worth_adopting' })).toBeNull()
  })
})

describe('summarizeFailure', () => {
  it('puts a plain sentence before the traceback', () => {
    const error = [
      'smoke: smoke benchmark failed (exit 1):',
      ' in _run_module_as_main',
      '  File "<frozen runpy>", line 88, in _run_code',
      '  File "/repo/data/r2e/worktrees/exp-7/src/inference_lab/bench/client.py", line 177, in chat_stream',
      '    raise ServerError(f"chat completion failed")',
      'inference_lab.bench.client.ServerError: chat completion failed: HTTP 404: b\'{"error": "generation thread died"}\'',
    ].join('\n')
    expect(summarizeFailure(error)).toMatchObject({
      title: 'Smoke test failed',
      plain: 'The benchmark crashed before measuring anything.',
      cause: 'ServerError: chat completion failed: HTTP 404: b\'{"error": "generation thread died"}\'',
      location: 'inference_lab/bench/client.py, line 177',
      exitCode: 1,
      timedOut: false,
      technical: error,
    })
  })

  it('explains timeouts and falls back to the stage', () => {
    expect(summarizeFailure('smoke: smoke benchmark failed (exit 124):\n[timeout after 1800s]')).toMatchObject({ timedOut: true, cause: null, plain: 'It ran out of time after 30 min before finishing.' })
    expect(summarizeFailure('verification failed: tests do not pass', 'build')).toMatchObject({ title: 'Build failed', cause: 'verification failed: tests do not pass' })
    expect(summarizeFailure(null).title).toBe('Experiment failed')
    expect([plainDuration(45), plainDuration(1800), plainDuration(7200), plainDuration(5400)]).toEqual(['45 s', '30 min', '2 h', '1 h 30 min'])
  })
})
