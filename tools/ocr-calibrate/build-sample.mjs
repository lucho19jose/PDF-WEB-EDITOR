/**
 * A page of KNOWN type, for calibrating the font detector.
 *
 * The detector has to tell bold from regular, italic from upright and serif
 * from sans by looking at pixels alone — that is all a scan gives it. Every
 * threshold it uses is therefore measured off this page rather than guessed,
 * the same way the font-size constant was.
 */
import fs from 'fs'

const FACES = [
  ['Helvetica', 'F1'], ['Helvetica-Bold', 'F2'], ['Helvetica-Oblique', 'F3'],
  ['Times-Roman', 'F4'], ['Times-Bold', 'F5'], ['Times-Italic', 'F6'],
  ['Courier', 'F7'], ['Courier-Bold', 'F8']
]
const SIZES = [12, 24]
const SAMPLE = 'Hamburgefonstiv 123'

let content = ''
const rows = []
let y = 740
for (const size of SIZES) {
  for (const [face, ref] of FACES) {
    content += `BT /${ref} ${size} Tf 0 0 0 rg 1 0 0 1 60 ${y} Tm (${SAMPLE}) Tj ET\n`
    rows.push({ face, size, baselineY: y })
    y -= size * 2.2
  }
  y -= 20
}

const fontObjs = FACES.map(([face, ref], i) =>
  `${4 + i} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /${face} /Encoding /WinAnsiEncoding >>\nendobj\n`
).join('')
const fontRes = FACES.map(([, ref], i) => `/${ref} ${4 + i} 0 R`).join(' ')

const objs = [
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
  `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${fontRes} >> >> /Contents ${4 + FACES.length} 0 R >>\nendobj\n`,
  fontObjs,
  `${4 + FACES.length} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`
]

let pdf = '%PDF-1.4\n'
const offsets = []
for (const o of objs) {
  // fontObjs is several objects concatenated; record each one's offset.
  let rest = o
  while (rest.length) {
    const end = rest.indexOf('endobj\n') + 'endobj\n'.length
    offsets.push(pdf.length)
    pdf += rest.slice(0, end)
    rest = rest.slice(end)
  }
}
const xref = pdf.length
pdf += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`
for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n'
pdf += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`

fs.writeFileSync('tools/ocr-calibrate/sample.pdf', Buffer.from(pdf, 'latin1'))
fs.writeFileSync('tools/ocr-calibrate/sample.json', JSON.stringify(rows, null, 2))
console.log('sample.pdf written,', rows.length, 'rows')
