/** Pure helpers for the engine roofline and the cost-model predictions (unit-tested in roofline.test.ts). */

import type { Bottleneck, Likelihood, Prediction, Roofline } from '../api/types'
import { BOTTLENECK, legacyTone, LIKELIHOOD, likelihoodSemantics, type LegacyTone, type LikelihoodSemantics, type SemanticInfo } from './semantics'

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Decode speed the memory bandwidth allows: every token streams the active weights once (tok/s). */
export function bandwidthLimit(roofline: Roofline | null | undefined): number | null {
  const peak = roofline?.hardware?.peak_bandwidth_gbs
  const bytes = roofline?.model?.bytes_per_token_gb
  return finite(peak) && finite(bytes) && peak > 0 && bytes > 0 ? peak / bytes : null
}

/** Share of the bandwidth limit the engine reaches (0–1): measured tok/s vs the limit, else the reported utilization. */
export function bandwidthUtilization(roofline: Roofline | null | undefined): number | null {
  const limit = bandwidthLimit(roofline)
  const speed = roofline?.decode?.tokens_per_s
  if (limit && finite(speed) && speed >= 0) return speed / limit
  const reported = roofline?.decode?.bandwidth_utilization
  return finite(reported) && reported >= 0 ? reported : null
}

/** Mirrors lab/costmodel.bottleneck: ≥ 0.6 bandwidth-bound, < 0.4 overhead-bound, otherwise mixed. */
export function bottleneckOf(utilization: number | null | undefined): Bottleneck {
  if (!finite(utilization)) return 'unknown'
  if (utilization >= 0.6) return 'bandwidth'
  if (utilization < 0.4) return 'overhead'
  return 'mixed'
}

export type BottleneckInfo = Omit<SemanticInfo, 'tone'> & { tone: LegacyTone }

/**
 * Labels and descriptions from lib/semantics.ts ("Bandwidth-bound", "Overhead-bound", "Mixed", "Not measured").
 * `tone` keeps the legacy names (success/attention/neutral) because existing callers compare against them;
 * use `BOTTLENECK` from lib/semantics.ts for the semantic tone.
 */
export const BOTTLENECK_INFO: Record<Bottleneck, BottleneckInfo> = Object.fromEntries(
  Object.entries(BOTTLENECK).map(([key, info]) => [key, { ...info, tone: legacyTone(info.tone) }]),
) as Record<Bottleneck, BottleneckInfo>

export function bottleneckInfo(value: string | null | undefined): BottleneckInfo {
  return BOTTLENECK_INFO[(value ?? 'unknown') as Bottleneck] ?? BOTTLENECK_INFO.unknown
}

export interface CurvePoint {
  x: number
  y: number
}

/** `{"1": 41.5, "16": 66.4, …}` → points sorted by x, ignoring keys or values that are not finite numbers. */
export function numericSeries(record: Record<string, unknown> | null | undefined): CurvePoint[] {
  return Object.entries(record ?? {})
    .map(([key, value]) => ({ x: Number(key), y: typeof value === 'number' ? value : Number.NaN }))
    .filter((point) => Number.isFinite(point.x) && point.x > 0 && Number.isFinite(point.y) && point.y > 0)
    .sort((a, b) => a.x - b.x)
}

/** Cost of one forward pass appending one token: the curve's first point at 1 token, else the decode ms/token. */
export function singleStepMs(roofline: Roofline | null | undefined): number | null {
  const one = numericSeries(roofline?.forward_cost_ms).find((point) => point.x === 1)
  if (one) return one.y
  const ms = roofline?.decode?.ms_per_token
  if (finite(ms) && ms > 0) return ms
  const speed = roofline?.decode?.tokens_per_s
  return finite(speed) && speed > 0 ? 1000 / speed : null
}

// ---- predictions ------------------------------------------------------------------------------

/** Re-exported from lib/semantics.ts ("Likely gain", "Small or no gain", "Unlikely to help", "Not estimated"). */
export const LIKELIHOOD_INFO: Record<Likelihood, LikelihoodSemantics> = LIKELIHOOD

export function likelihoodInfo(value: string | null | undefined): LikelihoodSemantics {
  return likelihoodSemantics(value)
}

export const LIKELIHOODS: Likelihood[] = ['likely', 'marginal', 'unlikely', 'unknown']

const METRIC_SHORT: Record<string, string> = {
  decode_tokens_per_s: 'decode',
  throughput_tokens_per_s: 'throughput',
  peak_memory_gb: 'peak memory',
  ttft_ms: 'TTFT',
  itl_ms: 'ITL',
  e2e_latency_ms: 'latency',
}

export function metricShort(metric: string | null | undefined): string {
  if (!metric) return ''
  return METRIC_SHORT[metric] ?? metric.replace(/_/g, ' ')
}

/** Signed whole percent; one decimal below 10 so small ranges stay readable: `+8`, `+2.6`, `−2`, `0`. */
function signedPct(value: number): string {
  const digits = Math.abs(value) < 10 && !Number.isInteger(value) ? 1 : 0
  const rounded = Number(value.toFixed(digits))
  if (rounded === 0) return '0'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(digits)}`
}

/** `+8 to +35%` (or `+5%` when both ends match); null without a range. */
export function formatGainRange(range: Prediction['predicted_gain_pct'] | undefined): string | null {
  if (!range || !finite(range.low) || !finite(range.high)) return null
  const [low, high] = range.low <= range.high ? [range.low, range.high] : [range.high, range.low]
  const a = signedPct(low)
  const b = signedPct(high)
  return a === b ? `${a}%` : `${a} to ${b}%`
}

/** `+8 to +35% decode`, or the likelihood's fallback text when there is no range. */
export function predictionHeadline(prediction: Prediction | null | undefined): string {
  if (!prediction) return 'not estimated'
  const range = formatGainRange(prediction.predicted_gain_pct)
  if (!range) return 'not estimated'
  const metric = metricShort(prediction.metric)
  return metric ? `${range} ${metric}` : range
}

/** Sort key: likely first, then marginal, unknown, unlikely; within a group the higher predicted midpoint first. */
export function compareByPrediction(a: Prediction | null | undefined, b: Prediction | null | undefined): number {
  const rank = likelihoodInfo(a?.likelihood).rank - likelihoodInfo(b?.likelihood).rank
  if (rank) return rank
  const mid = (p: Prediction | null | undefined) =>
    p?.predicted_gain_pct && finite(p.predicted_gain_pct.low) && finite(p.predicted_gain_pct.high)
      ? (p.predicted_gain_pct.low + p.predicted_gain_pct.high) / 2
      : Number.NEGATIVE_INFINITY
  const diff = mid(b) - mid(a)
  return Number.isNaN(diff) ? 0 : diff
}

/** Items in prediction order (stable: equal predictions keep their match rank). */
export function sortByPrediction<T extends { prediction?: Prediction | null }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compareByPrediction(a.item.prediction, b.item.prediction) || a.index - b.index)
    .map(({ item }) => item)
}

/** The likelihood an item is filtered by: a missing prediction counts as unknown. */
export const likelihoodOf = (prediction: Prediction | null | undefined): Likelihood => {
  const value = prediction?.likelihood
  return value && value in LIKELIHOOD_INFO ? (value as Likelihood) : 'unknown'
}

/** Blockers added by the cost model ("cost model: at most +1.5% on this engine (…)"). */
export const isCostModelBlocker = (blocker: string): boolean => /^cost model:/i.test(blocker.trim())

/** Whether a predicted range is about the metric an experiment measures (only then can it be drawn on its number line). */
export function predictionMatchesMetric(prediction: Prediction | null | undefined, metric: string | null | undefined): boolean {
  return !!prediction?.predicted_gain_pct && !!metric && prediction.metric === metric
}
