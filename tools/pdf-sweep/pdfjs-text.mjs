// Text content of one page as pdf.js reads it.
//   node tools/pdf-sweep/pdfjs-text.mjs <pdf> <page1based> [needle]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..').split(path.sep).join('/')
const [file, pageArg = '1', needle] = process.argv.slice(2)
const data = new Uint8Array(fs.readFileSync(file))
const doc = await pdfjs.getDocument({
  data, verbosity: 1,
  standardFontDataUrl: ROOT + '/public/pdfjs/standard_fonts/',
  cMapUrl: ROOT + '/public/pdfjs/cmaps/', cMapPacked: true,
  wasmUrl: ROOT + '/public/pdfjs/wasm/', iccUrl: ROOT + '/public/pdfjs/iccs/'
}).promise
const page = await doc.getPage(Number(pageArg))
const tc = await page.getTextContent()
const items = tc.items.filter(i => i.str !== undefined)
const fold = (s) => s.replace(/\s+/g, '').toLowerCase()
if (needle) {
  const n = fold(needle)
  for (const it of items) {
    const f = fold(it.str)
    if (!f) continue
    if (f.includes(n) || (n.includes(f) && f.length > 2)) {
      console.log(JSON.stringify(it.str), 'at', it.transform.slice(4).map(v => v.toFixed(1)).join(','), 'font', it.fontName, 'w', it.width.toFixed(1))
    }
  }
  console.log('joined has needle:', fold(items.map(i => i.str).join('')).includes(n))
} else {
  for (const it of items.slice(0, 80)) console.log(JSON.stringify(it.str).slice(0, 80), 'at', it.transform.slice(4).map(v => v.toFixed(1)).join(','), 'font', it.fontName)
}
process.exit(0)
