import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api } from '../api/client'
import { keys, useCancelExperiment, useExperiment, useProject, useRetryExperiment } from '../api/queries'
import { mergeEvents, useEventStream } from '../api/sse'
import type { Experiment, LabEvent } from '../api/types'
import { CategoryChip, LiveDot, StatusChip, VerdictBadge } from '../components/Badges'
import { ClaimCardDetails } from '../components/ClaimCard'
import { ConfirmDialog } from '../components/Dialog'
import { EventTimeline } from '../components/EventTimeline'
import { AlertIcon, BranchIcon, GateIcon, RefreshIcon, StopIcon } from '../components/Icons'
import { Stepper } from '../components/Stepper'
import { useToast } from '../components/Toast'
import { Banner, Button, Card, ErrorState, ExternalLink, Loading, PageHeader, PaperLink, RelativeTime, errorMessage } from '../components/ui'
import { formatPct } from '../lib/format'
import { canCancel, canRetry, isActiveStatus, normalizeStages, statusInfo } from '../lib/stages'
import { BuildCard, LogCard, ProjectFacts, RunsCard } from './experiment/Sections'
import { SpecDetails, SpecGate } from './experiment/SpecGate'
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

function Actions({ experiment }: { experiment: Experiment }) {
  const [dialog, setDialog] = useState<'cancel' | 'retry' | null>(null)
  const cancel = useCancelExperiment(experiment.id)
  const retry = useRetryExperiment(experiment.id)
  const toast = useToast()
  return (
    <>
      {canRetry(experiment.status) && (
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
        <p className="text-muted">The experiment is re-queued and resumes from its last checkpoint (completed steps are not repeated).</p>
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
        <strong>Gate 3 — merge or drop?</strong> The judge measured {formatPct(experiment.median_delta_pct)} vs the paper’s {formatPct(experiment.claimed_gain_pct, 0)}.
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
          <Stepper stages={stages} />
        </Card>

        <div className="grid gap-6 xl:grid-cols-3">
          <div className="min-w-0 space-y-6 xl:col-span-2">
            {data.status === 'awaiting_approval' && <SpecGate key={JSON.stringify(data.spec)} experiment={data} project={project.data} />}
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
                <SpecDetails spec={data.spec} project={project.data} includeEditable />
              </Card>
            )}
          </div>

          <div className="min-w-0 space-y-6">
            <Card
              title="Claim under test"
              actions={
                <Link to={`/research/claims/${data.claim_id}`} className="text-xs">
                  Claim #{data.claim_id}
                </Link>
              }
            >
              <ClaimCardDetails claim={data.claim} />
            </Card>
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
