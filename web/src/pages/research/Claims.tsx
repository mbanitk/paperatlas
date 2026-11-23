import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useCategories, useClaims, useProjects, useTopics } from '../../api/queries'
import type { Claim, Project } from '../../api/types'
import { ClaimChips } from '../../components/ClaimCard'
import { ClaimDiagram, ClaimExplainDetails, ClaimLead, GenerateClaimExplainer, GlanceStrip } from '../../components/Explainers'
import { RelatedStrip } from '../../components/Related'
import { SearchIcon, SparkIcon } from '../../components/Icons'
import { Button, EmptyState, ErrorState, Loading, Pagination, PaperLink, useDebounced } from '../../components/ui'
import { formatScore, humanize, pluralize } from '../../lib/format'

const LIMIT = 30

function ClaimRow({ claim, project }: { claim: Claim; project?: Project }) {
  const [open, setOpen] = useState(false)
  const explainer = claim.explainer
  return (
    <li className="px-4 py-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <Link to={`/research/claims/${claim.id}`} className="font-semibold text-fg hover:text-accent">
            {claim.name}
          </Link>
          {typeof claim.search_score === 'number' && <span className="text-[11px] text-muted">relevance {formatScore(claim.search_score)}</span>}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted">
          <PaperLink paperId={claim.paper_id} title={claim.paper_title ?? claim.paper_id} className="text-muted hover:text-accent" />
        </div>
        <ClaimLead claim={claim} explainer={explainer} />
      </div>
      <div className="mt-3">
        <GlanceStrip claim={claim} explainer={explainer} project={project} />
      </div>
      <RelatedStrip related={claim.related} claimId={claim.id} paperId={claim.paper_id} className="mt-3" />
      <ClaimDiagram diagram={explainer?.diagram} className="mt-3" />
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <ClaimChips claim={claim} />
        {explainer ? (
          <Button size="sm" variant="invisible" onClick={() => setOpen(!open)} aria-expanded={open} icon={<SparkIcon size={14} />}>
            {open ? 'Hide explanation' : 'Explain'}
          </Button>
        ) : (
          claim.testable && <GenerateClaimExplainer claimId={claim.id} projectId={project?.id} />
        )}
      </div>
      {open && explainer && (
        <div className="mt-3 border-t border-line-muted pt-4">
          <ClaimExplainDetails explainer={explainer} projectName={project?.name} showDiagram={false} />
        </div>
      )}
    </li>
  )
}

export default function Claims() {
  const [params, setParams] = useSearchParams()
  const category = params.get('category') ?? ''
  const topic = params.get('topic') ?? ''
  const testable = params.get('testable') ?? ''
  const offset = Number(params.get('offset')) || 0
  const [search, setSearch] = useState(params.get('q') ?? '')
  const q = useDebounced(search.trim(), 450)
  const categories = useCategories()
  const topics = useTopics()
  const projects = useProjects()
  const project = projects.data?.[0]
  const claims = useClaims({
    q: q || undefined,
    category: category || undefined,
    topic: topic || undefined,
    testable: testable === '' ? undefined : testable === 'true',
    limit: LIMIT,
    offset: q ? 0 : offset,
  })

  const update = (changes: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value)
          else next.delete(key)
        }
        if (!('offset' in changes)) next.delete('offset')
        return next
      },
      { replace: true },
    )

  useEffect(() => {
    if ((params.get('q') ?? '') !== q) update({ q: q || null })
  }, [q])

  return (
    <div>
      <div className="mb-4 grid gap-3 md:grid-cols-[1fr_auto_auto_auto] md:items-end">
        <div>
          <label htmlFor="claim-search" className="label">
            Search claims
          </label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle" />
            <input
              id="claim-search"
              type="search"
              className="input pl-8"
              placeholder="hybrid full-text + semantic search, e.g. “time to first token”"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label htmlFor="claim-category" className="label">
            Category
          </label>
          <select id="claim-category" className="input md:w-48" value={category} onChange={(e) => update({ category: e.target.value || null })}>
            <option value="">All categories</option>
            {categories.data?.map((item) => (
              <option key={item} value={item}>
                {humanize(item)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="claim-topic" className="label">
            Topic
          </label>
          <select id="claim-topic" className="input md:w-56" value={topic} onChange={(e) => update({ topic: e.target.value || null })}>
            <option value="">All topics</option>
            {topics.data?.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.rank}. {item.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="claim-testable" className="label">
            Testable
          </label>
          <select id="claim-testable" className="input md:w-32" value={testable} onChange={(e) => update({ testable: e.target.value || null })}>
            <option value="">Any</option>
            <option value="true">Testable</option>
            <option value="false">Not testable</option>
          </select>
        </div>
      </div>

      <div className="card">
        {claims.isLoading ? (
          <Loading label={q ? 'Searching…' : 'Loading claims…'} />
        ) : claims.isError ? (
          <div className="p-4">
            <ErrorState error={claims.error} onRetry={() => claims.refetch()} />
          </div>
        ) : !claims.data?.items.length ? (
          <EmptyState title="No claim cards match" icon={<SparkIcon size={28} />}>
            Try a broader search or clear the filters.
          </EmptyState>
        ) : (
          <>
            <div className="border-b border-line-muted px-4 py-2 text-xs text-muted">
              {pluralize(claims.data.total, 'claim card')}
              {q && ' · ranked by relevance'}
              {claims.isFetching && ' · updating…'}
            </div>
            <ul className="divide-y divide-line-muted">
              {claims.data.items.map((claim) => (
                <ClaimRow key={claim.id} claim={claim} project={project} />
              ))}
            </ul>
          </>
        )}
      </div>
      {!q && claims.data && <Pagination total={claims.data.total} limit={LIMIT} offset={offset} onChange={(next) => update({ offset: next ? String(next) : null })} />}
    </div>
  )
}
