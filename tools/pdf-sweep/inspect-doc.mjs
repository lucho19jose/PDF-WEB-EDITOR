// Inspect a document page by page through the node harness: text blocks,
// invisible blocks, images, coverage — the same judgement the app makes.
//   node tools/pdf-sweep/inspect-doc.mjs <pdf> [firstPage] [lastPage]
import { createEngine } from './node-harness.mjs'

const file = process.argv[2]
const first = Number(process.argv[3] ?? 0)
const lastArg = process.argv[4]
const eng = await createEngine()
const info = await eng.load(file)
console.log('pages', info.pageCount ?? JSON.stringify(info).slice(0, 200))
const pageCount = info.pageCount ?? info.numPages ?? 0
const last = lastArg !== undefined ? Number(lastArg) : pageCount - 1

for (let p = first; p <= last; p++) {
  try {
    const t = await eng.send('getPageText', { pageIndex: p })
    const blocks = t.blocks || []
    const invisible = blocks.filter(b => b.invisible).length
    const chars = blocks.reduce((n, b) => n + (b.text || '').length, 0)
    let imgs = []
    try { { const r = await eng.send("listContentImages", { pageIndex: p }); imgs = Array.isArray(r) ? r : (r.images || []) } } catch (e) { imgs = ['ERR ' + e.message] }
    const size = await eng.send('getPageSize', { pageIndex: p }).catch(() => null)
    const fonts = new Set(blocks.map(b => b.fontName).filter(Boolean))
    const sample = blocks.filter(b => !b.invisible).slice(0, 4).map(b => JSON.stringify((b.text || '').slice(0, 40)))
    console.log(`p${p}: ${blocks.length} blocks (${invisible} invisible), ${chars} chars, ${Array.isArray(imgs) ? imgs.length + ' images' : imgs}, size=${size ? size.width + 'x' + size.height : '?'} fonts=[${[...fonts].slice(0, 6).join(', ')}] ${sample.join(' | ')}`)
  } catch (e) {
    console.log(`p${p}: ERROR ${e.message}`)
  }
}
await eng.close()
process.exit(0)
