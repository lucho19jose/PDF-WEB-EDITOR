/**
 * Deskew survey — what levelling a scan before recognition (src/utils/ocr/deskew.ts)
 * does to PaddleOCR on real pages, in node, with the app's own models.
 *
 *   node tools/ocr-calibrate/deskew-survey.mjs [--compare] [--pages N] <pdf | dir>...
 *
 * For every page that is a scan (images cover 85% of it) it prints the skew
 * `estimateSkew` finds on a 220 DPI render, or "level". With --compare, each
 * page the app would level is recognised twice — as scanned and levelled —
 * and the line count and mean confidence of both are printed, so a change to
 * the estimate can be judged on what it does to the reading, not on the angle.
 *
 * The PDFs are read as data (MuPDF); nothing in their folders is executed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')
const mupdf = await import(pathToFileURL(ROOT + '/node_modules/mupdf/dist/mupdf.js').href)
const { createServer } = await import(pathToFileURL(ROOT + '/node_modules/vite/dist/node/index.js').href)
const server = await createServer({
  root: ROOT, configFile: ROOT + '/vite.config.ts',
  server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: [] },
})
const D = await server.ssrLoadModule('/src/utils/ocr/deskew.ts')

const args = process.argv.slice(2)
const compare = args.includes('--compare')
const pagesAt = args.indexOf('--pages')
const maxPages = pagesAt >= 0 ? Number(args[pagesAt + 1]) : 3
const inputs = args.filter((a, i) => !a.startsWith('--') && (pagesAt < 0 || i !== pagesAt + 1))
const files = inputs.flatMap(p => fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).filter(f => f.toLowerCase().endsWith('.pdf')).map(f => path.join(p, f))
  : [p])

const DPI = 220, s = DPI / 72
let svc = null, canvasLib = null
if (compare) {
  const { PaddleOcrService } = await import(pathToFileURL(ROOT + '/node_modules/ppu-paddle-ocr/index.js').href)
  canvasLib = await import(pathToFileURL(ROOT + '/node_modules/@napi-rs/canvas/index.js').href)
  const read = (f) => { const b = fs.readFileSync(`${ROOT}/public/paddle/${f}`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
  svc = new PaddleOcrService({
    model: { detection: read('PP-OCRv6_small_det.ort'), recognition: read('PP-OCRv6_small_rec.ort'), charactersDictionary: read('ppocrv6_dict.txt') },
    processing: { engine: 'canvas-native' },
    recognition: { strategy: 'per-box', minimumConfidence: 0.3 },
  })
  await svc.initialize()
}
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
const stats = (res) => {
  const r = (res.results ?? []).filter(x => String(x.text).trim())
  // What can be used: the characters of lines read at 80% or better (the app drops most of the rest as junk).
  const sure = r.filter(x => x.confidence >= 0.8).reduce((a, x) => a + String(x.text).replace(/s+/g, '').length, 0)
  return { n: r.length, mean: r.length ? r.reduce((a, x) => a + x.confidence, 0) / r.length * 100 : 0, low: r.filter(x => x.confidence < 0.8).length, sure }
}

let scans = 0, levelled = 0
const rows = []
for (const file of files) {
  let doc
  try { doc = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf') } catch { continue }
  const n = Math.min(doc.countPages(), maxPages)
  for (let pg = 0; pg < n; pg++) {
    let page, st
    try { page = doc.loadPage(pg); st = page.toStructuredText('preserve-images') } catch { continue }
    const b = page.getBounds(), area = (b[2] - b[0]) * (b[3] - b[1])
    let img = 0
    st.walk({ onImageBlock(bb) { img += Math.max(0, bb[2] - bb[0]) * Math.max(0, bb[3] - bb[1]) } })
    st.destroy?.()
    if (img / area < 0.85) { page.destroy?.(); continue }
    scans++
    let pix
    try { pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true) } catch { page.destroy?.(); continue }
    page.destroy?.()
    const W = pix.getWidth(), H = pix.getHeight(), src = pix.getPixels()
    const rgba = new Uint8ClampedArray(W * H * 4)
    for (let i = 0, j = 0; i < W * H; i++, j += 3) { rgba[i * 4] = src[j]; rgba[i * 4 + 1] = src[j + 1]; rgba[i * 4 + 2] = src[j + 2]; rgba[i * 4 + 3] = 255 }
    const t0 = Date.now()
    const skew = D.estimateSkew(rgba, W, H)
    const ms = Date.now() - t0
    const name = `${path.basename(file).slice(0, 48)} p${pg + 1}`
    if (!skew) { console.log(`level      ${name} (${ms}ms)`); pix.destroy?.(); continue }
    levelled++
    let line = `skew ${skew.degrees.toFixed(2).padStart(5)}° gain ${skew.gain.toFixed(2)} ${name} (${ms}ms)`
    if (compare) {
      const png = Buffer.from(pix.asPNG())
      const before = stats(await svc.recognize(toAB(png), { flatten: true }))
      const im = await canvasLib.loadImage(png)
      const rad = skew.degrees * Math.PI / 180
      const margin = Math.ceil(Math.max(W, H) * Math.abs(Math.sin(rad)) / 2) + 4
      const c = canvasLib.createCanvas(W + margin * 2, H + margin * 2), ctx = c.getContext('2d')
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height)
      ctx.translate(c.width / 2, c.height / 2); ctx.rotate(-rad); ctx.drawImage(im, -W / 2, -H / 2)
      const after = stats(await svc.recognize(toAB(c.toBuffer('image/png')), { flatten: true }))
      line += ` | lines ${before.n} -> ${after.n}, mean ${before.mean.toFixed(1)} -> ${after.mean.toFixed(1)}%, under 80%: ${before.low} -> ${after.low}, sure chars ${before.sure} -> ${after.sure}`
      rows.push({ name, skew, before, after })
    }
    pix.destroy?.()
    console.log(line)
  }
  doc.destroy?.()
}
console.log(`\n${scans} scanned pages, ${levelled} would be read levelled`)
if (rows.length) {
  const better = rows.filter(r => r.after.mean > r.before.mean + 0.2).length, worse = rows.filter(r => r.after.mean < r.before.mean - 0.2).length
  console.log(`mean confidence: ${better} better, ${worse} worse, ${rows.length - better - worse} about the same`)
  const more = rows.filter(r => r.after.sure > r.before.sure * 1.01).length, fewer = rows.filter(r => r.after.sure < r.before.sure * 0.99).length
  console.log(`characters read at 80%+: ${more} more, ${fewer} fewer, ${rows.length - more - fewer} about the same; total ${rows.reduce((a, r) => a + r.before.sure, 0)} -> ${rows.reduce((a, r) => a + r.after.sure, 0)}`)
}
await server.close()
