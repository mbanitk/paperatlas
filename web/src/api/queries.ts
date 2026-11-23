import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ClaimParams, type PaperParams, type RecommendationParams } from './client'
import type { Experiment, ExperimentStatus, MergeDecisionBody, PickBody, SpecDecisionBody, TriageOptions } from './types'
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
  seeds: ['seeds'] as const,
  categories: ['categories'] as const,
  papers: (params: PaperParams) => ['papers', params] as const,
  paper: (id: string) => ['paper', id] as const,
  claims: (params: ClaimParams) => ['claims', params] as const,
  claim: (id: number) => ['claim', id] as const,
}

export const useServices = () =>
  useQuery({ queryKey: keys.services, queryFn: ({ signal }) => api.services(signal), refetchInterval: 15_000, retry: 0 })

export const useStats = () =>
  useQuery({ queryKey: keys.stats, queryFn: ({ signal }) => api.research.stats(signal), refetchInterval: 30_000 })

export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: api.lab.projects, staleTime: 60_000 })

export const useProject = (id: number | undefined) =>
  useQuery({ queryKey: keys.project(id ?? 0), queryFn: () => api.lab.project(id!), enabled: !!id, staleTime: 60_000 })

export const useRecommendations = (projectId: number | undefined, params: RecommendationParams) =>
  useQuery({
    queryKey: keys.recommendations(projectId ?? 0, params),
    queryFn: ({ signal }) => api.lab.recommendations(projectId!, params, signal),
    enabled: !!projectId,
    placeholderData: keepPreviousData,
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

export const useClaim = (id: number) =>
  useQuery({ queryKey: keys.claim(id), queryFn: () => api.research.claim(id), enabled: Number.isFinite(id) && id > 0 })

// ---- mutations ----------------------------------------------------------------------

function useExperimentMutation<TVars>(id: number, mutationFn: (vars: TVars) => Promise<Experiment>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn,
    // e.g. 409 because someone else already decided: show the current state
    onError: () => client.invalidateQueries({ queryKey: keys.experiment(id), exact: true }),
    onSuccess: (experiment) => {
      client.setQueryData(keys.experiment(experiment.id), experiment)
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
