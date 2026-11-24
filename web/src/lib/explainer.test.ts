import { describe, expect, it } from 'vitest'
import type { ClaimExplainer } from '../api/types'
import { claimTheme, formatReportedValue, heroResult, isPlainLanguage, isUnreported, paperReport } from './explainer'

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
      metric: 'Decode speed (tokens/s)',
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

describe('formatReportedValue', () => {
  it('cleans the paper\'s number for the plain layer', () => {
    expect(formatReportedValue('1.96x–3.12x')).toBe('1.96× to 3.12×')
    expect(formatReportedValue('10x–20x')).toBe('10× to 20×')
    expect(formatReportedValue('1.5x-2.3x')).toBe('1.5× to 2.3×')
    expect(formatReportedValue('32.2–79.1% lower')).toBe('32.2 to 79.1% lower')
    expect(formatReportedValue('up to 3.4x')).toBe('up to 3.4×')
    expect(formatReportedValue('0…+10%')).toBe('0 to +10%')
    expect(formatReportedValue('4^{-b} penalty')).toBe('4⁻ᵇ penalty')
    expect(formatReportedValue('+28%')).toBe('+28%')
    expect(formatReportedValue('70.62→97.36')).toBe('70.62→97.36')
    expect(formatReportedValue('1.8x on Qwen2.5-7B')).toBe('1.8× on Qwen2.5-7B')
    expect(formatReportedValue('Llama-2-7B: +12%')).toBe('Llama-2-7B: +12%')
    expect(formatReportedValue('A100-80GB')).toBe('A100-80GB')
  })

  it('treats placeholders as no number', () => {
    for (const value of ['not reported', 'Not quantified', 'n/a', '—', '', null]) {
      expect(isUnreported(value)).toBe(true)
      expect(formatReportedValue(value)).toBeNull()
    }
    expect(isUnreported('at most m iterations')).toBe(false)
  })
})

describe('paperReport', () => {
  it('skips a "not reported" headline and falls back to the claim card', () => {
    const explainer: ClaimExplainer = { ...v2, headline_result: { value: 'not reported', metric: 'speed' } }
    expect(heroResult({ ...dloop, claimed_gain_pct: 12, claimed_value: 12, claimed_unit: '%' }, explainer)).toMatchObject({ value: '+12%', source: 'claim' })
    expect(heroResult(dloop, explainer)).toBeNull()
  })

  it('shows absolute values neutrally when there is no headline gain', () => {
    expect(paperReport(dloop, null)).toMatchObject({ value: '0.14×', direction: 'none' })
    expect(paperReport({ ...dloop, claimed_value: null }, null)).toBeNull()
    expect(paperReport(dloop, v2)?.value).toBe('+5 to 41%')
  })
})
