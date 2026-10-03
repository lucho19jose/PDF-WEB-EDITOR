/**
 * Scan-edit lab — the transplant pipeline (lineInk / glyphAtlas / scanEdit) in
 * node, on a PDF's own scan pixels, without a browser or an OCR engine.
 *
 *   node tools/ocr-calibrate/scan-edit-lab.mjs <pdf> <fixture.json> <cmd> [args...]
 *
 * The fixture is the OCR runs the fidelity driver exports from the app
 * (`__fidelity.exportFixture()`, or the inline export in its header). Commands:
 *
 *   lines <page>                  analyse every line, print what was found
 *   debug <page> <id> <out.png>   the line's analysis drawn over its pixels
 *   atlas <page>                  the page's glyph atlas: coverage and styles
 *   edit <page> <suite.json> <outDir>   apply a suite's edits on that page,
 *                                 write before/after crops and the overlays
 *
 * Everything is imported through Vite's SSR loader, so the modules are the
 * app's own (aliases and TypeScript included).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')
const mupdf = await import(pathToFileURL(ROOT + '/node_modules/mupdf/dist/mupdf.js').href)
const { createServer } = await import(pathToFileURL(ROOT + '/node_modules/vite/dist/node/index.js').href)
const server = await createServer({
  root: ROOT, configFile: ROOT + '/vite.config.ts',
  server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: [] },
})
globalThis.ImageData = class ImageData {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4) }
}
// VARIANT=<dir>: the OCR modules are loaded from a copy of src/utils/ocr there
// instead — a variant can be measured without touching src/ (and the dev
// server's hot reload) while a browser run is going.
const load = (p) => server.ssrLoadModule(process.env.VARIANT && p.startsWith('/src/utils/ocr/') ? '/@fs/' + process.env.VARIANT.replace(/\\/g, '/') + '/' + p.slice('/src/utils/ocr/'.length) : p)
const R = await load('/src/utils/ocr/scanRaster.ts')
const LI = await load('/src/utils/ocr/lineInk.ts')

const [pdfPath, fixturePath, cmd, ...args] = process.argv.slice(2)
const doc = mupdf.PDFDocument.openDocument(fs.readFileSync(pdfPath), 'application/pdf')
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

/** The largest image a page's content draws, with its CTM — a simplified version of the worker's `getScanImage`. */
export function scanOf(pageIndex) {
  const page = doc.loadPage(pageIndex)
  const obj = page.getObject()
  const bounds = page.getBounds()
  const pageW = bounds[2] - bounds[0], pageH = bounds[3] - bounds[1]
  // RENDER=1: the page's content rendered at up to 300 DPI — what the app reads
  // when the scan is not one upright image (a layered "compact PDF", a /Rotate
  // page, tiles).
  if (process.env.RENDER) {
    const scale = Math.min(300 / 72, Math.sqrt(16e6 / (pageW * pageH)))
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, false)
    const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), src = pix.getPixels()
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0, j = 0; i < w * h; i++, j += n) { rgba[i * 4] = src[j]; rgba[i * 4 + 1] = src[j + 1]; rgba[i * 4 + 2] = src[j + 2]; rgba[i * 4 + 3] = 255 }
    return R.scanRasterOf(w, h, rgba, [w / scale, 0, 0, h / scale, 0, 0], w / scale, h / scale, '')
  }
  // /Contents may be an ARRAY of streams; readStream() is asked of each
  // indirect element, never of a resolved one (MuPDF quirk).
  const contents = obj.get('Contents')
  let content = ''
  if (contents.resolve().isArray()) {
    const arr = contents.resolve()
    for (let i = 0; i < arr.length; i++) content += arr.get(i).readStream().asString() + '\n'
  } else content = contents.readStream().asString()
  const xo = (obj.getInheritable ? obj.getInheritable('Resources') : obj.get('Resources')).get('XObject')
  // The CTM at each `/Name Do`, replaying q/Q/cm (the transforms nest: a
  // page often wraps its scan in a flip, then places the image inside it).
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]]
  const placed = new Map()
  {
    let ctm = [1, 0, 0, 1, 0, 0]
    const stack = []
    const nums = []
    const re = /\/([^\s/<>[\]()]+)|([-+]?\d*\.?\d+)|([A-Za-z*'"]+)/g
    let m, lastName = null
    while ((m = re.exec(content))) {
      if (m[1]) { lastName = m[1]; continue }
      if (m[2]) { nums.push(Number(m[2])); continue }
      const op = m[3]
      if (op === 'q') stack.push(ctm)
      else if (op === 'Q') ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]
      else if (op === 'cm' && nums.length >= 6) ctm = mul(nums.slice(-6), ctm)
      else if (op === 'Do' && lastName && !placed.has(lastName)) placed.set(lastName, ctm)
      nums.length = 0
    }
  }
  let best = null
  xo.forEach((v, k) => {
    const name = String(k).replace(/^\//, '')
    const ctm = placed.get(name)
    if (!ctm) return
    const area = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])
    if (!best || area > best.area) best = { name, ref: v, ctm, area }
  })
  if (!best) throw new Error('no image')
  let pix = doc.loadImage(best.ref).toPixmap()
  if (pix.getNumberOfComponents() !== 3 || pix.getAlpha()) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false)
  const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), src = pix.getPixels()
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0, j = 0; i < w * h; i++, j += n) { rgba[i * 4] = src[j]; rgba[i * 4 + 1] = src[j + 1]; rgba[i * 4 + 2] = src[j + 2]; rgba[i * 4 + 3] = 255 }
  return R.scanRasterOf(w, h, rgba, best.ctm, pageW, pageH, best.name)
}

/** applyLineEdit, with a reversed-out line edited on the inverted page and folded back into `work`. */
function editOn(SE, pi, li, atlas, text, work, opts) {
  if (!li.inverted) return SE.applyLineEdit(pi, li, atlas, text, work, opts)
  const pl = LI.invertedPage(pi)
  const w = pl.s.data.slice()
  const res = SE.applyLineEdit(pl, li, atlas, text, w, opts)
  const orig = pl.s.data
  for (let i = 0; i < w.length; i += 4) {
    if (w[i] === orig[i] && w[i + 1] === orig[i + 1] && w[i + 2] === orig[i + 2]) continue
    work[i] = 255 - w[i]; work[i + 1] = 255 - w[i + 1]; work[i + 2] = 255 - w[i + 2]
  }
  return res
}

/** RGBA region → PNG file, optionally magnified (nearest). */
export function savePng(file, w, h, rgba, zoom = 1) {
  const W = w * zoom, H = h * zoom
  const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], false)
  const o = pm.getPixels()
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const si = (Math.floor(y / zoom) * w + Math.floor(x / zoom)) * 4, oi = (y * W + x) * 3
    o[oi] = rgba[si]; o[oi + 1] = rgba[si + 1]; o[oi + 2] = rgba[si + 2]
  }
  fs.writeFileSync(file, pm.asPNG())
}

function cropRgba(s, x0, y0, x1, y1, src = s.data) {
  const w = x1 - x0, h = y1 - y0
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) out.set(src.subarray(((y0 + y) * s.w + x0) * 4, ((y0 + y) * s.w + x1) * 4), y * w * 4)
  return out
}

const itemsOf = (p) => fixture.pages.find(pg => pg.pageIndex === p).items.filter(i => !i.vertical)
const t0 = Date.now()
const ms = () => `${Date.now() - t0}ms`

if (cmd === 'lines' || cmd === 'debug') {
  const p = Number(args[0])
  const s = scanOf(p)
  console.log(`page ${p}: scan ${s.name} ${s.w}x${s.h} toPage ${s.toPage.map(v => +v.toFixed(4)).join(' ')} (${ms()})`)
  const pi = LI.preparePage(s)
  console.log(`prepared (${ms()})`)
  const items = itemsOf(p).filter(i => cmd === 'lines' || i.id === args[1])
  let words = 0, cut = 0
  for (const it of items) {
    const li = LI.analyzeLine(pi, { id: it.id, text: it.text, inkRect: it.inkRect, confidence: it.confidence })
    if (!li) { console.log(`${it.id.padEnd(9)} FAIL ${LI.lastLineFailure()}  "${it.text.slice(0, 50)}"`); continue }
    words += li.words.length; cut += li.words.filter(w => w.cut).length
    const ws = li.words.map(w => `${li.chars.slice(w.from, w.to).join('')}${w.cut ? '' : '~'}${w.weight ? '/' + w.weight.toFixed(3) : ''}`).join(' ')
    if (process.env.PALE && LI.lastPaleTest) console.log('     pale', JSON.stringify(LI.lastPaleTest()), 'smooth', JSON.stringify(LI.lastSmoothTest?.()))
    if (process.env.INK && LI.lastInkTest) { const m = LI.lastInkTest(); if (m) { const so = [...m].sort((x, y) => x - y); console.log('     ink', m.join(' ')) } }
    if (process.env.FRAG) console.log('   frag', JSON.stringify(LI.lastFragTest?.()))
    console.log(`${it.id.padEnd(9)} em ${li.fit.emPx.toFixed(1)} sl ${li.fit.slope.toFixed(4)} gaps ${li.letterGapPx}/${li.wordGapPx} core ${li.coreLevel} rules ${li.rules.length} cut ${li.words.filter(w => w.cut).length}/${li.words.length} | ${ws.slice(0, 160)}`)
    if (cmd === 'debug') {
      const { x0, y0, x1, y1 } = li.roi
      const img = cropRgba(s, x0, y0, x1, y1)
      const W = x1 - x0
      const tint = (p, r, g, b) => { const x = p % s.w - x0, y = Math.floor(p / s.w) - y0; const i = (y * W + x) * 4; img[i] = (img[i] + r) / 2; img[i + 1] = (img[i + 1] + g) / 2; img[i + 2] = (img[i + 2] + b) / 2 }
      li.cells.forEach((c, k) => { const col = k % 2 ? [0, 90, 255] : [0, 200, 120]; for (const p of c.pix) tint(p, ...col) })
      for (const p of li.protect) tint(p, 255, 0, 0)
      for (const r of li.rules) for (const p of r.pix) tint(p, 255, 160, 0)
      // Baseline in magenta.
      for (let x = x0; x < x1; x++) { const y = Math.round(li.fit.y + li.fit.slope * (x - li.fit.centreX)); if (y >= y0 && y < y1) { const i = ((y - y0) * W + x - x0) * 4; img[i] = 255; img[i + 1] = 0; img[i + 2] = 255 } }
      savePng(args[2], W, y1 - y0, img, 3)
      console.log('cells:', li.cells.map(c => `${c.char}[${c.x0}-${c.x1}${c.suspect ? '!' : ''}${c.approx ? '~' : ''}${c.isolated ? '' : '^'}]`).join(' '))
      console.log('roi:', JSON.stringify(li.roi), 'rules:', li.rules.map(r => `[${r.x0}-${r.x1} y${r.y.toFixed(1)} t${r.thick}]`).join(' '))
    }
  }
  if (cmd === 'lines') console.log(`words cut ${cut}/${words} (${(100 * cut / Math.max(1, words)).toFixed(0)}%) (${ms()})`)
}

/** MuPDF rasterising the bundled match faces — the worker's `rasterGlyphs`, in node. */
const matchFonts = new Map()
let look = null
function nodeRasterize(GS) {
  return async (file, chars, emPx) => {
    let f = matchFonts.get(file)
    if (!f) { f = new mupdf.Font(file, fs.readFileSync(`${ROOT}/public/fonts/match/${file}.ttf`)); matchFonts.set(file, f) }
    return chars.map(ch => GS.rasterizeGlyph(mupdf, f, ch, emPx))
  }
}

/** Every recognised page of the fixture analysed, and the atlas built from them. */
async function pagesAndAtlas(GA) {
  const lines = []
  const pages = new Map()
  for (const pg of fixture.pages) {
    const s = scanOf(pg.pageIndex)
    const pi = LI.preparePage(s)
    const lis = []
    for (const it of pg.items.filter(i => !i.vertical)) {
      const li = LI.analyzeLine(pi, { id: it.id, text: it.text, inkRect: it.inkRect, confidence: it.confidence })
      if (li) { lis.push(li); lines.push({ pi, li, page: pg.pageIndex }) }
    }
    pages.set(pg.pageIndex, { s, pi, lis })
  }
  return { pages, atlas: GA.buildAtlas(lines) }
}

if (cmd === 'atlas') {
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const { atlas } = await pagesAndAtlas(GA)
  console.log(`atlas built (${ms()}): boldAt ${atlas.boldAt?.toFixed(4)} wordGapEm ${atlas.wordGapEm.toFixed(3)} spacing regular mu ${atlas.spacing.regular.mu.toFixed(3)} n ${atlas.spacing.regular.n} bold mu ${atlas.spacing.bold.mu.toFixed(3)} n ${atlas.spacing.bold.n}`)
  const rows = []
  for (const [ch, list] of [...atlas.byChar.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const b = list.filter(e => atlas.boldAt !== null && e.weight !== null && e.weight >= atlas.boldAt).length
    rows.push(`${ch}:${list.length - b}/${b}`)
  }
  console.log(rows.join('  '))
  // Contact sheet: for each char of a sample, the regular and bold picks at a 9pt body size.
  const sample = (args[0] || 'abcdefghijklmnopqrstuvwxyzáéíóúñABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;()/-%"')
  const em = 23.5, xh = 11.2
  const picks = []
  for (const bold of [false, true]) for (const ch of sample) {
    const p = GA.pickGlyph(atlas, { char: ch, emPx: em, xh, bold })
    picks.push({ ch, bold, p })
  }
  const cellW = 34, cellH = 44, perRow = sample.length
  const W = cellW * perRow, H = cellH * 2
  const img = new Uint8ClampedArray(W * H * 4).fill(255)
  for (const [i, { p, bold }] of picks.entries()) {
    const col = i % perRow, row = bold ? 1 : 0
    if (!p) { for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) { const o = ((row * cellH + y) * W + col * cellW + x) * 4; img[o] = 255; img[o + 1] = 0; img[o + 2] = 0 } ; continue }
    const ex = p.ex
    const ox = col * cellW + 4, oy = row * cellH + Math.round(32 - ex.baseY)
    for (let y = 0; y < ex.h; y++) for (let x = 0; x < ex.w; x++) {
      const X = ox + x, Y = oy + y
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue
      const o = (Y * W + X) * 4, t = (y * ex.w + x) * 3
      img[o] = img[o] * ex.t[t] / 255; img[o + 1] = img[o + 1] * ex.t[t + 1] / 255; img[o + 2] = img[o + 2] * ex.t[t + 2] / 255
    }
  }
  savePng(args[1] || "atlas.png", W, H, img, Number(args[2] || 2))
  console.log('missing regular:', picks.filter(x => !x.bold && !x.p).map(x => x.ch).join(''), ' missing bold:', picks.filter(x => x.bold && !x.p).map(x => x.ch).join(''))
}


if (cmd === 'edit') {
  // Apply a suite's edits for one page: `edit <page> <suite.json> <outDir> [label filter]`.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const SE = await load('/src/utils/ocr/scanEdit.ts')
  const p = Number(args[0])
  const suite = JSON.parse(fs.readFileSync(args[1], 'utf8')).filter(e => e.page === p && (!args[3] || e.label.includes(args[3])))
  const outDir = args[2]
  fs.mkdirSync(outDir, { recursive: true })
  const { pages, atlas } = await pagesAndAtlas(GA)
  console.log(`atlas ready (${ms()})`)
  const { s, pi, lis } = pages.get(p)
  const work = Uint8ClampedArray.from(s.data)
  const norm = (t) => (t || '').replace(/\s+/g, '').toLowerCase()
  // The same margins scanEditPage computes.
  const ends = lis.filter(l => l.words.length >= 5).map(l => l.words[l.words.length - 1].x1).sort((a, b) => a - b)
  const editOpts = { justifyTo: ends.length >= 3 ? ends[Math.floor(ends.length * 0.8)] : null, limitRight: s.w - Math.round(18 / Math.abs(s.toPage[0])) }
  console.log('margins', JSON.stringify(editOpts))
  for (const spec of suite) {
    const items = itemsOf(p)
    // `id` names the run outright, for text that occurs on more than one line.
    const it = spec.id != null ? items.find(i => i.id === spec.id) : spec.exact != null
      ? (items.find(i => i.text.trim() === spec.exact) ?? items.find(i => norm(i.text) === norm(spec.exact)))
      : (items.find(i => i.text.includes(spec.find)) ?? items.find(i => norm(i.text).includes(norm(spec.find))))
    if (!it) { console.log(`${spec.label}: run not found`); continue }
    const li = lis.find(l => l.id === it.id)
    if (!li) { console.log(`${spec.label}: line not analysed`); continue }
    const next = it.text.replace(spec.from ?? spec.find ?? spec.exact, spec.to)
    const t1 = Date.now()
    let res = editOn(SE, pi, li, atlas, next, work, editOpts)
    if (!res.ok && res.wanting?.length) {
      // Letters no page holds: fit the scan's look once, synthesise, retry.
      const GS = await load('/src/utils/ocr/glyphSynth.ts')
      look = await GS.fitScanLook(atlas, nodeRasterize(GS), { log: l => console.log(`   face ${l}`), near: { line: li.id, page: p, emPx: li.fit.emPx } })
      console.log(`   look: ${JSON.stringify(look)}`)
      const synth = new Map()
      if (look) for (const w of res.wanting) {
        const g = await GS.synthGlyph(look, nodeRasterize(GS), atlas, w)
        console.log(`   want "${w.char}" em ${w.emPx.toFixed(1)} xh ${w.xh?.toFixed(1)} capH ${w.capH?.toFixed(1)} bold ${w.bold} -> ${g ? `${g.w}x${g.h} ink ${g.inkL}-${g.inkR} base ${g.baseY}` : 'none'}`)
        if (g) synth.set(SE.wantKey(w), g)
      }
      res = editOn(SE, pi, li, atlas, next, work, { ...editOpts, synth })
    }
    const tookMs = Date.now() - t1
    if (!res.ok) { console.log(`${spec.label}: REFUSED ${res.reason}`); continue }
    console.log(`${spec.label}: ok ${tookMs}ms drawn=${res.drawn} box=${res.box ? [res.box.x0, res.box.y0, res.box.x1, res.box.y1].join(',') : '-'} ${res.notes.join('; ')}`)
    console.log(`   "${it.text.slice(0, 90)}"\n -> "${next.slice(0, 90)}"`)
    // Before/after crops of the line, 3x.
    const r = li.roi
    const pad = 6
    const x0 = Math.max(0, r.x0 - pad), y0 = Math.max(0, r.y0 - pad), x1 = Math.min(s.w, Math.max(r.x1, res.box?.x1 ?? 0) + pad), y1 = Math.min(s.h, r.y1 + pad)
    const cw = Math.min(x1 - x0, 700)
    const tag = spec.label.split(' ')[0]
    savePng(`${outDir}/${tag}-before.png`, cw, y1 - y0, cropRgba(s, x0, y0, x0 + cw, y1), 3)
    savePng(`${outDir}/${tag}-after.png`, cw, y1 - y0, cropRgba(s, x0, y0, x0 + cw, y1, work), 3)
    if (res.box) {
      // The changed region alone, 6x: before above after.
      const b = res.box
      const zx0 = Math.max(0, b.x0 - 8), zx1 = Math.min(s.w, Math.min(b.x1 + 8, zx0 + 260)), zy0 = Math.max(0, b.y0 - 8), zy1 = Math.min(s.h, b.y1 + 8)
      const zw = zx1 - zx0, zh = zy1 - zy0
      const both = new Uint8ClampedArray(zw * (zh * 2 + 2) * 4).fill(255)
      both.set(cropRgba(s, zx0, zy0, zx1, zy1), 0)
      both.set(cropRgba(s, zx0, zy0, zx1, zy1, work), zw * (zh + 2) * 4)
      savePng(`${outDir}/${tag}-zoom.png`, zw, zh * 2 + 2, both, 5)
      // The change IN CONTEXT: the line's band, from a little before the
      // changed box to just past it, before above after.
      const cx0 = Math.max(0, b.x0 - 240), cx1 = Math.min(s.w, b.x1 + 24), cy0 = r.y0, cy1 = r.y1
      const cw2 = cx1 - cx0, ch2 = cy1 - cy0
      const ctx2 = new Uint8ClampedArray(cw2 * (ch2 * 2 + 2) * 4).fill(255)
      ctx2.set(cropRgba(s, cx0, cy0, cx1, cy1), 0)
      ctx2.set(cropRgba(s, cx0, cy0, cx1, cy1, work), cw2 * (ch2 + 2) * 4)
      savePng(`${outDir}/${tag}-context.png`, cw2, ch2 * 2 + 2, ctx2, 3)
    }
    if (process.env.GAPS) {
      // Every gap of the new line, ink to ink.
      const ws = res.words
      console.log("   words", ws.map(w => `${w.text}[${w.x0}-${w.x1}]`).join(" "))
      console.log("   layout", res.debug.layout.join(" "))
      console.log("   ", res.debug.underlines.join(" | "))
    }
  }
}

if (cmd === 'look') {
  // `look <out.png> [sigma] [gamma]`: the letters the scan's look is fitted on,
  // each beside every match face (regular, bold) printed at the size and blur
  // the fit would use — what "Tinos scored 0.63" actually compared.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const GS = await load('/src/utils/ocr/glyphSynth.ts')
  const { atlas, pages: lookPages } = await pagesAndAtlas(GA)
  // `look <out.png> <sigma> <gamma> <page> <lineId>`: the refs a LINE's look is fitted on.
  let near
  if (args[4]) { const li = lookPages.get(Number(args[3])).lis.find(l => l.id === args[4]); near = { line: args[4], page: Number(args[3]), emPx: li.fit.emPx } }
  const picked = GS.lookRefs(atlas, near)
  if (!picked) { console.log('no refs'); process.exit(0) }
  console.log('refs:', picked.refs.map(ex => `${ex.char}@${ex.lineId}${picked.boldRef.has(ex) ? 'b' : ''}`).join(' '))
  const sigma = Number(args[1] ?? 0.85), gamma = Number(args[2] ?? 1)
  const rast = nodeRasterize(GS)
  const faces = GS.MATCH_FACES ?? []
  const cells = []
  for (const ex of picked.refs) {
    const row = [{ w: ex.w, h: ex.h, base: ex.baseY, inkL: ex.inkL, d: Array.from({ length: ex.w * ex.h }, (_, i) => 1 - ex.t[i * 3] / 255) }]
    for (const face of faces) for (const file of [face.regular, face.bold]) {
      const [gx, gH] = await rast(face.regular, ['x', 'H'], 100)
      const capPerEm = (gH.baseY - gH.top) / 100, xhPerEm = (gx.baseY - gx.top) / 100
      const em = picked.capRef.has(ex) ? picked.capRef.get(ex) / capPerEm : (ex.xh ?? ex.emPx * 0.5) / xhPerEm
      const [g] = await rast(file, [ex.char], em)
      if (!g) { row.push(null); continue }
      row.push({ w: g.w, h: g.h, base: g.baseY, inkL: g.inkL, d: GS.printedDarkness(g, sigma, gamma) })
    }
    cells.push({ ch: ex.char, bold: picked.boldRef.has(ex), row })
    console.log(`ref "${ex.char}" ${picked.boldRef.has(ex) ? 'bold' : 'regular'} ${ex.w}x${ex.h} base ${ex.baseY.toFixed(1)} capH ${picked.capRef.get(ex) ?? '-'} xh ${ex.xh?.toFixed(1)} page ${ex.page} line ${ex.lineId}`)
    const dark = GS.exemplarDarkness(ex)
    console.log('   ' + row.slice(1).map((g, k) => g ? `${['CaR', 'CaB', 'ArR', 'ArB', 'TiR', 'TiB', 'ClR', 'ClB'][k]} ${GS.agreement(dark, ex.w, ex.h, ex.inkL, ex.baseY, g.d, g.w, g.h, g.inkL, g.base).toFixed(2)}` : '-').join('  '))
    {
      const inkDark = Math.max(0.2, 1 - (ex.inkT[0] * 299 + ex.inkT[1] * 587 + ex.inkT[2] * 114) / 1000 / 255)
      let m = 0, raw = 0
      for (let k = 0; k < dark.length; k++) if (ex.m[k]) { m += Math.min(1, dark[k] / inkDark); raw += dark[k] }
      console.log(`   mass ref ${m.toFixed(1)} (raw ${raw.toFixed(1)}, ink ${inkDark.toFixed(2)}) faces ` + row.slice(1).map((g, k) => g ? `${['CaR', 'CaB', 'ArR', 'ArB', 'TiR', 'TiB', 'ClR', 'ClB'][k]} ${g.d.reduce((t, v) => t + v, 0).toFixed(1)}` : '-').join(' '))
      if (GS.stemOfForLab) {
        const ink75 = Math.max(0.75, inkDark)
        const cov = new Float32Array(dark.length)
        for (let k = 0; k < cov.length; k++) cov[k] = ex.m[k] ? Math.min(1, dark[k] / ink75) : 0
        const refStem = GS.stemOfForLab(cov, ex.w, ex.h, ex.baseY, ex.emPx)
        const fs = []
        let k = 0
        for (const face of faces) for (const file of [face.regular, face.bold]) {
          const [gx, gH] = await rast(face.regular, ['x', 'H'], 100)
          const capPerEm = (gH.baseY - gH.top) / 100, xhPerEm = (gx.baseY - gx.top) / 100
          const em = picked.capRef.has(ex) ? picked.capRef.get(ex) / capPerEm : (ex.xh ?? ex.emPx * 0.5) / xhPerEm
          const [g] = await rast(file, [ex.char], em)
          const st = g ? GS.stemOfForLab(g.cov, g.w, g.h, g.baseY, em) : null
          fs.push(`${['CaR', 'CaB', 'ArR', 'ArB', 'TiR', 'TiB', 'ClR', 'ClB'][k++]} ${st?.toFixed(2) ?? '-'}`)
        }
        console.log(`   stem ref ${refStem?.toFixed(2) ?? '-'} faces ${fs.join(' ')}`)
      }
    }
  }
  const cw = Math.max(...cells.flatMap(c => c.row.filter(Boolean).map(r => r.w))) + 6
  const above = Math.max(...cells.flatMap(c => c.row.filter(Boolean).map(r => r.base))) + 3
  const below = Math.max(...cells.flatMap(c => c.row.filter(Boolean).map(r => r.h - r.base))) + 3
  const ch = Math.ceil(above + below)
  const cols = 1 + faces.length * 2
  const W = cw * cols, H = ch * cells.length
  const img = new Uint8ClampedArray(W * H * 4).fill(255)
  cells.forEach((c, r) => c.row.forEach((g, k) => {
    if (!g) return
    const ox = k * cw + 3 + Math.round(-g.inkL + 4), oy = r * ch + Math.round(above - g.base)
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      const X = ox + x, Y = oy + y
      if (X < k * cw || X >= (k + 1) * cw || Y < 0 || Y >= H) continue
      const o = (Y * W + X) * 4, v = Math.round(255 * (1 - Math.min(1, g.d[y * g.w + x])))
      img[o] = Math.min(img[o], v); img[o + 1] = Math.min(img[o + 1], v); img[o + 2] = Math.min(img[o + 2], v)
    }
  }))
  savePng(args[0], W, H, img, 2)
  console.log('columns: page |', faces.map(f => `${f.family} R | ${f.family} B`).join(' | '))
}

if (cmd === 'refine') {
  // `refine <page> <suite.json> <label>`: how the typed text re-reads the line.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const SE = await load('/src/utils/ocr/scanEdit.ts')
  const p = Number(args[0])
  const spec = JSON.parse(fs.readFileSync(args[1], 'utf8')).find(e => e.page === p && e.label.includes(args[2]))
  const { pages, atlas } = await pagesAndAtlas(GA)
  const { pi, lis } = pages.get(p)
  const it = spec.id ? itemsOf(p).find(i => i.id === spec.id) : itemsOf(p).find(i => i.text.includes(spec.find ?? spec.exact))
  const li = lis.find(l => l.id === it.id)
  const next = it.text.replace(spec.from ?? spec.find ?? spec.exact, spec.to)
  const r = SE.refineReading(pi, li, atlas, next, l => console.log('  ' + l))
  console.log('confirmed', r?.confirmed ?? 0)
}

if (cmd === 'repair') {
  // `repair <page> <lineId> [newText]`: the line's misread words re-read from
  // the page's own letters, and (with a new text) the user's change merged onto it.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const SE = await load('/src/utils/ocr/scanEdit.ts')
  const p = Number(args[0])
  const { pages, atlas } = await pagesAndAtlas(GA)
  const { pi, lis } = pages.get(p)
  const li = lis.find(l => l.id === args[1])
  if (!li) { console.log('line not analysed'); process.exit(0) }
  console.log('reading: "' + li.text + '"')
  const r = SE.repairReading(pi, li, atlas, l => console.log('  ' + l))
  console.log('repaired', r?.repaired ?? 0, r ? '"' + r.text + '"' : '')
  if (r && args[2]) console.log('merged: "' + SE.mergeReadings(li.text, args[2], r.text) + '"')
}

if (cmd === 'repairall') {
  // `repairall <page>`: every analysed line's reading beside its repair from
  // the page's own letters — how the editor would read the page.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const SE = await load('/src/utils/ocr/scanEdit.ts')
  const p = Number(args[0])
  const { pages, atlas } = await pagesAndAtlas(GA)
  const { pi, lis } = pages.get(p)
  let n = 0, changed = 0
  const t0 = Date.now()
  for (const li of lis) {
    n++
    const r = SE.repairReading(pi, li, atlas)
    if (!r) continue
    // BG=1: only what the editor would show for an untouched line.
    if (process.env.BG && !SE.repairIsDisplayable(li, r.text)) continue
    changed++
    console.log(`${li.id}\n  ocr: "${li.text}"\n  fix: "${r.text}"  (${r.repaired} word${r.repaired > 1 ? 's' : ''})`)
  }
  console.log(`${changed} of ${n} lines repaired in ${Date.now() - t0} ms`)
}

if (cmd === 'exact') {
  // `exact <page>`: how the page's words were cut — exact, cut but not exact,
  // not cut — and how many of the others stand in one ink run per character.
  const p = Number(args[0])
  const s = scanOf(p)
  const pi = LI.preparePage(s)
  const tally = { words: 0, exact: 0, cutNotExact: 0, notCut: 0, runsMatch: 0 }
  const samples = []
  for (const it of itemsOf(p)) {
    const li = LI.analyzeLine(pi, { id: it.id, text: it.text, inkRect: it.inkRect, confidence: it.confidence })
    if (!li) continue
    for (const w of li.words) {
      tally.words++
      if (w.cut && w.exact) { tally.exact++; continue }
      if (w.cut) tally.cutNotExact++; else tally.notCut++
      const cols = new Set()
      for (let i = w.from; i < w.to; i++) for (const q of li.cells[i].pix) cols.add(q % s.w)
      const xs = [...cols].sort((a, b) => a - b)
      let runs = 0, last = -9
      for (const x of xs) { if (x > last + 1) runs++; last = x }
      if (runs === w.to - w.from) {
        tally.runsMatch++
        if (samples.length < 25) samples.push(li.chars.slice(w.from, w.to).join('') + (w.cut ? '' : '~'))
        if (process.env.WIDTHS) {
          // Each run's width over the line's em, against its letter's advance.
          const spans = []
          let cur = null, last = -9
          for (const x of xs) { if (x > last + 1) { cur = { x0: x, x1: x + 1 }; spans.push(cur) } else cur.x1 = x + 1; last = x }
          console.log(li.chars.slice(w.from, w.to).join(''), 'em', li.fit.emPx.toFixed(1), spans.map((sp, i) => `${li.chars[w.from + i]}:${((sp.x1 - sp.x0) / li.fit.emPx).toFixed(2)}`).join(' '))
        }
      }
    }
  }
  console.log(JSON.stringify(tally))
  console.log('runs match but not exact:', samples.join(' | '))
}

if (cmd === 'window') {
  // `window <page> <suite.json> <label> <x0> <y0> <x1> <y1>`: grey levels of a
  // pixel window before and after an edit, with the owner of each pixel.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const SE = await load('/src/utils/ocr/scanEdit.ts')
  const p = Number(args[0])
  const spec = JSON.parse(fs.readFileSync(args[1], 'utf8')).find(e => e.page === p && e.label.includes(args[2]))
  const [x0, y0, x1, y1] = args.slice(3, 7).map(Number)
  const { pages, atlas } = await pagesAndAtlas(GA)
  const { s, pi, lis } = pages.get(p)
  const it = itemsOf(p).find(i => i.id === spec.id)
  const li = lis.find(l => l.id === it.id)
  const work = Uint8ClampedArray.from(s.data)
  const res = editOn(SE, pi, li, atlas, it.text.replace(spec.from, spec.to), work, {})
  console.log('ok', res.ok, res.drawn)
  const W = li.roi.x1 - li.roi.x0
  for (let y = y0; y < y1; y++) {
    let a = '', b = '', o = ''
    for (let x = x0; x < x1; x++) {
      const q = y * s.w + x
      a += String(s.data[q * 4]).padStart(4)
      b += String(work[q * 4]).padStart(4)
      const own = x >= li.roi.x0 && x < li.roi.x1 && y >= li.roi.y0 && y < li.roi.y1 ? li.owner[(y - li.roi.y0) * W + (x - li.roi.x0)] : -9
      o += String(own).padStart(4)
    }
    console.log(String(y).padStart(4), a, ' |', b, ' |', o)
  }
}

if (cmd === 'labels') {
  // `labels <page> <lineId>`: every cell's label against the page's shapes —
  // its own medoid's agreement and the best other letter's.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const p = Number(args[0])
  const { pages, atlas } = await pagesAndAtlas(GA)
  const { pi, lis } = pages.get(p)
  const li = lis.find(l => l.id === args[1])
  if (!li) { console.log('line not analysed'); process.exit(0) }
  for (const [wi, w] of li.words.entries()) {
    const bold = atlas.boldAt !== null && (w.weight ?? 0) >= atlas.boldAt
    const parts = []
    for (let i = w.from; i < w.to; i++) {
      const shape = GA.cellShapeOf(pi, li, i)
      const own = atlas.medoids.get(`${li.chars[i]}|${bold}`)
      let best = 0, bestCh = ''
      if (shape) for (const [key, med] of atlas.medoids) {
        const bar = key.lastIndexOf('|')
        if (key.slice(bar + 1) !== String(bold)) continue
        const a = GA.shapeAgreement(shape, med.shape)
        if (a > best) { best = a; bestCh = key.slice(0, bar) }
      }
      parts.push(`${li.chars[i]}:${own && shape ? GA.shapeAgreement(shape, own.shape).toFixed(2) : '-'}/${bestCh}${best.toFixed(2)}`)
    }
    console.log(`w${wi} "${li.chars.slice(w.from, w.to).join('')}" cut=${w.cut} exact=${w.exact} bold=${bold} | ${parts.join(' ')}`)
  }
}

if (cmd === 'corr') {
  // `corr <page> <suite.json> <label>`: why an edit is (not) a correction —
  // the ink word under the changed token, its column runs, each letter's
  // agreement with the page's established shape of it.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const SE = await load('/src/utils/ocr/scanEdit.ts')
  const p = Number(args[0])
  const spec = JSON.parse(fs.readFileSync(args[1], 'utf8')).find(e => e.page === p && e.label.includes(args[2]))
  const { pages, atlas } = await pagesAndAtlas(GA)
  const { s, pi, lis } = pages.get(p)
  const it = itemsOf(p).find(i => i.text.includes(spec.find ?? spec.exact))
  const li = lis.find(l => l.id === it.id)
  const next = it.text.replace(spec.from ?? spec.find ?? spec.exact, spec.to)
  console.log('fixes:', JSON.stringify([...SE.findCorrections(pi, li, atlas, next)]))
  const tok = spec.to.split(/\s+/)[0]
  // The ink word holding the old text.
  const oldWord = (spec.from ?? spec.find).split(/\s+/)[0]
  for (const w of li.words) {
    const text = li.chars.slice(w.from, w.to).join('')
    if (text !== oldWord) continue
    const cols = new Map()
    for (let i = w.from; i < w.to; i++) for (const q of li.cells[i].pix) { const x = q % s.w; if (!cols.has(x)) cols.set(x, []); cols.get(x).push(q) }
    const xs = [...cols.keys()].sort((a, b) => a - b)
    const runs = []
    let cur = [], last = -9
    for (const x of xs) { if (x > last + 1 && cur.length) { runs.push(cur); cur = [] } cur.push(...cols.get(x)); last = x }
    if (cur.length) runs.push(cur)
    const bold = atlas.boldAt !== null && (w.weight ?? 0) >= atlas.boldAt
    console.log(`word "${text}" cut=${w.cut} exact=${w.exact} weight=${w.weight?.toFixed(3)} bold=${bold} runs=${runs.length} token "${tok}" (${[...tok].length})`)
    runs.forEach((r, k) => {
      const xsr = r.map(q => q % s.w)
      const ch = [...tok][k] ?? '?'
      const m = atlas.medoids.get(`${ch}|${bold}`)
      const sh = GA.shapeOfCore(pi, li, r)
      const a = m && sh ? GA.shapeAgreement(sh, m.shape).toFixed(2) : '-'
      console.log(`  run ${k} x ${Math.min(...xsr)}-${Math.max(...xsr)} px ${r.length} -> "${ch}" medoid ${m ? 'yes coh ' + m.cohesion.toFixed(2) : 'NO'} agree ${a}`)
    })
  }
}

if (cmd === 'who') {
  // Which lines each candidate of a character came from: `who <char> [bold]`.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const { atlas, pages } = await pagesAndAtlas(GA)
  const list = atlas.byChar.get(args[0]) ?? []
  const p = GA.pickGlyph(atlas, { char: args[0], emPx: 23.5, xh: 11.2, bold: args[1] === 'bold' })
  for (const ex of list) {
    const li = pages.get(ex.page).lis.find(l => l.id === ex.lineId)
    const cellIdx = li.cells.findIndex(c => c.x0 <= ex.x0 + ex.inkL && c.x1 >= ex.x0 + ex.inkR - 1 && c.char === ex.char)
    const w = li.words.find(w => cellIdx >= w.from && cellIdx < w.to)
    console.log(`${ex === p?.ex ? '*' : ' '} ${ex.lineId} w=${ex.weight?.toFixed(3)} xh=${ex.xh?.toFixed(1)} iso=${ex.isolated} word="${w ? li.chars.slice(w.from, w.to).join('') : '?'}" x=${ex.x0}`)
  }
}


if (cmd === 'zoom') {
  // `zoom <png-in-out-dir-tag> ...` is not useful; instead: zoom <page> <x0> <y0> <x1> <y1> <out.png> [zoom] — of the ORIGINAL scan.
  const p = Number(args[0])
  const s = scanOf(p)
  const [x0, y0, x1, y1] = args.slice(1, 5).map(Number)
  savePng(args[5], x1 - x0, y1 - y0, cropRgba(s, x0, y0, x1, y1), Number(args[6] || 6))
}


if (cmd === 'fill') {
  // `fill <page> <id> <out.png> [zoom]`: what a vector redraw's patch does to
  // the run's ground, stacked: the original; the flat patch the vector path
  // paints (its pads, clamped to the neighbours as `planOcrExport` clamps
  // them, in the median ground colour around it); the same rectangle filled
  // from the ground by `groundFill`.
  const p = Number(args[0])
  const s = scanOf(p)
  const items = itemsOf(p)
  const it = items.find(i => i.id === args[1])
  const EX = await load('/src/utils/ocr/ocrExport.ts')
  const GF = await load('/src/utils/ocr/groundFill.ts')
  const ink = it.inkRect
  const padY = Math.max(1, ink.height * 0.12), padX = Math.max(1, ink.height * 0.15)
  const asItem = (o) => ({ ...o, rect: o.inkRect })
  const all = items.map(asItem), me = all[items.indexOf(it)]
  const [rx0, ry0, rx1, ry1] = EX.clampToNeighbours([ink.x - padX, ink.y - padY, ink.x + ink.width + padX, ink.y + ink.height + padY], me, all)
  const rect = R.pxRectOf(s, { x: rx0, y: ry0, width: rx1 - rx0, height: ry1 - ry0 })
  const box = R.pxRectOf(s, ink)
  const em = GF.emOfRun(box, it.text)
  const rev = GF.isReversedAt(s, box, em)
  // The flat patch's colour: the median ground pixel in a ring around it.
  const ring = []
  const g = Math.max(2, Math.round((box.y1 - box.y0) * 0.2))
  for (let y = Math.max(0, rect.y0 - g); y < Math.min(s.h, rect.y1 + g); y++) for (let x = Math.max(0, rect.x0 - g); x < Math.min(s.w, rect.x1 + g); x++) {
    if (y >= rect.y0 && y < rect.y1 && x >= rect.x0 && x < rect.x1) continue
    const l = R.lumAt(s.data, y * s.w + x)
    ring.push([l, y * s.w + x])
  }
  ring.sort((a, b) => a[0] - b[0])
  const pick = ring[Math.floor(ring.length * (rev ? 0.25 : 0.75))]?.[1] ?? 0
  const bg = [s.data[pick * 4], s.data[pick * 4 + 1], s.data[pick * 4 + 2]]
  const m = Math.round((box.y1 - box.y0) * 0.6)
  const cx0 = Math.max(0, rect.x0 - m), cy0 = Math.max(0, rect.y0 - m), cx1 = Math.min(s.w, rect.x1 + m), cy1 = Math.min(s.h, rect.y1 + m)
  const a = s.data.slice(), b = s.data.slice()
  for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) { const q = (y * s.w + x) * 4; a[q] = bg[0]; a[q + 1] = bg[1]; a[q + 2] = bg[2] }
  const others = items.filter(o => o !== it).map(o => R.pxRectOf(s, o.inkRect))
  if (process.env.COMPS) GF.debugGroundFill(true)
  const got = GF.groundFill(s, rect, em, rev, b, box, others)
  if (process.env.COMPS) console.log(JSON.stringify(GF.debugGroundFill(false)))
  const w = cx1 - cx0, h = cy1 - cy0
  const stack = new Uint8ClampedArray(w * (h * 3 + 4) * 4).fill(255)
  for (let i = 0; i < 3; i++) stack.set(cropRgba(s, cx0, cy0, cx1, cy1, [s.data, a, b][i]), i * (h + 2) * w * 4)
  savePng(args[2], w, h * 3 + 4, stack, Number(args[3] || 1))
  console.log(`${it.id} "${it.text}" em ${em.toFixed(1)}px reversed ${rev} rect ${JSON.stringify(rect)} changed ${JSON.stringify(got)} ${JSON.stringify(GF.lastGroundFill())}`)
}

if (cmd === 'colors') {
  // `colors <page>`: the ink and paper colours `sampleLineColors` gives every
  // run, read off the scan (with VARIANT, the variant's sampling).
  const p = Number(args[0])
  const s = scanOf(p)
  const OS = await load('/src/utils/ocr/ocrSampling.ts')
  const ctx = R.readerCtx(s)
  const hex = (c) => '#' + c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
  for (const it of itemsOf(p)) {
    const b = R.pxRectOf(s, it.inkRect)
    const { color, background } = OS.sampleLineColors(ctx, { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 })
    console.log(`${it.id.padEnd(10)} ink ${hex(color)} paper ${hex(background)}  "${it.text.slice(0, 50)}"`)
  }
}

if (cmd === 'cell') {
  // `cell <page> <lineId> <index>`: a cell's pixels as ASCII.
  const p = Number(args[0])
  const s = scanOf(p)
  const pi = LI.preparePage(s)
  const it = itemsOf(p).find(i => i.id === args[1])
  const li = LI.analyzeLine(pi, { id: it.id, text: it.text, inkRect: it.inkRect, confidence: it.confidence })
  const k = Number(args[2]) < 0 ? li.cells.length + Number(args[2]) : Number(args[2])
  const c = li.cells[k]
  console.log(`cell ${k} "${c.char}" x ${c.x0}-${c.x1} ink ${c.inkL}-${c.inkR} rows ${c.top}-${c.bottom} pix ${c.pix.length} word ${c.word} words: ${li.words.map(w => `[${w.x0}-${w.x1}]`).join(' ')}`)
  const set = new Set(c.pix)
  for (let y = c.top - 2; y <= c.bottom + 1; y++) {
    let row = ''
    for (let x = c.inkL - 2; x <= c.inkR + 1; x++) row += set.has(y * s.w + x) ? '#' : pi.dark[y * s.w + x] > 110 ? 'o' : pi.dark[y * s.w + x] > 26 ? '.' : ' '
    console.log(String(y).padStart(5), row)
  }
}


if (cmd === 'tail') {
  // `tail <page> <suite.json> <label> <x0> <x1> <out.png>`: after one edit, a 6x crop of columns x0..x1 of its line.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const SE = await load('/src/utils/ocr/scanEdit.ts')
  const p = Number(args[0])
  const spec = JSON.parse(fs.readFileSync(args[1], 'utf8')).find(e => e.page === p && e.label.includes(args[2]))
  const { pages, atlas } = await pagesAndAtlas(GA)
  const { s, pi, lis } = pages.get(p)
  const it = spec.id != null ? itemsOf(p).find(i => i.id === spec.id) : itemsOf(p).find(i => i.text.includes(spec.find ?? spec.exact))
  const li = lis.find(l => l.id === it.id)
  const work = Uint8ClampedArray.from(s.data)
  const res = editOn(SE, pi, li, atlas, it.text.replace(spec.from ?? spec.find ?? spec.exact, spec.to), work)
  const x0 = Number(args[3]), x1 = Number(args[4]), y0 = li.roi.y0, y1 = li.roi.y1
  const zh = y1 - y0
  const both = new Uint8ClampedArray((x1 - x0) * (zh * 2 + 2) * 4).fill(255)
  both.set(cropRgba(s, x0, y0, x1, y1), 0)
  both.set(cropRgba(s, x0, y0, x1, y1, work), (x1 - x0) * (zh + 2) * 4)
  savePng(args[5], x1 - x0, zh * 2 + 2, both, 6)
  console.log(res.ok, res.box)
}


if (cmd === 'haze') {
  // `haze <page>`: mean luminance of non-core pixels by distance to the nearest core pixel.
  const p = Number(args[0])
  const s = scanOf(p)
  const pi = LI.preparePage(s)
  const W = s.w, H = s.h
  // Distance transform (chessboard, two passes) from core pixels.
  const INF = 1e9
  const d = new Float32Array(W * H).fill(INF)
  for (let i = 0; i < W * H; i++) if (pi.dark[i] >= LI.CORE) d[i] = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1)
    if (y > 0) { d[i] = Math.min(d[i], d[i - W] + 1); if (x > 0) d[i] = Math.min(d[i], d[i - W - 1] + 1); if (x < W - 1) d[i] = Math.min(d[i], d[i - W + 1] + 1) }
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x
    if (x < W - 1) d[i] = Math.min(d[i], d[i + 1] + 1)
    if (y < H - 1) { d[i] = Math.min(d[i], d[i + W] + 1); if (x < W - 1) d[i] = Math.min(d[i], d[i + W + 1] + 1); if (x > 0) d[i] = Math.min(d[i], d[i + W - 1] + 1) }
  }
  const sum = new Float64Array(16), n = new Float64Array(16), sumP = new Float64Array(16)
  for (let i = 0; i < W * H; i++) {
    const k = d[i]
    if (k >= 16) continue
    const L = (s.data[i * 4] * 299 + s.data[i * 4 + 1] * 587 + s.data[i * 4 + 2] * 114) / 1000
    const P = (pi.paper[i * 3] * 299 + pi.paper[i * 3 + 1] * 587 + pi.paper[i * 3 + 2] * 114) / 1000
    sum[k] += L; sumP[k] += P; n[k]++
  }
  for (let k = 0; k < 16; k++) console.log(`d=${k} n=${n[k]} lum=${(sum[k] / n[k]).toFixed(1)} paper=${(sumP[k] / n[k]).toFixed(1)}`)
}


if (cmd === 'darkgrid') {
  // `darkgrid <page> <id>`: the prepared page's darkness over a line's ROI,
  // with the fitted baseline's row marked — for judging where the letters sit.
  const p = Number(args[0])
  const s = scanOf(p)
  const pi = LI.preparePage(s)
  const it = itemsOf(p).find(i => i.id === args[1])
  const li = LI.analyzeLine(pi, { id: it.id, text: it.text, inkRect: it.inkRect, confidence: it.confidence })
  if (!li) { console.log('not analysed'); process.exit(0) }
  const { x0, y0, x1, y1 } = li.roi
  const cx = (x0 + x1) / 2
  const by = li.fit.y + li.fit.slope * (cx - li.fit.centreX)
  console.log(`roi ${x0},${y0}-${x1},${y1} fit.y ${li.fit.y.toFixed(2)} slope ${li.fit.slope.toFixed(4)} em ${li.fit.emPx.toFixed(1)} (baseline at centre ${by.toFixed(2)}) core ${li.coreLevel}`)
  console.log('arc:', JSON.stringify(LI.lastArcTest?.()))
  console.log('fit blobs:', LI.lastFitBlobs().map(b => `[${b.x0}-${b.x1} y${b.y0}-${b.y1} a${b.area} w${b.w}]`).join(' '))
  for (let y = y0; y < y1; y++) {
    let row = ''
    for (let x = x0; x < Math.min(x1, x0 + 90); x++) { const d = pi.dark[y * s.w + x]; row += d < 20 ? '  .' : String(Math.min(999, d)).padStart(3) }
    console.log(`${String(y).padStart(4)}${Math.abs(y + 0.5 - by) < 0.5 ? '>' : ' '}${row}`)
  }
  process.exit(0)
}

if (cmd === 'lumgrid') {
  // `lumgrid <page> <suite.json> <label> <x0> <y0> <x1> <y1>`: luminance after the edit (and paper), every pixel of a small box.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const SE = await load('/src/utils/ocr/scanEdit.ts')
  const p = Number(args[0])
  const spec = JSON.parse(fs.readFileSync(args[1], 'utf8')).find(e => e.page === p && e.label.includes(args[2]))
  const { pages, atlas } = await pagesAndAtlas(GA)
  const { s, pi, lis } = pages.get(p)
  const it = spec.id != null ? itemsOf(p).find(i => i.id === spec.id) : itemsOf(p).find(i => i.text.includes(spec.find ?? spec.exact))
  const li = lis.find(l => l.id === it.id)
  const work = Uint8ClampedArray.from(s.data)
  editOn(SE, pi, li, atlas, it.text.replace(spec.from ?? spec.find ?? spec.exact, spec.to), work)
  const [x0, y0, x1, y1] = args.slice(3, 7).map(Number)
  const L = (d, i) => Math.round((d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000)
  for (let y = y0; y < y1; y++) {
    let a = '', b = '', c = ''
    for (let x = x0; x < x1; x++) {
      const i = y * s.w + x
      a += String(L(s.data, i)).padStart(4); b += String(L(work, i)).padStart(4)
      c += String(Math.round((pi.paper[i * 3] * 299 + pi.paper[i * 3 + 1] * 587 + pi.paper[i * 3 + 2] * 114) / 1000)).padStart(4)
    }
    console.log(`${y} orig ${a}\n${y} work ${b}\n${y} papr ${c}`)
  }
}


if (cmd === 'damage') {
  // `damage <page> <suite.json> [label]`: per edit, pixels changed that another ink (another line, a rule) owns.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const SE = await load('/src/utils/ocr/scanEdit.ts')
  const p = Number(args[0])
  const suite = JSON.parse(fs.readFileSync(args[1], 'utf8')).filter(e => e.page === p && (!args[2] || e.label.includes(args[2])))
  const { pages, atlas } = await pagesAndAtlas(GA)
  const { s, pi, lis } = pages.get(p)
  for (const spec of suite) {
    const it = spec.id != null ? itemsOf(p).find(i => i.id === spec.id) : itemsOf(p).find(i => spec.exact != null ? i.text.trim() === spec.exact : i.text.includes(spec.find))
    const li = it && lis.find(l => l.id === it.id)
    if (!li) { console.log(spec.label, 'no line'); continue }
    const work = Uint8ClampedArray.from(s.data)
    const res = editOn(SE, pi, li, atlas, it.text.replace(spec.from ?? spec.find ?? spec.exact, spec.to), work)
    if (!res.ok || !res.box) { console.log(spec.label, res.reason ?? 'no box'); continue }
    const W = li.roi.x1 - li.roi.x0
    let other = 0, outside = 0, total = 0
    const where = new Map()
    for (let y = res.box.y0; y < res.box.y1; y++) for (let x = res.box.x0; x < res.box.x1; x++) {
      const q = y * s.w + x
      if (work[q * 4] === s.data[q * 4] && work[q * 4 + 1] === s.data[q * 4 + 1] && work[q * 4 + 2] === s.data[q * 4 + 2]) continue
      total++
      const inRoi = x >= li.roi.x0 && x < li.roi.x1 && y >= li.roi.y0 && y < li.roi.y1
      if (!inRoi) { outside++; continue }
      if (li.owner[(y - li.roi.y0) * W + (x - li.roi.x0)] === -2 && pi.dark[q] >= 26) {
        other++
        const k = `${Math.floor(x / 10) * 10},${Math.floor(y / 10) * 10}`
        where.set(k, (where.get(k) ?? 0) + 1)
      }
    }
    // Anything written OUTSIDE the box is lost from the overlay — and is a bug.
    let beyond = 0, by0 = Infinity, by1 = -Infinity, bx0 = Infinity, bx1 = -Infinity
    for (let q = 0; q < s.w * s.h; q++) {
      if (work[q * 4] === s.data[q * 4] && work[q * 4 + 1] === s.data[q * 4 + 1] && work[q * 4 + 2] === s.data[q * 4 + 2]) continue
      const x = q % s.w, y = (q - x) / s.w
      if (x >= res.box.x0 && x < res.box.x1 && y >= res.box.y0 && y < res.box.y1) continue
      beyond++; by0 = Math.min(by0, y); by1 = Math.max(by1, y); bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x)
    }
    console.log(`${spec.label}: changed ${total}, on other ink ${other}, outside roi ${outside}, beyond box ${beyond}${beyond ? ` [${bx0},${by0}..${bx1},${by1}]` : ''} box ${res.box.x0},${res.box.y0}..${res.box.x1},${res.box.y1}`, [...where.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(' '))
  }
}


if (cmd === 'rowdiff') {
  // `rowdiff <page> <suite.json> <label>`: per row of the edit's box, how many pixels changed.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const SE = await load('/src/utils/ocr/scanEdit.ts')
  const p = Number(args[0])
  const spec = JSON.parse(fs.readFileSync(args[1], 'utf8')).find(e => e.page === p && e.label.includes(args[2]))
  const { pages, atlas } = await pagesAndAtlas(GA)
  const { s, pi, lis } = pages.get(p)
  const it = itemsOf(p).find(i => spec.exact != null ? i.text.trim() === spec.exact : i.text.includes(spec.find))
  const li = lis.find(l => l.id === it.id)
  const work = Uint8ClampedArray.from(s.data)
  const res = editOn(SE, pi, li, atlas, it.text.replace(spec.from ?? spec.find ?? spec.exact, spec.to), work)
  const base = (x) => li.fit.y + li.fit.slope * (x - li.fit.centreX)
  console.log('baseline at box centre', base((res.box.x0 + res.box.x1) / 2).toFixed(1), 'em', li.fit.emPx.toFixed(1), 'box', res.box)
  for (let y = res.box.y0; y < res.box.y1; y++) {
    let n = 0
    for (let x = res.box.x0; x < res.box.x1; x++) { const q = y * s.w + x; if (work[q * 4] !== s.data[q * 4] || work[q * 4 + 1] !== s.data[q * 4 + 1]) n++ }
    console.log(y, n)
  }
}


if (cmd === 'explain') {
  // `explain <page> <lineId> <char> <bold|regular>`: the target line's metrics and every candidate.
  const GA = await load('/src/utils/ocr/glyphAtlas.ts')
  const { pages, atlas } = await pagesAndAtlas(GA)
  const li = pages.get(Number(args[0])).lis.find(l => l.id === args[1])
  const m = GA.lineMetrics(li)
  const req = { char: args[2], emPx: li.fit.emPx, xh: m.xh, capH: m.capH, bold: args[3] === 'bold' }
  console.log('target', JSON.stringify(req), 'boldAt', atlas.boldAt)
  console.log(GA.explainPick(atlas, req).join('\n'))
  console.log('pick:', GA.pickGlyph(atlas, req)?.ex.lineId ?? null)
}


if (cmd === 'errs') {
  // `errs <page>`: width error of exact words, and of the ones that are not.
  const p = Number(args[0])
  const s = scanOf(p)
  const pi = LI.preparePage(s)
  const ex = [], nx = []
  for (const it of itemsOf(p)) {
    const li = LI.analyzeLine(pi, { id: it.id, text: it.text, inkRect: it.inkRect, confidence: it.confidence })
    if (!li) continue
    for (const w of li.words) (w.exact ? ex : nx).push({ e: w.err, t: li.chars.slice(w.from, w.to).join('') })
  }
  const hist = (a) => { const b = new Array(8).fill(0); for (const x of a) b[Math.min(7, Math.floor(x.e / 0.05))]++; return b.join(' ') }
  console.log('exact', ex.length, 'err hist (0.05 bins):', hist(ex))
  console.log('not  ', nx.length, 'err hist (0.05 bins):', hist(nx))
  console.log('exact with err > 0.2:', ex.filter(x => x.e > 0.2).map(x => `${x.t}:${x.e.toFixed(2)}`).join(' '))
}


if (cmd === 'inspect') {
  // `inspect <page> <lineId>`: the line's rules and loose pieces.
  const p = Number(args[0])
  const s = scanOf(p)
  const pi = LI.preparePage(s)
  const it = itemsOf(p).find(i => i.id === args[1])
  const li = LI.analyzeLine(pi, { id: it.id, text: it.text, inkRect: it.inkRect, confidence: it.confidence })
  if (!li) { console.log('FAIL', LI.lastLineFailure()); }
  else {
    const base = (x) => li.fit.y + li.fit.slope * (x - li.fit.centreX)
    console.log('em', li.fit.emPx.toFixed(1), 'baseline at centre', li.fit.y.toFixed(1), 'roi', JSON.stringify(li.roi))
    for (const r of li.rules) console.log('rule', r.x0, r.x1, 'y', r.y.toFixed(1), 'vs base', (r.y - base((r.x0 + r.x1) / 2)).toFixed(1), 'thick', r.thick)
    for (const l of li.loose) console.log('loose', l.x0, l.x1, l.y0, l.y1, 'area', l.area, 'vs base', (l.y1 - base((l.x0 + l.x1) / 2)).toFixed(1))
  }
}

await server.close()
