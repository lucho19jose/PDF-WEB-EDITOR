// Per-letter ink boxes inside a page region: columns are split at empty
// columns, each piece reports its top/bottom/height in points.
//   node tools/ocr-calibrate/glyph-heights.mjs <pdf> <pageIndex> <dpi> x y w h [threshold]
import fs from 'node:fs'
import * as mupdf from 'mupdf'

const [file, pageArg, dpiArg, x, y, w, h, thrArg] = process.argv.slice(2)
const doc = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf')
const page = doc.loadPage(Number(pageArg))
const s = Number(dpiArg) / 72
const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceGray, false, true)
const W = pix.getWidth(), raw = pix.getPixels(), n = pix.getNumberOfComponents()
const thr = Number(thrArg || 140)
const x0 = Math.floor(x * s), y0 = Math.floor(y * s), x1 = Math.floor((Number(x) + Number(w)) * s), y1 = Math.floor((Number(y) + Number(h)) * s)
const dark = (xx, yy) => raw[(yy * W + xx) * n] < thr
const cols = []
for (let xx = x0; xx < x1; xx++) { let any = false; for (let yy = y0; yy < y1; yy++) if (dark(xx, yy)) { any = true; break } cols.push(any) }
let i = 0
const pieces = []
while (i < cols.length) {
  if (!cols[i]) { i++; continue }
  let j = i
  while (j < cols.length && cols[j]) j++
  let top = Infinity, bot = -Infinity
  for (let xx = x0 + i; xx < x0 + j; xx++) for (let yy = y0; yy < y1; yy++) if (dark(xx, yy)) { if (yy < top) top = yy; if (yy > bot) bot = yy }
  pieces.push({ x: ((x0 + i) / s).toFixed(1), w: ((j - i) / s).toFixed(1), top: (top / s).toFixed(2), bottom: ((bot + 1) / s).toFixed(2), height: ((bot + 1 - top) / s).toFixed(2) })
  i = j
}
for (const p of pieces) console.log(JSON.stringify(p))
