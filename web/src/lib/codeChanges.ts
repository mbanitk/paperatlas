/**
 * Unified-diff parsing and the words for an experiment's code changes (GET /lab/experiments/:id/changes) and for
 * "why this result" (verdict details `code_effect`).
 */

import type { CodeChangeFile, CodeEffectOutcome, Triggered } from '../api/types'
import type { SemanticIconName, SemanticTone } from './semantics'

export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk' | 'note'

export interface DiffLine {
  kind: DiffLineKind
  /** the line without its +/-/space marker (hunk headers keep their text) */
  text: string
  oldNo: number | null
  newNo: number | null
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/
// File header lines git writes before the first hunk; the page shows the path and status instead.
const HEADER = /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to)/

/** One file's unified diff → display lines with old/new line numbers. */
export function parsePatch(patch: string | null | undefined): DiffLine[] {
  if (!patch) return []
  const lines: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const raw of patch.replace(/\n$/, '').split('\n')) {
    const hunk = HUNK.exec(raw)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      inHunk = true
      lines.push({ kind: 'hunk', text: raw, oldNo: null, newNo: null })
      continue
    }
    if (!inHunk) {
      if (raw.startsWith('Binary files')) lines.push({ kind: 'note', text: 'Binary file: no text diff.', oldNo: null, newNo: null })
      else if (!HEADER.test(raw) && raw.trim()) lines.push({ kind: 'note', text: raw, oldNo: null, newNo: null })
      continue
    }
    if (raw.startsWith('\\')) {
      lines.push({ kind: 'note', text: raw.replace(/^\\\s*/, ''), oldNo: null, newNo: null })
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ })
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null })
    } else if (raw.startsWith('diff --git ')) {
      inHunk = false
    } else {
      lines.push({ kind: 'context', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return lines
}

export const FILE_STATUS_LABEL: Record<string, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  type_changed: 'Type changed',
}

export const FILE_KIND_LABEL: Record<string, string> = { source: 'Code', test: 'Test', docs: 'Docs', config: 'Config', other: 'Other' }

const KIND_ORDER: Record<string, number> = { source: 0, config: 1, other: 2, test: 3, docs: 4 }

/** Engine code first (largest change first), then config, tests and docs. */
export function orderFiles<T extends Pick<CodeChangeFile, 'kind' | 'additions' | 'deletions' | 'path'>>(files: T[]): T[] {
  const size = (file: T) => (file.additions ?? 0) + (file.deletions ?? 0)
  return [...files].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || size(b) - size(a) || a.path.localeCompare(b.path))
}

/** Split a path into its folder (with trailing slash) and file name, for a readable two-tone path. */
export function splitPath(path: string): { folder: string; name: string } {
  const index = path.lastIndexOf('/')
  return index < 0 ? { folder: '', name: path } : { folder: path.slice(0, index + 1), name: path.slice(index + 1) }
}

export interface OutcomeSemantics {
  label: string
  tone: SemanticTone
  icon: SemanticIconName
  description: string
}

/** Outcome of the change as measured (the user's words: a gain, a loss, or no gain and no loss). */
export const CODE_EFFECT_OUTCOME: Record<CodeEffectOutcome, OutcomeSemantics> = {
  gain: { label: 'Gain', tone: 'positive', icon: 'arrow-up', description: 'The change made the metric measurably better (the 95% CI is above 0).' },
  loss: { label: 'Loss', tone: 'negative', icon: 'arrow-down', description: 'The change made the metric measurably worse (the 95% CI is below 0).' },
  no_change: {
    label: 'No gain, no loss',
    tone: 'neutral',
    icon: 'equals',
    description: 'The difference is within run-to-run noise: the 95% CI includes 0.',
  },
  mixed: { label: 'Mixed', tone: 'caution', icon: 'half', description: 'A gain in one check and not in the other (see each check).' },
  unknown: { label: 'Not measured', tone: 'neutral', icon: 'question', description: 'There was no reliable measurement to explain.' },
}

export function codeEffectOutcome(outcome: string | null | undefined): OutcomeSemantics {
  return CODE_EFFECT_OUTCOME[(outcome ?? 'unknown') as CodeEffectOutcome] ?? CODE_EFFECT_OUTCOME.unknown
}

export const TRIGGERED: Record<Triggered, { label: string; tone: SemanticTone; description: string }> = {
  yes: { label: 'The new code ran', tone: 'neutral', description: 'The technique’s counters were above 0 during the measured requests.' },
  no: { label: 'Never triggered', tone: 'caution', description: 'Every counter the technique reports stayed at 0: the new code path didn’t run.' },
  unknown: { label: 'No counters', tone: 'neutral', description: 'The technique reported no counters, so the numbers can’t show whether the new code ran.' },
}

export function triggeredInfo(value: string | null | undefined) {
  return TRIGGERED[(value ?? 'unknown') as Triggered] ?? TRIGGERED.unknown
}

/** "+1,050 −3" (no zero parts; "binary" for binary files). */
export function formatChangeCounts(additions: number | null | undefined, deletions: number | null | undefined): string {
  if (additions == null && deletions == null) return 'binary'
  const parts = []
  if (additions) parts.push(`+${additions.toLocaleString('en-US')}`)
  if (deletions) parts.push(`−${deletions.toLocaleString('en-US')}`)
  return parts.join(' ') || '±0'
}

/** Render `backticks` in explanation text as code tokens: split into plain and code segments. */
export function codeSegments(text: string): { code: boolean; text: string }[] {
  const segments: { code: boolean; text: string }[] = []
  const pattern = /`([^`]+)`/g
  let last = 0
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) segments.push({ code: false, text: text.slice(last, match.index) })
    segments.push({ code: true, text: match[1] })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ code: false, text: text.slice(last) })
  return segments
}

/** How each always-shown note looks: never-triggered and no-engine-code need attention, quality is harm. */
export const NOTE_STYLE: Record<string, { tone: SemanticTone; icon: SemanticIconName; label: string }> = {
  never_triggered: { tone: 'caution', icon: 'alert', label: 'Never triggered' },
  no_engine_code: { tone: 'caution', icon: 'alert', label: 'No engine code' },
  quality: { tone: 'negative', icon: 'x', label: 'Quality' },
  within_noise: { tone: 'neutral', icon: 'equals', label: 'Within noise' },
  no_counters: { tone: 'neutral', icon: 'question', label: 'No counters' },
  no_diff: { tone: 'neutral', icon: 'minus', label: 'No diff' },
}

export function noteStyle(kind: string | null | undefined) {
  return NOTE_STYLE[kind ?? ''] ?? { tone: 'neutral' as SemanticTone, icon: 'alert' as SemanticIconName, label: 'Note' }
}
