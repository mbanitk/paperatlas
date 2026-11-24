import type { DiagramEdge, DiagramNode, FlowDiagramData } from '../api/types'

/** Geometry of one diagram variant. */
export interface FlowMetrics {
  nodeWidth: number
  nodeHeight: number
  /** Gap between layers, along the flow (horizontal in left-to-right diagrams, vertical in top-to-bottom ones). */
  gapX: number
  /** Gap between parallel nodes of one layer, across the flow. */
  gapY: number
  padX: number
  padY: number
  /** Extra room above the nodes for skip edges that arc over a row, and below for loop edges. */
  arcRoom: number
}

export const FULL_METRICS: FlowMetrics = { nodeWidth: 142, nodeHeight: 54, gapX: 46, gapY: 16, padX: 8, padY: 16, arcRoom: 30 }
/** Top-to-bottom variant for narrow containers (phones, side columns). */
export const VERTICAL_METRICS: FlowMetrics = { nodeWidth: 142, nodeHeight: 48, gapX: 38, gapY: 12, padX: 6, padY: 10, arcRoom: 24 }
/** Edge labels wrap to lines of at most this many characters (and at most 2 lines). */
export const EDGE_LABEL_CHARS = 13
/** Loop labels beside a top-to-bottom diagram run upwards along the arc, so they can be longer. */
const SIDE_LABEL_CHARS = 9
const LABEL_CHAR_WIDTH = 5.8
const MAX_LABEL_GAP = 92
export const MINI_METRICS: FlowMetrics = { nodeWidth: 40, nodeHeight: 16, gapX: 12, gapY: 6, padX: 3, padY: 4, arcRoom: 9 }

export interface LaidOutNode extends DiagramNode {
  layer: number
  row: number
  x: number
  y: number
  width: number
  height: number
}

export type EdgeRoute = 'forward' | 'arc' | 'loop'

export interface LaidOutEdge extends DiagramEdge {
  route: EdgeRoute
  path: string
  labelX: number
  labelY: number
  /** Label lines (wrapped), drawn from labelY downwards. */
  labelLines: string[]
  labelAnchor: 'start' | 'middle' | 'end'
  /** Degrees to rotate the label around (labelX, labelY); loop labels beside a vertical diagram run upwards. */
  labelRotate?: number
}

export type FlowOrientation = 'horizontal' | 'vertical'

export interface FlowLayout {
  nodes: LaidOutNode[]
  edges: LaidOutEdge[]
  width: number
  height: number
  layers: number
  orientation: FlowOrientation
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
  /** Override the gap between layers (aligned diagrams share one). */
  gapX?: number
  orientation?: FlowOrientation
}

/** Gap between layers wide enough for the longest (wrapped) label on a forward edge. */
export function labelGap(diagram: FlowDiagramData | null | undefined, metrics: FlowMetrics = FULL_METRICS): number {
  const { edges } = sanitizeDiagram(diagram)
  const longest = Math.max(0, ...edges.filter((edge) => edge.style !== 'loop' && edge.label).flatMap((edge) => wrapLabel(edge.label!, EDGE_LABEL_CHARS, 2).map((line) => line.length)))
  return Math.max(metrics.gapX, Math.min(MAX_LABEL_GAP, Math.ceil(longest * LABEL_CHAR_WIDTH + 18)))
}

/**
 * Layered layout with rows ordered by the barycenter of their predecessors. Horizontal = left to right;
 * vertical = top to bottom (rows become columns), with loops returning on the left and skips arcing on the right.
 */
export function layoutFlow(diagram: FlowDiagramData | null | undefined, metrics: FlowMetrics = FULL_METRICS, options: LayoutOptions = {}): FlowLayout {
  const orientation = options.orientation ?? 'horizontal'
  const vertical = orientation === 'vertical'
  const { nodes, edges } = sanitizeDiagram(diagram)
  const { nodeWidth: w, nodeHeight: h, gapY, padX, padY, arcRoom } = metrics
  const gapX = options.gapX ?? (vertical ? metrics.gapX : labelGap(diagram, metrics))
  if (!nodes.length) return { nodes: [], edges: [], width: 0, height: 0, layers: 0, orientation }

  const { layer, backEdges } = assignLayers(nodes, edges)
  for (const [id, fixed] of options.fixedLayers ?? []) if (layer.has(id)) layer.set(id, fixed)
  const layers = Math.max(options.minLayers ?? 0, Math.max(...layer.values()) + 1)
  const byLayer: DiagramNode[][] = Array.from({ length: layers }, () => [])
  for (const node of nodes) byLayer[layer.get(node.id)!].push(node)

  const row = new Map<string, number>()
  const index = new Map(nodes.map((node, i) => [node.id, i]))
  byLayer.forEach((group, layerIndex) => {
    if (layerIndex > 0) {
      const center = (node: DiagramNode) => {
        const preds = edges.filter((edge) => edge.to === node.id && !backEdges.has(edge) && row.has(edge.from)).map((edge) => row.get(edge.from)!)
        return preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : Number.POSITIVE_INFINITY
      }
      group.sort((a, b) => center(a) - center(b) || index.get(a.id)! - index.get(b.id)!)
    }
    group.forEach((node, i) => row.set(node.id, i - (group.length - 1) / 2))
  })

  const maxRows = Math.max(...byLayer.map((group) => group.length))
  const between = (from: string, to: string) => nodes.some((n) => layer.get(n.id)! > layer.get(from)! && layer.get(n.id)! < layer.get(to)!)
  const sameRowArcs = edges.some((edge) => {
    if (backEdges.has(edge)) return false
    return layer.get(edge.to)! - layer.get(edge.from)! > 1 && row.get(edge.to) === row.get(edge.from) && between(edge.from, edge.to)
  })

  // "along" runs with the flow, "across" over the parallel rows; map them to x/y per orientation.
  const acrossSize = vertical ? w : h
  const alongSize = vertical ? h : w
  const alongPad = vertical ? padY : padX
  const loopLabelRoom = vertical
    ? Math.max(0, ...edges.filter((edge) => backEdges.has(edge) && edge.label).map((edge) => wrapLabel(edge.label!, SIDE_LABEL_CHARS * 2, 2).length * 11 + 2))
    : 0
  const before = (vertical ? padX : padY) + (vertical ? (backEdges.size ? arcRoom + loopLabelRoom : 0) : sameRowArcs ? arcRoom : 0)
  const after = (vertical ? padX : padY) + (vertical ? (sameRowArcs ? arcRoom : 0) : backEdges.size ? arcRoom : 0)
  const body = maxRows * acrossSize + (maxRows - 1) * gapY
  const alongTotal = alongPad * 2 + layers * alongSize + (layers - 1) * gapX
  const acrossTotal = before + body + after
  const mid = before + body / 2
  let width = vertical ? acrossTotal : alongTotal
  const height = vertical ? alongTotal : acrossTotal

  const laidOut = new Map<string, LaidOutNode>()
  for (const node of nodes) {
    const l = layer.get(node.id)!
    const along = alongPad + l * (alongSize + gapX)
    const across = mid + row.get(node.id)! * (acrossSize + gapY) - acrossSize / 2
    laidOut.set(node.id, { ...node, layer: l, row: row.get(node.id)!, x: vertical ? across : along, y: vertical ? along : across, width: w, height: h })
  }

  const lines = (edge: DiagramEdge, chars: number) => (edge.label ? wrapLabel(edge.label, chars, 2) : [])
  /** Nodes whose layer lies within [low, high] (a loop or arc must clear all of them). */
  const spanned = (a: LaidOutNode, b: LaidOutNode) => {
    const [low, high] = a.layer <= b.layer ? [a.layer, b.layer] : [b.layer, a.layer]
    return [...laidOut.values()].filter((n) => n.layer >= low && n.layer <= high)
  }
  const routed: LaidOutEdge[] = edges.map((edge) => {
    const a = laidOut.get(edge.from)!
    const b = laidOut.get(edge.to)!
    const labelLines = lines(edge, vertical && backEdges.has(edge) ? SIDE_LABEL_CHARS * 2 : EDGE_LABEL_CHARS)
    const lineHeight = 11
    if (backEdges.has(edge)) {
      if (vertical) {
        const y1 = a.y + h / 2
        const y2 = b.y + h / 2
        const far = Math.min(...spanned(a, b).map((n) => n.x)) - arcRoom + 2
        const extreme = 0.25 * Math.min(a.x, b.x) + 0.75 * far
        return { ...edge, route: 'loop', path: `M ${a.x} ${y1} C ${far} ${y1}, ${far} ${y2}, ${b.x} ${y2}`, labelX: extreme - 4 - (labelLines.length - 1) * lineHeight, labelY: (y1 + y2) / 2, labelLines, labelAnchor: 'middle', labelRotate: -90 }
      }
      const x1 = a.x + w / 2
      const x2 = b.x + w / 2
      const y1 = a.y + h
      const y2 = b.y + h
      const low = Math.max(...spanned(a, b).map((n) => n.y + h)) + arcRoom - 2
      return { ...edge, route: 'loop', path: `M ${x1} ${y1} C ${x1} ${low}, ${x2} ${low}, ${x2} ${y2}`, labelX: (x1 + x2) / 2, labelY: low - 2 - (labelLines.length - 1) * lineHeight, labelLines, labelAnchor: 'middle' }
    }
    if (b.layer - a.layer > 1 && a.row === b.row && between(a.id, b.id)) {
      // Clear every node between the endpoints, not just the endpoints (branched flows put siblings higher).
      if (vertical) {
        let edgeMax = Math.max(a.x + w, b.x + w)
        for (const n of laidOut.values()) if (n.layer > a.layer && n.layer < b.layer) edgeMax = Math.max(edgeMax, n.x + w)
        const far = edgeMax + arcRoom - 4
        const sy = a.y + h / 2
        const ey = b.y + h / 2
        return { ...edge, route: 'arc', path: `M ${a.x + w} ${sy} C ${far} ${sy}, ${far} ${ey}, ${b.x + w} ${ey}`, labelX: far - 6, labelY: (sy + ey) / 2, labelLines, labelAnchor: 'end' }
      }
      let ceiling = Math.min(a.y, b.y)
      for (const n of laidOut.values()) if (n.layer > a.layer && n.layer < b.layer) ceiling = Math.min(ceiling, n.y)
      const high = ceiling - arcRoom + 4
      const sx = a.x + w / 2
      const ex = b.x + w / 2
      return { ...edge, route: 'arc', path: `M ${sx} ${a.y} C ${sx} ${high}, ${ex} ${high}, ${ex} ${b.y}`, labelX: (sx + ex) / 2, labelY: high + 6, labelLines, labelAnchor: 'middle' }
    }
    if (vertical) {
      const x1 = a.x + w / 2
      const y1 = a.y + h
      const x2 = b.x + w / 2
      const y2 = b.y
      const dy = Math.max(10, (y2 - y1) / 2)
      const labelX = (x1 + x2) / 2 + 8
      if (labelLines.length) width = Math.max(width, labelX + Math.max(...labelLines.map((line) => line.length)) * LABEL_CHAR_WIDTH + padX)
      return { ...edge, route: 'forward', path: `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`, labelX, labelY: (y1 + y2) / 2 - ((labelLines.length - 1) * lineHeight) / 2 + 3, labelLines, labelAnchor: 'start' }
    }
    const x1 = a.x + w
    const y1 = a.y + h / 2
    const x2 = b.x
    const y2 = b.y + h / 2
    const dx = Math.max(12, (x2 - x1) / 2)
    return { ...edge, route: 'forward', path: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, labelX: (x1 + x2) / 2, labelY: (y1 + y2) / 2 - 7 - (labelLines.length - 1) * lineHeight, labelLines, labelAnchor: 'middle' }
  })

  return { nodes: [...laidOut.values()], edges: routed, width, height, layers, orientation }
}

export type NodeStatus = 'new' | 'changed' | 'same' | 'removed'

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
 * line up vertically. Nodes only in `after` are new; shared ids whose label changed (or that the technique
 * highlights) are changed; nodes only in `before` are removed. Before-only nodes go one column after their
 * aligned predecessor, and every forward edge keeps pointing right.
 */
export function compareFlows(
  beforeDiagram: FlowDiagramData | null | undefined,
  afterDiagram: FlowDiagramData | null | undefined,
  metrics: FlowMetrics = FULL_METRICS,
  orientation: FlowOrientation = 'horizontal',
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

  const gapX = orientation === 'vertical' ? metrics.gapX : Math.max(labelGap(beforeDiagram, metrics), labelGap(afterDiagram, metrics))
  const columns = Math.max(afterLayers.size ? Math.max(...afterLayers.values()) + 1 : 0, aligned.size ? Math.max(...aligned.values()) + 1 : 0)
  return {
    before: layoutFlow(beforeDiagram, metrics, { fixedLayers: aligned, minLayers: columns, gapX, orientation }),
    after: layoutFlow(afterDiagram, metrics, { minLayers: columns, gapX, orientation }),
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
