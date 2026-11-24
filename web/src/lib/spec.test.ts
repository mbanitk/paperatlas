import { describe, expect, it } from 'vitest'
import type { EditableField, ExperimentSpec } from '../api/types'
import { diffOverrides, rebaseForm, specToForm, validateSpecForm } from './spec'

const FIELDS: EditableField[] = ['hypothesis', 'flag_name', 'primary_metric', 'success_threshold_pct', 'rounds', 'warmup', 'workload', 'model']
const SPEC: Partial<ExperimentSpec> = {
  hypothesis: 'Lookahead decoding improves decode_tokens_per_s by 8%.',
  flag_name: 'lookahead_decoding',
  primary_metric: 'decode_tokens_per_s',
  success_threshold_pct: 8,
  rounds: 10,
  warmup: 1,
  workload: 'short_chat',
  model: 'eval',
}

describe('diffOverrides', () => {
  it('returns nothing when the form is untouched', () => {
    expect(diffOverrides(SPEC, specToForm(SPEC, FIELDS), FIELDS)).toEqual({})
  })

  it('returns only changed fields, coerced to numbers where needed', () => {
    const form = { ...specToForm(SPEC, FIELDS), rounds: '20', success_threshold_pct: '7.5', workload: 'long_prompt' }
    expect(diffOverrides(SPEC, form, FIELDS)).toEqual({ rounds: 20, success_threshold_pct: 7.5, workload: 'long_prompt' })
  })

  it('treats equal numbers written differently as unchanged and trims the flag name', () => {
    const form = { ...specToForm(SPEC, FIELDS), success_threshold_pct: '8.0', flag_name: ' lookahead_decoding ' }
    expect(diffOverrides(SPEC, form, FIELDS)).toEqual({})
  })
})

describe('validateSpecForm', () => {
  const options = { metrics: ['decode_tokens_per_s', 'itl_ms'], workloads: ['short_chat'], models: ['eval', 'smoke'] }

  it('accepts the current spec', () => {
    expect(validateSpecForm(specToForm(SPEC, FIELDS), options)).toEqual({})
  })

  it('flags out-of-range and malformed values', () => {
    const errors = validateSpecForm(
      { ...specToForm(SPEC, FIELDS), flag_name: 'Bad-Flag', rounds: '1', warmup: '2.5', success_threshold_pct: '', workload: 'other' },
      options,
    )
    expect(Object.keys(errors).sort()).toEqual(['flag_name', 'rounds', 'success_threshold_pct', 'warmup', 'workload'])
  })
})

describe('rebaseForm', () => {
  const base = specToForm(SPEC, FIELDS)

  it('keeps edits typed while a save was in flight and settles the saved ones', () => {
    // saved rounds 20 and threshold "7.50"; the user then typed a new workload before the save returned
    const form = { ...base, rounds: '20', success_threshold_pct: '7.50', workload: 'long_prompt' }
    const saved = { ...SPEC, rounds: 20, success_threshold_pct: 7.5 }
    const next = rebaseForm(base, form, saved, FIELDS)
    expect(next).toEqual({ ...specToForm(saved, FIELDS), workload: 'long_prompt' })
    expect(diffOverrides(saved, next, FIELDS)).toEqual({ workload: 'long_prompt' })
  })

  it('follows server changes to fields the user has not touched', () => {
    const form = { ...base, model: 'other' }
    const updated = { ...SPEC, warmup: 2 }
    expect(rebaseForm(base, form, updated, FIELDS)).toEqual({ ...base, warmup: '2', model: 'other' })
  })
})
