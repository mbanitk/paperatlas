import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link } from 'react-router'
import { useMeasureRoofline, useRooflineJobs } from '../api/queries'
import type { Project, Roofline } from '../api/types'
import { formatNumber, pluralize } from '../lib/format'
import { jobResultSummary } from '../lib/overviewJobs'
import { batchTakeaway, draftTakeaway, measuredWith, niceMax, rooflineAnswer, verificationTakeaway } from '../lib/overviewProject'
import { bandwidthLimit, bandwidthUtilization, bottleneckInfo, bottleneckOf, numericSeries, singleStepMs, type CurvePoint } from '../lib/roofline'
import { ConfirmDialog } from './Dialog'
import { PulseIcon, SemanticIcon } from './Icons'
import { JobStatus } from './JobStatus'
import { useToast } from './Toast'
import { Truncate } from './Tooltip'
import { Button, Checkbox, Chip, cx, Field, RelativeTime } from './ui'

const ACTIVE = new Set(['queued', 'running'])

/** Chart colours (Primer): line/marks in info blue, the one-step reference in neutral ink. */
const INK = { axis: '#d1d9e0', grid: '#eff2f5', label: '#59636e', line: '#0969da', reference: '#59636e' }

/** Width of an element in CSS px, so charts can draw 1 SVG unit = 1 px and their text never shrinks below 12 px. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setWidth(Math.floor(element.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

function Tile({ title, takeaway, children, caption }: { title: string; takeaway?: string | null; children: ReactNode; caption?: ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border border-line-muted p-3">
      <h5 className="text-sm font-semibold text-fg">{title}</h5>
      {takeaway && <p className="mt-0.5 text-sm text-fg">{takeaway}</p>}
      <div className="mt-2">{children}</div>
      {caption && <p className="mt-1.5 text-xs text-muted">{caption}</p>}
    </section>
  )
}

/** Decode speed against the memory-bandwidth limit, with the overhead / mixed / bandwidth zones. */
function BandwidthGauge({ roofline }: { roofline: Roofline }) {
  const utilization = bandwidthUtilization(roofline)
  const limit = bandwidthLimit(roofline)
  const speed = roofline.decode?.tokens_per_s
  // Legacy tones (success / attention / neutral) from BOTTLENECK_INFO drive the fill colour.
  const info = bottleneckInfo(bottleneckOf(utilization))
  const pct = utilization === null ? null : Math.max(0, Math.min(1, utilization)) * 100
  const model = roofline.model ?? {}
  const hardware = roofline.hardware ?? {}
  const fill = info.tone === 'success' ? 'bg-positive-emphasis' : info.tone === 'attention' ? 'bg-caution-emphasis' : 'bg-neutral-emphasis'
  const facts = [
    typeof hardware.peak_bandwidth_gbs === 'number' && `${formatNumber(hardware.peak_bandwidth_gbs, 0)} GB/s peak bandwidth`,
    typeof roofline.decode?.achieved_bandwidth_gbs === 'number' && `${formatNumber(roofline.decode.achieved_bandwidth_gbs, 0)} GB/s achieved`,
    typeof model.bytes_per_token_gb === 'number' && `${formatNumber(model.bytes_per_token_gb, 2)} GB read per token`,
  ].filter(Boolean)
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs font-medium text-muted">Decode speed</span>
        <Chip tone={info.tone} title={info.description}>
          <SemanticIcon name={info.icon} size={12} className="shrink-0" />
          {info.label}
        </Chip>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-metric text-fg tabular-nums">{typeof speed === 'number' ? formatNumber(speed, 1) : 'Not reported'}</span>
        {typeof speed === 'number' && <span className="text-sm text-muted">tokens/s</span>}
        {limit !== null && <span className="text-sm text-muted">of a {formatNumber(limit, 0)} tokens/s limit set by memory bandwidth</span>}
      </div>
      <div
        className="relative mt-3 mb-1"
        role="meter"
        aria-label="Share of the memory-bandwidth limit"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(pct)}
        aria-valuetext={pct === null ? 'Not measured' : `${Math.round(pct)}% of the limit: ${info.label}`}
      >
        <div className="flex h-3 overflow-hidden rounded-full" aria-hidden="true">
          <div className="w-[40%] bg-caution-subtle" />
          <div className="w-[20%] bg-neutral-subtle" />
          <div className="w-[40%] bg-positive-subtle" />
        </div>
        {pct !== null && (
          <>
            <div className={cx('absolute inset-y-0 left-0 rounded-full opacity-85', fill)} style={{ width: `${pct}%` }} aria-hidden="true" />
            <span className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-canvas bg-fg shadow" style={{ left: `${pct}%` }} aria-hidden="true" />
          </>
        )}
      </div>
      <div className="relative h-4 text-xs text-muted tabular-nums" aria-hidden="true">
        <span className="absolute left-0">0%</span>
        <span className="absolute left-[40%] -translate-x-1/2">40%</span>
        <span className="absolute left-[60%] -translate-x-1/2">60%</span>
        <span className="absolute right-0">100%</span>
      </div>
      <div className="mt-0.5 flex text-xs text-muted" aria-hidden="true">
        <span className="w-[40%]">Overhead-bound</span>
        <span className="w-[20%] text-center">Mixed</span>
        <span className="w-[40%] text-right">Bandwidth-bound</span>
      </div>
      <p className="mt-2 text-sm text-fg">
        {pct !== null ? <strong>{formatNumber(pct, 0)}% of the memory-bandwidth limit</strong> : 'Share of the limit not reported'}
        {facts.length > 0 && <span className="text-muted"> · {facts.join(' · ')}</span>}
      </p>
    </div>
  )
}

/** Line chart of the forward-pass cost vs tokens checked in one pass (the verification cost curve). */
export function CostCurve({ points, step }: { points: CurvePoint[]; step: number | null }) {
  const [ref, measured] = useWidth<HTMLDivElement>()
  if (points.length < 2)
    return (
      <div ref={ref}>
        <p className="text-sm text-muted">Not measured.</p>
      </div>
    )
  const width = Math.max(200, measured || 260)
  const height = 150
  const pad = { left: 48, right: 14, top: 20, bottom: 26 }
  const xs = points.map((p) => Math.log2(p.x))
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const maxY = niceMax(Math.max(...points.map((p) => p.y), step ?? 0))
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const x = (value: number) => pad.left + ((Math.log2(value) - minX) / (maxX - minX || 1)) * plotW
  const y = (value: number) => pad.top + (1 - value / maxY) * plotH
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  // Skip x labels that would sit closer than 28 px (keep the first and last).
  const every = Math.max(1, Math.ceil(28 / (plotW / Math.max(1, points.length - 1))))
  const ticks = [0, maxY / 2, maxY]
  return (
    <figure>
      <div ref={ref} className="w-full">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block max-w-full"
          role="img"
          aria-label={`Cost of one forward pass: ${points.map((p) => `${p.x} tokens ${formatNumber(p.y, 1)} ms`).join(', ')}${step ? `; one normal step ${formatNumber(step, 1)} ms` : ''}`}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? INK.axis : INK.grid} />
              <text x={pad.left - 6} y={y(tick) + 4} textAnchor="end" fontSize={12} fill={INK.label}>
                {formatNumber(tick, 1)}
                {tick === maxY ? ' ms' : ''}
              </text>
            </g>
          ))}
          {step !== null && (
            <line x1={pad.left} x2={width - pad.right} y1={y(step)} y2={y(step)} stroke={INK.reference} strokeDasharray="4 3" strokeWidth={1.2} />
          )}
          <path d={path} fill="none" stroke={INK.line} strokeWidth={2} strokeLinejoin="round" />
          {points.map((p, index) => (
            <g key={p.x}>
              <circle cx={x(p.x)} cy={y(p.y)} r={3.5} fill={INK.line} stroke="#fff" strokeWidth={1.5} />
              {(index % every === 0 || index === points.length - 1) && (
                <text x={x(p.x)} y={height - pad.bottom + 17} textAnchor="middle" fontSize={12} fill={INK.label}>
                  {p.x}
                </text>
              )}
            </g>
          ))}
          <text x={x(last.x)} y={y(last.y) - 8} textAnchor="end" fontSize={12} fill={INK.line} fontWeight={600}>
            {formatNumber(last.y, 1)} ms
          </text>
        </svg>
      </div>
      <figcaption className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded bg-info" aria-hidden="true" />
          Time for one pass (ms) by tokens checked
        </span>
        {step !== null && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-4 border-t-2 border-dashed border-neutral" aria-hidden="true" />
            One normal step: {formatNumber(step, 1)} ms
          </span>
        )}
      </figcaption>
    </figure>
  )
}

function BarList({ rows, max }: { rows: { key: string; label: ReactNode; value: number | null; text: string; className: string }[]; max: number }) {
  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <li key={row.key} className="grid grid-cols-[minmax(4.5rem,auto)_minmax(0,1fr)_auto] items-center gap-2 text-xs">
          <span className="text-muted">{row.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-canvas-inset" aria-hidden="true">
            {row.value !== null && <span className={cx('block h-full rounded-full', row.className)} style={{ width: `${(row.value / (max || 1)) * 100}%` }} />}
          </span>
          <span className="text-right font-medium text-fg tabular-nums">{row.text}</span>
        </li>
      ))}
    </ul>
  )
}

function BatchBars({ points }: { points: CurvePoint[] }) {
  if (!points.length) return <p className="text-sm text-muted">Not measured.</p>
  return (
    <BarList
      max={Math.max(...points.map((p) => p.y))}
      rows={points.map((p) => ({
        key: String(p.x),
        label: pluralize(p.x, 'request'),
        value: p.y,
        text: formatNumber(p.y, 0),
        className: 'bg-info',
      }))}
    />
  )
}

function DraftVsTarget({ roofline }: { roofline: Roofline }) {
  const target = singleStepMs(roofline)
  const draft = typeof roofline.draft?.ms_per_token === 'number' ? roofline.draft.ms_per_token : null
  const prefill = roofline.prefill_tokens_per_s
  return (
    <div>
      <BarList
        max={Math.max(target ?? 0, draft ?? 0)}
        rows={[
          { key: 'target', label: 'Target model', value: target, text: target !== null ? `${formatNumber(target, 1)} ms` : 'Not measured', className: 'bg-neutral-emphasis' },
          { key: 'draft', label: 'Draft model', value: draft, text: draft !== null ? `${formatNumber(draft, 1)} ms` : 'Not measured', className: 'bg-info' },
        ]}
      />
      {roofline.draft?.id && (
        <p className="mt-1.5 flex min-w-0 gap-1 text-xs text-muted">
          <span className="shrink-0">Draft:</span>
          <Truncate className="font-mono">{roofline.draft.id}</Truncate>
        </p>
      )}
      <p className="mt-2 border-t border-line-muted pt-2 text-xs text-muted">
        Reading the prompt (prefill):{' '}
        <strong className="text-fg tabular-nums">{typeof prefill === 'number' ? `${formatNumber(prefill, 0)} tokens/s` : 'Not measured'}</strong>
      </p>
    </div>
  )
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
      confirmLabel="Measure roofline"
      loading={measure.isPending}
      error={measure.error}
      initialFocus="cancel"
      cost="Runs on the worker and takes a few minutes on the GPU. Experiments that need the GPU wait until it’s done."
      onConfirm={() =>
        measure.mutate(
          { model, rematch },
          {
            onSuccess: (job) => {
              toast.success(`Queued job #${job.job_id}: measure roofline`)
              onClose()
            },
          },
        )
      }
    >
      <p className="mb-3 text-muted">
        Measures how fast the engine decodes compared with its memory-bandwidth limit, what it costs to check 1–16 tokens in one pass, batched
        decoding and the draft model. The cost model uses this to estimate what each claim can gain here.
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
        <Checkbox
          id="roofline-rematch"
          checked={rematch}
          onChange={setRematch}
          label="Re-rank claims afterwards"
          description="Uses the new estimates to re-rank this project’s claims (claims the cost model calls unlikely to help are set aside)."
        />
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
  const answer = rooflineAnswer(roofline)
  const measured = measuredWith(roofline)

  return (
    <section className="@container rounded-lg border border-line" aria-labelledby={`roofline-${project.id}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-muted px-4 py-2.5">
        <h3 id={`roofline-${project.id}`} className="flex items-center gap-2 text-sm font-semibold">
          <PulseIcon size={14} className="text-info-fg" /> Engine speed limit (roofline)
        </h3>
        <span className="text-xs text-muted">
          {project.roofline_at ? (
            <>
              Measured <RelativeTime iso={project.roofline_at} />
            </>
          ) : (
            'Not measured yet'
          )}
        </span>
        <Button size="sm" className="ml-auto" icon={<PulseIcon size={14} />} onClick={() => setOpen(true)} disabled={running} loading={running}>
          {running ? 'Measuring…' : roofline ? 'Re-measure…' : 'Measure roofline…'}
        </Button>
      </header>
      <div className="space-y-4 p-3 sm:p-4">
        {showJob && latest && (
          <JobStatus
            job={latest}
            title={`Roofline job #${latest.id}`}
            summary={jobResultSummary(latest) ?? undefined}
            action={
              latest.status === 'done' && latest.payload?.rematch !== false ? (
                <Link to={`/recommendations?project=${project.id}`} className="ml-auto text-sm">
                  View re-ranked recommendations
                </Link>
              ) : undefined
            }
          />
        )}
        {!roofline ? (
          <div className="rounded-md border border-dashed border-line px-4 py-5 text-center text-sm text-muted">
            <p>
              <strong className="text-fg">Not measured yet.</strong> Until it is, the expected gain of each claim on this engine is “Not estimated”.
            </p>
            <p className="mt-1">Measuring takes a few minutes on the GPU and re-ranks the claims for this project.</p>
          </div>
        ) : (
          <>
            {answer && (
              <div data-answer="roofline">
                <p className="text-body-lg font-semibold text-fg">{answer.headline}</p>
                <p className="mt-1 max-w-3xl text-sm text-fg">{answer.detail}</p>
              </div>
            )}
            <BandwidthGauge roofline={roofline} />
            {measured && <p className="text-xs text-muted [overflow-wrap:anywhere]">{measured}</p>}
            <div>
              <h4 className="mb-2 text-sm font-semibold text-fg">Where decode time goes</h4>
              <div className="grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
                <Tile title="Checking several tokens at once" takeaway={verificationTakeaway(curve, roofline)} caption="Matters for speculative decoding, which checks drafted tokens in one pass.">
                  <CostCurve points={curve} step={singleStepMs(roofline)} />
                </Tile>
                <Tile
                  title="Serving requests together"
                  takeaway={batchTakeaway(batches)}
                  caption={batches.length ? `Total tokens/s across ${pluralize(batches.length, 'batch size')} measured.` : undefined}
                >
                  <BatchBars points={batches} />
                </Tile>
                <Tile title="Draft model vs target model" takeaway={draftTakeaway(roofline)} caption="Time per token in ms. A cheap draft makes speculative decoding pay off.">
                  <DraftVsTarget roofline={roofline} />
                </Tile>
              </div>
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
  if (!roofline) return <span className="text-muted">Roofline not measured yet</span>
  const utilization = bandwidthUtilization(roofline)
  const info = bottleneckInfo(bottleneckOf(utilization))
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5">
      {typeof roofline.decode?.tokens_per_s === 'number' && <span>{formatNumber(roofline.decode.tokens_per_s, 0)} tok/s</span>}
      {utilization !== null && <span>· {formatNumber(utilization * 100, 0)}% of the bandwidth limit ·</span>}
      <Chip tone={info.tone}>
        <SemanticIcon name={info.icon} size={12} className="shrink-0" />
        {info.label}
      </Chip>
    </span>
  )
}

