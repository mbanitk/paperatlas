import { useState, type ReactNode } from 'react'
import { api } from '../../api/client'
import { useMergeDecision } from '../../api/queries'
import type { Experiment, MetricResult, Project, VerdictDetail } from '../../api/types'
import { Delta, VerdictBadge } from '../../components/Badges'
import { CompareBars, ImprovementChart } from '../../components/Charts'
import { Modal } from '../../components/Dialog'
import { CheckIcon, ExternalIcon, FileIcon, GateIcon, MergeIcon, XIcon } from '../../components/Icons'
import { useToast } from '../../components/Toast'
import { Button, Card, Chip, DefinitionList, Field, InlineError, cx, errorMessage } from '../../components/ui'
import { displayValue, formatCI, formatNumber, formatPct, formatWorkload, humanize } from '../../lib/format'

const REPRODUCED_FRACTION_OF_CLAIM = 0.7

function Stat({ label, children, sub, className }: { label: string; children: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-lg border border-line-muted bg-canvas-subtle px-3 py-2.5', className)}>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{children}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  )
}

function MetricsTable({ perMetric, primary, project }: { perMetric: Record<string, MetricResult>; primary: string; project?: Project }) {
  const rows = Object.entries(perMetric).sort(([a], [b]) => (a === primary ? -1 : b === primary ? 1 : a.localeCompare(b)))
  return (
    <div className="overflow-x-auto rounded-md border border-line-muted">
      <table className="w-full text-sm">
        <caption className="sr-only">Per-metric A/B results (medians over paired rounds)</caption>
        <thead className="bg-canvas-subtle text-left text-xs text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Metric
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Baseline
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Variant
            </th>
            <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
              <span className="sr-only">Comparison</span>
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Improvement
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              95% CI
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
              <tr key={name} className={cx('border-t border-line-muted', name === primary && 'bg-accent-subtle/40')}>
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <code className="code-inline">{name}</code>
                  {name === primary && (
                    <span className="ml-1 text-accent" title="Primary metric">
                      ★
                    </span>
                  )}
                  <div className="text-[11px] text-muted">{humanize(metric.direction)}</div>
                </th>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatNumber(metric.baseline_median)} <span className="text-xs text-muted">{unit}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatNumber(metric.variant_median)} <span className="text-xs text-muted">{unit}</span>
                </td>
                <td className="hidden px-3 py-2 sm:table-cell">
                  <CompareBars baseline={metric.baseline_median} variant={metric.variant_median} better={metric.direction} />
                </td>
                <td className="px-3 py-2 text-right">
                  <Delta value={metric.median_improvement_pct} className={significant ? '' : 'opacity-60'} />
                </td>
                <td className="px-3 py-2 text-right text-xs whitespace-nowrap text-muted tabular-nums">{formatCI(metric.ci_low_pct, metric.ci_high_pct)}</td>
                <td className="hidden px-3 py-2 text-right text-xs text-muted md:table-cell">{metric.pairs}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function DecisionDialog({ kind, onClose, experiment }: { kind: 'merge' | 'drop'; onClose: () => void; experiment: Experiment }) {
  const decide = useMergeDecision(experiment.id)
  const toast = useToast()
  const [comment, setComment] = useState('')
  const merge = kind === 'merge'
  const submit = () => {
    if (decide.isPending) return
    decide.mutate(
      { decision: kind, comment: comment.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(merge ? 'Merge requested — the worker is merging the branch.' : 'Drop requested — the branch and worktree will be removed.')
          onClose()
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    )
  }
  return (
    <Modal
      open
      onClose={onClose}
      dismissable={!decide.isPending}
      size="sm"
      title={merge ? 'Merge this experiment?' : 'Drop this experiment?'}
      footer={
        <>
          <Button onClick={onClose} disabled={decide.isPending}>
            Cancel
          </Button>
          <Button
            variant={merge ? 'primary' : 'dangerSolid'}
            onClick={submit}
            loading={decide.isPending}
            icon={merge ? <MergeIcon /> : <XIcon />}
          >
            {merge ? 'Merge branch' : 'Drop branch'}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-muted">
        {merge ? (
          <>
            Merges <code className="code-inline">{experiment.branch}</code> into the project’s main branch with a merge commit. The flag{' '}
            <code className="code-inline">{experiment.flag_name}</code> stays <strong>off by default</strong>.
          </>
        ) : (
          <>Removes the branch and its worktree. The verdict, report and measurements are kept.</>
        )}
      </p>
      <Field label="Comment (optional)" htmlFor={`gate3-${kind}-comment`}>
        <textarea id={`gate3-${kind}-comment`} className="input min-h-20" value={comment} onChange={(event) => setComment(event.target.value)} disabled={decide.isPending} />
      </Field>
      <InlineError error={decide.error} />
    </Modal>
  )
}

export function VerdictPanel({ experiment, verdict, project }: { experiment: Experiment; verdict: VerdictDetail; project?: Project }) {
  const [dialog, setDialog] = useState<'merge' | 'drop' | null>(null)
  const [showReport, setShowReport] = useState(false)
  const details = verdict.details ?? {}
  const gateOpen = experiment.status === 'awaiting_decision'
  const threshold = details.success_threshold_pct ?? experiment.spec.success_threshold_pct ?? null
  const claimed = verdict.claimed_gain_pct
  const target = claimed !== null && claimed !== undefined && threshold !== null ? Math.max(threshold, REPRODUCED_FRACTION_OF_CLAIM * claimed) : threshold
  const quality = details.quality ?? {}
  const problems = details.quality_problems ?? []
  const environment = details.environment ?? {}
  const reportUrl = api.lab.reportUrl(experiment.id)

  return (
    <Card
      id="gate"
      className={gateOpen ? 'border-attention-emphasis/60 ring-1 ring-attention-emphasis/30' : undefined}
      title={
        <span className="flex items-center gap-2">
          {gateOpen ? <GateIcon className="text-attention" /> : <CheckIcon className="text-muted" />}
          {gateOpen ? 'Gate 3 · Verdict — merge or drop?' : 'Verdict'}
        </span>
      }
      actions={
        verdict.has_report ? (
          <a href={reportUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs">
            <FileIcon size={14} /> Full report <ExternalIcon size={12} />
          </a>
        ) : (
          <span className="text-xs text-muted">No report file</span>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <VerdictBadge verdict={verdict.verdict} size="lg" />
        {details.reason && <span className="text-sm text-fg">{details.reason}</span>}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={`Measured · ${verdict.primary_metric}`} sub={`95% CI ${formatCI(verdict.ci_low_pct, verdict.ci_high_pct)}`}>
          <Delta value={verdict.median_delta_pct} />
        </Stat>
        <Stat label="Paper claims" sub={target !== null ? `target ≥ ${formatPct(target, 1)}` : undefined}>
          <span className="text-done">{formatPct(claimed, 1)}</span>
        </Stat>
        <Stat label="Success bar" sub={details.worth_adopting ? 'worth adopting' : 'not worth adopting'}>
          {formatPct(threshold, 1)}
        </Stat>
        <Stat label="Quality guardrails" sub={problems.length ? problems.join('; ') : 'no problems'}>
          {verdict.quality_ok ? <span className="text-success">OK</span> : <span className="text-danger">FAILED</span>}
        </Stat>
      </div>

      <div className="mt-4 rounded-md border border-line-muted px-3 py-2">
        <ImprovementChart median={verdict.median_delta_pct} low={verdict.ci_low_pct} high={verdict.ci_high_pct} claimed={claimed} threshold={threshold} target={target} />
      </div>

      {details.per_metric && Object.keys(details.per_metric).length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold">Per-metric results</h3>
          <MetricsTable perMetric={details.per_metric} primary={verdict.primary_metric} project={project} />
          <p className="mt-1 text-xs text-muted">Improvement is positive when the metric moved in its better direction; faded values are not significant (CI includes 0).</p>
        </div>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">Quality</h3>
          <DefinitionList
            items={[
              ['Exact match', `${displayValue(quality.baseline?.exact_match)} → ${displayValue(quality.variant?.exact_match)}`],
              ['Output agreement', typeof quality.output_agreement === 'number' ? `${(quality.output_agreement * 100).toFixed(0)}%` : '—'],
              ['Problems', problems.length ? <span className="text-danger">{problems.join('; ')}</span> : 'none'],
            ]}
          />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">Environment</h3>
          <DefinitionList
            items={[
              ['Model', displayValue(details.model ?? experiment.spec.model)],
              ['Workload', formatWorkload(details.workload ?? experiment.spec.workload)],
              [
                'Machine',
                [
                  displayValue(environment.chip, ''),
                  environment.macos ? `macOS ${displayValue(environment.macos)}` : '',
                  environment.torch ? `torch ${displayValue(environment.torch)}` : '',
                ]
                  .filter(Boolean)
                  .join(' · ') || '—',
              ],
              [
                'Conditions',
                <span key="cond" className="flex flex-wrap gap-1">
                  {environment.on_ac_power === false ? <Chip tone="attention">on battery</Chip> : environment.on_ac_power ? <Chip tone="success">AC power</Chip> : null}
                  {environment.thermal_warning ? <Chip tone="attention">thermal throttling</Chip> : environment.thermal_warning === false ? <Chip tone="success">no throttling</Chip> : null}
                </span>,
              ],
            ]}
          />
        </div>
      </div>

      {verdict.has_report && (
        <div className="mt-4">
          <Button size="sm" variant="invisible" onClick={() => setShowReport(!showReport)} aria-expanded={showReport} icon={<FileIcon size={14} />}>
            {showReport ? 'Hide report' : 'Show HTML report inline'}
          </Button>
          {showReport && (
            <iframe title={`Experiment ${experiment.id} report`} src={reportUrl} sandbox="" className="mt-2 h-[640px] w-full rounded-md border border-line bg-canvas" />
          )}
        </div>
      )}

      {gateOpen && (
        <div className="mt-5 flex flex-col gap-3 border-t border-line-muted pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">
            {details.worth_adopting ? 'The improvement clears the success bar.' : 'The improvement does not clear the success bar.'} Merging keeps the flag off by
            default.
          </p>
          <div className="flex gap-2">
            <Button variant="danger" icon={<XIcon />} onClick={() => setDialog('drop')}>
              Drop
            </Button>
            <Button variant="primary" icon={<MergeIcon />} onClick={() => setDialog('merge')}>
              Merge
            </Button>
          </div>
        </div>
      )}
      {experiment.status === 'finalizing' && <p className="mt-4 text-sm text-accent">Decision recorded — the worker is finalizing it.</p>}
      {experiment.status === 'merged' && experiment.build.merge_sha && (
        <p className="mt-4 text-sm text-done">
          <MergeIcon className="mr-1 inline" /> Merged at <code className="code-inline">{String(experiment.build.merge_sha).slice(0, 10)}</code> (flag off by default).
        </p>
      )}
      {dialog && <DecisionDialog kind={dialog} experiment={experiment} onClose={() => setDialog(null)} />}
    </Card>
  )
}
