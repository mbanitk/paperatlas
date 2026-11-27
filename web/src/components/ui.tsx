import {
  Children,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { Link } from 'react-router'
import { ApiError } from '../api/client'
import { formatDateTime, parseMath, relativeTime } from '../lib/format'
import { REGISTER, semanticTone, type Register, type Tone } from '../lib/semantics'
import { AlertIcon, ChevronRight, ExternalIcon, PaperIcon, Spinner } from './Icons'
import { InfoPopover, Tooltip, Truncate } from './Tooltip'

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

// ---- buttons -----------------------------------------------------------------------------

type Variant = 'default' | 'primary' | 'danger' | 'dangerSolid' | 'success' | 'invisible' | 'outline'
const VARIANTS: Record<Variant, string> = {
  default: 'border-line bg-canvas-subtle text-fg hover:bg-canvas-inset',
  primary: 'border-black/10 bg-success-emphasis text-white hover:bg-success',
  success: 'border-black/10 bg-success-emphasis text-white hover:bg-success',
  danger: 'border-line bg-canvas-subtle text-negative-fg hover:border-danger hover:bg-danger-emphasis hover:text-white',
  dangerSolid: 'border-black/10 bg-danger-emphasis text-white hover:bg-danger',
  invisible: 'border-transparent bg-transparent text-info-fg hover:bg-canvas-inset',
  outline: 'border-line bg-canvas text-info-fg hover:border-accent hover:bg-accent hover:text-white',
}
const SOLID: Variant[] = ['primary', 'success', 'dangerSolid']

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  /** sm 28px · md 32px · lg 40px. Solid (primary) md/lg buttons grow to 44px below 640px. */
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: ReactNode
  ref?: Ref<HTMLButtonElement>
}

export function Button({ variant = 'default', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-55',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : size === 'lg' ? 'h-10 px-4 text-sm' : 'h-8 px-3 text-sm',
        size !== 'sm' && SOLID.includes(variant) && 'max-sm:h-11 max-sm:px-4',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : icon}
      {children}
    </button>
  )
}

/** Icon-only button with a ≥ 28px hit area, an accessible name and a Tooltip carrying the same label. */
export function IconButton({ label, icon, className, size = 'md', ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  label: string
  icon: ReactNode
  size?: 'sm' | 'md'
}) {
  return (
    <Tooltip content={label} asChild>
      <button
        type="button"
        aria-label={label}
        className={cx(
          'inline-flex shrink-0 items-center justify-center rounded-md text-muted hover:bg-canvas-inset hover:text-fg disabled:cursor-not-allowed disabled:opacity-55',
          size === 'sm' ? 'size-7' : 'size-8',
          className,
        )}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

// ---- chips -----------------------------------------------------------------------------

const SEMANTIC_CHIP: Record<Exclude<Tone, 'accent' | 'attention' | 'success' | 'danger' | 'done' | 'muted'>, string> = {
  positive: 'border-positive/30 bg-positive-subtle text-positive-fg',
  negative: 'border-negative/30 bg-negative-subtle text-negative-fg',
  caution: 'border-caution-emphasis/60 bg-caution-subtle text-caution-fg',
  info: 'border-info/30 bg-info-subtle text-info-fg',
  neutral: 'border-line bg-neutral-subtle text-neutral-fg',
  merged: 'border-merged/30 bg-merged-subtle text-merged-fg',
  reference: 'border-line bg-canvas-subtle text-fg',
}

/** Subtle tint + border + AA text for every tone. Legacy names map onto the semantic ones. */
export const TONE_CLASSES: Record<Tone, string> = {
  ...SEMANTIC_CHIP,
  accent: SEMANTIC_CHIP.info,
  attention: SEMANTIC_CHIP.caution,
  success: SEMANTIC_CHIP.positive,
  danger: SEMANTIC_CHIP.negative,
  done: SEMANTIC_CHIP.merged,
  muted: 'border-line-muted bg-canvas-subtle text-muted',
}

/** Text colour only (for icons and inline words) per tone. */
export const TONE_TEXT: Record<Tone, string> = {
  positive: 'text-positive-fg',
  negative: 'text-negative-fg',
  caution: 'text-caution-fg',
  info: 'text-info-fg',
  neutral: 'text-muted',
  merged: 'text-merged-fg',
  reference: 'text-fg',
  accent: 'text-info-fg',
  attention: 'text-caution-fg',
  success: 'text-positive-fg',
  danger: 'text-negative-fg',
  done: 'text-merged-fg',
  muted: 'text-muted',
}

/** Focusable wrapper around a chip that carries a Tooltip: a 24px-tall hit area (WCAG 2.5.8) around the 22px pill. */
export const CHIP_TARGET = 'inline-flex min-h-6 max-w-full min-w-0 items-center rounded-full'

/**
 * Sentence-case pill. `title` is shown in an accessible Tooltip (hover, focus, tap), not as a native title.
 */
export function Chip({ tone = 'neutral', className, children, title }: { tone?: Tone; className?: string; children: ReactNode; title?: string }) {
  const chip = <span className={cx('chip', TONE_CLASSES[tone], className)}>{children}</span>
  if (!title) return chip
  return (
    <Tooltip content={title} className={CHIP_TARGET}>
      {chip}
    </Tooltip>
  )
}

export function Counter({ value, tone = 'neutral' }: { value: number; tone?: 'neutral' | 'attention' | 'accent' | 'caution' | 'info' }) {
  const t = semanticTone(tone)
  const classes =
    t === 'caution'
      ? 'border-caution-emphasis bg-caution-subtle text-caution-fg'
      : t === 'info'
        ? 'border-transparent bg-accent text-white'
        : 'border-transparent bg-neutral-subtle text-muted'
  return (
    <span className={cx('inline-flex min-w-5 items-center justify-center rounded-full border px-1.5 text-xs leading-[18px] font-semibold tabular-nums', classes)}>
      {value}
    </span>
  )
}

/**
 * Up to `max` chips/tags, then a "+N" button that lists the rest in a popover (§3.6: at most 3 visible).
 */
export function ChipRow({ items, max = 3, label = 'More tags', className }: { items: ReactNode[]; max?: number; label?: string; className?: string }) {
  const list = Children.toArray(items).filter(Boolean)
  if (!list.length) return null
  const visible = list.slice(0, max)
  const rest = list.slice(max)
  return (
    <div className={cx('flex min-w-0 flex-wrap items-center gap-1.5', className)}>
      {visible}
      {rest.length > 0 && (
        <InfoPopover
          label={`${label}: ${rest.length} more`}
          triggerClassName="inline-flex h-6 items-center rounded-full border border-line bg-canvas px-2 text-xs font-medium text-muted hover:border-fg hover:text-fg"
          content={<div className="flex max-w-72 flex-wrap gap-1.5">{rest}</div>}
        >
          +{rest.length}
        </InfoPopover>
      )}
    </div>
  )
}

// ---- layout bits -----------------------------------------------------------------------

export function Card({ title, actions, children, className, bodyClassName, id, attention, selected }: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  id?: string
  /** A gate that needs the user: caution ring. */
  attention?: boolean
  /** Selected (e.g. picked for testing): info ring. */
  selected?: boolean
}) {
  return (
    <section
      className={cx(
        'card',
        attention && 'border-caution-emphasis/70 ring-1 ring-caution-emphasis/40',
        selected && 'border-info ring-1 ring-info/40',
        className,
      )}
      id={id}
      aria-labelledby={id && title ? `${id}-title` : undefined}
    >
      {(title || actions) && (
        <header className="card-header">
          {title && (
            <h2 className="card-title" id={id ? `${id}-title` : undefined}>
              {title}
            </h2>
          )}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName ?? 'p-3 sm:p-4'}>{children}</div>
    </section>
  )
}

export interface Crumb {
  label: ReactNode
  to?: string
}

export function Breadcrumb({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm text-muted">
        {items.map((item, index) => {
          const last = index === items.length - 1
          return (
            <li key={index} className="inline-flex min-w-0 items-center gap-1">
              {item.to && !last ? (
                <Link to={item.to} className="text-muted hover:text-accent">
                  {item.label}
                </Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={last ? 'text-fg' : undefined}>
                  {item.label}
                </span>
              )}
              {!last && <ChevronRight size={12} className="shrink-0 text-muted" />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * Page title block. `answer` is the one-sentence bottom line under the title (BLUF, §2.1); `breadcrumb` and
 * `level="object"` are for detail pages whose object title is the h1 (20/28 instead of 24/32).
 */
export function PageHeader({ title, description, actions, eyebrow, answer, breadcrumb, level = 'page' }: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  eyebrow?: ReactNode
  answer?: ReactNode
  breadcrumb?: Crumb[] | ReactNode
  level?: 'page' | 'object'
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 border-b border-line-muted pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-2">{Array.isArray(breadcrumb) ? <Breadcrumb items={breadcrumb as Crumb[]} /> : breadcrumb}</div>}
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h1 className={cx('text-fg [overflow-wrap:anywhere]', level === 'object' ? 'text-title' : 'text-page tracking-tight')}>{title}</h1>
        {answer && <p className="mt-2 max-w-3xl text-body-lg text-fg">{answer}</p>}
        {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * Card / list-row header in the §3.4 order: eyebrow → title → one plain sentence, with the status chip on the
 * right and actions below. `summaryLines` clamps the sentence (full text in a Tooltip) for lists.
 */
export function CardHeader({ eyebrow, title, summary, status, actions, as: Heading = 'h3', titleId, summaryLines }: {
  eyebrow?: ReactNode
  title: ReactNode
  summary?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  as?: 'h2' | 'h3' | 'h4'
  titleId?: string
  summaryLines?: number
}) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {eyebrow && <div className="eyebrow mb-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">{eyebrow}</div>}
          <Heading id={titleId} className="text-body-lg font-semibold text-fg [overflow-wrap:anywhere]">
            {title}
          </Heading>
          {summary &&
            (summaryLines && typeof summary === 'string' ? (
              <Truncate lines={summaryLines} as="div" className="mt-1 text-sm text-muted">
                {summary}
              </Truncate>
            ) : (
              <p className="mt-1 text-sm text-muted">{summary}</p>
            ))}
        </div>
        {status && <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{status}</div>}
      </div>
      {actions && <div className="mt-3 flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  )
}

const REGISTER_CLASSES: Record<Register, string> = {
  claimed: 'border border-line bg-canvas-subtle',
  predicted: 'border border-dashed border-info/70 bg-canvas',
  measured: '',
}

const MEASURED_CLASSES: Record<string, string> = {
  positive: 'border border-positive/30 bg-positive-subtle',
  negative: 'border border-negative/30 bg-negative-subtle',
  caution: 'border border-caution-emphasis/50 bg-caution-subtle',
  info: 'border border-info/30 bg-info-subtle',
  neutral: 'border border-line bg-neutral-subtle',
  merged: 'border border-merged/30 bg-merged-subtle',
  reference: 'border border-line bg-canvas-subtle',
}

/**
 * The answer number of a card or panel, in one of three registers (§2.4):
 * `claimed` (paper's number: neutral ink + paper icon, never green), `predicted` (cost model: dashed outline)
 * and `measured` (A/B result here: solid tint by outcome `tone`). The value wraps, it never truncates.
 */
export function AnswerBlock({ register, value, unit, label, tone = 'neutral', confidence, badge, size = 'lg', className }: {
  register: Register
  value: ReactNode
  unit?: ReactNode
  /** Defaults to "Paper reports" / "Expected here" / "Measured here". */
  label?: ReactNode
  /** Outcome tone (measured register only). */
  tone?: Tone
  /** CI, likelihood, fidelity, sample size… (12px). */
  confidence?: ReactNode
  /** Outcome or likelihood badge shown next to the value. */
  badge?: ReactNode
  size?: 'lg' | 'md'
  className?: string
}) {
  const t = semanticTone(tone)
  const container = register === 'measured' ? MEASURED_CLASSES[t] : REGISTER_CLASSES[register]
  const valueTone = register === 'measured' && t !== 'neutral' ? cx(TONE_TEXT[t]) : 'text-fg'
  return (
    <div className={cx('min-w-0 rounded-lg px-3 py-2', container, className)} data-register={register}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted">
        {register === 'claimed' && <PaperIcon size={14} className="shrink-0" />}
        {label ?? REGISTER[register].label}
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={cx('tabular-nums [overflow-wrap:anywhere]', size === 'lg' ? 'text-metric' : 'text-metric-sm', valueTone)}>{value}</span>
        {unit && <span className="text-sm text-muted">{unit}</span>}
        {badge && <span className="self-center">{badge}</span>}
      </div>
      {confidence && <div className="mt-1 text-xs text-muted">{confidence}</div>}
    </div>
  )
}

/**
 * Labelled stat (§3.9): label → value → context → delta. The value never truncates; the whole tile is a link
 * when `to` is set. `attention` gives it the caution ring used for "needs you".
 */
export function StatTile({ label, value, context, delta, to, attention, className, info, fill }: {
  label: ReactNode
  value: ReactNode
  context?: ReactNode
  delta?: ReactNode
  to?: string
  attention?: boolean
  className?: string
  /** Optional explanation in an InfoPopover next to the label. */
  info?: ReactNode
  /** Stretch to the height of its grid cell, so tiles side by side are the same size. */
  fill?: boolean
}) {
  const body = (
    <>
      <div className={cx('text-xs font-medium text-muted', info ? 'pr-6' : null)}>{label}</div>
      <div className="mt-1 text-metric-sm tabular-nums text-fg [overflow-wrap:anywhere]">{value ?? <span className="text-muted">—</span>}</div>
      {delta && <div className="mt-0.5 text-sm">{delta}</div>}
      {context && <div className="mt-1 text-xs text-muted">{context}</div>}
    </>
  )
  const classes = cx(
    'block min-w-0 rounded-lg border bg-canvas p-3',
    attention ? 'border-caution-emphasis/70 ring-1 ring-caution-emphasis/40' : 'border-line',
    to && 'text-fg transition-colors hover:border-accent hover:no-underline',
    fill && 'h-full',
    className,
  )
  return (
    <div className={cx('relative min-w-0', fill && 'h-full')}>
      {to ? (
        <Link to={to} className={classes}>
          {body}
        </Link>
      ) : (
        <div className={classes}>{body}</div>
      )}
      {info && (
        <span className="absolute top-1.5 right-1.5">
          <InfoPopover content={info} label={typeof label === 'string' ? `About ${label.toLowerCase()}` : 'About this number'} />
        </span>
      )}
    </div>
  )
}

/**
 * Labelled disclosure (Explain ▸ / Evidence ▸ / Raw ▸). Native <details>, so it works without JS and with
 * find-in-page. Children render lazily on first open.
 */
export function Disclosure({ label, children, defaultOpen = false, open, onToggle, meta, className, summaryClassName, id, lazy = true }: {
  label: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  /** Controlled open state (pair with onToggle). */
  open?: boolean
  onToggle?: (open: boolean) => void
  /** Extra text after the label (counts, hints). */
  meta?: ReactNode
  className?: string
  summaryClassName?: string
  id?: string
  lazy?: boolean
}) {
  const [opened, setOpened] = useState(open ?? defaultOpen)
  const isOpen = open ?? undefined
  return (
    <details
      id={id}
      className={cx('group', className)}
      open={isOpen ?? (defaultOpen || undefined)}
      onToggle={(event) => {
        const next = event.currentTarget.open
        if (next) setOpened(true)
        onToggle?.(next)
      }}
    >
      <summary
        className={cx(
          'inline-flex min-h-7 cursor-pointer list-none items-center gap-1 rounded-md text-sm font-medium text-info-fg select-none hover:underline [&::-webkit-details-marker]:hidden',
          summaryClassName,
        )}
      >
        <ChevronRight size={14} className="shrink-0 transition-transform group-open:rotate-90" />
        {label}
        {meta && <span className="font-normal text-muted">{meta}</span>}
      </summary>
      <div className="mt-2">{!lazy || opened || isOpen ? children : null}</div>
    </details>
  )
}

/** Term/value list: two columns when its container is wide enough, stacked otherwise (container query). */
export function DefinitionList({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <div className={cx('@container', className)}>
      <dl className="grid grid-cols-1 text-sm @md:grid-cols-[minmax(110px,max-content)_1fr] @md:gap-x-4 @md:gap-y-1.5">
        {items.map(([term, value], index) => (
          <div key={index} className="contents">
            <dt className="text-xs font-medium text-muted @md:text-sm @md:font-normal">{term}</dt>
            <dd className="mb-2 min-w-0 break-words text-fg @md:mb-0">{value ?? <span className="text-muted">Not reported</span>}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** Text with LaTeX-style math rendered as real superscripts/subscripts: "4^{-b} penalty" → 4<sup>−b</sup> penalty. */
export function MathText({ children, className }: { children: string | null | undefined; className?: string }) {
  const segments = parseMath(children)
  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.kind === 'sup' ? (
          <sup key={index} className="text-[0.86em]">
            {segment.text}
          </sup>
        ) : segment.kind === 'sub' ? (
          <sub key={index} className="text-[0.86em]">
            {segment.text}
          </sub>
        ) : (
          segment.text
        ),
      )}
    </span>
  )
}

// ---- states ----------------------------------------------------------------------------

export function Loading({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={cx('flex items-center justify-center gap-2 py-10 text-sm text-muted', className)} role="status" aria-live="polite">
      <Spinner />
      {label}
    </div>
  )
}

/**
 * Content-shaped placeholder (§3.10). `text` (default) draws lines; `card`, `row` and `chart` draw the shape
 * of what's coming. `count` repeats it.
 */
export function Skeleton({ lines = 3, variant = 'text', count = 1, className }: { lines?: number; variant?: 'text' | 'card' | 'row' | 'chart'; count?: number; className?: string }) {
  const bar = 'animate-pulse rounded bg-canvas-inset'
  const one = (key: number) => {
    if (variant === 'card')
      return (
        <div key={key} className="rounded-lg border border-line-muted p-4">
          <div className={cx(bar, 'h-3 w-1/4')} />
          <div className={cx(bar, 'mt-2 h-5 w-3/4')} />
          <div className={cx(bar, 'mt-2 h-4 w-full')} />
          <div className={cx(bar, 'mt-3 h-10 w-1/3')} />
        </div>
      )
    if (variant === 'row')
      return (
        <div key={key} className="flex items-center gap-3 border-b border-line-muted py-3">
          <div className={cx(bar, 'h-4 w-10')} />
          <div className={cx(bar, 'h-4 flex-1')} />
          <div className={cx(bar, 'h-5 w-20 rounded-full')} />
        </div>
      )
    if (variant === 'chart') return <div key={key} className={cx(bar, 'h-40 w-full rounded-lg')} />
    return (
      <div key={key} className="space-y-2 py-2">
        {Array.from({ length: lines }, (_, index) => (
          <div key={index} className={cx(bar, 'h-4')} style={{ width: `${90 - index * 12}%` }} />
        ))}
      </div>
    )
  }
  return (
    <div className={cx(variant !== 'text' && 'space-y-3', className)} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => one(index))}
    </div>
  )
}

export function EmptyState({ title, children, icon, action, secondaryAction }: {
  title: ReactNode
  children?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  secondaryAction?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {icon && <div className="mb-3 text-muted">{icon}</div>}
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {(action || secondaryAction) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  )
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/** A plain-language sentence for an error (the raw message goes under "Technical details"). */
export function plainError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'The PaperAtlas gateway didn’t respond. Check that the services are running, then retry.'
    if (error.status === 404) return 'We couldn’t find this. It may have been removed, or the link is wrong.'
    if (error.status >= 500) return 'The server ran into a problem while loading this.'
    return error.message
  }
  return 'Something went wrong while loading this.'
}

function technicalDetails(error: unknown): string {
  const lines: string[] = []
  if (error instanceof ApiError) {
    if (error.status) lines.push(`HTTP ${error.status}`)
    lines.push(error.message)
    if (error.detail && typeof error.detail === 'object') lines.push(JSON.stringify(error.detail, null, 2))
  } else lines.push(errorMessage(error))
  return lines.join('\n')
}

/**
 * Error block (§3.10): a plain sentence first, then Retry, then a "Technical details" disclosure with the raw
 * message and status.
 */
export function ErrorState({ error, onRetry, title = 'Something went wrong' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const notFound = error instanceof ApiError && error.status === 404
  const plain = plainError(error)
  const technical = technicalDetails(error)
  return (
    <div role="alert" className="rounded-lg border border-negative/30 bg-negative-subtle px-4 py-3 text-sm">
      <div className="flex flex-wrap items-start gap-3">
        <AlertIcon className="mt-0.5 shrink-0 text-negative-fg" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-negative-fg">{notFound ? 'Not found' : title}</div>
          <p className="mt-0.5 break-words text-fg">{plain}</p>
          {technical && technical !== plain && (
            <details className="mt-1.5">
              <summary className="inline-flex min-h-6 cursor-pointer items-center text-xs font-medium text-muted">Technical details</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-canvas/70 p-2 font-mono text-xs whitespace-pre-wrap break-words text-fg">{technical}</pre>
            </details>
          )}
        </div>
        {onRetry && !notFound && (
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  )
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p role="alert" className="mt-2 flex items-start gap-1.5 text-sm text-negative-fg">
      <AlertIcon className="mt-0.5 shrink-0" size={14} />
      <span className="break-words">{errorMessage(error)}</span>
    </p>
  )
}

export function Banner({ tone = 'accent', icon, children, action }: { tone?: Tone; icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx('flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm', TONE_CLASSES[tone])}>
      {icon}
      <div className="min-w-0 flex-1 text-fg">{children}</div>
      {action}
    </div>
  )
}

// ---- time -----------------------------------------------------------------------------

let tickListeners = new Set<() => void>()
let tickTimer: ReturnType<typeof setInterval> | undefined

function subscribeTick(listener: () => void) {
  tickListeners.add(listener)
  if (!tickTimer) tickTimer = setInterval(() => tickListeners.forEach((fn) => fn()), 30_000)
  return () => {
    tickListeners.delete(listener)
    if (!tickListeners.size && tickTimer) {
      clearInterval(tickTimer)
      tickTimer = undefined
      tickListeners = new Set()
    }
  }
}

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => subscribeTick(() => setNow(Date.now())), [])
  return now
}

/** "5 min ago", with the exact date and time in a Tooltip (hover or tap). */
export function RelativeTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const now = useNow()
  if (!iso) return <span className={className}>—</span>
  return (
    <Tooltip content={formatDateTime(iso)} focusable={false}>
      <time dateTime={iso} className={className}>
        {relativeTime(iso, now)}
      </time>
    </Tooltip>
  )
}

// ---- links -----------------------------------------------------------------------------

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cx('inline-flex items-center gap-1', className)}>
      {children}
      <ExternalIcon size={12} className="shrink-0 opacity-70" />
      <span className="sr-text">(opens in a new tab)</span>
    </a>
  )
}

export function PaperLink({ paperId, title, className }: { paperId: string; title: ReactNode; className?: string }) {
  return (
    <Link to={`/research/papers/${paperId.split('/').map(encodeURIComponent).join('/')}`} className={className}>
      {title}
    </Link>
  )
}

// ---- tabs ------------------------------------------------------------------------------

const tabDomId = (base: string, value: string) => `${base}-tab-${value.replace(/[^\w-]/g, '_')}`
const panelDomId = (base: string, value: string) => `${base}-panel-${value.replace(/[^\w-]/g, '_')}`

/**
 * Tab list with roving focus: ←/→ move between tabs (and select them), Home/End jump to the ends. Pass `id`
 * and render the content in <TabPanel tabsId={id} value={value}> to link tab ↔ panel for screen readers.
 */
export function Tabs<T extends string>({ tabs, value, onChange, label, id }: {
  tabs: { value: T; label: ReactNode; count?: number; attention?: boolean }[]
  value: T
  onChange: (value: T) => void
  label: string
  id?: string
}) {
  const fallbackId = useId()
  const base = id ?? `tabs${fallbackId.replace(/[^\w-]/g, '')}`
  const listRef = useRef<HTMLDivElement>(null)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.value === value)
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    onChange(tabs[next].value)
    listRef.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabDomId(base, tabs[next].value))}`)?.focus()
  }

  return (
    <div ref={listRef} role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((tab) => {
        const selected = tab.value === value
        return (
          <button
            key={tab.value}
            id={tabDomId(base, tab.value)}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={id ? panelDomId(base, tab.value) : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cx(
              '-mb-px inline-flex min-h-10 items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap',
              selected ? 'border-[#fd8c73] font-semibold text-fg' : 'border-transparent text-muted hover:border-line hover:text-fg',
            )}
          >
            {tab.label}
            {tab.count !== undefined && <Counter value={tab.count} tone={tab.attention && tab.count > 0 ? 'attention' : 'neutral'} />}
          </button>
        )
      })}
    </div>
  )
}

/** Panel for <Tabs id=…>; pass the same id and the tab value it belongs to. */
export function TabPanel({ tabsId, value, children, className }: { tabsId: string; value: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={panelDomId(tabsId, value)} aria-labelledby={tabDomId(tabsId, value)} tabIndex={0} className={cx('focus-visible:outline-offset-4', className)}>
      {children}
    </div>
  )
}

// ---- forms -----------------------------------------------------------------------------

export function Field({ label, htmlFor, hint, error, children, className }: {
  label: ReactNode
  htmlFor: string
  hint?: ReactNode
  error?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="label">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="mt-1 text-xs text-negative-fg">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${htmlFor}-hint`} className="mt-1 text-xs text-muted">
            {hint}
          </p>
        )
      )}
    </div>
  )
}

/** Checkbox with a 24×24 hit area (the `.checkbox` class) and a clickable label. */
export function Checkbox({ id, checked, onChange, label, disabled, description }: {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  disabled?: boolean
  description?: ReactNode
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="flex h-5 shrink-0 items-center">
        <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="checkbox" />
      </span>
      <label htmlFor={id} className={cx('text-sm', disabled && 'text-muted')}>
        {label}
        {description && <span className="block text-xs text-muted">{description}</span>}
      </label>
    </div>
  )
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= limit) return null
  const page = Math.floor(offset / limit) + 1
  const pages = Math.ceil(total / limit)
  return (
    <nav className="flex items-center justify-between gap-2 pt-3 text-sm" aria-label="Pagination">
      <span className="text-muted">
        {offset + 1}–{Math.min(total, offset + limit)} of {total}
      </span>
      <div className="flex gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))}>
          Previous
        </Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onChange(offset + limit)}>
          Next
        </Button>
      </div>
    </nav>
  )
}

/** Debounced value for search inputs. */
export function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}
