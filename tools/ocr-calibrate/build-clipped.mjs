/**
 * Text inside a clip barely one line tall — how Word table cells and Canva
 * text boxes bound their runs. A second line drawn below the first falls
 * outside the window and is invisible unless the clip is grown.
 */
import fs from 'fs'
const c = []
c.push('BT /F1 14 Tf 0 0 0 rg 1 0 0 1 60 740 Tm (Titulo sin recorte) Tj ET')
// Three clipped cells, each 18pt tall — one line and no more.
const cells = [[700, 'CELDA UNO texto original'], [640, 'CELDA DOS texto original'], [580, 'CELDA TRES texto original']]
for (const [y, t] of cells) {
  c.push(`q 55 ${y - 4} 300 18 re W n BT /F1 12 Tf 0 0 0 rg 1 0 0 1 60 ${y} Tm (${t}) Tj ET Q`)
}
c.push('BT /F1 12 Tf 0 0 0 rg 1 0 0 1 60 520 Tm (Linea de abajo que deberia bajar) Tj ET')
c.push('BT /F1 12 Tf 0 0 0 rg 1 0 0 1 60 490 Tm (Otra linea mas abajo) Tj ET')
const content = c.join('\n') + '\n'
const parts = [
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
  `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
  '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n'
]
let pdf = '%PDF-1.4\n'; const offs = []
for (const o of parts) { offs.push(pdf.length); pdf += o }
const xref = pdf.length
pdf += `xref\n0 ${offs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
pdf += `trailer\n<< /Size ${offs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
fs.writeFileSync('public/_clipped.pdf', Buffer.from(pdf, 'latin1'))
console.log('written')
