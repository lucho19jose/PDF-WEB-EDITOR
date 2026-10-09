/**
 * Realistic-operation sweep over EVERY page of ONE document.
 *
 * `sweep-real.mjs` samples the first two pages of many documents. A long
 * compilation — a fund request that binds an Excel invoice, Word reports, a
 * scanned delivery note, CAD sheets and photo panels, each signed and stamped
 * page by page — has a different producer every few pages, so its later pages
 * are untested by any corpus sweep. This runs the same judged operations on
 * each page in turn, a fresh document before every one:
 *
 *   same   — every letter/digit shifted by one (same length, same classes)
 *   delete — the block emptied ("")
 *   append — " ok" added at the end
 *   resize — 1.25x about the block's bottom-left corner
 *   recolor— fill colour red
 *   move   — 10pt right, 3pt down
 *
 *   node tools/pdf-sweep/sweep-doc.mjs <pdf> out.json [firstPage] [lastPage] [perPage]
 *
 * SKIP (a regex) leaves out blocks whose text matches it — a signing
 * service's ID strip, drawn once per signing pass, extracts as a shuffle.
 */
import fs from 'fs'
import { createEngine, ROOT } from './node-harness.mjs'

const [file, out = 'sweep-doc-out.json', firstArg, lastArg, perArg] = process.argv.slice(2)
if (!file) { console.error('usage: sweep-doc.mjs <pdf> out.json [first] [last] [perPage]'); process.exit(1) }
const perPage = Number(perArg ?? 2)
const skip = process.env.SKIP ? new RegExp(process.env.SKIP) : null
const kinds = (process.env.KINDS || 'same,delete,append,resize,recolor,move').split(',')
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (typeof url === 'string' && url.startsWith('/fonts/')) {
    const b = fs.readFileSync(ROOT + '/public' + url)
    return new Response(b, { status: 200 })
  }
  return realFetch(url, init)
}
const eng = await createEngine()
const log = console.log
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
function shifted(text) {
  return text.replace(/[A-Za-z0-9]/g, (c) => {
    if (c >= '0' && c <= '9') return c === '9' ? '0' : String.fromCharCode(c.charCodeAt(0) + 1)
    if (c >= 'a' && c <= 'z') return c === 'z' ? 'a' : String.fromCharCode(c.charCodeAt(0) + 1)
    return c === 'Z' ? 'A' : String.fromCharCode(c.charCodeAt(0) + 1)
  })
}
function candidates(blocks, max) {
  const scored = blocks.map((b, i) => ({ b, i })).filter(({ b }) =>
    b.text && b.text.trim().length >= 3 && /[A-Za-z0-9]/.test(b.text) && !b.invisible && !(skip && skip.test(b.text)))
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
    kind, page, block_index: i, internal_strategy: r?.strategy ?? null, substituted_font: r?.substitutedFont ?? null,
    font: target.fontName, original_text: target.text.slice(0, 70), new_text: newText.slice(0, 70),
    observed_text: atTarget ? atTarget.text.slice(0, 70) : null,
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
    kind: 'resize', page, block_index: i, internal_strategy: r?.strategy ?? null, font: target.fontName, original_text: target.text.slice(0, 70),
    reported_success: ok, vanished: !landed, char_delta: charDelta, blocks_touched: movedCount(before, after),
    size_ratio: sizeRatio === null ? null : Math.round(sizeRatio * 100) / 100,
    geometry_error: landed ? Math.round(Math.hypot(landed.bbox[0] - target.bbox[0], landed.bbox[3] - target.bbox[3]) * 10) / 10 : null,
    success: ok && !!landed && charDelta === 0 && sizeRatio !== null && Math.abs(sizeRatio - S) < 0.08 && movedCount(before, after) <= 3,
    // A refusal that names a reason (the paper's edge, a shared block) is the
    // engine being honest, not a defect; kept apart so triage can tell.
    refused: !ok,
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
  // A space-only block turning red shows nothing; only visible glyphs count.
  const isRed = (b) => b.color[0] > 0.9 && b.color[1] < 0.1 && b.color[2] < 0.1 && /\S/.test(b.text)
  const red = at ? isRed(at) : false
  const collateral = Math.max(0, after.filter(isRed).length - before.filter(isRed).length - (red ? 1 : 0))
  return {
    kind: 'recolor', page, block_index: i, font: target.fontName, original_text: target.text.slice(0, 70),
    reported_success: ok, vanished: !at, recolored: red, red_collateral: collateral, char_delta: charDelta, blocks_touched: movedCount(before, after),
    success: ok && !!at && red && collateral === 0 && charDelta === 0 && movedCount(before, after) <= 2,
    error: err || (!ok ? (res?.error || 'failed') : null),
  }
}

async function moveExperiment(page, i) {
  const before = await blocksOf(page)
  const target = before[i]; if (!target) return null
  const DX = 10, DY = -3
  let r = null, err = null
  try { r = await eng.send('transformTextBlock', { pageIndex: page, blockId: target.id, dx: DX, dy: DY, sx: 1, sy: 1, anchorX: 0, anchorY: 0 }) } catch (e) { err = String(e.message || e) }
  const after = await blocksOf(page)
  const charDelta = histDelta(charHist(before), charHist(after))
  const expX = target.bbox[0] + DX, expY = target.bbox[1] - DY
  const same = after.filter(b => norm(b.text) === norm(target.text))
  const landed = same.length ? same.reduce((a, b) => Math.hypot(b.bbox[0] - expX, b.bbox[1] - expY) < Math.hypot(a.bbox[0] - expX, a.bbox[1] - expY) ? b : a) : null
  const geo = landed ? Math.round(Math.hypot(landed.bbox[0] - expX, landed.bbox[1] - expY) * 10) / 10 : null
  const ok = !!r?.success
  return {
    kind: 'move', page, block_index: i, internal_strategy: r?.strategy ?? null, font: target.fontName, original_text: target.text.slice(0, 70),
    reported_success: ok, vanished: !landed, char_delta: charDelta, blocks_touched: movedCount(before, after), geometry_error: geo,
    success: ok && !!landed && geo !== null && geo < 6 && charDelta === 0 && movedCount(before, after) <= 3,
    refused: !ok,
    error: err || (!ok ? (r?.error || 'failed') : null),
  }
}

const load = async () => (await eng.load(file)).pageCount
const pageCount = await load()
const first = Number(firstArg ?? 0)
const last = Math.min(pageCount - 1, lastArg !== undefined ? Number(lastArg) : pageCount - 1)
const results = []
const t00 = Date.now()
for (let p = first; p <= last; p++) {
  const t0 = Date.now()
  const rec = { page: p, experiments: [], error: null }
  try {
    await load()
    const b0 = await blocksOf(p)
    const picks = candidates(b0, perPage).map(c => c.i)
    rec.blocks = b0.length
    const run = async (kind, fn) => { if (!kinds.includes(kind)) return; for (const i of picks) { await load(); try { const e = await fn(i); if (e) rec.experiments.push(e) } catch (err) { rec.experiments.push({ kind, page: p, block_index: i, success: false, error: 'THROW ' + String(err?.message || err).slice(0, 200) }) } } }
    await run('same', i => editExperiment('same', p, i, shifted))
    await run('delete', i => editExperiment('delete', p, i, () => ''))
    await run('append', i => editExperiment('append', p, i, t => t.replace(/\s+$/, '') + ' ok'))
    await run('resize', i => resizeExperiment(p, i))
    await run('recolor', i => recolorExperiment(p, i))
    await run('move', i => moveExperiment(p, i))
  } catch (e) { rec.error = String(e.message || e).slice(0, 300) }
  results.push(rec)
  const ok = rec.experiments.filter(e => e.success).length
  process.stderr.write(`p${p} ${rec.experiments.length}/${ok} ${rec.error ? 'ERR ' + rec.error.slice(0, 60) : ''} ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
  fs.writeFileSync(out, JSON.stringify(results))
}
const tot = results.reduce((a, r) => a + r.experiments.length, 0)
const okc = results.reduce((a, r) => a + r.experiments.filter(e => e.success).length, 0)
process.stderr.write(`TOTAL ${tot}/${okc} in ${((Date.now() - t00) / 1000).toFixed(0)}s\n`)
log('done')
await eng.close()
process.exit(0)
