import { useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { keys, useActivity } from '../api/queries'
import { api } from '../api/client'
import { mergeEvents, useEventStream, type StreamStatus } from '../api/sse'
import type { LabEvent } from '../api/types'

interface LiveEventsValue {
  /** Newest first. */
  events: LabEvent[]
  status: StreamStatus
  loading: boolean
  error: unknown
}

const LiveEventsContext = createContext<LiveEventsValue>({ events: [], status: 'idle', loading: true, error: null })

const FEED_SIZE = 80

/**
 * One app-wide subscription to /api/lab/events/stream: feeds the activity list and invalidates
 * cached queries touched by new events (experiments, triage, stats, jobs, recommendations).
 */
export function LiveEventsProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const activity = useActivity(50)
  const [streamed, setStreamed] = useState<LabEvent[]>([])
  const [after, setAfter] = useState<number | null>(null)
  const pending = useRef<{ keys: Set<string>; experiments: Set<number>; triage: Set<number> }>({
    keys: new Set(),
    experiments: new Set(),
    triage: new Set(),
  })
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (after === null && activity.data) setAfter(activity.data.reduce((max, event) => Math.max(max, event.id), 0))
  }, [activity.data, after])

  useEffect(() => () => clearTimeout(timer.current), [])

  const flushInvalidations = useCallback(() => {
    const { keys: groups, experiments, triage } = pending.current
    pending.current = { keys: new Set(), experiments: new Set(), triage: new Set() }
    for (const group of groups) client.invalidateQueries({ queryKey: [group] })
    for (const id of experiments) {
      client.invalidateQueries({ queryKey: keys.experiment(id), exact: true })
      client.invalidateQueries({ queryKey: keys.experimentLog(id) })
    }
    for (const id of triage) client.invalidateQueries({ queryKey: keys.triage(id) })
  }, [client])

  const onEvents = useCallback(
    (batch: LabEvent[]) => {
      setStreamed((current) => mergeEvents(current, batch, FEED_SIZE))
      const target = pending.current
      target.keys.add('stats')
      target.keys.add('jobs')
      for (const event of batch) {
        if (event.experiment_id) {
          target.experiments.add(event.experiment_id)
          target.keys.add('experiments')
        }
        if (event.triage_id) {
          target.triage.add(event.triage_id)
          target.keys.add('triage')
        }
        if (['match', 'pick', 'distill'].includes(event.stage)) {
          target.keys.add('recommendations')
          target.keys.add('claims')
          target.keys.add('papers')
        }
        if (event.stage === 'topics') target.keys.add('topics')
      }
      clearTimeout(timer.current)
      timer.current = setTimeout(flushInvalidations, 400)
    },
    [flushInvalidations],
  )

  const status = useEventStream(after === null ? null : api.streams.all, { after: after ?? 0, onEvents })

  const events = useMemo(() => {
    const initial = activity.data ? [...activity.data].sort((a, b) => a.id - b.id) : []
    const merged = [...mergeEvents(initial, streamed, FEED_SIZE + 50)]
    return merged.reverse().slice(0, FEED_SIZE)
  }, [activity.data, streamed])

  const value = useMemo(
    () => ({ events, status, loading: activity.isLoading, error: activity.error }),
    [events, status, activity.isLoading, activity.error],
  )

  return <LiveEventsContext.Provider value={value}>{children}</LiveEventsContext.Provider>
}

export const useLiveEvents = () => useContext(LiveEventsContext)
