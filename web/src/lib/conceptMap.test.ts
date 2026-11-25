import { describe, expect, it } from 'vitest'
import type { ConceptLinkData, ConceptNode } from '../api/types'
import type { ClaimRelated } from '../api/types'
import { flowEdge, layoutConceptMap, neighbours, normalizeLinks, normalizeRelated, readingPathParts, shortEffect, shortName } from './conceptMap'
import { containsPoint, samplePath } from './geometry'

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

  // The two maps from the audit (OV-16): arxiv:2606.24033 and arxiv:2611.27561.
  const paperMap = (nodes: [number, string, string, number][], links: [number, number, string][]) => ({
    nodes: nodes.map(([concept_id, name, role, order]) => ({ concept_id, claim_id: concept_id, name, role, order })),
    links: links.map(([source, target, relation]) => link(source, target, relation)),
  })
  const BLOCK_GTQ = paperMap(
    [
      [165, 'RoPE-block logit-error bound for key quantization', 'foundation', 1],
      [166, 'Label-free Q/K energy block importance score', 'core', 2],
      [168, 'TQ-MSE-instantiated Block-GTQ objective (4^{-b} penalty)', 'core', 3],
      [167, 'Separable integer rate allocation with optimal largest-marginal-gain greedy', 'core', 4],
      [169, 'Equal-rate grouping to realize mixed block rates with one codec per occupied rate', 'optimization', 5],
      [170, 'Packed-cache fused attention without materializing fp16 KV in HBM', 'optimization', 6],
      [171, 'Matched-budget accuracy gains at low KV rates (NIAH, LongBench-EN, AIME)', 'evaluation', 7],
      [172, 'Packed serving memory/perplexity trade-off at 128K (Qwen2.5-3B, K3V3)', 'evaluation', 8],
      [173, 'Stated limitations: no joint K/V budget optimization; limited deployment scope; safety not evaluated', 'limitation', 9],
    ],
    [
      [166, 165, 'builds_on'], [168, 166, 'requires'], [167, 168, 'builds_on'], [169, 168, 'requires'], [170, 169, 'requires'],
      [171, 166, 'evaluated_by'], [171, 168, 'evaluated_by'], [172, 170, 'evaluated_by'], [172, 168, 'evaluated_by'], [173, 168, 'evaluated_by'],
    ],
  )
  const VQACC = paperMap(
    [
      [526, 'Empirical finding: on-chip traffic dominates after VQ removes DRAM bottleneck', 'foundation', 1],
      [528, 'Limitation: EVA-style output-lookup degrades with batch and lacks KV/prefill support', 'limitation', 2],
      [521, 'VQACC (WB-integrated VQ dequantization)', 'core', 3],
      [522, 'Codebook-Index Mapping in Weight Buffer (WB)', 'core', 4],
      [523, 'Index Address Generator + Port Multiplexing for Lookups', 'core', 5],
      [524, 'Shift Layout Unit (rotator-based on-the-fly transpose)', 'extension', 6],
      [525, 'Codebook-Stationary Tile Scheduling', 'extension', 7],
      [527, 'Evaluation methodology: cycle-level SA simulator + RTL area/energy breakdown', 'evaluation', 8],
    ],
    [[521, 522, 'requires'], [521, 523, 'requires'], [521, 524, 'builds_on'], [523, 522, 'requires'], [524, 522, 'requires'], [525, 521, 'builds_on'], [521, 526, 'builds_on'], [521, 527, 'evaluated_by'], [521, 528, 'complements']],
  )

  it('routes every link around the nodes it passes and keeps names inside their nodes (OV-16)', () => {
    for (const map of [BLOCK_GTQ, VQACC]) {
      const layout = layoutConceptMap(map)
      expect(new Set(layout.nodes.map((n) => n.height)).size).toBe(1)
      for (const n of layout.nodes) {
        expect(n.lines.length).toBeLessThanOrEqual(4)
        expect(n.textBox!.x).toBeGreaterThanOrEqual(n.x)
        expect(n.textBox!.x + n.textBox!.width).toBeLessThanOrEqual(n.x + n.width)
        expect(n.textBox!.y).toBeGreaterThanOrEqual(n.y)
        expect(n.textBox!.y + n.textBox!.height).toBeLessThanOrEqual(n.y + n.height)
        expect(n.y).toBeGreaterThanOrEqual(0)
        expect(n.y + n.height).toBeLessThanOrEqual(layout.height)
      }
      for (const l of layout.links) {
        for (const sample of samplePath(l.segments, 2)) {
          for (const n of layout.nodes) expect(containsPoint(n, sample.point, 1.5), `${l.source}→${l.target} through ${n.concept_id}`).toBe(false)
          expect(sample.point.y).toBeGreaterThanOrEqual(0)
          expect(sample.point.y).toBeLessThanOrEqual(layout.height)
        }
      }
    }
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
