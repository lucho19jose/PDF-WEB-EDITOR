/**
 * OCR sweep driver — runs inside the live app page, like driver.js.
 *
 * For every staged PDF: load it through the app, walk its first pages, and
 * on each page that the app itself judges a SCAN, recognise it with the
 * engine the user has chosen, edit a few runs the way a person would (delete a
 * character, change a word, append), bake, and judge:
 *
 *  - recognition: runs found, confidence, time, engine, fallback;
 *  - editing: the edited text is what extraction reads back after the bake;
 *  - fidelity: how many of the edited run's characters the scan face could
 *    draw, and whether the face's glyph cut was refused;
 *  - cost: bytes the bake added to the document;
 *  - safety: no exception anywhere, the viewer still renders the page.
 *
 * Text pages get one light edit through the same replaceText path the UI uses,
 * as a smoke test; the character-level sweep (driver.js) covers those in depth.
 */

const app = () => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
const store = (n) => app()._s.get(n)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const norm = (s) => (s || '').replace(/\s+/g, '')

function provides() {
  // The layout puts its hooks on window (a production build strips the Vue
  // internals); the DOM walk is the dev-only fallback.
  if (window.__pdfHooks) return window.__pdfHooks
  let inst = document.querySelector('.q-layout')?.__vueParentComponent
  while (inst) { if (inst.provides && inst.provides.ocrController) return inst.provides; inst = inst.parent }
  return null
}

async function withTimeout(promise, ms, label) {
  let t
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: timeout ${ms}ms`)), ms) })
  try { return await Promise.race([promise, timeout]) } finally { clearTimeout(t) }
}

async function loadStaged(staged, timeoutMs = 60000) {
  const doc = store('document')
  const res = await fetch('/_sweep/' + staged)
  if (!res.ok) throw new Error(`fetch ${staged}: ${res.status}`)
  const buf = await res.arrayBuffer()
  const dt = new DataTransfer()
  dt.items.add(new File([buf], staged.split('/').pop(), { type: 'application/pdf' }))
  const before = doc.pdfBytes
  document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  const t0 = performance.now()
  while (performance.now() - t0 < timeoutMs) {
    await sleep(200)
    if (doc.loaded && doc.pdfBytes && doc.pdfBytes !== before) break
  }
  if (!doc.loaded) throw new Error('document did not load')
  await sleep(600)
  return { pages: doc.totalPages, bytes: buf.byteLength }
}

async function gotoPage(n) {
  const doc = store('document')
  if (doc.currentPage !== n) { doc.setCurrentPage ? doc.setCurrentPage(n) : (doc.currentPage = n); await sleep(1200) }
}

function ocrLayerApi() {
  if (!document.querySelector('.ocr-layer')) return null
  if (window.__ocrLayer) return { api: window.__ocrLayer, ocr: window.__ocrLayer.ocr }
  const inst = document.querySelector('.ocr-layer').__vueParentComponent
  if (!inst) return null
  return { api: inst.exposed || inst.setupState, ocr: inst.setupState.ocr }
}

/** Runs worth editing: readable, confident, not sideways, with some letters. */
function pickRuns(items, max) {
  const good = items.filter(i => !i.vertical && !i.removed && i.confidence >= 70 && /[\p{L}\p{N}]{3,}/u.test(i.text) && i.text.length >= 4 && i.text.length <= 90)
  const step = Math.max(1, Math.floor(good.length / max))
  const out = []
  for (let k = 0; k < good.length && out.length < max; k += step) out.push(good[k])
  return out
}

/** Three kinds of edit a person makes: drop a character, change a word, add one. */
function editsFor(text, k) {
  const chars = [...text]
  if (k % 3 === 0 && chars.length > 4) { const i = Math.floor(chars.length / 2); return { kind: 'delete', text: chars.slice(0, i).concat(chars.slice(i + 1)).join('') } }
  if (k % 3 === 1) {
    const m = text.match(/[\p{L}]{3,}/u)
    if (m) return { kind: 'replace', text: text.replace(m[0], m[0].split('').reverse().join('')) }
  }
  return { kind: 'append', text: text + ' X' }
}

async function inkFraction(pageNo, rectPt) {
  const canvas = await withTimeout(window.__pdfViewer.renderPageToCanvas(pageNo, 2), 20000, 'render')
  if (!canvas) return null
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const k = 2
  const x = Math.max(0, Math.floor(rectPt.x * k)), y = Math.max(0, Math.floor(rectPt.y * k))
  const w = Math.min(canvas.width - x, Math.ceil(rectPt.width * k)), h = Math.min(canvas.height - y, Math.ceil(rectPt.height * k))
  if (w < 2 || h < 2) return null
  const d = ctx.getImageData(x, y, w, h).data
  let dark = 0
  for (let i = 0; i < d.length; i += 4) if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 140) dark++
  return dark / (w * h)
}

/**
 * Recognise the BAKED page again and compare each edited run's ink against the
 * text the user typed. Two runs' texts are compared folded and space-free; a
 * traced face that learned the wrong shapes scores near zero while the
 * extracted text is a perfect match, which is exactly the gap being measured.
 */
async function rereadEdits(pageIndex, edits) {
  const P = provides()
  const ocr = P.ocr || window.__ocrLayer?.ocr
  if (!ocr) return { error: 'no ocr composable' }
  const canvas = await window.__pdfViewer.renderPageToCanvas(pageIndex + 1, 220 / 72)
  if (!canvas) return { error: 'no canvas' }
  const size = await window.__pdfEngine.getPageSize(pageIndex).catch(() => ({ width: 612, height: 792 }))
  const res = await withTimeout(
    ocr.recognizePage(canvas, pageIndex, size.width, size.height, undefined, false),
    240000, 'reread')
  if (!res) return { error: 'no result' }
  const fold = (t) => (t || '').toLowerCase().replace(/\s+/g, '')
  const out = []
  for (const e of edits) {
    if (!e.text || !e.rect) continue
    const want = fold(e.text)
    let best = null
    // The re-read run that best MATCHES the edited run's box (intersection
    // over union), not the one that overlaps it most: a 93pt logo's box
    // contains the whole 16pt tagline under it, so by overlap alone the
    // tagline's edit was scored against the logo's text (0.11) while the
    // tagline itself had been traced correctly.
    for (const it of res.items) {
      const r = it.rect
      const ox = Math.min(r.x + r.width, e.rect.x + e.rect.width) - Math.max(r.x, e.rect.x)
      const oy = Math.min(r.y + r.height, e.rect.y + e.rect.height) - Math.max(r.y, e.rect.y)
      if (ox <= 0 || oy <= 0) continue
      const inter = ox * oy
      const union = r.width * r.height + e.rect.width * e.rect.height - inter
      const area = inter / Math.max(union, 1e-6)
      if (!best || area > best.area) best = { area, text: it.text }
    }
    const got = fold(best?.text)
    out.push({ want: e.text.slice(0, 50), got: (best?.text || '').slice(0, 50), sim: got ? similarity(want, got) : 0, traced: !!(e.font && /ScanFace/.test(e.font)) })
  }
  return { runs: res.items.length, edits: out }
}

/** Longest common subsequence over length — 1 is identical, 0 is unrelated. */
function similarity(a, b) {
  if (!a || !b) return 0
  const prev = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diag = 0
    for (let j = 1; j <= b.length; j++) {
      const t = prev[j]
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1])
      diag = t
    }
  }
  return Math.round((prev[b.length] / Math.max(a.length, b.length)) * 100) / 100
}

export async function runPdf(entry, opts = {}) {
  const maxPages = opts.maxPages ?? 3
  const maxRuns = opts.maxRuns ?? 3
  const out = { staged: entry.staged, file: entry.file, pages: [], error: null, ms: 0 }
  const t0 = performance.now()
  const doc = store('document'), editor = store('editor'), ocrStore = store('ocr')
  try {
    const loaded = await withTimeout(loadStaged(entry.staged), 70000, 'load')
    out.totalPages = loaded.pages
    out.bytes = loaded.bytes
    const P = provides()
    const total = Math.min(loaded.pages, maxPages)
    for (let p = 1; p <= total; p++) {
      const page = { page: p, error: null }
      out.pages.push(page)
      try {
        await gotoPage(p)
        const pageIndex = p - 1
        const blocks = await withTimeout(window.__pdfEngine.getTextBlocks(pageIndex), 30000, 'getTextBlocks')
        page.textChars = blocks.reduce((n, b) => n + b.text.trim().length, 0)
        page.scan = await withTimeout(P.ocrController.isScanLike(pageIndex), 30000, 'isScanLike')
        if (!page.scan) {
          // Text page: one edit through the UI's own path, as a smoke test.
          const cand = blocks.filter(b => b.text.trim().length >= 6 && /[A-Za-z]/.test(b.text))
          if (cand.length) {
            const b = cand[Math.floor(cand.length / 2)]
            const newText = b.text.trim() + ' X'
            const ok = await withTimeout(window.__pdfEngine.replaceText(pageIndex, b.id, newText), 60000, 'replaceText')
            const after = await withTimeout(window.__pdfEngine.getTextBlocks(pageIndex), 30000, 'getTextBlocks')
            page.textEdit = { block: b.text.slice(0, 40), ok: !!(ok && (ok.success ?? ok)), found: norm(after.map(x => x.text).join('')).includes(norm(newText)), error: ok && ok.error ? ok.error : (window.__pdfEngine.error?.value || null) }
          }
          continue
        }
        editor.setTool('edit'); await sleep(300)
        const r0 = performance.now()
        await withTimeout(P.ocrController.recognise(pageIndex), 240000, 'recognise')
        page.recogMs = Math.round(performance.now() - r0)
        const result = ocrStore.resultFor(pageIndex)
        if (!result) { page.error = 'no result: ' + editor.statusMessage; continue }
        page.engine = result.engine
        page.fallback = result.fallbackNote || null
        page.runs = result.items.length
        page.confidence = result.confidence
        page.vertical = result.verticalCount || 0
        page.status = editor.statusMessage
        const layer = ocrLayerApi()
        // A scan page that reads as NOTHING (the blank back of a sheet) has no
        // layer to edit in; that is the app's answer, not a harness failure.
        if (!layer) { if (result.items.length) page.error = 'no OCR layer'; else page.note = 'no text recognised'; continue }
        const picks = pickRuns(result.items, maxRuns)
        page.edits = []
        for (const [k, item] of picks.entries()) {
          // The sampled colours travel with the row: a replacement drawn in the
          // paper's own colour reads back perfectly and shows nothing, and
          // without them that row is indistinguishable from a wrong trace.
          const e = { original: item.text, fontSize: item.fontSize, bold: item.bold, italic: item.italic, conf: item.confidence, color: item.color?.map(v => +v.toFixed(2)), background: item.background?.map(v => +v.toFixed(2)) }
          page.edits.push(e)
          try {
            const cut = layer.ocr.cutFor(item)
            e.cut = cut ? { cells: cut.cells.length, suspects: cut.cells.filter(c => c.suspect).length, reason: cut.reason || null } : null
            const ed = editsFor(item.text, k)
            e.kind = ed.kind; e.text = ed.text
            layer.api.beginEdit(item.id); await sleep(250)
            const ta = document.querySelector('.ocr-editor')
            if (!ta) { e.error = 'editor did not open'; continue }
            ta.value = ed.text; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.blur()
            await sleep(1800)
            const now = ocrStore.itemsFor(pageIndex).find(i => i.id === item.id)
            e.edited = !!now?.edited
            e.rect = now ? now.rect : item.rect
          } catch (err) { e.error = String(err?.message || err) }
        }
        const faces = layer.ocr.facesOf(pageIndex).map(f => ({ name: f.familyName, glyphs: f.glyphs.size, bytes: f.bytes?.byteLength ?? 0 }))
        page.faces = faces
        const bytesBefore = doc.pdfBytes?.byteLength ?? 0
        const b0 = performance.now()
        page.written = await withTimeout(P.bakeOcrEdits(), 120000, 'bake')
        page.bakeMs = Math.round(performance.now() - b0)
        await sleep(800)
        page.bytesAdded = (doc.pdfBytes?.byteLength ?? 0) - bytesBefore
        page.viewerOk = !!window.__pdfViewer.pdfDoc.value
        const after = await withTimeout(window.__pdfEngine.getTextBlocks(pageIndex), 30000, 'getTextBlocks after')
        // Read back against the whole page's text, not block by block: a
        // long replacement wraps or re-groups into several blocks.
        const pageText = norm(after.map(x => x.text).join(''))
        for (const e of page.edits) {
          if (!e.text) continue
          e.found = pageText.includes(norm(e.text))
          const drawn = after.find(x => norm(x.text).includes(norm(e.text)))
          e.font = drawn?.fontName || null
          try { e.ink = e.rect ? await inkFraction(p, e.rect) : null } catch (_) { e.ink = null }
        }
        // What the page SHOWS, not what it says. A scan face traced from a
        // misaligned glyph cut draws every letter as its neighbour, so the line
        // renders as nonsense while extraction still reads it back perfectly —
        // the failure a user reports as "I edited one character and it broke"
        // and that no text-level assertion here can see. Recognising the baked
        // page again is the only reading of the ink there is.
        try {
          page.reread = await rereadEdits(pageIndex, page.edits)
        } catch (err) { page.reread = { error: String(err?.message || err) } }
      } catch (err) {
        page.error = String(err?.message || err)
      }
    }
  } catch (err) {
    out.error = String(err?.message || err)
  }
  out.ms = Math.round(performance.now() - t0)
  return out
}

window.__ocrSweep = { runPdf }
