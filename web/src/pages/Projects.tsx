import { useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ApiError } from '../api/client'
import { useMatchJobs, useProjects, useRegisterProject, useRematch, useReprofile } from '../api/queries'
import type { Project } from '../api/types'
import { ConfirmDialog, Modal } from '../components/Dialog'
import { BranchIcon, FlaskIcon, RefreshIcon, ServerIcon, SparkIcon } from '../components/Icons'
import { JobStatus } from '../components/JobStatus'
import { useToast } from '../components/Toast'
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Chip,
  DefinitionList,
  EmptyState,
  ErrorState,
  Field,
  InlineError,
  Loading,
  PageHeader,
  RelativeTime,
  cx,
  errorMessage,
} from '../components/ui'
import { humanize, pluralize } from '../lib/format'


function hardwareSummary(project: Project): string {
  const hardware = project.hardware ?? {}
  return [hardware.chip, hardware.memory_gb && `${hardware.memory_gb} GB`, hardware.accelerator].filter(Boolean).join(' · ') || 'hardware not described'
}

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
    return `The lab-api could not profile the repository (HTTP ${error.status}: ${error.message}). Check that ${project ? `${project.repo_path}/lab.yaml` : 'its lab.yaml'} exists and is valid.`
  return errorMessage(error)
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
      footer={
        <>
          <Button onClick={onClose} disabled={register.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={register.isPending} disabled={!path || !!pathError}>
            {register.isPending ? 'Profiling…' : 'Register'}
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
          The repository must contain a <code className="code-inline">lab.yaml</code> describing its hardware, models, metrics, workloads and commands. PaperAtlas
          reads it (plus git branch/sha and the registered techniques) and uses it to rank claims and plan experiments.
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

// ---- re-match job -----------------------------------------------------------------------------

function RematchDialog({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const rematch = useRematch(project.id)
  const toast = useToast()
  const [useLlm, setUseLlm] = useState(true)
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Re-match claims to ${project.name}?`}
      confirmLabel="Queue re-match"
      loading={rematch.isPending}
      error={rematch.error}
      onConfirm={() =>
        rematch.mutate(useLlm, {
          onSuccess: (job) => {
            toast.success(`Queued job #${job.job_id} (${job.kind})`)
            onClose()
          },
        })
      }
    >
      <p className="mb-3 text-muted">
        Re-scores every claim card against this project’s profile (fit, claimed gain, effort, blockers) and refreshes its recommendations. Runs on the worker.
      </p>
      <Checkbox id="rematch-llm" checked={useLlm} onChange={setUseLlm} label="LLM review of the top candidates" description="Adds rationales and extra blockers; needs an LLM API key on the worker." />
    </ConfirmDialog>
  )
}

// ---- profile ---------------------------------------------------------------------------------

function Section({ title, children, count }: { title: string; children: ReactNode; count?: number }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
        {title}
        {count !== undefined && <span className="ml-1 font-normal normal-case">({count})</span>}
      </h3>
      {children}
    </section>
  )
}

function ProjectProfile({ project }: { project: Project }) {
  const hardware = Object.entries(project.hardware ?? {})
  const models = Object.entries(project.models ?? {})
  const metrics = project.metrics ?? []
  const workloads = workloadsOf(project)
  const constraints = project.constraints ?? []
  const techniques = project.techniques ?? []
  const repo = project.repo ?? {}
  return (
    <div className="space-y-6">
      {project.description && <p className="text-sm text-fg">{project.description}</p>}
      <DefinitionList
        items={[
          ['Repository', <code key="path" className="text-xs break-all">{project.repo_path}</code>],
          [
            'Git',
            repo.branch || repo.sha ? (
              <span key="git" className="inline-flex flex-wrap items-center gap-1.5">
                <BranchIcon size={14} className="text-muted" />
                <code className="code-inline">{repo.branch ?? '—'}</code>
                {repo.sha && <code className="code-inline">{repo.sha.slice(0, 10)}</code>}
                {repo.remote && <span className="text-xs text-muted">{repo.remote}</span>}
              </span>
            ) : (
              <span className="text-muted">not a git repository</span>
            ),
          ],
          ['Profiled', <RelativeTime key="profiled" iso={project.profiled_at} />],
        ]}
      />

      <Section title="Hardware">
        {hardware.length === 0 ? (
          <p className="text-sm text-muted">Not described in lab.yaml.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {hardware.map(([key, value]) => (
              <Chip key={key} tone={typeof value === 'boolean' ? (value ? 'success' : 'neutral') : 'accent'}>
                {humanize(key)}: {typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value)}
              </Chip>
            ))}
          </div>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Models" count={models.length}>
          <ul className="space-y-1.5 text-sm">
            {models.map(([alias, model]) => (
              <li key={alias} className="flex flex-wrap items-baseline gap-x-2">
                <code className="code-inline">{alias}</code>
                <span>{typeof model === 'string' ? model : model.id ?? '—'}</span>
                {typeof model !== 'string' && model.dtype && <span className="text-xs text-muted">{model.dtype}</span>}
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Workloads" count={workloads.length}>
          <ul className="space-y-1.5 text-sm">
            {workloads.map((workload) => (
              <li key={workload.name}>
                <code className="code-inline">{workload.name}</code>
                {workload.description && <span className="ml-2 text-muted">{workload.description}</span>}
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <Section title="Metrics" count={metrics.length}>
        <div className="overflow-x-auto rounded-md border border-line-muted">
          <table className="w-full text-sm">
            <caption className="sr-only">Benchmark metrics</caption>
            <thead className="bg-canvas-subtle text-left text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Metric
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Better
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Unit
                </th>
                <th scope="col" className="hidden px-3 py-1.5 font-medium sm:table-cell">
                  Description
                </th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={metric.name} className="border-t border-line-muted">
                  <td className="px-3 py-1.5">
                    <code className="code-inline">{metric.name}</code>
                  </td>
                  <td className="px-3 py-1.5 text-xs text-muted">{String(metric.direction ?? '').includes('lower') ? 'lower' : 'higher'}</td>
                  <td className="px-3 py-1.5 text-xs text-muted">{metric.unit ?? '—'}</td>
                  <td className="hidden px-3 py-1.5 text-xs text-muted sm:table-cell">{metric.description ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Constraints" count={constraints.length}>
          {constraints.length === 0 ? (
            <p className="text-sm text-muted">None listed.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {constraints.map((constraint) => (
                <li key={constraint}>{constraint}</li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Registered techniques" count={techniques.length}>
          {techniques.length === 0 ? (
            <p className="text-sm text-muted">No feature-flag techniques found yet.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {techniques.map((technique) => (
                <li key={technique.name}>
                  <code className="code-inline">{technique.name}</code>
                  {technique.hooks?.map((hook) => (
                    <span key={hook} className="ml-1 rounded bg-canvas-inset px-1.5 py-0.5 text-[11px] text-muted">
                      {hook}
                    </span>
                  ))}
                  {technique.description && <div className="text-xs text-muted">{technique.description}</div>}
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
  const reprofile = useReprofile(project.id)
  const jobs = useMatchJobs(project.id)
  const toast = useToast()
  const [rematchOpen, setRematchOpen] = useState(false)
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
        <>
          <Button
            size="sm"
            icon={<RefreshIcon size={14} />}
            loading={reprofile.isPending}
            onClick={() =>
              reprofile.mutate(undefined, {
                onSuccess: (updated) => toast.success(`Re-profiled ${updated.name} from lab.yaml`),
                onError: (error) => toast.error(profileError(error, project)),
              })
            }
          >
            Re-profile
          </Button>
          <Button size="sm" icon={<SparkIcon size={14} />} onClick={() => setRematchOpen(true)}>
            Re-match
          </Button>
        </>
      }
    >
      <div className="mb-5 flex flex-wrap gap-3 text-sm">
        <Link to={`/recommendations?project=${project.id}`} className="inline-flex items-center gap-1">
          <SparkIcon size={14} /> Recommendations
        </Link>
        <Link to={`/experiments?tab=all&project=${project.id}`} className="inline-flex items-center gap-1">
          <FlaskIcon size={14} /> Experiments
        </Link>
      </div>
      {reprofile.isError && (
        <div className="mb-5">
          <Banner tone="danger">{profileError(reprofile.error, project)}</Banner>
        </div>
      )}
      {latestJob && (
        <div className="mb-6">
          <JobStatus
            job={latestJob}
            title={`Re-match job #${latestJob.id}`}
            action={
              latestJob.status === 'done' ? (
                <Link to={`/recommendations?project=${project.id}`} className="ml-auto text-xs">
                  View recommendations
                </Link>
              ) : undefined
            }
          />
          {jobs.data && jobs.data.length > 1 && <p className="mt-1 text-xs text-muted">{pluralize(jobs.data.length - 1, 'earlier re-match job')} on the System page.</p>}
        </div>
      )}
      <ProjectProfile project={project} />
      <RematchDialog project={project} open={rematchOpen} onClose={() => setRematchOpen(false)} />
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
        description="Target repositories that experiments run against. Each one describes itself in a lab.yaml: hardware, models, metrics, workloads, constraints and commands."
        actions={
          <Button variant="primary" onClick={() => setRegisterOpen(true)}>
            Register project
          </Button>
        }
      />
      {projects.isLoading ? (
        <Loading label="Loading projects…" />
      ) : projects.isError ? (
        <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
      ) : !projects.data?.length ? (
        <EmptyState title="No projects yet" icon={<ServerIcon size={28} />} action={<Button onClick={() => setRegisterOpen(true)}>Register project</Button>}>
          Register the repository you want to improve. It needs a <code className="code-inline">lab.yaml</code> at its root.
        </EmptyState>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <nav aria-label="Projects" className="min-w-0 space-y-2 self-start">
            {projects.data.map((project) => {
              const active = project.id === selected?.id
              return (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => select(project.id)}
                  aria-current={active ? 'true' : undefined}
                  className={cx(
                    'card block w-full px-4 py-3 text-left transition-colors',
                    active ? 'border-accent ring-1 ring-accent' : 'hover:border-subtle/60',
                  )}
                >
                  <div className="font-semibold text-fg">{project.name}</div>
                  <div className="truncate font-mono text-[11px] text-muted" title={project.repo_path}>
                    {project.repo_path}
                  </div>
                  <div className="mt-1 text-xs text-muted">{hardwareSummary(project)}</div>
                  <div className="mt-1 text-xs text-muted">
                    {pluralize(project.metrics?.length ?? 0, 'metric')} · {pluralize(project.techniques?.length ?? 0, 'technique')} · profiled{' '}
                    <RelativeTime iso={project.profiled_at} />
                  </div>
                </button>
              )
            })}
          </nav>
          {selected && <ProjectDetail key={selected.id} project={selected} />}
        </div>
      )}
      <RegisterDialog open={registerOpen} onClose={() => setRegisterOpen(false)} onRegistered={(project) => select(project.id)} />
    </>
  )
}
