import type {
  EditableField,
  Experiment,
  ExperimentSpec,
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
} from '../api/types'
import type { Tone } from './stages'

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

export const FIDELITY_INFO: Record<FidelityLevel, { label: string; tone: Tone; description: string }> = {
  high: { label: 'High fidelity', tone: 'success', description: 'Baseline, workload and setup closely follow the paper.' },
  medium: { label: 'Medium fidelity', tone: 'attention', description: 'Close to the paper, with some known gaps.' },
  low: { label: 'Low fidelity', tone: 'danger', description: 'Large gaps to the paper — read any verdict with care.' },
}

export const ADOPTION_INFO: Record<string, { label: string; tone: Tone }> = {
  worth_adopting: { label: 'Worth adopting', tone: 'success' },
  small_gain: { label: 'Small gain', tone: 'attention' },
  not_reproduced: { label: 'No gain', tone: 'neutral' },
  regression: { label: 'Regression', tone: 'danger' },
  inconclusive: { label: 'Inconclusive', tone: 'attention' },
}
export const adoptionInfo = (verdict: string | null | undefined) =>
  ADOPTION_INFO[verdict ?? ''] ?? { label: (verdict ?? 'unknown').replace(/_/g, ' '), tone: 'neutral' as Tone }

export const DIAGNOSIS_INFO: Record<string, { label: string; tone: Tone; description: string }> = {
  reproduced: { label: 'Reproduced', tone: 'success', description: 'The claim check met the target.' },
  partially_reproduced: { label: 'Partially reproduced', tone: 'attention', description: 'A real improvement, smaller than the paper’s.' },
  implementation_suspect: { label: 'Implementation suspect', tone: 'danger', description: 'The counters show the technique is not doing what the paper describes.' },
  untuned: { label: 'Not tuned', tone: 'attention', description: 'The mechanism works, but the knobs are far from where the paper operates.' },
  regime_mismatch: { label: 'Workload mismatch', tone: 'neutral', description: 'The workload or model regime removes the benefit.' },
  hardware_mismatch: { label: 'Hardware mismatch', tone: 'neutral', description: 'The mechanism works, but this hardware’s cost model cancels the gain.' },
  claim_not_supported: { label: 'Claim not supported', tone: 'neutral', description: 'Faithful implementation and regime, still no effect.' },
  inconclusive: { label: 'Inconclusive', tone: 'muted', description: 'Not enough evidence to explain the result.' },
}
export const diagnosisInfo = (diagnosis: string | null | undefined) =>
  DIAGNOSIS_INFO[diagnosis ?? ''] ?? { label: (diagnosis ?? 'unknown').replace(/_/g, ' '), tone: 'neutral' as Tone, description: '' }

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
