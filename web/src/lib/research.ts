/**
 * Plain-language helpers for the research pages (topics, papers): readable topic names, the one-sentence
 * answers each page leads with, the paper's claimed numbers and what has been tested here.
 */
import type { Claim, ExperimentSummary, Recommendation, Topic, TopicInsights } from '../api/types'
import { claimedEffectView } from './claims'
import { formatAcronyms, formatNumber, pluralize, sanitizeText } from './format'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-11" → "Nov". */
export const monthLabel = (key: string) => MONTHS[Number(key.slice(5, 7)) - 1] ?? key

const capitalise = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text)

// ---- topic names ---------------------------------------------------------------------------------------

/** Keywords too generic to tell two topics apart. */
const GENERIC = new Set([
  'model', 'models', 'llm', 'llms', 'inference', 'times', 'low', 'high', 'token', 'tokens', 'learning', 'task', 'tasks', 'based', 'efficient',
  'large', 'language', 'new', 'method', 'methods', 'approach', 'paper', 'papers', 'using', 'via', 'data', 'bit', 'bits', 'system', 'systems',
])

type TopicNameInput = Pick<Topic, 'slug' | 'name' | 'keywords'> & { rank?: number | null; explainer?: Topic['explainer'] }

/**
 * The topic's own phrase: the explainer's title when there is one, otherwise the multi-word keyword that
 * contains the cluster name ("decoding" → "Speculative decoding"), with acronyms fixed ("Kv" → "KV").
 */
export function topicPhrase(topic: TopicNameInput): string {
  const title = (topic.explainer as { title?: string } | null | undefined)?.title?.trim()
  if (title) return title
  const name = topic.name.trim()
  const lower = name.toLowerCase()
  const phrase = (topic.keywords ?? []).find((keyword) => /\s/.test(keyword.trim()) && keyword.toLowerCase().split(/\s+/).includes(lower))
  return capitalise(formatAcronyms((phrase ?? name).toLowerCase()))
}

/**
 * Readable, unique names for a list of topics (T-1). Topics that would share a name get their most
 * distinctive keyword in brackets ("KV cache (quantization)", "KV cache (eviction)"), and numbers as a last
 * resort.
 */
export function topicDisplayNames(topics: TopicNameInput[]): Map<string, string> {
  const sorted = [...topics].sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
  const base = new Map(sorted.map((topic) => [topic.slug, topicPhrase(topic)]))
  const groups = new Map<string, TopicNameInput[]>()
  for (const topic of sorted) {
    const key = base.get(topic.slug)!.toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), topic])
  }
  const names = new Map<string, string>()
  for (const [key, group] of groups) {
    if (group.length === 1) {
      names.set(group[0].slug, base.get(group[0].slug)!)
      continue
    }
    const baseWords = new Set(key.split(/\s+/))
    const used = new Set<string>()
    group.forEach((topic, index) => {
      const phrase = base.get(topic.slug)!
      const qualifier = (topic.keywords ?? [])
        .map((keyword) => keyword.trim().toLowerCase())
        .find((keyword) => keyword && !GENERIC.has(keyword) && !keyword.split(/\s+/).some((word) => baseWords.has(word)) && !used.has(keyword))
      if (qualifier) {
        used.add(qualifier)
        names.set(topic.slug, `${phrase} (${formatAcronyms(qualifier)})`)
      } else names.set(topic.slug, index === 0 ? phrase : `${phrase} (${index + 1})`)
    })
  }
  // A qualifier can still collide in rare cases: number whatever is left over.
  const seen = new Map<string, number>()
  for (const topic of sorted) {
    const name = names.get(topic.slug)!
    const count = (seen.get(name.toLowerCase()) ?? 0) + 1
    seen.set(name.toLowerCase(), count)
    if (count > 1) names.set(topic.slug, `${name} (${count})`)
  }
  return names
}

/** Display name of one topic, using the others to keep names unique. */
export function displayTopicName(topic: TopicNameInput, all: TopicNameInput[] = [topic]): string {
  return topicDisplayNames(all.some((item) => item.slug === topic.slug) ? all : [...all, topic]).get(topic.slug) ?? topicPhrase(topic)
}

/** The scanner's placeholder description ("Recent work in 'X' about a, b, c."), which says nothing new. */
export function isAutoDescription(text: string | null | undefined): boolean {
  return !!text && /^recent work in ['‘"].+['’"] about /i.test(text.trim())
}

/** One plain sentence about the topic, or null when there is only the placeholder text. */
export function topicSummary(topic: Pick<Topic, 'description' | 'explainer'>): string | null {
  const summary = topic.explainer?.summary?.trim()
  if (summary) return summary
  const description = topic.description?.trim()
  return description && !isAutoDescription(description) ? description : null
}

// ---- momentum ------------------------------------------------------------------------------------------

export interface Momentum {
  latest: { month: string; papers: number } | null
  previous: { month: string; papers: number } | null
  change: number
  direction: 'up' | 'down' | 'flat'
  /** The latest month is the current calendar month (still filling up). */
  partial: boolean
}

const monthKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

/** Papers in the latest month compared with the month before. */
export function monthlyMomentum(monthly: TopicInsights['monthly'] | null | undefined, now: Date = new Date()): Momentum {
  const months = [...(monthly ?? [])].sort((a, b) => a.month.localeCompare(b.month))
  const latest = months[months.length - 1] ?? null
  const previous = months[months.length - 2] ?? null
  const change = latest && previous ? latest.papers - previous.papers : 0
  return {
    latest,
    previous,
    change,
    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    partial: !!latest && latest.month === monthKey(now),
  }
}

/** "16 papers so far in Nov (12 in Oct)" / "4 papers in Sep (none in Aug)". */
export function momentumText(momentum: Momentum): string | null {
  const { latest, previous, partial } = momentum
  if (!latest) return null
  const head = `${pluralize(latest.papers, 'paper')} ${partial ? 'so far in' : 'in'} ${monthLabel(latest.month)}`
  if (!previous) return head
  return `${head} (${previous.papers ? formatNumber(previous.papers, 0) : 'none'} in ${monthLabel(previous.month)})`
}

/** Testable claims across a topic's categories. */
export function testableClaims(insights: Pick<TopicInsights, 'claim_categories'> | null | undefined): { claims: number; testable: number } {
  return (insights?.claim_categories ?? []).reduce((sum, item) => ({ claims: sum.claims + item.claims, testable: sum.testable + item.testable }), { claims: 0, testable: 0 })
}

/** Why the topic ranks where it does, in plain words, from the trend signals. */
export function trendReasons(topic: Pick<Topic, 'stats' | 'insights'>): string[] {
  const stats = topic.stats ?? {}
  const reasons: string[] = []
  if (typeof stats.velocity === 'number') reasons.push(`${Math.round(stats.velocity * 100)}% of its papers are from the last 60 days`)
  const insights = topic.insights
  if (insights?.papers) reasons.push(`${Math.round((insights.with_code / insights.papers) * 100)}% come with code`)
  if (insights?.upvotes) reasons.push(`${formatNumber(insights.upvotes, 0)} Hugging Face upvotes`)
  if (insights?.citations) reasons.push(`${pluralize(insights.citations, 'citation')}`)
  return reasons
}

export interface TopicsAnswer {
  lead: Topic
  leadName: string
  leadMomentum: string | null
  leadTestable: number
  /** Topic with the most papers in the latest month, when it isn't the leader. */
  busiest: Topic | null
  busiestName: string | null
  busiestPapers: number
  seeds: number
}

/** The Topics page's bottom line: what leads, and what is growing fastest. */
export function topicsAnswer(topics: Topic[], names: Map<string, string>, now: Date = new Date()): TopicsAnswer | null {
  if (!topics.length) return null
  const ranked = [...topics].sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
  const lead = ranked[0]
  const latest = (topic: Topic) => monthlyMomentum(topic.insights?.monthly, now).latest?.papers ?? 0
  const busiest = ranked.reduce((best, topic) => (latest(topic) > latest(best) ? topic : best), lead)
  return {
    lead,
    leadName: names.get(lead.slug) ?? topicPhrase(lead),
    leadMomentum: momentumText(monthlyMomentum(lead.insights?.monthly, now)),
    leadTestable: testableClaims(lead.insights).testable,
    busiest: busiest === lead ? null : busiest,
    busiestName: busiest === lead ? null : (names.get(busiest.slug) ?? topicPhrase(busiest)),
    busiestPapers: latest(busiest),
    seeds: new Set(topics.map((topic) => topic.seed).filter(Boolean)).size,
  }
}

// ---- sources -------------------------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, string> = {
  arxiv: 'arXiv',
  semantic_scholar: 'Semantic Scholar',
  openalex: 'OpenAlex',
  hf_papers: 'Hugging Face Papers',
  patents: 'Patents',
  blogs: 'Blogs',
}

export const sourceLabel = (source: string) => SOURCE_LABELS[source] ?? capitalise(source.replace(/_/g, ' '))

/** Short label for a paper id (breadcrumbs): "arxiv:2610.07659" → "arXiv 2610.07659", "blog:3f…" → "Blog post". */
export function paperShortLabel(paperId: string, docType?: string | null): string {
  const [prefix, ...rest] = paperId.split(':')
  const id = rest.join(':')
  if (!id) return docType === 'patent' ? 'Patent' : 'Paper'
  switch (prefix.toLowerCase()) {
    case 'arxiv':
      return `arXiv ${id}`
    case 'doi':
      return `DOI ${id}`
    case 'blog':
      return 'Blog post'
    default:
      return docType === 'patent' ? 'Patent' : /^[\w.-]{1,24}$/.test(id) ? `${capitalise(prefix)} ${id}` : capitalise(prefix)
  }
}

// ---- numbers from papers -----------------------------------------------------------------------------------

/** A key-result value written plainly: "1.71x" → "1.71×", "5 to 41 percent" → "5 to 41%", ranges with "to". */
export function formatResultValue(value: string | null | undefined): string {
  if (!value) return ''
  return sanitizeText(value)
    .replace(/(\d)\s?[xX](?![A-Za-z])/g, '$1×')
    .replace(/(\d)\s?times\b/g, '$1×')
    .replace(/(\d)\s+percent\b/gi, '$1%')
}

export interface ClaimedFigure {
  /** "+41%", "4.76×", "1,070 tokens/s/GPU". */
  value: string
  /** What it measures, in the paper's words. */
  metric: string | null
}

/** The number the paper reports for a claim (reference register), or null when it gives none. */
export function claimedFigure(claim: Pick<Claim, 'claimed_gain_pct' | 'claimed_value' | 'claimed_unit' | 'direction' | 'primary_metric' | 'explainer'>): ClaimedFigure | null {
  const view = claimedEffectView(claim, claim.explainer)
  const metric = claim.primary_metric ? sanitizeText(claim.primary_metric) : null
  if (view.kind === 'none') return null
  if (view.kind === 'gain') {
    const ratio = view.text.endsWith('×')
    const value = ratio ? view.text.replace(/^[↑↓]/, '') : `${claim.direction === 'decrease' ? '−' : '+'}${view.text.replace(/^[↑↓]/, '')}`
    return { value, metric }
  }
  return { value: view.text, metric }
}

// ---- what has been tested here -----------------------------------------------------------------------------

/** Experiments per claim id (including claims bundled into another claim's experiment), newest first. */
export function experimentsByClaim(experiments: ExperimentSummary[] | null | undefined): Map<number, ExperimentSummary[]> {
  const map = new Map<number, ExperimentSummary[]>()
  for (const experiment of [...(experiments ?? [])].sort((a, b) => b.id - a.id)) {
    for (const id of new Set([experiment.claim_id, ...(experiment.bundle_claim_ids ?? [])])) map.set(id, [...(map.get(id) ?? []), experiment])
  }
  return map
}

/** Experiments per paper id, newest first. */
export function experimentsByPaper(experiments: ExperimentSummary[] | null | undefined): Map<string, ExperimentSummary[]> {
  const map = new Map<string, ExperimentSummary[]>()
  for (const experiment of [...(experiments ?? [])].sort((a, b) => b.id - a.id)) map.set(experiment.paper_id, [...(map.get(experiment.paper_id) ?? []), experiment])
  return map
}

export interface TestedSummary {
  count: number
  /** The newest experiment (shown as "Tested in #N"). */
  latest: ExperimentSummary | null
  /** Distinct claims tested. */
  claims: number
}

export function testedSummary(experiments: ExperimentSummary[] | null | undefined): TestedSummary {
  const list = [...(experiments ?? [])].sort((a, b) => b.id - a.id)
  return { count: list.length, latest: list[0] ?? null, claims: new Set(list.map((experiment) => experiment.claim_id)).size }
}

// ---- best claims in a topic -------------------------------------------------------------------------------------

export type RankedClaim = Claim & { recommendation?: Recommendation }

const TECHNIQUE_KINDS = new Set(['method', 'algorithm', 'system', 'technique', 'optimization', 'kernel'])

/**
 * How promising a claim is to test, before the project has ranked it: a technique you can build (not a
 * finding or a limitation), a relative gain the paper reports, a plain headline, and no special hardware.
 */
export function claimPromise(claim: Pick<Claim, 'kind' | 'claimed_gain_pct' | 'claimed_value' | 'claimed_unit' | 'direction' | 'primary_metric' | 'explainer' | 'requires_cuda' | 'requires_multi_gpu' | 'requires_training'>): number {
  const kind = (claim.kind ?? '').toLowerCase()
  let score = TECHNIQUE_KINDS.has(kind) ? 4 : kind === 'limitation' ? -4 : 0
  if (claim.claimed_gain_pct !== null && claim.claimed_gain_pct !== undefined) score += 2
  else if (claimedFigure(claim)) score += 1
  if (claim.explainer?.headline) score += 1
  if (claim.requires_cuda || claim.requires_multi_gpu || claim.requires_training) score -= 2
  return score
}

/**
 * The claims most worth testing in a topic: testable ones only, in the project's recommendation order when
 * they're ranked, then by `claimPromise`. At most `perPaper` per paper so one paper doesn't fill the list.
 */
export function bestClaims(claims: Claim[] | null | undefined, recommendations: Recommendation[] | null | undefined, limit = 3, perPaper = 1): RankedClaim[] {
  const recs = new Map((recommendations ?? []).map((rec) => [rec.id, rec]))
  const score = (claim: Claim) => {
    const rec = recs.get(claim.id)
    return rec ? 1_000_000 - rec.rank : claimPromise(claim)
  }
  const ranked = (claims ?? [])
    .filter((claim) => claim.testable)
    .map((claim) => ({ claim, score: score(claim) }))
    .sort((a, b) => b.score - a.score || b.claim.id - a.claim.id)
  const picked: RankedClaim[] = []
  const perPaperCount = new Map<string, number>()
  for (const pass of [perPaper, Number.MAX_SAFE_INTEGER]) {
    for (const { claim } of ranked) {
      if (picked.length >= limit) break
      if (picked.some((item) => item.id === claim.id)) continue
      const count = perPaperCount.get(claim.paper_id) ?? 0
      if (count >= pass) continue
      perPaperCount.set(claim.paper_id, count + 1)
      picked.push({ ...claim, recommendation: recs.get(claim.id) })
    }
  }
  return picked
}
