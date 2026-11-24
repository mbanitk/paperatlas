/**
 * Plain-language helpers for the Projects page and the engine roofline card (PR-2, PR-3): human hardware
 * labels and the one-sentence answer "This engine runs at X tok/s, Y% of what the hardware allows; it's
 * limited by Z, so techniques that reduce Z can help." Unit-tested in overviewProject.test.ts.
 */

import type { Roofline } from '../api/types'
import type { CurvePoint } from './roofline'
import { bandwidthLimit, bandwidthUtilization, bottleneckOf, singleStepMs } from './roofline'
import { formatAcronyms, formatNumber, humanize } from './format'
import type { Bottleneck } from '../api/types'

// ---- hardware ---------------------------------------------------------------------------------------

export interface Fact {
  key: string
  label: string
  value: string
}

const HARDWARE_LABELS: Record<string, { label: string; unit?: string; order: number }> = {
  chip: { label: 'Chip', order: 0 },
  accelerator: { label: 'Accelerator', order: 1 },
  memory_gb: { label: 'Memory', unit: 'GB', order: 2 },
  peak_bandwidth_gbs: { label: 'Peak memory bandwidth', unit: 'GB/s', order: 3 },
  gpu_count: { label: 'GPUs', order: 4 },
  multi_gpu: { label: 'Multiple GPUs', order: 5 },
  cuda: { label: 'CUDA', order: 6 },
}

const UNIT_SUFFIX: [RegExp, string][] = [
  [/_gbs$/, 'GB/s'],
  [/_gb$/, 'GB'],
  [/_mb$/, 'MB'],
  [/_ms$/, 'ms'],
  [/_w$/, 'W'],
  [/_tflops$/, 'TFLOPS'],
]

/** `{ memory_gb: 64, cuda: false }` → "Memory: 64 GB", "CUDA: No", known keys first. */
export function hardwareFacts(hardware: Record<string, unknown> | null | undefined): Fact[] {
  const facts = Object.entries(hardware ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => {
      const known = HARDWARE_LABELS[key]
      const suffix = UNIT_SUFFIX.find(([pattern]) => pattern.test(key))
      const unit = known?.unit ?? suffix?.[1]
      const label = known?.label ?? sentence(formatAcronyms(humanize(suffix ? key.replace(suffix[0], '') : key)))
      return { key, label, value: factValue(value, unit), order: known?.order ?? 100 }
    })
  return facts.sort((a, b) => a.order - b.order).map(({ key, label, value }) => ({ key, label, value }))
}

function factValue(value: unknown, unit?: string): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return `${formatNumber(value)}${unit ? ` ${unit}` : ''}`
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return `${String(value)}${unit ? ` ${unit}` : ''}`
}

const sentence = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text)

/** "Apple M5 Pro · 64 GB · apple-gpu (metal, via mlx)" for the project list. */
export function hardwareSummary(hardware: Record<string, unknown> | null | undefined): string {
  const facts = hardwareFacts(hardware)
  const pick = (key: string) => facts.find((fact) => fact.key === key)?.value
  return [pick('chip'), pick('memory_gb'), pick('accelerator')].filter(Boolean).join(' · ') || 'Hardware not described'
}

// ---- roofline answer ------------------------------------------------------------------------------------

const LIMIT_SENTENCE: Record<Bottleneck, string> = {
  bandwidth:
    'It’s limited by memory bandwidth, so techniques that read fewer bytes per token (quantization, KV-cache compression) or check several tokens per weight read (speculative decoding) can help.',
  overhead:
    'It’s limited by per-step overhead (framework and kernel launches), not by memory bandwidth, so techniques that cut per-step overhead help most and saving bytes barely helps.',
  mixed: 'It’s limited partly by memory bandwidth and partly by per-step overhead, so techniques that cut per-step overhead can still help.',
  unknown: 'Its memory-bandwidth limit isn’t known (the profile doesn’t report peak bandwidth or bytes per token), so it’s not clear what limits it.',
}

export interface RooflineAnswer {
  /** "This engine decodes at 107 tok/s, 58% of what its memory bandwidth allows (185 tok/s)." */
  headline: string
  /** "It's limited partly by … so techniques that cut per-step overhead can still help." */
  detail: string
  bottleneck: Bottleneck
  /** 0–100, null when unknown. */
  percent: number | null
}

export function rooflineAnswer(roofline: Roofline | null | undefined): RooflineAnswer | null {
  if (!roofline) return null
  const speed = roofline.decode?.tokens_per_s
  const utilization = bandwidthUtilization(roofline)
  const limit = bandwidthLimit(roofline)
  const bottleneck = bottleneckOf(utilization)
  const percent = utilization === null ? null : Math.round(utilization * 100)
  const speedText = typeof speed === 'number' && Number.isFinite(speed) ? `${formatNumber(speed, speed >= 100 ? 0 : 1)} tok/s` : null
  let headline: string
  if (speedText && percent !== null)
    headline = `This engine decodes at ${speedText}, ${percent}% of what its memory bandwidth allows${limit ? ` (${formatNumber(limit, 0)} tok/s)` : ''}.`
  else if (speedText) headline = `This engine decodes at ${speedText}.`
  else if (percent !== null) headline = `This engine runs at ${percent}% of what its memory bandwidth allows.`
  else headline = 'The roofline was measured, but it doesn’t report the decode speed.'
  return { headline, detail: LIMIT_SENTENCE[bottleneck], bottleneck, percent }
}

/** "Measured with mlx-community/Qwen3.5-35B-A3B-4bit (4bit, 3.5B active of 34.7B) on Apple M5 Pro, 64 GB." */
export function measuredWith(roofline: Roofline | null | undefined): string | null {
  const model = roofline?.model ?? {}
  const hardware = roofline?.hardware ?? {}
  const details = [
    model.quantization,
    typeof model.active_params_b === 'number' &&
      `${formatNumber(model.active_params_b, 1)}B active${typeof model.total_params_b === 'number' ? ` of ${formatNumber(model.total_params_b, 1)}B` : ''}`,
  ].filter(Boolean)
  const machine = [hardware.chip, typeof hardware.memory_gb === 'number' && `${formatNumber(hardware.memory_gb)} GB`].filter(Boolean).join(', ')
  if (!model.id && !machine) return null
  return `Measured with ${model.id ?? 'the eval model'}${details.length ? ` (${details.join(', ')})` : ''}${machine ? ` on ${machine}` : ''}.`
}

// ---- chart takeaways ----------------------------------------------------------------------------------------

/** "Checking 16 tokens in one pass costs 4.5× a normal step." */
export function verificationTakeaway(points: readonly CurvePoint[], roofline: Roofline | null | undefined): string | null {
  const step = singleStepMs(roofline)
  const last = points[points.length - 1]
  if (!last || !step || last.x <= 1) return null
  return `Checking ${last.x} tokens in one pass costs ${formatNumber(last.y / step, 1)}× a normal step.`
}

/** "Serving 8 requests at once gives 2.4× the throughput of one." */
export function batchTakeaway(points: readonly CurvePoint[]): string | null {
  const single = points.find((point) => point.x === 1)?.y
  const top = points[points.length - 1]
  if (!single || !top || top.x <= 1) return null
  return `Serving ${top.x} requests at once gives ${formatNumber(top.y / single, 1)}× the throughput of one.`
}

/** "A draft-model token costs 24% of a target step." */
export function draftTakeaway(roofline: Roofline | null | undefined): string | null {
  const target = singleStepMs(roofline)
  const draft = roofline?.draft?.ms_per_token
  if (!target || typeof draft !== 'number' || !Number.isFinite(draft)) return null
  return `A draft-model token costs ${formatNumber((draft / target) * 100, 0)}% of a target-model step.`
}

/** Round, readable upper bound for a chart axis: 48.6 → 50, 258 → 300, 0.84 → 1. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const scaled = value / power
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((candidate) => scaled <= candidate) ?? 10
  return step * power
}
