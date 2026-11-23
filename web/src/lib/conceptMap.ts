import type { ClaimRelated, ConceptBundle, ConceptLinkData, ConceptMap, ConceptNode, DiagramEdge, DiagramNode } from '../api/types'
import { assignLayers } from './flow'

// ---- relation vocabulary ------------------------------------------------------------------

export interface RelationInfo {
  /** Legend / edge label, read along the drawn arrow ("A → is needed for → B"). */
  label: string
  /** Sentence for a link A <relation> B in the API's direction. */
  sentence: (a: string, b: string) => string
  /** Drawn arrow goes from the API target to the source (prerequisite → dependent). */
  reversed: boolean
  directed: boolean
}

export const RELATIONS: Record<string, RelationInfo> = {
  requires: {
    label: 'needed first',
    sentence: (a, b) => `${a} needs ${b} first`,
    reversed: true,
    directed: true,
  },
  builds_on: {
    label: 'extended by',
    sentence: (a, b) => `${a} extends ${b}`,
    reversed: true,
    directed: true,
  },
  complements: {
    label: 'works with',
    sentence: (a, b) => `${a} works together with ${b}`,
    reversed: false,
    directed: false,
  },
  alternative_to: {
    label: 'or (alternative)',
    sentence: (a, b) => `${a} is an alternative to ${b}`,
    reversed: false,
    directed: false,
  },
  evaluated_by: {
    label: 'measured by',
    sentence: (a, b) => `${a} is measured by ${b}`,
    reversed: false,
    directed: true,
  },
}

export const relationInfo = (relation: string): RelationInfo =>
  RELATIONS[relation] ?? {
    label: relation.replace(/_/g, ' '),
    sentence: (a, b) => `${a} ${relation.replace(/_/g, ' ')} ${b}`,
    reversed: false,
    directed: false,
  }

export const ROLE_LABELS: Record<string, string> = {
  foundation: 'Foundation',
  core: 'Core idea',
  extension: 'Extension',
  optimization: 'Optimization',
  evaluation: 'Evaluation',
  limitation: 'Limitation',
}

export const roleLabel = (role: string | null | undefined) => (role ? (ROLE_LABELS[role] ?? role.replace(/_/g, ' ')) : null)

/** Evaluation/limitation concepts measure or bound the others; they go in a last column. */
const TAIL_ROLES = new Set(['evaluation', 'limitation'])
const isTailRole = (role: string | null | undefined) => TAIL_ROLES.has(String(role ?? ''))

/**
 * Generated maps sometimes state "<evaluation> evaluated_by <concept>"; flip those so the evaluation or
 * limitation is always the side that measures (the link's target).
 */
export function normalizeLinks(nodes: ConceptNode[], links: ConceptLinkData[]): ConceptLinkData[] {
  const role = new Map(nodes.map((node) => [node.concept_id, node.role]))
  return links.map((link) =>
    link.relation === 'evaluated_by' && isTailRole(role.get(link.source)) && !isTailRole(role.get(link.target))
      ? { ...link, source: link.target, target: link.source }
      : link,
  )
}

/** Same correction for a claim's `related` lists ("Measured by" vs "Measures"). */
export function normalizeRelated(related: ClaimRelated): ClaimRelated {
  const evaluatedBy = related.evaluated_by ?? []
  const evaluates = related.evaluates ?? []
  if (isTailRole(related.role)) {
    return {
      ...related,
      evaluated_by: evaluatedBy.filter((node) => isTailRole(node.role)),
      evaluates: [...evaluates, ...evaluatedBy.filter((node) => !isTailRole(node.role))],
    }
  }
  return {
    ...related,
    evaluates: evaluates.filter((node) => !isTailRole(node.role)),
    evaluated_by: [...evaluatedBy, ...evaluates.filter((node) => isTailRole(node.role))],
  }
}

// ---- layout ---------------------------------------------------------------------------------

export interface ConceptMapMetrics {
  nodeWidth: number
  nodeHeight: number
  gapX: number
  gapY: number
  padX: number
  padY: number
}

export const CONCEPT_METRICS: ConceptMapMetrics = {
  nodeWidth: 138,
  nodeHeight: 48,
  gapX: 50,
  gapY: 16,
  padX: 12,
  padY: 14,
}

export interface PlacedConcept extends ConceptNode {
  column: number
  row: number
  x: number
  y: number
  width: number
  height: number
}

export interface PlacedLink extends ConceptLinkData {
  /** Drawn from `from` to `to` (left to right, or top to bottom in the same column). */
  from: number
  to: number
  /** Which drawn end carries the arrowhead (none for symmetric relations). */
  arrow: 'start' | 'end' | null
  path: string
  sameColumn: boolean
}

export interface ConceptMapLayout {
  nodes: PlacedConcept[]
  links: PlacedLink[]
  width: number
  height: number
  columns: number
}

const nodeKey = (id: number) => String(id)

/**
 * Flow direction of a link for layering: prerequisite → dependent, base → extension, concept → its evaluation.
 * Symmetric relations (complements, alternatives) do not order concepts.
 */
export function flowEdge(link: ConceptLinkData): { from: number; to: number } | null {
  const info = RELATIONS[link.relation]
  if (!info || !info.directed) return null
  return info.reversed ? { from: link.target, to: link.source } : { from: link.source, to: link.target }
}

/**
 * Left-to-right layout of a paper's concept map: longest-path columns over the "needs / extends / measured by"
 * edges (cycles broken), evaluation & limitation concepts in a final column, and rows in reading order.
 * Concepts without directed links stay in the column of the previous concept in reading order.
 */
export function layoutConceptMap(map: Pick<ConceptMap, 'nodes' | 'links'> | null | undefined, metrics: ConceptMapMetrics = CONCEPT_METRICS): ConceptMapLayout {
  const nodes = dedupeNodes(map?.nodes ?? [])
  if (!nodes.length) return { nodes: [], links: [], width: 0, height: 0, columns: 0 }
  const ids = new Set(nodes.map((node) => node.concept_id))
  const links = normalizeLinks(
    nodes,
    (map?.links ?? []).filter((link) => ids.has(link.source) && ids.has(link.target) && link.source !== link.target),
  )
  const orderOf = new Map(nodes.map((node, index) => [node.concept_id, node.order ?? index + 1]))
  const isTail = (id: number) => isTailRole(nodes.find((node) => node.concept_id === id)?.role)

  const main = nodes.filter((node) => !isTail(node.concept_id))
  const flow: DiagramEdge[] = []
  const linked = new Set<number>()
  for (const link of links) {
    const edge = flowEdge(link)
    if (!edge || isTail(edge.from) || isTail(edge.to)) continue
    flow.push({
      from: nodeKey(edge.from),
      to: nodeKey(edge.to),
      label: null,
      style: 'normal',
    })
    linked.add(edge.from)
    linked.add(edge.to)
  }
  const diagramNodes: DiagramNode[] = main.map((node) => ({
    id: nodeKey(node.concept_id),
    label: node.name,
    kind: 'step',
    highlight: false,
  }))
  const { layer } = assignLayers(diagramNodes, flow)

  const column = new Map<number, number>()
  const byReading = [...main].sort((a, b) => orderOf.get(a.concept_id)! - orderOf.get(b.concept_id)!)
  let previous = 0
  for (const node of byReading) {
    const value = linked.has(node.concept_id) ? layer.get(nodeKey(node.concept_id))! : previous
    column.set(node.concept_id, value)
    previous = value
  }
  const mainColumns = main.length ? Math.max(...column.values()) + 1 : 0
  for (const node of nodes) if (isTail(node.concept_id)) column.set(node.concept_id, mainColumns)
  const columns = Math.max(...column.values()) + 1

  const groups: ConceptNode[][] = Array.from({ length: columns }, () => [])
  for (const node of nodes) groups[column.get(node.concept_id)!].push(node)
  for (const group of groups) group.sort((a, b) => orderOf.get(a.concept_id)! - orderOf.get(b.concept_id)!)

  const { nodeWidth: w, nodeHeight: h, gapX, gapY, padX, padY } = metrics
  const maxRows = Math.max(...groups.map((group) => group.length))
  const hasSameColumn = links.some((link) => column.get(link.source) === column.get(link.target))
  const sideRoom = hasSameColumn ? 22 : 0
  const bodyHeight = maxRows * h + (maxRows - 1) * gapY
  const width = padX * 2 + columns * w + (columns - 1) * gapX + sideRoom
  const height = padY * 2 + bodyHeight
  const midY = padY + bodyHeight / 2

  const placed = new Map<number, PlacedConcept>()
  groups.forEach((group, col) => {
    group.forEach((node, index) => {
      const row = index - (group.length - 1) / 2
      placed.set(node.concept_id, {
        ...node,
        column: col,
        row,
        x: padX + col * (w + gapX),
        y: midY + row * (h + gapY) - h / 2,
        width: w,
        height: h,
      })
    })
  })

  const placedLinks: PlacedLink[] = links.map((link) => {
    const edge = flowEdge(link)
    const a = placed.get(link.source)!
    const b = placed.get(link.target)!
    const [left, right] = a.column < b.column || (a.column === b.column && a.y <= b.y) ? [a, b] : [b, a]
    const arrow: PlacedLink['arrow'] = edge ? (edge.to === right.concept_id ? 'end' : 'start') : null
    const sameColumn = left.column === right.column
    let path: string
    if (sameColumn) {
      const x = left.x + w
      const y1 = left.y + h / 2
      const y2 = right.y + h / 2
      const bulge = 16 + Math.min(10, Math.abs(right.row - left.row) * 4)
      path = `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x} ${y2}`
    } else {
      const x1 = left.x + w
      const y1 = left.y + h / 2
      const x2 = right.x
      const y2 = right.y + h / 2
      const dx = Math.max(16, (x2 - x1) / 2)
      path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
    }
    return {
      ...link,
      from: left.concept_id,
      to: right.concept_id,
      arrow,
      path,
      sameColumn,
    }
  })

  return {
    nodes: [...placed.values()],
    links: placedLinks,
    width,
    height,
    columns,
  }
}

function dedupeNodes(nodes: ConceptNode[]): ConceptNode[] {
  const seen = new Set<number>()
  return nodes.filter((node) => {
    if (!node || typeof node.concept_id !== 'number' || seen.has(node.concept_id)) return false
    seen.add(node.concept_id)
    return true
  })
}

// ---- text helpers -----------------------------------------------------------------------------

const UNIT = String.raw`(%|×|x(?![a-z]))`
const RANGE_RE = new RegExp(String.raw`([+−-]?)(\d+(?:\.\d+)?)\s?${UNIT}?\s?(?:to|–|-)\s?(\d+(?:\.\d+)?)\s?${UNIT}`, 'gi')
const SINGLE_RE = new RegExp(String.raw`([+−-]?)(\d+(?:\.\d+)?)\s?${UNIT}`, 'gi')

interface EffectCandidate {
  index: number
  end: number
  text: string
  /** A change rather than a level: a range, a multiplier, a signed percentage or "by N%". */
  strong: boolean
}

/**
 * The headline number of a bundle's effect sentence. Prefers the first change ("by 5% to 41%" → "5–41%",
 * "16.09x faster" → "16.09×", "+5.77% vs base" → "+5.77%") over plain levels ("60.07% average").
 */
export function shortEffect(effect: string | null | undefined): string | null {
  if (!effect) return null
  const unit = (value: string | undefined) => (value ? (value.toLowerCase() === 'x' ? '×' : value) : '')
  const candidates: EffectCandidate[] = []
  for (const match of effect.matchAll(RANGE_RE)) {
    const [, sign, from, unitFrom, to, unitTo] = match
    const a = unit(unitFrom)
    const b = unit(unitTo)
    const text = a && a !== b ? `${sign}${from}${a}–${to}${b}` : `${sign}${from}–${to}${b}`
    candidates.push({ index: match.index, end: match.index + match[0].length, text, strong: true })
  }
  for (const match of effect.matchAll(SINGLE_RE)) {
    if (candidates.some((c) => c.strong && match.index >= c.index && match.index < c.end)) continue
    const [, sign, value, suffix] = match
    const u = unit(suffix)
    const strong = u === '×' || !!sign || /\bby\s*$/i.test(effect.slice(Math.max(0, match.index - 4), match.index))
    candidates.push({ index: match.index, end: match.index + match[0].length, text: `${sign}${value}${u}`, strong })
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => Number(b.strong) - Number(a.strong) || a.index - b.index)
  return candidates[0].text
}

/** Short concept name for chips ("Confidence-gated drafting loop (multi-stage…)" → "Confidence-gated drafting loop"). */
export function shortName(name: string, max = 34): string {
  const base = name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name
  if (base.length <= max) return base
  const cut = base.slice(0, max - 1)
  if (base[max - 1] === ' ') return `${cut.trimEnd()}…`
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The headline-result bundle that includes this concept (and at least one other), if any. */
export function headlineBundle(related: ClaimRelated | null | undefined, claimId: number): ConceptBundle | null {
  const bundles = related?.bundles ?? []
  return (
    bundles.find((bundle) => bundle.is_headline_result && bundle.members.some((member) => member.claim_id === claimId) && bundle.members.length > 1) ?? null
  )
}

/** True when there is anything worth showing about how this concept connects to the rest of its paper. */
export function hasRelations(related: ClaimRelated | null | undefined): boolean {
  if (!related) return false
  const lists = [
    related.requires,
    related.required_by,
    related.builds_on,
    related.extended_by,
    related.complements,
    related.alternatives,
    related.evaluated_by,
    related.evaluates,
    related.bundles,
    related.prerequisites,
  ]
  return lists.some((list) => (list?.length ?? 0) > 0)
}

/** Every directly linked concept of a node in a concept map, with the relation phrased from the node's side. */
export function neighbours(map: Pick<ConceptMap, 'nodes' | 'links'>, conceptId: number): { node: ConceptNode; phrase: string; why: string | null }[] {
  const byId = new Map(map.nodes.map((node) => [node.concept_id, node]))
  const result: { node: ConceptNode; phrase: string; why: string | null }[] = []
  for (const link of normalizeLinks(map.nodes, map.links)) {
    const outgoing = link.source === conceptId
    if (!outgoing && link.target !== conceptId) continue
    const other = byId.get(outgoing ? link.target : link.source)
    if (!other) continue
    const phrase = PHRASES[link.relation]?.[outgoing ? 0 : 1] ?? link.relation.replace(/_/g, ' ')
    result.push({ node: other, phrase, why: link.why ?? null })
  }
  return result
}

const PHRASES: Record<string, [string, string]> = {
  requires: ['Needs first', 'Needed by'],
  builds_on: ['Extends', 'Extended by'],
  complements: ['Works with', 'Works with'],
  alternative_to: ['Alternative to', 'Alternative to'],
  evaluated_by: ['Measured by', 'Measures'],
}

export type ReadingPathPart = string | { order: number; node: ConceptNode }

/**
 * Generated reading paths cite concepts as "C1…Cn" — their position in the prompt, i.e. by concept id — while
 * the map numbers them in reading order. Split the text so those references can be shown as reading-order badges.
 */
export function readingPathParts(path: string | null | undefined, nodes: ConceptNode[]): ReadingPathPart[] {
  if (!path) return []
  const byPrompt = [...nodes].sort((a, b) => a.concept_id - b.concept_id)
  const parts: ReadingPathPart[] = []
  let last = 0
  for (const match of path.matchAll(/\bC(\d{1,2})\b/g)) {
    const node = byPrompt[Number(match[1]) - 1]
    if (!node || node.order == null) continue
    if (match.index > last) parts.push(path.slice(last, match.index))
    parts.push({ order: node.order, node })
    last = match.index + match[0].length
  }
  if (last < path.length) parts.push(path.slice(last))
  return parts
}
