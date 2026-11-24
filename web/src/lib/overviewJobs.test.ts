import { describe, expect, it } from 'vitest'
import type { Job } from '../api/types'
import { jobHeadline, jobKindLabel, jobResultSummary, jobStatusSemantics, jobTarget, serviceRows, systemAnswer } from './overviewJobs'

const job = (overrides: Partial<Job>): Job => ({
  id: 1,
  kind: 'experiment.run',
  status: 'done',
  payload: {},
  attempts: 1,
  error: null,
  result: null,
  experiment_id: null,
  triage_id: null,
  created_at: null,
  started_at: null,
  finished_at: null,
  ...overrides,
})

describe('job words', () => {
  it('names kinds in plain words, by gate for resumed experiments', () => {
    expect(jobKindLabel('experiment.run')).toBe('Write test plan')
    expect(jobKindLabel('experiment.resume', { resume: { gate: 'approve_spec' } })).toBe('Build and test')
    expect(jobKindLabel('experiment.resume', { resume: { gate: 'merge' } })).toBe('Apply your decision')
    expect(jobKindLabel('project.roofline')).toBe('Measure roofline')
    expect(jobKindLabel('new.kind_of_job')).toBe('new kind of job')
  })

  it('keeps green for results: a finished job is neutral, a failed one negative', () => {
    expect(jobStatusSemantics('done')).toMatchObject({ label: 'Done', tone: 'neutral' })
    expect(jobStatusSemantics('failed')).toMatchObject({ label: 'Failed', tone: 'negative' })
    expect(jobStatusSemantics('running')).toMatchObject({ tone: 'info', icon: 'pulse' })
  })

  it('links each job to what it works on', () => {
    expect(jobTarget(job({ experiment_id: 13 }))).toEqual({ label: 'Experiment #13', to: '/experiments/13' })
    expect(jobTarget(job({ kind: 'match', payload: { project_id: 1 } }))).toEqual({ label: 'Project #1', to: '/projects?project=1' })
    expect(jobTarget(job({ kind: 'topics.refresh' }))).toEqual({ label: 'Research topics', to: '/research/topics' })
  })
})

describe('jobResultSummary', () => {
  it.each([
    [{ kind: 'experiment.resume', result: { status: 'awaiting_decision' } }, 'Now: Needs your decision'],
    [{ kind: 'topics.refresh', result: { topics: ['a', 'b'] } }, 'Refreshed 2 topics'],
    [{ kind: 'discover', result: { selected: 12, text_fetched: 8 } }, 'Found 12 new papers · 8 full texts fetched'],
    [{ kind: 'distill', result: { papers: 5, claims: 23, testable: 18 } }, 'Summarised 5 papers into 23 claims (18 testable)'],
    [{ kind: 'match', result: { matched: 652 } }, 'Ranked 652 claims'],
    [{ kind: 'project.roofline', result: { decode: { tokens_per_s: 107.31, bandwidth_utilization: 0.58 } } }, 'Decodes at 107.3 tok/s · 58% of the bandwidth limit'],
    [{ kind: 'explain', result: { claims: 25, papers: 3, nested: { a: 1 } } }, '25 claims · 3 papers'],
    [{ kind: 'explain', result: null }, null],
  ])('%j', (input, expected) => {
    expect(jobResultSummary(input as Pick<Job, 'kind' | 'result'>)).toBe(expected)
  })

  it('reads a failure before anything else', () => {
    const failed = job({ status: 'failed', error: 'smoke benchmark failed (exit 124):\n[timeout after 1800s]' })
    expect(jobHeadline(failed)).toEqual({ text: 'Smoke test failed: Timed out after 30 min', tone: 'negative' })
    expect(jobHeadline(job({ status: 'queued' }))).toEqual({ text: 'Waiting for a worker', tone: 'neutral' })
  })
})

describe('system answer', () => {
  const services = { research: { url: 'http://127.0.0.1:8101', status: 'ok' }, lab: { url: 'http://127.0.0.1:8102', status: 'ok' } }

  it('lists gateway, APIs and worker with plain names', () => {
    const rows = serviceRows(services, { gatewayUrl: 'http://localhost' })
    expect(rows.map((row) => [row.name, row.state])).toEqual([
      ['Gateway', 'ok'],
      ['Research API', 'ok'],
      ['Lab API', 'ok'],
      ['Worker', 'unknown'],
    ])
  })

  it('marks everything unknown behind a gateway that is down', () => {
    expect(serviceRows(undefined, { gatewayDown: true }).map((row) => row.state)).toEqual(['down', 'unknown', 'unknown', 'unknown'])
  })

  it('leads with health, then running and failed jobs (latest failure named)', () => {
    const jobs = [
      job({ id: 31, status: 'running' }),
      job({ id: 27, status: 'failed', experiment_id: 13 }),
      job({ id: 23, status: 'failed', experiment_id: 11 }),
      job({ id: 20, status: 'done' }),
    ]
    expect(systemAnswer(serviceRows(services), jobs).map((part) => part.text)).toEqual([
      'All services OK',
      '1 job running',
      '2 failed (latest: job #27, experiment #13)',
    ])
    expect(systemAnswer(serviceRows(undefined), [], { checking: true })[0].text).toBe('Checking services…')
    const down = serviceRows({ ...services, lab: { url: 'x', status: 'error' } })
    expect(systemAnswer(down, [])[0]).toMatchObject({ text: 'Lab API is not responding', tone: 'negative' })
  })
})
