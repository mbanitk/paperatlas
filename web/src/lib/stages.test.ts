import { describe, expect, it } from 'vitest'
import type { Stage } from '../api/types'
import { normalizeStages, stagesForStatus, triageStepState } from './stages'

const states = (stages: Stage[]) => stages.map((stage) => stage.state).join(',')

describe('stagesForStatus', () => {
  it('mirrors the backend for in-flight and gate statuses', () => {
    expect(states(stagesForStatus('running'))).toBe('done,done,done,done,active,pending,pending')
    expect(states(stagesForStatus('awaiting_approval'))).toBe('done,waiting,pending,pending,pending,pending,pending')
    expect(states(stagesForStatus('awaiting_decision'))).toBe('done,done,done,done,done,done,waiting')
    expect(states(stagesForStatus('approving'))).toBe('done,done,active,pending,pending,pending,pending')
  })

  it('uses the stage a failed or cancelled experiment stopped in', () => {
    expect(states(stagesForStatus('merged'))).toBe('done,done,done,done,done,done,done')
    expect(states(stagesForStatus('rejected'))).toBe('done,rejected,pending,pending,pending,pending,pending')
    expect(states(stagesForStatus('failed', 'build'))).toBe('done,done,failed,pending,pending,pending,pending')
    expect(states(stagesForStatus('cancelled', 'run'))).toBe('done,done,done,done,cancelled,pending,pending')
  })
})

describe('normalizeStages', () => {
  it('shows stages after the one that failed as pending', () => {
    const api: Stage[] = stagesForStatus('merged').map((stage) => (stage.stage === 'build' ? { ...stage, state: 'failed' } : stage))
    expect(states(normalizeStages(api, 'failed', 'build'))).toBe('done,done,failed,pending,pending,pending,pending')
  })

  it('keeps regular progress untouched and falls back to the status when stages are missing', () => {
    const running = stagesForStatus('running')
    expect(normalizeStages(running, 'running')).toEqual(running)
    expect(states(normalizeStages(undefined, 'failed', 'smoke'))).toBe('done,done,done,failed,pending,pending,pending')
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
