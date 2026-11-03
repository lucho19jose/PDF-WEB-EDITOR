/**
 * "Exportar a Excel" over a corpus: every PDF through the real worker, the
 * app's layout and writer, one workbook each. Reports what failed and what
 * each workbook holds, so a change to the layout can be judged on hundreds of
 * documents rather than the one that prompted it.
 *
 *   node tools/pdf-sweep/xlsx-batch.mjs <out-dir> <pdf|dir|manifest.json>... [--pages N] [--single]
 *
 * Writes <out-dir>/<name>.xlsx and <out-dir>/summary.json. Validate the
 * workbooks afterwards with tools/pdf-sweep/xlsx-validate.py (openpyxl) or
 * open a few in Excel.
 */
import fs from 'fs'
import path from 'path'
import { createEngine } from './node-harness.mjs'

const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const maxPages = +(flag('--pages') ?? 4)
const single = args.includes('--single')
const positional = args.filter((a, i) => !a.startsWith('--') && !['--pages'].includes(args[i - 1]))
const [outDir, ...inputs] = positional
if (!outDir || !inputs.length) { console.error('usage: xlsx-batch.mjs <out-dir> <pdf|dir|manifest.json>...'); process.exit(2) }
fs.mkdirSync(outDir, { recursive: true })

const files = []
for (const inp of inputs) {
  if (inp.endsWith('.json')) {
    // The manifests are written by PowerShell, with a byte-order mark.
    const m = JSON.parse(fs.readFileSync(inp, 'utf8').replace(/^﻿/, ''))
    const list = Array.isArray(m) ? m : (m.files ?? m.items ?? [])
    for (const e of list) {
      const p = typeof e === 'string' ? e : (e.staged ?? e.path ?? e.file)
      if (p) files.push(path.isAbsolute(p) ? p : path.resolve(path.dirname(inp), path.basename(p)))
    }
  } else if (fs.statSync(inp).isDirectory()) {
    for (const f of fs.readdirSync(inp)) if (/\.pdf$/i.test(f)) files.push(path.join(inp, f))
  } else files.push(inp)
}

const eng = await createEngine()
const layout = await eng.ssrLoad('/src/utils/acro/sheetLayout.ts')
const writer = await eng.ssrLoad('/src/utils/acro/xlsx.ts')
const summary = []
for (const file of files) {
  const name = path.basename(path.dirname(file)) + '_' + path.basename(file, '.pdf')
  const rec = { file, name }
  const t0 = Date.now()
  try {
    await eng.load(file)
    const count = await eng.send('getPageCount')
    const n = typeof count === 'number' ? count : (count?.pageCount ?? count?.count ?? 1)
    const pages = Array.from({ length: Math.min(n, maxPages) }, (_, i) => i)
    const layouts = []
    let tables = 0, blocks = 0, words = 0, chars = 0
    for (const p of pages) {
      const data = await eng.send('acro', { op: 'sheetPage', args: { pageIndex: p } })
      words += data.words.length; chars += data.chars
      const L = layout.layoutPage(data)
      tables += L.items.filter(i => i.kind === 'table').length
      blocks += L.blocks.length
      layouts.push(L)
    }
    const sheets = single ? [layout.buildSheet(layouts, { name: 'Documento' })]
      : layouts.map((L, i) => layout.buildSheet([L], { name: `Página ${i + 1}` }))
    const blob = await writer.buildXlsx(sheets, { title: name })
    fs.writeFileSync(path.join(outDir, name + '.xlsx'), Buffer.from(await blob.arrayBuffer()))
    const cells = sheets.reduce((s, sh) => s + sh.cells.filter(c => c.text).length, 0)
    const merges = sheets.reduce((s, sh) => s + sh.cells.filter(c => (c.rows ?? 1) > 1 || (c.cols ?? 1) > 1).length, 0)
    const cols = Math.max(...sheets.map(sh => sh.colWidths.length))
    Object.assign(rec, { ok: true, pages: n, exported: pages.length, words, chars, tables, blocks, cells, merges, cols, bytes: blob.size })
  } catch (err) {
    Object.assign(rec, { ok: false, error: String(err?.stack || err).slice(0, 600) })
  }
  rec.ms = Date.now() - t0
  summary.push(rec)
  console.log(`${rec.ok ? 'ok ' : 'ERR'} ${String(rec.ms).padStart(6)}ms ${name}${rec.ok ? `  p${rec.exported}/${rec.pages} t${rec.tables} b${rec.blocks} cells${rec.cells} merges${rec.merges} cols${rec.cols}` : '  ' + rec.error.split('\n')[0]}`)
}
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1))
const bad = summary.filter(r => !r.ok)
console.log(`\n${summary.length} files, ${bad.length} failed, ${summary.reduce((s, r) => s + r.ms, 0)} ms total`)
await eng.close()
process.exit(0)
