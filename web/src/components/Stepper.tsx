import type { Stage, StageName, StageState } from '../api/types'
import { STAGE_LABELS } from '../lib/stages'
import { CheckIcon, ClockIcon, GateIcon, MinusIcon, XIcon } from './Icons'
import { InfoPopover } from './Tooltip'
import { cx, Disclosure } from './ui'

const STATE_LABEL: Record<StageState, string> = {
  done: 'done',
  active: 'in progress',
  waiting: 'waiting for you',
  pending: 'not started',
  failed: 'failed',
  cancelled: 'cancelled',
  cancelling: 'cancelling',
  rejected: 'rejected',
}

/** What happens at each step, in plain words (one presentation for engineers and executives alike). */
export const STAGE_HELP: Record<StageName, string> = {
  plan: 'An AI planner turns the paper’s claim into a test plan.',
  approve: 'You approve the test plan before anything is built (Gate 2).',
  build: 'A coding agent implements the technique behind a feature flag, on its own branch.',
  smoke: 'A quick run on a small model checks that the build works.',
  tune: 'Short runs find the best settings, for the change and for the baseline.',
  run: 'The measured A/B test: the same workload with the change on and off.',
  judge: 'The results are compared with the paper’s claim and your success bar.',
  decide: 'You merge the change or drop it (Gate 3). Merged changes stay off by default.',
}

/** Steps where a person decides; shown as "you approve" / "you decide" until reached. */
const GATE_STAGES: Partial<Record<StageName, string>> = { approve: 'you approve', decide: 'you decide' }

const stateLabel = (stage: Stage, waitingLabel?: string) =>
  stage.state === 'waiting' && waitingLabel ? waitingLabel : stage.state === 'pending' && GATE_STAGES[stage.stage] ? GATE_STAGES[stage.stage]! : STATE_LABEL[stage.state]

/** The step that needs attention now: the first one that's neither done nor untouched (else the last done). */
export function currentStage(stages: Stage[]): { stage: Stage; index: number; allDone: boolean } | null {
  if (!stages.length) return null
  const index = stages.findIndex((stage) => stage.state !== 'done' && stage.state !== 'pending')
  if (index >= 0) return { stage: stages[index], index, allDone: false }
  const firstPending = stages.findIndex((stage) => stage.state === 'pending')
  if (firstPending === 0) return { stage: stages[0], index: 0, allDone: false }
  if (firstPending > 0) return { stage: stages[firstPending - 1], index: firstPending - 1, allDone: false }
  return { stage: stages[stages.length - 1], index: stages.length - 1, allDone: true }
}

function StageIcon({ state, gate, size = 'md' }: { state: StageState; gate?: boolean; size?: 'md' | 'sm' }) {
  const base = cx('flex shrink-0 items-center justify-center rounded-full border-2', size === 'sm' ? 'size-6' : 'size-7')
  const icon = size === 'sm' ? 12 : 14
  switch (state) {
    case 'done':
      return (
        <span className={cx(base, 'border-neutral bg-neutral text-white')}>
          <CheckIcon size={icon} />
        </span>
      )
    case 'active':
      return (
        <span className={cx(base, 'border-info bg-info-subtle text-info-fg')}>
          <span className="size-2.5 animate-pulse-dot rounded-full bg-info" />
        </span>
      )
    case 'waiting':
      return (
        <span className={cx(base, 'border-caution-emphasis bg-caution-subtle text-caution-fg')}>
          {gate ? <GateIcon size={icon} /> : <ClockIcon size={icon} />}
        </span>
      )
    case 'failed':
    case 'rejected':
      return (
        <span className={cx(base, 'border-negative-emphasis bg-negative-emphasis text-white')}>
          <XIcon size={icon} />
        </span>
      )
    case 'cancelled':
    case 'cancelling':
      return (
        <span className={cx(base, 'border-line bg-canvas-inset text-muted')}>
          <MinusIcon size={icon} />
        </span>
      )
    default:
      return <span className={cx(base, 'border-line bg-canvas text-muted')}>{gate && <GateIcon size={icon - 2} />}</span>
  }
}

function StepsHelp() {
  return (
    <InfoPopover
      label="What happens at each step"
      title="What happens at each step"
      maxWidth={360}
      content={
        <ol className="list-decimal space-y-1 pl-4 whitespace-normal">
          {(Object.keys(STAGE_HELP) as StageName[]).map((name) => (
            <li key={name}>
              <span className="font-semibold">{STAGE_LABELS[name]}:</span> {STAGE_HELP[name]}
            </li>
          ))}
        </ol>
      }
    />
  )
}

/** "Step 8 of 8 · Merge or drop: waiting for you", plus what that step means. */
function StepSummary({ stages, waitingLabel }: { stages: Stage[]; waitingLabel?: string }) {
  const current = currentStage(stages)
  if (!current) return null
  const { stage, index, allDone } = current
  return (
    <div className="flex min-w-0 items-start gap-1">
      <p className="min-w-0 text-sm text-fg">
        {allDone ? (
          <span className="font-semibold">All {stages.length} steps done</span>
        ) : (
          <>
            <span className="text-muted tabular-nums">
              Step {index + 1} of {stages.length} ·{' '}
            </span>
            <span className="font-semibold">{STAGE_LABELS[stage.stage]}</span>
            <span className={cx(stage.state === 'waiting' && !waitingLabel ? 'font-semibold text-caution-fg' : stage.state === 'failed' || stage.state === 'rejected' ? 'font-semibold text-negative-fg' : 'text-muted')}>
              : {stateLabel(stage, waitingLabel)}
            </span>
          </>
        )}
        {!allDone && <span className="block text-xs text-muted">{STAGE_HELP[stage.stage]}</span>}
      </p>
      <StepsHelp />
    </div>
  )
}

/**
 * Experiment pipeline. From 768 px: a horizontal stepper with the current step explained underneath. Below:
 * a compact bar and "Step n of 8 · …" line, with the full list in a disclosure (docs/ux-review.md X-7).
 * `waitingLabel` replaces "waiting for you" when the wait is not on the user (e.g. a prerequisite experiment).
 */
export function Stepper({ stages, waitingLabel }: { stages: Stage[]; waitingLabel?: string }) {
  return (
    <div className="space-y-3">
      <ol className="hidden md:flex md:items-start" aria-label="Experiment progress">
        {stages.map((stage, index) => {
          const last = index === stages.length - 1
          const next = stages[index + 1]
          return (
            <li key={stage.stage} className="relative flex min-w-0 flex-1 flex-col items-center gap-1.5 px-1 text-center" aria-current={stage.state === 'active' || stage.state === 'waiting' ? 'step' : undefined}>
              {!last && (
                <span
                  aria-hidden="true"
                  className={cx('absolute top-3.5 left-[calc(50%+18px)] h-0.5 w-[calc(100%-36px)]', stage.state === 'done' && next && next.state !== 'pending' ? 'bg-neutral' : 'bg-line')}
                />
              )}
              <StageIcon state={stage.state} gate={!!GATE_STAGES[stage.stage]} />
              <div className="min-w-0">
                <div className={cx('text-xs font-semibold', stage.state === 'pending' ? 'text-muted' : 'text-fg')}>{STAGE_LABELS[stage.stage]}</div>
                <div
                  className={cx(
                    'text-xs',
                    stage.state === 'waiting' && !waitingLabel
                      ? 'font-semibold text-caution-fg'
                      : stage.state === 'failed' || stage.state === 'rejected'
                        ? 'text-negative-fg'
                        : 'text-muted',
                  )}
                >
                  {stateLabel(stage, waitingLabel)}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      <div className="md:hidden">
        <MiniStages stages={stages} showLabel={false} className="mb-2" />
      </div>
      <StepSummary stages={stages} waitingLabel={waitingLabel} />
      <Disclosure label="All steps" className="md:hidden">
        <ol className="space-y-2" aria-label="Experiment progress">
          {stages.map((stage) => (
            <li key={stage.stage} className="flex items-start gap-2">
              <StageIcon state={stage.state} gate={!!GATE_STAGES[stage.stage]} size="sm" />
              <div className="min-w-0 text-sm">
                <span className={cx('font-semibold', stage.state === 'pending' ? 'text-muted' : 'text-fg')}>{STAGE_LABELS[stage.stage]}</span>
                <span className="text-muted"> · {stateLabel(stage, waitingLabel)}</span>
                <span className="block text-xs text-muted">{STAGE_HELP[stage.stage]}</span>
              </div>
            </li>
          ))}
        </ol>
      </Disclosure>
    </div>
  )
}

const MINI_COLORS: Record<StageState, string> = {
  done: 'bg-neutral',
  active: 'bg-info animate-pulse-dot',
  waiting: 'bg-caution-emphasis',
  pending: 'bg-line',
  failed: 'bg-negative-emphasis',
  rejected: 'bg-negative-emphasis',
  cancelled: 'bg-neutral-emphasis',
  cancelling: 'bg-neutral-emphasis',
}

/** Compact 8-segment progress bar for list rows (and the stepper below 768 px). */
export function MiniStages({ stages, className, showLabel = true }: { stages: Stage[]; className?: string; showLabel?: boolean }) {
  const current = stages.find((stage) => stage.state !== 'done' && stage.state !== 'pending')
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <div className="flex gap-0.5" role="img" aria-label={stages.map((s) => `${STAGE_LABELS[s.stage]}: ${STATE_LABEL[s.state]}`).join(', ')}>
        {stages.map((stage) => (
          <span key={stage.stage} className={cx('h-1.5 w-4 rounded-full', MINI_COLORS[stage.state])} />
        ))}
      </div>
      {showLabel && current && <span className="text-xs whitespace-nowrap text-muted">{STAGE_LABELS[current.stage]}</span>}
    </div>
  )
}
