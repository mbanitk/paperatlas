import { useId, useState, type ReactNode } from 'react'
import type { Claim, ClaimExplainer, ClaimTheme, Prediction, Project } from '../api/types'
import { EFFORT_LEVEL, riskLevel, type Level } from '../lib/claims'
import { aspectLabel, claimTheme, heroResult, isPlainLanguage, THEME_LABEL } from '../lib/explainer'
import { formatGainRange, likelihoodInfo, metricShort } from '../lib/roofline'
import {
  BarMeterInline,
  ClaimDiagram,
  ClaimExplainDetails,
  ClaimLead,
  GlanceStrip,
  GlossaryChips,
  GlossaryText,
  LevelDots,
  LosslessBadge,
} from './Explainers'
import { FlowComparisonDiagram } from './FlowDiagram'
import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, ChevronDown, ChevronRight, ClockIcon, Glyph, type GlyphName, PulseIcon, SparkIcon } from './Icons'
import { PredictionDetails } from './Prediction'
import { cx, TONE_CLASSES } from './ui'

type Glossary = ClaimExplainer['glossary']

// ---- small pieces -----------------------------------------------------------------------------

const THEME_GLYPH: Record<ClaimTheme, GlyphName> = {
  speed: 'speed',
  latency: 'latency',
  throughput: 'throughput',
  memory: 'memory',
  quality: 'quality',
  cost: 'cost',
  reliability: 'reliability',
}

const THEME_TINT: Record<ClaimTheme, string> = {
  speed: 'bg-accent-subtle text-accent ring-accent/25',
  latency: 'bg-accent-subtle text-accent ring-accent/25',
  throughput: 'bg-done-subtle text-done ring-done/25',
  memory: 'bg-[#d8f6f0] text-[#1b7c83] ring-[#1b7c83]/25',
  quality: 'bg-success-subtle text-success ring-success/25',
  cost: 'bg-attention-subtle text-attention ring-attention-emphasis/30',
  reliability: 'bg-neutral-subtle text-muted ring-line',
}

/** Rounded tile with the claim's theme glyph (speed, memory…); labelled for screen readers. */
export function ThemeBadge({ claim, explainer, className }: { claim: Pick<Claim, 'primary_metric' | 'category'>; explainer?: ClaimExplainer | null; className?: string }) {
  const theme = claimTheme(claim, explainer)
  return (
    <span className={cx('inline-flex size-9 shrink-0 items-center justify-center rounded-lg ring-1', THEME_TINT[theme], className)} title={`Goal: ${THEME_LABEL[theme].toLowerCase()}`}>
      <Glyph name={THEME_GLYPH[theme]} size={20} />
      <span className="sr-only">{`Goal: ${THEME_LABEL[theme]}`}</span>
    </span>
  )
}

function SectionTitle({ icon, children, aside }: { icon: GlyphName | ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
        <span className="text-muted" aria-hidden="true">
          {typeof icon === 'string' ? <Glyph name={icon as GlyphName} size={15} /> : icon}
        </span>
        {children}
      </h4>
      {aside}
    </div>
  )
}

/** The plain one-sentence headline (v2), or the existing headline + problem lead for older explainers. */
export function ClaimHeadline({ claim, explainer, clamp = true }: { claim: Claim; explainer?: ClaimExplainer | null; clamp?: boolean }) {
  if (!explainer || !isPlainLanguage(explainer)) return <ClaimLead claim={claim} explainer={explainer} clamp={clamp} />
  return <p className="mt-1.5 text-[15px] leading-snug font-medium text-fg">{explainer.headline || claim.technique}</p>
}

// ---- hero: what the paper reports vs what we expect here ---------------------------------------

function PredictedHere({ prediction, project }: { prediction: Prediction | null; project?: Project }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const chip = project?.hardware?.chip ? String(project.hardware.chip) : project?.name
  if (!prediction)
    return (
      <div className="flex min-w-0 flex-col justify-center rounded-lg border border-dashed border-line px-3.5 py-3">
        <div className="text-[11px] font-semibold tracking-wide text-subtle uppercase">Predicted here</div>
        <p className="mt-0.5 text-sm text-muted">Not estimated yet: the cost model needs the engine’s measured roofline.</p>
      </div>
    )
  const info = likelihoodInfo(prediction.likelihood)
  const range = formatGainRange(prediction.predicted_gain_pct)
  return (
    <div className="flex min-w-0 flex-col justify-center rounded-lg border border-line-muted bg-canvas-subtle/70 px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">Predicted here{chip && <span className="font-normal normal-case"> · {chip}</span>}</div>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-xl font-semibold text-fg tabular-nums">{range ?? 'no estimate'}</span>
        {range && prediction.metric && <span className="text-xs text-muted">{metricShort(prediction.metric)}</span>}
      </div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="mt-1.5 inline-flex w-fit items-center gap-1.5 rounded-md text-left text-xs text-muted hover:text-fg"
        title={info.description}
      >
        <span className={cx('chip', TONE_CLASSES[info.tone])}>
          <PulseIcon size={12} />
          {info.label}
        </span>
        why?
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div id={panelId} className="mt-2 border-t border-line-muted pt-2">
          <PredictionDetails prediction={prediction} />
        </div>
      )}
    </div>
  )
}

/**
 * Big "paper reports" number (the v2 headline result, not a side number from the paper) next to what the
 * cost model predicts on this engine. `prediction === undefined` hides the prediction cell (claim pages).
 */
export function HeroResult({ claim, explainer, prediction, project, className }: {
  claim: Claim
  explainer?: ClaimExplainer | null
  prediction?: Prediction | null
  project?: Project
  className?: string
}) {
  const hero = heroResult(claim, explainer)
  if (!hero) return null
  const Arrow = hero.direction === 'down' ? ArrowDownIcon : hero.direction === 'up' ? ArrowUpIcon : null
  return (
    <div className={cx('grid gap-2.5', prediction !== undefined ? '@xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]' : 'max-w-2xl', className)}>
      <div className="flex min-w-0 items-start gap-3 rounded-lg border border-success/25 bg-success-subtle/45 px-3.5 py-3">
        {Arrow && (
          <span className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-success-emphasis text-white" aria-hidden="true">
            <Arrow size={20} strokeWidth={2.2} />
          </span>
        )}
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-wide text-success uppercase">The paper reports</div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[28px] leading-tight font-semibold text-success tabular-nums">{hero.value}</span>
            {hero.metric && <span className="text-sm font-medium text-fg">{hero.metric}</span>}
          </div>
          {hero.versus && <p className="mt-0.5 text-[13px] leading-snug text-muted">vs {hero.versus}</p>}
          {explainer?.lossless !== undefined && explainer?.lossless !== null && (
            <div className="mt-1.5">
              <LosslessBadge lossless={explainer.lossless} />
            </div>
          )}
        </div>
      </div>
      {prediction !== undefined && <PredictedHere prediction={prediction} project={project} />}
    </div>
  )
}

// ---- primer ---------------------------------------------------------------------------------

/** "New to this? 30-second primer": background concept, an analogy callout and the glossary. */
export function Primer({ explainer, defaultOpen = false }: { explainer: ClaimExplainer; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const primer = explainer.primer
  if (!primer?.concept && !primer?.analogy) return null
  return (
    <details open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)} className="group rounded-lg border border-line-muted bg-canvas">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3.5 py-2.5 text-sm font-semibold text-fg select-none hover:bg-canvas-subtle [&::-webkit-details-marker]:hidden">
        <span className="flex size-6 items-center justify-center rounded-full bg-attention-subtle text-attention" aria-hidden="true">
          <Glyph name="lightbulb" size={14} />
        </span>
        New to this? <span className="font-normal text-muted">30-second primer</span>
        <ChevronRight size={14} className="ml-auto text-muted transition-transform group-open:rotate-90" />
      </summary>
      <div className="space-y-3 px-3.5 pt-1 pb-3.5">
        {primer.concept && (
          <p className="max-w-[75ch] text-sm leading-relaxed text-fg">
            <GlossaryText text={primer.concept} glossary={explainer.glossary} />
          </p>
        )}
        {primer.analogy && (
          <div className="flex gap-2.5 rounded-md border border-attention-emphasis/30 bg-attention-subtle/50 px-3 py-2">
            <Glyph name="lightbulb" size={16} className="mt-0.5 shrink-0 text-attention" />
            <p className="text-sm text-fg">
              <span className="font-semibold">Think of it like this: </span>
              {primer.analogy}
            </p>
          </div>
        )}
        <GlossaryChips glossary={explainer.glossary} />
      </div>
    </details>
  )
}

// ---- today vs with the paper's idea ----------------------------------------------------------

export function TodayVsPaper({ explainer }: { explainer: ClaimExplainer }) {
  const pair = explainer.today_vs_paper
  if (!pair?.today && !pair?.with_paper) return null
  const glossary = explainer.glossary
  return (
    <section aria-label="Today vs. with the paper’s idea">
      <SectionTitle icon="compare">Today vs. with the paper’s idea</SectionTitle>
      <div className="grid items-stretch gap-2 @xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="min-w-0 rounded-lg border border-line-muted bg-canvas-subtle/70 px-3.5 py-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted">
            <ClockIcon size={14} /> Today
          </div>
          <p className="text-sm text-fg">
            <GlossaryText text={pair.today} glossary={glossary} />
          </p>
        </div>
        <div className="flex items-center justify-center text-subtle" aria-hidden="true">
          <span className="flex size-7 items-center justify-center rounded-full border border-line bg-canvas">
            <ArrowRightIcon size={14} className="rotate-90 @xl:rotate-0" />
          </span>
        </div>
        <div className="min-w-0 rounded-lg border border-accent/30 bg-accent-subtle/40 px-3.5 py-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-accent">
            <SparkIcon size={14} /> With the paper’s idea
          </div>
          <p className="text-sm text-fg">
            <GlossaryText text={pair.with_paper} glossary={glossary} />
          </p>
        </div>
      </div>
    </section>
  )
}

// ---- diagram --------------------------------------------------------------------------------

/** Before/after flow when the explainer has `diagram_before`, else the single flow diagram. */
export function ClaimFlow({ explainer, claimName, className }: { explainer: ClaimExplainer | null | undefined; claimName: string; className?: string }) {
  const diagram = explainer?.diagram
  if (!diagram?.nodes?.length) return null
  const before = explainer?.diagram_before
  if (!before?.nodes?.length) return <ClaimDiagram diagram={diagram} className={className} />
  return (
    <section aria-label="How the flow changes" className={cx('rounded-lg border border-line-muted bg-canvas px-3.5 pt-3 pb-3', className)}>
      <SectionTitle icon="flow">How the flow changes</SectionTitle>
      <FlowComparisonDiagram before={before} after={diagram} techniqueLabel={diagram.title?.trim() || claimName} />
    </section>
  )
}

// ---- expanded detail: key numbers, paper vs here, what we do differently --------------------------

export function KeyNumbers({ items }: { items: ClaimExplainer['key_numbers'] }) {
  if (!items?.length) return null
  return (
    <section aria-label="Key numbers">
      <SectionTitle icon="hash">Key numbers from the paper</SectionTitle>
      <ul className="grid gap-2 @xl:grid-cols-3">
        {items.slice(0, 3).map((item, index) => (
          <li key={index} className="min-w-0 rounded-lg border border-line-muted bg-canvas-subtle/60 px-3 py-2.5" title={item.meaning || undefined}>
            <div className="text-xl font-semibold text-done tabular-nums">{item.value}</div>
            <div className="text-[13px] font-medium text-fg">{item.label}</div>
            {item.meaning && <p className="mt-0.5 line-clamp-3 text-xs leading-snug text-muted">{item.meaning}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}

const ASPECT_GLYPH: Record<string, GlyphName> = {
  hardware: 'chip',
  model: 'cube',
  runtime: 'runtime',
  workload: 'workload',
  baseline: 'baseline',
  draft_model: 'draft',
  batch: 'batch',
  context: 'context',
  other: 'hash',
}

function Aspect({ aspect }: { aspect: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-medium text-fg">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-canvas-inset text-muted" aria-hidden="true">
        <Glyph name={ASPECT_GLYPH[aspect] ?? 'hash'} size={14} />
      </span>
      {aspectLabel(aspect)}
    </span>
  )
}

export function PaperVsHere({ items, projectName, glossary }: { items: ClaimExplainer['paper_vs_here']; projectName?: string; glossary?: Glossary }) {
  const rows = (items ?? []).filter((row) => row && (row.paper || row.here))
  if (!rows.length) return null
  const here = projectName ? `Here (${projectName})` : 'Here'
  return (
    <section aria-label="Paper vs. here">
      <SectionTitle icon="compare">Paper vs. here</SectionTitle>
      <div className="hidden overflow-hidden rounded-lg border border-line-muted @2xl:block">
        <table className="w-full table-fixed text-left text-sm">
          <thead className="bg-canvas-subtle text-xs text-muted">
            <tr>
              <th scope="col" className="w-[17%] px-3 py-2 font-semibold">Aspect</th>
              <th scope="col" className="w-[26%] px-3 py-2 font-semibold">In the paper</th>
              <th scope="col" className="w-[28%] px-3 py-2 font-semibold text-accent">{here}</th>
              <th scope="col" className="px-3 py-2 font-semibold">What it means</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-muted align-top">
            {rows.map((row, index) => (
              <tr key={index}>
                <th scope="row" className="px-3 py-2.5 font-normal">
                  <Aspect aspect={row.aspect} />
                </th>
                <td className="px-3 py-2.5 text-muted">{row.paper}</td>
                <td className="bg-accent-subtle/25 px-3 py-2.5 text-fg">{row.here}</td>
                <td className="px-3 py-2.5 text-fg">
                  <GlossaryText text={row.effect} glossary={glossary} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 @2xl:hidden">
        {rows.map((row, index) => (
          <li key={index} className="rounded-lg border border-line-muted px-3 py-2.5">
            <Aspect aspect={row.aspect} />
            <dl className="mt-2 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-sm">
              <dt className="text-xs font-semibold text-muted">Paper</dt>
              <dd className="text-muted">{row.paper}</dd>
              <dt className="text-xs font-semibold text-accent">Here</dt>
              <dd className="text-fg">{row.here}</dd>
              {row.effect && (
                <>
                  <dt className="text-xs font-semibold text-muted">Means</dt>
                  <dd className="text-fg">
                    <GlossaryText text={row.effect} glossary={glossary} />
                  </dd>
                </>
              )}
            </dl>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function DoDifferently({ items, glossary }: { items: string[] | undefined; glossary?: Glossary }) {
  if (!items?.length) return null
  return (
    <section aria-label="What we’ll do differently here">
      <SectionTitle icon="checklist">What we’ll do differently here</SectionTitle>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-sm text-fg">
            <span className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded bg-success-emphasis text-white" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8.5l3.2 3L13 4.5" />
              </svg>
            </span>
            <span>
              <GlossaryText text={item} glossary={glossary} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---- compact facts ----------------------------------------------------------------------------

/** One-line fit / effort / risk meters (+ the lossless badge when the hero does not show it). */
export function QuickFacts({ claim, explainer, fit, blockers = [], showLossless = false, className }: {
  claim: Claim
  explainer?: ClaimExplainer | null
  fit?: number | null
  blockers?: string[]
  showLossless?: boolean
  className?: string
}) {
  const effort = claim.effort ? ((['low', 'medium', 'high'] as Level[])[(EFFORT_LEVEL[claim.effort] ?? 2) - 1] ?? 'medium') : null
  const risk = riskLevel(claim, explainer, blockers)
  return (
    <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {typeof fit === 'number' && <BarMeterInline label="fit" value={fit} />}
      {effort && <LevelDots label="effort" level={effort} />}
      <LevelDots label="risk" level={risk} />
      {showLossless && <LosslessBadge lossless={explainer?.lossless} />}
    </div>
  )
}

// ---- composed blocks ----------------------------------------------------------------------------

/**
 * The scannable part of a claim: hero result + prediction, primer, today vs. paper and the flow diagram.
 * Older (v1) explainers keep the previous glance strip + single diagram.
 */
export function ClaimOverview({ claim, explainer, project, prediction, fit, blockers, primerOpen = false, className }: {
  claim: Claim
  explainer?: ClaimExplainer | null
  project?: Project
  /** undefined = no prediction cell (claim pages); null = "not estimated yet". */
  prediction?: Prediction | null
  fit?: number | null
  blockers?: string[]
  primerOpen?: boolean
  className?: string
}) {
  if (!explainer || !isPlainLanguage(explainer))
    return (
      <div className={cx('space-y-3 @container', className)}>
        <GlanceStrip claim={claim} explainer={explainer} project={project} fit={fit} blockers={blockers} />
        <ClaimDiagram diagram={explainer?.diagram} />
      </div>
    )
  return (
    <div className={cx('space-y-3.5 @container', className)}>
      <HeroResult claim={claim} explainer={explainer} prediction={prediction} project={project} />
      <Primer explainer={explainer} defaultOpen={primerOpen} />
      <TodayVsPaper explainer={explainer} />
      <ClaimFlow explainer={explainer} claimName={claim.name} />
    </div>
  )
}

/** The expanded "Explain" content: key numbers, paper vs. here, what we do differently, then the steps. */
export function ClaimDeepDive({ explainer, projectName, showDiagram = false }: { explainer: ClaimExplainer; projectName?: string; showDiagram?: boolean }) {
  if (!isPlainLanguage(explainer)) return <ClaimExplainDetails explainer={explainer} projectName={projectName} showDiagram={showDiagram} />
  return (
    <div className="space-y-6 @container">
      <KeyNumbers items={explainer.key_numbers} />
      <PaperVsHere items={explainer.paper_vs_here} projectName={projectName} glossary={explainer.glossary} />
      <DoDifferently items={explainer.what_we_do_differently} glossary={explainer.glossary} />
      <ClaimExplainDetails explainer={explainer} projectName={projectName} showDiagram={showDiagram} />
    </div>
  )
}
