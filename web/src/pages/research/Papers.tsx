import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, encodePaperId } from '../../api/client'
import { useExperiments, usePapers, useQueueJob, useStats, useTopics } from '../../api/queries'
import type { ExperimentSummary, PaperSummary } from '../../api/types'
import { DocTypeChip } from '../../components/Badges'
import { ConfirmDialog } from '../../components/Dialog'
import { BookIcon, CodeIcon, PlayIcon, SearchIcon } from '../../components/Icons'
import { ActionMenu, HeadlineResult, TestedStatus, topicName, useTopicNames } from '../../components/Insights'
import { useToast } from '../../components/Toast'
import { Button, CardHeader, EmptyState, ErrorState, MathText, Pagination, Skeleton, useDebounced } from '../../components/ui'
import { formatDate, formatNumber, pluralize, sanitizeText, truncate } from '../../lib/format'
import { experimentsByPaper, sourceLabel } from '../../lib/research'

const LIMIT = 25
const DISTILL_LIMIT = 30

function Signals({ paper }: { paper: PaperSummary }) {
  const items = [
    typeof paper.citation_count === 'number' && paper.citation_count > 0 && <span key="cites">{pluralize(paper.citation_count, 'citation')}</span>,
    typeof paper.hf_upvotes === 'number' && paper.hf_upvotes > 0 && (
      <span key="hf">
        {formatNumber(paper.hf_upvotes, 0)} Hugging Face {paper.hf_upvotes === 1 ? 'upvote' : 'upvotes'}
      </span>
    ),
    paper.code_url && (
      <a key="code" href={paper.code_url} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-6 items-center gap-1">
        <CodeIcon size={14} className="shrink-0" /> Code
        <span className="sr-text"> (opens in a new tab)</span>
      </a>
    ),
    paper.sources.length > 0 && <span key="sources">From {paper.sources.map(sourceLabel).join(', ')}</span>,
  ].filter(Boolean)
  if (!items.length) return null
  return <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">{items}</div>
}

function PaperRow({ paper, experiments }: { paper: PaperSummary; experiments: ExperimentSummary[] | undefined }) {
  const explainer = paper.explainer
  const href = `/research/papers/${encodePaperId(paper.paper_id)}`
  const results = explainer?.key_results ?? []
  return (
    <li className="px-3 py-4 sm:px-4">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(180px,220px)] md:gap-6">
        <div className="min-w-0">
          <CardHeader
            eyebrow={
              <>
                <DocTypeChip docType={paper.doc_type} />
                {paper.venue && <span>{paper.venue}</span>}
                {paper.venue && paper.publication_date && <span aria-hidden="true">·</span>}
                {paper.publication_date && <span>{formatDate(paper.publication_date)}</span>}
              </>
            }
            title={
              <Link to={href} className="inline-block text-fg hover:text-accent">
                <MathText>{paper.title}</MathText>
              </Link>
            }
          />
          {explainer?.tldr ? (
            <p className="mt-1.5 text-sm text-fg">
              <span className="font-semibold">In short: </span>
              {sanitizeText(explainer.tldr)}
            </p>
          ) : (
            paper.abstract && <p className="mt-1.5 text-sm text-muted">{truncate(sanitizeText(paper.abstract), 220)}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            {paper.distilled ? (
              <span>
                {pluralize(paper.claims, 'claim card')}
                {paper.claims > 0 && <>, {formatNumber(paper.testable_claims, 0)} testable</>}
              </span>
            ) : (
              <span>Not summarised yet</span>
            )}
            <TestedStatus experiments={experiments} untested={null} />
          </div>
          <Signals paper={paper} />
        </div>
        {results.length > 0 && (
          <HeadlineResult
            className="self-start"
            results={results}
            more={
              results.length > 1 ? (
                <Link to={`${href}#key-results`} className="inline-flex min-h-6 items-center text-xs">
                  +{pluralize(results.length - 1, 'more result')}
                </Link>
              ) : undefined
            }
          />
        )}
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
  const names = useTopicNames()
  const stats = useStats()
  const experiments = useExperiments({})
  const byPaper = useMemo(() => experimentsByPaper(experiments.data), [experiments.data])
  const toast = useToast()
  const papers = usePapers({ q: q || undefined, topic: topic || undefined, limit: LIMIT, offset: q ? 0 : offset })
  const discover = useQueueJob(() => api.research.discover({}))
  const distill = useQueueJob(() => api.research.distill({ limit: DISTILL_LIMIT }))
  const [confirm, setConfirm] = useState<'discover' | 'distill' | null>(null)
  const pending = stats.data ? Math.max(0, stats.data.papers - stats.data.papers_distilled) : null

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

  const queued = (job: { job_id: number; kind: string }) => {
    setConfirm(null)
    toast.success(
      <>
        Queued job #{job.job_id}. Track it on the <Link to="/system">System</Link> page.
      </>,
    )
  }
  const topicItem = topics.data?.find((item) => item.slug === topic)
  const filtered = !!(q || topic)
  const total = papers.data?.total

  return (
    <div className="space-y-4">
      <section aria-labelledby="papers-answer-title">
        <h2 id="papers-answer-title" className="text-title text-fg">
          {q ? `Results for “${q}”` : topicItem ? `Papers in ${topicName(topicItem, names)}` : 'Latest papers and patents'}
        </h2>
        <p className="mt-1 max-w-3xl text-body text-muted">
          {filtered ? (
            typeof total === 'number' ? (
              <>
                {q ? `The ${pluralize(total, 'closest match', 'closest matches')} by title and meaning` : `${pluralize(total, 'paper')} in this topic`}. Each shows its one-line summary and
                the headline result the paper reports.
              </>
            ) : (
              'Searching…'
            )
          ) : stats.data ? (
            <>
              <span className="font-semibold text-fg">{formatNumber(stats.data.papers_distilled, 0)}</span> of {formatNumber(stats.data.papers, 0)} papers are summarised into{' '}
              <span className="font-semibold text-fg">{pluralize(stats.data.claims, 'claim card')}</span> ({formatNumber(stats.data.testable_claims, 0)} testable)
              {byPaper.size > 0 && <>; {pluralize(byPaper.size, 'paper')} tested here so far</>}. Newest first.
            </>
          ) : (
            'Each paper shows its one-line summary and the headline result it reports.'
          )}
        </p>
      </section>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)_auto] sm:items-end">
        <div className="min-w-0">
          <label htmlFor="paper-search" className="label">
            Search papers
          </label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <input id="paper-search" type="search" className="input min-h-10 pl-8 sm:min-h-8" placeholder="Title or abstract" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="flex min-w-0 items-end gap-2 sm:contents">
          <div className="min-w-0 flex-1">
            <label htmlFor="paper-topic" className="label">
              Topic
            </label>
            <select id="paper-topic" className="input min-h-10 sm:min-h-8" value={topic} onChange={(e) => update({ topic: e.target.value || null, offset: null })}>
              <option value="">All topics</option>
              {topics.data?.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.rank != null ? `${item.rank}. ` : ''}
                  {topicName(item, names)}
                </option>
              ))}
            </select>
          </div>
          <ActionMenu
            icon={<PlayIcon size={14} />}
            className="min-h-10 sm:min-h-8"
            items={[
              { label: 'Find new papers…', description: 'Searches every seed area · several minutes', onSelect: () => setConfirm('discover') },
              {
                label: `Summarise pending papers${pending ? ` (up to ${Math.min(pending, DISTILL_LIMIT)})` : ''}…`,
                description: 'Writes claim cards with the LLM · runs on the worker',
                onSelect: () => setConfirm('distill'),
              },
            ]}
          >
            Run
          </ActionMenu>
        </div>
      </div>

      <div className="card">
        {papers.isLoading ? (
          <div className="px-4 py-2" role="status" aria-label={q ? 'Searching' : 'Loading papers'}>
            <Skeleton variant="row" count={6} />
          </div>
        ) : papers.isError ? (
          <div className="p-4">
            <ErrorState title="We couldn’t load the papers" error={papers.error} onRetry={() => papers.refetch()} />
          </div>
        ) : !papers.data?.items.length ? (
          filtered ? (
            <EmptyState
              title="No papers match"
              icon={<BookIcon size={28} />}
              action={
                <Button
                  onClick={() => {
                    setSearch('')
                    update({ q: null, topic: null, offset: null })
                  }}
                >
                  Clear search and topic
                </Button>
              }
            >
              Try other words, or another topic.
            </EmptyState>
          ) : (
            <EmptyState title="No papers yet" icon={<BookIcon size={28} />} action={<Button onClick={() => setConfirm('discover')}>Find new papers…</Button>}>
              Finding papers searches every seed area across the configured sources.
            </EmptyState>
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-muted px-3 py-2 text-xs text-muted sm:px-4" aria-live="polite">
              <span>
                {q ? pluralize(papers.data.total, 'result') : `${formatNumber(offset + 1, 0)}–${formatNumber(Math.min(offset + LIMIT, papers.data.total), 0)} of ${formatNumber(papers.data.total, 0)}`}
              </span>
              {papers.isFetching && <span>Updating…</span>}
            </div>
            <ul className="divide-y divide-line-muted">
              {papers.data.items.map((paper) => (
                <PaperRow key={paper.paper_id} paper={paper} experiments={byPaper.get(paper.paper_id)} />
              ))}
            </ul>
          </>
        )}
      </div>
      {!q && papers.data && papers.data.total > LIMIT && (
        <Pagination total={papers.data.total} limit={LIMIT} offset={offset} onChange={(next) => update({ offset: next ? String(next) : null })} />
      )}

      <ConfirmDialog
        open={confirm === 'discover'}
        onClose={() => setConfirm(null)}
        title="Find new papers?"
        confirmLabel="Queue search"
        loading={discover.isPending}
        error={discover.error}
        cost="Runs on the worker · takes several minutes"
        onConfirm={() => discover.mutate(undefined, { onSuccess: queued })}
      >
        <p className="text-muted">Searches every seed area across the configured sources and adds papers that aren’t in the library yet.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'distill'}
        onClose={() => setConfirm(null)}
        title="Summarise pending papers?"
        confirmLabel="Queue summaries"
        loading={distill.isPending}
        error={distill.error}
        cost={`Runs on the worker · uses the LLM for up to ${DISTILL_LIMIT} papers · several minutes`}
        onConfirm={() => distill.mutate(undefined, { onSuccess: queued })}
      >
        <p className="text-muted">
          Reads papers that have no claim cards yet{pending ? ` (${formatNumber(pending, 0)} waiting)` : ''} and writes a summary and claim cards for each, up to{' '}
          {DISTILL_LIMIT} at a time.
        </p>
      </ConfirmDialog>
    </div>
  )
}
