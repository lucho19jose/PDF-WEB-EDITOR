/**
 * A scan that reproduces the reported failures.
 *
 * Five headings printed side by side across one visual row (which OCR groups
 * into a single line), a bold row, an italic row, and a label set on its side.
 * Rendered to an image and wrapped in a PDF, so the result is a genuine scan:
 * no text objects at all.
 */
import * as mupdf from 'mupdf'
import fs from 'fs'

const c = []
const put = (font, size, x, y, text, rot = 0) => {
  const m = rot === 90 ? '0 1 -1 0' : '1 0 0 1'
  c.push(`BT /${font} ${size} Tf 0.11 0.16 0.35 rg ${m} ${x} ${y} Tm (${text}) Tj ET`)
}

// The row that used to come back as ONE run: five headings, wide gaps between.
const cols = [['DATA', 60], ['PROCESS', 170], ['CROSS-FUNCTIONAL', 280], ['PERFORMANCE', 420], ['CUSTOMER', 520]]
for (const [t, x] of cols) put('FB', 11, x, 600, t)
for (const [t, x] of cols) put('FB', 11, x, 585, 'DETAIL')

put('FR', 12, 60, 520, 'Regular sans text set across the page for comparison.')
put('FI', 12, 60, 495, 'Italic sans text set across the page for comparison.')
put('FB', 18, 60, 460, 'Bold heading at eighteen point')
put('FM', 12, 60, 430, 'Monospaced 0123456789 sample')
// Set on its side, reading bottom to top.
put('FB', 13, 35, 300, 'VERTICAL SIDE LABEL', 90)

const content = c.join('\n') + '\n'
const FACES = [['FR', 'Helvetica'], ['FB', 'Helvetica-Bold'], ['FI', 'Helvetica-Oblique'], ['FM', 'Courier']]
const fontRes = FACES.map(([ref], i) => `/${ref} ${4 + i} 0 R`).join(' ')
const parts = [
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
  `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${fontRes} >> >> /Contents ${4 + FACES.length} 0 R >>\nendobj\n`,
  ...FACES.map(([, face], i) => `${4 + i} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /${face} /Encoding /WinAnsiEncoding >>\nendobj\n`),
  `${4 + FACES.length} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`
]
let pdf = '%PDF-1.4\n'
const offs = []
for (const o of parts) { offs.push(pdf.length); pdf += o }
const xref = pdf.length
pdf += `xref\n0 ${offs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
pdf += `trailer\n<< /Size ${offs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
fs.writeFileSync('tools/ocr-calibrate/typed.pdf', Buffer.from(pdf, 'latin1'))

// ── flatten it into a scan ──
const doc = mupdf.Document.openDocument(fs.readFileSync('tools/ocr-calibrate/typed.pdf'), 'application/pdf')
const page = doc.loadPage(0)
const DPI = 150
const pix = page.toPixmap(mupdf.Matrix.scale(DPI / 72, DPI / 72), mupdf.ColorSpace.DeviceRGB, false)
const jpeg = Buffer.from(pix.asJPEG(85, false))
const W = pix.getWidth(), H = pix.getHeight()

const imgContent = `q 612 0 0 792 0 0 cm /Im0 Do Q\n`
const sparts = [
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
  `4 0 obj\n<< /Length ${imgContent.length} >>\nstream\n${imgContent}endstream\nendobj\n`,
  `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n@@JPEG@@\nendstream\nendobj\n`
]
let spdf = '%PDF-1.4\n'
const soffs = []
for (const o of sparts) { soffs.push(spdf.length); spdf += o }
const sxref = spdf.length
spdf += `xref\n0 ${soffs.length + 1}\n0000000000 65535 f \n` + soffs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
spdf += `trailer\n<< /Size ${soffs.length + 1} /Root 1 0 R >>\nstartxref\n${sxref}\n%%EOF\n`

const [head, tail] = spdf.split('@@JPEG@@')
fs.writeFileSync('public/_scan2.pdf', Buffer.concat([Buffer.from(head, 'latin1'), jpeg, Buffer.from(tail, 'latin1')]))

const check = mupdf.Document.openDocument(fs.readFileSync('public/_scan2.pdf'), 'application/pdf')
const st = JSON.parse(check.loadPage(0).toStructuredText().asJSON())
let chars = 0
for (const b of st.blocks ?? []) for (const l of b.lines ?? []) chars += l.text.length
console.log('scan built,', W + 'x' + H, 'px — real text characters in it:', chars)
