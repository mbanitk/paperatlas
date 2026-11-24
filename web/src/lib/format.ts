/** Pure formatting helpers (unit-tested in format.test.ts). */

export function humanize(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/_/g, ' ')
}

export function titleCase(value: string | null | undefined): string {
  const text = humanize(value)
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** `+12.3%` / `−4.0%`; `—` for missing values. */
export function formatPct(value: number | null | undefined, digits = 1, signed = true): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const rounded = Number(value.toFixed(digits))
  const magnitude = Math.abs(rounded).toFixed(digits)
  if (!signed) return `${rounded < 0 ? '−' : ''}${magnitude}%`
  if (rounded === 0) return `${(0).toFixed(digits)}%`
  return `${rounded > 0 ? '+' : '−'}${magnitude}%`
}

export function formatCI(low: number | null | undefined, high: number | null | undefined, digits = 1): string {
  if (low === null || low === undefined || high === null || high === undefined) return '—'
  return `${formatPct(low, digits)} … ${formatPct(high, digits)}`
}

/** Compact number for metric values: 2,329 · 49.2 · 0.84 */
export function formatNumber(value: number | null | undefined, maxDigits?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const digits = maxDigits ?? (abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3)
  return value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toFixed(value >= 1 ? 2 : 3)
}

/** Seconds → `45s`, `8m 32s`, `2h 05m`. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function durationBetween(start: string | null | undefined, end: string | null | undefined, now = Date.now()): number | null {
  if (!start) return null
  const from = Date.parse(start)
  const to = end ? Date.parse(end) : now
  if (Number.isNaN(from) || Number.isNaN(to)) return null
  return Math.max(0, (to - from) / 1000)
}

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago`, then a short date. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return '—'
  const seconds = Math.round((now - time) / 1000)
  const future = seconds < 0
  const abs = Math.abs(seconds)
  let text: string
  if (abs < 45) return 'just now'
  if (abs < 3600) text = `${Math.round(abs / 60)} min`
  else if (abs < 86_400) text = `${Math.round(abs / 3600)} h`
  else if (abs < 14 * 86_400) text = `${Math.round(abs / 86_400)} d`
  else return formatDate(iso)
  return future ? `in ${text}` : `${text} ago`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso)
  return new Date(time).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(dateOnly ? { timeZone: 'UTC' } : {}),
  })
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** Last `maxLines` lines of a (log) text. */
export function tailLines(text: string, maxLines: number): string {
  const lines = text.replace(/\n$/, '').split('\n')
  return lines.length > maxLines ? lines.slice(lines.length - maxLines).join('\n') : lines.join('\n')
}

/** Any API value as short text: objects show their `name`/`id`/`version` (or compact JSON), never "[object Object]". */
export function displayValue(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'number') return Number.isFinite(value) ? formatNumber(value) : fallback
  if (typeof value === 'string' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((item) => displayValue(item, '')).filter(Boolean).join(', ') || fallback
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['name', 'id', 'alias', 'version']) if (typeof record[key] === 'string' && record[key]) return record[key] as string
    return JSON.stringify(value)
  }
  return String(value)
}

/** Bench-contract workload ({name, requests_per_round, max_new_tokens, concurrency}) or a plain name. */
export function formatWorkload(workload: unknown, fallback = '—'): string {
  if (!workload || typeof workload !== 'object' || Array.isArray(workload)) return displayValue(workload, fallback)
  const w = workload as Record<string, unknown>
  const num = (key: string) => (typeof w[key] === 'number' && Number.isFinite(w[key]) ? (w[key] as number) : null)
  const requests = num('requests_per_round')
  const tokens = num('max_new_tokens')
  const concurrency = num('concurrency')
  const parts = [
    displayValue(w.name ?? w.id, 'workload'),
    requests !== null ? `${requests} req/round` : null,
    tokens !== null ? `${tokens} tokens` : null,
    concurrency !== null && concurrency > 1 ? `concurrency ${concurrency}` : null,
  ]
  return parts.filter(Boolean).join(' · ')
}
