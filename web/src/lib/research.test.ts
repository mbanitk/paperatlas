import { describe, expect, it } from 'vitest'
import type { Claim, ExperimentSummary, Recommendation } from '../api/types'
import {
  bestClaims,
  claimedFigure,
  experimentsByClaim,
  formatResultValue,
  isAutoDescription,
  momentumText,
  monthlyMomentum,
  paperShortLabel,
  topicDisplayNames,
  topicSummary,
} from './research'

const topic = (slug: string, name: string, keywords: string[], rank: number) => ({ slug, name, keywords, rank })

describe('topicDisplayNames', () => {
  it('uses the multi-word key phrase, fixes acronyms and tells duplicates apart', () => {
    const names = topicDisplayNames([
      topic('decoding', 'Decoding', ['decoding', 'draft', 'speculative decoding'], 1),
      topic('kv', 'Kv', ['kv', 'cache', 'quantization', 'kv cache'], 3),
      topic('cache', 'Cache', ['cache', 'kv', 'kv cache', 'eviction'], 5),
      topic('kv-6', 'Kv', ['kv', 'cache', 'kv cache', 'model', 'agent'], 6),
      topic('video', 'Video', ['video', 'visual'], 2),
    ])
    expect(names.get('decoding')).toBe('Speculative decoding')
    expect(names.get('video')).toBe('Video')
    expect(names.get('kv')).toBe('KV cache (quantization)')
    expect(names.get('cache')).toBe('KV cache (eviction)')
    expect(names.get('kv-6')).toBe('KV cache (agent)')
  })

  it('numbers duplicates that have nothing distinctive', () => {
    const names = topicDisplayNames([topic('a', 'Kv', ['kv', 'model'], 1), topic('b', 'KV', ['kv'], 2)])
    expect([names.get('a'), names.get('b')]).toEqual(['KV', 'KV (2)'])
  })
})

describe('topic summaries', () => {
  it('hides the scanner placeholder but keeps real text', () => {
    expect(isAutoDescription("Recent work in 'Speculative decoding' about decoding, draft, model.")).toBe(true)
    expect(topicSummary({ description: "Recent work in 'X' about a, b.", explainer: null })).toBeNull()
    expect(topicSummary({ description: "Recent work in 'X' about a, b.", explainer: { summary: 'Drafting tokens cheaply.' } })).toBe('Drafting tokens cheaply.')
    expect(topicSummary({ description: 'Hand-written description.', explainer: null })).toBe('Hand-written description.')
  })
})

describe('momentum', () => {
  const monthly = [
    { month: '2026-09', papers: 4 },
    { month: '2026-11', papers: 16 },
    { month: '2026-10', papers: 12 },
  ]
  it('compares the latest month with the one before and flags a month still in progress', () => {
    const now = new Date(2026, 10, 24)
    const momentum = monthlyMomentum(monthly, now)
    expect(momentum).toMatchObject({ change: 4, direction: 'up', partial: true })
    expect(momentumText(momentum)).toBe('16 papers so far in Nov (12 in Oct)')
    expect(momentumText(monthlyMomentum([{ month: '2026-08', papers: 1 }, { month: '2026-09', papers: 0 }], now))).toBe('0 papers in Sep (1 in Aug)')
    expect(momentumText(monthlyMomentum([], now))).toBeNull()
  })
})

describe('formatResultValue', () => {
  it('writes ratios, percentages and ranges plainly', () => {
    expect(formatResultValue('1.71x')).toBe('1.71×')
    expect(formatResultValue('up to 15x faster')).toBe('up to 15× faster')
    expect(formatResultValue('5 to 41 percent')).toBe('5 to 41%')
    expect(formatResultValue('+5…+30%')).toBe('+5 to +30%')
    expect(formatResultValue('25.0 MB')).toBe('25.0 MB')
  })
})

describe('claimedFigure', () => {
  const claim = { claimed_gain_pct: null, claimed_value: null, claimed_unit: null, direction: null, primary_metric: 'wall-clock speedup', explainer: null }
  it('gives the paper’s number without arrows, signed for relative gains', () => {
    expect(claimedFigure({ ...claim, claimed_gain_pct: 41, claimed_value: 41, claimed_unit: '%', direction: 'increase' })).toEqual({ value: '+41%', metric: 'wall-clock speedup' })
    expect(claimedFigure({ ...claim, claimed_gain_pct: 30, claimed_value: 30, claimed_unit: '%', direction: 'decrease' })?.value).toBe('−30%')
    expect(claimedFigure({ ...claim, claimed_gain_pct: 376, claimed_value: 4.76, claimed_unit: 'x', direction: 'increase' })?.value).toBe('4.76×')
    expect(claimedFigure({ ...claim, claimed_value: 1070, claimed_unit: 'tokens/s/GPU' })?.value).toBe('1,070 tokens/s/GPU')
    expect(claimedFigure(claim)).toBeNull()
  })
})

const experiment = (id: number, claim_id: number, extra: Partial<ExperimentSummary> = {}) => ({ id, claim_id, paper_id: 'p', ...extra }) as ExperimentSummary

describe('experimentsByClaim', () => {
  it('lists newest first and counts bundled claims as tested', () => {
    const map = experimentsByClaim([experiment(1, 10), experiment(3, 10), experiment(2, 11, { bundle_claim_ids: [12] })])
    expect(map.get(10)?.map((item) => item.id)).toEqual([3, 1])
    expect(map.get(12)?.map((item) => item.id)).toEqual([2])
  })
})

describe('bestClaims', () => {
  const claim = (id: number, paper_id: string, extra: Partial<Claim> = {}) =>
    ({
      id,
      paper_id,
      kind: 'method',
      testable: true,
      claimed_gain_pct: null,
      claimed_value: null,
      claimed_unit: null,
      direction: null,
      primary_metric: null,
      explainer: null,
      requires_cuda: false,
      requires_multi_gpu: false,
      requires_training: false,
      ...extra,
    }) as Claim
  it('prefers the project’s ranking, skips untestable claims and spreads picks across papers', () => {
    const claims = [
      claim(1, 'a', { explainer: { headline: 'x' }, claimed_gain_pct: 10, claimed_value: 10, claimed_unit: '%' }),
      claim(2, 'a', { explainer: { headline: 'y' } }),
      claim(3, 'b', { testable: false, explainer: { headline: 'z' } }),
      claim(4, 'c'),
      claim(5, 'a'),
    ]
    const recs = [{ id: 5, rank: 2 } as Recommendation]
    expect(bestClaims(claims, recs).map((item) => item.id)).toEqual([5, 4, 1])
    expect(bestClaims(claims, recs)[0].recommendation?.rank).toBe(2)
    expect(bestClaims(claims, []).map((item) => item.id)).toEqual([1, 4, 2])
  })

  it('ranks buildable techniques with a reported gain above findings, limitations and CUDA-only claims', () => {
    const gain = { claimed_gain_pct: 20, claimed_value: 20, claimed_unit: '%', direction: 'increase' }
    const claims = [
      claim(1, 'a', { kind: 'limitation', ...gain, direction: 'decrease' }),
      claim(2, 'b', { kind: 'finding', ...gain }),
      claim(3, 'c', { ...gain, requires_cuda: true }),
      claim(4, 'd', { kind: 'algorithm', ...gain }),
    ]
    expect(bestClaims(claims, null, 4).map((item) => item.id)).toEqual([4, 3, 2, 1])
  })
})

describe('paperShortLabel', () => {
  it('keeps breadcrumbs short and readable', () => {
    expect(paperShortLabel('arxiv:2610.07659')).toBe('arXiv 2610.07659')
    expect(paperShortLabel('blog:c4b61c85055853a6740e3f0de459554c9e7fb2d8')).toBe('Blog post')
    expect(paperShortLabel('patent:US1234567B2', 'patent')).toBe('Patent')
  })
})
