import { useState, type ReactNode } from 'react'
import { api } from '../../api/client'
import { useMergeDecision } from '../../api/queries'
import type { Experiment, MetricResult, Project, VerdictDetail } from '../../api/types'
import { CodeToken, Delta, MetricName, Tag } from '../../components/Badges'
import { CompareBars, ImprovementChart } from '../../components/Charts'
import { ConfirmDialog } from '../../components/Dialog'
import { ExternalIcon, FileIcon, GateIcon, MergeIcon, XIcon } from '../../components/Icons'
import { PredictedLine } from '../../components/Prediction'
import { TableScroll } from '../../components/Table'
import { useToast } from '../../components/Toast'
import { Banner, Button, Card, Chip, cx, DefinitionList, Disclosure, errorMessage, Field } from '../../components/ui'
import { displayValue, formatCI, formatNumber, formatWorkload, humanize } from '../../lib/format'
import { claimTarget, currentIteration, protocolOf, recommendDecision, type DecisionRecommendation } from '../../lib/protocol'
import { predictionMatchesMetric } from '../../lib/roofline'
import { semanticTone } from '../../lib/semantics'
import { FidelityBadge } from './Protocol'
import { DiagnosisCallout, IterationsTimeline, MechanismTableView, TuningTable, VerdictTiles } from './VerdictV2'

const DECISION_NOTE = 'Merging puts the change on the main branch behind its flag, off by default. Dropping removes the branch; the results are kept.'

const ITERATING = ['approving', 'building', 'smoke_testing', 'tuning', 'waiting_gpu', 'running', 'judging']

function MetricsTable({ perMetric, primary, project, label }: { perMetric: Record<string, MetricResult>; primary: string; project?: Project; label: string }) {
  const rows = Object.entries(perMetric).sort(([a], [b]) => (a === primary ? -1 : b === primary ? 1 : a.localeCompare(b)))
  return (
    <TableScroll label={label} stickyFirstColumn>
      <table className="w-full text-sm">
        <caption className="sr-text">{label} (medians over paired rounds)</caption>
        <thead className="bg-canvas-subtle text-left text-xs text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Metric
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Baseline
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Method
            </th>
            <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
              <span className="sr-text">Comparison</span>
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Change
            </th>
            <th scope="col" className="hidden px-3 py-2 text-right font-medium md:table-cell">
              Pairs
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, metric]) => {
            const unit = project?.metrics?.find((m) => m.name === name)?.unit
            const significant = metric.ci_low_pct > 0 || metric.ci_high_pct < 0
            return (
              <tr key={name} className="border-t border-line-muted align-top">
                <th scope="row" className="min-w-44 px-3 py-2 text-left font-normal">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <MetricName metric={name} className="text-fg" />
                    {name === primary && <Tag>Primary</Tag>}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <CodeToken className="text-xs">{name}</CodeToken> {humanize(metric.direction)}
                  </span>
                </th>
                <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                  {formatNumber(metric.baseline_median)} <span className="text-xs text-muted">{unit}</span>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                  {formatNumber(metric.variant_median)} <span className="text-xs text-muted">{unit}</span>
                </td>
                <td className="hidden px-3 py-2 sm:table-cell">
                  <CompareBars baseline={metric.baseline_median} variant={metric.variant_median} better={metric.direction} />
                </td>
                <td className="px-3 py-2 text-right">
                  <Delta value={metric.median_improvement_pct} significant={significant} />
                  <div className="text-xs whitespace-nowrap text-muted tabular-nums">CI {formatCI(metric.ci_low_pct, metric.ci_high_pct)}</div>
                </td>
                <td className="hidden px-3 py-2 text-right text-xs text-muted md:table-cell">{metric.pairs}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </TableScroll>
  )
}

function DecisionDialog({ kind, onClose, experiment, recommendation }: { kind: 'merge' | 'drop'; onClose: () => void; experiment: Experiment; recommendation: DecisionRecommendation }) {
  const decide = useMergeDecision(experiment.id)
  const toast = useToast()
  const [comment, setComment] = useState('')
  const merge = kind === 'merge'
  const against = (merge && recommendation.action === 'drop') || (!merge && recommendation.action === 'merge')
  const submit = () => {
    if (decide.isPending) return
    decide.mutate(
      { decision: kind, comment: comment.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(merge ? 'Merge requested: the worker is merging the branch.' : 'Drop requested: the branch and worktree will be removed.')
          onClose()
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    )
  }
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={submit}
      title={merge ? 'Merge this change?' : 'Drop this change?'}
      confirmLabel={against ? (merge ? 'Merge anyway' : 'Drop anyway') : merge ? 'Merge branch' : 'Drop branch'}
      variant={merge ? 'primary' : 'danger'}
      loading={decide.isPending}
      error={decide.error}
      recap={
        <>
          <span className="block">{recommendation.recap}</span>
          <span className="mt-0.5 block text-sm text-muted">
            Recommendation: <strong className="text-fg">{recommendation.label}</strong>. {recommendation.reason}
          </span>
        </>
      }
      warning={
        against ? (
          merge ? (
            <>
              The evidence says <strong>drop</strong>. Merging puts code on the main branch that{' '}
              {recommendation.claim.qualityOk && recommendation.adoption.qualityOk ? 'measured worse than the current default on your workload' : 'broke a quality guardrail'} when the
              flag <CodeToken>{experiment.flag_name}</CodeToken> is on. The flag stays off by default.
            </>
          ) : (
            <>The evidence says <strong>merge</strong>: it measured a clear gain on your workload. Dropping removes the branch; you can re-run the experiment later.</>
          )
        ) : undefined
      }
    >
      <p className="mb-3 text-muted">
        {merge ? (
          <>
            Merges <CodeToken>{experiment.branch}</CodeToken> into the project’s main branch with a merge commit. The flag <CodeToken>{experiment.flag_name}</CodeToken> stays{' '}
            <strong>off by default</strong>.
          </>
        ) : (
          <>Removes the branch and its worktree. The verdict, report and measurements are kept.</>
        )}
      </p>
      <Field label="Comment (optional)" htmlFor={`gate3-${kind}-comment`}>
        <textarea id={`gate3-${kind}-comment`} className="input min-h-20" value={comment} onChange={(event) => setComment(event.target.value)} disabled={decide.isPending} />
      </Field>
    </ConfirmDialog>
  )
}

function RecommendationIcon({ recommendation }: { recommendation: DecisionRecommendation }) {
  const tone = semanticTone(recommendation.tone)
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex size-9 shrink-0 items-center justify-center rounded-full border',
        tone === 'positive' ? 'border-positive/30 bg-positive-subtle text-positive-fg' : tone === 'negative' ? 'border-negative/30 bg-negative-subtle text-negative-fg' : 'border-caution-emphasis/60 bg-caution-subtle text-caution-fg',
      )}
    >
      {recommendation.action === 'merge' ? <MergeIcon size={18} /> : recommendation.action === 'drop' ? <XIcon size={18} /> : <GateIcon size={18} />}
    </span>
  )
}

/**
 * Gate 3's bottom line (docs/ux-review.md X-1): one recommendation with its reason, the two measured answers,
 * then the decision, with the recommended action as the primary button. Shown first on every judged experiment.
 */
export function DecisionSummary({ experiment, verdict }: { experiment: Experiment; verdict: VerdictDetail }) {
  const [dialog, setDialog] = useState<'merge' | 'drop' | null>(null)
  const recommendation = recommendDecision(verdict)
  const details = verdict.details ?? {}
  const gateOpen = experiment.status === 'awaiting_decision'
  const iterating = ITERATING.includes(experiment.status)
  const protocol = protocolOf(experiment.spec)
  const iteration = details.iteration ?? currentIteration(experiment)
  const iterations = details.iterations?.length ?? 0
  const decided = experiment.status === 'merged' ? 'merged' : experiment.status === 'dropped' ? 'dropped' : null
  const word = <strong className={cx(recommendation.action === 'merge' ? 'text-positive-fg' : recommendation.action === 'drop' ? 'text-negative-fg' : 'text-caution-fg')}>{recommendation.label}</strong>

  let headline: ReactNode
  if (iterating) headline = <>Latest result, iteration {iteration}</>
  else if (decided === 'merged') headline = <>Merged · the flag stays off by default</>
  else if (decided === 'dropped') headline = <>Dropped</>
  else if (recommendation.action === 'your_call') headline = <>{word}: the evidence doesn’t point either way</>
  else headline = <>Recommendation: {word}</>

  const mergeVariant = recommendation.action === 'merge' ? 'primary' : 'default'
  const dropVariant = recommendation.action === 'drop' ? 'primary' : 'default'
  // Secondary first, the recommended (primary) action last; no primary at all when it's the user's call.
  const buttons = (
    <div className="flex flex-wrap gap-2 max-sm:[&>*]:flex-1">
      {recommendation.action === 'drop' ? (
        <>
          <Button variant={mergeVariant} icon={<MergeIcon />} onClick={() => setDialog('merge')}>
            Merge anyway…
          </Button>
          <Button variant={dropVariant} icon={<XIcon />} onClick={() => setDialog('drop')}>
            Drop
          </Button>
        </>
      ) : (
        <>
          <Button variant={dropVariant} icon={<XIcon />} onClick={() => setDialog('drop')}>
            {recommendation.action === 'merge' ? 'Drop anyway…' : 'Drop…'}
          </Button>
          <Button variant={mergeVariant} icon={<MergeIcon />} onClick={() => setDialog('merge')}>
            {recommendation.action === 'merge' ? 'Merge' : 'Merge…'}
          </Button>
        </>
      )}
    </div>
  )

  return (
    <Card
      id="gate"
      attention={gateOpen}
      title={
        <span className="flex items-center gap-2">
          <GateIcon className={gateOpen ? 'text-caution-fg' : 'text-muted'} />
          {gateOpen ? 'Gate 3 · Decide: merge or drop' : 'Result'}
        </span>
      }
      actions={
        verdict.has_report ? (
          <a href={api.lab.reportUrl(experiment.id)} target="_blank" rel="noreferrer" className="inline-flex min-h-6 items-center gap-1 text-xs max-sm:hidden">
            <FileIcon size={14} /> Full report <ExternalIcon size={12} />
          </a>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          {!iterating && !decided && <RecommendationIcon recommendation={recommendation} />}
          <div className="min-w-0">
            <p className="text-title text-fg">{headline}</p>
            {iterating ? (
              <p className="mt-1 text-sm text-muted">A new iteration is being built and measured; the recommendation comes once it’s judged.</p>
            ) : (
              <>
                <p className="mt-1 max-w-3xl text-body-lg text-fg">
                  {decided && (
                    <span className="text-muted">
                      {recommendation.action === 'your_call' ? 'The evidence didn’t point either way: ' : `The evidence suggested ${recommendation.action === 'merge' ? 'merging' : 'dropping'}: `}
                    </span>
                  )}
                  {recommendation.reason}
                </p>
                {recommendation.warnings.length > 0 && (
                  <div className="mt-3 max-w-3xl">
                    <Banner tone="caution">
                      <strong className="font-semibold">Check before trusting this result.</strong>{' '}
                      {recommendation.warnings.join(' ')}
                    </Banner>
                  </div>
                )}
                {gateOpen && (
                  <div className="mt-3 space-y-1.5 sm:hidden">
                    {buttons}
                    <p className="text-xs text-muted">{DECISION_NOTE}</p>
                  </div>
                )}
                <p className="mt-1 max-w-3xl text-sm text-muted max-sm:mt-3">{recommendation.claimSentence}</p>
              </>
            )}
          </div>
        </div>

        <VerdictTiles experiment={experiment} verdict={verdict} />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
          {protocol.version >= 2 && <FidelityBadge level={protocol.fidelity.level} />}
          {iterations > 1 && (
            <span>
              After {iterations} iterations
              {experiment.build.kept_iteration != null && ` · iteration ${experiment.build.kept_iteration} kept`}
            </span>
          )}
          {details.code_effect && (
            <a href="#code-changes" className="min-h-6 font-medium">
              What the code changed, and why ↓
            </a>
          )}
          {details.analysis && (
            <a href="#evidence" className="min-h-6 font-medium">
              Why it came out this way ↓
            </a>
          )}
        </div>

        {gateOpen && (
          <div className="hidden items-center justify-between gap-3 border-t border-line-muted pt-4 sm:flex">
            <p className="max-w-xl text-xs text-muted">{DECISION_NOTE}</p>
            {buttons}
          </div>
        )}
        {experiment.status === 'finalizing' && <p className="text-sm text-info-fg">Decision recorded: the worker is applying it.</p>}
        {experiment.status === 'merged' && experiment.build.merge_sha && (
          <p className="flex items-center gap-1 text-sm text-merged-fg">
            <MergeIcon /> Merged at <CodeToken>{String(experiment.build.merge_sha).slice(0, 10)}</CodeToken> (flag off by default).
          </p>
        )}
      </div>
      {dialog && <DecisionDialog kind={dialog} experiment={experiment} recommendation={recommendation} onClose={() => setDialog(null)} />}
    </Card>
  )
}

/** Why the result came out this way, then the evidence and run details on demand (docs/ux-review.md X-5). */
export function VerdictPanel({ experiment, verdict, project }: { experiment: Experiment; verdict: VerdictDetail; project?: Project }) {
  const [showReport, setShowReport] = useState(false)
  const details = verdict.details ?? {}
  const threshold = details.success_threshold_pct ?? experiment.spec.success_threshold_pct ?? null
  const target = details.target_pct ?? claimTarget(verdict.claimed_gain_pct, threshold)
  const quality = details.quality ?? {}
  const problems = details.quality_problems ?? []
  const environment = details.environment ?? {}
  const reportUrl = api.lab.reportUrl(experiment.id)
  const iterations = details.iterations ?? []
  const maxIterations = protocolOf(experiment.spec).max_iterations
  const settled = !ITERATING.includes(experiment.status)
  const adoption = details.adoption
  const evidenceParts = [
    'chart',
    details.per_metric && 'per-metric results',
    details.mechanism?.rows?.length && 'counters',
    details.tuning && 'tuning',
  ].filter(Boolean) as string[]

  return (
    <Card id="evidence" title="Evidence">
      <div className="space-y-3">
        {details.analysis ? (
          <DiagnosisCallout analysis={details.analysis} iteration={details.iteration ?? currentIteration(experiment)} maxIterations={maxIterations} settled={settled} />
        ) : (
          details.reason && <p className="text-sm text-fg">{details.reason}</p>
        )}

        {iterations.length > 1 && (
          <Disclosure label="How the result was reached" meta={` · ${iterations.length} iterations`}>
            <IterationsTimeline iterations={iterations} kept={experiment.build.kept_iteration} />
          </Disclosure>
        )}

        <Disclosure label="Evidence" meta={` · ${evidenceParts.join(', ')}`}>
          <div className="space-y-5">
            <div>
              <h3 className="mb-1 text-sm font-semibold">Claim check vs the paper</h3>
              <div className="rounded-md border border-line-muted px-3 py-2">
                <ImprovementChart
                  median={verdict.median_delta_pct}
                  low={verdict.ci_low_pct}
                  high={verdict.ci_high_pct}
                  claimed={verdict.claimed_gain_pct}
                  threshold={threshold}
                  target={target}
                  predicted={predictionMatchesMetric(experiment.spec.prediction, verdict.primary_metric) ? experiment.spec.prediction!.predicted_gain_pct : null}
                />
              </div>
              <PredictedLine prediction={experiment.spec.prediction} metric={verdict.primary_metric} className="mt-1.5" />
              {details.reason && details.analysis && <p className="mt-1 text-xs text-muted">Judge: {details.reason}</p>}
            </div>
            {details.per_metric && Object.keys(details.per_metric).length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-semibold">Every metric · claim check</h3>
                <p className="mb-2 text-xs text-muted">Positive means the metric moved in its better direction. “No clear change” means the 95% CI includes 0.</p>
                <MetricsTable perMetric={details.per_metric} primary={verdict.primary_metric} project={project} label="Per-metric results, claim check" />
              </div>
            )}
            {adoption?.per_metric && Object.keys(adoption.per_metric).length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold">Every metric · adoption check</h3>
                <MetricsTable perMetric={adoption.per_metric} primary={verdict.primary_metric} project={project} label="Per-metric results, adoption check" />
              </div>
            )}
            {details.mechanism && <MechanismTableView mechanism={details.mechanism} />}
            {details.tuning && (
              <TuningTable
                tuning={details.tuning}
                metric={verdict.primary_metric}
                direction={experiment.spec.direction}
                knobOrder={protocolOf(experiment.spec).knobs.map((knob) => knob.name)}
              />
            )}
          </div>
        </Disclosure>

        <Disclosure label="Run details" meta=" · quality, environment, report">
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold">Quality</h3>
                <DefinitionList
                  items={[
                    ['Exact match', `${displayValue(quality.baseline?.exact_match, 'not reported')} → ${displayValue(quality.variant?.exact_match, 'not reported')}`],
                    ['Output agreement', typeof quality.output_agreement === 'number' ? `${(quality.output_agreement * 100).toFixed(0)}%` : 'Not reported'],
                    ['Problems', problems.length ? <span className="text-negative-fg">{problems.join('; ')}</span> : 'None'],
                  ]}
                />
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold">Environment</h3>
                <DefinitionList
                  items={[
                    ['Model', displayValue(details.model ?? experiment.spec.model, 'Not reported')],
                    ['Workload', formatWorkload(details.workload ?? experiment.spec.workload, 'Not reported')],
                    [
                      'Machine',
                      [
                        displayValue(environment.chip, ''),
                        environment.macos ? `macOS ${displayValue(environment.macos)}` : '',
                        environment.torch ? `torch ${displayValue(environment.torch)}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Not reported',
                    ],
                    [
                      'Conditions',
                      <span key="cond" className="flex flex-wrap gap-1">
                        {environment.on_ac_power === false ? <Chip tone="caution">On battery</Chip> : environment.on_ac_power ? <Chip tone="neutral">AC power</Chip> : null}
                        {environment.thermal_warning ? <Chip tone="caution">Thermal throttling</Chip> : environment.thermal_warning === false ? <Chip tone="neutral">No throttling</Chip> : null}
                      </span>,
                    ],
                  ]}
                />
              </div>
            </div>
            {verdict.has_report ? (
              <div className="flex flex-wrap items-center gap-2">
                <a href={reportUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-7 items-center gap-1 text-sm">
                  <FileIcon size={14} /> Open the full report <ExternalIcon size={12} />
                </a>
                <Button size="sm" variant="invisible" onClick={() => setShowReport(!showReport)} aria-expanded={showReport}>
                  {showReport ? 'Hide the report' : 'Show the report here'}
                </Button>
                {showReport && (
                  <iframe title={`Experiment ${experiment.id} report`} src={reportUrl} sandbox="" className="mt-2 h-[640px] w-full rounded-md border border-line bg-canvas" />
                )}
              </div>
            ) : (
              <p className="text-sm text-muted">No report file was written for this verdict.</p>
            )}
          </div>
        </Disclosure>
      </div>
    </Card>
  )
}
