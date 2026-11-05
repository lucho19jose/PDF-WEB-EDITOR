/**
 * Pages copied between documents keep their annotations, fields and
 * signatures (src/engine/worker/pageGraft.ts).
 *
 *   node --experimental-strip-types --test tools/pdf-sweep/page-graft.test.mjs
 *
 * The documents are built here: a page signed the way Intellisign signs (a
 * /Sig widget that is its own field, with an appearance and a /V whose
 * /Reference names the catalog), a note with its popup and a reply, links to
 * pages kept and left behind, and a field whose two widgets sit on two pages.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mupdf from 'mupdf'
import { graftPagesWithAnnotations } from '../../src/engine/worker/pageGraft.ts'

const reopen = d => new mupdf.PDFDocument(d.saveToBuffer('compress,garbage=compact').asUint8Array().slice())

function rect(doc, r) {
  const a = doc.newArray()
  for (const v of r) a.push(doc.newReal(v))
  return a
}

function addAnnot(doc, pageIndex, dict) {
  const page = doc.findPage(pageIndex)
  dict.put('P', page)
  let annots = page.get('Annots')
  if (annots.isNull()) { annots = doc.newArray(); page.put('Annots', annots) }
  const ref = doc.addObject(dict)
  annots.push(ref)
  return ref
}

function formFields(doc) {
  const catalog = doc.getTrailer().get('Root')
  let form = catalog.get('AcroForm')
  if (form.isNull()) { form = doc.addObject(doc.newDictionary()); form.put('Fields', doc.newArray()); catalog.put('AcroForm', form) }
  return form.get('Fields')
}

/** A widget that is its own signed /Sig field, drawing a black box. */
function addSignature(doc, pageIndex, name, r) {
  const ap = doc.addStream('0 0 0 rg 0 0 40 20 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 40, 20] })
  const sigRef = doc.newDictionary()
  sigRef.put('Type', doc.newName('SigRef'))
  sigRef.put('TransformMethod', doc.newName('DocMDP'))
  sigRef.put('Data', doc.getTrailer().get('Root')) // what must not drag the source along
  const refs = doc.newArray(); refs.push(sigRef)
  const v = doc.newDictionary()
  v.put('Type', doc.newName('Sig'))
  v.put('Filter', doc.newName('Adobe.PPKLite'))
  v.put('Contents', doc.newByteString(new Uint8Array(64).fill(7)))
  v.put('ByteRange', rect(doc, [0, 10, 20, 30]))
  v.put('Reference', refs)
  const w = doc.newDictionary()
  w.put('Type', doc.newName('Annot'))
  w.put('Subtype', doc.newName('Widget'))
  w.put('FT', doc.newName('Sig'))
  w.put('T', doc.newString(name))
  w.put('V', doc.addObject(v))
  w.put('F', doc.newInteger(132))
  w.put('Rect', rect(doc, r))
  const apd = doc.newDictionary(); apd.put('N', ap); w.put('AP', apd)
  const ref = addAnnot(doc, pageIndex, w)
  formFields(doc).push(ref)
  return ref
}

function source() {
  const doc = new mupdf.PDFDocument()
  for (let i = 0; i < 3; i++) doc.insertPage(-1, doc.addPage([0, 0, 300, 300], 0, {}, ''))
  addSignature(doc, 0, 'Signature1', [20, 20, 60, 40])
  // A note, its popup, and a reply to it.
  const p0 = doc.loadPage(0)
  const note = p0.createAnnotation('Text'); note.setRect([100, 100, 120, 120]); note.setContents('nota'); note.setPopup([130, 130, 230, 190]); note.update()
  const reply = p0.createAnnotation('Text'); reply.setRect([100, 130, 120, 150]); reply.setContents('respuesta'); reply.update()
  reply.getObject().put('IRT', note.getObject())
  // Links to page 2 (copied with page 1 below) and to page 3 (left behind).
  for (const [r, to] of [[[200, 20, 230, 40], 1], [[240, 20, 270, 40], 2]]) {
    const d = doc.newDictionary()
    d.put('Type', doc.newName('Annot')); d.put('Subtype', doc.newName('Link')); d.put('Rect', rect(doc, r))
    const dest = doc.newArray(); dest.push(doc.findPage(to)); dest.push(doc.newName('Fit')); d.put('Dest', dest)
    addAnnot(doc, 0, d)
  }
  // A text field with one widget on page 1 and one on page 3.
  const field = doc.addObject(doc.newDictionary())
  field.put('FT', doc.newName('Tx')); field.put('T', doc.newString('Nombre')); field.put('V', doc.newString('Ana'))
  const kids = doc.newArray(); field.put('Kids', kids)
  for (const p of [0, 2]) {
    const w = doc.newDictionary()
    w.put('Type', doc.newName('Annot')); w.put('Subtype', doc.newName('Widget')); w.put('Rect', rect(doc, [20, 250, 120, 270]))
    w.put('Parent', field)
    kids.push(addAnnot(doc, p, w))
  }
  formFields(doc).push(field)
  return reopen(doc)
}

function annots(doc, p) {
  const a = doc.findPage(p).get('Annots')
  const out = []
  if (a.isNull()) return out
  for (let i = 0; i < a.length; i++) out.push({ ref: a.get(i), dict: a.get(i).resolve() })
  return out
}
const subtypes = (doc, p) => annots(doc, p).map(a => a.dict.get('Subtype').asName())
function fieldNames(doc) {
  const f = doc.getTrailer().get('Root').get('AcroForm').get('Fields')
  const out = []
  for (let i = 0; i < f.length; i++) out.push(f.get(i).resolve().get('T').asString())
  return out
}
/** Dark pixels inside a PDF-space rect of a rendered page. */
function ink(doc, p, r) {
  const page = doc.loadPage(p)
  const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true)
  const w = pix.getWidth(), px = pix.getPixels(), H = page.getBounds()[3]
  let n = 0
  for (let y = Math.ceil(H - r[3]); y < H - r[1]; y++) for (let x = Math.ceil(r[0]); x < r[2]; x++) if (px[y * w + x] < 128) n++
  return n
}

test('extracting pages keeps their signatures, notes and fields, and nothing else of the source', () => {
  const src = source()
  const out = new mupdf.PDFDocument()
  const r = graftPagesWithAnnotations(out, src, [{ from: 0, at: -1 }, { from: 1, at: -1 }])
  const back = reopen(out)
  assert.equal(back.countPages(), 2)
  assert.deepEqual(subtypes(back, 0).sort(), ['Link', 'Popup', 'Popup', 'Text', 'Text', 'Widget', 'Widget'].sort(),
    'the link into page 3 (not copied) is dropped; everything else comes along')
  assert.equal(r.annotations, 7)
  // The signature: drawn, still signed, its own field.
  assert.ok(ink(back, 0, [20, 20, 60, 40]) > 600)
  const sig = annots(back, 0).find(a => a.dict.get('FT').toString() === '/Sig').dict
  assert.equal(sig.get('V').resolve().get('Type').asName(), 'Sig')
  assert.ok(sig.get('V').resolve().get('Reference').get(0).get('Data').isNull(), 'the catalog reference is not followed')
  assert.ok(back.countObjects() < 40, `only the two pages' objects (${back.countObjects()})`)
  // Every /P is its own page, the popup and its note point at each other, the reply at its note.
  const own = new Set(annots(back, 0).map(a => a.ref.asIndirect()))
  for (const { dict } of annots(back, 0)) {
    assert.equal(dict.get('P').asIndirect(), back.findPage(0).asIndirect())
    const s = dict.get('Subtype').asName()
    if (s === 'Popup') assert.ok(own.has(dict.get('Parent').asIndirect()))
    if (s === 'Link') assert.equal(dict.get('Dest').get(0).asIndirect(), back.findPage(1).asIndirect())
    if (s === 'Text' && !dict.get('IRT').isNull()) assert.equal(dict.get('IRT').resolve().get('Contents').asString(), 'nota')
  }
  // The field keeps its hierarchy with only the widget that came along.
  assert.deepEqual(fieldNames(back).sort(), ['Nombre', 'Signature1'])
  const nombre = annots(back, 0).find(a => a.dict.get('Subtype').asName() === 'Widget' && !a.dict.get('Parent').isNull()).dict.get('Parent').resolve()
  assert.equal(nombre.get('Kids').length, 1)
  assert.equal(nombre.get('V').asString(), 'Ana')
})

test('inserting into a document that has fields of the same names renames the newcomers', () => {
  const dst = source(), src = source()
  const before = dst.countPages()
  const r = graftPagesWithAnnotations(dst, src, [0, 1, 2].map(i => ({ from: i, at: 1 + i })))
  const back = reopen(dst)
  assert.equal(back.countPages(), before + 3)
  const names = fieldNames(back)
  assert.equal(new Set(names).size, names.length)
  assert.deepEqual(names.sort(), ['Nombre', 'Nombre+1', 'Signature1', 'Signature1+1'])
  assert.equal(r.renamed, 2)
  assert.equal(subtypes(back, 1).filter(s => s === 'Link').length, 2, 'both links kept: every page they point at came along')
  assert.ok(ink(back, 1, [20, 20, 60, 40]) > 600)
  // The inserted "Nombre+1" holds the inserted widgets (pages 2 and 4), not the original ones.
  const kids = annots(back, 1).find(a => a.dict.get('Subtype').asName() === 'Widget' && !a.dict.get('Parent').isNull()).dict.get('Parent').resolve().get('Kids')
  assert.equal(kids.length, 2)
  assert.equal(back.getTrailer().get('Root').get('AcroForm').get('SigFlags').asNumber() & 1, 1)
})

test('duplicating a page inside one document gives the copy annotations of its own', () => {
  const doc = source()
  graftPagesWithAnnotations(doc, doc, [{ from: 0, at: 1 }])
  const back = reopen(doc)
  assert.equal(back.countPages(), 4)
  const a = annots(back, 0), b = annots(back, 1)
  assert.equal(a.length, b.length)
  const shared = a.filter(x => b.some(y => y.ref.asIndirect() === x.ref.asIndirect()))
  assert.equal(shared.length, 0, 'no annotation object is shared between the page and its copy')
  for (const { dict } of b) assert.equal(dict.get('P').asIndirect(), back.findPage(1).asIndirect())
  const names = fieldNames(back)
  assert.equal(new Set(names).size, names.length, names.join(', '))
  assert.ok(ink(back, 1, [20, 20, 60, 40]) > 600)
  // The link to page 3 stays a link to page 3 — still in this document.
  assert.equal(subtypes(back, 1).filter(s => s === 'Link').length, 2)
})
