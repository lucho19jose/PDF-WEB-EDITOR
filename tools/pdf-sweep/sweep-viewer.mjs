/**
 * Viewer-agreement sweep: every edit is SAVED and the saved bytes read back by
 * pdf.js, not by MuPDF.
 *
 * MuPDF is tolerant — it draws past an unknown operator and reports a page
 * that pdf.js may refuse or render differently. The `T*20.0115` token that
 * silently shifted every later line (an injected `Td` with no space before
 * it) is the shape this catches: pdf.js logs a warning for a malformed
 * operator and drops or misplaces what follows. For each document, page 1
 * gets a same-width edit, a delete and a resize, each saved and checked:
 *
 *   - pdf.js parses the page (getOperatorList) with no warnings it did not
 *     already log for the untouched page;
 *   - its text content carries the new text and no longer the old;
 *   - the operator count moved by a plausible amount.
 *
 *   node tools/pdf-sweep/sweep-viewer.mjs out.json
 *   SWEEP_MANIFEST=public/_sweep/r3/manifest.json node tools/pdf-sweep/sweep-viewer.mjs out.json
 */
import fs from 'fs'
import { createEngine, ROOT } from './node-harness.mjs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const out = process.argv[2] || 'sweep-viewer-out.json'
const only = process.env.ONLY
const eng = await createEngine()
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (typeof url === 'string' && url.startsWith('/fonts/')) return new Response(fs.readFileSync(ROOT + '/public' + url), { status: 200 })
  return realFetch(url, init)
}
const origLog = console.log, origWarn = console.warn, origErr = console.error
let captured = []
const capture = (on) => {
  if (on) {
    console.log = (...a) => captured.push(a.join(' ')); console.warn = console.log; console.error = console.log
  } else { console.log = () => {}; console.warn = () => {}; console.error = () => {} }
}
capture(false)

const norm = (s) => (s || '').replace(/\s+/g, '')
const fold = (s) => norm(s).toLowerCase()
function shifted(text) {
  return text.replace(/[A-Za-z0-9]/g, (c) => (c >= '0' && c <= '9') ? (c === '9' ? '0' : String.fromCharCode(c.charCodeAt(0) + 1)) : (c >= 'a' && c <= 'z') ? (c === 'z' ? 'a' : String.fromCharCode(c.charCodeAt(0) + 1)) : (c === 'Z' ? 'A' : String.fromCharCode(c.charCodeAt(0) + 1)))
}
function candidates(blocks, max) {
  const scored = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.text && b.text.trim().length >= 6 && /[A-Za-z]/.test(b.text) && !b.invisible)
  const step = Math.max(1, Math.floor(scored.length / max))
  const o = []; for (let i = 0; i < scored.length && o.length < max; i += step) o.push(scored[i]); return o
}
const blocksOf = async (p) => (await eng.send('getPageText', { pageIndex: p })).blocks

/** pdf.js view of page 1 of `bytes`: warnings, operator count, text. */
async function viewerRead(bytes) {
  captured = []
  capture(true)
  let result
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 1, isEvalSupported: false, standardFontDataUrl: ROOT + '/public/pdfjs/standard_fonts/', cMapUrl: ROOT + '/public/pdfjs/cmaps/', cMapPacked: true, wasmUrl: ROOT + '/public/pdfjs/wasm/', iccUrl: ROOT + '/public/pdfjs/iccs/' }).promise
    const page = await doc.getPage(1)
    const ops = await Promise.race([page.getOperatorList(), new Promise((_, rej) => setTimeout(() => rej(new Error('ops timeout')), 30000))])
    const tc = await Promise.race([page.getTextContent(), new Promise((_, rej) => setTimeout(() => rej(new Error('text timeout')), 30000))])
    const text = tc.items.map(i => i.str ?? '').join(' ')
    result = { ops: ops.fnArray.length, text, warnings: captured.filter(l => /warn|error|unknown|invalid|unsupported/i.test(l)).map(l => l.slice(0, 160)) }
    await doc.destroy()
  } catch (e) {
    result = { error: String(e.message || e).slice(0, 200), warnings: captured.filter(l => /warn|error|unknown|invalid/i.test(l)).map(l => l.slice(0, 160)) }
  } finally { capture(false) }
  return result
}

async function runPdf(m) {
  const rec = { pdf_id: m.pdf_id, staged: m.staged, file: m.file, experiments: [], error: null }
  const file = ROOT + '/public/_sweep/' + m.staged
  const load = async () => (await eng.load(file)).pageCount
  try {
    const pages = await load()
    if (!pages) { rec.error = 'document did not load'; return rec }
    const original = fs.readFileSync(file)
    const base = await viewerRead(original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength))
    rec.base = { ops: base.ops, warnings: base.warnings?.length ?? null, error: base.error ?? null, textLen: base.text?.length ?? null }
    if (base.error) return rec
    const baseWarn = new Set(base.warnings)
    const b0 = await blocksOf(0)
    if (!b0.length) { rec.notes = ['no text on page 1']; return rec }
    const picks = candidates(b0, 2).map(c => c.i)
    const ph = (await eng.send('getPageSize', { pageIndex: 0 })).height
    const kinds = [
      ['same', (t) => shifted(t)],
      ['delete', () => ''],
    ]
    for (const i of picks) {
      for (const [kind, make] of kinds) {
        await load()
        const before = await blocksOf(0)
        const target = before[i]; if (!target) continue
        const newText = make(target.text)
        let r = null, err = null
        try { r = await eng.send('replaceText', { pageIndex: 0, blockId: target.id, newText }) } catch (e) { err = String(e.message || e) }
        if (!r?.success) { rec.experiments.push({ kind, block_index: i, original_text: target.text.slice(0, 60), refused: true, error: err || r?.error || null, success: null }); continue }
        const saved = await eng.send('saveDocument', {})
        const bytes = saved.bytes || saved
        const v = await viewerRead(bytes)
        const newWarnings = (v.warnings || []).filter(w => !baseWarn.has(w))
        const tFold = fold(v.text || '')
        // pdf.js reads some fonts differently from MuPDF (a Tahoma without a
        // ToUnicode, a TCPDF form its text extraction throws on): where the
        // UNTOUCHED page does not read the old text either, nothing about this
        // edit can be judged from the text, only from the warnings.
        const readable = fold(base.text || '').includes(fold(target.text)) && fold(target.text).length >= 4
        const hasNew = !readable || kind === 'delete' ? true : tFold.includes(fold(newText))
        // The old text may occur elsewhere on the page: one occurrence fewer is what a delete leaves.
        const countIn = (hay, needle) => needle.length < 4 ? 0 : hay.split(needle).length - 1
        const oldGone = kind === 'delete' && readable
          ? countIn(tFold, fold(target.text)) < countIn(fold(base.text || ''), fold(target.text))
          : true
        rec.experiments.push({
          kind, block_index: i, original_text: target.text.slice(0, 60), new_text: newText.slice(0, 60),
          internal_strategy: r.strategy ?? null, substituted_font: r.substitutedFont ?? null,
          viewer_error: v.error ?? null, viewer_ops: v.ops ?? null, base_ops: base.ops,
          new_warnings: newWarnings.slice(0, 5), has_new: hasNew, old_gone: oldGone,
          success: !v.error && newWarnings.length === 0 && hasNew && oldGone,
        })
      }
      // resize 1.25x
      await load()
      const before = await blocksOf(0)
      const target = before[i]; if (!target) continue
      let r = null
      try { r = await eng.send('transformTextBlock', { pageIndex: 0, blockId: target.id, dx: 0, dy: 0, sx: 1.25, sy: 1.25, anchorX: target.bbox[0], anchorY: ph - target.bbox[3] }) } catch (e) { r = { success: false, error: String(e.message || e) } }
      if (!r?.success) { rec.experiments.push({ kind: 'resize', block_index: i, original_text: target.text.slice(0, 60), refused: true, error: r?.error || null, success: null }); continue }
      const saved = await eng.send('saveDocument', {})
      const v = await viewerRead(saved.bytes || saved)
      const newWarnings = (v.warnings || []).filter(w => !baseWarn.has(w))
      const tFold = fold(v.text || '')
      rec.experiments.push({
        kind: 'resize', block_index: i, original_text: target.text.slice(0, 60), internal_strategy: r.strategy ?? null,
        viewer_error: v.error ?? null, viewer_ops: v.ops ?? null, base_ops: base.ops, new_warnings: newWarnings.slice(0, 5),
        // A quarter bigger, a wide line runs off the page and pdf.js drops the
        // glyphs past the edge: the leading 70% is what a resize must keep.
        has_text: (() => { const t = fold(target.text); const readable = fold(base.text || '').includes(t) && t.length >= 4; return !readable || tFold.includes(t.slice(0, Math.max(4, Math.floor(t.length * 0.7)))) })(),
        success: !v.error && newWarnings.length === 0 && (() => { const t = fold(target.text); const readable = fold(base.text || '').includes(t) && t.length >= 4; return !readable || tFold.includes(t.slice(0, Math.max(4, Math.floor(t.length * 0.7)))) })(),
      })
    }
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 300)
  }
  return rec
}

const manifest = JSON.parse(fs.readFileSync(process.env.SWEEP_MANIFEST || (ROOT + '/public/_sweep/manifest.json'), 'utf8').replace(/^﻿/, ''))
const results = []
for (const m of manifest) {
  if (only && m.staged !== only) continue
  const t0 = Date.now()
  let rec
  try {
    rec = await Promise.race([runPdf(m), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 240000))])
  } catch (e) {
    rec = { pdf_id: m.pdf_id, staged: m.staged, file: m.file, experiments: [], error: String(e.message || e) }
  }
  results.push(rec)
  const ok = rec.experiments.filter(e => e.success).length
  const judged = rec.experiments.filter(e => e.success !== null).length
  process.stderr.write(`${m.staged} ${judged}/${ok} ${rec.error ? 'ERR ' + rec.error.slice(0, 60) : ''} ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
  fs.writeFileSync(out, JSON.stringify(results))
}
const tot = results.reduce((a, r) => a + r.experiments.filter(e => e.success !== null).length, 0)
const okc = results.reduce((a, r) => a + r.experiments.filter(e => e.success).length, 0)
process.stderr.write(`TOTAL ${tot}/${okc}\n`)
await eng.close()
process.exit(0)
