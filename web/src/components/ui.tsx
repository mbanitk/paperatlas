import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../api/client'
import { formatDateTime, relativeTime } from '../lib/format'
import type { Tone } from '../lib/stages'
import { AlertIcon, ExternalIcon, Spinner } from './Icons'

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

// ---- buttons -----------------------------------------------------------------------------

type Variant = 'default' | 'primary' | 'danger' | 'dangerSolid' | 'success' | 'invisible' | 'outline'
const VARIANTS: Record<Variant, string> = {
  default: 'border-line bg-canvas-subtle text-fg hover:bg-canvas-inset',
  primary: 'border-black/10 bg-success-emphasis text-white hover:bg-success',
  success: 'border-black/10 bg-success-emphasis text-white hover:bg-success',
  danger: 'border-line bg-canvas-subtle text-danger hover:border-danger hover:bg-danger-emphasis hover:text-white',
  dangerSolid: 'border-black/10 bg-danger-emphasis text-white hover:bg-danger',
  invisible: 'border-transparent bg-transparent text-accent hover:bg-canvas-inset',
  outline: 'border-line bg-canvas text-accent hover:border-accent hover:bg-accent hover:text-white',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
  loading?: boolean
  icon?: ReactNode
}

export function Button({ variant = 'default', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-55',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
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

// ---- chips -----------------------------------------------------------------------------

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'border-line bg-neutral-subtle text-muted',
  muted: 'border-line-muted bg-canvas-subtle text-subtle',
  accent: 'border-accent/30 bg-accent-subtle text-accent',
  attention: 'border-attention-emphasis/40 bg-attention-subtle text-attention',
  success: 'border-success/30 bg-success-subtle text-success',
  danger: 'border-danger/30 bg-danger-subtle text-danger',
  done: 'border-done/30 bg-done-subtle text-done',
}

export function Chip({ tone = 'neutral', className, children, title }: { tone?: Tone; className?: string; children: ReactNode; title?: string }) {
  return (
    <span className={cx('chip', TONE_CLASSES[tone], className)} title={title}>
      {children}
    </span>
  )
}

export function Counter({ value, tone = 'neutral' }: { value: number; tone?: 'neutral' | 'attention' | 'accent' }) {
  const classes = {
    neutral: 'bg-neutral-subtle text-muted',
    attention: 'bg-attention-emphasis text-white',
    accent: 'bg-accent text-white',
  }[tone]
  return <span className={cx('inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs leading-5 font-semibold', classes)}>{value}</span>
}

// ---- layout bits -----------------------------------------------------------------------

export function Card({ title, actions, children, className, bodyClassName, id }: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  id?: string
}) {
  return (
    <section className={cx('card', className)} id={id} aria-labelledby={id && title ? `${id}-title` : undefined}>
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
      <div className={bodyClassName ?? 'p-4'}>{children}</div>
    </section>
  )
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 border-b border-line-muted pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs text-muted">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
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
            <dd className="mb-2 min-w-0 break-words text-fg @md:mb-0">{value ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
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

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2 py-2" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="h-4 animate-pulse rounded bg-canvas-inset" style={{ width: `${90 - index * 12}%` }} />
      ))}
    </div>
  )
}

export function EmptyState({ title, children, icon, action }: { title: ReactNode; children?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {icon && <div className="mb-3 text-subtle">{icon}</div>}
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

export function ErrorState({ error, onRetry, title = 'Something went wrong' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const notFound = error instanceof ApiError && error.status === 404
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
      <AlertIcon className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{notFound ? 'Not found' : title}</div>
        <div className="mt-0.5 break-words text-fg">{errorMessage(error)}</div>
      </div>
      {onRetry && !notFound && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  )
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p role="alert" className="mt-2 flex items-start gap-1.5 text-sm text-danger">
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

export function RelativeTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const now = useNow()
  if (!iso) return <span className={className}>—</span>
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {relativeTime(iso, now)}
    </time>
  )
}

// ---- links -----------------------------------------------------------------------------

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cx('inline-flex items-center gap-1', className)}>
      {children}
      <ExternalIcon size={12} className="shrink-0 opacity-70" />
      <span className="sr-only">(opens in a new tab)</span>
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

export function Tabs<T extends string>({ tabs, value, onChange, label }: {
  tabs: { value: T; label: ReactNode; count?: number; attention?: boolean }[]
  value: T
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((tab) => {
        const selected = tab.value === value
        return (
          <button
            key={tab.value}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onChange(tab.value)}
            className={cx(
              '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap',
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
        <p id={`${htmlFor}-error`} className="mt-1 text-xs text-danger">
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
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 rounded border-line accent-accent"
      />
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
