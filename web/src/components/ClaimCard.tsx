import type { ReactNode } from 'react'
import type { Claim } from '../api/types'
import { formatClaimedEffect, formatNumber, humanize } from '../lib/format'
import { CategoryChip, DocTypeChip, EffortChip } from './Badges'
import { AlertIcon } from './Icons'
import { Chip, DefinitionList, ExternalLink, PaperLink } from './ui'

export function Requirements({ claim }: { claim: Claim }) {
  const items = [
    claim.requires_cuda && 'CUDA',
    claim.requires_multi_gpu && 'multiple GPUs',
    claim.requires_training && 'training',
  ].filter(Boolean) as string[]
  if (!items.length) return null
  return (
    <Chip tone="danger" title="Paper prerequisites">
      <AlertIcon size={12} /> requires {items.join(', ')}
    </Chip>
  )
}

/** Header line used in lists: claimed effect + chips. */
export function ClaimChips({ claim, showCategory = true }: { claim: Claim; showCategory?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showCategory && <CategoryChip category={claim.category} />}
      <EffortChip effort={claim.effort} />
      {!claim.testable && <Chip tone="muted">not testable</Chip>}
      <Requirements claim={claim} />
      <DocTypeChip docType={claim.paper_doc_type} />
    </div>
  )
}

export function ClaimedEffect({ claim }: { claim: Claim }) {
  return (
    <span className="tabular-nums">
      <span className="font-semibold text-done">{formatClaimedEffect(claim)}</span>
      {claim.primary_metric && <span className="text-muted"> {claim.primary_metric}</span>}
    </span>
  )
}

/** Full claim card: effects, paper setup, prerequisites, risks and the evidence quote. */
export function ClaimCardDetails({ claim, showPaper = true }: { claim: Claim; showPaper?: boolean }) {
  const card = claim.card
  const setup = card?.paper_setup ? Object.entries(card.paper_setup).filter(([, value]) => value) : []
  return (
    <div className="space-y-4 text-sm">
      {claim.summary && <p className="text-fg">{claim.summary}</p>}
      <DefinitionList
        items={[
          ['Technique', claim.technique],
          ['Change required', claim.change_required ?? '—'],
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
          <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Claimed effects</h4>
          <ul className="space-y-1">
            {card.effects.map((effect, index) => (
              <li key={index} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold tabular-nums">
                  {effect.value === null || effect.direction === 'none'
                    ? 'qualitative'
                    : `${effect.direction === 'decrease' ? '↓' : '↑'} ${formatNumber(effect.value, 2)}${effect.unit === '%' ? '%' : effect.unit ? `${effect.unit === 'x' ? '×' : ` ${effect.unit}`}` : ''}`}
                </span>
                <span>{effect.metric}</span>
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
          <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Paper setup</h4>
          <DefinitionList items={setup.map(([key, value]) => [humanize(key), String(value)])} />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {!!card?.prerequisites?.length && (
          <div>
            <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Prerequisites</h4>
            <ul className="list-disc space-y-0.5 pl-5">
              {card.prerequisites.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {!!card?.risks?.length && (
          <div>
            <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Risks</h4>
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
          {card?.evidence?.location && <span className="mt-1 block text-xs not-italic">— {card.evidence.location}</span>}
        </blockquote>
      )}
      {!!claim.key_points?.length && (
        <div>
          <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Key points</h4>
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
