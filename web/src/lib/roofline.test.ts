import { describe, expect, it } from 'vitest'
import type { Prediction, Roofline } from '../api/types'
import {
  bandwidthLimit,
  bandwidthUtilization,
  bottleneckOf,
  formatGainRange,
  isCostModelBlocker,
  likelihoodOf,
  numericSeries,
  predictionHeadline,
  predictionMatchesMetric,
  singleStepMs,
  sortByPrediction,
} from './roofline'

const ROOFLINE: Roofline = {
  kind: 'profile',
  model: { bytes_per_token_gb: 3.3 },
  hardware: { peak_bandwidth_gbs: 307 },
  decode: { tokens_per_s: 24.1, ms_per_token: 41.5, bandwidth_utilization: 0.9 },
  forward_cost_ms: { '16': 66.4, '1': 41.5, '4': 45.8, bad: 3, '8': null as unknown as number },
}

describe('bandwidth utilization', () => {
  it('compares tok/s with peak bandwidth ÷ bytes per token', () => {
    expect(bandwidthLimit(ROOFLINE)).toBeCloseTo(93.03, 2)
    expect(bandwidthUtilization(ROOFLINE)).toBeCloseTo(0.259, 3)
  })

  it('falls back to the reported utilization when the limit cannot be derived', () => {
    expect(bandwidthUtilization({ decode: { tokens_per_s: 24, bandwidth_utilization: 0.52 } })).toBe(0.52)
    expect(bandwidthUtilization({ hardware: { peak_bandwidth_gbs: 0 }, model: { bytes_per_token_gb: 3 }, decode: {} })).toBeNull()
    expect(bandwidthUtilization(null)).toBeNull()
  })

  it('labels the bottleneck like the cost model', () => {
    expect(bottleneckOf(0.6)).toBe('bandwidth')
    expect(bottleneckOf(0.45)).toBe('mixed')
    expect(bottleneckOf(0.399)).toBe('overhead')
    expect(bottleneckOf(null)).toBe('unknown')
  })
})

describe('curves', () => {
  it('sorts numeric keys and drops invalid points', () => {
    expect(numericSeries(ROOFLINE.forward_cost_ms)).toEqual([
      { x: 1, y: 41.5 },
      { x: 4, y: 45.8 },
      { x: 16, y: 66.4 },
    ])
    expect(numericSeries(undefined)).toEqual([])
  })

  it('takes the single-step cost from the curve, then ms/token, then tok/s', () => {
    expect(singleStepMs(ROOFLINE)).toBe(41.5)
    expect(singleStepMs({ forward_cost_ms: { '2': 40 }, decode: { ms_per_token: 38 } })).toBe(38)
    expect(singleStepMs({ decode: { tokens_per_s: 25 } })).toBe(40)
    expect(singleStepMs({})).toBeNull()
  })
})

const prediction = (likelihood: string, low?: number, high?: number, metric = 'decode_tokens_per_s'): Prediction => ({
  likelihood,
  predicted_gain_pct: low === undefined ? null : { low, high: high ?? low },
  metric,
})

describe('prediction formatting', () => {
  it('formats gain ranges', () => {
    expect(formatGainRange({ low: 8.2, high: 35.4 })).toBe('+8.2…+35%')
    expect(formatGainRange({ low: 35, high: 8 })).toBe('+8…+35%')
    expect(formatGainRange({ low: -2, high: 1.5 })).toBe('−2…+1.5%')
    expect(formatGainRange({ low: 0, high: 0.04 })).toBe('0%')
    expect(formatGainRange(null)).toBeNull()
  })

  it('names the metric briefly', () => {
    expect(predictionHeadline(prediction('likely', 8, 35))).toBe('+8…+35% decode')
    expect(predictionHeadline(prediction('marginal', 0, 4, 'peak_memory_gb'))).toBe('0…+4% peak memory')
    expect(predictionHeadline(prediction('unknown'))).toBe('no estimate')
    expect(predictionHeadline(null)).toBe('not predicted')
  })
})

describe('prediction order and filters', () => {
  it('puts likely first, unlikely last, higher midpoints first, otherwise keeps the rank', () => {
    const items = [
      { id: 1, prediction: prediction('unlikely', -2, 1) },
      { id: 2, prediction: null },
      { id: 3, prediction: prediction('marginal', 0, 4) },
      { id: 4, prediction: prediction('likely', 5, 20) },
      { id: 5, prediction: prediction('likely', 40, 100) },
      { id: 6, prediction: prediction('unknown') },
    ]
    expect(sortByPrediction(items).map((item) => item.id)).toEqual([5, 4, 3, 2, 6, 1])
  })

  it('treats missing or unrecognised predictions as unknown', () => {
    expect(likelihoodOf(null)).toBe('unknown')
    expect(likelihoodOf(prediction('maybe'))).toBe('unknown')
    expect(likelihoodOf(prediction('likely', 5))).toBe('likely')
  })

  it('recognises cost-model blockers', () => {
    expect(isCostModelBlocker('cost model: at most +1.5% on this engine (…)')).toBe(true)
    expect(isCostModelBlocker('needs CUDA')).toBe(false)
  })

  it('draws a band only for the measured metric', () => {
    expect(predictionMatchesMetric(prediction('likely', 5, 20), 'decode_tokens_per_s')).toBe(true)
    expect(predictionMatchesMetric(prediction('likely', 5, 20), 'ttft_ms')).toBe(false)
    expect(predictionMatchesMetric(prediction('unknown'), 'decode_tokens_per_s')).toBe(false)
  })
})
