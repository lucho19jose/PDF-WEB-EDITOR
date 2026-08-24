/** Pages filled nearly to the foot, so anything inserted has to spill. */
import fs from 'fs'
const PAGES = 4
const contents = []
for (let p = 1; p <= PAGES; p++) {
  const lines = [`BT /F1 16 Tf 0 0 0 rg 1 0 0 1 60 750 Tm (Pagina ${p} — encabezado) Tj ET`]
  let y = 720
  for (let i = 1; i <= 34; i++) {
    lines.push(`BT /F1 11 Tf 0 0 0 rg 1 0 0 1 60 ${y} Tm (Pagina ${p} linea ${i} de texto denso que llena la hoja completa) Tj ET`)
    y -= 20
  }
  contents.push(lines.join('\n') + '\n')
}
const parts = ['1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n']
const pageIds = []
for (let p = 0; p < PAGES; p++) pageIds.push(3 + p * 2)
parts.push(`2 0 obj\n<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${PAGES} >>\nendobj\n`)
const fontId = 3 + PAGES * 2
for (let p = 0; p < PAGES; p++) {
  parts.push(`${3 + p * 2} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + p * 2} 0 R >>\nendobj\n`)
  parts.push(`${4 + p * 2} 0 obj\n<< /Length ${contents[p].length} >>\nstream\n${contents[p]}endstream\nendobj\n`)
}
parts.push(`${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`)
const numbered = parts.map(o => ({ num: parseInt(o), text: o })).sort((a, b) => a.num - b.num)
let pdf = '%PDF-1.4\n'; const offs = []
for (const o of numbered) { offs.push(pdf.length); pdf += o.text }
const xref = pdf.length
pdf += `xref\n0 ${offs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
pdf += `trailer\n<< /Size ${offs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
fs.writeFileSync('public/_dense.pdf', Buffer.from(pdf, 'latin1'))
console.log('dense written')
