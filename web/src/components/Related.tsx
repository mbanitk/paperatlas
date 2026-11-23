import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { ClaimRelated, ConceptBundle, ConceptNode, RelatedConcept } from '../api/types'
import { hasRelations, headlineBundle, normalizeRelated, roleLabel, shortEffect, shortName } from '../lib/conceptMap'
import { GraphIcon } from './Icons'
import { Card, cx } from './ui'

const paperPath = (paperId: string) => `/research/papers/${paperId.split('/').map(encodeURIComponent).join('/')}`

/** Small numbered chip linking to another concept's claim; green dot = testable on this project. */
export function ConceptRef({ node, max = 30, className }: { node: ConceptNode; max?: number; className?: string }) {
  const testable = node.testable_here === true
  const title = `${node.order != null ? `Concept ${node.order}: ` : ''}${node.name}${node.headline ? ` — ${node.headline}` : ''}${
    node.testable_here == null ? '' : testable ? ' (testable here)' : ' (not testable here)'
  }`
  const body = (
    <>
      {node.order != null && <span className="font-semibold text-subtle tabular-nums">{node.order}</span>}
      <span className="truncate">{shortName(node.name, max)}</span>
      {node.testable_here != null && (
        <span
          className={cx('inline-block size-1.5 shrink-0 rounded-full', testable ? 'bg-success-emphasis' : 'border border-subtle bg-canvas')}
          aria-hidden="true"
        />
      )}
    </>
  )
  const classes = cx(
    'inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border border-line bg-canvas px-2 py-px align-middle text-xs text-fg',
    node.claim_id != null && 'hover:border-accent hover:text-accent hover:no-underline',
    className,
  )
  return node.claim_id ? (
    <Link to={`/research/claims/${node.claim_id}`} className={classes} title={title}>
      {body}
    </Link>
  ) : (
    <span className={classes} title={title}>
      {body}
    </span>
  )
}

function Group({ label, nodes, claimId, limit = 2 }: { label: string; nodes: ConceptNode[] | undefined; claimId: number; limit?: number }) {
  if (!nodes?.length) return null
  const extra = nodes.length - limit
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      <span className="text-muted">{label}:</span>
      {nodes.slice(0, limit).map((node) => (
        <ConceptRef key={node.concept_id} node={node} max={26} />
      ))}
      {extra > 0 && (
        <Link to={`/research/claims/${claimId}`} className="text-muted hover:text-accent">
          +{extra} more
        </Link>
      )}
    </span>
  )
}

function HeadlineLine({ bundle, claimId }: { bundle: ConceptBundle; claimId: number }) {
  const others = bundle.members.filter((member) => member.claim_id !== claimId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const effect = shortEffect(bundle.effect)
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-1 text-xs" title={bundle.effect ?? undefined}>
      <span className="rounded bg-success-emphasis px-1.5 py-px text-[10.5px] font-semibold text-white">Headline</span>
      <span className="text-muted">
        {effect ? <strong className="mr-1 text-success tabular-nums">{effect}</strong> : 'result '}
        needs this
      </span>
      {others.map((member) => (
        <span key={member.concept_id} className="inline-flex min-w-0 items-center gap-1">
          <span className="text-subtle">+</span>
          <ConceptRef node={member} max={24} />
        </span>
      ))}
    </p>
  )
}

/**
 * One or two lines for claim cards: where the concept sits in its paper ("Concept 3 of 8"), what it needs first,
 * what it unlocks / extends / works with, and the headline result it is part of.
 */
export function RelatedStrip({
  related,
  claimId,
  paperId,
  showPosition = true,
  className,
}: {
  related: ClaimRelated | null | undefined
  claimId: number
  paperId: string
  /** "Concept 3 of 8 · Core idea" (off on the paper page, which numbers its claims already). */
  showPosition?: boolean
  className?: string
}) {
  if (!related?.has_map || (related.concepts_in_paper ?? 0) < 2) return null
  const headline = headlineBundle(related, claimId)
  const role = roleLabel(related.role)
  const linked = hasRelations(related)
  if (!showPosition && !linked) return null
  return (
    <div className={cx('min-w-0 space-y-1', className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {showPosition && (
          <Link
            to={{ pathname: paperPath(paperId), hash: 'concept-map' }}
            className="inline-flex items-center gap-1 text-muted hover:text-accent"
            title="Open the paper's concept map"
          >
            <GraphIcon size={13} />
            {related.order != null ? `Concept ${related.order} of ${related.concepts_in_paper}` : `${related.concepts_in_paper} concepts in this paper`}
            {role && <span className="text-subtle">· {role}</span>}
          </Link>
        )}
        <Group label="Needs first" nodes={related.prerequisites} claimId={claimId} />
        <Group label="Unlocks" nodes={related.required_by} claimId={claimId} />
        <Group label="Extends" nodes={related.builds_on} claimId={claimId} />
        <Group label="Works with" nodes={related.complements} claimId={claimId} />
        <Group label="Alternative to" nodes={related.alternatives} claimId={claimId} />
        {showPosition && !linked && <span className="text-subtle">stands on its own</span>}
      </div>
      {headline && <HeadlineLine bundle={headline} claimId={claimId} />}
    </div>
  )
}

function WhyList({ title, items, hint }: { title: string; items: RelatedConcept[] | undefined; hint?: string }) {
  if (!items?.length) return null
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase" title={hint}>
        {title}
      </h4>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.concept_id} className="text-sm">
            <ConceptRef node={item} max={48} />
            {item.why && <p className="mt-0.5 ml-1 text-[13px] text-muted">{item.why}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Full "how this concept connects" card for the claim page. */
export function RelatedCard({
  related,
  claimId,
  paperId,
  paperTitle,
  actions,
}: {
  related: ClaimRelated | null | undefined
  claimId: number
  paperId: string
  paperTitle?: string | null
  actions?: ReactNode
}) {
  if (!related || (related.concepts_in_paper ?? 0) < 2) return null
  const measured = normalizeRelated(related)
  const role = roleLabel(related.role)
  const bundles = [...(related.bundles ?? [])].sort((a, b) => Number(!!b.is_headline_result) - Number(!!a.is_headline_result))
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <GraphIcon className="text-accent" /> How this concept connects
        </span>
      }
      actions={actions}
    >
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          {related.order != null ? (
            <>
              Concept <strong className="text-fg">{related.order}</strong> of {related.concepts_in_paper}
            </>
          ) : (
            <>One of {related.concepts_in_paper} concepts</>
          )}{' '}
          in{' '}
          <Link to={paperPath(paperId)} className="text-fg">
            {paperTitle ?? paperId}
          </Link>
          {role && <> · {role}</>} ·{' '}
          <Link to={{ pathname: paperPath(paperId), hash: 'concept-map' }}>{related.has_map ? 'open the concept map' : 'map the concepts'}</Link>
        </p>
        {!related.has_map ? (
          <p className="text-muted">How this paper’s concepts depend on each other has not been mapped yet.</p>
        ) : !hasRelations(related) ? (
          <p className="text-muted">The paper presents this concept on its own — no prerequisites or combined results.</p>
        ) : null}
        {related.prerequisites.length > 0 && (
          <section className="rounded-md border border-attention-emphasis/30 bg-attention-subtle/50 px-3 py-2">
            <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-attention uppercase">To try this, first have</h4>
            <ol className="flex flex-wrap items-center gap-1.5">
              {related.prerequisites.map((node) => (
                <li key={node.concept_id} className="flex min-w-0 items-center gap-1.5">
                  <ConceptRef node={node} max={36} />
                  <span className="text-subtle" aria-hidden="true">
                    →
                  </span>
                </li>
              ))}
              <li className="rounded-full bg-accent-emphasis px-2 py-px text-xs font-semibold text-white">this concept</li>
            </ol>
            <p className="mt-1.5 text-xs text-muted">Green dot = testable on your hardware. Gate 1 can chain or bundle these with this claim.</p>
          </section>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <WhyList title="Needs first" items={related.requires} hint="Direct prerequisites" />
          <WhyList title="Unlocks" items={related.required_by} hint="Concepts that need this one first" />
          <WhyList title="Extends" items={related.builds_on} />
          <WhyList title="Extended by" items={related.extended_by} />
          <WhyList title="Works with" items={related.complements} />
          <WhyList title="Alternative to" items={related.alternatives} />
          <WhyList title="Measured by" items={measured.evaluated_by} />
          <WhyList title="Measures" items={measured.evaluates} />
        </div>
        {bundles.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Combined results that include this concept</h4>
            <ul className="space-y-1.5">
              {bundles.map((bundle, index) => {
                const effect = shortEffect(bundle.effect)
                return (
                  <li
                    key={`${bundle.name}-${index}`}
                    className={cx('rounded-md border px-3 py-2', bundle.is_headline_result ? 'border-success/30 bg-success-subtle/40' : 'border-line-muted')}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {bundle.is_headline_result && (
                        <span className="rounded bg-success-emphasis px-1.5 py-px text-[10.5px] font-semibold text-white">Headline</span>
                      )}
                      <span className="font-medium">{bundle.name}</span>
                      {effect && (
                        <span className="ml-auto rounded-full bg-success-subtle px-2 py-px text-xs font-semibold text-success tabular-nums">{effect}</span>
                      )}
                    </div>
                    {bundle.effect && <p className="mt-0.5 text-xs text-muted">{bundle.effect}</p>}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {[...bundle.members]
                        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                        .map((member, i) => (
                          <span key={member.concept_id} className="inline-flex min-w-0 items-center gap-1">
                            {i > 0 && <span className="text-subtle">+</span>}
                            {member.claim_id === claimId ? (
                              <span className="rounded-full bg-accent-emphasis px-2 py-px text-xs font-semibold text-white">this</span>
                            ) : (
                              <ConceptRef node={member} max={30} />
                            )}
                          </span>
                        ))}
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </Card>
  )
}
