// TypeScript mirrors of the dicts returned by the PaperAtlas services
// (src/paperatlas/lab/service.py, lab/events.py, lab/profiler.py, discovery/topics.py).

export type ExperimentStatus =
  | 'blocked'
  | 'queued'
  | 'planning'
  | 'awaiting_approval'
  | 'approving'
  | 'building'
  | 'smoke_testing'
  | 'tuning'
  | 'waiting_gpu'
  | 'running'
  | 'judging'
  | 'awaiting_decision'
  | 'finalizing'
  | 'cancelling'
  | 'merged'
  | 'dropped'
  | 'rejected'
  | 'failed'
  | 'cancelled'

export type StageName = 'plan' | 'approve' | 'build' | 'smoke' | 'tune' | 'run' | 'judge' | 'decide'
export type StageState =
  | 'done'
  | 'active'
  | 'waiting'
  | 'pending'
  | 'failed'
  | 'cancelled'
  | 'cancelling'
  | 'rejected'

export interface Stage {
  stage: StageName
  state: StageState
}

export type Gate = 'approve_spec' | 'merge'
export type VerdictName = 'reproduced' | 'partial' | 'not_reproduced' | 'regression' | 'inconclusive'
export type Effort = 'low' | 'medium' | 'high'

export interface ClaimEffect {
  metric: string
  value: number | null
  unit: string | null
  direction: 'increase' | 'decrease' | 'none'
  baseline?: string | null
  conditions?: string | null
  [extra: string]: unknown
}

export interface PaperSetup {
  hardware?: string | null
  model?: string | null
  framework?: string | null
  batch_size?: string | null
  sequence_length?: string | null
  dataset?: string | null
  [extra: string]: unknown
}

export interface ClaimCardData {
  testable: boolean
  category: string
  technique: string
  change_required: string
  effects: ClaimEffect[]
  paper_setup: PaperSetup
  prerequisites: string[]
  requires_cuda: boolean
  requires_multi_gpu: boolean
  requires_training: boolean
  effort: Effort
  risks: string[]
  evidence: { quote: string; location?: string | null }
  [extra: string]: unknown
}

// ---- explainers (plain-language descriptions + flow diagrams) --------------------------------

export type DiagramNodeKind = 'input' | 'model' | 'step' | 'decision' | 'memory' | 'output' | 'hardware' | 'data'

export interface DiagramNode {
  id: string
  label: string
  kind: DiagramNodeKind | string
  highlight?: boolean
}

export interface DiagramEdge {
  from: string
  to: string
  label?: string | null
  style?: 'normal' | 'loop' | 'skip' | string
}

export interface FlowDiagramData {
  title?: string
  nodes: DiagramNode[]
  edges: DiagramEdge[]
}

export interface ClaimExplainer {
  headline?: string
  problem?: string
  how_it_works?: string[]
  why_it_helps?: string
  claimed_result?: { summary?: string; is_relative_gain?: boolean } | null
  in_this_project?: { where?: string; change?: string; measure?: string } | null
  lossless?: boolean | null
  caveats?: string[]
  glossary?: { term: string; meaning: string }[]
  diagram?: FlowDiagramData | null
  generated_at?: string | null
  model?: string | null
  /** 2 = plain-language layer below is present (primer, headline result, before/after, paper vs here). */
  version?: number
  primer?: { concept?: string; analogy?: string } | null
  headline_result?: { value?: string; metric?: string; versus?: string; direction?: 'up' | 'down' | 'none' | string } | null
  today_vs_paper?: { today?: string; with_paper?: string } | null
  paper_vs_here?: { aspect: ComparisonAspect | string; paper?: string; here?: string; effect?: string }[]
  what_we_do_differently?: string[]
  key_numbers?: { value: string; label: string; meaning?: string }[]
  theme?: ClaimTheme | string | null
  /** The standard flow without the technique; shares node ids with `diagram`. */
  diagram_before?: FlowDiagramData | null
}

export type ClaimTheme = 'speed' | 'latency' | 'throughput' | 'memory' | 'quality' | 'cost' | 'reliability'
export type ComparisonAspect = 'hardware' | 'model' | 'runtime' | 'workload' | 'baseline' | 'draft_model' | 'batch' | 'context' | 'other'

export interface PaperExplainer {
  tldr?: string
  problem?: string
  approach?: string[]
  key_results?: { label: string; value: string; context?: string }[]
  novelty?: string
  who_should_care?: string
  limitations?: string[]
  diagram?: FlowDiagramData | null
  generated_at?: string | null
  model?: string | null
}

export interface TopicExplainer {
  summary?: string
  why_now?: string
  key_ideas?: { name: string; one_liner: string }[]
  typical_gains?: string
  open_problems?: string[]
  relevance?: string
  generated_at?: string | null
  model?: string | null
}

export interface TopicInsights {
  papers: number
  patents: number
  distilled: number
  with_code: number
  citations: number
  upvotes: number
  monthly: { month: string; papers: number }[]
  sources: { source: string; papers: number }[]
  claim_categories: { category: string; claims: number; testable: number }[]
  median_claimed_gain_pct: number | null
  top_papers: { paper_id: string; title: string; score: number | null; rank: number | null }[]
}

// ---- concept maps (how a paper's concepts relate) ------------------------------------------

export type ConceptRole = 'foundation' | 'core' | 'extension' | 'optimization' | 'evaluation' | 'limitation'
export type ConceptRelation = 'requires' | 'builds_on' | 'complements' | 'alternative_to' | 'evaluated_by'

export interface ConceptNode {
  concept_id: number
  claim_id: number | null
  name: string
  kind?: string | null
  role?: ConceptRole | string | null
  order?: number | null
  category?: string | null
  testable?: boolean
  testable_here?: boolean | null
  claimed_gain_pct?: number | null
  headline?: string | null
}

export interface RelatedConcept extends ConceptNode {
  why?: string | null
}

export interface ConceptLinkData {
  source: number
  target: number
  relation: ConceptRelation | string
  why?: string | null
  evidence?: string | null
}

export interface ConceptBundle {
  name: string
  concept_ids?: number[]
  effect?: string | null
  is_headline_result?: boolean
  members: ConceptNode[]
}

export interface ConceptMap {
  nodes: ConceptNode[]
  links: ConceptLinkData[]
  bundles: ConceptBundle[]
  reading_path?: string | null
  generated: boolean
}

export interface ClaimRelated {
  requires: RelatedConcept[]
  required_by: RelatedConcept[]
  builds_on: RelatedConcept[]
  extended_by: RelatedConcept[]
  complements: RelatedConcept[]
  alternatives: RelatedConcept[]
  evaluated_by: RelatedConcept[]
  evaluates: RelatedConcept[]
  bundles: ConceptBundle[]
  prerequisites: ConceptNode[]
  order?: number | null
  role?: string | null
  concepts_in_paper?: number
  has_map?: boolean
}

export type ExperimentMode = 'single' | 'bundle' | 'chain'

export interface Claim {
  id: number
  claim_id: number
  paper_id: string
  name: string
  kind: string | null
  summary: string | null
  key_points: string[]
  category: string | null
  technique: string
  change_required: string | null
  primary_metric: string | null
  claimed_value: number | null
  claimed_unit: string | null
  direction: string | null
  claimed_gain_pct: number | null
  testable: boolean
  requires_cuda: boolean
  requires_multi_gpu: boolean
  requires_training: boolean
  effort: Effort | null
  evidence_quote: string | null
  card: ClaimCardData | null
  group_id: number | null
  paper_title: string | null
  paper_url: string | null
  paper_doc_type: string | null
  paper_date: string | null
  created_at: string | null
  search_score?: number | null
  explainer?: ClaimExplainer | null
  related?: ClaimRelated | null
  /** The claim's match on the project passed as `project_id` (null when it isn't matched there). */
  match?: ClaimMatch | null
}

export interface ClaimDetail extends Claim {
  paper_explainer?: PaperExplainer | null
  group?: {
    id: number
    label: string
    size: number
    other_claims: { claim_id: number; paper_id: string; paper_title: string }[]
  }
  experiments: { id: number; status: ExperimentStatus; project_id: number }[]
}

export interface TopicRef {
  slug: string
  name: string
}

// ---- roofline + cost-model predictions (lab/profiler.measure_roofline, lab/costmodel.predict) -----------

/** The engine's measured roofline (project `commands.profile`). Every field may be missing. */
export interface Roofline {
  kind?: 'profile' | string
  model?: {
    profile?: string
    id?: string
    quantization?: string
    active_params_b?: number
    total_params_b?: number
    bytes_per_token_gb?: number
  } | null
  hardware?: { chip?: string; peak_bandwidth_gbs?: number; memory_gb?: number } | null
  decode?: {
    tokens_per_s?: number
    ms_per_token?: number
    achieved_bandwidth_gbs?: number
    /** 0–1 */
    bandwidth_utilization?: number
  } | null
  /** Cost of one forward pass that appends N tokens (the verification cost curve), keyed by N. */
  forward_cost_ms?: Record<string, number> | null
  batch_decode_tokens_per_s?: Record<string, number> | null
  prefill_tokens_per_s?: number | null
  draft?: { profile?: string; id?: string; ms_per_token?: number } | null
  environment?: Record<string, unknown> | null
  [extra: string]: unknown
}

export type Likelihood = 'likely' | 'marginal' | 'unlikely' | 'unknown'
export type Bottleneck = 'bandwidth' | 'overhead' | 'mixed' | 'unknown'

/** What a claim is predicted to gain on this engine, before building it. */
export interface Prediction {
  likelihood: Likelihood | string
  predicted_gain_pct: { low: number; high: number } | null
  metric?: string | null
  relies_on?: string | null
  bottleneck?: Bottleneck | string | null
  reasons?: string[]
  best_block_size?: number | null
  acceptance?: number | null
  note?: string | null
  [extra: string]: unknown
}

// ---- pre-screen: what a claim needs vs what the project provides (lab/assets.py) ---------------------------

export type AssetCategory =
  | 'draft_model'
  | 'mtp_heads'
  | 'offline_artifact'
  | 'calibration_data'
  | 'architecture'
  | 'custom_kernels'
  | 'multi_gpu'
  | 'min_context'
  | 'training'
  | 'trained_adapter'
  | 'other'

export interface AssetNeed {
  category: AssetCategory
  key: string
  /** Completes "needs …", e.g. "a trained EAGLE-3 draft head". */
  label: string
  essential: boolean
  why: string
  /** null: can't be checked against the project (category `other`, or not essential). */
  met: boolean | null
}

export interface AssetCheck {
  status: 'ok' | 'needs_assets'
  missing: { category: AssetCategory; key: string; label: string }[]
  needs: AssetNeed[]
  source: 'llm' | 'rules' | null
  /** Capabilities lab.yaml doesn't declare, so the defaults were assumed. */
  assumed: string[]
  classified_at: string | null
}

export interface ClaimMatch {
  project_id: number
  testable_here: boolean
  blockers: string[]
  asset_check: AssetCheck | null
}

/** `capabilities:` in lab.yaml, with defaults for missing keys (listed in `assumed`). */
export interface ProjectCapabilities {
  architecture: string
  draft_models: string[]
  mtp_heads: boolean
  offline_artifacts: string[]
  calibration_data: boolean
  max_context_tokens: number
  trained_adapters: string[]
  accelerator: string
  multi_gpu: boolean
  cuda: boolean
  assumed: string[]
}

export interface ProjectAssets {
  project_id: number
  capabilities: ProjectCapabilities
  matched: number
  testable: number
  checked: number
  /** Claims that need assets the project lacks (some are blocked for other reasons too). */
  needs_assets: number
  /** Claims blocked only for missing assets: testable once the project has them. */
  held_back: number
  by_category: Partial<Record<AssetCategory, number>>
}

export interface Recommendation extends Claim {
  rank: number
  project_id: number
  score: number
  fit: number
  gain: number
  effort_cost: number
  testable_here: boolean
  blockers: string[]
  target_metric: string | null
  rationale: string | null
  topics: TopicRef[]
  experiment_id: number | null
  experiment_status: ExperimentStatus | null
  prediction?: Prediction | null
  asset_check?: AssetCheck | null
}

export interface Paged<T> {
  total: number
  items: T[]
}

export interface PaperSummary {
  paper_id: string
  doc_type: string
  title: string
  abstract: string | null
  venue: string | null
  sources: string[]
  url: string | null
  pdf_url: string | null
  code_url: string | null
  publication_date: string | null
  citation_count: number | null
  hf_upvotes: number | null
  has_full_text: boolean
  distilled: boolean
  claims: number
  testable_claims: number
  explainer?: PaperExplainer | null
}

export interface Author {
  name: string
  affiliation?: string | null
  orcid?: string | null
}

export interface PaperDetail {
  paper_id: string
  doc_type: string
  title: string
  abstract: string | null
  authors: (Author | string)[]
  venue: string | null
  sources: string[]
  url: string | null
  pdf_url: string | null
  code_url: string | null
  publication_date: string | null
  citation_count: number | null
  hf_upvotes: number | null
  has_full_text: boolean
  distilled_at: string | null
  topics: { slug: string; name: string; rank: number | null; score: number | null }[]
  claims: Claim[]
  explainer?: PaperExplainer | null
  concept_map?: ConceptMap | null
}

export interface Topic {
  id: number
  slug: string
  name: string
  description: string | null
  seed: string | null
  rank: number | null
  trend_score: number
  needs_gpu_cluster: boolean
  keywords: string[]
  queries: string[]
  stats: Record<string, number>
  status: string
  refreshed_at: string | null
  explainer?: TopicExplainer | null
  insights?: TopicInsights | null
}

export interface Seeds {
  seeds: { name: string; queries: string[]; needs_gpu_cluster: boolean }[]
  sources: string[]
  topics: Record<string, number>
}

export interface Stats {
  topics: number
  papers: number
  papers_distilled: number
  patents: number
  claims: number
  testable_claims: number
  projects: number
  experiments: Partial<Record<ExperimentStatus, number>>
  verdicts: Partial<Record<VerdictName, number>>
  awaiting_you: number
  jobs: Record<string, number>
}

export interface ProjectMetric {
  name: string
  direction?: string
  unit?: string
  description?: string
}

export interface Project {
  id: number
  name: string
  repo_path: string
  description: string | null
  hardware: Record<string, unknown> | null
  models: Record<string, { id?: string; dtype?: string } | string> | null
  metrics: ProjectMetric[] | null
  workloads: ({ name: string; description?: string } | string)[] | Record<string, unknown> | null
  constraints: string[] | null
  techniques: { name: string; description?: string; hooks?: string[] }[] | null
  repo: { path?: string; branch?: string; sha?: string; remote?: string | null } | null
  profiled_at: string | null
  /** When hardware, models or stack in lab.yaml last changed (`r2e batch --retest` re-runs older experiments). */
  engine_changed_at?: string | null
  capabilities?: ProjectCapabilities | null
  /** null until `POST /projects/{id}/roofline` has measured it */
  roofline?: Roofline | null
  roofline_at?: string | null
}

export type TriageStatus =
  | 'queued'
  | 'topics'
  | 'discover'
  | 'distill'
  | 'match'
  | 'shortlist'
  | 'awaiting_pick'
  | 'picked'
  | 'failed'
  | 'done'

export interface TriageOptions {
  refresh_topics?: boolean
  topics?: string[] | null
  per_topic?: number | null
  distill_limit?: number
  expand?: boolean
  use_llm?: boolean
}

export interface TriageSummary {
  id: number
  project_id: number
  status: TriageStatus
  options: TriageOptions
  shortlist_size: number
  created_at: string | null
  updated_at: string | null
}

export interface Triage {
  id: number
  project_id: number
  status: TriageStatus
  options: TriageOptions
  shortlist: { claim_id: number; score: number }[]
  selected: number[]
  created_at: string | null
  updated_at: string | null
  events: LabEvent[]
}

export interface LabEvent {
  id: number
  stage: string
  level: 'info' | 'warning' | 'error' | string
  message: string
  data: Record<string, unknown> | null
  experiment_id: number | null
  triage_id: number | null
  job_id: number | null
  created_at: string | null
}

export interface Job {
  id: number
  kind: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | string
  payload: Record<string, unknown>
  attempts: number
  error: string | null
  result: Record<string, unknown> | null
  experiment_id: number | null
  triage_id: number | null
  created_at: string | null
  started_at: string | null
  finished_at: string | null
}

export interface JobQueued {
  job_id: number
  kind: string
}

export interface ExperimentSummary {
  id: number
  project_id: number
  claim_id: number
  triage_id: number | null
  status: ExperimentStatus
  gate: Gate | null
  stage: StageName | null
  flag_name: string | null
  branch: string | null
  error: string | null
  title: string
  technique: string
  category: string | null
  claimed_gain_pct: number | null
  paper_id: string
  paper_title: string
  verdict: VerdictName | null
  median_delta_pct: number | null
  created_at: string | null
  updated_at: string | null
  mode?: ExperimentMode | string | null
  bundle_claim_ids?: number[]
  depends_on_experiment_id?: number | null
  /** set on a re-run: the experiment it repeats (same claim, current code) */
  rerun_of_experiment_id?: number | null
  /**
   * Adoption check (method vs the project default on its workload) when it ran separately from the claim check.
   * `null` when it didn't; absent from older lab-api versions.
   */
  adoption_verdict?: AdoptionVerdict | string | null
  adoption_median_delta_pct?: number | null
}

export interface Guardrails {
  max_exact_match_drop?: number
  min_output_agreement?: number | null
  max_peak_memory_increase_pct?: number
  [extra: string]: unknown
}

export interface ExperimentSpec {
  hypothesis: string
  flag_name: string
  technique_summary: string
  implementation_notes: string
  primary_metric: string
  direction: 'higher_is_better' | 'lower_is_better'
  secondary_metrics: string[]
  workload: string
  model: string
  rounds: number
  warmup: number
  success_threshold_pct: number
  claimed_gain_pct: number | null
  lossless: boolean
  guardrails: Guardrails
  paper_vs_project: string | null
  build_timeout_s: number
  smoke_timeout_s: number
  eval_timeout_s: number
  // protocol v2 (lab/protocol.py) — older specs may lack these
  protocol_version?: number
  paper_baseline?: PaperBaseline
  paper_workload?: PaperWorkload | null
  mechanism?: MechanismCounter[]
  knobs?: Knob[]
  fidelity?: Fidelity
  tune?: boolean
  tune_rounds?: number
  max_iterations?: number
  baseline_flags?: string[]
  /** cost-model prediction for this claim on this engine, made when the spec was planned */
  prediction?: Prediction | null
  [extra: string]: unknown
}

// ---- protocol v2: test the claim the way the paper measured it, then test adoption ----------

export type PaperBaselineKind = 'project_default' | 'technique_mode'

export interface PaperBaseline {
  description: string
  kind: PaperBaselineKind
}

export interface PaperWorkload {
  matches: string
  description: string
  prompts: string[]
  max_new_tokens: number
  concurrency: number
  long_context_tokens: number
}

export interface MechanismCounter {
  name: string
  meaning: string
  paper_value: string | null
}

export type KnobValue = string | number | boolean

export interface Knob {
  name: string
  meaning: string
  paper_value: string | null
  candidates: KnobValue[]
}

export type FidelityLevel = 'high' | 'medium' | 'low'

export interface Fidelity {
  level: FidelityLevel
  gaps: string[]
}

export interface RunComparison {
  kind: 'claim' | 'adopt' | string
  workload: string
  baseline: string
  baseline_config?: Record<string, KnobValue>
  variant_config?: Record<string, KnobValue>
}

export interface MechanismRow {
  name: string
  meaning: string | null
  paper_value: string | null
  expected: boolean
  baseline_total: number | null
  variant_total: number | null
  baseline_per_1k_tokens: number | null
  variant_per_1k_tokens: number | null
  change_pct: number | null
}

export interface MechanismTable {
  rows: MechanismRow[]
  missing: string[]
  measured: boolean
  tokens: { baseline: number; variant: number }
}

export type AdoptionVerdict = 'worth_adopting' | 'small_gain' | 'not_reproduced' | 'regression' | 'inconclusive'

export interface AdoptionResult {
  verdict: AdoptionVerdict | string
  reason: string
  median_delta_pct: number | null
  ci_low_pct: number | null
  ci_high_pct: number | null
  quality_ok: boolean
  quality_problems: string[]
  workload?: unknown
  per_metric?: Record<string, MetricResult>
  mechanism?: MechanismTable
}

export type Diagnosis =
  | 'reproduced'
  | 'partially_reproduced'
  | 'implementation_suspect'
  | 'untuned'
  | 'regime_mismatch'
  | 'hardware_mismatch'
  | 'claim_not_supported'
  | 'inconclusive'

export interface Analysis {
  diagnosis: Diagnosis | string
  summary: string
  evidence: string[]
  paper_comparison: string
  worth_iterating: boolean
  next_changes: string
  expected_effect: string
  model?: string | null
}

export interface IterationEntry {
  iteration: number
  verdict: VerdictName | string
  reason: string
  median_delta_pct: number | null
  ci_low_pct: number | null
  ci_high_pct: number | null
  adoption_verdict: string | null
  adoption_median_delta_pct: number | null
  diagnosis: string | null
  summary: string | null
  next_changes: string | null
  tuned: { baseline?: Record<string, KnobValue> | null; variant?: Record<string, KnobValue> | null } | null
  /** commit of this iteration's build (the keep-or-revert loop resets to the best one) */
  sha?: string | null
  eval_run_id?: number | null
  adopt_run_id?: number | null
  quality_ok?: boolean | null
}

export interface TuningTrial {
  config: Record<string, KnobValue>
  baseline: number | null
  variant: number | null
}

export interface TuningResult {
  configs: Record<string, KnobValue>[]
  trials: TuningTrial[]
  metric?: string
  baseline: Record<string, KnobValue>
  variant: Record<string, KnobValue>
  skipped: boolean
}

/** Scalar spec fields edited as text in the Gate 2 form. */
export type EditableField =
  | 'hypothesis'
  | 'flag_name'
  | 'primary_metric'
  | 'success_threshold_pct'
  | 'rounds'
  | 'warmup'
  | 'workload'
  | 'model'

/** Protocol v2 fields edited with structured controls (lib/protocol.ts). */
export type ProtocolField = 'paper_baseline' | 'paper_workload' | 'mechanism' | 'knobs' | 'fidelity' | 'lossless' | 'tune' | 'max_iterations'

export interface BuildAttempt {
  attempt: number
  agent_exit: number | null
  duration_s: number | null
  problems: string[]
  log: string | null
}

export interface BuildInfo {
  builder?: string
  attempts?: BuildAttempt[]
  files?: string[]
  diff_stat?: string
  agent_summary?: string
  pr_url?: string | null
  merge_sha?: string
  iteration?: number
  iterations?: IterationEntry[]
  /** the best iteration, kept after judging; later iterations' code was reverted */
  kept_iteration?: number | null
  tuning?: TuningResult
  [extra: string]: unknown
}

export interface RunInfo {
  id: number
  kind: 'smoke' | 'tune' | 'eval' | 'adopt' | string
  status: string
  command: string | null
  started_at: string | null
  finished_at: string | null
  summary: Record<string, unknown> | null
  quality: QualityInfo | null
  model: { id?: string; dtype?: string; alias?: string } | string | null
  comparison?: RunComparison | null
  mechanism?: Record<string, unknown> | null
}

export interface QualityInfo {
  baseline?: { exact_match?: number | null } | null
  variant?: { exact_match?: number | null } | null
  output_agreement?: number | null
  [extra: string]: unknown
}

export interface MetricResult {
  direction: 'higher_is_better' | 'lower_is_better'
  baseline_median: number
  variant_median: number
  median_improvement_pct: number
  ci_low_pct: number
  ci_high_pct: number
  pairs: number
}

export interface WorkloadInfo {
  name?: string
  requests_per_round?: number
  max_new_tokens?: number
  concurrency?: number
  [extra: string]: unknown
}

export interface VerdictDetails {
  verdict?: VerdictName
  reason?: string
  primary_metric?: string
  median_delta_pct?: number | null
  ci_low_pct?: number | null
  ci_high_pct?: number | null
  claimed_gain_pct?: number | null
  success_threshold_pct?: number
  quality_ok?: boolean
  worth_adopting?: boolean
  per_metric?: Record<string, MetricResult>
  quality?: QualityInfo
  quality_problems?: string[]
  environment?: Record<string, unknown> | null
  model?: { id?: string; dtype?: string } | string | null
  workload?: string | WorkloadInfo | null
  // protocol v2
  comparison?: RunComparison | null
  target_pct?: number | null
  mechanism?: MechanismTable | null
  adoption?: AdoptionResult | null
  analysis?: Analysis | null
  iteration?: number | null
  iterations?: IterationEntry[] | null
  tuning?: TuningResult | null
  [extra: string]: unknown
}

export interface VerdictDetail {
  verdict: VerdictName
  primary_metric: string
  median_delta_pct: number | null
  ci_low_pct: number | null
  ci_high_pct: number | null
  claimed_gain_pct: number | null
  quality_ok: boolean
  details: VerdictDetails
  has_report: boolean
}

export interface Experiment extends ExperimentSummary {
  project: { id: number; name: string; repo_path: string }
  claim: Claim
  spec: Partial<ExperimentSpec>
  /** Everything the backend lets Gate 2 change (scalar and protocol fields; unknown names are ignored). */
  editable_fields: (EditableField | ProtocolField | string)[]
  spec_options: { metrics: string[]; workloads: string[]; models: string[] }
  build: BuildInfo
  worktree_path: string | null
  stages: Stage[]
  runs: RunInfo[]
  verdict_detail: VerdictDetail | null
  bundle?: { claim_id: number; name: string; technique: string }[]
  dependents?: { id: number; status: ExperimentStatus; claim_id: number }[]
  related?: ClaimRelated | null
}

export interface ExperimentLog {
  file: string | null
  files?: string[]
  text: string
}

export type ServicesHealth = Record<string, { url: string; status: string }>

export interface SpecDecisionBody {
  decision: 'approve' | 'revise' | 'reject'
  overrides?: Record<string, unknown> | null
  comment?: string | null
}

export interface RerunBody {
  /** false: reuse the previous spec and stop at Gate 2; true: write a fresh spec from the paper with the previous result as feedback */
  replan?: boolean
  comment?: string | null
}

export interface MergeDecisionBody {
  decision: 'merge' | 'drop'
  comment?: string | null
}

export interface PickBody {
  project_id: number
  claim_ids: number[]
  triage_id?: number | null
  force?: boolean
  mode?: ExperimentMode
}
