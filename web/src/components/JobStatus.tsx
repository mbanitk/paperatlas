import type { ReactNode } from 'react'
import type { Job } from '../api/types'
import { durationBetween, formatDuration, humanize } from '../lib/format'
import type { Tone } from '../lib/stages'
import { EventTimeline } from './EventTimeline'
import { useLiveEvents } from './LiveEvents'
import { Chip, RelativeTime } from './ui'

const JOB_TONE: Record<string, Tone> = { queued: 'attention', running: 'accent', done: 'success', failed: 'danger', cancelled: 'muted' }

/** Status of one queued job: state, timing, result/error and its live progress events. */
export function JobStatus({ job, title, action }: { job: Job; title: ReactNode; action?: ReactNode }) {
  const live = useLiveEvents()
  const events = live.events.filter((event) => event.job_id === job.id)
  const active = job.status === 'queued' || job.status === 'running'
  return (
    <div className="rounded-md border border-line-muted">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <span className="font-semibold">{title}</span>
        <Chip tone={JOB_TONE[job.status] ?? 'neutral'}>
          {job.status === 'running' && <span className="size-1.5 animate-pulse-dot rounded-full bg-current" />}
          {job.status}
        </Chip>
        <span className="text-xs text-muted">
          queued <RelativeTime iso={job.created_at} />
          {job.started_at && <> · ran {formatDuration(durationBetween(job.started_at, job.finished_at))}</>}
          {job.payload?.use_llm === false && ' · heuristics only'}
        </span>
        {action}
      </div>
      {job.status === 'queued' && (
        <p className="border-t border-line-muted px-3 py-2 text-xs text-muted">
          Waiting for a worker (<code className="code-inline">paperatlas services up</code> runs one).
        </p>
      )}
      {job.error && <pre className="max-h-40 overflow-auto border-t border-line-muted bg-danger-subtle p-2 text-xs whitespace-pre-wrap text-danger">{job.error}</pre>}
      {job.result && !job.error && (
        <p className="border-t border-line-muted px-3 py-2 text-xs text-muted">
          Result: {Object.entries(job.result).map(([key, value]) => `${humanize(key)} ${String(value)}`).join(' · ')}
        </p>
      )}
      {(events.length > 0 || active) && (
        <div className="border-t border-line-muted px-3">
          <EventTimeline events={events} dense emptyText="No progress events yet." />
        </div>
      )}
    </div>
  )
}
