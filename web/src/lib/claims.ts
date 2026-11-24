import type { Claim, ClaimExplainer, ExperimentStatus } from '../api/types'
import { formatNumber, formatScore, humanizeMetric, MISSING, pluralize } from './format'
import { isActiveStatus } from './stages'

export type EffectView =
  | { kind: 'gain'; gainPct: number; text: string; metric: string | null; summary: string | null }
  | { kind: 'neutral'; text: string; metric: string | null; summary: string | null }
  | { kind: 'none'; text: string; metric: null; summary: string | null }

const RATIO_UNITS = ['x', '×', 'times', 'fold']

/**
 * How to show a claim's reported effect. Only relative gains (claimed_gain_pct set, and not flagged as
 * non-relative by the explainer) get a directional ↑/↓ and the gain gauge; absolute values such as
 * "0.14×", "64.2 ms" or "59.3 GB" are shown neutrally.
 */
export function claimedEffectView(
  claim: Pick<Claim, 'claimed_gain_pct' | 'claimed_value' | 'claimed_unit' | 'direction' | 'primary_metric'>,
  explainer?: ClaimExplainer | null,
): EffectView {
  const summary = explainer?.claimed_result?.summary?.trim() || null
  const relative = explainer?.claimed_result?.is_relative_gain !== false
  const metric = claim.primary_metric || null
  const gain = claim.claimed_gain_pct
  if (gain !== null && gain !== undefined && Number.isFinite(gain) && relative) {
    const arrow = claim.direction === 'decrease' ? '↓' : '↑'
    const unit = (claim.claimed_unit || '').trim().toLowerCase()
    const text =
      claim.claimed_value !== null && claim.claimed_value !== undefined && RATIO_UNITS.includes(unit)
        ? `${arrow}${formatNumber(claim.claimed_value, 2)}×`
        : `${arrow}${formatNumber(Math.abs(gain), 1)}%`
    return { kind: 'gain', gainPct: Math.abs(gain), text, metric, summary }
  }
  if (claim.claimed_value !== null && claim.claimed_value !== undefined && Number.isFinite(claim.claimed_value)) {
    const unit = (claim.claimed_unit || '').trim()
    const value = formatNumber(claim.claimed_value, 2)
    const text = !unit ? value : RATIO_UNITS.includes(unit.toLowerCase()) ? `${value}×` : unit === '%' ? `${value}%` : `${value} ${unit}`
    return { kind: 'neutral', text, metric, summary }
  }
  return { kind: 'none', text: MISSING.claim, metric: null, summary }
}

/**
 * The effect as plain text, without the ↑/↓ arrow: percentages are signed (`+41%`, `−20%`), ratios are not
 * (`2×`, or `2.6× lower` for a decrease), absolute values stay as reported.
 */
export function effectText(view: EffectView, direction: string | null | undefined): string {
  if (view.kind !== 'gain') return view.text
  const bare = view.text.replace(/^[↑↓]/, '')
  if (bare.endsWith('×')) return direction === 'decrease' ? `${bare} lower` : bare
  return `${direction === 'decrease' ? '−' : '+'}${bare}`
}

export type Level = 'low' | 'medium' | 'high'

export const EFFORT_LEVEL: Record<string, number> = { low: 1, medium: 2, high: 3 }

/** The claim's effort as a level ("low"/"medium"/"high"); null when the card has none. */
export function effortLevel(effort: string | null | undefined): Level | null {
  if (!effort) return null
  return (['low', 'medium', 'high'] as Level[])[(EFFORT_LEVEL[effort] ?? 2) - 1]
}

/** The matcher's 0–1 fit score as a word: ≥ 0.67 high, ≥ 0.34 medium, else low. */
export function fitLevel(fit: number | null | undefined): Level | null {
  if (typeof fit !== 'number' || !Number.isFinite(fit)) return null
  return fit >= 0.67 ? 'high' : fit >= 0.34 ? 'medium' : 'low'
}

const EXPECTED_METRIC: Record<string, string> = {
  decode_tokens_per_s: 'decode speed',
  throughput_tokens_per_s: 'throughput',
  prefill_tokens_per_s: 'prefill speed',
  tokens_per_s: 'speed',
  ttft_ms: 'time to first token',
  itl_ms: 'inter-token latency',
  tpot_ms: 'time per output token',
  e2e_latency_ms: 'end-to-end latency',
  latency_ms: 'latency',
  peak_memory_gb: 'peak memory',
  memory_gb: 'memory',
}

/** Short plain words for the metric next to an expected gain: `decode_tokens_per_s` → "decode speed". */
export function expectedMetricLabel(metric: string | null | undefined): string {
  if (!metric) return ''
  if (EXPECTED_METRIC[metric]) return EXPECTED_METRIC[metric]
  const plain = humanizeMetric(metric).replace(/\s*\([^)]*\)$/, '')
  return plain.charAt(0).toLowerCase() + plain.slice(1)
}

/** "Being tested in" until the A/B test has a verdict; "Tested in" once it's judged (Gate 3) or ended. */
export function experimentVerb(status: ExperimentStatus | string | null | undefined): string {
  return status && status !== 'awaiting_decision' && isActiveStatus(status as ExperimentStatus) ? 'Being tested in' : 'Tested in'
}

/** Words for the match score's popover, with the numbers behind it. */
export function matchScoreExplanation(item: { score: number; fit?: number | null; gain?: number | null; effort_cost?: number | null }): string {
  const parts = [
    typeof item.fit === 'number' && `fit ${formatScore(item.fit)}`,
    typeof item.gain === 'number' && `expected gain ${formatScore(item.gain)}`,
    typeof item.effort_cost === 'number' && `effort cost ${formatNumber(item.effort_cost, 2)}`,
  ].filter(Boolean)
  return `How well this claim suits the project, used to rank the list. Match = fit × (0.4 + expected gain) ÷ effort cost${
    parts.length ? `. Here: ${parts.join(', ')} → ${formatScore(item.score)}` : ''
  }.`
}

/**
 * Gate 1's bottom line: "12 of 30 ranked claims are likely to gain on inference-lab (Apple M5 Pro)." Without
 * a measured roofline nothing can be estimated, so it says that instead.
 */
export function gateOneAnswer({ total, likely, project, chip, estimated = true }: {
  total: number
  likely: number
  project?: string | null
  chip?: string | null
  estimated?: boolean
}): string {
  if (!total) return 'No claims are ranked for this project yet.'
  const where = project ? ` on ${project}${chip ? ` (${chip})` : ''}` : ' here'
  if (!estimated) return `${pluralize(total, 'ranked claim')}. Expected gains${where} aren’t estimated until the engine’s roofline is measured.`
  if (!likely) return `None of the ${pluralize(total, 'ranked claim')} is likely to gain much${where}.`
  if (total === 1) return `The only ranked claim is likely to gain${where}.`
  if (likely === total) return `All ${pluralize(total, 'ranked claim')} are likely to gain${where}.`
  return `${likely} of ${pluralize(total, 'ranked claim')} ${likely === 1 ? 'is' : 'are'} likely to gain${where}.`
}

/** Rough risk of trying the claim here: blockers, caveats/risks, approximate technique, special hardware. */
export function riskLevel(
  claim: Pick<Claim, 'requires_cuda' | 'requires_multi_gpu' | 'requires_training' | 'card'>,
  explainer?: ClaimExplainer | null,
  blockers: string[] = [],
): Level {
  let score = blockers.length ? 2 : 0
  const concerns = explainer?.caveats?.length ?? claim.card?.risks?.length ?? 0
  score += Math.min(concerns, 3) * 0.4
  if (explainer?.lossless === false) score += 0.4
  if (claim.requires_cuda || claim.requires_multi_gpu || claim.requires_training) score += 1
  return score <= 0.8 ? 'low' : score <= 1.7 ? 'medium' : 'high'
}

export type HardwareFit = 'same' | 'different' | 'unknown'

const APPLE = /\b(apple|mps|metal|mlx|m[1-5](\s?(pro|max|ultra))?)\b/i
const NVIDIA = /\b(nvidia|cuda|triton|h100|h200|a100|a10g?|l4|l40s?|rtx|a6000|v100|t4|gb200|b200|amd|mi300x?|tpu)\b/i

/** Does the paper's hardware match the project's? (Apple silicon vs datacenter GPUs, by keywords.) */
export function compareHardware(paperHardware: string | null | undefined, projectHardware: Record<string, unknown> | null | undefined): HardwareFit {
  const text = (paperHardware || '').trim()
  if (!text || /unspecified|not reported|unknown/i.test(text)) return 'unknown'
  const project = Object.values(projectHardware ?? {}).map(String).join(' ')
  const projectApple = APPLE.test(project)
  const projectCuda = projectHardware?.cuda === true || NVIDIA.test(project)
  const paperApple = APPLE.test(text)
  const paperGpu = NVIDIA.test(text)
  if ((paperApple && projectApple) || (paperGpu && projectCuda)) return 'same'
  if ((paperGpu && projectApple && !projectCuda) || (paperApple && !projectApple)) return 'different'
  return 'unknown'
}
