// Dump a page's text blocks (visible ones by default) with bbox, font, size.
//   node tools/pdf-sweep/dump-blocks.mjs <pdf> <pageIndex> [all]
import { createEngine } from './node-harness.mjs'

const [file, pageArg, all] = process.argv.slice(2)
const p = Number(pageArg)
const eng = await createEngine()
await eng.load(file)
const t = await eng.send('getPageText', { pageIndex: p })
for (const b of t.blocks) {
  if (b.invisible && !all) continue
  const bb = b.bbox.map(v => v.toFixed(1)).join(',')
  console.log(`${b.id}\t${b.invisible ? 'INV' : 'vis'}\t[${bb}]\t${b.fontName}\t${(b.fontSize || 0).toFixed(1)}\t${JSON.stringify(b.text.slice(0, 90))}`)
}
await eng.close()
process.exit(0)
