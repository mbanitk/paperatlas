import { Link, useParams } from 'react-router'
import { encodePaperId } from '../../api/client'
import { useTopic } from '../../api/queries'
import { Meter } from '../../components/Charts'
import { ExplainerFootnote, GenerateTopicExplainer } from '../../components/Explainers'
import { AlertIcon, SparkIcon } from '../../components/Icons'
import { CategoryBars, KpiRow, SourceMix, SparkBars } from '../../components/Insights'
import { Card, Chip, EmptyState, ErrorState, Loading, RelativeTime } from '../../components/ui'
import { formatNumber } from '../../lib/format'

const STATS: [string, string, (v: number) => string][] = [
  ['recency', 'recency', (v) => v.toFixed(2)],
  ['velocity', 'last 60 days', (v) => `${Math.round(v * 100)}%`],
  ['citations', 'citation signal', (v) => v.toFixed(2)],
  ['upvotes', 'upvote signal', (v) => v.toFixed(2)],
  ['code', 'with code', (v) => `${Math.round(v * 100)}%`],
]

export default function TopicDetail() {
  const slug = useParams().slug ?? ''
  const topic = useTopic(slug)

  if (topic.isLoading) return <Loading label="Loading topic…" />
  if (topic.isError || !topic.data)
    return (
      <div className="space-y-3">
        <Link to="/research/topics" className="text-sm">
          ← Topics
        </Link>
        <ErrorState error={topic.error ?? new Error('Topic not found')} onRetry={() => topic.refetch()} />
      </div>
    )
  const data = topic.data
  const explainer = data.explainer
  const insights = data.insights
  const stats = data.stats ?? {}

  return (
    <div className="space-y-6">
      <div>
        <Link to="/research/topics" className="text-sm">
          ← Topics
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-full bg-accent-subtle text-base font-bold text-accent tabular-nums">{data.rank ?? '–'}</span>
          <h2 className="text-xl leading-snug font-semibold">{data.name}</h2>
          {data.seed && <Chip tone="neutral">{data.seed}</Chip>}
          {data.needs_gpu_cluster && (
            <Chip tone="attention">
              <AlertIcon size={12} /> needs GPU cluster
            </Chip>
          )}
        </div>
        <p className="mt-2 max-w-3xl text-sm text-muted">{explainer?.summary || data.description}</p>
        <div className="mt-2 flex flex-wrap gap-3 text-sm">
          <Link to={`/research/papers?topic=${data.slug}`}>Papers in this topic</Link>
          <Link to={`/recommendations?topic=${data.slug}`}>Recommendations</Link>
        </div>
      </div>

      {insights && (
        <Card bodyClassName="p-4">
          <KpiRow insights={insights} />
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card
            title={
              <span className="flex items-center gap-2">
                <SparkIcon className="text-done" /> Overview
              </span>
            }
          >
            {!explainer ? (
              <div className="space-y-2 text-sm text-muted">
                <p>No overview written yet for this topic.</p>
                <GenerateTopicExplainer slug={data.slug} />
              </div>
            ) : (
              <div className="space-y-5 text-sm">
                {explainer.why_now && (
                  <section>
                    <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Why now</h3>
                    <p className="text-fg">{explainer.why_now}</p>
                  </section>
                )}
                {!!explainer.key_ideas?.length && (
                  <section>
                    <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Key ideas</h3>
                    <ul className="grid gap-2 sm:grid-cols-2">
                      {explainer.key_ideas.map((idea, index) => (
                        <li key={idea.name} className="rounded-md border border-line-muted bg-canvas-subtle/60 px-3 py-2">
                          <div className="flex items-center gap-2 font-semibold text-fg">
                            <span className="flex size-5 items-center justify-center rounded-full bg-done-subtle text-[11px] text-done">{index + 1}</span>
                            {idea.name}
                          </div>
                          <p className="mt-1 text-[13px] text-muted">{idea.one_liner}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {explainer.typical_gains && (
                  <section className="rounded-md border border-success/25 bg-success-subtle/50 px-3 py-2">
                    <h3 className="mb-0.5 text-xs font-semibold tracking-wide text-success uppercase">Typical gains</h3>
                    <p className="text-fg">{explainer.typical_gains}</p>
                  </section>
                )}
                {explainer.relevance && (
                  <section className="rounded-md border border-accent/30 bg-accent-subtle/40 px-3 py-2">
                    <h3 className="mb-0.5 text-xs font-semibold tracking-wide text-accent uppercase">Relevance for a single Apple Silicon server</h3>
                    <p className="text-fg">{explainer.relevance}</p>
                  </section>
                )}
                {!!explainer.open_problems?.length && (
                  <section>
                    <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Open problems</h3>
                    <ul className="list-disc space-y-1 pl-5 text-fg">
                      {explainer.open_problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  </section>
                )}
                <ExplainerFootnote explainer={explainer} />
              </div>
            )}
          </Card>

          {insights && (
            <Card title="Top papers" actions={<Link to={`/research/papers?topic=${data.slug}`} className="text-xs">All papers</Link>}>
              {insights.top_papers.length === 0 ? (
                <p className="text-sm text-muted">No ranked papers yet.</p>
              ) : (
                <ol className="space-y-2">
                  {insights.top_papers.map((paper) => (
                    <li key={paper.paper_id} className="flex items-start gap-3 text-sm">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-canvas-inset text-[11px] font-semibold text-muted">{paper.rank ?? '·'}</span>
                      <span className="min-w-0 flex-1">
                        <Link to={`/research/papers/${encodePaperId(paper.paper_id)}`} className="font-medium text-fg hover:text-accent">
                          {paper.title}
                        </Link>
                      </span>
                      {typeof paper.score === 'number' && <span className="shrink-0 text-xs text-muted tabular-nums">{formatNumber(paper.score, 2)}</span>}
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          {insights ? (
            <>
              <Card title="Papers per month">
                <SparkBars data={insights.monthly} size="md" className="w-full" />
              </Card>
              <Card title="Where the papers come from">
                <SourceMix sources={insights.sources} />
              </Card>
              <Card title="Claim cards by category" actions={<span className="text-[11px] text-muted">green = testable</span>}>
                <CategoryBars categories={insights.claim_categories} />
              </Card>
            </>
          ) : (
            <EmptyState title="No insights yet" />
          )}
          <Card title="Trend" actions={<RelativeTime iso={data.refreshed_at} className="text-xs text-muted" />}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted">trend score</span>
              <span className="font-semibold tabular-nums">{formatNumber(data.trend_score, 3)}</span>
            </div>
            <Meter value={data.trend_score} label={`Trend score ${data.trend_score}`} />
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
              {STATS.filter(([key]) => typeof stats[key] === 'number').map(([key, label, fmt]) => (
                <div key={key} className="flex justify-between gap-2">
                  <dt className="text-muted">{label}</dt>
                  <dd className="font-semibold tabular-nums">{fmt(stats[key])}</dd>
                </div>
              ))}
            </dl>
            {!!data.keywords?.length && (
              <div className="mt-3 flex flex-wrap gap-1">
                {data.keywords.map((keyword) => (
                  <span key={keyword} className="rounded bg-canvas-inset px-1.5 py-0.5 text-[11px] text-muted">
                    {keyword}
                  </span>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
