import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useExperimentSearch, useProjects } from '../api/queries'
import type { ExperimentSummary } from '../api/types'
import { Delta, OutcomeBadge, StatusChip } from '../components/Badges'
import { FlaskIcon, RerunIcon, SparkIcon } from '../components/Icons'
import { MiniStages } from '../components/Stepper'
import { DataTable, type Column } from '../components/Table'
import { InfoPopover } from '../components/Tooltip'
import { Banner, Button, EmptyState, ErrorState, MathText, PageHeader, Pagination, RelativeTime, Skeleton, TabPanel, Tabs, cx, useDebounced } from '../components/ui'
import {
  EMPTY_FILTERS,
  TAB_LABEL,
  hasActiveFilters,
  parseFilters,
  parseTab,
  searchParams,
  writeFilters,
  type ExperimentFilters,
  type ExperimentTab,
} from '../lib/experimentFilters'
import { formatSigned, pluralize } from '../lib/format'
import { recommendForSummary, summarizeFailure } from '../lib/protocol'
import { GATE, MODE } from '../lib/semantics'
import { stagesForStatus } from '../lib/stages'
import { ExperimentListFilters } from './experiment/ListFilters'

function TitleCell({ experiment }: { experiment: ExperimentSummary }) {
  const mode = experiment.mode && experiment.mode !== 'single' ? MODE[experiment.mode]?.label : null
  return (
    <span className="block min-w-48">
      <span className="mr-1.5 text-xs font-normal text-muted tabular-nums">
        #{experiment.id}
        {experiment.rerun_of_experiment_id != null && (
          <span className="ml-1 inline-flex items-center gap-0.5 align-[-1px]">
            <RerunIcon size={12} aria-hidden="true" />
            <span className="sr-text">re-run of #{experiment.rerun_of_experiment_id}</span>
          </span>
        )}
      </span>
      <MathText>{experiment.title}</MathText>
      <span className="mt-0.5 line-clamp-1 text-xs font-normal text-muted">
        {mode && <>{mode} · </>}
        <MathText>{experiment.paper_title}</MathText>
      </span>
    </span>
  )
}

/** Status chip, plus why it's stuck when it is (failed, waiting for a prerequisite). */
function StatusCell({ experiment }: { experiment: ExperimentSummary }) {
  return (
    <div className="flex flex-col items-start gap-1 md:items-start">
      <StatusChip status={experiment.status} short />
      {experiment.status === 'failed' && experiment.error && <span className="text-xs whitespace-normal text-negative-fg">{summarizeFailure(experiment.error, experiment.stage).title}</span>}
      {experiment.status === 'blocked' && experiment.depends_on_experiment_id != null && (
        <span className={cx('text-xs whitespace-normal', experiment.error ? 'font-semibold text-caution-fg' : 'text-muted')}>
          {experiment.error ? `#${experiment.depends_on_experiment_id} wasn’t merged` : `Waits for #${experiment.depends_on_experiment_id}`}
        </span>
      )}
    </div>
  )
}

/**
 * Both answers, honestly: the claim check and (when it ran separately) the adoption check on the project's
 * default workload, so a claim gain can't hide a regression here (docs/ux-review.md E-3).
 */
function OutcomeCell({ experiment }: { experiment: ExperimentSummary }) {
  if (!experiment.verdict) return <span className="text-xs text-muted">{experiment.status === 'failed' ? 'No result' : 'Not measured yet'}</span>
  const adoption = experiment.adoption_verdict
  return (
    <div className="grid grid-cols-[auto_auto_auto] items-center justify-start gap-x-1.5 gap-y-1">
      <span className="text-xs text-muted">{adoption ? 'Claim' : 'Claim check'}</span>
      <OutcomeBadge kind="verdict" value={experiment.verdict} short />
      <Delta value={experiment.median_delta_pct} className="text-xs" />
      {adoption && (
        <>
          <span className="text-xs text-muted">Here</span>
          <OutcomeBadge kind="adoption" value={adoption} short />
          <Delta value={experiment.adoption_median_delta_pct} className="text-xs" />
        </>
      )}
      {typeof experiment.claimed_gain_pct === 'number' && (
        <span className="col-span-3 text-xs text-muted">Paper reports {formatSigned(experiment.claimed_gain_pct, { digits: 0 })}</span>
      )}
    </div>
  )
}

/** The next step at a gate, with the recommendation once the API sends the adoption check. */
function NextStep({ experiment }: { experiment: ExperimentSummary }) {
  if (experiment.status !== 'awaiting_decision' && experiment.status !== 'awaiting_approval') return null
  const recommendation = experiment.status === 'awaiting_decision' ? recommendForSummary(experiment) : null
  return (
    <span className="relative z-[1] inline-flex flex-col items-end gap-0.5 text-right">
      <Link to={`/experiments/${experiment.id}#gate`} className="inline-flex min-h-6 items-center text-sm font-semibold whitespace-nowrap">
        {experiment.status === 'awaiting_decision' ? GATE.merge.label : GATE.approve_spec.label} →
      </Link>
      {recommendation && (
        <span className="text-xs whitespace-nowrap text-muted">
          Suggested:{' '}
          <span className={cx('font-semibold', recommendation.action === 'drop' ? 'text-negative-fg' : recommendation.action === 'merge' ? 'text-positive-fg' : 'text-caution-fg')}>
            {recommendation.label.toLowerCase()}
          </span>
        </span>
      )}
    </span>
  )
}

const OUTCOME_HELP = (
  <>
    <strong>Claim</strong>: the A/B test against the paper’s setup. Does the paper’s claim hold?
    <br />
    <strong>Here</strong>: the A/B test on your project’s default workload. Is it worth adopting? Shown when it ran separately.
  </>
)

const COLUMNS: Column<ExperimentSummary>[] = [
  { key: 'title', header: 'Experiment', cell: (row) => <TitleCell experiment={row} />, cardSlot: 'title' },
  { key: 'status', header: 'Status', cell: (row) => <StatusCell experiment={row} />, cardSlot: 'badge', className: 'align-top' },
  { key: 'stage', header: 'Progress', cell: (row) => <MiniStages stages={stagesForStatus(row.status, row.stage)} />, priority: 3, nowrap: true, className: 'align-top pt-3' },
  {
    key: 'outcome',
    header: (
      <span className="inline-flex items-center gap-0.5">
        Outcome <InfoPopover label="What the outcome shows" content={OUTCOME_HELP} />
      </span>
    ),
    cardLabel: 'Outcome',
    cell: (row) => <OutcomeCell experiment={row} />,
    nowrap: true,
    className: 'align-top',
  },
  { key: 'updated', header: 'Updated', cell: (row) => <RelativeTime iso={row.updated_at} className="text-xs text-muted" />, priority: 2, numeric: true, nowrap: true, cardSlot: 'hidden', className: 'align-top' },
  { key: 'next', header: 'Next step', srOnlyHeader: true, cell: (row) => <NextStep experiment={row} />, align: 'right', cardSlot: 'footer', className: 'align-top' },
]

const LIMIT = 50

export default function Experiments() {
  const [params, setParams] = useSearchParams()
  const tab = parseTab(params)
  const filters = useMemo(() => parseFilters(params), [params])
  const offset = Math.max(0, Math.floor(Number(params.get('offset')) || 0))
  const projects = useProjects()
  const projectId = Number(params.get('project')) || undefined
  const created = (params.get('new') ?? '').split(',').filter(Boolean).map(Number)

  const results = useExperimentSearch(searchParams(filters, tab, { project_id: projectId, limit: LIMIT, offset }))
  const data = results.data
  const overall = data?.overall
  const filtered = hasActiveFilters(filters)

  const setFilters = useCallback(
    (next: ExperimentFilters) => setParams((prev) => writeFilters(prev, next), { replace: true }),
    [setParams],
  )
  const [search, setSearch] = useState(filters.q)
  const q = useDebounced(search.trim(), 350)
  // Push only a changed search (setParams changes identity with every URL change, so it can't be the trigger).
  const pushedQ = useRef(q)
  useEffect(() => {
    if (pushedQ.current === q) return
    pushedQ.current = q
    setParams(
      (prev) => {
        const current = parseFilters(prev)
        return current.q === q ? prev : writeFilters(prev, { ...current, q })
      },
      { replace: true },
    )
  }, [q])
  // Back/forward or "Clear all" changed the URL's search (not our own push): show it in the box.
  useEffect(() => {
    if (filters.q === pushedQ.current) return
    pushedQ.current = filters.q
    setSearch(filters.q)
  }, [filters.q])
  const clearAll = () => {
    setSearch('')
    setFilters(EMPTY_FILTERS)
  }

  const setTab = (value: ExperimentTab) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('tab', value)
      next.delete('offset')
      return next
    })
  const setOffset = (value: number) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value > 0) next.set('offset', String(value))
      else next.delete('offset')
      return next
    })
  // A shared link can point past the last page once experiments finish or filters narrow: go back to page 1.
  useEffect(() => {
    if (data && offset > 0 && (offset >= data.total || data.total <= LIMIT)) setOffset(0)
  }, [data, offset])

  const scope = data?.facets.scope
  const waiting = overall?.needs_you ?? 0
  const emptyMessage = (() => {
    if (!filtered) {
      return tab === 'needs_you'
        ? { title: 'No gates are waiting for you', body: 'Experiments show up here when they need a decision or are running.' }
        : tab === 'active'
          ? { title: 'Nothing in progress', body: 'Experiments show up here when they need a decision or are running.' }
          : { title: 'No experiments yet', body: null }
    }
    const elsewhere = tab !== 'all' && scope && scope.all > 0
    return {
      title: tab === 'all' ? 'No experiments match these filters' : `No experiments in ${TAB_LABEL[tab]} match these filters`,
      body: elsewhere ? `${pluralize(scope.all, 'experiment')} in All ${scope.all === 1 ? 'matches' : 'match'} them.` : 'Try removing a filter.',
    }
  })()

  return (
    <>
      <PageHeader
        title="Experiments"
        answer={
          overall
            ? [waiting ? `${waiting} experiment${waiting > 1 ? 's need' : ' needs'} your decision` : 'Nothing is waiting for you', `${Math.max(0, overall.active - waiting)} in progress`].join(' · ')
            : undefined
        }
        description={
          <span className="max-sm:hidden">Each experiment implements one paper’s claim behind a feature flag, A/B tests it on your project, and compares the result with the paper.</span>
        }
        actions={
          <>
            {(projects.data?.length ?? 0) > 1 && (
              <>
                <label htmlFor="exp-project" className="sr-only">
                  Project
                </label>
                <select
                  id="exp-project"
                  className="input w-auto"
                  value={projectId ?? ''}
                  onChange={(event) =>
                    setParams((prev) => {
                      const next = new URLSearchParams(prev)
                      if (event.target.value) next.set('project', event.target.value)
                      else next.delete('project')
                      next.delete('offset')
                      return next
                    })
                  }
                >
                  <option value="">All projects</option>
                  {projects.data?.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </>
            )}
            <Link to="/recommendations" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-canvas-subtle px-3 text-sm font-medium text-fg hover:bg-canvas-inset hover:no-underline">
              <SparkIcon /> Pick claims to test
            </Link>
          </>
        }
      />
      {created.length > 0 && (
        <div className="mb-4">
          <Banner tone="info">
            Created{' '}
            {created.map((id, index) => (
              <span key={id}>
                {index > 0 && ', '}
                <Link to={`/experiments/${id}`}>#{id}</Link>
              </span>
            ))}
            . The planner is writing the test plans; they’ll appear under <strong>Needs you</strong> for approval.
          </Banner>
        </div>
      )}
      <Tabs<ExperimentTab>
        id="experiment-tabs"
        label="Experiment lists"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'needs_you', label: TAB_LABEL.needs_you, count: scope?.needs_you, attention: true },
          { value: 'active', label: TAB_LABEL.active, count: scope?.active },
          { value: 'all', label: TAB_LABEL.all, count: scope?.all },
        ]}
      />
      <TabPanel tabsId="experiment-tabs" value={tab} className="mt-4">
        <ExperimentListFilters
          filters={filters}
          onChange={setFilters}
          onClear={clearAll}
          search={search}
          onSearch={setSearch}
          facets={data?.facets}
          total={data?.total}
          tab={tab}
          onShowAll={() => setTab('all')}
        />
        {/* Always present so screen readers hear the new count, including "0 experiments match". */}
        <p className={cx('mb-2 text-xs text-muted', !data?.items.length && 'sr-only')} aria-live="polite">
          {data && (
            <>
              {filtered ? `${pluralize(data.total, 'experiment')} ${data.total === 1 ? 'matches' : 'match'}` : pluralize(data.total, 'experiment')}
              {tab !== 'all' && ` in ${TAB_LABEL[tab]}`}
              {data.total > data.items.length && ` · showing ${offset + 1}–${offset + data.items.length}`}
              {results.isFetching && results.isPlaceholderData && ' · updating…'}
            </>
          )}
        </p>
        {results.isLoading ? (
          <Skeleton variant="row" count={5} />
        ) : results.isError ? (
          <ErrorState error={results.error} onRetry={() => results.refetch()} />
        ) : !data?.items.length ? (
          <div className="card">
            <EmptyState
              icon={<FlaskIcon size={28} />}
              title={emptyMessage.title}
              action={
                filtered ? (
                  tab !== 'all' && scope && scope.all > 0 ? (
                    <Button onClick={() => setTab('all')}>Show {scope.all} in All</Button>
                  ) : (
                    <Button onClick={clearAll}>Clear all filters</Button>
                  )
                ) : undefined
              }
              secondaryAction={filtered && tab !== 'all' && scope && scope.all > 0 ? <Button variant="invisible" onClick={clearAll}>Clear all filters</Button> : undefined}
            >
              {emptyMessage.body ?? (
                <>
                  Pick a claim on the <Link to="/recommendations">Recommendations</Link> page to start one.
                </>
              )}
            </EmptyState>
          </div>
        ) : (
          <>
            <DataTable
              label="Experiments"
              rows={data.items}
              rowKey={(row) => row.id}
              rowHref={(row) => `/experiments/${row.id}`}
              columns={COLUMNS}
              rowClassName={(row) => (created.includes(row.id) ? 'bg-info-subtle/60' : undefined)}
              className={cx('md:overflow-hidden md:rounded-lg md:border md:border-line md:bg-canvas', results.isPlaceholderData && 'opacity-70')}
            />
            <Pagination total={data.total} limit={LIMIT} offset={offset} onChange={setOffset} />
          </>
        )}
      </TabPanel>
    </>
  )
}
