/**
 * Plain-language helpers for queued jobs and service health (System page, JobStatus): one word and tone per
 * job status, a human name per job kind, a one-line result, and the System answer line. Unit-tested in
 * overviewJobs.test.ts.
 */

import type { Job } from '../api/types'
import { formatNumber, humanize, pluralize } from './format'
import { plainFailure, type AnswerPart } from './overview'
import { statusSemantics, type SemanticInfo } from './semantics'
import { TRIAGE_STATUS_LABEL } from './stages'

/** Job statuses. A finished job isn't a result, so "Done" is neutral; only failures are red. */
export const JOB_STATUS: Record<string, SemanticInfo> = {
  queued: { label: 'Queued', tone: 'neutral', icon: 'clock', description: 'Waiting for a worker to pick it up.' },
  running: { label: 'Running', tone: 'info', icon: 'pulse', description: 'A worker is running it now.' },
  done: { label: 'Done', tone: 'neutral', icon: 'check', description: 'Finished without errors.' },
  failed: { label: 'Failed', tone: 'negative', icon: 'x', description: 'Stopped with an error; see the error output.' },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: 'minus', description: 'Stopped before it finished.' },
}

export function jobStatusSemantics(status: string | null | undefined): SemanticInfo {
  return JOB_STATUS[status ?? ''] ?? { label: humanize(status ?? 'unknown'), tone: 'neutral', icon: 'question', description: '' }
}

/** Human names for job kinds (Appendix B: "Find new papers…", "Re-rank claims…", "Write missing explanations…"). */
export const JOB_KIND: Record<string, { label: string; description: string }> = {
  'experiment.run': { label: 'Write test plan', description: 'Plans the experiment from the picked claim, then waits for your approval.' },
  'experiment.resume': { label: 'Continue experiment', description: 'Continues an experiment after a gate.' },
  'topics.refresh': { label: 'Refresh topics', description: 'Finds the trending research topics in the seed areas.' },
  discover: { label: 'Find new papers', description: 'Searches the sources for new papers on the topics.' },
  distill: { label: 'Summarise papers', description: 'Turns pending papers into claim cards.' },
  match: { label: 'Re-rank claims', description: 'Scores every claim against a project and refreshes its recommendations.' },
  'project.roofline': { label: 'Measure roofline', description: 'Measures the engine’s decode speed against its hardware limit.' },
  'triage.run': { label: 'Research scan', description: 'Finds, summarises and ranks new claims, then shortlists them for you.' },
  explain: { label: 'Write explanations', description: 'Writes plain-language explanations that are missing.' },
}

/** "Build and test" for a resume after Gate 2, "Apply your decision" after Gate 3, else the kind's name. */
export function jobKindLabel(kind: string, payload?: Record<string, unknown> | null): string {
  if (kind === 'experiment.resume') {
    const gate = (payload?.resume as { gate?: string } | undefined)?.gate
    if (gate === 'approve_spec') return 'Build and test'
    if (gate === 'merge') return 'Apply your decision'
  }
  return JOB_KIND[kind]?.label ?? humanize(kind.replace(/\./g, ' '))
}

/** One sentence on what the job does (by gate for resumed experiments). */
export function jobKindDescription(kind: string, payload?: Record<string, unknown> | null): string {
  if (kind === 'experiment.resume') {
    const gate = (payload?.resume as { gate?: string } | undefined)?.gate
    if (gate === 'approve_spec') return 'After you approved the test plan: builds the change, smoke-tests it, tunes it, runs the A/B test and judges the result.'
    if (gate === 'merge') return 'Merges or drops the change, as you decided.'
  }
  return JOB_KIND[kind]?.description ?? ''
}

export interface JobTarget {
  label: string
  to?: string
}

/** What the job works on: an experiment, a research scan, a project, or the research library. */
export function jobTarget(job: Pick<Job, 'kind' | 'payload' | 'experiment_id' | 'triage_id'>): JobTarget {
  if (job.experiment_id) return { label: `Experiment #${job.experiment_id}`, to: `/experiments/${job.experiment_id}` }
  if (job.triage_id) return { label: `Research scan #${job.triage_id}`, to: `/recommendations?triage=${job.triage_id}` }
  const project = job.payload?.project_id
  if (typeof project === 'number') return { label: `Project #${project}`, to: `/projects?project=${project}` }
  if (job.kind === 'topics.refresh') return { label: 'Research topics', to: '/research/topics' }
  if (job.kind === 'discover' || job.kind === 'distill') return { label: 'Research papers', to: '/research/papers' }
  if (job.kind === 'explain') return { label: 'Explanations' }
  return { label: 'Whole system' }
}

const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * One plain line for what a finished job produced: "Next: Needs your decision", "Refreshed 10 topics",
 * "Summarised 5 papers into 23 claims (18 testable)". `null` when there is nothing worth saying.
 */
export function jobResultSummary(job: Pick<Job, 'kind' | 'result'>): string | null {
  const result = job.result
  if (!result) return null
  switch (job.kind) {
    case 'experiment.run':
    case 'experiment.resume':
      return typeof result.status === 'string' ? `Now: ${statusSemantics(result.status).label}` : null
    case 'triage.run':
      return typeof result.status === 'string' ? `Now: ${TRIAGE_STATUS_LABEL[result.status as keyof typeof TRIAGE_STATUS_LABEL] ?? humanize(result.status)}` : null
    case 'topics.refresh':
      return Array.isArray(result.topics) ? `Refreshed ${pluralize(result.topics.length, 'topic')}` : null
    case 'discover':
      return num(result.selected)
        ? `Found ${pluralize(result.selected, 'new paper')}${num(result.text_fetched) ? ` · ${pluralize(result.text_fetched, 'full text')} fetched` : ''}`
        : null
    case 'distill':
      return num(result.papers)
        ? `Summarised ${pluralize(result.papers, 'paper')}${num(result.claims) ? ` into ${pluralize(result.claims, 'claim')}` : ''}${num(result.testable) ? ` (${result.testable} testable)` : ''}`
        : null
    case 'match':
      return num(result.matched) ? `Ranked ${pluralize(result.matched, 'claim')}` : null
    case 'project.roofline': {
      const decode = result.decode as { tokens_per_s?: unknown; bandwidth_utilization?: unknown } | null | undefined
      const parts = [
        num(decode?.tokens_per_s) && `Decodes at ${formatNumber(decode.tokens_per_s, 1)} tok/s`,
        num(decode?.bandwidth_utilization) && `${formatNumber(decode.bandwidth_utilization * 100, 0)}% of the bandwidth limit`,
      ].filter(Boolean)
      return parts.length ? parts.join(' · ') : null
    }
    default: {
      const scalars = Object.entries(result).filter(([, value]) => num(value) || typeof value === 'boolean' || typeof value === 'string')
      if (!scalars.length) return null
      return scalars
        .slice(0, 4)
        .map(([key, value]) => (num(value) ? `${formatNumber(value)} ${humanize(key)}` : `${humanize(key)}: ${typeof value === 'boolean' ? (value ? 'yes' : 'no') : value}`))
        .join(' · ')
    }
  }
}

export interface JobHeadline {
  text: string
  tone: 'negative' | 'neutral' | 'info'
}

/** The first thing to read about a job: its failure, its result, or what it's doing. */
export function jobHeadline(job: Pick<Job, 'kind' | 'status' | 'result' | 'error'>): JobHeadline {
  if (job.status === 'failed' || job.error) {
    const failure = plainFailure(job.error)
    return { text: failure.reason ? `${failure.headline}: ${failure.reason}` : failure.headline, tone: 'negative' }
  }
  if (job.status === 'queued') return { text: 'Waiting for a worker', tone: 'neutral' }
  if (job.status === 'running') return { text: 'Running now', tone: 'info' }
  if (job.status === 'cancelled') return { text: 'Cancelled before it finished', tone: 'neutral' }
  return { text: jobResultSummary(job) ?? 'Finished', tone: 'neutral' }
}

// ---- service health + System answer line ----------------------------------------------------------------

export interface ServiceRow {
  id: string
  name: string
  role: string
  url: string | null
  /** 'ok' | 'down' | 'unknown' */
  state: 'ok' | 'down' | 'unknown'
}

const SERVICE_COPY: Record<string, { name: string; role: string }> = {
  gateway: { name: 'Gateway', role: 'Serves this console and forwards its requests' },
  research: { name: 'Research API', role: 'Topics, papers and claim cards' },
  lab: { name: 'Lab API', role: 'Projects, experiments and the job queue' },
  worker: { name: 'Worker', role: 'Runs queued jobs; its health shows in the jobs below' },
}

/** Gateway, each backing API and the worker, in that order, with plain names. */
export function serviceRows(
  services: Record<string, { url?: string; status?: string }> | null | undefined,
  options: { gatewayUrl?: string; gatewayDown?: boolean } = {},
): ServiceRow[] {
  const rows: ServiceRow[] = [
    { id: 'gateway', ...SERVICE_COPY.gateway, url: options.gatewayUrl ?? null, state: options.gatewayDown ? 'down' : services ? 'ok' : 'unknown' },
  ]
  for (const [id, health] of Object.entries(services ?? {})) {
    const copy = SERVICE_COPY[id] ?? { name: `${humanize(id)} service`, role: '' }
    rows.push({ id, ...copy, url: health.url ?? null, state: health.status === 'ok' ? 'ok' : 'down' })
  }
  if (options.gatewayDown) for (const id of ['research', 'lab']) if (!rows.some((row) => row.id === id)) rows.push({ id, ...SERVICE_COPY[id], url: null, state: 'unknown' })
  rows.push({ id: 'worker', ...SERVICE_COPY.worker, url: null, state: 'unknown' })
  return rows
}

/**
 * "All services OK · 3 jobs running · 3 failed (latest: job #27, experiment #13)" (S-1).
 * Jobs are newest first, as the API returns them.
 */
export function systemAnswer(rows: readonly ServiceRow[], jobs: readonly Job[] | null | undefined, options: { checking?: boolean } = {}): AnswerPart[] {
  const down = rows.filter((row) => row.state === 'down')
  const parts: AnswerPart[] = [
    down.length
      ? { text: `${down.map((row) => row.name).join(', ')} ${down.length === 1 ? 'is' : 'are'} not responding`, emphasis: true, tone: 'negative' }
      : options.checking
        ? { text: 'Checking services…' }
        : { text: 'All services OK' },
  ]
  if (jobs) {
    const running = jobs.filter((job) => job.status === 'running').length
    const queued = jobs.filter((job) => job.status === 'queued').length
    const failed = jobs.filter((job) => job.status === 'failed')
    parts.push({ text: running ? `${pluralize(running, 'job')} running` : 'no jobs running' })
    if (queued) parts.push({ text: `${queued} queued` })
    if (failed.length) {
      const latest = failed[0]
      const target = latest.experiment_id ? `, experiment #${latest.experiment_id}` : ''
      parts.push({ text: `${failed.length} failed (latest: job #${latest.id}${target})`, emphasis: true, tone: 'negative', to: '#failed-jobs' })
    }
  }
  return parts
}
