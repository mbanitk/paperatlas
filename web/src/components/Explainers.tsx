import { Fragment, useId, useState, type ReactNode } from 'react'
import { useExplainClaim, useExplainPaper, useExplainTopic } from '../api/queries'
import type { Claim, ClaimExplainer, PaperExplainer, Project } from '../api/types'
import { claimedEffectView, compareHardware, EFFORT_LEVEL, riskLevel, type Level } from '../lib/claims'
import { formatPct, relativeTime } from '../lib/format'
import { FlowDiagram } from './FlowDiagram'
import { AlertIcon, CheckIcon, SparkIcon } from './Icons'
import { useToast } from './Toast'
import { Button, Chip, InlineError, cx, errorMessage } from './ui'

// ---- glossary -----------------------------------------------------------------------------

type Glossary = { term: string; meaning: string }[] | undefined

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Text with glossary terms underlined (dotted) and explained on hover/focus. */
export function GlossaryText({ text, glossary }: { text: string | undefined | null; glossary: Glossary }) {
  if (!text) return null
  const terms = (glossary ?? []).filter((item) => item?.term && item.term.length > 1)
  if (!terms.length) return <>{text}</>
  const pattern = new RegExp(`(${terms.map((item) => escapeRegExp(item.term)).join('|')})`, 'gi')
  const parts = text.split(pattern)
  return (
    <>
      {parts.map((part, index) => {
        const item = terms.find((entry) => entry.term.toLowerCase() === part.toLowerCase())
        return item ? (
          <abbr key={index} title={item.meaning} className="cursor-help underline decoration-subtle decoration-dotted underline-offset-2 [text-decoration-line:underline]">
            {part}
          </abbr>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        )
      })}
    </>
  )
}

function TermChip({ term, meaning }: { term: string; meaning: string }) {
  const id = useId()
  return (
    <span className="group relative inline-flex">
      <button type="button" aria-describedby={id} className="chip cursor-help border-line bg-canvas text-fg hover:border-accent focus:border-accent">
        {term}
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 hidden w-[min(16rem,calc(100vw-3rem))] rounded-md border border-line bg-fg px-2.5 py-1.5 text-xs leading-snug text-white shadow-lg group-focus-within:block group-hover:block"
      >
        {meaning}
      </span>
    </span>
  )
}

export function GlossaryChips({ glossary }: { glossary: Glossary }) {
  if (!glossary?.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted">Terms:</span>
      {glossary.map((item) => (
        <TermChip key={item.term} term={item.term} meaning={item.meaning} />
      ))}
    </div>
  )
}

// ---- small infographics ------------------------------------------------------------------

/** Horizontal gain bar (0–100 %, capped) with a tick at the success bar (default 5 %). */
export function GainGauge({ gainPct, threshold = 5, className }: { gainPct: number; threshold?: number; className?: string }) {
  const width = Math.max(2, Math.min(100, gainPct))
  return (
    <span
      className={cx('relative inline-block h-1.5 w-20 overflow-visible rounded-full bg-canvas-inset align-middle', className)}
      role="meter"
      aria-label={`Claimed gain ${formatPct(gainPct, 0)} vs a ${threshold}% success bar`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(100, gainPct)}
    >
      <span className="absolute inset-y-0 left-0 rounded-full bg-success-emphasis" style={{ width: `${width}%` }} />
      {gainPct > 100 && <span className="absolute -top-0.5 -right-1.5 text-[9px] leading-none font-bold text-success">+</span>}
      <span className="absolute -top-0.5 h-2.5 w-px bg-fg/60" style={{ left: `${threshold}%` }} title={`${threshold}% success bar`} />
    </span>
  )
}

const LEVEL_INDEX: Record<Level, number> = { low: 1, medium: 2, high: 3 }

/** Three-dot meter (low / medium / high). `invert` makes high = good (green). */
export function LevelDots({ label, level, invert = false }: { label: string; level: Level; invert?: boolean }) {
  const filled = LEVEL_INDEX[level]
  const good = invert ? level === 'high' : level === 'low'
  const bad = invert ? level === 'low' : level === 'high'
  const color = good ? 'bg-success-emphasis' : bad ? 'bg-danger-emphasis' : 'bg-attention-emphasis'
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted" title={`${label}: ${level}`}>
      <span className="w-9">{label}</span>
      <span className="inline-flex gap-0.5" role="img" aria-label={`${label} ${level}`}>
        {[1, 2, 3].map((i) => (
          <span key={i} className={cx('h-1.5 w-2.5 rounded-full', i <= filled ? color : 'bg-canvas-inset')} />
        ))}
      </span>
    </span>
  )
}

export function BarMeterInline({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted" title={`${label}: ${value.toFixed(2)}`}>
      <span className="w-9">{label}</span>
      <span className="relative inline-block h-1.5 w-[38px] overflow-hidden rounded-full bg-canvas-inset" role="meter" aria-label={`${label} ${value.toFixed(2)}`} aria-valuemin={0} aria-valuemax={1} aria-valuenow={value}>
        <span className="absolute inset-y-0 left-0 rounded-full bg-done" style={{ width: `${pct}%` }} />
      </span>
    </span>
  )
}

function Tile({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0 rounded-md border border-line-muted bg-canvas-subtle/60 px-2.5 py-1.5', className)}>
      <div className="text-[10.5px] font-medium tracking-wide text-subtle uppercase">{label}</div>
      <div className="mt-0.5 min-w-0 text-sm">{children}</div>
    </div>
  )
}

export function EffectTile({ claim, explainer }: { claim: Claim; explainer?: ClaimExplainer | null }) {
  const view = claimedEffectView(claim, explainer)
  return (
    <Tile label="Paper reports" className="sm:max-w-[300px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cx('font-semibold tabular-nums', view.kind === 'gain' ? 'text-success' : 'text-fg')}>{view.text}</span>
        {view.kind === 'gain' && <GainGauge gainPct={view.gainPct} />}
        {view.kind === 'neutral' && <span className="text-[11px] text-muted">absolute value</span>}
      </div>
      <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted" title={view.summary ?? view.metric ?? undefined}>
        {view.summary ?? view.metric ?? 'No number reported'}
      </div>
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

export function HardwareTile({ claim, project }: { claim: Claim; project?: Project }) {
  const setup = claim.card?.paper_setup
  const paperHardware = setup?.hardware ? String(setup.hardware) : null
  const fit = compareHardware(paperHardware, project?.hardware)
  const mine = project?.hardware?.chip ? String(project.hardware.chip) : project?.name
  const icon =
    fit === 'same' ? (
      <CheckIcon size={12} className="text-success" />
    ) : fit === 'different' ? (
      <AlertIcon size={12} className="text-attention" />
    ) : null
  return (
    <Tile label={fit === 'same' ? 'Same hardware class' : fit === 'different' ? 'Different hardware' : 'Paper vs yours'} className="sm:max-w-[300px]">
      <div className="flex min-w-0 flex-wrap items-center gap-1 text-[12px]">
        {icon}
        <span className="max-w-[150px] truncate rounded bg-canvas px-1.5 py-px ring-1 ring-line-muted" title={`Paper: ${paperHardware ?? 'not reported'}`}>
          {paperHardware ?? 'not reported'}
        </span>
        <span className="text-subtle">vs</span>
        <span className="max-w-[120px] truncate rounded bg-accent-subtle px-1.5 py-px text-accent" title={`Your hardware: ${mine ?? 'unknown'}`}>
          {mine ?? 'your project'}
        </span>
      </div>
      {(setup?.model || shortModel(project)) && (
        <div className="mt-0.5 truncate text-[11.5px] text-muted" title={`Paper model: ${setup?.model ?? 'not reported'} · your eval model: ${shortModel(project) ?? 'unknown'}`}>
          {setup?.model ? String(setup.model) : 'model not reported'} → {shortModel(project) ?? 'your model'}
        </div>
      )}
    </Tile>
  )
}

export function LosslessBadge({ lossless }: { lossless: boolean | null | undefined }) {
  if (lossless === null || lossless === undefined) return null
  return lossless ? (
    <Chip tone="success" title="Outputs stay identical to the baseline under greedy decoding">
      <CheckIcon size={12} /> lossless
    </Chip>
  ) : (
    <Chip tone="attention" title="Approximate: outputs may change; the quality guardrail applies">
      ≈ approximate
    </Chip>
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
  const effort = claim.effort ? ((['low', 'medium', 'high'] as Level[])[(EFFORT_LEVEL[claim.effort] ?? 2) - 1] ?? 'medium') : null
  const risk = riskLevel(claim, explainer, blockers)
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-stretch">
      <EffectTile claim={claim} explainer={explainer} />
      <Tile label="At a glance">
        <div className="flex flex-col gap-0.5">
          {typeof fit === 'number' && <BarMeterInline label="fit" value={fit} />}
          {effort && <LevelDots label="effort" level={effort} />}
          <LevelDots label="risk" level={risk} />
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
  if (!explainer?.headline) return <p className="mt-1.5 text-sm text-fg">{claim.technique}</p>
  return (
    <div className="mt-1.5 space-y-1">
      <p className="text-[15px] leading-snug font-medium text-fg">{explainer.headline}</p>
      {explainer.problem && (
        <p className={cx('text-sm text-muted', clamp && 'line-clamp-2')}>
          <span className="font-medium text-fg/80">Problem: </span>
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
          <span className="z-[1] flex size-6 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent-subtle text-xs font-semibold text-accent">
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
    <p className="text-[11px] text-subtle">
      Explanation written by {explainer.model ?? 'the LLM'}
      {explainer.generated_at && <> {relativeTime(explainer.generated_at)}</>} from the paper’s text — check numbers against the claim card.
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
export function ClaimExplainDetails({ explainer, projectName, showDiagram = true }: { explainer: ClaimExplainer; projectName?: string; showDiagram?: boolean }) {
  const where = explainer.in_this_project
  const glossary = explainer.glossary
  return (
    <div className="space-y-5 @container">
      {showDiagram && <ClaimDiagram diagram={explainer.diagram} />}
      <div className="grid gap-5 @2xl:grid-cols-2">
        <section>
          <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">How it works</h4>
          <NumberedSteps steps={explainer.how_it_works} glossary={glossary} />
        </section>
        <div className="space-y-4">
          {explainer.why_it_helps && (
            <section>
              <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Why it helps</h4>
              <p className="text-sm text-fg">
                <GlossaryText text={explainer.why_it_helps} glossary={glossary} />
              </p>
            </section>
          )}
          {where && (where.where || where.change || where.measure) && (
            <section className="rounded-md border border-accent/30 bg-accent-subtle/40 p-3">
              <h4 className="mb-2 text-xs font-semibold tracking-wide text-accent uppercase">In {projectName ?? 'your project'}</h4>
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
          <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Caveats</h4>
          <ul className="space-y-1">
            {explainer.caveats.map((caveat) => (
              <li key={caveat} className="flex gap-2 text-sm text-fg">
                <AlertIcon size={14} className="mt-0.5 shrink-0 text-attention" />
                <span>
                  <GlossaryText text={caveat} glossary={glossary} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <GlossaryChips glossary={glossary} />
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

export function ResultTiles({ results, max = 4, size = 'sm' }: { results: PaperExplainer['key_results']; max?: number; size?: 'sm' | 'md' }) {
  if (!results?.length) return null
  return (
    <ul className={cx('grid gap-2', size === 'md' ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-2 sm:grid-cols-4')}>
      {results.slice(0, max).map((result, index) => (
        <li key={index} className="min-w-0 rounded-md border border-line-muted bg-canvas-subtle/60 px-2.5 py-1.5" title={result.context || undefined}>
          <div className={cx('truncate font-semibold text-done tabular-nums', size === 'md' ? 'text-xl' : 'text-base')}>{result.value}</div>
          <div className="truncate text-[11.5px] text-fg">{result.label}</div>
          {size === 'md' && result.context && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted">{result.context}</div>}
        </li>
      ))}
    </ul>
  )
}

export { Generated as ExplainerFootnote }
