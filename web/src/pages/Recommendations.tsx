import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ApiError } from '../api/client'
import { keys, useCategories, useCreateExperiments, useProjects, useRecommendations, useStartTriage, useTopics, useTriage, useTriageList } from '../api/queries'
import { mergeEvents, useEventStream } from '../api/sse'
import type { ExperimentMode, LabEvent, Project, Recommendation, TriageOptions, TriageStatus, TriageSummary } from '../api/types'
import { api } from '../api/client'
import { BlockerBadge, CategoryChip, DocTypeChip, LiveDot, StatusChip } from '../components/Badges'
import { ClaimCardDetails, ClaimedEffect, Requirements } from '../components/ClaimCard'
import { ClaimDiagram, ClaimExplainDetails, ClaimLead, GenerateClaimExplainer, GlanceStrip } from '../components/Explainers'
import { ConfirmDialog, Modal } from '../components/Dialog'
import { ConceptRef, RelatedStrip } from '../components/Related'
import { EventTimeline } from '../components/EventTimeline'
import { ChevronDown, ChevronRight, RefreshIcon, SearchIcon, SparkIcon } from '../components/Icons'
import { Meter } from '../components/Charts'
import { PredictionChip, PredictionRow } from '../components/Prediction'
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
import { LIKELIHOOD_INFO, LIKELIHOODS, likelihoodOf, sortByPrediction } from '../lib/roofline'
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
    if (start.isPending) return
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
      dismissable={!start.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={start.isPending}>
            Cancel
          </Button>
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

function RecommendationCard({ item, selected, disabledReason, onToggle, shortlisted, project }: {
  item: Recommendation
  selected: boolean
  disabledReason: string | null
  onToggle: () => void
  shortlisted: boolean
  project?: Project
}) {
  const [open, setOpen] = useState<'explain' | 'card' | null>(null)
  const blocked = !item.testable_here || item.blockers.length > 0
  const checkboxId = `pick-${item.claim_id}`
  const explainer = item.explainer
  const toggle = (panel: 'explain' | 'card') => setOpen((current) => (current === panel ? null : panel))
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
          <div className="min-w-0">
            <h3 id={`rec-title-${item.claim_id}`} className="text-base leading-snug font-semibold">
              <label htmlFor={checkboxId} className="cursor-pointer">
                {item.name}
              </label>
            </h3>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
              <DocTypeChip docType={item.paper_doc_type} />
              <PaperLink paperId={item.paper_id} title={item.paper_title ?? item.paper_id} className="min-w-0 text-muted hover:text-accent" />
              {item.paper_date && <span>· {item.paper_date.slice(0, 7)}</span>}
              {item.paper_url && (
                <>
                  <span>·</span>
                  <ExternalLink href={item.paper_url} className="text-muted">
                    source
                  </ExternalLink>
                </>
              )}
            </div>
            <ClaimLead claim={item} explainer={explainer} />
          </div>

          <div className="mt-3">
            <GlanceStrip claim={item} explainer={explainer} project={project} fit={item.fit} blockers={item.blockers} />
          </div>

          <PredictionRow prediction={item.prediction} className="mt-3" />

          <RelatedStrip related={item.related} claimId={item.claim_id} paperId={item.paper_id} className="mt-3" />

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <CategoryChip category={item.category} />
            {item.topics.map((topic) => (
              <Link key={topic.slug} to={`/research/topics/${topic.slug}`} className="chip border-line bg-canvas text-muted hover:border-accent hover:text-accent hover:no-underline">
                {topic.name}
              </Link>
            ))}
            {shortlisted && <Chip tone="accent">shortlisted</Chip>}
            {item.blockers.map((blocker) => (
              <BlockerBadge key={blocker} blocker={blocker} />
            ))}
            <Requirements claim={item} />
          </div>

          <ClaimDiagram diagram={explainer?.diagram} className="mt-3" />

          {item.rationale && (
            <p className="mt-3 rounded-md bg-canvas-subtle px-3 py-2 text-sm text-fg">
              <span className="mr-1 inline-flex items-center gap-1 text-xs font-semibold text-done">
                <SparkIcon size={12} /> Why for this project:
              </span>
              {item.rationale}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <div className="w-20">
                <Meter value={Math.min(item.score, 1)} label={`Match score ${formatScore(item.score)}`} tone="done" />
              </div>
              <span title="score = fit × (0.4 + gain) ÷ effort cost · gain and effort are shown above">
                score <strong className="text-fg tabular-nums">{formatScore(item.score)}</strong>
              </span>
              {item.target_metric && (
                <span>
                  measured as <code className="code-inline">{item.target_metric}</code>
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {item.experiment_id && item.experiment_status && (
                <Link to={`/experiments/${item.experiment_id}`} className="mr-1 inline-flex items-center gap-1.5 text-xs hover:no-underline">
                  Experiment #{item.experiment_id} <StatusChip status={item.experiment_status} />
                </Link>
              )}
              {explainer ? (
                <Button size="sm" variant="invisible" onClick={() => toggle('explain')} aria-expanded={open === 'explain'} icon={<SparkIcon size={14} />}>
                  {open === 'explain' ? 'Hide explanation' : 'Explain'}
                </Button>
              ) : (
                <GenerateClaimExplainer claimId={item.claim_id} projectId={item.project_id} />
              )}
              <Button size="sm" variant="invisible" onClick={() => toggle('card')} aria-expanded={open === 'card'} icon={open === 'card' ? <ChevronDown /> : <ChevronRight />}>
                Claim card
              </Button>
            </div>
          </div>
          {disabledReason && !selected && (
            <p id={`${checkboxId}-reason`} className="mt-2 text-xs text-muted">
              {disabledReason}
            </p>
          )}
          {open === 'explain' && explainer && (
            <div className="mt-3 border-t border-line-muted pt-4">
              <ClaimExplainDetails explainer={explainer} projectName={project?.name} showDiagram={false} />
            </div>
          )}
          {open === 'card' && (
            <div className="mt-3 border-t border-line-muted pt-3">
              <ClaimCardDetails claim={item} showPaper={false} />
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

// ---- Gate 1: how to handle prerequisites ------------------------------------------------------

const MODE_OPTIONS: { value: ExperimentMode; label: string; describe: (picks: Recommendation[]) => string }[] = [
  {
    value: 'single',
    label: 'Test only this claim',
    describe: (picks) =>
      `${picks.length > 1 ? 'One experiment per selected claim' : 'One experiment'}; prerequisites are not added, so the result may understate the paper.`,
  },
  {
    value: 'bundle',
    label: 'Bundle with prerequisites',
    describe: (picks) =>
      `One experiment implements “${picks[0]?.name ?? ''}” together with its prerequisites${picks.length > 1 ? ' and the other selected claims' : ''} behind one flag.`,
  },
  {
    value: 'chain',
    label: 'Chain: prerequisites first',
    describe: () =>
      'One experiment per testable prerequisite, in order; each next one starts when the previous is merged and keeps its flag on in the baseline.',
  },
]

/**
 * Experiments a Gate 1 mode creates. A chain adds one per testable prerequisite that is not picked and has no
 * merged or running experiment yet (those are reused); untestable prerequisites are folded into the dependent.
 */
function plannedCount(mode: ExperimentMode, picks: Recommendation[], lookup: Map<number, Recommendation>): number {
  if (mode === 'bundle') return 1
  if (mode === 'single') return picks.length
  const picked = new Set(picks.map((item) => item.claim_id))
  const prerequisites = new Set<number>()
  for (const item of picks)
    for (const node of item.related?.prerequisites ?? []) {
      if (!node.claim_id || !node.testable_here || picked.has(node.claim_id)) continue
      const status = lookup.get(node.claim_id)?.experiment_status
      if (status && (status === 'merged' || isActiveStatus(status))) continue
      prerequisites.add(node.claim_id)
    }
  return picks.length + prerequisites.size
}

function PrerequisitesChoice({ picks, mode, onChange, lookup }: {
  picks: Recommendation[]
  mode: ExperimentMode
  onChange: (mode: ExperimentMode) => void
  lookup: Map<number, Recommendation>
}) {
  const withPrerequisites = picks.filter((item) => (item.related?.prerequisites?.length ?? 0) > 0)
  if (!withPrerequisites.length) return null
  return (
    <section className="mb-3 rounded-md border border-accent/30 bg-accent-subtle/30 p-3">
      <h3 className="text-sm font-semibold">Builds on other concepts from the same paper</h3>
      <ul className="mt-1.5 space-y-1.5">
        {withPrerequisites.map((item) => (
          <li key={item.claim_id} className="text-xs">
            <span className="font-medium text-fg">{item.name}</span> <span className="text-muted">needs first:</span>
            <ol className="mt-1 flex flex-wrap items-center gap-1.5">
              {item.related!.prerequisites.map((node) => {
                const existing = node.claim_id ? lookup.get(node.claim_id) : undefined
                return (
                  <li key={node.concept_id} className="flex min-w-0 flex-wrap items-center gap-1">
                    <ConceptRef node={node} max={34} />
                    <span className={node.testable_here ? 'text-success' : 'text-muted'}>{node.testable_here ? 'testable here' : 'not testable here'}</span>
                    {existing?.experiment_id && existing.experiment_status && (
                      <>
                        <span className="text-subtle">·</span>
                        <Link to={`/experiments/${existing.experiment_id}`} className="inline-flex items-center gap-1">
                          experiment #{existing.experiment_id} <StatusChip status={existing.experiment_status} />
                        </Link>
                      </>
                    )}
                  </li>
                )
              })}
            </ol>
          </li>
        ))}
      </ul>
      <fieldset className="mt-3">
        <legend className="mb-1.5 text-xs font-semibold text-muted">How should the experiment handle them?</legend>
        <div className="space-y-1.5">
          {MODE_OPTIONS.map((option) => {
            const count = plannedCount(option.value, picks, lookup)
            return (
              <label
                key={option.value}
                className={cx(
                  'flex cursor-pointer gap-2.5 rounded-md border bg-canvas px-3 py-2',
                  mode === option.value ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-subtle',
                )}
              >
                <input type="radio" name="gate1-mode" value={option.value} checked={mode === option.value} onChange={() => onChange(option.value)} className="mt-0.5 accent-accent" />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                    {option.label}
                    <span className="text-xs font-normal text-muted">
                      {option.value === 'chain' ? '≈ ' : ''}
                      {pluralize(count, 'experiment')}
                    </span>
                  </span>
                  <span className="block text-xs text-muted">{option.describe(picks)}</span>
                </span>
              </label>
            )
          })}
        </div>
        {withPrerequisites.some((item) => item.related!.prerequisites.some((node) => !node.testable_here)) && (
          <p className="mt-2 text-xs text-muted">
            In bundle and chain modes, prerequisites that cannot be tested here on their own are implemented inside the experiment that needs them.
          </p>
        )}
      </fieldset>
    </section>
  )
}

// ---- page -----------------------------------------------------------------------------------

export default function Recommendations() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const projects = useProjects()
  // A scan link (?triage=) decides the project: scan ids are global and links may omit ?project.
  const requestedTriage = Number(params.get('triage')) || undefined
  const requested = useTriage(requestedTriage)
  const requestedMissing = requested.isError
  const waitingForTriage = !!requestedTriage && requested.isLoading
  const projectId = requested.data?.project_id ?? (Number(params.get('project')) || (waitingForTriage ? undefined : projects.data?.[0]?.id))
  const project = projects.data?.find((item) => item.id === projectId)
  const topics = useTopics()
  const categories = useCategories()

  const topic = params.get('topic') ?? ''
  const category = params.get('category') ?? ''
  const includeBlocked = params.get('blocked') === '1'
  const predicted = params.get('pred') ?? ''
  const sortByPredicted = params.get('sort') === 'predicted'
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
  const requestedSummary: TriageSummary | undefined = requested.data && {
    id: requested.data.id,
    project_id: requested.data.project_id,
    status: requested.data.status,
    options: requested.data.options,
    shortlist_size: requested.data.shortlist.length,
    created_at: requested.data.created_at,
    updated_at: requested.data.updated_at,
  }
  // Never substitute another scan for a requested one: a missing scan gets a not-found banner instead.
  const latestTriage: TriageSummary | undefined = requestedTriage
    ? (triageList.data?.find((item) => item.id === requestedTriage) ?? requestedSummary)
    : triageList.data?.[0]
  const runningTriage = triageList.data?.find((item) => isTriageRunning(item.status))
  const [showProgress, setShowProgress] = useState(false)
  const progressTriageId = runningTriage?.id ?? (showProgress ? latestTriage?.id : undefined)
  const pickTriage = latestTriage?.status === 'awaiting_pick' ? latestTriage : triageList.data?.find((item) => item.status === 'awaiting_pick')
  const pickTriageDetail = useTriage(pickTriage?.id)
  const shortlist = useMemo(() => new Set((pickTriageDetail.data?.shortlist ?? []).map((item) => item.claim_id)), [pickTriageDetail.data])

  const [scanOpen, setScanOpen] = useState(false)
  const [selected, setSelected] = useState<Map<number, Recommendation>>(new Map())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [force, setForce] = useState(false)
  const [mode, setMode] = useState<ExperimentMode>('single')
  const create = useCreateExperiments()
  const lookup = useMemo(() => new Map((recs.data ?? []).map((item) => [item.claim_id, item])), [recs.data])
  // Likelihood filter and order are client-side: the cost model's prediction rides along with each recommendation.
  const shown = useMemo(() => {
    const items = (recs.data ?? []).filter((item) => !predicted || likelihoodOf(item.prediction) === predicted)
    return sortByPredicted ? sortByPrediction(items) : items
  }, [recs.data, predicted, sortByPredicted])

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

  // Selections never carry over to another project (they would be submitted with this project's id).
  const picks = [...selected.values()].filter((item) => item.project_id === projectId)
  const blockedPicks = picks.filter((item) => !item.testable_here || item.blockers.length > 0)
  const hasPrerequisites = picks.some((item) => (item.related?.prerequisites?.length ?? 0) > 0)
  const effectiveMode: ExperimentMode = hasPrerequisites ? mode : 'single'

  const startExperiments = () => {
    if (!projectId || !picks.length || create.isPending) return
    create.mutate(
      {
        project_id: projectId,
        claim_ids: picks.map((item) => item.claim_id),
        triage_id: pickTriage?.id ?? null,
        force: blockedPicks.length > 0 && force,
        mode: effectiveMode,
      },
      {
        onSuccess: (experiments) => {
          setConfirmOpen(false)
          setSelected(new Map())
          const waiting = experiments.filter((e) => e.status === 'blocked').length
          toast.success(
            `Created ${pluralize(experiments.length, 'experiment')}: ${experiments.map((e) => `#${e.id}`).join(', ')}. ` +
              (waiting
                ? `${pluralize(waiting, 'experiment')} ${waiting === 1 ? 'waits for its prerequisite' : 'wait for their prerequisites'} to be merged.`
                : 'The planner is writing the spec (Gate 2 next).'),
          )
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
  if (waitingForTriage) return <Loading label={`Loading research scan #${requestedTriage}…`} />
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
            <select
              id="project-select"
              className="input w-auto"
              value={projectId}
              onChange={(e) => {
                const value = e.target.value
                setParams(
                  (current) => {
                    const next = new URLSearchParams(current)
                    next.set('project', value)
                    next.delete('triage')
                    return next
                  },
                  { replace: true },
                )
              }}
            >
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
        {requestedMissing && (
          <Banner
            tone="danger"
            action={
              <Button size="sm" variant="invisible" onClick={() => setParam('triage', null)}>
                Show latest scan
              </Button>
            }
          >
            {requested.error instanceof ApiError && requested.error.status === 404 ? (
              <>
                <strong>Research scan #{requestedTriage} was not found.</strong> It may have been deleted.
              </>
            ) : (
              <>
                <strong>Research scan #{requestedTriage} could not be loaded:</strong> {errorMessage(requested.error)}
              </>
            )}
          </Banner>
        )}
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
          {project && !project.roofline && (
            <div className="mb-3">
              <Banner tone="muted" action={<Link to={`/projects?project=${project.id}`} className="text-sm">Measure roofline</Link>}>
                <strong>Predictions are unknown</strong> until the engine’s roofline is measured — the cost model needs it to estimate each claim’s gain here.
              </Banner>
            </div>
          )}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted">
            <span>
              {predicted ? `${pluralize(shown.length, 'claim')} of ${recs.data.length}` : pluralize(recs.data.length, 'claim')} {recs.isFetching && '· updating…'}
              <span className="hidden sm:inline"> · suggested: pick 1–2 (max {MAX_PICK})</span>
            </span>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="inline-flex items-center gap-1.5">
              <label htmlFor="rec-predicted">Predicted</label>
              <select id="rec-predicted" className="input h-7 w-auto py-0 text-xs" value={predicted} onChange={(e) => setParam('pred', e.target.value || null)}>
                <option value="">any likelihood</option>
                {LIKELIHOODS.map((value) => (
                  <option key={value} value={value}>
                    {LIKELIHOOD_INFO[value].label}
                  </option>
                ))}
              </select>
              </span>
              <span className="inline-flex items-center gap-1.5">
              <label htmlFor="rec-sort">Sort</label>
              <select id="rec-sort" className="input h-7 w-auto py-0 text-xs" value={sortByPredicted ? 'predicted' : ''} onChange={(e) => setParam('sort', e.target.value || null)}>
                <option value="">match score</option>
                <option value="predicted">predicted gain here</option>
              </select>
              </span>
            </div>
          </div>
          {!shown.length && (
            <EmptyState title={`No claims predicted ${LIKELIHOOD_INFO[likelihoodOf({ likelihood: predicted, predicted_gain_pct: null })].label}`} icon={<SparkIcon size={28} />} action={<Button onClick={() => setParam('pred', null)}>Show all predictions</Button>}>
              {predicted === 'unlikely' && !includeBlocked
                ? 'Claims the cost model calls unlikely are blocked — tick “Include blocked” to see them.'
                : 'Try another likelihood or include blocked claims.'}
            </EmptyState>
          )}
          <div className="space-y-3">
            {shown.map((item) => (
              <RecommendationCard
                key={item.claim_id}
                item={item}
                selected={selected.has(item.claim_id)}
                disabledReason={disabledReason(item)}
                onToggle={() => toggle(item)}
                shortlisted={shortlist.has(item.claim_id)}
                project={project}
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
            <Button
              variant="primary"
              icon={<SparkIcon />}
              disabled={create.isPending}
              onClick={() => {
                // Never reset (and so re-enable) a Gate 1 submit that is still in flight.
                if (create.isPending) return
                setForce(false)
                setMode('single')
                create.reset()
                setConfirmOpen(true)
              }}
            >
              Start {pluralize(picks.length, 'experiment')}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={startExperiments}
        title={`Start ${pluralize(plannedCount(effectiveMode, picks, lookup), 'experiment')}?`}
        confirmLabel={effectiveMode === 'single' ? 'Start experiments' : effectiveMode === 'bundle' ? 'Start bundled experiment' : 'Start chain'}
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
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <ClaimedEffect claim={item} />
                <PredictionChip prediction={item.prediction} />
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
        <PrerequisitesChoice picks={picks} mode={mode} onChange={setMode} lookup={lookup} />
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
