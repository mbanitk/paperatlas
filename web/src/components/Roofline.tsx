import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useMeasureRoofline, useRooflineJobs } from '../api/queries'
import type { Job, Project, Roofline } from '../api/types'
import { formatNumber, pluralize } from '../lib/format'
import { bandwidthLimit, bandwidthUtilization, bottleneckInfo, bottleneckOf, numericSeries, singleStepMs, type CurvePoint } from '../lib/roofline'
import { ConfirmDialog } from './Dialog'
import { PulseIcon } from './Icons'
import { JobStatus } from './JobStatus'
import { useToast } from './Toast'
import { Button, Checkbox, Chip, cx, Field, RelativeTime, TONE_CLASSES } from './ui'

const ACTIVE = new Set(['queued', 'running'])

function Tile({ title, hint, children, className }: { title: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cx('min-w-0 rounded-md border border-line-muted px-3 py-2.5', className)}>
      <h4 className="text-xs font-semibold text-muted">{title}</h4>
      {hint && <p className="text-[11px] text-subtle">{hint}</p>}
      <div className="mt-2">{children}</div>
    </section>
  )
}

/** Decode speed against the memory-bandwidth limit, with the overhead / mixed / bandwidth zones. */
function BandwidthGauge({ roofline }: { roofline: Roofline }) {
  const utilization = bandwidthUtilization(roofline)
  const limit = bandwidthLimit(roofline)
  const speed = roofline.decode?.tokens_per_s
  const info = bottleneckInfo(bottleneckOf(utilization))
  const pct = utilization === null ? null : Math.max(0, Math.min(1, utilization)) * 100
  const model = roofline.model ?? {}
  const hardware = roofline.hardware ?? {}
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-2xl font-semibold text-fg tabular-nums">{typeof speed === 'number' ? formatNumber(speed, 1) : '—'}</span>
        <span className="text-sm text-muted">tok/s decode</span>
        {limit !== null && <span className="text-sm text-muted">of a {formatNumber(limit, 0)} tok/s bandwidth limit</span>}
        <span className={cx('chip ml-auto font-semibold', TONE_CLASSES[info.tone])} title={info.description}>
          {info.label}
        </span>
      </div>
      <div className="relative mt-3 mb-1" role="meter" aria-label="Memory-bandwidth utilization" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === null ? undefined : Math.round(pct)}>
        <div className="flex h-3 overflow-hidden rounded-full">
          <div className="w-[40%] bg-attention-subtle" title="overhead-bound (< 40%)" />
          <div className="w-[20%] bg-neutral-subtle" title="mixed (40–60%)" />
          <div className="w-[40%] bg-success-subtle" title="bandwidth-bound (≥ 60%)" />
        </div>
        {pct !== null && (
          <>
            <div
              className={cx(
                'absolute inset-y-0 left-0 rounded-full opacity-85',
                info.tone === 'success' ? 'bg-success-emphasis' : info.tone === 'attention' ? 'bg-attention-emphasis' : 'bg-subtle',
              )}
              style={{ width: `${pct}%` }}
              aria-hidden="true"
            />
            <span className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-canvas bg-fg shadow" style={{ left: `${pct}%` }} aria-hidden="true" />
          </>
        )}
      </div>
      <div className="relative h-4 text-[10.5px] text-subtle tabular-nums" aria-hidden="true">
        <span className="absolute left-0">0%</span>
        <span className="absolute left-[40%] -translate-x-1/2">40%</span>
        <span className="absolute left-[60%] -translate-x-1/2">60%</span>
        <span className="absolute right-0">100%</span>
      </div>
      <div className="flex text-[10.5px] text-subtle" aria-hidden="true">
        <span className="w-[40%]">overhead-bound</span>
        <span className="w-[20%] text-center">mixed</span>
        <span className="w-[40%] text-right">bandwidth-bound</span>
      </div>
      <p className="mt-1.5 text-xs text-muted">
        {pct !== null ? <strong className="text-fg">{formatNumber(pct, 0)}% of the memory-bandwidth limit</strong> : 'Utilization not reported'}
        {typeof hardware.peak_bandwidth_gbs === 'number' && <> · {formatNumber(hardware.peak_bandwidth_gbs, 0)} GB/s peak</>}
        {typeof model.bytes_per_token_gb === 'number' && <> · {formatNumber(model.bytes_per_token_gb, 2)} GB read per token</>}
        {typeof roofline.decode?.achieved_bandwidth_gbs === 'number' && <> · {formatNumber(roofline.decode.achieved_bandwidth_gbs, 0)} GB/s achieved</>}
      </p>
      <p className="mt-0.5 text-xs text-subtle">{info.description}</p>
    </div>
  )
}

/** Tiny line chart of the forward-pass cost vs tokens appended (the verification cost curve). */
export function CostCurve({ points, step }: { points: CurvePoint[]; step: number | null }) {
  if (points.length < 2) return <p className="text-xs text-muted">Not measured.</p>
  const width = 260
  const height = 120
  const pad = { left: 30, right: 10, top: 12, bottom: 22 }
  const xs = points.map((p) => Math.log2(p.x))
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...points.map((p) => p.y), step ?? 0) * 1.08
  const x = (value: number) => pad.left + ((Math.log2(value) - minX) / (maxX - minX || 1)) * (width - pad.left - pad.right)
  const y = (value: number) => pad.top + (1 - value / maxY) * (height - pad.top - pad.bottom)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  const ratio = step ? last.y / step : null
  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Forward pass cost: ${points.map((p) => `${p.x} tokens ${formatNumber(p.y, 1)} ms`).join(', ')}`}
      >
        <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke="#d1d9e0" />
        <line x1={pad.left} x2={pad.left} y1={pad.top} y2={height - pad.bottom} stroke="#d1d9e0" />
        <text x={pad.left - 4} y={y(maxY / 1.08) + 3} textAnchor="end" fontSize={9} fill="#818b98">
          {formatNumber(maxY / 1.08, 0)}
        </text>
        <text x={pad.left - 4} y={height - pad.bottom + 3} textAnchor="end" fontSize={9} fill="#818b98">
          0
        </text>
        {step !== null && (
          <g>
            <line x1={pad.left} x2={width - pad.right} y1={y(step)} y2={y(step)} stroke="#8250df" strokeDasharray="3 3" strokeWidth={1.2} />
            <text x={width - pad.right} y={y(step) + 11} textAnchor="end" fontSize={9.5} fill="#8250df" fontWeight={600}>
              1 step {formatNumber(step, 1)} ms
            </text>
          </g>
        )}
        <path d={path} fill="none" stroke="#0969da" strokeWidth={2} strokeLinejoin="round" />
        {points.map((p) => (
          <g key={p.x}>
            <circle cx={x(p.x)} cy={y(p.y)} r={p.x === 1 ? 4 : 3} fill={p.x === 1 ? '#8250df' : '#0969da'} stroke="#fff" strokeWidth={1.5} />
            <text x={x(p.x)} y={height - pad.bottom + 13} textAnchor="middle" fontSize={9} fill="#59636e">
              {p.x}
            </text>
          </g>
        ))}
        <text x={x(last.x)} y={y(last.y) - 7} textAnchor="end" fontSize={9.5} fill="#0969da" fontWeight={600}>
          {formatNumber(last.y, 1)} ms
        </text>
      </svg>
      <figcaption className="text-[11px] text-muted">
        tokens per forward pass (ms)
        {ratio !== null && (
          <>
            {' '}
            · verifying {last.x} tokens costs <strong className="text-fg">{formatNumber(ratio, 2)}×</strong> a step
          </>
        )}
      </figcaption>
    </figure>
  )
}

function BatchBars({ points }: { points: CurvePoint[] }) {
  if (!points.length) return <p className="text-xs text-muted">Not measured.</p>
  const max = Math.max(...points.map((p) => p.y))
  const single = points.find((p) => p.x === 1)?.y
  const top = points[points.length - 1]
  return (
    <div>
      <ul className="space-y-1">
        {points.map((p) => (
          <li key={p.x} className="grid grid-cols-[3.2rem_minmax(0,1fr)_3.2rem] items-center gap-2 text-xs">
            <span className="text-muted">batch {p.x}</span>
            <span className="h-2 overflow-hidden rounded-full bg-canvas-inset">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${(p.y / max) * 100}%` }} />
            </span>
            <span className="text-right text-fg tabular-nums">{formatNumber(p.y, 0)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[11px] text-muted">
        tok/s across the batch
        {single && top.x > 1 && (
          <>
            {' '}
            · <strong className="text-fg">{formatNumber(top.y / single, 1)}×</strong> at batch {top.x}
          </>
        )}
      </p>
    </div>
  )
}

function DraftVsTarget({ roofline }: { roofline: Roofline }) {
  const target = singleStepMs(roofline)
  const draft = roofline.draft?.ms_per_token
  const prefill = roofline.prefill_tokens_per_s
  const rows = [
    { label: 'target', value: target, title: roofline.model?.id ?? 'target model', className: 'bg-done' },
    { label: 'draft', value: typeof draft === 'number' ? draft : null, title: roofline.draft?.id ?? 'draft model', className: 'bg-attention-emphasis' },
  ]
  const max = Math.max(...rows.map((row) => row.value ?? 0)) || 1
  return (
    <div>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.label} className="grid grid-cols-[3.2rem_minmax(0,1fr)_3.6rem] items-center gap-2 text-xs" title={row.title}>
            <span className="text-muted">{row.label}</span>
            <span className="h-2 overflow-hidden rounded-full bg-canvas-inset">
              {row.value !== null && <span className={cx('block h-full rounded-full', row.className)} style={{ width: `${(row.value / max) * 100}%` }} />}
            </span>
            <span className="text-right text-fg tabular-nums">{row.value !== null ? `${formatNumber(row.value, 1)} ms` : '—'}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[11px] text-muted">
        ms per token
        {typeof draft === 'number' && target ? (
          <>
            {' '}
            · a draft token costs <strong className="text-fg">{formatNumber((draft / target) * 100, 0)}%</strong> of a target step
          </>
        ) : null}
      </p>
      {roofline.draft?.id && <p className="truncate text-[11px] text-subtle" title={roofline.draft.id}>draft: {roofline.draft.id}</p>}
      <div className="mt-2 border-t border-line-muted pt-2 text-xs">
        <span className="text-muted">Prefill </span>
        <strong className="text-fg tabular-nums">{typeof prefill === 'number' ? `${formatNumber(prefill, 0)} tok/s` : '—'}</strong>
      </div>
    </div>
  )
}

function modelLine(roofline: Roofline): string {
  const model = roofline.model ?? {}
  const hardware = roofline.hardware ?? {}
  return [
    model.id,
    model.quantization,
    typeof model.active_params_b === 'number' &&
      `${formatNumber(model.active_params_b, 1)}B active${typeof model.total_params_b === 'number' ? ` / ${formatNumber(model.total_params_b, 1)}B total` : ''}`,
    hardware.chip,
    typeof hardware.memory_gb === 'number' && `${hardware.memory_gb} GB`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function jobSummary(job: Job): string | undefined {
  const decode = (job.result?.decode ?? null) as Roofline['decode']
  if (!decode) return undefined
  const parts = [
    typeof decode.tokens_per_s === 'number' && `decode ${formatNumber(decode.tokens_per_s, 1)} tok/s`,
    typeof decode.bandwidth_utilization === 'number' && `${formatNumber(decode.bandwidth_utilization * 100, 0)}% of bandwidth`,
  ].filter(Boolean)
  return parts.join(' · ') || undefined
}

function MeasureDialog({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const measure = useMeasureRoofline(project.id)
  const toast = useToast()
  const aliases = Object.keys(project.models ?? {})
  const [model, setModel] = useState(aliases.includes('eval') ? 'eval' : (aliases[0] ?? 'eval'))
  const [rematch, setRematch] = useState(true)
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Measure the roofline of ${project.name}?`}
      confirmLabel="Queue measurement"
      loading={measure.isPending}
      error={measure.error}
      onConfirm={() =>
        measure.mutate(
          { model, rematch },
          {
            onSuccess: (job) => {
              toast.success(`Queued job #${job.job_id} (${job.kind})`)
              onClose()
            },
          },
        )
      }
    >
      <p className="mb-3 text-muted">
        Runs the project’s <code className="code-inline">commands.profile</code> on the worker under the GPU lock: decode speed vs the memory-bandwidth limit, the
        cost of one forward pass for 1–16 tokens, batched decode and the draft model. The cost model uses it to predict what each claim can gain here.
      </p>
      <div className="space-y-3">
        {aliases.length > 1 && (
          <Field label="Model" htmlFor="roofline-model">
            <select id="roofline-model" className="input" value={model} onChange={(event) => setModel(event.target.value)}>
              {aliases.map((alias) => (
                <option key={alias} value={alias}>
                  {alias}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Checkbox id="roofline-rematch" checked={rematch} onChange={setRematch} label="Re-rank claims afterwards" description="Re-match with the new predictions (blocks claims the cost model calls unlikely)." />
      </div>
    </ConfirmDialog>
  )
}

/** The engine roofline of a project: where decode time goes, which the cost model turns into per-claim predictions. */
export function RooflineCard({ project }: { project: Project }) {
  const jobs = useRooflineJobs(project.id)
  const [open, setOpen] = useState(false)
  const roofline = project.roofline
  const latest = jobs.data?.[0]
  const running = !!latest && ACTIVE.has(latest.status)
  // A finished job whose roofline is already shown below is noise; keep active and failed jobs and anything newer.
  const showJob =
    !!latest && (running || latest.status !== 'done' || !project.roofline_at || Date.parse(latest.created_at ?? '') > Date.parse(project.roofline_at))
  const curve = numericSeries(roofline?.forward_cost_ms)
  const batches = numericSeries(roofline?.batch_decode_tokens_per_s)

  return (
    <section className="rounded-lg border border-line" aria-labelledby={`roofline-${project.id}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-muted px-4 py-2.5">
        <h3 id={`roofline-${project.id}`} className="flex items-center gap-2 text-sm font-semibold">
          <PulseIcon size={14} className="text-accent" /> Engine roofline
        </h3>
        <span className="text-xs text-muted">
          {project.roofline_at ? (
            <>
              measured <RelativeTime iso={project.roofline_at} />
            </>
          ) : (
            'not measured'
          )}
        </span>
        <Button size="sm" className="ml-auto" icon={<PulseIcon size={14} />} onClick={() => setOpen(true)} disabled={running} loading={running}>
          {running ? 'Measuring…' : roofline ? 'Re-measure' : 'Measure roofline'}
        </Button>
      </header>
      <div className="space-y-3 p-4">
        {showJob && latest && (
          <JobStatus
            job={latest}
            title={`Roofline job #${latest.id}`}
            summary={jobSummary(latest)}
            action={
              latest.status === 'done' && latest.payload?.rematch !== false ? (
                <Link to={`/recommendations?project=${project.id}`} className="ml-auto text-xs">
                  View re-ranked recommendations
                </Link>
              ) : undefined
            }
          />
        )}
        {!roofline ? (
          <div className="rounded-md border border-dashed border-line px-4 py-5 text-center text-sm text-muted">
            <p>
              <strong className="text-fg">Not measured yet</strong> — predictions are unknown until you measure.
            </p>
            <p className="mt-1 text-xs">Measuring takes a few minutes on the GPU and re-ranks the claims for this project.</p>
          </div>
        ) : (
          <>
            {modelLine(roofline) && <p className="text-xs text-muted">{modelLine(roofline)}</p>}
            <BandwidthGauge roofline={roofline} />
            <div className="grid gap-3 md:grid-cols-3">
              <Tile title="Verification cost" hint="one forward pass appending N tokens">
                <CostCurve points={curve} step={singleStepMs(roofline)} />
              </Tile>
              <Tile title="Batched decode" hint={batches.length ? `${pluralize(batches.length, 'batch size')} measured` : undefined}>
                <BatchBars points={batches} />
              </Tile>
              <Tile title="Draft vs target" hint="cost of one token">
                <DraftVsTarget roofline={roofline} />
              </Tile>
            </div>
          </>
        )}
      </div>
      {open && <MeasureDialog project={project} open={open} onClose={() => setOpen(false)} />}
    </section>
  )
}

/** One-line roofline summary for project lists. */
export function RooflineSummary({ roofline }: { roofline: Roofline | null | undefined }) {
  if (!roofline) return <span className="text-subtle">roofline not measured</span>
  const utilization = bandwidthUtilization(roofline)
  const info = bottleneckInfo(bottleneckOf(utilization))
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {typeof roofline.decode?.tokens_per_s === 'number' && <span>{formatNumber(roofline.decode.tokens_per_s, 0)} tok/s</span>}
      {utilization !== null && <span>· {formatNumber(utilization * 100, 0)}% of bandwidth</span>}
      <Chip tone={info.tone} className="px-1.5 py-0 text-[10.5px]">
        {info.label}
      </Chip>
    </span>
  )
}
