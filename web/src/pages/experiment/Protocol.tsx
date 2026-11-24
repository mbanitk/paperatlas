import { useState, type ReactNode } from 'react'
import type { ExperimentSpec, FidelityLevel, PaperBaselineKind, Project, ProtocolField } from '../../api/types'
import { CodeToken, MetricName, OutcomeBadge } from '../../components/Badges'
import { AlertIcon, ChevronDown, ChevronRight, MinusIcon, XIcon } from '../../components/Icons'
import { PredictionPanel } from '../../components/Prediction'
import { AnswerBlock, Button, Checkbox, Chip, cx, Disclosure, Field, IconButton } from '../../components/ui'
import { formatRange, formatSigned } from '../../lib/format'
import {
  BASELINE_KIND_LABELS,
  claimTarget,
  FIDELITY_INFO,
  formatKnobValue,
  MAX_COUNTERS,
  MAX_KNOBS,
  MAX_ITERATIONS,
  MAX_NEW_TOKENS,
  maxPrompts,
  MIN_NEW_TOKENS,
  needsAdoptionCheck,
  plainDuration,
  protocolOf,
  tuneConfigs,
  workloadSummary,
  type ProtocolErrors,
  type ProtocolForm,
} from '../../lib/protocol'

export function FidelityBadge({ level, className }: { level: FidelityLevel; className?: string }) {
  const info = FIDELITY_INFO[level]
  return (
    <Chip tone={info.tone} className={className} title={info.description}>
      <span className="flex items-end gap-px" aria-hidden="true">
        {[0, 1, 2].map((bar) => (
          <span
            key={bar}
            className={cx('w-[3px] rounded-[1px] bg-current', bar > ['low', 'medium', 'high'].indexOf(level) && 'opacity-25')}
            style={{ height: 4 + bar * 2.5 }}
          />
        ))}
      </span>
      {info.label}
    </Chip>
  )
}

function CheckCard({ question, title, children }: { question: string; title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-line bg-canvas px-3 py-2.5">
      <div className="text-xs font-semibold text-muted">{title}</div>
      <div className="text-sm font-semibold text-fg">{question}</div>
      <dl className="mt-2 space-y-1.5 text-sm">{children}</dl>
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-xs leading-5 text-muted">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </div>
  )
}

/** Long planner prose: three lines, then "more". */
function MoreText({ children }: { children: string }) {
  const [open, setOpen] = useState(false)
  const long = children.length > 200
  return (
    <span className="mt-0.5 block">
      <span className={long && !open ? 'line-clamp-3' : 'block'}>{children}</span>
      {long && (
        <button type="button" className="min-h-6 text-xs font-medium text-info-fg hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'less' : 'more'}
        </button>
      )}
    </span>
  )
}

const changedRing = (changed: boolean) => (changed ? 'rounded-md ring-2 ring-caution-emphasis/50 ring-offset-1' : '')

function modelLabel(project: Project | undefined, alias: string | undefined) {
  if (!alias) return null
  const model = project?.models?.[alias]
  const id = typeof model === 'string' ? model : model?.id
  return id ? `${alias} (${id})` : alias
}

function Fact({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-canvas px-3 py-2">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-fg [overflow-wrap:anywhere]">{children}</dd>
      {hint && <dd className="mt-0.5 text-xs text-muted">{hint}</dd>}
    </div>
  )
}

/**
 * Gate 2's answer first (docs/ux-review.md X-12): what we'll test, the success bar, the workload and model, the
 * sample size and time budget, what to expect, and how closely it follows the paper. Everything else is a
 * disclosure away.
 */
export function TestPlanGlance({ spec, project, className }: { spec: Partial<ExperimentSpec>; project?: Project; className?: string }) {
  const protocol = protocolOf(spec)
  const adoption = needsAdoptionCheck(spec)
  const target = claimTarget(spec.claimed_gain_pct, spec.success_threshold_pct)
  const prediction = spec.prediction
  const range = prediction?.predicted_gain_pct
  const timeouts = [spec.build_timeout_s, spec.smoke_timeout_s, spec.eval_timeout_s].filter((value): value is number => typeof value === 'number' && value > 0)
  const budget = timeouts.reduce((sum, value) => sum + value, 0)
  const runs = adoption ? 'two A/B tests' : 'an A/B test'
  return (
    <div className={cx('space-y-3', className)}>
      <div>
        <h3 className="text-xs font-semibold text-muted">What we’ll test</h3>
        <p className="mt-0.5 max-w-3xl text-body-lg text-fg">{spec.hypothesis || 'The planner didn’t write a hypothesis.'}</p>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          On approval, a coding agent builds the technique behind the flag {spec.flag_name ? <CodeToken>{spec.flag_name}</CodeToken> : 'for this claim'} on its own branch, then
          we run {runs}{adoption ? ': one against the paper’s setup (does the claim hold?) and one on your default workload (is it worth adopting here?)' : ' on your default workload'}.
          Nothing is merged without your decision at Gate 3.
        </p>
      </div>
      <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Fact
          label="Success bar"
          hint={[
            adoption && target !== null && target !== spec.success_threshold_pct ? `Claim check needs ${formatSigned(target, { digits: 1 })}` : null,
            typeof spec.claimed_gain_pct === 'number' ? `Paper reports ${formatSigned(spec.claimed_gain_pct, { digits: 0 })}` : 'Paper gives no number',
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          {formatSigned(adoption ? spec.success_threshold_pct : target, { digits: 1, fallback: 'Not set' })} or better on <MetricName metric={spec.primary_metric} />
        </Fact>
        <Fact label="Workload and model" hint={adoption && protocol.paper_workload ? 'Claim check uses a paper-like workload' : undefined}>
          {spec.workload ?? 'Not set'} · {modelLabel(project, spec.model) ?? 'Not set'}
        </Fact>
        <Fact label="Sample size" hint={protocol.max_iterations > 1 ? `Up to ${protocol.max_iterations} iterations if the result looks fixable` : undefined}>
          {spec.rounds ?? '?'} rounds per side{spec.warmup ? `, ${spec.warmup} warm-up` : ''}
        </Fact>
        <Fact label="Time limit" hint={timeouts.length ? `Build ${plainDuration(spec.build_timeout_s)} · smoke ${plainDuration(spec.smoke_timeout_s)} · A/B ${plainDuration(spec.eval_timeout_s)}` : undefined}>
          {budget ? `Up to ${plainDuration(budget)}` : 'Not set'}
        </Fact>
      </dl>
      {(range || prediction || protocol.version >= 2) && (
        <div className="grid gap-2 sm:grid-cols-2">
          {prediction && (
            <AnswerBlock
              register="predicted"
              size="md"
              label="Expected here (cost model)"
              value={formatRange(range?.low, range?.high)}
              badge={<OutcomeBadge kind="likelihood" value={prediction.likelihood} explain />}
              confidence={prediction.reasons?.[0]}
            />
          )}
          {protocol.version >= 2 && (
            <div className="min-w-0 rounded-lg border border-line bg-canvas px-3 py-2">
              <div className="text-xs font-medium text-muted">How close to the paper</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <FidelityBadge level={protocol.fidelity.level} />
                <span className="text-sm text-fg">
                  {protocol.fidelity.gaps.length ? `${protocol.fidelity.gaps.length} known gap${protocol.fidelity.gaps.length > 1 ? 's' : ''} to the paper` : 'No known gaps'}
                </span>
              </div>
              {protocol.fidelity.gaps[0] && <p className="mt-1 line-clamp-2 text-xs text-muted">{protocol.fidelity.gaps[0]}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * "How we'll test the paper's claim": the claim check (method vs the paper's baseline on a paper-like workload)
 * and the adoption check (method vs the project default on its workload), in plain words; counters, knobs and
 * known gaps are one click away.
 */
export function ProtocolSummary({ spec, changed = [], className, showPrediction = true, showFidelity = true }: {
  spec: Partial<ExperimentSpec>
  changed?: ProtocolField[]
  className?: string
  /** Off when the prediction is already shown nearby (Gate 2's plan at a glance). */
  showPrediction?: boolean
  showFidelity?: boolean
}) {
  const protocol = protocolOf(spec)
  const adoption = needsAdoptionCheck(spec)
  const target = claimTarget(spec.claimed_gain_pct, spec.success_threshold_pct)
  const workload = protocol.paper_workload
  const configs = tuneConfigs(protocol.knobs)
  const tuned = protocol.tune && configs.length >= 2
  const is = (field: ProtocolField) => changed.includes(field)
  const metric = spec.primary_metric ? <MetricName metric={spec.primary_metric} /> : 'the primary metric'
  const prediction = showPrediction ? spec.prediction : null
  const expertChanged = is('mechanism') || is('knobs') || is('tune') || is('lossless') || is('max_iterations')

  return (
    <div className={cx('space-y-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">How we’ll test the paper’s claim</h3>
        {showFidelity && (
          <span className={changedRing(is('fidelity'))}>
            <FidelityBadge level={protocol.fidelity.level} />
          </span>
        )}
      </div>
      <p className="max-w-3xl text-sm text-muted">
        {adoption
          ? 'Two A/B tests with the same build. The claim check recreates the paper’s comparison to see whether its claim holds; the adoption check measures the change on your project’s default setup to see whether it’s worth keeping.'
          : 'One A/B test with the change on and off, on your project’s default setup. It answers both questions: does the claim hold here, and is it worth keeping?'}
      </p>
      <div className={cx('grid gap-3', (adoption || prediction) && 'md:grid-cols-2')}>
        <CheckCard title="Claim check" question="Does the paper’s claim hold?">
          <Row label="Compares">
            <span className={changedRing(is('paper_baseline'))}>
              the method vs{' '}
              {protocol.paper_baseline.kind === 'technique_mode' ? (
                <>
                  <strong>the paper’s baseline</strong> <span className="text-xs whitespace-nowrap text-muted">(same flag, mode=baseline)</span>
                  {protocol.paper_baseline.description && (
                    <span className="block text-sm text-fg">
                      <MoreText>{protocol.paper_baseline.description}</MoreText>
                    </span>
                  )}
                </>
              ) : (
                <>
                  <strong>your project’s default</strong> <span className="text-xs text-muted">(flag off)</span>
                  {protocol.paper_baseline.description && (
                    <span className="block text-xs text-muted">
                      <MoreText>{`The paper compared against: ${protocol.paper_baseline.description}`}</MoreText>
                    </span>
                  )}
                </>
              )}
            </span>
          </Row>
          <Row label="Workload">
            <span className={changedRing(is('paper_workload'))}>
              {workload ? (
                <>
                  <strong>Paper-like</strong>
                  {workload.matches && <>, mirrors {workload.matches}</>}
                  <span className="block text-xs text-muted">{workloadSummary(workload)}</span>
                </>
              ) : (
                <>
                  your workload <CodeToken>{spec.workload}</CodeToken>
                  <span className="block text-xs text-muted">No paper-like workload set</span>
                </>
              )}
            </span>
          </Row>
          <Row label="Passes if">
            {metric} improves by {formatSigned(target, { digits: 1, fallback: 'the target' })} or more
            {typeof spec.claimed_gain_pct === 'number' && <span className="block text-xs text-muted">70% of the paper’s {formatSigned(spec.claimed_gain_pct, { digits: 0 })}</span>}
          </Row>
        </CheckCard>
        {adoption && (
          <CheckCard title="Adoption check" question="Is it worth adopting here?">
            <Row label="Compares">
              the method vs <strong>your project’s default</strong> <span className="text-xs text-muted">(flag off)</span>
            </Row>
            <Row label="Workload">
              your workload <CodeToken>{spec.workload}</CodeToken>
            </Row>
            <Row label="Worth it if">
              {metric} improves by {formatSigned(spec.success_threshold_pct, { digits: 1, fallback: 'the success bar' })} or more{' '}
              <span className="block text-xs text-muted">Your success bar, with quality intact</span>
            </Row>
          </CheckCard>
        )}
        {prediction && <PredictionPanel prediction={prediction} claimed={spec.claimed_gain_pct} className={adoption ? 'md:col-span-2' : undefined} />}
      </div>

      <Disclosure label="Counters, settings and known gaps" meta=" · for experts" defaultOpen={expertChanged}>
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <section className={cx('min-w-0', changedRing(is('mechanism')))}>
              <h4 className="mb-1 text-xs font-semibold text-muted">Mechanism counters: what the technique should change</h4>
              {protocol.mechanism.length ? (
                <ul className="space-y-1">
                  {protocol.mechanism.map((counter) => (
                    <li key={counter.name} className="text-sm">
                      <CodeToken>{counter.name}</CodeToken>
                      {counter.meaning && <span className="text-muted"> · {counter.meaning}</span>}
                      {counter.paper_value && <span className="ml-1 text-xs text-fg">(paper: {counter.paper_value})</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex gap-1.5 text-xs text-caution-fg">
                  <AlertIcon size={14} className="mt-px shrink-0" /> None: a miss can’t be told apart from a broken build.
                </p>
              )}
            </section>
            <section className={cx('min-w-0', changedRing(is('knobs') || is('tune')))}>
              <h4 className="mb-1 flex flex-wrap items-center gap-2 text-xs font-semibold text-muted">
                Settings to tune
                {protocol.knobs.length > 0 && (
                  <Chip tone={tuned ? 'info' : 'neutral'}>{tuned ? `Tuned first · ${configs.length} settings × ${protocol.tune_rounds} round` : 'Not tuned'}</Chip>
                )}
              </h4>
              {protocol.knobs.length ? (
                <ul className="space-y-1">
                  {protocol.knobs.map((knob) => (
                    <li key={knob.name} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
                      <CodeToken>{knob.name}</CodeToken>
                      {knob.candidates.map((value, index) => (
                        <span
                          key={formatKnobValue(value)}
                          className={cx('rounded-full border px-1.5 text-xs tabular-nums', index === 0 ? 'border-fg/40 bg-canvas-subtle font-semibold text-fg' : 'border-line bg-canvas text-muted')}
                        >
                          {formatKnobValue(value)}
                          {index === 0 && <span className="sr-text"> (the paper’s setting, tried first)</span>}
                        </span>
                      ))}
                      {knob.paper_value && <span className="text-xs text-muted">paper: {knob.paper_value}</span>}
                      {knob.meaning && <span className="basis-full text-xs text-muted">{knob.meaning}</span>}
                    </li>
                  ))}
                  <li className="text-xs text-muted">The first value is the paper’s setting.</li>
                </ul>
              ) : (
                <p className="text-xs text-muted">None: the paper’s setting is used as is.</p>
              )}
            </section>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className={changedRing(is('lossless'))}>
              <Chip tone="neutral">{protocol.lossless ? 'Lossless: outputs must match' : 'Approximate: the quality guardrail applies'}</Chip>
            </span>
            <span className={changedRing(is('max_iterations'))}>
              <Chip tone="neutral">
                Up to {protocol.max_iterations} iteration{protocol.max_iterations > 1 ? 's' : ''}
                {protocol.max_iterations > 1 && ' · analyse, fix, measure again'}
              </Chip>
            </span>
            {spec.baseline_flags && spec.baseline_flags.length > 0 && <Chip tone="neutral">Baseline keeps {spec.baseline_flags.join(', ')} on</Chip>}
          </div>

          {protocol.fidelity.gaps.length > 0 && (
            <div className={cx('rounded-md border border-line-muted px-3 py-2', changedRing(is('fidelity')))}>
              <h4 className="mb-1 text-xs font-semibold text-muted">Known gaps to the paper</h4>
              <ul className="list-disc space-y-0.5 pl-4 text-sm">
                {protocol.fidelity.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Disclosure>
    </div>
  )
}

// ---- editor -----------------------------------------------------------------------------------

function RemoveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return <IconButton label={label} onClick={onClick} disabled={disabled} icon={<XIcon size={14} />} className="hover:bg-negative-subtle hover:text-negative-fg" />
}

function Section({ title, hint, changed, children }: { title: string; hint?: ReactNode; changed: boolean; children: ReactNode }) {
  return (
    <fieldset className={cx('min-w-0 rounded-md border px-3 pt-1 pb-3', changed ? 'border-attention-emphasis bg-attention-subtle/30' : 'border-line-muted')}>
      <legend className="px-1 text-xs font-semibold text-fg">
        {title}
        {changed && <span className="ml-1.5 font-normal text-attention">edited</span>}
      </legend>
      {hint && <p className="mb-2 text-xs text-muted">{hint}</p>}
      {children}
    </fieldset>
  )
}

export function ProtocolEditor({ form, onChange, errors, changed, fields, disabled }: {
  form: ProtocolForm
  onChange: (update: (form: ProtocolForm) => ProtocolForm) => void
  errors: ProtocolErrors
  changed: ProtocolField[]
  fields: ProtocolField[]
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const has = (field: ProtocolField) => fields.includes(field)
  const is = (field: ProtocolField) => changed.includes(field)
  const input = (key: string, extra?: string) => cx('input', errors[key] && 'border-danger', extra)
  const workload = form.paper_workload
  const setWorkload = (patch: Partial<ProtocolForm['paper_workload']>) => onChange((f) => ({ ...f, paper_workload: { ...f.paper_workload, ...patch } }))
  const edited = changed.length

  return (
    <div className="rounded-md border border-line-muted">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold hover:bg-canvas-subtle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="protocol-editor"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Edit the test protocol
        <span className="font-normal text-muted">baseline, paper workload, counters, settings, fidelity</span>
        {edited > 0 && <Chip tone="attention" className="ml-auto">{edited} edited</Chip>}
      </button>
      {open && (
        <div id="protocol-editor" className="space-y-3 border-t border-line-muted p-3">
          {has('paper_baseline') && (
            <Section title="Paper baseline" changed={is('paper_baseline')} hint="What the paper compared its method against. Use “another method” when the paper did not compare against plain decoding.">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
                <Field label="Kind" htmlFor="protocol-baseline-kind">
                  <select
                    id="protocol-baseline-kind"
                    className="input"
                    value={form.paper_baseline.kind}
                    disabled={disabled}
                    onChange={(event) => onChange((f) => ({ ...f, paper_baseline: { ...f.paper_baseline, kind: event.target.value as PaperBaselineKind } }))}
                  >
                    {(Object.keys(BASELINE_KIND_LABELS) as PaperBaselineKind[]).map((kind) => (
                      <option key={kind} value={kind}>
                        {BASELINE_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Description" htmlFor="protocol-baseline-description" error={errors['paper_baseline.description']}>
                  <textarea
                    id="protocol-baseline-description"
                    className={input('paper_baseline.description', 'min-h-20')}
                    value={form.paper_baseline.description}
                    disabled={disabled}
                    placeholder="e.g. EAGLE-2 with its static draft tree"
                    onChange={(event) => onChange((f) => ({ ...f, paper_baseline: { ...f.paper_baseline, description: event.target.value } }))}
                  />
                </Field>
              </div>
            </Section>
          )}

          {has('paper_workload') && (
            <Section title="Paper workload" changed={is('paper_workload')} hint="Prompts that mirror the paper’s benchmark, used by the claim check (the adoption check keeps the project workload).">
              <Checkbox
                id="protocol-workload-enabled"
                checked={workload.enabled}
                disabled={disabled}
                onChange={(enabled) => setWorkload({ enabled })}
                label="Use a paper-like workload for the claim check"
              />
              {workload.enabled && (
                <div className="mt-3 space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Mirrors" htmlFor="protocol-workload-matches" hint="Which benchmark of the paper">
                      <input id="protocol-workload-matches" className="input" value={workload.matches} disabled={disabled} onChange={(e) => setWorkload({ matches: e.target.value })} />
                    </Field>
                    <Field label="Description" htmlFor="protocol-workload-description">
                      <input id="protocol-workload-description" className="input" value={workload.description} disabled={disabled} onChange={(e) => setWorkload({ description: e.target.value })} />
                    </Field>
                  </div>
                  <div>
                    <div className="label">
                      Prompts <span className="font-normal text-muted">({workload.prompts.filter((p) => p.trim()).length}/{maxPrompts(Number(workload.max_new_tokens))})</span>
                    </div>
                    <ol className="space-y-1.5">
                      {workload.prompts.map((prompt, index) => (
                        <li key={index} className="flex items-start gap-1.5">
                          <span className="mt-2 w-4 shrink-0 text-right text-xs text-muted tabular-nums">{index + 1}</span>
                          <textarea
                            aria-label={`Prompt ${index + 1}`}
                            className={input('paper_workload.prompts', 'min-h-12 flex-1')}
                            value={prompt}
                            disabled={disabled}
                            onChange={(event) => setWorkload({ prompts: workload.prompts.map((p, i) => (i === index ? event.target.value : p)) })}
                          />
                          <RemoveButton
                            label={`Remove prompt ${index + 1}`}
                            disabled={disabled || workload.prompts.length === 1}
                            onClick={() => setWorkload({ prompts: workload.prompts.filter((_, i) => i !== index) })}
                          />
                        </li>
                      ))}
                    </ol>
                    {errors['paper_workload.prompts'] && <p className="mt-1 text-xs text-danger">{errors['paper_workload.prompts']}</p>}
                    <Button
                      size="sm"
                      variant="invisible"
                      className="mt-1"
                      disabled={disabled || workload.prompts.length >= maxPrompts(Number(workload.max_new_tokens))}
                      onClick={() => setWorkload({ prompts: [...workload.prompts, ''] })}
                    >
                      + Add prompt
                    </Button>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="New tokens" htmlFor="protocol-workload-tokens" hint={`${MIN_NEW_TOKENS}–${MAX_NEW_TOKENS} per prompt`} error={errors['paper_workload.max_new_tokens']}>
                      <input
                        id="protocol-workload-tokens"
                        type="number"
                        min={MIN_NEW_TOKENS}
                        max={MAX_NEW_TOKENS}
                        className={input('paper_workload.max_new_tokens')}
                        value={workload.max_new_tokens}
                        disabled={disabled}
                        onChange={(e) => setWorkload({ max_new_tokens: e.target.value })}
                      />
                    </Field>
                    <Field label="Concurrency" htmlFor="protocol-workload-concurrency" hint="1–8" error={errors['paper_workload.concurrency']}>
                      <input
                        id="protocol-workload-concurrency"
                        type="number"
                        min={1}
                        max={8}
                        className={input('paper_workload.concurrency')}
                        value={workload.concurrency}
                        disabled={disabled}
                        onChange={(e) => setWorkload({ concurrency: e.target.value })}
                      />
                    </Field>
                    <Field label="Long context" htmlFor="protocol-workload-context" hint="tokens, 0 = none" error={errors['paper_workload.long_context_tokens']}>
                      <input
                        id="protocol-workload-context"
                        type="number"
                        min={0}
                        max={16000}
                        step={500}
                        className={input('paper_workload.long_context_tokens')}
                        value={workload.long_context_tokens}
                        disabled={disabled}
                        onChange={(e) => setWorkload({ long_context_tokens: e.target.value })}
                      />
                    </Field>
                  </div>
                </div>
              )}
            </Section>
          )}

          {has('mechanism') && (
            <Section title="Mechanism counters" changed={is('mechanism')} hint="Counters the technique reports, so the verdict can say why a number moved (e.g. verify passes, accepted tokens).">
              {form.mechanism.length > 0 && (
                <div className="mb-1 hidden gap-1.5 text-xs text-muted sm:grid sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,8rem)_2rem]">
                  <span>Name</span>
                  <span>Meaning</span>
                  <span>Paper value</span>
                </div>
              )}
              <ul className="space-y-1.5">
                {form.mechanism.map((row, index) => {
                  const update = (patch: Partial<ProtocolForm['mechanism'][number]>) =>
                    onChange((f) => ({ ...f, mechanism: f.mechanism.map((r, i) => (i === index ? { ...r, ...patch } : r)) }))
                  return (
                    <li key={index} className="grid gap-1.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,8rem)_2rem]">
                      <input aria-label={`Counter ${index + 1} name`} className={input(`mechanism.${index}.name`, 'font-mono')} value={row.name} disabled={disabled} placeholder="verify_passes" onChange={(e) => update({ name: e.target.value })} />
                      <input aria-label={`Counter ${index + 1} meaning`} className="input" value={row.meaning} disabled={disabled} placeholder="what it counts" onChange={(e) => update({ meaning: e.target.value })} />
                      <input aria-label={`Counter ${index + 1} paper value`} className="input" value={row.paper_value} disabled={disabled} placeholder="paper value" onChange={(e) => update({ paper_value: e.target.value })} />
                      <RemoveButton label={`Remove counter ${index + 1}`} disabled={disabled} onClick={() => onChange((f) => ({ ...f, mechanism: f.mechanism.filter((_, i) => i !== index) }))} />
                      {errors[`mechanism.${index}.name`] && <p className="text-xs text-danger sm:col-span-4">{errors[`mechanism.${index}.name`]}</p>}
                    </li>
                  )
                })}
              </ul>
              {errors.mechanism && <p className="mt-1 text-xs text-danger">{errors.mechanism}</p>}
              <Button
                size="sm"
                variant="invisible"
                className="mt-1"
                disabled={disabled || form.mechanism.length >= MAX_COUNTERS}
                onClick={() => onChange((f) => ({ ...f, mechanism: [...f.mechanism, { name: '', meaning: '', paper_value: '' }] }))}
              >
                + Add counter
              </Button>
            </Section>
          )}

          {has('knobs') && (
            <Section title="Knobs" changed={is('knobs')} hint="Hyperparameters to tune before the measured runs: list the paper’s value first, then up to two alternatives.">
              {form.knobs.length > 0 && (
                <div className="mb-1 hidden gap-1.5 text-xs text-muted sm:grid sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,6rem)_minmax(0,7rem)_2rem]">
                  <span>Name</span>
                  <span>Meaning</span>
                  <span>Paper value</span>
                  <span>Values to try</span>
                </div>
              )}
              <ul className="space-y-1.5">
                {form.knobs.map((row, index) => {
                  const update = (patch: Partial<ProtocolForm['knobs'][number]>) =>
                    onChange((f) => ({ ...f, knobs: f.knobs.map((r, i) => (i === index ? { ...r, ...patch } : r)) }))
                  return (
                    <li key={index} className="grid gap-1.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,6rem)_minmax(0,7rem)_2rem]">
                      <input aria-label={`Knob ${index + 1} name`} className={input(`knobs.${index}.name`, 'font-mono')} value={row.name} disabled={disabled} placeholder="draft_len" onChange={(e) => update({ name: e.target.value })} />
                      <input aria-label={`Knob ${index + 1} meaning`} className="input" value={row.meaning} disabled={disabled} placeholder="what it controls" onChange={(e) => update({ meaning: e.target.value })} />
                      <input aria-label={`Knob ${index + 1} paper value`} className="input" value={row.paper_value} disabled={disabled} placeholder="paper" onChange={(e) => update({ paper_value: e.target.value })} />
                      <input
                        aria-label={`Knob ${index + 1} values to try`}
                        className={input(`knobs.${index}.candidates`, 'font-mono')}
                        value={row.candidates}
                        disabled={disabled}
                        placeholder="4, 6, 8"
                        onChange={(e) => update({ candidates: e.target.value })}
                      />
                      <RemoveButton label={`Remove knob ${index + 1}`} disabled={disabled} onClick={() => onChange((f) => ({ ...f, knobs: f.knobs.filter((_, i) => i !== index) }))} />
                      {(errors[`knobs.${index}.name`] || errors[`knobs.${index}.candidates`]) && (
                        <p className="text-xs text-danger sm:col-span-5">{[errors[`knobs.${index}.name`], errors[`knobs.${index}.candidates`]].filter(Boolean).join(' ')}</p>
                      )}
                    </li>
                  )
                })}
              </ul>
              {errors.knobs && <p className="mt-1 text-xs text-danger">{errors.knobs}</p>}
              <Button
                size="sm"
                variant="invisible"
                className="mt-1"
                disabled={disabled || form.knobs.length >= MAX_KNOBS}
                onClick={() => onChange((f) => ({ ...f, knobs: [...f.knobs, { name: '', meaning: '', paper_value: '', candidates: '' }] }))}
              >
                + Add knob
              </Button>
            </Section>
          )}

          {has('fidelity') && (
            <Section title="Fidelity" changed={is('fidelity')} hint="How closely this setup follows the paper, and the known gaps.">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
                <Field label="Level" htmlFor="protocol-fidelity-level">
                  <select
                    id="protocol-fidelity-level"
                    className="input"
                    value={form.fidelity.level}
                    disabled={disabled}
                    onChange={(e) => onChange((f) => ({ ...f, fidelity: { ...f.fidelity, level: e.target.value as FidelityLevel } }))}
                  >
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </Field>
                <Field label="Gaps" htmlFor="protocol-fidelity-gaps" hint="One per line">
                  <textarea
                    id="protocol-fidelity-gaps"
                    className="input min-h-24"
                    value={form.fidelity.gaps}
                    disabled={disabled}
                    onChange={(e) => onChange((f) => ({ ...f, fidelity: { ...f.fidelity, gaps: e.target.value } }))}
                  />
                </Field>
              </div>
            </Section>
          )}

          {(has('tune') || has('lossless') || has('max_iterations')) && (
            <Section title="Run settings" changed={is('tune') || is('lossless') || is('max_iterations')}>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                {has('tune') && (
                  <Checkbox
                    id="protocol-tune"
                    checked={form.tune}
                    disabled={disabled}
                    onChange={(tune) => onChange((f) => ({ ...f, tune }))}
                    label="Tune the knobs first"
                    description="Short sweep; each arm keeps its best setting"
                  />
                )}
                {has('lossless') && (
                  <Checkbox
                    id="protocol-lossless"
                    checked={form.lossless}
                    disabled={disabled}
                    onChange={(lossless) => onChange((f) => ({ ...f, lossless }))}
                    label="Lossless"
                    description="Greedy outputs must match the baseline"
                  />
                )}
                {has('max_iterations') && (
                  <div>
                    <div className="text-sm" id="protocol-iterations-label">
                      Max iterations
                    </div>
                    <div className="mt-1 flex items-center gap-1" role="group" aria-labelledby="protocol-iterations-label">
                      <Button
                        size="sm"
                        aria-label="Fewer iterations"
                        disabled={disabled || form.max_iterations <= 1}
                        onClick={() => onChange((f) => ({ ...f, max_iterations: Math.max(1, f.max_iterations - 1) }))}
                        icon={<MinusIcon size={12} />}
                      />
                      <output className="w-8 text-center text-sm font-semibold tabular-nums" aria-live="polite">
                        {form.max_iterations}
                      </output>
                      <Button
                        size="sm"
                        aria-label="More iterations"
                        disabled={disabled || form.max_iterations >= MAX_ITERATIONS}
                        onClick={() => onChange((f) => ({ ...f, max_iterations: Math.min(MAX_ITERATIONS, f.max_iterations + 1) }))}
                      >
                        +
                      </Button>
                    </div>
                    <p className="mt-1 text-xs text-muted">1–{MAX_ITERATIONS} · diagnose, fix and re-run when fixable; the best iteration is kept</p>
                    {errors.max_iterations && <p className="text-xs text-danger">{errors.max_iterations}</p>}
                  </div>
                )}
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  )
}
