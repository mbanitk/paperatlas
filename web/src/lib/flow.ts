import type { DiagramEdge, DiagramNode, FlowDiagramData } from '../api/types'
import {
  inflate,
  line,
  mapCubic,
  pathBounds,
  pathD,
  pathLabelCandidates,
  placeLabels,
  roundedPolyline,
  samplePath,
  sCurve,
  unionRect,
  type Cubic,
  type LabelRequest,
  type PathSample,
  type PlacementBounds,
  type Point,
  type Rect,
} from './geometry'
import { DIAGRAM_FONT_SIZE, DIAGRAM_LINE_HEIGHT, measureText, wrapText } from './textMeasure'

/** Geometry of one diagram variant. */
export interface FlowMetrics {
  nodeWidth: number
  /** Minimum node height; nodes grow (all together) to fit their wrapped labels and a status badge. */
  nodeHeight: number
  /** Minimum gap between layers, along the flow (horizontal in left-to-right diagrams, vertical in top-to-bottom ones). */
  gapX: number
  /** Gap between parallel nodes of one layer, across the flow. */
  gapY: number
  padX: number
  padY: number
  /** Room beside the nodes for loops (and skip edges routed around a row). */
  arcRoom: number
}

export const FULL_METRICS: FlowMetrics = { nodeWidth: 136, nodeHeight: 48, gapX: 40, gapY: 22, padX: 8, padY: 8, arcRoom: 18 }
/** Top-to-bottom variant for narrow containers (phones, side columns); node width adapts to the container. */
export const VERTICAL_METRICS: FlowMetrics = { nodeWidth: 176, nodeHeight: 44, gapX: 30, gapY: 18, padX: 8, padY: 8, arcRoom: 18 }
export const MINI_METRICS: FlowMetrics = { nodeWidth: 40, nodeHeight: 16, gapX: 12, gapY: 6, padX: 3, padY: 4, arcRoom: 9 }
/** @deprecated Edge labels are wrapped by measured width now; kept for callers of `wrapLabel`. */
export const EDGE_LABEL_CHARS = 13

/** Label type (rendered size): everything is 12 px at natural size. */
export const FLOW_TEXT = {
  fontSize: DIAGRAM_FONT_SIZE,
  lineHeight: DIAGRAM_LINE_HEIGHT,
  /** Baseline of a line, from the top of its line box. */
  baseline: 11.2,
  edgeLineHeight: 14,
  pillPadX: 5,
  pillPadY: 2,
  badgeHeight: 18,
  badgePadX: 7,
  badgeTop: 5,
  calloutSize: 20,
} as const

const NODE_CLEAR = 6
const LOOP_CLEAR = 18
const CHANNEL_CLEAR = 15
const MIN_VERTICAL_NODE = 96
const MAX_VERTICAL_NODE = 220
const HORIZONTAL_LABEL_MAX = 84
/** Nodes narrower than this drop the kind glyph to keep room for the label. */
const GLYPH_MIN_WIDTH = 124
const HEXAGON_INSET = 12

export type NodeStatus = 'new' | 'changed' | 'same' | 'removed'

const BADGE_TEXT: Partial<Record<NodeStatus, string>> = { new: 'New', changed: 'Changed', removed: 'Removed' }

export interface NodeBadge extends Rect {
  text: string
}

export interface LaidOutNode extends DiagramNode {
  layer: number
  row: number
  x: number
  y: number
  width: number
  height: number
  status: NodeStatus
  /** Label lines (measured wrap, ≤ 4); `truncated` when the last one ends in "…". */
  lines: string[]
  truncated: boolean
  fontWeight: number
  textX: number
  /** Baseline y of each line. */
  lineY: number[]
  /** Box around the label text (for collision checks). */
  textBox: Rect | null
  /** Centre of the per-kind glyph; null when the node is too narrow for it. */
  glyph: Point | null
  /** Status pill inside the node's top-right corner. */
  badge: NodeBadge | null
}

export type EdgeRoute = 'forward' | 'arc' | 'loop'

export interface LaidOutEdge extends DiagramEdge {
  route: EdgeRoute
  path: string
  segments: Cubic[]
  /** Centre of the label box, and the baseline of its first line. */
  labelX: number
  labelY: number
  labelLines: string[]
  labelAnchor: 'start' | 'middle' | 'end'
  /** Always undefined now (labels are never rotated); kept for compatibility. */
  labelRotate?: number
  /** The label's pill, placed clear of nodes, badges, arrowheads and other labels. */
  labelBox: Rect | null
  /** When the label didn't fit next to its edge: its number, drawn on the edge and listed under the diagram. */
  callout?: number
  calloutBox?: Rect
}

export type FlowOrientation = 'horizontal' | 'vertical'

export interface FlowLayout {
  nodes: LaidOutNode[]
  edges: LaidOutEdge[]
  width: number
  height: number
  layers: number
  orientation: FlowOrientation
  /** Edge labels shown as numbered callouts (listed under the diagram). */
  callouts: { number: number; label: string }[]
  nodeWidth: number
  nodeHeight: number
  /** Widest gap between layers. */
  gap: number
  /** Gap after each layer (each sized to the labels that sit in it). */
  gaps: number[]
}

/** Valid nodes (unique ids, max 8) and edges between them (no self loops). */
export function sanitizeDiagram(diagram: FlowDiagramData | null | undefined): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const nodes: DiagramNode[] = []
  const seen = new Set<string>()
  for (const node of diagram?.nodes ?? []) {
    if (!node || typeof node.id !== 'string' || !node.id || seen.has(node.id)) continue
    seen.add(node.id)
    nodes.push(node)
    if (nodes.length === 8) break
  }
  const edges = (diagram?.edges ?? []).filter((edge) => edge && seen.has(edge.from) && seen.has(edge.to) && edge.from !== edge.to)
  return { nodes, edges }
}

/**
 * Longest-path layering on the forward graph. Edges styled `loop` are ignored, and so is any other edge
 * that would close a cycle (found by DFS in input order), so malformed diagrams still lay out.
 */
export function assignLayers(nodes: DiagramNode[], edges: DiagramEdge[]): { layer: Map<string, number>; backEdges: Set<DiagramEdge> } {
  const ids = nodes.map((node) => node.id)
  const backEdges = new Set<DiagramEdge>(edges.filter((edge) => edge.style === 'loop'))
  const outgoing = new Map<string, DiagramEdge[]>(ids.map((id) => [id, []]))
  for (const edge of edges) if (!backEdges.has(edge)) outgoing.get(edge.from)!.push(edge)

  const state = new Map<string, 0 | 1 | 2>()
  const visit = (id: string) => {
    state.set(id, 1)
    for (const edge of outgoing.get(id)!) {
      const next = state.get(edge.to) ?? 0
      if (next === 1) backEdges.add(edge)
      else if (next === 0) visit(edge.to)
    }
    state.set(id, 2)
  }
  const hasIncoming = new Set(edges.filter((edge) => !backEdges.has(edge)).map((edge) => edge.to))
  for (const id of ids) if (!hasIncoming.has(id) && !state.get(id)) visit(id)
  for (const id of ids) if (!state.get(id)) visit(id)

  const forward = edges.filter((edge) => !backEdges.has(edge))
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]))
  for (const edge of forward) indegree.set(edge.to, indegree.get(edge.to)! + 1)
  const layer = new Map<string, number>(ids.map((id) => [id, 0]))
  const queue = ids.filter((id) => indegree.get(id) === 0)
  while (queue.length) {
    const id = queue.shift()!
    for (const edge of forward) {
      if (edge.from !== id) continue
      layer.set(edge.to, Math.max(layer.get(edge.to)!, layer.get(id)! + 1))
      indegree.set(edge.to, indegree.get(edge.to)! - 1)
      if (indegree.get(edge.to) === 0) queue.push(edge.to)
    }
  }
  return { layer, backEdges }
}

export interface LayoutOptions {
  /** Fixed column per node id (missing ids fall back to their computed layer); used to align two diagrams. */
  fixedLayers?: Map<string, number>
  /** Minimum number of columns (so two aligned diagrams get the same width). */
  minLayers?: number
  /** Fix the gap between layers; otherwise each gap fits the labels that sit in it. */
  gapX?: number
  /** Fix each gap between layers (aligned diagrams share them). Wins over `gapX`. */
  gaps?: number[]
  orientation?: FlowOrientation
  /** Vertical layouts: fit node widths (and label room) to this many px. */
  availableWidth?: number
  /** Status per node id (default: highlighted nodes are "new"). */
  status?: Map<string, NodeStatus>
  /** Minimum node height (aligned diagrams share one). */
  nodeHeight?: number
  /** Vertical layouts: use this node width instead of fitting `availableWidth` (aligned lanes share one). */
  nodeWidth?: number
}

/** Widest gap between layers that fits this diagram's edge labels (the gap `layoutFlow` would choose). */
export function labelGap(diagram: FlowDiagramData | null | undefined, metrics: FlowMetrics = FULL_METRICS, orientation: FlowOrientation = 'horizontal'): number {
  return Math.max(metrics.gapX, layoutFlow(diagram, metrics, { orientation }).gap)
}

interface NodeText {
  node: DiagramNode
  status: NodeStatus
  decision: boolean
  padLeft: number
  weight: number
  lines: string[]
  width: number
  truncated: boolean
  badgeText: string | null
  badgeWidth: number
}

interface Box {
  node: DiagramNode
  layer: number
  row: number
  /** along-axis start/end, across-axis start/end (abstract frame: x = along, y = across). */
  a0: number
  a1: number
  c0: number
  c1: number
}

const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

/**
 * Layered layout with rows ordered by the barycenter of their predecessors. Horizontal = left to right;
 * vertical = top to bottom (rows become columns), with loops returning on the left.
 *
 * Every label is measured (12 px). Node labels wrap (≤ 4 lines, no ellipsis in practice) inside the node and all nodes share one
 * height. Edges between adjacent layers are S-curves in the gap; longer edges run through the free channels
 * of the layers they cross, so they never pass under a node; loops run outside the rows. Edge labels are
 * pills placed by a collision-aware search along their edge (clear of nodes, status badges, arrowheads and
 * each other); the gap between layers grows until they fit, and any label that still doesn't is shown as a
 * numbered callout listed under the diagram.
 */
export function layoutFlow(diagram: FlowDiagramData | null | undefined, metrics: FlowMetrics = FULL_METRICS, options: LayoutOptions = {}): FlowLayout {
  const orientation = options.orientation ?? 'horizontal'
  const vertical = orientation === 'vertical'
  const { nodes, edges } = sanitizeDiagram(diagram)
  const empty: FlowLayout = { nodes: [], edges: [], width: 0, height: 0, layers: 0, orientation, callouts: [], nodeWidth: 0, nodeHeight: 0, gap: 0, gaps: [] }
  if (!nodes.length) return empty
  const mini = metrics.nodeWidth < 80

  const { layer, backEdges } = assignLayers(nodes, edges)
  for (const [id, fixed] of options.fixedLayers ?? []) if (layer.has(id)) layer.set(id, fixed)
  const layers = Math.max(options.minLayers ?? 0, Math.max(...layer.values()) + 1)
  const byLayer: DiagramNode[][] = Array.from({ length: layers }, () => [])
  for (const node of nodes) byLayer[layer.get(node.id)!].push(node)

  const row = new Map<string, number>()
  const index = new Map(nodes.map((node, i) => [node.id, i]))
  byLayer.forEach((group, layerIndex) => {
    if (layerIndex > 0) {
      const centerOf = (node: DiagramNode) => {
        const preds = edges.filter((edge) => edge.to === node.id && !backEdges.has(edge) && row.has(edge.from)).map((edge) => row.get(edge.from)!)
        return preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : Number.POSITIVE_INFINITY
      }
      group.sort((a, b) => centerOf(a) - centerOf(b) || index.get(a.id)! - index.get(b.id)!)
    }
    group.forEach((node, i) => row.set(node.id, i - (group.length - 1) / 2))
  })
  const maxRows = Math.max(...byLayer.map((group) => group.length))
  // A "back" edge whose fixed columns point forward is drawn as a loop anyway; a forward edge whose fixed
  // columns don't is drawn as a loop too.
  const isLoop = (edge: DiagramEdge) => backEdges.has(edge) || layer.get(edge.to)! <= layer.get(edge.from)!
  const hasLoops = edges.some(isLoop)
  const hasLongEdges = edges.some((edge) => !isLoop(edge) && layer.get(edge.to)! - layer.get(edge.from)! > 1)

  // ---- node width and label text --------------------------------------------------------------
  let nodeWidth = vertical && !mini && options.nodeWidth ? options.nodeWidth : metrics.nodeWidth
  if (vertical && !mini && options.availableWidth && !options.nodeWidth) {
    const side = 2 * metrics.padX + (hasLoops ? LOOP_CLEAR + 8 : 0) + (hasLongEdges ? CHANNEL_CLEAR + 8 : 0)
    const fit = Math.floor((options.availableWidth - side - (maxRows - 1) * metrics.gapY) / maxRows)
    nodeWidth = Math.max(MIN_VERTICAL_NODE, Math.min(MAX_VERTICAL_NODE, fit))
  }
  const glyph = !mini && nodeWidth >= GLYPH_MIN_WIDTH
  const statusOf = (node: DiagramNode): NodeStatus => options.status?.get(node.id) ?? (node.highlight ? 'new' : 'same')
  const texts = new Map<string, NodeText>()
  for (const node of nodes) {
    const status = statusOf(node)
    const decision = node.kind === 'decision'
    const inset = decision ? 6 : 0
    const padLeft = (glyph ? 36 : 10) + inset
    const textWidth = nodeWidth - padLeft - 10 - inset
    const weight = status === 'new' || status === 'changed' ? 600 : 500
    const wrapped = mini ? { lines: [], width: 0, truncated: false } : wrapText(node.label ?? '', textWidth, { weight, maxLines: 4 })
    const badgeText = mini ? null : (BADGE_TEXT[status] ?? null)
    const badgeWidth = badgeText ? measureText(badgeText, FLOW_TEXT.fontSize, 600) + 2 * FLOW_TEXT.badgePadX : 0
    texts.set(node.id, { node, status, decision, padLeft, weight, lines: wrapped.lines, width: wrapped.width, truncated: wrapped.truncated, badgeText, badgeWidth })
  }
  const badgeRow = FLOW_TEXT.badgeTop + FLOW_TEXT.badgeHeight + 1
  const needed = (text: NodeText) => (text.badgeText ? badgeRow + text.lines.length * FLOW_TEXT.lineHeight + 8 : text.lines.length * FLOW_TEXT.lineHeight + 18)
  const nodeHeight = mini ? metrics.nodeHeight : Math.ceil(Math.max(metrics.nodeHeight, options.nodeHeight ?? 0, ...[...texts.values()].map(needed)))

  // ---- edge label sizes ------------------------------------------------------------------------
  const labelMax = vertical ? Math.max(96, Math.min(168, nodeWidth)) : HORIZONTAL_LABEL_MAX
  const labels = new Map<DiagramEdge, { lines: string[]; width: number; height: number }>()
  if (!mini)
    for (const edge of edges) {
      const text = edge.label?.trim()
      if (!text) continue
      const wrapped = wrapText(text, labelMax, { weight: 500, maxLines: 4 })
      labels.set(edge, {
        lines: wrapped.lines,
        width: Math.ceil(wrapped.width + 2 * FLOW_TEXT.pillPadX),
        height: wrapped.lines.length * FLOW_TEXT.edgeLineHeight + 2 * FLOW_TEXT.pillPadY + 1,
      })
    }
  const gaps = requiredGaps(edges, labels, layer, layers, isLoop, metrics.gapX, vertical)

  const build = (sizes: number[]) => buildLayout({ nodes, edges, layer, row, layers, isLoop, texts, labels, nodeWidth, nodeHeight, gaps: sizes, metrics, vertical, orientation, mini, availableWidth: options.availableWidth })
  if (options.gaps) return build(Array.from({ length: layers - 1 }, (_, i) => options.gaps![i] ?? metrics.gapX))
  if (options.gapX !== undefined || mini) return build(gaps.map(() => options.gapX ?? metrics.gapX))
  let result = build(gaps)
  for (let attempt = 0; attempt < 4 && result.callouts.length; attempt++) result = build(growGaps(result.gaps, vertical))
  return result
}

/** Widen every gap after a layout that still needed callouts. */
const growGaps = (gaps: number[], vertical: boolean) => gaps.map((gap) => gap + (vertical ? 16 : 22))

/**
 * Size of each gap between layers: room for the widest (horizontal) or tallest (vertical) label of the edges
 * between those two layers, plus clearance from the nodes. A label on a longer edge (or a loop, top to bottom)
 * claims the widest gap it crosses.
 */
function requiredGaps(
  edges: DiagramEdge[],
  labels: Map<DiagramEdge, { width: number; height: number }>,
  layer: Map<string, number>,
  layers: number,
  isLoop: (edge: DiagramEdge) => boolean,
  minimum: number,
  vertical: boolean,
): number[] {
  const gaps = Array.from({ length: Math.max(0, layers - 1) }, () => minimum)
  const need = (size: { width: number; height: number }) => Math.ceil((vertical ? size.height : size.width) + 2 * NODE_CLEAR + 4)
  const span = (edge: DiagramEdge) => {
    const from = layer.get(edge.from)!
    const to = layer.get(edge.to)!
    return [Math.min(from, to), Math.max(from, to)]
  }
  const rest: DiagramEdge[] = []
  for (const edge of edges) {
    const size = labels.get(edge)
    if (!size || (!vertical && isLoop(edge))) continue
    const [low, high] = span(edge)
    if (high - low === 1 && !isLoop(edge)) gaps[low] = Math.max(gaps[low], need(size))
    else if (high > low) rest.push(edge)
  }
  for (const edge of rest) {
    const [low, high] = span(edge)
    let widest = low
    for (let i = low; i < high; i++) if (gaps[i] > gaps[widest]) widest = i
    gaps[widest] = Math.max(gaps[widest], need(labels.get(edge)!))
  }
  return gaps
}

interface BuildInput {
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  layer: Map<string, number>
  row: Map<string, number>
  layers: number
  isLoop: (edge: DiagramEdge) => boolean
  texts: Map<string, NodeText>
  labels: Map<DiagramEdge, { lines: string[]; width: number; height: number }>
  nodeWidth: number
  nodeHeight: number
  gaps: number[]
  metrics: FlowMetrics
  vertical: boolean
  orientation: FlowOrientation
  mini: boolean
  availableWidth?: number
}

function buildLayout(input: BuildInput): FlowLayout {
  const { nodes, edges, layer, row, layers, isLoop, texts, labels, nodeWidth, nodeHeight, gaps, metrics, vertical, orientation, mini } = input
  const alongSize = vertical ? nodeHeight : nodeWidth
  const acrossSize = vertical ? nodeWidth : nodeHeight
  const padAlong = vertical ? metrics.padY : metrics.padX
  const padAcross = vertical ? metrics.padX : metrics.padY
  const starts = [padAlong]
  for (let l = 1; l < layers; l++) starts.push(starts[l - 1] + alongSize + gaps[l - 1])
  const alongTotal = starts[layers - 1] + alongSize + padAlong
  const layerStart = (l: number) => starts[l]
  const gapY = metrics.gapY
  const loopClear = mini ? metrics.arcRoom : LOOP_CLEAR
  const channelClear = mini ? metrics.arcRoom : CHANNEL_CLEAR
  // Loops run below a left-to-right flow and left of a top-to-bottom one; detours prefer the other side.
  const loopSide = vertical ? -1 : 1
  const detourSide = -loopSide

  const boxes = new Map<string, Box>()
  for (const node of nodes) {
    const l = layer.get(node.id)!
    const a0 = layerStart(l)
    const c0 = row.get(node.id)! * (acrossSize + gapY) - acrossSize / 2
    boxes.set(node.id, { node, layer: l, row: row.get(node.id)!, a0, a1: a0 + alongSize, c0, c1: c0 + acrossSize })
  }
  const inLayer = (l: number) => [...boxes.values()].filter((box) => box.layer === l).sort((a, b) => a.c0 - b.c0)
  const ac = (box: Box) => (box.a0 + box.a1) / 2
  const cc = (box: Box) => (box.c0 + box.c1) / 2
  const sideFree = (box: Box, side: number) => !inLayer(box.layer).some((other) => other !== box && (side > 0 ? other.c0 >= box.c1 : other.c1 <= box.c0))

  // ---- routes, in the abstract frame (x = along, y = across) -----------------------------------------
  const routes = new Map<DiagramEdge, { route: EdgeRoute; segments: Cubic[] }>()
  const pairCount = new Map<string, number>()
  const pairIndex = new Map<DiagramEdge, number>()
  for (const edge of edges) {
    if (isLoop(edge)) continue
    const key = `${edge.from}→${edge.to}`
    pairIndex.set(edge, pairCount.get(key) ?? 0)
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
  }
  const channelUse = new Map<string, number>()
  const loopChannels: { low: number; high: number; channel: number }[] = []

  const forward = edges.filter((edge) => !isLoop(edge)).sort((a, b) => layer.get(a.to)! - layer.get(a.from)! - (layer.get(b.to)! - layer.get(b.from)!))
  for (const edge of forward) {
    const a = boxes.get(edge.from)!
    const b = boxes.get(edge.to)!
    const start = { x: a.a1, y: cc(a) }
    const end = { x: b.a0, y: cc(b) }
    if (b.layer - a.layer === 1) {
      const count = pairCount.get(`${edge.from}→${edge.to}`) ?? 1
      const bow = (pairIndex.get(edge)! - (count - 1) / 2) * 30
      routes.set(edge, { route: 'forward', segments: [sCurve(start, end, 'x', bow)] })
      continue
    }
    const segments: Cubic[] = []
    let cursor = start
    for (let l = a.layer + 1; l < b.layer; l++) {
      const ideal = cc(a) + ((cc(b) - cc(a)) * (l - a.layer)) / (b.layer - a.layer)
      const column = inLayer(l)
      let across = ideal
      let side = 0
      if (column.some((box) => ideal > box.c0 - 8 && ideal < box.c1 + 8)) {
        const choices: { at: number; side: number }[] = [
          { at: column[0].c0 - channelClear, side: -1 },
          { at: column[column.length - 1].c1 + channelClear, side: 1 },
        ]
        for (let i = 0; i < column.length - 1; i++)
          if (column[i + 1].c0 - column[i].c1 >= 12) choices.push({ at: (column[i].c1 + column[i + 1].c0) / 2, side: 0 })
        choices.sort((p, q) => Math.abs(p.at - ideal) + (p.side === detourSide || p.side === 0 ? 0 : 6) - (Math.abs(q.at - ideal) + (q.side === detourSide || q.side === 0 ? 0 : 6)))
        across = choices[0].at
        side = choices[0].side
      }
      const key = `${l}:${Math.round(across)}`
      const used = channelUse.get(key) ?? 0
      channelUse.set(key, used + 1)
      if (used) across += (side || (used % 2 ? 1 : -1)) * 8 * Math.ceil(used / (side ? 1 : 2))
      const entry = { x: layerStart(l), y: across }
      const exit = { x: layerStart(l) + alongSize, y: across }
      segments.push(sCurve(cursor, entry, 'x'), line(entry, exit))
      cursor = exit
    }
    segments.push(sCurve(cursor, end, 'x'))
    routes.set(edge, { route: 'arc', segments })
  }

  for (const edge of edges.filter(isLoop)) {
    const a = boxes.get(edge.from)!
    const b = boxes.get(edge.to)!
    const low = Math.min(a.layer, b.layer)
    const high = Math.max(a.layer, b.layer)
    const spanned = [...boxes.values()].filter((box) => box.layer >= low && box.layer <= high)
    let channel = loopSide > 0 ? Math.max(...spanned.map((box) => box.c1)) + loopClear : Math.min(...spanned.map((box) => box.c0)) - loopClear
    while (loopChannels.some((other) => other.low <= high && other.high >= low && Math.abs(other.channel - channel) < 10)) channel += loopSide * 12
    loopChannels.push({ low, high, channel })
    // Leave/enter on the loop side when nothing else in the layer sits there; otherwise detour through the gap.
    const exitStep = a.layer === layers - 1 ? padAlong - 1 : gaps[a.layer] / 2
    const entryStep = b.layer === 0 ? padAlong - 1 : gaps[b.layer - 1] / 2
    const points: Point[] = []
    if (sideFree(a, loopSide)) points.push({ x: ac(a), y: loopSide > 0 ? a.c1 : a.c0 }, { x: ac(a), y: channel })
    else points.push({ x: a.a1, y: cc(a) }, { x: a.a1 + exitStep, y: cc(a) }, { x: a.a1 + exitStep, y: channel })
    if (sideFree(b, loopSide)) points.push({ x: ac(b), y: channel }, { x: ac(b), y: loopSide > 0 ? b.c1 : b.c0 })
    else points.push({ x: b.a0 - entryStep, y: channel }, { x: b.a0 - entryStep, y: cc(b) }, { x: b.a0, y: cc(b) })
    routes.set(edge, { route: 'loop', segments: roundedPolyline(points, mini ? 4 : 12) })
  }

  // ---- to screen coordinates ----------------------------------------------------------------------
  const toScreen = (p: Point): Point => (vertical ? { x: p.y, y: p.x } : p)
  const screenRoutes = new Map([...routes].map(([edge, value]) => [edge, { route: value.route, segments: value.segments.map((s) => mapCubic(s, toScreen)) }]))

  const laidOut: LaidOutNode[] = nodes.map((node) => {
    const box = boxes.get(node.id)!
    const topLeft = toScreen({ x: box.a0, y: box.c0 })
    const text = texts.get(node.id)!
    const x = topLeft.x
    const y = topLeft.y
    const inset = text.decision ? HEXAGON_INSET : 0
    const badge = text.badgeText
      ? { text: text.badgeText, x: x + nodeWidth - inset - 5 - text.badgeWidth, y: y + FLOW_TEXT.badgeTop, width: text.badgeWidth, height: FLOW_TEXT.badgeHeight }
      : null
    const areaTop = y + (badge ? FLOW_TEXT.badgeTop + FLOW_TEXT.badgeHeight + 1 : 0)
    const areaBottom = y + nodeHeight
    const blockHeight = text.lines.length * FLOW_TEXT.lineHeight
    const blockTop = areaTop + (areaBottom - areaTop - blockHeight) / 2
    const textX = x + text.padLeft
    return {
      ...node,
      layer: box.layer,
      row: box.row,
      x,
      y,
      width: nodeWidth,
      height: nodeHeight,
      status: text.status,
      lines: text.lines,
      truncated: text.truncated,
      fontWeight: text.weight,
      textX,
      lineY: text.lines.map((_, i) => blockTop + i * FLOW_TEXT.lineHeight + FLOW_TEXT.baseline),
      textBox: text.lines.length ? { x: textX, y: blockTop, width: text.width, height: blockHeight } : null,
      glyph: mini || nodeWidth < GLYPH_MIN_WIDTH ? null : { x: x + (text.decision ? 6 : 0) + 19, y: (areaTop + areaBottom) / 2 },
      badge,
    }
  })

  // ---- label placement ------------------------------------------------------------------------------
  const samples = new Map<DiagramEdge, PathSample[]>([...screenRoutes].map(([edge, value]) => [edge, samplePath(value.segments, 3)]))
  const obstacles: Rect[] = laidOut.map((node) => inflate(node, NODE_CLEAR))
  for (const value of screenRoutes.values()) {
    const end = value.segments[value.segments.length - 1]?.p3
    if (end) obstacles.push({ x: end.x - 7, y: end.y - 7, width: 14, height: 14 })
  }
  const routeBox = unionRect([...screenRoutes.values()].map((value) => pathBounds(value.segments)).filter((r): r is Rect => !!r))
  const nodeBox = unionRect(laidOut)!
  const bounds: PlacementBounds = vertical ? { minY: 0, maxY: alongTotal } : { minX: 0, maxX: alongTotal }
  if (vertical && input.availableWidth) {
    const content = unionRect([nodeBox, ...(routeBox ? [routeBox] : [])])!
    const slack = Math.max(0, input.availableWidth - 2 * padAcross - content.width)
    bounds.minX = content.x - slack / 2
    bounds.maxX = content.x + content.width + slack / 2
  }
  const otherCost = (edge: DiagramEdge) => (rect: Rect) => {
    const zone = inflate(rect, 1)
    let cost = 0
    for (const [other, points] of samples) {
      if (other === edge) continue
      for (const sample of points) if (sample.point.x > zone.x && sample.point.x < zone.x + zone.width && sample.point.y > zone.y && sample.point.y < zone.y + zone.height) cost++
    }
    return cost
  }
  const routeRank: Record<EdgeRoute, number> = { forward: 0, arc: 1, loop: 2 }
  const requests: LabelRequest<DiagramEdge>[] = [...labels.keys()]
    .sort((a, b) => routeRank[screenRoutes.get(a)!.route] - routeRank[screenRoutes.get(b)!.route] || layer.get(a.from)! - layer.get(b.from)!)
    .map((edge) => ({ key: edge, candidates: pathLabelCandidates(samples.get(edge)!, labels.get(edge)!.width, labels.get(edge)!.height), cost: otherCost(edge) }))
  const placed = placeLabels(requests, obstacles, { gap: 3, bounds })

  const callouts: { number: number; label: string }[] = []
  const calloutBoxes = new Map<DiagramEdge, Rect>()
  const taken = [...obstacles, ...[...placed.values()].filter((r): r is Rect => !!r).map((r) => inflate(r, 3))]
  for (const edge of edges) {
    if (!labels.has(edge) || placed.get(edge)) continue
    const size = FLOW_TEXT.calloutSize
    const candidates = pathLabelCandidates(samples.get(edge)!, size, size, { offset: 2 })
    const spot = placeLabels([{ key: 0, candidates }], taken, { bounds }).get(0) ?? candidates[0]
    callouts.push({ number: callouts.length + 1, label: edge.label!.trim() })
    calloutBoxes.set(edge, spot)
    taken.push(inflate(spot, 3))
  }

  // ---- extent: the along axis is fixed (aligned lanes share it); the across axis shrinks to fit ----------
  const everything = [
    nodeBox,
    ...(routeBox ? [routeBox] : []),
    ...[...placed.values()].filter((r): r is Rect => !!r),
    ...calloutBoxes.values(),
  ]
  const extent = unionRect(everything)!
  const shift = vertical ? padAcross - extent.x : padAcross - extent.y
  const across = (vertical ? extent.width : extent.height) + 2 * padAcross
  const move = (p: Point): Point => (vertical ? { x: p.x + shift, y: p.y } : { x: p.x, y: p.y + shift })
  const moveRect = <T extends Rect>(r: T): T => ({ ...r, ...move(r) })

  const finalNodes = laidOut.map((node) => {
    const moved = move(node)
    const dx = moved.x - node.x
    const dy = moved.y - node.y
    return {
      ...node,
      ...moved,
      textX: node.textX + dx,
      lineY: node.lineY.map((y) => y + dy),
      textBox: node.textBox ? moveRect(node.textBox) : null,
      glyph: node.glyph ? move(node.glyph) : null,
      badge: node.badge ? moveRect(node.badge) : null,
    }
  })
  let calloutNumber = 0
  const finalEdges: LaidOutEdge[] = edges.map((edge) => {
    const value = screenRoutes.get(edge)!
    const segments = value.segments.map((s) => mapCubic(s, move))
    const label = labels.get(edge)
    const box = placed.get(edge) ? moveRect(placed.get(edge)!) : null
    const callout = calloutBoxes.get(edge)
    const mid = box ? center(box) : null
    return {
      ...edge,
      route: value.route,
      segments,
      path: pathD(segments),
      labelBox: box,
      labelLines: box && label ? label.lines : [],
      labelX: mid?.x ?? 0,
      labelY: box ? box.y + FLOW_TEXT.pillPadY + FLOW_TEXT.baseline - 0.6 : 0,
      labelAnchor: 'middle',
      ...(callout ? { callout: ++calloutNumber, calloutBox: moveRect(callout) } : {}),
    }
  })

  return {
    nodes: finalNodes,
    edges: finalEdges,
    width: Math.ceil(vertical ? across : alongTotal),
    height: Math.ceil(vertical ? alongTotal : across),
    layers,
    orientation,
    callouts,
    nodeWidth,
    nodeHeight,
    gap: Math.max(0, ...gaps),
    gaps,
  }
}

export interface FlowComparison {
  before: FlowLayout
  after: FlowLayout
  /** Status of every node in the "after" diagram (new / changed / same). */
  afterStatus: Map<string, NodeStatus>
  /** Status of every node in the "before" diagram (removed / same / changed). */
  beforeStatus: Map<string, NodeStatus>
  added: string[]
  changed: string[]
  removed: string[]
}

const normalizeLabel = (label: string | undefined) => (label ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Lay out "today" (before) and "with the technique" (after) on one column grid so steps that share an id
 * line up. Nodes only in `after` are new; shared ids whose label changed (or that the technique highlights)
 * are changed; nodes only in `before` are removed. Before-only nodes go one column after their aligned
 * predecessor, and every forward edge keeps pointing forward. Both lanes share the gap between layers and the
 * node height, so columns (or rows, top to bottom) line up exactly.
 */
export function compareFlows(
  beforeDiagram: FlowDiagramData | null | undefined,
  afterDiagram: FlowDiagramData | null | undefined,
  metrics: FlowMetrics = FULL_METRICS,
  orientation: FlowOrientation = 'horizontal',
  options: { availableWidth?: number } = {},
): FlowComparison {
  const before = sanitizeDiagram(beforeDiagram)
  const after = sanitizeDiagram(afterDiagram)
  const afterLayers = assignLayers(after.nodes, after.edges).layer
  const { layer: ownLayers, backEdges } = assignLayers(before.nodes, before.edges)

  const aligned = new Map<string, number>()
  const order = [...before.nodes].sort((a, b) => ownLayers.get(a.id)! - ownLayers.get(b.id)!)
  for (const node of order) {
    const preds = before.edges.filter((edge) => edge.to === node.id && !backEdges.has(edge) && aligned.has(edge.from)).map((edge) => aligned.get(edge.from)!)
    const floor = preds.length ? Math.max(...preds) + 1 : 0
    aligned.set(node.id, Math.max(afterLayers.get(node.id) ?? floor, floor))
  }
  // A before-only node pushed right may now sit at or past a shared successor; shift those successors.
  let changedLayers = true
  for (let guard = 0; changedLayers && guard < 16; guard++) {
    changedLayers = false
    for (const edge of before.edges) {
      if (backEdges.has(edge)) continue
      if (aligned.get(edge.to)! <= aligned.get(edge.from)!) {
        aligned.set(edge.to, aligned.get(edge.from)! + 1)
        changedLayers = true
      }
    }
  }

  const beforeById = new Map(before.nodes.map((node) => [node.id, node]))
  const afterIds = new Set(after.nodes.map((node) => node.id))
  const afterStatus = new Map<string, NodeStatus>()
  for (const node of after.nodes) {
    const old = beforeById.get(node.id)
    afterStatus.set(node.id, !old ? 'new' : node.highlight || normalizeLabel(old.label) !== normalizeLabel(node.label) ? 'changed' : 'same')
  }
  const beforeStatus = new Map<string, NodeStatus>()
  for (const node of before.nodes) beforeStatus.set(node.id, !afterIds.has(node.id) ? 'removed' : afterStatus.get(node.id) === 'changed' ? 'changed' : 'same')
  // The "today" lane only marks what goes away; what changes is marked in the lane with the technique.
  const beforeLane = new Map([...beforeStatus].map(([id, status]) => [id, status === 'removed' ? ('removed' as const) : ('same' as const)]))

  const columns = Math.max(afterLayers.size ? Math.max(...afterLayers.values()) + 1 : 0, aligned.size ? Math.max(...aligned.values()) + 1 : 0)
  const lane = (which: 'before' | 'after', gaps: number[], nodeHeight: number, nodeWidth: number) =>
    which === 'before'
      ? layoutFlow(beforeDiagram, metrics, { fixedLayers: aligned, minLayers: columns, gaps, orientation, status: beforeLane, nodeHeight, nodeWidth, availableWidth: options.availableWidth })
      : layoutFlow(afterDiagram, metrics, { minLayers: columns, gaps, orientation, status: afterStatus, nodeHeight, nodeWidth, availableWidth: options.availableWidth })

  // Start from the gaps each lane needs on its own, share the larger of each, and widen them while a label
  // still only fits as a callout. Both lanes use the narrower node width (so they look alike) and the taller
  // node height.
  const own = (which: 'before' | 'after', nodeWidth?: number) =>
    which === 'before'
      ? layoutFlow(beforeDiagram, metrics, { fixedLayers: aligned, minLayers: columns, orientation, status: beforeLane, nodeWidth, availableWidth: options.availableWidth })
      : layoutFlow(afterDiagram, metrics, { minLayers: columns, orientation, status: afterStatus, nodeWidth, availableWidth: options.availableWidth })
  const first = [own('before'), own('after')]
  const nodeWidth = Math.min(...first.map((layout) => layout.nodeWidth))
  const sized = first.map((layout, i) => (layout.nodeWidth === nodeWidth ? layout : own(i === 0 ? 'before' : 'after', nodeWidth)))
  let gaps = Array.from({ length: Math.max(0, columns - 1) }, (_, i) => Math.max(metrics.gapX, ...sized.map((layout) => layout.gaps[i] ?? 0)))
  const nodeHeight = Math.max(...sized.map((layout) => layout.nodeHeight))
  let beforeLayout = lane('before', gaps, nodeHeight, nodeWidth)
  let afterLayout = lane('after', gaps, nodeHeight, nodeWidth)
  for (let attempt = 0; attempt < 4 && (beforeLayout.callouts.length || afterLayout.callouts.length); attempt++) {
    gaps = growGaps(gaps, orientation === 'vertical')
    beforeLayout = lane('before', gaps, nodeHeight, nodeWidth)
    afterLayout = lane('after', gaps, nodeHeight, nodeWidth)
  }

  return {
    before: beforeLayout,
    after: afterLayout,
    afterStatus,
    beforeStatus,
    added: after.nodes.filter((node) => afterStatus.get(node.id) === 'new').map((node) => node.label),
    changed: after.nodes.filter((node) => afterStatus.get(node.id) === 'changed').map((node) => node.label),
    removed: before.nodes.filter((node) => beforeStatus.get(node.id) === 'removed').map((node) => node.label),
  }
}

/** Split a label into at most `maxLines` lines of roughly `maxChars` characters (word-wrapped, ellipsis). */
export function wrapLabel(label: string, maxChars: number, maxLines = 2): string[] {
  const words = label.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxChars || !current) {
      current = next
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  const clipped = lines.slice(0, maxLines).map((line) => (line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line))
  if (lines.length > maxLines) clipped[maxLines - 1] = `${clipped[maxLines - 1].replace(/…$/, '').slice(0, maxChars - 1)}…`
  return clipped
}
