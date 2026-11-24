import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { useQueueJob, useSeeds, useTopics } from '../../api/queries'
import type { Topic } from '../../api/types'
import { Meter } from '../../components/Charts'
import { CategoryCounts, KpiRow, SparkBars } from '../../components/Insights'
import { ConfirmDialog } from '../../components/Dialog'
import { AlertIcon, RefreshIcon } from '../../components/Icons'
import { useToast } from '../../components/Toast'
import { Button, Card, Checkbox, Chip, EmptyState, ErrorState, Loading, RelativeTime } from '../../components/ui'
import { formatNumber } from '../../lib/format'

function TopicCard({ topic }: { topic: Topic }) {
  const insights = topic.insights
  const summary = topic.explainer?.summary || topic.description
  return (
    <article className="card flex flex-col p-4" aria-labelledby={`topic-${topic.id}`}>
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-sm font-bold text-accent tabular-nums">
          {topic.rank ?? '–'}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`topic-${topic.id}`} className="leading-snug font-semibold">
            <Link to={`/research/topics/${topic.slug}`} className="text-fg hover:text-accent">
              {topic.name}
            </Link>
          </h3>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {topic.seed && <Chip tone="neutral">{topic.seed}</Chip>}
            {topic.needs_gpu_cluster && (
              <Chip tone="attention" title="Topics in this seed area usually need a multi-GPU cluster to test">
                <AlertIcon size={12} /> needs GPU cluster
              </Chip>
            )}
            {topic.status !== 'active' && <Chip tone="muted">{topic.status}</Chip>}
          </div>
        </div>
      </div>
      {summary && <p className="mt-3 line-clamp-3 text-sm text-muted">{summary}</p>}
      {insights && (
        <div className="mt-3 rounded-md border border-line-muted bg-canvas-subtle/50 px-3 py-2.5">
          <KpiRow insights={insights} compact />
          <div className="mt-2.5 flex items-end justify-between gap-3">
            <div>
              <SparkBars data={insights.monthly} />
              <div className="mt-0.5 text-[10.5px] text-subtle">papers / month</div>
            </div>
            <div className="min-w-0 flex-1 pl-2">
              <div className="mb-1 flex items-center justify-between text-[11px]">
                <span className="text-muted">trend</span>
                <span className="font-semibold tabular-nums">{formatNumber(topic.trend_score, 2)}</span>
              </div>
              <Meter value={topic.trend_score} label={`Trend score ${topic.trend_score}`} />
            </div>
          </div>
        </div>
      )}
      {!!insights?.claim_categories?.length && (
        <div className="mt-3">
          <CategoryCounts categories={insights.claim_categories} max={3} />
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4 text-xs">
        <span className="text-muted">
          refreshed <RelativeTime iso={topic.refreshed_at} />
        </span>
        <span className="flex gap-3">
          <Link to={`/research/papers?topic=${topic.slug}`}>Papers</Link>
          <Link to={`/recommendations?topic=${topic.slug}`}>Recommendations</Link>
          <Link to={`/research/topics/${topic.slug}`} className="font-semibold">
            Details →
          </Link>
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Auto-picked from recent volume, citations, Hugging Face upvotes and code availability within the configured seed areas.</p>
        <div className="flex items-center gap-4">
          <Checkbox id="topics-archived" checked={archived} onChange={setArchived} label="Show archived" />
          <Button icon={<RefreshIcon />} onClick={() => setConfirm(true)}>
            Refresh topics
          </Button>
        </div>
      </div>

      {topics.isLoading ? (
        <Loading />
      ) : topics.isError ? (
        <ErrorState error={topics.error} onRetry={() => topics.refetch()} />
      ) : !topics.data?.length ? (
        <EmptyState title="No topics yet" action={<Button onClick={() => setConfirm(true)}>Refresh topics</Button>}>
          Run a topic refresh (or a research scan with “refresh topics”) to find the trending topics.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {topics.data.map((topic) => (
            <TopicCard key={topic.id} topic={topic} />
          ))}
        </div>
      )}

      {seeds.data && (
        <Card title="Seed areas" actions={<span className="text-xs text-muted">sources: {seeds.data.sources.join(', ')}</span>}>
          <ul className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2">
            {seeds.data.seeds.map((seed) => (
              <li key={seed.name}>
                <span className="font-medium">{seed.name}</span>
                {seed.needs_gpu_cluster && (
                  <Chip tone="attention" className="ml-2">
                    needs GPU cluster
                  </Chip>
                )}
                <div className="text-xs text-muted">{seed.queries.join(' · ')}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Refresh the trending topics?"
        confirmLabel="Queue refresh"
        loading={refresh.isPending}
        error={refresh.error}
        onConfirm={() =>
          refresh.mutate(undefined, {
            onSuccess: (job) => {
              setConfirm(false)
              toast.success(
                <>
                  Queued job #{job.job_id} ({job.kind}). Track it on the <Link to="/system">System</Link> page.
                </>,
              )
            },
          })
        }
      >
        <p className="text-muted">Searches every seed area across the configured sources, clusters the results and picks a new top 10. Runs on the worker and may take several minutes.</p>
      </ConfirmDialog>
    </div>
  )
}
