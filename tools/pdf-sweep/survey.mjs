// Quick producer census over a folder of PDFs, used to pick a diverse sweep set.
// Usage: node tools/pdf-sweep/survey.mjs "<folder>" > survey.json
import fs from 'node:fs'
import path from 'node:path'
import * as mupdf from 'mupdf'

const dir = process.argv[2]
const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf'))

const rows = []
for (const f of files) {
  const full = path.join(dir, f)
  const row = { file: f, size: 0, producer: null, creator: null, format: null, pages: 0, error: null }
  try {
    const st = fs.statSync(full)
    row.size = st.size
    if (st.size > 60 * 1024 * 1024) { row.error = 'too large'; rows.push(row); continue }
    const doc = mupdf.Document.openDocument(fs.readFileSync(full), 'application/pdf')
    row.producer = doc.getMetaData('info:Producer') || null
    row.creator = doc.getMetaData('info:Creator') || null
    row.format = doc.getMetaData('format') || null
    row.pages = doc.countPages()
    doc.destroy?.()
  } catch (e) {
    row.error = String(e.message || e).slice(0, 120)
  }
  rows.push(row)
}
process.stdout.write(JSON.stringify(rows, null, 0))
