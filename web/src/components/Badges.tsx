import type { Effort, ExperimentStatus } from '../api/types'
import { formatPct, humanize } from '../lib/format'
import { statusInfo, verdictInfo, type Tone } from '../lib/stages'
import { AlertIcon, CheckIcon, MergeIcon, XIcon } from './Icons'
import { Chip, cx } from './ui'

export function StatusChip({ status, className }: { status: ExperimentStatus | string; className?: string }) {
  const info = statusInfo(status)
  return (
    <Chip tone={info.tone} className={className}>
      {status === 'merged' ? (
        <MergeIcon size={12} />
      ) : status === 'failed' ? (
        <XIcon size={12} />
      ) : (
        <span
          aria-hidden="true"
          className={cx('inline-block size-1.5 rounded-full bg-current', info.busy && 'animate-pulse-dot')}
        />
      )}
      {info.label}
    </Chip>
  )
}

export function VerdictBadge({ verdict, size = 'sm' }: { verdict: string | null | undefined; size?: 'sm' | 'lg' }) {
  if (!verdict) return null
  const info = verdictInfo(verdict)
  const solid: Record<Tone, string> = {
    success: 'bg-success-emphasis text-white border-transparent',
    attention: 'bg-attention-emphasis text-white border-transparent',
    neutral: 'bg-muted text-white border-transparent',
    danger: 'bg-danger-emphasis text-white border-transparent',
    accent: 'bg-accent text-white border-transparent',
    done: 'bg-done text-white border-transparent',
    muted: 'bg-subtle text-white border-transparent',
  }
  return (
    <span
      title={info.description}
      className={cx(
        'inline-flex items-center gap-1 rounded-full border font-semibold tracking-wide uppercase',
        size === 'lg' ? 'px-3 py-1 text-xs' : 'px-2 py-0.5 text-[10.5px]',
        solid[info.tone],
      )}
    >
      {verdict === 'reproduced' ? <CheckIcon size={12} /> : verdict === 'regression' ? <AlertIcon size={12} /> : null}
      {info.label}
    </span>
  )
}

/** Improvement in % (positive = better in the metric's own direction). */
export function Delta({ value, className, digits = 1 }: { value: number | null | undefined; className?: string; digits?: number }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={cx('text-muted', className)}>—</span>
  const tone = value > 0.05 ? 'text-success' : value < -0.05 ? 'text-danger' : 'text-muted'
  return <span className={cx('font-semibold tabular-nums', tone, className)}>{formatPct(value, digits)}</span>
}

export function EffortChip({ effort }: { effort: Effort | string | null | undefined }) {
  if (!effort) return null
  const tone: Tone = effort === 'low' ? 'success' : effort === 'high' ? 'danger' : 'attention'
  return (
    <Chip tone={tone} title="Implementation effort estimated from the paper">
      {effort} effort
    </Chip>
  )
}

export function CategoryChip({ category }: { category: string | null | undefined }) {
  if (!category) return null
  return <Chip tone="accent">{humanize(category)}</Chip>
}

export function BlockerBadge({ blocker }: { blocker: string }) {
  return (
    <Chip tone="attention" title="Blocked on this project">
      <AlertIcon size={12} />
      {blocker}
    </Chip>
  )
}

export function DocTypeChip({ docType }: { docType: string | null | undefined }) {
  if (docType !== 'patent') return null
  return <Chip tone="done">patent</Chip>
}

export function LiveDot({ status }: { status: string }) {
  const label = status === 'open' ? 'Live' : status === 'idle' ? 'Paused' : 'Reconnecting…'
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" title={`Live updates: ${label}`}>
      <span
        aria-hidden="true"
        className={cx(
          'inline-block size-2 rounded-full',
          status === 'open' ? 'animate-pulse-dot bg-success-emphasis' : status === 'idle' ? 'bg-subtle' : 'bg-attention-emphasis',
        )}
      />
      {label}
    </span>
  )
}

export const MODE_INFO: Record<string, { label: string; description: string }> = {
  single: { label: 'Single', description: 'Tests only this claim.' },
  bundle: { label: 'Bundle', description: 'Implements the claim together with its prerequisites in one experiment.' },
  chain: { label: 'Chain', description: 'Part of a chain: prerequisites are tested and merged first; dependents start when they are merged.' },
}

/** "Bundle +2" / "Chain" chip for experiments started in a Gate 1 mode other than single. */
export function ModeBadge({ mode, bundleSize = 0, className }: { mode: string | null | undefined; bundleSize?: number; className?: string }) {
  if (!mode || mode === 'single') return null
  const info = MODE_INFO[mode] ?? { label: humanize(mode), description: '' }
  return (
    <Chip tone="done" className={className} title={info.description}>
      {info.label}
      {mode === 'bundle' && bundleSize > 0 && <span className="tabular-nums">+{bundleSize}</span>}
    </Chip>
  )
}
