// Stage a NEW producer-diverse sweep set, excluding files already swept.
// Usage: node tools/pdf-sweep/pick-new.mjs "<srcFolder>" <count> <excludeManifest.json> [...more excludes]
// Same family logic as pick.mjs; skips any survey row whose file name appears
// in one of the exclude manifests, so successive rounds cover new documents.
import fs from 'node:fs'
import path from 'node:path'

const src = process.argv[2]
const want = Number(process.argv[3] || 50)
const excludeFiles = new Set()
for (const m of process.argv.slice(4)) {
  for (const e of JSON.parse(fs.readFileSync(m, 'utf8'))) excludeFiles.add(e.file)
}
const outDir = 'public/_sweep'

function family(p) {
  const s = (p || '').toLowerCase()
  if (!s.trim()) return 'unknown'
  if (s.includes('dompdf')) return 'dompdf'
  if (s.includes('pdf24')) return 'pdf24'
  if (s.includes('word')) return 'ms-word'
  if (s.includes('excel')) return 'ms-excel'
  if (s.includes('powerpoint')) return 'ms-powerpoint'
  if (s.includes('visio')) return 'ms-visio'
  if (s.includes('print to pdf')) return 'ms-printtopdf'
  if (s.includes('pdfium')) return 'pdfium'
  if (s.includes('skia')) return 'skia-chrome'
  if (s.includes('ghostscript')) return 'ghostscript'
  if (s.includes('itextsharp')) return 'itextsharp'
  if (s.includes('itext')) return 'itext'
  if (s.includes('openpdf')) return 'openpdf'
  if (s.includes('libreoffice')) return 'libreoffice'
  if (s.includes('openoffice')) return 'openoffice'
  if (s.includes('quartz')) return 'quartz-apple'
  if (s.includes('pdftex') || s.includes('dvipdfmx') || s.includes('miktex')) return 'tex'
  if (s.includes('ilovepdf')) return 'ilovepdf'
  if (s.includes('pdf-lib')) return 'pdf-lib'
  if (s.includes('acrobat') || s.includes('adobe')) return 'adobe'
  if (s.includes('crystal')) return 'crystal'
  if (s.includes('reportlab')) return 'reportlab'
  if (s.includes('weasyprint')) return 'weasyprint'
  if (s.includes('tcpdf')) return 'tcpdf'
  if (s.includes('canva')) return 'canva'
  if (s.includes('calibre')) return 'calibre'
  if (s.includes('haru')) return 'haru'
  if (s.includes('qt ')) return 'qt'
  if (s.includes('intsig') || s.includes('scan') || s.includes('konica') ||
      s.includes('lexmark') || s.includes('ricoh') || s.includes('epson') ||
      s.includes('versalink') || s.includes('mfpimglib') || s.includes('bizhub')) return 'scanner'
  if (s.includes('3-heights')) return '3heights'
  if (s.includes('docusign')) return 'docusign'
  if (s.includes('pypdf')) return 'pypdf'
  if (s.includes('pdftools')) return 'pdftools'
  if (s.includes('foxit')) return 'foxit'
  if (s.includes('corel')) return 'corel'
  if (s.includes('xep')) return 'xep'
  return 'other:' + s.slice(0, 18)
}

const rows = JSON.parse(fs.readFileSync('tools/pdf-sweep/survey.json', 'utf8'))
  .filter(r => !r.error && r.size > 0 && r.size < 12 * 1024 * 1024)
  .filter(r => !excludeFiles.has(r.file))
  .filter(r => fs.existsSync(path.join(src, r.file)))

const groups = new Map()
for (const r of rows) {
  const f = family(r.producer)
  if (!groups.has(f)) groups.set(f, [])
  groups.get(f).push(r)
}
for (const list of groups.values()) list.sort((a, b) => a.size - b.size)

const picked = []
let round = 0
while (picked.length < want) {
  let added = 0
  for (const [fam, list] of groups) {
    if (picked.length >= want) break
    if (list[round]) { picked.push({ ...list[round], family: fam }); added++ }
  }
  if (!added) break
  round++
}

// Remove only the staged PDFs — driver.js in outDir is git-tracked.
fs.mkdirSync(outDir, { recursive: true })
for (const f of fs.readdirSync(outDir)) if (f.endsWith('.pdf')) fs.rmSync(path.join(outDir, f))

const manifest = picked.map((r, i) => {
  const id = String(i + 1).padStart(3, '0')
  const staged = `${id}.pdf`
  fs.copyFileSync(path.join(src, r.file), path.join(outDir, staged))
  return { pdf_id: i + 1, staged, file: r.file, family: r.family,
           producer: r.producer, creator: r.creator, format: r.format,
           pages: r.pages, size: r.size }
})

fs.writeFileSync('tools/pdf-sweep/manifest.json', JSON.stringify(manifest, null, 2))
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`staged ${manifest.length} pdfs across ${new Set(manifest.map(m => m.family)).size} families`)
console.log([...new Set(manifest.map(m => m.family))].join(', '))
