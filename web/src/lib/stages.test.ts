import { describe, expect, it } from 'vitest'
import type { Stage } from '../api/types'
import { canRerun, canRetry, normalizeStages, rerunsOf, stagesForStatus, triageStepState } from './stages'

const states = (stages: Stage[]) => stages.map((stage) => stage.state).join(',')

describe('stagesForStatus', () => {
  it('mirrors the backend for in-flight and gate statuses', () => {
    expect(states(stagesForStatus('running'))).toBe('done,done,done,done,done,active,pending,pending')
    expect(states(stagesForStatus('tuning'))).toBe('done,done,done,done,active,pending,pending,pending')
    expect(states(stagesForStatus('awaiting_approval'))).toBe('done,waiting,pending,pending,pending,pending,pending,pending')
    expect(states(stagesForStatus('awaiting_decision'))).toBe('done,done,done,done,done,done,done,waiting')
    expect(states(stagesForStatus('approving'))).toBe('done,done,active,pending,pending,pending,pending,pending')
  })

  it('uses the stage a failed or cancelled experiment stopped in', () => {
    expect(states(stagesForStatus('merged'))).toBe('done,done,done,done,done,done,done,done')
    expect(states(stagesForStatus('rejected'))).toBe('done,rejected,pending,pending,pending,pending,pending,pending')
    expect(states(stagesForStatus('failed', 'build'))).toBe('done,done,failed,pending,pending,pending,pending,pending')
    expect(states(stagesForStatus('cancelled', 'run'))).toBe('done,done,done,done,done,cancelled,pending,pending')
  })
})

describe('normalizeStages', () => {
  it('shows stages after the one that failed as pending', () => {
    const api: Stage[] = stagesForStatus('merged').map((stage) => (stage.stage === 'build' ? { ...stage, state: 'failed' } : stage))
    expect(states(normalizeStages(api, 'failed', 'build'))).toBe('done,done,failed,pending,pending,pending,pending,pending')
  })

  it('keeps regular progress untouched and falls back to the status when stages are missing', () => {
    const running = stagesForStatus('running')
    expect(normalizeStages(running, 'running')).toEqual(running)
    expect(states(normalizeStages(undefined, 'failed', 'smoke'))).toBe('done,done,done,failed,pending,pending,pending,pending')
  })
})

describe('triageStepState', () => {
  it('walks through the scan steps', () => {
    expect(triageStepState('discover', 'topics')).toBe('done')
    expect(triageStepState('discover', 'discover')).toBe('active')
    expect(triageStepState('discover', 'match')).toBe('pending')
    expect(triageStepState('awaiting_pick', 'shortlist')).toBe('done')
    expect(triageStepState('failed', 'distill', 'distill')).toBe('failed')
  })
})

describe('blocked (chain dependents)', () => {
  it('waits in plan and can be retried only once its prerequisite was not merged', () => {
    expect(stagesForStatus('blocked')[0]).toEqual({ stage: 'plan', state: 'waiting' })
    expect(canRetry('blocked')).toBe(false)
    expect(canRetry('blocked', 'plan: prerequisite experiment #2 was not merged — retry to run without it')).toBe(true)
  })
})

describe('re-runs', () => {
  it('allows re-running settled experiments only', () => {
    for (const status of ['awaiting_decision', 'merged', 'dropped', 'rejected', 'failed', 'cancelled'] as const) expect(canRerun(status)).toBe(true)
    for (const status of ['awaiting_approval', 'building', 'running', 'blocked', 'queued', 'finalizing'] as const) expect(canRerun(status)).toBe(false)
  })

  it('finds the re-runs of an experiment in a list', () => {
    const list = [
      { id: 9, rerun_of_experiment_id: 3 },
      { id: 7, rerun_of_experiment_id: null },
      { id: 5, rerun_of_experiment_id: 3 },
      { id: 4 },
    ]
    expect(rerunsOf(3, list)).toEqual([5, 9])
    expect(rerunsOf(7, list)).toEqual([])
    expect(rerunsOf(3, undefined)).toEqual([])
  })
})
