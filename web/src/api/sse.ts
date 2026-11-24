import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LabEvent } from './types'

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting'

export interface EventStreamOptions {
  /** Start after this event id; -1 = only new events (later reconnects resume from the last seen id). */
  after?: number
  /** Called with batches of new events (bursts are coalesced to keep renders cheap). */
  onEvents: (events: LabEvent[]) => void
  enabled?: boolean
}

const MAX_BACKOFF_MS = 30_000

/**
 * Subscribe to a PaperAtlas SSE endpoint (`event: progress`, data = event JSON).
 * Reconnects with backoff even when the browser gives up (e.g. gateway returned 502),
 * resuming from the last seen event id.
 */
export function useEventStream(url: string | null, { after = 0, onEvents, enabled = true }: EventStreamOptions): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('idle')
  const handler = useRef(onEvents)
  const startAfter = useRef(after)
  useLayoutEffect(() => {
    handler.current = onEvents
    startAfter.current = after
  })

  useEffect(() => {
    if (!url || !enabled || typeof EventSource === 'undefined') {
      setStatus('idle')
      return
    }
    let source: EventSource | null = null
    let lastId = startAfter.current
    let attempt = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    let buffer: LabEvent[] = []
    let disposed = false

    const flush = () => {
      flushTimer = undefined
      if (!buffer.length || disposed) return
      const batch = buffer
      buffer = []
      handler.current(batch)
    }

    const connect = () => {
      if (disposed) return
      const target = new URL(url, window.location.origin)
      if (lastId !== 0) target.searchParams.set('after', String(lastId))
      source = new EventSource(target.toString())
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting')
      source.onopen = () => {
        attempt = 0
        setStatus('open')
      }
      source.addEventListener('progress', (message) => {
        try {
          const event = JSON.parse((message as MessageEvent<string>).data) as LabEvent
          if (event.id <= lastId) return
          lastId = event.id
          buffer.push(event)
          if (!flushTimer) flushTimer = setTimeout(flush, 120)
        } catch {
          // ignore malformed frames
        }
      })
      source.onerror = () => {
        if (!source) return
        if (source.readyState === EventSource.CLOSED) {
          source.close()
          attempt += 1
          setStatus('reconnecting')
          retryTimer = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 5)))
        } else {
          setStatus('reconnecting')
        }
      }
    }

    connect()
    return () => {
      disposed = true
      clearTimeout(retryTimer)
      clearTimeout(flushTimer)
      source?.close()
    }
  }, [url, enabled])

  return status
}

/** Merge new events into a sorted, de-duplicated list (by id), keeping at most `max` newest. */
export function mergeEvents(current: LabEvent[], incoming: LabEvent[], max = 1000): LabEvent[] {
  if (!incoming.length) return current
  const byId = new Map<number, LabEvent>()
  for (const event of current) byId.set(event.id, event)
  for (const event of incoming) byId.set(event.id, event)
  const merged = [...byId.values()].sort((a, b) => a.id - b.id)
  return merged.length > max ? merged.slice(merged.length - max) : merged
}
