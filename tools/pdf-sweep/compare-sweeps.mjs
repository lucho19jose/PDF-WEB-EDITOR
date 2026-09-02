/** Per-experiment diff of two sweep result files: node compare-sweeps.mjs base.json new.json */
import fs from 'fs'

const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, 'utf8')))
const key = (r, e) => `${r.staged}|${e.strategy}|${e.block_index}|${(e.original_text || '').slice(0, 30)}`
const index = (rs) => {
  const m = new Map()
  for (const r of rs) for (const e of r.experiments) m.set(key(r, e), e)
  return m
}
const A = index(a), B = index(b)
let gained = 0, lost = 0, changed = 0
for (const [k, e] of B) {
  const o = A.get(k)
  if (!o) { console.log('NEW', k, e.success); continue }
  if (o.success !== e.success) {
    e.success ? gained++ : lost++
    console.log(e.success ? 'GAINED' : 'LOST', k, o.internal_strategy, '->', e.internal_strategy, e.error || '')
  } else if (o.internal_strategy !== e.internal_strategy || o.char_delta !== e.char_delta ||
             o.observed_text !== e.observed_text || o.substituted_font !== e.substituted_font) {
    changed++
    console.log('CHANGED', k, o.internal_strategy, '->', e.internal_strategy, o.char_delta, '->', e.char_delta,
      JSON.stringify(o.observed_text), '->', JSON.stringify(e.observed_text), o.substituted_font, '->', e.substituted_font)
  }
}
for (const k of A.keys()) if (!B.has(k)) console.log('MISSING', k)
console.log({ gained, lost, changed, base: A.size, new: B.size })
