import type {
  ClaimDetail,
  Claim,
  Experiment,
  ExperimentLog,
  ExperimentSpec,
  ExperimentSummary,
  Job,
  JobQueued,
  LabEvent,
  MergeDecisionBody,
  Paged,
  PaperDetail,
  PaperSummary,
  PickBody,
  Project,
  Recommendation,
  Seeds,
  ServicesHealth,
  SpecDecisionBody,
  Stats,
  Topic,
  Triage,
  TriageOptions,
  TriageSummary,
  ClaimExplainer,
  PaperExplainer,
  TopicExplainer,
} from './types'

export const API_BASE = '/api'

export class ApiError extends Error {
  status: number
  detail: unknown

  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

type Query = Record<string, string | number | boolean | null | undefined>

export function buildQuery(params?: Query): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** Encode a paper id (e.g. `doi:10.1145/x`) for a URL path, keeping `/` separators readable. */
export function encodePaperId(paperId: string): string {
  return paperId.split('/').map(encodeURIComponent).join('/')
}

function detailMessage(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    // FastAPI validation errors
    return detail
      .map((item) => {
        if (item && typeof item === 'object' && 'msg' in item) {
          const loc = Array.isArray((item as { loc?: unknown[] }).loc)
            ? (item as { loc: unknown[] }).loc.filter((part) => part !== 'body').join('.')
            : ''
          return loc ? `${loc}: ${(item as { msg: string }).msg}` : (item as { msg: string }).msg
        }
        return String(item)
      })
      .join('; ')
  }
  return fallback
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    throw new ApiError(0, 'Cannot reach the PaperAtlas gateway — is `paperatlas services up` running?')
  }
  const text = await response.text()
  let data: unknown = undefined
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!response.ok) {
    const detail = data && typeof data === 'object' && 'detail' in data ? (data as { detail: unknown }).detail : data
    const fallback = `${method} ${path} failed with HTTP ${response.status}`
    throw new ApiError(response.status, detailMessage(detail, fallback), detail)
  }
  return data as T
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal)
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {})
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body)

export interface RecommendationParams {
  limit?: number
  include_blocked?: boolean
  category?: string
  topic?: string
  q?: string
}

export interface PaperParams {
  q?: string
  topic?: string
  limit?: number
  offset?: number
}

export interface ClaimParams {
  q?: string
  category?: string
  topic?: string
  testable?: boolean
  paper_id?: string
  limit?: number
  offset?: number
}

export const api = {
  services: (signal?: AbortSignal) => get<ServicesHealth>('/services', signal),

  research: {
    stats: (signal?: AbortSignal) => get<Stats>('/research/stats', signal),
    seeds: () => get<Seeds>('/research/seeds'),
    topics: (includeArchived = false) => get<Topic[]>(`/research/topics${buildQuery({ include_archived: includeArchived || undefined })}`),
    topic: (slug: string) => get<Topic>(`/research/topics/${encodeURIComponent(slug)}`),
    explainTopic: (slug: string) => post<TopicExplainer>(`/research/topics/${encodeURIComponent(slug)}/explain`),
    explainPaper: (paperId: string) => post<PaperExplainer>(`/research/papers/${encodePaperId(paperId)}/explain`),
    explainBackfill: (body: { project_id?: number | null; claims_top?: number; papers?: boolean; topics?: boolean; force?: boolean }) =>
      post<JobQueued>('/research/explain', body),
    refreshTopics: (useLlm = true) => post<JobQueued>('/research/topics/refresh', { use_llm: useLlm }),
    discover: (body: { topics?: string[] | null; per_topic?: number | null; expand?: boolean } = {}) =>
      post<JobQueued>('/research/discover', body),
    distill: (body: { limit?: number; paper_ids?: string[] | null; reprocess?: boolean; use_llm?: boolean } = {}) =>
      post<JobQueued>('/research/distill', body),
    papers: (params: PaperParams = {}, signal?: AbortSignal) =>
      get<Paged<PaperSummary>>(`/research/papers${buildQuery({ ...params })}`, signal),
    paper: (paperId: string) => get<PaperDetail>(`/research/papers/${encodePaperId(paperId)}`),
    categories: () => get<string[]>('/research/categories'),
    claims: (params: ClaimParams = {}, signal?: AbortSignal) =>
      get<Paged<Claim>>(`/research/claims${buildQuery({ ...params })}`, signal),
    claim: (id: number, projectId?: number) => get<ClaimDetail>(`/research/claims/${id}${buildQuery({ project_id: projectId })}`),
    jobs: (limit = 50, status?: string) => get<Job[]>(`/research/jobs${buildQuery({ limit, status })}`),
  },

  lab: {
    projects: () => get<Project[]>('/lab/projects'),
    project: (id: number) => get<Project>(`/lab/projects/${id}`),
    registerProject: (body: { repo_path: string; name?: string | null }) => post<Project>('/lab/projects', body),
    reprofile: (id: number) => post<Project>(`/lab/projects/${id}/profile`),
    explainClaim: (projectId: number, claimId: number) => post<ClaimExplainer>(`/lab/projects/${projectId}/claims/${claimId}/explain`),
    rematch: (id: number, useLlm = true) => post<JobQueued>(`/lab/projects/${id}/match${buildQuery({ use_llm: useLlm })}`),
    recommendations: (projectId: number, params: RecommendationParams = {}, signal?: AbortSignal) =>
      get<Recommendation[]>(`/lab/projects/${projectId}/recommendations${buildQuery({ ...params })}`, signal),
    startTriage: (projectId: number, options: TriageOptions) => post<Triage>(`/lab/projects/${projectId}/triage`, options),
    triageList: (projectId?: number) => get<TriageSummary[]>(`/lab/triage${buildQuery({ project_id: projectId })}`),
    triage: (id: number) => get<Triage>(`/lab/triage/${id}`),
    createExperiments: (body: PickBody) => post<Experiment[]>('/lab/experiments', body),
    experiments: (params: { project_id?: number; status?: string } = {}, signal?: AbortSignal) =>
      get<ExperimentSummary[]>(`/lab/experiments${buildQuery(params)}`, signal),
    experiment: (id: number, signal?: AbortSignal) => get<Experiment>(`/lab/experiments/${id}`, signal),
    editSpec: (id: number, overrides: Record<string, unknown>) =>
      patch<ExperimentSpec>(`/lab/experiments/${id}/spec`, { overrides }),
    decideSpec: (id: number, body: SpecDecisionBody) => post<Experiment>(`/lab/experiments/${id}/spec/decision`, body),
    decideMerge: (id: number, body: MergeDecisionBody) => post<Experiment>(`/lab/experiments/${id}/decision`, body),
    cancel: (id: number) => post<Experiment>(`/lab/experiments/${id}/cancel`),
    retry: (id: number) => post<Experiment>(`/lab/experiments/${id}/retry`),
    events: (id: number, after = 0) => get<LabEvent[]>(`/lab/experiments/${id}/events${buildQuery({ after })}`),
    log: (id: number) => get<ExperimentLog>(`/lab/experiments/${id}/log`),
    reportUrl: (id: number) => `${API_BASE}/lab/experiments/${id}/report`,
    activity: (limit = 50) => get<LabEvent[]>(`/lab/activity${buildQuery({ limit })}`),
    jobs: (limit = 50, status?: string) => get<Job[]>(`/lab/jobs${buildQuery({ limit, status })}`),
  },

  streams: {
    all: `${API_BASE}/lab/events/stream`,
    experiment: (id: number) => `${API_BASE}/lab/experiments/${id}/stream`,
    triage: (id: number) => `${API_BASE}/lab/triage/${id}/stream`,
  },
}
