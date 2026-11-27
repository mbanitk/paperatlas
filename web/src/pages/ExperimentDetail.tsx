import { autoUpdate, FloatingFocusManager, FloatingPortal, useClick, useDismiss, useFloating, useInteractions, useRole } from '@floating-ui/react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api } from '../api/client'
import { keys, useCancelExperiment, useClaim, useExperiment, useExperiments, useProject, useRerunExperiment, useRetryExperiment } from '../api/queries'
import { mergeEvents, useEventStream } from '../api/sse'
import type { Experiment, LabEvent, Project } from '../api/types'
import { CategoryChip, CodeToken, LiveDot, MODE_INFO, ModeBadge, OutcomeBadge, StatusChip } from '../components/Badges'
import { ClaimCardDetails } from '../components/ClaimCard'
import { ConfirmDialog, Modal } from '../components/Dialog'
import { EventTimeline } from '../components/EventTimeline'
import { AlertIcon, BranchIcon, ClockIcon, MoreIcon, RefreshIcon, StopIcon } from '../components/Icons'
import { GenerateClaimExplainer } from '../components/Explainers'
import { ClaimDeepDive, ClaimHeadline, ClaimOverview } from '../components/ClaimStory'
import { RelatedStrip } from '../components/Related'
import { PredictionPanel } from '../components/Prediction'
import { Stepper } from '../components/Stepper'
import { floatingMiddleware, useExclusiveOpen } from '../components/Tooltip'
import { useToast } from '../components/Toast'
import {
  AnswerBlock,
  Banner,
  Breadcrumb,
  Button,
  Card,
  Chip,
  cx,
  DefinitionList,
  Disclosure,
  ErrorState,
  errorMessage,
  ExternalLink,
  InlineError,
  Loading,
  MathText,
  PaperLink,
  RelativeTime,
} from '../components/ui'
import { formatClaimed, formatRange } from '../lib/format'
import { canCancel, canRerun, canRetry, isActiveStatus, normalizeStages, rerunsOf, statusInfo } from '../lib/stages'
import { currentIteration, isProtocolV2, protocolOf, summarizeFailure } from '../lib/protocol'
import { CodeChangesCard, hasCodeChanges } from './experiment/CodeChanges'
import { BuildCard, LogCard, ProjectFacts, RunsCard } from './experiment/Sections'
import { SpecDetails, SpecGate } from './experiment/SpecGate'
import { ProtocolSummary } from './experiment/Protocol'
import { DecisionSummary, VerdictPanel } from './experiment/VerdictPanel'
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

/** Claim panel: the headline and the two key numbers; the explanation and raw claim card on demand (X-8). */
function ClaimUnderTest({ experiment, project }: { experiment: Experiment; project?: Project }) {
  const claim = useClaim(experiment.claim_id, experiment.project_id)
  const explainer = claim.data?.explainer
  const subject = { ...experiment.claim, explainer }
  const prediction = experiment.spec.prediction
  return (
    <div className="space-y-3">
      <div className="[&>p:first-child]:mt-0 [&>div:first-child]:mt-0">
        <ClaimHeadline claim={subject} explainer={explainer} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
        <AnswerBlock
          register="claimed"
          size="md"
          value={typeof experiment.claimed_gain_pct === 'number' ? formatClaimed(experiment.claimed_gain_pct).replace(/^Paper reports /, '') : 'No number'}
          confidence={typeof experiment.claimed_gain_pct === 'number' ? 'On the paper’s own setup' : 'The paper gives no number to compare with'}
        />
        <AnswerBlock
          register="predicted"
          size="md"
          label={`Expected here${project?.hardware?.chip ? ` · ${String(project.hardware.chip)}` : ''}`}
          value={formatRange(prediction?.predicted_gain_pct?.low, prediction?.predicted_gain_pct?.high)}
          badge={prediction ? <OutcomeBadge kind="likelihood" value={prediction.likelihood} explain /> : undefined}
          confidence={prediction ? 'Cost-model estimate, made when the plan was written' : undefined}
        />
      </div>
      <div className="space-y-1.5">
        {explainer ? (
          <Disclosure label="Explain" meta=" · what the paper does, in plain words">
            <div className="space-y-4">
              <ClaimOverview claim={subject} explainer={explainer} project={project} />
              <ClaimDeepDive explainer={explainer} projectName={experiment.project.name} />
              <RelatedStrip related={experiment.related ?? claim.data?.related} claimId={experiment.claim_id} paperId={experiment.paper_id} />
            </div>
          </Disclosure>
        ) : (
          !claim.isLoading && <GenerateClaimExplainer claimId={experiment.claim_id} projectId={experiment.project_id} />
        )}
        <Disclosure label="Claim card" meta=" · the raw claim">
          <ClaimCardDetails claim={experiment.claim} />
        </Disclosure>
      </div>
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
            <h4 className="mb-1.5 text-xs font-semibold text-muted">Waits for</h4>
            <ExperimentRef id={dependsOn} />
            {experiment.error ? null : (experiment.spec?.baseline_flags as string[] | undefined)?.length ? (
              <p className="mt-1.5 text-xs text-muted">
                Baseline keeps{' '}
                {(experiment.spec.baseline_flags as string[]).map((flag, index) => (
                  <span key={flag}>
                    {index > 0 && ', '}
                    <CodeToken>{flag}</CodeToken>
                  </span>
                ))}{' '}
                on, so only this claim’s change is measured.
              </p>
            ) : (
              <p className="mt-1.5 text-xs text-muted">Once it’s merged, its flag stays on in this experiment’s baseline, so only this claim’s change is measured.</p>
            )}
          </section>
        )}
        {dependents.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold text-muted">Unlocks</h4>
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
            <h4 className="mb-1.5 text-xs font-semibold text-muted">Implemented together with</h4>
            <ul className="space-y-2">
              {bundle.map((member) => (
                <li key={member.claim_id} className="rounded-md border border-line-muted px-2.5 py-1.5">
                  <Link to={`/research/claims/${member.claim_id}`} className="font-medium">
                    {member.name}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted">{member.technique}</p>
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
      <div role="alert" className="rounded-lg border border-caution-emphasis/60 bg-caution-subtle p-4">
        <div className="flex items-center gap-2 font-semibold text-caution-fg">
          <AlertIcon /> Prerequisite experiment {link} was not merged
        </div>
        {!/was not merged/.test(experiment.error) && <p className="mt-1 text-sm text-fg">{experiment.error.replace(/^plan:\s*/, '')}</p>}
        <p className="mt-1 text-sm text-muted">Use Retry to run this experiment on its own (without the prerequisite), or cancel it from More.</p>
      </div>
    )
  return (
    <Banner tone="neutral" icon={<ClockIcon className="text-muted" />}>
      <strong>Waiting for prerequisite {link}.</strong> This experiment starts automatically when {link} is merged.
    </Banner>
  )
}

const RERUN_OPTIONS = [
  {
    replan: false,
    label: 'Reuse this spec (review at Gate 2)',
    description: 'Same hypothesis, protocol and knobs on the project’s current code. Stops at Gate 2 so you can edit it before anything is built.',
  },
  {
    replan: true,
    label: 'Re-plan from the paper (use this result as feedback)',
    description: 'The planner writes a fresh spec from the paper, using this verdict and diagnosis as feedback. Also stops at Gate 2.',
  },
]

function RerunDialog({ experiment, onClose }: { experiment: Experiment; onClose: () => void }) {
  const rerun = useRerunExperiment(experiment.id)
  const navigate = useNavigate()
  const toast = useToast()
  const [replan, setReplan] = useState(false)
  const [comment, setComment] = useState('')
  // isPending only updates on the next render; the ref also stops a second click in the same tick.
  const submitting = useRef(false)
  const busy = rerun.isPending
  const submit = () => {
    if (submitting.current || busy) return
    submitting.current = true
    rerun.mutate(
      { replan, comment: comment.trim() || null },
      {
        onSuccess: (created) => {
          toast.success(`Re-run started as experiment #${created.id}`)
          onClose()
          navigate(`/experiments/${created.id}`)
        },
        onSettled: () => {
          submitting.current = false
        },
      },
    )
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Re-run experiment #${experiment.id}?`}
      size="sm"
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={<RefreshIcon />} onClick={submit} loading={busy} disabled={busy}>
            Start re-run
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <p className="mb-3 text-muted">
          Starts a new experiment for the same claim on the project’s current code. This experiment, its verdict and its branch stay as they are.
        </p>
        <fieldset disabled={busy} className="space-y-1.5">
          <legend className="sr-only">Spec for the re-run</legend>
          {RERUN_OPTIONS.map((option) => (
            <label
              key={String(option.replan)}
              className={cx(
                'flex cursor-pointer gap-2.5 rounded-md border bg-canvas px-3 py-2',
                replan === option.replan ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-subtle',
                busy && 'cursor-not-allowed opacity-70',
              )}
            >
              <input type="radio" name="rerun-mode" checked={replan === option.replan} onChange={() => setReplan(option.replan)} className="mt-0.5 accent-accent" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs text-muted">{option.description}</span>
              </span>
            </label>
          ))}
          <label htmlFor="rerun-comment" className="label mt-3 block">
            Comment (optional)
          </label>
          <textarea
            id="rerun-comment"
            className="input min-h-16"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="e.g. engine ported to MLX"
            maxLength={500}
          />
        </fieldset>
        <button type="submit" hidden />
      </form>
      <InlineError error={rerun.error} />
    </Modal>
  )
}

type DialogKind = 'cancel' | 'retry' | 'rerun'

/** Dialogs for Retry, Re-run and Cancel; `open(kind)` is used by the header menu and the failure block. */
function useExperimentDialogs(experiment: Experiment) {
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const cancel = useCancelExperiment(experiment.id)
  const retry = useRetryExperiment(experiment.id)
  const toast = useToast()
  const dialogs = (
    <>
      {dialog === 'rerun' && <RerunDialog experiment={experiment} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog === 'cancel'}
        onClose={() => setDialog(null)}
        title="Cancel this experiment?"
        confirmLabel="Cancel experiment"
        cancelLabel="Keep it running"
        variant="danger"
        loading={cancel.isPending}
        error={cancel.error}
        onConfirm={() =>
          cancel.mutate(undefined, {
            onSuccess: (result) => {
              setDialog(null)
              toast.success(result.status === 'cancelling' ? 'Cancelling: the running step stops at its next checkpoint.' : 'Experiment cancelled.')
            },
            onError: (error) => toast.error(errorMessage(error)),
          })
        }
      >
        <p className="text-muted">Queued jobs are cancelled, and a running build or benchmark stops at its next check. You can retry later from the last completed step.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'retry'}
        onClose={() => setDialog(null)}
        title="Retry this experiment?"
        confirmLabel="Retry"
        loading={retry.isPending}
        error={retry.error}
        cost="Runs on the worker again from the last completed step."
        onConfirm={() =>
          retry.mutate(undefined, {
            onSuccess: () => {
              setDialog(null)
              toast.success('Retry queued: continuing from the last completed step.')
            },
            onError: (error) => toast.error(errorMessage(error)),
          })
        }
      >
        <p className="text-muted">
          {experiment.status === 'blocked'
            ? 'The experiment is queued now and runs without its prerequisite.'
            : 'The experiment is queued again and resumes from its last checkpoint. Completed steps aren’t repeated.'}
        </p>
      </ConfirmDialog>
    </>
  )
  return { open: setDialog, dialogs }
}

/** "⋯ More": actions that aren't this page's next step (docs/ux-review.md X-13). */
function MoreMenu({ experiment, onSelect }: { experiment: Experiment; onSelect: (kind: DialogKind) => void }) {
  const [open, setOpen] = useState(false)
  const arrowRef = useRef<Element | null>(null)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: floatingMiddleware(arrowRef, 300),
  })
  useExclusiveOpen(open, () => setOpen(false), { sticky: true, reference: () => refs.domReference.current, floating: () => refs.floating.current })
  const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context), useRole(context, { role: 'menu' })])
  const rerunnable = canRerun(experiment.status)
  const cancellable = canCancel(experiment.status)
  const choose = (kind: DialogKind) => {
    setOpen(false)
    onSelect(kind)
  }
  const item = 'flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-canvas-subtle focus-visible:bg-canvas-subtle disabled:cursor-not-allowed disabled:opacity-60'
  return (
    <>
      <Button ref={refs.setReference} icon={<MoreIcon size={16} />} aria-label="More actions" {...getReferenceProps()}>
        More
      </Button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={{ ...floatingStyles, zIndex: 'var(--z-popover)' }}
              className="w-72 rounded-lg border border-line bg-canvas p-1 shadow-lg"
              {...getFloatingProps()}
            >
              <button type="button" role="menuitem" className={item} disabled={!rerunnable} onClick={() => choose('rerun')}>
                <RefreshIcon size={16} className="mt-0.5 shrink-0 text-muted" />
                <span>
                  <span className="block font-medium text-fg">Re-run…</span>
                  <span className="block text-xs text-muted">
                    {rerunnable
                      ? 'A new experiment for the same claim on the current code.'
                      : `Available once there’s a verdict or the experiment has ended. Now: ${statusInfo(experiment.status).label}.`}
                  </span>
                </span>
              </button>
              {cancellable && (
                <button type="button" role="menuitem" className={item} onClick={() => choose('cancel')}>
                  <StopIcon size={16} className="mt-0.5 shrink-0 text-negative-fg" />
                  <span>
                    <span className="block font-medium text-negative-fg">Cancel experiment…</span>
                    <span className="block text-xs text-muted">Stops the current step. You can retry later.</span>
                  </span>
                </button>
              )}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}

function DetailItems({ experiment, reruns }: { experiment: Experiment; reruns: number[] }) {
  const items: [ReactNode, ReactNode][] = [
    [
      'Paper',
      <span key="paper">
        <PaperLink paperId={experiment.paper_id} title={<MathText>{experiment.paper_title}</MathText>} />
        {experiment.claim.paper_url && (
          <>
            {' '}
            <ExternalLink href={experiment.claim.paper_url} className="text-xs text-muted">
              source
            </ExternalLink>
          </>
        )}
      </span>,
    ],
  ]
  if (experiment.category) items.push(['Category', <CategoryChip key="category" category={experiment.category} />])
  if (experiment.mode && experiment.mode !== 'single')
    items.push(['Mode', <ModeBadge key="mode" mode={experiment.mode} bundleSize={experiment.bundle?.length ?? experiment.bundle_claim_ids?.length} />])
  if (experiment.flag_name) items.push(['Flag', <CodeToken key="flag">{experiment.flag_name}</CodeToken>])
  if (experiment.branch)
    items.push([
      'Branch',
      <span key="branch" className="inline-flex items-center gap-1">
        <BranchIcon size={14} className="text-muted" /> <CodeToken>{experiment.branch}</CodeToken>
      </span>,
    ])
  items.push([
    'Project',
    <span key="project">
      {experiment.project.name} · created <RelativeTime iso={experiment.created_at} />
    </span>,
  ])
  if (experiment.rerun_of_experiment_id != null)
    items.push(['Re-run of', <Link key="rerun-of" to={`/experiments/${experiment.rerun_of_experiment_id}`}>#{experiment.rerun_of_experiment_id}</Link>])
  if (reruns.length)
    items.push([
      'Re-runs',
      <span key="reruns">
        {reruns.map((rerunId, index) => (
          <span key={rerunId}>
            {index > 0 && ', '}
            <Link to={`/experiments/${rerunId}`}>#{rerunId}</Link>
          </span>
        ))}
      </span>,
    ])
  if (experiment.triage_id)
    items.push(['From', <Link key="triage" to={`/recommendations?project=${experiment.project_id}&triage=${experiment.triage_id}`}>research scan #{experiment.triage_id}</Link>])
  return (
    <>
      <dl className="mt-2 hidden flex-wrap items-center gap-x-4 gap-y-1.5 text-sm sm:flex">
        {items.map(([label, value], index) => (
          <div key={index} className="flex min-w-0 items-center gap-1.5">
            <dt className="text-muted">{label}:</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      <Disclosure label="Details" meta=" · paper, flag, branch" className="mt-2 sm:hidden">
        <DefinitionList items={items} />
      </Disclosure>
    </>
  )
}

/** Detail-page header: breadcrumb, the experiment as the h1, one status line, details (collapsed on mobile). */
function ExperimentHeader({ experiment, reruns, onAction }: { experiment: Experiment; reruns: number[]; onAction: (kind: DialogKind) => void }) {
  const adoption = experiment.verdict_detail?.details?.adoption
  const retryable = canRetry(experiment.status, experiment.error) && experiment.status !== 'failed'
  return (
    <header className="mb-6 border-b border-line-muted pb-4">
      <div className="flex items-start justify-between gap-3">
        <Breadcrumb items={[{ label: 'Experiments', to: '/experiments' }, { label: `#${experiment.id}` }]} className="pt-1" />
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {retryable && (
            <Button icon={<RefreshIcon />} onClick={() => onAction('retry')}>
              Retry
            </Button>
          )}
          <MoreMenu experiment={experiment} onSelect={onAction} />
        </div>
      </div>
      <h1 className="mt-1 text-title text-fg [overflow-wrap:anywhere]">
        <MathText>{experiment.title}</MathText>
      </h1>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <StatusChip status={experiment.status} explain />
        {experiment.verdict && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            Claim <OutcomeBadge kind="verdict" value={experiment.verdict} />
          </span>
        )}
        {adoption?.verdict && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            Here <OutcomeBadge kind="adoption" value={String(adoption.verdict)} />
          </span>
        )}
        {experiment.status === 'awaiting_decision' && (
          <a href="#gate" className="inline-flex min-h-6 items-center text-sm font-semibold">
            See the recommendation ↓
          </a>
        )}
        {experiment.status === 'awaiting_approval' && (
          <a href="#gate" className="inline-flex min-h-6 items-center text-sm font-semibold">
            Review the test plan ↓
          </a>
        )}
      </div>
      <DetailItems experiment={experiment} reruns={reruns} />
    </header>
  )
}

/** A failed experiment: what broke in plain words first, the traceback on demand (docs/ux-review.md X-11). */
function FailureSummary({ experiment, onRetry }: { experiment: Experiment; onRetry: () => void }) {
  const failure = summarizeFailure(experiment.error, experiment.stage)
  const where = [failure.exitCode !== null ? `exit code ${failure.exitCode}` : null, failure.location ? `in ${failure.location}` : null].filter(Boolean).join(' ')
  return (
    <section role="alert" aria-labelledby="failure-title" className="rounded-lg border border-negative/30 bg-negative-subtle p-4">
      <h2 id="failure-title" className="flex items-center gap-2 text-body-lg font-semibold text-negative-fg">
        <AlertIcon /> {failure.title}
      </h2>
      <p className="mt-1 max-w-3xl text-body-lg text-fg [overflow-wrap:anywhere]">
        {failure.plain}
        {where && <span className="text-muted"> ({where})</span>}
      </p>
      {failure.cause && (
        <p className="mt-1.5 max-w-3xl text-sm text-fg">
          <span className="text-muted">Error: </span>
          <code className="font-mono text-xs [overflow-wrap:anywhere]">{failure.cause}</code>
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {canRetry(experiment.status, experiment.error) && (
          <Button variant="primary" icon={<RefreshIcon />} onClick={onRetry}>
            Retry
          </Button>
        )}
        <p className="text-sm text-muted">Fix the cause, then retry: completed steps aren’t repeated.</p>
      </div>
      {failure.technical && (
        <Disclosure label="Show error output" className="mt-2">
          <pre className="max-h-72 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-xs whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{failure.technical}</pre>
        </Disclosure>
      )}
    </section>
  )
}

function StatusBanner({ experiment }: { experiment: Experiment }) {
  if (experiment.status === 'approving' || experiment.status === 'queued' || experiment.status === 'finalizing')
    return (
      <Banner tone="info" icon={<ClockIcon className="text-info-fg" />}>
        <strong>{statusInfo(experiment.status).label}.</strong> A job is queued for the worker; this page updates live when it starts.
      </Banner>
    )
  if (experiment.status === 'cancelled' && experiment.error) return <Banner tone="neutral">{experiment.error}</Banner>
  return null
}

export default function ExperimentDetail() {
  const id = Number(useParams().id)
  const experiment = useExperiment(id)
  const project = useProject(experiment.data?.project_id)
  const siblings = useExperiments({ project_id: experiment.data?.project_id })
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
  return <ExperimentPage data={experiment.data} project={project.data} reruns={rerunsOf(experiment.data.id, siblings.data)} events={events} streamStatus={streamStatus} />
}

function ExperimentPage({ data, project, reruns, events, streamStatus }: { data: Experiment; project?: Project; reruns: number[]; events: LabEvent[]; streamStatus: string }) {
  const { open, dialogs } = useExperimentDialogs(data)
  const stages = normalizeStages(data.stages, data.status, data.stage)
  const busy = isActiveStatus(data.status) && !['awaiting_approval', 'awaiting_decision'].includes(data.status)
  const iteration = currentIteration(data)
  const maxIterations = protocolOf(data.spec).max_iterations

  return (
    <>
      <ExperimentHeader experiment={data} reruns={reruns} onAction={open} />

      <div className="space-y-6">
        {data.status === 'awaiting_approval' && <SpecGate key={data.id} experiment={data} project={project} />}
        {data.verdict_detail && <DecisionSummary experiment={data} verdict={data.verdict_detail} />}
        {data.status === 'failed' && <FailureSummary experiment={data} onRetry={() => open('retry')} />}
        <BlockedBanner experiment={data} />
        <StatusBanner experiment={data} />

        <Card title="Progress" bodyClassName="px-4 py-4">
          {iteration > 1 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted">
              <Chip tone="info">
                Iteration {iteration}
                {maxIterations >= iteration && ` of ${maxIterations}`}
              </Chip>
              The analysis found a fixable gap, so the build went back to the coding agent with a change.
              {data.build.kept_iteration != null && data.build.kept_iteration < iteration && (
                <span className="font-medium text-fg">Iteration {data.build.kept_iteration} scored best and was kept; later changes were reverted.</span>
              )}
            </div>
          )}
          <Stepper
            stages={stages}
            waitingLabel={
              data.status === 'blocked' ? (data.error ? 'prerequisite not merged' : `waiting for #${data.depends_on_experiment_id ?? 'prerequisite'}`) : undefined
            }
          />
        </Card>

        <div className="grid gap-6 xl:grid-cols-3">
          <div className="min-w-0 space-y-6 xl:col-span-2">
            {hasCodeChanges(data) && <CodeChangesCard experiment={data} />}
            {data.verdict_detail && <VerdictPanel experiment={data} verdict={data.verdict_detail} project={project} />}

            <Card
              title={`Timeline (${events.length})`}
              actions={isActiveStatus(data.status) ? <LiveDot status={streamStatus} /> : <span className="text-xs text-muted">{statusInfo(data.status).label}</span>}
              bodyClassName="max-h-[560px] overflow-y-auto px-4 py-1"
            >
              <EventTimeline events={[...events].reverse()} emptyText={streamStatus === 'open' ? 'No events yet.' : 'Connecting to the live stream…'} />
            </Card>

            <LogCard experimentId={data.id} live={busy} />
            {data.status !== 'awaiting_approval' && Object.keys(data.spec).length > 0 && (
              <Card title="Test plan">
                {isProtocolV2(data.spec) ? (
                  <ProtocolSummary spec={data.spec} className="mb-5 border-b border-line-muted pb-5" />
                ) : (
                  data.spec.prediction && <PredictionPanel prediction={data.spec.prediction} claimed={data.spec.claimed_gain_pct} className="mb-5 md:max-w-xl" />
                )}
                <Disclosure label="Full plan" meta=" · hypothesis, metrics, guardrails, time limits">
                  <SpecDetails spec={data.spec} project={project} includeEditable />
                </Disclosure>
              </Card>
            )}
          </div>

          <div className="min-w-0 space-y-6">
            {data.status === 'blocked' && <PlanCard experiment={data} />}
            <Card
              title="Claim under test"
              actions={
                <Link to={`/research/claims/${data.claim_id}`} className="inline-flex min-h-6 items-center text-xs">
                  Open claim #{data.claim_id} →
                </Link>
              }
            >
              <ClaimUnderTest experiment={data} project={project} />
            </Card>
            {data.status !== 'blocked' && <PlanCard experiment={data} />}
            <BuildCard experiment={data} />
            <RunsCard experiment={data} />
            <Card title="Target project">
              <ProjectFacts project={project} />
            </Card>
          </div>
        </div>
      </div>
      {dialogs}
    </>
  )
}
