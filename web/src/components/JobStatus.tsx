import type { ReactNode } from 'react'
import type { Job } from '../api/types'
import { durationBetween, formatDuration } from '../lib/format'
import { summarizeEvent } from '../lib/overview'
import { jobHeadline, jobStatusSemantics } from '../lib/overviewJobs'
import { EventTimeline } from './EventTimeline'
import { SemanticIcon } from './Icons'
import { useLiveEvents } from './LiveEvents'
import { cx, Disclosure, RelativeTime, TONE_CLASSES, TONE_TEXT } from './ui'

/** Job status chip: one word, tone and icon per status (lib/overviewJobs.ts). */
export function JobStatusChip({ status, className }: { status: string; className?: string }) {
  const info = jobStatusSemantics(status)
  return (
    <span className={cx('chip', TONE_CLASSES[info.tone], className)}>
      <SemanticIcon name={info.icon} size={12} className="shrink-0" />
      {info.label}
    </span>
  )
}

/** Raw error output (a traceback, usually) behind a disclosure: experts open it, everyone else reads the summary. */
export function ErrorOutput({ error, label = 'Show error output' }: { error: string; label?: string }) {
  return (
    <Disclosure label={label} summaryClassName="text-xs">
      <pre className="max-h-64 overflow-auto rounded-md border border-line-muted bg-canvas-subtle p-2 font-mono text-xs whitespace-pre-wrap break-words text-fg">
        {error}
      </pre>
    </Disclosure>
  )
}

/**
 * Status of one queued job, plain summary first (§3.10): state and timing, then what happened in one sentence
 * (its failure, result or latest progress), then the raw error output and progress log behind disclosures.
 */
export function JobStatus({ job, title, action, summary }: { job: Job; title: ReactNode; action?: ReactNode; summary?: ReactNode }) {
  const live = useLiveEvents()
  const events = live.events.filter((event) => event.job_id === job.id)
  const active = job.status === 'queued' || job.status === 'running'
  const headline = jobHeadline(job)
  const latest = events[0]
  const failed = job.status === 'failed' || !!job.error
  const line: ReactNode = failed
    ? headline.text
    : job.status === 'running' && latest
      ? summarizeEvent(latest)
      : job.status === 'done' && summary
        ? summary
        : headline.text
  return (
    <div className="rounded-md border border-line-muted">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm">
        <span className="font-semibold">{title}</span>
        <JobStatusChip status={job.status} />
        <span className="text-xs text-muted">
          queued <RelativeTime iso={job.created_at} />
          {job.started_at && <> · ran {formatDuration(durationBetween(job.started_at, job.finished_at))}</>}
          {job.payload?.use_llm === false && ' · without the LLM'}
        </span>
        {action}
      </div>
      <div className="space-y-1.5 border-t border-line-muted px-3 py-2">
        <p className={cx('text-sm break-words', failed ? TONE_TEXT.negative : 'text-fg')}>
          {!failed && job.status === 'done' && <span className="text-muted">Result: </span>}
          {line}
        </p>
        {job.status === 'queued' && (
          <p className="text-xs text-muted">
            A worker picks it up when one is free (<code className="code-inline">paperatlas services up</code> starts one).
          </p>
        )}
        {job.error && <ErrorOutput error={job.error} />}
        {events.length > 0 && (
          <Disclosure label="Progress log" meta={` (${events.length})`} summaryClassName="text-xs">
            <EventTimeline events={events} dense />
          </Disclosure>
        )}
        {active && events.length === 0 && <p className="text-xs text-muted">No progress reported yet.</p>}
      </div>
    </div>
  )
}
