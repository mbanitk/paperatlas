import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api } from '../api/client'
import { keys, useCancelExperiment, useClaim, useExperiment, useProject, useRetryExperiment } from '../api/queries'
import { mergeEvents, useEventStream } from '../api/sse'
import type { Experiment, LabEvent, Project } from '../api/types'
import { CategoryChip, LiveDot, MODE_INFO, ModeBadge, StatusChip, VerdictBadge } from '../components/Badges'
import { ClaimCardDetails } from '../components/ClaimCard'
import { ConfirmDialog } from '../components/Dialog'
import { EventTimeline } from '../components/EventTimeline'
import { AlertIcon, BranchIcon, ClockIcon, ChevronDown, ChevronRight, GateIcon, RefreshIcon, SparkIcon, StopIcon } from '../components/Icons'
import { ClaimDiagram, ClaimExplainDetails, ClaimLead, GenerateClaimExplainer, GlanceStrip } from '../components/Explainers'
import { RelatedStrip } from '../components/Related'
import { Stepper } from '../components/Stepper'
import { useToast } from '../components/Toast'
import { Banner, Button, Card, Chip, ErrorState, ExternalLink, Loading, PageHeader, PaperLink, RelativeTime, errorMessage } from '../components/ui'
import { formatPct } from '../lib/format'
import { canCancel, canRetry, isActiveStatus, normalizeStages, statusInfo } from '../lib/stages'
import { BuildCard, LogCard, ProjectFacts, RunsCard } from './experiment/Sections'
import { SpecDetails, SpecGate } from './experiment/SpecGate'
import { ProtocolSummary } from './experiment/Protocol'
import { adoptionInfo, currentIteration, isProtocolV2, protocolOf } from '../lib/protocol'
import { VerdictPanel } from './experiment/VerdictPanel'

function useExperimentEvents(id: number, enabled: boolean) {
  const client = useQueryClient()
  const [events, setEvents] = useState<LabEvent[]>([])
  const replayed = useRef(false)

  useEffect(() => {
    setEvents([])
    replayed.current = false
  }, [id])

  const onEvents = useCallback(
    (batch: LabEvent[]) => {
      setEvents((current) => mergeEvents(current, batch))
      // The first batch is the replay of history; later batches are live → refresh the experiment.
      if (replayed.current) {
        client.invalidateQueries({ queryKey: keys.experiment(id), exact: true })
        client.invalidateQueries({ queryKey: keys.experimentLog(id) })
      }
      replayed.current = true
    },
    [client, id],
  )
  const status = useEventStream(enabled ? api.streams.experiment(id) : null, { after: 0, onEvents })
  return { events, status }
}

/** Claim panel: plain-language lead + mini diagram + glance strip, explanation and raw claim card on demand. */
function ClaimUnderTest({ experiment, project }: { experiment: Experiment; project?: Project }) {
  const claim = useClaim(experiment.claim_id, experiment.project_id)
  const [open, setOpen] = useState<'explain' | 'card' | null>(null)
  const explainer = claim.data?.explainer
  const subject = { ...experiment.claim, explainer }
  const toggle = (panel: 'explain' | 'card') => setOpen((current) => (current === panel ? null : panel))
  return (
    <div className="space-y-3">
      <ClaimLead claim={subject} explainer={explainer} />
      <GlanceStrip claim={subject} explainer={explainer} project={project} />
      <RelatedStrip related={experiment.related ?? claim.data?.related} claimId={experiment.claim_id} paperId={experiment.paper_id} />
      <ClaimDiagram diagram={explainer?.diagram} />
      <div className="flex flex-wrap items-center gap-1">
        {explainer ? (
          <Button size="sm" variant="invisible" onClick={() => toggle('explain')} aria-expanded={open === 'explain'} icon={<SparkIcon size={14} />}>
            {open === 'explain' ? 'Hide explanation' : 'Explain'}
          </Button>
        ) : (
          !claim.isLoading && <GenerateClaimExplainer claimId={experiment.claim_id} projectId={experiment.project_id} />
        )}
        <Button size="sm" variant="invisible" onClick={() => toggle('card')} aria-expanded={open === 'card'} icon={open === 'card' ? <ChevronDown /> : <ChevronRight />}>
          Claim card
        </Button>
      </div>
      {open === 'explain' && explainer && (
        <div className="border-t border-line-muted pt-4">
          <ClaimExplainDetails explainer={explainer} projectName={experiment.project.name} showDiagram={false} />
        </div>
      )}
      {open === 'card' && (
        <div className="border-t border-line-muted pt-3">
          <ClaimCardDetails claim={experiment.claim} />
        </div>
      )}
    </div>
  )
}

function ExperimentRef({ id, status }: { id: number; status?: string }) {
  const other = useExperiment(id)
  const current = status ?? other.data?.status
  return (
    <Link
      to={`/experiments/${id}`}
      className="group flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line-muted px-2.5 py-1.5 text-sm hover:border-accent hover:no-underline"
    >
      <span className="text-xs text-muted tabular-nums">#{id}</span>
      <span className="min-w-0 text-fg group-hover:text-accent">{other.data?.title ?? 'Experiment'}</span>
      {current && <StatusChip status={current} />}
    </Link>
  )
}

/** Gate 1 mode, the prerequisite this experiment waits for, what it unlocks and the claims it bundles. */
function PlanCard({ experiment }: { experiment: Experiment }) {
  const mode = experiment.mode ?? 'single'
  const bundle = experiment.bundle ?? []
  const dependents = experiment.dependents ?? []
  const dependsOn = experiment.depends_on_experiment_id
  if (mode === 'single' && !bundle.length && !dependents.length && dependsOn == null) return null
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Experiment plan <ModeBadge mode={mode} bundleSize={bundle.length} />
        </span>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-muted">{MODE_INFO[mode]?.description ?? ''}</p>
        {dependsOn != null && (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Waits for</h4>
            <ExperimentRef id={dependsOn} />
            {experiment.error ? null : (experiment.spec?.baseline_flags as string[] | undefined)?.length ? (
              <p className="mt-1.5 text-xs text-muted">
                Baseline keeps{' '}
                {(experiment.spec.baseline_flags as string[]).map((flag, index) => (
                  <span key={flag}>
                    {index > 0 && ', '}
                    <code className="code-inline">{flag}</code>
                  </span>
                ))}{' '}
                on, so only this claim’s change is measured.
              </p>
            ) : (
              <p className="mt-1.5 text-xs text-muted">When it is merged its flag stays on in this experiment’s baseline, so only this claim’s change is measured.</p>
            )}
          </section>
        )}
        {dependents.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Unlocks</h4>
            <ul className="space-y-1.5">
              {dependents.map((dependent) => (
                <li key={dependent.id}>
                  <ExperimentRef id={dependent.id} status={dependent.status} />
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs text-muted">These start automatically once this experiment is merged.</p>
          </section>
        )}
        {bundle.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Implemented together with</h4>
            <ul className="space-y-2">
              {bundle.map((member) => (
                <li key={member.claim_id} className="rounded-md border border-line-muted px-2.5 py-1.5">
                  <Link to={`/research/claims/${member.claim_id}`} className="font-medium">
                    {member.name}
                  </Link>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted" title={member.technique}>
                    {member.technique}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Card>
  )
}

function BlockedBanner({ experiment }: { experiment: Experiment }) {
  if (experiment.status !== 'blocked') return null
  const dependsOn = experiment.depends_on_experiment_id
  const link = dependsOn != null ? <Link to={`/experiments/${dependsOn}`}>#{dependsOn}</Link> : 'its prerequisite'
  if (experiment.error)
    return (
      <div role="alert" className="rounded-lg border border-attention-emphasis/40 bg-attention-subtle p-4">
        <div className="flex items-center gap-2 font-semibold text-attention">
          <AlertIcon /> Prerequisite experiment {link} was not merged
        </div>
        {!/was not merged/.test(experiment.error) && <p className="mt-1 text-sm text-fg">{experiment.error.replace(/^plan:\s*/, '')}</p>}
        <p className="mt-1 text-xs text-muted">Use Retry to run this experiment on its own (without the prerequisite), or cancel it.</p>
      </div>
    )
  return (
    <Banner tone="muted" icon={<ClockIcon className="text-muted" />}>
      <strong>Waiting for prerequisite {link}.</strong> This experiment starts automatically when {link} is merged.
    </Banner>
  )
}

function Actions({ experiment }: { experiment: Experiment }) {
  const [dialog, setDialog] = useState<'cancel' | 'retry' | null>(null)
  const cancel = useCancelExperiment(experiment.id)
  const retry = useRetryExperiment(experiment.id)
  const toast = useToast()
  return (
    <>
      {canRetry(experiment.status, experiment.error) && (
        <Button icon={<RefreshIcon />} onClick={() => setDialog('retry')}>
          Retry
        </Button>
      )}
      {canCancel(experiment.status) && (
        <Button variant="danger" icon={<StopIcon />} onClick={() => setDialog('cancel')}>
          Cancel experiment
        </Button>
      )}
      <ConfirmDialog
        open={dialog === 'cancel'}
        onClose={() => setDialog(null)}
        title="Cancel this experiment?"
        confirmLabel="Cancel experiment"
        variant="danger"
        loading={cancel.isPending}
        error={cancel.error}
        onConfirm={() =>
          cancel.mutate(undefined, {
            onSuccess: (result) => {
              setDialog(null)
              toast.success(result.status === 'cancelling' ? 'Cancelling — the running step stops at the next checkpoint.' : 'Experiment cancelled.')
            },
            onError: (error) => toast.error(errorMessage(error)),
          })
        }
      >
        <p className="text-muted">Queued jobs are cancelled; a running build or benchmark stops at its next check. You can retry later from the last completed step.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'retry'}
        onClose={() => setDialog(null)}
        title="Retry this experiment?"
        confirmLabel="Retry"
        loading={retry.isPending}
        error={retry.error}
        onConfirm={() =>
          retry.mutate(undefined, {
            onSuccess: () => {
              setDialog(null)
              toast.success('Retry queued — continuing from the last completed step.')
            },
            onError: (error) => toast.error(errorMessage(error)),
          })
        }
      >
        <p className="text-muted">
          {experiment.status === 'blocked'
            ? 'The experiment is queued now and runs without its prerequisite.'
            : 'The experiment is re-queued and resumes from its last checkpoint (completed steps are not repeated).'}
        </p>
      </ConfirmDialog>
    </>
  )
}

function GateCallout({ experiment }: { experiment: Experiment }) {
  if (experiment.status === 'awaiting_approval')
    return (
      <Banner tone="attention" icon={<GateIcon className="text-attention" />} action={<a href="#gate" className="text-sm font-semibold">Review spec ↓</a>}>
        <strong>Gate 2 — your approval is needed.</strong> Review the experiment spec, then approve, request a revision or reject.
      </Banner>
    )
  if (experiment.status === 'awaiting_decision')
    return (
      <Banner tone="attention" icon={<GateIcon className="text-attention" />} action={<a href="#gate" className="text-sm font-semibold">See verdict ↓</a>}>
        <strong>Gate 3 — merge or drop?</strong> The judge measured {formatPct(experiment.median_delta_pct)} vs the paper’s {formatPct(experiment.claimed_gain_pct, 0)}
        {experiment.verdict_detail?.details?.adoption
          ? `; adoption check: ${adoptionInfo(experiment.verdict_detail.details.adoption.verdict).label.toLowerCase()} (${formatPct(experiment.verdict_detail.details.adoption.median_delta_pct)} vs the project default).`
          : '.'}
      </Banner>
    )
  if (experiment.status === 'approving' || experiment.status === 'queued' || experiment.status === 'finalizing')
    return (
      <Banner tone="accent">
        <strong>{statusInfo(experiment.status).label}.</strong> A job is queued for the worker; this page updates live when it starts.
      </Banner>
    )
  return null
}

export default function ExperimentDetail() {
  const id = Number(useParams().id)
  const experiment = useExperiment(id)
  const project = useProject(experiment.data?.project_id)
  const { events, status: streamStatus } = useExperimentEvents(id, Number.isFinite(id) && !experiment.isError)

  if (!Number.isFinite(id)) return <ErrorState error={new Error('Invalid experiment id')} />
  if (experiment.isLoading) return <Loading label={`Loading experiment #${id}…`} />
  if (experiment.isError || !experiment.data)
    return (
      <div className="space-y-4">
        <Link to="/experiments" className="text-sm">
          ← Experiments
        </Link>
        <ErrorState error={experiment.error} onRetry={() => experiment.refetch()} />
      </div>
    )

  const data = experiment.data
  const stages = normalizeStages(data.stages, data.status, data.stage)
  const busy = isActiveStatus(data.status) && !['awaiting_approval', 'awaiting_decision'].includes(data.status)
  const iteration = currentIteration(data)
  const maxIterations = protocolOf(data.spec).max_iterations

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-x-2">
            <Link to="/experiments">Experiments</Link>
            <span>/</span>
            <span>#{data.id}</span>
            <span>· {data.project.name}</span>
            <span>
              · created <RelativeTime iso={data.created_at} />
            </span>
            {data.triage_id && (
              <span>
                · from <Link to={`/recommendations?project=${data.project_id}&triage=${data.triage_id}`}>research scan #{data.triage_id}</Link>
              </span>
            )}
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {data.title}
            <StatusChip status={data.status} className="text-sm" />
            <VerdictBadge verdict={data.verdict} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <CategoryChip category={data.category} />
            <ModeBadge mode={data.mode} bundleSize={data.bundle?.length ?? data.bundle_claim_ids?.length} />
            {data.flag_name && (
              <span>
                flag <code className="code-inline">{data.flag_name}</code>
              </span>
            )}
            {data.branch && (
              <span className="inline-flex items-center gap-1">
                <BranchIcon size={14} /> <code className="code-inline">{data.branch}</code>
              </span>
            )}
            <span>
              paper: <PaperLink paperId={data.paper_id} title={data.paper_title} />
              {data.claim.paper_url && (
                <>
                  {' '}
                  <ExternalLink href={data.claim.paper_url} className="text-xs text-muted">
                    source
                  </ExternalLink>
                </>
              )}
            </span>
          </span>
        }
        actions={<Actions experiment={data} />}
      />

      <div className="space-y-4">
        <GateCallout experiment={data} />
        <BlockedBanner experiment={data} />
        {data.status === 'failed' && (
          <div role="alert" className="rounded-lg border border-danger/40 bg-danger-subtle p-4">
            <div className="flex items-center gap-2 font-semibold text-danger">
              <AlertIcon /> Experiment failed
            </div>
            {data.error && <pre className="mt-2 max-h-56 overflow-auto text-xs whitespace-pre-wrap text-fg">{data.error}</pre>}
            <p className="mt-2 text-xs text-muted">Fix the cause (see the log below) and use Retry — completed steps are not repeated.</p>
          </div>
        )}
        {data.status === 'cancelled' && data.error && <Banner tone="muted">{data.error}</Banner>}

        <Card bodyClassName="px-4 py-5">
          {iteration > 1 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
              <Chip tone="done">
                Iteration {iteration}
                {maxIterations >= iteration && ` of ${maxIterations}`}
              </Chip>
              the judge diagnosed a fixable gap and sent the build back with a change
            </div>
          )}
          <Stepper
            stages={stages}
            waitingLabel={
              data.status === 'blocked'
                ? data.error
                  ? 'prerequisite not merged'
                  : `waiting for #${data.depends_on_experiment_id ?? 'prerequisite'}`
                : undefined
            }
          />
        </Card>

        <div className="grid gap-6 xl:grid-cols-3">
          <div className="min-w-0 space-y-6 xl:col-span-2">
            {data.status === 'awaiting_approval' && <SpecGate key={data.id} experiment={data} project={project.data} />}
            {data.verdict_detail && <VerdictPanel experiment={data} verdict={data.verdict_detail} project={project.data} />}

            <Card
              title={`Timeline (${events.length})`}
              actions={isActiveStatus(data.status) ? <LiveDot status={streamStatus} /> : <span className="text-xs text-muted">{statusInfo(data.status).label}</span>}
              bodyClassName="max-h-[520px] overflow-y-auto px-4 py-1"
            >
              <EventTimeline events={[...events].reverse()} emptyText={streamStatus === 'open' ? 'No events yet.' : 'Connecting to the live stream…'} />
            </Card>

            <LogCard experimentId={data.id} live={busy} />
            {data.status !== 'awaiting_approval' && Object.keys(data.spec).length > 0 && (
              <Card title="Experiment spec">
                {isProtocolV2(data.spec) && <ProtocolSummary spec={data.spec} className="mb-5 border-b border-line-muted pb-5" />}
                <SpecDetails spec={data.spec} project={project.data} includeEditable />
              </Card>
            )}
          </div>

          <div className="min-w-0 space-y-6">
            {data.status === 'blocked' && <PlanCard experiment={data} />}
            <Card
              title="Claim under test"
              actions={
                <Link to={`/research/claims/${data.claim_id}`} className="text-xs">
                  Claim #{data.claim_id}
                </Link>
              }
            >
              <ClaimUnderTest experiment={data} project={project.data} />
            </Card>
            {data.status !== 'blocked' && <PlanCard experiment={data} />}
            <BuildCard experiment={data} />
            <RunsCard experiment={data} />
            <Card title="Target project">
              <ProjectFacts project={project.data} />
            </Card>
          </div>
        </div>
      </div>
    </>
  )
}
