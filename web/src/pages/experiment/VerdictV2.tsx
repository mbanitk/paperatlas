import type { ReactNode } from 'react'
import type { Analysis, Experiment, IterationEntry, MechanismTable, TuningResult, VerdictDetail } from '../../api/types'
import { Delta, VerdictBadge } from '../../components/Badges'
import { ImprovementChart } from '../../components/Charts'
import { AlertIcon, CheckIcon, SparkIcon } from '../../components/Icons'
import { Chip, cx, TONE_CLASSES } from '../../components/ui'
import { formatCI, formatNumber, formatPct, formatWorkload } from '../../lib/format'
import { adoptionInfo, chosenBy, claimTarget, diagnosisInfo, formatConfig, formatKnobValue, protocolOf } from '../../lib/protocol'
import { predictionMatchesMetric } from '../../lib/roofline'
import { PredictedLine } from '../../components/Prediction'

function Tile({ kicker, question, badge, children, className }: { kicker: string; question: string; badge: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('min-w-0 rounded-lg border px-3.5 py-3', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">{kicker}</div>
          <h3 className="text-sm font-semibold text-fg">{question}</h3>
        </div>
        {badge}
      </div>
      <div className="mt-2 space-y-1 text-sm">{children}</div>
    </section>
  )
}

function Measured({ median, low, high }: { median: number | null | undefined; low: number | null | undefined; high: number | null | undefined }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-2xl font-semibold">
        <Delta value={median} />
      </span>
      <span className="text-xs text-muted tabular-nums">95% CI {formatCI(low, high)}</span>
    </div>
  )
}

/** "Does the paper's claim hold?" (claim check) and "Is it worth adopting here?" (adoption check). */
export function VerdictTiles({ experiment, verdict }: { experiment: Experiment; verdict: VerdictDetail }) {
  const details = verdict.details ?? {}
  const protocol = protocolOf(experiment.spec)
  const comparison = details.comparison
  const adoption = details.adoption
  const threshold = details.success_threshold_pct ?? experiment.spec.success_threshold_pct ?? null
  const target = details.target_pct ?? claimTarget(verdict.claimed_gain_pct, threshold)
  const paperBaseline = comparison?.baseline === 'paper baseline'
  const paperWorkload = comparison?.workload === 'paper regime'
  const adoptionLabel = adoption ? adoptionInfo(adoption.verdict) : details.worth_adopting ? adoptionInfo('worth_adopting') : adoptionInfo('not_reproduced')
  const prediction = experiment.spec.prediction
  const band = predictionMatchesMetric(prediction, verdict.primary_metric) ? prediction!.predicted_gain_pct : null

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Tile kicker="Claim check" question="Does the paper’s claim hold?" badge={<VerdictBadge verdict={verdict.verdict} />} className="border-done/30 bg-done-subtle/25">
        <Measured median={verdict.median_delta_pct} low={verdict.ci_low_pct} high={verdict.ci_high_pct} />
        <p className="text-xs text-muted">
          target ≥ {formatPct(target, 1)}
          {typeof verdict.claimed_gain_pct === 'number' && <> · paper claims {formatPct(verdict.claimed_gain_pct, 0)}</>} · <code>{verdict.primary_metric}</code>
        </p>
        <PredictedLine prediction={prediction} metric={verdict.primary_metric} />
        <p className="text-xs">
          <span className="text-muted">vs </span>
          {paperBaseline ? <strong>{protocol.paper_baseline.description || 'the paper’s baseline'}</strong> : <strong>the project default</strong>}
          <span className="text-muted"> on </span>
          {paperWorkload ? <strong>a paper-like workload</strong> : <strong>{comparison?.workload ?? formatWorkload(details.workload ?? experiment.spec.workload)}</strong>}
        </p>
        {details.reason && <p className="text-xs text-muted">{details.reason}</p>}
      </Tile>
      <Tile
        kicker="Adoption check"
        question="Is it worth adopting here?"
        badge={<Chip tone={adoptionLabel.tone}>{adoptionLabel.label}</Chip>}
        className="border-success/30 bg-success-subtle/25"
      >
        {adoption ? (
          <>
            <Measured median={adoption.median_delta_pct} low={adoption.ci_low_pct} high={adoption.ci_high_pct} />
            <p className="text-xs text-muted">
              success bar ≥ {formatPct(threshold, 1)} · quality{' '}
              {adoption.quality_ok ? <span className="text-success">OK</span> : <span className="text-danger">{adoption.quality_problems.join('; ') || 'failed'}</span>}
            </p>
            <p className="text-xs">
              <span className="text-muted">vs </span>
              <strong>the project default</strong>
              <span className="text-muted"> on </span>
              <strong>{formatWorkload(adoption.workload ?? experiment.spec.workload)}</strong>
            </p>
            {adoption.reason && <p className="text-xs text-muted">{adoption.reason}</p>}
          </>
        ) : (
          <p className="text-xs text-muted">
            Same comparison as the claim check (project default on the project workload): the gain {details.worth_adopting ? 'clears' : 'does not clear'} the{' '}
            {formatPct(threshold, 1)} success bar.
          </p>
        )}
      </Tile>
      <div className="rounded-md border border-line-muted px-3 py-2 md:col-span-2">
        <div className="mb-0.5 text-[11px] font-semibold tracking-wide text-muted uppercase">Claim check vs the paper</div>
        <ImprovementChart
          median={verdict.median_delta_pct}
          low={verdict.ci_low_pct}
          high={verdict.ci_high_pct}
          claimed={verdict.claimed_gain_pct}
          threshold={threshold}
          target={target}
          predicted={band}
        />
      </div>
    </div>
  )
}

const DIAGNOSIS_BORDER: Record<string, string> = {
  success: 'border-l-success-emphasis',
  attention: 'border-l-attention-emphasis',
  danger: 'border-l-danger-emphasis',
  neutral: 'border-l-subtle',
  muted: 'border-l-line',
}

/** The analyst's reading of the result: why the numbers moved, compared with the paper. */
export function DiagnosisCallout({ analysis, iteration, maxIterations, settled }: { analysis: Analysis; iteration: number; maxIterations: number; settled: boolean }) {
  const info = diagnosisInfo(analysis.diagnosis)
  const suggested = analysis.worth_iterating && analysis.next_changes?.trim()
  return (
    <section className={cx('rounded-md border border-l-4 border-line-muted bg-canvas-subtle/60 px-3.5 py-3', DIAGNOSIS_BORDER[info.tone])} aria-label="Diagnosis">
      <div className="flex flex-wrap items-center gap-2">
        <SparkIcon size={14} className="text-done" />
        <span className="text-xs font-semibold tracking-wide text-muted uppercase">Diagnosis</span>
        <span className={cx('chip font-semibold', TONE_CLASSES[info.tone])} title={info.description}>
          {info.label}
        </span>
        {analysis.model && <span className="ml-auto text-[11px] text-subtle">by {analysis.model}</span>}
      </div>
      {analysis.summary && <p className="mt-2 text-sm text-fg">{analysis.summary}</p>}
      {analysis.evidence?.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {analysis.evidence.map((item) => (
            <li key={item} className="flex gap-2">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-muted" aria-hidden="true" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
      {analysis.paper_comparison && (
        <p className="mt-2 rounded border border-done/20 bg-done-subtle/40 px-2.5 py-1.5 text-sm">
          <span className="mr-1 text-xs font-semibold text-done">vs the paper</span>
          {analysis.paper_comparison}
        </p>
      )}
      {suggested && (
        <div className="mt-2 text-sm">
          <span className="text-xs font-semibold text-muted">
            {settled && iteration >= maxIterations
              ? `Suggested next change — not tried (limit of ${maxIterations} iteration${maxIterations > 1 ? 's' : ''} reached)`
              : 'Next change'}
            :
          </span>{' '}
          {analysis.next_changes}
          {analysis.expected_effect && <span className="block text-xs text-muted">Expected: {analysis.expected_effect}</span>}
        </div>
      )}
    </section>
  )
}

/** Mechanism counters per 1k generated tokens, baseline vs method, next to the paper's values. */
export function MechanismTableView({ mechanism }: { mechanism: MechanismTable }) {
  const missing = new Set(mechanism.missing ?? [])
  if (!mechanism.rows?.length && !missing.size) return null
  return (
    <div>
      <h3 className="mb-1 flex flex-wrap items-center gap-2 text-sm font-semibold">
        Mechanism counters
        {missing.size > 0 ? (
          <Chip tone="attention">
            <AlertIcon size={12} /> {missing.size} not reported
          </Chip>
        ) : (
          mechanism.measured && (
            <Chip tone="success">
              <CheckIcon size={12} /> all reported
            </Chip>
          )
        )}
      </h3>
      <p className="mb-2 text-xs text-muted">What the technique did, per 1,000 generated tokens — tells a broken build apart from a claim that does not transfer.</p>
      <div className="overflow-x-auto rounded-md border border-line-muted">
        <table className="w-full text-sm">
          <caption className="sr-only">Mechanism counters per 1,000 generated tokens</caption>
          <thead className="bg-canvas-subtle text-left text-xs text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Counter
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Baseline
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Method
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Change
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Paper
              </th>
            </tr>
          </thead>
          <tbody>
            {mechanism.rows.map((row) => {
              const absent = missing.has(row.name)
              return (
                <tr key={row.name} className={cx('border-t border-line-muted align-top', absent && 'bg-attention-subtle/50')}>
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <code className="code-inline">{row.name}</code>
                    {!row.expected && <span className="ml-1 text-[11px] text-subtle">extra</span>}
                    {row.meaning && <div className="text-[11px] text-muted">{row.meaning}</div>}
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.baseline_per_1k_tokens, 1)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {absent ? <span className="text-xs font-semibold text-attention">not reported</span> : formatNumber(row.variant_per_1k_tokens, 1)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {typeof row.change_pct === 'number' ? (
                      <span className={row.change_pct > 0 ? 'text-done' : row.change_pct < 0 ? 'text-accent' : 'text-muted'}>{formatPct(row.change_pct, 1)}</span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-done">{row.paper_value ?? <span className="text-muted">—</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {mechanism.tokens && (mechanism.tokens.baseline > 0 || mechanism.tokens.variant > 0) && (
        <p className="mt-1 text-xs text-muted">
          Measured over {formatNumber(mechanism.tokens.baseline, 0)} baseline and {formatNumber(mechanism.tokens.variant, 0)} method tokens.
        </p>
      )}
    </div>
  )
}

/** The knob sweep before the measured runs: each arm keeps its best configuration. */
export function TuningTable({ tuning, metric, direction, knobOrder = [] }: { tuning: TuningResult; metric?: string; direction?: string; knobOrder?: string[] }) {
  if (tuning.skipped || !tuning.trials?.length) {
    return (
      <p className="text-xs text-muted">
        Tuning skipped{tuning.configs?.length ? ` — ran the paper’s setting (${formatConfig(tuning.variant)})` : ' — no knobs to tune'}.
      </p>
    )
  }
  // Stored configs come back with JSONB key order; show the knobs in the spec's order.
  const keys = Object.keys(tuning.trials[0].config)
  const knobs = [...knobOrder.filter((name) => keys.includes(name)), ...keys.filter((name) => !knobOrder.includes(name))]
  const higher = direction !== 'lower_is_better'
  const best = (arm: 'baseline' | 'variant') => {
    const values = tuning.trials.map((trial) => trial[arm]).filter((v): v is number => typeof v === 'number')
    return values.length ? (higher ? Math.max(...values) : Math.min(...values)) : null
  }
  const bestBaseline = best('baseline')
  const bestVariant = best('variant')
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">Tuning</h3>
      <p className="mb-2 text-xs text-muted">
        {tuning.trials.length} configurations, short runs on <code>{tuning.metric ?? metric}</code>; each arm keeps its best, so the paper’s baseline gets the same budget.
      </p>
      <div className="overflow-x-auto rounded-md border border-line-muted">
        <table className="w-full text-sm">
          <caption className="sr-only">Tuning trials</caption>
          <thead className="bg-canvas-subtle text-left text-xs text-muted">
            <tr>
              {knobs.map((knob) => (
                <th key={knob} scope="col" className="px-3 py-2 font-mono font-medium">
                  {knob}
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Baseline
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Method
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                <span className="sr-only">Chosen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tuning.trials.map((trial, index) => {
              const chosen = chosenBy(tuning, trial.config)
              return (
                <tr key={index} className={cx('border-t border-line-muted', chosen.includes('method') && 'bg-success-subtle/40')}>
                  {knobs.map((knob) => (
                    <td key={knob} className="px-3 py-1.5 font-mono text-xs tabular-nums">
                      {formatKnobValue(trial.config[knob])}
                      {index === 0 && knob === knobs[0] && <span className="ml-1.5 font-sans text-[10.5px] text-done">paper</span>}
                    </td>
                  ))}
                  <td className={cx('px-3 py-1.5 text-right tabular-nums', trial.baseline === bestBaseline && 'font-semibold')}>{formatNumber(trial.baseline)}</td>
                  <td className={cx('px-3 py-1.5 text-right tabular-nums', trial.variant === bestVariant && 'font-semibold')}>{formatNumber(trial.variant)}</td>
                  <td className="px-3 py-1.5 text-xs whitespace-nowrap">
                    {chosen.map((arm) => (
                      <span key={arm} className={cx('mr-1 inline-flex items-center gap-0.5', arm === 'method' ? 'text-success' : 'text-muted')}>
                        <CheckIcon size={12} /> {arm}
                      </span>
                    ))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** What happened in each build → measure → diagnose round. */
export function IterationsTimeline({ iterations, kept }: { iterations: IterationEntry[]; kept?: number | null }) {
  if (iterations.length < 2) return null
  const keptEntry = kept != null ? iterations.find((entry) => entry.iteration === kept) : undefined
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">Iterations</h3>
      {keptEntry && keptEntry !== iterations[iterations.length - 1] ? (
        <p className="mb-2 text-xs text-muted">
          Iteration {keptEntry.iteration} scored best, so it was kept: later iterations’ code was reverted and the verdict above is iteration {keptEntry.iteration}’s.
        </p>
      ) : (
        keptEntry && <p className="mb-2 text-xs text-muted">The last iteration scored best and was kept.</p>
      )}
      <ol className="relative space-y-3 border-l-2 border-line-muted pl-4">
        {iterations.map((entry, index) => {
          const last = index === iterations.length - 1
          const state = keptEntry ? (entry.iteration === keptEntry.iteration ? 'kept' : entry.iteration > keptEntry.iteration ? 'reverted' : null) : last ? 'final' : null
          const diagnosis = entry.diagnosis ? diagnosisInfo(entry.diagnosis) : null
          return (
            <li key={entry.iteration} className="relative">
              <span
                className={cx(
                  'absolute top-1 -left-[23px] size-3 rounded-full border-2 border-canvas',
                  state === 'kept' ? 'bg-success-emphasis' : state === 'final' ? 'bg-accent-emphasis' : 'bg-subtle',
                )}
                aria-hidden="true"
              />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className={cx('font-semibold', state === 'reverted' && 'text-muted')}>Iteration {entry.iteration}</span>
                {state === 'kept' && (
                  <Chip tone="success">
                    <CheckIcon size={12} /> kept
                  </Chip>
                )}
                {state === 'reverted' && <Chip tone="muted">reverted</Chip>}
                {entry.sha && (
                  <code className="code-inline text-[11px]" title={entry.sha}>
                    {entry.sha.slice(0, 7)}
                  </code>
                )}
                <VerdictBadge verdict={entry.verdict} />
                <Delta value={entry.median_delta_pct} />
                <span className="text-xs text-muted tabular-nums">CI {formatCI(entry.ci_low_pct, entry.ci_high_pct)}</span>
                {diagnosis && <Chip tone={diagnosis.tone}>{diagnosis.label}</Chip>}
                {entry.adoption_verdict && (
                  <span className="text-xs text-muted">
                    adoption: {adoptionInfo(entry.adoption_verdict).label}
                    {typeof entry.adoption_median_delta_pct === 'number' && ` (${formatPct(entry.adoption_median_delta_pct, 1)})`}
                  </span>
                )}
                {state === 'final' && <span className="text-xs font-semibold text-accent">final</span>}
                {entry.quality_ok === false && <Chip tone="danger">quality failed</Chip>}
              </div>
              {entry.summary && <p className="mt-0.5 text-sm text-muted">{entry.summary}</p>}
              {entry.tuned?.variant && Object.keys(entry.tuned.variant).length > 0 && (
                <p className="mt-0.5 text-xs text-muted">tuned method: {formatConfig(entry.tuned.variant)}</p>
              )}
              {!last && entry.next_changes && (
                <p className="mt-1 rounded border border-line-muted bg-canvas-subtle px-2 py-1 text-xs">
                  <span className="font-semibold">Tried next:</span> {entry.next_changes}
                </p>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
