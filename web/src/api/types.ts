// TypeScript mirrors of the dicts returned by the PaperAtlas services
// (src/paperatlas/lab/service.py, lab/events.py, lab/profiler.py, discovery/topics.py).

export type ExperimentStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_approval'
  | 'approving'
  | 'building'
  | 'smoke_testing'
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

export type StageName = 'plan' | 'approve' | 'build' | 'smoke' | 'run' | 'judge' | 'decide'
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
export type VerdictName = 'reproduced' | 'partial' | 'not_reproduced' | 'regression'
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
}

export interface ClaimDetail extends Claim {
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
  [extra: string]: unknown
}

export type EditableField =
  | 'hypothesis'
  | 'flag_name'
  | 'primary_metric'
  | 'success_threshold_pct'
  | 'rounds'
  | 'warmup'
  | 'workload'
  | 'model'

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
  [extra: string]: unknown
}

export interface RunInfo {
  id: number
  kind: 'smoke' | 'eval' | string
  status: string
  command: string | null
  started_at: string | null
  finished_at: string | null
  summary: Record<string, unknown> | null
  quality: QualityInfo | null
  model: { id?: string; dtype?: string; alias?: string } | string | null
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
  editable_fields: EditableField[]
  spec_options: { metrics: string[]; workloads: string[]; models: string[] }
  build: BuildInfo
  worktree_path: string | null
  stages: Stage[]
  runs: RunInfo[]
  verdict_detail: VerdictDetail | null
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

export interface MergeDecisionBody {
  decision: 'merge' | 'drop'
  comment?: string | null
}

export interface PickBody {
  project_id: number
  claim_ids: number[]
  triage_id?: number | null
  force?: boolean
}
