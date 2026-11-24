/**
 * Building blocks for the research pages (topics and papers): topic signals (papers per month, sources,
 * claim categories, KPI tiles), the paper's key results, compact claim rows with what has been tested here,
 * and a small action menu for jobs that need a confirm.
 */
import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useRole,
  type Placement,
} from '@floating-ui/react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useTopics } from '../api/queries'
import type { Claim, ExperimentSummary, PaperExplainer, Prediction, Topic, TopicInsights } from '../api/types'
import { formatAcronyms, formatNumber, formatRange, humanize, humanizeMetric, MISSING, pluralize, sanitizeText } from '../lib/format'
import { claimedFigure, formatResultValue, monthLabel as researchMonthLabel, sourceLabel, testedSummary, topicDisplayNames } from '../lib/research'
import { sentenceCase } from '../lib/semantics'
import { CategoryChip, EffortChip, OutcomeBadge, StatusChip, Tag } from './Badges'
import { AlertIcon, ChevronDown } from './Icons'
import { floatingMiddleware, Tooltip, Truncate } from './Tooltip'
import { AnswerBlock, Button, CardHeader, ChipRow, Chip, cx, Disclosure, MathText, StatTile } from './ui'

export const monthLabel = researchMonthLabel

// ---- topic signals -------------------------------------------------------------------------------------

/**
 * Papers per month as bars (HTML, so labels stay 12 px at every width). `sm` is a compact spark with its
 * numbers in a Tooltip; `md` labels every bar with its count and month.
 */
export function SparkBars({ data, size = 'sm', className, caption }: {
  data: TopicInsights['monthly'] | undefined
  size?: 'sm' | 'md'
  className?: string
  /** Text under a `sm` spark, e.g. "Papers per month (last 6)". */
  caption?: ReactNode
}) {
  if (!data?.length) return null
  const months = [...data].sort((a, b) => a.month.localeCompare(b.month))
  const max = Math.max(1, ...months.map((item) => item.papers))
  const summary = months.map((item) => `${monthLabel(item.month)} ${item.papers}`).join(' · ')
  const label = `Papers per month: ${summary}`
  if (size === 'md')
    return (
      <div className={cx('w-full', className)}>
        <ol className="flex h-36 items-end gap-2" aria-label={label}>
          {months.map((item, index) => {
            const last = index === months.length - 1
            return (
              <li key={item.month} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                <span className="text-xs text-muted tabular-nums">{item.papers}</span>
                <span
                  aria-hidden="true"
                  className={cx('w-full max-w-10 rounded-t', last ? 'bg-accent' : 'bg-accent/40')}
                  style={{ height: `${Math.max(2, (item.papers / max) * 96)}px` }}
                />
                <span className="text-xs text-muted">{monthLabel(item.month)}</span>
                <span className="sr-text">
                  {item.papers} papers in {monthLabel(item.month)} {item.month.slice(0, 4)}
                </span>
              </li>
            )
          })}
        </ol>
      </div>
    )
  return (
    <div className={cx('min-w-0', className)}>
      <Tooltip content={summary} focusable={false} className="inline-block rounded-sm">
        <span role="img" aria-label={label} className="flex h-7 items-end gap-1">
          {months.map((item, index) => (
            <span
              key={item.month}
              className={cx('w-2.5 rounded-sm', index === months.length - 1 ? 'bg-accent' : 'bg-accent/40', !item.papers && 'opacity-50')}
              style={{ height: `${item.papers ? Math.max(3, (item.papers / max) * 28) : 1}px` }}
            />
          ))}
        </span>
      </Tooltip>
      {caption && <div className="mt-1 text-xs text-muted">{caption}</div>}
    </div>
  )
}

const SOURCE_COLORS = ['#0969da', '#8250df', '#1a7f37', '#9a6700', '#cf222e', '#59636e', '#1b7c83']

/** Stacked bar of where the papers came from, with a wrapping legend (no hover-only numbers). */
export function SourceMix({ sources, compact = false }: { sources: TopicInsights['sources'] | undefined; compact?: boolean }) {
  if (!sources?.length) return null
  const total = sources.reduce((sum, item) => sum + item.papers, 0) || 1
  const shown = compact ? sources.slice(0, 4) : sources
  const rest = sources.length - shown.length
  return (
    <div>
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-canvas-inset" role="img" aria-label={`Sources: ${sources.map((s) => `${sourceLabel(s.source)} ${s.papers}`).join(', ')}`}>
        {sources.map((item, index) => (
          <span key={item.source} className="min-w-0.5" style={{ width: `${(item.papers / total) * 100}%`, background: SOURCE_COLORS[index % SOURCE_COLORS.length] }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-hidden="true">
        {shown.map((item, index) => (
          <li key={item.source} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className="size-2 shrink-0 rounded-full" style={{ background: SOURCE_COLORS[index % SOURCE_COLORS.length] }} />
            {sourceLabel(item.source)} <span className="font-semibold text-fg tabular-nums">{item.papers}</span>
          </li>
        ))}
        {rest > 0 && <li>+{rest} more</li>}
      </ul>
    </div>
  )
}

const categoryLabel = (category: string) => sentenceCase(formatAcronyms(humanize(category)))

/** Claim categories as neutral tags with their counts (at most `max` visible, then "+N"). */
export function CategoryCounts({ categories, max = 3 }: { categories: TopicInsights['claim_categories'] | undefined; max?: number }) {
  if (!categories?.length) return null
  return (
    <ChipRow
      max={max}
      label="More claim categories"
      items={categories.map((item) => (
        <Tag key={item.category} maxCh={30}>
          <Truncate className="min-w-0">{categoryLabel(item.category)}</Truncate>
          <span className="font-semibold text-fg tabular-nums">{item.claims}</span>
        </Tag>
      ))}
    />
  )
}

/** Claim cards per category: testable (solid) and the rest (light), with the counts in words. */
export function CategoryBars({ categories, max: limit = 6 }: { categories: TopicInsights['claim_categories'] | undefined; max?: number }) {
  if (!categories?.length) return <p className="text-sm text-muted">No claim cards written yet.</p>
  const max = Math.max(...categories.map((item) => item.claims), 1)
  return (
    <div>
      <ul className="space-y-2.5">
        {categories.slice(0, limit).map((item) => (
          <li key={item.category} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <Truncate className="min-w-0 text-fg">{categoryLabel(item.category)}</Truncate>
              <span className="shrink-0 text-xs text-muted tabular-nums">
                {item.testable} of {item.claims} testable
              </span>
            </div>
            <span className="mt-1 flex h-2 overflow-hidden rounded-full bg-canvas-inset" aria-hidden="true">
              <span className="h-full bg-accent" style={{ width: `${(item.testable / max) * 100}%` }} />
              <span className="h-full bg-accent/30" style={{ width: `${((item.claims - item.testable) / max) * 100}%` }} />
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm bg-accent" /> Testable
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm bg-accent/30" /> Not testable
        </span>
      </div>
      {categories.length > limit && <p className="mt-2 text-xs text-muted">+{pluralize(categories.length - limit, 'more category', 'more categories')}</p>}
    </div>
  )
}

/**
 * Topic KPIs as stat tiles. `compact`: the four headline numbers in a 2×2 grid, without context lines.
 * `columns="two"` keeps every tile in two columns (for narrow asides).
 */
export function KpiRow({ insights, compact = false, columns, className }: { insights: TopicInsights; compact?: boolean; columns?: 'two' | 'auto'; className?: string }) {
  const codeShare = insights.papers ? Math.round((insights.with_code / insights.papers) * 100) : 0
  const tiles: { label: string; value: string; context?: string }[] = [
    { label: 'Papers', value: formatNumber(insights.papers, 0), context: insights.patents ? `plus ${pluralize(insights.patents, 'patent')}` : 'papers and articles' },
    { label: 'With code', value: `${codeShare}%`, context: `${formatNumber(insights.with_code, 0)} of ${formatNumber(insights.papers, 0)} link a repo` },
    { label: 'Citations', value: formatNumber(insights.citations, 0), context: 'across all papers' },
    { label: 'Hugging Face upvotes', value: formatNumber(insights.upvotes, 0), context: 'community interest' },
  ]
  if (!compact) {
    tiles.push({ label: 'Summarised', value: formatNumber(insights.distilled, 0), context: 'papers with claim cards' })
    if (insights.median_claimed_gain_pct !== null && insights.median_claimed_gain_pct !== undefined)
      tiles.push({ label: 'Typical claimed gain', value: `+${formatNumber(insights.median_claimed_gain_pct, 0)}%`, context: 'median the papers report' })
  }
  return (
    <div className={cx('grid gap-2', compact || columns === 'two' ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-6', className)}>
      {tiles.map((tile) => (
        <StatTile key={tile.label} label={tile.label} value={tile.value} context={compact ? undefined : tile.context} className={compact ? 'px-3 py-2' : undefined} />
      ))}
    </div>
  )
}

/** Display names for every topic (unique and readable), from the cached topic list. */
export function useTopicNames(): Map<string, string> {
  const topics = useTopics()
  return useMemo(() => topicDisplayNames(topics.data ?? []), [topics.data])
}

/** A topic's name: the display name when the topic list is loaded, otherwise its own name with acronyms fixed. */
export function topicName(topic: Pick<Topic, 'slug' | 'name'>, names: Map<string, string>): string {
  return names.get(topic.slug) ?? sentenceCase(formatAcronyms(topic.name))
}

// ---- action menu ----------------------------------------------------------------------------------------

export interface ActionMenuItem {
  label: ReactNode
  /** One line under the label: what it does and what it costs. */
  description?: ReactNode
  onSelect: () => void
  disabled?: boolean
}

/**
 * Button that opens a short menu of actions (each usually opens a confirm). Arrow keys move, Enter picks,
 * Esc closes and focus returns to the button. Renders in a portal with the shared collision rules.
 */
export function ActionMenu({ label, children, items, icon, placement = 'bottom-end', variant = 'default', size = 'md', className }: {
  /** Accessible name when the trigger shows only an icon. */
  label?: string
  children?: ReactNode
  items: ActionMenuItem[]
  icon?: ReactNode
  placement?: Placement
  variant?: 'default' | 'invisible'
  size?: 'sm' | 'md'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const listRef = useRef<(HTMLElement | null)[]>([])
  const arrowRef = useRef<Element | null>(null)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: floatingMiddleware(arrowRef, 340),
  })
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    useClick(context),
    useDismiss(context),
    useRole(context, { role: 'menu' }),
    useListNavigation(context, { listRef, activeIndex, onNavigate: setActiveIndex, loop: true }),
  ])
  return (
    <>
      <Button
        ref={refs.setReference}
        variant={variant}
        size={size}
        aria-label={label}
        className={className}
        icon={icon}
        {...getReferenceProps()}
      >
        {children}
        {children && <ChevronDown size={14} className={cx('shrink-0 transition-transform', open && 'rotate-180')} />}
      </Button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={0}>
            <div
              ref={refs.setFloating}
              style={{ ...floatingStyles, zIndex: 'var(--z-popover)' }}
              className="w-max min-w-56 overflow-auto rounded-lg border border-line bg-canvas py-1 shadow-lg"
              {...getFloatingProps()}
            >
              {items.map((item, index) => (
                <button
                  key={index}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  tabIndex={activeIndex === index ? 0 : -1}
                  ref={(node) => {
                    listRef.current[index] = node
                  }}
                  className="flex min-h-11 w-full flex-col items-start justify-center gap-0.5 px-3 py-2 text-left text-sm text-fg outline-none hover:bg-canvas-subtle focus-visible:bg-canvas-subtle focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-55"
                  {...getItemProps({
                    onClick() {
                      // Hand focus back to the trigger before a confirm opens, so closing the confirm returns there.
                      setOpen(false)
                      ;(refs.domReference.current as HTMLElement | null)?.focus()
                      window.requestAnimationFrame(() => item.onSelect())
                    },
                  })}
                >
                  <span className="font-medium">{item.label}</span>
                  {item.description && <span className="text-xs text-muted">{item.description}</span>}
                </button>
              ))}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}

// ---- papers: key results --------------------------------------------------------------------------------

/**
 * The paper's key results as stat tiles (the paper's own numbers, in neutral ink). Values wrap and never
 * truncate; each result's setup (baseline, hardware, batch) is one tap away.
 */
export function KeyResults({ results, max = 4, className }: { results: PaperExplainer['key_results']; max?: number; className?: string }) {
  if (!results?.length) return null
  return (
    <ul className={cx('grid grid-cols-2 gap-2 lg:grid-cols-4', className)} aria-label="Key results the paper reports">
      {results.slice(0, max).map((result, index) => (
        <li key={index} className="min-w-0">
          <StatTile
            className="h-full"
            label={sanitizeText(result.label)}
            value={formatResultValue(result.value) || MISSING.value}
            info={result.context ? <span>{sanitizeText(result.context)}</span> : undefined}
          />
        </li>
      ))}
    </ul>
  )
}

/** The headline result of a paper (its first key result) in the reference register: "Paper reports 2.63×". */
export function HeadlineResult({ results, more, className }: { results: PaperExplainer['key_results']; more?: ReactNode; className?: string }) {
  const first = results?.[0]
  if (!first) return null
  return (
    <AnswerBlock
      register="claimed"
      size="md"
      className={className}
      value={formatResultValue(first.value) || MISSING.value}
      confidence={
        <>
          <span className="text-fg">{sanitizeText(first.label)}</span>
          {more && <span className="block">{more}</span>}
        </>
      }
    />
  )
}

// ---- what has been tested here ----------------------------------------------------------------------------

/** "Tested in #5 · Reproduced" (newest experiment, plus how many others), or "Not tested yet". */
export function TestedStatus({ experiments, className, untested = 'Not tested yet' }: { experiments: ExperimentSummary[] | undefined; className?: string; untested?: ReactNode }) {
  const summary = testedSummary(experiments)
  if (!summary.latest) return untested ? <span className={cx('text-xs text-muted', className)}>{untested}</span> : null
  const latest = summary.latest
  return (
    <span className={cx('inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted', className)}>
      <span>
        Tested in{' '}
        <Link to={`/experiments/${latest.id}`} className="inline-flex min-h-6 min-w-6 items-center justify-center font-medium">
          #{latest.id}
        </Link>
        {summary.count > 1 && <> and {pluralize(summary.count - 1, 'other')}</>}
      </span>
      {latest.verdict ? <OutcomeBadge kind="verdict" value={latest.verdict} explain /> : <StatusChip status={latest.status} />}
    </span>
  )
}

// ---- compact claim row -------------------------------------------------------------------------------------

function Requirement({ claim }: { claim: Claim }) {
  const items = [claim.requires_cuda && 'CUDA', claim.requires_multi_gpu && 'multiple GPUs', claim.requires_training && 'training'].filter(Boolean) as string[]
  if (!items.length) return null
  return (
    <Chip tone="caution" title="The paper's setup needs this; it may not run on your hardware.">
      <AlertIcon size={12} className="shrink-0" /> Needs {items.join(', ')}
    </Chip>
  )
}

/**
 * One claim in a list (§3.4): what it is (title + one plain sentence), the paper's number (reference register),
 * the estimate here when known (dashed), what has been tested, then "Explain" on demand.
 */
export function ClaimRow({ claim, order, experiments, prediction, eyebrow, explain, className, id, as = 'h3' }: {
  claim: Claim
  order?: number | null
  experiments?: ExperimentSummary[]
  prediction?: Prediction | null
  eyebrow?: ReactNode
  /** Content of the "Explain" disclosure (diagram, steps, related concepts). */
  explain?: ReactNode
  className?: string
  id?: string
  as?: 'h2' | 'h3' | 'h4'
}) {
  const figure = claimedFigure(claim)
  const headline = claim.explainer?.headline || claim.technique
  const range = prediction?.predicted_gain_pct
  const requires = claim.requires_cuda || claim.requires_multi_gpu || claim.requires_training
  const chips = [
    claim.category && <CategoryChip key="category" category={claim.category} />,
    claim.effort && <EffortChip key="effort" effort={claim.effort} />,
    !claim.testable && (
      <Tag key="testable" title="The claim doesn't describe a change that can be measured on an inference engine.">
        Not testable
      </Tag>
    ),
    requires && <Requirement key="requires" claim={claim} />,
  ].filter(Boolean)
  return (
    <li id={id} className={cx('scroll-mt-24 px-3 py-4 sm:px-4', className)}>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(180px,220px)] md:gap-4">
        <div className="min-w-0">
          <CardHeader
            as={as}
            eyebrow={eyebrow}
            title={
              <Link to={`/research/claims/${claim.id}`} className="inline-block text-fg hover:text-accent">
                {order != null && <span className="mr-1.5 text-muted tabular-nums">{order}.</span>}
                <MathText>{claim.name}</MathText>
              </Link>
            }
            summary={headline ? <MathText>{sanitizeText(headline)}</MathText> : undefined}
          />
          {chips.length > 0 && <ChipRow className="mt-2" items={chips} label="More about this claim" />}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <AnswerBlock
            register="claimed"
            size="md"
            value={figure?.value ?? <span className="text-body text-muted">{MISSING.claim}</span>}
            confidence={figure?.metric ? humanizeMetric(figure.metric) : undefined}
          />
          {range && (
            <AnswerBlock
              register="predicted"
              size="md"
              value={formatRange(range.low, range.high)}
              badge={<OutcomeBadge kind="likelihood" value={prediction?.likelihood} short explain />}
            />
          )}
          <TestedStatus experiments={experiments} />
        </div>
      </div>
      {explain && (
        <Disclosure label="Explain" className="mt-2">
          {explain}
        </Disclosure>
      )}
    </li>
  )
}
