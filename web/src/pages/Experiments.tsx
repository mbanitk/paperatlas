import { Link, useSearchParams } from 'react-router'
import { useExperiments, useProjects } from '../api/queries'
import type { ExperimentSummary } from '../api/types'
import { Delta, OutcomeBadge, StatusChip } from '../components/Badges'
import { FlaskIcon, RerunIcon, SparkIcon } from '../components/Icons'
import { MiniStages } from '../components/Stepper'
import { DataTable, type Column } from '../components/Table'
import { InfoPopover } from '../components/Tooltip'
import { Banner, EmptyState, ErrorState, MathText, PageHeader, RelativeTime, Skeleton, TabPanel, Tabs, cx } from '../components/ui'
import { formatSigned } from '../lib/format'
import { recommendForSummary, summarizeFailure } from '../lib/protocol'
import { GATE, MODE } from '../lib/semantics'
import { stagesForStatus } from '../lib/stages'

type Tab = 'needs_you' | 'active' | 'all'

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

export default function Experiments() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'needs_you'
  const projects = useProjects()
  const projectId = Number(params.get('project')) || undefined
  const created = (params.get('new') ?? '').split(',').filter(Boolean).map(Number)

  const needs = useExperiments({ status: 'needs_you', project_id: projectId })
  const active = useExperiments({ status: 'active', project_id: projectId })
  const all = useExperiments({ project_id: projectId })
  const current = tab === 'needs_you' ? needs : tab === 'active' ? active : all
  const waiting = needs.data?.length ?? 0

  const setTab = (value: Tab) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('tab', value)
      return next
    })

  return (
    <>
      <PageHeader
        title="Experiments"
        answer={
          needs.data
            ? [
                waiting ? `${waiting} experiment${waiting > 1 ? 's need' : ' needs'} your decision` : 'Nothing is waiting for you',
                active.data ? `${Math.max(0, active.data.length - waiting)} in progress` : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : undefined
        }
        description="Each experiment implements one paper’s claim behind a feature flag, A/B tests it on your project, and compares the result with the paper."
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
      <Tabs<Tab>
        id="experiment-tabs"
        label="Experiment filters"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'needs_you', label: 'Needs you', count: needs.data?.length, attention: true },
          { value: 'active', label: 'Active', count: active.data?.length },
          { value: 'all', label: 'All', count: all.data?.length },
        ]}
      />
      <TabPanel tabsId="experiment-tabs" value={tab} className="mt-4">
        {current.isLoading ? (
          <Skeleton variant="row" count={5} />
        ) : current.isError ? (
          <ErrorState error={current.error} onRetry={() => current.refetch()} />
        ) : !current.data?.length ? (
          <div className="card">
            <EmptyState
              icon={<FlaskIcon size={28} />}
              title={tab === 'needs_you' ? 'No gates are waiting for you' : tab === 'active' ? 'Nothing in progress' : 'No experiments yet'}
            >
              {tab === 'all' ? (
                <>
                  Pick a claim on the <Link to="/recommendations">Recommendations</Link> page to start one.
                </>
              ) : (
                'Experiments show up here when they need a decision or are running.'
              )}
            </EmptyState>
          </div>
        ) : (
          <DataTable
            label="Experiments"
            rows={current.data}
            rowKey={(row) => row.id}
            rowHref={(row) => `/experiments/${row.id}`}
            columns={COLUMNS}
            rowClassName={(row) => (created.includes(row.id) ? 'bg-info-subtle/60' : undefined)}
            className="md:overflow-hidden md:rounded-lg md:border md:border-line md:bg-canvas"
          />
        )}
      </TabPanel>
    </>
  )
}
