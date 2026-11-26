/**
 * Status chips, outcome badges, deltas and tags (docs/ux-review.md §3.6). Labels, tones and icons come from
 * lib/semantics.ts so every page uses the same words and colours.
 *
 * - StatusChip     experiment status: tint + icon/dot + word, sentence case, never wraps
 * - OutcomeBadge   claim check / adoption / likelihood (dashed = predicted) / diagnosis / fidelity
 * - VerdictBadge   compatibility wrapper → OutcomeBadge kind="verdict"
 * - Delta          signed % with ↑/↓ and words for "no clear change"; CI in a Tooltip
 * - Tag            neutral outline (category, mode, doc type, requirement); max 24ch with a Tooltip
 * - CodeToken      flag names, metric ids, branches (nowrap), optionally next to a plain label
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { Effort, ExperimentStatus } from '../api/types'
import { formatAcronyms, formatCI, formatPct, humanize, humanizeMetric } from '../lib/format'
import { assetBlockerItems, needsSentence } from '../lib/assets'
import { isCostModelBlocker } from '../lib/roofline'
import {
  adoptionSemantics,
  claimCheckSemantics,
  diagnosisSemantics,
  fidelitySemantics,
  gainSemantics,
  levelSemantics,
  likelihoodSemantics,
  MODE,
  NEEDS_ASSETS,
  sentenceCase,
  statusSemantics,
  type SemanticInfo,
} from '../lib/semantics'
import { AlertIcon, ArrowDownIcon, ArrowUpIcon, FileIcon, Glyph, SemanticIcon } from './Icons'
import { Tooltip, Truncate } from './Tooltip'
import { CHIP_TARGET, cx, TONE_CLASSES, TONE_TEXT } from './ui'

// ---- status ---------------------------------------------------------------------------------------

export function StatusChip({ status, className, short = false, explain = false }: {
  status: ExperimentStatus | string
  className?: string
  /** Use the short label ("Decide", "Approve") in dense rows. */
  short?: boolean
  /** Show the status description in a Tooltip. */
  explain?: boolean
}) {
  const info = statusSemantics(status)
  const chip = (
    <span className={cx('chip', TONE_CLASSES[info.tone], className)}>
      <SemanticIcon name={info.icon} size={12} className="shrink-0" />
      {short ? (info.short ?? info.label) : info.label}
    </span>
  )
  return explain ? (
    <Tooltip content={info.description} className={CHIP_TARGET}>
      {chip}
    </Tooltip>
  ) : (
    chip
  )
}

// ---- outcomes -------------------------------------------------------------------------------------

export type OutcomeKind = 'verdict' | 'adoption' | 'likelihood' | 'diagnosis' | 'fidelity'

const OUTCOME_SEMANTICS: Record<OutcomeKind, (value: string | null | undefined) => SemanticInfo> = {
  verdict: claimCheckSemantics,
  adoption: adoptionSemantics,
  likelihood: likelihoodSemantics,
  diagnosis: diagnosisSemantics,
  fidelity: fidelitySemantics,
}

/** Label/tone/icon/description for an outcome value (same table the badge uses). */
export function outcomeInfo(kind: OutcomeKind, value: string | null | undefined): SemanticInfo {
  return OUTCOME_SEMANTICS[kind](value)
}

/**
 * Outcome pill: subtle tint + 1px border in the outcome's tone, icon + word (+ optional value). Predictions
 * (`kind="likelihood"`) get a dashed border. Never wraps, never ALL CAPS, AA contrast.
 */
export function OutcomeBadge({ kind, value, detail, size = 'sm', short = false, explain = false, className }: {
  kind: OutcomeKind
  value: string | null | undefined
  /** Number shown after the word, e.g. "+2.8%". */
  detail?: ReactNode
  size?: 'sm' | 'lg'
  short?: boolean
  /** Show the description in a Tooltip (hover, focus, tap). */
  explain?: boolean
  className?: string
}) {
  if (!value) return null
  const info = outcomeInfo(kind, value)
  const badge = (
    <span
      data-outcome={`${kind}:${value}`}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full border font-medium whitespace-nowrap',
        size === 'lg' ? 'px-2.5 py-0.5 text-sm' : 'px-2 py-0.5 text-xs',
        TONE_CLASSES[info.tone],
        kind === 'likelihood' && 'border-dashed border-current/60',
        className,
      )}
    >
      <SemanticIcon name={info.icon} size={size === 'lg' ? 14 : 12} className="shrink-0" />
      {short ? (info.short ?? info.label) : info.label}
      {detail !== undefined && detail !== null && <span className="font-semibold tabular-nums">{detail}</span>}
    </span>
  )
  if (!explain || !info.description) return badge
  return (
    <Tooltip content={info.description} className={cx(CHIP_TARGET, 'shrink-0')}>
      {badge}
    </Tooltip>
  )
}

/** @deprecated use <OutcomeBadge kind="verdict">. Kept for compatibility (sentence case now, never wraps). */
export function VerdictBadge({ verdict, size = 'sm' }: { verdict: string | null | undefined; size?: 'sm' | 'lg' }) {
  return <OutcomeBadge kind="verdict" value={verdict} size={size} explain />
}

/**
 * Improvement in % (positive = better in the metric's own direction), always signed, with ↑/↓.
 * `significant={false}` renders "no clear change" in neutral instead of a coloured number; `ci` adds the
 * 95% CI in a Tooltip.
 */
export function Delta({ value, className, digits = 1, significant, ci, showLabel = false }: {
  value: number | null | undefined
  className?: string
  digits?: number
  significant?: boolean | null
  ci?: [number | null | undefined, number | null | undefined] | null
  /** Always show the word ("better" / "worse"); "no clear change" is always shown. */
  showLabel?: boolean
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return (
      <span className={cx('text-muted', className)}>
        —<span className="sr-text">not measured</span>
      </span>
    )
  }
  const gain = gainSemantics(value, { significant })
  const flat = gain.direction === 'flat' && significant === false
  const content = (
    <span className={cx('inline-flex items-center gap-0.5 font-semibold whitespace-nowrap tabular-nums', TONE_TEXT[gain.tone], className)}>
      {gain.direction === 'up' && <ArrowUpIcon size={12} className="shrink-0" />}
      {gain.direction === 'down' && <ArrowDownIcon size={12} className="shrink-0" />}
      <span>
        {formatPct(value, digits)}
        {!(flat || showLabel) && <span className="sr-text"> ({gain.label})</span>}
      </span>
      {(flat || showLabel) && <span className="ml-1 font-normal text-muted">{gain.label}</span>}
    </span>
  )
  if (!ci || ci[0] === null || ci[0] === undefined || ci[1] === null || ci[1] === undefined) return content
  return (
    <Tooltip content={`95% CI ${formatCI(ci[0], ci[1], digits)}`} className="inline-flex min-h-6 items-center rounded">
      {content}
    </Tooltip>
  )
}

// ---- tags -----------------------------------------------------------------------------------------

/**
 * Neutral outline tag (no fill, no colour meaning). Long labels truncate at `maxCh` with the full text in a
 * Tooltip. With `to`, the tag is a link (hover border only).
 */
export function Tag({ children, icon, to, className, maxCh = 24, title }: {
  children: ReactNode
  icon?: ReactNode
  to?: string
  className?: string
  maxCh?: number
  /** Extra explanation shown in a Tooltip. */
  title?: string
}) {
  const label =
    typeof children === 'string' ? (
      <Truncate className="min-w-0" as="span">
        {children}
      </Truncate>
    ) : (
      children
    )
  const classes = cx('tag', to && 'hover:border-fg hover:text-fg hover:no-underline', className)
  const style = { maxWidth: `${maxCh + 4}ch` }
  const tag = to ? (
    <Link to={to} className={classes} style={style}>
      {icon}
      {label}
    </Link>
  ) : (
    <span className={classes} style={style}>
      {icon}
      {label}
    </span>
  )
  return title ? (
    <Tooltip content={title} className={CHIP_TARGET}>
      {tag}
    </Tooltip>
  ) : (
    tag
  )
}

/** Flag names, metric ids, branches: monospace, never broken mid-token. With `label`, the plain words come first. */
export function CodeToken({ children, label, className }: { children: ReactNode; label?: ReactNode; className?: string }) {
  const code = <code className={cx('code-inline whitespace-nowrap', className)}>{children}</code>
  if (!label) return code
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span>{label}</span>
      {code}
    </span>
  )
}

/** Plain metric name ("Throughput (tokens/s)"), optionally followed by its id as a CodeToken for experts. */
export function MetricName({ metric, showId = false, className }: { metric: string | null | undefined; showId?: boolean; className?: string }) {
  if (!metric) return null
  const plain = humanizeMetric(metric)
  if (!showId || plain === metric) return <span className={className}>{plain}</span>
  return (
    <span className={cx('inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5', className)}>
      <span>{plain}</span>
      <code className="code-inline whitespace-nowrap">{metric}</code>
    </span>
  )
}

/** "Effort: low ●○○" — neutral words and dots, never red/green (effort isn't success). */
export function LevelTag({ kind, level, className }: { kind: 'effort' | 'risk' | 'fit'; level: string | null | undefined; className?: string }) {
  if (!level) return null
  const info = levelSemantics(kind, level)
  return (
    <Tag className={className} title={info.description}>
      <span>{info.label}</span>
      {info.dots > 0 && (
        <span aria-hidden="true" className="ml-0.5 inline-flex gap-0.5">
          {[1, 2, 3].map((dot) => (
            <span key={dot} className={cx('inline-block size-1.5 rounded-full', dot <= info.dots ? 'bg-muted' : 'border border-muted/60')} />
          ))}
        </span>
      )}
    </Tag>
  )
}

export function EffortChip({ effort }: { effort: Effort | string | null | undefined }) {
  return <LevelTag kind="effort" level={effort} />
}

export function CategoryChip({ category }: { category: string | null | undefined }) {
  if (!category) return null
  return <Tag>{sentenceCase(formatAcronyms(humanize(category)))}</Tag>
}

export function BlockerBadge({ blocker }: { blocker: string }) {
  // Cost-model blockers carry their reasons in parentheses; the chip shows the verdict, the tooltip the rest.
  // Pre-screen blockers ("needs assets: a; b") show one label; the tooltip lists what's missing.
  const assets = assetBlockerItems(blocker)
  const label = assets.length ? NEEDS_ASSETS.label : isCostModelBlocker(blocker) ? blocker.replace(/\s*\(.*$/s, '') : blocker
  const content = assets.length ? `${needsSentence(assets)} ${NEEDS_ASSETS.description}` : `Blocked on this project: ${blocker}`
  return (
    <Tooltip content={content} className={CHIP_TARGET}>
      <span className={cx('chip max-w-full', TONE_CLASSES.caution)}>
        <AlertIcon size={12} className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    </Tooltip>
  )
}

export function DocTypeChip({ docType }: { docType: string | null | undefined }) {
  if (docType !== 'patent') return null
  return <Tag icon={<FileIcon size={12} className="shrink-0" />}>Patent</Tag>
}

export function LiveDot({ status }: { status: string }) {
  const label = status === 'open' ? 'Live' : status === 'idle' ? 'Paused' : 'Reconnecting…'
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted">
      <span
        aria-hidden="true"
        className={cx(
          'inline-block size-2 rounded-full',
          status === 'open' ? 'animate-pulse-dot bg-positive-emphasis' : status === 'idle' ? 'bg-neutral-emphasis' : 'bg-caution-emphasis',
        )}
      />
      <span>
        <span className="sr-text">Live updates: </span>
        {label}
      </span>
    </span>
  )
}

/** Re-exported from lib/semantics.ts (MODE). */
export const MODE_INFO: Record<string, { label: string; description: string }> = MODE

/** "Bundle +2" / "Chain" tag for experiments started in a Gate 1 mode other than single. */
export function ModeBadge({ mode, bundleSize = 0, className }: { mode: string | null | undefined; bundleSize?: number; className?: string }) {
  if (!mode || mode === 'single') return null
  const info = MODE_INFO[mode] ?? { label: sentenceCase(humanize(mode)), description: '' }
  return (
    <Tag
      className={className}
      title={info.description || undefined}
      icon={<Glyph name={mode === 'bundle' ? 'batch' : 'flow'} size={12} className="shrink-0" />}
    >
      <span>{info.label}</span>
      {mode === 'bundle' && bundleSize > 0 && <span className="tabular-nums">+{bundleSize}</span>}
    </Tag>
  )
}
