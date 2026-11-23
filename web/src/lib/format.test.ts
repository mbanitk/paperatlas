import { describe, expect, it } from 'vitest'
import { formatClaimedEffect, formatDuration, formatNumber, formatPct, relativeTime, tailLines } from './format'

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

describe('formatClaimedEffect', () => {
  it('keeps the claim’s own unit and direction', () => {
    expect(formatClaimedEffect({ claimed_value: 2.6, claimed_unit: 'x', direction: 'decrease', claimed_gain_pct: 61.5 })).toBe('↓2.6×')
    expect(formatClaimedEffect({ claimed_value: 45, claimed_unit: '%', direction: 'increase', claimed_gain_pct: 45 })).toBe('↑45%')
    expect(formatClaimedEffect({ claimed_value: 46, claimed_unit: '%', direction: 'decrease', claimed_gain_pct: 46 })).toBe('↓46%')
    expect(formatClaimedEffect({ claimed_value: 0.8, claimed_unit: '%', direction: 'none', claimed_gain_pct: null })).toBe('not quantified')
  })
})

describe('tailLines', () => {
  it('keeps the last lines', () => {
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc')
    expect(tailLines('a', 5)).toBe('a')
  })
})
