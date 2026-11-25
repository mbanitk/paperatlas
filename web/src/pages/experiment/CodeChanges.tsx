import { useMemo, useState, type ReactNode } from 'react'
import { useExperimentChanges } from '../../api/queries'
import type { CodeChangeFile, CodeEffect, CodeEffectCheck, Experiment, ExperimentChanges } from '../../api/types'
import { CodeToken, Delta } from '../../components/Badges'
import { ArrowRightIcon, ChevronRight, CodeIcon, SemanticIcon } from '../../components/Icons'
import { InfoPopover } from '../../components/Tooltip'
import { Button, Card, Checkbox, Chip, cx, ErrorState, Skeleton, TONE_CLASSES, TONE_TEXT } from '../../components/ui'
import {
  codeEffectOutcome,
  codeSegments,
  FILE_KIND_LABEL,
  FILE_STATUS_LABEL,
  formatChangeCounts,
  noteStyle,
  orderFiles,
  parsePatch,
  splitPath,
  triggeredInfo,
} from '../../lib/codeChanges'
import { formatNumber, formatSignificant, roundNumbersInText } from '../../lib/format'
import { semanticTone } from '../../lib/semantics'

const INITIAL_DIFF_LINES = 300

/** Text with `code` spans as code tokens; numbers rounded for reading (docs/ux-review.md X-5). */
function RichText({ text }: { text: string }) {
  return (
    <>
      {codeSegments(roundNumbersInText(text)).map((segment, index) =>
        segment.code ? (
          <code key={index} className="code-inline [overflow-wrap:anywhere]">
            {segment.text}
          </code>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  )
}

function OutcomeTag({ outcome }: { outcome: string }) {
  const info = codeEffectOutcome(outcome)
  const tone = semanticTone(info.tone)
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cx('chip', TONE_CLASSES[tone])}>
        <SemanticIcon name={info.icon} size={12} />
        {info.label}
      </span>
      <InfoPopover content={info.description} label={`What “${info.label}” means`} />
    </span>
  )
}

function counterLine(check: CodeEffectCheck): ReactNode {
  const info = triggeredInfo(check.triggered)
  if (check.triggered !== 'yes') return <span className={cx(check.triggered === 'no' && 'font-semibold text-caution-fg')}>{info.label}</span>
  const top = check.counters.filter((counter) => counter.total).slice(0, 2)
  if (!top.length) return info.label
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{info.label}:</span>
      {top.map((counter) => (
        <span key={counter.name} className="inline-flex flex-wrap items-center gap-1">
          <span className="font-semibold text-fg tabular-nums">
            {formatSignificant(counter.per_request ?? counter.per_1k_tokens, 3)}
          </span>
          <CodeToken className="text-xs">{counter.name}</CodeToken>
          <span>{counter.per_request !== null ? 'per request' : 'per 1,000 tokens'}</span>
        </span>
      ))}
    </span>
  )
}

/** The measured answers next to whether the new code ran, one row per check. */
function CheckRows({ effect }: { effect: CodeEffect }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-md border border-line-muted bg-canvas-subtle px-3 py-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
      {effect.checks.map((check) => (
        <div key={check.check} className="contents">
          <dt className="pt-0.5 text-xs font-medium text-muted sm:text-sm sm:font-normal">
            {check.label} <span className="sm:hidden">· {check.setting}</span>
          </dt>
          <dd className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Delta value={check.median_pct} significant={check.outcome === 'no_change' ? false : undefined} ci={[check.ci_low_pct, check.ci_high_pct]} showLabel />
              <span className="text-xs text-muted max-sm:hidden">on {check.setting}</span>
            </div>
            <div className="text-xs text-muted">{counterLine(check)}</div>
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Notes({ effect }: { effect: CodeEffect }) {
  if (!effect.notes?.length) return null
  return (
    <ul className="space-y-1.5" aria-label="Notes on this result">
      {effect.notes.map((note) => {
        const style = noteStyle(typeof note === 'string' ? null : note.kind)
        const tone = semanticTone(style.tone)
        const text = typeof note === 'string' ? note : note.text
        return (
          <li key={text} className={cx('flex gap-2 rounded-md border px-2.5 py-1.5 text-sm', TONE_CLASSES[tone], 'text-fg')}>
            <SemanticIcon name={style.icon} size={14} className={cx('mt-0.5 shrink-0', TONE_TEXT[tone])} />
            <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** "Why this result": the code change → what the counters show → the measured gain, loss or no change. */
function WhyThisResult({ effect }: { effect: CodeEffect }) {
  return (
    <section aria-labelledby="why-this-result" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="why-this-result" className="text-sm font-semibold text-fg">
          Why this result
        </h3>
        <OutcomeTag outcome={effect.outcome} />
      </div>
      <p className="max-w-3xl text-body-lg text-fg [overflow-wrap:anywhere]">
        <RichText text={effect.headline} />
      </p>
      <CheckRows effect={effect} />
      <Notes effect={effect} />
      {effect.links?.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold text-muted">How the change led to this result</h4>
          <ol className="space-y-2.5">
            {effect.links.map((link, index) => (
              <li key={index} className="flex gap-2.5 text-sm">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-line bg-canvas text-xs font-semibold text-muted tabular-nums"
                >
                  {index + 1}
                </span>
                <div className="min-w-0 space-y-1">
                  <p className="text-fg [overflow-wrap:anywhere]">
                    <RichText text={link.code} />
                    {link.files.length > 0 && (
                      <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
                        {link.files.map((file) => (
                          <CodeToken key={file} className="text-xs text-muted">
                            {splitPath(file).name}
                          </CodeToken>
                        ))}
                      </span>
                    )}
                  </p>
                  <p className="flex gap-1.5 text-fg">
                    <ArrowRightIcon size={14} className="mt-0.5 shrink-0 text-muted" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span className="sr-text">Effect: </span>
                      <RichText text={link.effect} />
                    </span>
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {effect.why && (
        <p className="max-w-3xl text-sm text-fg [overflow-wrap:anywhere]">
          <span className="font-semibold">Why: </span>
          <RichText text={effect.why} />
        </p>
      )}
      <p className="text-xs text-muted">
        {effect.source === 'llm' ? `Explained by ${effect.model ?? 'an LLM'} from the diff and the counters` : 'Rule-based explanation from the counters and the numbers'}
        {effect.iteration != null && <> · iteration {effect.iteration}’s code</>}.
      </p>
    </section>
  )
}

function DiffView({ file, wrap }: { file: CodeChangeFile; wrap: boolean }) {
  const lines = useMemo(() => parsePatch(file.patch), [file.patch])
  const [limit, setLimit] = useState(INITIAL_DIFF_LINES)
  if (file.binary) return <p className="text-sm text-muted">Binary file: no text diff.</p>
  if (file.omitted) return <p className="text-sm text-muted">Not shown: this change is too large to load in the browser. The full diff is saved with the experiment’s artifacts.</p>
  if (!lines.length) return <p className="text-sm text-muted">No text changes (renamed or mode change only).</p>
  const shown = lines.slice(0, limit)
  const text = wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'
  // Old line numbers are hidden below 640 px so the code keeps the width.
  const columns = 'grid grid-cols-[2.25rem_1rem_minmax(0,1fr)] sm:grid-cols-[2.5rem_2.5rem_1.25rem_minmax(0,1fr)]'
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-line-muted" tabIndex={0} role="region" aria-label={`Diff of ${file.path}`}>
        <div className={cx('font-mono text-xs leading-5', wrap ? 'w-full' : 'w-max min-w-full')}>
          {shown.map((line, index) => {
            if (line.kind === 'hunk' || line.kind === 'note')
              return (
                <div key={index} className={cx('px-2 py-0.5 text-muted', text, line.kind === 'hunk' ? 'bg-info-subtle/60' : 'bg-canvas-subtle')}>
                  {line.text}
                </div>
              )
            const added = line.kind === 'add'
            const removed = line.kind === 'del'
            return (
              <div key={index} className={cx(columns, added && 'bg-positive-subtle/70', removed && 'bg-negative-subtle/70')}>
                <span className="px-1 text-right text-muted tabular-nums select-none max-sm:hidden">{line.oldNo ?? ''}</span>
                <span className="px-1 text-right text-muted tabular-nums select-none">{line.newNo ?? <span className="sm:hidden">{line.oldNo ?? ''}</span>}</span>
                <span className={cx('text-center select-none', added ? 'text-positive-fg' : removed ? 'text-negative-fg' : 'text-muted')}>
                  {added ? '+' : removed ? '−' : ''}
                  <span className="sr-text">{added ? 'added' : removed ? 'removed' : ''}</span>
                </span>
                <span className={cx('min-w-0 pr-3 text-fg', text)}>{line.text || ' '}</span>
              </div>
            )
          })}
        </div>
      </div>
      {lines.length > limit && (
        <Button size="sm" onClick={() => setLimit(lines.length)}>
          Show {(lines.length - limit).toLocaleString('en-US')} more lines
        </Button>
      )}
      {file.patch_truncated && (
        <p className="text-xs text-muted">
          Showing the first part of this file’s diff ({formatNumber(file.patch_lines ?? null, 4)} lines in total); the full diff is saved with the experiment’s artifacts.
        </p>
      )}
    </div>
  )
}

function FileRow({ file, experimentId, iteration, version, wrap }: { file: CodeChangeFile; experimentId: number; iteration?: number; version: string; wrap: boolean }) {
  const [open, setOpen] = useState(false)
  const full = useExperimentChanges(experimentId, { iteration, patch: true, enabled: open, version })
  const withPatch = full.data?.files.find((candidate) => candidate.path === file.path)
  const { folder, name } = splitPath(file.path)
  return (
    <li className="rounded-md border border-line-muted">
      <details onToggle={(event) => setOpen(event.currentTarget.open)} className="group">
        <summary className="flex min-h-10 cursor-pointer list-none items-start gap-2 px-3 py-2 hover:bg-canvas-subtle [&::-webkit-details-marker]:hidden">
          <ChevronRight size={14} className="mt-1 shrink-0 text-muted transition-transform group-open:rotate-90" />
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 basis-full font-mono text-xs break-words sm:flex-1 sm:basis-0">
              <span className="text-muted">
                {folder.split('/').filter(Boolean).map((part) => (
                  <span key={part}>
                    {part}/<wbr />
                  </span>
                ))}
              </span>
              <span className="font-semibold text-fg">{name}</span>
              {file.old_path && file.old_path !== file.path && <span className="block text-muted">from {file.old_path}</span>}
            </span>
            <Chip tone="neutral">{FILE_STATUS_LABEL[file.status] ?? file.status}</Chip>
            {file.kind !== 'source' && <span className="tag">{FILE_KIND_LABEL[file.kind] ?? file.kind}</span>}
            <span className="font-mono text-xs whitespace-nowrap tabular-nums">
              {file.additions == null ? (
                <span className="text-muted">binary</span>
              ) : (
                <>
                  <span className={file.additions ? 'text-positive-fg' : 'text-muted'}>+{file.additions.toLocaleString('en-US')}</span>{' '}
                  <span className={file.deletions ? 'text-negative-fg' : 'text-muted'}>−{(file.deletions ?? 0).toLocaleString('en-US')}</span>
                </>
              )}
            </span>
          </span>
        </summary>
        {open && (
          <div className="border-t border-line-muted p-2 sm:p-3">
            {full.isLoading ? (
              <Skeleton lines={4} />
            ) : full.isError ? (
              <ErrorState error={full.error} onRetry={() => full.refetch()} title="Couldn’t load the diff" />
            ) : withPatch ? (
              <DiffView file={withPatch} wrap={wrap} />
            ) : (
              <p className="text-sm text-muted">This file’s diff isn’t available.</p>
            )}
          </div>
        )}
      </details>
    </li>
  )
}

function IterationPicker({ changes, value, onChange }: { changes: ExperimentChanges; value?: number; onChange: (iteration?: number) => void }) {
  if (changes.iterations.length < 2) return null
  const kept = changes.kept_iteration
  const current = value ?? changes.iteration ?? undefined
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      Iteration
      <select
        className="input min-h-7 w-auto py-0.5 pr-7 text-xs"
        value={current ?? ''}
        onChange={(event) => {
          const next = Number(event.target.value)
          onChange(next === kept ? undefined : next)
        }}
      >
        {changes.iterations.map((entry) => (
          <option key={entry.iteration} value={entry.iteration}>
            {entry.iteration}
            {entry.iteration === kept ? ' · kept (measured)' : kept != null && entry.iteration > kept ? ' · reverted' : ''}
            {entry.additions != null && ` · ${formatChangeCounts(entry.additions, entry.deletions)}`}
          </option>
        ))}
      </select>
    </label>
  )
}

/** What the experiment changed in the project: the files with +/− and each file's diff on demand. */
function WhatChanged({ experiment, effect }: { experiment: Experiment; effect: CodeEffect | null }) {
  const [iteration, setIteration] = useState<number | undefined>()
  const [wrap, setWrap] = useState(true)
  const building = experiment.status === 'building'
  const version = `${experiment.status}:${experiment.build?.code_changes?.head ?? ''}:${experiment.build?.iteration ?? ''}`
  const changes = useExperimentChanges(experiment.id, { iteration, patch: false, version, live: building })
  const data = changes.data
  const files = useMemo(() => orderFiles(data?.files ?? []), [data?.files])

  let body: ReactNode
  if (changes.isLoading) body = <Skeleton variant="row" count={3} />
  else if (changes.isError) body = <ErrorState error={changes.error} onRetry={() => changes.refetch()} title="Couldn’t load the code changes" />
  else if (!data?.available) body = <p className="text-sm text-muted">{data?.reason ?? 'No code changes are available for this experiment.'}</p>
  else if (!files.length) body = <p className="text-sm text-muted">The build made no changes to tracked files.</p>
  else {
    const kept = data.kept_iteration
    const summary = effect && effect.iteration === data.iteration && effect.head === data.head && effect.change_summary ? effect.change_summary : data.summary
    body = (
      <div className="space-y-3">
        {summary && (
          <p className="max-w-3xl text-sm text-fg [overflow-wrap:anywhere]">
            <RichText text={summary} />
          </p>
        )}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>
            <span className="font-semibold text-fg">{(data.files_changed ?? files.length).toLocaleString('en-US')}</span> file{(data.files_changed ?? files.length) === 1 ? '' : 's'} ·{' '}
            <span className="font-mono">{formatChangeCounts(data.additions, data.deletions)}</span>
          </span>
          {data.base && data.head && (
            <span>
              <CodeToken className="text-xs">{data.base.slice(0, 7)}</CodeToken> → <CodeToken className="text-xs">{data.head.slice(0, 7)}</CodeToken>
            </span>
          )}
        </p>
        {data.live && (
          <p className="text-xs text-info-fg">
            {building ? 'The coding agent is still working: this is the branch as it is now.' : 'Read from the experiment’s branch: no saved copy yet.'}
          </p>
        )}
        {!data.live && kept != null && data.iteration != null && data.iteration !== kept && (
          <p className="text-xs text-caution-fg">
            You’re viewing iteration {data.iteration}’s code. {data.iteration > kept ? 'It was reverted' : 'It was replaced'}; the result above was measured on iteration {kept}.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">Open a file to see its diff.</p>
          <Checkbox id={`wrap-diff-${experiment.id}`} checked={wrap} onChange={setWrap} label={<span className="text-xs">Wrap long lines</span>} />
        </div>
        <ul className="space-y-1.5">
          {files.map((file) => (
            <FileRow key={file.path} file={file} experimentId={experiment.id} iteration={iteration} version={version} wrap={wrap} />
          ))}
        </ul>
        {data.patch_truncated && <p className="text-xs text-muted">This diff is very large; only its first part was saved.</p>}
      </div>
    )
  }

  return (
    <section aria-labelledby="what-changed" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="what-changed" className="text-sm font-semibold text-fg">
          What changed
          {data?.available && data.iteration != null && (data.iterations.length > 1 || data.kept_iteration != null) && (
            <span className="font-normal text-muted"> · iteration {data.iteration}</span>
          )}
        </h3>
        {data?.available && <IterationPicker changes={data} value={iteration} onChange={setIteration} />}
      </div>
      {body}
    </section>
  )
}

/**
 * Code changes and their effect: why the result came out as a gain, a loss or no change (from the diff and the
 * counters), then the files the experiment changed with each diff on demand.
 */
export function CodeChangesCard({ experiment }: { experiment: Experiment }) {
  const effect = experiment.verdict_detail?.details?.code_effect ?? null
  return (
    <Card
      id="code-changes"
      title={
        <span className="flex items-center gap-2">
          <CodeIcon size={16} className="text-muted" /> Code changes{effect ? ' and their effect' : ''}
        </span>
      }
    >
      <div className="space-y-5">
        {effect && <WhyThisResult effect={effect} />}
        <div className={cx(effect && 'border-t border-line-muted pt-4')}>
          <WhatChanged experiment={experiment} effect={effect} />
        </div>
      </div>
    </Card>
  )
}

/** Whether the page has code to show: something was built, saved or explained. */
export function hasCodeChanges(experiment: Experiment): boolean {
  return !!(experiment.branch || experiment.build?.code_changes || experiment.verdict_detail?.details?.code_effect)
}
