import { Link, useParams } from 'react-router'
import { usePaper } from '../../api/queries'
import type { Author } from '../../api/types'
import { CategoryChip, DocTypeChip } from '../../components/Badges'
import { ClaimChips, ClaimedEffect } from '../../components/ClaimCard'
import { BookIcon } from '../../components/Icons'
import { Card, Chip, DefinitionList, EmptyState, ErrorState, ExternalLink, Loading, RelativeTime } from '../../components/ui'
import { formatDate, pluralize } from '../../lib/format'

export default function PaperDetailPage() {
  const paperId = useParams()['*'] ?? ''
  const paper = usePaper(paperId)

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
  const authors = data.authors.map((author) => (typeof author === 'string' ? author : (author as Author).name)).filter(Boolean)

  return (
    <div className="space-y-6">
      <div>
        <Link to="/research/papers" className="text-sm">
          ← Papers
        </Link>
        <h2 className="mt-2 text-xl leading-snug font-semibold">{data.title}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <DocTypeChip docType={data.doc_type} />
          {authors.length > 0 && <span>{authors.slice(0, 6).join(', ')}{authors.length > 6 && ' et al.'}</span>}
          <span>· {data.venue ?? 'unknown venue'}</span>
          <span>· {formatDate(data.publication_date)}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-sm">
          {data.url && <ExternalLink href={data.url}>{data.doc_type === 'patent' ? 'Patent page' : 'Paper page'}</ExternalLink>}
          {data.pdf_url && <ExternalLink href={data.pdf_url}>PDF</ExternalLink>}
          {data.code_url && <ExternalLink href={data.code_url}>Code</ExternalLink>}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Abstract">
            <p className="text-sm leading-relaxed whitespace-pre-line">{data.abstract || 'No abstract available.'}</p>
          </Card>
          <Card title={`Claim cards (${data.claims.length})`} bodyClassName="p-0">
            {data.claims.length === 0 ? (
              <EmptyState title={data.distilled_at ? 'No claims extracted' : 'Not distilled yet'} icon={<BookIcon size={28} />}>
                {data.distilled_at ? 'The distiller found no technical claims in this document.' : 'Run “Distill pending” on the Papers page or a research scan.'}
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line-muted">
                {data.claims.map((claim) => (
                  <li key={claim.id} className="px-4 py-3">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                      <div className="min-w-0">
                        <Link to={`/research/claims/${claim.id}`} className="font-semibold text-fg hover:text-accent">
                          {claim.name}
                        </Link>
                        <p className="mt-0.5 text-sm text-muted">{claim.technique}</p>
                      </div>
                      <div className="shrink-0 text-sm sm:text-right">
                        <ClaimedEffect claim={claim} />
                      </div>
                    </div>
                    <div className="mt-2">
                      <ClaimChips claim={claim} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-6">
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
                    <Link to={`/research/papers?topic=${topic.slug}`}>{topic.name}</Link>
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
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
