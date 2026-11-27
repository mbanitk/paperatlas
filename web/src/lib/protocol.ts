import type {
  EditableField,
  Experiment,
  ExperimentSpec,
  ExperimentSummary,
  Fidelity,
  FidelityLevel,
  Knob,
  KnobValue,
  MechanismCounter,
  PaperBaseline,
  PaperBaselineKind,
  PaperWorkload,
  ProtocolField,
  TuningResult,
  VerdictDetails,
} from '../api/types'
import { formatSigned, humanizeMetric } from './format'
import {
  ADOPTION,
  adoptionSemantics,
  claimCheckSemantics,
  DIAGNOSIS,
  diagnosisSemantics,
  FIDELITY,
  type SemanticInfo,
  type SemanticTone,
} from './semantics'

// Mirrors src/paperatlas/lab/protocol.py and planner._normalize_protocol.
export const MAX_TUNE_CONFIGS = 4
export const MAX_PAPER_PROMPTS = 6
export const MAX_COUNTERS = 4
export const MAX_KNOBS = 3
export const MAX_CANDIDATES = 3
/** keep-or-revert loop: build → measure → diagnose rounds (planner.ExperimentSpec.max_iterations, 1–5) */
export const MAX_ITERATIONS = 5
/** planner._normalize_protocol clamps new tokens to 16–256 and keeps prompts within a 1,200-token round. */
export const MIN_NEW_TOKENS = 16
export const MAX_NEW_TOKENS = 256
export const MAX_ROUND_TOKENS = 1200
export const maxPrompts = (maxNewTokens: number) =>
  Math.max(1, Math.min(MAX_PAPER_PROMPTS, Math.floor(MAX_ROUND_TOKENS / Math.max(MIN_NEW_TOKENS, Math.min(maxNewTokens || 128, MAX_NEW_TOKENS)))))

export const SCALAR_FIELDS: EditableField[] = ['hypothesis', 'flag_name', 'primary_metric', 'success_threshold_pct', 'rounds', 'warmup', 'workload', 'model']
export const PROTOCOL_FIELDS: ProtocolField[] = ['paper_baseline', 'paper_workload', 'mechanism', 'knobs', 'fidelity', 'lossless', 'tune', 'max_iterations']

export const isScalarField = (field: string): field is EditableField => (SCALAR_FIELDS as string[]).includes(field)
export const isProtocolField = (field: string): field is ProtocolField => (PROTOCOL_FIELDS as string[]).includes(field)

export const PROTOCOL_LABELS: Record<ProtocolField, string> = {
  paper_baseline: 'Paper baseline',
  paper_workload: 'Paper workload',
  mechanism: 'Mechanism counters',
  knobs: 'Knobs',
  fidelity: 'Fidelity',
  lossless: 'Lossless',
  tune: 'Tuning',
  max_iterations: 'Max iterations',
}

export const BASELINE_KIND_LABELS: Record<PaperBaselineKind, string> = {
  project_default: 'Project default (flag off)',
  technique_mode: 'Another method — same flag, mode=baseline',
}

// ---- normalised protocol (spec_defaults) ------------------------------------------------------

export interface Protocol {
  version: number
  paper_baseline: PaperBaseline
  paper_workload: PaperWorkload | null
  mechanism: MechanismCounter[]
  knobs: Knob[]
  fidelity: Fidelity
  lossless: boolean
  tune: boolean
  tune_rounds: number
  max_iterations: number
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim())
const optionalText = (value: unknown) => text(value) || null
/** Counter and knob names are snake_case on the backend ("Verify Passes" → "verify_passes"). */
export const snakeName = (value: unknown, fallback: string) =>
  text(value).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || fallback
const int = (value: unknown, fallback: number) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : fallback
}

/** Knob candidate as the backend stores it ("4" → 4, "true" → true). */
export function coerceKnobValue(value: unknown): KnobValue {
  if (typeof value === 'number' || typeof value === 'boolean') return value
  const raw = text(value)
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true'
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

export const formatKnobValue = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))

function normalizeWorkload(workload: Partial<PaperWorkload> | null | undefined): PaperWorkload | null {
  const prompts = (workload?.prompts ?? []).map(text).filter(Boolean)
  if (!workload || !prompts.length) return null
  return {
    matches: text(workload.matches),
    description: text(workload.description),
    prompts,
    max_new_tokens: int(workload.max_new_tokens, 128),
    concurrency: int(workload.concurrency, 1),
    long_context_tokens: int(workload.long_context_tokens, 0),
  }
}

const normalizeCounters = (counters: Partial<MechanismCounter>[] | null | undefined): MechanismCounter[] =>
  (counters ?? []).filter((c) => text(c?.name)).map((c) => ({ name: snakeName(c.name, 'counter'), meaning: text(c.meaning), paper_value: optionalText(c.paper_value) }))

const normalizeKnobs = (knobs: Partial<Knob>[] | null | undefined): Knob[] =>
  (knobs ?? [])
    .filter((k) => text(k?.name))
    .map((k) => ({
      name: snakeName(k.name, 'knob'),
      meaning: text(k.meaning),
      paper_value: optionalText(k.paper_value),
      candidates: [...new Map((k.candidates ?? []).map((v) => coerceKnobValue(v)).map((v) => [JSON.stringify(v), v])).values()],
    }))

/** Protocol fields with the backend's defaults filled in, so v1 specs read like "no protocol". */
export function protocolOf(spec: Partial<ExperimentSpec>): Protocol {
  const baseline = spec.paper_baseline
  const fidelity = spec.fidelity
  return {
    version: int(spec.protocol_version, 1),
    paper_baseline: { kind: baseline?.kind === 'technique_mode' ? 'technique_mode' : 'project_default', description: text(baseline?.description) },
    paper_workload: normalizeWorkload(spec.paper_workload),
    mechanism: normalizeCounters(spec.mechanism),
    knobs: normalizeKnobs(spec.knobs),
    fidelity: {
      level: fidelity?.level === 'high' || fidelity?.level === 'low' ? fidelity.level : 'medium',
      gaps: (fidelity?.gaps ?? []).map(text).filter(Boolean),
    },
    lossless: !!spec.lossless,
    tune: !!spec.tune,
    tune_rounds: int(spec.tune_rounds, 1),
    max_iterations: int(spec.max_iterations, 1),
  }
}

export const isProtocolV2 = (spec: Partial<ExperimentSpec>) => int(spec.protocol_version, 1) >= 2

/** The adoption check runs separately only when the claim check uses the paper's baseline or workload. */
export function needsAdoptionCheck(spec: Partial<ExperimentSpec>): boolean {
  const protocol = protocolOf(spec)
  return protocol.version >= 2 && (protocol.paper_baseline.kind === 'technique_mode' || !!protocol.paper_workload)
}

/** Tuning configurations: the paper's setting first, then one knob changed at a time (≤ 4). */
export function tuneConfigs(knobs: Knob[]): Record<string, KnobValue>[] {
  const usable = knobs.filter((knob) => knob.candidates.length)
  if (!usable.length) return []
  const base = Object.fromEntries(usable.map((knob) => [knob.name, knob.candidates[0]]))
  const configs = [base]
  for (const knob of usable)
    for (const value of knob.candidates.slice(1)) {
      const config = { ...base, [knob.name]: value }
      if (!configs.some((existing) => JSON.stringify(existing) === JSON.stringify(config))) configs.push(config)
      if (configs.length >= MAX_TUNE_CONFIGS) return configs
    }
  return configs
}

/** Target for the claim check: 70% of the paper's claim, never below the success bar (judge.evaluate). */
export function claimTarget(claimed: number | null | undefined, threshold: number | null | undefined): number | null {
  const bar = typeof threshold === 'number' ? threshold : 0
  return typeof claimed === 'number' ? Math.max(bar, 0.7 * claimed) : typeof threshold === 'number' ? threshold : null
}

// ---- Gate 2 form ------------------------------------------------------------------------------

export interface ProtocolForm {
  paper_baseline: { kind: PaperBaselineKind; description: string }
  paper_workload: {
    enabled: boolean
    matches: string
    description: string
    prompts: string[]
    max_new_tokens: string
    concurrency: string
    long_context_tokens: string
  }
  mechanism: { name: string; meaning: string; paper_value: string }[]
  knobs: { name: string; meaning: string; paper_value: string; candidates: string }[]
  fidelity: { level: FidelityLevel; gaps: string }
  lossless: boolean
  tune: boolean
  max_iterations: number
}

export function protocolToForm(spec: Partial<ExperimentSpec>): ProtocolForm {
  const protocol = protocolOf(spec)
  const workload = protocol.paper_workload
  return {
    paper_baseline: { ...protocol.paper_baseline },
    paper_workload: {
      enabled: !!workload,
      matches: workload?.matches ?? '',
      description: workload?.description ?? '',
      prompts: workload?.prompts.length ? [...workload.prompts] : [''],
      max_new_tokens: String(workload?.max_new_tokens ?? 128),
      concurrency: String(workload?.concurrency ?? 1),
      long_context_tokens: String(workload?.long_context_tokens ?? 0),
    },
    mechanism: protocol.mechanism.map((c) => ({ name: c.name, meaning: c.meaning, paper_value: c.paper_value ?? '' })),
    knobs: protocol.knobs.map((k) => ({ name: k.name, meaning: k.meaning, paper_value: k.paper_value ?? '', candidates: k.candidates.map(formatKnobValue).join(', ') })),
    fidelity: { level: protocol.fidelity.level, gaps: protocol.fidelity.gaps.join('\n') },
    lossless: protocol.lossless,
    tune: protocol.tune,
    max_iterations: protocol.max_iterations,
  }
}

export const parseCandidates = (raw: string): KnobValue[] =>
  [...new Map(raw.split(',').map((part) => part.trim()).filter(Boolean).map(coerceKnobValue).map((v) => [JSON.stringify(v), v])).values()]

/** The value Gate 2 sends for a protocol field (normalised like the backend stores it). */
export function protocolValue(field: ProtocolField, form: ProtocolForm): unknown {
  switch (field) {
    case 'paper_baseline':
      return { kind: form.paper_baseline.kind, description: form.paper_baseline.description.trim() }
    case 'paper_workload': {
      const w = form.paper_workload
      if (!w.enabled) return null
      return normalizeWorkload({
        matches: w.matches,
        description: w.description,
        prompts: w.prompts,
        max_new_tokens: Number(w.max_new_tokens),
        concurrency: Number(w.concurrency),
        long_context_tokens: Number(w.long_context_tokens),
      })
    }
    case 'mechanism':
      return normalizeCounters(form.mechanism)
    case 'knobs':
      return normalizeKnobs(form.knobs.map((k) => ({ ...k, candidates: parseCandidates(k.candidates) })))
    case 'fidelity':
      return { level: form.fidelity.level, gaps: form.fidelity.gaps.split('\n').map((g) => g.trim()).filter(Boolean) }
    default:
      return form[field]
  }
}

/** The spec's current value of a protocol field, normalised the same way as `protocolValue`. */
export function specProtocolValue(field: ProtocolField, spec: Partial<ExperimentSpec>): unknown {
  const protocol = protocolOf(spec)
  return field === 'max_iterations' ? protocol.max_iterations : protocol[field]
}

/** Only the protocol fields the reviewer changed. */
export function protocolOverrides(spec: Partial<ExperimentSpec>, form: ProtocolForm, fields: readonly ProtocolField[]): Partial<Record<ProtocolField, unknown>> {
  const overrides: Partial<Record<ProtocolField, unknown>> = {}
  for (const field of fields) {
    const next = protocolValue(field, form)
    if (JSON.stringify(next) !== JSON.stringify(specProtocolValue(field, spec))) overrides[field] = next
  }
  return overrides
}

/** Like rebaseForm: untouched protocol fields follow a changed server spec, edited ones are kept. */
export function rebaseProtocol(base: ProtocolForm, form: ProtocolForm, spec: Partial<ExperimentSpec>, fields: readonly ProtocolField[]): ProtocolForm {
  const next = protocolToForm(spec)
  const rebased = { ...form }
  for (const field of fields) {
    const touched = JSON.stringify(protocolValue(field, form)) !== JSON.stringify(protocolValue(field, base))
    const saved = JSON.stringify(protocolValue(field, form)) === JSON.stringify(specProtocolValue(field, spec))
    if (!touched || saved) (rebased as Record<ProtocolField, unknown>)[field] = next[field]
  }
  return rebased
}

export type ProtocolErrors = Partial<Record<string, string>>

/** Client-side checks mirroring the protocol models (errors keyed by field or `field.index.key`). */
export function validateProtocol(form: ProtocolForm): ProtocolErrors {
  const errors: ProtocolErrors = {}
  const intIn = (key: string, raw: string, low: number, high: number) => {
    const value = Number(raw)
    if (raw.trim() === '' || !Number.isInteger(value) || value < low || value > high) errors[key] = `Whole number between ${low} and ${high}.`
  }
  if (form.paper_baseline.kind === 'technique_mode' && !form.paper_baseline.description.trim())
    errors['paper_baseline.description'] = 'Describe the paper’s baseline method — the coding agent implements it as mode=baseline.'
  const workload = form.paper_workload
  if (workload.enabled) {
    const prompts = workload.prompts.filter((p) => p.trim())
    intIn('paper_workload.max_new_tokens', workload.max_new_tokens, MIN_NEW_TOKENS, MAX_NEW_TOKENS)
    const limit = maxPrompts(Number(workload.max_new_tokens))
    if (!prompts.length) errors['paper_workload.prompts'] = 'Add at least one prompt, or turn the paper workload off.'
    else if (prompts.length > limit)
      errors['paper_workload.prompts'] =
        limit < MAX_PAPER_PROMPTS
          ? `At most ${limit} prompts at ${workload.max_new_tokens} new tokens (${MAX_ROUND_TOKENS.toLocaleString('en-US')}-token round budget).`
          : `At most ${MAX_PAPER_PROMPTS} prompts.`
    intIn('paper_workload.concurrency', workload.concurrency, 1, 8)
    intIn('paper_workload.long_context_tokens', workload.long_context_tokens, 0, 16000)
  }
  if (form.mechanism.length > MAX_COUNTERS) errors.mechanism = `At most ${MAX_COUNTERS} counters.`
  form.mechanism.forEach((row, index) => {
    if (!row.name.trim() && (row.meaning.trim() || row.paper_value.trim())) errors[`mechanism.${index}.name`] = 'Name the counter.'
  })
  if (form.knobs.length > MAX_KNOBS) errors.knobs = `At most ${MAX_KNOBS} knobs.`
  form.knobs.forEach((row, index) => {
    if (!row.name.trim()) errors[`knobs.${index}.name`] = 'Name the knob.'
    const candidates = parseCandidates(row.candidates)
    if (!candidates.length) errors[`knobs.${index}.candidates`] = 'List 1–3 values, the paper’s first.'
    else if (candidates.length > MAX_CANDIDATES) errors[`knobs.${index}.candidates`] = `At most ${MAX_CANDIDATES} values.`
  })
  if (!Number.isInteger(form.max_iterations) || form.max_iterations < 1 || form.max_iterations > MAX_ITERATIONS)
    errors.max_iterations = `Between 1 and ${MAX_ITERATIONS}.`
  return errors
}

/** One-line description of a protocol value for the "Your edits" list. */
export function describeProtocolValue(field: ProtocolField, value: unknown): string {
  switch (field) {
    case 'paper_baseline': {
      const baseline = value as PaperBaseline
      const description = baseline.description.length > 70 ? `${baseline.description.slice(0, 69)}…` : baseline.description
      return `${BASELINE_KIND_LABELS[baseline.kind]}${description ? ` — ${description}` : ''}`
    }
    case 'paper_workload': {
      const workload = value as PaperWorkload | null
      return workload ? workloadSummary(workload) : 'none (claim check uses the project workload)'
    }
    case 'mechanism':
      return (value as MechanismCounter[]).map((c) => c.name).join(', ') || 'none'
    case 'knobs':
      return (value as Knob[]).map((k) => `${k.name} ∈ {${k.candidates.map(formatKnobValue).join(', ')}}`).join('; ') || 'none'
    case 'fidelity': {
      const fidelity = value as Fidelity
      return `${fidelity.level}${fidelity.gaps.length ? ` · ${fidelity.gaps.length} gap${fidelity.gaps.length > 1 ? 's' : ''}` : ''}`
    }
    case 'lossless':
    case 'tune':
      return value ? 'on' : 'off'
    default:
      return String(value)
  }
}

export function workloadSummary(workload: PaperWorkload): string {
  const parts = [
    `${workload.prompts.length} prompt${workload.prompts.length === 1 ? '' : 's'}`,
    `${workload.max_new_tokens} new tokens`,
    `concurrency ${workload.concurrency}`,
  ]
  if (workload.long_context_tokens) parts.push(`~${workload.long_context_tokens.toLocaleString('en-US')}-token context`)
  return parts.join(' · ')
}

// ---- verdicts, diagnoses, iterations ------------------------------------------------------------

// Words, tones and icons live in lib/semantics.ts (one vocabulary for the whole console); these names stay
// for existing imports.
export { ADOPTION, DIAGNOSIS, FIDELITY }
export const FIDELITY_INFO: Record<FidelityLevel, SemanticInfo> = FIDELITY
export const ADOPTION_INFO: Record<string, SemanticInfo> = ADOPTION
export const adoptionInfo = (verdict: string | null | undefined): SemanticInfo => adoptionSemantics(verdict)
export const DIAGNOSIS_INFO: Record<string, SemanticInfo> = DIAGNOSIS
export const diagnosisInfo = (diagnosis: string | null | undefined): SemanticInfo => diagnosisSemantics(diagnosis)

export const RUN_KIND_LABELS: Record<string, string> = { smoke: 'Smoke', tune: 'Tuning', eval: 'Claim check', adopt: 'Adoption check' }
export const runKindLabel = (kind: string) => RUN_KIND_LABELS[kind] ?? kind.replace(/_/g, ' ')

const ITERATING_STATUSES = new Set(['approving', 'building', 'smoke_testing', 'tuning', 'waiting_gpu', 'running', 'judging'])

/** Iteration in progress (or the last judged one): judge can send the build back for another try. */
export function currentIteration(experiment: Pick<Experiment, 'status' | 'build' | 'verdict_detail'>): number {
  const judged = Math.max(experiment.build?.iterations?.length ?? 0, experiment.verdict_detail?.details?.iterations?.length ?? 0)
  const inFlight = ITERATING_STATUSES.has(experiment.status) && judged > 0 ? judged + 1 : judged
  return Math.max(1, Number(experiment.build?.iteration) || 1, Number(experiment.verdict_detail?.details?.iteration) || 1, inFlight)
}

/** Which arms chose a tuning config ("method", "baseline", both or none). */
export function chosenBy(tuning: Pick<TuningResult, 'baseline' | 'variant'>, config: Record<string, KnobValue>): ('baseline' | 'method')[] {
  const key = (value: Record<string, KnobValue>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  const chosen: ('baseline' | 'method')[] = []
  if (tuning.baseline && Object.keys(tuning.baseline).length && key(tuning.baseline) === key(config)) chosen.push('baseline')
  if (tuning.variant && Object.keys(tuning.variant).length && key(tuning.variant) === key(config)) chosen.push('method')
  return chosen
}

export const formatConfig = (config: Record<string, KnobValue> | null | undefined) =>
  config && Object.keys(config).length ? Object.entries(config).map(([k, v]) => `${k}=${formatKnobValue(v)}`).join(', ') : '—'

// ---- Gate 3: the bottom line (docs/ux-review.md X-1) ----------------------------------------------

export type DecisionAction = 'merge' | 'drop' | 'your_call'

/** What `recommendDecision` reads: a `VerdictDetail`, or anything shaped like one (e.g. built from a list row). */
export interface DecisionInput {
  verdict: string | null | undefined
  primary_metric?: string | null
  median_delta_pct?: number | null
  ci_low_pct?: number | null
  ci_high_pct?: number | null
  claimed_gain_pct?: number | null
  quality_ok?: boolean | null
  details?:
    | (Pick<VerdictDetails, 'worth_adopting' | 'success_threshold_pct' | 'target_pct' | 'quality_problems' | 'validity_warnings' | 'comparison'> & {
        adoption?: Partial<NonNullable<VerdictDetails['adoption']>> | null
      })
    | null
}

export interface CheckResult {
  verdict: string
  info: SemanticInfo
  delta: number | null
  low: number | null
  high: number | null
  /** false only when a quality guardrail is known to have failed. */
  qualityOk: boolean
  /** 'unmeasured': quality wasn't (fully) measured, which the judge reports as inconclusive, not as a failure. */
  quality: 'ok' | 'failed' | 'unmeasured'
  qualityProblems: string[]
}

export interface DecisionRecommendation {
  action: DecisionAction
  /** "Merge", "Drop" or "Your call". */
  label: string
  tone: SemanticTone
  /** The decisive reason, with its number. */
  reason: string
  /** What the claim check says about the paper's claim. */
  claimSentence: string
  claim: CheckResult
  /** The adoption check; derived from the claim check when that already ran on the project default. */
  adoption: CheckResult
  /** false when no separate adoption check ran (the claim check already used the project default and workload). */
  separateAdoption: boolean
  /** No separate adoption check, and the claim check used the paper's baseline or workload: nothing measured on the default. */
  paperOnly: boolean
  /** One line for dialogs and rows: "Claim check: Partly reproduced +2.8% · Adoption check: Worse than default −63.1%". */
  recap: string
  /** Reasons to doubt the measured difference (from the judge), shown next to the recommendation. */
  warnings: string[]
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** The judge only returns `regression` with quality_ok=false when a guardrail broke; unmeasured quality is `inconclusive`. */
const qualityState = (qualityOk: boolean | null | undefined, verdict: string): CheckResult['quality'] =>
  qualityOk !== false ? 'ok' : verdict === 'regression' ? 'failed' : 'unmeasured'
const signed = (value: number | null) => formatSigned(value, { digits: 1, fallback: 'not measured' })

/** Adoption verdict implied by a claim check that already ran on the project default and workload. */
function impliedAdoption(claim: string, worthAdopting: boolean | undefined): string {
  if (claim === 'reproduced' || claim === 'partial') return worthAdopting === true ? 'worth_adopting' : worthAdopting === false ? 'small_gain' : claim === 'reproduced' ? 'worth_adopting' : 'small_gain'
  return ['not_reproduced', 'regression', 'inconclusive'].includes(claim) ? claim : 'inconclusive'
}

function claimSentenceFor(verdict: string, delta: number | null, target: number | null, claimed: number | null): string {
  const vs = target !== null ? ` vs a ${formatSigned(target, { digits: 1 })} target` : ''
  const base =
    verdict === 'reproduced'
      ? `The paper’s claim held here (${signed(delta)}${vs}).`
      : verdict === 'partial'
        ? `The paper’s claim partly held here (${signed(delta)}${vs}).`
        : verdict === 'not_reproduced'
          ? `The paper’s claim didn’t reproduce here (${signed(delta)}, no clear change).`
          : verdict === 'regression'
            ? `Against the paper’s setup it was worse than the baseline (${signed(delta)}).`
            : 'The claim check was inconclusive: not enough complete measurements.'
  return claimed !== null ? `${base} The paper reports ${formatSigned(claimed, { digits: 0 })}.` : base
}

/**
 * The bottom line for Gate 3, from the claim check and the adoption check (docs/ux-review.md X-1):
 * - a failed quality guardrail, or an adoption check that came out worse than the default → **Drop**
 * - worth adopting with quality intact → **Merge**
 * - small gain, no measurable gain or inconclusive → **Your call** (no primary action), with the reason
 * When no separate adoption check ran, the claim check (project default, project workload) stands in for it.
 */
export function recommendDecision(input: DecisionInput): DecisionRecommendation {
  const details = input.details ?? {}
  const claimVerdict = input.verdict ?? 'inconclusive'
  const claimDelta = num(input.median_delta_pct)
  const claimProblems = details.quality_problems ?? []
  const claim: CheckResult = {
    verdict: claimVerdict,
    info: claimCheckSemantics(claimVerdict),
    delta: claimDelta,
    low: num(input.ci_low_pct),
    high: num(input.ci_high_pct),
    qualityOk: qualityState(input.quality_ok, claimVerdict) !== 'failed',
    quality: qualityState(input.quality_ok, claimVerdict),
    qualityProblems: claimProblems,
  }
  const separate = !!details.adoption?.verdict
  // A claim check against the paper's baseline or workload says nothing about the project default on its own.
  const paperOnly = !separate && (details.comparison?.baseline === 'paper baseline' || details.comparison?.workload === 'paper regime')
  const adoptionVerdict = separate ? String(details.adoption!.verdict) : paperOnly ? 'inconclusive' : impliedAdoption(claimVerdict, details.worth_adopting)
  const adoption: CheckResult = separate
    ? {
        verdict: adoptionVerdict,
        info: adoptionSemantics(adoptionVerdict),
        delta: num(details.adoption!.median_delta_pct),
        low: num(details.adoption!.ci_low_pct),
        high: num(details.adoption!.ci_high_pct),
        qualityOk: qualityState(details.adoption!.quality_ok, adoptionVerdict) !== 'failed',
        quality: qualityState(details.adoption!.quality_ok, adoptionVerdict),
        qualityProblems: details.adoption!.quality_problems ?? [],
      }
    : { ...claim, verdict: adoptionVerdict, info: adoptionSemantics(adoptionVerdict), ...(paperOnly ? { delta: null, low: null, high: null } : {}) }

  const metric = humanizeMetric(input.primary_metric) || 'The primary metric'
  const threshold = num(details.success_threshold_pct)
  const target = num(details.target_pct) ?? claimTarget(input.claimed_gain_pct, threshold)
  const size = adoption.delta !== null ? `${Math.abs(Number(adoption.delta.toFixed(1)))}%` : null

  const warnings = [...new Set([...(details.validity_warnings ?? []), ...(details.adoption?.validity_warnings ?? [])])]
  let action: DecisionAction
  let reason: string
  const problems = [...new Set([...(claim.qualityOk ? [] : claim.qualityProblems), ...(adoption.qualityOk ? [] : adoption.qualityProblems)])]
  if (!claim.qualityOk || !adoption.qualityOk) {
    action = 'drop'
    reason = `A quality guardrail failed${problems.length ? `: ${problems.join('; ')}` : ''}. The change alters outputs beyond what’s allowed.`
  } else if (adoptionVerdict === 'regression') {
    action = 'drop'
    reason = size ? `${metric} is ${size} worse than the current default on your workload.` : 'It made things worse than the current default on your workload.'
  } else if (adoptionVerdict === 'worth_adopting' && warnings.length > 0) {
    action = 'your_call'
    reason = `${metric} measured ${size ?? 'clearly'} better than the current default, but the measurement may not hold for fresh requests (see the warning). Re-measure before merging.`
  } else if (adoptionVerdict === 'worth_adopting') {
    action = 'merge'
    reason = `${metric} is ${size ?? 'clearly'} better than the current default on your workload, with quality intact.`
  } else {
    action = 'your_call'
    reason =
      adoptionVerdict === 'small_gain'
        ? `A small gain on your workload (${signed(adoption.delta)})${threshold !== null ? `, below the ${formatSigned(threshold, { digits: 1 })} success bar` : ''}. Merge only if it’s worth the extra code.`
        : adoptionVerdict === 'not_reproduced'
          ? `No measurable change on your workload (${signed(adoption.delta)}, within noise). Merging adds code without a clear benefit.`
          : paperOnly
            ? 'Only the paper’s setup was measured, so there’s no result on your default workload yet.'
            : 'Not enough complete measurements to judge it on your workload. A re-run may settle it.'
  }

  const recap = separate
    ? `Claim check: ${claim.info.label} ${signed(claim.delta)} · Adoption check: ${adoption.info.label} ${signed(adoption.delta)}`
    : `Claim check (on your workload): ${claim.info.label} ${signed(claim.delta)}`

  return {
    action,
    label: action === 'merge' ? 'Merge' : action === 'drop' ? 'Drop' : 'Your call',
    tone: action === 'merge' ? 'positive' : action === 'drop' ? 'negative' : 'caution',
    reason,
    claimSentence: claimSentenceFor(claimVerdict, claim.delta, target, num(input.claimed_gain_pct)),
    claim,
    adoption,
    separateAdoption: separate,
    paperOnly,
    recap,
    warnings,
  }
}

/**
 * Recommendation for a list row, only when the row alone settles it the same way the detail page would: a
 * separate adoption check is required (older APIs omit the field; without it the claim check would need
 * `worth_adopting` and the comparison, which rows don't carry). A claim-check regression next to a
 * worth-adopting result is left open: only the detail page knows whether that regression was a quality failure.
 */
export function recommendForSummary(
  summary: Pick<ExperimentSummary, 'verdict' | 'median_delta_pct' | 'claimed_gain_pct' | 'adoption_verdict' | 'adoption_median_delta_pct' | 'validity_warning'>,
): DecisionRecommendation | null {
  if (!summary.verdict || !summary.adoption_verdict) return null
  if (summary.verdict === 'regression' && summary.adoption_verdict === 'worth_adopting') return null
  return recommendDecision({
    verdict: summary.verdict,
    median_delta_pct: summary.median_delta_pct,
    claimed_gain_pct: summary.claimed_gain_pct,
    details: {
      adoption: { verdict: summary.adoption_verdict, median_delta_pct: summary.adoption_median_delta_pct ?? null },
      validity_warnings: summary.validity_warning ? ['The measured difference may not hold for fresh requests.'] : [],
    },
  })
}

// ---- failed experiments: plain sentence first, traceback on demand (X-11) ----------------------------

export interface FailureSummary {
  /** "Smoke test failed" */
  title: string
  /** "The benchmark crashed before measuring anything." */
  plain: string
  /** The exception at the bottom of the traceback: "ServerError: chat completion failed: HTTP 404 …" */
  cause: string | null
  /** Where it was raised: "inference_lab/bench/client.py, line 177" */
  location: string | null
  exitCode: number | null
  timedOut: boolean
  /** The raw error text, for "Show error output". */
  technical: string
}

const FAILED_STEP: Record<string, { title: string; plain: string }> = {
  plan: { title: 'Planning failed', plain: 'The planner couldn’t turn the claim into a test plan.' },
  approve: { title: 'Starting the build failed', plain: 'The approved plan couldn’t be handed to the coding agent.' },
  build: { title: 'Build failed', plain: 'The coding agent couldn’t produce a build that passes the project’s checks.' },
  smoke: { title: 'Smoke test failed', plain: 'The benchmark crashed before measuring anything.' },
  tune: { title: 'Tuning failed', plain: 'The benchmark crashed while trying different settings.' },
  eval: { title: 'A/B test failed', plain: 'The benchmark crashed during the measured runs.' },
  run: { title: 'A/B test failed', plain: 'The benchmark crashed during the measured runs.' },
  adopt: { title: 'Adoption check failed', plain: 'The benchmark crashed while measuring your default workload.' },
  judge: { title: 'Judging failed', plain: 'The measurements couldn’t be compared with the claim.' },
  decide: { title: 'Applying your decision failed', plain: 'The merge or drop didn’t complete.' },
  finalize: { title: 'Applying your decision failed', plain: 'The merge or drop didn’t complete.' },
}

/** Duration for prose: "45 s", "30 min", "2 h", "1 h 30 min". */
export function plainDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 90) return `${Math.round(seconds)} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

const EXCEPTION_LINE = /^(?:[A-Za-z_][\w]*\.)*([A-Z][\w]*(?:Error|Exception|Exit|Interrupt|Failure|Failed))\b(?::\s*(.*))?$/

/** Plain-language summary of an experiment's `error` ("smoke: smoke benchmark failed (exit 1):\n<traceback>"). */
export function summarizeFailure(error: string | null | undefined, stage?: string | null): FailureSummary {
  const technical = (error ?? '').trim()
  const prefix = /^([a-z_]+):\s*/.exec(technical)
  const step = FAILED_STEP[prefix?.[1] ?? ''] ?? FAILED_STEP[stage ?? ''] ?? { title: 'Experiment failed', plain: 'A step crashed before the experiment finished.' }
  const exit = /\(exit (-?\d+)\)/.exec(technical)
  const exitCode = exit ? Number(exit[1]) : null
  const timeout = /\[timeout after (\d+)\s*s\]/.exec(technical)
  const timedOut = !!timeout || exitCode === 124
  const lines = technical.split('\n').map((line) => line.trim()).filter(Boolean)

  let cause: string | null = null
  for (let index = lines.length - 1; index >= 0 && !cause; index--) {
    const match = EXCEPTION_LINE.exec(lines[index])
    if (match) cause = match[2] ? `${match[1]}: ${match[2]}` : match[1]
  }
  if (!cause && lines.length) {
    // No traceback: the message itself is the cause, unless it's only the generic "… failed (exit N):" header.
    const first = lines[0].replace(/^[a-z_]+:\s*/, '')
    if (!/failed \(exit -?\d+\):?$/.test(first) && !/^\[timeout/.test(first) && first !== step.title) cause = first
  }
  if (cause && cause.length > 220) cause = `${cause.slice(0, 219)}…`

  let location: string | null = null
  const files = [...technical.matchAll(/File "([^"<]+)", line (\d+)/g)]
  if (files.length) {
    const [, file, line] = files[files.length - 1]
    const short = file.includes('/src/') ? file.slice(file.lastIndexOf('/src/') + 5) : file.split('/').slice(-3).join('/')
    location = `${short}, line ${line}`
  }

  const seconds = timeout ? Number(timeout[1]) : null
  const plain = timedOut ? `It ran out of time${seconds ? ` after ${plainDuration(seconds)}` : ''} before finishing.` : step.plain
  return { title: step.title, plain, cause, location, exitCode, timedOut, technical }
}
