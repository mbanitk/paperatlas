import { describe, expect, it } from 'vitest'
import { claimedEffectView, compareHardware, riskLevel } from './claims'

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
    expect(claimedEffectView(base).kind).toBe('none')
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
