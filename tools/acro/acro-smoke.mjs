/**
 * Smoke test for the Acrobat-style document tools (src/engine/worker/acroTools.ts),
 * through the real worker in node: every operation runs, and the saved result
 * is re-read with MuPDF to check it did what it says.
 *
 *   node tools/acro/acro-smoke.mjs [file.pdf]
 */
import fs from 'fs'
import { createEngine, ROOT } from '../pdf-sweep/node-harness.mjs'

const file = process.argv[2] || ROOT + '/public/sample.pdf'
const eng = await createEngine()
const mupdf = await import('mupdf')
const acro = (op, args) => eng.send('acro', { op, args })
let failures = 0
const check = (label, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`); if (!ok) failures++ }
const reopen = (bytes) => new mupdf.PDFDocument(new Uint8Array(bytes))
const textOf = (d, i) => { const p = d.loadPage(i); const t = p.toStructuredText().asText(); p.destroy(); return t }

await eng.load(file)
// Make a 4-page document to organize: duplicate page 1 three times.
for (let k = 0; k < 3; k++) await eng.send('duplicatePage', { pageIndex: 0 })
const { pageCount } = await eng.send('getPageCount')
check('setup: 4 pages', pageCount === 4, `got ${pageCount}`)

// Header / footer with tokens on every page.
let r = await acro('headerFooter', { pages: [0, 1, 2, 3], header: { left: '', center: 'CONFIDENCIAL', right: '' },
  footer: { left: '', center: '', right: 'Página <<1>> de <<n>>' }, fontName: 'Helvetica', fontSize: 10, color: [0, 0, 0],
  margins: { top: 36, bottom: 36, left: 72, right: 72 }, startNumber: 1, date: '09/10/2026' })
check('headerFooter applied', r.success && r.pages === 4, JSON.stringify(r))
let saved = await eng.send('saveDocument')
let d = reopen(saved.bytes)
check('footer text on page 3', textOf(d, 2).includes('Página 3 de 4'), JSON.stringify(textOf(d, 2).slice(-60)))
check('header text on page 1', textOf(d, 0).includes('CONFIDENCIAL'))
d.destroy()
// Updating replaces (no stacking).
r = await acro('headerFooter', { pages: [0, 1, 2, 3], header: { left: '', center: 'BORRADOR', right: '' }, footer: { left: '', center: '', right: '' },
  fontName: 'Helvetica', fontSize: 10, color: [0, 0, 0], margins: { top: 36, bottom: 36, left: 72, right: 72 }, startNumber: 1, date: '' })
saved = await eng.send('saveDocument'); d = reopen(saved.bytes)
check('header updated, old one gone', textOf(d, 0).includes('BORRADOR') && !textOf(d, 0).includes('CONFIDENCIAL'))
d.destroy()
const tagged = await acro('hasTagged')
check('hasTagged sees header', tagged.headerFooter && !tagged.watermark, JSON.stringify(tagged))

// Watermark behind, translucent and turned.
r = await acro('watermark', { pages: [0, 1, 2, 3], text: 'MUESTRA', fontName: 'Helvetica-Bold', widthFraction: 0.6, fontSize: 72,
  color: [1, 0, 0], opacity: 0.3, rotation: 45, behind: true, vAlign: 'middle' })
check('watermark applied', r.success && r.pages === 4, JSON.stringify(r))
saved = await eng.send('saveDocument'); d = reopen(saved.bytes)
check('watermark text present', textOf(d, 1).includes('MUESTRA'))
d.destroy()
r = await acro('removeTagged', { kind: 'watermark' })
saved = await eng.send('saveDocument'); d = reopen(saved.bytes)
check('watermark removed', r.removed === 4 && !textOf(d, 1).includes('MUESTRA'), JSON.stringify(r))
d.destroy()

// Background.
r = await acro('background', { pages: [0], color: [1, 1, 0.8], opacity: 1 })
check('background applied', r.success && r.pages === 1)

// Crop: 72pt margins all round.
r = await acro('cropPages', { indices: [1], margins: { top: 72, right: 72, bottom: 72, left: 72 } })
let size = await eng.send('getPageSize', { pageIndex: 1 })
const size0 = await eng.send('getPageSize', { pageIndex: 0 })
check('crop shrinks the page by 144pt', r.success && Math.abs(size0.width - size.width - 144) < 0.5, `${size0.width} → ${size.width}`)
const crop = await acro('cropOf', { pageIndex: 1 })
check('cropOf reads margins back', Math.abs(crop.top - 72) < 0.5 && Math.abs(crop.left - 72) < 0.5, JSON.stringify(crop))
r = await acro('cropPages', { indices: [1], margins: { top: 0, right: 0, bottom: 0, left: 0 } })
size = await eng.send('getPageSize', { pageIndex: 1 })
check('crop removed', Math.abs(size.width - size0.width) < 0.5)

// Rotate two pages, rearrange (reverse), extract, split, replace, delete.
r = await acro('rotatePages', { indices: [0, 2], degrees: 90 })
size = await eng.send('getPageSize', { pageIndex: 2 })
check('rotatePages', r.success && size.rotation === 90, JSON.stringify(size))
r = await acro('rearrange', { order: [3, 2, 1, 0] })
size = await eng.send('getPageSize', { pageIndex: 1 })
check('rearrange reverses', r.success && size.rotation === 90, JSON.stringify(size))
r = await acro('extractPages', { indices: [0, 2] })
d = reopen(r.bytes); check('extract 2 pages', r.success && d.countPages() === 2); d.destroy()
r = await acro('split', { every: 3 })
check('split into 2 parts', r.success && r.parts.length === 2 && reopen(r.parts[1]).countPages() === 1)
const sample = fs.readFileSync(file)
r = await acro('replacePages', { indices: [1], bytes: sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength) })
size = await eng.send('getPageSize', { pageIndex: 1 })
check('replace keeps count, page now unrotated', r.success && r.pageCount === 4 && size.rotation === 0, JSON.stringify({ r, size }))
r = await acro('deletePages', { indices: [0, 3] })
check('delete 2 pages', r.success && r.pageCount === 2, JSON.stringify(r))
r = await acro('deletePages', { indices: [0, 1] })
check('cannot delete every page', !r.success)

// Links, redaction, metadata, outline, export.
await acro('addLink', { pageIndex: 0, rect: [72, 72, 200, 90], target: { uri: 'https://example.com' } })
await acro('addLink', { pageIndex: 0, rect: [72, 100, 200, 118], target: { page: 2 } })
let links = await acro('listLinks', { pageIndex: 0 })
check('two links', links.length === 2 && links[1].page === 2, JSON.stringify(links))
await acro('deleteLink', { pageIndex: 0, index: 0 })
links = await acro('listLinks', { pageIndex: 0 })
check('delete link', links.length === 1)
const blk = (await eng.send('getPageText', { pageIndex: 0 })).blocks.find(b => b.text.trim().length > 3 && !/BORRADOR/.test(b.text))
await acro('addRedaction', { pageIndex: 0, rect: blk.bbox })
check('one redaction marked', (await acro('countRedactions')) === 1)
r = await acro('applyRedactions')
const after = (await eng.send('getPageText', { pageIndex: 0 })).blocks.map(b => b.text).join(' ')
check('redaction removes the text', r.success && r.pages === 1 && !after.includes(blk.text.trim()), `removed "${blk.text.trim().slice(0, 30)}"`)
await acro('setMetadata', { meta: { Title: 'Prueba', Author: 'Acrobat UI' } })
const meta = await acro('getMetadata')
check('metadata', meta.Title === 'Prueba' && meta.Author === 'Acrobat UI' && meta.pageCount === '2', JSON.stringify(meta))
check('outline is an array', Array.isArray(await acro('outline')))
const txt = await acro('exportText')
check('export text', txt.includes('BORRADOR'))
const html = await acro('exportHtml')
check('export html', html.includes('<div id="page0"'))
const st = await acro('exportStructured')
check('export structured', st.length === 2 && Array.isArray(st[0].blocks))
const png = await acro('renderImage', { pageIndex: 0, scale: 0.5, format: 'png' })
check('render png', new Uint8Array(png)[1] === 0x50)
const jpg = await acro('renderImage', { pageIndex: 0, scale: 0.5, format: 'jpeg', quality: 80 })
check('render jpeg', new Uint8Array(jpg)[0] === 0xFF)

// Protect, then unlock.
const prot = await acro('saveProtected', { userPassword: 'abc123', permissions: { print: true, copy: false } })
check('protected needs a password', await acro('needsPassword', { bytes: prot.slice(0) }))
r = await acro('unlock', { bytes: prot.slice(0), password: 'wrong' })
check('wrong password refused', !r.success)
r = await acro('unlock', { bytes: prot.slice(0), password: 'abc123' })
check('right password opens', r.success && !(await acro('needsPassword', { bytes: r.bytes.slice(0) })))

// Create from images.
r = await acro('createPdf', { images: [png.slice(0), jpg.slice(0)] })
d = reopen(r.bytes)
check('create from 2 images', r.success && d.countPages() === 2); d.destroy()
r = await acro('createPdf', { images: [] })
check('create blank', r.success && r.pages === 1)
r = await acro('flatten')
check('flatten', r.success)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
await eng.close()
process.exit(failures ? 1 : 0)
