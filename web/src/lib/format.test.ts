import { describe, expect, it } from 'vitest'
import {
  displayValue,
  formatAcronyms,
  formatCI,
  formatClaimed,
  formatDuration,
  formatMath,
  formatNumber,
  formatPct,
  formatRange,
  formatSignificant,
  formatSigned,
  formatWorkload,
  humanizeMetric,
  isMissing,
  orMissing,
  parseMath,
  relativeTime,
  roundNumbersInText,
  sanitizeText,
  tailLines,
} from './format'

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

describe('formatRange', () => {
  it('writes ranges in words, with the unit once', () => {
    expect(formatRange(0, 10)).toBe('0 to +10%')
    expect(formatRange(5, 30)).toBe('+5 to +30%')
    expect(formatRange(-2, 1.5)).toBe('−2 to +1.5%')
    expect(formatRange(30, 5)).toBe('+5 to +30%')
    expect(formatRange(12, 30, { unit: ' ms', signed: false })).toBe('12 to 30 ms')
  })

  it('collapses equal ends and says plainly when it is missing', () => {
    expect(formatRange(5, 5.01)).toBe('+5%')
    expect(formatRange(null, undefined)).toBe('Not estimated')
    expect(formatRange(null, null, { fallback: 'No estimate yet' })).toBe('No estimate yet')
    expect(formatRange(null, 8)).toBe('+8%')
  })

  it('formats CIs the same way', () => {
    expect(formatCI(-0.42, 1.18)).toBe('−0.4 to +1.2%')
    expect(formatCI(null, 1)).toBe('—')
  })
})

describe('formatSigned', () => {
  it('always shows the sign and trims needless decimals', () => {
    expect(formatSigned(2.8)).toBe('+2.8%')
    expect(formatSigned(-63.14)).toBe('−63.1%')
    expect(formatSigned(41)).toBe('+41%')
    expect(formatSigned(0.01)).toBe('0%')
    expect(formatSigned(2.63, { unit: '×', digits: 2 })).toBe('+2.63×')
    expect(formatSigned(null)).toBe('—')
  })
})

describe('missing values', () => {
  it('writes them plainly', () => {
    expect(formatClaimed(null)).toBe('Paper gives no number')
    expect(formatClaimed(41)).toBe('Paper reports +41%')
    expect(orMissing(null)).toBe('Not reported')
    expect(orMissing('—')).toBe('Not reported')
    expect(orMissing(0)).toBe(0)
    expect(isMissing('  ')).toBe(true)
    expect(isMissing('n/a')).toBe(false)
  })
})

describe('significant digits in prose', () => {
  it('rounds to three significant digits', () => {
    expect(formatSignificant(84.9061)).toBe('84.9')
    expect(formatSignificant(0.0012345)).toBe('0.00123')
    expect(formatSignificant(12345.6)).toBe('12,346')
  })

  it('rounds long decimals inside text but not versions', () => {
    expect(roundNumbersInText('measured 84.9061 tokens/s vs 2.3 baseline')).toBe('measured 84.9 tokens/s vs 2.3 baseline')
    expect(roundNumbersInText('torch 2.9.1 and mlx 0.29.3')).toBe('torch 2.9.1 and mlx 0.29.3')
  })
})

describe('humanizeMetric', () => {
  it('turns metric ids into plain labels with units', () => {
    expect(humanizeMetric('throughput_tokens_per_s')).toBe('Throughput (tokens/s)')
    expect(humanizeMetric('decode_tokens_per_s')).toBe('Decode speed (tokens/s)')
    expect(humanizeMetric('ttft_ms')).toBe('Time to first token (ms)')
    expect(humanizeMetric('p50_latency_ms')).toBe('P50 latency (ms)')
    expect(humanizeMetric('kv_cache_memory_gb')).toBe('KV cache memory (GB)')
    expect(humanizeMetric('requests_per_s')).toBe('Requests/s')
    expect(humanizeMetric('quality_score')).toBe('Quality score')
    expect(humanizeMetric('Throughput')).toBe('Throughput')
    expect(humanizeMetric(null)).toBe('')
  })
})

describe('formatAcronyms', () => {
  it('fixes acronym case without touching ordinary words', () => {
    expect(formatAcronyms('Kv cache for llms on the gpu')).toBe('KV cache for LLMs on the GPU')
    expect(formatAcronyms('rope scaling and kv-cache')).toBe('RoPE scaling and KV-cache')
    expect(formatAcronyms('said the aim was mild')).toBe('said the aim was mild')
  })
})

describe('math and raw strings', () => {
  it('turns LaTeX into plain characters', () => {
    expect(formatMath('4^{-b} penalty')).toBe('4⁻ᵇ penalty')
    expect(formatMath('2^10 entries')).toBe('2¹⁰ entries')
    expect(formatMath('$O(n^2)$ cost')).toBe('O(n²) cost')
    expect(formatMath('2.6\\times faster, \\alpha \\le 0.5')).toBe('2.6× faster, α ≤ 0.5')
    expect(formatMath('\\frac{1}{2} the bits')).toBe('1/2 the bits')
    expect(formatMath('W_q and x_{ij}')).toBe('W_(q) and xᵢⱼ')
  })

  it('keeps snake_case identifiers intact', () => {
    expect(formatMath('throughput_tokens_per_s')).toBe('throughput_tokens_per_s')
  })

  it('splits math into segments for <MathText>', () => {
    expect(parseMath('4^{-b} penalty')).toEqual([
      { kind: 'text', text: '4' },
      { kind: 'sup', text: '−b' },
      { kind: 'text', text: ' penalty' },
    ])
    expect(parseMath('d_k')).toEqual([
      { kind: 'text', text: 'd' },
      { kind: 'sub', text: 'k' },
    ])
  })

  it('cleans raw log and LLM strings', () => {
    expect(sanitizeText('\u001b[32mOK\u001b[0m   done\r\n')).toBe('OK done')
    expect(sanitizeText('expected 0…+10% gain')).toBe('expected 0 to +10% gain')
    expect(sanitizeText('a 4^{-b} penalty at 84.9061 tokens/s')).toBe('a 4⁻ᵇ penalty at 84.9 tokens/s')
    expect(sanitizeText('line 1\n\n\n\nline 2', { keepNewlines: true })).toBe('line 1\n\nline 2')
    expect(sanitizeText(null)).toBe('')
  })
})
