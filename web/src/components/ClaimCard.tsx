import type { ReactNode } from 'react'
import type { Claim } from '../api/types'
import { claimedEffectView, effectText } from '../lib/claims'
import { formatNumber, humanize, humanizeMetric, MISSING, sanitizeText } from '../lib/format'
import { CategoryChip, DocTypeChip, EffortChip, Tag } from './Badges'
import { AlertIcon, ArrowDownIcon, ArrowUpIcon, PaperIcon } from './Icons'
import { Chip, DefinitionList, ExternalLink, PaperLink } from './ui'

export function Requirements({ claim }: { claim: Claim }) {
  const items = [
    claim.requires_cuda && 'CUDA',
    claim.requires_multi_gpu && 'multiple GPUs',
    claim.requires_training && 'training',
  ].filter(Boolean) as string[]
  if (!items.length) return null
  return (
    <Chip tone="caution" title="The paper’s setup needs this; it may not run on this project’s hardware.">
      <AlertIcon size={12} className="shrink-0" /> Requires {items.join(', ')}
    </Chip>
  )
}

/** Header line used in lists: claimed effect + chips. */
export function ClaimChips({ claim, showCategory = true }: { claim: Claim; showCategory?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showCategory && <CategoryChip category={claim.category} />}
      <EffortChip effort={claim.effort} />
      {!claim.testable && <Tag>Not testable</Tag>}
      <Requirements claim={claim} />
      <DocTypeChip docType={claim.paper_doc_type} />
    </div>
  )
}

/**
 * "Paper reports +41% decode speed" in the reference register (neutral ink + paper icon). Relative gains are
 * signed; absolute values are shown as reported; "Paper gives no number" when there is none.
 */
export function ClaimedEffect({ claim }: { claim: Claim }) {
  const view = claimedEffectView(claim, claim.explainer)
  const value = effectText(view, claim.direction)
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1 tabular-nums">
      <PaperIcon size={12} className="shrink-0 self-center text-muted" aria-hidden="true" />
      {view.kind === 'none' ? (
        <span className="text-muted">{value}</span>
      ) : (
        <>
          <span className="text-muted">Paper reports</span>
          <span className="font-semibold text-fg">{value}</span>
          {view.metric && <span className="text-muted">{humanizeMetric(view.metric)}</span>}
        </>
      )}
    </span>
  )
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h4 className="mb-1 text-sm font-semibold text-fg">{children}</h4>
}

/** Full claim card: effects, paper setup, prerequisites, risks and the evidence quote. */
export function ClaimCardDetails({ claim, showPaper = true }: { claim: Claim; showPaper?: boolean }) {
  const card = claim.card
  const setup = card?.paper_setup ? Object.entries(card.paper_setup).filter(([, value]) => value) : []
  return (
    <div className="space-y-4 text-sm">
      {claim.summary && <p className="text-fg">{sanitizeText(claim.summary)}</p>}
      <DefinitionList
        items={[
          ['Technique', sanitizeText(claim.technique)],
          ['Change required', claim.change_required ? sanitizeText(claim.change_required) : MISSING.value],
          ...(showPaper && claim.paper_title
            ? ([
                [
                  'Paper',
                  <span key="paper">
                    <PaperLink paperId={claim.paper_id} title={claim.paper_title} />{' '}
                    {claim.paper_url && (
                      <ExternalLink href={claim.paper_url} className="text-xs text-muted">
                        source
                      </ExternalLink>
                    )}
                  </span>,
                ],
              ] as [string, ReactNode][])
            : []),
        ]}
      />
      {!!card?.effects?.length && (
        <div>
          <SectionHeading>Effects the paper reports</SectionHeading>
          <ul className="space-y-1">
            {card.effects.map((effect, index) => (
              <li key={index} className="flex flex-wrap items-baseline gap-x-2">
                <span className="inline-flex items-center gap-0.5 font-semibold tabular-nums">
                  {effect.value === null || effect.direction === 'none' ? (
                    'Qualitative'
                  ) : (
                    <>
                      {effect.direction === 'decrease' ? (
                        <>
                          <ArrowDownIcon size={12} className="shrink-0" />
                          <span className="sr-text">decrease </span>
                        </>
                      ) : (
                        <>
                          <ArrowUpIcon size={12} className="shrink-0" />
                          <span className="sr-text">increase </span>
                        </>
                      )}
                      {`${formatNumber(effect.value, 2)}${effect.unit === '%' ? '%' : effect.unit ? `${effect.unit === 'x' ? '×' : ` ${effect.unit}`}` : ''}`}
                    </>
                  )}
                </span>
                <span>{humanizeMetric(effect.metric)}</span>
                {(effect.baseline || effect.conditions) && (
                  <span className="text-xs text-muted">
                    {effect.baseline && `vs ${effect.baseline}`}
                    {effect.baseline && effect.conditions && ' · '}
                    {effect.conditions}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!setup.length && (
        <div>
          <SectionHeading>Paper setup</SectionHeading>
          <DefinitionList items={setup.map(([key, value]) => [humanize(key), String(value)])} />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {!!card?.prerequisites?.length && (
          <div>
            <SectionHeading>Prerequisites</SectionHeading>
            <ul className="list-disc space-y-0.5 pl-5">
              {card.prerequisites.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {!!card?.risks?.length && (
          <div>
            <SectionHeading>Risks</SectionHeading>
            <ul className="list-disc space-y-0.5 pl-5">
              {card.risks.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {(card?.evidence?.quote || claim.evidence_quote) && (
        <blockquote className="rounded-r-md border-l-3 border-accent bg-canvas-subtle px-3 py-2 text-muted">
          “{card?.evidence?.quote ?? claim.evidence_quote}”
          {card?.evidence?.location && <span className="mt-1 block text-xs not-italic">{card.evidence.location}</span>}
        </blockquote>
      )}
      {!!claim.key_points?.length && (
        <div>
          <SectionHeading>Key points</SectionHeading>
          <ul className="list-disc space-y-0.5 pl-5">
            {claim.key_points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
