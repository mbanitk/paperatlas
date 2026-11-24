import { useState } from 'react'
import { Link } from 'react-router'
import { useExplainBackfill, useJobs, useJobsOfKind, useProjects, useServices } from '../api/queries'
import type { Job, LabEvent } from '../api/types'
import { ConfirmDialog, Modal } from '../components/Dialog'
import { AlertIcon, RefreshIcon, SemanticIcon, SparkIcon } from '../components/Icons'
import { ErrorOutput, JobStatus, JobStatusChip } from '../components/JobStatus'
import { useLiveEvents } from '../components/LiveEvents'
import { DataTable, type Column } from '../components/Table'
import { useToast } from '../components/Toast'
import { Button, Card, DefinitionList, Disclosure, EmptyState, ErrorState, PageHeader, RelativeTime, Skeleton, TONE_CLASSES, TONE_TEXT, cx } from '../components/ui'
import { durationBetween, formatDateTime, formatDuration, pluralize } from '../lib/format'
import { summarizeEvent, type AnswerPart } from '../lib/overview'
import { jobHeadline, jobKindDescription, jobKindLabel, jobResultSummary, jobTarget, serviceRows, systemAnswer, type ServiceRow } from '../lib/overviewJobs'
import type { SemanticInfo } from '../lib/semantics'

const PAGE = 25

const SERVICE_STATE: Record<ServiceRow['state'], SemanticInfo> = {
  ok: { label: 'OK', tone: 'positive', icon: 'check', description: 'Responding normally.' },
  down: { label: 'Not responding', tone: 'negative', icon: 'x', description: 'Didn’t answer the health check.' },
  unknown: { label: 'Not checked', tone: 'neutral', icon: 'question', description: 'No health check for this one.' },
}

function StateChip({ state }: { state: ServiceRow['state'] }) {
  const info = SERVICE_STATE[state]
  return (
    <span className={cx('chip', TONE_CLASSES[info.tone])}>
      <SemanticIcon name={info.icon} size={12} className="shrink-0" />
      {info.label}
    </span>
  )
}

function AnswerLine({ parts }: { parts: AnswerPart[] }) {
  return (
    <>
      {parts.map((part, index) => {
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

function duration(job: Job): string {
  return job.started_at ? formatDuration(durationBetween(job.started_at, job.finished_at)) : 'Not started'
}

// ---- job details -------------------------------------------------------------------------------------

function JobDetailsDialog({ job, onClose }: { job: Job | null; onClose: () => void }) {
  if (!job) return null
  const headline = jobHeadline(job)
  const target = jobTarget(job)
  return (
    <Modal open onClose={onClose} title={`${jobKindLabel(job.kind, job.payload)} · job #${job.id}`} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <JobStatusChip status={job.status} />
          <span className="text-sm text-muted">{jobKindDescription(job.kind, job.payload)}</span>
        </div>
        <p className={cx('text-body-lg break-words', headline.tone === 'negative' ? TONE_TEXT.negative : 'text-fg')}>{headline.text}</p>
        <DefinitionList
          items={[
            ['For', target.to ? <Link key="for" to={target.to} className="inline-flex min-h-6 items-center">{target.label}</Link> : target.label],
            ['Queued', job.created_at ? formatDateTime(job.created_at) : 'Not recorded'],
            ['Took', duration(job)],
            ['Attempts', String(job.attempts)],
          ]}
        />
        {job.error && <ErrorOutput error={job.error} />}
        <Disclosure label="Raw job data" meta=" (payload and result)" summaryClassName="text-xs">
          <pre className="max-h-72 overflow-auto rounded-md border border-line-muted bg-canvas-subtle p-2 font-mono text-xs whitespace-pre-wrap break-words text-fg">
            {JSON.stringify({ kind: job.kind, payload: job.payload, result: job.result }, null, 2)}
          </pre>
        </Disclosure>
      </div>
    </Modal>
  )
}

// ---- failed jobs callout (S-1) ------------------------------------------------------------------------------

function FailedJobs({ jobs, onOpen }: { jobs: Job[]; onOpen: (job: Job) => void }) {
  const failed = jobs.filter((job) => job.status === 'failed')
  if (!failed.length) return null
  return (
    <section id="failed-jobs" aria-labelledby="failed-jobs-title" className="rounded-lg border border-negative/30 bg-negative-subtle/60 p-3 sm:p-4">
      <h2 id="failed-jobs-title" className="flex items-center gap-2 text-sm font-semibold text-negative-fg">
        <AlertIcon size={16} className="shrink-0" />
        {pluralize(failed.length, 'job')} failed
      </h2>
      <ul className="mt-2 space-y-2">
        {failed.slice(0, 3).map((job) => {
          const target = jobTarget(job)
          return (
            <li key={job.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md border border-line bg-canvas px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-muted">
                  {jobKindLabel(job.kind, job.payload)} · job #{job.id} ·{' '}
                  {target.to ? (
                    <Link to={target.to} className="inline-flex min-h-6 items-center">
                      {target.label}
                    </Link>
                  ) : (
                    target.label
                  )}{' '}
                  · <RelativeTime iso={job.finished_at ?? job.created_at} />
                </div>
                <p className="text-sm break-words text-fg">{jobHeadline(job).text}</p>
              </div>
              <Button size="sm" onClick={() => onOpen(job)}>
                Details
              </Button>
            </li>
          )
        })}
      </ul>
      {failed.length > 3 && <p className="mt-2 text-xs text-muted">{pluralize(failed.length - 3, 'older failure')} in the jobs list below.</p>}
    </section>
  )
}

// ---- services ----------------------------------------------------------------------------------------

const SERVICE_COLUMNS: Column<ServiceRow>[] = [
  {
    key: 'service',
    header: 'Service',
    cell: (row) => (
      <span className="block min-w-0">
        <span className="block font-medium text-fg">{row.name}</span>
        <span className="block text-xs text-muted">{row.role}</span>
      </span>
    ),
  },
  { key: 'status', header: 'Status', nowrap: true, cardSlot: 'badge', cell: (row) => <StateChip state={row.state} /> },
  {
    key: 'address',
    header: 'Address',
    priority: 3,
    cell: (row) => (row.url ? <code className="font-mono text-xs break-all text-muted">{row.url}</code> : <span className="text-xs text-muted">Not applicable</span>),
  },
]

function ServicesCard() {
  const services = useServices()
  const rows = serviceRows(services.data, { gatewayUrl: window.location.origin, gatewayDown: services.isError })
  return (
    <Card
      title="Services"
      className="min-w-0"
      actions={
        <Button size="sm" onClick={() => services.refetch()} loading={services.isFetching} icon={<RefreshIcon size={14} />}>
          Check again
        </Button>
      }
    >
      {services.isLoading ? (
        <Skeleton variant="row" count={3} />
      ) : (
        <DataTable label="Services" rows={rows} rowKey={(row) => row.id} columns={SERVICE_COLUMNS} />
      )}
      {services.isError && (
        <p className="mt-3 text-sm text-fg">
          The console can’t reach the gateway. Start everything with <code className="code-inline">paperatlas services up</code>, then check again.
        </p>
      )}
    </Card>
  )
}

// ---- explanations ------------------------------------------------------------------------------------

function ExplanationsCard() {
  const projects = useProjects()
  const project = projects.data?.[0]
  const backfill = useExplainBackfill()
  const jobs = useJobsOfKind('explain')
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)
  const latest = jobs.data?.[0]
  const running = !!latest && (latest.status === 'queued' || latest.status === 'running')
  return (
    <Card
      className="min-w-0 self-start"
      title={
        <span className="flex items-center gap-2">
          <SparkIcon className="text-muted" /> Explanations
        </span>
      }
    >
      <p className="text-sm text-fg">
        Plain-language overviews of topics and papers, and explanations with flow diagrams for the top 25
        {project ? <> {project.name}</> : ''} recommendations.
      </p>
      <p className="mt-1 text-xs text-muted">Only missing ones are written, about 15 seconds each, on the worker.</p>
      <Button className="mt-3" icon={<SparkIcon size={14} />} loading={backfill.isPending} disabled={running} onClick={() => setConfirm(true)}>
        {running ? 'Writing explanations…' : 'Write missing explanations…'}
      </Button>
      {latest && (
        <div className="mt-3">
          <JobStatus job={latest} title={`Explanations job #${latest.id}`} summary={jobResultSummary(latest) ?? undefined} />
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Write missing explanations?"
        confirmLabel="Write explanations"
        loading={backfill.isPending}
        error={backfill.error}
        initialFocus="cancel"
        cost="Runs on the worker and uses the LLM API: about 15 seconds per missing explanation, so anywhere from a minute to half an hour."
        onConfirm={() =>
          backfill.mutate(
            { project_id: project?.id ?? null, claims_top: 25 },
            {
              onSuccess: (job) => {
                toast.success(`Queued job #${job.job_id}: write explanations`)
                setConfirm(false)
              },
            },
          )
        }
      >
        <p className="text-muted">
          Writes what’s missing for topics, papers and the top 25 recommendations{project ? ` of ${project.name}` : ''}. Existing explanations are kept.
        </p>
      </ConfirmDialog>
    </Card>
  )
}

// ---- jobs --------------------------------------------------------------------------------------------

function jobColumns(onOpen: (job: Job) => void, latestFor: (job: Job) => LabEvent | undefined): Column<Job>[] {
  return [
    {
      key: 'job',
      header: 'Job',
      className: 'min-w-36',
      cell: (job) => (
        <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
          <span className="font-medium text-fg">{jobKindLabel(job.kind, job.payload)}</span>
          <span className="text-xs text-muted tabular-nums">#{job.id}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', nowrap: true, cardSlot: 'badge', cell: (job) => <JobStatusChip status={job.status} /> },
    {
      key: 'for',
      header: 'For',
      nowrap: true,
      cell: (job) => {
        const target = jobTarget(job)
        return target.to ? (
          <Link to={target.to} className="relative z-[1] inline-flex min-h-6 items-center">
            {target.label}
          </Link>
        ) : (
          <span className="text-muted">{target.label}</span>
        )
      },
    },
    {
      key: 'outcome',
      header: 'Outcome',
      className: 'min-w-48',
      cell: (job) => {
        const headline = jobHeadline(job)
        const event = job.status === 'running' ? latestFor(job) : undefined
        return (
          <span className={cx('break-words', headline.tone === 'negative' ? TONE_TEXT.negative : 'text-fg')}>
            {event ? summarizeEvent(event) : headline.text}
          </span>
        )
      },
    },
    { key: 'created', header: 'Queued', priority: 3, nowrap: true, cell: (job) => <RelativeTime iso={job.created_at} className="text-muted" /> },
    { key: 'duration', header: 'Took', priority: 3, numeric: true, nowrap: true, cell: (job) => <span className="text-muted">{duration(job)}</span> },
    { key: 'attempts', header: 'Attempts', priority: 3, numeric: true, cell: (job) => <span className="text-muted">{job.attempts}</span> },
    {
      key: 'details',
      header: 'Details',
      srOnlyHeader: true,
      cardSlot: 'footer',
      nowrap: true,
      align: 'right',
      cell: (job) => (
        <Button size="sm" variant="invisible" onClick={() => onOpen(job)} aria-label={`Details of job #${job.id}`}>
          Details
        </Button>
      ),
    },
  ]
}

function JobsCard({ onOpen }: { onOpen: (job: Job) => void }) {
  const [status, setStatus] = useState('')
  const [shown, setShown] = useState(PAGE)
  const jobs = useJobs(100, status || undefined)
  const live = useLiveEvents()
  const rows = jobs.data ?? []
  const latestFor = (job: Job) =>
    live.events.find((event) => event.job_id === job.id) ?? (job.experiment_id ? live.events.find((event) => event.experiment_id === job.experiment_id) : undefined)
  return (
    <Card
      className="min-w-0"
      title="Jobs"
      actions={
        <>
          <label htmlFor="job-status" className="sr-text">
            Show jobs
          </label>
          <select
            id="job-status"
            className="input h-8 w-auto py-0 text-sm"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value)
              setShown(PAGE)
            }}
          >
            <option value="">All jobs</option>
            {['queued', 'running', 'done', 'failed', 'cancelled'].map((value) => (
              <option key={value} value={value}>
                {value.charAt(0).toUpperCase() + value.slice(1)}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={() => jobs.refetch()} loading={jobs.isFetching} icon={<RefreshIcon size={14} />}>
            Refresh
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">The worker runs these one by one; GPU work waits its turn. Newest first.</p>
      {jobs.isLoading ? (
        <Skeleton variant="row" count={5} />
      ) : jobs.isError ? (
        <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} title="Couldn’t load the jobs" />
      ) : !rows.length ? (
        <EmptyState title={status ? 'No jobs with this status' : 'No jobs yet'}>Jobs appear here when an experiment, scan or measurement is queued.</EmptyState>
      ) : (
        <>
          <DataTable label="Jobs" rows={rows.slice(0, shown)} rowKey={(job) => job.id} columns={jobColumns(onOpen, latestFor)} />
          {rows.length > shown && (
            <div className="mt-3 flex justify-center">
              <Button size="sm" onClick={() => setShown(shown + PAGE)}>
                Show {Math.min(PAGE, rows.length - shown)} more ({rows.length - shown} not shown)
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// ---- page ----------------------------------------------------------------------------------------------

export default function System() {
  const services = useServices()
  const jobs = useJobs(100)
  const [details, setDetails] = useState<Job | null>(null)
  const rows = serviceRows(services.data, { gatewayUrl: window.location.origin, gatewayDown: services.isError })
  const answer = services.isLoading && jobs.isLoading ? null : systemAnswer(rows, jobs.data, { checking: !services.data && !services.isError })

  return (
    <>
      <PageHeader
        title="System"
        answer={answer ? <AnswerLine parts={answer} /> : undefined}
        description="Health of the services behind this console, and the queue of jobs the worker runs."
      />
      <div className="space-y-6">
        {jobs.data && <FailedJobs jobs={jobs.data} onOpen={setDetails} />}
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2">
            <ServicesCard />
          </div>
          <ExplanationsCard />
        </div>
        <JobsCard onOpen={setDetails} />
      </div>
      <JobDetailsDialog job={details} onClose={() => setDetails(null)} />
    </>
  )
}
