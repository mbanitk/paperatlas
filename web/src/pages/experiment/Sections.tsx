import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useExperimentLog } from '../../api/queries'
import type { BuildInfo, Experiment, Project, RunInfo } from '../../api/types'
import { BranchIcon, ChevronDown, ChevronRight, LogIcon, MergeIcon, RefreshIcon } from '../../components/Icons'
import { Button, Card, Checkbox, Chip, DefinitionList, EmptyState, ErrorState, ExternalLink, Loading, RelativeTime, cx } from '../../components/ui'
import { displayValue, durationBetween, formatDuration, formatNumber, tailLines } from '../../lib/format'

export function BuildCard({ experiment }: { experiment: Experiment }) {
  const build: BuildInfo = experiment.build ?? {}
  const attempts = build.attempts ?? []
  const files = build.files ?? []
  const [showSummary, setShowSummary] = useState(false)
  const hasBuild = attempts.length > 0 || files.length > 0 || build.builder
  return (
    <Card title="Build" actions={build.builder ? <Chip tone="neutral">coding agent: {build.builder}</Chip> : undefined}>
      {!hasBuild && !experiment.branch ? (
        <p className="text-sm text-muted">Nothing built yet — the coding agent starts after Gate 2.</p>
      ) : (
        <div className="space-y-4 text-sm">
          <DefinitionList
            items={[
              [
                'Branch',
                experiment.branch ? (
                  <span className="inline-flex items-center gap-1">
                    <BranchIcon size={14} className="text-muted" />
                    <code className="code-inline">{experiment.branch}</code>
                  </span>
                ) : (
                  '—'
                ),
              ],
              ['Pull request', build.pr_url ? <ExternalLink href={build.pr_url}>{build.pr_url.replace(/^https?:\/\/(www\.)?github\.com\//, '')}</ExternalLink> : <span className="text-muted">none (no GitHub remote or not opened yet)</span>],
              ...(build.merge_sha
                ? ([
                    [
                      'Merged',
                      <span key="sha" className="inline-flex items-center gap-1 text-done">
                        <MergeIcon size={14} /> <code className="code-inline">{String(build.merge_sha).slice(0, 10)}</code>
                      </span>,
                    ],
                  ] as [string, ReactNode][])
                : []),
              ['Worktree', experiment.worktree_path ? <code className="text-xs break-all text-muted">{experiment.worktree_path}</code> : '—'],
            ]}
          />
          {attempts.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Attempts</h3>
              <ol className="space-y-2">
                {attempts.map((attempt) => (
                  <li key={attempt.attempt} className="rounded-md border border-line-muted px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">Attempt {attempt.attempt}</span>
                      <Chip tone={attempt.problems.length ? 'danger' : 'success'}>{attempt.problems.length ? 'verification failed' : 'verified'}</Chip>
                      <span className="text-xs text-muted">
                        {formatDuration(attempt.duration_s)} · agent exit {attempt.agent_exit ?? '—'}
                      </span>
                    </div>
                    {attempt.problems.length > 0 && (
                      <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-danger-subtle/60 p-2 text-xs whitespace-pre-wrap text-danger">{attempt.problems.join('\n')}</pre>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {files.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Changed files ({files.length})</h3>
              <ul className="space-y-0.5 font-mono text-xs">
                {files.map((file) => (
                  <li key={file} className="break-all">
                    {file}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {build.diff_stat && (
            <div>
              <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Diff stat</h3>
              <pre className="overflow-x-auto rounded-md border border-line-muted bg-canvas-subtle p-2 text-xs leading-relaxed">{build.diff_stat}</pre>
            </div>
          )}
          {build.agent_summary && (
            <div>
              <button type="button" onClick={() => setShowSummary(!showSummary)} aria-expanded={showSummary} className="inline-flex items-center gap-1 text-xs font-semibold text-accent">
                {showSummary ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Agent summary
              </button>
              {showSummary && <pre className="mt-1.5 max-h-72 overflow-auto rounded-md bg-canvas-subtle p-2 text-xs whitespace-pre-wrap">{build.agent_summary}</pre>}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function SummaryTable({ summary, primary }: { summary: Record<string, unknown>; primary?: string }) {
  const rows = Object.entries(summary).filter(([, value]) => value && typeof value === 'object' && ('baseline' in (value as object) || 'variant' in (value as object))) as [
    string,
    { baseline?: number; variant?: number },
  ][]
  if (!rows.length) {
    return <pre className="overflow-x-auto rounded bg-canvas-subtle p-2 text-xs">{JSON.stringify(summary, null, 2)}</pre>
  }
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-muted">
        <tr>
          <th scope="col" className="py-1 font-medium">
            Metric (median)
          </th>
          <th scope="col" className="py-1 text-right font-medium">
            Baseline
          </th>
          <th scope="col" className="py-1 text-right font-medium">
            Variant
          </th>
          <th scope="col" className="py-1 text-right font-medium">
            Change
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, value]) => {
          const change = typeof value.baseline === 'number' && typeof value.variant === 'number' && value.baseline !== 0 ? ((value.variant - value.baseline) / Math.abs(value.baseline)) * 100 : null
          return (
            <tr key={name} className="border-t border-line-muted">
              <td className="py-1">
                <code>{name}</code>
                {name === primary && <span className="ml-1 text-accent">★</span>}
              </td>
              <td className="py-1 text-right tabular-nums">{formatNumber(value.baseline)}</td>
              <td className="py-1 text-right tabular-nums">{formatNumber(value.variant)}</td>
              <td className="py-1 text-right tabular-nums text-muted">{change === null ? '—' : `${change > 0 ? '+' : ''}${change.toFixed(1)}%`}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function RunItem({ run, primary }: { run: RunInfo; primary?: string }) {
  const [open, setOpen] = useState(false)
  const model = run.model ? displayValue(run.model) : null
  const running = run.status === 'running'
  return (
    <li className="rounded-md border border-line-muted">
      <button type="button" className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-canvas-subtle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-semibold">{run.kind === 'eval' ? 'Evaluation A/B' : run.kind === 'smoke' ? 'Smoke A/B' : run.kind}</span>
        <Chip tone={run.status === 'done' ? 'success' : running ? 'accent' : run.status === 'failed' ? 'danger' : 'neutral'}>
          {running && <span className="size-1.5 animate-pulse-dot rounded-full bg-current" />}
          {run.status}
        </Chip>
        <span className="ml-auto text-xs text-muted">
          {model && <span className="mr-2">{model}</span>}
          {formatDuration(durationBetween(run.started_at, run.finished_at))} · <RelativeTime iso={run.started_at} />
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line-muted px-3 py-2">
          {run.command && <pre className="overflow-x-auto rounded bg-canvas-subtle p-2 text-[11.5px] whitespace-pre-wrap">{run.command}</pre>}
          {run.summary ? <SummaryTable summary={run.summary} primary={primary} /> : <p className="text-xs text-muted">{running ? 'Results appear when the run finishes.' : 'No summary.'}</p>}
          {run.quality && (
            <p className="text-xs text-muted">
              Quality: exact match {displayValue(run.quality.baseline?.exact_match)} → {displayValue(run.quality.variant?.exact_match)}
              {typeof run.quality.output_agreement === 'number' && <> · output agreement {(run.quality.output_agreement * 100).toFixed(0)}%</>}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

export function RunsCard({ experiment }: { experiment: Experiment }) {
  return (
    <Card title="Benchmark runs">
      {experiment.runs.length === 0 ? (
        <p className="text-sm text-muted">No runs yet — the smoke A/B starts after a verified build.</p>
      ) : (
        <ul className="space-y-2">
          {experiment.runs.map((run) => (
            <RunItem key={run.id} run={run} primary={experiment.spec.primary_metric} />
          ))}
        </ul>
      )}
    </Card>
  )
}

export function LogCard({ experimentId, live }: { experimentId: number; live: boolean }) {
  const log = useExperimentLog(experimentId)
  const [follow, setFollow] = useState(live)
  const ref = useRef<HTMLPreElement>(null)
  const refetch = log.refetch

  useEffect(() => {
    if (!follow) return
    const timer = setInterval(() => refetch(), 5000)
    return () => clearInterval(timer)
  }, [follow, refetch])

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [log.data?.text])

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <LogIcon className="text-muted" /> Log tail {log.data?.file && <code className="code-inline font-normal">{log.data.file}</code>}
        </span>
      }
      actions={
        <>
          <Checkbox id={`follow-log-${experimentId}`} checked={follow} onChange={setFollow} label={<span className="text-xs">Auto-refresh</span>} />
          <Button size="sm" onClick={() => log.refetch()} loading={log.isFetching} icon={<RefreshIcon size={14} />}>
            Refresh
          </Button>
        </>
      }
      bodyClassName="p-0"
    >
      {log.isLoading ? (
        <Loading label="Loading log…" />
      ) : log.isError ? (
        <div className="p-4">
          <ErrorState error={log.error} onRetry={() => log.refetch()} />
        </div>
      ) : !log.data?.text ? (
        <EmptyState title="No log output yet" icon={<LogIcon size={24} />}>
          Build and benchmark logs appear here once the worker starts on this experiment.
        </EmptyState>
      ) : (
        <>
          {log.data.files && log.data.files.length > 1 && (
            <div className="border-b border-line-muted px-4 py-1.5 text-xs text-muted">
              Showing the newest of {log.data.files.length} logs: {log.data.files.join(', ')}
            </div>
          )}
          <pre
            ref={ref}
            tabIndex={0}
            aria-label="Log output"
            className={cx('max-h-80 overflow-auto rounded-b-lg bg-[#0d1117] p-3 text-[11.5px] leading-relaxed text-[#e6edf3]')}
          >
            {tailLines(log.data.text, 400)}
          </pre>
        </>
      )}
    </Card>
  )
}

export function ProjectFacts({ project }: { project?: Project }) {
  if (!project) return null
  const hardware = project.hardware ?? {}
  return (
    <DefinitionList
      items={[
        ['Project', project.name],
        ['Hardware', [hardware.chip, hardware.memory_gb && `${hardware.memory_gb} GB`, hardware.accelerator].filter(Boolean).join(' · ') || '—'],
        ['Repo', <code key="repo" className="text-xs break-all">{project.repo_path}</code>],
      ]}
    />
  )
}

