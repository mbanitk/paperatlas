import { describe, expect, it } from 'vitest'
import { claimedEffectView, compareHardware, effectText, effortLevel, expectedMetricLabel, experimentVerb, fitLevel, gateOneAnswer, matchScoreExplanation, riskLevel } from './claims'

const base = { claimed_gain_pct: null, claimed_value: null, claimed_unit: null, direction: null, primary_metric: 'decode throughput' }

describe('claimedEffectView', () => {
  it('shows relative gains with a direction', () => {
    expect(claimedEffectView({ ...base, claimed_gain_pct: 41, claimed_value: 41, claimed_unit: '%', direction: 'increase' })).toMatchObject({ kind: 'gain', text: '↑41%', gainPct: 41 })
    expect(claimedEffectView({ ...base, claimed_gain_pct: 61.5, claimed_value: 2.6, claimed_unit: 'x', direction: 'decrease' })).toMatchObject({ kind: 'gain', text: '↓2.6×' })
  })

  it('renders absolute or non-relative values neutrally (no ↑0.14×)', () => {
    expect(claimedEffectView({ ...base, claimed_value: 0.14, claimed_unit: 'x', direction: 'increase' })).toMatchObject({ kind: 'neutral', text: '0.14×' })
    expect(claimedEffectView({ ...base, claimed_value: 64.2, claimed_unit: 'ms', direction: 'none' })).toMatchObject({ kind: 'neutral', text: '64.2 ms' })
    const explainer = { claimed_result: { summary: '41% fewer rounds, absolute', is_relative_gain: false } }
    expect(claimedEffectView({ ...base, claimed_gain_pct: 41, claimed_value: 41, claimed_unit: '%' }, explainer)).toMatchObject({ kind: 'neutral', summary: '41% fewer rounds, absolute' })
    expect(claimedEffectView(base)).toMatchObject({ kind: 'none', text: 'Paper gives no number' })
  })
})

describe('riskLevel', () => {
  const claim = { requires_cuda: false, requires_multi_gpu: false, requires_training: false, card: null }
  it('grows with blockers, caveats and special requirements', () => {
    expect(riskLevel(claim, { caveats: [], lossless: true })).toBe('low')
    expect(riskLevel(claim, { caveats: ['a', 'b'], lossless: false })).toBe('medium')
    expect(riskLevel({ ...claim, requires_cuda: true }, null, ['needs CUDA'])).toBe('high')
  })
})

describe('compareHardware', () => {
  const mac = { chip: 'Apple M5 Pro', accelerator: 'mps', cuda: false }
  it('matches Apple silicon papers and flags datacenter GPUs', () => {
    expect(compareHardware('Apple M3 Max 64GB', mac)).toBe('same')
    expect(compareHardware('1x NVIDIA H100 80GB', mac)).toBe('different')
    expect(compareHardware('unspecified', mac)).toBe('unknown')
    expect(compareHardware('8x H100', { chip: 'H100', cuda: true })).toBe('same')
  })
})

describe('levels', () => {
  it('maps effort and fit to words', () => {
    expect(effortLevel('low')).toBe('low')
    expect(effortLevel('high')).toBe('high')
    expect(effortLevel('bogus')).toBe('medium')
    expect(effortLevel(null)).toBeNull()
    expect(fitLevel(0.9)).toBe('high')
    expect(fitLevel(0.5)).toBe('medium')
    expect(fitLevel(0.1)).toBe('low')
    expect(fitLevel(undefined)).toBeNull()
  })
})

describe('expectedMetricLabel', () => {
  it('uses short plain words, never the metric id', () => {
    expect(expectedMetricLabel('decode_tokens_per_s')).toBe('decode speed')
    expect(expectedMetricLabel('ttft_ms')).toBe('time to first token')
    expect(expectedMetricLabel('p95_latency_ms')).toBe('p95 latency')
    expect(expectedMetricLabel(null)).toBe('')
  })
})

describe('experimentVerb', () => {
  it('says "being tested" until there is a verdict, then "tested"', () => {
    expect(experimentVerb('building')).toBe('Being tested in')
    expect(experimentVerb('awaiting_approval')).toBe('Being tested in')
    expect(experimentVerb('awaiting_decision')).toBe('Tested in')
    expect(experimentVerb('merged')).toBe('Tested in')
    expect(experimentVerb('failed')).toBe('Tested in')
  })
})

describe('matchScoreExplanation', () => {
  it('states the formula and the numbers behind it', () => {
    const text = matchScoreExplanation({ score: 0.29, fit: 0.62, gain: 0.1, effort_cost: 1 })
    expect(text).toContain('Match = fit × (0.4 + expected gain) ÷ effort cost')
    expect(text).toContain('fit 0.620')
    expect(text).toContain('→ 0.290')
  })
})

describe('gateOneAnswer', () => {
  it('answers how many claims are likely to gain here', () => {
    expect(gateOneAnswer({ total: 30, likely: 12, project: 'inference-lab', chip: 'Apple M5 Pro' })).toBe(
      '12 of 30 ranked claims are likely to gain on inference-lab (Apple M5 Pro).',
    )
    expect(gateOneAnswer({ total: 30, likely: 1, project: 'lab' })).toBe('1 of 30 ranked claims is likely to gain on lab.')
    expect(gateOneAnswer({ total: 3, likely: 0 })).toBe('None of the 3 ranked claims is likely to gain much here.')
    expect(gateOneAnswer({ total: 2, likely: 2 })).toBe('All 2 ranked claims are likely to gain here.')
    expect(gateOneAnswer({ total: 1, likely: 1 })).toBe('The only ranked claim is likely to gain here.')
    expect(gateOneAnswer({ total: 5, likely: 0, estimated: false, project: 'lab' })).toContain('aren’t estimated until the engine’s roofline is measured')
    expect(gateOneAnswer({ total: 0, likely: 0 })).toBe('No claims are ranked for this project yet.')
  })
})

describe('effectText', () => {
  it('signs percentages but not ratios', () => {
    const gain = (text: string) => ({ kind: 'gain' as const, gainPct: 1, text, metric: null, summary: null })
    expect(effectText(gain('↑41%'), 'increase')).toBe('+41%')
    expect(effectText(gain('↓20%'), 'decrease')).toBe('−20%')
    expect(effectText(gain('↑2×'), 'increase')).toBe('2×')
    expect(effectText(gain('↓2.6×'), 'decrease')).toBe('2.6× lower')
    expect(effectText({ kind: 'neutral', text: '64.2 ms', metric: null, summary: null }, 'none')).toBe('64.2 ms')
  })
})
