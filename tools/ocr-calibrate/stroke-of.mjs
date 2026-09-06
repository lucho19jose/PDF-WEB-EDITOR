// The face detector's strokeRatio (median horizontal ink run over the em) of a page region.
//   node tools/ocr-calibrate/stroke-of.mjs <pdf> <pageIndex> <dpi> <emPt> x y w h [x y w h ...]   (points, top-left origin)
import fs from 'node:fs'
import * as mupdf from 'mupdf'

const [file, pageArg, dpiArg, emArg, ...rest] = process.argv.slice(2)
const doc = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf')
const page = doc.loadPage(Number(pageArg))
const s = Number(dpiArg) / 72
const emPx = Number(emArg) * s
const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceGray, false, true)
const W = pix.getWidth(), H = pix.getHeight(), raw = pix.getPixels(), n = pix.getNumberOfComponents()
for (let i = 0; i + 3 < rest.length; i += 4) {
  const [x, y, w, h] = rest.slice(i, i + 4).map(Number)
  const x0 = Math.floor(x * s), y0 = Math.floor(y * s), x1 = Math.min(W, Math.floor((x + w) * s)), y1 = Math.min(H, Math.floor((y + h) * s))
  let lo = 255, hi = 0
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const v = raw[(yy * W + xx) * n]; if (v < lo) lo = v; if (v > hi) hi = v }
  const thr = (lo + hi) / 2
  const runs = []
  for (let yy = y0; yy < y1; yy++) {
    let run = 0
    for (let xx = x0; xx <= x1; xx++) {
      const ink = xx < x1 && raw[(yy * W + xx) * n] < thr
      if (ink) run++
      else if (run > 0) { runs.push(run); run = 0 }
    }
  }
  const stems = runs.filter(r => r <= emPx * 0.55).sort((a, b) => a - b)
  const pick = (p) => stems[Math.min(stems.length - 1, Math.floor(stems.length * p))]
  console.log(`[${x},${y},${w},${h}] em=${emArg}pt runs=${runs.length} stems=${stems.length} strokeRatio=${(pick(0.5) / emPx).toFixed(3)} p30=${(pick(0.3) / emPx).toFixed(3)} p85=${(pick(0.85) / emPx).toFixed(3)} thr=${thr.toFixed(0)}`)
}
