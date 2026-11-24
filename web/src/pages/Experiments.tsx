import { Link, useNavigate, useSearchParams } from 'react-router'
import { useExperiments, useProjects } from '../api/queries'
import type { ExperimentSummary } from '../api/types'
import { CategoryChip, Delta, ModeBadge, StatusChip, VerdictBadge } from '../components/Badges'
import { FlaskIcon, SparkIcon } from '../components/Icons'
import { MiniStages } from '../components/Stepper'
import { Banner, EmptyState, ErrorState, Loading, PageHeader, RelativeTime, Tabs, cx } from '../components/ui'
import { formatPct } from '../lib/format'
import { needsYou, stagesForStatus } from '../lib/stages'

type Tab = 'needs_you' | 'active' | 'all'

function ExperimentRow({ experiment, highlight }: { experiment: ExperimentSummary; highlight: boolean }) {
  const navigate = useNavigate()
  const open = () => navigate(`/experiments/${experiment.id}`)
  return (
    <tr
      className={cx('cursor-pointer border-b border-line-muted last:border-b-0 hover:bg-canvas-subtle', highlight && 'bg-accent-subtle/60')}
      onClick={open}
    >
      <td className="py-3 pr-2 pl-4 align-top text-xs whitespace-nowrap text-muted tabular-nums">
        #{experiment.id}
        {experiment.rerun_of_experiment_id != null && (
          <span className="ml-1 font-semibold text-accent" title={`Re-run of #${experiment.rerun_of_experiment_id}`}>
            <span aria-hidden="true">↻</span>
            <span className="sr-only">re-run of #{experiment.rerun_of_experiment_id}</span>
          </span>
        )}
      </td>
      <td className="w-full max-w-0 min-w-56 py-3 pr-3 align-top">
        <Link to={`/experiments/${experiment.id}`} className="font-semibold text-fg hover:text-accent" onClick={(event) => event.stopPropagation()}>
          {experiment.title}
        </Link>
        <div className="mt-0.5 truncate text-xs text-muted">
          <ModeBadge mode={experiment.mode} bundleSize={experiment.bundle_claim_ids?.length} className="mr-1.5 align-[1px]" />
          {experiment.flag_name && <code className="code-inline mr-1.5">{experiment.flag_name}</code>}
          {experiment.paper_title}
        </div>
        {experiment.status === 'blocked' && experiment.depends_on_experiment_id != null && (
          <div className={cx('mt-1 text-xs', experiment.error ? 'font-semibold text-attention' : 'text-muted')}>
            {experiment.error ? 'Prerequisite ' : 'Waits for '}
            <Link to={`/experiments/${experiment.depends_on_experiment_id}`} onClick={(event) => event.stopPropagation()}>
              #{experiment.depends_on_experiment_id}
            </Link>
            {experiment.error ? ' was not merged — retry to run without it' : ' to be merged, then starts automatically'}
          </div>
        )}
        {needsYou(experiment.status) && (
          <div className="mt-1 text-xs font-semibold text-attention">
            {experiment.status === 'awaiting_approval' ? 'Gate 2 · approve the spec' : 'Gate 3 · merge or drop'}
          </div>
        )}
        {experiment.status === 'failed' && experiment.error && <div className="mt-1 line-clamp-1 text-xs text-danger">{experiment.error}</div>}
      </td>
      <td className="hidden py-3 pr-3 align-top lg:table-cell">
        <CategoryChip category={experiment.category} />
      </td>
      <td className="py-3 pr-3 align-top">
        <StatusChip status={experiment.status} />
      </td>
      <td className="hidden py-3 pr-3 align-top md:table-cell">
        <MiniStages stages={stagesForStatus(experiment.status, experiment.stage)} />
      </td>
      <td className="py-3 pr-3 align-top">
        <VerdictBadge verdict={experiment.verdict} />
      </td>
      <td className="py-3 pr-3 text-right align-top whitespace-nowrap">
        <Delta value={experiment.median_delta_pct} />
        <div className="text-[11px] text-muted">claimed {formatPct(experiment.claimed_gain_pct, 0)}</div>
      </td>
      <td className="hidden py-3 pr-4 text-right align-top text-xs whitespace-nowrap text-muted sm:table-cell">
        <RelativeTime iso={experiment.updated_at} />
      </td>
    </tr>
  )
}

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
        description="Each experiment implements one claim behind a feature flag, A/B benchmarks it and judges the result against the paper."
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
              <SparkIcon /> New from recommendations
            </Link>
          </>
        }
      />
      {created.length > 0 && (
        <div className="mb-4">
          <Banner tone="success">
            Created {created.map((id, index) => (
              <span key={id}>
                {index > 0 && ', '}
                <Link to={`/experiments/${id}`}>#{id}</Link>
              </span>
            ))}
            . The planner is drafting the specs — they will appear under <strong>Needs you</strong> for approval.
          </Banner>
        </div>
      )}
      <Tabs<Tab>
        label="Experiment filters"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'needs_you', label: 'Needs you', count: needs.data?.length, attention: true },
          { value: 'active', label: 'Active', count: active.data?.length },
          { value: 'all', label: 'All', count: all.data?.length },
        ]}
      />
      <div className="card mt-4 overflow-hidden" role="tabpanel">
        {current.isLoading ? (
          <Loading />
        ) : current.isError ? (
          <div className="p-4">
            <ErrorState error={current.error} onRetry={() => current.refetch()} />
          </div>
        ) : !current.data?.length ? (
          <EmptyState
            icon={<FlaskIcon size={28} />}
            title={tab === 'needs_you' ? 'No gates waiting for you' : tab === 'active' ? 'Nothing in progress' : 'No experiments yet'}
          >
            {tab === 'all' ? (
              <>
                Pick a claim on the <Link to="/recommendations">Recommendations</Link> page to start one.
              </>
            ) : (
              'You will see experiments here when they need a decision or are running.'
            )}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Experiments</caption>
              <thead className="border-b border-line bg-canvas-subtle text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-2 pl-4 font-medium">
                    #
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Concept
                  </th>
                  <th scope="col" className="hidden py-2 pr-3 font-medium lg:table-cell">
                    Category
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="hidden py-2 pr-3 font-medium md:table-cell">
                    Stage
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Verdict
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Δ measured
                  </th>
                  <th scope="col" className="hidden py-2 pr-4 text-right font-medium sm:table-cell">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody>
                {current.data.map((experiment) => (
                  <ExperimentRow key={experiment.id} experiment={experiment} highlight={created.includes(experiment.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
