import { describe, expect, it } from 'vitest'
import type { LabEvent, Stage } from '../api/types'
import { failedStageOf, normalizeStages, stagesForStatus, triageStepState } from './stages'

const states = (stages: Stage[]) => stages.map((stage) => stage.state).join(',')

describe('stagesForStatus', () => {
  it('mirrors the backend for in-flight and gate statuses', () => {
    expect(states(stagesForStatus('running'))).toBe('done,done,done,done,active,pending,pending')
    expect(states(stagesForStatus('awaiting_approval'))).toBe('done,waiting,pending,pending,pending,pending,pending')
    expect(states(stagesForStatus('awaiting_decision'))).toBe('done,done,done,done,done,done,waiting')
    expect(states(stagesForStatus('approving'))).toBe('done,done,active,pending,pending,pending,pending')
  })

  it('marks terminal outcomes', () => {
    expect(states(stagesForStatus('merged'))).toBe('done,done,done,done,done,done,done')
    expect(states(stagesForStatus('rejected'))).toBe('done,rejected,pending,pending,pending,pending,pending')
    expect(states(stagesForStatus('failed', 'build'))).toBe('done,done,failed,pending,pending,pending,pending')
  })
})

describe('failedStageOf', () => {
  it('reads the stage from the error prefix', () => {
    expect(failedStageOf('build: Build failed after 3 attempts')).toBe('build')
    expect(failedStageOf('eval: benchmark exited 1')).toBe('run')
  })

  it('falls back to the last event stage', () => {
    const events = [{ stage: 'plan' }, { stage: 'smoke' }, { stage: 'cancel' }] as LabEvent[]
    expect(failedStageOf(null, events)).toBe('smoke')
    expect(failedStageOf(null, [])).toBeNull()
  })
})

describe('normalizeStages', () => {
  const allDone = stagesForStatus('merged')

  it('repairs the all-done stages the API returns for failed experiments', () => {
    expect(states(normalizeStages(allDone, 'failed', 'build: tests failed'))).toBe('done,done,failed,pending,pending,pending,pending')
  })

  it('keeps correct backend stages untouched', () => {
    const running = stagesForStatus('running')
    expect(normalizeStages(running, 'running')).toBe(running)
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
