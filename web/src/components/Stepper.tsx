import type { Stage, StageState } from '../api/types'
import { STAGE_LABELS } from '../lib/stages'
import { CheckIcon, ClockIcon, MinusIcon, XIcon } from './Icons'
import { cx } from './ui'

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

function StageIcon({ state }: { state: StageState }) {
  const base = 'flex size-7 shrink-0 items-center justify-center rounded-full border-2'
  switch (state) {
    case 'done':
      return (
        <span className={cx(base, 'border-success-emphasis bg-success-emphasis text-white')}>
          <CheckIcon size={14} />
        </span>
      )
    case 'active':
      return (
        <span className={cx(base, 'border-accent bg-accent-subtle text-accent')}>
          <span className="size-2.5 animate-pulse-dot rounded-full bg-accent" />
        </span>
      )
    case 'waiting':
      return (
        <span className={cx(base, 'border-attention-emphasis bg-attention-subtle text-attention')}>
          <ClockIcon size={14} />
        </span>
      )
    case 'failed':
    case 'rejected':
      return (
        <span className={cx(base, 'border-danger-emphasis bg-danger-emphasis text-white')}>
          <XIcon size={14} />
        </span>
      )
    case 'cancelled':
    case 'cancelling':
      return (
        <span className={cx(base, 'border-subtle bg-canvas-inset text-muted')}>
          <MinusIcon size={14} />
        </span>
      )
    default:
      return <span className={cx(base, 'border-line bg-canvas text-subtle')} />
  }
}

/**
 * Horizontal stepper for the experiment pipeline (wraps to a vertical list on small screens).
 * `waitingLabel` replaces "waiting for you" when the wait is not on the user (e.g. a prerequisite experiment).
 */
export function Stepper({ stages, waitingLabel }: { stages: Stage[]; waitingLabel?: string }) {
  return (
    <ol className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-0" aria-label="Experiment progress">
      {stages.map((stage, index) => {
        const last = index === stages.length - 1
        const next = stages[index + 1]
        return (
          <li key={stage.stage} className="relative flex items-center gap-2 sm:flex-1 sm:flex-col sm:items-center sm:gap-1.5 sm:text-center">
            {!last && (
              <span
                aria-hidden="true"
                className={cx(
                  'absolute top-3.5 left-[calc(50%+18px)] hidden h-0.5 w-[calc(100%-36px)] sm:block',
                  stage.state === 'done' && next && next.state !== 'pending' ? 'bg-success-emphasis' : 'bg-line',
                )}
              />
            )}
            <StageIcon state={stage.state} />
            <div className="min-w-0">
              <div className={cx('text-xs font-semibold', stage.state === 'pending' ? 'text-muted' : 'text-fg')}>{STAGE_LABELS[stage.stage]}</div>
              <div
                className={cx(
                  'text-[11px]',
                  stage.state === 'waiting' && !waitingLabel
                    ? 'font-semibold text-attention'
                    : stage.state === 'failed' || stage.state === 'rejected'
                      ? 'text-danger'
                      : 'text-muted',
                )}
              >
                {stage.state === 'waiting' && waitingLabel ? waitingLabel : STATE_LABEL[stage.state]}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

const MINI_COLORS: Record<StageState, string> = {
  done: 'bg-success-emphasis',
  active: 'bg-accent animate-pulse-dot',
  waiting: 'bg-attention-emphasis',
  pending: 'bg-line',
  failed: 'bg-danger-emphasis',
  rejected: 'bg-danger-emphasis',
  cancelled: 'bg-subtle',
  cancelling: 'bg-subtle',
}

/** Compact 7-segment progress bar for list rows. */
export function MiniStages({ stages, className }: { stages: Stage[]; className?: string }) {
  const current = stages.find((stage) => stage.state !== 'done' && stage.state !== 'pending')
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <div className="flex gap-0.5" role="img" aria-label={stages.map((s) => `${STAGE_LABELS[s.stage]}: ${STATE_LABEL[s.state]}`).join(', ')}>
        {stages.map((stage) => (
          <span key={stage.stage} title={`${STAGE_LABELS[stage.stage]} — ${STATE_LABEL[stage.state]}`} className={cx('h-1.5 w-4 rounded-full', MINI_COLORS[stage.state])} />
        ))}
      </div>
      {current && <span className="text-xs whitespace-nowrap text-muted">{STAGE_LABELS[current.stage]}</span>}
    </div>
  )
}
