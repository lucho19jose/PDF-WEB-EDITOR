/** A plain multi-page text document, for testing paging and move collisions. */
import fs from 'fs'
const PAGES = 6
const objs = []
const kids = []
let n = 3
const contents = []
for (let p = 1; p <= PAGES; p++) {
  const lines = []
  let y = 700
  lines.push(`BT /F1 20 Tf 0 0 0 rg 1 0 0 1 60 740 Tm (Page ${p} heading) Tj ET`)
  // One deliberately long line: wider than the window at any useful zoom, which
  // is the case where opening the editor used to throw the view to its end.
  lines.push(`BT /F1 11 Tf 0 0 0 rg 1 0 0 1 40 725 Tm (START-OF-LINE alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau END) Tj ET`)
  for (let i = 1; i <= 8; i++) {
    lines.push(`BT /F1 12 Tf 0 0 0 rg 1 0 0 1 60 ${y} Tm (Page ${p} line ${i} of body text here) Tj ET`)
    y -= 40
  }
  contents.push(lines.join('\n') + '\n')
}
let body = ''
const parts = []
parts.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
const pageIds = []
for (let p = 0; p < PAGES; p++) pageIds.push(3 + p * 2)
parts.push(`2 0 obj\n<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${PAGES} >>\nendobj\n`)
const fontId = 3 + PAGES * 2
for (let p = 0; p < PAGES; p++) {
  parts.push(`${3 + p * 2} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + p * 2} 0 R >>\nendobj\n`)
  parts.push(`${4 + p * 2} 0 obj\n<< /Length ${contents[p].length} >>\nstream\n${contents[p]}endstream\nendobj\n`)
}
parts.push(`${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`)
// Objects must appear in numeric order for a simple xref.
const numbered = parts.map(o => ({ num: parseInt(o), text: o })).sort((a, b) => a.num - b.num)
let pdf = '%PDF-1.4\n'
const offs = []
for (const o of numbered) { offs.push(pdf.length); pdf += o.text }
const xref = pdf.length
pdf += `xref\n0 ${offs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
pdf += `trailer\n<< /Size ${offs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
fs.writeFileSync('public/_pages.pdf', Buffer.from(pdf, 'latin1'))
console.log('written', PAGES, 'pages')
