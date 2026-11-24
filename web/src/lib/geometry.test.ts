import { describe, expect, it } from 'vitest'
import { intersects, pathLabelCandidates, placeLabels, roundedPolyline, samplePath, sCurve, type Rect } from './geometry'
import { measureText, wrapText } from './textMeasure'

describe('wrapText', () => {
  it('keeps every line within the width, breaking long words after hyphens', () => {
    const wrapped = wrapText('Sensitivity-weighted candidate selection', 90)
    for (const line of wrapped.lines) expect(measureText(line)).toBeLessThanOrEqual(90)
    expect(wrapped.lines[0]).toBe('Sensitivity-')
    expect(wrapped.lines.join(' ').replace(/- /g, '-')).toBe('Sensitivity-weighted candidate selection')
    expect(wrapped.truncated).toBe(false)
  })

  it('ends the last allowed line with an ellipsis when the text is too long', () => {
    const wrapped = wrapText('Stated limitations: no joint budget optimization; limited deployment scope; safety not evaluated', 100, { maxLines: 2 })
    expect(wrapped.lines).toHaveLength(2)
    expect(wrapped.lines[1].endsWith('…')).toBe(true)
    expect(wrapped.truncated).toBe(true)
    for (const line of wrapped.lines) expect(measureText(line)).toBeLessThanOrEqual(100)
  })

  it('measures bold text wider than regular text', () => {
    expect(measureText('Changed', 12, 600)).toBeGreaterThan(measureText('Changed', 12, 400))
  })
})

describe('placeLabels', () => {
  const box = (x: number, y: number, width = 40, height = 18): Rect => ({ x, y, width, height })

  it('skips candidates that hit an obstacle or an earlier label', () => {
    const placed = placeLabels(
      [
        { key: 'a', candidates: [box(0, 0), box(0, 30)] },
        { key: 'b', candidates: [box(10, 30), box(10, 60)] },
      ],
      [box(0, 0, 20, 10)],
    )
    expect(placed.get('a')).toEqual(box(0, 30))
    expect(placed.get('b')).toEqual(box(10, 60))
  })

  it('returns null when nothing fits, and prefers the cheapest valid box', () => {
    const placed = placeLabels(
      [
        { key: 'cheap', candidates: [box(0, 0), box(100, 0)], cost: (r) => (r.x === 0 ? 3 : 0) },
        { key: 'other', candidates: [box(0, 0)] },
      ],
      [],
      { bounds: { maxX: 200 } },
    )
    expect(placed.get('cheap')).toEqual(box(100, 0))
    expect(placed.get('other')).toEqual(box(0, 0))
    expect(placeLabels([{ key: 'x', candidates: [box(0, 0)] }], [box(0, 0)]).get('x')).toBeNull()
  })

  it('offers boxes centred on a path first, then beside it', () => {
    const samples = samplePath([sCurve({ x: 0, y: 0 }, { x: 100, y: 0 }, 'x')])
    const [first, second] = pathLabelCandidates(samples, 40, 18)
    expect(Math.abs(first.x + first.width / 2 - 50)).toBeLessThan(3)
    expect(first.y).toBeCloseTo(-9, 0)
    expect(intersects(first, second)).toBe(true)
  })
})

describe('roundedPolyline', () => {
  it('passes through the start and end with rounded corners in between', () => {
    const segments = roundedPolyline([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 80, y: 50 }], 10)
    expect(segments[0].p0).toEqual({ x: 0, y: 0 })
    expect(segments[segments.length - 1].p3).toEqual({ x: 80, y: 50 })
    expect(segments).toHaveLength(3)
  })
})
