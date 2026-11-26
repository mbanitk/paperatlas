import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ApiError } from '../api/client'
import { keys, useCategories, useCreateExperiments, useProjectAssets, useProjects, useRecommendations, useStartTriage, useTopics, useTriage, useTriageList } from '../api/queries'
import { mergeEvents, useEventStream } from '../api/sse'
import type { ExperimentMode, LabEvent, Project, Recommendation, TriageOptions, TriageStatus, TriageSummary } from '../api/types'
import { api } from '../api/client'
import { AssetNeedsList, NeedsAssetsNote } from '../components/Assets'
import { BlockerBadge, LiveDot, MetricName, StatusChip, Tag } from '../components/Badges'
import { ClaimedEffect } from '../components/ClaimCard'
import { ClaimEyebrow, ClaimSummary } from '../components/ClaimStory'
import { StickyActionBar } from '../components/ActionBar'
import { ConfirmDialog, Modal } from '../components/Dialog'
import { ConceptRef } from '../components/Related'
import { EventTimeline } from '../components/EventTimeline'
import { CheckIcon, ChevronDown, RefreshIcon, SearchIcon, SparkIcon, XIcon } from '../components/Icons'
import { PredictionChip } from '../components/Prediction'
import { InfoPopover } from '../components/Tooltip'
import { useToast } from '../components/Toast'
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  InlineError,
  Loading,
  MathText,
  PageHeader,
  RelativeTime,
  cx,
  errorMessage,
  useDebounced,
} from '../components/ui'
import { blockedOnlyByAssets, missingAssets } from '../lib/assets'
import { experimentVerb, gateOneAnswer, matchScoreExplanation } from '../lib/claims'
import { formatAcronyms, humanize, pluralize, sanitizeText } from '../lib/format'
import { LIKELIHOOD_INFO, LIKELIHOODS, likelihoodOf, sortByPrediction } from '../lib/roofline'
import { sentenceCase } from '../lib/semantics'
import { isActiveStatus, isTriageRunning, TRIAGE_STATUS_LABEL, TRIAGE_STEPS, triageStepState } from '../lib/stages'

const MAX_PICK = 5
/** Cards shown before "Show more": keeps Gate 1 a scannable list. */
const PAGE = 30

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
        Finds recent papers and patents on the trending topics, summarises them into claim cards and re-ranks them for this project. It ends here
        at Gate 1 with a fresh shortlist. It runs on the worker and takes several minutes; you can leave this page.
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
          <Field label="Papers per topic" htmlFor="scan-per-topic" hint="1 to 50. Leave blank for the configured default.">
            <input id="scan-per-topic" className="input" type="number" min={1} max={50} value={perTopic} onChange={(e) => setPerTopic(e.target.value)} placeholder="default" />
          </Field>
          <Field label="Max papers to summarise" htmlFor="scan-distill" hint="1 to 500">
            <input id="scan-distill" className="input" type="number" min={1} max={500} value={distillLimit} onChange={(e) => setDistillLimit(e.target.value)} />
          </Field>
        </div>
        <Checkbox
          id="scan-llm"
          checked={useLlm}
          onChange={setUseLlm}
          label="Write summaries with the LLM"
          description="Uncheck to use keyword heuristics instead (no API key needed)."
        />
      </div>
      {start.error instanceof ApiError && start.error.status === 409 ? (
        <Banner tone="caution">{start.error.message}</Banner>
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
          <Chip tone={data.status === 'failed' ? 'negative' : running ? 'info' : 'neutral'}>{TRIAGE_STATUS_LABEL[data.status] ?? sentenceCase(humanize(data.status))}</Chip>
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
                state === 'done' && 'border-line bg-canvas text-fg',
                state === 'active' && 'border-info/40 bg-info-subtle font-semibold text-info-fg',
                state === 'failed' && 'border-negative/30 bg-negative-subtle text-negative-fg',
                state === 'pending' && 'border-line-muted bg-canvas-subtle text-muted',
              )}
            >
              <span className="flex items-center gap-1">
                {state === 'done' && <CheckIcon size={12} className="shrink-0" />}
                {step.label}
              </span>
              <span className="block text-xs font-normal text-muted">{state === 'active' ? 'Running…' : state === 'done' ? 'Done' : state === 'failed' ? 'Failed' : 'Waiting'}</span>
            </li>
          )
        })}
      </ol>
      {data.status === 'queued' && (
        <p className="mb-2 text-xs text-muted">
          Queued. It starts when a worker picks it up (<code className="code-inline">paperatlas services up</code> runs one).
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
        Pick 1–2 claims below; new experiments are linked to this scan.
      </Banner>
    )
  }
  if (triage.status === 'failed') {
    return (
      <Banner
        tone="negative"
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

/**
 * Compact Gate 1 card (§3.4): what it is, what we expect here vs what the paper reports, effort and risk;
 * Explain and Evidence open the rest. Selecting it adds it to the pick bar.
 */
function RecommendationCard({ item, selected, maxReached, onToggle, shortlisted, project }: {
  item: Recommendation
  selected: boolean
  /** The pick limit is reached, so unselected cards can't be added. */
  maxReached: boolean
  onToggle: () => void
  shortlisted: boolean
  project?: Project
}) {
  const blocked = !item.testable_here || item.blockers.length > 0
  const missing = missingAssets(item)
  const checkboxId = `pick-${item.claim_id}`
  const experimentId = `${checkboxId}-experiment`
  const reasonId = `${checkboxId}-reason`
  const active = !!item.experiment_status && isActiveStatus(item.experiment_status)
  const disabled = !selected && (active || maxReached)
  const explainer = item.explainer
  return (
    <ClaimSummary
      claim={item}
      explainer={explainer}
      project={project}
      prediction={item.prediction ?? null}
      fit={item.fit}
      blockers={item.blockers}
      selected={selected}
      muted={blocked && !selected}
      titleId={`rec-title-${item.claim_id}`}
      leading={
        <input
          id={checkboxId}
          type="checkbox"
          className="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={onToggle}
          aria-describedby={disabled ? (active ? experimentId : reasonId) : undefined}
          aria-label={`Select for testing: ${sanitizeText(item.name)}`}
        />
      }
      title={
        <label htmlFor={checkboxId} className={cx(disabled ? 'cursor-default' : 'cursor-pointer')}>
          <MathText>{item.name}</MathText>
        </label>
      }
      eyebrow={<ClaimEyebrow claim={item} explainer={explainer} prefix={`#${item.rank}`} />}
      status={
        <>
          {selected && (
            <Chip tone="info">
              <CheckIcon size={12} className="shrink-0" /> Selected
            </Chip>
          )}
          {shortlisted && <Tag title="On the latest research scan’s shortlist">Shortlisted</Tag>}
          {item.blockers.map((blocker) => (
            <BlockerBadge key={blocker} blocker={blocker} />
          ))}
        </>
      }
      note={item.rationale ? `Why here: ${sanitizeText(item.rationale)}` : undefined}
      notice={missing.length > 0 && <NeedsAssetsNote missing={missing} project={project?.name} />}
      footer={
        <>
          <span className="hidden items-center sm:inline-flex">
            Match <strong className="ml-1 font-semibold text-fg tabular-nums">{item.score.toFixed(2)}</strong>
            <InfoPopover title="Match score" label="About the match score" content={matchScoreExplanation(item)} />
          </span>
          {item.experiment_id && item.experiment_status && (
            <Link id={experimentId} to={`/experiments/${item.experiment_id}`} className="inline-flex min-h-6 items-center gap-1.5 text-fg hover:no-underline">
              <span className="underline-offset-2 hover:underline">
                <span className="hidden sm:inline">{experimentVerb(item.experiment_status)} </span>
                <span className="sr-text sm:hidden">{experimentVerb(item.experiment_status)} experiment </span>#{item.experiment_id}
              </span>
              <StatusChip status={item.experiment_status} short className="sm:hidden" />
              <StatusChip status={item.experiment_status} className="max-sm:hidden" />
            </Link>
          )}
          {maxReached && !selected && !active && (
            <span id={reasonId} className="text-muted">
              Limit of {MAX_PICK} reached
            </span>
          )}
        </>
      }
      evidence={
        <>
          {item.asset_check && (
            <section aria-label="What it needs">
              <h4 className="mb-1 text-sm font-semibold text-fg">What it needs</h4>
              <AssetNeedsList check={item.asset_check} project={project?.name} />
            </section>
          )}
          {item.rationale && (
            <section aria-label="Why it suits this project">
              <h4 className="mb-1 text-sm font-semibold text-fg">Why it suits {project?.name ?? 'this project'}</h4>
              <p className="max-w-[75ch] text-fg">{sanitizeText(item.rationale)}</p>
            </section>
          )}
          <section aria-label="Match score">
            <h4 className="mb-1 text-sm font-semibold text-fg">
              Match score <span className="font-normal text-muted tabular-nums">{item.score.toFixed(2)}</span>
            </h4>
            <p className="max-w-[75ch] text-muted">{matchScoreExplanation(item)}</p>
            {item.target_metric && (
              <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-muted">
                The experiment would measure <MetricName metric={item.target_metric} showId className="text-fg" />
              </p>
            )}
          </section>
          {item.topics.length > 0 && (
            <section aria-label="Topics" className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">Topics:</span>
              {item.topics.map((topic) => (
                <Tag key={topic.slug} to={`/research/topics/${topic.slug}`}>
                  {formatAcronyms(topic.name)}
                </Tag>
              ))}
            </section>
          )}
        </>
      }
    />
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
    <section className="mb-3 rounded-lg border border-line bg-canvas-subtle p-3">
      <h3 className="text-sm font-semibold">Builds on other concepts from the same paper</h3>
      <ul className="mt-1.5 space-y-1.5">
        {withPrerequisites.map((item) => (
          <li key={item.claim_id} className="text-xs">
            <span className="font-medium text-fg">
              <MathText>{item.name}</MathText>
            </span>{' '}
            <span className="text-muted">needs first:</span>
            <ol className="mt-1 flex flex-wrap items-center gap-1.5">
              {item.related!.prerequisites.map((node) => {
                const existing = node.claim_id ? lookup.get(node.claim_id) : undefined
                return (
                  <li key={node.concept_id} className="flex min-w-0 flex-wrap items-center gap-1">
                    <ConceptRef node={node} max={34} />
                    <span className={node.testable_here ? 'text-fg' : 'text-muted'}>{node.testable_here ? 'Testable here' : 'Not testable here'}</span>
                    {existing?.experiment_id && existing.experiment_status && (
                      <>
                        <span className="text-muted" aria-hidden="true">·</span>
                        <Link to={`/experiments/${existing.experiment_id}`} className="inline-flex items-center gap-1">
                          {experimentVerb(existing.experiment_status)} #{existing.experiment_id} <StatusChip status={existing.experiment_status} />
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
                  mode === option.value ? 'border-info ring-1 ring-info/40' : 'border-line hover:border-muted',
                )}
              >
                <input type="radio" name="gate1-mode" value={option.value} checked={mode === option.value} onChange={() => onChange(option.value)} className="mt-0.5 size-4 shrink-0 accent-accent" />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                    {option.label}
                    <span className="text-xs font-normal text-muted">
                      {option.value === 'chain' ? 'about ' : ''}
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
  const includeAssets = params.get('assets') === '1'
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

  const recs = useRecommendations(projectId, {
    // Held-back claims are interleaved with the testable ones: fetch enough that every testable claim is still listed.
    limit: includeAssets && !includeBlocked ? 200 : 60,
    include_blocked: includeBlocked || undefined,
    include_needs_assets: (includeAssets && !includeBlocked) || undefined,
    topic: topic || undefined,
    category: category || undefined,
    q: q || undefined,
  })
  const assets = useProjectAssets(projectId)
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
  const assetOnlyPicks = blockedPicks.filter((item) => blockedOnlyByAssets(item))
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

  const [filtersOpen, setFiltersOpen] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  useEffect(() => {
    setLimit(PAGE)
  }, [projectId, q, topic, category, includeBlocked, includeAssets, predicted, sortByPredicted])
  const topicName = topics.data?.find((item) => item.slug === topic)?.name
  const activeFilters: { key: string; label: string }[] = [
    topic ? { key: 'topic', label: `Topic: ${formatAcronyms(topicName ?? topic)}` } : null,
    category ? { key: 'category', label: `Category: ${sentenceCase(formatAcronyms(humanize(category)))}` } : null,
    predicted ? { key: 'pred', label: `Expected: ${LIKELIHOOD_INFO[likelihoodOf({ likelihood: predicted, predicted_gain_pct: null })].label}` } : null,
    includeAssets && !includeBlocked ? { key: 'assets', label: 'Including needs assets' } : null,
    includeBlocked ? { key: 'blocked', label: 'Including blocked' } : null,
    sortByPredicted ? { key: 'sort', label: 'Sorted by expected gain' } : null,
  ].filter((item): item is { key: string; label: string } => !!item)
  const chip = project?.hardware?.chip ? String(project.hardware.chip) : null
  // The headline counts claims testable here, also when blocked or needs-assets ones are listed.
  const testable = (recs.data ?? []).filter((item) => item.testable_here)
  const likelyCount = testable.filter((item) => likelihoodOf(item.prediction) === 'likely').length
  const answer = recs.data
    ? gateOneAnswer({ total: testable.length, likely: likelyCount, project: project?.name, chip, estimated: !!project?.roofline || likelyCount > 0 })
    : null

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
    <div>
      <PageHeader
        title="Recommendations"
        eyebrow="Gate 1 · Pick claims to test"
        answer={answer && <>{answer} Pick 1–2 to test.</>}
        description={
          <span className="max-sm:hidden">
            Claims from recent papers, ranked by how well they suit <strong className="font-semibold text-fg">{project?.name}</strong>. Nothing is built until you
            approve the test plan (Gate 2).
          </span>
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
              {runningTriage ? 'Scan running…' : 'Run research scan…'}
            </Button>
          </>
        }
      />

      <div className="space-y-3">
        {requestedMissing && (
          <Banner
            tone="negative"
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
              toast.success('Research scan finished. Recommendations refreshed.')
            }}
          />
        )}
        {latestTriage && !runningTriage && (
          <TriageBanner triage={latestTriage} logOpen={showProgress} onToggleLog={() => setShowProgress((value) => !value)} />
        )}
      </div>

      <section aria-label="Filters" className="mt-4 mb-3 rounded-lg border border-line bg-canvas p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-56">
            <label htmlFor="rec-search" className="label">
              Search
            </label>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
              <input
                id="rec-search"
                type="search"
                className="input pl-8"
                placeholder="e.g. speculative decoding, KV cache"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          <Button
            className="md:hidden"
            onClick={() => setFiltersOpen((value) => !value)}
            aria-expanded={filtersOpen}
            aria-controls="rec-filters"
            icon={<ChevronDown size={14} className={cx('transition-transform', filtersOpen && 'rotate-180')} />}
          >
            Filters{activeFilters.length > 0 && <span className="tabular-nums"> ({activeFilters.length})</span>}
          </Button>
          <div id="rec-filters" className={cx('w-full flex-wrap items-end gap-3 md:flex md:w-auto', filtersOpen ? 'grid grid-cols-1 sm:grid-cols-2' : 'hidden')}>
            <div>
              <label htmlFor="rec-topic" className="label">
                Topic
              </label>
              <select id="rec-topic" className="input md:w-52" value={topic} onChange={(e) => setParam('topic', e.target.value || null)}>
                <option value="">All topics</option>
                {topics.data?.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.rank}. {formatAcronyms(item.name)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="rec-category" className="label">
                Category
              </label>
              <select id="rec-category" className="input md:w-44" value={category} onChange={(e) => setParam('category', e.target.value || null)}>
                <option value="">All categories</option>
                {categories.data?.map((item) => (
                  <option key={item} value={item}>
                    {sentenceCase(formatAcronyms(humanize(item)))}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="rec-predicted" className="label">
                Expected here
              </label>
              <select id="rec-predicted" className="input md:w-40" value={predicted} onChange={(e) => setParam('pred', e.target.value || null)}>
                <option value="">Any estimate</option>
                {LIKELIHOODS.map((value) => (
                  <option key={value} value={value}>
                    {LIKELIHOOD_INFO[value].label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="rec-sort" className="label">
                Sort by
              </label>
              <select id="rec-sort" className="input md:w-44" value={sortByPredicted ? 'predicted' : ''} onChange={(e) => setParam('sort', e.target.value || null)}>
                <option value="">Match score</option>
                <option value="predicted">Expected gain here</option>
              </select>
            </div>
            <div className="pb-1">
              <Checkbox
                id="rec-assets"
                checked={includeAssets || includeBlocked}
                disabled={includeBlocked}
                onChange={(checked) => setParam('assets', checked ? '1' : null)}
                label="Include needs assets"
              />
            </div>
            <div className="pb-1">
              <Checkbox id="rec-blocked" checked={includeBlocked} onChange={(checked) => setParam('blocked', checked ? '1' : null)} label="Include blocked" />
            </div>
          </div>
        </div>
        {activeFilters.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">Active:</span>
            {activeFilters.map((filter) => (
              <button
                key={filter.key}
                type="button"
                className="tag min-h-6 text-fg hover:border-fg"
                onClick={() => setParam(filter.key, null)}
                aria-label={`Remove filter: ${filter.label}`}
              >
                {filter.label}
                <XIcon size={12} className="shrink-0" />
              </button>
            ))}
          </div>
        )}
      </section>

      {recs.isLoading ? (
        <Loading label={q ? 'Searching (full text and semantic)…' : 'Ranking claims…'} />
      ) : recs.isError ? (
        <ErrorState error={recs.error} onRetry={() => recs.refetch()} />
      ) : !recs.data?.length ? (
        <EmptyState title="No recommendations match" icon={<SparkIcon size={28} />} action={<Button onClick={() => setScanOpen(true)}>Run research scan…</Button>}>
          {q || topic || category ? 'Try clearing the filters' : 'No claims have been matched to this project yet'}
          {!includeBlocked && ', or include blocked claims'}.
        </EmptyState>
      ) : (
        <>
          {project && !project.roofline && (
            <div className="mb-3">
              <Banner tone="neutral" action={<Link to={`/projects?project=${project.id}`} className="text-sm">Measure roofline</Link>}>
                <strong>Expected gains aren’t estimated yet.</strong> The cost model needs the engine’s measured roofline to estimate each claim’s gain here.
              </Banner>
            </div>
          )}
          <p className="mb-2 text-xs text-muted" aria-live="polite">
            {predicted ? `${pluralize(shown.length, 'claim')} of ${recs.data.length}` : pluralize(recs.data.length, 'claim')}
            {recs.isFetching && ' · updating…'}
            <span> · pick 1–2 (up to {MAX_PICK})</span>
          </p>
          {!includeAssets && !includeBlocked && (assets.data?.held_back ?? 0) > 0 && (
            <p className="mb-2 text-xs text-muted">
              {pluralize(assets.data!.held_back, 'claim')} left out: {assets.data!.held_back === 1 ? 'it needs' : 'they need'} assets{' '}
              {project?.name ?? 'this project'} doesn’t have (trained drafters, offline artifacts, an MoE model…).{' '}
              <button type="button" className="inline-flex min-h-6 items-center font-medium text-info-fg hover:underline" onClick={() => setParam('assets', '1')}>
                Show them
              </button>
            </p>
          )}
          {includeAssets && !includeBlocked && (assets.data?.held_back ?? 0) > 0 && (
            <p className="mb-2 text-xs text-muted">
              Claims marked “Needs assets” are ranked where they would be if {project?.name ?? 'this project'} had them; testing one now would likely
              hang at the smoke test or measure a stand-in.
            </p>
          )}
          {!shown.length && (
            <EmptyState
              title={`No claims with “${LIKELIHOOD_INFO[likelihoodOf({ likelihood: predicted, predicted_gain_pct: null })].label}”`}
              icon={<SparkIcon size={28} />}
              action={<Button onClick={() => setParam('pred', null)}>Show every estimate</Button>}
            >
              {predicted === 'unlikely' && !includeBlocked
                ? 'Claims the cost model calls unlikely to help are blocked. Tick “Include blocked” to see them.'
                : 'Try another estimate, or include blocked claims.'}
            </EmptyState>
          )}
          <div className="space-y-3">
            {shown.slice(0, limit).map((item) => (
              <RecommendationCard
                key={item.claim_id}
                item={item}
                selected={selected.has(item.claim_id)}
                maxReached={selected.size >= MAX_PICK}
                onToggle={() => toggle(item)}
                shortlisted={shortlist.has(item.claim_id)}
                project={project}
              />
            ))}
          </div>
          {shown.length > limit && (
            <div className="mt-4 flex flex-col items-center gap-1">
              <Button onClick={() => setLimit((value) => value + PAGE)}>Show {Math.min(PAGE, shown.length - limit)} more</Button>
              <span className="text-xs text-muted">
                Showing {limit} of {shown.length}, {sortByPredicted ? 'highest expected gain' : 'best match'} first
              </span>
            </div>
          )}
        </>
      )}

      <StickyActionBar
        open={picks.length > 0}
        label="Selected claims"
        summary={
          <>
            <strong className="font-semibold tabular-nums">{picks.length} selected</strong>
            {picks.length > 2 && <span className="hidden text-caution-fg sm:inline"> · 1–2 at a time keeps the queue short</span>}
          </>
        }
        actions={
          <>
            <Button variant="invisible" onClick={() => setSelected(new Map())}>
              Clear
            </Button>
            <Button
              variant="primary"
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
              Review & start
            </Button>
          </>
        }
      />

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={startExperiments}
        title={`Start ${pluralize(plannedCount(effectiveMode, picks, lookup), 'experiment')}?`}
        confirmLabel={effectiveMode === 'single' ? 'Start experiments' : effectiveMode === 'bundle' ? 'Start bundled experiment' : 'Start chain'}
        loading={create.isPending}
        error={create.error ? errorMessage(create.error) : null}
        confirmDisabled={blockedPicks.length > 0 && !force}
        initialFocus="cancel"
        cost={
          <>
            Creates {pluralize(plannedCount(effectiveMode, picks, lookup), 'experiment')}, each built on its own branch. The planner writes each test plan
            with the LLM; nothing is merged without your decision at Gate 3.
          </>
        }
      >
        <p className="mb-3 text-muted">
          For each claim the planner writes a test plan for <strong className="text-fg">{project?.name}</strong>. Nothing is built until you approve the
          plan (Gate 2).
        </p>
        <ul className="mb-3 space-y-2">
          {picks.map((item) => (
            <li key={item.claim_id} className="rounded-lg border border-line px-3 py-2">
              <div className="font-medium">
                <MathText>{item.name}</MathText>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <PredictionChip prediction={item.prediction} />
                <ClaimedEffect claim={item} />
              </div>
              {item.blockers.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {item.blockers.map((blocker) => (
                    <BlockerBadge key={blocker} blocker={blocker} />
                  ))}
                </div>
              )}
              <NeedsAssetsNote missing={missingAssets(item)} project={project?.name} className="mt-1" />
            </li>
          ))}
        </ul>
        <PrerequisitesChoice picks={picks} mode={mode} onChange={setMode} lookup={lookup} />
        {pickTriage && <p className="mb-3 text-xs text-muted">Linked to research scan #{pickTriage.id}.</p>}
        {blockedPicks.length > 0 && (
          <div className="rounded-lg border border-caution-emphasis/60 bg-caution-subtle p-3">
            <Checkbox
              id="force-blocked"
              checked={force}
              onChange={setForce}
              label={`Start anyway: ${pluralize(blockedPicks.length, 'claim')} ${blockedPicks.length === 1 ? 'is' : 'are'} blocked on this project`}
              description={
                assetOnlyPicks.length === blockedPicks.length
                  ? `${assetOnlyPicks.length === 1 ? 'It needs' : 'They need'} assets ${project?.name ?? 'this project'} doesn’t have. Experiments like this have hung at the smoke test or measured a stand-in without the paper’s benefit. Add the assets to lab.yaml’s capabilities and re-profile instead, if you can.`
                  : 'The matcher thinks these can’t be tested here, so the experiment will probably fail.'
              }
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
