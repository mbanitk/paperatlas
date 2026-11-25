import { Fragment, useState, type ReactNode } from 'react'
import { useExplainClaim, useExplainPaper, useExplainTopic } from '../api/queries'
import type { Claim, ClaimExplainer, PaperExplainer, Project } from '../api/types'
import { claimedEffectView, compareHardware, effectText, effortLevel, fitLevel, riskLevel } from '../lib/claims'
import { formatReportedValue } from '../lib/explainer'
import { formatPct, formatScore, relativeTime, sanitizeText } from '../lib/format'
import { levelSemantics } from '../lib/semantics'
import { LevelTag, Tag } from './Badges'
import { FlowDiagram } from './FlowDiagram'
import { AlertIcon, ApproxIcon, ArrowRightIcon, CheckIcon, SparkIcon } from './Icons'
import { useToast } from './Toast'
import { InfoPopover, Term, Truncate } from './Tooltip'
import { Button, InlineError, StatTile, cx, errorMessage } from './ui'

// ---- glossary -----------------------------------------------------------------------------

type Glossary = { term: string; meaning: string }[] | undefined

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Prose from an explainer, cleaned for the plain layer (LaTeX, "0…+10%", long decimals), with the first
 * mention of each glossary term opening its meaning in a popover (hover, focus, tap; never under the header).
 */
export function GlossaryText({ text, glossary }: { text: string | undefined | null; glossary: Glossary }) {
  if (!text) return null
  const clean = sanitizeText(text)
  const terms = (glossary ?? []).filter((item) => item?.term && item.term.length > 1 && item.meaning)
  if (!terms.length) return <>{clean}</>
  const pattern = new RegExp(`(${terms.map((item) => escapeRegExp(item.term)).join('|')})`, 'gi')
  const parts = clean.split(pattern)
  const seen = new Set<string>()
  return (
    <>
      {parts.map((part, index) => {
        const item = terms.find((entry) => entry.term.toLowerCase() === part.toLowerCase())
        if (!item || seen.has(item.term.toLowerCase())) return <Fragment key={index}>{part}</Fragment>
        seen.add(item.term.toLowerCase())
        return (
          <Term key={index} term={item.term} definition={item.meaning}>
            {part}
          </Term>
        )
      })}
    </>
  )
}

/** A glossary word as a chip; its meaning opens in a popover. */
function TermChip({ term, meaning }: { term: string; meaning: string }) {
  return (
    <InfoPopover
      content={meaning}
      title={term}
      triggerClassName="chip min-h-6 cursor-help border-line bg-canvas text-fg underline decoration-muted decoration-dotted underline-offset-[3px] hover:border-fg aria-expanded:border-fg"
    >
      {term}
    </InfoPopover>
  )
}

export function GlossaryChips({ glossary }: { glossary: Glossary }) {
  const items = (glossary ?? []).filter((item) => item?.term && item.meaning)
  if (!items.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted">Terms:</span>
      {items.map((item) => (
        <TermChip key={item.term} term={item.term} meaning={item.meaning} />
      ))}
    </div>
  )
}

// ---- small infographics ------------------------------------------------------------------

/**
 * Horizontal bar for a claimed gain (0–100 %, capped) with a tick at the success bar (default 5 %). It's the
 * paper's number, so it's neutral ink, not green.
 */
export function GainGauge({ gainPct, threshold = 5, className }: { gainPct: number; threshold?: number; className?: string }) {
  const width = Math.max(2, Math.min(100, gainPct))
  return (
    <span
      className={cx('relative inline-block h-1.5 w-20 overflow-visible rounded-full bg-canvas-inset align-middle', className)}
      role="meter"
      aria-label={`Paper reports ${formatPct(gainPct, 0)}${gainPct > 100 ? ' (bar capped at 100%)' : ''} vs a ${threshold}% success bar`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(100, gainPct)}
    >
      <span className="absolute inset-y-0 left-0 rounded-full bg-neutral-emphasis" style={{ width: `${width}%` }} />
      <span className="absolute -top-0.5 h-2.5 w-px bg-fg/60" style={{ left: `${threshold}%` }} aria-hidden="true" />
    </span>
  )
}

/** "Effort: low ●○○": neutral words and dots, never red/green (effort isn't success). `invert` is kept for compatibility. */
export function LevelDots({ label, level }: { label: string; level: Level; invert?: boolean }) {
  const kind = (['effort', 'risk', 'fit'] as const).find((value) => value === label.toLowerCase())
  if (kind) return <LevelTag kind={kind} level={level} />
  const info = levelSemantics('effort', level)
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span>
        {label.charAt(0).toUpperCase() + label.slice(1)}: <span className="text-fg">{level}</span>
      </span>
      <span aria-hidden="true" className="inline-flex gap-0.5">
        {[1, 2, 3].map((dot) => (
          <span key={dot} className={cx('inline-block size-1.5 rounded-full', dot <= info.dots ? 'bg-muted' : 'border border-muted/60')} />
        ))}
      </span>
    </span>
  )
}

/** "Fit: high" plus the 0–1 score, in words (neutral). */
export function BarMeterInline({ label, value }: { label: string; value: number }) {
  const level = fitLevel(value)
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span>
        {label.charAt(0).toUpperCase() + label.slice(1)}: <span className="text-fg">{level ?? formatScore(value)}</span>
      </span>
      <span className="relative inline-block h-1.5 w-10 overflow-hidden rounded-full bg-canvas-inset" role="meter" aria-label={`${label} ${value.toFixed(2)}`} aria-valuemin={0} aria-valuemax={1} aria-valuenow={value}>
        <span className="absolute inset-y-0 left-0 rounded-full bg-neutral-emphasis" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      </span>
    </span>
  )
}

type Level = 'low' | 'medium' | 'high'

function Tile({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0 rounded-lg border border-line bg-canvas px-3 py-2', className)}>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-0.5 min-w-0 text-sm">{children}</div>
    </div>
  )
}

/** The paper's reported effect, in the reference register (neutral ink). */
export function EffectTile({ claim, explainer }: { claim: Claim; explainer?: ClaimExplainer | null }) {
  const view = claimedEffectView(claim, explainer)
  const summary = view.summary ?? view.metric
  return (
    <Tile label="Paper reports" className="sm:max-w-[300px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cx('font-semibold tabular-nums [overflow-wrap:anywhere]', view.kind === 'none' ? 'text-muted' : 'text-fg')}>
          {effectText(view, claim.direction)}
        </span>
        {view.kind === 'gain' && <GainGauge gainPct={view.gainPct} />}
        {view.kind === 'neutral' && <span className="text-xs text-muted">absolute value</span>}
      </div>
      {summary && (
        <Truncate lines={2} as="div" className="mt-0.5 text-xs text-muted">
          {sanitizeText(summary)}
        </Truncate>
      )}
    </Tile>
  )
}

function shortModel(project: Project | undefined): string | null {
  const models = project?.models
  if (!models) return null
  const evalModel = (models as Record<string, unknown>).eval ?? Object.values(models)[0]
  if (!evalModel) return null
  const id = typeof evalModel === 'string' ? evalModel : (evalModel as { id?: string }).id
  return id ? id.split('/').pop() ?? id : null
}

/** Paper's hardware and model vs this project's. Names wrap instead of being cut. */
export function HardwareTile({ claim, project }: { claim: Claim; project?: Project }) {
  const setup = claim.card?.paper_setup
  const paperHardware = setup?.hardware ? String(setup.hardware) : null
  const fit = compareHardware(paperHardware, project?.hardware)
  const mine = project?.hardware?.chip ? String(project.hardware.chip) : project?.name
  const model = shortModel(project)
  return (
    <Tile label={fit === 'same' ? 'Same hardware class' : fit === 'different' ? 'Different hardware' : 'Paper vs yours'} className="sm:max-w-[320px]">
      <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
        {fit === 'same' && <CheckIcon size={12} className="shrink-0 text-muted" />}
        {fit === 'different' && <AlertIcon size={12} className="shrink-0 text-caution-fg" />}
        <span className="min-w-0 rounded bg-canvas-subtle px-1.5 py-px ring-1 ring-line-muted [overflow-wrap:anywhere]">
          <span className="sr-text">Paper: </span>
          {paperHardware ?? 'Not reported'}
        </span>
        <span className="text-muted">vs</span>
        <span className="min-w-0 rounded bg-info-subtle px-1.5 py-px text-info-fg [overflow-wrap:anywhere]">
          <span className="sr-text">Yours: </span>
          {mine ?? 'your project'}
        </span>
      </div>
      {(setup?.model || model) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted [overflow-wrap:anywhere]">
          {setup?.model ? String(setup.model) : 'Model not reported'}
          <ArrowRightIcon size={12} className="shrink-0" />
          <span className="sr-text">vs your model</span>
          {model ?? 'your model'}
        </div>
      )}
    </Tile>
  )
}

/** Lossless / approximate as a neutral tag; the meaning is in a tooltip. */
export function LosslessBadge({ lossless }: { lossless: boolean | null | undefined }) {
  if (lossless === null || lossless === undefined) return null
  return lossless ? (
    <Tag icon={<CheckIcon size={12} className="shrink-0" />} title="Outputs stay identical to the baseline under greedy decoding.">
      Lossless
    </Tag>
  ) : (
    <Tag icon={<ApproxIcon size={12} className="shrink-0" />} title="Approximate: outputs may change, so the quality guardrail applies.">
      Approximate
    </Tag>
  )
}

/** At-a-glance strip: reported effect, fit/effort/risk, paper vs your hardware, lossless. */
export function GlanceStrip({ claim, explainer, project, fit, blockers = [] }: {
  claim: Claim
  explainer?: ClaimExplainer | null
  project?: Project
  fit?: number | null
  blockers?: string[]
}) {
  const effort = effortLevel(claim.effort)
  const risk = riskLevel(claim, explainer, blockers)
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-stretch">
      <EffectTile claim={claim} explainer={explainer} />
      <Tile label="At a glance">
        <div className="flex flex-wrap gap-1.5">
          {typeof fit === 'number' && <LevelTag kind="fit" level={fitLevel(fit)} />}
          {effort && <LevelTag kind="effort" level={effort} />}
          <LevelTag kind="risk" level={risk} />
        </div>
      </Tile>
      <HardwareTile claim={claim} project={project} />
      {explainer?.lossless !== undefined && explainer?.lossless !== null && (
        <div className="flex items-center">
          <LosslessBadge lossless={explainer.lossless} />
        </div>
      )}
    </div>
  )
}

// ---- claim explainer ----------------------------------------------------------------------

/** Headline + one-line problem under a claim title (falls back to the technique). */
export function ClaimLead({ claim, explainer, clamp = true }: { claim: Claim; explainer?: ClaimExplainer | null; clamp?: boolean }) {
  if (!explainer?.headline) return <p className={cx('mt-1 text-sm text-fg', clamp && 'line-clamp-2')}>{sanitizeText(claim.technique)}</p>
  return (
    <div className="mt-1 space-y-1">
      <p className="text-sm font-medium text-fg">{sanitizeText(explainer.headline)}</p>
      {explainer.problem && (
        <p className={cx('text-sm text-muted', clamp && 'line-clamp-2')}>
          <span className="font-medium text-fg">Problem: </span>
          <GlossaryText text={explainer.problem} glossary={explainer.glossary} />
        </p>
      )}
    </div>
  )
}

export function NumberedSteps({ steps, glossary }: { steps: string[] | undefined; glossary?: Glossary }) {
  if (!steps?.length) return null
  return (
    <ol className="relative space-y-2.5">
      {steps.map((step, index) => (
        <li key={index} className="relative flex gap-3">
          {index < steps.length - 1 && <span aria-hidden="true" className="absolute top-6 bottom-[-12px] left-[11px] w-px bg-line" />}
          <span className="z-[1] flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-canvas text-xs font-semibold text-fg">
            {index + 1}
          </span>
          <span className="pt-0.5 text-sm text-fg">
            <GlossaryText text={step} glossary={glossary} />
          </span>
        </li>
      ))}
    </ol>
  )
}

function Generated({ explainer }: { explainer: { generated_at?: string | null; model?: string | null } }) {
  if (!explainer.generated_at && !explainer.model) return null
  return (
    <p className="text-xs text-muted">
      Explanation written by {explainer.model ?? 'the LLM'}
      {explainer.generated_at && <> {relativeTime(explainer.generated_at)}</>} from the paper’s text. Check numbers against the claim card.
    </p>
  )
}

/** The claim's full flow diagram in a bordered, horizontally scrollable box; renders nothing without a diagram. */
export function ClaimDiagram({ diagram, className }: { diagram: ClaimExplainer['diagram']; className?: string }) {
  if (!diagram?.nodes?.length) return null
  return (
    <div className={cx('rounded-lg border border-line-muted bg-canvas px-3.5 py-3', className)}>
      <FlowDiagram diagram={diagram} />
    </div>
  )
}

/** Expanded explanation: steps, why it helps, where it plugs into the project, caveats, glossary and (optionally) the diagram. */
export function ClaimExplainDetails({ explainer, projectName, showDiagram = true, showGlossary = true }: {
  explainer: ClaimExplainer
  projectName?: string
  showDiagram?: boolean
  /** Off when the glossary chips are already shown above (the primer). */
  showGlossary?: boolean
}) {
  const where = explainer.in_this_project
  const glossary = explainer.glossary
  return (
    <div className="space-y-5 @container">
      {showDiagram && <ClaimDiagram diagram={explainer.diagram} />}
      <div className="grid gap-5 @2xl:grid-cols-2">
        <section>
          <h4 className="mb-2 text-sm font-semibold text-fg">How it works</h4>
          <NumberedSteps steps={explainer.how_it_works} glossary={glossary} />
        </section>
        <div className="space-y-4">
          {explainer.why_it_helps && (
            <section>
              <h4 className="mb-1 text-sm font-semibold text-fg">Why it helps</h4>
              <p className="text-sm text-fg">
                <GlossaryText text={explainer.why_it_helps} glossary={glossary} />
              </p>
            </section>
          )}
          {where && (where.where || where.change || where.measure) && (
            <section className="rounded-lg border border-line bg-canvas-subtle p-3">
              <h4 className="mb-2 text-sm font-semibold text-fg">In {projectName ?? 'your project'}</h4>
              <dl className="space-y-1.5 text-sm">
                {(
                  [
                    ['Where', where.where],
                    ['Change', where.change],
                    ['Measure', where.measure],
                  ] as const
                )
                  .filter(([, value]) => value)
                  .map(([term, value]) => (
                    <div key={term} className="grid grid-cols-[64px_1fr] gap-2">
                      <dt className="text-xs font-semibold text-muted">{term}</dt>
                      <dd className="text-fg">
                        <GlossaryText text={value} glossary={glossary} />
                      </dd>
                    </div>
                  ))}
              </dl>
            </section>
          )}
        </div>
      </div>
      {!!explainer.caveats?.length && (
        <section>
          <h4 className="mb-1.5 text-sm font-semibold text-fg">Caveats</h4>
          <ul className="space-y-1">
            {explainer.caveats.map((caveat) => (
              <li key={caveat} className="flex gap-2 text-sm text-fg">
                <AlertIcon size={14} className="mt-0.5 shrink-0 text-caution-fg" />
                <span>
                  <GlossaryText text={caveat} glossary={glossary} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {showGlossary && <GlossaryChips glossary={glossary} />}
      <Generated explainer={explainer} />
    </div>
  )
}

// ---- generate on demand -------------------------------------------------------------------

function GenerateButton({ onClick, pending, error, label = 'Generate explanation' }: { onClick: () => void; pending: boolean; error: unknown; label?: string }) {
  return (
    <div className="min-w-0">
      <Button size="sm" variant="invisible" icon={<SparkIcon size={14} />} onClick={onClick} loading={pending} className="px-1.5">
        {pending ? 'Writing explanation… (~15 s)' : label}
      </Button>
      {error ? <InlineError error={error} /> : null}
    </div>
  )
}

export function GenerateClaimExplainer({ claimId, projectId }: { claimId: number; projectId?: number }) {
  const explain = useExplainClaim(projectId)
  const toast = useToast()
  return (
    <GenerateButton
      pending={explain.isPending}
      error={explain.error}
      onClick={() => explain.mutate(claimId, { onSuccess: () => toast.success('Explanation ready'), onError: (error) => toast.error(errorMessage(error)) })}
    />
  )
}

export function GeneratePaperExplainer({ paperId }: { paperId: string }) {
  const explain = useExplainPaper()
  const toast = useToast()
  return (
    <GenerateButton
      pending={explain.isPending}
      error={explain.error}
      onClick={() => explain.mutate(paperId, { onSuccess: () => toast.success('Paper explanation ready'), onError: (error) => toast.error(errorMessage(error)) })}
    />
  )
}

export function GenerateTopicExplainer({ slug }: { slug: string }) {
  const explain = useExplainTopic()
  const toast = useToast()
  return (
    <GenerateButton
      pending={explain.isPending}
      error={explain.error}
      label="Generate topic overview"
      onClick={() => explain.mutate(slug, { onSuccess: () => toast.success('Topic overview ready'), onError: (error) => toast.error(errorMessage(error)) })}
    />
  )
}

/** Claim explainer block used by cards: expand/collapse explanation. */
export function ExplainToggle({ explainer, projectName, children }: { explainer: ClaimExplainer; projectName?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="invisible" onClick={() => setOpen(!open)} aria-expanded={open} icon={<SparkIcon size={14} />} className="px-1.5">
          {open ? 'Hide explanation' : 'Explain'}
        </Button>
        {children}
      </div>
      {open && (
        <div className="mt-3 border-t border-line-muted pt-4">
          <ClaimExplainDetails explainer={explainer} projectName={projectName} />
        </div>
      )}
    </div>
  )
}

// ---- papers -------------------------------------------------------------------------------

/**
 * The paper's key results as stat tiles (reference register: neutral ink). Values wrap and are never cut;
 * the context is shown on `md` and behind an ⓘ popover on `sm`.
 */
export function ResultTiles({ results, max = 4, size = 'sm' }: { results: PaperExplainer['key_results']; max?: number; size?: 'sm' | 'md' }) {
  if (!results?.length) return null
  return (
    <ul className={cx('grid gap-2', size === 'md' ? 'grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]' : 'grid-cols-[repeat(auto-fit,minmax(8rem,1fr))]')}>
      {results.slice(0, max).map((result, index) => (
        <li key={index} className="min-w-0">
          <StatTile
            label={sanitizeText(result.label)}
            value={formatReportedValue(result.value) ?? sanitizeText(result.value)}
            context={size === 'md' && result.context ? sanitizeText(result.context) : undefined}
            info={size === 'sm' && result.context ? sanitizeText(result.context) : undefined}
            className="h-full"
          />
        </li>
      ))}
    </ul>
  )
}

export { Generated as ExplainerFootnote }
