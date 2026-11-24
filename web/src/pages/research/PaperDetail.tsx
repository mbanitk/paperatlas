import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { usePaper, useProjects } from '../../api/queries'
import type { Author, ConceptNode } from '../../api/types'
import { CategoryChip, DocTypeChip } from '../../components/Badges'
import { ClaimChips, ClaimedEffect } from '../../components/ClaimCard'
import { ClaimDiagram, ClaimLead, ExplainerFootnote, GeneratePaperExplainer, NumberedSteps, ResultTiles } from '../../components/Explainers'
import { ConceptMapCard } from '../../components/ConceptMap'
import { FlowDiagram } from '../../components/FlowDiagram'
import { RelatedStrip } from '../../components/Related'
import { AlertIcon, BookIcon, SparkIcon } from '../../components/Icons'
import { Card, Chip, cx, DefinitionList, EmptyState, ErrorState, ExternalLink, Loading, RelativeTime } from '../../components/ui'
import { formatDate, pluralize } from '../../lib/format'

export default function PaperDetailPage() {
  const paperId = useParams()['*'] ?? ''
  const paper = usePaper(paperId)
  const projects = useProjects()
  const location = useLocation()
  const [flash, setFlash] = useState<number | null>(null)
  const loaded = !!paper.data

  useEffect(() => {
    if (!loaded || !location.hash) return
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)))
    target?.scrollIntoView({ block: 'start' })
  }, [loaded, location.hash])

  useEffect(() => {
    if (flash == null) return
    const timer = window.setTimeout(() => setFlash(null), 1800)
    return () => window.clearTimeout(timer)
  }, [flash])

  const claims = useMemo(
    () =>
      [...(paper.data?.claims ?? [])].sort(
        (a, b) => (a.related?.order ?? Number.MAX_SAFE_INTEGER) - (b.related?.order ?? Number.MAX_SAFE_INTEGER) || a.id - b.id,
      ),
    [paper.data],
  )
  const jumpToClaim = (node: ConceptNode) => {
    if (!node.claim_id) return
    document.getElementById(`claim-${node.claim_id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlash(node.claim_id)
  }

  if (paper.isLoading) return <Loading label="Loading paper…" />
  if (paper.isError || !paper.data)
    return (
      <div className="space-y-3">
        <Link to="/research/papers" className="text-sm">
          ← Papers
        </Link>
        <ErrorState error={paper.error} onRetry={() => paper.refetch()} />
      </div>
    )
  const data = paper.data
  const explainer = data.explainer
  const authors = data.authors.map((author) => (typeof author === 'string' ? author : (author as Author).name)).filter(Boolean)
  const projectId = projects.data?.[0]?.id

  return (
    <div className="space-y-6">
      <div>
        <Link to="/research/papers" className="text-sm">
          ← Papers
        </Link>
        <h2 className="mt-2 text-xl leading-snug font-semibold">{data.title}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <DocTypeChip docType={data.doc_type} />
          {authors.length > 0 && (
            <span>
              {authors.slice(0, 6).join(', ')}
              {authors.length > 6 && ' et al.'}
            </span>
          )}
          <span>· {data.venue ?? 'unknown venue'}</span>
          <span>· {formatDate(data.publication_date)}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-sm">
          {data.url && <ExternalLink href={data.url}>{data.doc_type === 'patent' ? 'Patent page' : 'Paper page'}</ExternalLink>}
          {data.pdf_url && <ExternalLink href={data.pdf_url}>PDF</ExternalLink>}
          {data.code_url && <ExternalLink href={data.code_url}>Code</ExternalLink>}
        </div>
        {explainer?.tldr && (
          <p className="mt-3 max-w-3xl rounded-md border border-done/20 bg-done-subtle/50 px-3 py-2 text-[15px] leading-snug text-fg">
            <span className="mr-1.5 rounded bg-done px-1.5 py-px text-[10.5px] font-semibold text-white">TL;DR</span>
            {explainer.tldr}
          </p>
        )}
      </div>

      <ConceptMapCard paperId={data.paper_id} map={data.concept_map} onSelect={jumpToClaim} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {explainer ? (
            <Card
              title={
                <span className="flex items-center gap-2">
                  <SparkIcon className="text-done" /> In plain language
                </span>
              }
            >
              <div className="space-y-5 text-sm">
                {!!explainer.key_results?.length && <ResultTiles results={explainer.key_results} size="md" />}
                {explainer.problem && (
                  <section>
                    <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Problem</h3>
                    <p className="text-fg">{explainer.problem}</p>
                  </section>
                )}
                {!!explainer.approach?.length && (
                  <section>
                    <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Approach</h3>
                    <NumberedSteps steps={explainer.approach} />
                  </section>
                )}
                {explainer.diagram?.nodes?.length ? (
                  <div className="overflow-x-auto rounded-md border border-line-muted px-3 py-3">
                    <div className="min-w-[420px]">
                      <FlowDiagram diagram={explainer.diagram} />
                    </div>
                  </div>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2">
                  {explainer.novelty && (
                    <section className="rounded-md border border-accent/30 bg-accent-subtle/40 px-3 py-2">
                      <h3 className="mb-0.5 text-xs font-semibold tracking-wide text-accent uppercase">What is new</h3>
                      <p className="text-fg">{explainer.novelty}</p>
                    </section>
                  )}
                  {explainer.who_should_care && (
                    <section className="rounded-md border border-success/25 bg-success-subtle/50 px-3 py-2">
                      <h3 className="mb-0.5 text-xs font-semibold tracking-wide text-success uppercase">Who should care</h3>
                      <p className="text-fg">{explainer.who_should_care}</p>
                    </section>
                  )}
                </div>
                {!!explainer.limitations?.length && (
                  <section>
                    <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Limitations</h3>
                    <ul className="space-y-1">
                      {explainer.limitations.map((limitation) => (
                        <li key={limitation} className="flex gap-2 text-fg">
                          <AlertIcon size={14} className="mt-0.5 shrink-0 text-attention" />
                          {limitation}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <ExplainerFootnote explainer={explainer} />
              </div>
            </Card>
          ) : (
            <Card title="In plain language">
              <div className="space-y-2 text-sm text-muted">
                <p>No plain-language summary yet{data.distilled_at ? '' : ' — the paper has not been distilled'}.</p>
                <GeneratePaperExplainer paperId={data.paper_id} />
              </div>
            </Card>
          )}

          <Card
            title={`Claim cards (${data.claims.length})`}
            actions={data.concept_map?.generated ? <span className="text-xs text-muted">in reading order</span> : undefined}
            bodyClassName="p-0"
          >
            {data.claims.length === 0 ? (
              <EmptyState title={data.distilled_at ? 'No claims extracted' : 'Not distilled yet'} icon={<BookIcon size={28} />}>
                {data.distilled_at ? 'The distiller found no technical claims in this document.' : 'Run “Distill pending” on the Papers page or a research scan.'}
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line-muted">
                {claims.map((claim) => (
                  <li
                    key={claim.id}
                    id={`claim-${claim.id}`}
                    className={cx('scroll-mt-20 px-4 py-3 transition-colors duration-700', flash === claim.id && 'bg-accent-subtle')}
                  >
                    <div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <Link to={`/research/claims/${claim.id}`} className="font-semibold text-fg hover:text-accent">
                            {claim.related?.has_map && claim.related.order != null && (
                              <span className="mr-1.5 text-muted tabular-nums">{claim.related.order}.</span>
                            )}
                            {claim.name}
                          </Link>
                          <span className="text-sm">
                            <ClaimedEffect claim={claim} />
                          </span>
                        </div>
                        <ClaimLead claim={claim} explainer={claim.explainer} />
                        <ClaimDiagram diagram={claim.explainer?.diagram} className="mt-3" />
                        <RelatedStrip related={claim.related} claimId={claim.id} paperId={data.paper_id} showPosition={false} className="mt-2" />
                        <div className="mt-2">
                          <ClaimChips claim={claim} />
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {data.abstract && (
            <details className="card group">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold select-none">Abstract</summary>
              <p className="border-t border-line-muted px-4 py-3 text-sm leading-relaxed whitespace-pre-line">{data.abstract}</p>
            </details>
          )}
        </div>
        <div className="min-w-0 space-y-6">
          <Card title="Details">
            <DefinitionList
              items={[
                ['ID', <code key="id" className="text-xs break-all">{data.paper_id}</code>],
                ['Sources', data.sources.join(', ') || '—'],
                ['Citations', data.citation_count ?? '—'],
                ['HF upvotes', data.hf_upvotes ?? '—'],
                ['Full text', data.has_full_text ? 'parsed' : 'abstract only'],
                ['Distilled', data.distilled_at ? <RelativeTime key="d" iso={data.distilled_at} /> : 'not yet'],
              ]}
            />
          </Card>
          <Card title="Topics">
            {data.topics.length === 0 ? (
              <p className="text-sm text-muted">Not linked to a current topic.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.topics.map((topic) => (
                  <li key={topic.slug} className="flex items-center justify-between gap-2">
                    <Link to={`/research/topics/${topic.slug}`}>{topic.name}</Link>
                    {topic.rank && <Chip tone="neutral">#{topic.rank} in topic</Chip>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {data.claims.length > 0 && (
            <Card title="Categories">
              <div className="flex flex-wrap gap-1.5">
                {[...new Set(data.claims.map((claim) => claim.category).filter(Boolean))].map((category) => (
                  <CategoryChip key={category} category={category} />
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">{pluralize(data.claims.filter((claim) => claim.testable).length, 'testable claim')}</p>
              {projectId && <p className="mt-1 text-xs text-muted">Claim explanations are written for your project on the Recommendations page.</p>}
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
