import { useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { encodePaperId } from '../../api/client'
import { useClaims, useExperiments, useExplainTopic, useProjects, useRecommendations, useTopic } from '../../api/queries'
import type { Topic } from '../../api/types'
import { Meter } from '../../components/Charts'
import { ConfirmDialog } from '../../components/Dialog'
import { ExplainerFootnote } from '../../components/Explainers'
import { AlertIcon, PaperIcon, SparkIcon } from '../../components/Icons'
import { CategoryBars, ClaimRow, KpiRow, SourceMix, SparkBars, topicName, useTopicNames } from '../../components/Insights'
import { useToast } from '../../components/Toast'
import { Button, Card, Chip, Disclosure, EmptyState, ErrorState, MathText, PageHeader, RelativeTime, Skeleton, errorMessage } from '../../components/ui'
import { formatNumber, pluralize } from '../../lib/format'
import { bestClaims, experimentsByClaim, momentumText, monthlyMomentum, testableClaims, topicSummary, trendReasons } from '../../lib/research'

const TREND_STATS: [string, string, (v: number) => string][] = [
  ['recency', 'Recency', (v) => formatNumber(v, 2)],
  ['velocity', 'Papers from the last 60 days', (v) => `${Math.round(v * 100)}%`],
  ['citations', 'Citation signal', (v) => formatNumber(v, 2)],
  ['upvotes', 'Upvote signal', (v) => formatNumber(v, 2)],
  ['code', 'With code', (v) => `${Math.round(v * 100)}%`],
]

const BREADCRUMB_ROOT = [
  { label: 'Research', to: '/research' },
  { label: 'Topics', to: '/research/topics' },
]

/** One plain sentence when there's no written overview: activity and how much of it is testable. */
function generatedAnswer(topic: Topic): string | null {
  const insights = topic.insights
  if (!insights) return null
  const momentum = momentumText(monthlyMomentum(insights.monthly))
  const claims = testableClaims(insights)
  const parts = [momentum ? `${momentum.charAt(0).toUpperCase()}${momentum.slice(1)}, ${formatNumber(insights.papers, 0)} in total.` : `${pluralize(insights.papers, 'paper')} in total.`]
  if (claims.claims) parts.push(`${formatNumber(claims.testable, 0)} of ${pluralize(claims.claims, 'claim card')} can be tested on an inference engine.`)
  return parts.join(' ')
}

function WriteOverview({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false)
  const explain = useExplainTopic()
  const toast = useToast()
  return (
    <>
      <Button size="sm" variant="outline" icon={<SparkIcon size={14} />} loading={explain.isPending} onClick={() => setOpen(true)}>
        {explain.isPending ? 'Writing overview… (~15 s)' : 'Write a plain-language overview…'}
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Write an overview of this topic?"
        confirmLabel="Write overview"
        loading={explain.isPending}
        error={explain.error}
        cost="Asks the LLM to read this topic’s top papers · about 15 seconds"
        onConfirm={() =>
          explain.mutate(slug, {
            onSuccess: () => {
              setOpen(false)
              toast.success('Topic overview ready')
            },
            onError: (error) => toast.error(errorMessage(error)),
          })
        }
      >
        <p className="text-muted">Adds a summary, why it matters now, the key ideas, typical gains and open problems. It replaces any earlier overview.</p>
      </ConfirmDialog>
    </>
  )
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <h3 className="mb-1.5 text-sm font-semibold text-fg">{title}</h3>
      {children}
    </section>
  )
}

export default function TopicDetail() {
  const slug = useParams().slug ?? ''
  const topic = useTopic(slug)
  const names = useTopicNames()
  const projects = useProjects()
  const project = projects.data?.[0]
  const claims = useClaims({ topic: slug, testable: true, limit: 50 })
  const recs = useRecommendations(project?.id, { limit: 60 })
  const experiments = useExperiments({})
  const byClaim = useMemo(() => experimentsByClaim(experiments.data), [experiments.data])
  const recsSettled = !project || !recs.isLoading
  const best = useMemo(() => (recsSettled ? bestClaims(claims.data?.items, recs.data, 3) : []), [claims.data, recs.data, recsSettled])

  if (topic.isLoading)
    return (
      <div className="space-y-6">
        <PageHeader level="object" breadcrumb={BREADCRUMB_ROOT} title={<span role="status" aria-label="Loading topic" className="inline-block h-6 w-64 max-w-full animate-pulse rounded bg-canvas-inset align-middle" />} />
        <Skeleton variant="card" count={2} />
      </div>
    )
  if (topic.isError || !topic.data)
    return (
      <div className="space-y-6">
        <PageHeader level="object" breadcrumb={BREADCRUMB_ROOT} title="Topic" />
        <ErrorState title="We couldn’t load this topic" error={topic.error ?? new Error('Topic not found')} onRetry={() => topic.refetch()} />
      </div>
    )

  const data = topic.data
  const name = topicName(data, names)
  const explainer = data.explainer
  const insights = data.insights
  const stats = data.stats ?? {}
  const summary = topicSummary(data)
  const generated = generatedAnswer(data)
  const reasons = trendReasons(data)
  const testable = testableClaims(insights)
  const chip = project?.hardware && typeof project.hardware.chip === 'string' ? project.hardware.chip : null
  const relevanceTitle = project ? `Relevance for ${project.name}${chip ? ` (${chip})` : ''}` : 'Relevance for your project'

  return (
    <div className="space-y-6">
      <PageHeader
        level="object"
        breadcrumb={[...BREADCRUMB_ROOT, { label: name }]}
        eyebrow={
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {data.rank != null && <span className="font-semibold text-fg">#{data.rank} trending</span>}
            {data.seed && data.seed.toLowerCase() !== name.toLowerCase() && (
              <>
                <span aria-hidden="true">·</span>
                <span>{data.seed}</span>
              </>
            )}
            {data.needs_gpu_cluster && (
              <Chip tone="caution" title="Topics in this seed area usually need a multi-GPU cluster to test.">
                <AlertIcon size={12} className="shrink-0" /> Needs GPU cluster
              </Chip>
            )}
            {data.status !== 'active' && <Chip tone="neutral">{data.status}</Chip>}
          </span>
        }
        title={name}
        answer={summary ?? generated ?? undefined}
        description={summary && generated ? generated : undefined}
        actions={
          <div className="flex flex-wrap gap-2 sm:flex-nowrap">
            <Link to={`/research/papers?topic=${data.slug}`} className="inline-flex h-8 items-center rounded-md border border-line bg-canvas-subtle px-3 text-sm font-medium whitespace-nowrap text-fg hover:bg-canvas-inset hover:no-underline">
              Papers{insights ? ` (${formatNumber(insights.papers, 0)})` : ''}
            </Link>
            {testable.testable > 0 && (
              <Link
                to={`/research/claims?topic=${data.slug}&testable=true`}
                className="inline-flex h-8 items-center rounded-md border border-line bg-canvas-subtle px-3 text-sm font-medium whitespace-nowrap text-fg hover:bg-canvas-inset hover:no-underline"
              >
                Claims to test ({formatNumber(testable.testable, 0)})
              </Link>
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card title="Why it’s trending">
            <div className="space-y-4 text-sm">
              {explainer?.why_now && <p className="text-body text-fg">{explainer.why_now}</p>}
              {reasons.length > 0 && (
                <p className={explainer?.why_now ? 'text-muted' : 'text-fg'}>
                  {data.rank != null ? `Ranked #${data.rank}` : 'Ranked'} because {reasons.slice(0, -1).join(', ')}
                  {reasons.length > 1 ? ' and ' : ''}
                  {reasons[reasons.length - 1]}.
                </p>
              )}
              {insights?.monthly?.length ? (
                <div>
                  <h3 className="mb-2 text-xs font-medium text-muted">Papers per month</h3>
                  <SparkBars data={insights.monthly} size="md" />
                </div>
              ) : null}
            </div>
          </Card>

          <Card
            title="Best claims to test"
            actions={
              testable.testable > 0 ? (
                <Link to={`/research/claims?topic=${data.slug}&testable=true`} className="inline-flex min-h-6 items-center text-sm">
                  All {formatNumber(testable.testable, 0)} testable claims →
                </Link>
              ) : undefined
            }
            bodyClassName="p-0"
          >
            {claims.isLoading || !recsSettled ? (
              <div className="p-4">
                <Skeleton variant="row" count={3} />
              </div>
            ) : claims.isError ? (
              <div className="p-4">
                <ErrorState title="We couldn’t load the claims" error={claims.error} onRetry={() => claims.refetch()} />
              </div>
            ) : best.length === 0 ? (
              <EmptyState title="No testable claims yet">Claim cards appear here once this topic’s papers are summarised.</EmptyState>
            ) : (
              <>
                <p className="border-b border-line-muted px-3 py-2 text-xs text-muted sm:px-4">
                  {best.some((claim) => claim.recommendation)
                    ? `In the order ${project?.name ?? 'your project'} would test them, at most one per paper.`
                    : 'Techniques with a reported gain that need no special hardware come first, at most one per paper.'}
                </p>
                <ul className="divide-y divide-line-muted">
                  {best.map((claim) => (
                    <ClaimRow
                      key={claim.id}
                      claim={claim}
                      prediction={claim.recommendation?.prediction}
                      experiments={byClaim.get(claim.id)}
                      eyebrow={
                        <span className="inline-flex min-w-0 items-start gap-1">
                          <PaperIcon size={12} className="mt-1.5 shrink-0" />
                          <Link to={`/research/papers/${encodePaperId(claim.paper_id)}`} className="min-h-6 min-w-0 py-1 text-muted hover:text-accent">
                            <MathText>{claim.paper_title ?? claim.paper_id}</MathText>
                          </Link>
                        </span>
                      }
                    />
                  ))}
                </ul>
              </>
            )}
          </Card>

          <Card
            title={
              <span className="flex items-center gap-2">
                <SparkIcon className="text-muted" /> Overview
              </span>
            }
          >
            {!explainer ? (
              <div className="space-y-3 text-sm">
                <p className="text-muted">No plain-language overview yet. It explains the key ideas, typical gains and open problems in this topic.</p>
                <WriteOverview slug={data.slug} />
              </div>
            ) : (
              <div className="space-y-5 text-sm">
                {!!explainer.key_ideas?.length && (
                  <Section title="Key ideas">
                    <ol className="grid gap-2 sm:grid-cols-2">
                      {explainer.key_ideas.map((idea, index) => (
                        <li key={idea.name} className="rounded-lg border border-line-muted px-3 py-2">
                          <div className="flex items-start gap-2 font-semibold text-fg">
                            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-neutral-subtle text-xs text-muted tabular-nums">{index + 1}</span>
                            <span className="min-w-0">{idea.name}</span>
                          </div>
                          <p className="mt-1 text-muted">{idea.one_liner}</p>
                        </li>
                      ))}
                    </ol>
                  </Section>
                )}
                {explainer.typical_gains && (
                  <section className="rounded-lg border border-line bg-canvas-subtle px-3 py-2">
                    <h3 className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-muted">
                      <PaperIcon size={14} className="shrink-0" /> Typical gains the papers report
                    </h3>
                    <p className="text-fg">{explainer.typical_gains}</p>
                  </section>
                )}
                {explainer.relevance && (
                  <Section title={relevanceTitle}>
                    <p className="text-fg">{explainer.relevance}</p>
                  </Section>
                )}
                {!!explainer.open_problems?.length && (
                  <Section title="Open problems">
                    <ul className="list-disc space-y-1 pl-5 text-fg">
                      {explainer.open_problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  </Section>
                )}
                <ExplainerFootnote explainer={explainer} />
              </div>
            )}
          </Card>

          {insights && (
            <Card title="Top papers" actions={<Link to={`/research/papers?topic=${data.slug}`} className="inline-flex min-h-6 items-center text-sm">All papers →</Link>}>
              {insights.top_papers.length === 0 ? (
                <p className="text-sm text-muted">No ranked papers yet.</p>
              ) : (
                <ol className="space-y-2.5">
                  {insights.top_papers.map((paper, index) => (
                    <li key={paper.paper_id} className="flex items-start gap-3 text-sm">
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-neutral-subtle text-xs font-semibold text-muted tabular-nums">{paper.rank ?? index + 1}</span>
                      <Link to={`/research/papers/${encodePaperId(paper.paper_id)}`} className="min-h-6 min-w-0 pt-0.5 font-medium text-fg hover:text-accent">
                        {paper.title}
                      </Link>
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
              <Card title="At a glance">
                <KpiRow insights={insights} columns="two" />
              </Card>
              <Card title="Claim cards by category">
                <CategoryBars categories={insights.claim_categories} />
              </Card>
              <Card title="Where the papers come from">
                <SourceMix sources={insights.sources} />
              </Card>
            </>
          ) : (
            <Card title="At a glance">
              <EmptyState title="No numbers yet">They appear after the next topic refresh.</EmptyState>
            </Card>
          )}
          <Card title="How it’s ranked" actions={<span className="text-xs text-muted">Updated <RelativeTime iso={data.refreshed_at} /></span>}>
            <div className="mb-1 flex items-center justify-between gap-2 text-sm">
              <span className="text-muted">Trend score</span>
              <span className="font-semibold tabular-nums">{formatNumber(data.trend_score, 2)} of 1</span>
            </div>
            <Meter value={data.trend_score} label={`Trend score ${formatNumber(data.trend_score, 2)} of 1`} />
            <Disclosure label="Signals behind the score" className="mt-3">
              <dl className="grid gap-y-1.5 text-sm">
                {TREND_STATS.filter(([key]) => typeof stats[key] === 'number').map(([key, label, fmt]) => (
                  <div key={key} className="flex justify-between gap-3">
                    <dt className="text-muted">{label}</dt>
                    <dd className="font-semibold tabular-nums">{fmt(stats[key])}</dd>
                  </div>
                ))}
              </dl>
              {!!data.keywords?.length && (
                <div className="mt-3">
                  <div className="mb-1 text-xs font-medium text-muted">Key terms</div>
                  <div className="flex flex-wrap gap-1.5">
                    {data.keywords.map((keyword) => (
                      <span key={keyword} className="tag">
                        {keyword}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Disclosure>
          </Card>
        </div>
      </div>
    </div>
  )
}
