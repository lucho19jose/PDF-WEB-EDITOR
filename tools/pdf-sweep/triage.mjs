// Classify sweep failures by signature so real bugs stand out.
// Usage: node tools/pdf-sweep/triage.mjs [results.json]
import fs from 'node:fs'

const file = process.argv[2] || 'tools/pdf-sweep/results.json'
const results = JSON.parse(fs.readFileSync(file, 'utf8'))
const manifest = JSON.parse(fs.readFileSync('tools/pdf-sweep/manifest.json', 'utf8'))
const fam = new Map(manifest.map(m => [m.pdf_id, m.family]))

// A failure signature answers: what actually went wrong?
function signature(e) {
  if (e.strategy === 'LOAD') return 'load-error'
  if (e.error && /Could not find matching text/.test(e.error)) return 'no-match'
  if (e.error) return 'error:' + e.error.slice(0, 40)
  if (!e.reported_success) return 'reported-failure'
  // Reported success but the invariants disagree — the silent bugs.
  if (e.strategy === 'replace_text') {
    if (!e.landed_exactly && e.char_delta > 0) return 'SILENT:text-wrong'
    if (!e.landed_exactly) return 'SILENT:marker-not-found'
    if (e.char_delta > 0) return 'SILENT:collateral-chars'
    return 'SILENT:other'
  }
  if (e.strategy === 'transform_move') {
    if (e.vanished) return 'SILENT:vanished'
    if (e.char_delta > 0) return 'SILENT:move-changed-chars'
    if (e.geometry_error !== null && e.geometry_error * 1000 > 6) return 'SILENT:landed-off'
    if (e.blocks_touched > 3) return 'SILENT:dragged-neighbours'
    return 'SILENT:other'
  }
  return 'other'
}

const groups = new Map()
for (const p of results) {
  const items = [...(p.experiments || []).filter(e => !e.success).map(e => ({ ...e, pdf_id: p.pdf_id, file: p.file }))]
  if (p.error) items.push({ strategy: 'LOAD', error: p.error, pdf_id: p.pdf_id, file: p.file })
  for (const e of items) {
    const s = signature(e)
    if (!groups.has(s)) groups.set(s, [])
    groups.get(s).push(e)
  }
}

const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
for (const [sig, list] of order) {
  console.log(`\n=== ${sig} (${list.length}) ===`)
  for (const e of list.slice(0, 12)) {
    console.log(` #${e.pdf_id} [${fam.get(e.pdf_id) || '?'}] ${String(e.file).slice(0, 45)}`)
    console.log(`    strat=${e.strategy}/${e.internal_strategy ?? '-'} cd=${e.char_delta ?? '-'} bt=${e.blocks_touched ?? '-'} ge=${e.geometry_error ?? '-'} van=${e.vanished ?? '-'}`)
    if (e.original_text) console.log(`    text="${String(e.original_text).slice(0, 50)}" -> observed="${String(e.observed_text ?? '').slice(0, 50)}"`)
    if (e.error) console.log(`    err=${String(e.error).slice(0, 90)}`)
  }
  if (list.length > 12) console.log(`  ... and ${list.length - 12} more`)
}

// Per-family success rates for context.
const perFam = new Map()
for (const p of results) {
  const f = fam.get(p.pdf_id) || '?'
  if (!perFam.has(f)) perFam.set(f, { runs: 0, ok: 0 })
  for (const e of p.experiments || []) { const s = perFam.get(f); s.runs++; if (e.success) s.ok++ }
}
console.log('\n=== per family ===')
for (const [f, s] of [...perFam.entries()].sort()) console.log(` ${f}: ${s.ok}/${s.runs}`)
