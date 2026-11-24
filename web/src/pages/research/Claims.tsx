import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useCategories, useClaims, useProjects, useTopics } from '../../api/queries'
import type { Claim, Project } from '../../api/types'
import { ClaimSummary } from '../../components/ClaimStory'
import { ChevronDown, SearchIcon, SparkIcon, XIcon } from '../../components/Icons'
import { Button, EmptyState, ErrorState, Loading, Pagination, cx, useDebounced } from '../../components/ui'
import { formatAcronyms, formatScore, humanize, pluralize } from '../../lib/format'
import { sentenceCase } from '../../lib/semantics'

const LIMIT = 30

function ClaimRow({ claim, project }: { claim: Claim; project?: Project }) {
  return (
    <li>
      <ClaimSummary
        claim={claim}
        project={project}
        to={`/research/claims/${claim.id}`}
        canGenerate={claim.testable}
        footer={typeof claim.search_score === 'number' && <span className="tabular-nums">Relevance {formatScore(claim.search_score)}</span>}
      />
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
  const [filtersOpen, setFiltersOpen] = useState(false)
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

  const topicName = topics.data?.find((item) => item.slug === topic)?.name
  const activeFilters: { key: string; label: string }[] = [
    category ? { key: 'category', label: `Category: ${sentenceCase(formatAcronyms(humanize(category)))}` } : null,
    topic ? { key: 'topic', label: `Topic: ${formatAcronyms(topicName ?? topic)}` } : null,
    testable ? { key: 'testable', label: testable === 'true' ? 'Testable only' : 'Not testable only' } : null,
  ].filter((item): item is { key: string; label: string } => !!item)

  return (
    <div>
      <section aria-label="Filters" className="mb-3 rounded-lg border border-line bg-canvas p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-56">
            <label htmlFor="claim-search" className="label">
              Search claims
            </label>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
              <input
                id="claim-search"
                type="search"
                className="input pl-8"
                placeholder="e.g. time to first token"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <Button
            className="md:hidden"
            onClick={() => setFiltersOpen((value) => !value)}
            aria-expanded={filtersOpen}
            aria-controls="claim-filters"
            icon={<ChevronDown size={14} className={cx('transition-transform', filtersOpen && 'rotate-180')} />}
          >
            Filters{activeFilters.length > 0 && <span className="tabular-nums"> ({activeFilters.length})</span>}
          </Button>
          <div id="claim-filters" className={cx('w-full flex-wrap items-end gap-3 md:flex md:w-auto', filtersOpen ? 'grid grid-cols-1 sm:grid-cols-3' : 'hidden')}>
            <div>
              <label htmlFor="claim-category" className="label">
                Category
              </label>
              <select id="claim-category" className="input md:w-48" value={category} onChange={(e) => update({ category: e.target.value || null })}>
                <option value="">All categories</option>
                {categories.data?.map((item) => (
                  <option key={item} value={item}>
                    {sentenceCase(formatAcronyms(humanize(item)))}
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
                    {item.rank}. {formatAcronyms(item.name)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="claim-testable" className="label">
                Testable
              </label>
              <select id="claim-testable" className="input md:w-36" value={testable} onChange={(e) => update({ testable: e.target.value || null })}>
                <option value="">Any</option>
                <option value="true">Testable</option>
                <option value="false">Not testable</option>
              </select>
            </div>
          </div>
        </div>
        {activeFilters.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">Active:</span>
            {activeFilters.map((filter) => (
              <button
                key={filter.key}
                type="button"
                className="tag min-h-6 text-fg hover:border-fg"
                onClick={() => update({ [filter.key]: null })}
                aria-label={`Remove filter: ${filter.label}`}
              >
                {filter.label}
                <XIcon size={12} className="shrink-0" />
              </button>
            ))}
          </div>
        )}
      </section>

      {claims.isLoading ? (
        <Loading label={q ? 'Searching…' : 'Loading claims…'} />
      ) : claims.isError ? (
        <ErrorState error={claims.error} onRetry={() => claims.refetch()} />
      ) : !claims.data?.items.length ? (
        <EmptyState title="No claim cards match" icon={<SparkIcon size={28} />}>
          Try a broader search or clear the filters.
        </EmptyState>
      ) : (
        <>
          <p className="mb-2 text-xs text-muted" aria-live="polite">
            {pluralize(claims.data.total, 'claim card')}
            {q && ' · ranked by relevance'}
            {claims.isFetching && ' · updating…'}
          </p>
          <ul className="space-y-3">
            {claims.data.items.map((claim) => (
              <ClaimRow key={claim.id} claim={claim} project={project} />
            ))}
          </ul>
        </>
      )}
      {!q && claims.data && <Pagination total={claims.data.total} limit={LIMIT} offset={offset} onChange={(next) => update({ offset: next ? String(next) : null })} />}
    </div>
  )
}
