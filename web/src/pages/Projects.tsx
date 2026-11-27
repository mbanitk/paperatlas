import { useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useRole,
} from '@floating-ui/react'
import { ApiError } from '../api/client'
import { useMatchJobs, useProjects, useRegisterProject, useRematch, useReprofile } from '../api/queries'
import type { Project, ProjectMetric } from '../api/types'
import { CodeToken, MetricName, Tag } from '../components/Badges'
import { ConfirmDialog, Modal } from '../components/Dialog'
import { ArrowRightIcon, BranchIcon, ChevronDown, FlaskIcon, RefreshIcon, ServerIcon, SparkIcon } from '../components/Icons'
import { JobStatus } from '../components/JobStatus'
import { RooflineCard, RooflineSummary } from '../components/Roofline'
import { DataTable } from '../components/Table'
import { useToast } from '../components/Toast'
import { floatingMiddleware, useExclusiveOpen } from '../components/Tooltip'
import {
  Button,
  Card,
  Checkbox,
  DefinitionList,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  InlineError,
  PageHeader,
  RelativeTime,
  Skeleton,
  cx,
  errorMessage,
} from '../components/ui'
import { pluralize } from '../lib/format'
import { jobResultSummary } from '../lib/overviewJobs'
import { hardwareFacts, hardwareSummary } from '../lib/overviewProject'

function workloadsOf(project: Project): { name: string; description?: string }[] {
  const workloads = project.workloads
  if (!workloads) return []
  if (Array.isArray(workloads)) return workloads.map((item) => (typeof item === 'string' ? { name: item } : item))
  return Object.entries(workloads).map(([name, value]) => ({
    name,
    description: typeof value === 'string' ? value : value && typeof value === 'object' && 'description' in value ? String((value as { description: unknown }).description) : undefined,
  }))
}

function profileError(error: unknown, project?: Project): string {
  if (error instanceof ApiError && error.status >= 500)
    return `The lab-api couldn’t read the project (HTTP ${error.status}: ${error.message}). Check that ${project ? `${project.repo_path}/lab.yaml` : 'its lab.yaml'} exists and is valid.`
  return errorMessage(error)
}

// ---- actions menu --------------------------------------------------------------------------------------

interface MenuItem {
  label: string
  description: string
  icon: ReactNode
  onSelect: () => void
}

/** "Actions ▾": every item opens a confirm, so nothing runs from a single click (PR-1). */
function ActionsMenu({ items, label = 'Actions' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<number | null>(null)
  const arrowRef = useRef<Element | null>(null)
  const listRef = useRef<(HTMLElement | null)[]>([])
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: floatingMiddleware(arrowRef, 320),
  })
  useExclusiveOpen(open, () => setOpen(false), { sticky: true, reference: () => refs.domReference.current, floating: () => refs.floating.current })
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    useClick(context),
    useDismiss(context),
    useRole(context, { role: 'menu' }),
    useListNavigation(context, { listRef, activeIndex: active, onNavigate: setActive, loop: true }),
  ])
  return (
    <>
      <Button size="sm" ref={refs.setReference} {...getReferenceProps()}>
        {label}
        <ChevronDown size={14} />
      </Button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={{ ...floatingStyles, zIndex: 'var(--z-popover)' }}
              className="w-72 overflow-auto rounded-lg border border-line bg-canvas py-1 shadow-lg"
              {...getFloatingProps()}
            >
              {items.map((item, index) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  ref={(node) => {
                    listRef.current[index] = node
                  }}
                  tabIndex={active === index ? 0 : -1}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-canvas-subtle focus-visible:bg-canvas-subtle focus-visible:outline-none"
                  {...getItemProps({
                    onClick: () => {
                      setOpen(false)
                      item.onSelect()
                    },
                  })}
                >
                  <span className="mt-0.5 shrink-0 text-muted">{item.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-fg">{item.label}</span>
                    <span className="block text-xs text-muted">{item.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}

// ---- register ------------------------------------------------------------------------------

function RegisterDialog({ open, onClose, onRegistered }: { open: boolean; onClose: () => void; onRegistered: (project: Project) => void }) {
  const register = useRegisterProject()
  const toast = useToast()
  const [repoPath, setRepoPath] = useState('')
  const [name, setName] = useState('')
  const path = repoPath.trim()
  const pathError = path && !path.startsWith('/') && !path.startsWith('~') ? 'Use an absolute path on the machine running the lab-api.' : undefined

  const submit = () =>
    register.mutate(
      { repo_path: path, name: name.trim() || null },
      {
        onSuccess: (project) => {
          toast.success(`Registered ${project.name}`)
          setRepoPath('')
          setName('')
          register.reset()
          onRegistered(project)
          onClose()
        },
      },
    )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Register a project"
      initialFocus="first-field"
      footer={
        <>
          <Button onClick={onClose} disabled={register.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={register.isPending} disabled={!path || !!pathError}>
            {register.isPending ? 'Reading lab.yaml…' : 'Register'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (path && !pathError) submit()
        }}
        className="space-y-4"
      >
        <p className="text-muted">
          The repository needs a <code className="code-inline">lab.yaml</code> that describes its hardware, models, metrics, workloads and commands.
          PaperAtlas reads it, plus the git branch and the registered techniques, to rank claims and plan experiments.
        </p>
        <Field label="Repository path" htmlFor="project-path" error={pathError} hint="Local path on the machine running the services, e.g. /Users/you/dev/my-server">
          <input
            id="project-path"
            className="input font-mono"
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            placeholder="/path/to/repo"
            autoComplete="off"
            spellCheck={false}
            required
            aria-invalid={!!pathError}
          />
        </Field>
        <Field label="Name (optional)" htmlFor="project-name" hint="Defaults to the name in lab.yaml. Registering an existing name updates that project.">
          <input id="project-name" className="input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        </Field>
        <button type="submit" hidden />
      </form>
      <InlineError error={register.error ? profileError(register.error) : null} />
    </Modal>
  )
}

// ---- reload lab.yaml / re-rank claims (both confirm first) ---------------------------------------------

function ReloadDialog({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const reprofile = useReprofile(project.id)
  const toast = useToast()
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Reload lab.yaml for ${project.name}?`}
      confirmLabel="Reload lab.yaml"
      loading={reprofile.isPending}
      error={reprofile.error ? profileError(reprofile.error, project) : null}
      cost="Takes a few seconds. Doesn’t re-rank claims or touch experiments."
      onConfirm={() =>
        reprofile.mutate(undefined, {
          onSuccess: (updated) => {
            toast.success(`Reloaded lab.yaml for ${updated.name}`)
            onClose()
          },
        })
      }
    >
      <p className="text-muted">
        Reads <code className="code-inline break-all">{project.repo_path}/lab.yaml</code> again and updates the hardware, models, metrics, workloads,
        constraints and techniques shown here.
      </p>
    </ConfirmDialog>
  )
}

function RematchDialog({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const rematch = useRematch(project.id)
  const toast = useToast()
  const [useLlm, setUseLlm] = useState(true)
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Re-rank claims for ${project.name}?`}
      confirmLabel="Re-rank claims"
      loading={rematch.isPending}
      error={rematch.error}
      initialFocus="cancel"
      cost={useLlm ? 'Runs on the worker. A few minutes, and uses the LLM API for the review.' : 'Runs on the worker. About a minute.'}
      onConfirm={() =>
        rematch.mutate(useLlm, {
          onSuccess: (job) => {
            toast.success(`Queued job #${job.job_id}: re-rank claims`)
            onClose()
          },
        })
      }
    >
      <p className="mb-3 text-muted">
        Scores every claim card against this project (fit, the paper’s gain, effort and blockers) and refreshes its recommendations.
      </p>
      <Checkbox
        id="rematch-llm"
        checked={useLlm}
        onChange={setUseLlm}
        label="Ask the LLM to review the top candidates"
        description="Adds a short rationale and any extra blockers. Needs an LLM API key on the worker."
      />
    </ConfirmDialog>
  )
}

// ---- profile ---------------------------------------------------------------------------------

function Section({ title, children, count, hint }: { title: string; children: ReactNode; count?: number; hint?: ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="text-sm font-semibold text-fg">
        {title}
        {count !== undefined && <span className="ml-1 font-normal text-muted">({count})</span>}
      </h3>
      {hint && <p className="text-xs text-muted">{hint}</p>}
      <div className="mt-2">{children}</div>
    </section>
  )
}

function About({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 260
  return (
    <div>
      <p className={cx('max-w-3xl text-sm text-fg', long && !open && 'line-clamp-3')}>{text}</p>
      {long && (
        <button type="button" className="mt-1 inline-flex min-h-6 items-center text-sm font-medium text-info-fg hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

const METRIC_COLUMNS = [
  {
    key: 'metric',
    header: 'Metric',
    cell: (metric: ProjectMetric) => <MetricName metric={metric.name} showId className="font-medium text-fg" />,
  },
  {
    key: 'better',
    header: 'Better when',
    nowrap: true,
    cell: (metric: ProjectMetric) => <span className="text-muted">{String(metric.direction ?? '').includes('lower') ? 'Lower' : 'Higher'}</span>,
  },
  { key: 'description', header: 'What it measures', cell: (metric: ProjectMetric) => <span className="text-muted">{metric.description || 'Not described'}</span> },
]

function ProjectProfile({ project }: { project: Project }) {
  const hardware = hardwareFacts(project.hardware)
  const models = Object.entries(project.models ?? {})
  const metrics = project.metrics ?? []
  const workloads = workloadsOf(project)
  const constraints = project.constraints ?? []
  const techniques = project.techniques ?? []
  const repo = project.repo ?? {}
  return (
    <div className="space-y-6">
      <Section title="About this project">
        {project.description && <About text={project.description} />}
        <DefinitionList
          className="mt-3"
          items={[
            ['Repository', <code key="path" className="font-mono text-xs break-all">{project.repo_path}</code>],
            [
              'Git',
              repo.branch || repo.sha ? (
                <span key="git" className="inline-flex flex-wrap items-center gap-1.5">
                  <BranchIcon size={14} className="text-muted" />
                  {repo.branch && <CodeToken label="branch">{repo.branch}</CodeToken>}
                  {repo.sha && <CodeToken label="commit">{repo.sha.slice(0, 10)}</CodeToken>}
                  {repo.remote && <span className="text-xs text-muted break-all">{repo.remote}</span>}
                </span>
              ) : (
                <span className="text-muted">Not a git repository</span>
              ),
            ],
            ['lab.yaml read', <RelativeTime key="profiled" iso={project.profiled_at} />],
          ]}
        />
      </Section>

      <Section title="Hardware">
        {hardware.length === 0 ? (
          <p className="text-sm text-muted">Not described in lab.yaml.</p>
        ) : (
          <DefinitionList items={hardware.map((fact) => [fact.label, <span key={fact.key}>{fact.value}</span>] as [ReactNode, ReactNode])} />
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Models" count={models.length}>
          <ul className="space-y-2 text-sm">
            {models.map(([alias, model]) => {
              const extra = typeof model === 'string' ? {} : (model as { quantization?: unknown; dtype?: unknown; role?: unknown })
              const details = [extra.quantization, extra.dtype, extra.role].filter((value): value is string => typeof value === 'string' && !!value)
              return (
                <li key={alias} className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <CodeToken>{alias}</CodeToken>
                    <span className="min-w-0 [overflow-wrap:anywhere]">{typeof model === 'string' ? model : (model.id ?? 'Not named')}</span>
                  </div>
                  {details.length > 0 && <div className="text-xs text-muted">{details.join(' · ')}</div>}
                </li>
              )
            })}
          </ul>
        </Section>
        <Section title="Workloads" count={workloads.length} hint="The request mixes the A/B benchmark can run.">
          <ul className="space-y-2 text-sm">
            {workloads.map((workload) => (
              <li key={workload.name} className="min-w-0">
                <CodeToken>{workload.name}</CodeToken>
                {workload.description && <div className="text-muted">{workload.description}</div>}
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <Section title="Metrics" count={metrics.length} hint="What the A/B benchmark measures.">
        <DataTable label="Benchmark metrics" rows={metrics} rowKey={(metric) => metric.name} columns={METRIC_COLUMNS} />
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Constraints" count={constraints.length} hint="Rules every experiment on this project must follow.">
          {constraints.length === 0 ? (
            <p className="text-sm text-muted">None listed.</p>
          ) : (
            <>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {constraints.slice(0, 3).map((constraint) => (
                  <li key={constraint}>{constraint}</li>
                ))}
              </ul>
              {constraints.length > 3 && (
                <Disclosure label={`Show ${constraints.length - 3} more`} className="mt-2">
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {constraints.slice(3).map((constraint) => (
                      <li key={constraint}>{constraint}</li>
                    ))}
                  </ul>
                </Disclosure>
              )}
            </>
          )}
        </Section>
        <Section title="Registered techniques" count={techniques.length} hint="Feature-flagged techniques already in the code.">
          {techniques.length === 0 ? (
            <p className="text-sm text-muted">No feature-flag techniques found yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {techniques.map((technique) => (
                <li key={technique.name} className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <CodeToken>{technique.name}</CodeToken>
                    {technique.hooks?.map((hook) => (
                      <Tag key={hook}>{hook}</Tag>
                    ))}
                  </div>
                  {technique.description && <p className="mt-0.5 text-muted">{technique.description}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  )
}

function ProjectDetail({ project }: { project: Project }) {
  const jobs = useMatchJobs(project.id)
  const [dialog, setDialog] = useState<'reload' | 'rematch' | null>(null)
  const latestJob = jobs.data?.[0]

  return (
    <Card
      className="min-w-0"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <ServerIcon className="text-muted" /> {project.name}
          <span className="text-xs font-normal text-muted">#{project.id}</span>
        </span>
      }
      actions={
        <ActionsMenu
          items={[
            {
              label: 'Reload lab.yaml…',
              description: 'Read the project description again after editing it.',
              icon: <RefreshIcon size={14} />,
              onSelect: () => setDialog('reload'),
            },
            {
              label: 'Re-rank claims for this project…',
              description: 'Score every claim again and refresh the recommendations.',
              icon: <SparkIcon size={14} />,
              onSelect: () => setDialog('rematch'),
            },
          ]}
        />
      }
    >
      <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link to={`/recommendations?project=${project.id}`} className="inline-flex min-h-6 items-center gap-1">
          <SparkIcon size={14} /> Recommendations <ArrowRightIcon size={12} />
        </Link>
        <Link to={`/experiments?tab=all&project=${project.id}`} className="inline-flex min-h-6 items-center gap-1">
          <FlaskIcon size={14} /> Experiments <ArrowRightIcon size={12} />
        </Link>
      </div>
      {latestJob && (
        <div className="mb-6">
          <JobStatus
            job={latestJob}
            title={`Re-rank job #${latestJob.id}`}
            summary={jobResultSummary(latestJob) ?? undefined}
            action={
              latestJob.status === 'done' ? (
                <Link to={`/recommendations?project=${project.id}`} className="ml-auto text-sm">
                  View recommendations
                </Link>
              ) : undefined
            }
          />
          {jobs.data && jobs.data.length > 1 && (
            <p className="mt-1 text-xs text-muted">
              {pluralize(jobs.data.length - 1, 'earlier re-rank job')} on the <Link to="/system">System</Link> page.
            </p>
          )}
        </div>
      )}
      <div className="mb-6">
        <RooflineCard project={project} />
      </div>
      <ProjectProfile project={project} />
      {dialog === 'reload' && <ReloadDialog project={project} open onClose={() => setDialog(null)} />}
      {dialog === 'rematch' && <RematchDialog project={project} open onClose={() => setDialog(null)} />}
    </Card>
  )
}

// ---- page ------------------------------------------------------------------------------------

export default function Projects() {
  const projects = useProjects()
  const [params, setParams] = useSearchParams()
  const [registerOpen, setRegisterOpen] = useState(false)
  const selectedId = Number(params.get('project')) || projects.data?.[0]?.id
  const selected = projects.data?.find((project) => project.id === selectedId) ?? projects.data?.[0]
  const select = (id: number) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('project', String(id))
      return next
    })

  return (
    <>
      <PageHeader
        title="Projects"
        description="The code bases experiments run against. Each one describes itself in a lab.yaml: hardware, models, metrics, workloads and rules."
        actions={<Button onClick={() => setRegisterOpen(true)}>Register project…</Button>}
      />
      {projects.isLoading ? (
        <Skeleton variant="card" count={2} />
      ) : projects.isError ? (
        <ErrorState error={projects.error} onRetry={() => projects.refetch()} title="Couldn’t load the projects" />
      ) : !projects.data?.length ? (
        <EmptyState title="No projects yet" icon={<ServerIcon size={28} />} action={<Button onClick={() => setRegisterOpen(true)}>Register project…</Button>}>
          Register the code base you want to improve. It needs a <code className="code-inline">lab.yaml</code> at its root.
        </EmptyState>
      ) : (
        <div className={cx('grid gap-6', projects.data.length > 1 && 'lg:grid-cols-[280px_1fr]')}>
          {projects.data.length > 1 && (
            <nav aria-label="Projects" className="min-w-0 space-y-2 self-start">
              {projects.data.map((project) => (
                <ProjectButton key={project.id} project={project} active={project.id === selected?.id} onSelect={() => select(project.id)} />
              ))}
            </nav>
          )}
          {selected && <ProjectDetail key={selected.id} project={selected} />}
        </div>
      )}
      <RegisterDialog open={registerOpen} onClose={() => setRegisterOpen(false)} onRegistered={(project) => select(project.id)} />
    </>
  )
}

function ProjectButton({ project, active, onSelect }: { project: Project; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cx('card block w-full min-w-0 px-4 py-3 text-left transition-colors', active ? 'border-info ring-1 ring-info/40' : 'hover:border-muted')}
    >
      <div className="font-semibold text-fg">{project.name}</div>
      <div className="font-mono text-xs break-all text-muted">{project.repo_path}</div>
      <div className="mt-1 text-xs text-muted">{hardwareSummary(project.hardware)}</div>
      <div className="mt-1 text-xs text-muted">
        {pluralize(project.metrics?.length ?? 0, 'metric')} · {pluralize(project.techniques?.length ?? 0, 'technique')}
      </div>
      <div className="mt-1 text-xs text-muted">
        <RooflineSummary roofline={project.roofline} />
      </div>
    </button>
  )
}
