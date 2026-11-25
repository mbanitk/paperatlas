import { describe, expect, it } from 'vitest'
import type { Roofline } from '../api/types'
import { numericSeries } from './roofline'
import {
  batchTakeaway,
  draftTakeaway,
  hardwareFacts,
  hardwareSummary,
  measuredWith,
  niceMax,
  rooflineAnswer,
  verificationTakeaway,
} from './overviewProject'

const HARDWARE = { chip: 'Apple M5 Pro', cuda: false, memory_gb: 64, multi_gpu: false, accelerator: 'apple-gpu (metal, via mlx)', peak_bandwidth_gbs: 307, l2_cache_mb: 32 }

const ROOFLINE: Roofline = {
  model: { id: 'mlx-community/Qwen3.5-35B-A3B-4bit', quantization: '4bit', total_params_b: 34.661, active_params_b: 3.455, bytes_per_token_gb: 1.659 },
  hardware: { chip: 'Apple M5 Pro', memory_gb: 64, peak_bandwidth_gbs: 307 },
  decode: { ms_per_token: 9.32, tokens_per_s: 107.25, bandwidth_utilization: 0.5796 },
  forward_cost_ms: { '1': 10.78, '2': 13.31, '4': 18.83, '8': 29.12, '16': 48.59 },
  batch_decode_tokens_per_s: { '1': 106.2, '2': 157.1, '4': 208.3, '8': 258.3 },
  draft: { id: 'mlx-community/Qwen3.5-0.8B-4bit', ms_per_token: 2.6 },
}

describe('hardware facts', () => {
  it('uses human labels and units instead of raw keys', () => {
    expect(hardwareFacts(HARDWARE)).toEqual([
      { key: 'chip', label: 'Chip', value: 'Apple M5 Pro' },
      { key: 'accelerator', label: 'Accelerator', value: 'apple-gpu (metal, via mlx)' },
      { key: 'memory_gb', label: 'Memory', value: '64 GB' },
      { key: 'peak_bandwidth_gbs', label: 'Peak memory bandwidth', value: '307 GB/s' },
      { key: 'multi_gpu', label: 'Multiple GPUs', value: 'No' },
      { key: 'cuda', label: 'CUDA', value: 'No' },
      { key: 'l2_cache_mb', label: 'L2 cache', value: '32 MB' },
    ])
    expect(hardwareFacts(null)).toEqual([])
  })

  it('summarises the machine in one line', () => {
    expect(hardwareSummary(HARDWARE)).toBe('Apple M5 Pro · 64 GB · apple-gpu (metal, via mlx)')
    expect(hardwareSummary({})).toBe('Hardware not described')
  })
})

describe('rooflineAnswer', () => {
  it('states speed, share of the limit and what limits it', () => {
    expect(rooflineAnswer(ROOFLINE)).toEqual({
      headline: 'This engine decodes at 107 tok/s, 58% of what its memory bandwidth allows (185 tok/s).',
      detail: 'It’s limited partly by memory bandwidth and partly by per-step overhead, so techniques that cut per-step overhead can still help.',
      bottleneck: 'mixed',
      percent: 58,
    })
  })

  it('names the bottleneck at each end of the scale', () => {
    expect(rooflineAnswer({ ...ROOFLINE, decode: { tokens_per_s: 160 } })?.detail).toMatch(/^It’s limited by memory bandwidth/)
    expect(rooflineAnswer({ ...ROOFLINE, decode: { tokens_per_s: 40 } })?.detail).toMatch(/^It’s limited by per-step overhead/)
  })

  it('says what is unknown instead of guessing', () => {
    const answer = rooflineAnswer({ decode: { tokens_per_s: 24.1 } })
    expect(answer?.headline).toBe('This engine decodes at 24.1 tok/s.')
    expect(answer?.bottleneck).toBe('unknown')
    expect(rooflineAnswer(null)).toBeNull()
  })

  it('names the model and machine it was measured with', () => {
    expect(measuredWith(ROOFLINE)).toBe('Measured with mlx-community/Qwen3.5-35B-A3B-4bit (4bit, 3.5B active of 34.7B) on Apple M5 Pro, 64 GB.')
    expect(measuredWith({})).toBeNull()
  })
})

describe('chart takeaways', () => {
  it('turns each chart into one sentence', () => {
    expect(verificationTakeaway(numericSeries(ROOFLINE.forward_cost_ms), ROOFLINE)).toBe('Checking 16 tokens in one pass costs 4.5× a normal step.')
    expect(batchTakeaway(numericSeries(ROOFLINE.batch_decode_tokens_per_s))).toBe('Serving 8 requests at once gives 2.4× the throughput of one.')
    expect(draftTakeaway(ROOFLINE)).toBe('A draft-model token costs 24% of a target-model step.')
    expect(batchTakeaway([])).toBeNull()
  })

  it('rounds axis maxima to readable numbers', () => {
    expect(niceMax(48.6)).toBe(50)
    expect(niceMax(258)).toBe(300)
    expect(niceMax(0.84)).toBe(1)
    expect(niceMax(0)).toBe(1)
  })
})
