/**
 * Trace lab — the glyph cut and the tracer's cell bitmaps in node, without a
 * browser or an OCR engine.
 *
 *   node tools/ocr-calibrate/trace-lab.mjs <pdf> <pageIndex> <dpi> "<text>" x y w h [levels...]
 *
 * Renders the page with MuPDF at `dpi`, cuts the run at the ink rect (points,
 * top-left origin, the frame the OCR layer reports) with `cutGlyphs`, prints
 * the cells and the mass-conserving trace level, and dumps each cell's
 * TRACED bitmap (see `cellBitmapTraced`) as ASCII at every level asked for —
 * the check that shows a serif bridged into a bar or a leg dropped, which a
 * baked render at 300% does not.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as mupdf from 'mupdf'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')
const [pdf, pageArg, dpiArg, text, xs, ys, ws, hs, ...levelArgs] = process.argv.slice(2)
const pageIndex = Number(pageArg), dpi = Number(dpiArg || 440)
const rectPt = { x: Number(xs), y: Number(ys), width: Number(ws), height: Number(hs) }
const levels = levelArgs.length ? levelArgs.map(Number) : []

const { createServer } = await import(pathToFileURL(ROOT + '/node_modules/vite/dist/node/index.js').href)
const server = await createServer({
  root: ROOT, configFile: ROOT + '/vite.config.ts',
  server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: [] },
})
// The cutter builds ImageData for the tracer; node has none.
globalThis.ImageData = class ImageData {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4) }
}
const glyphCut = await server.ssrLoadModule('/src/utils/ocr/glyphCut.ts')

const doc = mupdf.Document.openDocument(fs.readFileSync(pdf), 'application/pdf')
const page = doc.loadPage(pageIndex)
const k = dpi / 72
const pix = page.toPixmap(mupdf.Matrix.scale(k, k), mupdf.ColorSpace.DeviceRGB, false, true)
const W = pix.getWidth(), H = pix.getHeight(), n = pix.getNumberOfComponents()
const samples = pix.getPixels()
const ctx = {
  canvas: { width: W, height: H },
  getImageData(x, y, w, h) {
    const out = new Uint8ClampedArray(w * h * 4)
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const s = ((y + yy) * W + (x + xx)) * n, o = (yy * w + xx) * 4
      out[o] = samples[s]; out[o + 1] = samples[s + 1]; out[o + 2] = samples[s + 2]; out[o + 3] = 255
    }
    return { data: out, width: w, height: h }
  }
}
const rect = { x: rectPt.x * k, y: rectPt.y * k, width: rectPt.width * k, height: rectPt.height * k }
if (process.env.MODE === 'box') {
  // The line-box pipeline `refineLines` runs on a detector box: tight ink
  // bounds, then the descender and ascender walks. Prints each stage in points.
  const ink = await server.ssrLoadModule('/src/utils/ocr/inkMeasure.ts')
  const pt = (r) => `x ${(r.x / k).toFixed(2)} y ${(r.y / k).toFixed(2)} w ${(r.width / k).toFixed(2)} h ${(r.height / k).toFixed(2)}`
  const emGuess = rect.width / Math.max(1, [...text].filter(c => c !== ' ').reduce((s, c) => s + glyphCut.expectedAdvance(c), 0))
  const b0 = ink.inkBounds(ctx, rect, emGuess)
  const b1 = ink.extendDescenders(ctx, b0, text)
  const b2 = ink.extendAscenders(ctx, b1, text)
  console.log(`detector  ${pt(rect)}\ninkBounds ${pt(b0)}\n+descend  ${pt(b1)}\n+ascend   ${pt(b2)}`)
  for (const d of ink.lastWalkDebug()) console.log('  ' + d.slice(0, 400))
  await server.close()
  process.exit(0)
}
const cut = glyphCut.cutGlyphs(ctx, rect, text)
if (!cut) {
  console.log('REFUSED:', glyphCut.lastCutReason())
  const d = glyphCut.lastCutDebug()
  for (const k of ['runs', 'cells', 'shape', 'rows']) if (d[k]) console.log(`-- ${k}: ${d[k].slice(0, 1500)}`)
  await server.close()
  process.exit(0)
}
console.log(`cells ${cut.cells.length}: ` + cut.cells.map(c => `${c.char}[${c.x0}-${c.x1}${c.suspect ? '!' : ''}]`).join(' '))
console.log(`emPx ${cut.emPx.toFixed(1)}  traceLevel ${glyphCut.traceLevel(cut).toFixed(3)}  cut threshold darkness ${(1 - (cut.threshold - 0) / 255).toFixed(2)}`)
console.log('rows: ' + (glyphCut.lastCutDebug().rows || '').slice(0, 600))
console.log('shape: ' + (glyphCut.lastCutDebug().shape || '').slice(0, 300))

function ascii(img) {
  const rows = []
  for (let y = 0; y < img.height; y++) {
    let s = ''
    for (let x = 0; x < img.width; x++) s += img.data[(y * img.width + x) * 4] < 128 ? '#' : '.'
    rows.push(s)
  }
  return rows.join('\n')
}
const wanted = process.env.CHARS ? [...process.env.CHARS] : null
for (const cell of cut.cells) {
  if (wanted && !wanted.includes(cell.char)) continue
  console.log(`\n=== '${cell.char}' [${cell.x0}-${cell.x1}]${cell.suspect ? ' SUSPECT' : ''}`)
  if (process.env.DUMP === 'dark') {
    // The raw darkness of the cell's columns, 0–9, one digit per raster pixel.
    const b = cut.bin
    const rows = []
    for (let yy = 0; yy < b.h; yy++) {
      let s = ''
      for (let xx = cell.x0 - 1; xx <= cell.x1 + 1; xx++) { const bx = xx - b.x; s += bx >= 0 && bx < b.w ? String(Math.min(9, Math.round(b.dark[yy * b.w + bx] * 9))) : ' ' }
      rows.push(s)
    }
    console.log('-- darkness:\n' + rows.join('\n'))
  }
  const plain = glyphCut.cellBitmap(cut, cell, 1)
  console.log('-- cut bitmap (0.42 of range):\n' + (plain ? ascii(plain.image) : 'null'))
  for (const level of levels.length ? levels : [glyphCut.traceLevel(cut)]) {
    const t = glyphCut.cellBitmapTraced(cut, cell, 1, 2, level)
    console.log(`-- traced @${level.toFixed(2)} (2x):\n` + (t ? ascii(t.image) : 'null'))
  }
}
await server.close()
