import { useId, useState } from 'react'
import type { Prediction } from '../api/types'
import { formatNumber, formatPct } from '../lib/format'
import { bottleneckInfo, formatGainRange, likelihoodInfo, metricShort, predictionHeadline } from '../lib/roofline'
import { ChevronDown, ChevronRight, PulseIcon } from './Icons'
import { Chip, cx, TONE_CLASSES } from './ui'

function tooltip(prediction: Prediction): string {
  const info = likelihoodInfo(prediction.likelihood)
  return [
    `Predicted on this engine: ${info.label} — ${predictionHeadline(prediction)}`,
    prediction.relies_on && `Relies on: ${prediction.relies_on}`,
    ...(prediction.reasons ?? []).map((reason) => `• ${reason}`),
  ]
    .filter(Boolean)
    .join('\n')
}

/** "likely · +8…+35% decode" chip coloured by likelihood; the native tooltip lists the reasons. */
export function PredictionChip({ prediction, className }: { prediction: Prediction | null | undefined; className?: string }) {
  if (!prediction) return null
  const info = likelihoodInfo(prediction.likelihood)
  return (
    <Chip tone={info.tone} className={className} title={tooltip(prediction)}>
      <PulseIcon size={12} />
      {info.label}
      {prediction.predicted_gain_pct && <span className="font-semibold tabular-nums">· {predictionHeadline(prediction)}</span>}
    </Chip>
  )
}

/** Reasons, what the gain relies on and the cost model's extra numbers. */
export function PredictionDetails({ prediction, className }: { prediction: Prediction; className?: string }) {
  const bottleneck = bottleneckInfo(prediction.bottleneck)
  const extras = [
    typeof prediction.best_block_size === 'number' && `best block size ≈ ${prediction.best_block_size}`,
    typeof prediction.acceptance === 'number' && `per-token acceptance ${formatNumber(prediction.acceptance, 2)}`,
  ].filter(Boolean) as string[]
  return (
    <div className={cx('space-y-1.5 text-sm', className)}>
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
        {prediction.relies_on && (
          <>
            <dt className="text-muted">Relies on</dt>
            <dd className="text-fg">{prediction.relies_on}</dd>
          </>
        )}
        <dt className="text-muted">Engine</dt>
        <dd>
          <span className={cx('chip', TONE_CLASSES[bottleneck.tone])} title={bottleneck.description}>
            {bottleneck.label}
          </span>
        </dd>
        {prediction.metric && (
          <>
            <dt className="text-muted">Measured as</dt>
            <dd>
              <code className="code-inline">{prediction.metric}</code>
            </dd>
          </>
        )}
        {extras.length > 0 && (
          <>
            <dt className="text-muted">Model</dt>
            <dd className="text-fg">{extras.join(' · ')}</dd>
          </>
        )}
      </dl>
      {(prediction.reasons?.length ?? 0) > 0 && (
        <ul className="space-y-1 text-[13px]">
          {prediction.reasons!.map((reason) => (
            <li key={reason} className="flex gap-2">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-muted" aria-hidden="true" />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}
      {prediction.note && <p className="text-xs text-attention">{prediction.note}</p>}
    </div>
  )
}

/** Recommendation-card row: "Predicted here" + chip; the chip expands the reasons. */
export function PredictionRow({ prediction, className }: { prediction: Prediction | null | undefined; className?: string }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  if (!prediction) return null
  const info = likelihoodInfo(prediction.likelihood)
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="group inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-md text-left text-xs text-muted"
        title={tooltip(prediction)}
      >
        <span className="font-medium">Predicted here</span>
        <span className={cx('chip group-hover:border-current', TONE_CLASSES[info.tone])}>
          <PulseIcon size={12} />
          {info.label}
          {prediction.predicted_gain_pct && <span className="font-semibold tabular-nums">· {predictionHeadline(prediction)}</span>}
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        {!prediction.predicted_gain_pct && <span className="text-subtle">{predictionHeadline(prediction)}</span>}
      </button>
      {open && (
        <div id={panelId} className="mt-2 rounded-md border border-line-muted bg-canvas-subtle/60 px-3 py-2">
          <PredictionDetails prediction={prediction} />
        </div>
      )}
    </div>
  )
}

/** Gate 2 / Gate 3 box: the predicted range on this engine next to what the paper claims. */
export function PredictionPanel({ prediction, claimed, measured, className }: {
  prediction: Prediction | null | undefined
  claimed?: number | null
  measured?: number | null
  className?: string
}) {
  if (!prediction) return null
  const info = likelihoodInfo(prediction.likelihood)
  const range = formatGainRange(prediction.predicted_gain_pct)
  const gain = prediction.predicted_gain_pct
  const inside = typeof measured === 'number' && gain ? measured >= Math.min(gain.low, gain.high) && measured <= Math.max(gain.low, gain.high) : null
  return (
    <section className={cx('min-w-0 rounded-lg border border-accent/30 bg-accent-subtle/25 px-3 py-2.5', className)} aria-label="Predicted on this engine">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-wide text-accent uppercase">Predicted on this engine</div>
          <div className="text-sm font-semibold text-fg">What should it gain here?</div>
        </div>
        <Chip tone={info.tone} title={info.description}>
          {info.label}
        </Chip>
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xl font-semibold text-fg tabular-nums">{range ?? 'no estimate'}</span>
        {range && prediction.metric && <span className="text-xs text-muted">{metricShort(prediction.metric)}</span>}
        {typeof claimed === 'number' && <span className="text-xs text-done">paper claims {formatPct(claimed, 0)}</span>}
        {inside !== null && (
          <span className={cx('text-xs', inside ? 'text-success' : 'text-attention')}>
            measured {formatPct(measured, 1)} · {inside ? 'inside' : 'outside'} the predicted range
          </span>
        )}
      </div>
      <PredictionDetails prediction={prediction} className="mt-2" />
    </section>
  )
}

/** One line for verdicts: "predicted here +2.6…+21% · marginal" (and the metric when it differs from the measured one). */
export function PredictedLine({ prediction, metric, className }: { prediction: Prediction | null | undefined; metric?: string | null; className?: string }) {
  if (!prediction) return null
  return (
    <p className={cx('text-xs', className)} title={tooltip(prediction)}>
      <span className="text-accent">predicted here {formatGainRange(prediction.predicted_gain_pct) ?? 'no estimate'}</span>
      <span className="text-muted"> · {likelihoodInfo(prediction.likelihood).label}</span>
      {prediction.metric && metric && prediction.metric !== metric && (
        <span className="text-muted">
          {' '}
          · for <code>{prediction.metric}</code>
        </span>
      )}
    </p>
  )
}
