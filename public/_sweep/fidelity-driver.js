/**
 * Fidelity driver — does an edit on a scanned page look like the scan, and does
 * it leave everything else alone?
 *
 * Runs inside the live app page, like ocr-driver.js. It loads a PDF, recognises
 * the pages a suite touches, applies each edit the way a person does (open the
 * OCR editor, type, blur), waits for the live bake, and judges the result on
 * MuPDF renders of the page before and after (288 DPI):
 *
 *  - DAMAGE: pixels that changed by more than a few levels OUTSIDE the
 *    rectangles the bake planned to touch (`window.__ocrBakePlans`, set in
 *    `bakeOcrEdits` in dev builds). Anything there is damage to text the user
 *    never edited — the line above an edited line, a table rule, a stamp.
 *  - UNDERLINE: for a run that had one, how much of the new text it still runs
 *    under, and whether a stretch of it is left beyond the text's new end.
 *  - READ-BACK: the new text is what the page now extracts.
 *  - MODE: how the bake drew the run (`__ocrBakeReport`: partial, partial+shift,
 *    whole and why).
 *  - A before/after crop sheet (`__fidelity.show()`), because a reader's eye is
 *    what "looks like the scan" is finally judged by.
 *
 * Usage, at http://localhost:9000 (console or chrome-devtools MCP):
 *   const f = await import('/_sweep/fidelity-driver.js')
 *   const r = await f.runSuite({ url: '/some-scan.pdf', edits: await f.loadSuite('/_sweep/suites/some-scan.json') })
 *   r.summary                 // one line per edit
 *   window.__fidelity.show()  // crop sheet; __fidelity.hide() to close
 *   f.exportFixture()         // OCR runs as JSON, for tools/ocr-calibrate/fidelity-lab.mjs
 *
 * A suite is a JSON array of edits:
 *   { "label": "E2 underlined heading", "page": 0, "find": "<text in the OCR reading>",
 *     "from": "<substring to replace, default find>", "to": "<replacement>", "underlined": true }
 * or `"exact": "<whole run>"` instead of `find`. `find` matches the OCR READING,
 * misreadings included — a user edits what the editor shows. Suites quote the
 * documents they test, so they live in public/_sweep/suites/, which is
 * gitignored like the PDFs themselves: this repository is public.
 */

// No "unsaved changes" prompt while a driver is in charge: it blocks every
// automation call after a hot reload of an edited document.
window.__noUnloadPrompt = true

const pinia = () => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
const store = (n) => pinia()._s.get(n)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase()

/**
 * Whether an edit reads back. The page's text must hold what the user typed —
 * or, on a scan edit that re-read the line's misread words from the page's own
 * letters, what the bake wrote for the run instead (its text layer is that
 * repaired reading), as long as it carries the user's change: the stretch of
 * the typed text that differs from the original.
 */
function readsBack(pageText, plan, id, original, typed) {
  if (pageText.includes(norm(typed))) return 'typed'
  const written = norm((plan?.texts ?? []).filter(t => t.group === id).map(t => t.text).join(''))
  if (!written || !pageText.includes(written)) return false
  const a = norm(original), b = norm(typed)
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let q = 0
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++
  const change = b.slice(p, b.length - q)
  return !change || written.includes(change) ? 'repaired' : false
}
/** Renders for diffs and crops: 288 DPI. */
const SCALE = 4
/** A pixel "changed" when its luminance moved by more than this. */
const LEVEL = 8

/** A suite of edits from a JSON file (see the header for the shape). */
export async function loadSuite(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  return res.json()
}

async function withTimeout(promise, ms, label) {
  let t
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: timeout ${ms}ms`)), ms) })
  try { return await Promise.race([promise, timeout]) } finally { clearTimeout(t) }
}

async function loadPdf(url, timeoutMs = 60000) {
  const doc = store('document')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  const buf = await res.arrayBuffer()
  const dt = new DataTransfer()
  dt.items.add(new File([buf], url.split('/').pop(), { type: 'application/pdf' }))
  const before = doc.pdfBytes
  document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  const t0 = performance.now()
  while (performance.now() - t0 < timeoutMs) {
    await sleep(200)
    if (doc.loaded && doc.pdfBytes && doc.pdfBytes !== before) break
  }
  if (!doc.loaded) throw new Error('document did not load')
  await sleep(800)
  return { pages: doc.totalPages, bytes: buf.byteLength }
}

async function ensureRecognised(pageIndex) {
  const ocrStore = store('ocr')
  if (ocrStore.resultFor(pageIndex)) return ocrStore.resultFor(pageIndex)
  store('editor').setTool('edit')
  await sleep(200)
  await withTimeout(window.__pdfHooks.ocrController.recognise(pageIndex), 240000, 'recognise')
  // The app re-reads the runs from the page's own letters in the background;
  // the suite's lookups have to see the readings it settles on.
  await withTimeout(window.__pdfHooks.ocrController.settleRepairs?.() ?? Promise.resolve(), 120000, 're-read')
  return ocrStore.resultFor(pageIndex)
}

async function render(pageIndex) {
  const c = await withTimeout(window.__pdfEngine.renderPageBitmap(pageIndex, SCALE), 30000, 'render')
  if (!c) throw new Error('render failed')
  return c
}

function lumOf(canvas) {
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data
  const lum = new Uint8Array(canvas.width * canvas.height)
  for (let i = 0, j = 0; i < d.length; i += 4, j++) lum[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
  return { w: canvas.width, h: canvas.height, lum }
}

function findItem(pageIndex, spec) {
  const items = store('ocr').itemsFor(pageIndex).filter(i => !i.vertical && !i.removed)
  const hit = spec.exact != null
    ? items.find(i => i.originalText.trim() === spec.exact) ?? items.find(i => norm(i.originalText) === norm(spec.exact))
    : items.find(i => i.originalText.includes(spec.find)) ?? items.find(i => norm(i.originalText).includes(norm(spec.find)))
  // `alt`: the same edit against the line as the app re-reads it from the
  // page's own letters ("USD 30.00" comes back "USD 630.00").
  if (hit || !spec.alt) return hit ? { item: hit, spec } : null
  return findItem(pageIndex, { ...spec, ...spec.alt, alt: undefined })
}

async function applyEdit(item, newText) {
  if (!window.__ocrLayer) throw new Error('no OCR layer on this page')
  window.__ocrLayer.beginEdit(item.id)
  await sleep(400)
  const ta = document.querySelector('.ocr-editor')
  if (!ta) throw new Error('editor did not open')
  ta.value = newText
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.blur()
  await sleep(300)
}

async function waitApplied(pageIndex, ids, timeoutMs = 180000) {
  const t0 = performance.now()
  while (performance.now() - t0 < timeoutMs) {
    await sleep(500)
    const items = store('ocr').itemsFor(pageIndex)
    const pending = ids.filter(id => { const i = items.find(x => x.id === id); return i && (i.edited || i.removed) && !i.applied })
    if (!pending.length) { await sleep(1000); return true }
  }
  return false
}

async function gotoPage(n) {
  const doc = store('document')
  if (doc.currentPage !== n) { doc.setCurrentPage ? doc.setCurrentPage(n) : (doc.currentPage = n); await sleep(1500) }
}

/** The pixels a page's bake was allowed to change: its patches and moved images, dilated. */
function allowedMask(w, h, plan, dilatePx) {
  const mask = new Uint8Array(w * h)
  const rects = [...(plan?.patches || []).map(p => p.rect), ...(plan?.images || []).map(i => i.dstRect)]
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(Math.min(r[0], r[2]) * SCALE) - dilatePx)
    const x1 = Math.min(w, Math.ceil(Math.max(r[0], r[2]) * SCALE) + dilatePx)
    const y0 = Math.max(0, Math.floor(Math.min(r[1], r[3]) * SCALE) - dilatePx)
    const y1 = Math.min(h, Math.ceil(Math.max(r[1], r[3]) * SCALE) + dilatePx)
    for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1)
  }
  return mask
}

/** Changed pixels outside the allowed set, and where they cluster (6pt cells, points). */
function damageOf(before, after, allowed) {
  let outside = 0, inside = 0
  const cells = new Map()
  const cell = 6 * SCALE
  for (let j = 0; j < before.lum.length; j++) {
    if (Math.abs(before.lum[j] - after.lum[j]) <= LEVEL) continue
    if (allowed[j]) { inside++; continue }
    outside++
    const x = j % before.w, y = (j - x) / before.w
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`
    cells.set(key, (cells.get(key) || 0) + 1)
  }
  const top = [...cells.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, n]) => { const [cx, cy] = k.split(',').map(Number); return { x: cx * 6, y: cy * 6, px: n } })
  return { outside, inside, where: top }
}

/**
 * An underline under the run's ORIGINAL ink, and how much of the run's new
 * extent it still covers after the edit. Rows are found on the before render:
 * the densest row below the letters, kept when it is inked across most of the
 * run.
 */
function underlineOf(before, after, item) {
  const r = item.inkRect
  const x0 = Math.max(0, Math.floor(r.x * SCALE)), x1 = Math.min(before.w, Math.ceil((r.x + r.width) * SCALE))
  const y0 = Math.floor((r.y + r.height * 0.45) * SCALE), y1 = Math.min(before.h, Math.ceil((r.y + r.height * 1.5) * SCALE))
  // A rule is a HORIZONTAL run of ink far longer than any stroke of a letter;
  // on a tilted scan it steps from row to row, so no single row holds it.
  // Rule columns: those any row of the band crosses with a run of 8pt or more.
  const LONG = 8 * SCALE
  const ruleCols = (L, a, b) => {
    const cols = new Uint8Array(L.w)
    for (let y = y0; y < y1; y++) {
      let start = -1
      for (let x = a; x <= b; x++) {
        const dark = x < b && L.lum[y * L.w + x] < 160
        if (dark && start < 0) start = x
        if (!dark && start >= 0) { if (x - start >= LONG) cols.fill(1, start, x); start = -1 }
      }
    }
    return cols
  }
  const share = (cols, a, b) => { let c = 0; for (let x = a; x < b; x++) c += cols[x]; return b > a ? c / (b - a) : 1 }
  const colsBefore = ruleCols(before, x0, x1)
  if (share(colsBefore, x0, x1) < 0.6) return { had: false }
  // The text's extent after the edit: inked columns above the band, from the
  // run's left edge rightwards until a gap of three ems.
  const textTop = Math.max(0, Math.floor((r.y - r.height * 0.2) * SCALE)), textBottom = y0
  const em = r.height * SCALE
  let right = x0, gap = 0
  for (let x = x0; x < Math.min(after.w, x1 + 80 * SCALE); x++) {
    let any = false
    for (let y = textTop; y < textBottom && !any; y++) if (after.lum[y * after.w + x] < 128) any = true
    if (any) { right = x; gap = 0 } else if (++gap > em * 3) break
  }
  const wide = Math.min(after.w, Math.max(x1, right) + 4 * SCALE)
  const colsAfter = ruleCols(after, x0, wide)
  // Rule left beyond the new end of the text (a shorter replacement).
  let beyond = 0
  for (let x = right + Math.round(2 * SCALE); x < wide; x++) beyond += colsAfter[x]
  return {
    had: true,
    before: +share(colsBefore, x0, x1).toFixed(3),
    after: +share(colsAfter, x0, right).toFixed(3),
    beyondPt: +(beyond / SCALE).toFixed(1)
  }
}

function crop(canvas, rectPt, padPt = 6, growPt = 60) {
  const x = Math.max(0, Math.floor((rectPt.x - padPt) * SCALE)), y = Math.max(0, Math.floor((rectPt.y - padPt) * SCALE))
  const w = Math.min(canvas.width - x, Math.ceil((rectPt.width + 2 * padPt + growPt) * SCALE))
  const h = Math.min(canvas.height - y, Math.ceil((rectPt.height + 2 * padPt) * SCALE))
  const out = document.createElement('canvas')
  out.width = w; out.height = h
  out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h)
  return out
}

let lastSheet = []

// The last run's sheet lives on window as well as here: importing the module
// again (a cache-busting query) makes a fresh instance with an empty sheet.
export function show(rows = window.__fidelityLast?.sheet ?? lastSheet, width = 1700) {
  hide()
  const d = document.createElement('div')
  d.id = '__fidelity_sheet'
  d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;overflow:auto;padding:8px;font:12px monospace;color:#000'
  for (const r of rows) {
    const lab = document.createElement('div')
    lab.textContent = r.label
    lab.style.cssText = 'margin:8px 0 2px;color:#a00'
    d.appendChild(lab)
    for (const cv of [r.before, r.after]) {
      if (!cv) continue
      cv.style.cssText = `display:block;width:${Math.min(width, cv.width * (r.zoom || 1.5))}px;border:1px solid #ccc;margin-bottom:2px`
      d.appendChild(cv)
    }
  }
  document.body.appendChild(d)
  return rows.length
}

export function hide() { document.getElementById('__fidelity_sheet')?.remove() }

/** The page's OCR runs as plain JSON — the fixture `fidelity-lab.mjs` cuts offline. */
export function exportFixture(file = '') {
  const pages = []
  for (const [pageIndex, page] of store('ocr').pages) {
    pages.push({
      pageIndex, pageWidth: page.pageWidth, pageHeight: page.pageHeight,
      items: page.items.map(i => ({ id: i.id, text: i.originalText, inkRect: i.inkRect, fontSize: i.fontSize, bold: i.bold, confidence: i.confidence, vertical: i.vertical }))
    })
  }
  return JSON.stringify({ file, pages })
}

export async function runSuite({ url, edits, load = true }) {
  const t0 = performance.now()
  const report = { url, edits: [], pages: {}, error: null }
  try {
    if (load) await withTimeout(loadPdf(url), 70000, 'load')
    const pages = [...new Set(edits.map(e => e.page))].sort((a, b) => a - b)
    const before = new Map()
    for (const p of pages) {
      await gotoPage(p + 1)
      await ensureRecognised(p)
      before.set(p, await render(p))
    }
    const done = []
    for (const spec of edits) {
      const row = { label: spec.label, page: spec.page }
      report.edits.push(row)
      try {
        await gotoPage(spec.page + 1)
        const found = findItem(spec.page, spec)
        if (!found) { row.error = 'run not found'; continue }
        const item = found.item
        const use = found.spec
        row.id = item.id
        row.original = item.originalText
        const next = item.text.replace(use.from ?? use.find ?? use.exact, use.to)
        if (next === item.text) { row.error = 'edit made no change'; continue }
        row.text = next
        row.inkRect = { ...item.inkRect }
        await applyEdit(item, next)
        done.push({ spec, id: item.id, row })
      } catch (err) { row.error = String(err?.message || err) }
    }
    for (const p of pages) {
      const ids = done.filter(d => d.spec.page === p).map(d => d.id)
      const settled = await waitApplied(p, ids)
      const after = await render(p)
      const plan = window.__ocrBakePlans?.[p]
      const b = lumOf(before.get(p)), a = lumOf(after)
      const dmg = damageOf(b, a, allowedMask(b.w, b.h, plan, 2))
      const blocks = await window.__pdfEngine.getTextBlocks(p).catch(() => [])
      const pageText = norm(blocks.map(x => x.text).join(''))
      report.pages[p] = { settled, damageOutside: dmg.outside, changedInside: dmg.inside, damageWhere: dmg.where }
      for (const d of done.filter(x => x.spec.page === p)) {
        const item = store('ocr').itemsFor(p).find(i => i.id === d.id)
        // Per page: `__ocrBakeReport` holds only the last page baked.
        d.row.mode = plan?.modes?.[d.id] ?? window.__ocrBakeReport?.[p]?.[d.id] ?? null
        d.row.applied = !!item?.applied
        d.row.found = readsBack(pageText, plan, d.id, item?.originalText ?? d.row.original, d.row.text)
        if (d.spec.underlined) d.row.underline = underlineOf(b, a, { inkRect: d.row.inkRect })
        // Damage near this run's line: the share of the page's damage cells
        // that sit within a line height of it.
        const r = d.row.inkRect
        d.row.damageNear = dmg.where.filter(c => c.y + 6 >= r.y - r.height && c.y <= r.y + r.height * 2).reduce((s, c) => s + c.px, 0)
        d.crops = { before: crop(before.get(p), r), after: crop(after, r) }
      }
    }
    lastSheet = done.map(d => ({ label: `${d.row.label} — ${d.row.mode ?? '?'} — found ${d.row.found}`, before: d.crops?.before, after: d.crops?.after }))
  } catch (err) {
    report.error = String(err?.message || err)
  }
  report.ms = Math.round(performance.now() - t0)
  report.summary = report.edits.map(e => [
    e.label.padEnd(36), (e.mode ?? e.error ?? '?').toString().padEnd(32),
    `found=${e.found ?? '-'}`, `near=${e.damageNear ?? '-'}`,
    e.underline ? `ul=${e.underline.had ? `${e.underline.before}->${e.underline.after} beyond ${e.underline.beyondPt}pt` : 'none'}` : ''
  ].join(' ')).concat(Object.entries(report.pages).map(([p, v]) => `page ${p}: damage outside plan ${v.damageOutside}px (inside ${v.changedInside}) ${JSON.stringify(v.damageWhere)}`))
  // Not enumerable: the canvases must not travel with a JSON copy of the report.
  Object.defineProperty(report, 'sheet', { value: lastSheet, enumerable: false })
  window.__fidelityLast = report
  return report
}

/** The three edits a person makes (ocr-driver.js's): drop a character, reverse a word, append. */
function autoEdit(text, k) {
  const chars = [...text]
  if (k % 3 === 0 && chars.length > 4) { const i = Math.floor(chars.length / 2); return { kind: 'delete', text: chars.slice(0, i).concat(chars.slice(i + 1)).join('') } }
  if (k % 3 === 1) {
    const m = text.match(/[\p{L}]{3,}/u)
    if (m) return { kind: 'replace', text: text.replace(m[0], m[0].split('').reverse().join('')) }
  }
  return { kind: 'append', text: text + ' X' }
}

/**
 * The suite's measurements on edits nobody wrote by hand: on each SCAN page of
 * `pages` (1-based; default the first three), up to `maxRuns` readable runs get
 * the three kinds of edit, through the UI, and the page is judged as
 * `runSuite` judges it — damage outside the bake's plan, read-back, the mode
 * each run was drawn in, and the crop sheet.
 */
export async function runAuto({ url, pages = [1, 2, 3], maxRuns = 3, load = true }) {
  const t0 = performance.now()
  const report = { url, pages: {}, edits: [], error: null }
  try {
    if (load) await withTimeout(loadPdf(url), 70000, 'load')
    const doc = store('document')
    const P = window.__pdfHooks
    const done = []
    const before = new Map()
    for (const p of pages.filter(n => n <= doc.totalPages)) {
      const pageIndex = p - 1
      await gotoPage(p)
      const scan = await withTimeout(P.ocrController.isScanLike(pageIndex), 30000, 'isScanLike').catch(() => false)
      if (!scan) { report.pages[pageIndex] = { scan: false }; continue }
      const result = await ensureRecognised(pageIndex)
      if (!result) { report.pages[pageIndex] = { error: 'not recognised' }; continue }
      before.set(pageIndex, await render(pageIndex))
      const good = result.items.filter(i => !i.vertical && !i.removed && i.confidence >= 70 && /[\p{L}\p{N}]{3,}/u.test(i.text) && i.text.length >= 4 && i.text.length <= 90)
      const step = Math.max(1, Math.floor(good.length / maxRuns))
      for (let k = 0, n = 0; k < good.length && n < maxRuns; k += step, n++) {
        const item = good[k]
        const ed = autoEdit(item.text, n)
        const row = { label: `p${p} ${ed.kind} "${item.text.slice(0, 28)}"`, page: pageIndex, id: item.id, original: item.text, text: ed.text, kind: ed.kind, inkRect: { ...item.inkRect } }
        report.edits.push(row)
        try { await applyEdit(item, ed.text); done.push({ row, pageIndex }) } catch (err) { row.error = String(err?.message || err) }
      }
    }
    for (const pageIndex of before.keys()) {
      const ids = done.filter(d => d.pageIndex === pageIndex).map(d => d.row.id)
      const settled = await waitApplied(pageIndex, ids)
      const after = await render(pageIndex)
      const plan = window.__ocrBakePlans?.[pageIndex]
      const b = lumOf(before.get(pageIndex)), a = lumOf(after)
      const dmg = damageOf(b, a, allowedMask(b.w, b.h, plan, 2))
      const blocks = await window.__pdfEngine.getTextBlocks(pageIndex).catch(() => [])
      const pageText = norm(blocks.map(x => x.text).join(''))
      report.pages[pageIndex] = { scan: true, settled, damageOutside: dmg.outside, changedInside: dmg.inside, damageWhere: dmg.where }
      for (const d of done.filter(x => x.pageIndex === pageIndex)) {
        d.row.mode = plan?.modes?.[d.row.id] ?? null
        d.row.found = readsBack(pageText, plan, d.row.id, d.row.original, d.row.text)
        d.crops = { before: crop(before.get(pageIndex), d.row.inkRect), after: crop(after, d.row.inkRect) }
      }
    }
    lastSheet = done.map(d => ({ label: `${d.row.label} — ${d.row.mode ?? '?'} — found ${d.row.found}`, before: d.crops?.before, after: d.crops?.after }))
  } catch (err) {
    report.error = String(err?.message || err)
  }
  report.ms = Math.round(performance.now() - t0)
  report.summary = report.edits.map(e => [e.label.padEnd(44), (e.mode ?? e.error ?? '?').toString().slice(0, 60).padEnd(60), `found=${e.found ?? '-'}`].join(' '))
    .concat(Object.entries(report.pages).map(([p, v]) => `page ${p}: ${v.scan === false ? 'not a scan' : v.error ?? `damage outside plan ${v.damageOutside}px (inside ${v.changedInside})`}`))
  Object.defineProperty(report, 'sheet', { value: lastSheet, enumerable: false })
  window.__fidelityLast = report
  return report
}

window.__fidelity = { runSuite, runAuto, loadSuite, show, hide, exportFixture }
