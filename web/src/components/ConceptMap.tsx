import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useGenerateConceptMap } from '../api/queries'
import type { ConceptBundle, ConceptMap as ConceptMapData, ConceptNode } from '../api/types'
import { CONCEPT_TEXT, layoutConceptMap, neighbours, readingPathParts, relationInfo, roleLabel, shortEffect, shortName, type PlacedConcept } from '../lib/conceptMap'
import { MIN_DIAGRAM_SCALE } from '../lib/textMeasure'
import { fitScale, useElementWidth } from '../lib/useElementWidth'
import { ConfirmDialog } from './Dialog'
import { DiagramFrame, useSvgTooltip } from './FlowDiagram'
import { BookIcon, CheckIcon, GraphIcon, ListIcon, PaperIcon, SparkIcon } from './Icons'
import { useToast } from './Toast'
import { Tooltip } from './Tooltip'
import { Button, Card, cx, errorMessage, InlineError } from './ui'

/**
 * Node look per role: foundation muted, core accent, extension/optimization lighter, evaluation outlined,
 * limitation caution. (Colours come from the semantic tokens; none of them reads as an outcome.)
 */
export const ROLE_STYLES: Record<string, { fill: string; stroke: string; width: number; dash?: string }> = {
  foundation: { fill: '#eff2f5', stroke: '#8c959f', width: 1 },
  core: { fill: '#ddf4ff', stroke: '#0969da', width: 1.6 },
  extension: { fill: '#f3f9ff', stroke: '#80ccff', width: 1.2 },
  optimization: { fill: '#f3f9ff', stroke: '#80ccff', width: 1.2, dash: '5 2' },
  evaluation: { fill: '#ffffff', stroke: '#6e7781', width: 1.2 },
  limitation: { fill: '#fff8c5', stroke: '#bf8700', width: 1.2 },
}
const DEFAULT_ROLE = { fill: '#ffffff', stroke: '#d1d9e0', width: 1 }
const roleStyle = (role: string | null | undefined) => ROLE_STYLES[role ?? ''] ?? DEFAULT_ROLE

/** Edge look per relation: needs = accent arrow, extends = grey arrow, works with = dashed, or = dotted, measured by = thin. */
export const RELATION_STYLES: Record<string, { stroke: string; width: number; dash?: string }> = {
  requires: { stroke: '#0969da', width: 1.6 },
  builds_on: { stroke: '#59636e', width: 1.3 },
  complements: { stroke: '#59636e', width: 1.4, dash: '6 3' },
  alternative_to: { stroke: '#59636e', width: 1.6, dash: '1.5 3.5' },
  evaluated_by: { stroke: '#8c959f', width: 1 },
}
const relationStyle = (relation: string) => RELATION_STYLES[relation] ?? { stroke: '#8c959f', width: 1 }

type Active = { node: number } | { bundle: number } | null
type View = 'map' | 'list'

/** Below this width the map opens as a list (the SVG would need sideways scrolling to stay readable). */
const LIST_BELOW = 640

export interface ConceptMapGraphProps {
  map: ConceptMapData
  /** Concept the page is about (claim detail): drawn with a dashed ring. */
  currentConceptId?: number | null
  /** Open a concept's claim card (offered once a concept is selected). */
  onSelect?: (node: ConceptNode) => void
  /** List the paper's combined results under the graph (default true). */
  showBundles?: boolean
  className?: string
  /** Start as a map or a list (default: list below 640 px, map otherwise). */
  defaultView?: View
}

/**
 * A paper's concepts as a compact left→right graph: columns follow prerequisites ("needs first" / "extends"),
 * evaluation and limitation concepts sit in the last column, numbered badges give the paper's reading order.
 *
 * Hover or focus a concept to preview what it needs and unlocks in the details panel (fixed height, so the
 * page never shifts); click, tap, Enter or Space selects it, and selecting it again (or "Open claim card")
 * opens its claim. Text is 12 px and never renders below 11 px: the map scrolls sideways instead of shrinking,
 * and on narrow screens it opens as a readable list.
 */
export function ConceptMapGraph({ map, currentConceptId, onSelect, showBundles = true, className, defaultView }: ConceptMapGraphProps) {
  const layout = useMemo(() => layoutConceptMap(map), [map])
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [chosenView, setView] = useState<View | null>(defaultView ?? null)
  const [hovered, setHovered] = useState<Active>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const tooltip = useSvgTooltip()
  const byId = useMemo(() => new Map(layout.nodes.map((node) => [node.concept_id, node])), [layout])
  const bundles = useMemo(() => sortBundles(map.bundles ?? []), [map.bundles])
  const view: View = chosenView ?? (width !== null && width < LIST_BELOW ? 'list' : 'map')

  if (!layout.nodes.length) return null

  const active: Active = hovered ?? (selected !== null ? { node: selected } : null)
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
  const readingOrder = [...layout.nodes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const description = readingOrder.map((node) => `${node.order ?? ''}. ${node.name}${node.role ? ` (${roleLabel(node.role)})` : ''}`).join('; ')
  const canOpen = (node: ConceptNode) => !!onSelect && !!node.claim_id && node.concept_id !== currentConceptId

  const activate = (node: PlacedConcept) => {
    if (selected === node.concept_id && canOpen(node)) onSelect?.(node)
    else setSelected(node.concept_id)
  }
  const onKey = (event: KeyboardEvent, node: PlacedConcept) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activate(node)
    } else if (event.key === 'Escape') setSelected(null)
  }
  const scale = fitScale(layout.width, width, MIN_DIAGRAM_SCALE) ?? 1
  // The details panel sits beside the map when there's room, otherwise under it (with the legend beside it).
  // Its height depends only on that, never on what it shows, so hovering never moves the page.
  const beside = width !== null && width - layout.width * scale - 24 >= 240
  const current = currentConceptId != null ? byId.get(currentConceptId) : undefined

  const svg = (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={Math.round(layout.width * scale)}
      height={Math.round(layout.height * scale)}
      role="group"
      aria-labelledby={`${uid}-t`}
      aria-describedby={`${uid}-d`}
      className="block max-w-none"
      onMouseLeave={() => setHovered(null)}
    >
      <title id={`${uid}-t`}>{`Concept map: how the paper’s ${layout.nodes.length} concepts connect`}</title>
      <desc id={`${uid}-d`}>{description}</desc>
      <defs>
        {Object.entries(RELATION_STYLES).map(([relation, style]) => (
          <marker key={relation} id={`${uid}-${relation}`} viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
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
              <path d={link.path} stroke="transparent" strokeWidth={12} {...tooltip.bind(`${sentence}${link.why ? `: ${link.why}` : ''}`)} />
              <path
                d={link.path}
                stroke={style.stroke}
                strokeWidth={focusSet && on ? style.width + 0.6 : style.width}
                strokeDasharray={style.dash}
                strokeLinecap="round"
                markerEnd={link.arrow === 'end' ? marker : undefined}
                markerStart={link.arrow === 'start' ? marker : undefined}
                pointerEvents="none"
              />
            </g>
          )
        })}
      </g>
      {readingOrder.map((node) => (
        <ConceptNodeMark
          key={node.concept_id}
          node={node}
          dimmed={focusSet ? !focusSet.has(node.concept_id) : false}
          current={node.concept_id === currentConceptId}
          selected={node.concept_id === selected}
          label={`${node.order ?? ''}. ${node.name}${node.role ? `, ${roleLabel(node.role)}` : ''}${node.testable_here ? ', testable here' : ''}${canOpen(node) ? '. Select twice to open its claim card' : ''}`}
          onEnter={() => setHovered({ node: node.concept_id })}
          onFocus={() => setHovered({ node: node.concept_id })}
          onBlur={() => setHovered(null)}
          onActivate={() => activate(node)}
          onKey={(event) => onKey(event, node)}
        />
      ))}
    </svg>
  )

  return (
    <div ref={ref} className={cx('min-w-0 space-y-3 [contain:inline-size]', className)} data-concept-map="">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {view === 'map' ? 'Select a concept to see what it needs and unlocks.' : 'Concepts in the order the paper explains them, with what each needs and unlocks.'}
        </p>
        <ViewSwitch view={view} onChange={setView} />
      </div>
      {view === 'map' ? (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <DiagramFrame contentWidth={layout.width * scale} available={width} className="max-w-full" focusX={current ? (current.x + current.width / 2) * scale : null}>
            {svg}
          </DiagramFrame>
          <div className={beside ? 'min-w-[240px] flex-1 space-y-3' : 'grid w-full items-start gap-3 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'}>
            <FocusInfo
              heightClass={beside ? 'h-44' : 'h-32'}
              map={map}
              active={active}
              bundles={bundles}
              currentConceptId={currentConceptId}
              onOpen={onSelect}
              pinned={!hovered && selected !== null}
              onClear={() => setSelected(null)}
            />
            <Legend roles={roles} relations={relations} testable={layout.nodes.some((node) => node.testable_here)} current={currentConceptId != null} />
          </div>
        </div>
      ) : (
        <ConceptList map={map} nodes={readingOrder} currentConceptId={currentConceptId} onOpen={onSelect} />
      )}
      {showBundles && bundles.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold text-muted">Combined results</h4>
          <ul className="space-y-1.5" onMouseLeave={() => setHovered(null)}>
            {bundles.map((bundle, index) => (
              <BundleRow
                key={`${bundle.name}-${index}`}
                bundle={bundle}
                active={!!active && 'bundle' in active && active.bundle === index}
                onActivate={() => setHovered({ bundle: index })}
                onDeactivate={() => setHovered(null)}
              />
            ))}
          </ul>
        </div>
      )}
      {tooltip.tooltip}
    </div>
  )
}

function ViewSwitch({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const options: [View, string, ReactNode][] = [
    ['map', 'Map', <GraphIcon key="m" size={14} />],
    ['list', 'List', <ListIcon key="l" size={14} />],
  ]
  return (
    <div className="inline-flex rounded-md border border-line bg-canvas-subtle p-0.5 text-xs font-medium" role="group" aria-label="Show the concepts as">
      {options.map(([value, label, icon]) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => onChange(value)}
          className={cx('inline-flex min-h-7 items-center gap-1 rounded px-2.5', view === value ? 'bg-canvas text-fg shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg')}
        >
          {icon}
          {label}
        </button>
      ))}
    </div>
  )
}

function ConceptNodeMark({ node, dimmed, current, selected, label, onEnter, onFocus, onBlur, onActivate, onKey }: {
  node: PlacedConcept
  dimmed: boolean
  current: boolean
  selected: boolean
  label: string
  onEnter: () => void
  onFocus: () => void
  onBlur: () => void
  onActivate: () => void
  onKey: (event: KeyboardEvent) => void
}) {
  const style = roleStyle(node.role)
  return (
    <g
      tabIndex={0}
      role="button"
      aria-label={label}
      aria-pressed={selected}
      className="cursor-pointer outline-none [&:focus-visible>rect.ring]:opacity-100"
      opacity={dimmed ? 0.35 : 1}
      style={{ transition: 'opacity 120ms' }}
      onMouseEnter={onEnter}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={onActivate}
      onKeyDown={onKey}
    >
      <rect className="ring" x={node.x - 4} y={node.y - 4} width={node.width + 8} height={node.height + 8} rx={12} fill="none" stroke="#0969da" strokeWidth={2} opacity={selected ? 1 : 0} />
      {current && !selected && (
        <rect x={node.x - 4} y={node.y - 4} width={node.width + 8} height={node.height + 8} rx={12} fill="none" stroke="#0969da" strokeWidth={1.5} strokeDasharray="3 2" />
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
      <text textAnchor="middle" fontSize={CONCEPT_TEXT.fontSize} style={{ fill: 'var(--color-fg)' }} fontWeight={node.role === 'core' || current ? 600 : 500}>
        {node.lines.map((line, i) => (
          <tspan key={i} x={node.x + node.width / 2} y={node.lineY[i]}>
            {line}
          </tspan>
        ))}
      </text>
      {node.order != null && (
        <g>
          <circle cx={node.x + 2} cy={node.y + 2} r={10} fill={node.role === 'core' ? '#0969da' : '#59636e'} stroke="#fff" strokeWidth={1.5} />
          <text x={node.x + 2} y={node.y + 6.2} textAnchor="middle" fontSize={CONCEPT_TEXT.fontSize} fontWeight={700} fill="#fff">
            {node.order}
          </text>
        </g>
      )}
      {node.testable_here && (
        <g>
          <circle cx={node.x + node.width - 2} cy={node.y + 2} r={7} fill="#1a7f37" stroke="#fff" strokeWidth={1.5} />
          <path d={`M ${node.x + node.width - 5} ${node.y + 2} l 2 2.2 l 4 -4.4`} fill="none" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
    </g>
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
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-xs leading-none font-bold text-white tabular-nums',
        node.role === 'core' ? 'bg-info' : 'bg-muted',
        className,
      )}
      aria-hidden="true"
    >
      {node.order}
    </span>
  )
}

/** Order badge with the concept's name in a tooltip (hover, focus or tap). */
function NamedBadge({ node, className }: { node: Pick<ConceptNode, 'order' | 'role' | 'name'>; className?: string }) {
  if (node.order == null) return null
  return (
    <Tooltip content={node.name} className="inline-flex rounded-full">
      <OrderBadge node={node} className={className} />
      <span className="sr-text">{`${node.order}. ${node.name}`}</span>
    </Tooltip>
  )
}

function NodeDetails({ map, node, currentConceptId, onOpen, onClear }: {
  map: ConceptMapData
  node: ConceptNode
  currentConceptId?: number | null
  onOpen?: (node: ConceptNode) => void
  /** Shown when the concept is pinned (selected), to unselect it. */
  onClear?: () => void
}) {
  const links = neighbours(map, node.concept_id)
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <OrderBadge node={node} />
        <span className="font-semibold text-fg">{node.name}</span>
        {node.role && <span className="text-xs text-muted">{roleLabel(node.role)}</span>}
        {node.testable_here && (
          <span className="inline-flex items-center gap-0.5 text-xs text-positive">
            <CheckIcon size={12} /> Testable here
          </span>
        )}
        {onOpen && node.claim_id && node.concept_id !== currentConceptId && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => onOpen(node)}>
            Open claim card →
          </Button>
        )}
        {node.concept_id === currentConceptId && <span className="ml-auto text-xs font-medium text-info-fg">This claim</span>}
        {onClear && (
          <Button size="sm" variant="invisible" className={cx(!(onOpen && node.claim_id) && node.concept_id !== currentConceptId && 'ml-auto')} onClick={onClear}>
            Clear
          </Button>
        )}
      </div>
      {node.headline && <p className="text-muted">{node.headline}</p>}
      {links.length > 0 && (
        <ul className="space-y-0.5">
          {links.map((item, index) => (
            <li key={index}>
              <span className="font-medium text-fg">{item.phrase}</span> <OrderBadge node={item.node} className="mx-0.5 align-[-4px]" /> {shortName(item.node.name, 48)}
              {item.why && <span className="text-muted">: {item.why}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Details of the hovered, focused or selected concept. Fixed height (scrolls inside) so nothing below it moves. */
function FocusInfo({ map, active, bundles, currentConceptId, onOpen, pinned, onClear, heightClass }: {
  heightClass: string
  map: ConceptMapData
  active: Active
  bundles: ConceptBundle[]
  currentConceptId?: number | null
  onOpen?: (node: ConceptNode) => void
  pinned: boolean
  onClear: () => void
}) {
  let content: ReactNode = null
  if (active && 'node' in active) {
    const node = map.nodes.find((item) => item.concept_id === active.node)
    content = node && <NodeDetails map={map} node={node} currentConceptId={currentConceptId} onOpen={onOpen} onClear={pinned ? onClear : undefined} />
  } else if (active && 'bundle' in active) {
    const bundle = bundles[active.bundle]
    content = bundle && (
      <p>
        <span className="font-semibold text-fg">{bundle.name}:</span> <span className="text-muted">{bundle.effect || 'The paper gives no number for this combination.'}</span>
      </p>
    )
  }
  return (
    <div className={cx('overflow-y-auto rounded-md bg-canvas-subtle px-3 py-2 text-sm', heightClass)} aria-live="polite" role="region" aria-label="Concept details" tabIndex={0}>
      {content ?? <p className="text-xs text-muted">Select a concept to see what it needs and unlocks. Select it again, or use “Open claim card”, to read its claim.</p>}
    </div>
  )
}

/** Readable list of the map (narrow screens, or by choice): reading order, role, and what each needs and unlocks. */
function ConceptList({ map, nodes, currentConceptId, onOpen }: { map: ConceptMapData; nodes: PlacedConcept[]; currentConceptId?: number | null; onOpen?: (node: ConceptNode) => void }) {
  return (
    <ol className="space-y-2" aria-label="Concepts in reading order">
      {nodes.map((node) => {
        const links = neighbours(map, node.concept_id)
        const grouped = new Map<string, ConceptNode[]>()
        for (const item of links) grouped.set(item.phrase, [...(grouped.get(item.phrase) ?? []), item.node])
        const current = node.concept_id === currentConceptId
        return (
          <li key={node.concept_id} className={cx('rounded-md border px-3 py-2 text-sm', current ? 'border-info bg-info-subtle/40' : 'border-line-muted')}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <OrderBadge node={node} />
              <span className="font-semibold text-fg">{node.name}</span>
              {node.role && <span className="text-xs text-muted">{roleLabel(node.role)}</span>}
              {node.testable_here && (
                <span className="inline-flex items-center gap-0.5 text-xs text-positive">
                  <CheckIcon size={12} /> Testable here
                </span>
              )}
              {current && <span className="text-xs font-medium text-info-fg">This claim</span>}
            </div>
            {node.headline && <p className="mt-0.5 text-muted">{node.headline}</p>}
            {grouped.size > 0 && (
              <dl className="mt-1 space-y-0.5 text-xs">
                {[...grouped].map(([phrase, others]) => (
                  <div key={phrase} className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <dt className="font-medium text-fg">{phrase}:</dt>
                    {others.map((other) => (
                      <dd key={other.concept_id} className="inline-flex items-center gap-1 text-muted">
                        <OrderBadge node={other} /> {shortName(other.name, 40)}
                      </dd>
                    ))}
                  </div>
                ))}
              </dl>
            )}
            {onOpen && node.claim_id && !current && (
              <button type="button" className="mt-1 text-xs font-medium text-accent hover:underline" onClick={() => onOpen(node)}>
                Open claim card →
              </button>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function Legend({ roles, relations, testable, current }: { roles: string[]; relations: string[]; testable: boolean; current: boolean }) {
  if (!roles.length && !relations.length) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted" aria-label="Legend">
      {roles.map((role) => {
        const style = roleStyle(role)
        return (
          <span key={role} className="inline-flex items-center gap-1.5">
            <svg width="18" height="11" aria-hidden="true">
              <rect x="1" y="1" width="16" height="9" rx="3" fill={style.fill} stroke={style.stroke} strokeWidth={style.width} strokeDasharray={style.dash ? '3 1.5' : undefined} />
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
              <line x1="1" y1="5" x2={info.directed ? 18 : 23} y2="5" stroke={style.stroke} strokeWidth={style.width + 0.2} strokeDasharray={style.dash} strokeLinecap="round" />
              {info.directed && <path d="M17,1.5 L23,5 L17,8.5 z" fill={style.stroke} />}
            </svg>
            {info.label}
          </span>
        )
      })}
      {testable && (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex size-3.5 items-center justify-center rounded-full bg-positive-emphasis text-white" aria-hidden="true">
            <CheckIcon size={10} />
          </span>
          Testable on your hardware
        </span>
      )}
      {current && (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-5 rounded-sm border-[1.5px] border-dashed border-info" aria-hidden="true" /> This claim
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
      className={cx('rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent', bundle.is_headline_result ? 'border-line' : 'border-line-muted', active && 'ring-1 ring-accent/40')}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {bundle.is_headline_result && <span className="rounded-full bg-neutral-subtle px-2 py-0.5 text-xs font-semibold text-fg">Headline result</span>}
        <span className="font-medium text-fg">{bundle.name}</span>
        <span className="inline-flex flex-wrap items-center gap-0.5" aria-label={`Combines ${members.map((member) => member.name).join(', ')}`}>
          {members.map((member, index) => (
            <span key={member.concept_id} className="inline-flex items-center gap-0.5">
              {index > 0 && (
                <span className="text-muted" aria-hidden="true">
                  +
                </span>
              )}
              <NamedBadge node={member} />
            </span>
          ))}
        </span>
        {effect && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-line bg-canvas-subtle px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-fg tabular-nums">
            <PaperIcon size={12} className="text-muted" />
            <span className="sr-text">Paper reports </span>
            {effect}
          </span>
        )}
      </div>
      {bundle.effect && <p className="mt-0.5 text-xs text-muted">{bundle.effect}</p>}
    </li>
  )
}

/** The paper's suggested reading path, with concept references shown as reading-order badges. */
export function ConceptReadingPath({ map }: { map: Pick<ConceptMapData, 'reading_path' | 'nodes'> }) {
  if (!map.reading_path) return null
  return (
    <p className="flex gap-2 text-sm text-fg">
      <BookIcon size={15} className="mt-0.5 shrink-0 text-muted" />
      <span>
        <span className="font-medium">Reading path:</span>{' '}
        {readingPathParts(map.reading_path, map.nodes).map((part, index) =>
          typeof part === 'string' ? <span key={index}>{part}</span> : <NamedBadge key={index} node={part.node} className="align-[-4px]" />,
        )}
      </span>
    </p>
  )
}

/** "Concept map" card for the paper page (generate / regenerate via the research API). */
export function ConceptMapCard({
  paperId,
  map,
  onSelect,
  actions,
  hideRegenerate = false,
}: {
  paperId: string
  map: ConceptMapData | null | undefined
  onSelect?: (node: ConceptNode) => void
  /** Extra header actions (e.g. a page's own "⋯" menu). */
  actions?: ReactNode
  /** Hide the built-in "Regenerate" action (when the page offers it elsewhere). */
  hideRegenerate?: boolean
}) {
  const generate = useGenerateConceptMap()
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  if (!map || map.nodes.length < 2) return null
  const run = () =>
    generate.mutate(paperId, {
      onSuccess: () => {
        setConfirming(false)
        toast.success('Concept map ready')
      },
      onError: (error) => toast.error(errorMessage(error)),
    })
  const title = (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <SparkIcon className="text-accent" /> Concept map
      <span className="text-xs font-normal text-muted">{map.nodes.length} concepts, in the order the paper explains them</span>
    </span>
  )
  if (!map.generated)
    return (
      <Card title={title} id="concept-map" actions={actions}>
        <div className="space-y-2 text-sm">
          <p className="text-muted">
            These concepts are not isolated: some need others first, some only reach the paper’s headline result together. Map how they connect to see what to
            implement first.
          </p>
          <Button size="sm" variant="outline" icon={<SparkIcon size={14} />} loading={generate.isPending} onClick={run}>
            {generate.isPending ? 'Mapping concepts… (about 20 s)' : 'Map how these concepts connect'}
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
        actions || !hideRegenerate ? (
          <>
            {actions}
            {!hideRegenerate && (
              <Button size="sm" variant="invisible" loading={generate.isPending} onClick={() => setConfirming(true)}>
                {generate.isPending ? 'Mapping… (about 20 s)' : 'Regenerate…'}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      <div className="space-y-3">
        <ConceptReadingPath map={map} />
        {generate.error ? <InlineError error={generate.error} /> : null}
        <ConceptMapGraph map={map} onSelect={onSelect} />
      </div>
      {!hideRegenerate && (
        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          onConfirm={run}
          title="Map the concepts again?"
          confirmLabel="Map again"
          loading={generate.isPending}
          error={generate.error}
          cost="Asks the model again · about 20 seconds"
        >
          <p>Replaces the current concept map for this paper.</p>
        </ConfirmDialog>
      )}
    </Card>
  )
}
