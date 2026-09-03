/**
 * Run `public/_sweep/driver.js` (engine-only) on the node harness.
 *
 *   node tools/pdf-sweep/sweep-node.mjs out.json
 *   PDF_ROOT=C:/path/to/baseline-worktree node tools/pdf-sweep/sweep-node.mjs base.json
 *   node tools/pdf-sweep/compare-sweeps.mjs base.json out.json
 *
 * The driver is written for the app page; the handful of browser objects it
 * touches (`window.__pdfEngine`, the pinia lookup, `fetch('/_sweep/…')`) are
 * shimmed here. Visual similarity is not measured (no viewer), which the
 * driver already tolerates in engineOnly mode.
 */
import fs from 'fs'
import { pathToFileURL } from 'url'
import { createEngine, ROOT } from './node-harness.mjs'

const out = process.argv[2] || 'sweep-out.json'
const eng = await createEngine()
const error = { value: null }, lastTransform = { value: {} }
const shim = {
  error, lastTransform,
  async loadDocument(buf) {
    error.value = null
    const r = await eng.send('loadDocument', { bytes: buf.slice(0) })
    return r.pageCount
  },
  async getPageSize(p) { return eng.send('getPageSize', { pageIndex: p }) },
  async getTextBlocks(p) { return (await eng.send('getPageText', { pageIndex: p })).blocks },
  async replaceText(p, id, t) {
    const r = await eng.send('replaceText', { pageIndex: p, blockId: id, newText: t })
    if (!r.success) error.value = r.error || 'failed'
    return r
  },
  async transformTextBlock(p, id, dx, dy, sx, sy, ax, ay) {
    const r = await eng.send('transformTextBlock', { pageIndex: p, blockId: id, dx, dy, sx, sy, anchorX: ax, anchorY: ay })
    lastTransform.value = { strategy: r.strategy, clipAdjusted: r.clipAdjusted }
    if (!r.success) error.value = r.error || 'failed'
    return r.success
  },
  async saveDocument() { const r = await eng.send('saveDocument', {}); return r.bytes || r },
}
globalThis.window = { __pdfEngine: shim }
globalThis.document = {
  querySelector: () => ({ __vue_app__: { config: { globalProperties: { $pinia: { _s: new Map([['document', {}]]) } } } } }),
}
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  if (typeof url === 'string' && url.startsWith('/_sweep/')) {
    const b = fs.readFileSync(ROOT + '/public' + url)
    return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
  }
  return realFetch(url)
}

const { runPdf } = await import(pathToFileURL(ROOT + '/public/_sweep/driver.js').href)
// SWEEP_MANIFEST points at another round's manifest (entries' `staged` paths
// are relative to public/_sweep, e.g. "r2/007.pdf").
const manifest = JSON.parse(fs.readFileSync(process.env.SWEEP_MANIFEST || (ROOT + '/public/_sweep/manifest.json'), 'utf8').replace(/^\uFEFF/, ''))
const results = []
console.log = () => {}; console.warn = () => {}; console.error = () => {}
for (const m of manifest) {
  const t0 = Date.now()
  let rec
  try {
    rec = await Promise.race([
      runPdf(m, { engineOnly: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 180000)),
    ])
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
