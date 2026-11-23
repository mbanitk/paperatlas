import type { Claim, ClaimExplainer } from '../api/types'
import { formatNumber } from './format'

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
  return { kind: 'none', text: 'not quantified', metric: null, summary }
}

export type Level = 'low' | 'medium' | 'high'

export const EFFORT_LEVEL: Record<string, number> = { low: 1, medium: 2, high: 3 }

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
