import { useState } from 'react'
import { Link } from 'react-router'
import type { LabEvent } from '../api/types'
import { humanize } from '../lib/format'
import { AlertIcon, ChevronDown, ChevronRight, InfoIcon, XIcon } from './Icons'
import { cx, RelativeTime } from './ui'

const STAGE_TONES: Record<string, string> = {
  topics: 'bg-done-subtle text-done',
  discover: 'bg-done-subtle text-done',
  distill: 'bg-done-subtle text-done',
  match: 'bg-done-subtle text-done',
  roofline: 'bg-accent-subtle text-accent',
  pick: 'bg-attention-subtle text-attention',
  plan: 'bg-accent-subtle text-accent',
  approve: 'bg-attention-subtle text-attention',
  build: 'bg-accent-subtle text-accent',
  smoke: 'bg-accent-subtle text-accent',
  eval: 'bg-accent-subtle text-accent',
  waiting_gpu: 'bg-neutral-subtle text-muted',
  decide: 'bg-success-subtle text-success',
  cancel: 'bg-neutral-subtle text-muted',
  retry: 'bg-neutral-subtle text-muted',
}

function LevelIcon({ level }: { level: string }) {
  if (level === 'error') return <XIcon size={14} className="text-danger" aria-label="error" />
  if (level === 'warning') return <AlertIcon size={14} className="text-attention" aria-label="warning" />
  return <InfoIcon size={14} className="text-subtle" aria-hidden="true" />
}

function EventData({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const keys = Object.keys(data)
  if (!keys.length) return null
  return (
    <div className="mt-1">
      <button type="button" className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {keys.join(', ')}
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-line-muted bg-canvas-subtle p-2 text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg">
          {typeof data.traceback === 'string' && keys.length === 1 ? data.traceback : JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  )
}

export function EventTimeline({ events, showContext = false, emptyText = 'No events yet.', dense = false }: {
  events: LabEvent[]
  /** Show links to the experiment / triage the event belongs to (global feed). */
  showContext?: boolean
  emptyText?: string
  dense?: boolean
}) {
  if (!events.length) return <p className="py-6 text-center text-sm text-muted">{emptyText}</p>
  return (
    <ol className="relative">
      {events.map((event) => (
        <li key={event.id} className={cx('flex gap-3 border-b border-line-muted last:border-b-0', dense ? 'py-2' : 'py-2.5')}>
          <div className="mt-0.5 shrink-0">
            <LevelIcon level={event.level} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className={cx('rounded px-1.5 py-px font-mono text-[11px] font-semibold', STAGE_TONES[event.stage] ?? 'bg-neutral-subtle text-muted')}>
                {humanize(event.stage)}
              </span>
              {showContext && event.experiment_id && (
                <Link to={`/experiments/${event.experiment_id}`} className="font-semibold">
                  Experiment #{event.experiment_id}
                </Link>
              )}
              {showContext && !event.experiment_id && event.triage_id && (
                <Link to={`/recommendations?triage=${event.triage_id}`} className="font-semibold">
                  Research scan #{event.triage_id}
                </Link>
              )}
              <RelativeTime iso={event.created_at} className="text-muted" />
            </div>
            <p
              className={cx(
                'mt-0.5 text-sm break-words',
                event.level === 'error' ? 'text-danger' : event.level === 'warning' ? 'text-attention' : 'text-fg',
                dense && 'line-clamp-2',
              )}
            >
              {event.message}
            </p>
            {!dense && event.data && <EventData data={event.data} />}
          </div>
        </li>
      ))}
    </ol>
  )
}
