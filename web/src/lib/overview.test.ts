import { describe, expect, it } from 'vitest'
import type { ExperimentSummary, LabEvent } from '../api/types'
import {
  decisionBreakdown,
  decisionCounts,
  experimentProgress,
  formatEta,
  outcomeBreakdown,
  overviewAnswer,
  plainFailure,
  progressCounts,
  progressLine,
  recentFinished,
  sortGates,
  summarizeEvent,
} from './overview'

const TRACEBACK = `smoke: smoke benchmark failed (exit 1):
 recent call last):
  File "<frozen runpy>", line 198, in _run_module_as_main
  File "/x/techniques/latency_constrained_batching.py", line 150, in configuration
    raise ValueError(f"batch_limit={limit!r} is infeasible: offered concurrency is capped at {MAX_CONCURRENCY}")
ValueError: batch_limit=64 is infeasible: offered concurrency is capped at 8`

describe('outcomeBreakdown', () => {
  it('lists all five outcomes, negatives included, and the counts sum to the total', () => {
    const result = outcomeBreakdown({ regression: 2, partial: 2, not_reproduced: 4, reproduced: 1 })
    expect(result.slices.map((slice) => [slice.verdict, slice.count])).toEqual([
      ['reproduced', 1],
      ['partial', 2],
      ['not_reproduced', 4],
      ['regression', 2],
      ['inconclusive', 0],
    ])
    expect(result.total).toBe(9)
    expect(result.slices.reduce((sum, slice) => sum + slice.count, 0)).toBe(result.total)
    expect(result.sentence).toBe('9 results: 1 reproduced, 2 partly reproduced, 4 not reproduced, 2 worse than baseline')
  })

  it('keeps unknown verdicts so nothing is hidden', () => {
    const result = outcomeBreakdown({ reproduced: 1, mystery: 2 })
    expect(result.total).toBe(3)
    expect(result.slices.at(-1)).toMatchObject({ verdict: 'mystery', count: 2 })
  })

  it('says so when nothing is judged yet', () => {
    expect(outcomeBreakdown(undefined)).toMatchObject({ total: 0, sentence: 'No results yet' })
  })
})

describe('counts and answer line', () => {
  const experiments = { awaiting_decision: 9, awaiting_approval: 1, failed: 3, building: 2, running: 1 }

  it('counts decisions per gate', () => {
    const counts = decisionCounts(experiments, 1)
    expect(counts).toEqual({ pick: 1, approve: 1, merge: 9, total: 11 })
    expect(decisionBreakdown(counts)).toBe('9 to merge or drop · 1 test plan to approve · 1 research scan to pick from')
    expect(decisionBreakdown(decisionCounts({}))).toBe('Nothing waiting')
  })

  it('counts work in progress separately from gates and failures', () => {
    expect(progressCounts(experiments)).toEqual({ inProgress: 3, failed: 3, breakdown: '2 building · 1 running A/B test' })
  })

  it('answers what needs you first, then progress, outcomes and failures', () => {
    const parts = overviewAnswer({ experiments, verdicts: { reproduced: 1, not_reproduced: 8 } })
    expect(parts.map((part) => part.text)).toEqual([
      '10 decisions are waiting for you',
      '3 experiments in progress',
      '1 of 9 tested claims reproduced so far',
      '3 failed',
    ])
    expect(parts[0]).toMatchObject({ emphasis: true, to: '#needs-you' })
  })

  it('reads plainly when the lab is idle', () => {
    expect(overviewAnswer({ experiments: {}, verdicts: {} }).map((part) => part.text)).toEqual([
      'Nothing is waiting for you',
      'no experiments running',
      'no claims tested yet',
    ])
  })
})

const experiment = (id: number, status: ExperimentSummary['status'], updated: string): ExperimentSummary =>
  ({ id, status, updated_at: updated }) as ExperimentSummary

describe('lists', () => {
  it('puts plans to approve before results to decide, newest first', () => {
    const sorted = sortGates([
      experiment(1, 'awaiting_decision', '2026-11-24T10:00:00Z'),
      experiment(2, 'building', '2026-11-24T12:00:00Z'),
      experiment(3, 'awaiting_decision', '2026-11-24T11:00:00Z'),
      experiment(4, 'awaiting_approval', '2026-11-24T09:00:00Z'),
    ])
    expect(sorted.map((item) => item.id)).toEqual([4, 3, 1])
  })

  it('reports finished experiments newest first', () => {
    const finished = recentFinished([
      experiment(1, 'failed', '2026-11-24T10:00:00Z'),
      experiment(2, 'awaiting_decision', '2026-11-24T12:00:00Z'),
      experiment(3, 'merged', '2026-11-24T11:00:00Z'),
    ])
    expect(finished.map((item) => item.id)).toEqual([3, 1])
  })
})

describe('plainFailure', () => {
  it('reads the exception line out of a traceback', () => {
    expect(plainFailure(TRACEBACK)).toEqual({
      headline: 'Smoke test failed',
      reason: 'ValueError: batch_limit=64 is infeasible: offered concurrency is capped at 8',
    })
  })

  it('turns timeouts into words', () => {
    expect(plainFailure('smoke: smoke benchmark failed (exit 124):\n[timeout after 1800s]')).toEqual({
      headline: 'Smoke test failed',
      reason: 'Timed out after 30 min',
    })
  })

  it('drops module paths and byte-string wrappers', () => {
    const error = `smoke benchmark failed (exit 1):\n  File "x.py", line 1\ninference_lab.bench.client.ServerError: chat completion failed: HTTP 404: b'{"error": "generation thread died"}'`
    expect(plainFailure(error).reason).toBe('ServerError: chat completion failed: HTTP 404: “generation thread died”')
  })

  it('falls back to the first line', () => {
    expect(plainFailure('build: copilot gave up after 3 attempts')).toEqual({ headline: 'Build failed', reason: 'copilot gave up after 3 attempts' })
    expect(plainFailure(null)).toEqual({ headline: 'Failed', reason: null })
  })
})

const event = (id: number, message: string, created_at: string, stage = 'run', level = 'info'): LabEvent => ({
  id,
  stage,
  level,
  message,
  data: null,
  experiment_id: 12,
  triage_id: null,
  job_id: null,
  created_at,
})

describe('summarizeEvent', () => {
  it.each([
    ['[bench] round 7 baseline: ttft=245.2ms decode=90.7tok/s tput=76.7tok/s peak=19.11GB', 'run', 'A/B test: measured round 8 (baseline arm)'],
    ['[bench] round 0 baseline: ttft=245.8ms decode=91.5tok/s', 'tune', 'Tuning run: measured round 1 (baseline arm)'],
    ["[bench] started server for arm variant flags=['suffix_decoding'] pid=18006", 'run', 'Starting the variant server'],
    ['Claim check: 10 rounds per arm, workload paper regime', 'run', 'Claim check started: 10 rounds per arm on the paper’s workload'],
    ['Adoption check: 10 rounds per arm, workload long_prompt', 'run', 'Adoption check started: 10 rounds per arm on long_prompt'],
    ['Tuning (3/3 max_draft_tokens=8): 1 rounds per arm, workload paper regime', 'tune', 'Tuning: trying setting 3 of 3'],
    ['Config 3/3 max_draft_tokens=8: baseline 1547.0553955019568, method 1155.81 (e2e_latency_ms)', 'tune', 'Tuning: setting 3 of 3 measured'],
    ['copilot is implementing `suffix_decoding` (attempt 1/3)', 'build', 'Coding agent is implementing the change (attempt 1 of 3)'],
    ['copilot: still running (101s elapsed)', 'build', 'Coding agent at work (1m 41s so far)'],
    ['copilot:  ● Edit  Create src/inference_lab/techniques/_suffix_compact.cpp', 'build', 'Coding agent at work'],
    [
      'Verdict: partial — peak_memory_gb improved +0.1%, below target 3.0%. Adoption: regression. Diagnosis: implementation suspect.',
      'decide',
      'Result: partly reproduced; on your default workload: worse than default. Waiting for your decision',
    ],
    ['Spec ready — waiting for approval (Gate 2)', 'approve', 'Test plan ready: waiting for your approval'],
  ])('%s', (message, stage, expected) => {
    expect(summarizeEvent({ message, stage, level: 'info' })).toBe(expected)
  })

  it('summarises errors instead of showing the traceback', () => {
    expect(summarizeEvent({ message: `smoke failed: ${TRACEBACK.replace(/^smoke: /, '')}`, stage: 'smoke', level: 'error' })).toBe(
      'Smoke test failed: ValueError: batch_limit=64 is infeasible: offered concurrency is capped at 8',
    )
  })

  it('keeps already-plain messages and cleans the rest', () => {
    expect(summarizeEvent({ message: 'Waiting for the GPU (another benchmark is running)', stage: 'waiting_gpu', level: 'info' })).toBe(
      'Waiting for the GPU (another benchmark is running)',
    )
  })
})

describe('experimentProgress', () => {
  const events = [
    event(1, 'Claim check: 10 rounds per arm, workload paper regime', '2026-11-24T12:00:00Z'),
    event(2, '[bench] round 0 baseline: ttft=246.9ms', '2026-11-24T12:01:00Z'),
    event(3, '[bench] round 1 variant: ttft=234.2ms', '2026-11-24T12:02:00Z'),
    event(4, '[bench] started server for arm baseline', '2026-11-24T12:02:30Z'),
    event(5, '[bench] round 4 baseline: ttft=254.7ms', '2026-11-24T12:05:00Z'),
  ]

  it('derives the phase, rounds and a time estimate from the pace so far', () => {
    const progress = experimentProgress([...events].reverse())
    expect(progress).toEqual({ phase: 'Claim check', done: 5, total: 20, etaSeconds: 900 })
    expect(progressLine(progress)).toBe('Claim check · round 5 of 20 · about 15 min left')
  })

  it('uses the latest phase only', () => {
    const later = [...events, event(6, 'Adoption check: 5 rounds per arm, workload long_prompt', '2026-11-24T12:10:00Z')]
    expect(experimentProgress(later)).toEqual({ phase: 'Adoption check', done: 0, total: 10, etaSeconds: null })
  })

  it('still reports rounds when the phase start has scrolled out of the feed', () => {
    expect(experimentProgress(events.slice(1))).toEqual({ phase: null, done: 5, total: null, etaSeconds: null })
    expect(progressLine(experimentProgress(events.slice(1)))).toBe('round 5')
    expect(experimentProgress([])).toEqual({ phase: null, done: null, total: null, etaSeconds: null })
  })

  it('formats the time left', () => {
    expect(formatEta(30)).toBe('under a minute left')
    expect(formatEta(4000)).toBe('about 1 h 7 min left')
    expect(formatEta(null)).toBeNull()
  })
})
