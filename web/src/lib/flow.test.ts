import { describe, expect, it } from 'vitest'
import type { FlowDiagramData } from '../api/types'
import { assignLayers, compareFlows, FULL_METRICS, labelGap, layoutFlow, sanitizeDiagram, VERTICAL_METRICS, wrapLabel, type FlowLayout } from './flow'
import { containsPoint, intersects, samplePath, type Rect } from './geometry'

const node = (id: string, kind = 'step', highlight = false) => ({ id, label: id.toUpperCase(), kind, highlight })
const edge = (from: string, to: string, style: 'normal' | 'loop' | 'skip' = 'normal') => ({ from, to, label: null, style })

type Compact = { title?: string; nodes: [string, string, string, boolean][]; edges: [string, string, string | null, string][] }
const fixture = ({ title, nodes, edges }: Compact): FlowDiagramData => ({
  title,
  nodes: nodes.map(([id, label, kind, highlight]) => ({ id, label, kind, highlight })),
  edges: edges.map(([from, to, label, style]) => ({ from, to, label, style })),
})

// Real diagrams behind the audit's collisions (docs/ux-review.md OV-08…14).
const CLAIM_168 = fixture({
  title: 'Importance-weighted key precision',
  nodes: [['keys', 'Incoming keys', 'input', false], ['scores', 'Calibrated block importance', 'data', true], ['allocation', 'Allocate block bits', 'step', true], ['encode', 'Encode by group', 'step', true], ['cache', 'Mixed-bit packed cache', 'memory', true], ['attention', 'Read grouped blocks', 'step', true], ['output', 'Attention result', 'output', false]],
  edges: [['keys', 'encode', 'runtime keys', 'normal'], ['scores', 'allocation', 'offline calibration', 'normal'], ['allocation', 'encode', 'bit schedule', 'normal'], ['encode', 'cache', null, 'normal'], ['cache', 'attention', null, 'normal'], ['attention', 'output', null, 'normal']],
})
const CLAIM_168_BEFORE = fixture({
  title: 'Uniform key precision',
  nodes: [['keys', 'Incoming keys', 'input', false], ['allocation', 'Uniform bit schedule', 'data', false], ['encode', 'Encode uniformly', 'step', false], ['cache', 'Uniform-bit cache', 'memory', false], ['attention', 'Read cached vectors', 'step', false], ['output', 'Attention result', 'output', false]],
  edges: [['keys', 'encode', 'runtime keys', 'normal'], ['allocation', 'encode', 'bit schedule', 'normal'], ['encode', 'cache', null, 'normal'], ['cache', 'attention', null, 'normal'], ['attention', 'output', null, 'normal']],
})
const CLAIM_195 = fixture({
  title: 'Selectable block sizes on one compute path',
  nodes: [['operands', 'Weights and activations', 'input', false], ['blocks', 'Select 16 or 32', 'decision', true], ['encode', 'Operand-specific encoding', 'step', true], ['storage', 'Packed blocks', 'memory', true], ['compute', 'Shared 32-lane compute', 'hardware', true], ['results', 'Computed values', 'output', false]],
  edges: [['operands', 'blocks', null, 'normal'], ['blocks', 'encode', null, 'normal'], ['encode', 'storage', null, 'normal'], ['storage', 'compute', 'Two small blocks', 'normal'], ['storage', 'compute', 'One large block', 'normal'], ['compute', 'results', null, 'normal']],
})
const CLAIM_195_BEFORE = fixture({
  title: 'Fixed block-size baseline',
  nodes: [['operands', 'Weights and activations', 'input', false], ['blocks', 'Fixed 16-element blocks', 'step', false], ['encode', 'Fixed floating-point encoding', 'step', false], ['storage', 'Packed blocks', 'memory', false], ['compute', 'Four-bit floating-point compute', 'hardware', false], ['results', 'Computed values', 'output', false]],
  edges: [['operands', 'blocks', null, 'normal'], ['blocks', 'encode', null, 'normal'], ['encode', 'storage', null, 'normal'], ['storage', 'compute', null, 'normal'], ['compute', 'results', null, 'normal']],
})
const MEMONCE_406 = fixture({
  title: 'Selective reconstruction with reuse',
  nodes: [['query', 'Current query', 'input', false], ['cache', 'Compressed chunks and landmarks', 'memory', true], ['select', 'Select top-k chunks', 'decision', true], ['buffer', 'Persistent chunk buffer', 'memory', true], ['reconstruct', 'Reconstruct missing chunks', 'step', true], ['exact', 'Exactly retained entries', 'memory', true], ['attention', 'Attention', 'step', true], ['output', 'Attention output', 'output', false]],
  edges: [['query', 'select', null, 'normal'], ['cache', 'select', 'Landmarks', 'normal'], ['select', 'buffer', 'Selected chunks', 'normal'], ['buffer', 'reconstruct', 'Cache misses', 'normal'], ['reconstruct', 'buffer', 'Store for reuse', 'loop'], ['buffer', 'attention', 'Reuse hits', 'skip'], ['reconstruct', 'attention', 'Newly reconstructed', 'normal'], ['exact', 'attention', 'Window and outliers', 'normal'], ['query', 'attention', null, 'normal'], ['attention', 'output', null, 'normal']],
})
const PAPER_2606 = fixture({
  title: 'Block-GTQ inference-time flow',
  nodes: [['n1', 'Input tokens', 'input', false], ['n2', 'Packed KV cache', 'memory', true], ['n3', 'RoPE Q compute', 'step', false], ['n4', 'Block rate map', 'memory', true], ['n5', 'Fused packed attn', 'model', true], ['n6', 'Next token', 'output', false]],
  edges: [['n1', 'n3', null, 'normal'], ['n2', 'n5', 'load codes', 'normal'], ['n4', 'n5', 'block rates', 'normal'], ['n3', 'n5', 'Q', 'normal'], ['n5', 'n6', null, 'normal']],
})

/** Every way a laid-out diagram could put text on text or an edge through a node. Empty = clean. */
function collisions(layout: FlowLayout): string[] {
  const out: string[] = []
  const inCanvas = (r: Rect) => r.x >= -0.5 && r.y >= -0.5 && r.x + r.width <= layout.width + 0.5 && r.y + r.height <= layout.height + 0.5
  const marks = [
    ...layout.edges.filter((e) => e.labelBox).map((e) => ({ id: `label "${e.label}"`, r: e.labelBox! })),
    ...layout.edges.filter((e) => e.calloutBox).map((e) => ({ id: `callout ${e.callout}`, r: e.calloutBox! })),
  ]
  for (const n of layout.nodes) {
    if (!inCanvas(n)) out.push(`node ${n.id} outside the canvas`)
    if (n.textBox && (n.textBox.x < n.x || n.textBox.x + n.textBox.width > n.x + n.width || n.textBox.y < n.y || n.textBox.y + n.textBox.height > n.y + n.height)) out.push(`label of ${n.id} escapes its node`)
    if (n.badge && n.textBox && intersects(n.badge, n.textBox)) out.push(`badge of ${n.id} covers its label`)
    if (n.badge && (n.badge.x < n.x || n.badge.x + n.badge.width > n.x + n.width || n.badge.y < n.y)) out.push(`badge of ${n.id} outside its node`)
  }
  for (const m of marks) {
    if (!inCanvas(m.r)) out.push(`${m.id} outside the canvas`)
    for (const n of layout.nodes) if (intersects(m.r, n)) out.push(`${m.id} over node ${n.id}`)
  }
  for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) if (intersects(marks[i].r, marks[j].r)) out.push(`${marks[i].id} over ${marks[j].id}`)
  for (const e of layout.edges) {
    const samples = samplePath(e.segments, 2)
    for (const n of layout.nodes) if (samples.some((s) => containsPoint(n, s.point, 1.5))) out.push(`edge ${e.from}→${e.to} passes through ${n.id}`)
    for (const n of layout.nodes) if (n.badge && samples.some((s) => containsPoint(n.badge!, s.point, 1))) out.push(`edge ${e.from}→${e.to} crosses the badge of ${n.id}`)
  }
  return out
}

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

  it('routes loops below every node they span and keeps everything inside the canvas', () => {
    const layout = layoutFlow(diagram)
    const loop = layout.edges.find((e) => e.style === 'loop')!
    expect(loop.route).toBe('loop')
    const lowest = Math.max(...layout.nodes.filter((n) => ['draft', 'lookup', 'verify'].includes(n.id)).map((n) => n.y + n.height))
    expect(Math.max(...samplePath(loop.segments).map((s) => s.point.y))).toBeGreaterThan(lowest)
    expect(collisions(layout)).toEqual([])
  })

  it('routes edges that skip a layer around the nodes in it', () => {
    const chain = { nodes: ['a', 'b', 'c'].map((id) => node(id)), edges: [edge('a', 'b'), edge('b', 'c'), edge('a', 'c', 'skip')] }
    const skip = layoutFlow(chain).edges.find((e) => e.style === 'skip')!
    expect(skip.route).toBe('arc')
    const branched = { nodes: ['a', 'b', 'd', 'c'].map((id) => node(id)), edges: [edge('a', 'b'), edge('b', 'c'), edge('a', 'd'), edge('d', 'c'), edge('a', 'c', 'skip')] }
    expect(collisions(layoutFlow(chain))).toEqual([])
    expect(collisions(layoutFlow(branched))).toEqual([])
  })

  it('lays out top to bottom with loops on the left, labels upright and inside the canvas', () => {
    const labelled = { ...diagram, edges: diagram.edges.map((e) => (e.style === 'loop' ? { ...e, label: 'Retry rejected tokens' } : e)) }
    const layout = layoutFlow(labelled, VERTICAL_METRICS, { orientation: 'vertical' })
    const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]))
    expect(layout.orientation).toBe('vertical')
    expect(byId.prompt.y).toBeLessThan(byId.draft.y)
    expect(byId.draft.y).toBe(byId.lookup.y)
    expect(byId.draft.x).toBeLessThan(byId.lookup.x)
    const loop = layout.edges.find((e) => e.route === 'loop')!
    expect(Math.min(...samplePath(loop.segments).map((s) => s.point.x))).toBeLessThan(Math.min(...layout.nodes.map((n) => n.x)))
    expect(loop.labelRotate).toBeUndefined()
    expect(loop.labelBox).not.toBeNull()
    expect(collisions(layout)).toEqual([])
  })

  it('wraps node labels by measured width (never past 4 lines) and gives every node the same height', () => {
    const layout = layoutFlow(MEMONCE_406)
    expect(new Set(layout.nodes.map((n) => n.height)).size).toBe(1)
    for (const n of layout.nodes) {
      expect(n.lines.length).toBeGreaterThan(0)
      expect(n.lines.length).toBeLessThanOrEqual(4)
      expect(n.truncated).toBe(false)
      expect(n.lines.join(' ').replace(/- /g, '-')).toBe(n.label)
    }
  })

  it('sizes each gap to the labels in it', () => {
    const labelled = { nodes: [node('a'), node('b'), node('c')], edges: [{ from: 'a', to: 'b', label: 'warm prefixes first', style: 'normal' }, edge('b', 'c')] }
    const plain = layoutFlow({ nodes: [node('a'), node('b'), node('c')], edges: [edge('a', 'b'), edge('b', 'c')] })
    const wide = layoutFlow(labelled)
    expect(wide.gaps[0]).toBeGreaterThan(plain.gaps[0])
    expect(wide.gaps[1]).toBe(plain.gaps[1])
    expect(wide.edges[0].labelLines.join(' ')).toBe('warm prefixes first')
    expect(labelGap(labelled)).toBe(wide.gap)
  })

  it('puts status badges inside the node’s top-right corner, clear of its label', () => {
    const layout = layoutFlow(CLAIM_168)
    const scores = layout.nodes.find((n) => n.id === 'scores')!
    expect(scores.badge?.text).toBe('New')
    expect(scores.badge!.x + scores.badge!.width).toBeLessThanOrEqual(scores.x + scores.width)
    expect(scores.badge!.y).toBeGreaterThanOrEqual(scores.y)
    expect(layout.nodes.find((n) => n.id === 'keys')!.badge).toBeNull()
  })

  it('keeps "runtime keys" off "Allocate block bits" in every orientation (OV-08, OV-09)', () => {
    for (const layout of [
      layoutFlow(CLAIM_168),
      layoutFlow(CLAIM_168, VERTICAL_METRICS, { orientation: 'vertical', availableWidth: 300 }),
      layoutFlow(CLAIM_168, VERTICAL_METRICS, { orientation: 'vertical', availableWidth: 520 }),
    ]) {
      expect(collisions(layout)).toEqual([])
      const label = layout.edges.find((e) => e.label === 'runtime keys')!.labelBox!
      const allocation = layout.nodes.find((n) => n.id === 'allocation')!
      expect(intersects(label, allocation)).toBe(false)
      expect(intersects(label, allocation.badge!)).toBe(false)
    }
  })

  it('separates parallel edges between the same two nodes and both of their labels (OV-11)', () => {
    for (const layout of [layoutFlow(CLAIM_195), layoutFlow(CLAIM_195, VERTICAL_METRICS, { orientation: 'vertical', availableWidth: 300 })]) {
      const [small, large] = ['Two small blocks', 'One large block'].map((label) => layout.edges.find((e) => e.label === label)!)
      expect(small.path).not.toBe(large.path)
      expect(small.labelBox && large.labelBox).toBeTruthy()
      expect(intersects(small.labelBox!, large.labelBox!)).toBe(false)
      expect(collisions(layout)).toEqual([])
    }
  })

  it('lays out the MemOnce and RoPE diagrams with no label on a node or another label (OV-10, OV-12, OV-13)', () => {
    for (const diagramUnderTest of [MEMONCE_406, PAPER_2606])
      for (const layout of [
        layoutFlow(diagramUnderTest),
        layoutFlow(diagramUnderTest, VERTICAL_METRICS, { orientation: 'vertical', availableWidth: 300 }),
        layoutFlow(diagramUnderTest, VERTICAL_METRICS, { orientation: 'vertical', availableWidth: 640 }),
      ]) {
        expect(collisions(layout)).toEqual([])
        expect(layout.callouts).toEqual([])
      }
  })

  it('fits a single-column flow into a phone-width container', () => {
    const layout = layoutFlow(CLAIM_195, VERTICAL_METRICS, { orientation: 'vertical', availableWidth: 300 })
    expect(layout.width).toBeLessThanOrEqual(300)
  })

  it('falls back to numbered callouts when a fixed gap leaves no room, still without overlaps', () => {
    const crowded = {
      nodes: [node('a'), node('b'), node('c'), node('d')],
      edges: [
        { from: 'a', to: 'b', label: 'a fairly long edge label', style: 'normal' },
        { from: 'a', to: 'c', label: 'another long edge label', style: 'normal' },
        { from: 'a', to: 'd', label: 'and a third long label', style: 'normal' },
      ],
    }
    const layout = layoutFlow(crowded, FULL_METRICS, { gapX: 24 })
    expect(layout.callouts.length).toBeGreaterThan(0)
    expect(layout.callouts.map((c) => c.number)).toEqual(layout.callouts.map((_, i) => i + 1))
    expect(layout.edges.filter((e) => e.callout).map((e) => e.label)).toEqual(layout.callouts.map((c) => c.label))
    expect(collisions(layout)).toEqual([])
    // Without the fixed gap, the gap grows until every label fits next to its edge.
    expect(layoutFlow(crowded).callouts).toEqual([])
  })

  it('drops broken input instead of failing', () => {
    expect(layoutFlow(null).nodes).toEqual([])
    const broken = sanitizeDiagram({ nodes: [node('a'), node('a'), node('b')], edges: [edge('a', 'zzz'), edge('a', 'a'), edge('a', 'b')] })
    expect(broken.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(broken.edges).toHaveLength(1)
  })

  it('renders LaTeX in labels as plain text, never raw markup', () => {
    const layout = layoutFlow({ nodes: [{ id: 'a', label: 'Apply 4^{-b} penalty', kind: 'step', highlight: false }, node('b')], edges: [{ from: 'a', to: 'b', label: 'x_{t} codes', style: 'normal' }] })
    expect(layout.nodes[0].lines.join(' ')).toBe('Apply 4⁻ᵇ penalty')
    expect(layout.edges[0].labelLines.join(' ')).toBe('xₜ codes')
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
    // draft → verify crosses the empty column in a straight line
    const draft = result.before.nodes.find((n) => n.id === 'draft')!
    const jump = result.before.edges.find((e) => e.from === 'draft')!
    for (const sample of samplePath(jump.segments)) expect(sample.point.y).toBeCloseTo(draft.y + draft.height / 2)
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
    expect(result.before.nodes.find((n) => n.id === 'sync')!.badge?.text).toBe('Removed')
    expect(result.after.nodes.find((n) => n.id === 'draft')!.badge?.text).toBe('Changed')
    expect(result.before.nodes.find((n) => n.id === 'draft')!.badge).toBeNull()
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

  it('aligns the two lanes in both orientations with no collisions (claims 168 and 195)', () => {
    for (const [today, next] of [
      [CLAIM_168_BEFORE, CLAIM_168],
      [CLAIM_195_BEFORE, CLAIM_195],
    ]) {
      const stacked = compareFlows(today, next)
      expect(stacked.before.width).toBe(stacked.after.width)
      expect(stacked.before.nodeHeight).toBe(stacked.after.nodeHeight)
      const sideBySide = compareFlows(today, next, VERTICAL_METRICS, 'vertical', { availableWidth: 300 })
      expect(sideBySide.before.height).toBe(sideBySide.after.height)
      expect(sideBySide.before.nodeWidth).toBe(sideBySide.after.nodeWidth)
      for (const layout of [stacked.before, stacked.after, sideBySide.before, sideBySide.after]) expect(collisions(layout)).toEqual([])
    }
  })
})

describe('wrapLabel', () => {
  it('wraps on words and truncates long labels', () => {
    expect(wrapLabel('Confidence gate', 14)).toEqual(['Confidence', 'gate'])
    expect(wrapLabel('WB: idx+codebook', 14)).toEqual(['WB:', 'idx+codebook'])
    expect(wrapLabel('Extremely long label that keeps going', 10, 2)).toEqual(['Extremely', 'long labe…'])
  })
})
