import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { useExperiments, useExplainPaper, useGenerateConceptMap, usePaper } from '../../api/queries'
import type { Author, ConceptMap, ConceptNode, PaperDetail } from '../../api/types'
import { CategoryChip, DocTypeChip, OutcomeBadge, StatusChip } from '../../components/Badges'
import { ConceptMapGraph } from '../../components/ConceptMap'
import { ConfirmDialog } from '../../components/Dialog'
import { ClaimDiagram, ExplainerFootnote, NumberedSteps } from '../../components/Explainers'
import { FlowDiagram } from '../../components/FlowDiagram'
import { AlertIcon, BookIcon, MoreIcon, SparkIcon } from '../../components/Icons'
import { ActionMenu, ClaimRow, KeyResults, topicName, useTopicNames } from '../../components/Insights'
import { RelatedStrip } from '../../components/Related'
import { useToast } from '../../components/Toast'
import { Tooltip } from '../../components/Tooltip'
import {
  Button,
  Card,
  Chip,
  cx,
  DefinitionList,
  Disclosure,
  EmptyState,
  ErrorState,
  ExternalLink,
  InlineError,
  MathText,
  PageHeader,
  RelativeTime,
  Skeleton,
  errorMessage,
} from '../../components/ui'
import { readingPathParts } from '../../lib/conceptMap'
import { formatDate, formatNumber, MISSING, pluralize, sanitizeText } from '../../lib/format'
import { experimentsByClaim, formatResultValue, paperShortLabel, sourceLabel } from '../../lib/research'

const BREADCRUMB_ROOT = [
  { label: 'Research', to: '/research' },
  { label: 'Papers & patents', to: '/research/papers' },
]

function Links({ data, className }: { data: PaperDetail; className?: string }) {
  if (!data.url && !data.pdf_url && !data.code_url) return null
  return (
    <div className={cx('flex flex-wrap items-center gap-x-4 gap-y-1 text-sm', className)}>
      {data.url && <ExternalLink href={data.url} className="inline-flex min-h-6 items-center">{data.doc_type === 'patent' ? 'Patent page' : data.paper_id.startsWith('blog:') ? 'Original post' : 'Paper page'}</ExternalLink>}
      {data.pdf_url && <ExternalLink href={data.pdf_url} className="inline-flex min-h-6 items-center">PDF</ExternalLink>}
      {data.code_url && <ExternalLink href={data.code_url} className="inline-flex min-h-6 items-center">Code</ExternalLink>}
    </div>
  )
}

/** Concept map with its reading path; mapping again (an LLM call that replaces the map) sits in a menu behind a confirm. */
function ConceptMapSection({ paperId, map, onSelect }: { paperId: string; map: ConceptMap | null | undefined; onSelect: (node: ConceptNode) => void }) {
  const generate = useGenerateConceptMap()
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)
  if (!map || map.nodes.length < 2) return null
  const run = () =>
    generate.mutate(paperId, {
      onSuccess: () => {
        setConfirm(false)
        toast.success('Concept map ready')
      },
      onError: (error) => toast.error(errorMessage(error)),
    })
  const parts = readingPathParts(map.reading_path, map.nodes)
  return (
    <Card
      id="concept-map"
      title="How the ideas connect"
      actions={
        map.generated ? (
          <ActionMenu
            label="Concept map actions"
            icon={generate.isPending ? undefined : <MoreIcon size={16} />}
            variant="invisible"
            size="sm"
            items={[{ label: 'Map the concepts again…', description: 'Replaces the current map · about 20 seconds', onSelect: () => setConfirm(true), disabled: generate.isPending }]}
          >
            {generate.isPending ? 'Mapping…' : undefined}
          </ActionMenu>
        ) : undefined
      }
    >
      {!map.generated ? (
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            Some of these concepts need others first, and some only reach the paper’s headline result together. Mapping them shows what to build first.
          </p>
          <Button size="sm" variant="outline" icon={<SparkIcon size={14} />} loading={generate.isPending} onClick={() => setConfirm(true)}>
            {generate.isPending ? 'Mapping concepts… (~20 s)' : 'Map how these concepts connect…'}
          </Button>
          {generate.error ? <InlineError error={generate.error} /> : null}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted">{pluralize(map.nodes.length, 'concept')}, numbered in the order the paper explains them. Select one to jump to its claim.</p>
          {parts.length > 0 && (
            <p className="flex gap-2 text-sm text-fg">
              <BookIcon size={16} className="mt-0.5 shrink-0 text-muted" />
              <span>
                <span className="font-medium">Reading path: </span>
                {parts.map((part, index) =>
                  typeof part === 'string' ? (
                    <span key={index}>{part}</span>
                  ) : (
                    <Tooltip key={index} content={part.node.name} className="inline-flex size-6 items-center justify-center rounded-full align-middle">
                      <span className="inline-flex size-5 items-center justify-center rounded-full bg-neutral-subtle text-xs font-semibold text-fg tabular-nums">
                        {part.order}
                      </span>
                    </Tooltip>
                  ),
                )}
              </span>
            </p>
          )}
          {generate.error ? <InlineError error={generate.error} /> : null}
          <ConceptMapGraph map={map} onSelect={onSelect} />
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={map.generated ? 'Map the concepts again?' : 'Map how these concepts connect?'}
        confirmLabel={map.generated ? 'Map again' : 'Map concepts'}
        loading={generate.isPending}
        error={generate.error}
        cost="Uses the LLM · about 20 seconds"
        onConfirm={run}
      >
        <p className="text-muted">
          {map.generated
            ? 'Asks the model to work out again which concepts need which, and replaces the current map and reading path.'
            : 'Asks the model which concepts need which, and which combine into the paper’s headline result.'}
        </p>
      </ConfirmDialog>
    </Card>
  )
}

function WriteSummary({ paperId }: { paperId: string }) {
  const [open, setOpen] = useState(false)
  const explain = useExplainPaper()
  const toast = useToast()
  return (
    <>
      <Button size="sm" variant="outline" icon={<SparkIcon size={14} />} loading={explain.isPending} onClick={() => setOpen(true)}>
        {explain.isPending ? 'Writing summary… (~15 s)' : 'Write a plain-language summary…'}
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Write a plain-language summary?"
        confirmLabel="Write summary"
        loading={explain.isPending}
        error={explain.error}
        cost="Uses the LLM · about 15 seconds"
        onConfirm={() =>
          explain.mutate(paperId, {
            onSuccess: () => {
              setOpen(false)
              toast.success('Paper summary ready')
            },
            onError: (error) => toast.error(errorMessage(error)),
          })
        }
      >
        <p className="text-muted">Adds a one-line summary, the key results, the approach step by step, what’s new and the limitations.</p>
      </ConfirmDialog>
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-sm font-semibold text-fg">{title}</h3>
      {children}
    </section>
  )
}

export default function PaperDetailPage() {
  const paperId = useParams()['*'] ?? ''
  const paper = usePaper(paperId)
  const names = useTopicNames()
  const experiments = useExperiments({})
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
  const byClaim = useMemo(() => experimentsByClaim(experiments.data), [experiments.data])
  const tested = useMemo(() => (experiments.data ?? []).filter((experiment) => experiment.paper_id === paper.data?.paper_id).sort((a, b) => b.id - a.id), [experiments.data, paper.data])

  const jumpToClaim = (node: ConceptNode) => {
    if (!node.claim_id) return
    document.getElementById(`claim-${node.claim_id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlash(node.claim_id)
  }

  if (paper.isLoading)
    return (
      <div className="space-y-6">
        <PageHeader
          level="object"
          breadcrumb={BREADCRUMB_ROOT}
          title={<span role="status" aria-label="Loading paper" className="inline-block h-6 w-80 max-w-full animate-pulse rounded bg-canvas-inset align-middle" />}
        />
        <Skeleton variant="card" count={2} />
      </div>
    )
  if (paper.isError || !paper.data)
    return (
      <div className="space-y-6">
        <PageHeader level="object" breadcrumb={BREADCRUMB_ROOT} title="Paper" />
        <ErrorState title="We couldn’t load this paper" error={paper.error ?? new Error('Paper not found')} onRetry={() => paper.refetch()} />
      </div>
    )

  const data = paper.data
  const explainer = data.explainer
  const results = explainer?.key_results ?? []
  const authors = data.authors.map((author) => (typeof author === 'string' ? author : (author as Author).name)).filter(Boolean)
  const authorLine = authors.length ? `${authors.slice(0, 6).join(', ')}${authors.length > 6 ? ' et al.' : ''}` : null
  const testableCount = data.claims.filter((claim) => claim.testable).length
  const categories = [...new Set(data.claims.map((claim) => claim.category).filter(Boolean))] as string[]

  return (
    <div className="space-y-6">
      <PageHeader
        level="object"
        breadcrumb={[...BREADCRUMB_ROOT, { label: paperShortLabel(data.paper_id, data.doc_type) }]}
        eyebrow={
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <DocTypeChip docType={data.doc_type} />
            {data.venue && <span>{data.venue}</span>}
            {data.venue && data.publication_date && <span aria-hidden="true">·</span>}
            {data.publication_date && <span>{formatDate(data.publication_date)}</span>}
          </span>
        }
        title={<MathText>{data.title}</MathText>}
        answer={
          explainer?.tldr ? (
            <span className="text-body sm:text-body-lg">
              <span className="font-semibold">In short: </span>
              {sanitizeText(explainer.tldr)}
            </span>
          ) : undefined
        }
        description={authorLine ?? undefined}
        actions={<Links data={data} className="hidden sm:flex sm:flex-nowrap sm:whitespace-nowrap" />}
      />

      {results.length > 0 && (
        <section id="key-results" aria-labelledby="key-results-title" className="-mt-2">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
            <h2 id="key-results-title" className="text-sm font-semibold text-fg">
              Key results the paper reports
            </h2>
            <span className="text-xs text-muted">On the paper’s own setup, not measured here</span>
          </div>
          <KeyResults results={results} max={4} />
          {results.length > 4 && (
            <Disclosure label={`All ${results.length} results`} className="mt-2">
              <ul className="divide-y divide-line-muted rounded-lg border border-line text-sm">
                {results.map((result, index) => (
                  <li key={index} className="grid gap-x-4 gap-y-0.5 px-3 py-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,8rem)_1fr]">
                    <span className="text-fg">{sanitizeText(result.label)}</span>
                    <span className="font-semibold text-fg tabular-nums">{formatResultValue(result.value) || MISSING.value}</span>
                    <span className="text-xs text-muted">{result.context ? sanitizeText(result.context) : ''}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </section>
      )}
      <Links data={data} className="sm:hidden" />

      <ConceptMapSection paperId={data.paper_id} map={data.concept_map} onSelect={jumpToClaim} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card
            id="claims"
            title={`Claims in this paper (${data.claims.length})`}
            actions={
              data.claims.length ? (
                <span className="text-xs text-muted">
                  {formatNumber(testableCount, 0)} testable{data.concept_map?.generated ? ' · in reading order' : ''}
                </span>
              ) : undefined
            }
            bodyClassName="p-0"
          >
            {data.claims.length === 0 ? (
              <EmptyState title={data.distilled_at ? 'No claims found' : 'Not summarised yet'} icon={<BookIcon size={28} />}>
                {data.distilled_at ? 'The summariser found no technical claims in this document.' : 'Claim cards appear after the paper is summarised (Papers page → Run → Summarise pending papers).'}
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line-muted">
                {claims.map((claim) => (
                  <ClaimRow
                    key={claim.id}
                    id={`claim-${claim.id}`}
                    claim={claim}
                    order={claim.related?.has_map ? claim.related.order : null}
                    experiments={byClaim.get(claim.id)}
                    className={cx('transition-colors duration-700', flash === claim.id && 'bg-accent-subtle')}
                    explain={
                      claim.explainer?.problem || claim.explainer?.diagram?.nodes?.length || claim.related?.has_map ? (
                        <div className="space-y-3">
                          {claim.explainer?.problem && (
                            <p className="text-sm text-fg">
                              <span className="font-medium">Problem: </span>
                              {sanitizeText(claim.explainer.problem)}
                            </p>
                          )}
                          <ClaimDiagram diagram={claim.explainer?.diagram} />
                          <RelatedStrip related={claim.related} claimId={claim.id} paperId={data.paper_id} showPosition={false} />
                          <Link to={`/research/claims/${claim.id}`} className="inline-block text-sm">
                            Open the full claim card →
                          </Link>
                        </div>
                      ) : undefined
                    }
                  />
                ))}
              </ul>
            )}
          </Card>

          {explainer ? (
            <Card
              title={
                <span className="flex items-center gap-2">
                  <SparkIcon className="text-muted" /> How it works
                </span>
              }
            >
              <div className="space-y-5 text-sm">
                {explainer.problem && (
                  <Section title="Problem">
                    <p className="text-fg">{sanitizeText(explainer.problem)}</p>
                  </Section>
                )}
                {!!explainer.approach?.length && (
                  <Section title="Approach">
                    <NumberedSteps steps={explainer.approach.map((step) => sanitizeText(step))} />
                  </Section>
                )}
                {explainer.diagram?.nodes?.length ? (
                  <Disclosure label="Show the flow diagram" meta={explainer.diagram.title ? ` · ${explainer.diagram.title}` : undefined}>
                    <div className="rounded-lg border border-line-muted px-3 py-3">
                      <FlowDiagram diagram={explainer.diagram} />
                    </div>
                  </Disclosure>
                ) : null}
                {(explainer.novelty || explainer.who_should_care) && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    {explainer.novelty && (
                      <Section title="What’s new">
                        <p className="text-fg">{sanitizeText(explainer.novelty)}</p>
                      </Section>
                    )}
                    {explainer.who_should_care && (
                      <Section title="Who should care">
                        <p className="text-fg">{sanitizeText(explainer.who_should_care)}</p>
                      </Section>
                    )}
                  </div>
                )}
                {!!explainer.limitations?.length && (
                  <Section title="Limitations">
                    <ul className="space-y-1.5">
                      {explainer.limitations.map((limitation) => (
                        <li key={limitation} className="flex gap-2 text-fg">
                          <AlertIcon size={14} className="mt-0.5 shrink-0 text-caution-fg" />
                          <span>{sanitizeText(limitation)}</span>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
                <ExplainerFootnote explainer={explainer} />
              </div>
            </Card>
          ) : (
            <Card title="How it works">
              <div className="space-y-3 text-sm">
                <p className="text-muted">No plain-language summary yet{data.distilled_at ? '' : ', and the paper hasn’t been summarised into claim cards'}.</p>
                <WriteSummary paperId={data.paper_id} />
              </div>
            </Card>
          )}

          {data.abstract && (
            <section className="card px-3 py-3 sm:px-4" aria-label="Abstract">
              <Disclosure label="Abstract">
                <p className="text-sm leading-relaxed whitespace-pre-line text-fg">{data.abstract}</p>
              </Disclosure>
            </section>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <Card title="Tested here">
            {tested.length === 0 ? (
              <p className="text-sm text-muted">{testableCount ? `Not tested yet. ${pluralize(testableCount, 'claim')} can be picked on the Recommendations page.` : 'Nothing from this paper has been tested.'}</p>
            ) : (
              <ul className="space-y-2.5 text-sm">
                {tested.map((experiment) => (
                  <li key={experiment.id} className="min-w-0">
                    <Link to={`/experiments/${experiment.id}`} className="inline-block py-0.5 font-medium text-fg hover:text-accent">
                      <span className="text-muted tabular-nums">#{experiment.id}</span> <MathText>{experiment.title}</MathText>
                    </Link>
                    <div className="mt-1">
                      {experiment.verdict ? <OutcomeBadge kind="verdict" value={experiment.verdict} explain /> : <StatusChip status={experiment.status} />}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="About this paper">
            <DefinitionList
              items={[
                ['Authors', authors.length ? authors.join(', ') : MISSING.value],
                ['Published', data.publication_date ? formatDate(data.publication_date) : MISSING.value],
                ['Found on', data.sources.length ? data.sources.map(sourceLabel).join(', ') : MISSING.value],
                ['Citations', typeof data.citation_count === 'number' ? formatNumber(data.citation_count, 0) : MISSING.value],
                ['Hugging Face upvotes', typeof data.hf_upvotes === 'number' ? formatNumber(data.hf_upvotes, 0) : MISSING.value],
                ['Text read', data.has_full_text ? 'Full text' : 'Abstract only'],
                ['Summarised', data.distilled_at ? <RelativeTime key="d" iso={data.distilled_at} /> : 'Not yet'],
                ['ID', <code key="id" className="code-inline break-all">{data.paper_id}</code>],
              ]}
            />
          </Card>
          <Card title="Topics">
            {data.topics.length === 0 ? (
              <p className="text-sm text-muted">Not part of a current topic.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.topics.map((topic) => (
                  <li key={topic.slug} className="flex flex-wrap items-center justify-between gap-2">
                    <Link to={`/research/topics/${topic.slug}`} className="inline-flex min-h-6 min-w-0 items-center">
                      {topicName(topic, names)}
                    </Link>
                    {topic.rank != null && <Chip tone="neutral">#{topic.rank} in topic</Chip>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {categories.length > 0 && (
            <Card title="Categories">
              <div className="flex flex-wrap gap-1.5">
                {categories.map((category) => (
                  <CategoryChip key={category} category={category} />
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
