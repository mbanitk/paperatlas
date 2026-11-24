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
  rebaseProtocol,
  runKindLabel,
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
      max_iterations: 4,
    }
    expect(Object.keys(validateProtocol(bad)).sort()).toEqual(
      ['knobs.0.candidates', 'max_iterations', 'paper_baseline.description', 'paper_workload.concurrency', 'paper_workload.prompts'].sort(),
    )
    expect(validateProtocol(form)).toEqual({})
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
