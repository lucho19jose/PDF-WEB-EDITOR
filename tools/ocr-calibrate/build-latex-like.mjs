/**
 * A PDF shaped the way pdfTeX makes them.
 *
 * Three traits that together defeat most editors and none of which appear in
 * Word or browser output:
 *   - a Type1 font with a CUSTOM /Differences encoding (LaTeX's OT1), so the
 *     byte 0x0B is not a vertical tab but the "ff" ligature;
 *   - NO /ToUnicode CMap at all, which is what a decoder normally reads;
 *   - words split into several show operations with kern jumps between them,
 *     which is how TeX applies its letter spacing.
 */
import fs from 'fs'

// OT1: ligatures live in the low codes, and there are no ASCII quotes.
const diffs = '0 /Gamma /Delta /Theta /Lambda /Xi /Pi /Sigma /Upsilon /Phi /Psi ' +
  '11 /ff /fi /fl /ffi /ffl /dotlessi /dotlessj /grave /acute /caron /breve /macron /ring /cedilla ' +
  '25 /germandbls /ae /oe /oslash /AE /OE /Oslash /suppress'

const content = [
  'BT /F15 14.34 Tf 1 0 0 1 100 700 Tm (Introduction to the subject) Tj ET',
  // A TJ array with kerns, as TeX emits.
  'BT /F15 10.9 Tf 1 0 0 1 100 670 Tm [(This)-333(is)-333(a)-334(paragraph)-333(set)-333(by)-333(pdfTeX)-333(with)-333(kerns.)]TJ ET',
  'BT /F15 10.9 Tf 1 0 0 1 100 650 Tm [(A)-334(second)-333(line)-333(of)-333(the)-333(same)-333(paragraph)-333(here.)]TJ ET',
  // A word carrying an OT1 ligature: byte 12 is /fi, so this reads "define".
  'BT /F15 10.9 Tf 1 0 0 1 100 630 Tm (de' + String.fromCharCode(92) + '014ne and re' + String.fromCharCode(92) + '014ne the terms) Tj ET'
].join('\n') + '\n'

const parts = [
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F15 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
  `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
  // No /ToUnicode. Encoding is a Differences array over a base.
  '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /FirstChar 0 /LastChar 127 /Encoding 6 0 R >>\nendobj\n',
  `6 0 obj\n<< /Type /Encoding /BaseEncoding /StandardEncoding /Differences [${diffs}] >>\nendobj\n`
]
let pdf = '%PDF-1.4\n'; const offs = []
for (const o of parts) { offs.push(pdf.length); pdf += o }
const xref = pdf.length
pdf += `xref\n0 ${offs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
pdf += `trailer\n<< /Size ${offs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
fs.writeFileSync('public/_latex.pdf', Buffer.from(pdf, 'latin1'))
console.log('written')
