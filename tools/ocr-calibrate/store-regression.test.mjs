// Run with: node --experimental-strip-types --test tools/ocr-calibrate/store-regression.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { useOcrStore } from '../../src/stores/ocr.ts'

function fixture() {
  setActivePinia(createPinia())
  const store = useOcrStore()
  store.setResult({
    pageIndex: 0, pageWidth: 612, pageHeight: 792, confidence: 95, lang: 'spa',
    items: [{
      id: 'line', pageIndex: 0, originalText: 'Los términos del contrato', text: 'Los términos del contrato',
      rect: { x: 20, y: 30, width: 260, height: 16 },
      inkRect: { x: 20, y: 30, width: 260, height: 16 }, words: [],
      fontSize: 16.9, fontFamily: 'Helvetica', bold: false, italic: false,
      color: [0.2, 0.2, 0.2], background: [1, 1, 1], align: 'left', rotation: -0.4,
      vertical: false, confidence: 95, edited: false, removed: false
    }]
  })
  return { store, item: () => store.itemsFor(0)[0] }
}

test('measuring a skewed scan while opening its editor never creates an edit', () => {
  const { store, item } = fixture()
  store.updateItem('line', { fontSize: 10.5, restyled: false })
  assert.equal(item().fontSize, 10.5)
  assert.equal(item().edited, false)
  assert.equal(item().restyled, false)
  assert.equal(store.hasEdits, false)
  assert.deepEqual(store.editedItems(0), [])
  // Closing the editor with its original reading is equally harmless.
  store.updateItem('line', { text: item().originalText })
  assert.equal(store.hasEdits, false)
})

test('a refined measurement preserves an existing applied text edit', () => {
  const { store, item } = fixture()
  store.updateItem('line', { text: 'Los términos del contrato firmado' })
  store.updateItem('line', { applied: true })
  store.updateItem('line', { fontSize: 10.5, restyled: false })
  assert.equal(item().edited, true)
  assert.equal(item().applied, true)
  assert.equal(item().text, 'Los términos del contrato firmado')
})

test('restoring a line restores its measured size, face, colour, alignment and position', () => {
  const { store, item } = fixture()
  store.updateItem('line', { fontSize: 10.5, restyled: false })
  store.updateItem('line', { fontSize: 20, fontFamily: 'Times-Roman', bold: true })
  store.updateItem('line', { italic: true, color: [1, 0, 0], align: 'right', rotation: 3 })
  store.updateItem('line', { rect: { ...item().rect, x: 80 }, text: 'Edited' })
  store.updateItem('line', { applied: true })
  store.revertItem('line')
  assert.equal(item().fontSize, 10.5)
  assert.equal(item().fontFamily, 'Helvetica')
  assert.equal(item().bold, false)
  assert.equal(item().italic, false)
  assert.deepEqual(item().color, [0.2, 0.2, 0.2])
  assert.equal(item().align, 'left')
  assert.equal(item().rotation, -0.4)
  assert.deepEqual(item().rect, item().inkRect)
  assert.equal(item().text, item().originalText)
  assert.equal(item().edited, false)
  assert.equal(item().restyled, false)
  assert.equal(item().applied, false)
  assert.equal(item().originalStyle, undefined)
})

test('unchanged style controls do not restyle a scan', () => {
  const { store, item } = fixture()
  store.updateItem('line', { fontSize: 16.9, fontFamily: 'Helvetica', bold: false, color: [0.2, 0.2, 0.2] })
  assert.equal(item().edited, false)
  assert.equal(item().restyled, undefined)
  assert.equal(item().originalStyle, undefined)
})

test('finalising a bake establishes a fresh restore baseline', () => {
  const { store, item } = fixture()
  store.updateItem('line', { fontSize: 20, text: 'Edited' })
  store.updateItem('line', { baked: true, edited: false, restyled: false, originalText: 'Edited', applied: true })
  store.updateItem('line', { fontSize: 24 })
  store.revertItem('line')
  assert.equal(item().fontSize, 20)
  assert.equal(item().text, 'Edited')
})
