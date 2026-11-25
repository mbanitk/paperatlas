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

/** 95% CI as a plain range: `−0.4 to +1.2%`; `—` when either end is missing. */
export function formatCI(low: number | null | undefined, high: number | null | undefined, digits = 1): string {
  if (!isNum(low) || !isNum(high)) return '—'
  return formatRange(low, high, { digits })
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

// ---- plain-language helpers (docs/ux-review.md §3.2, Appendix B) ---------------------------------------

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Plain words for values that are missing, instead of a bare "—". */
export const MISSING = {
  value: 'Not reported',
  claim: 'Paper gives no number',
  estimate: 'Not estimated',
  measured: 'Not measured yet',
} as const

/** True for null/undefined/NaN/empty strings and the placeholder dashes the API sometimes sends. */
export function isMissing(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'number') return !Number.isFinite(value)
  if (typeof value === 'string') return !value.trim() || /^[—–-]+$/.test(value.trim())
  return false
}

/** The value, or a plain phrase ("Not reported") when it's missing. */
export function orMissing<T>(value: T | null | undefined, fallback: string = MISSING.value): T | string {
  return isMissing(value) ? fallback : (value as T)
}

function trimNumber(value: number, digits: number): string {
  return Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

/** Auto precision for signed values: one decimal below 10 (if not whole), none above. */
function autoDigits(value: number): number {
  return Math.abs(value) < 10 && !Number.isInteger(value) ? 1 : 0
}

/**
 * Signed number with its unit: `+2.8%`, `−63.1%`, `+41%`, `0%`. Always shows the sign (U+2212 for minus);
 * `digits` (default 1) is a maximum, so trailing zeros are dropped.
 */
export function formatSigned(value: number | null | undefined, options: { digits?: number; unit?: string; fallback?: string } = {}): string {
  const { unit = '%', fallback = '—' } = options
  if (!isNum(value)) return fallback
  const digits = options.digits ?? 1
  const rounded = Number(value.toFixed(digits))
  if (rounded === 0) return `0${unit}`
  return `${rounded > 0 ? '+' : '−'}${trimNumber(rounded, digits)}${unit}`
}

/**
 * A range in words: `0 to +10%`, `+5 to +30%`, `12 to 30 ms`; `+5%` when both ends round the same.
 * Ends are swapped when given in the wrong order. Missing ends give `fallback` ("Not estimated").
 */
export function formatRange(
  low: number | null | undefined,
  high: number | null | undefined,
  options: { unit?: string; digits?: number; signed?: boolean; fallback?: string } = {},
): string {
  const { unit = '%', signed = true, fallback = MISSING.estimate } = options
  if (!isNum(low) && !isNum(high)) return fallback
  if (!isNum(low) || !isNum(high)) {
    const only = (isNum(low) ? low : high) as number
    return signed ? formatSigned(only, { digits: options.digits, unit }) : `${trimNumber(only, options.digits ?? autoDigits(only))}${unit}`
  }
  const [a, b] = low <= high ? [low, high] : [high, low]
  const one = (value: number) => {
    const digits = options.digits ?? autoDigits(value)
    if (signed) return formatSigned(value, { digits, unit: '' })
    const rounded = Number(value.toFixed(digits))
    return `${rounded < 0 ? '−' : ''}${trimNumber(rounded, digits)}`
  }
  const from = one(a)
  const to = one(b)
  return from === to ? `${from}${unit}` : `${from} to ${to}${unit}`
}

/** "Paper reports +41%" / "Paper gives no number". */
export function formatClaimed(value: number | null | undefined, options: { unit?: string; digits?: number } = {}): string {
  if (!isNum(value)) return MISSING.claim
  return `Paper reports ${formatSigned(value, { unit: options.unit ?? '%', digits: options.digits })}`
}

/**
 * Number for prose: at most `significant` significant digits below 1,000 (84.9061 → 84.9, 0.0012345 →
 * 0.00123) and whole numbers with separators above (12,346).
 */
export function formatSignificant(value: number | null | undefined, significant = 3): string {
  if (!isNum(value)) return '—'
  if (Math.abs(value) >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
  return value.toLocaleString('en-US', { maximumSignificantDigits: significant })
}

/** Rounds long decimals inside free text ("84.9061 tokens/s" → "84.9 tokens/s"); leaves versions like 2.9.1 alone. */
export function roundNumbersInText(text: string | null | undefined, significant = 3): string {
  if (!text) return ''
  return text.replace(/(?<![\w.])(-?\d+\.\d{3,})(?![\d.])/g, (match) => formatSignificant(Number(match), significant))
}

// ---- metric names ------------------------------------------------------------------------------------

const METRIC_LABELS: Record<string, string> = {
  decode_tokens_per_s: 'Decode speed (tokens/s)',
  throughput_tokens_per_s: 'Throughput (tokens/s)',
  prefill_tokens_per_s: 'Prefill speed (tokens/s)',
  tokens_per_s: 'Speed (tokens/s)',
  ttft_ms: 'Time to first token (ms)',
  itl_ms: 'Inter-token latency (ms)',
  tpot_ms: 'Time per output token (ms)',
  e2e_latency_ms: 'End-to-end latency (ms)',
  latency_ms: 'Latency (ms)',
  peak_memory_gb: 'Peak memory (GB)',
  memory_gb: 'Memory (GB)',
  acceptance_rate: 'Acceptance rate',
  accept_rate: 'Acceptance rate',
  perplexity: 'Perplexity',
}

const UNIT_WORDS: Record<string, string> = {
  ms: 'ms',
  us: 'µs',
  s: 's',
  sec: 's',
  seconds: 's',
  gb: 'GB',
  mb: 'MB',
  kb: 'KB',
  gbs: 'GB/s',
  pct: '%',
  percent: '%',
  x: '×',
  tokens: 'tokens',
  tok: 'tokens',
  bytes: 'bytes',
  w: 'W',
}

const WORD_LABELS: Record<string, string> = { e2e: 'end-to-end', p50: 'p50', p90: 'p90', p95: 'p95', p99: 'p99', tok: 'token' }

/**
 * Plain label for a metric id: `throughput_tokens_per_s` → "Throughput (tokens/s)", `p50_latency_ms` →
 * "P50 latency (ms)". Already-plain names are returned in sentence case. Show the raw id next to it (as a
 * CodeToken) in expert layers.
 */
export function humanizeMetric(metric: string | null | undefined): string {
  if (!metric) return ''
  const key = metric.trim()
  if (METRIC_LABELS[key]) return METRIC_LABELS[key]
  if (!/[_]/.test(key)) return sentence(formatAcronyms(key))
  const words = key.toLowerCase().split(/[_\s]+/).filter(Boolean)
  let unit = ''
  const per = words.lastIndexOf('per')
  if (per > 0 && per === words.length - 2) {
    const top = words[per - 1]
    const bottom = words[per + 1]
    unit = `${UNIT_WORDS[top] ?? top}/${UNIT_WORDS[bottom] ?? bottom}`
    words.splice(per - 1, 3)
  } else if (words.length > 1 && UNIT_WORDS[words[words.length - 1]]) {
    unit = UNIT_WORDS[words.pop() as string]
  }
  if (!words.length) return sentence(unit)
  const name = formatAcronyms(words.map((word) => WORD_LABELS[word] ?? word).join(' '))
  return unit ? `${sentence(name)} (${unit})` : sentence(name)
}

function sentence(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

// ---- acronyms ----------------------------------------------------------------------------------------

const ACRONYMS = [
  'KV', 'LLM', 'GPU', 'CPU', 'TPU', 'NPU', 'MLX', 'CUDA', 'RoPE', 'TTFT', 'ITL', 'TPOT', 'API', 'MoE', 'FFN', 'MLP', 'SSM', 'RAG',
  'LoRA', 'HF', 'ML', 'AI', 'NLP', 'SIMD', 'FP4', 'FP8', 'FP16', 'FP32', 'BF16', 'INT2', 'INT3', 'INT4', 'INT8', 'GEMM', 'GEMV', 'SRAM',
  'DRAM', 'HBM', 'VRAM', 'RAM', 'NVMe', 'SSD', 'JSON', 'YAML', 'SQL', 'URL', 'HTTP', 'IO', 'ANE', 'SDPA', 'QKV', 'PPL', 'BLEU', 'MMLU',
]
const ACRONYM_BY_LOWER = new Map(ACRONYMS.map((word) => [word.toLowerCase(), word]))
const PLURALISABLE = new Set(['llm', 'gpu', 'cpu', 'tpu', 'npu', 'api', 'ssm', 'ffn', 'mlp'])

/** Fixes acronym case in generated names: "kv cache for llms" → "KV cache for LLMs", "Kv" → "KV". */
export function formatAcronyms(text: string | null | undefined): string {
  if (!text) return ''
  return text.replace(/\b[A-Za-z][A-Za-z0-9]*\b/g, (word) => {
    const lower = word.toLowerCase()
    const direct = ACRONYM_BY_LOWER.get(lower)
    if (direct) return direct
    if (lower.endsWith('s') && PLURALISABLE.has(lower.slice(0, -1))) return `${ACRONYM_BY_LOWER.get(lower.slice(0, -1))}s`
    return word
  })
}

// ---- LaTeX and raw strings ------------------------------------------------------------------------------

const LATEX_SYMBOLS: Record<string, string> = {
  times: '×', cdot: '·', approx: '≈', sim: '~', le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠', pm: '±', to: '→',
  rightarrow: '→', leftarrow: '←', infty: '∞', sum: 'Σ', prod: 'Π', partial: '∂', nabla: '∇', alpha: 'α', beta: 'β', gamma: 'γ',
  delta: 'δ', Delta: 'Δ', epsilon: 'ε', varepsilon: 'ε', eta: 'η', theta: 'θ', kappa: 'κ', lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ',
  sigma: 'σ', Sigma: 'Σ', tau: 'τ', phi: 'φ', varphi: 'φ', omega: 'ω', Omega: 'Ω', ell: 'ℓ', log: 'log', ln: 'ln', exp: 'exp',
  max: 'max', min: 'min', ldots: '…', cdots: '⋯', dots: '…', '%': '%', '_': '_', '{': '{', '}': '}', '&': '&', '#': '#', ',': ' ',
  ';': ' ', ':': ' ', '!': '', ' ': ' ', quad: ' ', qquad: ' ', left: '', right: '', big: '', Big: '',
}

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻',
  '=': '⁼', '(': '⁽', ')': '⁾', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ',
  m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ', T: 'ᵀ', ' ': ' ',
}
const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '−': '₋',
  '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ',
  s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ', ' ': ' ',
}

export interface MathSegment {
  kind: 'text' | 'sup' | 'sub'
  text: string
}

/** Reads one `{…}` group (with nesting), a signed number (2^10, 10^-3) or a single character after `^`/`_`. */
function readGroup(text: string, start: number): [string, number] {
  if (text[start] !== '{') {
    const number = /^[+\-−]?\d+(?:\.\d+)?/.exec(text.slice(start))
    if (number) return [number[0], start + number[0].length]
    return [text[start] ?? '', start + 1]
  }
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return [text.slice(start + 1, i), i + 1]
  }
  return [text.slice(start + 1), text.length]
}

/** Replaces LaTeX commands with plain characters; keeps `^`/`_` for parseMath. */
function replaceCommands(input: string): string {
  let text = input.replace(/\$\$?|\\\(|\\\)|\\\[|\\\]/g, '')
  // \frac{a}{b} → a/b, \sqrt{x} → √x, \text{x}/\mathrm{x}/… → x
  for (let guard = 0; guard < 10 && /\\(frac|dfrac|tfrac|sqrt|text\w*|math\w+|operatorname|boldsymbol)\b/.test(text); guard++) {
    text = text.replace(/\\(?:d|t)?frac\s*(\{(?:[^{}]|\{[^{}]*\})*\}|\S)\s*(\{(?:[^{}]|\{[^{}]*\})*\}|\S)/g, (_, a: string, b: string) => {
      const strip = (group: string) => (group.startsWith('{') ? group.slice(1, -1) : group)
      const wrap = (part: string) => (/^[\w.]+$/.test(part) ? part : `(${part})`)
      return `${wrap(strip(a))}/${wrap(strip(b))}`
    })
    text = text.replace(/\\sqrt\s*(\{(?:[^{}]|\{[^{}]*\})*\}|\S)/g, (_, a: string) => `√${a.startsWith('{') ? (a.length > 3 ? `(${a.slice(1, -1)})` : a.slice(1, -1)) : a}`)
    text = text.replace(/\\(?:text\w*|math\w+|operatorname|boldsymbol)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1')
  }
  text = text.replace(/\\([A-Za-z]+|[%_{}&#,;:! ])/g, (match, name: string) => LATEX_SYMBOLS[name] ?? match.slice(1))
  return text.replace(/~/g, ' ')
}

/**
 * Splits text with LaTeX-style math into plain, superscript and subscript segments (for <MathText>):
 * "4^{-b} penalty" → [{text "4"}, {sup "-b"}, {text " penalty"}]. Commands like \times or \alpha become ×, α.
 */
export function parseMath(input: string | null | undefined): MathSegment[] {
  if (!input) return []
  const text = replaceCommands(input)
  const segments: MathSegment[] = []
  const push = (kind: MathSegment['kind'], value: string) => {
    if (!value) return
    const last = segments[segments.length - 1]
    if (last && last.kind === kind) last.text += value
    else segments.push({ kind, text: value })
  }
  let buffer = ''
  for (let i = 0; i < text.length; ) {
    const char = text[i]
    // `^`/`_` only count as math right after a word character or a closing bracket (not snake_case words).
    const prev = text[i - 1] ?? ''
    const next = text[i + 1] ?? ''
    const mathy = (char === '^' && /[\w)\]}]/.test(prev) && next !== '') || (char === '_' && /[\w)\]}]/.test(prev) && (next === '{' || /[0-9]/.test(next) || (/[a-z]/i.test(next) && !/[a-z]/i.test(text[i + 2] ?? ''))) && !/[a-z]{2,}$/i.test(text.slice(0, i)))
    if (mathy) {
      const [group, end] = readGroup(text, i + 1)
      push('text', buffer)
      buffer = ''
      push(char === '^' ? 'sup' : 'sub', group.replace(/-/g, '−'))
      i = end
      continue
    }
    buffer += char
    i++
  }
  push('text', buffer)
  return segments
}

/** Plain-text math: "4^{-b}" → "4⁻ᵇ"; falls back to "x^(…)" when a character has no Unicode superscript. */
export function formatMath(input: string | null | undefined): string {
  return parseMath(input)
    .map((segment) => {
      if (segment.kind === 'text') return segment.text
      const table = segment.kind === 'sup' ? SUPERSCRIPT : SUBSCRIPT
      const chars = Array.from(segment.text)
      if (chars.every((c) => table[c])) return chars.map((c) => table[c]).join('')
      return `${segment.kind === 'sup' ? '^' : '_'}(${segment.text})`
    })
    .join('')
}

/** True when text contains LaTeX-style markup worth rendering with MathText/formatMath. */
export const hasMath = (text: string | null | undefined): boolean => !!text && /\\[A-Za-z]+|[\w)}]\^|\$[^$]+\$|_\{/.test(text)

/**
 * Raw strings from logs/LLMs → readable text: strips ANSI colour codes and control characters, normalises
 * line breaks and spaces, writes ranges as "0 to +10%", turns LaTeX into plain characters and rounds long decimals.
 */
export function sanitizeText(input: string | null | undefined, options: { keepNewlines?: boolean } = {}): string {
  if (!input) return ''
  // eslint-disable-next-line no-control-regex
  let text = input.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  text = text.replace(/([+−-]?\d[\d.,]*)\s*(?:…|\.\.\.)\s*([+−-]?\d)/g, '$1 to $2')
  if (hasMath(text)) text = formatMath(text)
  text = roundNumbersInText(text)
  text = options.keepNewlines ? text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : text.replace(/\s+/g, ' ')
  return text.trim()
}
