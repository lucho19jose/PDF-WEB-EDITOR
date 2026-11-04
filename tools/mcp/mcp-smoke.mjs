// End-to-end test of the MCP server: the BUILT bundle, copied outside the repo
// (so it cannot fall back to the repo's node_modules), started over stdio by
// the SDK's own client, every tool called, and the saved files checked with
// mupdf directly.
//
//   npm run mcp:build && node tools/mcp/mcp-smoke.mjs [--electron]
//
// --electron runs the server on electron.exe with ELECTRON_RUN_AS_NODE=1, the
// way the installed app runs it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const imp = (p) => import(pathToFileURL(path.join(ROOT, 'node_modules', p)).href)
const { Client } = await imp('@modelcontextprotocol/sdk/dist/esm/client/index.js')
const { StdioClientTransport } = await imp('@modelcontextprotocol/sdk/dist/esm/client/stdio.js')
const mupdf = await imp('mupdf/dist/mupdf.js')

const useElectron = process.argv.includes('--electron')
// --mcpb: run the packed extension, unpacked, with the folders passed as
// `--roots` the way Claude Desktop passes its "Allowed folders" setting.
const useMcpb = process.argv.includes('--mcpb')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-mcp-smoke-'))
const DIST = path.join(TMP, 'server')
const WORK = path.join(TMP, 'work')
if (useMcpb) {
  fs.mkdirSync(DIST)
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/@anthropic-ai/mcpb/dist/cli/cli.js'), 'unpack', path.join(ROOT, 'release/pdf-editor-pro.mcpb'), DIST], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('mcpb unpack failed: ' + r.stderr)
} else fs.cpSync(path.join(ROOT, 'dist-mcp'), DIST, { recursive: true })
fs.mkdirSync(WORK)
for (const f of ['sample.pdf', '_scan2.pdf']) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(WORK, f))

let failures = 0
function check(label, okay, extra = '') {
  if (!okay) failures++
  console.log(`${okay ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + String(extra).slice(0, 300) : ''}`)
}

const command = useElectron ? path.join(ROOT, 'node_modules/electron/dist/electron.exe') : process.execPath
const env = { ...process.env, PDF_EDITOR_APP_EXE: process.execPath, PDF_EDITOR_APP_ARGS: JSON.stringify(['-e', '0']) }
if (!useMcpb) env.PDF_MCP_ROOTS = TMP
else delete env.PDF_MCP_ROOTS
if (useElectron) env.ELECTRON_RUN_AS_NODE = '1'
const serverArgs = useMcpb ? [path.join(DIST, 'server.mjs'), '--roots', TMP] : [path.join(DIST, 'server.mjs')]
const transport = new StdioClientTransport({ command, args: serverArgs, env, stderr: 'pipe' })
const stderr = []
transport.stderr?.on('data', d => stderr.push(String(d)))
const transportErrors = []
const client = new Client({ name: 'smoke', version: '1.0.0' })
await client.connect(transport)
transport.onerror = (e) => transportErrors.push(e)

const text = (r) => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
const json = (r) => { try { return JSON.parse(r.content[0].text) } catch { return {} } }
async function call(name, args = {}, expectError = false) {
  const t0 = Date.now()
  const r = await client.callTool({ name, arguments: args })
  const okay = expectError ? !!r.isError : !r.isError
  check(`${name}${expectError ? ' (refused)' : ''}`, okay, `${Date.now() - t0} ms  ${text(r).replace(/\s+/g, ' ').slice(0, 220)}`)
  return r
}

const { tools } = await client.listTools()
check(`tools listed (${tools.length})`, tools.length >= 50, tools.map(t => t.name).join(' '))
check('read-only tools are annotated', tools.find(t => t.name === 'render_page')?.annotations?.readOnlyHint === true)

const sample = path.join(WORK, 'sample.pdf')
await call('open_pdf', { path: path.join(os.homedir(), 'definitely-not-allowed.pdf') }, true)
let r = await call('open_pdf', { path: sample })
const doc = json(r).doc_id
check('doc id', doc === 'd1', doc)
// The same file under its other Windows spelling (8.3 short vs long name) is the same document.
const longForm = fs.realpathSync.native(sample)
r = await call('open_pdf', { path: longForm === sample ? sample : longForm })
check('one document whatever the spelling', json(r).already_open === true && json(r).doc_id === doc, `${sample} vs ${longForm}`)

r = await call('list_page_text', { page: 1 })
check('listing has refs and text', /\[p1b0\]/.test(text(r)) && /Sample PDF/.test(text(r)))
r = await call('find_text', { query: 'Sample' })
check('find gives a ref', json(r).matches?.length > 0)
r = await call('replace_text', { find: 'Sample PDF', replace: 'Ejemplo PDF' })
check('replaced', json(r).occurrences >= 1)
r = await call('render_page', { page: 1 })
check('render is a jpeg image', r.content[0]?.type === 'image' && r.content[0].mimeType === 'image/jpeg' && Buffer.from(r.content[0].data, 'base64')[0] === 0xFF)
r = await call('render_page', { page: 1, region: { x: 50, y: 50, width: 200, height: 60 } })
check('region render is a png', r.content[0]?.mimeType === 'image/png')
r = await call('get_text', {})
check('text has the edit', json(r).text?.includes('Ejemplo PDF'))

// Pages
await call('duplicate_pages', { pages: '1' })
r = await call('duplicate_pages', { pages: '1-2' })
check('four pages', json(r).pages_now === 4)
await call('rotate_pages', { pages: [2], degrees: 90 })
await call('move_pages', { pages: [4], before: 1 })
await call('reorder_pages', { order: [4, 3, 2, 1] })
await call('reorder_pages', { order: [1, 2] }, true)
r = await call('delete_pages', { pages: '3' })
check('three pages', json(r).pages_now === 3)
await call('delete_pages', { pages: 'all' }, true)
await call('insert_pages', { before: 4, blank_pages: 1 })
await call('crop_pages', { pages: '4', top: 20, bottom: 20 })

// An image to place: page 1 exported as PNG.
r = await call('export_pdf', { format: 'png', output_path: path.join(WORK, 'img', 'p1.png'), pages: '1', dpi: 40 })
const png = path.join(WORK, 'img', 'p1.png')
check('png written', fs.existsSync(png) && fs.readFileSync(png)[1] === 0x50)

// Annotations
await call('add_text_markup', { page: 1, text: 'Ejemplo' })
await call('add_text_markup', { page: 1, rect: { x: 60, y: 300, width: 100, height: 12 }, kind: 'strikeout' })
await call('add_note', { page: 1, x: 500, y: 60, text: 'Revisar esto' })
await call('add_free_text', { page: 1, x: 60, y: 700, text: 'José Luis Barboza\nDNI 12345678', font_size: 12 })
await call('add_shape', { page: 1, shape: 'rectangle', x: 50, y: 400, width: 120, height: 40, fill_color: '#fff59d' })
await call('add_shape', { page: 1, shape: 'line', x: 50, y: 460, x2: 300, y2: 460 })
await call('add_shape', { page: 1, shape: 'line', x: 50, y: 460 }, true)
await call('add_drawing', { page: 1, strokes: [[[300, 500], [320, 520], [340, 500]]] })
await call('add_stamp', { page: 2, stamp: 'Approved', x: 300, y: 80 })
await call('add_mark', { page: 1, mark: 'check', x: 40, y: 520, size: 12 })
await call('add_image', { page: 2, image_path: png, x: 60, y: 300, width: 120 })
await call('add_image', { page: 2, image_path: png, x: 260, y: 300, width: 80, placement: 'behind' })
r = await call('list_annotations', { page: 1 })
const annots = json(r).annotations || []
check('annotations listed', annots.length >= 7, annots.map(a => a.type).join(','))
const note = annots.find(a => a.type === 'Text')
const square = annots.find(a => a.type === 'Square')
if (note) await call('update_annotation', { ref: note.ref, text: 'Revisado' })
if (square) await call('delete_annotations', { refs: [square.ref] })
r = await call('list_images', { page: 2 })
const img = (json(r).images || [])[0]
check('content image listed', !!img)
if (img) {
  await call('edit_image', { ref: img.ref, action: 'move', x: 300, y: 500 })
  await call('edit_image', { ref: img.ref, action: 'flip_horizontal' })
}

// Text edits by reference
await call('add_text', { page: 1, x: 60, y: 600, text: 'Línea añadida por Claude\nSegunda línea', font_size: 12, bold: true, color: '#1a73e8' })
r = await call('list_page_text', { page: 1 })
const refLine = /\[(p1b\d+)\][^\n]*"Línea añadida por Claude"/.exec(text(r))?.[1]
const refHead = /\[(p1b\d+)\][^\n]*Ejemplo PDF/.exec(text(r))?.[1]
check('added text is listed', !!refLine)
if (refLine) {
  await call('transform_text', { refs: [refLine], dx: 10, dy: 20 })
  await call('restyle_text', { refs: [refLine], font_size: 14, color: '#c00000' })
  await call('edit_text_block', { ref: refLine, new_text: 'Línea editada' })
}
if (refHead) await call('transform_text', { refs: [refHead], scale: 1.2 })
r = await call('list_page_text', { page: 1 })
const refSecond = /\[(p1b\d+)\][^\n]*"Segunda línea"/.exec(text(r))?.[1]
if (refSecond) await call('delete_text', { refs: [refSecond] })
await call('edit_text_block', { ref: 'p9b9', new_text: 'x' }, true)

// Decorations, links, metadata
await call('set_header_footer', { header: { left: 'Contrato de prueba' }, footer: { center: '<<fecha>>' } })
await call('add_page_numbers', { position: 'bottom-right' })
await call('add_watermark', { text: 'BORRADOR', pages: '1-2' })
await call('set_background', { color: '#fff8dc', pages: '3' })
await call('remove_page_decoration', { kind: 'background' })
await call('add_link', { page: 1, x: 60, y: 60, width: 100, height: 20, url: 'https://example.com' })
r = await call('list_links', { page: 1 })
check('link listed', json(r).links?.some(l => l.url === 'https://example.com'))
await call('add_link', { page: 1, x: 60, y: 90, width: 100, height: 20, to_page: 2 })
await call('delete_link', { page: 1, index: 1 })
await call('set_metadata', { title: 'Prueba MCP', author: 'Claude' })
r = await call('get_document_info', {})
check('metadata set', json(r).metadata?.Title === 'Prueba MCP')

// Undo / redo
r = await call('undo', {})
r = await call('get_document_info', {})
check('undo reverted the metadata', json(r).metadata?.Title !== 'Prueba MCP')
await call('redo', {})
r = await call('get_document_info', {})
check('redo restored it', json(r).metadata?.Title === 'Prueba MCP')

// Export
for (const fmt of ['docx', 'xlsx', 'txt', 'html']) {
  r = await call('export_pdf', { format: fmt, output_path: path.join(WORK, `export.${fmt}`) })
  const f = path.join(WORK, `export.${fmt}`)
  check(`${fmt} written`, fs.existsSync(f) && fs.statSync(f).size > 100)
}
check('docx and xlsx are zips', ['docx', 'xlsx'].every(x => fs.readFileSync(path.join(WORK, `export.${x}`)).subarray(0, 2).toString() === 'PK'))

// Redact, save, check with mupdf
await call('redact', { text: 'Revisar' }, true)
r = await call('redact', { text: 'Ejemplo', page: 2 })
r = await call('save_pdf', {})
const saved = json(r).saved
check('saved beside the original', saved === path.join(fs.realpathSync.native(WORK), 'sample (editado).pdf'), saved)
await call('save_pdf', { path: sample }, true)
if (saved && fs.existsSync(saved)) {
  const d = new mupdf.PDFDocument(fs.readFileSync(saved))
  check('saved: 4 pages', d.countPages() === 4, d.countPages())
  const p1 = d.loadPage(0).toStructuredText().asText()
  check('saved: replaced text', p1.includes('Ejemplo PDF'))
  check('saved: page numbers', p1.includes('Página 1 de 4'), p1.slice(0, 200))
  check('saved: added and edited text', p1.includes('Línea editada') && !p1.includes('Segunda línea'))
  const p2 = d.loadPage(1).toStructuredText().asText()
  check('saved: redacted on page 2 only', !p2.includes('Ejemplo') && p1.includes('Ejemplo'))
  check('saved: annotations', d.loadPage(0).getAnnotations().length >= 6, d.loadPage(0).getAnnotations().length)
  check('saved: metadata', d.getMetaData('info:Title') === 'Prueba MCP')
}
r = await call('save_pdf', { path: path.join(WORK, 'protegido.pdf'), password: 'abc123', allow_copy: false })
check('protected file needs a password', new mupdf.PDFDocument(fs.readFileSync(path.join(WORK, 'protegido.pdf'))).needsPassword())

// The session now follows its last save (Save As): opening that path again
// returns it. A COPY of the protected file is refused without the password.
r = await call('open_pdf', { path: path.join(WORK, 'protegido.pdf') })
check('save retargets the session', json(r).already_open === true && json(r).doc_id === doc)
fs.copyFileSync(path.join(WORK, 'protegido.pdf'), path.join(WORK, 'protegido-copia.pdf'))
await call('open_pdf', { path: path.join(WORK, 'protegido-copia.pdf') }, true)
await call('open_pdf', { path: path.join(WORK, 'protegido-copia.pdf'), password: 'wrong' }, true)
r = await call('open_pdf', { path: path.join(WORK, 'protegido-copia.pdf'), password: 'abc123' })
const prot = json(r).doc_id
check('protected opened', !!prot && json(r).pages === 4)
await call('list_page_text', { page: 1 }, true)   // two documents open and no doc_id
r = await call('list_page_text', { doc_id: prot, page: 1 })
check('doc_id picks the document', /Ejemplo PDF/.test(text(r)))
await call('close_pdf', { doc_id: prot })

// Extract / split / combine / create
r = await call('extract_pages', { doc_id: doc, pages: '1-2', output_path: path.join(WORK, 'extracto.pdf') })
check('extract wrote 2 pages', new mupdf.PDFDocument(fs.readFileSync(path.join(WORK, 'extracto.pdf'))).countPages() === 2)
r = await call('split_pdf', { doc_id: doc, every: 2, output_dir: path.join(WORK, 'partes') })
check('split in two', json(r).parts === 2)
r = await call('combine_files', { paths: [path.join(WORK, 'extracto.pdf'), png, sample], output_path: path.join(WORK, 'combinado.pdf') })
check('combined 4 pages', json(r).pages === 4, json(r).pages)
r = await call('create_pdf', { blank_pages: 3, size: 'Letter', output_path: path.join(WORK, 'nuevo.pdf') })
check('created 3 blank pages', json(r).pages === 3)
r = await call('create_pdf', { images: [png] })
const fromImg = json(r).doc_id
await call('close_pdf', { doc_id: fromImg }, true)
await call('close_pdf', { doc_id: fromImg, discard_changes: true })
r = await call('list_documents', {})
check('documents listed', json(r).documents?.length === 3, JSON.stringify(json(r).documents?.map(d => d.doc_id)))

// The file changed on disk: picked up by the next call (d1 now lives at protegido.pdf).
await call('save_pdf', { doc_id: doc, path: path.join(WORK, 'sample (editado).pdf'), overwrite: true })
await new Promise(r => setTimeout(r, 50))
fs.copyFileSync(path.join(WORK, 'nuevo.pdf'), path.join(WORK, 'sample (editado).pdf'))
r = await call('get_document_info', { doc_id: doc })
check('disk change reloaded', json(r).pages === 3 && /changed on disk/.test(text(r)), text(r).slice(-200))

// open_in_editor (a stand-in exe here)
r = await call('open_in_editor', { doc_id: doc })

// A scanned page: no text blocks, but recognised and edited ON the scan.
r = await call('open_pdf', { path: path.join(WORK, '_scan2.pdf') })
const scan = json(r).doc_id
check('scan detected', json(r).scanned_pages !== undefined, JSON.stringify(json(r).scanned_pages))
r = await call('list_page_text', { doc_id: scan, page: 1 })
check('scan listing points to recognize_page', json(r).scanned === true && /recognize_page/.test(text(r)))
r = await call('recognize_page', { doc_id: scan, page: 1 })
const runs = json(r)?.runs ?? []
const runOf = (s) => (runs.find(x => x.includes(s)) ?? '').split(' | ')[0]
check('scan recognised', runs.length >= 8 && !!runOf('Regular sans text'), runs.slice(0, 4).join(' / '))
// A line nobody edits must come out pixel for pixel the same.
const untouched = { doc_id: scan, page: 1, dpi: 150, region: { x: 55, y: 315, width: 300, height: 25 } }
const pngOf = (res) => res.content.find(c => c.type === 'image')?.data
const before = pngOf(await call('render_page', untouched))
r = await call('replace_text', { doc_id: scan, page: 1, find: 'Regular sans', replace: 'Normal sans' })
check('replace_text on a scan draws on the scan', json(r)?.pages?.[0]?.runs_redrawn_on_scan === 1, text(r))
r = await call('edit_scanned_text', { doc_id: scan, page: 1, edits: [{ ref: runOf('DATA'), text: 'DATOS' }, { ref: runOf('PROCESS'), text: '' }] })
check('edit_scanned_text: edit with the page\'s own letters, and a removal', json(r)?.drawn?.length === 2, text(r))
check('untouched line unchanged', pngOf(await call('render_page', untouched)) === before)
r = await call('get_text', { doc_id: scan, page: 1 })
check('new words in the text layer', /Normal sans text/.test(text(r)) && /DATOS/.test(text(r)) && !/Regular sans/.test(text(r)), text(r).slice(0, 200))
await call('undo', { doc_id: scan })
r = await call('get_text', { doc_id: scan, page: 1 })
check('undo takes the scan edit back', !/DATOS/.test(text(r)) && /Normal sans/.test(text(r)), text(r).slice(0, 200))
await call('redo', { doc_id: scan })
r = await call('edit_scanned_text', { doc_id: scan, page: 1, edits: [{ ref: runOf('Regular sans text'), text: 'Regular sans text, edited twice from the scan.' }] })
check('second edit of a line redraws from the scan', json(r)?.drawn?.length === 1, text(r))
await call('edit_scanned_text', { doc_id: scan, page: 1, edits: [{ ref: 'p1r999', text: 'x' }] }, true)
await call('add_free_text', { doc_id: scan, page: 1, x: 100, y: 100, text: 'Anotación sobre el escaneo' })

const t0 = Date.now()
await client.close()
check('no transport errors (stdout stayed JSON-RPC)', transportErrors.length === 0, transportErrors.map(e => e.message).join('; '))
await new Promise(r => setTimeout(r, 300))
console.log(`closed in ${Date.now() - t0} ms`)
if (failures) console.log('\n--- server stderr (tail) ---\n' + stderr.join('').slice(-3000))
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* a handle may linger on Windows */ }
process.exit(failures ? 1 : 0)
