/**
 * Text measurement for SVG layouts (diagrams and charts).
 *
 * In the browser, widths come from `canvas.measureText` with the page's own font stack, so wrapping and
 * label boxes match what the SVG renders. Without a canvas (unit tests, SSR) an Arial/Helvetica advance
 * table is used: close enough to validate geometry, and slightly wider than the real system font.
 */

/** Diagram type: every label is 12 px at natural size, so it stays ≥ 11 px at the minimum 0.92 scale. */
export const DIAGRAM_FONT_SIZE = 12
export const DIAGRAM_LINE_HEIGHT = 15
/** Smallest scale a diagram may render at: 12 px × 0.92 ≈ 11 px (docs/ux-review.md §3.2). */
export const MIN_DIAGRAM_SCALE = 0.92

const FALLBACK_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif"

// Arial advance widths (1/1000 em) for ASCII 32–126.
const ADVANCE = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556,
  556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]

function fallbackWidth(text: string, size: number, weight: number): number {
  let units = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    units += code >= 32 && code <= 126 ? ADVANCE[code - 32] : char === '…' ? 1000 : char === '–' || char === '−' ? 556 : 600
  }
  // System UI fonts run ~6% wider than Arial; bold ~6% wider again.
  return (units / 1000) * size * 1.06 * (weight >= 600 ? 1.06 : 1)
}

type Context2D = { font: string; measureText: (text: string) => { width: number } }
let context: Context2D | null | undefined
let family: string | undefined

function canvasContext(): Context2D | null {
  if (context !== undefined) return context
  context = null
  try {
    if (typeof document !== 'undefined') {
      context = (document.createElement('canvas').getContext('2d') as Context2D | null) ?? null
      family = (document.body && getComputedStyle(document.body).fontFamily) || FALLBACK_FAMILY
    }
  } catch {
    context = null
  }
  return context
}

const cache = new Map<string, number>()

/** Rendered width in px of one line of text (with a small safety margin). */
export function measureText(text: string, size = DIAGRAM_FONT_SIZE, weight = 400): number {
  if (!text) return 0
  const key = `${size}|${weight}|${text}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const ctx = canvasContext()
  let width: number
  if (ctx) {
    ctx.font = `${weight} ${size}px ${family ?? FALLBACK_FAMILY}`
    width = ctx.measureText(text).width
  } else {
    width = fallbackWidth(text, size, weight)
  }
  width = Math.ceil(width * 1.03 + 1)
  if (cache.size > 4000) cache.clear()
  cache.set(key, width)
  return width
}

export interface WrapOptions {
  size?: number
  weight?: number
  /** Most lines to produce; the last one ends in "…" when the text doesn't fit (default: unlimited). */
  maxLines?: number
}

export interface WrappedText {
  lines: string[]
  /** Widest line, in px. */
  width: number
  /** True when text was cut to fit `maxLines`. */
  truncated: boolean
}

/** Pieces a word may break into when it's wider than a line: after hyphens and slashes, then by characters. */
function splitLongWord(word: string, maxWidth: number, size: number, weight: number): string[] {
  const parts = word.split(/(?<=[-/])/)
  const out: string[] = []
  for (const part of parts) {
    if (measureText(part, size, weight) <= maxWidth) {
      const last = out[out.length - 1]
      if (last !== undefined && /[-/]$/.test(last) && measureText(last + part, size, weight) <= maxWidth) out[out.length - 1] = last + part
      else out.push(part)
      continue
    }
    let chunk = ''
    for (const char of part) {
      if (chunk && measureText(`${chunk}${char}-`, size, weight) > maxWidth) {
        out.push(`${chunk}-`)
        chunk = char
      } else chunk += char
    }
    if (chunk) out.push(chunk)
  }
  return out
}

/**
 * Word-wrap `text` into lines no wider than `maxWidth` px (measured, not estimated). Long words break after
 * hyphens or slashes, and only as a last resort mid-word.
 */
export function wrapText(text: string, maxWidth: number, options: WrapOptions = {}): WrappedText {
  const size = options.size ?? DIAGRAM_FONT_SIZE
  const weight = options.weight ?? 400
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => (measureText(word, size, weight) > maxWidth ? splitLongWord(word, maxWidth, size, weight) : [word]))
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const joiner = current && !/[-/]$/.test(current) ? ' ' : ''
    const next = current ? `${current}${joiner}${word}` : word
    if (!current || measureText(next, size, weight) <= maxWidth) current = next
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)

  let truncated = false
  const max = options.maxLines ?? Number.POSITIVE_INFINITY
  if (lines.length > max) {
    truncated = true
    lines.length = max
    let last = lines[max - 1]
    while (last.length > 1 && measureText(`${last}…`, size, weight) > maxWidth) last = last.slice(0, -1).trimEnd()
    lines[max - 1] = `${last.replace(/[\s,;:.-]+$/, '')}…`
  }
  const width = Math.max(0, ...lines.map((line) => measureText(line, size, weight)))
  return { lines, width, truncated }
}

/** Testing hook: forget the cached canvas so the fallback table is used. */
export function resetTextMeasure(): void {
  context = undefined
  family = undefined
  cache.clear()
}
