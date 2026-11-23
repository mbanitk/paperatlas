import { describe, expect, it } from 'vitest'
import { displayValue, formatDuration, formatNumber, formatPct, formatWorkload, relativeTime, tailLines } from './format'

describe('formatPct', () => {
  it('signs and rounds', () => {
    expect(formatPct(19.524)).toBe('+19.5%')
    expect(formatPct(-2.246)).toBe('−2.2%')
    expect(formatPct(0.04)).toBe('0.0%')
    expect(formatPct(45, 0)).toBe('+45%')
  })

  it('handles missing values', () => {
    expect(formatPct(null)).toBe('—')
    expect(formatPct(Number.NaN)).toBe('—')
  })
})

describe('formatNumber', () => {
  it('picks precision by magnitude', () => {
    expect(formatNumber(2329.07)).toBe('2,329')
    expect(formatNumber(49.215)).toBe('49.2')
    expect(formatNumber(0.8234)).toBe('0.823')
  })
})

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(512.4)).toBe('8m 32s')
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe('3h 05m')
    expect(formatDuration(null)).toBe('—')
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-11-23T12:00:00Z')
  it('describes the past', () => {
    expect(relativeTime('2026-11-23T11:59:50Z', now)).toBe('just now')
    expect(relativeTime('2026-11-23T11:55:00Z', now)).toBe('5 min ago')
    expect(relativeTime('2026-11-23T09:00:00Z', now)).toBe('3 h ago')
    expect(relativeTime('2026-11-21T12:00:00Z', now)).toBe('2 d ago')
  })
  it('handles bad input', () => {
    expect(relativeTime(null, now)).toBe('—')
    expect(relativeTime('nope', now)).toBe('—')
  })
})

describe('tailLines', () => {
  it('keeps the last lines', () => {
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc')
    expect(tailLines('a', 5)).toBe('a')
  })
})

describe('formatWorkload / displayValue', () => {
  it('summarises the bench-contract workload object', () => {
    expect(formatWorkload({ name: 'concurrent_4', requests_per_round: 4, max_new_tokens: 128, concurrency: 4 })).toBe(
      'concurrent_4 · 4 req/round · 128 tokens · concurrency 4',
    )
    expect(formatWorkload({ name: 'short_chat', requests_per_round: 4, max_new_tokens: 128, concurrency: 1 })).toBe('short_chat · 4 req/round · 128 tokens')
    expect(formatWorkload('long_prompt')).toBe('long_prompt')
    expect(formatWorkload(null)).toBe('—')
  })

  it('never renders [object Object]', () => {
    expect(displayValue({ id: 'Qwen/Qwen3-0.6B', dtype: 'bfloat16' })).toBe('Qwen/Qwen3-0.6B')
    expect(displayValue({ value: 0.82 })).toBe('{"value":0.82}')
    expect(displayValue({ version: '2.9.1' })).toBe('2.9.1')
    expect(displayValue(0.84)).toBe('0.84')
    expect(displayValue(undefined)).toBe('—')
  })
})
