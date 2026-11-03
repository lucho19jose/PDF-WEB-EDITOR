// Run with: node --experimental-strip-types --test tools/pdf-sweep/xlsx-export.test.mjs
//
// The two pure halves of "Exportar a Excel": turning cell text into numbers
// and dates, and rebuilding a page's words and rules as cells. The worker side
// and the .xlsx writer are covered end to end by xlsx-batch.mjs over the corpus.
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCellValue, detectConventions } from '../../src/utils/acro/cellValue.ts'
import { layoutPage, buildSheet } from '../../src/utils/acro/sheetLayout.ts'

const US = { decimal: '.', dayFirst: true }
const serial = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000

test('amounts become numbers that print as the PDF printed them', () => {
  assert.deepEqual(parseCellValue('S/ 1,170.00', US), { value: 1170, fmt: '"S/ "#,##0.00', kind: 'number' })
  assert.deepEqual(parseCellValue('2.79%', US), { value: 0.0279, fmt: '0.00%', kind: 'number' })
  assert.equal(parseCellValue('(1,234.56)', US).value, -1234.56)
  assert.equal(parseCellValue('(1,234.56)', US).fmt, '#,##0.00;(#,##0.00)')
  // SAP prints a negative with its minus at the end.
  assert.deepEqual(parseCellValue('1,234.56-', US), { value: -1234.56, fmt: '#,##0.00;#,##0.00-', kind: 'number' })
  assert.deepEqual(parseCellValue('3', US), { value: 3, fmt: undefined, kind: 'number' })
})

test('identifiers and ambiguous text stay text', () => {
  assert.equal(parseCellValue('20606091380', US).kind, 'text') // RUC
  assert.equal(parseCellValue('007', US).kind, 'text')
  assert.equal(parseCellValue('1,5', US).kind, 'text')
  assert.equal(parseCellValue('S/ 1,170.00 S/ 210.60', US).kind, 'text')
  assert.equal(parseCellValue('F001-00344345', US).kind, 'text')
})

test('dates become dates, day first unless the document says otherwise', () => {
  assert.deepEqual(parseCellValue('26/08/2026', US), { value: serial(2026, 8, 26), fmt: 'dd/mm/yyyy', kind: 'date' })
  assert.equal(parseCellValue('31/02/2026', US).kind, 'text')
  assert.equal(parseCellValue('2026-08-26', US).value, serial(2026, 8, 26))
  // A part over 12 can only be the day, whatever the document's habit.
  assert.equal(parseCellValue('08/26/2026', US).value, serial(2026, 8, 26))
})

test('the decimal separator is decided by the document', () => {
  const eu = detectConventions(['23.059,52', '1.234,50', '12,00'])
  assert.equal(eu.decimal, ',')
  assert.equal(parseCellValue('23.059,52', eu).value, 23059.52)
  assert.equal(detectConventions(['1,234.56', '30.00']).decimal, '.')
})

function word(text, x0, y0, size = 8, extra = {}) {
  const w = text.length * size * 0.5
  return { x0, y0, x1: x0 + w, y1: y0 + size * 1.15, base: y0 + size, size, text, bold: false, italic: false, color: 0, font: 'Arial', sp: 1, ...extra }
}
function page(words, hRules, vRules) {
  return { pageIndex: 0, width: 595, height: 842, words, hRules, vRules, fills: [], marks: [], chars: 99, imageCover: 0 }
}
const h = (y, x0, x1) => ({ y, x0, x1, w: 0.75, color: 0 })
const v = (x, y0, y1) => ({ x, y0, y1, w: 0.75, color: 0 })

test('a ruled table comes back as its cells, with a merge where a border is missing', () => {
  // 3 columns x 3 rows; the title row has no inner borders (one merged cell).
  const words = [
    word('TITULO', 120, 104), word('Item', 60, 124), word('Cant.', 160, 124), word('Total', 260, 124),
    word('Cable', 60, 144), word('2', 160, 144), word('1,170.00', 260, 144)
  ]
  const H = [h(100, 50, 350), h(120, 50, 350), h(140, 50, 350), h(160, 50, 350)]
  const V = [v(50, 100, 160), v(350, 100, 160), v(150, 120, 160), v(250, 120, 160)]
  const sheet = buildSheet([layoutPage(page(words, H, V))], { name: 'Página 1' })
  const at = (r, c) => sheet.cells.find(x => x.r === r && x.c === c && x.text)
  const title = sheet.cells.find(c => c.text === 'TITULO')
  assert.equal(title.cols, 3)
  const cable = sheet.cells.find(c => c.text === 'Cable')
  assert.equal(at(cable.r, cable.c + 1).text, '2')
  assert.equal(at(cable.r, cable.c + 2).text, '1,170.00')
  assert.ok(title.border?.top && cable.border?.left, 'borders are kept')
})

test('a box with no column lines is cut into columns by its gutters', () => {
  // One ruled box (no inner lines) holding a header and two item lines.
  const words = [
    word('ITEM', 60, 104), word('DESCRIPCION', 120, 104), word('TOTAL', 300, 104),
    word('1', 60, 124), word('Servicio', 120, 124), word('120.00', 300, 124),
    word('2', 60, 144), word('Licencia', 120, 144), word('80.00', 300, 144)
  ]
  const H = [h(100, 50, 360), h(160, 50, 360)]
  const V = [v(50, 100, 160), v(360, 100, 160)]
  const sheet = buildSheet([layoutPage(page(words, H, V))], { name: 'x' })
  const c = t => sheet.cells.find(x => x.text === t)
  assert.equal(c('Servicio').r, c('120.00').r)
  assert.notEqual(c('Servicio').c, c('120.00').c)
  assert.equal(c('1').c, c('2').c)
  assert.equal(c('120.00').c, c('TOTAL').c)
})

test('an unruled table keeps one column per field across rows', () => {
  const rows = [['Fecha', 'Descripcion', 'Importe'], ['01/02/2026', 'Pago proveedor', '1,200.00'], ['03/02/2026', 'Deposito', '350.50']]
  const words = rows.flatMap((r, i) => [word(r[0], 40, 100 + i * 14), word(r[1], 140, 100 + i * 14), word(r[2], 360, 100 + i * 14)])
  const sheet = buildSheet([layoutPage(page(words, [], []))], { name: 'x' })
  const col = t => sheet.cells.find(x => x.text === t).c
  assert.equal(col('Fecha'), col('01/02/2026'))
  assert.equal(col('Descripcion'), col('Deposito'))
  assert.equal(col('Importe'), col('350.50'))
  assert.equal(new Set([col('Fecha'), col('Descripcion'), col('Importe')]).size, 3)
})
