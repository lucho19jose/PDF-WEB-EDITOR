// Luma statistics of a page region: median, lightest-fifth mean, darkest-fifth mean.
//   node tools/pdf-sweep/measure-paper.mjs <pdf> <pageIndex> <dpi> x y w h [x y w h ...]
import fs from 'node:fs'
import * as mupdf from 'mupdf'

const [file, pageArg, dpiArg, ...rest] = process.argv.slice(2)
const doc = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf')
const page = doc.loadPage(Number(pageArg))
const s = Number(dpiArg) / 72
const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true)
const W = pix.getWidth(), H = pix.getHeight(), px = pix.getPixels(), n = pix.getNumberOfComponents()
for (let i = 0; i + 3 < rest.length; i += 4) {
  const [x, y, w, h] = rest.slice(i, i + 4).map(Number)
  const l = []
  for (let yy = Math.floor(y * s); yy < Math.floor((y + h) * s); yy++) for (let xx = Math.floor(x * s); xx < Math.floor((x + w) * s); xx++) {
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
    const o = (yy * W + xx) * n
    l.push(0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2])
  }
  l.sort((a, b) => a - b)
  const fifth = Math.max(1, Math.floor(l.length / 5))
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length
  console.log(`[${x},${y},${w},${h}] n=${l.length} median=${l[l.length >> 1].toFixed(1)} p10=${l[Math.floor(l.length * 0.1)].toFixed(1)} p90=${l[Math.floor(l.length * 0.9)].toFixed(1)} lightest5th=${mean(l.slice(-fifth)).toFixed(1)} darkest5th=${mean(l.slice(0, fifth)).toFixed(1)} max=${l[l.length - 1].toFixed(0)}`)
}
