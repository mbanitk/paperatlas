import { Link, useNavigate, useParams } from 'react-router'
import { encodePaperId } from '../../api/client'
import { useClaim, useExperiment, useExperiments, usePaper, useProjects } from '../../api/queries'
import type { ClaimDetail, Experiment, Project } from '../../api/types'
import { Delta, OutcomeBadge, StatusChip } from '../../components/Badges'
import { ClaimCardDetails } from '../../components/ClaimCard'
import { ExplainerFootnote, GenerateClaimExplainer, ResultTiles } from '../../components/Explainers'
import { ClaimExplain, ClaimFacts, claimSentence, ExpectedHere, PaperReports } from '../../components/ClaimStory'
import { ArrowRightIcon, BookIcon, SparkIcon } from '../../components/Icons'
import { ConceptMapGraph } from '../../components/ConceptMap'
import { RelatedCard } from '../../components/Related'
import { AnswerBlock, Card, Disclosure, ErrorState, Loading, MathText, PageHeader, PaperLink } from '../../components/ui'
import { expectedMetricLabel, experimentVerb } from '../../lib/claims'
import { formatCI, formatSigned, humanize, sanitizeText } from '../../lib/format'
import { adoptionSemantics, claimCheckSemantics, gainSemantics, sentenceCase } from '../../lib/semantics'

const latestOf = (claim: ClaimDetail) => (claim.experiments.length ? claim.experiments.reduce((a, b) => (b.id > a.id ? b : a)) : null)

/** "Tested in #9 · Needs your decision" or "Not tested yet · Find it at Gate 1 →". The outcome itself is in the answer row. */
function StatusLine({ claim }: { claim: ClaimDetail }) {
  const ref = latestOf(claim)
  if (!ref)
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg">
        <strong className="font-semibold">Not tested yet</strong>
        <span aria-hidden="true">·</span>
        <Link to={`/recommendations?q=${encodeURIComponent(claim.name)}&blocked=1`} className="inline-flex items-center gap-1 font-medium">
          Find it at Gate 1 <ArrowRightIcon size={14} />
        </Link>
      </span>
    )
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg">
      <strong className="font-semibold">
        {experimentVerb(ref.status)}{' '}
        <Link to={`/experiments/${ref.id}`} className="font-semibold">
          #{ref.id}
        </Link>
      </strong>
      <StatusChip status={ref.status} />
      <Link to={`/experiments/${ref.id}`} className="inline-flex items-center gap-1 text-sm font-medium">
        Open experiment <ArrowRightIcon size={14} />
      </Link>
      {claim.experiments.length > 1 && <span className="text-muted">· {claim.experiments.length} experiments in all</span>}
    </span>
  )
}

/** "better" / "worse" / "no clear change": significance from the 95% CI when it's known. */
function gainWord(delta: number | null | undefined, low?: number | null, high?: number | null): string {
  const significant = typeof low === 'number' && typeof high === 'number' ? low > 0 || high < 0 : undefined
  return gainSemantics(delta, { significant }).label
}

/** The answer row: measured results when the claim was judged here, else what's expected, next to the paper's number. */
function Answer({ claim, latest, project }: { claim: ClaimDetail; latest: Experiment | undefined; project?: Project }) {
  const explainer = claim.explainer
  const verdict = latest?.verdict_detail
  const adoption = verdict?.details?.adoption
  const prediction = latest?.spec?.prediction
  const metric = verdict ? expectedMetricLabel(verdict.primary_metric) : ''
  const measured = verdict && typeof verdict.median_delta_pct === 'number'
  return (
    <div className="grid items-start gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {measured && (
        <AnswerBlock
          register="measured"
          size="md"
          tone={claimCheckSemantics(verdict.verdict).tone}
          label={`Claim check · #${latest!.id}`}
          value={formatSigned(verdict.median_delta_pct)}
          unit={[gainWord(verdict.median_delta_pct, verdict.ci_low_pct, verdict.ci_high_pct), metric].filter(Boolean).join(' · ')}
          badge={<OutcomeBadge kind="verdict" value={verdict.verdict} explain />}
          confidence={
            typeof verdict.ci_low_pct === 'number' && typeof verdict.ci_high_pct === 'number'
              ? `95% CI ${formatCI(verdict.ci_low_pct, verdict.ci_high_pct)} · on the paper’s setup`
              : 'On the paper’s setup'
          }
        />
      )}
      {measured && adoption?.verdict && (
        <AnswerBlock
          register="measured"
          size="md"
          tone={adoptionSemantics(adoption.verdict).tone}
          label={`Adoption check · #${latest!.id}`}
          value={formatSigned(adoption.median_delta_pct)}
          unit={gainWord(adoption.median_delta_pct, adoption.ci_low_pct, adoption.ci_high_pct)}
          badge={<OutcomeBadge kind="adoption" value={adoption.verdict} explain />}
          confidence={
            typeof adoption.ci_low_pct === 'number' && typeof adoption.ci_high_pct === 'number'
              ? `95% CI ${formatCI(adoption.ci_low_pct, adoption.ci_high_pct)} · on your default workload`
              : 'On your default workload'
          }
        />
      )}
      {!measured && prediction !== undefined && <ExpectedHere prediction={prediction} project={project} long />}
      <PaperReports claim={claim} explainer={explainer} showLossless={false} />
    </div>
  )
}

export default function ClaimDetailPage() {
  const id = Number(useParams().id)
  const projects = useProjects()
  const project = projects.data?.[0]
  const claim = useClaim(id, project?.id)
  const navigate = useNavigate()
  const paperDetail = usePaper(claim.data?.related?.has_map ? claim.data.paper_id : '')
  const latestRef = claim.data ? latestOf(claim.data) : null
  const latest = useExperiment(latestRef?.id ?? 0)
  const summaries = useExperiments({ project_id: latestRef?.project_id ?? project?.id })
  const summaryOf = (experimentId: number) => summaries.data?.find((item) => item.id === experimentId)

  if (claim.isLoading || projects.isLoading) return <Loading label="Loading claim…" />
  if (claim.isError || !claim.data)
    return (
      <div className="space-y-3">
        <Link to="/research/claims" className="text-sm">
          Back to claim cards
        </Link>
        <ErrorState error={claim.error ?? new Error('Claim not found')} onRetry={() => claim.refetch()} />
      </div>
    )
  const data = claim.data
  const explainer = data.explainer
  const paper = data.paper_explainer
  const experimentProject = latest.data?.project ? projects.data?.find((item) => item.id === latest.data!.project.id) : project

  return (
    <div className="space-y-6">
      <div>
        <PageHeader
          level="object"
          breadcrumb={[
            { label: 'Research', to: '/research/topics' },
            { label: 'Claim cards', to: '/research/claims' },
            { label: `#${data.id}` },
          ]}
          eyebrow={
            <span className="flex flex-wrap items-center gap-x-1.5">
              {sentenceCase(humanize(data.kind ?? 'concept'))} from <PaperLink paperId={data.paper_id} title={sanitizeText(data.paper_title ?? data.paper_id)} className="text-muted hover:text-accent" />
              {data.paper_date && <span>· {data.paper_date.slice(0, 7)}</span>}
            </span>
          }
          title={<MathText>{data.name}</MathText>}
          answer={claimSentence(data, explainer)}
          description={<StatusLine claim={data} />}
        />
        <div className="-mt-2 space-y-3">
          <Answer claim={data} latest={latest.data} project={experimentProject} />
          <ClaimFacts claim={data} explainer={explainer} max={8} />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card
            title={
              <span className="flex items-center gap-2">
                <SparkIcon className="text-muted" /> Explanation
              </span>
            }
          >
            {explainer ? (
              <ClaimExplain claim={data} explainer={explainer} project={project} diagramOpen={false} />
            ) : (
              <div className="space-y-2 text-sm text-muted">
                <p>
                  No plain-language explanation yet. It’s written for {project ? <strong className="text-fg">{project.name}</strong> : 'your project'} from the
                  paper’s text.
                </p>
                <GenerateClaimExplainer claimId={data.id} projectId={project?.id} />
              </div>
            )}
          </Card>
          <RelatedCard related={data.related} claimId={data.id} paperId={data.paper_id} paperTitle={data.paper_title} />
          {paperDetail.data?.concept_map?.generated && (
            <Card title="Where it sits in the paper">
              <p className="text-sm text-muted">
                A map of how the paper’s {paperDetail.data.concept_map.nodes.length} concepts depend on each other. This concept has a dashed ring.
              </p>
              <Disclosure label="Show the concept map" className="mt-2">
                <ConceptMapGraph
                  map={paperDetail.data.concept_map}
                  currentConceptId={paperDetail.data.concept_map.nodes.find((node) => node.claim_id === data.id)?.concept_id}
                  showBundles={false}
                  onSelect={(node) => node.claim_id && node.claim_id !== data.id && navigate(`/research/claims/${node.claim_id}`)}
                />
              </Disclosure>
            </Card>
          )}
          <Card title="Claim card (raw)">
            <ClaimCardDetails claim={data} />
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          <Card title="Experiments">
            {data.experiments.length === 0 ? (
              <p className="text-sm text-muted">
                Not tested yet. Pick it on the <Link to={`/recommendations?q=${encodeURIComponent(data.name)}&blocked=1`}>Recommendations</Link> page to start an
                experiment.
              </p>
            ) : (
              <ul className="divide-y divide-line-muted text-sm">
                {[...data.experiments]
                  .sort((a, b) => b.id - a.id)
                  .map((experiment) => {
                    const summary = summaryOf(experiment.id)
                    const verdict = summary?.verdict ?? (experiment.id === latest.data?.id ? latest.data.verdict_detail?.verdict : undefined)
                    const delta = summary?.median_delta_pct ?? (experiment.id === latest.data?.id ? latest.data.verdict_detail?.median_delta_pct : undefined)
                    return (
                      <li key={experiment.id} className="py-2 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Link to={`/experiments/${experiment.id}`} className="font-medium">
                            Experiment #{experiment.id}
                          </Link>
                          <StatusChip status={experiment.status} />
                        </div>
                        {verdict ? (
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-xs text-muted">Claim check</span>
                            <OutcomeBadge kind="verdict" value={verdict} />
                            <Delta value={delta} />
                          </div>
                        ) : (
                          (summary || experiment.id === latest.data?.id) && <p className="mt-1 text-xs text-muted">No verdict yet</p>
                        )}
                      </li>
                    )
                  })}
              </ul>
            )}
          </Card>
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
              {paper.tldr && <p className="text-sm text-fg">{sanitizeText(paper.tldr)}</p>}
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
          {data.group && (
            <Card title={`Similar claims · ${sanitizeText(data.group.label)}`}>
              <p className="mb-2 text-xs text-muted">The same idea in other papers ({data.group.size} in the group).</p>
              <ul className="space-y-1.5 text-sm">
                {data.group.other_claims.map((other) => (
                  <li key={other.claim_id}>
                    <Link to={`/research/claims/${other.claim_id}`}>Claim #{other.claim_id}</Link>
                    <span className="text-muted"> · {sanitizeText(other.paper_title)}</span>
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
