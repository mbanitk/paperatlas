import { useState, type ReactNode } from 'react'
import type { EditableField, Experiment, ExperimentSpec, Project } from '../../api/types'
import { useEditSpec, useSpecDecision } from '../../api/queries'
import { ConfirmDialog, Modal } from '../../components/Dialog'
import { CheckIcon, GateIcon, XIcon } from '../../components/Icons'
import { useToast } from '../../components/Toast'
import { Button, Card, Chip, DefinitionList, Field, InlineError, cx, errorMessage } from '../../components/ui'
import { formatDuration, formatPct, humanize } from '../../lib/format'
import { diffOverrides, FIELD_LABELS, rebaseForm, specToForm, validateSpecForm, type SpecForm } from '../../lib/spec'

function metricInfo(project: Project | undefined, name: string | undefined) {
  return project?.metrics?.find((metric) => metric.name === name)
}

function modelLabel(project: Project | undefined, alias: string) {
  const model = project?.models?.[alias]
  if (!model) return alias
  const id = typeof model === 'string' ? model : model.id
  return id ? `${alias} — ${id}` : alias
}

function workloadDescription(project: Project | undefined, name: string): string | undefined {
  const workloads = project?.workloads
  if (!Array.isArray(workloads)) return undefined
  const match = workloads.find((item) => (typeof item === 'string' ? item === name : item.name === name))
  return match && typeof match !== 'string' ? match.description : undefined
}

/** Read-only view of the non-editable parts of the spec (and of everything once approved). */
export function SpecDetails({ spec, project, includeEditable = false }: { spec: Partial<ExperimentSpec>; project?: Project; includeEditable?: boolean }) {
  const guardrails = spec.guardrails ?? {}
  const primary = metricInfo(project, spec.primary_metric)
  const items: [string, ReactNode][] = []
  if (includeEditable) {
    items.push(
      ['Hypothesis', spec.hypothesis],
      ['Feature flag', spec.flag_name ? <code className="code-inline">{spec.flag_name}</code> : '—'],
      [
        'Primary metric',
        spec.primary_metric ? (
          <span>
            <code className="code-inline">{spec.primary_metric}</code> <span className="text-muted">{humanize(spec.direction)}</span>
          </span>
        ) : (
          '—'
        ),
      ],
      ['Success threshold', spec.success_threshold_pct !== undefined ? formatPct(spec.success_threshold_pct, 1) : '—'],
      ['Workload · model', `${spec.workload ?? '—'} · ${spec.model ? modelLabel(project, spec.model) : '—'}`],
      ['Rounds', spec.rounds !== undefined ? `${spec.rounds} per arm (ABBA), ${spec.warmup ?? 0} warm-up` : '—'],
    )
  } else if (spec.direction) {
    items.push([
      'Direction',
      <span key="dir">
        {humanize(spec.direction)} {primary?.unit && <span className="text-muted">({primary.unit})</span>}
      </span>,
    ])
  }
  items.push(
    ['Technique', spec.technique_summary],
    ['Implementation notes', <span key="notes" className="whitespace-pre-line">{spec.implementation_notes}</span>],
    [
      'Secondary metrics',
      spec.secondary_metrics?.length
        ? spec.secondary_metrics.map((metric) => (
            <code key={metric} className="code-inline mr-1">
              {metric}
            </code>
          ))
        : '—',
    ],
    ['Lossless', spec.lossless ? 'yes — greedy outputs must match the baseline' : 'no — approximate technique, the quality guardrail applies'],
    ['Paper claims', spec.claimed_gain_pct !== null && spec.claimed_gain_pct !== undefined ? formatPct(spec.claimed_gain_pct, 1) : 'not quantified'],
    [
      'Guardrails',
      <ul key="guardrails" className="space-y-0.5">
        {typeof guardrails.max_exact_match_drop === 'number' && <li>exact-match drop ≤ {(guardrails.max_exact_match_drop * 100).toFixed(1)} pts</li>}
        {typeof guardrails.min_output_agreement === 'number' && <li>output agreement ≥ {(guardrails.min_output_agreement * 100).toFixed(0)}%</li>}
        {typeof guardrails.max_peak_memory_increase_pct === 'number' && <li>peak memory increase ≤ {guardrails.max_peak_memory_increase_pct}%</li>}
      </ul>,
    ],
    ['Paper vs project', spec.paper_vs_project || '—'],
    ['Timeouts', `build ${formatDuration(spec.build_timeout_s)} · smoke ${formatDuration(spec.smoke_timeout_s)} · eval ${formatDuration(spec.eval_timeout_s)}`],
  )
  return <DefinitionList items={items} />
}

function DecisionDialog({ open, onClose, kind, onSubmit, loading, error, overrides }: {
  open: boolean
  onClose: () => void
  kind: 'revise' | 'reject'
  onSubmit: (comment: string) => void
  loading: boolean
  error: unknown
  overrides: number
}) {
  const [comment, setComment] = useState('')
  const required = kind === 'revise'
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={kind === 'revise' ? 'Request a revision' : 'Reject this experiment?'}
      size="sm"
      dismissable={!loading}
      footer={
        <>
          <Button onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={kind === 'reject' ? 'dangerSolid' : 'primary'}
            onClick={() => {
              if (!loading) onSubmit(comment.trim())
            }}
            disabled={required && !comment.trim()}
            loading={loading}
          >
            {kind === 'revise' ? 'Send back to the planner' : 'Reject'}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-muted">
        {kind === 'revise'
          ? 'The planner rewrites the spec using your feedback, then it comes back here for approval.'
          : 'The claim will not be tested; the experiment ends as rejected.'}
        {overrides > 0 && ' Your unsaved field edits are not applied.'}
      </p>
      <Field
        label={required ? 'What should change? (required)' : 'Reason (optional)'}
        htmlFor={`decision-${kind}`}
        hint={required ? 'e.g. “Use concurrent_4 and measure itl_ms; 10 rounds is enough.”' : undefined}
      >
        <textarea
          id={`decision-${kind}`}
          className="input min-h-24"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          disabled={loading}
          required={required}
          aria-required={required}
        />
      </Field>
      <InlineError error={error} />
    </Modal>
  )
}

/** Gate 2 — review/edit the spec, then approve, request a revision or reject. */
export function SpecGate({ experiment, project }: { experiment: Experiment; project?: Project }) {
  const toast = useToast()
  const spec = experiment.spec
  const fields = experiment.editable_fields
  const options = experiment.spec_options
  const [form, setForm] = useState<SpecForm>(() => specToForm(spec, fields))
  const [dialog, setDialog] = useState<'approve' | 'revise' | 'reject' | null>(null)
  const edit = useEditSpec(experiment.id)
  const decide = useSpecDecision(experiment.id)
  const locked = edit.isPending || decide.isPending

  // The server spec changed (a save landed, or someone else edited it): rebase the form instead of remounting it.
  const specKey = JSON.stringify(spec)
  const [base, setBase] = useState(() => ({ key: specKey, form: specToForm(spec, fields) }))
  if (base.key !== specKey) {
    setBase({ key: specKey, form: specToForm(spec, fields) })
    setForm(rebaseForm(base.form, form, spec, fields))
  }

  const overrides = diffOverrides(spec, form, fields)
  const changed = Object.keys(overrides) as EditableField[]
  const errors = validateSpecForm(form, options)
  const hasErrors = Object.keys(errors).length > 0
  const set = (field: EditableField, value: string) => setForm((current) => ({ ...current, [field]: value }))

  const save = () => {
    if (edit.isPending) return
    edit.mutate(overrides, {
      onSuccess: () => toast.success(`Spec saved: ${changed.map((field) => FIELD_LABELS[field]).join(', ')}`),
      onError: (error) => toast.error(errorMessage(error)),
    })
  }

  const submit = (decision: 'approve' | 'revise' | 'reject', comment?: string) => {
    if (decide.isPending) return
    decide.reset()
    decide.mutate(
      { decision, overrides: decision === 'approve' && changed.length ? overrides : undefined, comment: comment || undefined },
      {
        onSuccess: () => {
          setDialog(null)
          toast.success(
            decision === 'approve'
              ? 'Spec approved — the build job is queued.'
              : decision === 'revise'
                ? 'Revision requested — the planner will rewrite the spec.'
                : 'Experiment rejected.',
          )
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    )
  }

  const open = (kind: 'approve' | 'revise' | 'reject') => {
    // Never reset (and so re-enable) a decision that is still in flight.
    if (decide.isPending) return
    decide.reset()
    setDialog(kind)
  }

  const fieldClass = (field: EditableField) =>
    cx('input', changed.includes(field) && 'border-attention-emphasis bg-attention-subtle/40', errors[field] && 'border-danger')
  const describedBy = (field: EditableField) => (errors[field] ? `spec-${field}-error` : `spec-${field}-hint`)
  const primary = metricInfo(project, form.primary_metric)
  const claimed = spec.claimed_gain_pct

  const select = (field: 'primary_metric' | 'workload' | 'model', values: string[], label: (value: string) => string = (v) => v) => (
    <select
      id={`spec-${field}`}
      className={fieldClass(field)}
      value={form[field]}
      onChange={(event) => set(field, event.target.value)}
      disabled={locked}
      aria-describedby={describedBy(field)}
    >
      {!values.includes(form[field]) && <option value={form[field]}>{form[field]}</option>}
      {values.map((value) => (
        <option key={value} value={value}>
          {label(value)}
        </option>
      ))}
    </select>
  )

  const number = (field: 'success_threshold_pct' | 'rounds' | 'warmup', min: number, max: number, step = 1) => (
    <input
      id={`spec-${field}`}
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      max={max}
      className={fieldClass(field)}
      value={form[field]}
      onChange={(event) => set(field, event.target.value)}
      disabled={locked}
      aria-invalid={!!errors[field]}
      aria-describedby={describedBy(field)}
    />
  )

  return (
    <Card
      id="gate"
      className="border-attention-emphasis/60 ring-1 ring-attention-emphasis/30"
      title={
        <span className="flex items-center gap-2">
          <GateIcon className="text-attention" /> Gate 2 · Review the experiment spec
        </span>
      }
      actions={changed.length > 0 ? <Chip tone="attention">{changed.length} unsaved change{changed.length > 1 ? 's' : ''}</Chip> : undefined}
    >
      <p className="mb-4 text-sm text-muted">
        The planner turned the claim into this spec. Adjust the key fields if needed; on approval a coding agent implements{' '}
        <code className="code-inline">{form.flag_name || spec.flag_name}</code> on a new branch and the A/B benchmark runs.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!hasErrors && !locked) open('approve')
        }}
        noValidate
      >
        <div className="grid gap-4 md:grid-cols-6">
          {fields.includes('hypothesis') && (
            <Field className="md:col-span-6" label={FIELD_LABELS.hypothesis} htmlFor="spec-hypothesis" error={errors.hypothesis} hint="One falsifiable sentence with the metric and the minimum effect.">
              <textarea
                id="spec-hypothesis"
                className={cx(fieldClass('hypothesis'), 'min-h-16')}
                value={form.hypothesis}
                onChange={(event) => set('hypothesis', event.target.value)}
                disabled={locked}
                aria-invalid={!!errors.hypothesis}
                aria-describedby={describedBy('hypothesis')}
              />
            </Field>
          )}
          {fields.includes('flag_name') && (
            <Field className="md:col-span-2" label={FIELD_LABELS.flag_name} htmlFor="spec-flag_name" error={errors.flag_name} hint="snake_case technique name, off by default">
              <input
                id="spec-flag_name"
                className={cx(fieldClass('flag_name'), 'font-mono')}
                value={form.flag_name}
                onChange={(event) => set('flag_name', event.target.value)}
                disabled={locked}
                aria-invalid={!!errors.flag_name}
                aria-describedby={describedBy('flag_name')}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          )}
          {fields.includes('primary_metric') && (
            <Field
              className="md:col-span-2"
              label={FIELD_LABELS.primary_metric}
              htmlFor="spec-primary_metric"
              error={errors.primary_metric}
              hint={primary ? [humanize(primary.direction), primary.unit].filter(Boolean).join(' · ') : undefined}
            >
              {select('primary_metric', options.metrics)}
            </Field>
          )}
          {fields.includes('success_threshold_pct') && (
            <Field
              className="md:col-span-2"
              label={FIELD_LABELS.success_threshold_pct}
              htmlFor="spec-success_threshold_pct"
              error={errors.success_threshold_pct}
              hint={claimed !== null && claimed !== undefined ? `Minimum worthwhile gain · paper claims ${formatPct(claimed, 0)}` : 'Minimum worthwhile gain'}
            >
              {number('success_threshold_pct', 0, 500, 0.5)}
            </Field>
          )}
          {fields.includes('workload') && (
            <Field className="md:col-span-2" label={FIELD_LABELS.workload} htmlFor="spec-workload" error={errors.workload} hint={workloadDescription(project, form.workload)}>
              {select('workload', options.workloads)}
            </Field>
          )}
          {fields.includes('model') && (
            <Field className="md:col-span-2" label={FIELD_LABELS.model} htmlFor="spec-model" error={errors.model} hint="Model used for the A/B evaluation">
              {select('model', options.models, (value) => modelLabel(project, value))}
            </Field>
          )}
          {fields.includes('rounds') && (
            <Field className="md:col-span-1" label={FIELD_LABELS.rounds} htmlFor="spec-rounds" error={errors.rounds} hint="2–60, interleaved">
              {number('rounds', 2, 60)}
            </Field>
          )}
          {fields.includes('warmup') && (
            <Field className="md:col-span-1" label={FIELD_LABELS.warmup} htmlFor="spec-warmup" error={errors.warmup} hint="0–5">
              {number('warmup', 0, 5)}
            </Field>
          )}
        </div>

        <details className="mt-5 rounded-md border border-line-muted">
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-fg select-none hover:bg-canvas-subtle">
            Rest of the spec (read-only): technique, implementation notes, guardrails
          </summary>
          <div className="border-t border-line-muted p-3">
            <SpecDetails spec={spec} project={project} />
          </div>
        </details>

        <div className="mt-5 flex flex-col-reverse gap-3 border-t border-line-muted pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => open('revise')} disabled={decide.isPending}>
              Request revision
            </Button>
            <Button variant="danger" onClick={() => open('reject')} disabled={decide.isPending} icon={<XIcon />}>
              Reject
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {changed.length > 0 && (
              <>
                <Button variant="invisible" onClick={() => setForm(specToForm(spec, fields))} disabled={edit.isPending}>
                  Reset
                </Button>
                <Button onClick={save} loading={edit.isPending} disabled={hasErrors || decide.isPending}>
                  Save edits
                </Button>
              </>
            )}
            <Button type="submit" variant="primary" icon={<CheckIcon />} disabled={hasErrors || locked}>
              {changed.length > 0 ? 'Approve with edits' : 'Approve'}
            </Button>
          </div>
        </div>
        {hasErrors && <p className="mt-2 text-right text-xs text-danger">Fix the highlighted fields to continue.</p>}
      </form>

      <ConfirmDialog
        open={dialog === 'approve'}
        onClose={() => setDialog(null)}
        onConfirm={() => submit('approve')}
        title="Approve the spec and start the build?"
        confirmLabel={changed.length ? 'Approve with edits' : 'Approve'}
        loading={decide.isPending}
        error={dialog === 'approve' ? decide.error : null}
      >
        <p className="text-muted">
          A coding agent will implement <code className="code-inline">{form.flag_name}</code> behind a flag on a new branch, then smoke-test and A/B
          benchmark it ({form.rounds} rounds per arm on <code className="code-inline">{form.workload}</code>).
        </p>
        {changed.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-xs font-semibold text-muted">Your edits</div>
            <ul className="space-y-1 text-sm">
              {changed.map((field) => (
                <li key={field}>
                  <span className="text-muted">{FIELD_LABELS[field]}:</span> <del className="text-danger">{String(spec[field] ?? '')}</del> →{' '}
                  <ins className="font-semibold text-success no-underline">{String(overrides[field])}</ins>
                </li>
              ))}
            </ul>
          </div>
        )}
      </ConfirmDialog>
      {dialog === 'revise' && (
        <DecisionDialog
          open
          onClose={() => setDialog(null)}
          kind="revise"
          onSubmit={(comment) => submit('revise', comment)}
          loading={decide.isPending}
          error={decide.error}
          overrides={changed.length}
        />
      )}
      {dialog === 'reject' && (
        <DecisionDialog
          open
          onClose={() => setDialog(null)}
          kind="reject"
          onSubmit={(comment) => submit('reject', comment)}
          loading={decide.isPending}
          error={decide.error}
          overrides={changed.length}
        />
      )}
    </Card>
  )
}
