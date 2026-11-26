import { useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { Claim, ClaimExplainer, ClaimTheme, Prediction, Project } from '../api/types'
import { effortLevel, expectedMetricLabel, fitLevel, riskLevel } from '../lib/claims'
import { aspectLabel, claimTheme, formatReportedValue, heroResult, isPlainLanguage, paperReport, THEME_LABEL } from '../lib/explainer'
import { formatRange, MISSING, sanitizeText } from '../lib/format'
import { likelihoodInfo } from '../lib/roofline'
import { CategoryChip, DocTypeChip, LevelTag, OutcomeBadge } from './Badges'
import { ClaimCardDetails, Requirements } from './ClaimCard'
import {
  ClaimDiagram,
  ClaimExplainDetails,
  ClaimLead,
  GenerateClaimExplainer,
  GlanceStrip,
  GlossaryChips,
  GlossaryText,
  LosslessBadge,
} from './Explainers'
import { FlowComparisonDiagram } from './FlowDiagram'
import { ArrowRightIcon, CheckIcon, ChevronRight, ClockIcon, ExternalIcon, Glyph, type GlyphName, PaperIcon, SparkIcon } from './Icons'
import { PredictionDetails } from './Prediction'
import { RelatedStrip } from './Related'
import { InfoPopover, Truncate } from './Tooltip'
import { Button, ChipRow, Disclosure, MathText, PaperLink, StatTile, cx } from './ui'

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

/** Rounded tile with the claim's goal glyph (speed, memory…). Neutral: a goal is not an outcome. */
export function ThemeBadge({ claim, explainer, className }: { claim: Pick<Claim, 'primary_metric' | 'category'>; explainer?: ClaimExplainer | null; className?: string }) {
  const theme = claimTheme(claim, explainer)
  return (
    <span className={cx('inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-canvas-subtle text-muted ring-1 ring-line', className)}>
      <Glyph name={THEME_GLYPH[theme]} size={20} aria-hidden="true" />
      <span className="sr-text">{`Goal: ${THEME_LABEL[theme]}`}</span>
    </span>
  )
}

function SectionTitle({ icon, children, aside }: { icon: GlyphName | ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
        <span className="text-muted" aria-hidden="true">
          {typeof icon === 'string' ? <Glyph name={icon as GlyphName} size={16} /> : icon}
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
  return <p className="mt-1 text-sm font-medium text-fg">{sanitizeText(explainer.headline || claim.technique)}</p>
}

/** One plain sentence saying what the technique does (explainer headline, else the card's technique). */
export function claimSentence(claim: Pick<Claim, 'technique'>, explainer?: ClaimExplainer | null): string {
  return sanitizeText(explainer?.headline || claim.technique)
}

// ---- the answer: expected here (predicted register) and paper reports (claimed register) ---------------

/**
 * What the cost model expects on this project's engine, in the predicted register (dashed outline). The
 * likelihood is a badge; the reasons open in an InfoPopover ("Why this estimate?"). `long` names the project
 * and chip in the label ("Expected on inference-lab (Apple M5 Pro)"); compact cards say "Expected here".
 */
export function ExpectedHere({ prediction, project, long = false, className }: {
  prediction: Prediction | null | undefined
  project?: Project
  long?: boolean
  className?: string
}) {
  const chip = project?.hardware?.chip ? String(project.hardware.chip) : null
  const where = project ? `${project.name}${chip ? ` (${chip})` : ''}` : null
  const gain = prediction?.predicted_gain_pct
  const range = gain ? formatRange(gain.low, gain.high, { fallback: '' }) : ''
  const metric = expectedMetricLabel(prediction?.metric)
  const info = likelihoodInfo(prediction?.likelihood)
  return (
    <div data-register="predicted" className={cx('min-w-0 rounded-lg border border-dashed border-info/70 bg-canvas px-3 py-1.5', className)}>
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="inline-flex min-w-0 items-center gap-0.5 text-xs font-medium text-muted">
          {long && where ? `Expected on ${where}` : 'Expected here'}
          {prediction && (
            <InfoPopover
              title="Why this estimate?"
              label="Why this estimate?"
              maxWidth={360}
              content={
                <>
                  {where && <p className="mb-2 text-xs text-muted">Cost-model estimate for {where}, before anything is built.</p>}
                  <PredictionDetails prediction={prediction} />
                </>
              }
            />
          )}
        </span>
        {prediction && range && <OutcomeBadge kind="likelihood" value={prediction.likelihood} explain />}
      </div>
      {range ? (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-metric-sm text-fg tabular-nums">{range}</span>
          {metric && <span className="text-sm text-muted">{metric}</span>}
        </div>
      ) : (
        <div>
          <span className="text-sm font-semibold text-muted">{MISSING.estimate}</span>
          {long && <p className="text-xs text-muted">{prediction ? info.description : 'The cost model needs the engine’s measured roofline.'}</p>}
        </div>
      )}
    </div>
  )
}

/**
 * The paper's number in the reference register: neutral ink and a paper icon, never green. `compact` (lists)
 * is a single line on narrow cards and a box with the metric cut to one line on wide ones (`@lg` of the
 * nearest container); the full version adds what the paper compares against and lossless.
 */
export function PaperReports({ claim, explainer, compact = false, showLossless = true, className }: {
  claim: Claim
  explainer?: ClaimExplainer | null
  compact?: boolean
  /** Off where the facts row already shows lossless/approximate. */
  showLossless?: boolean
  className?: string
}) {
  const report = paperReport(claim, explainer)
  const lossless = explainer?.lossless
  if (compact)
    return (
      <div
        data-register="claimed"
        className={cx(
          'flex min-w-0 items-baseline gap-x-1.5 text-sm @lg:block @lg:rounded-lg @lg:border @lg:border-line @lg:bg-canvas-subtle @lg:px-3 @lg:py-1.5',
          className,
        )}
      >
        <span className="inline-flex shrink-0 items-center gap-1 self-center text-xs font-medium text-muted @lg:flex @lg:min-h-6">
          <PaperIcon size={14} className="shrink-0" aria-hidden="true" />
          Paper reports
        </span>
        {report ? (
          <span className="flex min-w-0 flex-1 items-baseline gap-x-1.5 @lg:block">
            <span className="max-w-full shrink-0 font-semibold text-fg tabular-nums @lg:block @lg:text-body-lg">{report.value}</span>
            {report.metric && <Truncate className="min-w-0 text-muted">{report.metric}</Truncate>}
          </span>
        ) : (
          <span className="min-w-0 text-muted">{MISSING.claim}</span>
        )}
      </div>
    )
  return (
    <div data-register="claimed" className={cx('min-w-0 rounded-lg border border-line bg-canvas-subtle px-3 py-2', className)}>
      <div className="flex min-h-6 items-center gap-1.5 text-xs font-medium text-muted">
        <PaperIcon size={14} className="shrink-0" aria-hidden="true" />
        Paper reports
      </div>
      {report ? (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-metric-sm text-fg tabular-nums [overflow-wrap:anywhere]">{report.value}</span>
          {report.metric && <span className="text-sm text-muted">{report.metric}</span>}
        </div>
      ) : (
        <div className="text-sm text-muted">{MISSING.claim}</div>
      )}
      {report?.versus && <p className="mt-0.5 text-xs text-muted">vs {report.versus}</p>}
      {showLossless && lossless !== undefined && lossless !== null && (
        <div className="mt-1.5">
          <LosslessBadge lossless={lossless} />
        </div>
      )}
    </div>
  )
}

/**
 * The paper's number next to what the cost model expects here. The expected number comes first: it's the
 * one decisions are made on. `prediction === undefined` hides the expected cell (claim pages).
 */
export function HeroResult({ claim, explainer, prediction, project, className }: {
  claim: Claim
  explainer?: ClaimExplainer | null
  prediction?: Prediction | null
  project?: Project
  className?: string
}) {
  if (prediction === undefined && !heroResult(claim, explainer)) return null
  return (
    <div className={cx('grid gap-2', prediction !== undefined ? '@xl:grid-cols-2' : 'max-w-2xl', className)}>
      {prediction !== undefined && <ExpectedHere prediction={prediction} project={project} long />}
      <PaperReports claim={claim} explainer={explainer} />
    </div>
  )
}

// ---- primer ---------------------------------------------------------------------------------

/**
 * "New to this? 30-second primer": background concept, an analogy and the glossary. Collapsible by default;
 * `collapsible={false}` renders it as an open section (inside Explain).
 */
export function Primer({ explainer, defaultOpen = false, collapsible = true }: { explainer: ClaimExplainer; defaultOpen?: boolean; collapsible?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const primer = explainer.primer
  if (!primer?.concept && !primer?.analogy) return null
  const body = (
    <div className={cx('space-y-3', collapsible && 'px-3.5 pt-1 pb-3.5')}>
      {primer.concept && (
        <p className="max-w-[75ch] text-sm leading-relaxed text-fg">
          <GlossaryText text={primer.concept} glossary={explainer.glossary} />
        </p>
      )}
      {primer.analogy && (
        <div className="flex max-w-[75ch] gap-2.5 rounded-lg border border-line bg-canvas-subtle px-3 py-2">
          <Glyph name="lightbulb" size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
          <p className="text-sm text-fg">
            <span className="font-semibold">Think of it like this: </span>
            {sanitizeText(primer.analogy)}
          </p>
        </div>
      )}
      <GlossaryChips glossary={explainer.glossary} />
    </div>
  )
  if (!collapsible)
    return (
      <section aria-label="The idea in 30 seconds">
        <SectionTitle icon="lightbulb">The idea in 30 seconds</SectionTitle>
        {body}
      </section>
    )
  return (
    <details open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)} className="group rounded-lg border border-line bg-canvas">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold text-fg select-none hover:bg-canvas-subtle [&::-webkit-details-marker]:hidden">
        <Glyph name="lightbulb" size={16} className="shrink-0 text-muted" aria-hidden="true" />
        New to this? <span className="font-normal text-muted">30-second primer</span>
        <ChevronRight size={14} className="ml-auto text-muted transition-transform group-open:rotate-90" />
      </summary>
      {body}
    </details>
  )
}

// ---- today vs with the paper's idea ----------------------------------------------------------

export function TodayVsPaper({ explainer }: { explainer: ClaimExplainer }) {
  const pair = explainer.today_vs_paper
  if (!pair?.today && !pair?.with_paper) return null
  const glossary = explainer.glossary
  return (
    <section aria-label="Usual approach vs. the paper’s idea">
      <SectionTitle icon="compare">Usual approach vs. the paper’s idea</SectionTitle>
      <div className="grid items-stretch gap-2 @xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="min-w-0 rounded-lg border border-line bg-canvas-subtle px-3.5 py-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted">
            <ClockIcon size={14} aria-hidden="true" /> Usual approach
          </div>
          <p className="text-sm text-fg">
            <GlossaryText text={pair.today} glossary={glossary} />
          </p>
        </div>
        <div className="flex items-center justify-center text-muted" aria-hidden="true">
          <span className="flex size-7 items-center justify-center rounded-full border border-line bg-canvas">
            <ArrowRightIcon size={14} className="rotate-90 @xl:rotate-0" />
          </span>
        </div>
        <div className="min-w-0 rounded-lg border border-fg/30 bg-canvas px-3.5 py-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-fg">
            <SparkIcon size={14} aria-hidden="true" /> With the paper’s idea
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
    <section aria-label="How the flow changes" className={cx('rounded-lg border border-line bg-canvas px-3.5 pt-3 pb-3', className)}>
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
          <li key={index} className="min-w-0">
            <StatTile
              label={sanitizeText(item.label)}
              value={formatReportedValue(item.value) ?? sanitizeText(item.value)}
              context={item.meaning ? sanitizeText(item.meaning) : undefined}
              className="h-full"
            />
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
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-canvas-subtle text-muted" aria-hidden="true">
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
      <div className="hidden overflow-hidden rounded-lg border border-line @2xl:block">
        <table className="w-full table-fixed text-left text-sm">
          <thead className="bg-canvas-subtle text-xs text-muted">
            <tr>
              <th scope="col" className="w-[17%] px-3 py-2 font-semibold">Aspect</th>
              <th scope="col" className="w-[26%] px-3 py-2 font-semibold">In the paper</th>
              <th scope="col" className="w-[28%] px-3 py-2 font-semibold text-info-fg">{here}</th>
              <th scope="col" className="px-3 py-2 font-semibold">What it means</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-muted align-top">
            {rows.map((row, index) => (
              <tr key={index}>
                <th scope="row" className="px-3 py-2.5 font-normal">
                  <Aspect aspect={row.aspect} />
                </th>
                <td className="px-3 py-2.5 text-muted">{sanitizeText(row.paper)}</td>
                <td className="bg-info-subtle/40 px-3 py-2.5 text-fg">{sanitizeText(row.here)}</td>
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
          <li key={index} className="rounded-lg border border-line px-3 py-2.5">
            <Aspect aspect={row.aspect} />
            <dl className="mt-2 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-sm">
              <dt className="text-xs font-semibold text-muted">Paper</dt>
              <dd className="text-muted">{sanitizeText(row.paper)}</dd>
              <dt className="text-xs font-semibold text-info-fg">Here</dt>
              <dd className="text-fg">{sanitizeText(row.here)}</dd>
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
            <CheckIcon size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
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
  const effort = effortLevel(claim.effort)
  const risk = riskLevel(claim, explainer, blockers)
  return (
    <div className={cx('flex flex-wrap items-center gap-1.5', className)}>
      {typeof fit === 'number' && <LevelTag kind="fit" level={fitLevel(fit)} />}
      {effort && <LevelTag kind="effort" level={effort} />}
      <LevelTag kind="risk" level={risk} />
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

// ---- compact card (§3.4): one anatomy for Recommendations, Claims, papers and experiments ---------------

/** Effort, risk and fit as neutral tags (then lossless, category, requirements), at most `max` visible + "+N". */
export function ClaimFacts({ claim, explainer, fit, blockers = [], max = 3, extra = [], className }: {
  claim: Claim
  explainer?: ClaimExplainer | null
  fit?: number | null
  blockers?: string[]
  max?: number
  /** More tags after the built-in ones (topics…). */
  extra?: ReactNode[]
  className?: string
}) {
  const effort = effortLevel(claim.effort)
  const items: ReactNode[] = [
    effort && <LevelTag key="effort" kind="effort" level={effort} />,
    <LevelTag key="risk" kind="risk" level={riskLevel(claim, explainer, blockers)} />,
    typeof fit === 'number' && <LevelTag key="fit" kind="fit" level={fitLevel(fit)} />,
    explainer?.lossless !== undefined && explainer?.lossless !== null && <LosslessBadge key="lossless" lossless={explainer.lossless} />,
    (claim.requires_cuda || claim.requires_multi_gpu || claim.requires_training) && <Requirements key="requires" claim={claim} />,
    claim.category && <CategoryChip key="category" category={claim.category} />,
    claim.paper_doc_type === 'patent' && <DocTypeChip key="doc" docType={claim.paper_doc_type} />,
    !claim.testable && <LevelTagless key="testable">Not testable</LevelTagless>,
    ...extra,
  ].filter(Boolean)
  return <ChipRow items={items} max={max} label="More about this claim" className={className} />
}

function LevelTagless({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>
}

/**
 * Everything behind "Explain": the idea in 30 seconds, usual approach vs the paper's idea, how the flow
 * changes, key numbers, paper vs here, what we do differently, the steps and caveats. Older (v1) explainers
 * show their steps and diagram.
 */
export function ClaimExplain({ claim, explainer, project, showDiagram = true, diagramOpen = true }: {
  claim: Claim
  explainer: ClaimExplainer
  project?: Project
  showDiagram?: boolean
  /** false = the flow diagram sits behind a "How the flow changes" disclosure. */
  diagramOpen?: boolean
}) {
  const plain = isPlainLanguage(explainer)
  const hasDiagram = showDiagram && !!explainer.diagram?.nodes?.length
  const diagram = plain ? <ClaimFlow explainer={explainer} claimName={claim.name} /> : <ClaimDiagram diagram={explainer.diagram} />
  const flow = hasDiagram ? (
    diagramOpen ? (
      diagram
    ) : (
      <Disclosure label="How the flow changes" meta=" · diagram">
        {diagram}
      </Disclosure>
    )
  ) : null
  if (!plain)
    return (
      <div className="space-y-5 @container">
        {flow}
        <ClaimExplainDetails explainer={explainer} projectName={project?.name} showDiagram={false} />
      </div>
    )
  return (
    <div className="space-y-6 @container">
      <Primer explainer={explainer} collapsible={false} />
      <TodayVsPaper explainer={explainer} />
      {flow}
      <KeyNumbers items={explainer.key_numbers} />
      <PaperVsHere items={explainer.paper_vs_here} projectName={project?.name} glossary={explainer.glossary} />
      <DoDifferently items={explainer.what_we_do_differently} glossary={explainer.glossary} />
      <ClaimExplainDetails explainer={explainer} projectName={project?.name} showDiagram={false} showGlossary={false} />
    </div>
  )
}

/** Eyebrow line of a compact claim card: goal glyph · optional prefix (#rank) · paper title · month. */
export function ClaimEyebrow({ claim, explainer, prefix, showPaper = true }: {
  claim: Claim
  explainer?: ClaimExplainer | null
  prefix?: ReactNode
  showPaper?: boolean
}) {
  const theme = claimTheme(claim, explainer)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Glyph name={THEME_GLYPH[theme]} size={14} className="shrink-0" aria-hidden="true" />
      <span className="sr-text">{`Goal: ${THEME_LABEL[theme]}. `}</span>
      {prefix && <span className="shrink-0 font-semibold text-fg tabular-nums">{prefix}</span>}
      {prefix && showPaper && <span aria-hidden="true">·</span>}
      {showPaper && (
        <Truncate className="min-w-0">{sanitizeText(claim.paper_title ?? claim.paper_id)}</Truncate>
      )}
      {claim.paper_date && (
        <span className="shrink-0 tabular-nums">
          <span aria-hidden="true">· </span>
          {claim.paper_date.slice(0, 7)}
        </span>
      )}
    </span>
  )
}

type Panel = 'explain' | 'evidence'

/**
 * The compact claim card (§3.4), collapsed by default: what it is (eyebrow, title, one plain sentence, facts)
 * and the answer (expected here, then what the paper reports). "Explain" and "Evidence" open the rest.
 *
 * - `prediction`: `undefined` hides the expected-here cell (no project context); `null` = not estimated yet.
 * - `title` replaces the default title (e.g. a <label> for a selection checkbox); `to` links the default title.
 * - `leading` sits left of the card (checkbox), `status` right of the eyebrow, `footer` right of the toggles.
 * - `evidence` is prepended to the Evidence panel (rationale, match score…).
 * - `note` is one qualifier under the answer on wide cards ("Why here: …"), clamped to 2 lines; put the full
 *   text in `evidence` too.
 */
export function ClaimSummary({
  claim,
  explainer = claim.explainer,
  project,
  prediction,
  fit,
  blockers = [],
  title,
  to,
  titleId,
  headingLevel = 'h3',
  eyebrow,
  status,
  leading,
  footer,
  facts,
  evidence,
  note,
  notice,
  related = claim.related,
  canGenerate = true,
  selected = false,
  muted = false,
  className,
}: {
  claim: Claim
  explainer?: ClaimExplainer | null
  project?: Project
  prediction?: Prediction | null
  fit?: number | null
  blockers?: string[]
  title?: ReactNode
  to?: string
  titleId?: string
  headingLevel?: 'h2' | 'h3' | 'h4'
  eyebrow?: ReactNode
  status?: ReactNode
  leading?: ReactNode
  footer?: ReactNode
  facts?: ReactNode[]
  evidence?: ReactNode
  note?: string
  /** Shown under the summary at every width (e.g. what the claim needs that the project lacks). */
  notice?: ReactNode
  related?: Claim['related']
  /** Offer "Generate explanation" when there is none (queues an LLM call). */
  canGenerate?: boolean
  selected?: boolean
  muted?: boolean
  className?: string
}) {
  const [panel, setPanel] = useState<Panel | null>(null)
  const id = useId()
  const headingId = titleId ?? `${id}-title`
  const Heading = headingLevel
  const toggle = (next: Panel) => setPanel((current) => (current === next ? null : next))
  const name = (
    <MathText>{claim.name}</MathText>
  )
  const factItems = facts
  return (
    <article
      aria-labelledby={headingId}
      data-claim-card={claim.id}
      className={cx(
        'card p-3 transition-colors sm:px-4',
        selected ? 'border-info ring-1 ring-info/40' : muted ? 'bg-canvas-subtle' : 'hover:border-muted/50',
        className,
      )}
    >
      <div className="flex gap-3">
        {leading && <div className="flex shrink-0 flex-col items-center pt-0.5">{leading}</div>}
        <div className="min-w-0 flex-1 @container">
          <div className="grid gap-x-6 gap-y-1.5 @lg:gap-y-2 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] @5xl:grid-cols-[minmax(0,1fr)_minmax(0,34rem)]">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <div className="eyebrow min-w-0 grow basis-48">{eyebrow ?? <ClaimEyebrow claim={claim} explainer={explainer} />}</div>
                {status && <div className="flex max-w-full flex-wrap items-center justify-end gap-1">{status}</div>}
              </div>
              <Heading id={headingId} className="mt-0.5 text-body-lg font-semibold text-fg [overflow-wrap:anywhere]">
                {title ?? (to ? (
                  <Link to={to} className="text-fg hover:text-accent">
                    {name}
                  </Link>
                ) : (
                  name
                ))}
              </Heading>
              <p className="mt-0.5 line-clamp-2 text-sm text-muted">{claimSentence(claim, explainer)}</p>
              {notice && <div className="mt-1.5">{notice}</div>}
              <div className="mt-2 hidden @md:block">
                {factItems ? <ChipRow items={factItems} label="More about this claim" /> : <ClaimFacts claim={claim} explainer={explainer} fit={fit} blockers={blockers} />}
              </div>
            </div>
            <div className={cx('grid min-w-0 content-start gap-1.5 @lg:gap-2', prediction !== undefined && '@lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]')}>
              {prediction !== undefined && <ExpectedHere prediction={prediction} project={project} />}
              <PaperReports claim={claim} explainer={explainer} compact />
              {note && (
                <div className="col-span-full hidden @3xl:block">
                  <Truncate lines={2} as="div" className="text-xs text-muted">
                    {note}
                  </Truncate>
                </div>
              )}
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line-muted pt-1 sm:mt-2 sm:pt-1.5">
            <div className="-ml-2 flex flex-wrap items-center gap-1">
              {explainer ? (
                <PanelToggle label="Explain" panel="explain" open={panel === 'explain'} onToggle={toggle} controls={`${id}-explain`} />
              ) : (
                canGenerate && <GenerateClaimExplainer claimId={claim.id} projectId={project?.id} />
              )}
              <PanelToggle label="Evidence" panel="evidence" open={panel === 'evidence'} onToggle={toggle} controls={`${id}-evidence`} />
            </div>
            {footer && <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-muted">{footer}</div>}
          </div>
          {panel === 'explain' && explainer && (
            <div id={`${id}-explain`} className="mt-2 border-t border-line-muted pt-4">
              <ClaimExplain claim={claim} explainer={explainer} project={project} />
            </div>
          )}
          {panel === 'evidence' && (
            <div id={`${id}-evidence`} className="mt-2 border-t border-line-muted pt-4">
              <ClaimEvidence claim={claim} explainer={explainer} prediction={prediction} fit={fit} blockers={blockers} related={related} extra={evidence} />
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

function PanelToggle({ label, panel, open, onToggle, controls }: { label: string; panel: Panel; open: boolean; onToggle: (panel: Panel) => void; controls: string }) {
  return (
    <Button
      size="sm"
      variant="invisible"
      onClick={() => onToggle(panel)}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      icon={<ChevronRight size={14} className={cx('transition-transform', open && 'rotate-90')} />}
      className="px-2"
    >
      {label}
    </Button>
  )
}

/** Evidence panel: why the estimate, project-specific notes, source, all facts, related concepts and the raw card. */
function ClaimEvidence({ claim, explainer, prediction, fit, blockers, related, extra }: {
  claim: Claim
  explainer?: ClaimExplainer | null
  prediction?: Prediction | null
  fit?: number | null
  blockers: string[]
  related?: Claim['related']
  extra?: ReactNode
}) {
  return (
    <div className="space-y-4 text-sm">
      {prediction && (
        <section aria-label="Why this estimate">
          <SectionTitle icon="chip">Why this estimate?</SectionTitle>
          <PredictionDetails prediction={prediction} />
        </section>
      )}
      {extra}
      <section aria-label="Source">
        <SectionTitle icon="paper">Source</SectionTitle>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg">
          <PaperLink paperId={claim.paper_id} title={sanitizeText(claim.paper_title ?? claim.paper_id)} />
          {claim.paper_date && <span className="text-muted">· {claim.paper_date.slice(0, 7)}</span>}
          {claim.paper_url && (
            <a href={claim.paper_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-muted hover:text-accent">
              · original <ExternalIcon size={12} />
            </a>
          )}
        </p>
      </section>
      <ClaimFacts claim={claim} explainer={explainer} fit={fit} blockers={blockers} max={99} />
      <RelatedStrip related={related} claimId={claim.id} paperId={claim.paper_id} />
      <Disclosure label="Claim card (raw)" summaryClassName="text-sm">
        <div className="rounded-lg border border-line px-3 py-3">
          <ClaimCardDetails claim={claim} showPaper={false} />
        </div>
      </Disclosure>
      <Link to={`/research/claims/${claim.id}`} className="inline-flex items-center gap-1 text-sm font-medium">
        Open the claim page <ArrowRightIcon size={14} />
      </Link>
    </div>
  )
}
