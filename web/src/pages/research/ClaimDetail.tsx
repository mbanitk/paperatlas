import { Link, useParams } from 'react-router'
import { useClaim } from '../../api/queries'
import { StatusChip } from '../../components/Badges'
import { ClaimCardDetails, ClaimChips, ClaimedEffect } from '../../components/ClaimCard'
import { Card, ErrorState, Loading, PaperLink } from '../../components/ui'

export default function ClaimDetailPage() {
  const id = Number(useParams().id)
  const claim = useClaim(id)

  if (claim.isLoading) return <Loading label="Loading claim…" />
  if (claim.isError || !claim.data)
    return (
      <div className="space-y-3">
        <Link to="/research/claims" className="text-sm">
          ← Claim cards
        </Link>
        <ErrorState error={claim.error ?? new Error('Claim not found')} onRetry={() => claim.refetch()} />
      </div>
    )
  const data = claim.data

  return (
    <div className="space-y-6">
      <div>
        <Link to="/research/claims" className="text-sm">
          ← Claim cards
        </Link>
        <h2 className="mt-2 text-xl leading-snug font-semibold">{data.name}</h2>
        <div className="mt-1 text-sm text-muted">
          from <PaperLink paperId={data.paper_id} title={data.paper_title ?? data.paper_id} /> · {data.kind ?? 'concept'} · claim #{data.id}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="text-base">
            <ClaimedEffect claim={data} />
          </span>
          <ClaimChips claim={data} />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Claim card" className="lg:col-span-2">
          <ClaimCardDetails claim={data} />
        </Card>
        <div className="space-y-6">
          <Card title="Experiments">
            {data.experiments.length === 0 ? (
              <p className="text-sm text-muted">
                Not tested yet. Pick it on the <Link to={`/recommendations?q=${encodeURIComponent(data.name)}&blocked=1`}>Recommendations</Link> page to start an experiment.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.experiments.map((experiment) => (
                  <li key={experiment.id} className="flex items-center justify-between gap-2">
                    <Link to={`/experiments/${experiment.id}`}>Experiment #{experiment.id}</Link>
                    <StatusChip status={experiment.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {data.group && (
            <Card title={`Similar claims · ${data.group.label}`}>
              <p className="mb-2 text-xs text-muted">Deduplicated across papers ({data.group.size} in group).</p>
              <ul className="space-y-1.5 text-sm">
                {data.group.other_claims.map((other) => (
                  <li key={other.claim_id}>
                    <Link to={`/research/claims/${other.claim_id}`}>Claim #{other.claim_id}</Link>
                    <span className="text-muted"> — {other.paper_title}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
