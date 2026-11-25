import { useState, type ReactNode } from 'react'
import type { EditableField, Experiment, ExperimentSpec, Project, ProtocolField } from '../../api/types'
import { useEditSpec, useSpecDecision } from '../../api/queries'
import { StickyActionBar } from '../../components/ActionBar'
import { CodeToken, MetricName } from '../../components/Badges'
import { ConfirmDialog, Modal } from '../../components/Dialog'
import { CheckIcon, GateIcon, XIcon } from '../../components/Icons'
import { useToast } from '../../components/Toast'
import { Button, Card, Chip, DefinitionList, Disclosure, Field, InlineError, cx, errorMessage } from '../../components/ui'
import { formatClaimed, formatSigned, humanize } from '../../lib/format'
import {
  describeProtocolValue,
  isProtocolField,
  isProtocolV2,
  isScalarField,
  needsAdoptionCheck,
  plainDuration,
  PROTOCOL_LABELS,
  protocolOverrides,
  protocolToForm,
  rebaseProtocol,
  specProtocolValue,
  validateProtocol,
  type ProtocolForm,
} from '../../lib/protocol'
import { diffOverrides, FIELD_LABELS, rebaseForm, specToForm, validateSpecForm, type SpecForm } from '../../lib/spec'
import { ProtocolEditor, ProtocolSummary, TestPlanGlance } from './Protocol'

const fieldLabel = (field: EditableField | ProtocolField) => (isProtocolField(field) ? PROTOCOL_LABELS[field] : FIELD_LABELS[field])

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
      ['Feature flag', spec.flag_name ? <CodeToken>{spec.flag_name}</CodeToken> : 'Not set'],
      [
        'Primary metric',
        spec.primary_metric ? (
          <span className="flex flex-wrap items-baseline gap-x-1.5">
            <MetricName metric={spec.primary_metric} showId /> <span className="text-muted">{humanize(spec.direction)}</span>
          </span>
        ) : (
          'Not set'
        ),
      ],
      ['Success bar', spec.success_threshold_pct !== undefined ? `${formatSigned(spec.success_threshold_pct, { digits: 1 })} or better` : 'Not set'],
      ['Workload · model', `${spec.workload ?? 'Not set'} · ${spec.model ? modelLabel(project, spec.model) : 'Not set'}`],
      ['Rounds', spec.rounds !== undefined ? `${spec.rounds} per side, interleaved (ABBA), ${spec.warmup ?? 0} warm-up` : 'Not set'],
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
      spec.secondary_metrics?.length ? (
        <ul key="secondary" className="flex flex-wrap gap-x-3 gap-y-1">
          {spec.secondary_metrics.map((metric) => (
            <li key={metric}>
              <MetricName metric={metric} showId />
            </li>
          ))}
        </ul>
      ) : (
        'None'
      ),
    ],
    ['Lossless', spec.lossless ? 'Yes: greedy outputs must match the baseline' : 'No: an approximate technique, so the quality guardrail applies'],
    ['Paper reports', formatClaimed(spec.claimed_gain_pct, { digits: 1 })],
    [
      'Guardrails',
      <ul key="guardrails" className="space-y-0.5">
        {typeof guardrails.max_exact_match_drop === 'number' && <li>Exact match drops by at most {(guardrails.max_exact_match_drop * 100).toFixed(1)} points</li>}
        {typeof guardrails.min_output_agreement === 'number' && <li>Output agreement at least {(guardrails.min_output_agreement * 100).toFixed(0)}%</li>}
        {typeof guardrails.max_peak_memory_increase_pct === 'number' && <li>Peak memory grows by at most {guardrails.max_peak_memory_increase_pct}%</li>}
      </ul>,
    ],
    ['Paper vs project', spec.paper_vs_project || 'Not reported'],
    ['Time limits', `Build ${plainDuration(spec.build_timeout_s) || '?'} · smoke ${plainDuration(spec.smoke_timeout_s) || '?'} · A/B ${plainDuration(spec.eval_timeout_s) || '?'}`],
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
      title={kind === 'revise' ? 'Request changes to the test plan' : 'Reject this test plan?'}
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
            {kind === 'revise' ? 'Send back to the planner' : 'Reject plan'}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-muted">
        {kind === 'revise'
          ? 'The planner rewrites the plan using your feedback, then it comes back here for approval.'
          : 'The claim won’t be tested, and the experiment ends as rejected.'}
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
  const v2 = isProtocolV2(spec)
  // Scalar fields are text inputs; protocol v2 fields (objects, lists, toggles) have their own editor.
  const fields = experiment.editable_fields.filter(isScalarField)
  const protocolFields = v2 ? experiment.editable_fields.filter(isProtocolField) : []
  const options = experiment.spec_options
  const [form, setForm] = useState<SpecForm>(() => specToForm(spec, fields))
  const [protocolForm, setProtocolForm] = useState<ProtocolForm>(() => protocolToForm(spec))
  const [dialog, setDialog] = useState<'approve' | 'revise' | 'reject' | null>(null)
  // The form opens on its own when the planner's plan doesn't validate (Approve is disabled until it's fixed).
  const [editOpen, setEditOpen] = useState(() => Object.keys(validateSpecForm(specToForm(spec, fields), experiment.spec_options)).length > 0)
  const edit = useEditSpec(experiment.id)
  const decide = useSpecDecision(experiment.id)
  const locked = edit.isPending || decide.isPending

  // The server spec changed (a save landed, or someone else edited it): rebase the form instead of remounting it.
  const specKey = JSON.stringify(spec)
  const [base, setBase] = useState(() => ({ key: specKey, form: specToForm(spec, fields), protocol: protocolToForm(spec) }))
  if (base.key !== specKey) {
    setBase({ key: specKey, form: specToForm(spec, fields), protocol: protocolToForm(spec) })
    setForm(rebaseForm(base.form, form, spec, fields))
    setProtocolForm(rebaseProtocol(base.protocol, protocolForm, spec, protocolFields))
  }

  const protocolChanges = protocolOverrides(spec, protocolForm, protocolFields)
  const protocolChanged = Object.keys(protocolChanges) as ProtocolField[]
  const overrides: Record<string, unknown> = { ...diffOverrides(spec, form, fields), ...protocolChanges }
  const changed = Object.keys(overrides) as (EditableField | ProtocolField)[]
  const errors = validateSpecForm(form, options)
  const protocolErrors = v2 ? validateProtocol(protocolForm) : {}
  const hasErrors = Object.keys(errors).length > 0 || Object.keys(protocolErrors).length > 0
  const preview = { ...spec, ...overrides } as Partial<ExperimentSpec>
  const set = (field: EditableField, value: string) => setForm((current) => ({ ...current, [field]: value }))

  const save = () => {
    if (edit.isPending) return
    edit.mutate(overrides, {
      onSuccess: () => toast.success(`Plan saved: ${changed.map(fieldLabel).join(', ')}`),
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
              ? 'Plan approved: the build is queued.'
              : decision === 'revise'
                ? 'Changes requested: the planner will rewrite the plan.'
                : 'Plan rejected.',
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

  const reset = () => {
    setForm(specToForm(spec, fields))
    setProtocolForm(protocolToForm(spec))
  }

  const fieldClass = (field: EditableField) =>
    cx('input', changed.includes(field) && 'border-caution-emphasis bg-caution-subtle/40', errors[field] && 'border-negative')
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

  const changeSummary = changed.map(fieldLabel).join(', ')
  const approveLabel = changed.length > 0 ? 'Approve with edits' : 'Approve and start build'

  return (
    <Card
      id="gate"
      attention
      title={
        <span className="flex items-center gap-2">
          <GateIcon className="text-caution-fg" /> Gate 2 · Approve the test plan
        </span>
      }
      actions={changed.length > 0 ? <Chip tone="caution">{changed.length} unsaved change{changed.length > 1 ? 's' : ''}</Chip> : undefined}
    >
      <TestPlanGlance spec={preview} project={project} />

      <div className="mt-5 flex flex-col gap-3 border-t border-line-muted pt-4 lg:flex-row lg:items-center lg:justify-between">
        <p className="max-w-xl text-xs text-muted">
          Approving starts the build on a new branch. Nothing is merged without your decision at Gate 3. Not right? Request changes and the planner rewrites the plan.
        </p>
        <div className="flex flex-wrap items-center gap-2 max-sm:[&>*]:flex-1">
          <Button variant="danger" onClick={() => open('reject')} disabled={decide.isPending} icon={<XIcon />}>
            Reject
          </Button>
          <Button onClick={() => open('revise')} disabled={decide.isPending}>
            Request changes
          </Button>
          <Button variant="primary" icon={<CheckIcon />} disabled={hasErrors || locked} onClick={() => !hasErrors && !locked && open('approve')}>
            {approveLabel}
          </Button>
        </div>
      </div>
      {hasErrors && <p className="mt-2 text-xs text-negative-fg lg:text-right">Fix the highlighted fields under “Edit plan” to continue.</p>}

      {v2 && <ProtocolSummary spec={preview} changed={protocolChanged} showPrediction={false} showFidelity={false} className="mt-5 border-t border-line-muted pt-4" />}

      <div className="mt-4 space-y-2 border-t border-line-muted pt-3">
        <Disclosure
          label="Edit plan"
          meta={changed.length ? ` · ${changed.length} unsaved: ${changeSummary}` : ' · hypothesis, flag, metric, success bar, workload, rounds, protocol'}
          open={editOpen}
          onToggle={setEditOpen}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!hasErrors && !locked) open('approve')
            }}
            noValidate
            className="space-y-4 pt-1"
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
                  hint={claimed !== null && claimed !== undefined ? `Minimum worthwhile gain · paper reports ${formatSigned(claimed, { digits: 0 })}` : 'Minimum worthwhile gain'}
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
            {protocolFields.length > 0 && (
              <ProtocolEditor
                form={protocolForm}
                onChange={(update) => setProtocolForm((current) => update(current))}
                errors={protocolErrors}
                changed={protocolChanged}
                fields={protocolFields}
                disabled={locked}
              />
            )}
            {changed.length > 0 && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="invisible" onClick={reset} disabled={edit.isPending}>
                  Reset
                </Button>
                <Button onClick={save} loading={edit.isPending} disabled={hasErrors || decide.isPending}>
                  Save edits
                </Button>
              </div>
            )}
            <button type="submit" hidden />
          </form>
        </Disclosure>
        <Disclosure label="Rest of the plan" meta=" · technique, implementation notes, guardrails (read-only)">
          <SpecDetails spec={spec} project={project} />
        </Disclosure>
      </div>

      <StickyActionBar
        open={changed.length > 0}
        label="Unsaved plan edits"
        summary={
          <>
            <strong>
              {changed.length} unsaved change{changed.length > 1 ? 's' : ''}
            </strong>
            <span className="text-muted"> · {changeSummary}</span>
          </>
        }
        actions={
          <>
            <Button size="sm" variant="invisible" onClick={reset} disabled={edit.isPending} className="max-sm:hidden">
              Reset
            </Button>
            <Button size="sm" onClick={save} loading={edit.isPending} disabled={hasErrors || decide.isPending}>
              Save
            </Button>
            <Button size="sm" variant="primary" icon={<CheckIcon />} disabled={hasErrors || locked} onClick={() => !hasErrors && !locked && open('approve')}>
              Approve with edits
            </Button>
          </>
        }
      />

      <ConfirmDialog
        open={dialog === 'approve'}
        onClose={() => setDialog(null)}
        onConfirm={() => submit('approve')}
        title="Approve the test plan and start the build?"
        confirmLabel={changed.length ? 'Approve with edits' : 'Approve and start build'}
        loading={decide.isPending}
        error={dialog === 'approve' ? decide.error : null}
        recap={
          <>
            <MetricName metric={preview.primary_metric} /> must improve by {formatSigned(Number(preview.success_threshold_pct), { digits: 1 })} or more ·{' '}
            {String(preview.rounds ?? '?')} rounds per side on {String(preview.workload ?? 'the project workload')}
          </>
        }
        cost={`Runs on the worker and uses the measurement machine: build up to ${plainDuration(spec.build_timeout_s) || '?'}, then the A/B tests (up to ${plainDuration(spec.eval_timeout_s) || '?'} each).`}
      >
        <p className="text-muted">
          A coding agent implements <CodeToken>{form.flag_name || spec.flag_name}</CodeToken> behind a flag on a new branch. Then it’s smoke-tested
          {v2 && preview.tune ? ', tuned' : ''} and measured:{' '}
          {v2 && needsAdoptionCheck(preview) ? (
            <>a claim check against the paper’s setup, and an adoption check on your workload</>
          ) : (
            <>one A/B test on your workload</>
          )}
          {v2 && Number(preview.max_iterations) > 1 && <>, with up to {String(preview.max_iterations)} iterations when the result looks fixable</>}. Nothing is merged
          without your decision.
        </p>
        {changed.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-xs font-semibold text-muted">Your edits</div>
            <ul className="space-y-1 text-sm">
              {changed.map((field) => (
                <li key={field}>
                  <span className="text-muted">{fieldLabel(field)}:</span>{' '}
                  <del className="text-negative-fg">{isProtocolField(field) ? describeProtocolValue(field, specProtocolValue(field, spec)) : String(spec[field] ?? '')}</del> →{' '}
                  <ins className="font-semibold text-fg no-underline">
                    {isProtocolField(field) ? describeProtocolValue(field, overrides[field]) : String(overrides[field])}
                  </ins>
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
