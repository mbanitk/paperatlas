import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ApiError } from '../api/client'
import { keys, useCategories, useCreateExperiments, useProjects, useRecommendations, useStartTriage, useTopics, useTriage, useTriageList } from '../api/queries'
import { mergeEvents, useEventStream } from '../api/sse'
import type { LabEvent, Recommendation, TriageOptions, TriageStatus, TriageSummary } from '../api/types'
import { api } from '../api/client'
import { BlockerBadge, CategoryChip, DocTypeChip, EffortChip, LiveDot, StatusChip } from '../components/Badges'
import { ClaimCardDetails, ClaimedEffect, Requirements } from '../components/ClaimCard'
import { ConfirmDialog, Modal } from '../components/Dialog'
import { EventTimeline } from '../components/EventTimeline'
import { ChevronDown, ChevronRight, RefreshIcon, SearchIcon, SparkIcon } from '../components/Icons'
import { Meter } from '../components/Charts'
import { useToast } from '../components/Toast'
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Chip,
  EmptyState,
  ErrorState,
  ExternalLink,
  Field,
  InlineError,
  Loading,
  PageHeader,
  PaperLink,
  RelativeTime,
  cx,
  errorMessage,
  useDebounced,
} from '../components/ui'
import { formatScore, humanize, pluralize } from '../lib/format'
import { isActiveStatus, isTriageRunning, TRIAGE_STATUS_LABEL, TRIAGE_STEPS, triageStepState } from '../lib/stages'

const MAX_PICK = 5

// ---- research scan (triage) -----------------------------------------------------------------

function ScanDialog({ open, onClose, projectId, onStarted }: { open: boolean; onClose: () => void; projectId: number; onStarted: (id: number) => void }) {
  const start = useStartTriage(projectId)
  const toast = useToast()
  const [refreshTopics, setRefreshTopics] = useState(false)
  const [perTopic, setPerTopic] = useState('')
  const [distillLimit, setDistillLimit] = useState('60')
  const [useLlm, setUseLlm] = useState(true)
  const perTopicValue = perTopic.trim() === '' ? null : Number(perTopic)
  const distillValue = Number(distillLimit)
  const invalid =
    (perTopicValue !== null && (!Number.isInteger(perTopicValue) || perTopicValue < 1 || perTopicValue > 50)) ||
    !Number.isInteger(distillValue) ||
    distillValue < 1 ||
    distillValue > 500

  const submit = () => {
    const options: TriageOptions = { refresh_topics: refreshTopics, per_topic: perTopicValue, distill_limit: distillValue, use_llm: useLlm }
    start.mutate(options, {
      onSuccess: (triage) => {
        toast.success(`Research scan #${triage.id} queued`)
        onStarted(triage.id)
        onClose()
      },
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Run a research scan"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={start.isPending} disabled={invalid} icon={<RefreshIcon />}>
            Start scan
          </Button>
        </>
      }
    >
      <p className="mb-4 text-muted">
        Discovers recent papers and patents on the trending topics, distills them into claim cards and re-ranks them for this project. Ends at
        Gate 1 with a fresh shortlist. Runs on the worker; you can leave this page.
      </p>
      <div className="space-y-4">
        <Checkbox
          id="scan-refresh"
          checked={refreshTopics}
          onChange={setRefreshTopics}
          label="Refresh trending topics first"
          description="Re-cluster the seed areas and pick a new top 10 (slower)."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Papers per topic" htmlFor="scan-per-topic" hint="1–50 · blank = configured default">
            <input id="scan-per-topic" className="input" type="number" min={1} max={50} value={perTopic} onChange={(e) => setPerTopic(e.target.value)} placeholder="default" />
          </Field>
          <Field label="Distill limit" htmlFor="scan-distill" hint="Max papers to distill (1–500)">
            <input id="scan-distill" className="input" type="number" min={1} max={500} value={distillLimit} onChange={(e) => setDistillLimit(e.target.value)} />
          </Field>
        </div>
        <Checkbox id="scan-llm" checked={useLlm} onChange={setUseLlm} label="Use the LLM" description="Uncheck to use heuristics only (no API key needed)." />
      </div>
      {start.error instanceof ApiError && start.error.status === 409 ? (
        <Banner tone="attention">{start.error.message}</Banner>
      ) : (
        <InlineError error={start.error} />
      )}
    </Modal>
  )
}

function TriageProgress({ triageId, onReady }: { triageId: number; onReady: () => void }) {
  const triage = useTriage(triageId)
  const client = useQueryClient()
  const [events, setEvents] = useState<LabEvent[]>([])
  const after = triage.data?.events.length ? triage.data.events[triage.data.events.length - 1].id : 0
  const running = triage.data ? isTriageRunning(triage.data.status) : false

  const onEvents = useCallback(
    (batch: LabEvent[]) => {
      setEvents((current) => mergeEvents(current, batch))
      client.invalidateQueries({ queryKey: keys.triage(triageId) })
      if (batch.some((event) => event.stage === 'pick' || event.level === 'error')) {
        client.invalidateQueries({ queryKey: ['triage'] })
        client.invalidateQueries({ queryKey: ['recommendations'] })
        onReady()
      }
    },
    [client, triageId, onReady],
  )
  const status = useEventStream(triage.data ? api.streams.triage(triageId) : null, { after, onEvents, enabled: running })

  if (triage.isLoading) return <Loading label="Loading research scan…" />
  if (triage.isError) return <ErrorState error={triage.error} onRetry={() => triage.refetch()} />
  const data = triage.data!
  const all = mergeEvents(data.events, events)
  const failedEvent = data.status === 'failed' ? all.findLast((event) => event.level === 'error') : undefined
  const failedAt = failedEvent && TRIAGE_STEPS.some((step) => step.key === failedEvent.stage) ? (failedEvent.stage as TriageStatus) : null

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Research scan #{data.id}
          <Chip tone={data.status === 'failed' ? 'danger' : running ? 'accent' : 'success'}>{TRIAGE_STATUS_LABEL[data.status] ?? data.status}</Chip>
        </span>
      }
      actions={running ? <LiveDot status={status} /> : <RelativeTime iso={data.updated_at} className="text-xs text-muted" />}
    >
      <ol className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Scan steps">
        {TRIAGE_STEPS.map((step) => {
          const state = triageStepState(data.status, step.key, failedAt)
          return (
            <li
              key={step.key}
              className={cx(
                'rounded-md border px-2.5 py-1.5 text-xs',
                state === 'done' && 'border-success/30 bg-success-subtle text-success',
                state === 'active' && 'border-accent/40 bg-accent-subtle font-semibold text-accent',
                state === 'failed' && 'border-danger/30 bg-danger-subtle text-danger',
                state === 'pending' && 'border-line-muted bg-canvas-subtle text-muted',
              )}
            >
              {step.label}
              <span className="block text-[10.5px] opacity-80">{state === 'active' ? 'running…' : state}</span>
            </li>
          )
        })}
      </ol>
      {data.status === 'queued' && (
        <p className="mb-2 text-xs text-muted">
          Queued — it starts when a worker picks it up (<code className="code-inline">paperatlas services up</code> runs one).
        </p>
      )}
      <div className="max-h-56 overflow-y-auto rounded-md border border-line-muted px-3">
        <EventTimeline events={[...all].reverse()} dense emptyText="Waiting for the first progress event…" />
      </div>
    </Card>
  )
}

function TriageBanner({ triage, logOpen, onToggleLog }: { triage: TriageSummary; logOpen: boolean; onToggleLog: () => void }) {
  if (triage.status === 'awaiting_pick') {
    return (
      <Banner
        tone="accent"
        icon={<SparkIcon className="text-accent" />}
        action={
          <Button size="sm" variant="invisible" onClick={onToggleLog} aria-expanded={logOpen}>
            {logOpen ? 'Hide scan log' : 'Scan log'}
          </Button>
        }
      >
        <strong>Research scan #{triage.id}</strong> finished <RelativeTime iso={triage.updated_at} /> with {pluralize(triage.shortlist_size, 'shortlisted claim')}.
        Gate 1: pick 1–2 claims below — the new experiments are linked to this scan.
      </Banner>
    )
  }
  if (triage.status === 'failed') {
    return (
      <Banner
        tone="danger"
        action={
          <Button size="sm" variant="invisible" onClick={onToggleLog} aria-expanded={logOpen}>
            {logOpen ? 'Hide scan log' : 'Scan log'}
          </Button>
        }
      >
        <strong>Research scan #{triage.id}</strong> failed <RelativeTime iso={triage.updated_at} />. Recommendations below are from earlier scans.
      </Banner>
    )
  }
  return null
}

// ---- recommendation card --------------------------------------------------------------------

function RecommendationCard({ item, selected, disabledReason, onToggle, shortlisted }: {
  item: Recommendation
  selected: boolean
  disabledReason: string | null
  onToggle: () => void
  shortlisted: boolean
}) {
  const [open, setOpen] = useState(false)
  const blocked = !item.testable_here || item.blockers.length > 0
  const checkboxId = `pick-${item.claim_id}`
  return (
    <article
      className={cx(
        'card transition-colors',
        selected ? 'border-accent ring-1 ring-accent' : blocked ? 'border-line-muted bg-canvas-subtle/60' : 'hover:border-subtle/60',
      )}
      aria-labelledby={`rec-title-${item.claim_id}`}
    >
      <div className="flex gap-3 p-4">
        <div className="flex flex-col items-center gap-2 pt-0.5">
          <input
            id={checkboxId}
            type="checkbox"
            className="size-4.5 accent-accent disabled:cursor-not-allowed"
            checked={selected}
            disabled={!!disabledReason && !selected}
            onChange={onToggle}
            aria-describedby={disabledReason ? `${checkboxId}-reason` : undefined}
            aria-label={`Select “${item.name}” for an experiment`}
          />
          <span className="text-xs font-semibold text-muted tabular-nums" title="Rank">
            #{item.rank}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h3 id={`rec-title-${item.claim_id}`} className="text-base leading-snug font-semibold">
                <label htmlFor={checkboxId} className="cursor-pointer">
                  {item.name}
                </label>
              </h3>
              <div className="mt-0.5 text-xs text-muted">
                <PaperLink paperId={item.paper_id} title={item.paper_title ?? item.paper_id} className="text-muted hover:text-accent" />
                {item.paper_date && <span> · {item.paper_date.slice(0, 7)}</span>}
                {item.paper_url && (
                  <>
                    {' · '}
                    <ExternalLink href={item.paper_url} className="text-muted">
                      source
                    </ExternalLink>
                  </>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
              <div className="text-sm">
                <ClaimedEffect claim={item} />
              </div>
              {item.target_metric && (
                <div className="text-xs text-muted">
                  measured as <code className="code-inline">{item.target_metric}</code>
                </div>
              )}
            </div>
          </div>

          <p className="mt-2 text-sm text-fg">{item.technique}</p>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <CategoryChip category={item.category} />
            <EffortChip effort={item.effort} />
            <DocTypeChip docType={item.paper_doc_type} />
            {item.topics.map((topic) => (
              <Link key={topic.slug} to={`/research/papers?topic=${topic.slug}`} className="chip border-line bg-canvas text-muted hover:border-accent hover:text-accent hover:no-underline">
                {topic.name}
              </Link>
            ))}
            {shortlisted && <Chip tone="accent">shortlisted</Chip>}
            {item.blockers.map((blocker) => (
              <BlockerBadge key={blocker} blocker={blocker} />
            ))}
            <Requirements claim={item} />
          </div>

          {item.rationale && (
            <p className="mt-3 rounded-md bg-canvas-subtle px-3 py-2 text-sm text-fg">
              <span className="mr-1 inline-flex items-center gap-1 text-xs font-semibold text-done">
                <SparkIcon size={12} /> Why for this project:
              </span>
              {item.rationale}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-xs text-muted">
              <div className="w-24">
                <Meter value={Math.min(item.score, 1)} label={`Match score ${formatScore(item.score)}`} tone="done" />
              </div>
              <span title="score = fit × (0.4 + gain) ÷ effort cost">
                score <strong className="text-fg tabular-nums">{formatScore(item.score)}</strong> · fit {item.fit.toFixed(2)} · gain {item.gain.toFixed(2)} · effort ×
                {item.effort_cost}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {item.experiment_id && item.experiment_status && (
                <Link to={`/experiments/${item.experiment_id}`} className="inline-flex items-center gap-1.5 text-xs hover:no-underline">
                  Experiment #{item.experiment_id} <StatusChip status={item.experiment_status} />
                </Link>
              )}
              <Button size="sm" variant="invisible" onClick={() => setOpen(!open)} aria-expanded={open} icon={open ? <ChevronDown /> : <ChevronRight />}>
                {open ? 'Hide' : 'Claim card'}
              </Button>
            </div>
          </div>
          {disabledReason && !selected && (
            <p id={`${checkboxId}-reason`} className="mt-2 text-xs text-muted">
              {disabledReason}
            </p>
          )}
          {open && (
            <div className="mt-3 border-t border-line-muted pt-3">
              <ClaimCardDetails claim={item} showPaper={false} />
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

// ---- page -----------------------------------------------------------------------------------

export default function Recommendations() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const projects = useProjects()
  const projectId = Number(params.get('project')) || projects.data?.[0]?.id
  const project = projects.data?.find((item) => item.id === projectId)
  const topics = useTopics()
  const categories = useCategories()

  const topic = params.get('topic') ?? ''
  const category = params.get('category') ?? ''
  const includeBlocked = params.get('blocked') === '1'
  const [search, setSearch] = useState(params.get('q') ?? '')
  const q = useDebounced(search.trim(), 450)

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (value) next.set(key, value)
          else next.delete(key)
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  useEffect(() => {
    if ((params.get('q') ?? '') !== q) setParam('q', q || null)
  }, [q, params, setParam])

  const recs = useRecommendations(projectId, { limit: 60, include_blocked: includeBlocked || undefined, topic: topic || undefined, category: category || undefined, q: q || undefined })
  const triageList = useTriageList(projectId)
  const requestedTriage = Number(params.get('triage')) || undefined
  const latestTriage: TriageSummary | undefined = triageList.data?.find((item) => item.id === requestedTriage) ?? triageList.data?.[0]
  const runningTriage = triageList.data?.find((item) => isTriageRunning(item.status))
  const [showProgress, setShowProgress] = useState(false)
  const progressTriageId = runningTriage?.id ?? (showProgress ? requestedTriage ?? latestTriage?.id : undefined)
  const pickTriage = latestTriage?.status === 'awaiting_pick' ? latestTriage : triageList.data?.find((item) => item.status === 'awaiting_pick')
  const pickTriageDetail = useTriage(pickTriage?.id)
  const shortlist = useMemo(() => new Set((pickTriageDetail.data?.shortlist ?? []).map((item) => item.claim_id)), [pickTriageDetail.data])

  const [scanOpen, setScanOpen] = useState(false)
  const [selected, setSelected] = useState<Map<number, Recommendation>>(new Map())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [force, setForce] = useState(false)
  const create = useCreateExperiments()

  useEffect(() => {
    setSelected(new Map())
  }, [projectId])

  const toggle = (item: Recommendation) => {
    setSelected((current) => {
      const next = new Map(current)
      if (next.has(item.claim_id)) next.delete(item.claim_id)
      else if (next.size < MAX_PICK) next.set(item.claim_id, item)
      return next
    })
  }

  const picks = [...selected.values()]
  const blockedPicks = picks.filter((item) => !item.testable_here || item.blockers.length > 0)

  const startExperiments = () => {
    if (!projectId) return
    create.mutate(
      { project_id: projectId, claim_ids: picks.map((item) => item.claim_id), triage_id: pickTriage?.id ?? null, force: blockedPicks.length > 0 && force },
      {
        onSuccess: (experiments) => {
          setConfirmOpen(false)
          setSelected(new Map())
          toast.success(`Created ${pluralize(experiments.length, 'experiment')}: ${experiments.map((e) => `#${e.id}`).join(', ')}. The planner is writing the spec (Gate 2 next).`)
          if (experiments.length === 1) navigate(`/experiments/${experiments[0].id}`)
          else navigate(`/experiments?tab=active&new=${experiments.map((e) => e.id).join(',')}`)
        },
      },
    )
  }

  const disabledReason = (item: Recommendation): string | null => {
    if (item.experiment_status && isActiveStatus(item.experiment_status)) return `Already being tested in experiment #${item.experiment_id}.`
    if (selected.size >= MAX_PICK) return `You can start at most ${MAX_PICK} experiments at once.`
    return null
  }

  if (projects.isLoading) return <Loading label="Loading projects…" />
  if (projects.isError) return <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
  if (!projects.data?.length) {
    return (
      <>
        <PageHeader title="Recommendations" />
        <EmptyState title="No target project registered" icon={<SparkIcon size={28} />} action={<Link to="/projects">Register a project</Link>}>
          Register the repository you want to improve (it needs a <code className="code-inline">lab.yaml</code>), then come back here.
        </EmptyState>
      </>
    )
  }

  return (
    <div className={cx(picks.length > 0 && 'pb-24')}>
      <PageHeader
        title="Recommendations"
        eyebrow="Gate 1 · pick what to test"
        description={
          <>
            Claim cards from recent papers, ranked for <strong className="text-fg">{project?.name}</strong>
            {project?.hardware && <> ({String(project.hardware.chip ?? '')})</>}. Select 1–2 to turn into experiments.
          </>
        }
        actions={
          <>
            <label htmlFor="project-select" className="sr-only">
              Project
            </label>
            <select id="project-select" className="input w-auto" value={projectId} onChange={(e) => setParam('project', e.target.value)}>
              {projects.data.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <Button onClick={() => setScanOpen(true)} icon={<RefreshIcon />} disabled={!!runningTriage}>
              {runningTriage ? 'Scan running…' : 'Run research scan'}
            </Button>
          </>
        }
      />

      <div className="space-y-3">
        {progressTriageId && (
          <TriageProgress
            triageId={progressTriageId}
            onReady={() => {
              toast.success('Research scan finished — recommendations refreshed')
            }}
          />
        )}
        {latestTriage && !runningTriage && (
          <TriageBanner triage={latestTriage} logOpen={showProgress} onToggleLog={() => setShowProgress((value) => !value)} />
        )}
      </div>

      <div className="mt-4 mb-4 grid gap-3 rounded-lg border border-line bg-canvas p-3 md:grid-cols-[1fr_auto_auto_auto] md:items-end">
        <div>
          <label htmlFor="rec-search" className="label">
            Search
          </label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle" />
            <input
              id="rec-search"
              type="search"
              className="input pl-8"
              placeholder="e.g. speculative decoding, KV cache quantization…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
        <div>
          <label htmlFor="rec-topic" className="label">
            Topic
          </label>
          <select id="rec-topic" className="input md:w-56" value={topic} onChange={(e) => setParam('topic', e.target.value || null)}>
            <option value="">All topics</option>
            {topics.data?.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.rank}. {item.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="rec-category" className="label">
            Category
          </label>
          <select id="rec-category" className="input md:w-48" value={category} onChange={(e) => setParam('category', e.target.value || null)}>
            <option value="">All categories</option>
            {categories.data?.map((item) => (
              <option key={item} value={item}>
                {humanize(item)}
              </option>
            ))}
          </select>
        </div>
        <div className="pb-1.5">
          <Checkbox id="rec-blocked" checked={includeBlocked} onChange={(checked) => setParam('blocked', checked ? '1' : null)} label="Include blocked" />
        </div>
      </div>

      {recs.isLoading ? (
        <Loading label={q ? 'Searching (hybrid full-text + vector)…' : 'Ranking claims…'} />
      ) : recs.isError ? (
        <ErrorState error={recs.error} onRetry={() => recs.refetch()} />
      ) : !recs.data?.length ? (
        <EmptyState title="No recommendations match" icon={<SparkIcon size={28} />} action={<Button onClick={() => setScanOpen(true)}>Run research scan</Button>}>
          {q || topic || category ? 'Try clearing the filters' : 'No claims have been matched to this project yet'}
          {!includeBlocked && ' or include blocked claims'}.
        </EmptyState>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between text-xs text-muted">
            <span>
              {pluralize(recs.data.length, 'claim')} {recs.isFetching && '· updating…'}
            </span>
            <span>Suggested: pick 1–2 (max {MAX_PICK})</span>
          </div>
          <div className="space-y-3">
            {recs.data.map((item) => (
              <RecommendationCard
                key={item.claim_id}
                item={item}
                selected={selected.has(item.claim_id)}
                disabledReason={disabledReason(item)}
                onToggle={() => toggle(item)}
                shortlisted={shortlist.has(item.claim_id)}
              />
            ))}
          </div>
        </>
      )}

      {picks.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-canvas/95 shadow-[0_-4px_12px_rgb(0_0_0/0.06)] backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
            <div className="min-w-0 flex-1 text-sm">
              <strong>{pluralize(picks.length, 'claim')} selected</strong>
              <span className="text-muted"> · {picks.map((item) => item.name).join(' · ')}</span>
              {picks.length > 2 && <div className="text-xs text-attention">Tip: 1–2 at a time keeps the GPU queue short.</div>}
            </div>
            <Button onClick={() => setSelected(new Map())}>Clear</Button>
            <Button variant="primary" icon={<SparkIcon />} onClick={() => { setForce(false); create.reset(); setConfirmOpen(true) }}>
              Start {pluralize(picks.length, 'experiment')}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={startExperiments}
        title={`Start ${pluralize(picks.length, 'experiment')}?`}
        confirmLabel="Start experiments"
        loading={create.isPending}
        error={create.error ? errorMessage(create.error) : null}
        confirmDisabled={blockedPicks.length > 0 && !force}
      >
        <p className="mb-3 text-muted">
          For each claim the planner writes an experiment spec for <strong className="text-fg">{project?.name}</strong>. Nothing is built until you
          approve the spec (Gate 2).
        </p>
        <ul className="mb-3 space-y-2">
          {picks.map((item) => (
            <li key={item.claim_id} className="rounded-md border border-line-muted px-3 py-2">
              <div className="font-medium">{item.name}</div>
              <div className="text-xs">
                <ClaimedEffect claim={item} />
              </div>
              {item.blockers.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {item.blockers.map((blocker) => (
                    <BlockerBadge key={blocker} blocker={blocker} />
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
        {pickTriage && <p className="mb-3 text-xs text-muted">Linked to research scan #{pickTriage.id}.</p>}
        {blockedPicks.length > 0 && (
          <div className="rounded-md border border-attention-emphasis/40 bg-attention-subtle p-3">
            <Checkbox
              id="force-blocked"
              checked={force}
              onChange={setForce}
              label={`Start anyway — ${pluralize(blockedPicks.length, 'claim')} marked as blocked on this project`}
              description="The matcher thinks these cannot be tested here; the experiment will likely fail."
            />
          </div>
        )}
      </ConfirmDialog>

      {projectId && (
        <ScanDialog
          open={scanOpen}
          onClose={() => setScanOpen(false)}
          projectId={projectId}
          onStarted={(id) => {
            setShowProgress(true)
            setParam('triage', String(id))
          }}
        />
      )}
    </div>
  )
}
