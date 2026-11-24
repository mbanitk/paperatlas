import type { ExperimentStatus, Gate, Stage, StageName, StageState, TriageStatus, VerdictName } from '../api/types'

export const STAGES: StageName[] = ['plan', 'approve', 'build', 'smoke', 'tune', 'run', 'judge', 'decide']

export const STAGE_LABELS: Record<StageName, string> = {
  plan: 'Plan',
  approve: 'Approve spec',
  build: 'Build',
  smoke: 'Smoke test',
  tune: 'Tune',
  run: 'A/B run',
  judge: 'Judge',
  decide: 'Merge / drop',
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

export type Tone = 'neutral' | 'accent' | 'attention' | 'success' | 'danger' | 'done' | 'muted'

export interface StatusInfo {
  label: string
  tone: Tone
  /** true while the backend/worker is doing something (show a pulse). */
  busy: boolean
}

const STATUS_INFO: Record<ExperimentStatus, StatusInfo> = {
  blocked: { label: 'Waiting for prerequisite', tone: 'neutral', busy: false },
  queued: { label: 'Queued', tone: 'neutral', busy: false },
  planning: { label: 'Planning', tone: 'accent', busy: true },
  awaiting_approval: { label: 'Needs approval', tone: 'attention', busy: false },
  approving: { label: 'Approved — starting', tone: 'accent', busy: true },
  building: { label: 'Building', tone: 'accent', busy: true },
  smoke_testing: { label: 'Smoke testing', tone: 'accent', busy: true },
  tuning: { label: 'Tuning', tone: 'accent', busy: true },
  waiting_gpu: { label: 'Waiting for GPU', tone: 'neutral', busy: true },
  running: { label: 'Running A/B', tone: 'accent', busy: true },
  judging: { label: 'Judging', tone: 'accent', busy: true },
  awaiting_decision: { label: 'Needs decision', tone: 'attention', busy: false },
  finalizing: { label: 'Finalizing', tone: 'accent', busy: true },
  cancelling: { label: 'Cancelling', tone: 'neutral', busy: true },
  merged: { label: 'Merged', tone: 'done', busy: false },
  dropped: { label: 'Dropped', tone: 'muted', busy: false },
  rejected: { label: 'Rejected', tone: 'muted', busy: false },
  failed: { label: 'Failed', tone: 'danger', busy: false },
  cancelled: { label: 'Cancelled', tone: 'muted', busy: false },
}

export function statusInfo(status: string): StatusInfo {
  return STATUS_INFO[status as ExperimentStatus] ?? { label: status.replace(/_/g, ' '), tone: 'neutral', busy: false }
}

export const VERDICT_INFO: Record<VerdictName, { label: string; tone: Tone; description: string }> = {
  reproduced: { label: 'Reproduced', tone: 'success', description: 'Effect reached the target derived from the paper’s claim.' },
  partial: { label: 'Partial', tone: 'attention', description: 'Significant improvement, but below the target.' },
  not_reproduced: { label: 'Not reproduced', tone: 'neutral', description: 'No significant change (95% CI includes 0).' },
  regression: { label: 'Regression', tone: 'danger', description: 'Got worse, or a quality / memory guardrail failed.' },
  inconclusive: { label: 'Inconclusive', tone: 'attention', description: 'Not enough complete measurements (missing rounds or quality metrics) to judge.' },
}

export function verdictInfo(verdict: string) {
  return VERDICT_INFO[verdict as VerdictName] ?? { label: verdict.replace(/_/g, ' '), tone: 'neutral' as Tone, description: '' }
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
  awaiting_pick: 'Ready — pick claims',
  picked: 'Picked',
  failed: 'Failed',
  done: 'Done',
}
