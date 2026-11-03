/**
 * "Exportar a Excel" in node: the real worker reads each page, the app's own
 * layout and writer build the workbook.
 *
 *   node tools/pdf-sweep/xlsx-export.mjs <in.pdf> <out.xlsx> [--single] [--text] [--pages 1,3]
 *
 * --single   every page in one worksheet (default: one sheet per page)
 * --text     keep every cell as text (no number/date conversion)
 * --dump     print each sheet as a tab-separated grid (what landed where)
 */
import fs from 'fs'
import { createEngine } from './node-harness.mjs'

const args = process.argv.slice(2)
const [input, output] = args.filter(a => !a.startsWith('--') && !/^\d+(,\d+)*$/.test(a))
if (!input || !output) { console.error('usage: xlsx-export.mjs <in.pdf> <out.xlsx> [--single] [--text] [--dump]'); process.exit(2) }
const single = args.includes('--single'), text = args.includes('--text'), dump = args.includes('--dump')
const pi = args.indexOf('--pages')
const eng = await createEngine()
try {
  await eng.load(input)
  const layout = await eng.ssrLoad('/src/utils/acro/sheetLayout.ts')
  const writer = await eng.ssrLoad('/src/utils/acro/xlsx.ts')
  const count = await eng.send('getPageCount').catch(() => null)
  const n = typeof count === 'number' ? count : (count?.pageCount ?? count?.count ?? 1)
  const pages = pi >= 0 ? args[pi + 1].split(',').map(v => +v - 1) : Array.from({ length: n }, (_, i) => i)
  const t0 = Date.now()
  const layouts = []
  for (const p of pages) {
    const data = await eng.send('acro', { op: 'sheetPage', args: { pageIndex: p } })
    layouts.push(layout.layoutPage(data))
  }
  const sheets = single
    ? [layout.buildSheet(layouts, { name: 'Documento' })]
    : layouts.map((L, i) => layout.buildSheet([L], { name: `Página ${pages[i] + 1}` }))
  const blob = await writer.buildXlsx(sheets, { convertValues: !text, title: input })
  fs.writeFileSync(output, Buffer.from(await blob.arrayBuffer()))
  console.log(`${pages.length} page(s) -> ${sheets.length} sheet(s), ${blob.size} bytes, ${Date.now() - t0} ms`)
  if (dump) for (const s of sheets) {
    console.log(`\n=== ${s.name} ===`)
    const grid = new Map()
    for (const c of s.cells) if (c.text) grid.set(`${c.r},${c.c}`, c.text.replace(/\n/g, ' ⏎ ') + (c.cols > 1 || c.rows > 1 ? ` [${c.rows ?? 1}x${c.cols ?? 1}]` : ''))
    const maxR = Math.max(0, ...s.cells.map(c => c.r))
    for (let r = 0; r <= maxR; r++) {
      const line = []
      for (const [k, v] of grid) { const [rr, cc] = k.split(',').map(Number); if (rr === r) line[cc] = v }
      if (line.length) console.log(String(r + 1).padStart(3), [...line].map(v => v ?? '').join(' | '))
    }
  }
} finally {
  await eng.close()
}
process.exit(0)
