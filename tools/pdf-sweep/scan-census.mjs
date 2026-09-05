// Which pages of a folder's PDFs are SCANS — the pages the OCR editor lives on.
//
// Usage: node tools/pdf-sweep/scan-census.mjs "<folder>" [maxPages] [...excludeManifests] > scan-census.json
//
// A page is judged the way the app judges it (`textLayerOf` in EditorLayout):
// the union of its text blocks over a 64×64 grid, under 2% of the paper, and
// images covering half the paper or more. Exclude manifests (JSON with `file`
// fields, or a TSV `id<TAB>name`) drop documents already staged in a corpus.
import fs from 'node:fs'
import path from 'node:path'
import * as mupdf from 'mupdf'

const dir = process.argv[2]
const maxPages = Number(process.argv[3] || 4)
const exclude = new Set()
for (const m of process.argv.slice(4)) {
  const text = fs.readFileSync(m, 'utf8')
  if (m.endsWith('.tsv')) for (const line of text.split(/\r?\n/)) { const t = line.split('\t')[1]; if (t) exclude.add(t.trim()) }
  else for (const e of JSON.parse(text)) if (e.file) exclude.add(e.file.replace(/\.pdf$/i, '').trim())
}
const norm = (f) => f.replace(/\.pdf$/i, '').trim()

function coverage(blocks, bounds, kind) {
  const [x0, y0, x1, y1] = bounds
  const W = x1 - x0, H = y1 - y0
  if (W <= 0 || H <= 0) return 0
  const N = 64
  const grid = new Uint8Array(N * N)
  for (const b of blocks) {
    if (b.type !== kind) continue
    const r = b.bbox
    const gx0 = Math.max(0, Math.floor((r.x - x0) / W * N)), gx1 = Math.min(N - 1, Math.floor((r.x + r.w - x0) / W * N))
    const gy0 = Math.max(0, Math.floor((r.y - y0) / H * N)), gy1 = Math.min(N - 1, Math.floor((r.y + r.h - y0) / H * N))
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) grid[gy * N + gx] = 1
  }
  let n = 0
  for (const v of grid) n += v
  return n / (N * N)
}

const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf'))
const rows = []
for (const f of files) {
  const row = { file: f, excluded: exclude.has(norm(f)), producer: null, pages: 0, scanPages: [], pageStats: [], error: null }
  const full = path.join(dir, f)
  try {
    const st = fs.statSync(full)
    row.size = st.size
    if (st.size > 60 * 1024 * 1024) { row.error = 'too large'; rows.push(row); continue }
    const doc = mupdf.Document.openDocument(fs.readFileSync(full), 'application/pdf')
    row.producer = doc.getMetaData('info:Producer') || null
    row.pages = doc.countPages()
    for (let i = 0; i < Math.min(row.pages, maxPages); i++) {
      try {
        const page = doc.loadPage(i)
        const bounds = page.getBounds()
        const st = page.toStructuredText('preserve-images')
        const blocks = JSON.parse(st.asJSON()).blocks || []
        let chars = 0
        for (const b of blocks) if (b.type === 'text') for (const l of b.lines || []) chars += (l.text || '').replace(/\s+/g, '').length
        const text = coverage(blocks, bounds, 'text')
        const image = coverage(blocks, bounds, 'image')
        const scan = text < 0.02 && image >= 0.5
        row.pageStats.push({ page: i + 1, chars, text: +text.toFixed(3), image: +image.toFixed(3), scan })
        if (scan) row.scanPages.push(i + 1)
        st.destroy?.(); page.destroy?.()
      } catch (e) { row.pageStats.push({ page: i + 1, error: String(e.message || e).slice(0, 80) }) }
    }
    doc.destroy?.()
  } catch (e) {
    row.error = String(e.message || e).slice(0, 120)
  }
  rows.push(row)
}
process.stdout.write(JSON.stringify(rows, null, 0))
