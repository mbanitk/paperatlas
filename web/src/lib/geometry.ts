/**
 * Small 2-D geometry kit for the SVG diagrams: rectangles, cubic Bézier paths, path sampling and a greedy,
 * collision-aware label placer. Pure functions, unit-tested in geometry.test.ts.
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** One cubic Bézier segment. Straight lines use control points on the line. */
export interface Cubic {
  p0: Point
  c1: Point
  c2: Point
  p3: Point
}

export const rectRight = (r: Rect) => r.x + r.width
export const rectBottom = (r: Rect) => r.y + r.height

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by }
}

/** True when the rectangles share more than `tolerance` px in both directions. */
export function intersects(a: Rect, b: Rect, tolerance = 0): boolean {
  const x = Math.min(rectRight(a), rectRight(b)) - Math.max(a.x, b.x)
  const y = Math.min(rectBottom(a), rectBottom(b)) - Math.max(a.y, b.y)
  return x > tolerance && y > tolerance
}

export function containsPoint(r: Rect, p: Point, inset = 0): boolean {
  return p.x > r.x + inset && p.x < rectRight(r) - inset && p.y > r.y + inset && p.y < rectBottom(r) - inset
}

export function unionRect(rects: Rect[]): Rect | null {
  if (!rects.length) return null
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, rectRight(r))
    y1 = Math.max(y1, rectBottom(r))
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// ---- Bézier paths --------------------------------------------------------------------------------

export function line(p: Point, q: Point): Cubic {
  return { p0: p, c1: { x: p.x + (q.x - p.x) / 3, y: p.y + (q.y - p.y) / 3 }, c2: { x: p.x + ((q.x - p.x) * 2) / 3, y: p.y + ((q.y - p.y) * 2) / 3 }, p3: q }
}

/**
 * Smooth S-curve from p to q whose ends run along `axis` (x: leaves p and enters q horizontally). `bow`
 * pushes the middle sideways (used to separate parallel edges between the same two nodes).
 */
export function sCurve(p: Point, q: Point, axis: 'x' | 'y', bow = 0): Cubic {
  if (axis === 'x') {
    const d = Math.max(10, Math.abs(q.x - p.x) / 2) * Math.sign(q.x - p.x || 1)
    return { p0: p, c1: { x: p.x + d, y: p.y + bow }, c2: { x: q.x - d, y: q.y + bow }, p3: q }
  }
  const d = Math.max(10, Math.abs(q.y - p.y) / 2) * Math.sign(q.y - p.y || 1)
  return { p0: p, c1: { x: p.x + bow, y: p.y + d }, c2: { x: q.x + bow, y: q.y - d }, p3: q }
}

/** Polyline through `points` with rounded corners (radius ≤ half of each adjoining segment). */
export function roundedPolyline(points: Point[], radius = 10): Cubic[] {
  const pts = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 0.01)
  if (pts.length < 2) return []
  const out: Cubic[] = []
  let cursor = pts[0]
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]
    const corner = pts[i]
    const next = pts[i + 1]
    const lenIn = Math.hypot(corner.x - prev.x, corner.y - prev.y)
    const lenOut = Math.hypot(next.x - corner.x, next.y - corner.y)
    const r = Math.min(radius, lenIn / 2, lenOut / 2)
    const a = { x: corner.x - ((corner.x - prev.x) / lenIn) * r, y: corner.y - ((corner.y - prev.y) / lenIn) * r }
    const b = { x: corner.x + ((next.x - corner.x) / lenOut) * r, y: corner.y + ((next.y - corner.y) / lenOut) * r }
    if (Math.hypot(a.x - cursor.x, a.y - cursor.y) > 0.01) out.push(line(cursor, a))
    // Quadratic corner through `corner`, written as a cubic.
    out.push({ p0: a, c1: { x: a.x + ((corner.x - a.x) * 2) / 3, y: a.y + ((corner.y - a.y) * 2) / 3 }, c2: { x: b.x + ((corner.x - b.x) * 2) / 3, y: b.y + ((corner.y - b.y) * 2) / 3 }, p3: b })
    cursor = b
  }
  out.push(line(cursor, pts[pts.length - 1]))
  return out
}

export function cubicAt(c: Cubic, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const d = 3 * u * t * t
  const e = t * t * t
  return { x: a * c.p0.x + b * c.c1.x + d * c.c2.x + e * c.p3.x, y: a * c.p0.y + b * c.c1.y + d * c.c2.y + e * c.p3.y }
}

const fmt = (n: number) => String(Math.round(n * 10) / 10)

/** SVG `d` for connected segments. */
export function pathD(segments: Cubic[]): string {
  if (!segments.length) return ''
  const parts = [`M ${fmt(segments[0].p0.x)} ${fmt(segments[0].p0.y)}`]
  for (const s of segments) parts.push(`C ${fmt(s.c1.x)} ${fmt(s.c1.y)}, ${fmt(s.c2.x)} ${fmt(s.c2.y)}, ${fmt(s.p3.x)} ${fmt(s.p3.y)}`)
  return parts.join(' ')
}

export function mapCubic(c: Cubic, f: (p: Point) => Point): Cubic {
  return { p0: f(c.p0), c1: f(c.c1), c2: f(c.c2), p3: f(c.p3) }
}

export interface PathSample {
  point: Point
  /** Unit tangent. */
  tangent: Point
  /** Distance from the start, as a fraction of the total length (0–1). */
  at: number
}

/** Points every ~`step` px along the path, with their tangent and position as a fraction of the length. */
export function samplePath(segments: Cubic[], step = 4): PathSample[] {
  const raw: { point: Point; length: number }[] = []
  let length = 0
  let last: Point | null = null
  for (const segment of segments) {
    const approx = Math.hypot(segment.c1.x - segment.p0.x, segment.c1.y - segment.p0.y) + Math.hypot(segment.c2.x - segment.c1.x, segment.c2.y - segment.c1.y) + Math.hypot(segment.p3.x - segment.c2.x, segment.p3.y - segment.c2.y)
    const n = Math.max(2, Math.ceil(approx / step))
    for (let i = last ? 1 : 0; i <= n; i++) {
      const point = cubicAt(segment, i / n)
      if (last) length += Math.hypot(point.x - last.x, point.y - last.y)
      raw.push({ point, length })
      last = point
    }
  }
  const total = length || 1
  return raw.map((sample, i) => {
    const a = raw[Math.max(0, i - 1)].point
    const b = raw[Math.min(raw.length - 1, i + 1)].point
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { point: sample.point, tangent: { x: (b.x - a.x) / d, y: (b.y - a.y) / d }, at: sample.length / total }
  })
}

/** The sample closest to `fraction` of the way along. */
export function sampleAt(samples: PathSample[], fraction: number): PathSample {
  let best = samples[0]
  for (const sample of samples) if (Math.abs(sample.at - fraction) < Math.abs(best.at - fraction)) best = sample
  return best
}

export function pathBounds(segments: Cubic[]): Rect | null {
  const points = samplePath(segments, 6).map((s) => s.point)
  return unionRect(points.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })))
}

// ---- label placement ---------------------------------------------------------------------------------

/**
 * Candidate boxes for a label of `width` × `height` attached to a path: centred on the path (a pill over the
 * line) near its middle first, then beside it (above/below a horizontal stretch, left/right of a vertical one),
 * moving outwards along the path.
 */
export function pathLabelCandidates(samples: PathSample[], width: number, height: number, options: { offset?: number; fractions?: number[] } = {}): Rect[] {
  if (!samples.length) return []
  const offset = options.offset ?? 3
  const fractions = options.fractions ?? [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.12, 0.88]
  const scored: { rect: Rect; score: number }[] = []
  for (const fraction of fractions) {
    const { point: p, tangent } = sampleAt(samples, fraction)
    const distance = Math.abs(fraction - 0.5)
    scored.push({ rect: { x: p.x - width / 2, y: p.y - height / 2, width, height }, score: distance })
    const horizontal = Math.abs(tangent.x) >= Math.abs(tangent.y)
    const beside: Rect[] = horizontal
      ? [
          { x: p.x - width / 2, y: p.y - height - offset, width, height },
          { x: p.x - width / 2, y: p.y + offset, width, height },
        ]
      : [
          { x: p.x + offset, y: p.y - height / 2, width, height },
          { x: p.x - width - offset, y: p.y - height / 2, width, height },
        ]
    for (const rect of beside) scored.push({ rect, score: distance + 0.1 })
  }
  return scored.sort((a, b) => a.score - b.score).map((item) => item.rect)
}

export interface LabelRequest<K> {
  key: K
  /** Candidate boxes in order of preference. */
  candidates: Rect[]
  /** Soft penalty for a box (e.g. how much of other edges it hides); the lowest-cost valid box wins. */
  cost?: (rect: Rect) => number
}

export interface PlacementBounds {
  minX?: number
  maxX?: number
  minY?: number
  maxY?: number
}

const withinBounds = (r: Rect, b: PlacementBounds) =>
  (b.minX === undefined || r.x >= b.minX - 0.01) &&
  (b.maxX === undefined || rectRight(r) <= b.maxX + 0.01) &&
  (b.minY === undefined || r.y >= b.minY - 0.01) &&
  (b.maxY === undefined || rectBottom(r) <= b.maxY + 0.01)

/**
 * Greedy placement: each label takes its best candidate that stays inside `bounds`, clears every obstacle and
 * every label placed before it by `gap` px. Labels that found no room are retried first in a second pass.
 * Returns null for labels that still don't fit (callers fall back to a numbered callout).
 */
export function placeLabels<K>(requests: LabelRequest<K>[], obstacles: Rect[], options: { gap?: number; bounds?: PlacementBounds } = {}): Map<K, Rect | null> {
  const gap = options.gap ?? 3
  const bounds = options.bounds ?? {}
  const attempt = (order: LabelRequest<K>[]) => {
    const placed: Rect[] = []
    const result = new Map<K, Rect | null>()
    for (const request of order) {
      let best: Rect | null = null
      let bestCost = Number.POSITIVE_INFINITY
      for (const rect of request.candidates) {
        if (!withinBounds(rect, bounds)) continue
        if (obstacles.some((o) => intersects(rect, o))) continue
        if (placed.some((p) => intersects(inflate(rect, gap), p))) continue
        const cost = request.cost?.(rect) ?? 0
        if (cost < bestCost) {
          best = rect
          bestCost = cost
          if (cost === 0) break
        }
      }
      result.set(request.key, best)
      if (best) placed.push(best)
    }
    return result
  }
  const first = attempt(requests)
  const failed = requests.filter((request) => !first.get(request.key))
  if (!failed.length || failed.length === requests.length) return first
  const second = attempt([...failed, ...requests.filter((request) => first.get(request.key))])
  const misses = (result: Map<K, Rect | null>) => [...result.values()].filter((rect) => !rect).length
  return misses(second) < misses(first) ? second : first
}
