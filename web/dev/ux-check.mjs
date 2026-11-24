#!/usr/bin/env node
/**
 * UX check: overlaps, clipping, horizontal scroll, tooltips, tiny text and small targets across routes and
 * viewports (docs/ux-review.md Appendix A). GET-only: every non-GET request is aborted at the network layer,
 * so it is safe against the live console.
 *
 *   npm run ux:check -- --base http://127.0.0.1:5180
 *   npm run ux:check -- --base http://127.0.0.1:5180 --routes /,/experiments,/__ux --vps 390,1440
 *   npm run ux:check -- --routes /experiments/6 --save-baseline dev/ux-baseline.json
 *   npm run ux:check -- --baseline dev/ux-baseline.json        # fail only on regressions
 *
 * Options
 *   --base <url>           app URL (default $UX_BASE or http://127.0.0.1:5173)
 *   --routes <a,b,…>       paths to check (default: every console route + /__ux)
 *   --vps <w,…>            viewport widths (default 1440,1280,1024,768,390)
 *   --out <dir>            screenshots + JSON (default dev/screenshots/ux-check)
 *   --no-shots             skip full-page screenshots
 *   --no-tooltips          skip the hover/focus/tap tooltip probes
 *   --max-triggers <n>     tooltip triggers probed per page (default 6)
 *   --baseline <file>      compare failure counts per route@width; fail only when a count goes up
 *   --save-baseline <file> write the current failure counts as a baseline
 *   --lint-strict <f,…>    source files where `text-[<12px]` is a failure (default: the WS0 files)
 *   --quiet                print only the summary
 *
 * Failures (exit 1): document horizontal scroll, elements past the viewport, text-on-text overlaps, sibling
 * box overlaps, SVG text overlaps / outside its svg / rendered < 11px, tooltip outside the viewport, under
 * the header or covered, truncated numbers, a toast over the action bar, nav destinations unreachable, and
 * tiny text classes in --lint-strict files.
 * Warnings: text < 12px, targets < 24px, clipped/truncated text, native `title` tooltips, focus without a
 * visible ring, tiny text classes in other files.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- args ------------------------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}

const DEFAULT_ROUTES = [
  '/',
  '/recommendations',
  '/experiments',
  '/experiments/1',
  '/experiments/2',
  '/experiments/3',
  '/experiments/4',
  '/experiments/5',
  '/experiments/6',
  '/experiments/7',
  '/experiments/8',
  '/experiments/9',
  '/research/topics',
  '/research/topics/decoding',
  '/research/papers',
  '/research/papers/arxiv:2606.24033',
  '/research/papers/arxiv:2611.27561',
  '/research/claims',
  '/research/claims/168',
  '/research/claims/544',
  '/projects',
  '/system',
  '/does-not-exist',
  '/__ux',
  '/__ux?toast=1',
]

const BASE = (opt('base', process.env.UX_BASE || 'http://127.0.0.1:5173') || '').replace(/\/$/, '')
const ROUTES = (opt('routes', '') || '').split(',').filter(Boolean)
const routes = ROUTES.length ? ROUTES : DEFAULT_ROUTES
const VPS = (opt('vps', '1440,1280,1024,768,390') || '').split(',').map(Number).filter(Boolean)
const OUT = path.resolve(ROOT, opt('out', 'dev/screenshots/ux-check'))
const SHOTS = !flag('no-shots')
const TOOLTIPS = !flag('no-tooltips')
const MAX_TRIGGERS = Number(opt('max-triggers', '6'))
const BASELINE = opt('baseline', '')
const SAVE_BASELINE = opt('save-baseline', '')
const QUIET = flag('quiet')
const WS0_FILES = [
  'src/index.css',
  'src/main.tsx',
  'src/App.tsx',
  'src/components/ui.tsx',
  'src/components/Badges.tsx',
  'src/components/Icons.tsx',
  'src/components/Dialog.tsx',
  'src/components/Toast.tsx',
  'src/components/Layout.tsx',
  'src/components/Tooltip.tsx',
  'src/components/ActionBar.tsx',
  'src/components/Table.tsx',
  'src/pages/NotFound.tsx',
]
const LINT_STRICT = (opt('lint-strict', WS0_FILES.join(',')) || '').split(',').filter(Boolean)

const FAIL_KEYS = [
  'hscroll',
  'overflowX',
  'textOverlaps',
  'boxOverlaps',
  'svgTextOverlaps',
  'svgTextOutside',
  'svgTinyText',
  'tooltipIssues',
  'truncatedNumbers',
  'toastOverActionBar',
  'navIssues',
]
const WARN_KEYS = ['tinyText', 'smallTargets', 'clipped', 'truncated', 'nativeTitles', 'focusWithoutRing']

const slug = (route) => route.replace(/^\//, '').replace(/[^a-z0-9.]+/gi, '-').replace(/^-|-$/g, '') || 'overview'
const log = (...args) => {
  if (!QUIET) console.log(...args)
}

// ---- in-page detector (serialised into the page) -------------------------------------------------------

/* eslint-disable no-undef */
function detect() {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const doc = document.documentElement
  const headerH = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || (Array.from(document.querySelectorAll('header')).find((h) => ['sticky', 'fixed'].includes(getComputedStyle(h).position))?.getBoundingClientRect().bottom ?? 0))

  // Measure real horizontal scroll even though <body> clips overflow-x as a safety net.
  const bodyOverflow = document.body.style.overflowX
  document.body.style.overflowX = 'visible'
  const scrollWidth = Math.max(doc.scrollWidth, document.body.scrollWidth)
  let culprit = null
  if (scrollWidth > vw + 1) {
    // Hide children from <body> down until the page fits: the last one that fixes it is the culprit.
    let node = document.body
    const trail = []
    for (let depth = 0; depth < 25 && node; depth++) {
      let found = null
      for (const child of Array.from(node.children)) {
        const previous = child.style.display
        child.style.display = 'none'
        const fits = Math.max(doc.scrollWidth, document.body.scrollWidth) <= vw + 1
        child.style.display = previous
        if (fits) {
          found = child
          break
        }
      }
      if (!found) break
      trail.push(found)
      node = found
    }
    culprit = trail.length ? sel(trail[trail.length - 1]) : null
  }
  document.body.style.overflowX = bodyOverflow

  const out = {
    url: location.pathname + location.search,
    vw,
    headerH,
    scrollWidth,
    hscroll: scrollWidth > vw + 1 ? [{ scrollWidth, culprit }] : [],
    overflowX: [],
    textOverlaps: [],
    boxOverlaps: [],
    clipped: [],
    truncated: [],
    truncatedNumbers: [],
    svgTextOverlaps: [],
    svgTextOutside: [],
    svgTinyText: [],
    tinyText: [],
    smallTargets: [],
    nativeTitles: [],
  }

  function sel(el) {
    if (!el || el.nodeType !== 1) return ''
    const parts = []
    let cur = el
    for (let i = 0; cur && cur.nodeType === 1 && i < 5; i++) {
      let s = cur.tagName.toLowerCase()
      if (cur.id && !/^[«:]/.test(cur.id)) {
        s += '#' + cur.id
        parts.unshift(s)
        break
      }
      const cls = (cur.getAttribute('class') || '')
        .split(/\s+/)
        .filter((c) => c && !c.includes(':') && !c.includes('[') && c.length < 24)
        .slice(0, 3)
      if (cls.length) s += '.' + cls.join('.')
      const parent = cur.parentElement
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName)
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(cur) + 1})`
      }
      parts.unshift(s)
      cur = cur.parentElement
    }
    return parts.join(' > ')
  }
  const txt = (el) => ((el && (el.innerText || el.textContent)) || '').trim().replace(/\s+/g, ' ').slice(0, 80)
  function visible(el) {
    if (!el || el.nodeType !== 1) return false
    if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return false
    const closed = el.closest('details:not([open])')
    if (closed && !el.closest('summary')) return false
    if (el.closest('[hidden]')) return false
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width >= 2 && r.height >= 2
  }
  function srOnly(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      if (p.classList && p.classList.contains('sr-only')) return true
      const cs = getComputedStyle(p)
      if (cs.position === 'absolute' && cs.clip === 'rect(0px, 0px, 0px, 0px)') return true
    }
    return false
  }
  const inter = (a, b) => {
    const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    return { x, y, area: x * y }
  }
  function fixedAncestor(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const pos = getComputedStyle(p).position
      if (pos === 'fixed' || pos === 'sticky') return p
    }
    return null
  }
  function inScrollerX(el) {
    for (let p = el.parentElement; p && p !== document.body && p !== doc; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (['auto', 'scroll', 'hidden', 'clip'].includes(cs.overflowX)) return p
    }
    return null
  }
  const clipCache = new Map()
  const clipTo = (a, b) => {
    const left = Math.max(a.left, b.left)
    const right = Math.min(a.right, b.right)
    const top = Math.max(a.top, b.top)
    const bottom = Math.min(a.bottom, b.bottom)
    return right <= left || bottom <= top ? null : { left, right, top, bottom, width: right - left, height: bottom - top }
  }
  function clipRect(el) {
    if (clipCache.has(el)) return clipCache.get(el)
    const p = el.parentElement
    const parentClip = p && p !== doc ? clipRect(p) : { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 }
    let res = parentClip
    if (parentClip && el !== document.body) {
      const cs = getComputedStyle(el)
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const r = el.getBoundingClientRect()
        res = clipTo(parentClip, {
          left: cs.overflowX !== 'visible' ? r.left : -1e9,
          right: cs.overflowX !== 'visible' ? r.right : 1e9,
          top: cs.overflowY !== 'visible' ? r.top : -1e9,
          bottom: cs.overflowY !== 'visible' ? r.bottom : 1e9,
        })
      }
    }
    clipCache.set(el, res)
    return res
  }

  const all = Array.from(document.querySelectorAll('body *')).filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName))

  // 1. Elements past the viewport that aren't inside a horizontal scroll/clip container.
  for (const el of all) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue
    if (el.closest('[data-floating]')) continue
    if (!visible(el) || srOnly(el)) continue
    const r = el.getBoundingClientRect()
    if ((r.right > vw + 1 || r.left < -1) && !inScrollerX(el)) out.overflowX.push({ sel: sel(el), text: txt(el), left: Math.round(r.left), right: Math.round(r.right) })
  }
  out.overflowX = out.overflowX.filter((o, i, arr) => !arr.some((p, j) => j !== i && o.sel.startsWith(p.sel + ' >'))).slice(0, 40)

  // 2. Text on text, per line box, clipped to overflow ancestors.
  const textRects = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.nodeValue.trim().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement
    if (!el || el.closest('svg') || ['SCRIPT', 'STYLE', 'OPTION', 'TITLE'].includes(el.tagName)) continue
    if (!visible(el) || srOnly(el)) continue
    const clip = clipRect(el)
    if (!clip) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    const rects = Array.from(range.getClientRects())
      .map((r) => clipTo(r, clip))
      .filter((r) => r && r.width > 1 && r.height > 1)
    for (const r of rects) textRects.push({ el, r, fixed: fixedAncestor(el), text: n.nodeValue.trim().slice(0, 50) })
  }
  const B = 64
  const buckets = new Map()
  textRects.forEach((t, i) => {
    for (let bx = Math.floor(t.r.left / B); bx <= Math.floor(t.r.right / B); bx++)
      for (let by = Math.floor((t.r.top + scrollY) / B); by <= Math.floor((t.r.bottom + scrollY) / B); by++) {
        const key = bx + ',' + by
        if (!buckets.has(key)) buckets.set(key, [])
        buckets.get(key).push(i)
      }
  })
  const seen = new Set()
  for (const ids of buckets.values())
    for (let a = 0; a < ids.length; a++)
      for (let b = a + 1; b < ids.length; b++) {
        const i = ids[a]
        const j = ids[b]
        const key = i < j ? i + '|' + j : j + '|' + i
        if (seen.has(key)) continue
        seen.add(key)
        const A = textRects[i]
        const C = textRects[j]
        if (A.el === C.el || !!A.fixed !== !!C.fixed) continue
        const it = inter(A.r, C.r)
        if (it.x > 2 && it.y > 3 && it.area > 12)
          out.textOverlaps.push({ a: sel(A.el), aText: A.text, b: sel(C.el), bText: C.text, overlapPx: [Math.round(it.x), Math.round(it.y)], at: [Math.round(A.r.left), Math.round(A.r.top + scrollY)] })
      }
  out.textOverlaps = out.textOverlaps.slice(0, 60)

  // 3. Sibling boxes (border or background, in flow) that intersect.
  const isBox = (el) => {
    const cs = getComputedStyle(el)
    return (parseFloat(cs.borderTopWidth) > 0 || (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)')) && !['absolute', 'fixed'].includes(cs.position) && cs.display !== 'inline'
  }
  for (const p of new Set(all.map((el) => el.parentElement))) {
    if (!p || p.closest('svg')) continue
    const kids = Array.from(p.children).filter((c) => visible(c) && !srOnly(c) && isBox(c))
    for (let a = 0; a < kids.length; a++)
      for (let b = a + 1; b < kids.length; b++) {
        const it = inter(kids[a].getBoundingClientRect(), kids[b].getBoundingClientRect())
        if (it.x > 2 && it.y > 2) out.boxOverlaps.push({ a: sel(kids[a]), aText: txt(kids[a]).slice(0, 40), b: sel(kids[b]), bText: txt(kids[b]).slice(0, 40), overlapPx: [Math.round(it.x), Math.round(it.y)] })
      }
  }
  out.boxOverlaps = out.boxOverlaps.slice(0, 40)

  // 4. Truncation and clipping inventory. Truncated numbers are failures: numbers must wrap, never cut.
  const numberLike = (text) => {
    const compact = text.replace(/\s+/g, '')
    const digits = (compact.match(/\d/g) || []).length
    return digits > 0 && (digits / Math.max(1, compact.length) >= 0.3 || compact.length <= 16)
  }
  for (const el of all) {
    if (el.closest('svg') || !visible(el) || srOnly(el)) continue
    const cs = getComputedStyle(el)
    const truncated =
      (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) ||
      (cs.webkitLineClamp && cs.webkitLineClamp !== 'none' && el.scrollHeight > el.clientHeight + 2)
    if (truncated) {
      const entry = { sel: sel(el), text: txt(el), hasTooltip: !!el.closest('[aria-describedby]') }
      ;(numberLike(txt(el)) ? out.truncatedNumbers : out.truncated).push(entry)
      continue
    }
    const hiddenX = cs.overflowX === 'hidden' || cs.overflowX === 'clip'
    const hiddenY = cs.overflowY === 'hidden' || cs.overflowY === 'clip'
    if (el === document.body) continue
    if (((hiddenX && el.scrollWidth > el.clientWidth + 2) || (hiddenY && el.scrollHeight > el.clientHeight + 2)) && el.clientWidth >= 4 && el.clientHeight >= 4)
      out.clipped.push({ sel: sel(el), text: txt(el), client: [el.clientWidth, el.clientHeight], scroll: [el.scrollWidth, el.scrollHeight] })
  }
  out.clipped = out.clipped.slice(0, 40)
  out.truncated = out.truncated.slice(0, 60)

  // 5. SVG text: overlaps, escaping the svg, and rendered size (fontSize × scale) below 11px.
  for (const svg of Array.from(document.querySelectorAll('svg'))) {
    if (!visible(svg)) continue
    const sr = svg.getBoundingClientRect()
    if (sr.width < 60) continue
    const texts = Array.from(svg.querySelectorAll('text')).filter((t) => visible(t) && (t.textContent || '').trim())
    const rects = texts.map((t) => ({ t, r: t.getBoundingClientRect() }))
    const ctm = svg.getScreenCTM && svg.getScreenCTM()
    const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1
    for (let a = 0; a < rects.length; a++) {
      const A = rects[a]
      const rendered = parseFloat(getComputedStyle(A.t).fontSize) * (A.t.ownerSVGElement && A.t.ownerSVGElement.getScreenCTM ? scale : 1)
      if (rendered < 11) out.svgTinyText.push({ svg: sel(svg), text: A.t.textContent.trim().slice(0, 40), renderedPx: Math.round(rendered * 10) / 10 })
      if (A.r.left < sr.left - 1 || A.r.right > sr.right + 1 || A.r.top < sr.top - 1 || A.r.bottom > sr.bottom + 1)
        out.svgTextOutside.push({ svg: sel(svg), text: A.t.textContent.trim().slice(0, 50) })
      for (let b = a + 1; b < rects.length; b++) {
        const C = rects[b]
        if (A.t.contains(C.t) || C.t.contains(A.t)) continue
        const it = inter(A.r, C.r)
        if (it.x > 2 && it.y > 2) out.svgTextOverlaps.push({ svg: sel(svg), a: A.t.textContent.trim().slice(0, 40), b: C.t.textContent.trim().slice(0, 40), overlapPx: [Math.round(it.x), Math.round(it.y)] })
      }
    }
  }
  out.svgTextOverlaps = out.svgTextOverlaps.slice(0, 60)
  out.svgTextOutside = out.svgTextOutside.slice(0, 40)
  out.svgTinyText = out.svgTinyText.slice(0, 40)

  // 6. Text below 12px, targets below 24px, native title tooltips.
  const tiny = new Map()
  for (const t of textRects) {
    const size = parseFloat(getComputedStyle(t.el).fontSize)
    if (size < 12) {
      const key = `${size}px`
      const entry = tiny.get(key) || { size: key, count: 0, samples: [] }
      entry.count++
      if (entry.samples.length < 3) entry.samples.push({ sel: sel(t.el), text: t.text })
      tiny.set(key, entry)
    }
  }
  out.tinyText = Array.from(tiny.values())
  const targets = Array.from(document.querySelectorAll('button, a[href], [role=button], input:not([type=hidden]), select, summary, [tabindex]:not([tabindex="-1"])')).filter(
    (el) => visible(el) && !srOnly(el),
  )
  // Exempt: links/terms inside running text (WCAG 2.5.8 inline exception) and stretched links (::after covers the row).
  const inline = (el) => {
    const display = getComputedStyle(el).display
    if (['inline', 'inline-block'].includes(display) && el.parentElement && /\S/.test(el.parentElement.textContent.replace(el.textContent, '')) && getComputedStyle(el.parentElement).display === 'block') return true
    const after = getComputedStyle(el, '::after')
    return after.position === 'absolute' && after.content !== 'none'
  }
  out.smallTargets = targets
    .filter((el) => {
      const r = el.getBoundingClientRect()
      return (r.height < 24 || r.width < 24) && !inline(el)
    })
    .slice(0, 30)
    .map((el) => ({ sel: sel(el), text: txt(el).slice(0, 30), size: [Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)] }))
  out.nativeTitles = Array.from(document.querySelectorAll('[title]'))
    .filter((el) => visible(el) && el.tagName !== 'IFRAME' && !el.closest('svg'))
    .slice(0, 30)
    .map((el) => ({ sel: sel(el), title: (el.getAttribute('title') || '').slice(0, 60) }))
  return out
}

/** Check the currently open floating element (tooltip/popover). */
function checkFloating(triggerSel) {
  const doc = document.documentElement
  const headerH = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || (Array.from(document.querySelectorAll('header')).find((h) => ['sticky', 'fixed'].includes(getComputedStyle(h).position))?.getBoundingClientRect().bottom ?? 0))
  const actionBarH = parseFloat(getComputedStyle(doc).getPropertyValue('--action-bar-h')) || 0
  const candidates = Array.from(document.querySelectorAll('[role=tooltip], [data-floating]')).filter((el) => {
    if (el.closest('[hidden]')) return false
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0 && r.width > 4 && r.height > 4
  })
  if (!candidates.length) return { open: false }
  const el = candidates[candidates.length - 1]
  const r = el.getBoundingClientRect()
  const issues = []
  if (r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight) issues.push('outside-viewport')
  if (r.top < headerH - 1) issues.push('under-header')
  if (actionBarH && r.bottom > innerHeight - actionBarH + 1) issues.push('under-action-bar')
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const pr = p.getBoundingClientRect()
      if (r.left < pr.left - 1 || r.right > pr.right + 1 || r.top < pr.top - 1 || r.bottom > pr.bottom + 1) {
        issues.push('clipped-by-ancestor')
        break
      }
    }
  }
  const previous = el.style.pointerEvents
  el.style.pointerEvents = 'auto'
  const points = [
    [r.left + 6, r.top + 6],
    [r.right - 6, r.top + 6],
    [r.left + r.width / 2, r.top + r.height / 2],
  ]
  const covered = points
    .map(([x, y]) => document.elementFromPoint(x, y))
    .filter((top) => top && !(top === el || el.contains(top)))
    .map((top) => top.tagName.toLowerCase() + '.' + String(top.className).split(' ').slice(0, 2).join('.'))
  el.style.pointerEvents = previous
  if (covered.length) issues.push('covered')
  return { open: true, trigger: triggerSel, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], issues, covered }
}
/* eslint-enable no-undef */

// ---- static lint: tiny text classes ---------------------------------------------------------------------

function lintTinyText() {
  const results = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      if (statSync(file).isDirectory()) walk(file)
      else if (/\.(tsx|ts|css)$/.test(name) && !/\.test\.ts$/.test(name)) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            for (const match of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
              if (Number(match[1]) < 12) results.push({ file: path.relative(ROOT, file), line: index + 1, size: `${match[1]}px` })
            }
          })
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  const strict = new Set(LINT_STRICT)
  return { failures: results.filter((r) => strict.has(r.file)), warnings: results.filter((r) => !strict.has(r.file)) }
}

// ---- browser checks ------------------------------------------------------------------------------------

async function settle(page) {
  const start = Date.now()
  while (Date.now() - start < 15000) {
    const busy = await page
      .evaluate(
        () =>
          Array.from(document.querySelectorAll('[role=status]:not([data-toast-region]):not(:empty), .animate-pulse, [aria-busy=true]')).filter((el) => !el.closest('[data-ux-static]'))
            .length,
      )
      .catch(() => 0)
    if (!busy) break
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(700)
}

async function probeTooltips(page, vw, route, touch) {
  const issues = []
  const notes = []
  const handles = await page.$$(
    '[aria-describedby]:not([aria-describedby=""]), [aria-haspopup="dialog"]:not([data-probe] *), span.group.relative > button.chip, [data-probe] button',
  )
  const triggers = []
  for (const handle of handles) {
    if (!(await handle.isVisible().catch(() => false))) continue
    const info = await handle.evaluate((el) => ({
      tag: el.tagName,
      text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40),
      fixed: !!el.closest('[data-probe]'),
      button: el.tagName === 'BUTTON' && !el.hasAttribute('aria-haspopup'),
      inDialog: !!el.closest('dialog'),
    }))
    if (info.inDialog) continue
    triggers.push({ handle, ...info })
  }
  // Probe the fixed edge probes first, then a spread of the others.
  triggers.sort((a, b) => Number(b.fixed) - Number(a.fixed))
  const picked = triggers.slice(0, MAX_TRIGGERS + 2)
  for (const trigger of picked) {
    const positions = trigger.fixed ? ['as-is'] : ['top', 'middle']
    for (const position of positions) {
      if (position !== 'as-is') {
        await trigger.handle.evaluate((el, where) => {
          const headerH = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || (Array.from(document.querySelectorAll('header')).find((h) => ['sticky', 'fixed'].includes(getComputedStyle(h).position))?.getBoundingClientRect().bottom ?? 0))
          const r = el.getBoundingClientRect()
          window.scrollBy(0, where === 'top' ? r.top - headerH - 4 : r.top - innerHeight / 2)
        }, position)
        await page.waitForTimeout(80)
      }
      const box = await trigger.handle.boundingBox()
      if (!box) continue
      if (touch) {
        if (trigger.button) continue // never tap a button that does something
        await trigger.handle.tap().catch(() => {})
      } else await trigger.handle.hover().catch(() => {})
      await page.waitForTimeout(450)
      const result = await page.evaluate(checkFloating, trigger.text)
      if (result.open) {
        notes.push(result)
        if (result.issues.length) issues.push({ route, vw, mode: touch ? 'tap' : 'hover', position, ...result })
      }
      await page.keyboard.press('Escape').catch(() => {})
      await page.mouse.move(1, 1).catch(() => {})
      await page.waitForTimeout(150)
    }
  }
  // Keyboard focus on the first non-fixed trigger.
  const first = triggers.find((t) => !t.fixed)
  if (first && !touch) {
    await page.keyboard.press('Tab').catch(() => {})
    await first.handle.evaluate((el) => {
      const target = el.matches('a[href], button, input, select, textarea, [tabindex]') ? el : el.querySelector('a[href], button, [tabindex]')
      if (target) target.focus()
    })
    await page.waitForTimeout(250)
    const result = await page.evaluate(checkFloating, first.text)
    if (result.open && result.issues.length) issues.push({ route, vw, mode: 'focus', ...result })
    await page.keyboard.press('Escape').catch(() => {})
  }
  return { issues, probed: notes.length }
}

async function checkToastAndBar(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-action-bar]')
    const toasts = Array.from(document.querySelectorAll('[data-toast-region] > *'))
    if (!bar || !toasts.length) return []
    const b = bar.getBoundingClientRect()
    return toasts
      .map((toast) => {
        const t = toast.getBoundingClientRect()
        const x = Math.max(0, Math.min(t.right, b.right) - Math.max(t.left, b.left))
        const y = Math.max(0, Math.min(t.bottom, b.bottom) - Math.max(t.top, b.top))
        return x * y > 0 ? { toast: (toast.innerText || '').slice(0, 40), overlapPx: [Math.round(x), Math.round(y)] } : null
      })
      .filter(Boolean)
  })
}

async function checkNav(page) {
  const issues = []
  const count = async () =>
    page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('header nav a[href]')).filter((a) => {
        const r = a.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && r.right <= innerWidth + 1 && r.left >= -1 && getComputedStyle(a).visibility !== 'hidden'
      })
      return new Set(links.map((a) => a.getAttribute('href').split('?')[0])).size
    })
  let reachable = await count()
  if (reachable < 6) {
    const menu = page.locator('header button[aria-controls]').first()
    if (await menu.isVisible().catch(() => false)) {
      await menu.click()
      await page.waitForTimeout(150)
      reachable = await count()
      await page.keyboard.press('Escape')
    }
  }
  if (reachable < 6) issues.push({ problem: `only ${reachable} of 6 main destinations reachable` })
  return issues
}

async function checkFocusRings(page, limit = 20) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.mouse.click(1, 1).catch(() => {})
  const issues = []
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const cs = getComputedStyle(el)
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none')
      return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30), ring }
    })
    if (info && !info.ring) issues.push(info)
  }
  return issues
}

// ---- main ----------------------------------------------------------------------------------------------

async function main() {
  mkdirSync(path.join(OUT, 'report'), { recursive: true })
  const lint = lintTinyText()
  const browser = await chromium.launch()
  const blocked = []
  const summary = {}
  const allIssues = []

  for (const vw of VPS) {
    for (const touch of vw <= 390 ? [false, true] : [false]) {
      const context = await browser.newContext({
        viewport: { width: vw, height: 900 },
        deviceScaleFactor: 1,
        hasTouch: touch,
        isMobile: touch,
      })
      await context.route('**/*', (route) => {
        const method = route.request().method()
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          blocked.push(`${method} ${route.request().url()}`)
          return route.abort()
        }
        return route.continue()
      })
      const page = await context.newPage()
      let navChecked = false
      for (const route of routes) {
        const key = `${route}@${vw}${touch ? '-touch' : ''}`
        try {
          await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 30000 })
          await settle(page)
          if (touch) {
            // Touch pass: only tooltip/popover taps.
            if (TOOLTIPS && route.startsWith('/__ux')) {
              const tips = await probeTooltips(page, vw, route, true)
              summary[key] = { tooltipIssues: tips.issues.length }
              allIssues.push(...tips.issues.map((issue) => ({ key, kind: 'tooltipIssues', ...issue })))
              log(`${key.padEnd(48)} tap probes=${tips.probed} issues=${tips.issues.length}`)
            }
            continue
          }
          if (SHOTS) await page.screenshot({ path: path.join(OUT, `${slug(route)}@${vw}.png`), fullPage: true })
          const report = await page.evaluate(detect)
          report.toastOverActionBar = await checkToastAndBar(page)
          report.navIssues = navChecked ? [] : await checkNav(page)
          navChecked = true
          if (TOOLTIPS) {
            const tips = await probeTooltips(page, vw, route, false)
            report.tooltipIssues = tips.issues
            report.tooltipsProbed = tips.probed
          } else report.tooltipIssues = []
          report.focusWithoutRing = route.startsWith('/__ux') || route === '/' ? await checkFocusRings(page) : []
          report.pageHeight = await page.evaluate(() => document.documentElement.scrollHeight)
          writeFileSync(path.join(OUT, 'report', `${slug(route)}@${vw}.json`), JSON.stringify(report, null, 1))
          const counts = {}
          for (const k of [...FAIL_KEYS, ...WARN_KEYS]) {
            const value = report[k]
            counts[k] = Array.isArray(value) ? (k === 'tinyText' ? value.reduce((n, v) => n + v.count, 0) : value.length) : 0
          }
          summary[key] = counts
          for (const k of FAIL_KEYS) for (const item of report[k] || []) allIssues.push({ key, kind: k, ...item })
          const fails = FAIL_KEYS.filter((k) => counts[k]).map((k) => `${k}=${counts[k]}`)
          const warns = WARN_KEYS.filter((k) => counts[k]).map((k) => `${k}=${counts[k]}`)
          log(`${key.padEnd(48)} ${fails.length ? 'FAIL ' + fails.join(' ') : 'ok'}${warns.length ? '  · warn ' + warns.join(' ') : ''}`)
        } catch (error) {
          console.log(`ERROR ${key}: ${String(error.message).slice(0, 200)}`)
          summary[key] = { error: 1 }
        }
      }
      await context.close()
    }
  }
  await browser.close()

  // ---- verdict ---------------------------------------------------------------------------------------
  let baseline = null
  if (BASELINE) baseline = JSON.parse(readFileSync(path.resolve(ROOT, BASELINE), 'utf8'))
  const regressions = []
  for (const [key, counts] of Object.entries(summary)) {
    for (const k of [...FAIL_KEYS, 'error']) {
      const now = counts[k] || 0
      const before = baseline ? (baseline[key]?.[k] ?? 0) : 0
      if (now > before) regressions.push({ key, kind: k, now, before })
    }
  }
  if (lint.failures.length) regressions.push({ key: 'lint', kind: 'tinyTextClass', now: lint.failures.length, before: 0 })
  if (blocked.length) console.log(`\nBlocked ${blocked.length} non-GET request(s) (safety net):`, blocked.slice(0, 5))

  writeFileSync(path.join(OUT, 'report', '_summary.json'), JSON.stringify({ base: BASE, vps: VPS, routes, summary, regressions, lint }, null, 1))
  writeFileSync(path.join(OUT, 'report', '_issues.json'), JSON.stringify(allIssues, null, 1))
  if (SAVE_BASELINE) {
    writeFileSync(path.resolve(ROOT, SAVE_BASELINE), JSON.stringify(summary, null, 1))
    console.log(`Baseline written to ${SAVE_BASELINE}`)
  }

  console.log(`\nLint: ${lint.failures.length} tiny text class(es) in strict files, ${lint.warnings.length} elsewhere (warnings).`)
  for (const item of lint.failures) console.log(`  FAIL ${item.file}:${item.line} text-[${item.size}]`)
  if (!QUIET && lint.warnings.length) {
    const byFile = {}
    for (const item of lint.warnings) byFile[item.file] = (byFile[item.file] || 0) + 1
    for (const [file, n] of Object.entries(byFile)) console.log(`  warn ${file}: ${n}`)
  }
  console.log(`Reports: ${path.relative(process.cwd(), path.join(OUT, 'report'))}/ (_summary.json, _issues.json, <route>@<width>.json)`)
  if (regressions.length) {
    console.log(`\nux:check FAILED — ${regressions.length} ${baseline ? 'regression(s) vs baseline' : 'failing check(s)'}:`)
    for (const r of regressions.slice(0, 60)) console.log(`  ${r.key.padEnd(48)} ${r.kind}=${r.now}${baseline ? ` (baseline ${r.before})` : ''}`)
    process.exit(1)
  }
  console.log('\nux:check passed.')
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
