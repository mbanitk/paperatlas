import { describe, expect, it } from 'vitest'
import { CHART_FONT, layoutNumberLine, LEGEND_BELOW, type NumberLineInput, type NumberLineLayout } from './numberLine'

/** Label boxes (12 px text: ~10 px above the baseline, 3 below) must not overlap, and no marker line may cross a label. */
function problems(layout: NumberLineLayout): string[] {
  const out: string[] = []
  const boxes = layout.labels.map((label) => ({ key: label.key, x0: label.x, x1: label.x + label.width, y0: label.y - CHART_FONT + 1, y1: label.y + 3 }))
  for (const box of boxes) if (box.x0 < 0 || box.x1 > layout.width + 0.5 || box.y0 < 0 || box.y1 > layout.height) out.push(`${box.key} outside the chart`)
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) out.push(`${a.key} overlaps ${b.key}`)
    }
  for (const mark of layout.marks)
    for (const box of boxes) {
      if (box.key === mark.key) continue
      if (mark.x > box.x0 - 1 && mark.x < box.x1 + 1 && mark.lineTop < box.y1 && mark.lineBottom > box.y0) out.push(`${mark.key} line crosses ${box.key}`)
    }
  if (layout.band) for (const box of boxes) if (box.y1 > layout.band.y0 && box.y0 < layout.band.y1) out.push(`${box.key} sits on the band`)
  return out
}

// Experiment 6: claim check +2.8% with the expected band 0 to +10% and the +5% success bar (OV-05).
const EXP_6: Omit<NumberLineInput, 'width'> = { median: 2.8, low: 2.3, high: 3.3, threshold: 5, predicted: { low: 0, high: 10 } }
// Experiment 1: −66.8% with the success bar, target and paper's claim close together on the right (OV-06).
const EXP_1: Omit<NumberLineInput, 'width'> = { median: -66.8, low: -67, high: -66, threshold: 5, target: 29, claimed: 41 }

describe('layoutNumberLine', () => {
  it('keeps every label apart and every marker line clear of text at desktop and tablet widths', () => {
    for (const input of [EXP_6, EXP_1])
      for (const width of [1100, 760, 520]) {
        const layout = layoutNumberLine({ ...input, width })
        expect(problems(layout), `width ${width}`).toEqual([])
      }
  })

  it('uses full labels in the approved words when they fit', () => {
    const layout = layoutNumberLine({ ...EXP_6, width: 700 })
    expect(layout.legend).toBe(false)
    expect(layout.labels.map((label) => label.text).sort()).toEqual(['0%', 'Expected here: 0 to +10%', 'Measured +2.8%', 'Success bar +5%'])
    const crowded = layoutNumberLine({ ...EXP_1, width: 700 })
    expect(crowded.legend).toBe(false)
    expect(crowded.labels.find((label) => label.key === 'claimed')?.text).toBe('Paper reports +41%')
  })

  it('switches to short labels and a legend on narrow screens, still without collisions', () => {
    for (const input of [EXP_6, EXP_1]) {
      const layout = layoutNumberLine({ ...input, width: 300 })
      expect(300).toBeLessThan(LEGEND_BELOW)
      expect(layout.legend).toBe(true)
      expect(layout.width).toBe(300)
      expect(problems(layout)).toEqual([])
      expect(layout.labels.some((label) => label.key === 'measured')).toBe(true)
    }
  })

  it('colours the measurement by outcome: better, worse, or no clear change', () => {
    expect(layoutNumberLine({ ...EXP_6, width: 600 }).median.tone).toBe('positive')
    expect(layoutNumberLine({ ...EXP_1, width: 600 }).median.tone).toBe('negative')
    expect(layoutNumberLine({ median: 0.5, low: -0.4, high: 1.2, width: 600 }).median.tone).toBe('neutral')
  })

  it('marks the paper’s claim in the reference register and the band as expected-here', () => {
    const layout = layoutNumberLine({ ...EXP_1, predicted: { low: 0, high: 10 }, width: 900 })
    expect(layout.marks.find((mark) => mark.key === 'claimed')?.tone).toBe('reference')
    expect(layout.labels.find((label) => label.key === 'band')?.tone).toBe('info')
  })
})
