// Does a Tz-fitted invisible run actually span `fitWidth`? Draws a run and
// measures what extraction reads back. The CJK face is served from public/.
//   node tools/pdf-sweep/fit-check.mjs <pdf> <pageIndex> "<text>" [fitWidth]
import fs from 'node:fs'
import path from 'node:path'
import { createEngine, ROOT } from './node-harness.mjs'

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.startsWith('/')) {
    const file = path.join(ROOT, 'public', u)
    const buf = fs.readFileSync(file)
    return new Response(buf, { status: 200 })
  }
  return realFetch(url, init)
}

const [file, pageArg, text, fitArg] = process.argv.slice(2)
const p = Number(pageArg)
const fitWidth = Number(fitArg || 150)
const eng = await createEngine()
await eng.load(file)
const size = await eng.send('getPageSize', { pageIndex: p })
const m = await eng.send('measureRuns', { runs: [{ text, fontSize: 9.1, fontName: 'Helvetica' }] })
console.log('measured natural', JSON.stringify(m.widths[0]))
const r = await eng.send('addTextRun', { pageIndex: p, parts: [{ x: 100, y: size.height - 400, text, fontSize: 9.1, fontName: 'Helvetica', invisible: true, fitWidth }] })
console.log('addTextRun', JSON.stringify(r))
const { blocks } = await eng.send('getPageText', { pageIndex: p })
const b = blocks.find(b => b.text.replace(/\s+/g, '') === text.replace(/\s+/g, '') && Math.abs(b.bbox[1] - 400) < 15)
if (!b) { console.log('block not found'); process.exit(1) }
const chars = b.chars
const x0 = chars[0].origin[0], last = chars[chars.length - 1]
const end = Math.max(last.quad[2], last.quad[6])
console.log(`drawn from ${x0.toFixed(2)} to ${end.toFixed(2)} = ${(end - x0).toFixed(2)} (asked ${fitWidth}); text=${JSON.stringify(b.text)}`)
for (const c of chars) console.log(`  ${JSON.stringify(c.c)} x=${c.origin[0].toFixed(2)} adv=${(Math.max(c.quad[2], c.quad[6]) - c.origin[0]).toFixed(2)}`)
await eng.close()
process.exit(0)
