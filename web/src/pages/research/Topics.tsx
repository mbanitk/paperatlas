import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { useQueueJob, useSeeds, useTopics } from '../../api/queries'
import type { Topic } from '../../api/types'
import { ConfirmDialog } from '../../components/Dialog'
import { AlertIcon, RefreshIcon } from '../../components/Icons'
import { CategoryCounts, KpiRow, SparkBars } from '../../components/Insights'
import { useToast } from '../../components/Toast'
import { Button, CardHeader, Checkbox, Chip, Disclosure, EmptyState, ErrorState, RelativeTime, Skeleton } from '../../components/ui'
import { formatNumber, pluralize } from '../../lib/format'
import { monthLabel, monthlyMomentum, testableClaims, topicDisplayNames, topicsAnswer, topicSummary } from '../../lib/research'
import { sentenceCase } from '../../lib/semantics'

function TopicCard({ topic, name }: { topic: Topic; name: string }) {
  const insights = topic.insights
  const summary = topicSummary(topic)
  const momentum = monthlyMomentum(insights?.monthly)
  const claims = testableClaims(insights)
  const titleId = `topic-${topic.id}`
  const seed = topic.seed && topic.seed.toLowerCase() !== name.toLowerCase() ? topic.seed : null
  return (
    <article className="card flex min-w-0 flex-col p-3 sm:p-4" aria-labelledby={titleId}>
      <CardHeader
        titleId={titleId}
        eyebrow={
          <>
            {topic.rank != null && <span className="font-semibold text-fg tabular-nums">#{topic.rank}</span>}
            {topic.rank != null && seed && <span aria-hidden="true">·</span>}
            {seed && <span>{seed}</span>}
          </>
        }
        title={
          <Link to={`/research/topics/${topic.slug}`} className="inline-block text-fg hover:text-accent">
            {name}
          </Link>
        }
        summary={summary ?? undefined}
        summaryLines={summary ? 2 : undefined}
        status={
          <>
            {topic.needs_gpu_cluster && (
              <Chip tone="caution" title="Topics in this seed area usually need a multi-GPU cluster to test.">
                <AlertIcon size={12} className="shrink-0" /> Needs GPU cluster
              </Chip>
            )}
            {topic.status !== 'active' && <Chip tone="neutral">{sentenceCase(topic.status)}</Chip>}
          </>
        }
      />
      {insights && (
        <>
          {momentum.latest && (
            <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 rounded-lg bg-canvas-subtle px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-xs font-medium text-muted">{momentum.partial ? 'This month so far' : `Latest month (${monthLabel(momentum.latest.month)})`}</div>
                <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
                  <span className="text-metric text-fg tabular-nums">{formatNumber(momentum.latest.papers, 0)}</span>
                  <span className="text-sm text-fg">new {momentum.latest.papers === 1 ? 'paper' : 'papers'}</span>
                </div>
                {momentum.previous && (
                  <div className="text-xs text-muted">
                    {formatNumber(momentum.previous.papers, 0)} in {monthLabel(momentum.previous.month)}
                  </div>
                )}
              </div>
              <SparkBars data={insights.monthly} caption={`Papers per month (last ${insights.monthly.length})`} />
            </div>
          )}
          <KpiRow insights={insights} compact className="mt-3" />
          {!!insights.claim_categories?.length && (
            <div className="mt-3">
              <CategoryCounts categories={insights.claim_categories} max={3} />
            </div>
          )}
        </>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line-muted pt-3 text-sm">
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          <Link to={`/research/papers?topic=${topic.slug}`} className="inline-flex min-h-6 items-center">Papers{insights ? ` (${formatNumber(insights.papers, 0)})` : ''}</Link>
          {claims.testable > 0 && <Link to={`/research/claims?topic=${topic.slug}&testable=true`} className="inline-flex min-h-6 items-center">Claims to test ({formatNumber(claims.testable, 0)})</Link>}
        </span>
        <span className="text-xs text-muted">
          Updated <RelativeTime iso={topic.refreshed_at} />
        </span>
      </div>
    </article>
  )
}

export default function Topics() {
  const [archived, setArchived] = useState(false)
  const topics = useTopics(archived)
  const seeds = useSeeds()
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)
  const refresh = useQueueJob(() => api.research.refreshTopics(true))
  const names = useMemo(() => topicDisplayNames(topics.data ?? []), [topics.data])
  const answer = useMemo(() => topicsAnswer(topics.data ?? [], names), [topics.data, names])
  const seedCount = seeds.data?.seeds.length ?? answer?.seeds ?? 0

  return (
    <div className="space-y-6">
      <section aria-labelledby="topics-answer-title" className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl min-w-0">
          <h2 id="topics-answer-title" className="text-title text-fg">
            What’s trending
          </h2>
          {topics.isLoading ? (
            <Skeleton lines={2} />
          ) : answer ? (
            <p className="mt-1 text-body-lg text-fg">
              <Link to={`/research/topics/${answer.lead.slug}`} className="font-semibold">
                {answer.leadName}
              </Link>{' '}
              leads the {pluralize(topics.data?.length ?? 0, 'trending topic')}
              {answer.leadMomentum && <>, with {answer.leadMomentum}</>}
              {answer.leadTestable > 0 && <> and {pluralize(answer.leadTestable, 'testable claim')}</>}.
              {answer.busiest && answer.busiestName && (
                <>
                  {' '}
                  <Link to={`/research/topics/${answer.busiest.slug}`} className="font-semibold">
                    {answer.busiestName}
                  </Link>{' '}
                  has the most new papers this month ({formatNumber(answer.busiestPapers, 0)}).
                </>
              )}
            </p>
          ) : null}
          <p className="mt-1 text-sm text-muted">
            Ranked by recent volume, citations, Hugging Face upvotes and code availability{seedCount ? ` across ${pluralize(seedCount, 'seed area')}` : ''}.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
          <Checkbox id="topics-archived" checked={archived} onChange={setArchived} label="Show archived" />
          <Button icon={<RefreshIcon />} onClick={() => setConfirm(true)}>
            Refresh topics…
          </Button>
        </div>
      </section>

      {topics.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} variant="card" />
          ))}
        </div>
      ) : topics.isError ? (
        <ErrorState title="We couldn’t load the topics" error={topics.error} onRetry={() => topics.refetch()} />
      ) : !topics.data?.length ? (
        <div className="card">
          <EmptyState title="No trending topics yet" action={<Button onClick={() => setConfirm(true)}>Refresh topics…</Button>}>
            A topic refresh searches every seed area and picks the top 10 trending topics.
          </EmptyState>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {topics.data.map((topic) => (
            <TopicCard key={topic.id} topic={topic} name={names.get(topic.slug) ?? topic.name} />
          ))}
        </div>
      )}

      {seeds.data && (
        <section className="card px-3 py-3 sm:px-4" aria-label="How topics are found">
          <Disclosure label="How topics are found" meta={` · ${pluralize(seeds.data.seeds.length, 'seed area')} · sources: ${seeds.data.sources.join(', ')}`}>
            <ul className="grid gap-x-6 gap-y-3 text-sm md:grid-cols-2">
              {seeds.data.seeds.map((seed) => (
                <li key={seed.name} className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{seed.name}</span>
                    {seed.needs_gpu_cluster && <Chip tone="caution">Needs GPU cluster</Chip>}
                  </div>
                  <div className="text-xs text-muted [overflow-wrap:anywhere]">Searches: {seed.queries.join(' · ')}</div>
                </li>
              ))}
            </ul>
          </Disclosure>
        </section>
      )}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Refresh the trending topics?"
        confirmLabel="Queue refresh"
        loading={refresh.isPending}
        error={refresh.error}
        cost="Runs on the worker · takes several minutes · replaces the current top 10"
        onConfirm={() =>
          refresh.mutate(undefined, {
            onSuccess: (job) => {
              setConfirm(false)
              toast.success(
                <>
                  Queued job #{job.job_id}. Track it on the <Link to="/system">System</Link> page.
                </>,
              )
            },
          })
        }
      >
        <p className="text-muted">Searches every seed area across the configured sources, groups the results and picks a new top 10.</p>
      </ConfirmDialog>
    </div>
  )
}
