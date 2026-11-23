import { Link, useParams } from 'react-router'
import { encodePaperId } from '../../api/client'
import { useClaim, useProjects } from '../../api/queries'
import { StatusChip } from '../../components/Badges'
import { ClaimCardDetails, ClaimChips } from '../../components/ClaimCard'
import { ClaimExplainDetails, ClaimLead, ExplainerFootnote, GenerateClaimExplainer, GlanceStrip, ResultTiles } from '../../components/Explainers'
import { BookIcon, SparkIcon } from '../../components/Icons'
import { Card, ErrorState, Loading, PaperLink } from '../../components/ui'

export default function ClaimDetailPage() {
  const id = Number(useParams().id)
  const projects = useProjects()
  const project = projects.data?.[0]
  const claim = useClaim(id, project?.id)

  if (claim.isLoading || projects.isLoading) return <Loading label="Loading claim…" />
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
  const explainer = data.explainer
  const paper = data.paper_explainer

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
        <div className="max-w-3xl">
          <ClaimLead claim={data} explainer={explainer} clamp={false} />
        </div>
        <div className="mt-3">
          <GlanceStrip claim={data} explainer={explainer} project={project} />
        </div>
        <div className="mt-3">
          <ClaimChips claim={data} />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card
            title={
              <span className="flex items-center gap-2">
                <SparkIcon className="text-done" /> Explanation
              </span>
            }
          >
            {explainer ? (
              <ClaimExplainDetails explainer={explainer} projectName={project?.name} />
            ) : (
              <div className="space-y-2 text-sm text-muted">
                <p>
                  No plain-language explanation yet. It is written for {project ? <strong className="text-fg">{project.name}</strong> : 'your project'} from the paper’s
                  text.
                </p>
                <GenerateClaimExplainer claimId={data.id} projectId={project?.id} />
              </div>
            )}
          </Card>
          <Card title="Claim card">
            <ClaimCardDetails claim={data} />
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          {paper && (
            <Card
              title={
                <span className="flex items-center gap-2">
                  <BookIcon className="text-muted" /> About the paper
                </span>
              }
              actions={
                <Link to={`/research/papers/${encodePaperId(data.paper_id)}`} className="text-xs">
                  Paper page
                </Link>
              }
            >
              {paper.tldr && <p className="text-sm text-fg">{paper.tldr}</p>}
              {!!paper.key_results?.length && (
                <div className="mt-3">
                  <ResultTiles results={paper.key_results} max={4} />
                </div>
              )}
              <div className="mt-3">
                <ExplainerFootnote explainer={paper} />
              </div>
            </Card>
          )}
          <Card title="Experiments">
            {data.experiments.length === 0 ? (
              <p className="text-sm text-muted">
                Not tested yet. Pick it on the <Link to={`/recommendations?q=${encodeURIComponent(data.name)}&blocked=1`}>Recommendations</Link> page to start an
                experiment.
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
