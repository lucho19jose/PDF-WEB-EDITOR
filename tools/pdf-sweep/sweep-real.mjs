/**
 * Realistic-operation sweep on the node harness.
 *
 * The marker sweep (`sweep-node.mjs`) replaces a target with "SWEEPMARKn",
 * which is wider than most table cells; at this point nearly every remaining
 * failure there is the marker overflowing a neighbour. This sweep exercises
 * the operations a person actually performs, each sized to what it replaces:
 *
 *   same   — every letter/digit shifted by one (same length, same classes)
 *   delete — the block emptied ("")
 *   append — one short word added at the end
 *   resize — scaled 1.25x about the block's bottom-left corner
 *   recolor— fill colour changed to red (restyle)
 *   page2  — the `same` edit on page 2, when the document has one
 *
 * Judged the way the marker sweep judges: the page's character multiset must
 * change by exactly the target, the new text must be found as a block, and a
 * move/resize must change no characters.
 *
 *   node tools/pdf-sweep/sweep-real.mjs out.json
 *   SWEEP_MANIFEST=public/_sweep/r3/manifest.json node tools/pdf-sweep/sweep-real.mjs out.json
 *   ONLY=r3/012.pdf node tools/pdf-sweep/sweep-real.mjs out.json
 */
import fs from 'fs'
import { createEngine, ROOT } from './node-harness.mjs'

const out = process.argv[2] || 'sweep-real-out.json'
const only = process.env.ONLY
const eng = await createEngine()
console.log = () => {}; console.warn = () => {}; console.error = () => {}

const norm = (s) => (s || '').replace(/\s+/g, '')
function charHist(blocks) { const h = new Map(); for (const b of blocks) for (const c of norm(b.text)) h.set(c, (h.get(c) || 0) + 1); return h }
function histAdd(h, text, sign) { const o = new Map(h); for (const c of norm(text)) { const v = (o.get(c) || 0) + sign; if (v === 0) o.delete(c); else o.set(c, v) } return o }
function histDelta(a, b) { let d = 0; for (const [k, v] of a) d += Math.abs(v - (b.get(k) || 0)); for (const [k, v] of b) if (!a.has(k)) d += Math.abs(v); return d }
function keyOf(b) { return `${b.text}@${Math.round(b.bbox[0])},${Math.round(b.bbox[1])}` }
function movedCount(before, after) {
  const seen = new Map(); for (const b of after) { const k = keyOf(b); seen.set(k, (seen.get(k) || 0) + 1) }
  let n = 0; for (const b of before) { const k = keyOf(b); if (seen.get(k)) seen.set(k, seen.get(k) - 1); else n++ }
  return n
}
function nearest(blocks, bbox) {
  const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2
  let best = null, bestD = Infinity
  for (const b of blocks) { const d = Math.hypot((b.bbox[0] + b.bbox[2]) / 2 - cx, (b.bbox[1] + b.bbox[3]) / 2 - cy); if (d < bestD) { bestD = d; best = b } }
  return bestD < 40 ? best : null
}
/** Shift every letter and digit by one, keeping case and class. Width stays about the same. */
function shifted(text) {
  return text.replace(/[A-Za-z0-9]/g, (c) => {
    if (c >= '0' && c <= '9') return c === '9' ? '0' : String.fromCharCode(c.charCodeAt(0) + 1)
    if (c >= 'a' && c <= 'z') return c === 'z' ? 'a' : String.fromCharCode(c.charCodeAt(0) + 1)
    return c === 'Z' ? 'A' : String.fromCharCode(c.charCodeAt(0) + 1)
  })
}
function candidates(blocks, max) {
  const scored = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.text && b.text.trim().length >= 4 && /[A-Za-z0-9]/.test(b.text) && !b.invisible)
  const step = Math.max(1, Math.floor(scored.length / max))
  const o = []; for (let i = 0; i < scored.length && o.length < max; i += step) o.push(scored[i]); return o
}
const blocksOf = async (p) => (await eng.send('getPageText', { pageIndex: p })).blocks

async function editExperiment(kind, page, i, makeText) {
  const before = await blocksOf(page)
  const target = before[i]; if (!target) return null
  const newText = makeText(target.text)
  let r = null, err = null
  try { r = await eng.send('replaceText', { pageIndex: page, blockId: target.id, newText }) } catch (e) { err = String(e.message || e) }
  const after = await blocksOf(page)
  const expected = histAdd(histAdd(charHist(before), target.text, -1), newText, +1)
  const charDelta = histDelta(expected, charHist(after))
  const want = norm(newText)
  const landed = want ? after.some(b => norm(b.text) === want) : !after.some(b => Math.abs(b.bbox[0] - target.bbox[0]) < 2 && Math.abs(b.bbox[1] - target.bbox[1]) < 2 && norm(b.text) === norm(target.text))
  const atTarget = nearest(after, target.bbox)
  return {
    strategy: kind, page, internal_strategy: r?.strategy ?? null, substituted_font: r?.substitutedFont ?? null,
    block_index: i, original_text: target.text.slice(0, 60), new_text: newText.slice(0, 60),
    observed_text: atTarget ? atTarget.text.slice(0, 60) : null,
    reported_success: !!r?.success, landed_exactly: landed, char_delta: charDelta,
    blocks_touched: movedCount(before, after), block_count_delta: after.length - before.length,
    success: !!r?.success && landed && charDelta === 0,
    error: err || (r && !r.success ? (r.error || 'failed') : null),
  }
}

async function resizeExperiment(page, i) {
  const before = await blocksOf(page)
  const target = before[i]; if (!target) return null
  const S = 1.25
  // Anchors are in Tm space (bottom-left origin, y up); bbox is top-left.
  const ph = (await eng.send('getPageSize', { pageIndex: page })).height
  let r = null, err = null
  try { r = await eng.send('transformTextBlock', { pageIndex: page, blockId: target.id, dx: 0, dy: 0, sx: S, sy: S, anchorX: target.bbox[0], anchorY: ph - target.bbox[3] }) } catch (e) { err = String(e.message || e) }
  const after = await blocksOf(page)
  const charDelta = histDelta(charHist(before), charHist(after))
  const same = after.filter(b => norm(b.text) === norm(target.text))
  const landed = same.length ? same.reduce((a, b) => Math.hypot(b.bbox[0] - target.bbox[0], b.bbox[3] - target.bbox[3]) < Math.hypot(a.bbox[0] - target.bbox[0], a.bbox[3] - target.bbox[3]) ? b : a) : null
  const sizeRatio = landed ? landed.fontSize / (target.fontSize || 1) : null
  const ok = !!r?.success
  return {
    strategy: 'resize', page, internal_strategy: r?.strategy ?? null, block_index: i, original_text: target.text.slice(0, 60),
    reported_success: ok, vanished: !landed, char_delta: charDelta, blocks_touched: movedCount(before, after),
    size_ratio: sizeRatio === null ? null : Math.round(sizeRatio * 100) / 100,
    geometry_error: landed ? Math.round(Math.hypot(landed.bbox[0] - target.bbox[0], landed.bbox[3] - target.bbox[3]) * 10) / 10 : null,
    success: ok && !!landed && charDelta === 0 && sizeRatio !== null && Math.abs(sizeRatio - S) < 0.08 && movedCount(before, after) <= 3,
    error: err || (!ok ? (r?.error || 'failed') : null),
  }
}

async function recolorExperiment(page, i) {
  const before = await blocksOf(page)
  const target = before[i]; if (!target) return null
  let r = null, err = null
  try { r = await eng.send('restyleTextBlocks', { pageIndex: page, ops: [{ blockId: target.id, color: [1, 0, 0] }] }) } catch (e) { err = String(e.message || e) }
  const after = await blocksOf(page)
  const charDelta = histDelta(charHist(before), charHist(after))
  const res = r?.results?.[0]
  const ok = !!res?.success
  const at = after.find(b => norm(b.text) === norm(target.text) && Math.abs(b.bbox[0] - target.bbox[0]) < 3 && Math.abs(b.bbox[1] - target.bbox[1]) < 3)
  const isRed = (b) => b.color[0] > 0.9 && b.color[1] < 0.1 && b.color[2] < 0.1
  const red = at ? isRed(at) : false
  // Blocks OTHER than the target that turned red: a colour change scoped to
  // the block that merely CONTAINS the target recolours a whole table row.
  const redBefore = before.filter(isRed).length
  const redAfter = after.filter(isRed).length
  const collateral = Math.max(0, redAfter - redBefore - (red ? 1 : 0))
  return {
    strategy: 'recolor', page, block_index: i, original_text: target.text.slice(0, 60),
    reported_success: ok, vanished: !at, recolored: red, red_collateral: collateral, char_delta: charDelta, blocks_touched: movedCount(before, after),
    success: ok && !!at && red && collateral === 0 && charDelta === 0 && movedCount(before, after) <= 2,
    error: err || (!ok ? (res?.error || 'failed') : null),
  }
}

async function runPdf(m) {
  const rec = { pdf_id: m.pdf_id, staged: m.staged, file: m.file, experiments: [], error: null }
  const file = ROOT + '/public/_sweep/' + m.staged
  const load = async () => { const r = await eng.load(file); return r.pageCount }
  try {
    const pages = await load()
    rec.pages = pages
    if (!pages) { rec.error = 'document did not load'; return rec }
    const b0 = await blocksOf(0)
    if (!b0.length) { rec.notes = ['no text blocks on page 1']; return rec }
    const picks = candidates(b0, 4).map(c => c.i)
    // A fresh document before EVERY experiment: a delete removes a block and
    // renumbers the ones after it, and an edit that wraps adds one, so a
    // sequence run on one document edits the wrong block from the second
    // operation on.
    for (const i of picks) { await load(); const e = await editExperiment('same', 0, i, shifted); if (e) rec.experiments.push(e) }
    for (const i of picks.slice(0, 3)) { await load(); const e = await editExperiment('delete', 0, i, () => ''); if (e) rec.experiments.push(e) }
    for (const i of picks.slice(0, 3)) { await load(); const e = await editExperiment('append', 0, i, (t) => t.replace(/\s+$/, '') + ' ok'); if (e) rec.experiments.push(e) }
    for (const i of picks.slice(0, 3)) { await load(); const e = await resizeExperiment(0, i); if (e) rec.experiments.push(e) }
    for (const i of picks.slice(0, 3)) { await load(); const e = await recolorExperiment(0, i); if (e) rec.experiments.push(e) }
    if (pages > 1) {
      await load()
      const b1 = await blocksOf(1)
      const p1 = candidates(b1, 2).map(c => c.i)
      for (const i of p1) { await load(); const e = await editExperiment('same', 1, i, shifted); if (e) { e.strategy = 'page2'; rec.experiments.push(e) } }
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
  process.stderr.write(`${m.staged} ${rec.experiments.length}/${ok} ${rec.error ? 'ERR ' + rec.error.slice(0, 60) : ''} ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
  fs.writeFileSync(out, JSON.stringify(results))
}
const tot = results.reduce((a, r) => a + r.experiments.length, 0)
const okc = results.reduce((a, r) => a + r.experiments.filter(e => e.success).length, 0)
process.stderr.write(`TOTAL ${tot}/${okc}\n`)
await eng.close()
process.exit(0)
