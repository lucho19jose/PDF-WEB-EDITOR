// Does pdf.js get through a page? Runs getOperatorList in node with a timeout.
//   node tools/pdf-sweep/pdfjs-check.mjs <pdf> <page1based> [timeoutMs]
import fs from 'node:fs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const [file, pageArg, toArg = '20000'] = process.argv.slice(2)
const data = new Uint8Array(fs.readFileSync(file))
const t0 = performance.now()
const doc = await pdfjs.getDocument({ data, verbosity: 1 }).promise
const page = await doc.getPage(Number(pageArg))
const timeout = new Promise(r => setTimeout(() => r('TIMEOUT'), Number(toArg)))
const ops = await Promise.race([page.getOperatorList().then(l => `ops=${l.fnArray.length}`), timeout])
console.log(`${ops} in ${Math.round(performance.now() - t0)} ms`)
if (ops !== 'TIMEOUT') {
  const t1 = performance.now()
  const tc = await Promise.race([page.getTextContent().then(t => `text items=${t.items.length}`), timeout])
  console.log(`${tc} in ${Math.round(performance.now() - t1)} ms`)
}
process.exit(0)
