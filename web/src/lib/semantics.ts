/**
 * One meaning per colour, one word per concept (docs/ux-review.md §3.3 and Appendix B).
 *
 * Every status, verdict, likelihood, diagnosis and gain shown in the console takes its label, tone and
 * icon from here. `lib/stages.ts`, `lib/roofline.ts` (and `lib/protocol.ts`) re-export these tables, so
 * the words and colours can't drift between pages.
 *
 * Tones:
 * - positive  good outcome measured or expected **here** (never the paper's claim, never "low effort")
 * - negative  harm: regression, failed, a broken quality guardrail
 * - caution   mixed, partial, marginal, or "needs your attention"
 * - info      in progress, links, selected, predicted (dashed)
 * - neutral   none / no effect / queued / not estimated
 * - merged    merged (only)
 * - reference the paper's claimed number (neutral ink + paper icon)
 */

import type { AdoptionVerdict, Bottleneck, ExperimentStatus, FidelityLevel, Likelihood, VerdictName } from '../api/types'

export type SemanticTone = 'positive' | 'negative' | 'caution' | 'info' | 'neutral' | 'merged' | 'reference'

/** Legacy tone names (pre-WS0) are still accepted everywhere and map onto the semantic ones. */
export type LegacyTone = 'neutral' | 'accent' | 'attention' | 'success' | 'danger' | 'done' | 'muted'

export type Tone = SemanticTone | LegacyTone

const LEGACY_TO_SEMANTIC: Record<LegacyTone, SemanticTone> = {
  neutral: 'neutral',
  muted: 'neutral',
  accent: 'info',
  attention: 'caution',
  success: 'positive',
  danger: 'negative',
  done: 'merged',
}

const SEMANTIC_TO_LEGACY: Record<SemanticTone, LegacyTone> = {
  positive: 'success',
  negative: 'danger',
  caution: 'attention',
  info: 'accent',
  neutral: 'neutral',
  merged: 'done',
  reference: 'neutral',
}

/** Semantic tone → the equivalent legacy name, for code that still compares against 'success'/'attention'/…. */
export function legacyTone(tone: Tone): LegacyTone {
  return tone in SEMANTIC_TO_LEGACY ? SEMANTIC_TO_LEGACY[tone as SemanticTone] : (tone as LegacyTone)
}

/** Any tone (legacy or semantic) → its semantic name. */
export function semanticTone(tone: Tone | string | null | undefined): SemanticTone {
  if (!tone) return 'neutral'
  if (tone in LEGACY_TO_SEMANTIC) return LEGACY_TO_SEMANTIC[tone as LegacyTone]
  return (['positive', 'negative', 'caution', 'info', 'neutral', 'merged', 'reference'] as const).includes(tone as SemanticTone)
    ? (tone as SemanticTone)
    : 'neutral'
}

/** Icon names understood by `<SemanticIcon>` in components/Icons.tsx. */
export type SemanticIconName =
  | 'check'
  | 'x'
  | 'gate'
  | 'pulse'
  | 'clock'
  | 'merge'
  | 'minus'
  | 'half'
  | 'equals'
  | 'arrow-up'
  | 'arrow-down'
  | 'question'
  | 'paper'
  | 'alert'

export interface SemanticInfo {
  /** Sentence-case label: the one word(s) for this value everywhere. */
  label: string
  /** Shorter label for dense rows (falls back to `label`). */
  short?: string
  tone: SemanticTone
  icon: SemanticIconName
  /** One plain sentence for tooltips and popovers. */
  description: string
}

const fallbackInfo = (value: string | null | undefined, description = ''): SemanticInfo => ({
  label: sentenceCase((value ?? 'unknown').replace(/_/g, ' ')),
  tone: 'neutral',
  icon: 'question',
  description,
})

export function sentenceCase(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

// ---- experiment status ---------------------------------------------------------------------------

export interface StatusSemantics extends SemanticInfo {
  /** true while the backend/worker is doing something (show a pulse). */
  busy: boolean
}

const working = (label: string, description: string, short?: string): StatusSemantics => ({
  label,
  short,
  tone: 'info',
  icon: 'pulse',
  busy: true,
  description,
})
const waiting = (label: string, description: string, busy = false): StatusSemantics => ({ label, tone: 'neutral', icon: 'clock', busy, description })
const ended = (label: string, description: string): StatusSemantics => ({ label, tone: 'neutral', icon: 'minus', busy: false, description })

export const EXPERIMENT_STATUS: Record<ExperimentStatus, StatusSemantics> = {
  awaiting_approval: {
    label: 'Needs your approval',
    short: 'Approve',
    tone: 'caution',
    icon: 'gate',
    busy: false,
    description: 'Gate 2: approve the test plan before anything is built.',
  },
  awaiting_decision: {
    label: 'Needs your decision',
    short: 'Decide',
    tone: 'caution',
    icon: 'gate',
    busy: false,
    description: 'Gate 3: the results are in. Decide whether to merge or drop.',
  },
  planning: working('Planning', 'Writing the test plan from the claim.'),
  approving: working('Starting build', 'Plan approved; the build is starting.'),
  building: working('Building', 'Implementing the technique on a new branch.'),
  smoke_testing: working('Smoke testing', 'Checking that the build runs before measuring.'),
  tuning: working('Tuning', 'Searching for the settings the paper operates at.'),
  running: working('Running A/B test', 'Measuring the change against the baseline.', 'Running A/B'),
  judging: working('Judging', 'Comparing the measurements with the claim.'),
  finalizing: working('Finalizing', 'Applying your decision.'),
  queued: waiting('Queued', 'Waiting for the worker to pick it up.'),
  waiting_gpu: waiting('Waiting for GPU', 'Waiting for the measurement machine to be free.', true),
  blocked: waiting('Waiting for prerequisite', 'Starts when the experiment it depends on is merged.'),
  cancelling: waiting('Cancelling', 'Stopping the running job.', true),
  merged: { label: 'Merged', tone: 'merged', icon: 'merge', busy: false, description: 'The change is on the main branch (behind its flag).' },
  dropped: ended('Dropped', 'You decided not to merge the change.'),
  rejected: ended('Rejected', 'You rejected the test plan.'),
  cancelled: ended('Cancelled', 'Stopped before it finished.'),
  failed: { label: 'Failed', tone: 'negative', icon: 'x', busy: false, description: 'A step crashed; see the error output.' },
}

export function statusSemantics(status: string | null | undefined): StatusSemantics {
  return EXPERIMENT_STATUS[status as ExperimentStatus] ?? { ...fallbackInfo(status), busy: false }
}

// ---- claim check (verdict) --------------------------------------------------------------------------

export const CLAIM_CHECK: Record<VerdictName, SemanticInfo> = {
  reproduced: { label: 'Reproduced', tone: 'positive', icon: 'check', description: 'The effect reached the target derived from the paper’s claim.' },
  partial: {
    label: 'Partly reproduced',
    short: 'Partly',
    tone: 'caution',
    icon: 'half',
    description: 'A significant improvement, but below the target.',
  },
  not_reproduced: { label: 'Not reproduced', tone: 'neutral', icon: 'equals', description: 'No significant change (the 95% CI includes 0).' },
  regression: {
    label: 'Worse than baseline',
    short: 'Worse',
    tone: 'negative',
    icon: 'arrow-down',
    description: 'It got worse, or a quality or memory guardrail failed.',
  },
  inconclusive: {
    label: 'Inconclusive',
    tone: 'neutral',
    icon: 'question',
    description: 'Not enough complete measurements (missing rounds or quality metrics) to judge.',
  },
}

export function claimCheckSemantics(verdict: string | null | undefined): SemanticInfo {
  return CLAIM_CHECK[verdict as VerdictName] ?? fallbackInfo(verdict)
}

// ---- adoption check ---------------------------------------------------------------------------------

export const ADOPTION: Record<AdoptionVerdict, SemanticInfo> = {
  worth_adopting: { label: 'Worth adopting', tone: 'positive', icon: 'check', description: 'A clear gain on your default workload, with quality intact.' },
  small_gain: { label: 'Small gain', tone: 'caution', icon: 'half', description: 'A gain on your default workload, but a small one.' },
  not_reproduced: { label: 'No measurable gain', short: 'No gain', tone: 'neutral', icon: 'equals', description: 'No significant change on your default workload.' },
  regression: {
    label: 'Worse than default',
    short: 'Worse',
    tone: 'negative',
    icon: 'arrow-down',
    description: 'Slower or lower quality than the current default when the flag is on.',
  },
  inconclusive: { label: 'Inconclusive', tone: 'neutral', icon: 'question', description: 'Not enough complete measurements on the default workload.' },
}

export function adoptionSemantics(verdict: string | null | undefined): SemanticInfo {
  return ADOPTION[verdict as AdoptionVerdict] ?? fallbackInfo(verdict)
}

// ---- predicted here (cost model) ----------------------------------------------------------------------

export interface LikelihoodSemantics extends SemanticInfo {
  /** Sort order: likely first. */
  rank: number
}

export const LIKELIHOOD: Record<Likelihood, LikelihoodSemantics> = {
  likely: {
    label: 'Likely gain',
    short: 'Likely',
    tone: 'positive',
    icon: 'arrow-up',
    rank: 0,
    description: 'The cost model expects a worthwhile gain (at least 5% at the low end) on this engine.',
  },
  marginal: {
    label: 'Small or no gain',
    short: 'Marginal',
    tone: 'caution',
    icon: 'half',
    rank: 1,
    description: 'Could gain a little or nothing on this engine.',
  },
  unknown: {
    label: 'Not estimated',
    tone: 'neutral',
    icon: 'question',
    rank: 2,
    description: 'No estimate: the roofline isn’t measured, or there is no cost model for this kind of claim.',
  },
  unlikely: {
    label: 'Unlikely to help',
    short: 'Unlikely',
    tone: 'neutral',
    icon: 'equals',
    rank: 3,
    description: 'The cost model expects under 2% on this engine; the claim is blocked unless you force it.',
  },
}

export function likelihoodSemantics(value: string | null | undefined): LikelihoodSemantics {
  return LIKELIHOOD[(value ?? 'unknown') as Likelihood] ?? LIKELIHOOD.unknown
}

// ---- diagnosis (why the result came out this way) --------------------------------------------------------

export const DIAGNOSIS: Record<string, SemanticInfo> = {
  reproduced: { label: 'Reproduced', tone: 'neutral', icon: 'check', description: 'The claim check met the target.' },
  partially_reproduced: { label: 'Partly reproduced', tone: 'neutral', icon: 'half', description: 'A real improvement, smaller than the paper’s.' },
  implementation_suspect: {
    label: 'Implementation suspect',
    tone: 'negative',
    icon: 'alert',
    description: 'The counters show the technique isn’t doing what the paper describes.',
  },
  untuned: { label: 'Not tuned', tone: 'neutral', icon: 'question', description: 'The mechanism works, but the settings are far from where the paper operates.' },
  regime_mismatch: { label: 'Workload mismatch', tone: 'neutral', icon: 'question', description: 'The workload or model regime removes the benefit.' },
  hardware_mismatch: { label: 'Hardware mismatch', tone: 'neutral', icon: 'question', description: 'The mechanism works, but this hardware’s costs cancel the gain.' },
  claim_not_supported: { label: 'Claim not supported', tone: 'neutral', icon: 'equals', description: 'Faithful implementation and regime, still no effect.' },
  inconclusive: { label: 'Inconclusive', tone: 'neutral', icon: 'question', description: 'Not enough evidence to explain the result.' },
}

export function diagnosisSemantics(value: string | null | undefined): SemanticInfo {
  return DIAGNOSIS[value ?? ''] ?? fallbackInfo(value)
}

// ---- pre-screen (lab/assets.py): prerequisites the project lacks ------------------------------------------

export const NEEDS_ASSETS: SemanticInfo = {
  label: 'Needs assets',
  tone: 'caution',
  icon: 'alert',
  description:
    'The claim needs something this project doesn’t have (a trained draft model, an offline-quantized checkpoint, calibration data, an MoE model…). Testing it would hang at the smoke test or measure a stand-in.',
}

// ---- fidelity (how closely the test follows the paper) ----------------------------------------------------

export const FIDELITY: Record<FidelityLevel, SemanticInfo> = {
  high: { label: 'High fidelity', tone: 'neutral', icon: 'check', description: 'Baseline, workload and setup closely follow the paper.' },
  medium: { label: 'Medium fidelity', tone: 'neutral', icon: 'half', description: 'Close to the paper, with some known gaps.' },
  low: { label: 'Low fidelity', tone: 'caution', icon: 'alert', description: 'Large gaps to the paper: read any verdict with care.' },
}

export function fidelitySemantics(value: string | null | undefined): SemanticInfo {
  return FIDELITY[value as FidelityLevel] ?? fallbackInfo(value)
}

// ---- engine bottleneck (roofline) -----------------------------------------------------------------------

export const BOTTLENECK: Record<Bottleneck, SemanticInfo> = {
  bandwidth: {
    label: 'Bandwidth-bound',
    tone: 'positive',
    icon: 'check',
    description:
      'Decode streams the weights near the memory-bandwidth limit: techniques that cut bytes per token or verify several tokens per weight read pay off.',
  },
  overhead: {
    label: 'Overhead-bound',
    tone: 'caution',
    icon: 'alert',
    description:
      'Decode is far below the bandwidth limit: time goes to framework and kernel-launch overhead, so byte savings barely help and extra work per step (drafting, masks) costs a lot.',
  },
  mixed: { label: 'Mixed', tone: 'neutral', icon: 'half', description: 'Decode is partly bandwidth-bound and partly overhead-bound.' },
  unknown: { label: 'Not measured', tone: 'neutral', icon: 'question', description: 'No roofline measured yet.' },
}

export function bottleneckSemantics(value: string | null | undefined): SemanticInfo {
  return BOTTLENECK[(value ?? 'unknown') as Bottleneck] ?? BOTTLENECK.unknown
}

// ---- gain / loss (Δ) ------------------------------------------------------------------------------------

export interface GainSemantics {
  /** "better" / "worse" / "no clear change" / "not measured" */
  label: string
  tone: SemanticTone
  icon: SemanticIconName
  direction: 'up' | 'down' | 'flat' | 'none'
}

/**
 * Meaning of an improvement in % (positive = better in the metric's own direction).
 * `significant: false` → "no clear change" whatever the sign; `undefined` → judged by sign with a ±threshold.
 */
export function gainSemantics(delta: number | null | undefined, options: { significant?: boolean | null; threshold?: number } = {}): GainSemantics {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return { label: 'not measured', tone: 'neutral', icon: 'minus', direction: 'none' }
  const threshold = options.threshold ?? 0.05
  if (options.significant === false || Math.abs(delta) <= threshold) return { label: 'no clear change', tone: 'neutral', icon: 'equals', direction: 'flat' }
  return delta > 0
    ? { label: 'better', tone: 'positive', icon: 'arrow-up', direction: 'up' }
    : { label: 'worse', tone: 'negative', icon: 'arrow-down', direction: 'down' }
}

// ---- effort / risk / fit: neutral words, never red/green ---------------------------------------------------

export type Level = 'low' | 'medium' | 'high'
export const LEVELS: Level[] = ['low', 'medium', 'high']

export interface LevelSemantics {
  /** "Effort: low" */
  label: string
  /** "low" */
  value: string
  /** 1–3 filled dots (0 when unknown). */
  dots: number
  tone: 'neutral'
  description: string
}

const LEVEL_KIND_LABEL = { effort: 'Effort', risk: 'Risk', fit: 'Fit' } as const
const LEVEL_DESCRIPTION = {
  effort: 'Implementation effort, estimated from the paper.',
  risk: 'Chance the change breaks quality or stability, estimated from the paper.',
  fit: 'How well the technique fits this project’s engine and workload.',
} as const

export function levelSemantics(kind: keyof typeof LEVEL_KIND_LABEL, level: string | null | undefined): LevelSemantics {
  const index = LEVELS.indexOf(level as Level)
  const value = index >= 0 ? (level as string) : 'unknown'
  return { label: `${LEVEL_KIND_LABEL[kind]}: ${value}`, value, dots: index + 1, tone: 'neutral', description: LEVEL_DESCRIPTION[kind] }
}

// ---- registers: claimed ≠ predicted ≠ measured ----------------------------------------------------------------

export type Register = 'claimed' | 'predicted' | 'measured'

export const REGISTER: Record<Register, { label: string; description: string }> = {
  claimed: { label: 'Paper reports', description: 'The number the paper reports, on the paper’s setup. A promise, not a result.' },
  predicted: { label: 'Expected here', description: 'The cost model’s estimate for this project’s engine. An estimate, not a result.' },
  measured: { label: 'Measured here', description: 'The A/B result measured on this project.' },
}

// ---- gates and modes ------------------------------------------------------------------------------------------

export const GATE = {
  pick: { label: 'Pick claims to test', short: 'Gate 1' },
  approve_spec: { label: 'Approve the test plan', short: 'Gate 2' },
  merge: { label: 'Decide: merge or drop', short: 'Gate 3' },
} as const

export const MODE: Record<string, { label: string; description: string }> = {
  single: { label: 'Single', description: 'Tests only this claim.' },
  bundle: { label: 'Bundle', description: 'Implements the claim together with its prerequisites in one experiment.' },
  chain: { label: 'Chain', description: 'Part of a chain: prerequisites are tested and merged first; dependents start when they are merged.' },
}

/** Words to use (and not use) in copy. Appendix B of docs/ux-review.md. */
export const VOCAB = {
  paperReports: 'Paper reports',
  paperGivesNoNumber: 'Paper gives no number',
  expectedHere: 'Expected here',
  measuredHere: 'Measured here',
  notEstimated: 'Not estimated',
  notMeasured: 'Not measured yet',
  notReported: 'Not reported',
  claimCheck: 'Claim check',
  adoptionCheck: 'Adoption check',
  noClearChange: 'no clear change',
  needsYou: 'Needs you',
} as const
