import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { useGenerateConceptMap } from '../api/queries'
import type { ConceptBundle, ConceptMap as ConceptMapData, ConceptNode } from '../api/types'
import { layoutConceptMap, neighbours, readingPathParts, relationInfo, roleLabel, shortEffect, shortName, type PlacedConcept } from '../lib/conceptMap'
import { wrapLabel } from '../lib/flow'
import { BookIcon, CheckIcon, SparkIcon } from './Icons'
import { useToast } from './Toast'
import { Button, Card, cx, errorMessage, InlineError } from './ui'

/** Node look per role: foundation muted, core accent, extension/optimization lighter, evaluation outlined, limitation warning. */
export const ROLE_STYLES: Record<string, { fill: string; stroke: string; width: number; dash?: string }> = {
  foundation: { fill: '#eaeef2', stroke: '#8c959f', width: 1 },
  core: { fill: '#ddf4ff', stroke: '#0969da', width: 1.6 },
  extension: { fill: '#f3f9ff', stroke: '#80ccff', width: 1.2 },
  optimization: { fill: '#f3f9ff', stroke: '#80ccff', width: 1.2, dash: '5 2' },
  evaluation: { fill: '#ffffff', stroke: '#6e7781', width: 1.2 },
  limitation: { fill: '#fff8c5', stroke: '#d4a72c', width: 1.2 },
}
const DEFAULT_ROLE = { fill: '#ffffff', stroke: '#d0d7de', width: 1 }
const roleStyle = (role: string | null | undefined) => ROLE_STYLES[role ?? ''] ?? DEFAULT_ROLE

/** Edge look per relation: needs = accent arrow, extends = gray arrow, works with = dashed, or = dotted, measured by = thin. */
export const RELATION_STYLES: Record<string, { stroke: string; width: number; dash?: string }> = {
  requires: { stroke: '#0969da', width: 1.6 },
  builds_on: { stroke: '#57606a', width: 1.3 },
  complements: { stroke: '#1a7f37', width: 1.4, dash: '5 3' },
  alternative_to: { stroke: '#bf8700', width: 1.6, dash: '1 3.5' },
  evaluated_by: { stroke: '#afb8c1', width: 1 },
}
const relationStyle = (relation: string) => RELATION_STYLES[relation] ?? { stroke: '#8c959f', width: 1 }

type Active = { node: number } | { bundle: number } | null

export interface ConceptMapGraphProps {
  map: ConceptMapData
  /** Concept the page is about (claim detail): drawn with a thicker ring. */
  currentConceptId?: number | null
  onSelect?: (node: ConceptNode) => void
  /** List the paper's combined results under the graph (default true). */
  showBundles?: boolean
  className?: string
}

/**
 * A paper's concepts as a compact left→right graph: columns follow prerequisites ("needs first" / "extends"),
 * evaluation and limitation concepts sit in the last column, numbered badges give the paper's reading order.
 * Hover or focus a concept (or a combined result) to highlight its links and read why they exist.
 */
export function ConceptMapGraph({ map, currentConceptId, onSelect, showBundles = true, className }: ConceptMapGraphProps) {
  const layout = useMemo(() => layoutConceptMap(map), [map])
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const [active, setActive] = useState<Active>(null)
  const byId = useMemo(() => new Map(layout.nodes.map((node) => [node.concept_id, node])), [layout])
  const bundles = useMemo(() => sortBundles(map.bundles ?? []), [map.bundles])

  if (!layout.nodes.length) return null

  const focusSet: Set<number> | null =
    active && 'node' in active
      ? new Set([active.node, ...neighbours(map, active.node).map((item) => item.node.concept_id)])
      : active && 'bundle' in active
        ? new Set(bundleIds(bundles[active.bundle]))
        : null
  const linkActive = (source: number, target: number) =>
    !focusSet ? true : active && 'node' in active ? source === active.node || target === active.node : focusSet.has(source) && focusSet.has(target)

  const name = (id: number) => byId.get(id)?.name ?? `concept ${id}`
  const relations = Object.keys(RELATION_STYLES).filter((relation) => layout.links.some((link) => link.relation === relation))
  const roles = Object.keys(ROLE_STYLES).filter((role) => layout.nodes.some((node) => node.role === role))
  const description = layout.nodes
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((node) => `${node.order ?? ''}. ${node.name}${node.role ? ` (${node.role})` : ''}`)
    .join('; ')

  const activate = (node: PlacedConcept) => setActive({ node: node.concept_id })
  const onKey = (event: KeyboardEvent, node: PlacedConcept) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect?.(node)
    }
  }

  return (
    <div className={cx('min-w-0 space-y-3', className)}>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="max-w-full min-w-0 overflow-x-auto">
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            style={{
              width: layout.width,
              maxWidth: '100%',
              minWidth: Math.min(layout.width, 560),
              display: 'block',
            }}
            role="group"
            aria-labelledby={`${uid}-t`}
            aria-describedby={`${uid}-d`}
            className="h-auto"
            onMouseLeave={() => setActive(null)}
          >
            <title id={`${uid}-t`}>Concept map: how the paper&apos;s {layout.nodes.length} concepts connect</title>
            <desc id={`${uid}-d`}>{description}</desc>
            <defs>
              {Object.entries(RELATION_STYLES).map(([relation, style]) => (
                <marker
                  key={relation}
                  id={`${uid}-${relation}`}
                  viewBox="0 0 8 8"
                  refX="7.5"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                  markerUnits="userSpaceOnUse"
                >
                  <path d="M0,0.5 L8,4 L0,7.5 z" fill={style.stroke} />
                </marker>
              ))}
            </defs>
            <g fill="none">
              {layout.links.map((link, index) => {
                const style = relationStyle(link.relation)
                const on = linkActive(link.source, link.target)
                const marker = `url(#${uid}-${link.relation in RELATION_STYLES ? link.relation : 'evaluated_by'})`
                const sentence = relationInfo(link.relation).sentence(name(link.source), name(link.target))
                return (
                  <g key={index} opacity={on ? 1 : 0.15} style={{ transition: 'opacity 120ms' }}>
                    <title>{`${sentence}${link.why ? ` — ${link.why}` : ''}`}</title>
                    <path d={link.path} stroke="transparent" strokeWidth={10} />
                    <path
                      d={link.path}
                      stroke={style.stroke}
                      strokeWidth={focusSet && on ? style.width + 0.6 : style.width}
                      strokeDasharray={style.dash}
                      strokeLinecap="round"
                      markerEnd={link.arrow === 'end' ? marker : undefined}
                      markerStart={link.arrow === 'start' ? marker : undefined}
                    />
                  </g>
                )
              })}
            </g>
            {layout.nodes.map((node) => {
              const style = roleStyle(node.role)
              const dimmed = focusSet ? !focusSet.has(node.concept_id) : false
              const current = node.concept_id === currentConceptId
              const lines = wrapLabel(shortName(node.name, 64), 21, 2)
              const lineHeight = 12.5
              const startY = node.y + node.height / 2 - ((lines.length - 1) * lineHeight) / 2 + 4
              const label = `${node.order ?? ''}. ${node.name}${node.role ? `, ${roleLabel(node.role)}` : ''}${node.testable_here ? ', testable here' : ''}${onSelect && node.claim_id ? ' — open claim' : ''}`
              return (
                <g
                  key={node.concept_id}
                  tabIndex={0}
                  role={onSelect && node.claim_id ? 'button' : 'img'}
                  aria-label={label}
                  className="cursor-pointer outline-none [&:focus-visible>rect.ring]:opacity-100"
                  opacity={dimmed ? 0.35 : 1}
                  style={{ transition: 'opacity 120ms' }}
                  onMouseEnter={() => activate(node)}
                  onFocus={() => activate(node)}
                  onBlur={() => setActive(null)}
                  onClick={() => onSelect?.(node)}
                  onKeyDown={(event) => onKey(event, node)}
                >
                  <title>{`${node.order ?? ''}. ${node.name}${node.headline ? `\n${node.headline}` : ''}`}</title>
                  <rect
                    className="ring"
                    x={node.x - 3}
                    y={node.y - 3}
                    width={node.width + 6}
                    height={node.height + 6}
                    rx={11}
                    fill="none"
                    stroke="#0969da"
                    strokeWidth={2}
                    opacity={0}
                  />
                  {current && (
                    <rect
                      x={node.x - 4}
                      y={node.y - 4}
                      width={node.width + 8}
                      height={node.height + 8}
                      rx={12}
                      fill="none"
                      stroke="#0969da"
                      strokeWidth={1.5}
                      strokeDasharray="3 2"
                    />
                  )}
                  <rect
                    x={node.x}
                    y={node.y}
                    width={node.width}
                    height={node.height}
                    rx={8}
                    fill={style.fill}
                    stroke={style.stroke}
                    strokeWidth={current ? style.width + 0.8 : style.width}
                    strokeDasharray={style.dash}
                  />
                  <text textAnchor="middle" fontSize={11} fill="#1f2328" fontWeight={node.role === 'core' || current ? 600 : 500}>
                    {lines.map((line, i) => (
                      <tspan key={i} x={node.x + node.width / 2 + 3} y={startY + i * lineHeight}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                  {node.order != null && (
                    <g>
                      <circle cx={node.x + 1} cy={node.y + 1} r={8.5} fill={node.role === 'core' ? '#0969da' : '#57606a'} stroke="#fff" strokeWidth={1.5} />
                      <text x={node.x + 1} y={node.y + 4.4} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#fff">
                        {node.order}
                      </text>
                    </g>
                  )}
                  {node.testable_here && <circle cx={node.x + node.width - 1} cy={node.y + 1} r={4.5} fill="#1a7f37" stroke="#fff" strokeWidth={1.5} />}
                </g>
              )
            })}
          </svg>
        </div>
        <div className="min-w-[240px] flex-1 space-y-3">
          <FocusInfo map={map} active={active} bundles={bundles} />
          <Legend roles={roles} relations={relations} testable={layout.nodes.some((node) => node.testable_here)} />
        </div>
      </div>
      {showBundles && bundles.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Combined results</h4>
          <ul className="space-y-1.5" onMouseLeave={() => setActive(null)}>
            {bundles.map((bundle, index) => (
              <BundleRow
                key={`${bundle.name}-${index}`}
                bundle={bundle}
                active={!!active && 'bundle' in active && active.bundle === index}
                onActivate={() => setActive({ bundle: index })}
                onDeactivate={() => setActive(null)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function bundleIds(bundle: ConceptBundle | undefined): number[] {
  if (!bundle) return []
  return bundle.members?.length ? bundle.members.map((member) => member.concept_id) : (bundle.concept_ids ?? [])
}

function sortBundles(bundles: ConceptBundle[]): ConceptBundle[] {
  return [...bundles].sort((a, b) => Number(!!b.is_headline_result) - Number(!!a.is_headline_result))
}

function OrderBadge({ node, className }: { node: Pick<ConceptNode, 'order' | 'role'>; className?: string }) {
  if (node.order == null) return null
  return (
    <span
      className={cx(
        'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] leading-none font-bold text-white tabular-nums',
        node.role === 'core' ? 'bg-accent-emphasis' : 'bg-[#57606a]',
        className,
      )}
      aria-hidden="true"
    >
      {node.order}
    </span>
  )
}

function FocusInfo({ map, active, bundles }: { map: ConceptMapData; active: Active; bundles: ConceptBundle[] }) {
  let content
  if (active && 'node' in active) {
    const node = map.nodes.find((item) => item.concept_id === active.node)
    const links = neighbours(map, active.node)
    content = node && (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <OrderBadge node={node} />
          <span className="font-semibold text-fg">{node.name}</span>
          {node.role && <span className="text-xs text-muted">{roleLabel(node.role)}</span>}
          {node.testable_here && (
            <span className="inline-flex items-center gap-0.5 text-xs text-success">
              <CheckIcon size={12} /> testable here
            </span>
          )}
        </div>
        {node.headline && <p className="text-muted">{node.headline}</p>}
        {links.length > 0 && (
          <ul className="space-y-0.5">
            {links.map((item, index) => (
              <li key={index} className="text-[13px]">
                <span className="font-medium text-fg">{item.phrase}</span> <OrderBadge node={item.node} className="mx-0.5 align-[-2px]" />{' '}
                {shortName(item.node.name, 48)}
                {item.why && <span className="text-muted"> — {item.why}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  } else if (active && 'bundle' in active) {
    const bundle = bundles[active.bundle]
    content = bundle && (
      <p>
        <span className="font-semibold text-fg">{bundle.name}:</span> <span className="text-muted">{bundle.effect || 'not quantified'}</span>
      </p>
    )
  }
  return (
    <div className="min-h-16 rounded-md bg-canvas-subtle px-3 py-2 text-sm" aria-live="polite">
      {content ?? <p className="text-xs text-muted">Hover or focus a concept to see what it needs and what it unlocks; click it to jump to its claim card.</p>}
    </div>
  )
}

function Legend({ roles, relations, testable }: { roles: string[]; relations: string[]; testable: boolean }) {
  if (!roles.length && !relations.length) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted" aria-label="Legend">
      {roles.map((role) => {
        const style = roleStyle(role)
        return (
          <span key={role} className="inline-flex items-center gap-1.5">
            <svg width="18" height="11" aria-hidden="true">
              <rect
                x="1"
                y="1"
                width="16"
                height="9"
                rx="3"
                fill={style.fill}
                stroke={style.stroke}
                strokeWidth={style.width}
                strokeDasharray={style.dash ? '3 1.5' : undefined}
              />
            </svg>
            {roleLabel(role)}
          </span>
        )
      })}
      {relations.map((relation) => {
        const style = relationStyle(relation)
        const info = relationInfo(relation)
        return (
          <span key={relation} className="inline-flex items-center gap-1.5">
            <svg width="24" height="10" aria-hidden="true">
              <line
                x1="1"
                y1="5"
                x2={info.directed ? 18 : 23}
                y2="5"
                stroke={style.stroke}
                strokeWidth={style.width + 0.2}
                strokeDasharray={style.dash}
                strokeLinecap="round"
              />
              {info.directed && <path d="M17,1.5 L23,5 L17,8.5 z" fill={style.stroke} />}
            </svg>
            {info.label}
          </span>
        )
      })}
      {testable && (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-success-emphasis" aria-hidden="true" /> testable on your hardware
        </span>
      )}
    </div>
  )
}

function BundleRow({ bundle, active, onActivate, onDeactivate }: { bundle: ConceptBundle; active: boolean; onActivate: () => void; onDeactivate: () => void }) {
  const effect = shortEffect(bundle.effect)
  const members = [...(bundle.members ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  return (
    <li
      tabIndex={0}
      onMouseEnter={onActivate}
      onFocus={onActivate}
      onBlur={onDeactivate}
      className={cx(
        'rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent',
        bundle.is_headline_result ? 'border-success/30 bg-success-subtle/40' : 'border-line-muted',
        active && 'ring-1 ring-accent/40',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {bundle.is_headline_result && <span className="rounded bg-success-emphasis px-1.5 py-px text-[10.5px] font-semibold text-white">Headline</span>}
        <span className="font-medium text-fg">{bundle.name}</span>
        <span className="inline-flex flex-wrap items-center gap-0.5" aria-label={`Combines ${members.map((member) => member.name).join(', ')}`}>
          {members.map((member, index) => (
            <span key={member.concept_id} className="inline-flex items-center gap-0.5">
              {index > 0 && <span className="text-subtle">+</span>}
              <span title={member.name}>
                <OrderBadge node={member} />
              </span>
            </span>
          ))}
        </span>
        {effect && <span className="ml-auto rounded-full bg-success-subtle px-2 py-px text-xs font-semibold text-success tabular-nums">{effect}</span>}
      </div>
      {bundle.effect && (
        <p className="mt-0.5 line-clamp-2 text-xs text-muted" title={bundle.effect}>
          {bundle.effect}
        </p>
      )}
    </li>
  )
}

/** "Concept map" card for the paper page (generate / regenerate via the research API). */
export function ConceptMapCard({
  paperId,
  map,
  onSelect,
}: {
  paperId: string
  map: ConceptMapData | null | undefined
  onSelect?: (node: ConceptNode) => void
}) {
  const generate = useGenerateConceptMap()
  const toast = useToast()
  if (!map || map.nodes.length < 2) return null
  const run = () =>
    generate.mutate(paperId, {
      onSuccess: () => toast.success('Concept map ready'),
      onError: (error) => toast.error(errorMessage(error)),
    })
  const title = (
    <span className="flex items-center gap-2">
      <SparkIcon className="text-accent" /> Concept map
      <span className="text-xs font-normal text-muted">{map.nodes.length} concepts, in the order the paper explains them</span>
    </span>
  )
  if (!map.generated)
    return (
      <Card title={title} id="concept-map">
        <div className="space-y-2 text-sm">
          <p className="text-muted">
            These concepts are not isolated: some need others first, some only reach the paper’s headline result together. Map how they connect to see what to
            implement first.
          </p>
          <Button size="sm" variant="outline" icon={<SparkIcon size={14} />} loading={generate.isPending} onClick={run}>
            {generate.isPending ? 'Mapping concepts… (~20 s)' : 'Map how these concepts connect'}
          </Button>
          {generate.error ? <InlineError error={generate.error} /> : null}
        </div>
      </Card>
    )
  return (
    <Card
      title={title}
      id="concept-map"
      actions={
        <Button size="sm" variant="invisible" loading={generate.isPending} onClick={run} title="Ask the model to map the concepts again (~20 s)">
          {generate.isPending ? 'Mapping… (~20 s)' : 'Regenerate'}
        </Button>
      }
    >
      <div className="space-y-3">
        {map.reading_path && (
          <p className="flex gap-2 text-sm text-fg">
            <BookIcon size={15} className="mt-0.5 shrink-0 text-muted" />
            <span>
              <span className="font-medium">Reading path:</span>{' '}
              {readingPathParts(map.reading_path, map.nodes).map((part, index) =>
                typeof part === 'string' ? (
                  <span key={index}>{part}</span>
                ) : (
                  <span key={index} title={part.node.name}>
                    <OrderBadge node={part.node} className="align-[1px]" />
                  </span>
                ),
              )}
            </span>
          </p>
        )}
        {generate.error ? <InlineError error={generate.error} /> : null}
        <ConceptMapGraph map={map} onSelect={onSelect} />
      </div>
    </Card>
  )
}
