import type { Claim, ClaimExplainer, ClaimTheme, ComparisonAspect } from '../api/types'
import { claimedEffectView, effectText } from './claims'
import { humanize, humanizeMetric, isMissing, sanitizeText } from './format'

/** Placeholder words LLM explainers use when the paper has no number ("not reported", "n/a"…). */
const NO_NUMBER = /^(?:not\s+(?:reported|quantified|stated|given|specified|available)|n\/?a|none|unknown|unspecified|—|-)\.?$/i

/** True when a reported value is missing or only a placeholder such as "not reported". */
export function isUnreported(value: string | null | undefined): boolean {
  return isMissing(value) || NO_NUMBER.test((value ?? '').trim())
}

/**
 * A number as the paper reports it, cleaned for the plain layer: `1.96x–3.12x` → `1.96× to 3.12×`,
 * `32.2–79.1% lower` → `32.2 to 79.1% lower`, `4^{-b}` → `4⁻ᵇ`. Returns null for placeholders ("not reported").
 */
export function formatReportedValue(value: string | null | undefined): string | null {
  if (isUnreported(value)) return null
  let text = sanitizeText(value)
  text = text.replace(/(\d)\s?[xX](?![A-Za-z0-9])/g, '$1×')
  text = text.replace(/(?<![\w.\-])(\d[\d.,]*[×%]?)\s*[–—-]\s*([+−-]?\d)/g, '$1 to $2')
  return text || null
}

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
  const value = formatReportedValue(headline?.value)
  if (headline && value) {
    const direction: HeroDirection = headline.direction === 'up' || headline.direction === 'down' ? headline.direction : 'none'
    return {
      value,
      direction,
      metric: sanitizeText(headline.metric) || null,
      versus: sanitizeText(headline.versus).replace(/^vs\.?\s+/i, '') || null,
      source: 'explainer',
    }
  }
  const view = claimedEffectView(claim, explainer)
  if (view.kind !== 'gain') return null
  return {
    value: effectText(view, claim.direction),
    direction: claim.direction === 'decrease' ? 'down' : 'up',
    metric: view.metric ? humanizeMetric(view.metric) : null,
    versus: null,
    source: 'claim',
  }
}

/**
 * The number shown under "Paper reports": the headline result when there is one, else an absolute value
 * the paper reports (shown neutrally, no direction), else null ("Paper gives no number").
 */
export function paperReport(
  claim: Pick<Claim, 'claimed_gain_pct' | 'claimed_value' | 'claimed_unit' | 'direction' | 'primary_metric'>,
  explainer?: ClaimExplainer | null,
): HeroResult | null {
  const hero = heroResult(claim, explainer)
  if (hero) return hero
  const view = claimedEffectView(claim, explainer)
  if (view.kind !== 'neutral') return null
  return { value: view.text, direction: 'none', metric: view.metric ? humanizeMetric(view.metric) : null, versus: null, source: 'claim' }
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
