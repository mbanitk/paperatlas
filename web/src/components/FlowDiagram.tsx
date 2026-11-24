import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FlowDiagramData } from '../api/types'
import { compareFlows, FULL_METRICS, layoutFlow, MINI_METRICS, VERTICAL_METRICS, wrapLabel, type FlowLayout, type LaidOutNode, type NodeStatus } from '../lib/flow'
import { GLYPHS, type GlyphName } from './Icons'
import { cx } from './ui'

/** Subtle per-kind colours (fill, stroke) — GitHub Primer-like tints. */
export const KIND_COLORS: Record<string, { fill: string; stroke: string; label: string }> = {
  input: { fill: '#f6f8fa', stroke: '#8c959f', label: 'input' },
  model: { fill: '#fbefff', stroke: '#a475f9', label: 'model' },
  step: { fill: '#ddf4ff', stroke: '#54aeff', label: 'step' },
  decision: { fill: '#fff8c5', stroke: '#d4a72c', label: 'decision' },
  memory: { fill: '#d8f6f0', stroke: '#33b3ae', label: 'memory / cache' },
  output: { fill: '#dafbe1', stroke: '#4ac26b', label: 'output' },
  hardware: { fill: '#eaeef2', stroke: '#6e7781', label: 'hardware' },
  data: { fill: '#fff1e5', stroke: '#fb8f44', label: 'data' },
}
const kindColor = (kind: string) => KIND_COLORS[kind] ?? KIND_COLORS.step

/** Darker per-kind glyph colours (≥ 3:1 on the node tint). */
const KIND_INK: Record<string, string> = {
  input: '#59636e',
  model: '#8250df',
  step: '#0969da',
  decision: '#9a6700',
  memory: '#1b7c83',
  output: '#1a7f37',
  hardware: '#59636e',
  data: '#bc4c00',
}
const KIND_GLYPH: Record<string, GlyphName> = {
  input: 'input',
  model: 'cube',
  step: 'step',
  decision: 'decision',
  memory: 'database',
  output: 'output',
  hardware: 'chip',
  data: 'table',
}
const ACCENT = '#0969da'
const EDGE = '#6e7781'
const LOOP = '#bf8700'
const LOOP_INK = '#9a6700'
const MUTED_INK = '#59636e'

function Shape({ node, mini, status }: { node: LaidOutNode; mini: boolean; status: NodeStatus }) {
  const color = kindColor(node.kind)
  const emphasised = status === 'new' || status === 'changed'
  const stroke = emphasised ? ACCENT : color.stroke
  const strokeWidth = emphasised ? (mini ? 1.6 : 2) : 1
  const dash = status === 'removed' ? '5 3' : undefined
  if (node.kind === 'decision') {
    const { x, y, width: w, height: h } = node
    const inset = mini ? 4 : 12
    const points = `${x + inset},${y} ${x + w - inset},${y} ${x + w},${y + h / 2} ${x + w - inset},${y + h} ${x + inset},${y + h} ${x},${y + h / 2}`
    return <polygon points={points} fill={color.fill} stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} strokeLinejoin="round" />
  }
  const radius = mini ? 4 : node.kind === 'input' || node.kind === 'output' ? node.height / 2 : 10
  return <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={radius} fill={color.fill} stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} />
}

const STATUS_BADGE: Partial<Record<NodeStatus, { text: string; fill: string; ink: string; stroke?: string; width: number }>> = {
  new: { text: 'new', fill: ACCENT, ink: '#ffffff', width: 30 },
  changed: { text: 'changed', fill: '#ffffff', ink: ACCENT, stroke: ACCENT, width: 50 },
  removed: { text: 'removed', fill: '#eff2f5', ink: MUTED_INK, stroke: '#8c959f', width: 50 },
}

/** One node: tinted shape, per-kind glyph, a label wrapped to ≤ 3 lines and a status badge. */
function Node({ node, status, mini }: { node: LaidOutNode; status: NodeStatus; mini: boolean }) {
  const color = kindColor(node.kind)
  const badge = STATUS_BADGE[status]
  const removed = status === 'removed'
  const isDecision = node.kind === 'decision'
  const glyphX = node.x + (isDecision ? 20 : 12)
  const textX = glyphX + 24
  const maxChars = Math.max(8, Math.floor((node.x + node.width - (isDecision ? 14 : 8) - textX) / 6.3))
  const lines = mini ? [] : wrapLabel(node.label, maxChars, 3)
  const lineHeight = 13.5
  const startY = node.y + node.height / 2 - ((lines.length - 1) * lineHeight) / 2 + 4.2
  return (
    <g opacity={removed ? 0.6 : 1}>
      <title>{`${node.label} · ${color.label}${status === 'same' ? '' : ` · ${status}`}`}</title>
      <Shape node={node} mini={mini} status={status} />
      {!mini && (
        <>
          <circle cx={glyphX + 9} cy={node.y + node.height / 2} r={11} fill="#ffffff" stroke={color.stroke} strokeOpacity={0.55} />
          <g transform={`translate(${glyphX + 2} ${node.y + node.height / 2 - 7}) scale(0.875)`} color={KIND_INK[node.kind] ?? KIND_INK.step}>
            <g fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              {GLYPHS[KIND_GLYPH[node.kind] ?? 'step']}
            </g>
          </g>
          <text x={textX} fontSize={11.5} fill="#1f2328" fontWeight={status === 'new' || status === 'changed' ? 600 : 500} textDecoration={removed ? 'line-through' : undefined}>
            {lines.map((line, i) => (
              <tspan key={i} x={textX} y={startY + i * lineHeight}>
                {line}
              </tspan>
            ))}
          </text>
        </>
      )}
      {badge &&
        (mini ? (
          <circle cx={node.x + node.width - 1} cy={node.y + 1} r={2.6} fill={ACCENT} stroke="#fff" strokeWidth={0.8} />
        ) : (
          <g>
            <rect x={node.x + node.width - badge.width - 6} y={node.y - 8} width={badge.width} height={15} rx={7.5} fill={badge.fill} stroke={badge.stroke} strokeWidth={badge.stroke ? 1 : 0} />
            <text x={node.x + node.width - badge.width / 2 - 6} y={node.y + 3} textAnchor="middle" fontSize={9.5} fontWeight={700} fill={badge.ink}>
              {badge.text}
            </text>
          </g>
        ))}
    </g>
  )
}

function Markers({ uid }: { uid: string }) {
  return (
    <defs>
      <marker id={`${uid}-a`} viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
        <path d="M0,0.5 L8,4 L0,7.5 z" fill={EDGE} />
      </marker>
      <marker id={`${uid}-l`} viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
        <path d="M0,0.5 L8,4 L0,7.5 z" fill={LOOP} />
      </marker>
    </defs>
  )
}

/** Edges, nodes and edge labels of one laid-out diagram (labels last so they sit on top). */
function DiagramBody({ layout, uid, mini, statusOf, dimEdges = false }: {
  layout: FlowLayout
  uid: string
  mini: boolean
  statusOf: (node: LaidOutNode) => NodeStatus
  dimEdges?: boolean
}) {
  return (
    <>
      <g fill="none" opacity={dimEdges ? 0.75 : 1}>
        {layout.edges.map((edge, index) => {
          const loop = edge.route === 'loop'
          return (
            <path
              key={index}
              d={edge.path}
              stroke={loop ? LOOP : EDGE}
              strokeWidth={mini ? 0.9 : 1.5}
              strokeDasharray={edge.style === 'skip' ? (mini ? '2 2' : '5 4') : undefined}
              markerEnd={mini ? undefined : `url(#${uid}-${loop ? 'l' : 'a'})`}
              opacity={mini ? 0.8 : 1}
            />
          )
        })}
      </g>
      {layout.nodes.map((node) => (
        <Node key={node.id} node={node} status={statusOf(node)} mini={mini} />
      ))}
      {!mini &&
        layout.edges
          .filter((edge) => edge.labelLines.length)
          .map((edge, index) => (
            <text
              key={`label-${index}`}
              x={edge.labelX}
              y={edge.labelY}
              textAnchor={edge.labelAnchor}
              transform={edge.labelRotate ? `rotate(${edge.labelRotate} ${edge.labelX} ${edge.labelY})` : undefined}
              fontSize={10}
              fontWeight={500}
              fill={edge.route === 'loop' ? LOOP_INK : MUTED_INK}
              stroke="#fff"
              strokeWidth={4}
              strokeLinejoin="round"
              paintOrder="stroke"
            >
              {edge.labelLines.map((line, i) => (
                <tspan key={i} x={edge.labelX} y={edge.labelY + i * 11}>
                  {line}
                </tspan>
              ))}
            </text>
          ))}
    </>
  )
}

function Swatch({ children, label }: { children: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      {label}
    </span>
  )
}

/** Legend under a diagram: only the marks that actually appear. */
function Legend({ statuses, loops, skips, title }: { statuses: Set<NodeStatus>; loops: boolean; skips: boolean; title?: string }) {
  if (!title && !statuses.size && !loops && !skips) return null
  return (
    <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted">
      {title && <span className="font-medium text-fg">{title}</span>}
      {statuses.has('new') && (
        <Swatch label="new step">
          <span className="rounded-full bg-accent px-1.5 text-[10px] leading-4 font-bold text-white" aria-hidden="true">
            new
          </span>
        </Swatch>
      )}
      {statuses.has('changed') && (
        <Swatch label="existing step, changed">
          <span className="inline-block h-3 w-5 rounded-sm border-2 border-accent bg-canvas" aria-hidden="true" />
        </Swatch>
      )}
      {statuses.has('removed') && (
        <Swatch label="no longer needed">
          <span className="inline-block h-3 w-5 rounded-sm border border-dashed border-subtle bg-canvas-inset" aria-hidden="true" />
        </Swatch>
      )}
      {loops && (
        <Swatch label="repeats (loop)">
          <span className="inline-block h-0.5 w-5 rounded bg-attention-emphasis" aria-hidden="true" />
        </Swatch>
      )}
      {skips && (
        <Swatch label="sometimes skipped">
          <span className="inline-block w-5 border-t-2 border-dashed border-muted" aria-hidden="true" />
        </Swatch>
      )}
    </figcaption>
  )
}

/** Scroll box that keeps labels readable: the SVG never shrinks below `minScale` of its natural size. */
function ScrollBox({ width, height, children, labelledBy, minScale = 0.7 }: { width: number; height: number; children: ReactNode; labelledBy: string; minScale?: number }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1 pt-2 pb-1" tabIndex={0} role="group" aria-label="Diagram (scrolls sideways on small screens)">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ maxWidth: width, minWidth: Math.round(width * minScale), display: 'block' }}
        role="img"
        aria-labelledby={labelledBy}
        className="h-auto overflow-visible"
      >
        {children}
      </svg>
    </div>
  )
}

/** Below this container width diagrams switch to a top-to-bottom layout. */
const NARROW_WIDTH = 560

/** True when the element is narrower than NARROW_WIDTH (tracked with a ResizeObserver). */
function useNarrow<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => setNarrow(element.getBoundingClientRect().width < NARROW_WIDTH)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, narrow]
}

export interface FlowDiagramProps {
  diagram: FlowDiagramData | null | undefined
  variant?: 'full' | 'mini'
  className?: string
  /** Show the title and the "new" legend under a full diagram. */
  showCaption?: boolean
}

/**
 * Left-to-right flow diagram (≤ 8 nodes): layered layout, per-kind tint and glyph, decisions as hexagons,
 * nodes the technique adds/changes with an accent border and a "new" tag, dashed skip edges and a curved
 * return arrow for loops. Scrolls horizontally on narrow screens instead of shrinking the text.
 */
export function FlowDiagram({ diagram, variant = 'full', className, showCaption = true }: FlowDiagramProps) {
  const mini = variant === 'mini'
  const [ref, narrow] = useNarrow<HTMLElement>()
  const vertical = !mini && narrow
  const layout = useMemo(
    () => layoutFlow(diagram, mini ? MINI_METRICS : vertical ? VERTICAL_METRICS : FULL_METRICS, { orientation: vertical ? 'vertical' : 'horizontal' }),
    [diagram, mini, vertical],
  )
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  const title = diagram?.title?.trim() || 'How it works'
  const order = [...layout.nodes].sort((a, b) => a.layer - b.layer || a.row - b.row)
  const description = order.map((node) => `${node.label}${node.highlight ? ' (new)' : ''}`).join(' → ')
  const statusOf = (node: LaidOutNode): NodeStatus => (node.highlight ? 'new' : 'same')
  const content = (
    <>
      <title id={`${uid}-t`}>{title}</title>
      <desc id={`${uid}-d`}>{description}</desc>
      {!mini && <Markers uid={uid} />}
      <DiagramBody layout={layout} uid={uid} mini={mini} statusOf={statusOf} />
    </>
  )

  if (mini)
    return layout.nodes.length ? (
      <figure className={cx('m-0 min-w-0', className)}>
        <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width="100%" style={{ maxWidth: layout.width * 1.5, display: 'block' }} role="img" aria-labelledby={`${uid}-t ${uid}-d`} className="h-auto overflow-visible">
          {content}
        </svg>
      </figure>
    ) : null

  return (
    <figure ref={ref} className={cx('m-0 min-w-0', className)} hidden={!layout.nodes.length}>
      {layout.nodes.length > 0 && (
        <ScrollBox width={layout.width} height={layout.height} labelledBy={`${uid}-t ${uid}-d`} minScale={vertical ? 0.72 : 0.7}>
          {content}
        </ScrollBox>
      )}
      {showCaption && layout.nodes.length > 0 && (
        <Legend
          title={diagram?.title}
          statuses={new Set(layout.nodes.filter((node) => node.highlight).map(() => 'new' as const))}
          loops={layout.edges.some((edge) => edge.route === 'loop')}
          skips={layout.edges.some((edge) => edge.style === 'skip')}
        />
      )}
    </figure>
  )
}

const LANE_HEADER = 30
const LANE_GAP = 22

/**
 * "Today" vs "With <technique>": both flows on one column grid so shared steps line up. New steps get a
 * "new" badge, changed ones an accent border, steps the technique drops are ghosted.
 */
export function FlowComparisonDiagram({ before, after, techniqueLabel, className }: {
  before: FlowDiagramData
  after: FlowDiagramData
  techniqueLabel: string
  className?: string
}) {
  const comparison = useMemo(() => compareFlows(before, after), [before, after])
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const [ref, narrow] = useNarrow<HTMLElement>()
  const [lane, setLane] = useState<'today' | 'next'>('next')
  const verticalLane = useMemo(
    () => (narrow ? layoutFlow(lane === 'today' ? before : after, VERTICAL_METRICS, { orientation: 'vertical' }) : null),
    [narrow, lane, before, after],
  )
  const { before: today, after: next } = comparison
  if (!today.nodes.length || !next.nodes.length) return null

  const width = Math.max(today.width, next.width)
  const secondTop = LANE_HEADER + today.height + LANE_GAP
  const height = secondTop + LANE_HEADER + next.height
  const describe = (layout: FlowLayout, statuses: Map<string, NodeStatus>) =>
    [...layout.nodes]
      .sort((a, b) => a.layer - b.layer || a.row - b.row)
      .map((node) => `${node.label}${statuses.get(node.id) && statuses.get(node.id) !== 'same' ? ` (${statuses.get(node.id)})` : ''}`)
      .join(' → ')
  const afterTitle = `With ${techniqueLabel}`
  const statuses = new Set<NodeStatus>([...comparison.afterStatus.values(), ...comparison.beforeStatus.values()].filter((status) => status !== 'same'))
  const allEdges = [...today.edges, ...next.edges]

  const laneHeader = (y: number, label: string, tone: 'muted' | 'accent', caption?: string) => (
    <g>
      <rect x={0} y={y + 3} width={label.length * 6.9 + 22} height={21} rx={10.5} fill={tone === 'accent' ? '#ddf4ff' : '#eff2f5'} />
      <text x={11} y={y + 17.5} fontSize={11.5} fontWeight={700} fill={tone === 'accent' ? '#0757b8' : MUTED_INK}>
        {label}
      </text>
      {caption && (
        <text x={label.length * 6.9 + 32} y={y + 17.5} fontSize={11} fill={MUTED_INK}>
          {caption}
        </text>
      )}
    </g>
  )

  const afterTitleText = after.title?.trim() && after.title.trim() !== techniqueLabel ? after.title.trim() : undefined

  if (narrow && verticalLane) {
    const statusMap = lane === 'today' ? comparison.beforeStatus : comparison.afterStatus
    const laneStatus = (node: LaidOutNode): NodeStatus => {
      const status = statusMap.get(node.id) ?? 'same'
      return lane === 'today' ? (status === 'removed' ? 'removed' : 'same') : status
    }
    const laneLabel = lane === 'today' ? 'Today' : afterTitle
    return (
      <figure ref={ref} className={cx('m-0 min-w-0', className)}>
        <div className="mb-1 inline-flex max-w-full rounded-md border border-line bg-canvas-subtle p-0.5 text-xs font-medium" role="group" aria-label="Which flow to show">
          {(
            [
              ['today', 'Today'],
              ['next', afterTitle],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={lane === value}
              title={label}
              onClick={() => setLane(value)}
              className={cx('truncate rounded px-2.5 py-1', value === 'today' ? 'shrink-0' : 'min-w-0', lane === value ? 'bg-canvas text-fg shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg')}
            >
              {label}
            </button>
          ))}
        </div>
        <ScrollBox width={verticalLane.width} height={verticalLane.height} labelledBy={`${uid}-t ${uid}-d`} minScale={0.72}>
          <title id={`${uid}-t`}>{laneLabel}</title>
          <desc id={`${uid}-d`}>{describe(verticalLane, statusMap)}</desc>
          <Markers uid={uid} />
          <DiagramBody layout={verticalLane} uid={uid} mini={false} statusOf={laneStatus} />
        </ScrollBox>
        <Legend statuses={statuses} loops={allEdges.some((edge) => edge.route === 'loop')} skips={allEdges.some((edge) => edge.style === 'skip')} />
      </figure>
    )
  }

  return (
    <figure ref={ref} className={cx('m-0 min-w-0', className)}>
      <ScrollBox width={width} height={height} labelledBy={`${uid}-t ${uid}-d`}>
        <title id={`${uid}-t`}>{`How the flow changes: today vs ${afterTitle.toLowerCase()}`}</title>
        <desc id={`${uid}-d`}>{`Today: ${describe(today, comparison.beforeStatus)}. ${afterTitle}: ${describe(next, comparison.afterStatus)}.`}</desc>
        <Markers uid={uid} />
        {laneHeader(0, 'Today', 'muted', before.title?.trim() || undefined)}
        <g transform={`translate(0 ${LANE_HEADER})`}>
          <DiagramBody layout={today} uid={uid} mini={false} statusOf={(node) => (comparison.beforeStatus.get(node.id) === 'removed' ? 'removed' : 'same')} dimEdges />
        </g>
        <line x1={0} x2={width} y1={LANE_HEADER + today.height + LANE_GAP / 2} y2={LANE_HEADER + today.height + LANE_GAP / 2} stroke="#d1d9e0" strokeDasharray="3 4" />
        {laneHeader(secondTop, afterTitle, 'accent', afterTitleText)}
        <g transform={`translate(0 ${secondTop + LANE_HEADER})`}>
          <DiagramBody layout={next} uid={uid} mini={false} statusOf={(node) => comparison.afterStatus.get(node.id) ?? 'same'} />
        </g>
      </ScrollBox>
      <Legend statuses={statuses} loops={allEdges.some((edge) => edge.route === 'loop')} skips={allEdges.some((edge) => edge.style === 'skip')} />
    </figure>
  )
}

/** Labels of the nodes a technique adds or changes ("Adds: Draft block · Confidence gate"). */
export function changedNodes(diagram: FlowDiagramData | null | undefined): string[] {
  return (diagram?.nodes ?? []).filter((node) => node?.highlight && node.label).map((node) => node.label)
}
