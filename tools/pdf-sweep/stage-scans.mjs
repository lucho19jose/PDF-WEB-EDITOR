// Stage a producer-diverse OCR corpus from a scan census.
//
// Usage: node tools/pdf-sweep/stage-scans.mjs <scan-census.json> <srcFolder> <outName> <count> [...excludeManifests]
//
// Takes documents with scan pages that no earlier corpus holds, drops
// duplicates (same size and page count — Downloads keeps "(1)" copies), and
// picks round-robin across producer families so every scanner, phone app and
// print driver is represented before any is repeated. Writes
// public/_sweep/<outName>/NNN.pdf and a manifest in the OCR driver's format,
// with `scanPages` so a run can go straight to the pages that matter.
import fs from 'node:fs'
import path from 'node:path'

const [censusFile, src, outName, countArg, ...excludeManifests] = process.argv.slice(2)
const want = Number(countArg || 30)
const rows = JSON.parse(fs.readFileSync(censusFile, 'utf8'))
// Documents an earlier round of THIS census already staged (extra manifests
// after the count), so successive rounds cover new documents.
const already = new Set()
for (const m of excludeManifests) for (const e of JSON.parse(fs.readFileSync(m, 'utf8'))) already.add(e.file)
for (const r of rows) if (already.has(r.file)) r.excluded = true

function family(p) {
  const s = (p || '').toLowerCase()
  if (!s.trim()) return 'unknown'
  const keys = ['intsig', 'scanner system', 'pdf24', 'hp scan', 'print to pdf', 'calibre', 'lexmark', 'openpdf', 'ricoh', 'epson', 'foxit', 'ilovepdf', 'ios version', 'acrobat', 'ghostscript', 'haru', 'heights', 'versalink', 'mfpimglib', 'quartz', 'pdfium', 'pdftools', 'adobe pdf', 'konica', 'skia', 'word', 'xep', 'distiller']
  for (const k of keys) if (s.includes(k)) return k
  return 'other:' + s.slice(0, 12)
}

const seen = new Set()
const byFamily = new Map()
for (const r of rows) {
  if (r.excluded || r.error || !r.scanPages.length) continue
  const key = `${r.size}:${r.pages}:${r.scanPages.join(',')}`
  if (seen.has(key)) continue
  seen.add(key)
  const fam = family(r.producer)
  if (!byFamily.has(fam)) byFamily.set(fam, [])
  byFamily.get(fam).push(r)
}
// Within a family, the document with the most scan pages first.
for (const list of byFamily.values()) list.sort((a, b) => b.scanPages.length - a.scanPages.length || a.size - b.size)

const picked = []
const families = [...byFamily.keys()].sort()
let round = 0
while (picked.length < want) {
  let any = false
  for (const f of families) {
    const list = byFamily.get(f)
    if (list.length > round) { picked.push(list[round]); any = true; if (picked.length >= want) break }
  }
  if (!any) break
  round++
}

const outDir = path.join('public/_sweep', outName)
fs.mkdirSync(outDir, { recursive: true })
const manifest = picked.map((r, i) => {
  const staged = `${outName}/${String(i + 1).padStart(3, '0')}.pdf`
  fs.copyFileSync(path.join(src, r.file), path.join('public/_sweep', staged))
  return { pdf_id: i + 1, staged, file: r.file, producer: r.producer, pages: r.pages, size: r.size, scanPages: r.scanPages, chars: 0, images: 0 }
})
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`staged ${manifest.length} of ${seen.size} candidates across ${families.length} families into ${outDir}`)
for (const m of manifest) console.log(`${m.staged}  ${family(m.producer).padEnd(16)} ${m.scanPages.join(',').padEnd(10)} ${m.file}`)
