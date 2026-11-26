// Run with: node web/dev/check-architecture-wires.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const url = new URL('../../docs/architecture.html', import.meta.url).href
const browser = await chromium.launch()

// Inspect the actual rendered geometry: unrelated wires must never share a segment,
// a through-crossing must have a gap, and a branch must start on its own source's trunk.
function inspect(svg) {
  const segments = []
  const paths = [...svg.querySelectorAll('path[data-from]')]
  for (const path of paths) {
    const values = path.getAttribute('d').match(/-?[\d.]+/g).map(Number)
    for (let i = 0; i + 3 < values.length; i += 2) {
      const [x, y, X, Y] = values.slice(i, i + 4)
      if (x === X && y === Y) continue
      const horizontal = y === Y
      if (!horizontal && x !== X) throw Error('Diagonal route')
      const [a, b] = horizontal ? [x, X] : [y, Y]
      segments.push({ path, horizontal, pos: horizontal ? y : x, lo: Math.min(a, b), hi: Math.max(a, b) })
    }
  }
  const gaps = [...svg.querySelectorAll('mask circle')]
  const at = (circle, x, y) => Number(circle.getAttribute('cx')) === x && Number(circle.getAttribute('cy')) === y
  let crossings = 0
  for (const [i, a] of segments.entries()) {
    for (const b of segments.slice(i + 1)) {
      if (a.path === b.path) continue
      if (a.horizontal === b.horizontal) {
        if (a.pos === b.pos && Math.min(a.hi, b.hi) > Math.max(a.lo, b.lo)) throw Error('Coincident tracks')
      } else {
        const [h, v] = a.horizontal ? [a, b] : [b, a]
        if (h.lo < v.pos && v.pos < h.hi && v.lo < h.pos && h.pos < v.hi) {
          crossings++
          const mask = gaps.find(g => at(g, v.pos, h.pos))?.parentElement
          if (!mask || ![h, v].some(s => s.path.parentElement.getAttribute('mask') === `url(#${mask.id})`)) {
            throw Error(`Unmarked crossing at ${v.pos}, ${h.pos}`)
          }
        }
      }
    }
  }
  if (crossings !== gaps.length) throw Error('A gap does not mark a crossing')
  const dots = [...svg.querySelectorAll('.junction')]
  for (const dot of dots) {
    const x = Number(dot.getAttribute('cx')), y = Number(dot.getAttribute('cy'))
    const branches = paths.filter(p => {
      const start = p.getPointAtLength(0)
      return start.x === x && start.y === y
    })
    const trunk = segments.filter(s => s.horizontal ? s.pos === y && s.lo < x && x < s.hi : s.pos === x && s.lo < y && y < s.hi)
    if (branches.length !== 1 || trunk.length !== 1 ||
        branches[0].dataset.from !== trunk[0].path.dataset.from ||
        branches[0].getAttribute('class') !== trunk[0].path.getAttribute('class')) throw Error('False junction')
  }
  return { paths: paths.length, crossings, dots: dots.length }
}

try {
  const page = await browser.newPage({ offline: true, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') errors.push(m.text()) })
  for (const width of [1440, 838, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(url)
    const overview = await page.locator('#wires').evaluate(inspect)
    const expected = await page.evaluate(() => new Set(Object.values(handoffs).map(h => JSON.stringify([h.from, h.to, h.kind]))).size)
    assert.equal(overview.paths, expected, 'Missing overview handoff')
    assert.ok(overview.crossings && overview.dots, 'Exercise both crossing and branch notation')
    const choice = page.locator('#trace-choice')
    await choice.selectOption('scan')
    assert.deepEqual(await page.locator('#wires').evaluate(inspect), { paths: 1, crossings: 0, dots: 0 })
    await choice.selectOption('all')
    for (const node of await page.locator('button[data-key]').all()) {
      const key = await node.getAttribute('data-key')
      await node.click()
      for (const mode of ['execution', 'data']) {
        await page.locator(`label:has([value="${mode}"])`).click()
        const diagram = await page.locator('#detail-wires').evaluate(inspect)
        const expected = await page.evaluate(({key, mode}) => {
          const m = modules[key]
          if (mode === 'data') return m.via.length + 1
          return new Set(m.paths.flatMap(p => p.slice(1).map((to, i) => JSON.stringify([p[i], to])))).size
        }, {key, mode})
        assert.equal(diagram.paths, expected, `${key}/${mode}: missing handoff`)
      }
      await page.keyboard.press('Escape')
    }
    assert.deepEqual(errors, [])
    console.log(`${width}px: overview and all component diagrams passed`)
  }
} finally {
  await browser.close()
}
