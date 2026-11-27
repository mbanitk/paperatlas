import type { Analysis, Experiment, IterationEntry, MechanismTable, TuningResult, VerdictDetail } from '../../api/types'
import { CodeToken, Delta, MetricName, OutcomeBadge } from '../../components/Badges'
import { ArrowDownIcon, ArrowUpIcon, CheckIcon } from '../../components/Icons'
import { TableScroll } from '../../components/Table'
import { AnswerBlock, Chip, cx, Disclosure } from '../../components/ui'
import { formatCI, formatNumber, formatSigned, formatWorkload, humanize, roundNumbersInText } from '../../lib/format'
import { chosenBy, claimTarget, diagnosisInfo, formatConfig, formatKnobValue, recommendDecision, type CheckResult } from '../../lib/protocol'
import { semanticTone } from '../../lib/semantics'
import { formatChangeCounts } from '../../lib/codeChanges'

const ci = (check: Pick<CheckResult, 'low' | 'high'>) => (check.low !== null && check.high !== null ? `95% CI ${formatCI(check.low, check.high)}` : null)

/**
 * The two measured answers, side by side (docs/ux-review.md X-1, X-3): "Does the paper's claim hold?" (claim
 * check) and "Is it worth adopting here?" (adoption check). Each is tinted by its own outcome only.
 */
export function VerdictTiles({ experiment, verdict }: { experiment: Experiment; verdict: VerdictDetail }) {
  const details = verdict.details ?? {}
  const comparison = details.comparison
  const recommendation = recommendDecision(verdict)
  const { claim, adoption } = recommendation
  const threshold = details.success_threshold_pct ?? experiment.spec.success_threshold_pct ?? null
  const target = details.target_pct ?? claimTarget(verdict.claimed_gain_pct, threshold)
  const paperBaseline = comparison?.baseline === 'paper baseline'
  const paperWorkload = comparison?.workload === 'paper regime'
  // The planner's baseline description can run to a paragraph; it lives in the test plan, not in this tile.
  const claimSetup = `vs ${paperBaseline ? 'the paper’s baseline' : 'the project default'} on ${
    paperWorkload ? 'a paper-like workload' : (comparison?.workload ?? formatWorkload(details.workload ?? experiment.spec.workload))
  }`
  const adoptionWorkload = formatWorkload(details.adoption?.workload ?? details.workload ?? experiment.spec.workload)
  const sep = <span aria-hidden="true"> · </span>

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <AnswerBlock
        register="measured"
        tone={claim.info.tone}
        label={
          <span>
            <span className="font-semibold text-fg">Claim check</span> · does the paper’s claim hold?
          </span>
        }
        value={formatSigned(claim.delta, { digits: 1, fallback: 'Not measured' })}
        badge={<OutcomeBadge kind="verdict" value={claim.verdict} explain />}
        confidence={
          <>
            {ci(claim)}
            {target !== null && (
              <>
                {sep}target {formatSigned(target, { digits: 1 })}
              </>
            )}
            {typeof verdict.claimed_gain_pct === 'number' && (
              <>
                {sep}paper reports {formatSigned(verdict.claimed_gain_pct, { digits: 0 })}
              </>
            )}
            {claim.quality === 'unmeasured' && <>{sep}quality not fully measured</>}
            {!claim.qualityOk && (
              <>
                {sep}
                <span className="font-semibold text-negative-fg">quality failed: {claim.qualityProblems.join('; ') || 'guardrail broken'}</span>
              </>
            )}
            <span className="block">
              <MetricName metric={verdict.primary_metric} /> · {claimSetup}
            </span>
          </>
        }
      />
      <AnswerBlock
        register="measured"
        tone={adoption.info.tone}
        label={
          <span>
            <span className="font-semibold text-fg">Adoption check</span> · worth adopting here?
          </span>
        }
        value={formatSigned(adoption.delta, { digits: 1, fallback: 'Not measured' })}
        badge={<OutcomeBadge kind="adoption" value={adoption.verdict} explain />}
        confidence={
          recommendation.separateAdoption ? (
            <>
              {ci(adoption)}
              {threshold !== null && (
                <>
                  {sep}success bar {formatSigned(threshold, { digits: 1 })}
                </>
              )}
              {sep}quality{' '}
              {adoption.quality === 'ok' ? (
                'OK'
              ) : adoption.quality === 'unmeasured' ? (
                'not fully measured'
              ) : (
                <span className="font-semibold text-negative-fg">failed: {adoption.qualityProblems.join('; ') || 'guardrail broken'}</span>
              )}
              <span className="block">vs the project default on {adoptionWorkload}</span>
            </>
          ) : recommendation.paperOnly ? (
            'Not measured on your default workload: the claim check used the paper’s setup.'
          ) : (
            <>
              Same A/B test as the claim check (project default, your workload){threshold !== null && <>{sep}success bar {formatSigned(threshold, { digits: 1 })}</>}
            </>
          )
        }
      />
    </div>
  )
}

/** The analyst's reading of the result: one sentence and a label first, the full analysis on demand (X-5). */
export function DiagnosisCallout({ analysis, iteration, maxIterations, settled }: { analysis: Analysis; iteration: number; maxIterations: number; settled: boolean }) {
  const info = diagnosisInfo(analysis.diagnosis)
  const suggested = analysis.worth_iterating && analysis.next_changes?.trim()
  const hasMore = analysis.evidence?.length > 0 || !!analysis.paper_comparison || !!suggested
  const tone = semanticTone(info.tone)
  return (
    <section
      className={cx('rounded-lg border border-l-4 border-line bg-canvas px-3.5 py-3', tone === 'negative' ? 'border-l-negative-emphasis' : 'border-l-neutral-emphasis')}
      aria-label="Why it came out this way"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-fg">Why it came out this way</h3>
        <OutcomeBadge kind="diagnosis" value={analysis.diagnosis} explain />
        {analysis.model && <span className="ml-auto text-xs text-muted">analysis by {analysis.model}</span>}
      </div>
      {analysis.summary && <p className="mt-2 line-clamp-3 text-sm text-fg">{roundNumbersInText(analysis.summary)}</p>}
      {hasMore && (
        <Disclosure label="Show full analysis" className="mt-1.5">
          <div className="space-y-2 text-sm">
            {analysis.summary && <p className="text-fg">{roundNumbersInText(analysis.summary)}</p>}
            {analysis.evidence?.length > 0 && (
              <ul className="space-y-1">
                {analysis.evidence.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-muted" aria-hidden="true" />
                    <span>{roundNumbersInText(item)}</span>
                  </li>
                ))}
              </ul>
            )}
            {analysis.paper_comparison && (
              <p className="rounded-md border border-line bg-canvas-subtle px-2.5 py-1.5">
                <span className="mr-1 text-xs font-semibold text-muted">Compared with the paper:</span>
                {roundNumbersInText(analysis.paper_comparison)}
              </p>
            )}
            {suggested && (
              <p>
                <span className="text-xs font-semibold text-muted">
                  {settled && iteration >= maxIterations
                    ? `Suggested next change, not tried (the limit of ${maxIterations} iteration${maxIterations > 1 ? 's' : ''} was reached)`
                    : 'Next change'}
                  :
                </span>{' '}
                {analysis.next_changes}
                {analysis.expected_effect && <span className="block text-xs text-muted">Expected: {analysis.expected_effect}</span>}
              </p>
            )}
          </div>
        </Disclosure>
      )}
    </section>
  )
}

function Change({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span className="text-muted">Not reported</span>
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-fg tabular-nums">
      {value > 0 ? <ArrowUpIcon size={12} className="text-muted" /> : value < 0 ? <ArrowDownIcon size={12} className="text-muted" /> : null}
      {formatSigned(value, { digits: 1 })}
    </span>
  )
}

/** Mechanism counters per 1k generated tokens, baseline vs method, next to the paper's values. */
export function MechanismTableView({ mechanism }: { mechanism: MechanismTable }) {
  const missing = new Set(mechanism.missing ?? [])
  if (!mechanism.rows?.length && !missing.size) return null
  return (
    <div>
      <h3 className="mb-1 flex flex-wrap items-center gap-2 text-sm font-semibold">
        What the technique did
        {missing.size > 0 ? (
          <Chip tone="caution">{missing.size} counter{missing.size > 1 ? 's' : ''} not reported</Chip>
        ) : (
          mechanism.measured && <Chip tone="neutral">All counters reported</Chip>
        )}
      </h3>
      <p className="mb-2 text-xs text-muted">Counts per 1,000 generated tokens. They tell a broken build apart from a claim that doesn’t transfer.</p>
      <TableScroll label="Mechanism counters" stickyFirstColumn>
        <table className="w-full text-sm">
          <caption className="sr-text">Mechanism counters per 1,000 generated tokens</caption>
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
                <tr key={row.name} className={cx('border-t border-line-muted align-top', absent && 'bg-caution-subtle/50')}>
                  <th scope="row" className="min-w-40 px-3 py-2 text-left font-normal">
                    <div className="text-fg">{row.meaning || humanize(row.name)}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <CodeToken className="text-xs">{row.name}</CodeToken>
                      {!row.expected && <span className="text-xs text-muted">extra</span>}
                    </div>
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.baseline_per_1k_tokens, 1)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {absent ? <span className="text-xs font-semibold text-caution-fg">Not reported</span> : formatNumber(row.variant_per_1k_tokens, 1)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Change value={row.change_pct} />
                  </td>
                  <td className="px-3 py-2 text-xs text-fg">{row.paper_value ?? <span className="text-muted">Not reported</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableScroll>
      {mechanism.tokens && (mechanism.tokens.baseline > 0 || mechanism.tokens.variant > 0) && (
        <p className="mt-1 text-xs text-muted">
          Measured over {formatNumber(mechanism.tokens.baseline, 0)} baseline and {formatNumber(mechanism.tokens.variant, 0)} method tokens.
        </p>
      )}
    </div>
  )
}

/** The settings sweep before the measured runs: each side keeps its best configuration. */
export function TuningTable({ tuning, metric, direction, knobOrder = [] }: { tuning: TuningResult; metric?: string; direction?: string; knobOrder?: string[] }) {
  if (tuning.skipped || !tuning.trials?.length) {
    return (
      <p className="text-sm text-muted">
        Tuning skipped{tuning.configs?.length ? `: ran the paper’s setting (${formatConfig(tuning.variant)})` : ': there were no settings to tune'}.
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
        Before measuring, {tuning.trials.length} settings were tried with short runs on <MetricName metric={tuning.metric ?? metric} />. Each side keeps its
        best setting, so the baseline gets the same tuning budget as the method.
      </p>
      <TableScroll label="Tuning trials" stickyFirstColumn>
        <table className="w-full text-sm">
          <caption className="sr-text">Tuning trials</caption>
          <thead className="bg-canvas-subtle text-left text-xs text-muted">
            <tr>
              {knobs.map((knob) => (
                <th key={knob} scope="col" className="px-3 py-2 font-mono font-medium whitespace-nowrap">
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
                Chosen for
              </th>
            </tr>
          </thead>
          <tbody>
            {tuning.trials.map((trial, index) => {
              const chosen = chosenBy(tuning, trial.config)
              return (
                <tr key={index} className={cx('border-t border-line-muted', chosen.includes('method') && 'bg-info-subtle/40')}>
                  {knobs.map((knob) => (
                    <td key={knob} className="px-3 py-1.5 font-mono text-xs whitespace-nowrap tabular-nums">
                      {formatKnobValue(trial.config[knob])}
                      {index === 0 && knob === knobs[0] && <span className="ml-1.5 font-sans text-xs text-muted">(paper)</span>}
                    </td>
                  ))}
                  <td className={cx('px-3 py-1.5 text-right tabular-nums', trial.baseline === bestBaseline && 'font-semibold')}>{formatNumber(trial.baseline)}</td>
                  <td className={cx('px-3 py-1.5 text-right tabular-nums', trial.variant === bestVariant && 'font-semibold')}>{formatNumber(trial.variant)}</td>
                  <td className="px-3 py-1.5 text-xs whitespace-nowrap">
                    {chosen.length === 0 && <span className="text-muted">Neither</span>}
                    {chosen.map((arm) => (
                      <span key={arm} className="mr-1.5 inline-flex items-center gap-0.5 text-fg">
                        <CheckIcon size={12} className="text-muted" /> {arm}
                      </span>
                    ))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableScroll>
    </div>
  )
}

/** What happened in each build → measure → analyse round, in plain words. */
export function IterationsTimeline({ iterations, kept }: { iterations: IterationEntry[]; kept?: number | null }) {
  if (iterations.length < 2) return null
  const keptEntry = kept != null ? iterations.find((entry) => entry.iteration === kept) : undefined
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">How the result was reached: {iterations.length} iterations</h3>
      <p className="mb-2 text-xs text-muted">
        When the analysis finds a fixable problem, the build goes back to the coding agent with one change, then it’s measured again.{' '}
        {keptEntry && keptEntry !== iterations[iterations.length - 1]
          ? `Iteration ${keptEntry.iteration} scored best, so its code was kept and later changes were reverted; the result above is iteration ${keptEntry.iteration}’s.`
          : keptEntry
            ? 'The last iteration scored best and was kept.'
            : ''}
      </p>
      <ol className="relative space-y-3 border-l-2 border-line-muted pl-4">
        {iterations.map((entry, index) => {
          const last = index === iterations.length - 1
          const state = keptEntry ? (entry.iteration === keptEntry.iteration ? 'kept' : entry.iteration > keptEntry.iteration ? 'reverted' : null) : last ? 'final' : null
          return (
            <li key={entry.iteration} className="relative">
              <span
                className={cx('absolute top-1 -left-[23px] size-3 rounded-full border-2 border-canvas', state === 'kept' || state === 'final' ? 'bg-info' : 'bg-neutral-emphasis')}
                aria-hidden="true"
              />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className={cx('font-semibold', state === 'reverted' && 'text-muted')}>Iteration {entry.iteration}</span>
                {state === 'kept' && <Chip tone="info">Kept</Chip>}
                {state === 'final' && <Chip tone="info">Final</Chip>}
                {state === 'reverted' && <Chip tone="neutral">Reverted</Chip>}
                {entry.quality_ok === false && <Chip tone="negative">Quality failed</Chip>}
                {entry.diagnosis && <OutcomeBadge kind="diagnosis" value={entry.diagnosis} />}
              </div>
              <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-sm">
                <dt className="text-xs text-muted">Claim check</dt>
                <dd className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <OutcomeBadge kind="verdict" value={entry.verdict} />
                  <Delta value={entry.median_delta_pct} ci={[entry.ci_low_pct, entry.ci_high_pct]} />
                </dd>
                {entry.adoption_verdict && (
                  <>
                    <dt className="text-xs text-muted">Adoption check</dt>
                    <dd className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <OutcomeBadge kind="adoption" value={entry.adoption_verdict} />
                      <Delta value={entry.adoption_median_delta_pct} />
                    </dd>
                  </>
                )}
              </dl>
              {entry.summary && <p className="mt-1 text-sm text-muted">{roundNumbersInText(entry.summary)}</p>}
              {entry.tuned?.variant && Object.keys(entry.tuned.variant).length > 0 && <p className="mt-0.5 text-xs text-muted">Tuned method: {formatConfig(entry.tuned.variant)}</p>}
              {entry.changes?.files_changed != null && (
                <p className="mt-0.5 text-xs text-muted">
                  Code: {entry.changes.files_changed} file{entry.changes.files_changed === 1 ? '' : 's'}, <span className="font-mono">{formatChangeCounts(entry.changes.additions, entry.changes.deletions)}</span> from the base
                </p>
              )}
              {!last && entry.next_changes && (
                <p className="mt-1 rounded-md border border-line-muted bg-canvas-subtle px-2 py-1 text-xs">
                  <span className="font-semibold">Changed for the next iteration:</span> {entry.next_changes}
                </p>
              )}
              {entry.sha && (
                <p className="mt-0.5 text-xs text-muted">
                  Commit <CodeToken className="text-xs">{entry.sha.slice(0, 7)}</CodeToken>
                </p>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
