import { describe, expect, it } from 'vitest'
import type { FlowDiagramData } from '../api/types'
import { assignLayers, compareFlows, layoutFlow, sanitizeDiagram, VERTICAL_METRICS, wrapLabel } from './flow'

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

  it('routes loops below every node they span, not just their endpoints', () => {
    const layout = layoutFlow(diagram)
    const loop = layout.edges.find((e) => e.route === 'loop')!
    const lowest = Math.max(...layout.nodes.filter((n) => n.id === 'draft' || n.id === 'lookup' || n.id === 'verify').map((n) => n.y + n.height))
    expect(parseFloat(loop.path.split(' ')[5])).toBeGreaterThan(lowest)
  })

  it('lays out top to bottom with loops on the left and labels inside the canvas', () => {
    const layout = layoutFlow(diagram, VERTICAL_METRICS, { orientation: 'vertical' })
    const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]))
    expect(layout.orientation).toBe('vertical')
    expect(byId.prompt.y).toBeLessThan(byId.draft.y)
    expect(byId.draft.y).toBe(byId.lookup.y)
    expect(byId.draft.x).toBeLessThan(byId.lookup.x)
    const loop = layout.edges.find((e) => e.route === 'loop')!
    expect(loop.labelRotate).toBe(-90)
    expect(loop.labelX).toBeGreaterThan(0)
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThan(0)
      expect(n.x + n.width).toBeLessThanOrEqual(layout.width)
      expect(n.y + n.height).toBeLessThanOrEqual(layout.height)
    }
  })

  it('widens the gap between columns for long edge labels and wraps them', () => {
    const labelled = { nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b', label: 'warm prefixes first', style: 'normal' }] }
    const plain = layoutFlow({ nodes: [node('a'), node('b')], edges: [edge('a', 'b')] })
    const wide = layoutFlow(labelled)
    expect(wide.width).toBeGreaterThan(plain.width)
    expect(wide.edges[0].labelLines).toEqual(['warm prefixes', 'first'])
  })

  it('drops broken input instead of failing', () => {
    expect(layoutFlow(null).nodes).toEqual([])
    const broken = sanitizeDiagram({ nodes: [node('a'), node('a'), node('b')], edges: [edge('a', 'zzz'), edge('a', 'a'), edge('a', 'b')] })
    expect(broken.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(broken.edges).toHaveLength(1)
  })
})

describe('compareFlows', () => {
  const labelled = (id: string, label: string, kind = 'step', highlight = false) => ({ id, label, kind, highlight })
  // Claim 288 (DLoop): the gate is inserted between drafting and verification.
  const before: FlowDiagramData = {
    nodes: [labelled('context', 'Accepted context', 'input'), labelled('draft', 'Draft model', 'model'), labelled('verify', 'Verify one block', 'model'), labelled('accept', 'Accept or correct'), labelled('output', 'Verified tokens', 'output')],
    edges: [edge('context', 'draft'), edge('draft', 'verify'), edge('verify', 'accept'), edge('accept', 'output')],
  }
  const after: FlowDiagramData = {
    nodes: [
      labelled('context', 'Accepted context', 'input'),
      labelled('draft', 'Loop-ready draft model', 'model', true),
      labelled('gate', 'Sum logprobs ≥ g?', 'decision', true),
      labelled('verify', 'Verify accumulated blocks', 'model', true),
      labelled('accept', 'Accept or correct'),
      labelled('output', 'Verified tokens', 'output'),
    ],
    edges: [edge('context', 'draft'), edge('draft', 'gate'), edge('gate', 'draft', 'loop'), edge('gate', 'verify'), edge('verify', 'accept'), edge('accept', 'output')],
  }

  it('lines shared steps up in the same column and leaves a gap where the new step goes', () => {
    const result = compareFlows(before, after)
    const x = (layout: typeof result.before, id: string) => layout.nodes.find((n) => n.id === id)!.x
    for (const id of ['context', 'draft', 'verify', 'accept', 'output']) expect(x(result.before, id)).toBe(x(result.after, id))
    expect(result.before.width).toBe(result.after.width)
    expect(result.before.nodes.find((n) => n.id === 'verify')!.layer).toBe(3)
    // draft → verify jumps over the empty column, so it stays a straight forward edge
    expect(result.before.edges.find((e) => e.from === 'draft')!.route).toBe('forward')
  })

  it('marks new, changed and removed steps', () => {
    const withRemoval: FlowDiagramData = { ...before, nodes: [...before.nodes, labelled('sync', 'Host sync')], edges: [...before.edges, edge('accept', 'sync')] }
    const result = compareFlows(withRemoval, after)
    expect(result.afterStatus.get('gate')).toBe('new')
    expect(result.afterStatus.get('draft')).toBe('changed')
    expect(result.afterStatus.get('context')).toBe('same')
    expect(result.beforeStatus.get('sync')).toBe('removed')
    expect(result.added).toEqual(['Sum logprobs ≥ g?'])
    expect(result.removed).toEqual(['Host sync'])
  })

  it('keeps forward edges pointing right when a removed step sits before a shared one', () => {
    const b: FlowDiagramData = { nodes: [node('a'), node('x'), node('b')], edges: [edge('a', 'x'), edge('x', 'b')] }
    const a: FlowDiagramData = { nodes: [node('a'), node('b')], edges: [edge('a', 'b')] }
    const result = compareFlows(b, a)
    const layer = (id: string) => result.before.nodes.find((n) => n.id === id)!.layer
    expect(layer('a')).toBeLessThan(layer('x'))
    expect(layer('x')).toBeLessThan(layer('b'))
    expect(result.after.layers).toBe(result.before.layers)
  })
})

describe('wrapLabel', () => {
  it('wraps on words and truncates long labels', () => {
    expect(wrapLabel('Confidence gate', 14)).toEqual(['Confidence', 'gate'])
    expect(wrapLabel('WB: idx+codebook', 14)).toEqual(['WB:', 'idx+codebook'])
    expect(wrapLabel('Extremely long label that keeps going', 10, 2)).toEqual(['Extremely', 'long labe…'])
  })
})
