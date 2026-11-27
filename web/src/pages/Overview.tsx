import { useQueries } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../api/client'
import { keys, useExperiments, useProjects, useServices, useStats, useTriageList } from '../api/queries'
import type { Experiment, ExperimentSummary, LabEvent, Stats, TriageSummary } from '../api/types'
import { Delta, LiveDot, OutcomeBadge, StatusChip } from '../components/Badges'
import { EventTimeline } from '../components/EventTimeline'
import { ArrowRightIcon, ChevronRight, FlaskIcon, GateIcon, SemanticIcon, SparkIcon } from '../components/Icons'
import { JobStatusChip } from '../components/JobStatus'
import { useLiveEvents } from '../components/LiveEvents'
import {
  Card,
  Counter,
  Disclosure,
  EmptyState,
  ErrorState,
  MathText,
  PageHeader,
  RelativeTime,
  Skeleton,
  StatTile,
  TONE_CLASSES,
  TONE_TEXT,
  cx,
} from '../components/ui'
import { formatNumber, pluralize } from '../lib/format'
import {
  decisionBreakdown,
  decisionCounts,
  experimentProgress,
  gateCopy,
  IN_PROGRESS_STATUSES,
  outcomeBreakdown,
  overviewAnswer,
  plainFailure,
  progressCounts,
  progressLine,
  recentFinished,
  sortGates,
  summarizeEvent,
  type AnswerPart,
  type OutcomeSlice,
} from '../lib/overview'
import { serviceRows } from '../lib/overviewJobs'
import { statusSemantics } from '../lib/semantics'
import { STAGE_LABELS, STAGES, stagesForStatus } from '../lib/stages'

/** How many decisions the Overview lists before "See all". */
const GATE_ROWS = 5

/** Fill per outcome (the legend repeats it in words, so colour never stands alone). */
const OUTCOME_FILL: Record<string, string> = {
  reproduced: 'bg-positive-emphasis',
  partial: 'bg-caution-emphasis',
  not_reproduced: 'bg-neutral-emphasis',
  regression: 'bg-negative-emphasis',
  inconclusive: 'bg-line',
}

/** A claim/adoption Δ is only "better" or "worse" when the check found a real effect. */
const SIGNIFICANT = new Set(['reproduced', 'partial', 'regression', 'worth_adopting', 'small_gain'])

function AnswerLine({ parts }: { parts: AnswerPart[] }) {
  return (
    <>
      {parts.map((part, index) => {
        // Keep "3 failed" and "10 decisions" together when the line wraps.
        const words = part.text.replace(/^(\d[\d,]*) /, '$1\u00a0')
        const text = <span className={cx(part.emphasis && 'font-semibold', part.tone && part.tone !== 'neutral' && TONE_TEXT[part.tone])}>{words}</span>
        return (
          <span key={part.text}>
            {index > 0 && <span className="text-muted"> · </span>}
            {part.to ? (
              <a href={part.to} className="inline-flex min-h-6 items-center hover:underline">
                {text}
              </a>
            ) : (
              text
            )}
          </span>
        )
      })}
    </>
  )
}

// ---- tiles -----------------------------------------------------------------------------------------

function OutcomeBar({ slices, total, failed }: { slices: OutcomeSlice[]; total: number; failed: number }) {
  return (
    <div className="mt-1.5">
      {total > 0 && (
        <div className="flex h-2.5 overflow-hidden rounded-full bg-canvas-inset" aria-hidden="true">
          {slices
            .filter((slice) => slice.count > 0)
            .map((slice) => (
              <span key={slice.verdict} className={cx('h-full border-r border-canvas last:border-r-0', OUTCOME_FILL[slice.verdict] ?? 'bg-line')} style={{ width: `${(slice.count / total) * 100}%` }} />
            ))}
        </div>
      )}
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg">
        {slices.map((slice) => (
          <li key={slice.verdict} className={cx('inline-flex items-center gap-1 whitespace-nowrap', slice.count === 0 && 'text-muted')}>
            <span className={cx('inline-block size-2 shrink-0 rounded-sm', OUTCOME_FILL[slice.verdict] ?? 'bg-line')} aria-hidden="true" />
            <SemanticIcon name={slice.icon} size={12} className="shrink-0 text-muted" />
            {slice.label}
            <span className="font-semibold tabular-nums">{slice.count}</span>
          </li>
        ))}
      </ul>
      {failed > 0 && (
        <p className="mt-1.5 text-xs text-muted">
          Plus <span className={TONE_TEXT.negative}>{pluralize(failed, 'experiment')} that failed</span> before a result.
        </p>
      )}
    </div>
  )
}

function OutcomesTile({ stats }: { stats: Stats }) {
  const outcomes = outcomeBreakdown(stats.verdicts)
  return (
    <StatTile
      label="Claims reproduced so far"
      value={
        <>
          {outcomes.reproduced} <span className="text-sm font-normal text-muted">of {pluralize(outcomes.total, 'tested claim')}</span>
        </>
      }
      context={<OutcomeBar slices={outcomes.slices} total={outcomes.total} failed={progressCounts(stats.experiments).failed} />}
      to="/experiments?tab=all"
      fill
    />
  )
}

/**
 * Needs you → In progress → Outcomes. Below 1024 px the outcomes tile moves under the decision list (see
 * Overview), so the first phone screen states the count and lists the decisions.
 */
function Tiles({ stats, picks }: { stats: Stats | undefined; picks: number }) {
  if (!stats) return <Skeleton variant="card" count={1} />
  const decisions = decisionCounts(stats.experiments, picks)
  const progress = progressCounts(stats.experiments)
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      <StatTile label="Needs you" value={decisions.total} context={decisionBreakdown(decisions)} to="/experiments?tab=needs_you" attention={decisions.total > 0} fill />
      <StatTile label="In progress" value={progress.inProgress} context={progress.breakdown} to="/experiments?tab=active" fill />
      <div className="hidden min-w-0 lg:block">
        <OutcomesTile stats={stats} />
      </div>
    </div>
  )
}

function ResearchFunnel({ stats, className }: { stats: Stats | undefined; className?: string }) {
  if (!stats) return null
  const experiments = Object.values(stats.experiments ?? {}).reduce((sum, count) => sum + (count ?? 0), 0)
  const steps = [
    { to: '/research/topics', value: stats.topics, label: 'trending topics' },
    { to: '/research/papers', value: stats.papers, label: 'papers', detail: `${formatNumber(stats.papers_distilled)} summarised` },
    { to: '/research/claims', value: stats.claims, label: 'claim cards', detail: `${formatNumber(stats.testable_claims)} testable` },
    { to: '/experiments?tab=all', value: experiments, label: 'experiments' },
  ]
  return (
    <nav aria-label="Research pipeline" className={cx('rounded-lg border border-line bg-canvas px-3 py-2', className)}>
      <div className="mb-1 text-xs font-medium text-muted sm:hidden">Research pipeline</div>
      <ol className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:flex sm:flex-wrap sm:items-center sm:gap-x-2">
        <li className="mr-1 hidden text-xs font-medium text-muted sm:block">Research pipeline</li>
        {steps.map((step, index) => (
          <li key={step.to} className="inline-flex min-w-0 items-center gap-2">
            {index > 0 && <ArrowRightIcon size={12} className="hidden shrink-0 text-muted sm:block" aria-hidden="true" />}
            <Link to={step.to} className="inline-flex min-h-6 items-baseline gap-1 link-quiet">
              <strong className="tabular-nums">{formatNumber(step.value)}</strong> {step.label}
              {step.detail && <span className="hidden text-xs text-muted sm:inline">({step.detail})</span>}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  )
}

// ---- needs you -------------------------------------------------------------------------------------

function adoptionOf(detail: Experiment | undefined): { verdict: string; delta: number | null } | null {
  const adoption = detail?.verdict_detail?.details?.adoption
  return adoption?.verdict ? { verdict: String(adoption.verdict), delta: adoption.median_delta_pct ?? null } : null
}

function Outcome({ label, kind, value, delta }: { label: string; kind: 'verdict' | 'adoption'; value: string; delta: number | null | undefined }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5 sm:inline-flex sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-1.5">
      <span className="text-muted">{label}</span>
      <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <OutcomeBadge kind={kind} value={value} />
        <Delta value={delta} significant={SIGNIFICANT.has(value)} />
      </span>
    </span>
  )
}

function GateRow({ experiment, detail, loading }: { experiment: ExperimentSummary; detail?: Experiment; loading?: boolean }) {
  const gate = gateCopy(experiment.status)
  const merge = experiment.status === 'awaiting_decision'
  const adoption = adoptionOf(detail)
  return (
    <li>
      <Link to={`/experiments/${experiment.id}`} className="group flex items-start gap-3 px-4 py-3 text-fg hover:bg-canvas-subtle hover:no-underline">
        <span className={cx('mt-0.5 hidden size-8 shrink-0 items-center justify-center rounded-full border sm:flex', TONE_CLASSES.caution)} aria-hidden="true">
          <GateIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted">
            <span className="font-semibold text-caution-fg">{gate.ask}</span> · waiting <RelativeTime iso={experiment.updated_at} />
          </div>
          <div className="font-medium [overflow-wrap:anywhere]">
            #{experiment.id} <MathText>{experiment.title}</MathText>
          </div>
          {merge && experiment.verdict ? (
            <div className="mt-1.5 flex flex-col gap-1.5 text-xs sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
              <Outcome label="Claim check" kind="verdict" value={experiment.verdict} delta={experiment.median_delta_pct} />
              {adoption ? (
                <Outcome label="Your default workload" kind="adoption" value={adoption.verdict} delta={adoption.delta} />
              ) : loading ? (
                <span className="text-muted">Your default workload: loading…</span>
              ) : null}
            </div>
          ) : (
            <div className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">
              {merge ? 'Results are in.' : 'The test plan is ready.'} Paper: <MathText>{experiment.paper_title}</MathText>
            </div>
          )}
        </div>
        <ChevronRight className="mt-2 shrink-0 text-muted group-hover:text-info-fg" />
      </Link>
    </li>
  )
}

function PickRow({ item }: { item: TriageSummary }) {
  const gate = gateCopy('awaiting_pick')
  return (
    <li>
      <Link
        to={`/recommendations?project=${item.project_id}&triage=${item.id}`}
        className="group flex items-start gap-3 px-4 py-3 text-fg hover:bg-canvas-subtle hover:no-underline"
      >
        <span className={cx('mt-0.5 hidden size-8 shrink-0 items-center justify-center rounded-full border sm:flex', TONE_CLASSES.caution)} aria-hidden="true">
          <GateIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted">
            <span className="font-semibold text-caution-fg">{gate.ask}</span> · waiting <RelativeTime iso={item.updated_at} />
          </div>
          <div className="font-medium">Research scan #{item.id} is ready</div>
          <div className="text-xs text-muted">{pluralize(item.shortlist_size, 'recommendation')} shortlisted. Pick 1 or 2 to test.</div>
        </div>
        <ChevronRight className="mt-2 shrink-0 text-muted group-hover:text-info-fg" />
      </Link>
    </li>
  )
}

function NeedsYou({ experiments, picks, loading, error, onRetry }: {
  experiments: ExperimentSummary[]
  picks: TriageSummary[]
  loading: boolean
  error: unknown
  onRetry: () => void
}) {
  const gates = sortGates(experiments)
  const total = gates.length + picks.length
  const visiblePicks = picks.slice(0, GATE_ROWS)
  const visibleGates = gates.slice(0, Math.max(0, GATE_ROWS - visiblePicks.length))
  const details = useQueries({
    queries: visibleGates
      .filter((experiment) => experiment.status === 'awaiting_decision')
      .map((experiment) => ({
        queryKey: keys.experiment(experiment.id),
        queryFn: ({ signal }: { signal: AbortSignal }) => api.lab.experiment(experiment.id, signal),
        staleTime: 60_000,
      })),
  })
  const detailOf = (id: number) => details.find((query) => query.data?.id === id)
  const anyLoading = details.some((query) => query.isLoading)
  return (
    <Card
      id="needs-you"
      attention={total > 0}
      title={
        <span className="flex items-center gap-2">
          Needs you {total > 0 && <Counter value={total} tone="caution" />}
        </span>
      }
      bodyClassName="p-0"
      actions={
        total > 0 ? (
          <Link to="/experiments?tab=needs_you" className="inline-flex min-h-6 items-center text-sm">
            See all
          </Link>
        ) : undefined
      }
    >
      {loading ? (
        <div className="px-4">
          <Skeleton variant="row" count={3} />
        </div>
      ) : error ? (
        <div className="p-4">
          <ErrorState error={error} onRetry={onRetry} title="Couldn’t load the decisions" />
        </div>
      ) : total === 0 ? (
        <EmptyState title="No decisions are waiting for you" icon={<GateIcon size={28} />} action={<Link to="/recommendations">Pick claims to test</Link>}>
          Every gate is clear. New results and test plans will show up here.
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line-muted">
            {visiblePicks.map((item) => (
              <PickRow key={`triage-${item.id}`} item={item} />
            ))}
            {visibleGates.map((experiment) => (
              <GateRow key={experiment.id} experiment={experiment} detail={detailOf(experiment.id)?.data} loading={anyLoading && !detailOf(experiment.id)} />
            ))}
          </ul>
          {total > GATE_ROWS && (
            <div className="border-t border-line-muted px-4 py-2.5">
              <Link to="/experiments?tab=needs_you" className="inline-flex min-h-6 items-center gap-1 text-sm font-medium">
                See all {total} decisions <ArrowRightIcon size={12} />
              </Link>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// ---- what's happening now ------------------------------------------------------------------------

function StepBar({ experiment }: { experiment: ExperimentSummary }) {
  const stages = stagesForStatus(experiment.status, experiment.stage)
  const index = stages.findIndex((stage) => stage.state !== 'done')
  const current = index < 0 ? stages.length - 1 : index
  return (
    <span className="inline-flex items-center gap-2">
      <span className="flex gap-0.5" aria-hidden="true">
        {stages.map((stage, position) => (
          <span
            key={stage.stage}
            className={cx('h-1.5 w-3 rounded-full', position < current ? 'bg-neutral-emphasis' : position === current ? 'animate-pulse-dot bg-info' : 'bg-line')}
          />
        ))}
      </span>
      <span>
        Step {current + 1} of {STAGES.length}: {STAGE_LABELS[stages[current].stage]}
      </span>
    </span>
  )
}

function RunningRow({ experiment, events }: { experiment: ExperimentSummary; events: LabEvent[] }) {
  const latest = events[0]
  const progress = progressLine(experimentProgress(events))
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <Link to={`/experiments/${experiment.id}`} className="link-quiet min-h-6 min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
          #{experiment.id} <MathText>{experiment.title}</MathText>
        </Link>
        <StatusChip status={experiment.status} />
      </div>
      <div className="mt-1 text-xs text-muted">
        <StepBar experiment={experiment} />
        {progress && <span> · {progress}</span>}
      </div>
      <p className="mt-1 text-sm text-fg [overflow-wrap:anywhere]">
        {latest ? summarizeEvent(latest) : statusSemantics(experiment.status).description}{' '}
        <span className="text-xs text-muted">
          · <RelativeTime iso={latest?.created_at ?? experiment.updated_at} />
        </span>
      </p>
      {events.length > 0 && (
        <Disclosure label="Log lines" meta={` (${Math.min(events.length, 8)} most recent)`} summaryClassName="mt-1 text-xs" className="mt-1">
          <EventTimeline events={events.slice(0, 8)} dense />
        </Disclosure>
      )}
    </li>
  )
}

function Running({ experiments, loading }: { experiments: ExperimentSummary[]; loading: boolean }) {
  const live = useLiveEvents()
  const running = experiments
    .filter((experiment) => IN_PROGRESS_STATUSES.includes(experiment.status))
    .sort((a, b) => Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? '') || b.id - a.id)
  const eventsOf = (id: number) => live.events.filter((event) => event.experiment_id === id)
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          What’s happening now {running.length > 0 && <Counter value={running.length} />}
        </span>
      }
      bodyClassName="p-0"
      actions={<LiveDot status={live.status} />}
    >
      {loading ? (
        <div className="px-4">
          <Skeleton variant="row" count={2} />
        </div>
      ) : running.length === 0 ? (
        <EmptyState title="Nothing is running right now" icon={<FlaskIcon size={28} />}>
          Approved experiments show up here while the coding agent builds them and the A/B benchmark runs.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line-muted">
          {running.map((experiment) => (
            <RunningRow key={experiment.id} experiment={experiment} events={eventsOf(experiment.id)} />
          ))}
        </ul>
      )}
      <div className="border-t border-line-muted px-4 py-2.5">
        <Disclosure label="Raw activity log" meta=" · 40 latest lines" summaryClassName="text-xs">
          {live.loading ? (
            <Skeleton lines={3} />
          ) : live.error ? (
            <ErrorState error={live.error} title="Couldn’t load the activity log" />
          ) : (
            <EventTimeline events={live.events.slice(0, 40)} showContext dense emptyText="No activity yet." />
          )}
        </Disclosure>
      </div>
    </Card>
  )
}

// ---- right column ---------------------------------------------------------------------------------

function FinishedRow({ experiment }: { experiment: ExperimentSummary }) {
  const failure = experiment.status === 'failed' ? plainFailure(experiment.error) : null
  return (
    <li>
      <Link to={`/experiments/${experiment.id}`} className="block px-4 py-3 text-fg hover:bg-canvas-subtle hover:no-underline">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <StatusChip status={experiment.status} />
          <RelativeTime iso={experiment.updated_at} />
        </div>
        <div className="mt-1 font-medium [overflow-wrap:anywhere]">
          #{experiment.id} <MathText>{experiment.title}</MathText>
        </div>
        {failure ? (
          <p className={cx('mt-0.5 text-sm [overflow-wrap:anywhere]', TONE_TEXT.negative)}>
            {failure.headline}
            {failure.reason && <span className="text-fg">: {failure.reason}</span>}
          </p>
        ) : experiment.verdict ? (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            <OutcomeBadge kind="verdict" value={experiment.verdict} />
            <Delta value={experiment.median_delta_pct} significant={SIGNIFICANT.has(experiment.verdict)} />
          </div>
        ) : null}
      </Link>
    </li>
  )
}

function FinishedRecently({ experiments, loading }: { experiments: ExperimentSummary[]; loading: boolean }) {
  const finished = recentFinished(experiments, 5)
  return (
    <Card id="recent-results" title="Finished recently" bodyClassName="p-0">
      <p className="border-b border-line-muted px-4 py-2 text-xs text-muted">Merged, dropped, or stopped by an error. Newest first.</p>
      {loading ? (
        <div className="px-4">
          <Skeleton variant="row" count={2} />
        </div>
      ) : finished.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted">Nothing has finished yet. Experiments land here after you merge or drop them.</p>
      ) : (
        <ul className="divide-y divide-line-muted">
          {finished.map((experiment) => (
            <FinishedRow key={experiment.id} experiment={experiment} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function SystemHealth({ stats }: { stats: Stats | undefined }) {
  const services = useServices()
  const rows = serviceRows(services.data, { gatewayDown: services.isError }).filter((row) => row.id !== 'worker')
  const down = rows.filter((row) => row.state === 'down')
  const jobs = stats?.jobs ?? {}
  const order = ['running', 'queued', 'failed', 'done', 'cancelled']
  const jobKeys = Object.keys(jobs).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
  return (
    <Card
      title="System"
      actions={
        <Link to="/system" className="inline-flex min-h-6 items-center text-sm">
          Details
        </Link>
      }
    >
      <p className={cx('text-sm font-medium', down.length ? TONE_TEXT.negative : 'text-fg')}>
        {services.isLoading ? 'Checking services…' : down.length ? `${down.map((row) => row.name).join(', ')} not responding` : 'All services OK'}
      </p>
      <ul className="mt-1 text-xs text-muted">
        {rows.map((row) => (
          <li key={row.id} className="inline after:content-['_·_'] last:after:content-none">
            {row.name} {row.state === 'ok' ? 'OK' : row.state === 'down' ? 'down' : 'not checked'}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line-muted pt-3 text-xs">
        <span className="text-muted">Jobs:</span>
        {jobKeys.length === 0 && <span className="text-muted">none yet</span>}
        {jobKeys.map((status) => (
          <span key={status} className="inline-flex items-center gap-1">
            <JobStatusChip status={status} />
            <span className="font-semibold tabular-nums">{jobs[status]}</span>
          </span>
        ))}
      </div>
    </Card>
  )
}

// ---- page ------------------------------------------------------------------------------------------

export default function Overview() {
  const stats = useStats()
  const projects = useProjects()
  // Server-filtered lists: the unfiltered one is capped at the newest 100, which would hide old gates.
  const gates = useExperiments({ status: 'needs_you' })
  const active = useExperiments({ status: 'active' })
  const recent = useExperiments({})
  const triage = useTriageList()
  const picks = (triage.data ?? []).filter((item) => item.status === 'awaiting_pick')
  const projectNames = (projects.data ?? []).map((project) => project.name)
  const target = projectNames.length === 1 ? projectNames[0] : projectNames.length ? 'your projects' : 'your project'

  return (
    <>
      <PageHeader
        title="Overview"
        answer={stats.data ? <AnswerLine parts={overviewAnswer(stats.data, picks.length)} /> : stats.isLoading ? <Skeleton lines={1} className="w-72 max-w-full" /> : undefined}
        description={`New research turned into testable claims, then tested on ${target}.`}
        actions={
          <Link
            to="/recommendations"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-canvas-subtle px-3 text-sm font-medium text-fg hover:bg-canvas-inset hover:no-underline max-sm:h-11"
          >
            <SparkIcon /> Pick claims to test
          </Link>
        }
      />
      {stats.isError ? (
        <div className="mb-4">
          <ErrorState error={stats.error} onRetry={() => stats.refetch()} title="Couldn’t load the summary" />
        </div>
      ) : (
        <>
          <Tiles stats={stats.data} picks={picks.length} />
          <ResearchFunnel stats={stats.data} className="mt-3 hidden lg:block" />
        </>
      )}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <NeedsYou
            experiments={gates.data ?? []}
            picks={picks}
            loading={gates.isLoading || triage.isLoading}
            error={gates.error}
            onRetry={() => gates.refetch()}
          />
          {stats.data && (
            <div className="space-y-3 lg:hidden">
              <OutcomesTile stats={stats.data} />
              <ResearchFunnel stats={stats.data} />
            </div>
          )}
          <Running experiments={active.data ?? []} loading={active.isLoading} />
        </div>
        <div className="min-w-0 space-y-6">
          <FinishedRecently experiments={recent.data ?? []} loading={recent.isLoading} />
          <SystemHealth stats={stats.data} />
        </div>
      </div>
    </>
  )
}

