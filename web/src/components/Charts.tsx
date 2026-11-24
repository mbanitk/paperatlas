import { formatPct } from '../lib/format'
import { formatGainRange } from '../lib/roofline'
import { cx } from './ui'

/**
 * Horizontal % axis with the measured 95% CI (bar), the median (dot), the success threshold and the
 * paper's claimed gain (markers). Positive = better in the metric's own direction.
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
  const band =
    predicted && Number.isFinite(predicted.low) && Number.isFinite(predicted.high)
      ? { low: Math.min(predicted.low, predicted.high), high: Math.max(predicted.low, predicted.high) }
      : null
  const values = [median, low, high, claimed, threshold, target, band?.low, band?.high, 0].filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (median === null || median === undefined || !values.length) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(max - min, 5)
  const lo = min - span * 0.08
  const hi = max + span * 0.08
  const width = 560
  const height = band ? 112 : 100
  const pad = 14
  const x = (value: number) => pad + ((value - lo) / (hi - lo)) * (width - 2 * pad)
  const axisY = band ? 72 : 60
  const markers: { value: number; label: string; color: string; dash?: boolean }[] = []
  if (typeof threshold === 'number') markers.push({ value: threshold, label: `success bar ${formatPct(threshold, 0)}`, color: '#59636e', dash: true })
  if (typeof target === 'number' && Math.abs(target - (threshold ?? Number.NaN)) > 0.05)
    markers.push({ value: target, label: `target ${formatPct(target, 0)}`, color: '#9a6700', dash: true })
  if (typeof claimed === 'number') markers.push({ value: claimed, label: `paper claims ${formatPct(claimed, 0)}`, color: '#8250df' })
  const tone = (low ?? median) > 0 ? '#1a7f37' : (high ?? median) < 0 ? '#d1242f' : '#59636e'
  const anchor = (px: number) => (px > width - 90 ? 'end' : px < 90 ? 'start' : 'middle')
  const bandLabelY = 11 + markers.length * 12
  const showZeroLabel = Math.abs(x(median) - x(0)) > 34

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Measured improvement ${formatPct(median)} (95% CI ${formatPct(low)} to ${formatPct(high)})${typeof claimed === 'number' ? `, paper claims ${formatPct(claimed)}` : ''}${band ? `, predicted on this engine ${formatPct(band.low)} to ${formatPct(band.high)}` : ''}`}
    >
      {band && (
        <g>
          <rect
            x={x(band.low)}
            y={axisY - 13}
            width={Math.max(3, x(band.high) - x(band.low))}
            height={26}
            rx={4}
            fill="#0969da"
            fillOpacity={0.1}
            stroke="#0969da"
            strokeOpacity={0.55}
            strokeDasharray="4 3"
          />
          <text x={x((band.low + band.high) / 2)} y={Math.min(bandLabelY, axisY - 17)} textAnchor={anchor(x((band.low + band.high) / 2))} fontSize={10.5} fill="#0969da" fontWeight={600}>
            predicted here {formatGainRange(band)}
          </text>
        </g>
      )}
      <line x1={pad} x2={width - pad} y1={axisY} y2={axisY} stroke="#d1d9e0" strokeWidth={2} />
      <line x1={x(0)} x2={x(0)} y1={axisY - 10} y2={axisY + 10} stroke="#818b98" strokeWidth={1} />
      {showZeroLabel && (
        <text x={x(0)} y={axisY + 26} textAnchor="middle" fontSize={11} fill="#59636e">
          0%
        </text>
      )}
      {markers.map((marker, row) => {
        const labelY = 11 + row * 12
        return (
          <g key={marker.label}>
            <line x1={x(marker.value)} x2={x(marker.value)} y1={labelY + 3} y2={axisY + 8} stroke={marker.color} strokeWidth={1.4} strokeDasharray={marker.dash ? '3 3' : undefined} />
            <text x={x(marker.value)} y={labelY} textAnchor={anchor(x(marker.value))} fontSize={10.5} fill={marker.color} fontWeight={600}>
              {marker.label}
            </text>
          </g>
        )
      })}
      {typeof low === 'number' && typeof high === 'number' && (
        <rect x={x(low)} y={axisY - 7} width={Math.max(2, x(high) - x(low))} height={14} rx={7} fill={tone} fillOpacity={0.22} stroke={tone} />
      )}
      <circle cx={x(median)} cy={axisY} r={6.5} fill={tone} stroke="#fff" strokeWidth={2} />
      <text x={x(median)} y={axisY + 26} textAnchor={anchor(x(median))} fontSize={12} fontWeight={700} fill={tone}>
        measured {formatPct(median)}
      </text>
    </svg>
  )
}

/** Simple horizontal 0..1 meter. */
export function Meter({ value, max = 1, label, className, tone = 'accent' }: { value: number; max?: number; label: string; className?: string; tone?: 'accent' | 'success' | 'done' }) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100
  const color = tone === 'success' ? 'bg-success-emphasis' : tone === 'done' ? 'bg-done' : 'bg-accent'
  return (
    <div className={cx('h-1.5 w-full overflow-hidden rounded-full bg-canvas-inset', className)} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div className={cx('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
    </div>
  )
}

/** Baseline vs variant medians as two bars. */
export function CompareBars({ baseline, variant, better }: { baseline: number; variant: number; better: 'higher_is_better' | 'lower_is_better' }) {
  const max = Math.max(Math.abs(baseline), Math.abs(variant)) || 1
  const improved = better === 'higher_is_better' ? variant > baseline : variant < baseline
  return (
    <div className="w-28 space-y-0.5" aria-hidden="true">
      <div className="h-1.5 rounded-full bg-subtle/60" style={{ width: `${(Math.abs(baseline) / max) * 100}%` }} />
      <div className={cx('h-1.5 rounded-full', improved ? 'bg-success-emphasis' : 'bg-danger-emphasis')} style={{ width: `${(Math.abs(variant) / max) * 100}%` }} />
    </div>
  )
}
