// Print each character's origin x and quad for blocks containing a substring.
//   node tools/pdf-sweep/char-positions.mjs <pdf> <pageIndex> <substring>
import { createEngine } from './node-harness.mjs'
const [file, pageArg, needle] = process.argv.slice(2)
const eng = await createEngine()
await eng.load(file)
const { blocks } = await eng.send('getPageText', { pageIndex: Number(pageArg) })
for (const b of blocks) {
  if (!b.text.includes(needle)) continue
  console.log(`${b.id} ${b.invisible ? 'INV' : 'vis'} font=${b.fontName} ${JSON.stringify(b.text)}`)
  for (const c of b.chars || []) {
    const q = c.quad || c.bbox || []
    console.log(`  ${JSON.stringify(c.c ?? c.char ?? c.text)} x=${(c.origin?.[0] ?? q[0] ?? 0).toFixed(1)} quad=[${(q.slice ? q : []).map(v => v.toFixed ? v.toFixed(1) : v).join(',')}]`)
  }
}
await eng.close()
process.exit(0)
