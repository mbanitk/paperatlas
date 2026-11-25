/**
 * Layout of the verdict number line (`ImprovementChart`): a % axis with the measured median and 95% CI, the
 * cost model's expected range (band) and the success bar / target / paper's claim (markers).
 *
 * The chart is drawn at the container's real pixel width, so its 12 px text is 12 px on screen. Labels go
 * into rows above the axis (markers, band) and below it (measured, 0%) with a collision-aware allocator:
 * no two labels overlap, and a marker's line (from its label down to the axis) never crosses another label.
 * When full labels don't fit (narrow screens), the chart keeps short value labels where they fit and the
 * component lists everything in a legend under the axis.
 */
import { formatRange, formatSigned } from './format'
import { gainSemantics, type SemanticTone } from './semantics'
import { measureText } from './textMeasure'

export const CHART_FONT = 12
const ROW = 17
const LABEL_GAP = 8
const LINE_CLEAR = 5
const PAD_X = 12
const MAX_ROWS_ABOVE = 3
const MAX_ROWS_BELOW = 2
/** Below this width the chart always uses short labels and a legend. */
export const LEGEND_BELOW = 480
/** Room for the paper icon drawn before "Paper reports …". */
const ICON_ROOM = 15

export type MarkKey = 'threshold' | 'target' | 'claimed'
export type LabelKey = MarkKey | 'band' | 'measured' | 'zero'

export interface NumberLineInput {
  width: number
  median: number
  low?: number | null
  high?: number | null
  claimed?: number | null
  threshold?: number | null
  target?: number | null
  predicted?: { low: number; high: number } | null
}

export interface ChartMark {
  key: MarkKey
  value: number
  x: number
  /** Long and short label text. */
  label: string
  short: string
  tone: SemanticTone
  dash?: string
  /** Line from below its label (or the chart top when it has none) down to the axis. */
  lineTop: number
  lineBottom: number
}

export interface ChartLabel {
  key: LabelKey
  text: string
  /** Left edge of the box, baseline y. */
  x: number
  y: number
  width: number
  /** Index into the rows above (≥ 0) or below the axis. */
  row: number
  side: 'above' | 'below'
  tone: SemanticTone
  weight: number
  icon: boolean
}

export interface NumberLineLayout {
  width: number
  height: number
  axisY: number
  domain: [number, number]
  x: (value: number) => number
  marks: ChartMark[]
  band: { x0: number; x1: number; y0: number; y1: number; label: string; short: string } | null
  ci: { x0: number; x1: number } | null
  median: { x: number; tone: SemanticTone; label: string }
  zeroX: number
  labels: ChartLabel[]
  /** Labels were shortened or dropped: show the legend under the chart. */
  legend: boolean
}

interface Item {
  key: LabelKey
  text: string
  anchor: number
  width: number
  side: 'above' | 'below'
  /** x of the line hanging from this label to the axis (markers only). */
  lineX?: number
  tone: SemanticTone
  weight: number
  icon: boolean
  optional: boolean
}

interface Placed extends Item {
  left: number
  row: number
}

const overlaps = (a0: number, a1: number, b0: number, b1: number, gap: number) => a0 < b1 + gap && b0 < a1 + gap

/**
 * Assign each item a row on its side of the axis. Rows count outwards from the axis. A box may not overlap
 * another in its row, may not sit on a marker line that hangs from a row further out, and a marker placed
 * further out may not hang its line through a box closer in. Each label is tried centred on its value, then
 * as a flag ending or starting at its line. Returns null when a required item doesn't fit.
 */
export function allocateRows(items: Item[], width: number, maxRows: number): Placed[] | null {
  const placed: Placed[] = []
  for (const item of items) {
    const lefts = [item.anchor - item.width / 2, item.anchor - item.width + 4, item.anchor - 4].map((left) => Math.max(0, Math.min(width - item.width, left)))
    let done = false
    for (let row = 0; row < maxRows && !done; row++) {
      for (const left of lefts) {
        const right = left + item.width
        const clash = placed.some((other) => {
          if (other.side !== item.side) return false
          if (other.row === row && overlaps(left, right, other.left, other.left + other.width, LABEL_GAP)) return true
          // A line from a label further out passes through this row.
          if (other.row > row && other.lineX !== undefined && other.lineX > left - LINE_CLEAR && other.lineX < right + LINE_CLEAR) return true
          // This item's own line would pass through a label closer to the axis.
          if (item.lineX !== undefined && other.row < row && item.lineX > other.left - LINE_CLEAR && item.lineX < other.left + other.width + LINE_CLEAR) return true
          return false
        })
        if (!clash) {
          placed.push({ ...item, left, row })
          done = true
          break
        }
      }
    }
    if (!done && !item.optional) return null
  }
  return placed
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]))
}

/** Best allocation over every placement order (≤ 5 labels per side): fewest dropped labels, then fewest rows. */
function bestRows(items: Item[], width: number, maxRows: number): Placed[] | null {
  let best: Placed[] | null = null
  const score = (placed: Placed[]) => (items.length - placed.length) * 100 + Math.max(0, ...placed.map((p) => p.row + 1))
  for (const order of permutations(items)) {
    const placed = allocateRows(order, width, maxRows)
    if (placed && (!best || score(placed) < score(best))) best = placed
  }
  return best
}

const tick = (value: number) => formatSigned(value, { digits: Math.abs(value) < 10 && !Number.isInteger(value) ? 1 : 0 })

export function layoutNumberLine(input: NumberLineInput): NumberLineLayout {
  const width = Math.max(160, Math.round(input.width))
  const band =
    input.predicted && Number.isFinite(input.predicted.low) && Number.isFinite(input.predicted.high)
      ? { low: Math.min(input.predicted.low, input.predicted.high), high: Math.max(input.predicted.low, input.predicted.high) }
      : null
  const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
  const values = [input.median, input.low, input.high, input.claimed, input.threshold, input.target, band?.low, band?.high, 0].filter(finite)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(max - min, 5)
  const lo = min - span * 0.06
  const hi = max + span * 0.06
  const x = (value: number) => PAD_X + ((value - lo) / (hi - lo)) * (width - 2 * PAD_X)

  const significant = finite(input.low) && finite(input.high) ? input.low > 0 || input.high < 0 : undefined
  const medianTone = gainSemantics(input.median, { significant, threshold: 0 }).tone

  const marks: Omit<ChartMark, 'lineTop' | 'lineBottom'>[] = []
  if (finite(input.threshold)) marks.push({ key: 'threshold', value: input.threshold, x: x(input.threshold), label: `Success bar ${tick(input.threshold)}`, short: tick(input.threshold), tone: 'neutral', dash: '4 3' })
  if (finite(input.target) && Math.abs(input.target - (input.threshold ?? Number.NaN)) > 0.05)
    marks.push({ key: 'target', value: input.target, x: x(input.target), label: `Target ${tick(input.target)}`, short: tick(input.target), tone: 'neutral', dash: '1.5 3' })
  if (finite(input.claimed)) marks.push({ key: 'claimed', value: input.claimed, x: x(input.claimed), label: `Paper reports ${tick(input.claimed)}`, short: tick(input.claimed), tone: 'reference' })

  const bandText = band ? formatRange(band.low, band.high) : ''
  const measuredText = `Measured ${formatSigned(input.median, { digits: 1 })}`
  const build = (short: boolean): Item[] => {
    const items: Item[] = []
    // Paper's claim first (the reference people compare with), then the bars, then the expected band.
    const order: MarkKey[] = ['claimed', 'threshold', 'target']
    for (const key of order) {
      const mark = marks.find((m) => m.key === key)
      if (!mark) continue
      const text = short ? mark.short : mark.label
      const icon = key === 'claimed'
      items.push({ key, text, anchor: mark.x, width: measureText(text, CHART_FONT, 600) + (icon ? ICON_ROOM : 0), side: 'above', lineX: mark.x, tone: mark.tone, weight: 600, icon, optional: short })
    }
    if (band) {
      const text = short ? bandText : `Expected here: ${bandText}`
      items.push({ key: 'band', text, anchor: (x(band.low) + x(band.high)) / 2, width: measureText(text, CHART_FONT, 600), side: 'above', tone: 'info', weight: 600, icon: false, optional: short })
    }
    items.unshift({ key: 'measured', text: measuredText, anchor: x(input.median), width: measureText(measuredText, CHART_FONT, 700), side: 'below', tone: medianTone, weight: 700, icon: false, optional: false })
    if (Math.abs(x(input.median) - x(0)) > 4) items.push({ key: 'zero', text: '0%', anchor: x(0), width: measureText('0%', CHART_FONT, 400), side: 'below', tone: 'neutral', weight: 400, icon: false, optional: true })
    return items
  }

  const rowsFor = (items: Item[]) => {
    const above = bestRows(items.filter((item) => item.side === 'above'), width, MAX_ROWS_ABOVE)
    const below = bestRows(items.filter((item) => item.side === 'below'), width, MAX_ROWS_BELOW)
    return above && below ? [...above, ...below] : null
  }
  let legend = width < LEGEND_BELOW
  let placed = legend ? null : rowsFor(build(false))
  if (!placed) {
    legend = true
    placed = rowsFor(build(true)) ?? []
  }

  const rowsAbove = Math.max(0, ...placed.filter((p) => p.side === 'above').map((p) => p.row + 1))
  const rowsBelow = Math.max(1, ...placed.filter((p) => p.side === 'below').map((p) => p.row + 1))
  const top = 4
  const bandHalf = band ? 13 : 10
  const axisY = top + rowsAbove * ROW + (rowsAbove ? 6 : 4) + bandHalf
  const belowTop = axisY + bandHalf + 4
  const height = belowTop + rowsBelow * ROW + 4

  // Baselines: rows above count upwards from just over the band; rows below downwards from under it.
  const baselineAbove = (row: number) => axisY - bandHalf - 6 - row * ROW - 4
  const baselineBelow = (row: number) => belowTop + row * ROW + 12
  const labels: ChartLabel[] = placed.map((p) => ({
    key: p.key,
    text: p.text,
    x: p.left,
    y: p.side === 'above' ? baselineAbove(p.row) : baselineBelow(p.row),
    width: p.width,
    row: p.row,
    side: p.side,
    tone: p.tone,
    weight: p.weight,
    icon: p.icon,
  }))

  const finalMarks: ChartMark[] = marks.map((mark) => {
    const label = labels.find((l) => l.key === mark.key)
    // A mark whose label didn't fit is only a tick through the band (its value is in the legend), so its line
    // can't run through another label.
    return { ...mark, lineTop: label ? label.y + 4 : axisY - bandHalf - 3, lineBottom: axisY + 9 }
  })

  return {
    width,
    height,
    axisY,
    domain: [lo, hi],
    x,
    marks: finalMarks,
    band: band ? { x0: x(band.low), x1: Math.max(x(band.low) + 3, x(band.high)), y0: axisY - 13, y1: axisY + 13, label: `Expected here: ${bandText}`, short: bandText } : null,
    ci: finite(input.low) && finite(input.high) ? { x0: x(Math.min(input.low, input.high)), x1: Math.max(x(Math.min(input.low, input.high)) + 2, x(Math.max(input.low, input.high))) } : null,
    median: { x: x(input.median), tone: medianTone, label: measuredText },
    zeroX: x(0),
    labels,
    legend,
  }
}
