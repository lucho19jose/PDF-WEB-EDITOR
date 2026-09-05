// Compare two OCR sweep result files row by row (document, page, original run).
// Usage: node tools/pdf-sweep/compare-ocr.mjs base.json new.json
//
// Totals alone hide a wrong-glyph trace behind a right one elsewhere; every
// row whose re-read similarity, read-back or cut outcome changed is listed.
import fs from 'node:fs'

const [baseFile, newFile] = process.argv.slice(2)
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

function rows(res) {
  const out = new Map()
  const totals = { docs: 0, scanPages: 0, edits: 0, found: 0, simSum: 0, simN: 0, cuts: 0, errors: [] }
  for (const d of res) {
    totals.docs++
    if (d.error) totals.errors.push(`${d.staged}: ${d.error}`)
    for (const p of d.pages || []) {
      if (p.error) totals.errors.push(`${d.staged} p${p.page}: ${p.error}`)
      if (!p.scan) continue
      totals.scanPages++
      const rr = (p.reread && p.reread.edits) || []
      ;(p.edits || []).forEach((e, i) => {
        if (!e.text) return
        totals.edits++
        if (e.found) totals.found++
        const sim = rr[i] ? rr[i].sim : null
        if (sim !== null) { totals.simSum += sim; totals.simN++ }
        const cut = e.cut ? (e.cut.reason ? 'REFUSED' : `${e.cut.cells}/${e.cut.suspects}`) : '-'
        if (e.cut && !e.cut.reason) totals.cuts++
        out.set(`${d.staged} p${p.page} "${(e.original || '').slice(0, 40)}"`, { kind: e.kind, text: (e.text || '').slice(0, 40), found: !!e.found, sim, cut, reason: e.cut?.reason || '', font: e.font || '' })
      })
    }
  }
  return { out, totals }
}

const a = rows(load(baseFile)), b = rows(load(newFile))
const fmt = (t) => `docs=${t.docs} scanPages=${t.scanPages} edits=${t.edits} found=${t.found} cuts=${t.cuts} avgSim=${t.simN ? (t.simSum / t.simN).toFixed(3) : '-'} (n=${t.simN})${t.errors.length ? ' errors=' + t.errors.length : ''}`
console.log('base: ' + fmt(a.totals))
console.log('new:  ' + fmt(b.totals))
let changed = 0
for (const [key, nb] of b.out) {
  const na = a.out.get(key)
  if (!na) { console.log(`+ ${key} -> "${nb.text}" found=${nb.found ? 1 : 0} sim=${nb.sim} cut=${nb.cut}`); changed++; continue }
  const diffs = []
  if (na.found !== nb.found) diffs.push(`found ${na.found ? 1 : 0}->${nb.found ? 1 : 0}`)
  if ((na.sim ?? -1) !== (nb.sim ?? -1)) diffs.push(`sim ${na.sim}->${nb.sim}`)
  if (na.cut !== nb.cut) diffs.push(`cut ${na.cut}->${nb.cut}${nb.reason ? ' (' + nb.reason.slice(0, 40) + ')' : ''}`)
  if (diffs.length) { console.log(`~ ${key}: ${diffs.join(', ')}`); changed++ }
}
for (const key of a.out.keys()) if (!b.out.has(key)) { console.log(`- ${key} (not in new)`); changed++ }
if (a.totals.errors.length || b.totals.errors.length) console.log('errors base:\n  ' + a.totals.errors.join('\n  ') + '\nerrors new:\n  ' + b.totals.errors.join('\n  '))
console.log(`${changed} rows changed`)
