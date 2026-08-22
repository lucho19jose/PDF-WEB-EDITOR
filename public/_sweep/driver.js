/**
 * Sweep harness driver — runs inside the live app page.
 *
 * Exercises the editor's real code path (same worker, same matchers the UI
 * uses) and judges each operation on invariants that hold for EVERY generator:
 *
 *  - character preservation: an edit must change the target's characters and
 *    nothing else; a move must not change any characters at all.
 *  - scope: an operation must reposition the block it targeted and (almost)
 *    nothing else.
 *
 * Character histograms are used rather than block lists because MuPDF
 * legitimately re-groups blocks after an edit — two adjacent runs may merge, or
 * one may split. That is a presentation change, not corruption, and counting it
 * as a failure buries the real bugs in noise.
 */

const app = () => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
const store = (n) => app()._s.get(n)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const norm = (s) => (s || '').replace(/\s+/g, '')

/** Multiset of non-space characters across every block on the page. */
function charHist(blocks) {
  const h = new Map()
  for (const b of blocks) for (const c of norm(b.text)) h.set(c, (h.get(c) || 0) + 1)
  return h
}
function histAdd(h, text, sign) {
  const out = new Map(h)
  for (const c of norm(text)) {
    const v = (out.get(c) || 0) + sign
    if (v === 0) out.delete(c); else out.set(c, v)
  }
  return out
}
/** Total absolute difference between two histograms. */
function histDelta(a, b) {
  let d = 0
  for (const [k, v] of a) d += Math.abs(v - (b.get(k) || 0))
  for (const [k, v] of b) if (!a.has(k)) d += Math.abs(v)
  return d
}

function keyOf(b) { return `${b.text}@${Math.round(b.bbox[0])},${Math.round(b.bbox[1])}` }

/** Blocks present before but not after (position or text changed). */
function movedCount(before, after) {
  const seen = new Map()
  for (const b of after) { const k = keyOf(b); seen.set(k, (seen.get(k) || 0) + 1) }
  let n = 0
  for (const b of before) {
    const k = keyOf(b)
    if (seen.get(k)) seen.set(k, seen.get(k) - 1); else n++
  }
  return n
}

function nearest(blocks, bbox) {
  const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2
  let best = null, bestD = Infinity
  for (const b of blocks) {
    const d = Math.hypot((b.bbox[0] + b.bbox[2]) / 2 - cx, (b.bbox[1] + b.bbox[3]) / 2 - cy)
    if (d < bestD) { bestD = d; best = b }
  }
  return bestD < 40 ? best : null
}

/**
 * Load a PDF for experiments.
 *
 * `engineOnly` skips the viewer entirely. Going through the app's drop handler
 * also renders the page canvas and a thumbnail per page, which for a 173-page
 * book or a Visio diagram costs minutes and has nothing to do with the
 * content-stream behaviour under test. The visual-similarity check needs the
 * viewer, so it is only available when engineOnly is off.
 */
async function loadStaged(staged, { engineOnly = false } = {}, timeoutMs = 45000) {
  const doc = store('document')
  const res = await fetch('/_sweep/' + staged)
  const buf = await res.arrayBuffer()

  if (engineOnly) {
    const pages = await window.__pdfEngine.loadDocument(buf.slice(0))
    return { pages }
  }

  const dt = new DataTransfer()
  dt.items.add(new File([buf], staged, { type: 'application/pdf' }))
  const before = doc.pdfBytes
  document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  const t0 = performance.now()
  while (performance.now() - t0 < timeoutMs) {
    await sleep(200)
    if (doc.loaded && doc.pdfBytes && doc.pdfBytes !== before) break
  }
  await sleep(400)
  return { pages: doc.totalPages }
}

/** Blocks worth editing: real words, not stray punctuation or whitespace. */
function candidates(blocks, max) {
  const scored = blocks.map((b, i) => ({ b, i }))
    .filter(({ b }) => b.text && b.text.trim().length >= 4 && /[A-Za-z0-9]/.test(b.text))
  const step = Math.max(1, Math.floor(scored.length / max))
  const out = []
  for (let i = 0; i < scored.length && out.length < max; i += step) out.push(scored[i])
  return out
}

const RENDER_TIMEOUT_MS = 20000

/**
 * Rasterise a page, giving up after RENDER_TIMEOUT_MS.
 *
 * PDF.js needs over a minute on a Visio page built from 230 Form XObjects and
 * 464 q/Q pairs. That is a rendering-layer cost, not a content-stream one, but
 * without a bound it stalls the whole sweep on a single document.
 */
async function renderToImageData(pageNo) {
  const canvas = document.createElement('canvas')
  const r = await Promise.race([
    window.__pdfViewer.renderPage(canvas, pageNo).catch(() => null),
    new Promise(res => setTimeout(() => res('timeout'), RENDER_TIMEOUT_MS))
  ])
  if (!r || r === 'timeout') return r === 'timeout' ? 'timeout' : null
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height), w: canvas.width, h: canvas.height }
}

/** Fraction of pixels unchanged OUTSIDE the edited box — i.e. visual collateral. */
function similarityOutside(a, b, box) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return null
  const A = a.data.data, B = b.data.data
  let same = 0, total = 0
  for (let y = 0; y < a.h; y += 2) {
    const inRow = box && y >= box.y0 && y <= box.y1
    for (let x = 0; x < a.w; x += 2) {
      if (inRow && box && x >= box.x0 && x <= box.x1) continue
      const i = (y * a.w + x) * 4
      total++
      if (Math.abs(A[i] - B[i]) < 12 && Math.abs(A[i + 1] - B[i + 1]) < 12 && Math.abs(A[i + 2] - B[i + 2]) < 12) same++
    }
  }
  return total ? Math.round((same / total) * 10000) / 10000 : null
}

export async function runPdf(entry, opts = {}) {
  const engineOnly = !!opts.engineOnly
  const rec = { pdf_id: entry.pdf_id, staged: entry.staged, file: entry.file,
                experiments: [], notes: [], error: null }
  const engine = window.__pdfEngine

  try {
    const info = await loadStaged(entry.staged, { engineOnly })
    rec.pages = info.pages
    if (!info.pages) { rec.error = 'document did not load'; return rec }

    const size = await engine.getPageSize(0).catch(() => null)
    rec.page_size = size ? { w: Math.round(size.width), h: Math.round(size.height), rotation: size.rotation } : null
    const diag = size ? Math.hypot(size.width, size.height) : 1000

    let blocks0 = await engine.getTextBlocks(0)
    rec.blocks_page1 = blocks0.length
    if (!blocks0.length) { rec.notes.push('no text blocks on page 1'); return rec }

    // ---------- replace_text ----------
    let visualDone = false
    for (const { i } of candidates(blocks0, 4)) {
      const before = await engine.getTextBlocks(0)
      const target = before[i]
      if (!target) continue
      const marker = 'SWEEPMARK' + i
      const wantVisual = !engineOnly && !visualDone && rec.pages <= 40
      let baseImg = null
      if (wantVisual) {
        try { baseImg = await renderToImageData(1) } catch { baseImg = null }
        if (baseImg === 'timeout') { baseImg = null; rec.notes.push('render too slow for visual check') }
      }

      let r = null, err = null
      try { r = await engine.replaceText(0, target.id, marker) } catch (e) { err = String(e.message || e) }
      const after = await engine.getTextBlocks(0)

      // Characters everywhere else must be untouched.
      const expected = histAdd(histAdd(charHist(before), target.text, -1), marker, +1)
      const charDelta = histDelta(expected, charHist(after))
      const landed = after.some(b => norm(b.text) === marker)
      const scope = movedCount(before, after)
      const atTarget = nearest(after, target.bbox)

      const exp = {
        strategy: 'replace_text',
        internal_strategy: r?.strategy ?? null,
        substituted_font: r?.substitutedFont ?? null,
        block_index: i,
        original_text: target.text.slice(0, 60),
        observed_text: atTarget ? atTarget.text.slice(0, 60) : null,
        reported_success: !!r?.success,
        landed_exactly: landed,
        char_delta: charDelta,          // 0 = nothing but the target changed
        blocks_touched: scope,
        block_count_delta: after.length - before.length,
        success: !!r?.success && landed && charDelta === 0,
        error: err || (r && !r.success ? (engine.error?.value ?? 'failed') : null),
        visual_similarity: null,
        geometry_error: null
      }

      if (wantVisual && baseImg && exp.reported_success) {
        try {
          const saved = await engine.saveDocument()
          await window.__pdfViewer.reloadDocument(new Uint8Array(saved))
          const afterImg = await renderToImageData(1)
          if (afterImg === 'timeout') throw new Error('render timeout')
          const scale = baseImg.w / (size?.width || 1)
          exp.visual_similarity = similarityOutside(baseImg, afterImg, {
            x0: Math.floor(target.bbox[0] * scale) - 4, x1: Math.ceil(target.bbox[2] * scale) + 4,
            y0: Math.floor(target.bbox[1] * scale) - 4, y1: Math.ceil(target.bbox[3] * scale) + 4
          })
          await engine.loadDocument(saved)
          visualDone = true
        } catch (e) { rec.notes.push('visual: ' + String(e.message || e).slice(0, 60)) }
      }
      rec.experiments.push(exp)
    }

    // ---------- transform_move ----------
    await loadStaged(entry.staged, { engineOnly })
    blocks0 = await engine.getTextBlocks(0)
    const DX = 20, DY = -20 // 20pt right, 20pt down in page coords
    for (const { i } of candidates(blocks0, 3)) {
      const before = await engine.getTextBlocks(0)
      const target = before[i]
      if (!target) continue
      let ok = false, err = null
      try { ok = await engine.transformTextBlock(0, target.id, DX, DY, 1, 1, 0, 0) } catch (e) { err = String(e.message || e) }
      const after = await engine.getTextBlocks(0)

      // A move must not change a single character anywhere.
      const charDelta = histDelta(charHist(before), charHist(after))
      // Resolve the moved copy by proximity to where it was ASKED to go —
      // the same string can occur many times on a page.
      const expX = target.bbox[0] + DX, expY = target.bbox[1] - DY
      const same = after.filter(b => b.text === target.text)
      const landedBlock = same.length
        ? same.reduce((best, b) => Math.hypot(b.bbox[0] - expX, b.bbox[1] - expY) <
            Math.hypot(best.bbox[0] - expX, best.bbox[1] - expY) ? b : best)
        : null
      const geometryError = landedBlock
        ? Math.round((Math.hypot(landedBlock.bbox[0] - expX, landedBlock.bbox[1] - expY) / diag) * 10000) / 10000
        : null
      const scope = movedCount(before, after)

      rec.experiments.push({
        strategy: 'transform_move',
        internal_strategy: engine.lastTransform?.value?.strategy ?? null,
        clip_adjusted: engine.lastTransform?.value?.clipAdjusted ?? null,
        block_index: i,
        original_text: target.text.slice(0, 60),
        observed_text: null,
        reported_success: ok,
        vanished: !landedBlock,
        char_delta: charDelta,      // must be 0 — a move creates no new text
        blocks_touched: scope,      // should be ~1; large = dragged its neighbours
        block_count_delta: after.length - before.length,
        geometry_error: geometryError,
        // Landed where asked, changed no characters, and did not drag the page.
        success: !!(ok && landedBlock && geometryError !== null &&
                    geometryError * diag < 6 && charDelta === 0 && scope <= 3),
        visual_similarity: null,
        error: err || (!ok ? (engine.error?.value ?? 'failed') : null)
      })
    }

    const per = {}
    for (const e of rec.experiments) {
      per[e.strategy] ??= { runs: 0, ok: 0 }
      per[e.strategy].runs++
      if (e.success) per[e.strategy].ok++
    }
    rec.summary = per
    let best = null
    for (const [k, v] of Object.entries(per)) {
      const rate = v.runs ? v.ok / v.runs : 0
      if (!best || rate > best.rate) best = { strategy: k, rate }
    }
    rec.best_strategy = best && best.rate > 0 ? best.strategy : null
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 300)
  }
  return rec
}

window.__sweep = { runPdf }
