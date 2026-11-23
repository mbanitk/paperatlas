import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, encodePaperId } from '../../api/client'
import { usePapers, useQueueJob, useTopics } from '../../api/queries'
import type { PaperSummary } from '../../api/types'
import { DocTypeChip } from '../../components/Badges'
import { BookIcon, RefreshIcon, SearchIcon } from '../../components/Icons'
import { ResultTiles } from '../../components/Explainers'
import { useToast } from '../../components/Toast'
import { Button, Chip, EmptyState, ErrorState, Loading, Pagination, errorMessage, useDebounced } from '../../components/ui'
import { formatDate, pluralize, truncate } from '../../lib/format'

const LIMIT = 25

function Signals({ paper }: { paper: PaperSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
      <span title="Citations">
        <span className="text-subtle">cites</span> <span className="font-semibold text-fg tabular-nums">{paper.citation_count ?? '—'}</span>
      </span>
      <span title="Hugging Face upvotes">
        <span className="text-subtle">HF ↑</span> <span className="font-semibold text-fg tabular-nums">{paper.hf_upvotes ?? '—'}</span>
      </span>
      {paper.code_url ? (
        <a href={paper.code_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-success">
          ‹/› code
        </a>
      ) : (
        <span className="text-subtle">no code</span>
      )}
      <span className="inline-flex flex-wrap items-center gap-1">
        {paper.sources.map((source) => (
          <span key={source} className="rounded bg-canvas-inset px-1.5 py-px text-[10.5px]">
            {source}
          </span>
        ))}
      </span>
    </div>
  )
}

function PaperRow({ paper }: { paper: PaperSummary }) {
  const explainer = paper.explainer
  return (
    <li className="px-4 py-4 hover:bg-canvas-subtle/60">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <DocTypeChip docType={paper.doc_type} />
            <Link to={`/research/papers/${encodePaperId(paper.paper_id)}`} className="font-semibold text-fg hover:text-accent">
              {paper.title}
            </Link>
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {paper.venue ?? 'unknown venue'} · {formatDate(paper.publication_date)}
          </div>
        </div>
        <div className="shrink-0">
          {paper.distilled ? (
            <Chip tone={paper.testable_claims ? 'success' : 'neutral'}>
              {paper.claims} claims · {paper.testable_claims} testable
            </Chip>
          ) : (
            <Chip tone="muted">not distilled</Chip>
          )}
        </div>
      </div>
      {explainer?.tldr ? (
        <p className="mt-2 text-sm text-fg">
          <span className="mr-1 rounded bg-done-subtle px-1 py-px text-[10.5px] font-semibold text-done">TL;DR</span>
          {explainer.tldr}
        </p>
      ) : (
        paper.abstract && <p className="mt-2 text-sm text-muted">{truncate(paper.abstract, 220)}</p>
      )}
      {!!explainer?.key_results?.length && (
        <div className="mt-2.5 max-w-3xl">
          <ResultTiles results={explainer.key_results} max={4} />
        </div>
      )}
      <div className="mt-2.5">
        <Signals paper={paper} />
      </div>
    </li>
  )
}

export default function Papers() {
  const [params, setParams] = useSearchParams()
  const topic = params.get('topic') ?? ''
  const offset = Number(params.get('offset')) || 0
  const [search, setSearch] = useState(params.get('q') ?? '')
  const q = useDebounced(search.trim(), 450)
  const topics = useTopics()
  const toast = useToast()
  const papers = usePapers({ q: q || undefined, topic: topic || undefined, limit: LIMIT, offset: q ? 0 : offset })
  const discover = useQueueJob(() => api.research.discover({}))
  const distill = useQueueJob(() => api.research.distill({ limit: 30 }))

  const update = (changes: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value)
          else next.delete(key)
        }
        return next
      },
      { replace: true },
    )

  useEffect(() => {
    if ((params.get('q') ?? '') !== q) update({ q: q || null, offset: null })
  }, [q])

  const queued = (job: { job_id: number; kind: string }) =>
    toast.success(
      <>
        Queued job #{job.job_id} ({job.kind}). Track it on the <Link to="/system">System</Link> page.
      </>,
    )

  return (
    <div>
      <div className="mb-4 grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
        <div>
          <label htmlFor="paper-search" className="label">
            Search papers
          </label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle" />
            <input id="paper-search" type="search" className="input pl-8" placeholder="title or abstract (hybrid search)" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div>
          <label htmlFor="paper-topic" className="label">
            Topic
          </label>
          <select id="paper-topic" className="input md:w-64" value={topic} onChange={(e) => update({ topic: e.target.value || null, offset: null })}>
            <option value="">All topics</option>
            {topics.data?.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.rank}. {item.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <Button icon={<RefreshIcon />} loading={discover.isPending} onClick={() => discover.mutate(undefined, { onSuccess: queued, onError: (e) => toast.error(errorMessage(e)) })}>
            Discover
          </Button>
          <Button loading={distill.isPending} onClick={() => distill.mutate(undefined, { onSuccess: queued, onError: (e) => toast.error(errorMessage(e)) })}>
            Distill pending
          </Button>
        </div>
      </div>

      <div className="card">
        {papers.isLoading ? (
          <Loading label={q ? 'Searching…' : 'Loading papers…'} />
        ) : papers.isError ? (
          <div className="p-4">
            <ErrorState error={papers.error} onRetry={() => papers.refetch()} />
          </div>
        ) : !papers.data?.items.length ? (
          <EmptyState title="No papers found" icon={<BookIcon size={28} />}>
            {q || topic ? 'Try another search or topic.' : 'Run “Discover” or a research scan to find papers.'}
          </EmptyState>
        ) : (
          <>
            <div className="border-b border-line-muted px-4 py-2 text-xs text-muted">
              {pluralize(papers.data.total, 'result')}
              {papers.isFetching && ' · updating…'}
            </div>
            <ul className="divide-y divide-line-muted">
              {papers.data.items.map((paper) => (
                <PaperRow key={paper.paper_id} paper={paper} />
              ))}
            </ul>
          </>
        )}
      </div>
      {!q && papers.data && (
        <Pagination total={papers.data.total} limit={LIMIT} offset={offset} onChange={(next) => update({ offset: next ? String(next) : null })} />
      )}
    </div>
  )
}
