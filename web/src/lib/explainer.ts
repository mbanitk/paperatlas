import type { Claim, ClaimExplainer, ClaimTheme, ComparisonAspect } from '../api/types'
import { claimedEffectView } from './claims'
import { humanize } from './format'

/** True when the explainer carries the plain-language layer (primer, headline result, before/after…). */
export function isPlainLanguage(explainer: ClaimExplainer | null | undefined): boolean {
  return !!explainer && (explainer.version ?? 1) >= 2
}

export type HeroDirection = 'up' | 'down' | 'none'

export interface HeroResult {
  /** Big number, e.g. "+5 to 41%". */
  value: string
  direction: HeroDirection
  /** Plain words for what improves, e.g. "wall-clock decoding speedup". */
  metric: string | null
  /** What the paper compares against ("vs …"), when known. */
  versus: string | null
  /** v2 = the explainer's headline result; claim = derived from the claim card's relative gain. */
  source: 'explainer' | 'claim'
}

/**
 * The paper's main result for the hero tile. A v2 explainer's `headline_result` wins (it is the real claim,
 * not a side number). Otherwise only relative gains from the claim card qualify; absolute values such as
 * "0.14×" are not shown as a hero because they are often context numbers, not the technique's gain.
 */
export function heroResult(
  claim: Pick<Claim, 'claimed_gain_pct' | 'claimed_value' | 'claimed_unit' | 'direction' | 'primary_metric'>,
  explainer?: ClaimExplainer | null,
): HeroResult | null {
  const headline = isPlainLanguage(explainer) ? explainer?.headline_result : null
  if (headline?.value?.trim()) {
    const direction: HeroDirection = headline.direction === 'up' || headline.direction === 'down' ? headline.direction : 'none'
    return {
      value: headline.value.trim(),
      direction,
      metric: headline.metric?.trim() || null,
      versus: headline.versus?.trim().replace(/^vs\.?\s+/i, '') || null,
      source: 'explainer',
    }
  }
  const view = claimedEffectView(claim, explainer)
  if (view.kind !== 'gain') return null
  return {
    value: view.text.replace(/^[↑↓]/, claim.direction === 'decrease' ? '−' : '+'),
    direction: claim.direction === 'decrease' ? 'down' : 'up',
    metric: view.metric ? humanize(view.metric) : null,
    versus: null,
    source: 'claim',
  }
}

export const THEMES: ClaimTheme[] = ['speed', 'latency', 'throughput', 'memory', 'quality', 'cost', 'reliability']

export const THEME_LABEL: Record<ClaimTheme, string> = {
  speed: 'Faster generation',
  latency: 'Lower latency',
  throughput: 'More throughput',
  memory: 'Less memory',
  quality: 'Better quality',
  cost: 'Lower cost',
  reliability: 'More reliable',
}

/** Theme from the explainer, else guessed from the claim's metric and category. */
export function claimTheme(claim: Pick<Claim, 'primary_metric' | 'category'>, explainer?: ClaimExplainer | null): ClaimTheme {
  const theme = explainer?.theme
  if (theme && (THEMES as string[]).includes(theme)) return theme as ClaimTheme
  const text = `${claim.primary_metric ?? ''} ${claim.category ?? ''}`.toLowerCase()
  if (/memory|_gb|\bgb\b|footprint|kv_cache|quantiz/.test(text)) return 'memory'
  if (/latency|ttft|itl|\bms\b|time to first/.test(text)) return 'latency'
  if (/throughput|tokens?_per_s|tok\/s|requests|batching|schedul/.test(text)) return 'throughput'
  if (/accuracy|quality|perplexity|exact|evaluation/.test(text)) return 'quality'
  if (/cost|\$|price/.test(text)) return 'cost'
  if (/reliab|error|failure|observab/.test(text)) return 'reliability'
  return 'speed'
}

export const ASPECT_LABEL: Record<ComparisonAspect, string> = {
  hardware: 'Hardware',
  model: 'Model',
  runtime: 'Runtime',
  workload: 'Workload',
  baseline: 'Baseline',
  draft_model: 'Draft model',
  batch: 'Batch',
  context: 'Context',
  other: 'Other',
}

export function aspectLabel(aspect: string): string {
  return ASPECT_LABEL[aspect as ComparisonAspect] ?? humanize(aspect)
}
