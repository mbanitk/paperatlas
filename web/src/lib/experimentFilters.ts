/**
 * Experiment list filters: what the URL holds, what `GET /lab/experiments/search` gets, and the active-filter
 * chips. Every filter lives in the URL so a filtered view can be bookmarked or shared (docs/ux-review.md R-5).
 * Unit-tested in experimentFilters.test.ts.
 */
import type { ExperimentSearchParams } from '../api/client'
import type { AdoptionVerdict, ExperimentStatus, VerdictName } from '../api/types'
import { formatAcronyms, formatSigned, humanize } from './format'
import { ADOPTION, CLAIM_CHECK, EXPERIMENT_STATUS, VOCAB, sentenceCase } from './semantics'

export type ExperimentTab = 'needs_you' | 'active' | 'all'
export type ChangeDirection = 'gain' | 'loss'
export type ChangeCheck = 'claim' | 'adoption'

export const EXPERIMENT_TABS: readonly ExperimentTab[] = ['needs_you', 'active', 'all']
export const TAB_LABEL: Record<ExperimentTab, string> = { needs_you: VOCAB.needsYou, active: 'Active', all: 'All' }

/** Pipeline order (lab/service.py ALL_STATUSES): in progress first, then finished. */
export const STATUS_ORDER: readonly ExperimentStatus[] = [
  'blocked',
  'queued',
  'planning',
  'awaiting_approval',
  'approving',
  'building',
  'smoke_testing',
  'tuning',
  'waiting_gpu',
  'running',
  'judging',
  'awaiting_decision',
  'finalizing',
  'cancelling',
  'merged',
  'dropped',
  'rejected',
  'failed',
  'cancelled',
]
export const VERDICT_ORDER = Object.keys(CLAIM_CHECK) as VerdictName[]
export const ADOPTION_ORDER = Object.keys(ADOPTION) as AdoptionVerdict[]

export interface ExperimentFilters {
  /** Words in the title, technique, paper or flag; `#12` = experiment or claim 12. */
  q: string
  status: ExperimentStatus[]
  /** Claim check outcomes. */
  verdict: VerdictName[]
  /** Adoption check outcomes (only experiments where it ran separately have one). */
  adoption: AdoptionVerdict[]
  category: string[]
  /** Measured change: gains (> 0) or losses (< 0) only. */
  change: ChangeDirection | null
  /** Minimum size of the measured change in %: with `change`, at least +x% / −x%; alone, x% either way. */
  minChange: number | null
  /** Whose measured change: the claim check (default) or the adoption check. */
  changeOf: ChangeCheck
}

export const EMPTY_FILTERS: ExperimentFilters = { q: '', status: [], verdict: [], adoption: [], category: [], change: null, minChange: null, changeOf: 'claim' }

/** URL keys owned by the filters (plus `offset` for the page, reset whenever a filter changes). */
export const FILTER_PARAMS = ['q', 'status', 'verdict', 'adoption', 'category', 'change', 'min_change', 'change_of'] as const

const listParam = (params: URLSearchParams, key: string): string[] => [
  ...new Set(
    params
      .getAll(key)
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean),
  ),
]
const known = <T extends string>(values: string[], allowed: readonly T[]): T[] => values.filter((value): value is T => (allowed as readonly string[]).includes(value))

/** Filters from the URL; unknown values (an old or hand-edited link) are dropped rather than sent. */
export function parseFilters(params: URLSearchParams): ExperimentFilters {
  const change = params.get('change')
  const min = Number.parseFloat(params.get('min_change') ?? '')
  return {
    q: (params.get('q') ?? '').trim(),
    status: known(listParam(params, 'status'), STATUS_ORDER),
    verdict: known(listParam(params, 'verdict'), VERDICT_ORDER),
    adoption: known(listParam(params, 'adoption'), ADOPTION_ORDER),
    category: listParam(params, 'category'),
    change: change === 'gain' || change === 'loss' ? change : null,
    minChange: Number.isFinite(min) && min >= 0 ? min : null,
    changeOf: params.get('change_of') === 'adoption' ? 'adoption' : 'claim',
  }
}

export function parseTab(params: URLSearchParams): ExperimentTab {
  const tab = params.get('tab')
  return (EXPERIMENT_TABS as readonly string[]).includes(tab ?? '') ? (tab as ExperimentTab) : 'needs_you'
}

const hasChange = (filters: ExperimentFilters) => filters.change !== null || filters.minChange !== null

/** The URL with these filters (other keys kept); back to the first page. */
export function writeFilters(current: URLSearchParams, filters: ExperimentFilters): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const key of [...FILTER_PARAMS, 'offset']) next.delete(key)
  if (filters.q.trim()) next.set('q', filters.q.trim())
  for (const key of ['status', 'verdict', 'adoption', 'category'] as const) if (filters[key].length) next.set(key, filters[key].join(','))
  if (filters.change) next.set('change', filters.change)
  if (filters.minChange !== null) next.set('min_change', String(filters.minChange))
  if (filters.changeOf === 'adoption') next.set('change_of', 'adoption')
  return next
}

/** Query for `GET /lab/experiments/search`. */
export function searchParams(filters: ExperimentFilters, tab: ExperimentTab, page: { project_id?: number; limit: number; offset: number }): ExperimentSearchParams {
  const join = (values: string[]) => (values.length ? values.join(',') : undefined)
  return {
    project_id: page.project_id,
    scope: tab,
    q: filters.q || undefined,
    status: join(filters.status),
    verdict: join(filters.verdict),
    adoption: join(filters.adoption),
    category: join(filters.category),
    change: filters.change ?? undefined,
    min_change: filters.minChange ?? undefined,
    change_of: hasChange(filters) ? filters.changeOf : undefined,
    limit: page.limit,
    offset: page.offset,
  }
}

export const categoryLabel = (category: string) => sentenceCase(formatAcronyms(humanize(category)))
export const statusLabel = (status: string) => EXPERIMENT_STATUS[status as ExperimentStatus]?.label ?? sentenceCase(humanize(status))
export const verdictLabel = (verdict: string) => CLAIM_CHECK[verdict as VerdictName]?.label ?? sentenceCase(humanize(verdict))
export const adoptionLabel = (verdict: string) => ADOPTION[verdict as AdoptionVerdict]?.label ?? sentenceCase(humanize(verdict))
export const checkLabel = (check: ChangeCheck) => (check === 'adoption' ? VOCAB.adoptionCheck : VOCAB.claimCheck)

/** "gains only", "losses of −5% or more", "5% or more either way"; null without a measured-change filter. */
export function changePhrase(filters: Pick<ExperimentFilters, 'change' | 'minChange'>): string | null {
  const min = filters.minChange
  if (filters.change === 'gain') return min ? `gains of ${formatSigned(min)} or more` : 'gains only'
  if (filters.change === 'loss') return min ? `losses of ${formatSigned(-min)} or more` : 'losses only'
  return min !== null ? `${formatSigned(min).replace('+', '')} or more either way` : null
}

export interface FilterChip {
  key: string
  label: string
  /** The filters with this one removed. */
  without: ExperimentFilters
}

/** One removable chip per selected value (search stays in its box and isn't repeated here). */
export function filterChips(filters: ExperimentFilters): FilterChip[] {
  const chips: FilterChip[] = []
  const each = <K extends 'status' | 'verdict' | 'adoption' | 'category'>(key: K, prefix: string, label: (value: string) => string) => {
    for (const value of filters[key] as string[]) {
      chips.push({ key: `${key}:${value}`, label: `${prefix}: ${label(value)}`, without: { ...filters, [key]: (filters[key] as string[]).filter((item) => item !== value) } })
    }
  }
  each('status', 'Status', statusLabel)
  each('verdict', VOCAB.claimCheck, verdictLabel)
  each('adoption', VOCAB.adoptionCheck, adoptionLabel)
  each('category', 'Category', categoryLabel)
  const phrase = changePhrase(filters)
  if (phrase) {
    chips.push({
      key: 'change',
      label: `Measured change: ${phrase} (${checkLabel(filters.changeOf).toLowerCase()})`,
      without: { ...filters, change: null, minChange: null, changeOf: 'claim' },
    })
  }
  return chips
}

/** Any filter, including the search. */
export const hasActiveFilters = (filters: ExperimentFilters) => !!filters.q || filterChips(filters).length > 0

/** Toggle one value of a multi-value filter. */
export function toggleValue<K extends 'status' | 'verdict' | 'adoption' | 'category'>(filters: ExperimentFilters, key: K, value: ExperimentFilters[K][number]): ExperimentFilters {
  const values = filters[key] as string[]
  return { ...filters, [key]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value] }
}
