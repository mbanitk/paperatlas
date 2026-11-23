import type { DiagramEdge, DiagramNode, FlowDiagramData } from '../api/types'

/** Geometry of one diagram variant. */
export interface FlowMetrics {
  nodeWidth: number
  nodeHeight: number
  gapX: number
  gapY: number
  padX: number
  padY: number
  /** Extra room above the nodes for skip edges that arc over a row, and below for loop edges. */
  arcRoom: number
}

export const FULL_METRICS: FlowMetrics = { nodeWidth: 108, nodeHeight: 42, gapX: 42, gapY: 14, padX: 6, padY: 14, arcRoom: 26 }
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
}

export interface FlowLayout {
  nodes: LaidOutNode[]
  edges: LaidOutEdge[]
  width: number
  height: number
  layers: number
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

/** Left-to-right layered layout with rows ordered by the barycenter of their predecessors. */
export function layoutFlow(diagram: FlowDiagramData | null | undefined, metrics: FlowMetrics = FULL_METRICS): FlowLayout {
  const { nodes, edges } = sanitizeDiagram(diagram)
  const { nodeWidth: w, nodeHeight: h, gapX, gapY, padX, padY, arcRoom } = metrics
  if (!nodes.length) return { nodes: [], edges: [], width: 0, height: 0, layers: 0 }

  const { layer, backEdges } = assignLayers(nodes, edges)
  const layers = Math.max(...layer.values()) + 1
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
  const sameRowArcs = edges.some((edge) => {
    if (backEdges.has(edge)) return false
    return layer.get(edge.to)! - layer.get(edge.from)! > 1 && row.get(edge.to) === row.get(edge.from)
  })
  const top = padY + (sameRowArcs ? arcRoom : 0)
  const bodyHeight = maxRows * h + (maxRows - 1) * gapY
  const bottom = padY + (backEdges.size ? arcRoom : 0)
  const width = padX * 2 + layers * w + (layers - 1) * gapX
  const height = top + bodyHeight + bottom
  const midY = top + bodyHeight / 2

  const laidOut = new Map<string, LaidOutNode>()
  for (const node of nodes) {
    const l = layer.get(node.id)!
    const x = padX + l * (w + gapX)
    const y = midY + row.get(node.id)! * (h + gapY) - h / 2
    laidOut.set(node.id, { ...node, layer: l, row: row.get(node.id)!, x, y, width: w, height: h })
  }

  const routed: LaidOutEdge[] = edges.map((edge) => {
    const a = laidOut.get(edge.from)!
    const b = laidOut.get(edge.to)!
    if (backEdges.has(edge)) {
      const x1 = a.x + w / 2
      const x2 = b.x + w / 2
      const y1 = a.y + h
      const y2 = b.y + h
      const low = Math.max(y1, y2) + arcRoom - 2
      return { ...edge, route: 'loop', path: `M ${x1} ${y1} C ${x1} ${low}, ${x2} ${low}, ${x2} ${y2}`, labelX: (x1 + x2) / 2, labelY: low - 2 }
    }
    const x1 = a.x + w
    const y1 = a.y + h / 2
    const x2 = b.x
    const y2 = b.y + h / 2
    if (b.layer - a.layer > 1 && a.row === b.row) {
      const high = Math.min(a.y, b.y) - arcRoom + 4
      const sx = a.x + w / 2
      const ex = b.x + w / 2
      return { ...edge, route: 'arc', path: `M ${sx} ${a.y} C ${sx} ${high}, ${ex} ${high}, ${ex} ${b.y}`, labelX: (sx + ex) / 2, labelY: high + 6 }
    }
    const dx = Math.max(12, (x2 - x1) / 2)
    return { ...edge, route: 'forward', path: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, labelX: (x1 + x2) / 2, labelY: (y1 + y2) / 2 - 4 }
  })

  return { nodes: [...laidOut.values()], edges: routed, width, height, layers }
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
