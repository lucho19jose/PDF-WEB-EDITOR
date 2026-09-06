// Render a page to PNG with MuPDF (node), optionally a clip rect in points (top-left origin).
//   node tools/pdf-sweep/render-page.mjs <pdf> <pageIndex> <out.png> [dpi] [x y w h]
import fs from 'node:fs'
import * as mupdf from 'mupdf'

const [file, pageArg, out, dpiArg, ...clip] = process.argv.slice(2)
const dpi = Number(dpiArg || 150)
const doc = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf')
const page = doc.loadPage(Number(pageArg))
const s = dpi / 72
let m = mupdf.Matrix.scale(s, s)
const bounds = page.getBounds()
let pix
if (clip.length === 4) {
  const [x, y, w, h] = clip.map(Number)
  const rect = [bounds[0] + x, bounds[1] + y, bounds[0] + x + w, bounds[1] + y + h]
  const dev = mupdf.Rect.transform(rect, m)
  pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [Math.floor(dev[0]), Math.floor(dev[1]), Math.ceil(dev[2]), Math.ceil(dev[3])], false)
  pix.clear(255)
  const d = new mupdf.DrawDevice(m, pix)
  page.run(d, mupdf.Matrix.identity)
  d.close()
} else {
  pix = page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false, true)
}
fs.writeFileSync(out, pix.asPNG())
console.log(out, pix.getWidth(), pix.getHeight())
