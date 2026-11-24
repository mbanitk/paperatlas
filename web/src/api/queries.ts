import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ClaimParams, type PaperParams, type RecommendationParams } from './client'
import type {
  Claim,
  ClaimDetail,
  ClaimExplainer,
  Experiment,
  ExperimentStatus,
  MergeDecisionBody,
  Paged,
  PaperDetail,
  PaperExplainer,
  PaperSummary,
  PickBody,
  Recommendation,
  SpecDecisionBody,
  Topic,
  TopicExplainer,
  TriageOptions,
} from './types'
import { isActiveStatus } from '../lib/stages'

export const keys = {
  services: ['services'] as const,
  stats: ['stats'] as const,
  projects: ['projects'] as const,
  project: (id: number) => ['projects', id] as const,
  recommendations: (projectId: number, params: RecommendationParams) => ['recommendations', projectId, params] as const,
  triageList: (projectId?: number) => ['triage', 'list', projectId ?? 'all'] as const,
  triage: (id: number) => ['triage', id] as const,
  experiments: (params: { project_id?: number; status?: string }) => ['experiments', params] as const,
  experiment: (id: number) => ['experiment', id] as const,
  experimentLog: (id: number) => ['experiment', id, 'log'] as const,
  activity: (limit: number) => ['activity', limit] as const,
  jobs: (limit: number, status?: string) => ['jobs', limit, status ?? 'all'] as const,
  topics: (archived: boolean) => ['topics', archived] as const,
  topic: (slug: string) => ['topic', slug] as const,
  seeds: ['seeds'] as const,
  categories: ['categories'] as const,
  papers: (params: PaperParams) => ['papers', params] as const,
  paper: (id: string) => ['paper', id] as const,
  claims: (params: ClaimParams) => ['claims', params] as const,
  claim: (id: number, projectId?: number) => ['claim', id, projectId ?? 'any'] as const,
}

export const useServices = () =>
  useQuery({ queryKey: keys.services, queryFn: ({ signal }) => api.services(signal), refetchInterval: 15_000, retry: 0 })

export const useStats = () =>
  useQuery({ queryKey: keys.stats, queryFn: ({ signal }) => api.research.stats(signal), refetchInterval: 30_000 })

export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: api.lab.projects, staleTime: 60_000 })

export const useProject = (id: number | undefined) =>
  useQuery({ queryKey: keys.project(id ?? 0), queryFn: () => api.lab.project(id!), enabled: !!id, staleTime: 60_000 })

export const useRegisterProject = () => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: { repo_path: string; name?: string | null }) => api.lab.registerProject(body),
    onSuccess: (project) => {
      client.setQueryData(keys.project(project.id), project)
      client.invalidateQueries({ queryKey: keys.projects })
      client.invalidateQueries({ queryKey: keys.stats })
    },
  })
}

export const useReprofile = (id: number) => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.lab.reprofile(id),
    onSuccess: (project) => {
      client.setQueryData(keys.project(project.id), project)
      client.invalidateQueries({ queryKey: keys.projects })
    },
  })
}

export const useRematch = (id: number) => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (useLlm: boolean) => api.lab.rematch(id, useLlm),
    onSuccess: () => client.invalidateQueries({ queryKey: ['jobs'] }),
  })
}

const ACTIVE_JOB = new Set(['queued', 'running'])

/** Re-match jobs of one project (newest first); polls quickly while one is queued or running. */
export const useMatchJobs = (projectId: number) =>
  useQuery({
    queryKey: ['jobs', 'match', projectId] as const,
    queryFn: async () =>
      (await api.lab.jobs(200)).filter((job) => job.kind === 'match' && Number((job.payload ?? {}).project_id) === projectId),
    refetchInterval: (query) => (query.state.data?.some((job) => ACTIVE_JOB.has(job.status)) ? 3_000 : 15_000),
  })

export const useRecommendations = (projectId: number | undefined, params: RecommendationParams) =>
  useQuery({
    queryKey: keys.recommendations(projectId ?? 0, params),
    queryFn: ({ signal }) => api.lab.recommendations(projectId!, params, signal),
    enabled: !!projectId,
    // Keep the old page only while filtering within one project: never show (or let users pick) another project's claims.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === (projectId ?? 0) ? previous : undefined),
  })

export const useTriageList = (projectId?: number) =>
  useQuery({ queryKey: keys.triageList(projectId), queryFn: () => api.lab.triageList(projectId), refetchInterval: 30_000 })

export const useTriage = (id: number | undefined) =>
  useQuery({ queryKey: keys.triage(id ?? 0), queryFn: () => api.lab.triage(id!), enabled: !!id })

export const useExperiments = (params: { project_id?: number; status?: string }) =>
  useQuery({
    queryKey: keys.experiments(params),
    queryFn: ({ signal }) => api.lab.experiments(params, signal),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })

export const useExperiment = (id: number) =>
  useQuery({
    queryKey: keys.experiment(id),
    queryFn: ({ signal }) => api.lab.experiment(id, signal),
    enabled: Number.isFinite(id) && id > 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status as ExperimentStatus | undefined
      return status && isActiveStatus(status) ? 15_000 : false
    },
  })

export const useExperimentLog = (id: number, enabled = true) =>
  useQuery({ queryKey: keys.experimentLog(id), queryFn: () => api.lab.log(id), enabled })

export const useActivity = (limit = 50) =>
  useQuery({
    queryKey: keys.activity(limit),
    queryFn: () => api.lab.activity(limit),
    staleTime: Infinity,
    refetchInterval: (query) => (query.state.status === 'error' ? 15_000 : false),
  })

export const useJobs = (limit = 100, status?: string) =>
  useQuery({ queryKey: keys.jobs(limit, status), queryFn: () => api.lab.jobs(limit, status), refetchInterval: 15_000 })

export const useTopics = (archived = false) =>
  useQuery({ queryKey: keys.topics(archived), queryFn: () => api.research.topics(archived), staleTime: 60_000 })

export const useSeeds = () => useQuery({ queryKey: keys.seeds, queryFn: api.research.seeds, staleTime: Infinity })

export const useCategories = () =>
  useQuery({ queryKey: keys.categories, queryFn: api.research.categories, staleTime: Infinity })

export const usePapers = (params: PaperParams) =>
  useQuery({
    queryKey: keys.papers(params),
    queryFn: ({ signal }) => api.research.papers(params, signal),
    placeholderData: keepPreviousData,
  })

export const usePaper = (id: string) => useQuery({ queryKey: keys.paper(id), queryFn: () => api.research.paper(id), enabled: !!id })

export const useClaims = (params: ClaimParams) =>
  useQuery({
    queryKey: keys.claims(params),
    queryFn: ({ signal }) => api.research.claims(params, signal),
    placeholderData: keepPreviousData,
  })

export const useClaim = (id: number, projectId?: number) =>
  useQuery({
    queryKey: keys.claim(id, projectId),
    queryFn: () => api.research.claim(id, projectId),
    enabled: Number.isFinite(id) && id > 0,
  })

export const useTopic = (slug: string) =>
  useQuery({ queryKey: keys.topic(slug), queryFn: () => api.research.topic(slug), enabled: !!slug })

// ---- explainers (sync LLM calls, ~15 s) --------------------------------------------------------

export const useExplainClaim = (projectId: number | undefined) => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (claimId: number) => {
      if (!projectId) throw new Error('Register a project first — claim explanations are written for a target project.')
      return api.lab.explainClaim(projectId, claimId)
    },
    // Pin the originating project: the hook's projectId may change while the ~15 s call is in flight.
    onMutate: () => ({ projectId }),
    onSuccess: (explainer: ClaimExplainer, claimId, { projectId }) => {
      const patch = <T extends { id?: number; claim_id?: number }>(item: T): T =>
        item.id === claimId || item.claim_id === claimId ? { ...item, explainer } : item
      // Explainers are per project: patch only this project's caches (and the project-less views, which show the
      // latest explainer); other projects' caches are just invalidated below.
      client.setQueriesData<Recommendation[]>({ queryKey: ['recommendations', projectId] }, (old) => old?.map(patch))
      client.setQueriesData<Paged<Claim>>({ queryKey: ['claims'] }, (old) => (old ? { ...old, items: old.items.map(patch) } : old))
      for (const key of [keys.claim(claimId, projectId), keys.claim(claimId)])
        client.setQueryData<ClaimDetail>(key, (old) => (old ? { ...old, explainer } : old))
      client.setQueriesData<PaperDetail>({ queryKey: ['paper'] }, (old) => (old ? { ...old, claims: old.claims.map(patch) } : old))
      for (const key of ['recommendations', 'claims', 'claim', 'paper']) client.invalidateQueries({ queryKey: [key] })
    },
  })
}

export const useExplainPaper = () => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (paperId: string) => api.research.explainPaper(paperId),
    onSuccess: (explainer: PaperExplainer, paperId) => {
      client.setQueriesData<Paged<PaperSummary>>({ queryKey: ['papers'] }, (old) =>
        old ? { ...old, items: old.items.map((item) => (item.paper_id === paperId ? { ...item, explainer } : item)) } : old,
      )
      client.setQueryData<PaperDetail>(keys.paper(paperId), (old) => (old ? { ...old, explainer } : old))
      for (const key of ['papers', 'paper', 'claim']) client.invalidateQueries({ queryKey: [key] })
    },
  })
}

export const useExplainTopic = () => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (slug: string) => api.research.explainTopic(slug),
    onSuccess: (explainer: TopicExplainer, slug) => {
      client.setQueriesData<Topic[]>({ queryKey: ['topics'] }, (old) => old?.map((topic) => (topic.slug === slug ? { ...topic, explainer } : topic)))
      client.setQueryData<Topic>(keys.topic(slug), (old) => (old ? { ...old, explainer } : old))
      for (const key of ['topics', 'topic']) client.invalidateQueries({ queryKey: [key] })
    },
  })
}

export const useGenerateConceptMap = () => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (paperId: string) => api.research.conceptMap(paperId),
    onSuccess: (conceptMap, paperId) => {
      client.setQueryData<PaperDetail>(keys.paper(paperId), (old) => (old ? { ...old, concept_map: conceptMap } : old))
      for (const key of ['paper', 'recommendations', 'claims', 'claim', 'experiment']) client.invalidateQueries({ queryKey: [key] })
    },
  })
}

export const useExplainBackfill = () => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: { project_id?: number | null; claims_top?: number }) => api.research.explainBackfill(body),
    onSuccess: () => client.invalidateQueries({ queryKey: ['jobs'] }),
  })
}

/** Most recent jobs of one kind (newest first); polls quickly while one is queued or running. */
export const useJobsOfKind = (kind: string, filter?: (payload: Record<string, unknown>) => boolean) =>
  useQuery({
    queryKey: ['jobs', 'kind', kind] as const,
    queryFn: async () => (await api.lab.jobs(200)).filter((job) => job.kind === kind && (!filter || filter(job.payload ?? {}))),
    refetchInterval: (query) => (query.state.data?.some((job) => job.status === 'queued' || job.status === 'running') ? 3_000 : 15_000),
  })

// ---- mutations ----------------------------------------------------------------------

function useExperimentMutation<TVars>(id: number, mutationFn: (vars: TVars) => Promise<Experiment>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn,
    // e.g. 409 because someone else already decided: show the current state
    onError: () => client.invalidateQueries({ queryKey: keys.experiment(id), exact: true }),
    onSuccess: async (experiment) => {
      // A detail GET started before the decision could land afterwards and resurrect the old status (and gate controls).
      await client.cancelQueries({ queryKey: keys.experiment(experiment.id), exact: true })
      client.setQueryData(keys.experiment(experiment.id), experiment)
      client.invalidateQueries({ queryKey: keys.experiment(experiment.id), exact: true })
      client.invalidateQueries({ queryKey: ['experiments'] })
      client.invalidateQueries({ queryKey: keys.stats })
      client.invalidateQueries({ queryKey: ['jobs'] })
      client.invalidateQueries({ queryKey: ['recommendations'] })
    },
  })
}

export const useSpecDecision = (id: number) =>
  useExperimentMutation(id, (body: SpecDecisionBody) => api.lab.decideSpec(id, body))

export const useMergeDecision = (id: number) =>
  useExperimentMutation(id, (body: MergeDecisionBody) => api.lab.decideMerge(id, body))

export const useCancelExperiment = (id: number) => useExperimentMutation(id, () => api.lab.cancel(id))

export const useRetryExperiment = (id: number) => useExperimentMutation(id, () => api.lab.retry(id))

export const useEditSpec = (id: number) => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (overrides: Record<string, unknown>) => api.lab.editSpec(id, overrides),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.experiment(id) }),
  })
}

export const useCreateExperiments = () => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: PickBody) => api.lab.createExperiments(body),
    onSuccess: (experiments) => {
      for (const experiment of experiments) client.setQueryData(keys.experiment(experiment.id), experiment)
      client.invalidateQueries({ queryKey: ['experiments'] })
      client.invalidateQueries({ queryKey: ['recommendations'] })
      client.invalidateQueries({ queryKey: ['triage'] })
      client.invalidateQueries({ queryKey: keys.stats })
    },
  })
}

export const useStartTriage = (projectId: number | undefined) => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (options: TriageOptions) => api.lab.startTriage(projectId!, options),
    onSuccess: (triage) => {
      client.setQueryData(keys.triage(triage.id), triage)
      client.invalidateQueries({ queryKey: ['triage'] })
      client.invalidateQueries({ queryKey: ['jobs'] })
    },
  })
}

export const useQueueJob = <TVars,>(mutationFn: (vars: TVars) => Promise<{ job_id: number; kind: string }>) => {
  const client = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['jobs'] })
      client.invalidateQueries({ queryKey: keys.stats })
    },
  })
}
