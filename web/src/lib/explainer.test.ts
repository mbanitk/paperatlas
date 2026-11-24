import { describe, expect, it } from 'vitest'
import type { ClaimExplainer } from '../api/types'
import { claimTheme, heroResult, isPlainLanguage } from './explainer'

const dloop = {
  claimed_gain_pct: null,
  claimed_value: 0.14,
  claimed_unit: 'x',
  direction: 'increase',
  primary_metric: 'wall-clock speedup over autoregressive decoding',
}

const v2: ClaimExplainer = {
  version: 2,
  headline_result: { value: '+5 to 41%', metric: 'wall-clock decoding speedup', versus: 'vs. the same speculative decoding methods without DLoop', direction: 'up' },
  claimed_result: { summary: '…', is_relative_gain: true },
}

describe('heroResult', () => {
  it('uses the v2 headline result instead of a side number from the claim card', () => {
    expect(heroResult(dloop, v2)).toEqual({
      value: '+5 to 41%',
      direction: 'up',
      metric: 'wall-clock decoding speedup',
      versus: 'the same speculative decoding methods without DLoop',
      source: 'explainer',
    })
  })

  it('falls back to relative gains on older explainers and hides absolute values', () => {
    const v1: ClaimExplainer = { headline: 'x', claimed_result: { summary: 'y', is_relative_gain: true } }
    expect(heroResult({ ...dloop, claimed_gain_pct: 35, claimed_value: 35, claimed_unit: '%', primary_metric: 'decode_tokens_per_s' }, v1)).toMatchObject({
      value: '+35%',
      direction: 'up',
      metric: 'decode tokens per s',
      source: 'claim',
    })
    expect(heroResult({ ...dloop, claimed_gain_pct: 20, direction: 'decrease', claimed_unit: 'ms' }, null)).toMatchObject({ value: '−20%', direction: 'down' })
    expect(heroResult(dloop, v1)).toBeNull()
    expect(heroResult(dloop, { ...v2, version: 1 })).toBeNull()
  })

  it('ignores an empty headline value and unknown directions', () => {
    expect(heroResult(dloop, { ...v2, headline_result: { value: '  ' } })).toBeNull()
    expect(heroResult(dloop, { ...v2, headline_result: { value: '2x', direction: 'sideways' } })?.direction).toBe('none')
  })
})

describe('isPlainLanguage / claimTheme', () => {
  it('detects v2 explainers', () => {
    expect(isPlainLanguage(v2)).toBe(true)
    expect(isPlainLanguage({ headline: 'old' })).toBe(false)
    expect(isPlainLanguage(null)).toBe(false)
  })

  it('prefers the explainer theme, else guesses from metric and category', () => {
    expect(claimTheme({ primary_metric: 'peak_memory_gb', category: 'kv_cache' }, { version: 2, theme: 'latency' })).toBe('latency')
    expect(claimTheme({ primary_metric: 'peak_memory_gb', category: 'kv_cache' }, { theme: 'bogus' })).toBe('memory')
    expect(claimTheme({ primary_metric: 'ttft_ms', category: 'batching_scheduling' })).toBe('latency')
    expect(claimTheme({ primary_metric: 'throughput_tokens_per_s', category: 'speculative_decoding' })).toBe('throughput')
    expect(claimTheme({ primary_metric: null, category: 'speculative_decoding' })).toBe('speed')
  })
})
