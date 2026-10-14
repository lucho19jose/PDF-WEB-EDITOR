// Measure the faint-layer (watermark) test of src/utils/ocr/faintLayer.ts on
// scanned pages rendered at the OCR resolution, to calibrate its bars.
//   node --experimental-strip-types tools/ocr-calibrate/faint-hist.mjs <pdf>...   (PAGES=n, default 3)
import fs from 'node:fs'
import * as mupdf from 'mupdf'
import { analyseFaintLayer, measureFaintLayer } from '../../src/utils/ocr/faintLayer.ts'

for (const file of process.argv.slice(2).filter(a => a.endsWith('.pdf'))) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf')
  const pages = Math.min(doc.countPages(), Number(process.env.PAGES || 3))
  for (let p = 0; p < pages; p++) {
    const page = doc.loadPage(p)
    const pix = page.toPixmap(mupdf.Matrix.scale(220 / 72, 220 / 72), mupdf.ColorSpace.DeviceRGB, false)
    const w = pix.getWidth(), h = pix.getHeight(), rgb = pix.getPixels()
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255 }
    const m = measureFaintLayer(rgba, w, h), a = analyseFaintLayer(rgba, w, h)
    const name = file.split(/[\/]/).slice(-2).join('/')
    console.log(a ? 'LAYER' : '     ', name, 'p' + p, m ? `paper=${m.paper} share=${(m.share * 100).toFixed(2)}% edge=${m.edge.toFixed(2)} p75=${m.p75} spread=${m.spread.toFixed(2)} cutoff=${m.cutoff}` : 'no paper')
    pix.destroy(); page.destroy()
  }
  doc.destroy()
}
