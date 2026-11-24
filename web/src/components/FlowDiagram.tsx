import { autoUpdate, FloatingArrow, FloatingPortal, useFloating } from '@floating-ui/react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type MouseEvent, type ReactNode } from 'react'
import type { FlowDiagramData } from '../api/types'
import { formatMath } from '../lib/format'
import { compareFlows, FLOW_TEXT, FULL_METRICS, layoutFlow, MINI_METRICS, VERTICAL_METRICS, type FlowLayout, type LaidOutEdge, type LaidOutNode, type NodeStatus } from '../lib/flow'
import { MIN_DIAGRAM_SCALE } from '../lib/textMeasure'
import { fitScale, useElementWidth } from '../lib/useElementWidth'
import { ArrowRightIcon, GLYPHS, type GlyphName } from './Icons'
import { floatingMiddleware } from './Tooltip'
import { cx } from './ui'

/**
 * Per-kind label, kept for compatibility. Kinds are told apart by their glyph and shape (decisions are
 * hexagons, inputs/outputs pills), not by colour: colour in a diagram means only "what the technique adds or
 * changes" (info blue), so it can't be mistaken for an outcome (docs/ux-review.md §2.5).
 */
export const KIND_COLORS: Record<string, { fill: string; stroke: string; label: string }> = {
  input: { fill: '#ffffff', stroke: '#8c959f', label: 'input' },
  model: { fill: '#ffffff', stroke: '#8c959f', label: 'model' },
  step: { fill: '#ffffff', stroke: '#8c959f', label: 'step' },
  decision: { fill: '#ffffff', stroke: '#8c959f', label: 'decision' },
  memory: { fill: '#ffffff', stroke: '#8c959f', label: 'memory / cache' },
  output: { fill: '#ffffff', stroke: '#8c959f', label: 'output' },
  hardware: { fill: '#ffffff', stroke: '#8c959f', label: 'hardware' },
  data: { fill: '#ffffff', stroke: '#8c959f', label: 'data' },
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

/** Paint from the design tokens (index.css). Presentation attributes can't take var(), so these go in `style`. */
const C = {
  ink: 'var(--color-fg)',
  muted: 'var(--color-muted)',
  line: 'var(--color-line)',
  lineMuted: 'var(--color-line-muted)',
  edge: 'var(--color-neutral-emphasis)',
  canvas: 'var(--color-canvas)',
  canvasSubtle: 'var(--color-canvas-subtle)',
  info: 'var(--color-info)',
  infoFg: 'var(--color-info-fg)',
  infoSubtle: 'var(--color-info-subtle)',
  neutralSubtle: 'var(--color-neutral-subtle)',
} as const
const NODE_STROKE = '#8c959f'

// ---- shared pieces (also used by ConceptMap) ------------------------------------------------------------

/**
 * Hover/focus tooltip for SVG marks, rendered in a portal with the foundation's floating middleware (flip,
 * shift, header- and action-bar-aware). `bind(content)` gives the props for the mark; render `tooltip` once.
 */
export function useSvgTooltip() {
  const [state, setState] = useState<{ content: ReactNode; element: Element } | null>(null)
  const arrowRef = useRef<SVGSVGElement>(null)
  const { refs, floatingStyles, context, middlewareData } = useFloating({
    open: !!state,
    placement: 'top',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: floatingMiddleware(arrowRef),
    elements: { reference: state?.element ?? null },
  })
  useEffect(() => {
    if (!state) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setState(null)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [state])
  const show = (element: Element, content: ReactNode) => setState({ element, content })
  const hide = () => setState(null)
  const bind = (content: ReactNode) => ({
    onMouseEnter: (event: MouseEvent<Element>) => show(event.currentTarget, content),
    onMouseLeave: hide,
    onFocus: (event: FocusEvent<Element>) => show(event.currentTarget, content),
    onBlur: hide,
  })
  const tooltip = state ? (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        role="tooltip"
        data-floating="tooltip"
        style={{ ...floatingStyles, zIndex: 'var(--z-popover)', visibility: middlewareData.hide?.referenceHidden ? 'hidden' : undefined }}
        className="pointer-events-none w-max overflow-auto rounded-md bg-fg px-2.5 py-1.5 text-xs font-medium break-words whitespace-pre-line text-white shadow-lg"
      >
        {state.content}
        <FloatingArrow ref={arrowRef} context={context} width={10} height={5} fill="var(--color-fg)" />
      </div>
    </FloatingPortal>
  ) : null
  return { bind, show, hide, tooltip }
}

/**
 * Box for a diagram drawn at its natural size (or slightly smaller, never below 11 px text). When it's still
 * wider than the container it scrolls sideways, with a hint and keyboard access, instead of shrinking.
 * `focusX` (px from the left of the content) is scrolled into the middle when the box scrolls.
 */
export function DiagramFrame({ contentWidth, available, children, className, focusX }: {
  contentWidth: number
  available: number | null
  children: ReactNode
  className?: string
  focusX?: number | null
}) {
  const scrolls = !!available && contentWidth > available + 1
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = scroller.current
    if (!scrolls || !element || focusX == null) return
    element.scrollLeft = Math.max(0, focusX - element.clientWidth / 2)
  }, [scrolls, focusX])
  return (
    <div className={cx('min-w-0', className)}>
      {scrolls && (
        <p className="mb-1 flex items-center gap-1 text-xs text-muted" aria-hidden="true">
          Scroll sideways to see the whole diagram <ArrowRightIcon size={12} />
        </p>
      )}
      <div
        ref={scroller}
        className={cx('relative max-w-full', scrolls ? 'overflow-x-auto pb-1' : 'overflow-visible')}
        {...(scrolls ? { tabIndex: 0, role: 'region', 'aria-label': 'Diagram (scrolls sideways)' } : {})}
      >
        {children}
      </div>
    </div>
  )
}

// ---- nodes, edges and labels -------------------------------------------------------------------------------

function Shape({ node, mini }: { node: LaidOutNode; mini: boolean }) {
  const status = node.status
  const emphasised = status === 'new' || status === 'changed'
  const style: CSSProperties = {
    fill: emphasised ? C.infoSubtle : status === 'removed' ? C.canvasSubtle : C.canvas,
    stroke: emphasised ? C.info : NODE_STROKE,
  }
  const strokeWidth = emphasised ? (mini ? 1.6 : 2) : 1
  const dash = status === 'removed' ? '5 3' : undefined
  if (node.kind === 'decision') {
    const { x, y, width: w, height: h } = node
    const inset = mini ? 4 : 12
    const points = `${x + inset},${y} ${x + w - inset},${y} ${x + w},${y + h / 2} ${x + w - inset},${y + h} ${x + inset},${y + h} ${x},${y + h / 2}`
    return <polygon points={points} style={style} strokeWidth={strokeWidth} strokeDasharray={dash} strokeLinejoin="round" />
  }
  const radius = mini ? 4 : node.kind === 'input' || node.kind === 'output' ? Math.min(node.height / 2, 22) : 10
  return <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={radius} style={style} strokeWidth={strokeWidth} strokeDasharray={dash} />
}

const BADGE_STYLE: Partial<Record<NodeStatus, { fill: string; ink: string; stroke?: string }>> = {
  new: { fill: C.info, ink: '#ffffff' },
  changed: { fill: C.canvas, ink: C.infoFg, stroke: C.info },
  removed: { fill: C.neutralSubtle, ink: C.muted, stroke: NODE_STROKE },
}

/** One node: shape, per-kind glyph, the label (wrapped by measured width) and a status pill in its top-right corner. */
function Node({ node, mini, tooltip }: { node: LaidOutNode; mini: boolean; tooltip?: ReturnType<typeof useSvgTooltip> }) {
  const badge = node.badge
  const badgeStyle = BADGE_STYLE[node.status]
  const removed = node.status === 'removed'
  const focusable = !!(node.truncated && tooltip)
  const content = (
    <>
      {focusable && (
        <rect className="ring" x={node.x - 4} y={node.y - 4} width={node.width + 8} height={node.height + 8} rx={12} fill="none" style={{ stroke: C.info }} strokeWidth={2} opacity={0} />
      )}
      <Shape node={node} mini={mini} />
      {!mini && node.glyph && (
        <>
          <circle cx={node.glyph.x} cy={node.glyph.y} r={10.5} style={{ fill: C.canvas, stroke: C.line }} />
          <g transform={`translate(${node.glyph.x - 7} ${node.glyph.y - 7}) scale(0.875)`} style={{ color: C.muted }}>
            <g fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              {GLYPHS[KIND_GLYPH[node.kind] ?? 'step']}
            </g>
          </g>
        </>
      )}
      {!mini && node.lines.length > 0 && (
        <text x={node.textX} fontSize={FLOW_TEXT.fontSize} fontWeight={node.fontWeight} style={{ fill: removed ? C.muted : C.ink }}>
          {node.lines.map((line, i) => (
            <tspan key={i} x={node.textX} y={node.lineY[i]}>
              {line}
            </tspan>
          ))}
        </text>
      )}
      {badge && badgeStyle && (
        <g>
          <rect x={badge.x} y={badge.y} width={badge.width} height={badge.height} rx={badge.height / 2} style={{ fill: badgeStyle.fill, stroke: badgeStyle.stroke ?? 'none' }} strokeWidth={1} />
          <text x={badge.x + badge.width / 2} y={badge.y + badge.height / 2 + 4.2} textAnchor="middle" fontSize={FLOW_TEXT.fontSize} fontWeight={600} style={{ fill: badgeStyle.ink }}>
            {badge.text}
          </text>
        </g>
      )}
      {mini && node.status !== 'same' && <circle cx={node.x + node.width - 1} cy={node.y + 1} r={2.6} style={{ fill: C.info, stroke: C.canvas }} strokeWidth={0.8} />}
    </>
  )
  // A label cut to fit (rare: > 4 lines) shows in full in a tooltip, on hover and keyboard focus.
  if (focusable && tooltip)
    return (
      <g tabIndex={0} aria-label={formatMath(node.label)} className="outline-none [&:focus-visible>rect.ring]:opacity-100" {...tooltip.bind(formatMath(node.label))}>
        {content}
      </g>
    )
  return <g>{content}</g>
}

function Markers({ uid }: { uid: string }) {
  return (
    <defs>
      <marker id={`${uid}-a`} viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
        <path d="M0,0.5 L8,4 L0,7.5 z" style={{ fill: C.edge }} />
      </marker>
    </defs>
  )
}

function EdgeLabel({ edge }: { edge: LaidOutEdge }) {
  const box = edge.labelBox
  if (!box) return null
  const lineHeight = FLOW_TEXT.edgeLineHeight
  const first = box.y + FLOW_TEXT.pillPadY + FLOW_TEXT.baseline - 0.6
  return (
    <g>
      <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={5} style={{ fill: C.canvas, stroke: C.lineMuted }} strokeWidth={1} />
      <text textAnchor="middle" fontSize={FLOW_TEXT.fontSize} fontWeight={500} style={{ fill: C.muted }}>
        {edge.labelLines.map((line, i) => (
          <tspan key={i} x={box.x + box.width / 2} y={first + i * lineHeight}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  )
}

function Callout({ edge, offset = 0 }: { edge: LaidOutEdge; offset?: number }) {
  if (!edge.calloutBox || !edge.callout) return null
  const cx0 = edge.calloutBox.x + edge.calloutBox.width / 2
  const cy0 = edge.calloutBox.y + edge.calloutBox.height / 2
  return (
    <g>
      <circle cx={cx0} cy={cy0} r={edge.calloutBox.width / 2} style={{ fill: C.canvas, stroke: C.muted }} strokeWidth={1.2} />
      <text x={cx0} y={cy0 + 4.2} textAnchor="middle" fontSize={FLOW_TEXT.fontSize} fontWeight={700} style={{ fill: C.ink }}>
        {edge.callout + offset}
      </text>
    </g>
  )
}

/** Edges, nodes, then edge labels and callouts (labels last so their pills sit over the lines). */
function DiagramBody({ layout, uid, mini, calloutOffset = 0, dimEdges = false, tooltip }: {
  layout: FlowLayout
  uid: string
  mini: boolean
  calloutOffset?: number
  dimEdges?: boolean
  tooltip?: ReturnType<typeof useSvgTooltip>
}) {
  return (
    <>
      <g fill="none" opacity={dimEdges ? 0.8 : 1}>
        {layout.edges.map((edge, index) => (
          <path
            key={index}
            d={edge.path}
            style={{ stroke: C.edge }}
            strokeWidth={mini ? 0.9 : 1.5}
            strokeDasharray={edge.style === 'skip' ? (mini ? '2 2' : '5 4') : undefined}
            markerEnd={mini ? undefined : `url(#${uid}-a)`}
            opacity={mini ? 0.8 : 1}
          />
        ))}
      </g>
      {layout.nodes.map((node) => (
        <Node key={node.id} node={node} mini={mini} tooltip={tooltip} />
      ))}
      {!mini &&
        layout.edges.map((edge, index) => (
          <g key={`label-${index}`}>
            <EdgeLabel edge={edge} />
            <Callout edge={edge} offset={calloutOffset} />
          </g>
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

/** Legend under a diagram: only the marks that actually appear, plus any edge labels drawn as callouts. */
function Legend({ statuses, loops, skips, title, callouts = [] }: {
  statuses: Set<NodeStatus>
  loops: boolean
  skips: boolean
  title?: string
  callouts?: { number: number; label: string }[]
}) {
  if (!title && !statuses.size && !loops && !skips && !callouts.length) return null
  return (
    <figcaption className="mt-2 space-y-1 text-xs text-muted">
      <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {title && <span className="font-medium text-fg">{title}</span>}
        {statuses.has('new') && (
          <Swatch label="New step">
            <span className="rounded-full bg-info px-1.5 text-xs leading-4 font-semibold text-white" aria-hidden="true">
              New
            </span>
          </Swatch>
        )}
        {statuses.has('changed') && (
          <Swatch label="Existing step, changed">
            <span className="inline-block h-3 w-5 rounded-sm border-2 border-info bg-info-subtle" aria-hidden="true" />
          </Swatch>
        )}
        {statuses.has('removed') && (
          <Swatch label="No longer needed">
            <span className="inline-block h-3 w-5 rounded-sm border border-dashed border-muted bg-canvas-subtle" aria-hidden="true" />
          </Swatch>
        )}
        {loops && (
          <Swatch label="Repeats (loop back)">
            <svg width="22" height="12" aria-hidden="true" className="text-muted">
              <path d="M20 2 V6 Q20 10 16 10 H6 Q2 10 2 6 V3" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M2 1 L4.5 5 L-0.5 5 z" fill="currentColor" transform="translate(0.5 0)" />
            </svg>
          </Swatch>
        )}
        {skips && (
          <Swatch label="Sometimes skipped">
            <span className="inline-block w-5 border-t-2 border-dashed border-muted" aria-hidden="true" />
          </Swatch>
        )}
      </span>
      {callouts.length > 0 && (
        <ol className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Edge labels">
          {callouts.map((callout) => (
            <li key={callout.number} className="inline-flex items-center gap-1.5 text-fg">
              <span className="inline-flex size-5 items-center justify-center rounded-full border border-muted text-xs font-bold" aria-hidden="true">
                {callout.number}
              </span>
              <span className="sr-text">Arrow {callout.number}: </span>
              {callout.label}
            </li>
          ))}
        </ol>
      )}
    </figcaption>
  )
}

const statusesOf = (layouts: FlowLayout[]) => new Set(layouts.flatMap((layout) => layout.nodes.map((node) => node.status)).filter((status) => status !== 'same'))

/** Text alternative: the steps in flow order, with what's new or changed, and the edge labels. */
function describeFlow(layout: FlowLayout): string {
  const steps = [...layout.nodes]
    .sort((a, b) => a.layer - b.layer || a.row - b.row)
    .map((node) => `${formatMath(node.label)}${node.status !== 'same' ? ` (${node.status})` : ''}`)
    .join(' → ')
  const labelled = layout.edges.filter((edge) => edge.label?.trim())
  const byId = new Map(layout.nodes.map((node) => [node.id, formatMath(node.label)]))
  const arrows = labelled.map((edge) => `${byId.get(edge.from)} to ${byId.get(edge.to)}: ${formatMath(edge.label!.trim())}${edge.route === 'loop' ? ' (repeats)' : ''}`)
  return arrows.length ? `${steps}. Arrows: ${arrows.join('; ')}.` : steps
}

function Svg({ layout, scale, uid, title, description, children }: { layout: FlowLayout; scale: number; uid: string; title: string; description: string; children: ReactNode }) {
  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={Math.round(layout.width * scale)}
      height={Math.round(layout.height * scale)}
      role="img"
      aria-labelledby={`${uid}-t ${uid}-d`}
      className="block max-w-none overflow-visible"
    >
      <title id={`${uid}-t`}>{title}</title>
      <desc id={`${uid}-d`}>{description}</desc>
      <Markers uid={uid} />
      {children}
    </svg>
  )
}

// ---- FlowDiagram ------------------------------------------------------------------------------------

export interface FlowDiagramProps {
  diagram: FlowDiagramData | null | undefined
  variant?: 'full' | 'mini'
  className?: string
  /** Show the title and the legend under a full diagram. */
  showCaption?: boolean
}

/**
 * Flow diagram (≤ 8 nodes): layered layout, per-kind glyph, decisions as hexagons, steps the technique adds
 * with an accent fill and a "New" pill, dashed skip edges and loops that return outside the rows.
 *
 * Text is 12 px and never renders below 11 px: the diagram is drawn left to right when that fits the
 * container, top to bottom (nodes sized to the container) when it doesn't, and scrolls sideways only as a last
 * resort. Edge labels never overlap nodes, badges or each other.
 */
export function FlowDiagram({ diagram, variant = 'full', className, showCaption = true }: FlowDiagramProps) {
  const mini = variant === 'mini'
  const [ref, width] = useElementWidth<HTMLElement>()
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const tooltip = useSvgTooltip()
  const horizontal = useMemo(() => layoutFlow(diagram, mini ? MINI_METRICS : FULL_METRICS), [diagram, mini])
  const fitsHorizontally = mini || fitScale(horizontal.width, width, MIN_DIAGRAM_SCALE) !== null
  const layout = useMemo(
    () => (fitsHorizontally ? horizontal : layoutFlow(diagram, VERTICAL_METRICS, { orientation: 'vertical', availableWidth: width ?? undefined })),
    [fitsHorizontally, horizontal, diagram, width],
  )

  const title = formatMath(diagram?.title?.trim()) || 'How it works'
  const description = describeFlow(layout)

  if (mini)
    return layout.nodes.length ? (
      <figure className={cx('m-0 min-w-0', className)}>
        <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width="100%" style={{ maxWidth: layout.width * 1.5, display: 'block' }} role="img" aria-labelledby={`${uid}-t ${uid}-d`} className="h-auto overflow-visible">
          <title id={`${uid}-t`}>{title}</title>
          <desc id={`${uid}-d`}>{description}</desc>
          <DiagramBody layout={layout} uid={uid} mini />
        </svg>
      </figure>
    ) : null

  const scale = fitScale(layout.width, width, MIN_DIAGRAM_SCALE) ?? 1
  return (
    <figure ref={ref} className={cx('m-0 min-w-0 [contain:inline-size]', className)} hidden={!layout.nodes.length}>
      {layout.nodes.length > 0 && (
        <DiagramFrame contentWidth={layout.width * scale} available={width} className="pt-1">
          <Svg layout={layout} scale={scale} uid={uid} title={title} description={description}>
            <DiagramBody layout={layout} uid={uid} mini={false} tooltip={tooltip} />
          </Svg>
        </DiagramFrame>
      )}
      {showCaption && layout.nodes.length > 0 && (
        <Legend
          title={diagram?.title ? formatMath(diagram.title) : undefined}
          statuses={statusesOf([layout])}
          loops={layout.edges.some((edge) => edge.route === 'loop')}
          skips={layout.edges.some((edge) => edge.style === 'skip')}
          callouts={layout.callouts}
        />
      )}
      {tooltip.tooltip}
    </figure>
  )
}

// ---- FlowComparisonDiagram -------------------------------------------------------------------------------

function LaneHeader({ label, caption, tone }: { label: string; caption?: string; tone: 'neutral' | 'info' }) {
  return (
    <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      <span className={cx('rounded-full px-2 py-0.5 font-semibold', tone === 'info' ? 'bg-info-subtle text-info-fg' : 'bg-neutral-subtle text-fg')}>{label}</span>
      {caption && <span className="text-muted">{caption}</span>}
    </div>
  )
}

/** Gap between side-by-side lanes; the dashed divider sits in it, so neither lane loses width. */
const LANE_COLUMN_GAP = 24

/**
 * "Usual approach" vs "With <technique>": both flows on one grid so shared steps line up. New steps get a
 * "New" pill, changed ones an accent fill, steps the technique drops are dashed.
 *
 * Wide containers stack the two left-to-right lanes; medium ones put two top-to-bottom lanes side by side
 * (rows aligned); narrow ones show one lane at a time with a switch. Text never renders below 11 px.
 */
export function FlowComparisonDiagram({ before, after, techniqueLabel, className }: {
  before: FlowDiagramData
  after: FlowDiagramData
  techniqueLabel: string
  className?: string
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const [ref, width] = useElementWidth<HTMLElement>()
  const [lane, setLane] = useState<'today' | 'next'>('next')
  const tooltip = useSvgTooltip()

  const stacked = useMemo(() => compareFlows(before, after), [before, after])
  const stackedScale = fitScale(Math.max(stacked.before.width, stacked.after.width), width, MIN_DIAGRAM_SCALE)
  const laneWidth = width ? Math.floor((width - LANE_COLUMN_GAP) / 2) : null
  const sideBySide = useMemo(
    () => (stackedScale === null && laneWidth ? compareFlows(before, after, VERTICAL_METRICS, 'vertical', { availableWidth: laneWidth }) : null),
    [stackedScale, laneWidth, before, after],
  )
  const sideScale = sideBySide ? fitScale(Math.max(sideBySide.before.width, sideBySide.after.width), laneWidth, MIN_DIAGRAM_SCALE) : null
  const single = useMemo(
    () => (stackedScale === null && sideScale === null && width ? compareFlows(before, after, VERTICAL_METRICS, 'vertical', { availableWidth: width }) : null),
    [stackedScale, sideScale, width, before, after],
  )

  const { before: today, after: next } = stacked
  if (!today.nodes.length || !next.nodes.length) return null

  const afterTitle = `With ${formatMath(techniqueLabel)}`
  const beforeCaption = formatMath(before.title?.trim()) || undefined
  const afterCaption = after.title?.trim() && after.title.trim() !== techniqueLabel ? formatMath(after.title.trim()) : undefined
  const layoutsFor = (comparison: typeof stacked) => [comparison.before, comparison.after]
  const legend = (comparison: typeof stacked) => {
    const layouts = layoutsFor(comparison)
    const callouts = [...comparison.before.callouts, ...comparison.after.callouts.map((callout) => ({ ...callout, number: callout.number + comparison.before.callouts.length }))]
    return (
      <Legend
        statuses={statusesOf(layouts)}
        loops={layouts.some((layout) => layout.edges.some((edge) => edge.route === 'loop'))}
        skips={layouts.some((layout) => layout.edges.some((edge) => edge.style === 'skip'))}
        callouts={callouts}
      />
    )
  }
  const svgFor = (comparison: typeof stacked, which: 'today' | 'next', scale: number) => {
    const layout = which === 'today' ? comparison.before : comparison.after
    return (
      <Svg
        layout={layout}
        scale={scale}
        uid={`${uid}-${which}`}
        title={which === 'today' ? `Usual approach${beforeCaption ? `: ${beforeCaption}` : ''}` : `${afterTitle}${afterCaption ? `: ${afterCaption}` : ''}`}
        description={describeFlow(layout)}
      >
        <DiagramBody
          layout={layout}
          uid={`${uid}-${which}`}
          mini={false}
          dimEdges={which === 'today'}
          calloutOffset={which === 'next' ? comparison.before.callouts.length : 0}
          tooltip={tooltip}
        />
      </Svg>
    )
  }

  let body: ReactNode
  if (stackedScale !== null || !width) {
    const scale = stackedScale ?? 1
    body = (
      <>
        <DiagramFrame contentWidth={Math.max(today.width, next.width) * scale} available={width}>
          <div className="space-y-3">
            <div>
              <LaneHeader label="Usual approach" caption={beforeCaption} tone="neutral" />
              {svgFor(stacked, 'today', scale)}
            </div>
            <div className="border-t border-dashed border-line pt-3">
              <LaneHeader label={afterTitle} caption={afterCaption} tone="info" />
              {svgFor(stacked, 'next', scale)}
            </div>
          </div>
        </DiagramFrame>
        {legend(stacked)}
      </>
    )
  } else if (sideBySide && sideScale !== null) {
    body = (
      <>
        <div className="relative grid grid-cols-2 gap-x-6">
          <div className="pointer-events-none absolute inset-y-0 left-1/2 border-l border-dashed border-line" aria-hidden="true" />
          <LaneHeader label="Usual approach" caption={beforeCaption} tone="neutral" />
          <LaneHeader label={afterTitle} caption={afterCaption} tone="info" />
          <div className="min-w-0">{svgFor(sideBySide, 'today', sideScale)}</div>
          <div className="min-w-0">{svgFor(sideBySide, 'next', sideScale)}</div>
        </div>
        {legend(sideBySide)}
      </>
    )
  } else if (single) {
    const layout = lane === 'today' ? single.before : single.after
    const scale = fitScale(layout.width, width, MIN_DIAGRAM_SCALE) ?? 1
    body = (
      <>
        <div className="mb-2 flex w-full gap-0.5 rounded-md border border-line bg-canvas-subtle p-0.5 text-xs font-medium" role="group" aria-label="Which flow to show">
          {(
            [
              ['today', 'Usual approach'],
              ['next', afterTitle],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={lane === value}
              onClick={() => setLane(value)}
              className={cx(
                'min-h-8 min-w-0 rounded px-2.5 py-1 text-left break-words whitespace-normal',
                value === 'today' ? 'shrink-0' : 'flex-1',
                lane === value ? 'bg-canvas text-fg shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {(lane === 'today' ? beforeCaption : afterCaption) && <p className="mb-1 text-xs text-muted">{lane === 'today' ? beforeCaption : afterCaption}</p>}
        <DiagramFrame contentWidth={layout.width * scale} available={width}>
          {svgFor(single, lane, scale)}
        </DiagramFrame>
        {legend(single)}
      </>
    )
  }

  return (
    <figure ref={ref} className={cx('m-0 min-w-0 [contain:inline-size]', className)} aria-label={`How the flow changes: usual approach vs ${afterTitle.toLowerCase()}`}>
      {body}
      {tooltip.tooltip}
    </figure>
  )
}

/** Labels of the nodes a technique adds or changes ("Adds: Draft block · Confidence gate"). */
export function changedNodes(diagram: FlowDiagramData | null | undefined): string[] {
  return (diagram?.nodes ?? []).filter((node) => node?.highlight && node.label).map((node) => node.label)
}
