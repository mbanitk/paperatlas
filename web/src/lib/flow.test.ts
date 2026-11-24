import { describe, expect, it } from 'vitest'
import type { FlowDiagramData } from '../api/types'
import { assignLayers, layoutFlow, sanitizeDiagram, wrapLabel } from './flow'

const node = (id: string, kind = 'step', highlight = false) => ({ id, label: id.toUpperCase(), kind, highlight })
const edge = (from: string, to: string, style: 'normal' | 'loop' | 'skip' = 'normal') => ({ from, to, label: null, style })

describe('assignLayers', () => {
  it('uses the longest path from the sources', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => node(id))
    const { layer } = assignLayers(nodes, [edge('a', 'b'), edge('b', 'c'), edge('a', 'c'), edge('c', 'd')])
    expect([...layer.values()]).toEqual([0, 1, 2, 3])
  })

  it('ignores loop edges and breaks accidental cycles', () => {
    const nodes = ['a', 'b', 'c'].map((id) => node(id))
    const looped = assignLayers(nodes, [edge('a', 'b'), edge('b', 'c'), edge('c', 'a', 'loop')])
    expect([...looped.layer.values()]).toEqual([0, 1, 2])
    const cyclic = assignLayers(nodes, [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')])
    expect([...cyclic.layer.values()]).toEqual([0, 1, 2])
    expect(cyclic.backEdges.size).toBe(1)
  })
})

describe('layoutFlow', () => {
  const diagram: FlowDiagramData = {
    title: 'Speculative decoding',
    nodes: [node('prompt', 'input'), node('draft', 'model', true), node('lookup', 'memory', true), node('verify', 'decision'), node('out', 'output')],
    edges: [edge('prompt', 'draft'), edge('prompt', 'lookup'), edge('draft', 'verify'), edge('lookup', 'verify'), edge('verify', 'out'), edge('verify', 'draft', 'loop')],
  }

  it('places parallel branches in the same layer, one above the other', () => {
    const layout = layoutFlow(diagram)
    const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]))
    expect(layout.layers).toBe(4)
    expect(byId.draft.layer).toBe(byId.lookup.layer)
    expect(byId.draft.x).toBe(byId.lookup.x)
    expect(byId.draft.y).toBeLessThan(byId.lookup.y)
    expect(byId.prompt.y + byId.prompt.height / 2).toBeCloseTo(byId.verify.y + byId.verify.height / 2)
    expect(byId.out.x).toBeGreaterThan(byId.verify.x)
  })

  it('routes loop edges below the nodes and keeps everything inside the canvas', () => {
    const layout = layoutFlow(diagram)
    expect(layout.edges.find((e) => e.style === 'loop')?.route).toBe('loop')
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.x + n.width).toBeLessThanOrEqual(layout.width)
      expect(n.y + n.height).toBeLessThanOrEqual(layout.height)
    }
  })

  it('arcs skip edges over intermediate nodes on the same row', () => {
    const chain = { nodes: ['a', 'b', 'c'].map((id) => node(id)), edges: [edge('a', 'b'), edge('b', 'c'), edge('a', 'c', 'skip')] }
    expect(layoutFlow(chain).edges.find((e) => e.style === 'skip')?.route).toBe('arc')
  })

  it('arcs skip edges above every intermediate node on branched flows', () => {
    const branched = {
      nodes: ['a', 'b', 'd', 'c'].map((id) => node(id)),
      edges: [edge('a', 'b'), edge('b', 'c'), edge('a', 'd'), edge('d', 'c'), edge('a', 'c', 'skip')],
    }
    const layout = layoutFlow(branched)
    const skip = layout.edges.find((e) => e.style === 'skip')!
    expect(skip.route).toBe('arc')
    const high = parseFloat(skip.path.split(' ')[5])
    const b = layout.nodes.find((n) => n.id === 'b')!
    expect(b.y).toBeLessThan(layout.nodes.find((n) => n.id === 'a')!.y)
    expect(high).toBeLessThan(b.y)
    expect(high).toBeGreaterThanOrEqual(0)
  })

  it('drops broken input instead of failing', () => {
    expect(layoutFlow(null).nodes).toEqual([])
    const broken = sanitizeDiagram({ nodes: [node('a'), node('a'), node('b')], edges: [edge('a', 'zzz'), edge('a', 'a'), edge('a', 'b')] })
    expect(broken.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(broken.edges).toHaveLength(1)
  })
})

describe('wrapLabel', () => {
  it('wraps on words and truncates long labels', () => {
    expect(wrapLabel('Confidence gate', 14)).toEqual(['Confidence', 'gate'])
    expect(wrapLabel('WB: idx+codebook', 14)).toEqual(['WB:', 'idx+codebook'])
    expect(wrapLabel('Extremely long label that keeps going', 10, 2)).toEqual(['Extremely', 'long labe…'])
  })
})
