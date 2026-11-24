import { describe, expect, it } from 'vitest'
import type { ConceptLinkData, ConceptNode } from '../api/types'
import type { ClaimRelated } from '../api/types'
import { flowEdge, layoutConceptMap, neighbours, normalizeLinks, normalizeRelated, readingPathParts, shortEffect, shortName } from './conceptMap'

const node = (concept_id: number, order: number, role: string | null = 'core'): ConceptNode => ({
  concept_id,
  claim_id: concept_id,
  name: `Concept ${concept_id}`,
  role,
  order,
})
const link = (source: number, target: number, relation: string): ConceptLinkData => ({ source, target, relation, why: null })

describe('flowEdge', () => {
  it('draws prerequisites and bases before the concepts that need or extend them', () => {
    expect(flowEdge(link(1, 2, 'requires'))).toEqual({ from: 2, to: 1 })
    expect(flowEdge(link(1, 2, 'builds_on'))).toEqual({ from: 2, to: 1 })
    expect(flowEdge(link(1, 2, 'evaluated_by'))).toEqual({ from: 1, to: 2 })
    expect(flowEdge(link(1, 2, 'complements'))).toBeNull()
  })
})

describe('layoutConceptMap', () => {
  it('puts prerequisites left of dependents and evaluations/limitations in a last column', () => {
    const layout = layoutConceptMap({
      nodes: [node(10, 1), node(11, 2), node(12, 3, 'extension'), node(13, 4, 'evaluation'), node(14, 5, 'limitation')],
      links: [link(10, 11, 'requires'), link(12, 10, 'builds_on'), link(10, 13, 'evaluated_by'), link(10, 14, 'evaluated_by')],
    })
    const col = Object.fromEntries(layout.nodes.map((n) => [n.concept_id, n.column]))
    expect(col).toEqual({ 11: 0, 10: 1, 12: 2, 13: 3, 14: 3 })
    expect(layout.columns).toBe(4)
    const requires = layout.links.find((l) => l.relation === 'requires')!
    expect(requires).toMatchObject({
      from: 11,
      to: 10,
      arrow: 'end',
      sameColumn: false,
    })
  })

  it('keeps unlinked concepts with their reading-order neighbour and arcs same-column links', () => {
    const layout = layoutConceptMap({
      nodes: [node(1, 1), node(2, 2)],
      links: [link(1, 2, 'complements')],
    })
    expect(layout.nodes.map((n) => n.column)).toEqual([0, 0])
    expect(layout.links[0]).toMatchObject({ arrow: null, sameColumn: true })
    expect(layout.width).toBeGreaterThan(0)
  })

  it('survives cycles, unknown ids and duplicate nodes', () => {
    const layout = layoutConceptMap({
      nodes: [node(1, 1), node(2, 2), node(2, 2)],
      links: [link(1, 2, 'requires'), link(2, 1, 'requires'), link(1, 99, 'requires'), link(1, 1, 'builds_on')],
    })
    expect(layout.nodes).toHaveLength(2)
    expect(layout.links).toHaveLength(2)
  })

  it('returns an empty layout without nodes', () => {
    expect(layoutConceptMap(null)).toMatchObject({
      nodes: [],
      width: 0,
      columns: 0,
    })
  })
})

describe('shortEffect', () => {
  it('extracts the first quantified result', () => {
    expect(shortEffect('Improves wall-clock speedup by 5% to 41% over the baseline')).toBe('5–41%')
    expect(shortEffect('16.09× supervised-token throughput over Draft-OPD')).toBe('16.09×')
    expect(shortEffect('3.05x over vanilla decoding')).toBe('3.05×')
    expect(shortEffect('+12% accepted tokens per step')).toBe('+12%')
    expect(shortEffect('MemOnce 4B achieves 60.07% average over five benchmarks, +5.77% vs Qwen3.5-4B full-context')).toBe('+5.77%')
    expect(shortEffect('Reduces memory state cache by 1313× and prefill latency by 6.9×')).toBe('1313×')
    expect(shortEffect('3.1% lower perplexity than without clipping')).toBe('3.1%')
    expect(shortEffect('Prefill time scales from 1.38s (32K) to 41.36s (1M).')).toBeNull()
    expect(shortEffect('not quantified')).toBeNull()
    expect(shortEffect(null)).toBeNull()
  })
})

describe('shortName / neighbours', () => {
  it('drops a trailing parenthetical and truncates', () => {
    expect(shortName('Confidence-gated drafting loop (multi-stage per verification)')).toBe('Confidence-gated drafting loop')
    expect(shortName('A very long concept name that keeps going and going', 20)).toBe('A very long concept…')
  })

  it('phrases links from the selected concept', () => {
    const map = {
      nodes: [node(1, 1), node(2, 2), node(3, 3)],
      links: [link(1, 2, 'requires'), link(3, 1, 'builds_on')],
    }
    expect(neighbours(map, 1).map((n) => `${n.phrase}:${n.node.concept_id}`)).toEqual(['Needs first:2', 'Extended by:3'])
  })
})

describe('shortName word boundary', () => {
  it('cuts at a word boundary when one is close to the limit', () => {
    expect(shortName('Tree attention mask for one-pass verification', 26)).toBe('Tree attention mask for…')
    expect(shortName('Confidence-gated drafting loop', 26)).toBe('Confidence-gated drafting…')
  })
})

describe('normalizeLinks / normalizeRelated', () => {
  it('makes the evaluation the measuring side of evaluated_by', () => {
    const nodes = [node(1, 1), node(2, 2, 'evaluation')]
    expect(normalizeLinks(nodes, [link(2, 1, 'evaluated_by')])[0]).toMatchObject({ source: 1, target: 2 })
    expect(normalizeLinks(nodes, [link(1, 2, 'evaluated_by')])[0]).toMatchObject({ source: 1, target: 2 })
    expect(normalizeLinks(nodes, [link(2, 1, 'requires')])[0]).toMatchObject({ source: 2, target: 1 })
  })

  it('moves reversed items between "measured by" and "measures"', () => {
    const empty = { requires: [], required_by: [], builds_on: [], extended_by: [], complements: [], alternatives: [], bundles: [], prerequisites: [] }
    const core = { ...empty, role: 'core', evaluated_by: [], evaluates: [{ ...node(9, 5, 'evaluation'), why: null }] } as ClaimRelated
    expect(normalizeRelated(core)).toMatchObject({ evaluates: [], evaluated_by: [{ concept_id: 9 }] })
    const evaluation = { ...empty, role: 'evaluation', evaluated_by: [{ ...node(3, 1), why: null }], evaluates: [] } as ClaimRelated
    expect(normalizeRelated(evaluation)).toMatchObject({ evaluated_by: [], evaluates: [{ concept_id: 3 }] })
  })
})

describe('readingPathParts', () => {
  it('maps prompt indices (by concept id) to reading-order numbers', () => {
    const nodes = [node(30, 1), node(10, 2), node(20, 3)]
    const parts = readingPathParts('Start with C3, then C1 (and C9).', nodes)
    expect(parts.map((part) => (typeof part === 'string' ? part : `#${part.order}`))).toEqual(['Start with ', '#1', ', then ', '#2', ' (and C9).'])
    expect(readingPathParts('Plain (1) then (2).', nodes)).toEqual(['Plain (1) then (2).'])
  })
})
