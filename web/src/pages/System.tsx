import { Fragment, useState } from 'react'
import { Link } from 'react-router'
import { useJobs, useServices } from '../api/queries'
import type { Job } from '../api/types'
import { ChevronDown, ChevronRight, RefreshIcon, ServerIcon } from '../components/Icons'
import { Button, Card, Chip, EmptyState, ErrorState, Loading, PageHeader, RelativeTime, cx } from '../components/ui'
import { durationBetween, formatDuration } from '../lib/format'
import type { Tone } from '../lib/stages'

const JOB_TONE: Record<string, Tone> = { queued: 'attention', running: 'accent', done: 'success', failed: 'danger', cancelled: 'muted' }

function JobRow({ job }: { job: Job }) {
  const [open, setOpen] = useState(false)
  const expandable = !!job.error || Object.keys(job.payload ?? {}).length > 0 || !!job.result
  return (
    <Fragment>
      <tr className="border-t border-line-muted align-top">
        <td className="py-2 pr-2 pl-4 text-xs text-muted tabular-nums">
          {expandable ? (
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Details for job ${job.id}`} className="inline-flex items-center gap-1 hover:text-accent">
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}#{job.id}
            </button>
          ) : (
            `#${job.id}`
          )}
        </td>
        <td className="py-2 pr-3">
          <code className="code-inline">{job.kind}</code>
        </td>
        <td className="py-2 pr-3">
          <Chip tone={JOB_TONE[job.status] ?? 'neutral'}>
            {job.status === 'running' && <span className="size-1.5 animate-pulse-dot rounded-full bg-current" />}
            {job.status}
          </Chip>
        </td>
        <td className="py-2 pr-3 text-xs">
          {job.experiment_id ? (
            <Link to={`/experiments/${job.experiment_id}`}>experiment #{job.experiment_id}</Link>
          ) : job.triage_id ? (
            <Link to={`/recommendations?triage=${job.triage_id}`}>scan #{job.triage_id}</Link>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
        <td className="hidden py-2 pr-3 text-xs text-muted md:table-cell">{job.attempts}</td>
        <td className="py-2 pr-3 text-xs whitespace-nowrap text-muted">
          <RelativeTime iso={job.created_at} />
        </td>
        <td className="hidden py-2 pr-4 text-right text-xs whitespace-nowrap text-muted sm:table-cell">
          {job.started_at ? formatDuration(durationBetween(job.started_at, job.finished_at)) : '—'}
        </td>
      </tr>
      {open && (
        <tr className="bg-canvas-subtle">
          <td colSpan={7} className="px-4 pb-3">
            {job.error && <pre className="mb-2 max-h-48 overflow-auto rounded bg-danger-subtle p-2 text-xs whitespace-pre-wrap text-danger">{job.error}</pre>}
            <pre className="max-h-48 overflow-auto rounded bg-canvas p-2 text-xs">{JSON.stringify({ payload: job.payload, result: job.result }, null, 2)}</pre>
          </td>
        </tr>
      )}
    </Fragment>
  )
}

export default function System() {
  const services = useServices()
  const [status, setStatus] = useState('')
  const jobs = useJobs(100, status || undefined)

  return (
    <>
      <PageHeader title="System" description="Health of the microservices behind this console and the Postgres job queue the worker consumes." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          title="Services"
          className="self-start"
          actions={
            <Button size="sm" onClick={() => services.refetch()} loading={services.isFetching} icon={<RefreshIcon size={14} />}>
              Check
            </Button>
          }
        >
          <ul className="space-y-3 text-sm">
            <li className="flex items-start justify-between gap-2">
              <span className="flex items-start gap-2">
                <ServerIcon className="mt-0.5 text-muted" />
                <span>
                  <span className="font-medium">gateway</span>
                  <span className="block text-xs text-muted">{window.location.origin} · serves this UI, proxies /api/*</span>
                </span>
              </span>
              <Chip tone={services.isError ? 'danger' : 'success'}>{services.isError ? 'unreachable' : 'ok'}</Chip>
            </li>
            {Object.entries(services.data ?? {}).map(([name, health]) => (
              <li key={name} className="flex items-start justify-between gap-2">
                <span className="flex items-start gap-2">
                  <ServerIcon className="mt-0.5 text-muted" />
                  <span>
                    <span className="font-medium">{name}-api</span>
                    <span className="block text-xs text-muted">{health.url}</span>
                  </span>
                </span>
                <Chip tone={health.status === 'ok' ? 'success' : 'danger'}>{health.status}</Chip>
              </li>
            ))}
            <li className="flex items-start justify-between gap-2">
              <span className="flex items-start gap-2">
                <ServerIcon className="mt-0.5 text-muted" />
                <span>
                  <span className="font-medium">worker</span>
                  <span className="block text-xs text-muted">consumes the job queue — health is visible through job progress</span>
                </span>
              </span>
              <Chip tone="neutral">n/a</Chip>
            </li>
          </ul>
          {services.isError && <p className="mt-3 text-xs text-danger">Start everything with <code className="code-inline">paperatlas services up</code>.</p>}
        </Card>

        <Card
          className="lg:col-span-2"
          title="Jobs"
          bodyClassName="p-0"
          actions={
            <>
              <label htmlFor="job-status" className="sr-only">
                Filter by status
              </label>
              <select id="job-status" className="input h-7 w-auto py-0 text-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                {['queued', 'running', 'done', 'failed', 'cancelled'].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={() => jobs.refetch()} loading={jobs.isFetching} icon={<RefreshIcon size={14} />}>
                Refresh
              </Button>
            </>
          }
        >
          {jobs.isLoading ? (
            <Loading />
          ) : jobs.isError ? (
            <div className="p-4">
              <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />
            </div>
          ) : !jobs.data?.length ? (
            <EmptyState title="No jobs" />
          ) : (
            <div className="overflow-x-auto">
              <table className={cx('w-full text-sm')}>
                <caption className="sr-only">Jobs</caption>
                <thead className="bg-canvas-subtle text-left text-xs text-muted">
                  <tr>
                    <th scope="col" className="py-2 pr-2 pl-4 font-medium">
                      Job
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Kind
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Status
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      For
                    </th>
                    <th scope="col" className="hidden py-2 pr-3 font-medium md:table-cell">
                      Attempts
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Created
                    </th>
                    <th scope="col" className="hidden py-2 pr-4 text-right font-medium sm:table-cell">
                      Duration
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.data.map((job) => (
                    <JobRow key={job.id} job={job} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}
