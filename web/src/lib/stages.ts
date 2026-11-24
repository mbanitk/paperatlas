import type { ExperimentStatus, Gate, Stage, StageName, StageState, TriageStatus, VerdictName } from '../api/types'
import { CLAIM_CHECK, claimCheckSemantics, EXPERIMENT_STATUS, statusSemantics, type SemanticInfo, type StatusSemantics } from './semantics'

export type { Tone } from './semantics'

export const STAGES: StageName[] = ['plan', 'approve', 'build', 'smoke', 'tune', 'run', 'judge', 'decide']

export const STAGE_LABELS: Record<StageName, string> = {
  plan: 'Plan',
  approve: 'Approve plan',
  build: 'Build',
  smoke: 'Smoke test',
  tune: 'Tune',
  run: 'A/B test',
  judge: 'Judge',
  decide: 'Merge or drop',
}

/** Same mapping as STAGE_OF_STATUS in paperatlas/lab/service.py. */
export const STAGE_OF_STATUS: Partial<Record<ExperimentStatus, StageName>> = {
  blocked: 'plan',
  queued: 'plan',
  planning: 'plan',
  awaiting_approval: 'approve',
  approving: 'build',
  building: 'build',
  smoke_testing: 'smoke',
  tuning: 'tune',
  waiting_gpu: 'run',
  running: 'run',
  judging: 'judge',
  awaiting_decision: 'decide',
  finalizing: 'decide',
  merged: 'decide',
  dropped: 'decide',
  rejected: 'approve',
}

export const GATE_OF_STATUS: Partial<Record<ExperimentStatus, Gate>> = {
  awaiting_approval: 'approve_spec',
  awaiting_decision: 'merge',
}

export const ACTIVE_STATUSES: ExperimentStatus[] = [
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
]
export const TERMINAL_STATUSES: ExperimentStatus[] = ['merged', 'dropped', 'rejected', 'failed', 'cancelled']

export const isActiveStatus = (status: ExperimentStatus) => ACTIVE_STATUSES.includes(status)
export const isTerminalStatus = (status: ExperimentStatus) => TERMINAL_STATUSES.includes(status)
export const needsYou = (status: ExperimentStatus) => status in GATE_OF_STATUS
export const canCancel = (status: ExperimentStatus) => !isTerminalStatus(status) && status !== 'cancelling'
/** Failed/cancelled experiments, and blocked ones whose prerequisite was not merged (they then run without it). */
export const canRetry = (status: ExperimentStatus, error?: string | null) =>
  status === 'failed' || status === 'cancelled' || (status === 'blocked' && !!error)

/** Statuses the backend lets you re-run (service.RERUNNABLE_STATUSES): a new experiment for the same claim on the current code. */
export const RERUNNABLE_STATUSES: readonly ExperimentStatus[] = ['awaiting_decision', 'merged', 'dropped', 'rejected', 'failed', 'cancelled']
export const canRerun = (status: ExperimentStatus) => RERUNNABLE_STATUSES.includes(status)

/** Ids of the experiments that re-run `id`, oldest first. */
export function rerunsOf(id: number, experiments: readonly { id: number; rerun_of_experiment_id?: number | null }[] | undefined): number[] {
  return (experiments ?? [])
    .filter((item) => item.rerun_of_experiment_id === id)
    .map((item) => item.id)
    .sort((a, b) => a - b)
}

/** Label, tone, icon and description of an experiment status (lib/semantics.ts is the source of truth). */
export type StatusInfo = StatusSemantics

/** @deprecated use EXPERIMENT_STATUS from lib/semantics.ts */
export const STATUS_INFO: Record<ExperimentStatus, StatusInfo> = EXPERIMENT_STATUS

export function statusInfo(status: string): StatusInfo {
  return statusSemantics(status)
}

/** Claim-check verdicts ("Reproduced", "Partly reproduced", …). Re-exported from lib/semantics.ts. */
export const VERDICT_INFO: Record<VerdictName, SemanticInfo> = CLAIM_CHECK

export function verdictInfo(verdict: string): SemanticInfo {
  return claimCheckSemantics(verdict)
}

/** Client-side equivalent of service._stage_progress for list rows (which carry `stage` but no `stages`). */
export function stagesForStatus(status: ExperimentStatus, stoppedAt: StageName | null = null): Stage[] {
  const terminalFailure = status === 'failed' || status === 'cancelled' || status === 'cancelling'
  const current = terminalFailure ? stoppedAt : STAGE_OF_STATUS[status] ?? null
  let reached = true
  return STAGES.map((stage) => {
    let state: StageState
    if (current === stage) {
      if (terminalFailure) state = status as StageState
      else if (status === 'merged' || status === 'dropped') state = 'done'
      else if (status === 'rejected') state = 'rejected'
      else state = status in GATE_OF_STATUS || status === 'blocked' ? 'waiting' : 'active'
      reached = false
    } else if (terminalFailure && current === null) {
      state = 'pending'
    } else {
      state = reached ? 'done' : 'pending'
    }
    return { stage, state }
  })
}

const STOPPED: StageState[] = ['failed', 'cancelled', 'cancelling', 'rejected']

/**
 * Stages from the API (which reports the stage a failed/cancelled experiment stopped in). Nothing after
 * the stage where it stopped can have run, so later stages are shown as pending.
 */
export function normalizeStages(stages: Stage[] | undefined, status: ExperimentStatus, stage: StageName | null = null): Stage[] {
  if (!stages?.length) return stagesForStatus(status, stage)
  let stopped = false
  return stages.map((item) => {
    if (stopped) return item.state === 'pending' ? item : { ...item, state: 'pending' as StageState }
    if (STOPPED.includes(item.state)) stopped = true
    return item
  })
}

export function stageProgress(stages: Stage[]): { done: number; total: number } {
  return { done: stages.filter((stage) => stage.state === 'done').length, total: stages.length }
}

// ---- triage -----------------------------------------------------------------------------

export const TRIAGE_STEPS: { key: TriageStatus; label: string }[] = [
  { key: 'topics', label: 'Topics' },
  { key: 'discover', label: 'Discover papers' },
  { key: 'distill', label: 'Distill claims' },
  { key: 'match', label: 'Match to project' },
  { key: 'shortlist', label: 'Shortlist' },
]

export const isTriageRunning = (status: TriageStatus) => !['awaiting_pick', 'picked', 'failed', 'done'].includes(status)

export function triageStepState(status: TriageStatus, step: TriageStatus, failedAt: TriageStatus | null = null): StageState {
  const order = TRIAGE_STEPS.map((s) => s.key)
  if (status === 'awaiting_pick' || status === 'picked' || status === 'done') return 'done'
  if (status === 'queued') return 'pending'
  if (status === 'failed') {
    if (!failedAt) return 'pending'
    const failedIndex = order.indexOf(failedAt)
    const index = order.indexOf(step)
    return index < failedIndex ? 'done' : index === failedIndex ? 'failed' : 'pending'
  }
  const currentIndex = order.indexOf(status)
  const index = order.indexOf(step)
  return index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'pending'
}

export const TRIAGE_STATUS_LABEL: Record<TriageStatus, string> = {
  queued: 'Queued',
  topics: 'Finding topics',
  discover: 'Discovering papers',
  distill: 'Distilling claims',
  match: 'Matching',
  shortlist: 'Shortlisting',
  awaiting_pick: 'Ready: pick claims',
  picked: 'Picked',
  failed: 'Failed',
  done: 'Done',
}
