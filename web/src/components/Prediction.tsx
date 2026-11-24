import type { Prediction } from '../api/types'
import { expectedMetricLabel } from '../lib/claims'
import { formatClaimed, formatNumber, formatRange, formatSigned, MISSING, sanitizeText } from '../lib/format'
import { bottleneckInfo, likelihoodInfo } from '../lib/roofline'
import { MetricName, OutcomeBadge } from './Badges'
import { InfoPopover } from './Tooltip'
import { Chip, cx } from './ui'

/** `+8 to +35%` from the predicted range, or null without one. */
function predictedRange(prediction: Prediction | null | undefined): string | null {
  const gain = prediction?.predicted_gain_pct
  if (!gain) return null
  return formatRange(gain.low, gain.high, { fallback: '' }) || null
}

/** "Why this estimate?" ⓘ button that opens the cost model's reasons. */
export function PredictionWhy({ prediction, label = 'Why this estimate?' }: { prediction: Prediction; label?: string }) {
  return <InfoPopover title="Why this estimate?" label={label} maxWidth={360} content={<PredictionDetails prediction={prediction} />} />
}

/** "Likely gain +8 to +35% decode speed" badge (dashed = predicted) with the reasons behind an ⓘ popover. */
export function PredictionChip({ prediction, className }: { prediction: Prediction | null | undefined; className?: string }) {
  if (!prediction) return null
  const range = predictedRange(prediction)
  const metric = expectedMetricLabel(prediction.metric)
  return (
    <span className={cx('inline-flex max-w-full flex-wrap items-center gap-1', className)}>
      <OutcomeBadge kind="likelihood" value={prediction.likelihood} detail={range ? `${range}${metric ? ` ${metric}` : ''}` : undefined} />
      <PredictionWhy prediction={prediction} />
    </span>
  )
}

/** Reasons, what the gain relies on and the cost model's extra numbers. */
export function PredictionDetails({ prediction, className }: { prediction: Prediction; className?: string }) {
  const bottleneck = bottleneckInfo(prediction.bottleneck)
  const extras = [
    typeof prediction.best_block_size === 'number' && `best block size about ${prediction.best_block_size}`,
    typeof prediction.acceptance === 'number' && `per-token acceptance ${formatNumber(prediction.acceptance, 2)}`,
  ].filter(Boolean) as string[]
  return (
    <div className={cx('space-y-2 text-sm', className)}>
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1.5 text-sm">
        {prediction.relies_on && (
          <>
            <dt className="text-xs text-muted">Relies on</dt>
            <dd className="text-fg">{sanitizeText(prediction.relies_on)}</dd>
          </>
        )}
        <dt className="text-xs text-muted">Engine</dt>
        <dd>
          <Chip tone={bottleneck.tone} title={bottleneck.description}>
            {bottleneck.label}
          </Chip>
        </dd>
        {prediction.metric && (
          <>
            <dt className="text-xs text-muted">Measured as</dt>
            <dd>
              <MetricName metric={prediction.metric} showId />
            </dd>
          </>
        )}
        {extras.length > 0 && (
          <>
            <dt className="text-xs text-muted">Model</dt>
            <dd className="text-fg">{extras.join(' · ')}</dd>
          </>
        )}
      </dl>
      {(prediction.reasons?.length ?? 0) > 0 && (
        <ul className="space-y-1">
          {prediction.reasons!.map((reason) => (
            <li key={reason} className="flex gap-2">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-muted" aria-hidden="true" />
              <span>{sanitizeText(reason)}</span>
            </li>
          ))}
        </ul>
      )}
      {prediction.note && <p className="text-xs text-caution-fg">{sanitizeText(prediction.note)}</p>}
    </div>
  )
}

/** "Expected here" + likelihood badge + range, with the reasons behind "Why this estimate?". */
export function PredictionRow({ prediction, className }: { prediction: Prediction | null | undefined; className?: string }) {
  if (!prediction) return null
  const range = predictedRange(prediction)
  const metric = expectedMetricLabel(prediction.metric)
  return (
    <div className={cx('flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted', className)}>
      <span className="font-medium">Expected here</span>
      <OutcomeBadge kind="likelihood" value={prediction.likelihood} detail={range ? `${range}${metric ? ` ${metric}` : ''}` : undefined} />
      {!range && <span>{MISSING.estimate}</span>}
      <PredictionWhy prediction={prediction} />
    </div>
  )
}

/** Gate 2 / Gate 3 box (predicted register, dashed): the expected range on this engine next to what the paper reports. */
export function PredictionPanel({ prediction, claimed, measured, className }: {
  prediction: Prediction | null | undefined
  claimed?: number | null
  measured?: number | null
  className?: string
}) {
  if (!prediction) return null
  const range = predictedRange(prediction)
  const metric = expectedMetricLabel(prediction.metric)
  const gain = prediction.predicted_gain_pct
  const inside = typeof measured === 'number' && gain ? measured >= Math.min(gain.low, gain.high) && measured <= Math.max(gain.low, gain.high) : null
  return (
    <section data-register="predicted" className={cx('min-w-0 rounded-lg border border-dashed border-info/70 bg-canvas px-3 py-2.5', className)} aria-label="Expected on this engine">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted">Expected on this engine</div>
          <div className="text-sm font-semibold text-fg">What should it gain here?</div>
        </div>
        <OutcomeBadge kind="likelihood" value={prediction.likelihood} explain />
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={cx('tabular-nums', range ? 'text-metric-sm text-fg' : 'text-body-lg font-semibold text-muted')}>{range ?? MISSING.estimate}</span>
        {range && metric && <span className="text-sm text-muted">{metric}</span>}
        {typeof claimed === 'number' && <span className="text-xs text-muted">{formatClaimed(claimed, { digits: 0 })}</span>}
        {inside !== null && (
          <span className={cx('text-xs', inside ? 'text-positive-fg' : 'text-caution-fg')}>
            Measured {formatSigned(measured)}, {inside ? 'inside' : 'outside'} the expected range
          </span>
        )}
      </div>
      <PredictionDetails prediction={prediction} className="mt-2" />
    </section>
  )
}

/** One line for verdicts: "Expected here +2.6 to +21% · Small or no gain" (and the metric when it differs from the measured one). */
export function PredictedLine({ prediction, metric, className }: { prediction: Prediction | null | undefined; metric?: string | null; className?: string }) {
  if (!prediction) return null
  return (
    <p className={cx('flex flex-wrap items-center gap-x-1 text-xs', className)}>
      <span className="text-info-fg">Expected here {predictedRange(prediction) ?? MISSING.estimate.toLowerCase()}</span>
      <span className="text-muted">· {likelihoodInfo(prediction.likelihood).label}</span>
      {prediction.metric && metric && prediction.metric !== metric && (
        <span className="text-muted">
          {' '}
          · for <MetricName metric={prediction.metric} />
        </span>
      )}
      <PredictionWhy prediction={prediction} />
    </p>
  )
}
