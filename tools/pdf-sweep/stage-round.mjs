// Stage every never-swept PDF of a folder as a new round under public/_sweep/<round>/.
//   node tools/pdf-sweep/stage-round.mjs "<srcFolder>" <round> [maxBytes]
// Unlike pick-new.mjs this never touches the main corpus, and takes everything
// not already listed in any manifest under public/_sweep (producer diversity in
// Downloads is exhausted; what is left is worth a run as a whole).
import fs from 'node:fs'
import path from 'node:path'

const [src, round, maxS = String(12 * 1024 * 1024)] = process.argv.slice(2)
if (!src || !round) { console.error('usage: stage-round.mjs <srcFolder> <round>'); process.exit(1) }
const maxBytes = Number(maxS)
const sweepDir = 'public/_sweep'
const swept = new Set()
const walk = (dir) => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (f === 'manifest.json') { try { for (const e of JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''))) swept.add(e.file) } catch (_) {} }
  }
}
walk(sweepDir)
let survey = []
for (const f of ['tools/pdf-sweep/survey-0905.json', 'tools/pdf-sweep/survey.json']) {
  try { survey = survey.concat(JSON.parse(fs.readFileSync(f, 'utf8'))) } catch (_) {}
}
const producerOf = new Map(survey.map(r => [r.file, r.producer || '']))
function family(p) {
  const s = (p || '').toLowerCase()
  if (!s.trim()) return 'unknown'
  for (const [k, v] of [['dompdf', 'dompdf'], ['pdf24', 'pdf24'], ['word', 'ms-word'], ['excel', 'ms-excel'], ['powerpoint', 'ms-powerpoint'], ['print to pdf', 'ms-printtopdf'], ['skia', 'skia-chrome'], ['ghostscript', 'ghostscript'], ['itextsharp', 'itextsharp'], ['itext', 'itext'], ['libreoffice', 'libreoffice'], ['quartz', 'quartz'], ['pdftex', 'tex'], ['dvipdfmx', 'tex'], ['miktex', 'tex'], ['ilovepdf', 'ilovepdf'], ['pdf-lib', 'pdf-lib'], ['acrobat', 'adobe'], ['adobe', 'adobe'], ['crystal', 'crystal'], ['weasyprint', 'weasyprint'], ['tcpdf', 'tcpdf'], ['canva', 'canva'], ['haru', 'haru'], ['qt ', 'qt'], ['scan', 'scanner'], ['intsig', 'scanner'], ['3-heights', '3heights'], ['docusign', 'docusign'], ['pypdf', 'pypdf'], ['pdftools', 'pdftools'], ['corel', 'corel']]) {
    if (s.includes(k)) return v
  }
  return 'other:' + s.slice(0, 18)
}
const files = fs.readdirSync(src).filter(f => f.toLowerCase().endsWith('.pdf') && !swept.has(f))
const outDir = path.join(sweepDir, round)
fs.mkdirSync(outDir, { recursive: true })
const manifest = []
let n = 0
for (const f of files) {
  const p = path.join(src, f)
  const size = fs.statSync(p).size
  if (size <= 0 || size > maxBytes) continue
  n++
  const id = String(n).padStart(3, '0')
  fs.copyFileSync(p, path.join(outDir, id + '.pdf'))
  manifest.push({ pdf_id: n, staged: `${round}/${id}.pdf`, file: f, producer: producerOf.get(f) || '', family: family(producerOf.get(f)), size })
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1))
console.log(`staged ${manifest.length} of ${files.length} unswept files into ${outDir}`)
const fams = new Map(); for (const m of manifest) fams.set(m.family, (fams.get(m.family) || 0) + 1)
console.log([...fams].sort((a, b) => b[1] - a[1]).map(([f, c]) => f + ':' + c).join(' '))
