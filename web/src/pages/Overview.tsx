import { Link } from 'react-router'
import { useExperiments, useServices, useStats, useTriageList } from '../api/queries'
import type { ExperimentSummary, Stats } from '../api/types'
import { Delta, LiveDot, StatusChip, VerdictBadge } from '../components/Badges'
import { EventTimeline } from '../components/EventTimeline'
import { ChevronRight, FlaskIcon, GateIcon, ServerIcon, SparkIcon } from '../components/Icons'
import { useLiveEvents } from '../components/LiveEvents'
import { MiniStages } from '../components/Stepper'
import { Card, Chip, EmptyState, ErrorState, Loading, PageHeader, RelativeTime, Skeleton, cx } from '../components/ui'
import { formatPct, pluralize } from '../lib/format'
import { ACTIVE_STATUSES, needsYou, stagesForStatus } from '../lib/stages'

function StatCard({ label, value, detail, to }: { label: string; value: number | string | undefined; detail?: string; to?: string }) {
  const body = (
    <>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-fg">{value ?? '—'}</div>
      {detail && <div className="mt-0.5 truncate text-xs text-muted">{detail}</div>}
    </>
  )
  return to ? (
    <Link to={to} className="card block px-4 py-3 text-fg transition-colors hover:border-accent/60 hover:no-underline">
      {body}
    </Link>
  ) : (
    <div className="card px-4 py-3">{body}</div>
  )
}

function StatsRow({ stats }: { stats: Stats | undefined }) {
  const experiments = stats?.experiments ?? {}
  const active = ACTIVE_STATUSES.reduce((sum, status) => sum + (experiments[status] ?? 0), 0)
  const total = Object.values(experiments).reduce((sum, count) => sum + (count ?? 0), 0)
  const verdicts = stats?.verdicts ?? {}
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <StatCard label="Trending topics" value={stats?.topics} detail="top topics in the seed areas" to="/research/topics" />
      <StatCard label="Papers & patents" value={stats?.papers} detail={stats ? `${stats.papers_distilled} distilled · ${pluralize(stats.patents, 'patent')}` : undefined} to="/research/papers" />
      <StatCard label="Claim cards" value={stats?.claims} detail={stats ? `${stats.testable_claims} testable` : undefined} to="/research/claims" />
      <StatCard label="Experiments" value={total} detail={`${active} active`} to="/experiments?tab=all" />
      <StatCard
        label="Verdicts"
        value={Object.values(verdicts).reduce((sum, count) => sum + (count ?? 0), 0)}
        detail={`${verdicts.reproduced ?? 0} reproduced · ${verdicts.partial ?? 0} partial`}
      />
      <StatCard label="Needs you" value={stats?.awaiting_you} detail="gates waiting for a decision" to="/experiments?tab=needs_you" />
    </div>
  )
}

function GateRow({ experiment }: { experiment: ExperimentSummary }) {
  const gate2 = experiment.status === 'awaiting_approval'
  return (
    <li>
      <Link to={`/experiments/${experiment.id}`} className="group flex items-center gap-3 px-4 py-3 text-fg hover:bg-canvas-subtle hover:no-underline">
        <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-full', gate2 ? 'bg-attention-subtle text-attention' : 'bg-success-subtle text-success')}>
          <GateIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-attention">{gate2 ? 'Gate 2 · Review & approve the experiment spec' : 'Gate 3 · Merge or drop the branch'}</div>
          <div className="truncate font-medium">
            #{experiment.id} {experiment.title}
          </div>
          <div className="truncate text-xs text-muted">
            {experiment.flag_name && <code className="code-inline mr-1">{experiment.flag_name}</code>}
            {experiment.paper_title}
          </div>
        </div>
        {!gate2 && (
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <VerdictBadge verdict={experiment.verdict} />
            <Delta value={experiment.median_delta_pct} />
          </div>
        )}
        <span className="hidden shrink-0 text-xs text-muted md:block">
          <RelativeTime iso={experiment.updated_at} />
        </span>
        <ChevronRight className="shrink-0 text-subtle group-hover:text-accent" />
      </Link>
    </li>
  )
}

function NeedsYou() {
  const gates = useExperiments({ status: 'needs_you' })
  const triage = useTriageList()
  const picks = (triage.data ?? []).filter((item) => item.status === 'awaiting_pick')
  const count = (gates.data?.length ?? 0) + picks.length
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Needs you {count > 0 && <Chip tone="attention">{count}</Chip>}
        </span>
      }
      bodyClassName="p-0"
      id="needs-you"
    >
      {gates.isLoading || triage.isLoading ? (
        <div className="px-4">
          <Skeleton lines={3} />
        </div>
      ) : gates.isError ? (
        <div className="p-4">
          <ErrorState error={gates.error} onRetry={() => gates.refetch()} />
        </div>
      ) : count === 0 ? (
        <EmptyState title="Nothing waiting for you" icon={<GateIcon size={28} />}>
          All gates are clear. Pick new claims on the <Link to="/recommendations">Recommendations</Link> page.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line-muted">
          {picks.map((item) => (
            <li key={`triage-${item.id}`}>
              <Link
                to={`/recommendations?project=${item.project_id}&triage=${item.id}`}
                className="group flex items-center gap-3 px-4 py-3 text-fg hover:bg-canvas-subtle hover:no-underline"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent">
                  <SparkIcon />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-attention">Gate 1 · Pick 1–2 claims to test</div>
                  <div className="font-medium">Research scan #{item.id} is ready</div>
                  <div className="text-xs text-muted">{pluralize(item.shortlist_size, 'recommendation')} shortlisted</div>
                </div>
                <span className="hidden shrink-0 text-xs text-muted md:block">
                  <RelativeTime iso={item.updated_at} />
                </span>
                <ChevronRight className="shrink-0 text-subtle group-hover:text-accent" />
              </Link>
            </li>
          ))}
          {gates.data?.map((experiment) => (
            <GateRow key={experiment.id} experiment={experiment} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function ActiveExperiments() {
  const active = useExperiments({ status: 'active' })
  const running = (active.data ?? []).filter((experiment) => !needsYou(experiment.status))
  return (
    <Card
      title="In progress"
      bodyClassName="p-0"
      actions={
        <Link to="/experiments?tab=active" className="text-xs">
          View all
        </Link>
      }
    >
      {active.isLoading ? (
        <div className="px-4">
          <Skeleton lines={3} />
        </div>
      ) : active.isError ? (
        <div className="p-4">
          <ErrorState error={active.error} onRetry={() => active.refetch()} />
        </div>
      ) : running.length === 0 ? (
        <EmptyState title="No experiments running" icon={<FlaskIcon size={28} />}>
          Approved experiments show up here while the coding agent builds and the A/B benchmark runs.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line-muted">
          {running.map((experiment) => (
            <li key={experiment.id}>
              <Link to={`/experiments/${experiment.id}`} className="flex flex-col gap-2 px-4 py-3 text-fg hover:bg-canvas-subtle hover:no-underline sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    #{experiment.id} {experiment.title}
                  </div>
                  <div className="truncate text-xs text-muted">
                    {experiment.flag_name && <code className="code-inline mr-1">{experiment.flag_name}</code>}
                    claimed {formatPct(experiment.claimed_gain_pct, 0)}
                  </div>
                </div>
                <MiniStages stages={stagesForStatus(experiment.status)} />
                <div className="flex items-center gap-3">
                  <StatusChip status={experiment.status} />
                  <span className="w-16 text-right text-xs text-muted">
                    <RelativeTime iso={experiment.updated_at} />
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Activity() {
  const live = useLiveEvents()
  return (
    <Card title="Live activity" actions={<LiveDot status={live.status} />} bodyClassName="max-h-[560px] overflow-y-auto px-4 py-1">
      {live.loading ? (
        <Loading />
      ) : live.error ? (
        <div className="py-3">
          <ErrorState error={live.error} />
        </div>
      ) : (
        <EventTimeline events={live.events.slice(0, 40)} showContext dense emptyText="No activity yet." />
      )}
    </Card>
  )
}

function ServicesCard() {
  const services = useServices()
  const stats = useStats()
  const jobs = stats.data?.jobs ?? {}
  return (
    <Card
      title="Services"
      actions={
        <Link to="/system" className="text-xs">
          Details
        </Link>
      }
    >
      <ul className="space-y-2 text-sm">
        <li className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <ServerIcon className="text-muted" /> gateway
          </span>
          <Chip tone={services.isError ? 'danger' : 'success'}>{services.isError ? 'unreachable' : 'ok'}</Chip>
        </li>
        {Object.entries(services.data ?? {}).map(([name, health]) => (
          <li key={name} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <ServerIcon className="text-muted" /> {name}-api
            </span>
            <Chip tone={health.status === 'ok' ? 'success' : 'danger'}>{health.status}</Chip>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line-muted pt-3 text-xs">
        <span className="text-muted">Jobs:</span>
        {Object.keys(jobs).length === 0 && <span className="text-muted">none</span>}
        {Object.entries(jobs).map(([status, count]) => (
          <Chip key={status} tone={status === 'failed' ? 'danger' : status === 'running' ? 'accent' : status === 'queued' ? 'attention' : 'neutral'}>
            {count} {status}
          </Chip>
        ))}
      </div>
      {(jobs.queued ?? 0) > 0 && (
        <p className="mt-2 text-xs text-muted">Queued jobs are executed by the worker (<code className="code-inline">paperatlas services up</code>).</p>
      )}
    </Card>
  )
}

export default function Overview() {
  const stats = useStats()
  return (
    <>
      <PageHeader
        title="Overview"
        description="Recent research distilled into testable claims, experiments running against inference-lab, and the gates waiting for your decision."
        actions={
          <Link to="/recommendations" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-black/10 bg-success-emphasis px-3 text-sm font-medium text-white hover:bg-success hover:no-underline">
            <SparkIcon /> Pick claims to test
          </Link>
        }
      />
      {stats.isError ? (
        <div className="mb-4">
          <ErrorState error={stats.error} onRetry={() => stats.refetch()} title="Could not load stats" />
        </div>
      ) : (
        <StatsRow stats={stats.data} />
      )}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <NeedsYou />
          <ActiveExperiments />
        </div>
        <div className="space-y-6">
          <Activity />
          <ServicesCard />
        </div>
      </div>
    </>
  )
}
