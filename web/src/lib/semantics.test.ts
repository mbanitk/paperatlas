import { describe, expect, it } from 'vitest'
import { bottleneckInfo, likelihoodInfo } from './roofline'
import {
  ADOPTION,
  BOTTLENECK,
  CLAIM_CHECK,
  DIAGNOSIS,
  EXPERIMENT_STATUS,
  FIDELITY,
  gainSemantics,
  levelSemantics,
  LIKELIHOOD,
  semanticTone,
  statusSemantics,
  type SemanticInfo,
} from './semantics'
import { statusInfo, verdictInfo } from './stages'

const tables: [string, Record<string, SemanticInfo>][] = [
  ['status', EXPERIMENT_STATUS],
  ['claim check', CLAIM_CHECK],
  ['adoption', ADOPTION],
  ['likelihood', LIKELIHOOD],
  ['diagnosis', DIAGNOSIS],
  ['fidelity', FIDELITY],
  ['bottleneck', BOTTLENECK],
]

describe('vocabulary', () => {
  it.each(tables)('%s labels are sentence case, never ALL CAPS, and every value is described', (_, table) => {
    for (const info of Object.values(table)) {
      expect(info.label.charAt(0)).toBe(info.label.charAt(0).toUpperCase())
      expect(info.label).not.toMatch(/^[A-Z\s]{4,}$/)
      expect(info.description.length).toBeGreaterThan(10)
    }
  })

  it('uses one word per outcome', () => {
    expect(CLAIM_CHECK.partial.label).toBe('Partly reproduced')
    expect(CLAIM_CHECK.regression.label).toBe('Worse than baseline')
    expect(ADOPTION.not_reproduced.label).toBe('No measurable gain')
    expect(ADOPTION.regression.label).toBe('Worse than default')
    expect(EXPERIMENT_STATUS.awaiting_decision.label).toBe('Needs your decision')
    expect(LIKELIHOOD.marginal.label).toBe('Small or no gain')
  })
})

describe('one meaning per colour', () => {
  it('reserves purple (merged) for merged experiments only', () => {
    for (const [, table] of tables)
      for (const [value, info] of Object.entries(table)) if (info.tone === 'merged') expect(value).toBe('merged')
  })

  it('never shows a prediction of no gain, or an explanation, as a failure', () => {
    expect(LIKELIHOOD.unlikely.tone).toBe('neutral')
    for (const [value, info] of Object.entries(DIAGNOSIS)) expect(info.tone === 'negative').toBe(value === 'implementation_suspect')
  })

  it('marks every gate that needs you with caution', () => {
    expect(EXPERIMENT_STATUS.awaiting_approval.tone).toBe('caution')
    expect(EXPERIMENT_STATUS.awaiting_decision.tone).toBe('caution')
    expect(EXPERIMENT_STATUS.failed.tone).toBe('negative')
  })

  it('maps the legacy tone names', () => {
    expect(semanticTone('success')).toBe('positive')
    expect(semanticTone('danger')).toBe('negative')
    expect(semanticTone('attention')).toBe('caution')
    expect(semanticTone('accent')).toBe('info')
    expect(semanticTone('done')).toBe('merged')
    expect(semanticTone('muted')).toBe('neutral')
    expect(semanticTone('caution')).toBe('caution')
    expect(semanticTone('nope')).toBe('neutral')
  })
})

describe('gain', () => {
  it('says "no clear change" for non-significant results, whatever the sign', () => {
    expect(gainSemantics(2.8, { significant: false })).toMatchObject({ label: 'no clear change', tone: 'neutral' })
    expect(gainSemantics(2.8, { significant: true })).toMatchObject({ label: 'better', tone: 'positive', icon: 'arrow-up' })
    expect(gainSemantics(-63.1)).toMatchObject({ label: 'worse', tone: 'negative', direction: 'down' })
    expect(gainSemantics(0.01)).toMatchObject({ direction: 'flat' })
    expect(gainSemantics(null)).toMatchObject({ label: 'not measured', direction: 'none' })
  })
})

describe('effort, risk and fit', () => {
  it('are neutral words, not colours', () => {
    expect(levelSemantics('effort', 'high')).toMatchObject({ label: 'Effort: high', tone: 'neutral', dots: 3 })
    expect(levelSemantics('risk', 'low')).toMatchObject({ label: 'Risk: low', dots: 1 })
    expect(levelSemantics('fit', null)).toMatchObject({ label: 'Fit: unknown', dots: 0 })
  })
})

describe('re-exports stay in sync', () => {
  it('serves stages and roofline from the same tables', () => {
    expect(statusInfo('tuning')).toBe(EXPERIMENT_STATUS.tuning)
    expect(statusInfo('some_new_status')).toMatchObject({ label: 'Some new status', tone: 'neutral', busy: false })
    expect(statusSemantics('tuning').busy).toBe(true)
    expect(verdictInfo('partial')).toBe(CLAIM_CHECK.partial)
    expect(likelihoodInfo('unlikely')).toBe(LIKELIHOOD.unlikely)
    expect(likelihoodInfo(undefined)).toBe(LIKELIHOOD.unknown)
    expect(bottleneckInfo('overhead')).toMatchObject({ label: BOTTLENECK.overhead.label, tone: 'attention' })
    expect(semanticTone(bottleneckInfo('bandwidth').tone)).toBe(BOTTLENECK.bandwidth.tone)
  })
})
