import { useMemo } from 'react'
import { formatRange, formatSigned } from '../lib/format'
import { CHART_FONT, layoutNumberLine, type ChartMark } from '../lib/numberLine'
import type { SemanticTone } from '../lib/semantics'
import { useElementWidth } from '../lib/useElementWidth'
import { GLYPHS } from './Icons'
import { cx } from './ui'

/** Strokes/fills per semantic tone, from the design tokens (presentation attributes can't take var()). */
const TONE_PAINT: Record<SemanticTone, string> = {
  positive: 'var(--color-positive)',
  negative: 'var(--color-negative)',
  caution: 'var(--color-caution-emphasis)',
  info: 'var(--color-info)',
  neutral: 'var(--color-neutral)',
  merged: 'var(--color-merged)',
  reference: 'var(--color-reference)',
}
/** Text colour per tone (AA on white). */
const TONE_INK: Record<SemanticTone, string> = {
  positive: 'var(--color-positive-fg)',
  negative: 'var(--color-negative-fg)',
  caution: 'var(--color-caution-fg)',
  info: 'var(--color-info-fg)',
  neutral: 'var(--color-neutral-fg)',
  merged: 'var(--color-merged-fg)',
  reference: 'var(--color-reference-fg)',
}

function MarkSwatch({ mark }: { mark: Pick<ChartMark, 'tone' | 'dash' | 'key'> }) {
  return (
    <svg width="18" height="12" aria-hidden="true" className="shrink-0">
      <line x1="9" x2="9" y1="0" y2="12" style={{ stroke: TONE_PAINT[mark.tone] }} strokeWidth={1.6} strokeDasharray={mark.dash} />
    </svg>
  )
}

/**
 * Horizontal % axis with the measured median (dot) and 95% CI (bar), the cost model's expected range on this
 * engine (dashed band), and the success bar, target and the paper's claimed gain (markers). Positive = better
 * in the metric's own direction.
 *
 * Drawn at the container's pixel width so text is 12 px on screen at every width. Labels never overlap and
 * marker lines never cross text; on narrow screens the chart keeps short labels and lists the rest underneath.
 * Colours follow the registers: measured = outcome tone, expected here = info (dashed), paper = neutral ink.
 */
export function ImprovementChart({ median, low, high, claimed, threshold, target, predicted }: {
  median: number | null | undefined
  low: number | null | undefined
  high: number | null | undefined
  claimed?: number | null
  threshold?: number | null
  target?: number | null
  /** the cost model's predicted range on this engine, drawn as a band behind the measurement */
  predicted?: { low: number; high: number } | null
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>(2)
  const layout = useMemo(
    () => (typeof median === 'number' && Number.isFinite(median) ? layoutNumberLine({ width: width ?? 560, median, low, high, claimed, threshold, target, predicted }) : null),
    [width, median, low, high, claimed, threshold, target, predicted],
  )
  if (!layout || typeof median !== 'number') return null

  const ci = typeof low === 'number' && typeof high === 'number' ? formatRange(low, high) : null
  const parts = [
    `Measured improvement ${formatSigned(median)}${ci ? ` (95% CI ${ci})` : ''}`,
    typeof threshold === 'number' ? `success bar ${formatSigned(threshold, { digits: 0 })}` : null,
    typeof target === 'number' && layout.marks.some((mark) => mark.key === 'target') ? `target ${formatSigned(target, { digits: 0 })}` : null,
    typeof claimed === 'number' ? `paper reports ${formatSigned(claimed, { digits: 0 })}` : null,
    layout.band ? `expected here ${layout.band.short}` : null,
  ].filter(Boolean)
  const { axisY } = layout

  return (
    <div ref={ref} className="min-w-0 [contain:inline-size]" data-chart="improvement">
      <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={parts.join(', ')} className="block max-w-none">
        {layout.band && (
          <rect
            x={layout.band.x0}
            y={layout.band.y0}
            width={layout.band.x1 - layout.band.x0}
            height={layout.band.y1 - layout.band.y0}
            rx={4}
            style={{ fill: 'var(--color-info-subtle)', stroke: TONE_PAINT.info }}
            strokeOpacity={0.7}
            strokeDasharray="4 3"
          />
        )}
        <line x1={12} x2={layout.width - 12} y1={axisY} y2={axisY} style={{ stroke: 'var(--color-line)' }} strokeWidth={2} />
        <line x1={layout.zeroX} x2={layout.zeroX} y1={axisY - 10} y2={axisY + 10} style={{ stroke: 'var(--color-neutral-emphasis)' }} strokeWidth={1} />
        {layout.marks.map((mark) => (
          <line key={mark.key} x1={mark.x} x2={mark.x} y1={mark.lineTop} y2={mark.lineBottom} style={{ stroke: TONE_PAINT[mark.tone] }} strokeWidth={1.4} strokeDasharray={mark.dash} />
        ))}
        {layout.ci && <rect x={layout.ci.x0} y={axisY - 7} width={layout.ci.x1 - layout.ci.x0} height={14} rx={7} style={{ fill: TONE_PAINT[layout.median.tone], stroke: TONE_PAINT[layout.median.tone] }} fillOpacity={0.22} />}
        <circle cx={layout.median.x} cy={axisY} r={6.5} style={{ fill: TONE_PAINT[layout.median.tone], stroke: 'var(--color-canvas)' }} strokeWidth={2} />
        {layout.labels.map((label) => (
          <g key={label.key} style={{ color: TONE_INK[label.tone] }}>
            {label.icon && (
              <g transform={`translate(${label.x} ${label.y - 10.5}) scale(0.75)`} aria-hidden="true">
                <g fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                  {GLYPHS.paper}
                </g>
              </g>
            )}
            <text x={label.x + (label.icon ? 15 : 0)} y={label.y} fontSize={CHART_FONT} fontWeight={label.weight} style={{ fill: 'currentColor' }}>
              {label.text}
            </text>
          </g>
        ))}
      </svg>
      {layout.legend ? (
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Chart legend">
          {ci && (
            <li className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-4 rounded-full border" style={{ background: 'color-mix(in srgb, currentColor 22%, transparent)', borderColor: 'currentColor', color: TONE_PAINT[layout.median.tone] }} aria-hidden="true" />
              <span>Bar: 95% confidence interval, {ci}</span>
            </li>
          )}
          {layout.band && (
            <li className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-info bg-info-subtle" aria-hidden="true" />
              <span className="text-info-fg">Expected here: {layout.band.short}</span>
            </li>
          )}
          {layout.marks.map((mark) => (
            <li key={mark.key} className="inline-flex items-center gap-1" style={{ color: TONE_INK[mark.tone] }}>
              <MarkSwatch mark={mark} />
              {mark.label}
            </li>
          ))}
        </ul>
      ) : (
        ci && <p className="mt-0.5 text-xs text-muted">Bar: 95% confidence interval, {ci}.</p>
      )}
    </div>
  )
}

type MeterTone = 'accent' | 'success' | 'done' | 'info' | 'positive' | 'neutral'
const METER_FILL: Record<MeterTone, string> = {
  accent: 'bg-accent',
  info: 'bg-info',
  success: 'bg-success-emphasis',
  positive: 'bg-positive-emphasis',
  done: 'bg-done',
  neutral: 'bg-neutral-emphasis',
}

/** Simple horizontal 0..1 meter. Prefer the semantic tones (`info`, `positive`, `neutral`); `done` is legacy. */
export function Meter({ value, max = 1, label, className, tone = 'accent' }: { value: number; max?: number; label: string; className?: string; tone?: MeterTone }) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100
  return (
    <div className={cx('h-1.5 w-full overflow-hidden rounded-full bg-canvas-inset', className)} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div className={cx('h-full rounded-full', METER_FILL[tone])} style={{ width: `${pct}%` }} />
    </div>
  )
}

/** Baseline vs variant medians as two bars (variant tinted by outcome: better = positive, worse = negative). */
export function CompareBars({ baseline, variant, better }: { baseline: number; variant: number; better: 'higher_is_better' | 'lower_is_better' }) {
  const max = Math.max(Math.abs(baseline), Math.abs(variant)) || 1
  const improved = better === 'higher_is_better' ? variant > baseline : variant < baseline
  return (
    <div className="w-28 space-y-0.5" aria-hidden="true">
      <div className="h-1.5 rounded-full bg-neutral-emphasis/50" style={{ width: `${(Math.abs(baseline) / max) * 100}%` }} />
      <div className={cx('h-1.5 rounded-full', improved ? 'bg-positive-emphasis' : 'bg-negative-emphasis')} style={{ width: `${(Math.abs(variant) / max) * 100}%` }} />
    </div>
  )
}
