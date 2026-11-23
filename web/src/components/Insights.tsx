import type { TopicInsights } from '../api/types'
import { formatNumber, humanize } from '../lib/format'
import { cx } from './ui'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const monthLabel = (key: string) => MONTHS[Number(key.slice(5, 7)) - 1] ?? key

/** Papers per month as tiny bars (last month highlighted). */
export function SparkBars({ data, size = 'sm', className }: { data: TopicInsights['monthly'] | undefined; size?: 'sm' | 'md'; className?: string }) {
  if (!data?.length) return null
  const max = Math.max(1, ...data.map((item) => item.papers))
  const md = size === 'md'
  const barW = md ? 26 : 10
  const gap = md ? 10 : 4
  const h = md ? 64 : 26
  const labelH = md ? 16 : 0
  const valueH = md ? 13 : 0
  const width = data.length * barW + (data.length - 1) * gap
  const height = h + labelH + valueH
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cx('block max-w-full', className)}
      role="img"
      aria-label={`Papers per month: ${data.map((item) => `${monthLabel(item.month)} ${item.papers}`).join(', ')}`}
    >
      {data.map((item, index) => {
        const barH = item.papers ? Math.max(2, (item.papers / max) * h) : 1
        const x = index * (barW + gap)
        const last = index === data.length - 1
        return (
          <g key={item.month}>
            <title>{`${monthLabel(item.month)} ${item.month.slice(0, 4)}: ${item.papers} papers`}</title>
            <rect x={x} y={valueH + h - barH} width={barW} height={barH} rx={md ? 3 : 1.5} fill={last ? '#0969da' : '#9ecbff'} opacity={item.papers ? 1 : 0.5} />
            {md && (
              <>
                <text x={x + barW / 2} y={valueH + h - barH - 3} textAnchor="middle" fontSize={10} fill="#59636e">
                  {item.papers || ''}
                </text>
                <text x={x + barW / 2} y={height - 3} textAnchor="middle" fontSize={10} fill="#59636e">
                  {monthLabel(item.month)}
                </text>
              </>
            )}
          </g>
        )
      })}
    </svg>
  )
}

const SOURCE_COLORS = ['#0969da', '#8250df', '#1a7f37', '#bf8700', '#cf222e', '#57606a', '#33b3ae']
const SOURCE_LABELS: Record<string, string> = {
  arxiv: 'arXiv',
  semantic_scholar: 'Semantic Scholar',
  openalex: 'OpenAlex',
  hf_papers: 'HF Papers',
  patents: 'Patents',
}

/** Thin stacked bar of where the papers came from, with a legend. */
export function SourceMix({ sources, compact = false }: { sources: TopicInsights['sources'] | undefined; compact?: boolean }) {
  if (!sources?.length) return null
  const total = sources.reduce((sum, item) => sum + item.papers, 0) || 1
  return (
    <div>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-canvas-inset" role="img" aria-label={`Sources: ${sources.map((s) => `${SOURCE_LABELS[s.source] ?? s.source} ${s.papers}`).join(', ')}`}>
        {sources.map((item, index) => (
          <span key={item.source} style={{ width: `${(item.papers / total) * 100}%`, background: SOURCE_COLORS[index % SOURCE_COLORS.length] }} title={`${SOURCE_LABELS[item.source] ?? item.source}: ${item.papers}`} />
        ))}
      </div>
      <ul className={cx('mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted', compact && 'gap-x-2')}>
        {sources.slice(0, compact ? 4 : undefined).map((item, index) => (
          <li key={item.source} className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full" style={{ background: SOURCE_COLORS[index % SOURCE_COLORS.length] }} aria-hidden="true" />
            {SOURCE_LABELS[item.source] ?? item.source} <span className="tabular-nums">{item.papers}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Claim categories as small count chips with the testable share. */
export function CategoryCounts({ categories, max = 3 }: { categories: TopicInsights['claim_categories'] | undefined; max?: number }) {
  if (!categories?.length) return null
  return (
    <ul className="flex flex-wrap gap-1.5">
      {categories.slice(0, max).map((item) => {
        const share = item.claims ? item.testable / item.claims : 0
        return (
          <li
            key={item.category}
            className="relative overflow-hidden rounded-full border border-accent/25 bg-canvas px-2 py-0.5 text-[11px] text-fg"
            title={`${item.testable} of ${item.claims} claims testable`}
          >
            {humanize(item.category)} <span className="font-semibold tabular-nums">{item.claims}</span>
            <span className="absolute bottom-0 left-0 h-0.5 bg-success-emphasis/70" style={{ width: `${share * 100}%` }} aria-hidden="true" />
          </li>
        )
      })}
    </ul>
  )
}

/** Category bars (claims, testable part in green) for the topic detail page. */
export function CategoryBars({ categories }: { categories: TopicInsights['claim_categories'] | undefined }) {
  if (!categories?.length) return <p className="text-sm text-muted">No claim cards distilled yet.</p>
  const max = Math.max(...categories.map((item) => item.claims), 1)
  return (
    <ul className="space-y-1.5">
      {categories.slice(0, 6).map((item) => (
        <li key={item.category} className="grid grid-cols-[minmax(0,140px)_1fr_auto] items-center gap-2 text-xs">
          <span className="truncate text-fg" title={humanize(item.category)}>
            {humanize(item.category)}
          </span>
          <span className="flex h-2 overflow-hidden rounded-full bg-canvas-inset" role="img" aria-label={`${item.claims} claims, ${item.testable} testable`}>
            <span className="h-full bg-success-emphasis" style={{ width: `${(item.testable / max) * 100}%` }} />
            <span className="h-full bg-success-emphasis/30" style={{ width: `${((item.claims - item.testable) / max) * 100}%` }} />
          </span>
          <span className="text-muted tabular-nums">
            {item.testable}/{item.claims}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function KpiRow({ insights, compact = false }: { insights: TopicInsights; compact?: boolean }) {
  const codeShare = insights.papers ? Math.round((insights.with_code / insights.papers) * 100) : 0
  const items: [string, string, string?][] = [
    ['papers', formatNumber(insights.papers, 0), insights.patents ? `${insights.patents} patent${insights.patents > 1 ? 's' : ''}` : undefined],
    ['with code', `${codeShare}%`, `${insights.with_code} repos`],
    ['citations', formatNumber(insights.citations, 0)],
    ['HF upvotes', formatNumber(insights.upvotes, 0)],
  ]
  if (!compact) {
    items.push(['distilled', formatNumber(insights.distilled, 0), 'with claim cards'])
    if (insights.median_claimed_gain_pct !== null && insights.median_claimed_gain_pct !== undefined)
      items.push(['median claim', `+${formatNumber(insights.median_claimed_gain_pct, 0)}%`, 'testable claims'])
  }
  return (
    <dl className={cx('grid gap-x-3 gap-y-2', compact ? 'grid-cols-4' : 'grid-cols-3 sm:grid-cols-6')}>
      {items.map(([label, value, hint]) => (
        <div key={label} className="min-w-0" title={hint}>
          <dt className="truncate text-[10.5px] tracking-wide text-subtle uppercase">{label}</dt>
          <dd className={cx('font-semibold text-fg tabular-nums', compact ? 'text-sm' : 'text-lg')}>{value}</dd>
          {!compact && hint && <dd className="truncate text-[11px] text-muted">{hint}</dd>}
        </div>
      ))}
    </dl>
  )
}
