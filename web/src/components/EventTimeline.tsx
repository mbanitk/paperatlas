import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { LabEvent } from '../api/types'
import { humanize, roundNumbersInText, sanitizeText, truncate } from '../lib/format'
import { summarizeFailure } from '../lib/protocol'
import { AlertIcon, ChevronDown, ChevronRight, InfoIcon, XIcon } from './Icons'
import { cx, RelativeTime } from './ui'

/** Plain names for event stages (research jobs and the experiment pipeline). */
const STAGE_NAMES: Record<string, string> = {
  topics: 'Topics',
  discover: 'Find papers',
  distill: 'Summarise',
  match: 'Match',
  roofline: 'Roofline',
  explain: 'Explain',
  pick: 'Gate 1',
  plan: 'Plan',
  approve: 'Gate 2',
  build: 'Build',
  smoke: 'Smoke test',
  tune: 'Tuning',
  eval: 'A/B test',
  run: 'A/B test',
  adopt: 'A/B test',
  judge: 'Judge',
  decide: 'Gate 3',
  finalize: 'Gate 3',
  waiting_gpu: 'Waiting',
  cancel: 'Cancel',
  retry: 'Retry',
  recover: 'Recovery',
}
const stageName = (stage: string) => STAGE_NAMES[stage] ?? humanize(stage)

type RawSource = 'agent' | 'bench'

/** Tool-by-tool output of the coding agent and per-round benchmark lines: grouped, shown on demand. */
function rawSource(event: LabEvent): RawSource | null {
  if (event.level !== 'info') return null
  if (/^copilot:\s/.test(event.message)) return 'agent'
  if (/^\[bench\]/.test(event.message)) return 'bench'
  return null
}

type Item = { kind: 'event'; event: LabEvent } | { kind: 'raw'; source: RawSource; events: LabEvent[] }

function groupEvents(events: LabEvent[]): Item[] {
  const items: Item[] = []
  for (const event of events) {
    const source = rawSource(event)
    const last = items[items.length - 1]
    if (source && last?.kind === 'raw' && last.source === source && last.events[0].experiment_id === event.experiment_id && last.events[0].stage === event.stage)
      last.events.push(event)
    else items.push(source ? { kind: 'raw', source, events: [event] } : { kind: 'event', event })
  }
  return items
}

const agentText = (message: string) => message.replace(/^copilot:\s*/, '').trim()
/** A sentence the agent wrote (not a tool call like "● Edit …" or "$ Shell …"). */
const isProse = (text: string) => /^[A-Z][a-z’']/.test(text) && text.split(/\s+/).length > 5

function LevelIcon({ level }: { level: string }) {
  if (level === 'error') return <XIcon size={14} className="text-negative-fg" aria-label="Error" />
  if (level === 'warning') return <AlertIcon size={14} className="text-caution-fg" aria-label="Warning" />
  return <InfoIcon size={14} className="text-muted" aria-hidden="true" />
}

function StageTag({ stage }: { stage: string }) {
  return <span className="inline-flex h-5 items-center rounded border border-line px-1.5 text-xs whitespace-nowrap text-muted">{stageName(stage)}</span>
}

function Toggle({ open, onClick, children }: { open: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="inline-flex min-h-6 items-center gap-1 text-xs font-medium text-info-fg hover:underline" onClick={onClick} aria-expanded={open}>
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      {children}
    </button>
  )
}

function RawBlock({ text }: { text: string }) {
  return <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-line-muted bg-canvas-subtle p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-fg">{text}</pre>
}

function EventData({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const keys = Object.keys(data)
  if (!keys.length) return null
  const traceback = typeof data.traceback === 'string' && keys.length === 1
  return (
    <div className="mt-1">
      <Toggle open={open} onClick={() => setOpen(!open)}>
        {traceback ? 'Show error output' : `Details: ${keys.map(humanize).join(', ')}`}
      </Toggle>
      {open && <RawBlock text={traceback ? (data.traceback as string) : JSON.stringify(data, null, 2)} />}
    </div>
  )
}

/** A long line clamps to two lines with "more". */
function Message({ text, className, clamp }: { text: string; className?: string; clamp: boolean }) {
  const [open, setOpen] = useState(false)
  const long = clamp && text.length > 180
  return (
    <div className={cx('mt-0.5 text-sm break-words', className)}>
      <p className={cx(long && !open && 'line-clamp-2')}>{text}</p>
      {long && (
        <button type="button" className="min-h-6 text-xs font-medium text-info-fg hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}

function Context({ event, showContext }: { event: LabEvent; showContext: boolean }) {
  if (!showContext) return null
  if (event.experiment_id)
    return (
      <Link to={`/experiments/${event.experiment_id}`} className="font-semibold">
        Experiment #{event.experiment_id}
      </Link>
    )
  if (event.triage_id)
    return (
      <Link to={`/recommendations?triage=${event.triage_id}`} className="font-semibold">
        Research scan #{event.triage_id}
      </Link>
    )
  return null
}

/** Failures carry a traceback: lead with a plain sentence, keep the raw text one click away. */
function failureOf(event: LabEvent) {
  return event.level === 'error' && (event.message.includes('\n') || event.message.length > 200) ? summarizeFailure(event.message.replace(/^[a-z_]+ failed:\s*/, ''), event.stage) : null
}

function eventText(event: LabEvent): string {
  const failure = failureOf(event)
  return failure ? [`${failure.title}: ${failure.plain}`, failure.cause].filter(Boolean).join(' ') : sanitizeText(event.message)
}

function EventRow({ event, showContext, dense }: { event: LabEvent; showContext: boolean; dense: boolean }) {
  const failure = failureOf(event)
  const text = eventText(event)
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <StageTag stage={event.stage} />
        <Context event={event} showContext={showContext} />
        <RelativeTime iso={event.created_at} className="text-muted" />
      </div>
      <Message text={text} clamp={!dense} className={cx(event.level === 'error' ? 'text-negative-fg' : event.level === 'warning' ? 'text-caution-fg' : 'text-fg', dense && 'line-clamp-2')} />
      {!dense && failure && !event.data?.traceback && (
        <div className="mt-1">
          <Toggle open={open} onClick={() => setOpen(!open)}>
            Show error output
          </Toggle>
          {open && <RawBlock text={failure.technical} />}
        </div>
      )}
      {!dense && event.data && <EventData data={event.data} />}
    </>
  )
}

function RawGroup({ source, events, showContext }: { source: RawSource; events: LabEvent[]; showContext: boolean }) {
  const [open, setOpen] = useState(false)
  const latest = events.reduce((a, b) => (b.id > a.id ? b : a))
  const ordered = [...events].sort((a, b) => a.id - b.id)
  const notes = ordered.map((event) => agentText(event.message)).filter(isProse)
  const headline =
    source === 'agent'
      ? notes.length
        ? `Coding agent: “${roundNumbersInText(notes[notes.length - 1])}”`
        : `The coding agent worked through ${events.length} step${events.length > 1 ? 's' : ''}.`
      : `Benchmark progress: ${roundNumbersInText(latest.message.replace(/^\[bench\]\s*/, ''))}`
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <StageTag stage={latest.stage} />
        <Context event={latest} showContext={showContext} />
        <RelativeTime iso={latest.created_at} className="text-muted" />
      </div>
      <p className="mt-0.5 line-clamp-2 text-sm break-words text-fg">{headline}</p>
      <div className="mt-0.5">
        <Toggle open={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'} {events.length} line{events.length > 1 ? 's' : ''} of {source === 'agent' ? 'agent' : 'benchmark'} output
        </Toggle>
        {open && <RawBlock text={ordered.map((event) => (source === 'agent' ? agentText(event.message) : event.message)).join('\n')} />}
      </div>
    </>
  )
}

/**
 * Event feed: milestones in plain words first; the coding agent's tool-by-tool output and per-round benchmark
 * lines are grouped into one item each, with the raw lines on demand (docs/ux-review.md SC-15, O-5, X-11).
 */
export function EventTimeline({ events, showContext = false, emptyText = 'No events yet.', dense = false }: {
  events: LabEvent[]
  /** Show links to the experiment / triage the event belongs to (global feed). */
  showContext?: boolean
  emptyText?: string
  dense?: boolean
}) {
  if (!events.length) return <p className="py-6 text-center text-sm text-muted">{emptyText}</p>
  const items = groupEvents(events)
  const raw = items.reduce((count, item) => count + (item.kind === 'raw' ? item.events.length : 0), 0)
  const latest = events.reduce((a, b) => (b.id > a.id ? b : a))
  const latestRaw = rawSource(latest)
  return (
    <>
      {!dense && (
        <p className="border-b border-line-muted py-2 text-sm text-muted">
          <span className="text-fg">
            Latest: <span className="font-medium">{latestRaw === 'bench' ? 'benchmark running' : latestRaw === 'agent' ? 'coding agent at work' : truncate(eventText(latest), 140)}</span>
          </span>{' '}
          · <RelativeTime iso={latest.created_at} />
          {raw > 0 && (
            <>
              {' '}
              · {raw} line{raw > 1 ? 's' : ''} of agent and benchmark output grouped
            </>
          )}
        </p>
      )}
      <ol className="relative">
        {items.map((item) => {
          const event = item.kind === 'event' ? item.event : item.events[0]
          return (
            // A group's key must survive new lines arriving at either end (feeds may be newest-first).
            <li key={item.kind === 'event' ? event.id : `raw-${Math.min(...item.events.map((e) => e.id))}`} className={cx('flex gap-3 border-b border-line-muted last:border-b-0', dense ? 'py-2' : 'py-2.5')}>
              <div className="mt-0.5 shrink-0">
                <LevelIcon level={event.level} />
              </div>
              <div className="min-w-0 flex-1">
                {item.kind === 'event' ? (
                  <EventRow event={item.event} showContext={showContext} dense={dense} />
                ) : (
                  <RawGroup source={item.source} events={item.events} showContext={showContext} />
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </>
  )
}
