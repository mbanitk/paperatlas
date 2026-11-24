import type { EditableField, ExperimentSpec } from '../api/types'

export const NUMERIC_FIELDS: EditableField[] = ['success_threshold_pct', 'rounds', 'warmup']
export const FLAG_PATTERN = /^[a-z][a-z0-9_]{2,40}$/

export type SpecForm = Record<EditableField, string>

export const FIELD_LABELS: Record<EditableField, string> = {
  hypothesis: 'Hypothesis',
  flag_name: 'Feature flag',
  primary_metric: 'Primary metric',
  success_threshold_pct: 'Success threshold (%)',
  rounds: 'Rounds per arm',
  warmup: 'Warm-up rounds',
  workload: 'Workload',
  model: 'Model',
}

/** Form state (all strings) from the current spec. */
export function specToForm(spec: Partial<ExperimentSpec>, fields: readonly EditableField[]): SpecForm {
  const form = {} as SpecForm
  for (const field of fields) {
    const value = spec[field]
    form[field] = value === null || value === undefined ? '' : String(value)
  }
  return form
}

function coerce(field: EditableField, raw: string): string | number {
  if (NUMERIC_FIELDS.includes(field)) {
    const value = Number(raw.trim())
    return field === 'success_threshold_pct' ? value : Math.trunc(value)
  }
  return field === 'flag_name' ? raw.trim() : raw
}

/** Only the fields that differ from the spec, coerced to the backend's types. */
export function diffOverrides(
  spec: Partial<ExperimentSpec>,
  form: Partial<SpecForm>,
  fields: readonly EditableField[],
): Partial<Record<EditableField, string | number>> {
  const overrides: Partial<Record<EditableField, string | number>> = {}
  for (const field of fields) {
    const raw = form[field]
    if (raw === undefined) continue
    const next = coerce(field, raw)
    const current = spec[field]
    if (typeof next === 'number') {
      if (Number.isNaN(next)) {
        overrides[field] = next
        continue
      }
      if (typeof current === 'number' && Math.abs(current - next) < 1e-9) continue
      if (current !== undefined && current !== null && Number(current) === next) continue
    } else if ((current ?? '') === next || (field === 'hypothesis' && String(current ?? '').trim() === next.trim())) {
      continue
    }
    overrides[field] = next
  }
  return overrides
}

/**
 * Form state after the server spec changed from the one `base` was derived from: fields the user has not
 * touched (or whose edit the new spec now contains, e.g. after a save) follow the server; other edits are kept.
 */
export function rebaseForm(base: SpecForm, form: SpecForm, spec: Partial<ExperimentSpec>, fields: readonly EditableField[]): SpecForm {
  const next = specToForm(spec, fields)
  const dirty = diffOverrides(spec, form, fields)
  const rebased = { ...form }
  for (const field of fields) if (!(field in dirty) || form[field] === base[field]) rebased[field] = next[field]
  return rebased
}

/** Client-side validation mirroring ExperimentSpec (planner.py). Returns field → message. */
export function validateSpecForm(form: Partial<SpecForm>, options?: { metrics?: string[]; workloads?: string[]; models?: string[] }) {
  const errors: Partial<Record<EditableField, string>> = {}
  if (form.hypothesis !== undefined && !form.hypothesis.trim()) errors.hypothesis = 'Hypothesis cannot be empty.'
  if (form.flag_name !== undefined && !FLAG_PATTERN.test(form.flag_name.trim()))
    errors.flag_name = 'snake_case, 3–41 characters, starting with a letter.'
  const intIn = (field: EditableField, low: number, high: number) => {
    const raw = form[field]
    if (raw === undefined) return
    const value = Number(raw)
    if (raw.trim() === '' || !Number.isInteger(value) || value < low || value > high)
      errors[field] = `Whole number between ${low} and ${high}.`
  }
  intIn('rounds', 2, 60)
  intIn('warmup', 0, 5)
  if (form.success_threshold_pct !== undefined) {
    const value = Number(form.success_threshold_pct)
    if (form.success_threshold_pct.trim() === '' || Number.isNaN(value) || value < 0 || value > 500)
      errors.success_threshold_pct = 'Between 0 and 500.'
  }
  if (form.primary_metric !== undefined && options?.metrics?.length && !options.metrics.includes(form.primary_metric))
    errors.primary_metric = 'Pick one of the project metrics.'
  if (form.workload !== undefined && options?.workloads?.length && !options.workloads.includes(form.workload))
    errors.workload = 'Pick one of the project workloads.'
  if (form.model !== undefined && options?.models?.length && !options.models.includes(form.model))
    errors.model = 'Pick one of the project models.'
  return errors
}
