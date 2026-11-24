/**
 * Plain-language helpers for the Overview page (docs/ux-review.md §4.2): the answer line, honest outcome
 * counts, decision counts, "what's happening now" summaries of raw lab events, and plain failure reasons.
 * Unit-tested in overview.test.ts.
 */

import type { ExperimentStatus, ExperimentSummary, LabEvent, Stats, VerdictName } from '../api/types'
import { formatDuration, pluralize, sanitizeText } from './format'
import { adoptionSemantics, claimCheckSemantics, EXPERIMENT_STATUS, GATE, type SemanticIconName, type SemanticTone } from './semantics'
import { needsYou } from './stages'

// ---- outcomes (claim checks) ---------------------------------------------------------------------

/** Every claim-check outcome, best to worst, so summaries never hide the negatives. */
export const OUTCOME_ORDER: VerdictName[] = ['reproduced', 'partial', 'not_reproduced', 'regression', 'inconclusive']

/** Lower-case words for counts in a sentence ("2 partly", "2 worse"). */
const OUTCOME_WORDS: Record<string, string> = {
  reproduced: 'reproduced',
  partial: 'partly reproduced',
  not_reproduced: 'not reproduced',
  regression: 'worse than baseline',
  inconclusive: 'inconclusive',
}

export interface OutcomeSlice {
  verdict: string
  label: string
  tone: SemanticTone
  icon: SemanticIconName
  count: number
}

export interface OutcomeBreakdown {
  /** All five outcomes (zeros included), then any unknown verdict the API sends. Counts sum to `total`. */
  slices: OutcomeSlice[]
  total: number
  reproduced: number
  /** "9 results: 1 reproduced, 2 partly reproduced, 4 not reproduced, 2 worse than baseline" */
  sentence: string
}

export function outcomeBreakdown(verdicts: Partial<Record<string, number>> | null | undefined): OutcomeBreakdown {
  const counts = verdicts ?? {}
  const known = OUTCOME_ORDER.map((verdict) => slice(verdict, counts[verdict]))
  const extra = Object.keys(counts)
    .filter((verdict) => !OUTCOME_ORDER.includes(verdict as VerdictName) && (counts[verdict] ?? 0) > 0)
    .map((verdict) => slice(verdict, counts[verdict]))
  const slices = [...known, ...extra]
  const total = slices.reduce((sum, item) => sum + item.count, 0)
  const parts = slices.filter((item) => item.count > 0).map((item) => `${item.count} ${OUTCOME_WORDS[item.verdict] ?? lowerFirst(item.label)}`)
  const sentence = total ? `${pluralize(total, 'result')}: ${parts.join(', ')}` : 'No results yet'
  return { slices, total, reproduced: counts.reproduced ?? 0, sentence }
}

function slice(verdict: string, count: number | undefined): OutcomeSlice {
  const info = claimCheckSemantics(verdict)
  return { verdict, label: info.label, tone: info.tone, icon: info.icon, count: Math.max(0, count ?? 0) }
}

// ---- counts and the answer line ----------------------------------------------------------------------

/** Statuses where the lab is working (or waiting to work) on an experiment, not waiting for you. */
export const IN_PROGRESS_STATUSES: ExperimentStatus[] = (Object.keys(EXPERIMENT_STATUS) as ExperimentStatus[]).filter(
  (status) => EXPERIMENT_STATUS[status].tone === 'info' || ['queued', 'waiting_gpu', 'blocked', 'cancelling'].includes(status),
)

export interface DecisionCounts {
  /** Gate 1: research scans with a shortlist to pick from. */
  pick: number
  /** Gate 2: test plans to approve. */
  approve: number
  /** Gate 3: results to merge or drop. */
  merge: number
  total: number
}

export function decisionCounts(experiments: Partial<Record<string, number>> | null | undefined, picks = 0): DecisionCounts {
  const approve = experiments?.awaiting_approval ?? 0
  const merge = experiments?.awaiting_decision ?? 0
  return { pick: picks, approve, merge, total: picks + approve + merge }
}

/** "9 to merge or drop · 1 plan to approve · 1 scan to pick from" (zeros left out). */
export function decisionBreakdown(counts: DecisionCounts): string {
  const parts = [
    counts.merge && `${counts.merge} to merge or drop`,
    counts.approve && `${pluralize(counts.approve, 'test plan')} to approve`,
    counts.pick && `${pluralize(counts.pick, 'research scan')} to pick from`,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Nothing waiting'
}

export interface ProgressCounts {
  inProgress: number
  failed: number
  /** "2 building · 1 running A/B test", most common first. */
  breakdown: string
}

export function progressCounts(experiments: Partial<Record<string, number>> | null | undefined): ProgressCounts {
  const counts = experiments ?? {}
  const active = IN_PROGRESS_STATUSES.map((status) => ({ status, count: counts[status] ?? 0 })).filter((item) => item.count > 0)
  active.sort((a, b) => b.count - a.count)
  return {
    inProgress: active.reduce((sum, item) => sum + item.count, 0),
    failed: counts.failed ?? 0,
    breakdown: active.length ? active.map((item) => `${item.count} ${lowerFirst(EXPERIMENT_STATUS[item.status].label)}`).join(' · ') : 'Nothing running',
  }
}

export interface AnswerPart {
  text: string
  /** Where the part links to. */
  to?: string
  /** The part that needs the reader (bold). */
  emphasis?: boolean
  tone?: SemanticTone
}

/**
 * The Overview's one-line state of the world (O-1): "9 decisions are waiting for you · 3 experiments in
 * progress · 1 of 9 tested claims reproduced so far · 3 failed".
 */
export function overviewAnswer(stats: Pick<Stats, 'experiments' | 'verdicts'> | null | undefined, picks = 0): AnswerPart[] {
  const decisions = decisionCounts(stats?.experiments, picks)
  const progress = progressCounts(stats?.experiments)
  const outcomes = outcomeBreakdown(stats?.verdicts)
  const parts: AnswerPart[] = [
    decisions.total
      ? {
          text: `${pluralize(decisions.total, 'decision')} ${decisions.total === 1 ? 'is' : 'are'} waiting for you`,
          to: '#needs-you',
          emphasis: true,
          tone: 'caution',
        }
      : { text: 'Nothing is waiting for you' },
    { text: progress.inProgress ? `${pluralize(progress.inProgress, 'experiment')} in progress` : 'no experiments running' },
    {
      text: outcomes.total ? `${outcomes.reproduced} of ${pluralize(outcomes.total, 'tested claim')} reproduced so far` : 'no claims tested yet',
    },
  ]
  if (progress.failed) parts.push({ text: `${progress.failed} failed`, tone: 'negative', to: '#recent-results' })
  return parts
}

// ---- gate rows ------------------------------------------------------------------------------------------

export interface GateCopy {
  /** "Decide: merge or drop" */
  ask: string
  short: string
}

export function gateCopy(status: ExperimentStatus | string): GateCopy {
  if (status === 'awaiting_approval') return { ask: GATE.approve_spec.label, short: GATE.approve_spec.short }
  if (status === 'awaiting_decision') return { ask: GATE.merge.label, short: GATE.merge.short }
  return { ask: GATE.pick.label, short: GATE.pick.short }
}

/** Experiments waiting for a decision, Gate 2 (approve the plan, it blocks the build) before Gate 3, newest first within a gate. */
export function sortGates(experiments: readonly ExperimentSummary[]): ExperimentSummary[] {
  const rank = (status: string) => (status === 'awaiting_approval' ? 0 : 1)
  return experiments
    .filter((experiment) => needsYou(experiment.status))
    .slice()
    .sort((a, b) => rank(a.status) - rank(b.status) || time(b.updated_at) - time(a.updated_at) || b.id - a.id)
}

/** One-line evidence for a Gate 3 row: "Claim: Partly reproduced +2.8% · Here: Worse than default −63.1%". */
export function outcomeLine(verdict: string | null | undefined, adoption: string | null | undefined): string {
  const parts = []
  if (verdict) parts.push(`Claim check: ${claimCheckSemantics(verdict).label}`)
  if (adoption) parts.push(`Your default workload: ${adoptionSemantics(adoption).label}`)
  return parts.join(' · ')
}

/** Finished experiments worth reporting (failed, merged, dropped…), newest first. */
export function recentFinished(experiments: readonly ExperimentSummary[], limit = 5): ExperimentSummary[] {
  const finished: ExperimentStatus[] = ['failed', 'merged', 'dropped', 'rejected', 'cancelled']
  return experiments
    .filter((experiment) => finished.includes(experiment.status))
    .slice()
    .sort((a, b) => time(b.updated_at) - time(a.updated_at) || b.id - a.id)
    .slice(0, limit)
}

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0)

/** "Running A/B test" → "running A/B test"; acronyms ("GPU") keep their case. */
export const lowerFirst = (text: string) => (text && !/^[A-Z]{2}/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text)

// ---- failures ---------------------------------------------------------------------------------------------

export interface PlainFailure {
  /** "Smoke test failed" */
  headline: string
  /** The one line that explains it: "ValueError: batch_limit=64 is infeasible…", "Timed out after 30 min". */
  reason: string | null
}

const FAILED_STEP: [RegExp, string][] = [
  [/\bsmoke/i, 'Smoke test failed'],
  [/\bbuild|\bcompil|\bimplement/i, 'Build failed'],
  [/\btun(e|ing)\b/i, 'Tuning failed'],
  [/\bjudg/i, 'Judging failed'],
  [/\bplan|\bspec\b/i, 'Planning failed'],
  [/\bbench|\brun\b|\beval/i, 'A/B test failed'],
]

const EXCEPTION_LINE = /^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Failure|Timeout))\b:?\s*(.*)$/

/**
 * A raw error (often a whole traceback) → a headline and the one line that explains it. The raw text stays
 * available behind a "Show error output" disclosure; this is what people read first.
 */
export function plainFailure(error: string | null | undefined): PlainFailure {
  const text = (error ?? '').trim()
  if (!text) return { headline: 'Failed', reason: null }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const first = lines[0] ?? ''
  const headline = FAILED_STEP.find(([pattern]) => pattern.test(first))?.[1] ?? 'Failed'

  const timeout = text.match(/\[timeout after (\d+(?:\.\d+)?)\s*s\]/i)
  if (timeout) return { headline, reason: `Timed out after ${timeLabel(Number(timeout[1]))}` }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(EXCEPTION_LINE)
    if (match && !/^Traceback\b/.test(lines[index])) {
      const name = match[1].split('.').pop() as string
      return { headline, reason: clip(cleanMessage(match[2] ? `${name}: ${match[2]}` : name)) }
    }
  }
  const message = first.replace(/^[a-z_]+:\s+/i, '').replace(/:$/, '')
  return { headline, reason: message ? clip(cleanMessage(message)) : null }
}

function cleanMessage(message: string): string {
  return sanitizeText(message.replace(/b'\{"error":\s*"([^"]+)"\}'/g, '“$1”').replace(/b'([^']*)'/g, '$1'))
}

function timeLabel(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0 && seconds < 3600) return `${seconds / 60} min`
  return formatDuration(seconds)
}

const clip = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

// ---- what's happening now -------------------------------------------------------------------------------

const BENCH_ROUND = /^\[bench\] round (\d+) (baseline|variant)\b/i
const PHASE_START = /^(Claim check|Adoption check|Smoke A\/B|Tuning \((\d+)\/(\d+)[^)]*\)):\s*(\d+) rounds? per arm(?:,\s*workload\s+(.+))?/i

/**
 * One plain sentence for a raw lab event (bench lines, coding-agent output, tracebacks). The raw message stays
 * available to experts behind a disclosure.
 */
export function summarizeEvent(event: Pick<LabEvent, 'message' | 'stage' | 'level'>): string {
  const message = (event.message ?? '').trim()
  const firstLine = message.split('\n')[0]?.trim() ?? ''
  let match: RegExpMatchArray | null

  if (event.level === 'error' || /^\w+ failed:/i.test(firstLine)) {
    const failure = plainFailure(message.replace(/^\w+ failed:\s*/i, `${event.stage}: `))
    return failure.reason ? `${failure.headline}: ${failure.reason}` : failure.headline
  }
  if ((match = firstLine.match(BENCH_ROUND))) {
    const phase = event.stage === 'tune' ? 'Tuning run' : event.stage === 'smoke' ? 'Smoke test' : 'A/B test'
    return `${phase}: measured round ${Number(match[1]) + 1} (${match[2].toLowerCase()} arm)`
  }
  if ((match = firstLine.match(/^\[bench\] started server for arm (\w+)/i))) return `Starting the ${match[1].toLowerCase()} server`
  if ((match = firstLine.match(/^\[bench\] quality (\w+)/i))) return `Checking output quality (${match[1].toLowerCase()} arm)`
  if ((match = firstLine.match(PHASE_START))) {
    const rounds = pluralize(Number(match[4]), 'round')
    const workload = match[5] ? (/paper/i.test(match[5]) ? ' on the paper’s workload' : ` on ${match[5].trim()}`) : ''
    if (/^Claim check/i.test(match[1])) return `Claim check started: ${rounds} per arm${workload}`
    if (/^Adoption check/i.test(match[1])) return `Adoption check started: ${rounds} per arm${workload}`
    if (/^Smoke/i.test(match[1])) return `Smoke test on the small model: ${rounds} per arm`
    return `Tuning: trying setting ${match[2]} of ${match[3]}`
  }
  if ((match = firstLine.match(/^Config (\d+)\/(\d+)\b/i))) return `Tuning: setting ${match[1]} of ${match[2]} measured`
  if (/^Tuned:/i.test(firstLine)) return 'Tuning finished: best settings chosen'
  if ((match = firstLine.match(/^copilot is implementing .*?\(attempt (\d+)\/(\d+)\)/i))) return `Coding agent is implementing the change (attempt ${match[1]} of ${match[2]})`
  if ((match = firstLine.match(/^copilot:\s*still running \((\d+)s elapsed\)/i))) return `Coding agent at work (${formatDuration(Number(match[1]))} so far)`
  if (/^copilot:/i.test(firstLine)) return 'Coding agent at work'
  if (/^Worktree ready/i.test(firstLine)) return 'Working copy ready on a new branch'
  if ((match = firstLine.match(/^Verdict:\s*(\w+)/i))) {
    const adoption = firstLine.match(/Adoption:\s*(\w+)/i)
    const parts = [`Result: ${lowerFirst(claimCheckSemantics(match[1]).label)}`]
    if (adoption) parts.push(`on your default workload: ${lowerFirst(adoptionSemantics(adoption[1]).label)}`)
    return `${parts.join('; ')}. Waiting for your decision`
  }
  if (/^Spec ready/i.test(firstLine)) return 'Test plan ready: waiting for your approval'
  if (/^Spec approved/i.test(firstLine)) return 'Test plan approved'
  if (/^Gate 2: approve requested/i.test(firstLine)) return 'Approval received'
  if (/^Writing the experiment spec/i.test(firstLine)) return 'Writing the test plan'
  if (/^Experiment created/i.test(firstLine)) return 'Experiment created from a picked claim'
  return clip(sanitizeText(firstLine), 140)
}

export interface ExperimentProgress {
  /** "Claim check", "Adoption check", "Smoke test", "Tuning 2 of 3" */
  phase: string | null
  /** Rounds measured so far in this phase. */
  done: number | null
  /** Rounds in this phase (both arms). */
  total: number | null
  /** Rough time left in this phase, from the pace so far. */
  etaSeconds: number | null
}

/**
 * Progress of the phase an experiment is in, from its events (any order): "Claim check · round 8 of 20 ·
 * about 6 min left". Fields are null when the events don't say.
 */
export function experimentProgress(events: readonly Pick<LabEvent, 'id' | 'message' | 'created_at'>[]): ExperimentProgress {
  const ordered = [...events].sort((a, b) => a.id - b.id)
  let startIndex = -1
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (PHASE_START.test(ordered[index].message ?? '')) {
      startIndex = index
      break
    }
  }
  const rounds = (from: number) =>
    ordered
      .slice(from + 1)
      .map((event) => ({ event, match: (event.message ?? '').match(BENCH_ROUND) }))
      .filter((item): item is { event: (typeof ordered)[number]; match: RegExpMatchArray } => !!item.match)

  if (startIndex < 0) {
    const seen = rounds(-1)
    if (!seen.length) return { phase: null, done: null, total: null, etaSeconds: null }
    return { phase: null, done: Math.max(...seen.map((item) => Number(item.match[1]))) + 1, total: null, etaSeconds: null }
  }

  const start = ordered[startIndex]
  const head = (start.message ?? '').match(PHASE_START) as RegExpMatchArray
  const phase = /^Claim/i.test(head[1])
    ? 'Claim check'
    : /^Adoption/i.test(head[1])
      ? 'Adoption check'
      : /^Smoke/i.test(head[1])
        ? 'Smoke test'
        : `Tuning ${head[2]} of ${head[3]}`
  const total = Number(head[4]) * 2
  const seen = rounds(startIndex)
  if (!seen.length) return { phase, done: 0, total, etaSeconds: null }
  const done = Math.min(total, Math.max(...seen.map((item) => Number(item.match[1]))) + 1)
  const last = seen[seen.length - 1].event
  const elapsed = (time(last.created_at) - time(start.created_at)) / 1000
  const etaSeconds = done > 0 && done < total && elapsed > 0 ? Math.round((elapsed / done) * (total - done)) : null
  return { phase, done, total, etaSeconds }
}

/** "about 6 min left" / "under a minute left". */
export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null
  if (seconds < 60) return 'under a minute left'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `about ${minutes} min left`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `about ${hours} h${rest ? ` ${rest} min` : ''} left`
}

/** "Claim check · round 8 of 20 · about 6 min left" (only the parts that are known). */
export function progressLine(progress: ExperimentProgress): string | null {
  const parts = [
    progress.phase,
    progress.done !== null && progress.done > 0 ? (progress.total ? `round ${progress.done} of ${progress.total}` : `round ${progress.done}`) : null,
    formatEta(progress.etaSeconds),
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}
