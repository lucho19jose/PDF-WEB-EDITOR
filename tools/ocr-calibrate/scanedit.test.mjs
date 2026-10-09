// Regression tests for editing ON the scan (scanEdit.ts and what it stands on).
// Run with: node --test tools/ocr-calibrate/scanedit.test.mjs
//
// The modules are the app's own, loaded through Vite's SSR loader (they use
// extensionless imports and the '@/' alias). The end-to-end test builds a
// synthetic SCAN — real glyphs rasterised by MuPDF, blurred, on a tinted and
// noisy paper — so nothing here depends on a document or an OCR engine.
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')
let server, SE, R, LI, GA, IP, GR, GS, SEP, WS, mupdf

before(async () => {
  const { createServer } = await import(pathToFileURL(ROOT + '/node_modules/vite/dist/node/index.js').href)
  server = await createServer({
    root: ROOT, configFile: ROOT + '/vite.config.ts',
    server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  globalThis.ImageData ??= class ImageData { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4) } }
  SE = await loadOcr('scanEdit.ts')
  R = await loadOcr('scanRaster.ts')
  LI = await loadOcr('lineInk.ts')
  GA = await loadOcr('glyphAtlas.ts')
  IP = await loadOcr('inpaint.ts')
  GR = await loadOcr('glyphRaster.ts')
  GS = await loadOcr('glyphSynth.ts')
  SEP = await loadOcr('scanEditPage.ts')
  WS = await loadOcr('wordSeg.ts')
  mupdf = await import(pathToFileURL(ROOT + '/node_modules/mupdf/dist/mupdf.js').href)
})
after(async () => { await server?.close() })

// VARIANT=<dir>: the OCR modules from a copy of src/utils/ocr there (as the lab takes it).
const loadOcr = (name) => server.ssrLoadModule(process.env.VARIANT ? '/@fs/' + process.env.VARIANT.split(String.fromCharCode(92)).join('/') + '/' + name : '/src/utils/ocr/' + name)

test('alignment keeps a run of letters together rather than picking them from anywhere', () => {
  const pairs = SE.alignChars([...'cientocincuenta'], [...'quinientos'])
  const old = pairs.map(([i]) => i)
  // "iento" is shared as one run; nothing else of the old word is borrowed.
  assert.deepEqual(old, [1, 2, 3, 4, 5])
})

test('alignment of an insertion keeps every old letter', () => {
  const pairs = SE.alignChars([...'DESIGNADO:'], [...'DESIGNADOS:'])
  assert.equal(pairs.length, 10)
  assert.deepEqual(pairs.at(-1), [9, 10])
})

test('push-pull fills a hole with what surrounds it', () => {
  const w = 40, h = 20
  const ch = [new Float32Array(w * h).fill(200)]
  const known = new Float32Array(w * h).fill(1)
  for (let y = 5; y < 15; y++) for (let x = 10; x < 30; x++) { ch[0][y * w + x] = 0; known[y * w + x] = 0 }
  assert.ok(IP.pushPull(ch, known, w, h))
  for (let i = 0; i < w * h; i++) assert.ok(Math.abs(ch[0][i] - 200) < 0.5, `pixel ${i} = ${ch[0][i]}`)
  // The caller's weights are left alone.
  assert.equal(known[5 * w + 10], 0)
})

test('a glyph key names the letter, its weight and its size', () => {
  assert.equal(SE.wantKey({ char: 'W', bold: false, xh: 12.04, capH: 16, emPx: 23 }), 'W|r|x24')
  assert.equal(SE.wantKey({ char: 'W', bold: true, xh: null, capH: 16.2, emPx: 23 }), 'W|b|c32')
})

/** A synthetic scan: lines of Carlito drawn by MuPDF at 200 DPI, blurred, on tinted noisy paper. */
function syntheticScan(lines) {
  const W = 1200, H = 120 + lines.length * 60
  const font = new mupdf.Font('Carlito', fs.readFileSync(ROOT + '/public/fonts/match/Carlito-Regular.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const em = 25
  lines.forEach((text, k) => {
    const t = new mupdf.Text()
    t.showString(font, [em, 0, 0, -em, 60, 80 + k * 60], text)
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  })
  dev.close()
  const g = pix.getPixels()
  const stride = pix.getStride()
  // Blur a touch and lay it on a cream paper with a little grain.
  const rgba = new Uint8ClampedArray(W * H * 4)
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let acc = 0, n = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy))
      const wt = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1)
      acc += g[yy * stride + xx] * wt; n += wt
    }
    const ink = 1 - acc / n / 255
    const paper = [246, 242, 232].map(v => v + (rnd() - 0.5) * 4)
    const i = (y * W + x) * 4
    for (let c = 0; c < 3; c++) rgba[i + c] = paper[c] * (1 - ink * 0.85)
    rgba[i + 3] = 255
  }
  // 200 DPI: 0.36 pt a pixel, the image filling a page of W×H pixels.
  const pageW = W * 0.36, pageH = H * 0.36
  return { raster: R.scanRasterOf(W, H, rgba, [pageW, 0, 0, pageH, 0, 0], pageW, pageH, 'Synth'), em }
}

test('an edit on a synthetic scan changes only its own line, and keeps the letters it does not change', () => {
  const lines = [
    'Los terminos del presente contrato son claros y precisos para ambas partes.',
    'El proveedor entregara los equipos en un plazo de treinta dias habiles.',
    'Las partes acuerdan que el precio total incluye todos los impuestos.'
  ]
  const { raster } = syntheticScan(lines)
  const pi = LI.preparePage(raster)
  const items = lines.map((text, k) => {
    // The recogniser's box: the line's ink with a little slack, in points.
    const top = (80 + k * 60 - 22) * 0.36, bottom = (80 + k * 60 + 8) * 0.36
    return { id: `l${k}`, text, inkRect: { x: 55 * 0.36, y: top, width: 1080 * 0.36, height: bottom - top }, confidence: 95 }
  })
  const lis = items.map(it => LI.analyzeLine(pi, it))
  lis.forEach((li, k) => assert.ok(li, `line ${k}: ${LI.lastLineFailure()}`))
  const atlas = GA.atlasFrom([GA.harvestPage(pi, lis, 0)])
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, lis[1], atlas, 'El proveedor entregara los equipos en un plazo de quince dias habiles.', work, {})
  assert.ok(res.ok, res.reason)
  // Nothing outside the edited line's band changed.
  const band = lis[1].roi
  let outside = 0, inside = 0
  for (let y = 0; y < raster.h; y++) for (let x = 0; x < raster.w; x++) {
    const i = (y * raster.w + x) * 4
    if (work[i] === raster.data[i] && work[i + 1] === raster.data[i + 1] && work[i + 2] === raster.data[i + 2]) continue
    if (y >= band.y0 && y < band.y1 && x >= band.x0 && x < band.x1 + 200) inside++
    else outside++
  }
  assert.equal(outside, 0, 'pixels changed outside the edited line')
  assert.ok(inside > 200, 'the edit drew something')
  // Everything before "treinta" kept its place, to the pixel.
  assert.ok(/^k{30,}/.test(res.drawn), `drawn ${res.drawn}`)
})

/** The synthetic page, analysed with the given READINGS (what the recogniser said) for its lines. */
function analysed(lines, readings = lines) {
  const { raster } = syntheticScan(lines)
  const pi = LI.preparePage(raster)
  const lis = readings.map((text, k) => {
    const top = (80 + k * 60 - 22) * 0.36, bottom = (80 + k * 60 + 8) * 0.36
    return LI.analyzeLine(pi, { id: `l${k}`, text, inkRect: { x: 55 * 0.36, y: top, width: 1080 * 0.36, height: bottom - top }, confidence: 95 })
  })
  lis.forEach((li, k) => assert.ok(li, `line ${k}: ${LI.lastLineFailure()}`))
  return { raster, pi, lis, atlas: GA.atlasFrom([GA.harvestPage(pi, lis.filter((_, k) => readings[k] === lines[k]), 0)]) }
}

test('retyping a misread word to what the ink says changes no pixel, only the text', () => {
  const lines = [
    'Los terminos del presente contrato son claros y precisos para ambas partes.',
    'El proveedor entregara los equipos en un plazo de treinta dias habiles.',
    'Las partes acuerdan que el precio total incluye todos los impuestos.'
  ]
  // The recogniser dropped a letter of "presente" on the first line.
  const readings = [lines[0].replace('presente', 'presnte'), lines[1], lines[2]]
  const { raster, pi, lis, atlas } = analysed(lines, readings)
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, lis[0], atlas, lines[0], work, {})
  assert.ok(res.ok, res.reason)
  assert.equal(res.corrected, 1)
  let changed = 0
  for (let i = 0; i < work.length; i++) if (work[i] !== raster.data[i]) changed++
  assert.equal(changed, 0, 'a correction changed pixels')
  assert.ok(res.words.some(w => w.text === 'presente'), 'the text layer says what the user typed')
})

test('an edit that the ink does NOT already show is drawn, not taken for a correction', () => {
  const lines = [
    'Los terminos del presente contrato son claros y precisos para ambas partes.',
    'El proveedor entregara los equipos en un plazo de treinta dias habiles.',
    'Las partes acuerdan que el precio total incluye todos los impuestos.'
  ]
  const { raster, pi, lis, atlas } = analysed(lines)
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, lis[2], atlas, lines[2].replace('precio', 'premio'), work, {})
  assert.ok(res.ok, res.reason)
  assert.ok(!res.corrected, 'a real change was taken for a correction')
  let changed = 0
  for (let i = 0; i < work.length; i++) if (work[i] !== raster.data[i]) changed++
  assert.ok(changed > 50, 'the edit drew nothing')
})

test('removing an accent is an edit, never a correction', () => {
  const lines = [
    'La garantia cubre todos los equipos durante el periodo pactado.',
    'El proveedor entregara los equipos en un plazo de treinta dias habiles.',
    'Las partes acuerdan que la garantía incluye todos los impuestos.'
  ]
  const { raster, pi, lis, atlas } = analysed(lines)
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, lis[2], atlas, lines[2].replace('garantía', 'garantia'), work, {})
  assert.ok(res.ok, res.reason)
  assert.ok(!res.corrected, 'the accent change was taken for a correction')
  let changed = 0
  for (let i = 0; i < work.length; i += 4) if (work[i] !== raster.data[i]) changed++
  assert.ok(changed > 20, 'the accent stayed on the page')
})

test('an overlay is opaque around every changed pixel, so its edge never falls on old ink', async () => {
  const SEP = await loadOcr('scanEditPage.ts')
  const lines = [
    'Los terminos del presente contrato son claros y precisos para ambas partes.',
    'El proveedor entregara los equipos en un plazo de treinta dias habiles.'
  ]
  const { raster, pi, lis, atlas } = analysed(lines)
  const items = lis.map((li, k) => ({
    id: `l${k}`, text: k === 1 ? lines[1].replace('treinta', 'quince') : lines[k], originalText: lines[k], edited: k === 1, removed: false,
    inkRect: { x: 55 * 0.36, y: (80 + k * 60 - 22) * 0.36, width: 1080 * 0.36, height: 30 * 0.36 },
    rect: { x: 55 * 0.36, y: (80 + k * 60 - 22) * 0.36, width: 1080 * 0.36, height: 30 * 0.36 }
  }))
  const plan = SEP.planScanEdits(pi, new Map(lis.map(li => [li.id, li])), atlas, items)
  assert.equal(plan.overlays.length, 1, JSON.stringify(plan.modes))
  const o = plan.overlays[0]
  // Find the overlay's pixel box again from its page rect.
  const [x0, y0] = R.apply(raster.toPx, o.rect[0], o.rect[1])
  const bx = Math.round(x0), by = Math.round(y0)
  const work = raster.data.slice()
  SE.applyLineEdit(pi, lis[1], atlas, items[1].text, work, {})
  for (let y = 0; y < o.height; y++) for (let x = 0; x < o.width; x++) {
    const p = ((by + y) * raster.w + bx + x) * 4
    const diff = work[p] !== raster.data[p] || work[p + 1] !== raster.data[p + 1] || work[p + 2] !== raster.data[p + 2]
    if (!diff) continue
    // Every changed pixel and its 3-pixel neighbourhood are opaque.
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = x + dx, yy = y + dy
      if (xx < 0 || yy < 0 || xx >= o.width || yy >= o.height) continue
      assert.equal(o.alpha[yy * o.width + xx], 255, `transparent pixel ${xx},${yy} next to a change`)
    }
  }
})

test('a line retyped as printed plus one change only changes that change, even over a garbled reading', () => {
  const lines = [
    'Los terminos del presente contrato son claros y precisos para ambas partes.',
    'El proveedor entregara los equipos en un plazo de treinta dias habiles.',
    'Las partes acuerdan que el precio total incluye todos los impuestos.'
  ]
  // The recogniser glued two words and dropped a letter at the join.
  const readings = [lines[0].replace('presente contrato', 'presentecontrat'), lines[1], lines[2]]
  const { raster, pi, lis, atlas } = analysed(lines, readings)
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, lis[0], atlas, lines[0].replace('claros', 'nuevos'), work, {})
  assert.ok(res.ok, res.reason)
  assert.ok((res.corrected ?? 0) >= 1, 'the typed text was not used to read the line')
  // Everything before "nuevos" is the scan's own pixels, where they were.
  const son = res.words.find(w => w.text === 'son')
  assert.ok(son, JSON.stringify(res.words.map(w => w.text)))
  let changedBefore = 0
  for (let y = lis[0].roi.y0; y < lis[0].roi.y1; y++) for (let x = 0; x < son.x1; x++) {
    const i = (y * raster.w + x) * 4
    if (work[i] !== raster.data[i] || work[i + 1] !== raster.data[i + 1] || work[i + 2] !== raster.data[i + 2]) changedBefore++
  }
  assert.equal(changedBefore, 0, 'pixels changed before the edited word')
  assert.ok(res.words.some(w => w.text === 'nuevos'))
})

test('a change typed over a garbled reading is carried onto the reading the ink gives', () => {
  // Shown "(5)laves" for "(5) claves", the user changes only the digit.
  assert.equal(SE.mergeReadings('Liceniatariocinco (5)laves', 'Liceniatarioseis (6)laves', 'Licenciatario cinco (5) claves'), 'Licenciatario seis (6) claves')
  // A user's correction that the repair also made is made once.
  assert.equal(SE.mergeReadings('Liceniatario cinco', 'Licenciatario cinco', 'Licenciatario cinco'), 'Licenciatario cinco')
  // Where both changed the same stretch, the user's text wins.
  assert.equal(SE.mergeReadings('serán mitidas', 'serán enviadas', 'serán emitidas'), 'serán enviadas')
  assert.equal(SE.mergeReadings('sin cambios', 'sin cambios', 'sin cambios'), 'sin cambios')
})

test('an edit of the garbled reading itself lands on the ink it was meant for', () => {
  const lines = [
    'Los terminos del presente contrato son claros y precisos para ambas partes.',
    'El proveedor entregara los equipos en un plazo de treinta dias habiles.',
    'Las partes acuerdan que el precio total incluye todos los impuestos.'
  ]
  // The recogniser glued two words and dropped a letter at the join, and the
  // user edits THAT reading — the garbled words left as the editor showed them.
  const garbled = lines[0].replace('presente contrato', 'presentecontrat')
  const { raster, pi, lis, atlas } = analysed(lines, [garbled, lines[1], lines[2]])
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, lis[0], atlas, garbled.replace('claros', 'nuevos'), work, {})
  assert.ok(res.ok, res.reason)
  assert.ok((res.repaired ?? 0) >= 1, `the misread words were not re-read: ${res.notes.join('; ')}`)
  const texts = res.words.map(w => w.text)
  assert.ok(texts.includes('contrato') && texts.includes('nuevos'), JSON.stringify(texts))
  // Nothing before the changed word is redrawn.
  const son = res.words.find(w => w.text === 'son')
  let changedBefore = 0
  for (let y = lis[0].roi.y0; y < lis[0].roi.y1; y++) for (let x = 0; x < son.x1; x++) {
    const i = (y * raster.w + x) * 4
    if (work[i] !== raster.data[i] || work[i + 1] !== raster.data[i + 1] || work[i + 2] !== raster.data[i + 2]) changedBefore++
  }
  assert.equal(changedBefore, 0, 'pixels changed before the edited word')
})

/**
 * A cover: a green-to-yellow gradient, a title in WHITE letters and a line of
 * dark letters set tight under it, the title's box (as a detector reports it)
 * reaching over the line beneath.
 */
function coverScan() {
  const W = 900, H = 260
  const font = new mupdf.Font('Carlito', fs.readFileSync(ROOT + '/public/fonts/match/Carlito-Regular.ttf'))
  const mask = (text, em, x, y) => {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
    pix.clear(255)
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
    const t = new mupdf.Text()
    t.showString(font, [em, 0, 0, -em, x, y], text)
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
    dev.close()
    const g = pix.getPixels(), stride = pix.getStride(), m = new Float32Array(W * H)
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) m[yy * W + xx] = 1 - g[yy * stride + xx] / 255
    return m
  }
  const title = mask('MARIO LUNA', 70, 60, 120), sub = mask('LOS DIEZ MANDAMIENTOS', 30, 60, 160)
  const ground = (x) => [30 + 150 * x / W, 150 + 60 * x / W, 10 + 10 * x / W]
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const j = y * W + x, i = j * 4, g = ground(x)
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(g[c] + (255 - g[c]) * title[j] - g[c] * sub[j] * 0.9)
    rgba[i + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Cover')
  return { raster, ground, title, sub, W, H }
}

test('a vector patch on a gradient is filled from the ground: the title goes, the line beneath stays', async () => {
  const GF = await loadOcr('groundFill.ts')
  const { raster, ground, title, sub, W, H } = coverScan()
  // The title's box as a detector gives it — down into the line beneath — and
  // the vector patch around it, padded.
  const own = { x0: 55, y0: 66, x1: 560, y1: 150 }
  const rect = { x0: 45, y0: 56, x1: 570, y1: 160 }
  const others = [{ x0: 58, y0: 136, x1: 520, y1: 166 }]
  const em = GF.emOfRun(own, 'MARIO LUNA')
  assert.ok(GF.isReversedAt(raster, own, em), 'white on green reads as reversed')
  const work = raster.data.slice()
  const got = GF.groundFill(raster, rect, em, true, work, own, others)
  assert.ok(typeof got === 'object', `fill ${got} ${JSON.stringify(GF.lastGroundFill())}`)
  let left = 0, damaged = 0, letters = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const j = y * W + x, i = j * 4, g = ground(x)
    const off = Math.max(...[0, 1, 2].map(c => Math.abs(work[i + c] - g[c])))
    if (title[j] > 0.5) { letters++; if (off > 18) left++ }
    if (sub[j] > 0.3 && (work[i] !== raster.data[i] || work[i + 1] !== raster.data[i + 1] || work[i + 2] !== raster.data[i + 2])) damaged++
  }
  assert.ok(letters > 2000, 'the title was drawn')
  assert.ok(left < letters * 0.01, `title pixels left: ${left} of ${letters}`)
  assert.equal(damaged, 0, 'the line beneath was touched')
})

test('a number whose figures touch is cut by its pitch, and a changed figure takes its own cell', () => {
  // 200 DPI (0.36 pt a pixel), Arimo at 11pt: a cost centre "9408100" whose
  // "08" is set close enough to touch, and a date line that holds a "2".
  const W = 1000, H = 220, size = 11 / 0.36
  const font = new mupdf.Font('Arimo', fs.readFileSync(ROOT + '/public/fonts/match/Arimo-Regular.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const adv = (ch) => font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0))) * size
  const set = (text, x, y, squeeze = () => 0) => {
    const t = new mupdf.Text()
    let pen = x
    for (let i = 0; i < text.length; i++) {
      t.showString(font, [size, 0, 0, -size, pen, y], text[i])
      pen += adv(text[i]) - squeeze(i)
    }
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  }
  // The "0" (index 2 of the number) is set 5 px into the "8"'s advance: they touch.
  set('Centro de costos', 40, 80)
  set('9408100', 300, 80, i => (i === 2 ? 5 : 0))
  set('Fecha 2024 y 2026', 40, 150)
  dev.close()
  const g = pix.getPixels(), stride = pix.getStride()
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = g[y * stride + x], i = (y * W + x) * 4
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v
    rgba[i + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Figures')
  const pi = LI.preparePage(raster)
  const box = (y0, y1) => ({ x: 30 * 0.36, y: y0 * 0.36, width: 560 * 0.36, height: (y1 - y0) * 0.36 })
  const li = LI.analyzeLine(pi, { id: 'n', text: 'Centro de costos 9408100', inkRect: box(52, 86), confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  const other = LI.analyzeLine(pi, { id: 'd', text: 'Fecha 2024 y 2026', inkRect: box(122, 156), confidence: 95 })
  assert.ok(other, LI.lastLineFailure())
  // The number's ink words (the gaps between its runs split it): every one,
  // the touching "08" included, cut exactly.
  const first = 'Centro de costos '.replace(/ /g, '').length
  const parts = li.words.filter(w => w.from >= first)
  assert.ok(parts.length && parts.every(w => w.exact), `the number is cut exactly: ${JSON.stringify(parts.map(w => [w.from, w.to, w.exact]))}`)
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li, other], 0)])
  const work = raster.data.slice()
  // The "8" of the touching pair becomes a "2": drawn alone, every other
  // figure — its "0" neighbour included — keeps its pixels.
  const res = SE.applyLineEdit(pi, li, atlas, 'Centro de costos 9402100', work, {})
  assert.ok(res.ok, res.reason)
  assert.match(res.drawn, /^k+[gws]kkk$/, `drawn ${res.drawn}`)
})

test('two figures changed in one line are two swaps: the words between them keep their pixels', () => {
  const W = 1300, H = 220, size = 11 / 0.36
  const font = new mupdf.Font('Arimo', fs.readFileSync(ROOT + '/public/fonts/match/Arimo-Regular.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const set = (text, x, y) => {
    const t = new mupdf.Text()
    t.showString(font, [size, 0, 0, -size, x, y], text)
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  }
  set('desarrollado del 03 de abril al 01 de mayo', 40, 80)
  set('Fecha 2024 y 2026', 40, 150)
  dev.close()
  const g = pix.getPixels(), stride = pix.getStride()
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = g[y * stride + x], i = (y * W + x) * 4
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v
    rgba[i + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Dates')
  const pi = LI.preparePage(raster)
  const box = (y0, y1) => ({ x: 30 * 0.36, y: y0 * 0.36, width: 1200 * 0.36, height: (y1 - y0) * 0.36 })
  const li = LI.analyzeLine(pi, { id: 'd', text: 'desarrollado del 03 de abril al 01 de mayo', inkRect: box(52, 88), confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  const other = LI.analyzeLine(pi, { id: 'f', text: 'Fecha 2024 y 2026', inkRect: box(122, 156), confidence: 95 })
  assert.ok(other, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li, other], 0)])
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, li, atlas, 'desarrollado del 04 de abril al 02 de mayo', work, {})
  assert.ok(res.ok, res.reason)
  assert.equal(res.drawn.replace(/k/g, '').length, 2, `drawn ${res.drawn}`)
})

test('on squared paper the grid is paper: an edit neither erases it nor carries it with the letters', () => {
  // 200 DPI: a notebook's light blue grid every 40 px, 2 px lines, with a
  // line of dark blue text across it.
  const W = 1100, H = 200, size = 13 / 0.36
  const font = new mupdf.Font('Arimo', fs.readFileSync(ROOT + '/public/fonts/match/Arimo-Regular.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const t = new mupdf.Text()
  t.showString(font, [size, 0, 0, -size, 40, 120], 'La matriz escalonada es: real')
  dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  dev.close()
  const g = pix.getPixels(), stride = pix.getStride()
  const grid = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x % 40 < 2 || y % 40 < 2) grid[y * W + x] = 1
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, a = 1 - g[y * stride + x] / 255
    const base = grid[y * W + x] ? [150, 190, 235] : [252, 252, 250]
    const ink = [20, 30, 120]
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(base[c] * (1 - a) + ink[c] * a)
    rgba[i + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Grid')
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, { id: 'g', text: 'La matriz escalonada es: real', inkRect: { x: 30 * 0.36, y: 82 * 0.36, width: 1000 * 0.36, height: 50 * 0.36 }, confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li], 0)])
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, li, atlas, 'La matriz eslonada es: real', work, {})
  assert.ok(res.ok, res.reason)
  // Every grid pixel the new text does not cover keeps its colour: none
  // erased to white where the old letters stood, none moved with them.
  // Within two pixels of a letter, before or after the edit, what shows is
  // the letter's edge or the grid it uncovered: not judged.
  const nearLetter = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    if (work[i + 2] >= 200 && raster.data[i + 2] >= 200) continue
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) nearLetter[yy * W + xx] = 1
    }
  }
  let lost = 0, gridSeen = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!grid[y * W + x] || nearLetter[y * W + x]) continue
    const i = (y * W + x) * 4
    gridSeen++
    if (Math.abs(work[i] - raster.data[i]) > 30 || Math.abs(work[i + 1] - raster.data[i + 1]) > 30) lost++
  }
  assert.ok(gridSeen > 1000)
  assert.ok(lost < 20, `grid pixels changed: ${lost}`)
})

test('a small tinted button is paper of its own colour: its letters are not measured against the panel around it', () => {
  // 252 DPI (3.5 px a point), as a dashboard screenshot placed on A4: a
  // light-blue button 36 px tall and 137 wide on a lighter panel, "Last 3
  // days" in it at 6pt and a chevron at its right end. The paper filter's
  // radius (3.6pt) is a third of the button's height, so its edge band read
  // as ink and the margin round the letters took the rest: the paper under
  // the letters came from the panel, and every letter an edit moved carried
  // a box of the button's colour over it.
  const pxPerPt = 3.5, W = 420, H = 140
  const bx0 = 60, by0 = 50, bw = 137, bh = 36
  const font = new mupdf.Font('F', fs.readFileSync(ROOT + '/public/fonts/match/Carlito-Regular.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const t = new mupdf.Text()
  const px = 6 * pxPerPt, baseY = Math.round(by0 + bh / 2 + px * 0.33)
  t.showString(font, [px, 0, 0, -px, bx0 + 3 * pxPerPt, baseY], 'Last 3 days')
  t.showString(font, [px, 0, 0, -px, bx0 + bw - 16, baseY - 3], 'v')
  dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  dev.close()
  const g = new Uint8Array(pix.getPixels()), st = pix.getStride()
  const panel = [239, 246, 252], ground = [199, 224, 244], ink = [60, 110, 160]
  const inB = (x, y) => x >= bx0 && x < bx0 + bw && y >= by0 && y < by0 + bh
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, a = 1 - g[y * st + x] / 255, base = inB(x, y) ? ground : panel
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(base[c] * (1 - a) + ink[c] * a)
    rgba[i + 3] = 255
  }
  const k = 1 / pxPerPt
  const raster = R.scanRasterOf(W, H, rgba, [W * k, 0, 0, H * k, 0, 0], W * k, H * k, 'Btn')
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, { id: 'b', text: 'Last 3 days', inkRect: { x: (bx0 + 6) * k, y: (by0 + 4) * k, width: 100 * k, height: (bh - 8) * k }, confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  const est = [0, 0, 0]
  let n = 0
  for (const c of li.cells) if (c) for (const p of c.pix) { for (let q = 0; q < 3; q++) est[q] += pi.paper[p * 3 + q]; n++ }
  for (let q = 0; q < 3; q++) assert.ok(Math.abs(est[q] / n - ground[q]) <= 4, `paper under the letters ${est.map(v => Math.round(v / n))} against the button's ${ground}`)
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li], 0)])
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, li, atlas, 'Last days', work, {})
  assert.ok(res.ok, res.reason)
})

test('a bullet the reading does not name takes no label: the line is read from the first letter after it', () => {
  // 200 DPI: a solid green disc, an ordinary word space, then "49.7% good"
  // in grey — the recogniser reads the text and drops the bullet.
  const W = 900, H = 160, size = 12 / 0.36
  const font = new mupdf.Font('Arimo', fs.readFileSync(ROOT + '/public/fonts/match/Arimo-Regular.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const t = new mupdf.Text()
  t.showString(font, [size, 0, 0, -size, 90, 100], '49.7% good')
  dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  dev.close()
  const g = new Uint8Array(pix.getPixels()), st = pix.getStride()
  const disc = { cx: 64, cy: 88, r: 12 }
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, a = 1 - g[y * st + x] / 255
    const dd = Math.hypot(x + 0.5 - disc.cx, y + 0.5 - disc.cy)
    const da = Math.max(0, Math.min(1, disc.r - dd + 0.5))
    const grey = [90, 90, 90], green = [10, 140, 40], paper = [253, 253, 251]
    for (let c = 0; c < 3; c++) {
      let v = paper[c] * (1 - a) + grey[c] * a
      v = v * (1 - da) + green[c] * da
      rgba[i + c] = Math.round(v)
    }
    rgba[i + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Bullet')
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, { id: 'b', text: '49.7% good', inkRect: { x: 40 * 0.36, y: 60 * 0.36, width: 420 * 0.36, height: 55 * 0.36 }, confidence: 98 })
  assert.ok(li, LI.lastLineFailure())
  assert.ok(li.cells[0].x0 > disc.cx + disc.r, `the "4" starts at ${li.cells[0].x0}, on the bullet`)
  // The line's ink is the letters' grey, not the bullet's green.
  assert.ok(Math.abs(li.ink[1] - li.ink[0]) < 20, `ink ${li.ink}`)
})

test('a dash the recogniser boxed short is the line\'s whole: an edit moves all of it, none is left behind', () => {
  // 200 DPI: "—LAS 4 VIRTUDES ESTOICAS—" in a serif, its box ending well
  // inside the closing dash (recognisers routinely stop short of one).
  const W = 1500, H = 160, size = 14 / 0.36
  const font = new mupdf.Font('Tinos', fs.readFileSync(ROOT + '/public/fonts/match/Tinos-Bold.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const t = new mupdf.Text()
  t.showString(font, [size, 0, 0, -size, 60, 100], '—LAS 4 VIRTUDES ESTOICAS—')
  dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  dev.close()
  const g = new Uint8Array(pix.getPixels()), st = pix.getStride()
  const rgba = new Uint8ClampedArray(W * H * 4)
  let inkR = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, a = 1 - g[y * st + x] / 255
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(252 * (1 - a) + 20 * a)
    rgba[i + 3] = 255
    if (a > 0.5) inkR = Math.max(inkR, x + 1)
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Dash')
  const pi = LI.preparePage(raster)
  // Where the closing dash starts: the last run of inked columns.
  const inked = (x) => { for (let y = 0; y < H; y++) if (g[y * st + x] < 128) return true; return false }
  let dashStart = inkR - 1
  while (dashStart > 0 && inked(dashStart - 1)) dashStart--
  // The box stops a quarter em into the dash, as the cover's did.
  const box = { x: 55 * 0.36, y: 68 * 0.36, width: (dashStart + size * 0.25 - 55) * 0.36, height: 40 * 0.36 }
  const li = LI.analyzeLine(pi, { id: 'd', text: '—LAS 4 VIRTUDES ESTOICAS—', inkRect: box, confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  const last = li.cells[li.cells.length - 1]
  assert.ok(last.x1 >= inkR - 2, `the closing dash's cell ends at ${last.x1}, the ink at ${inkR}`)
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li], 0)])
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, li, atlas, '—LAS 4 VIRTUES ESTOICAS—', work, {})
  assert.ok(res.ok, res.reason)
  // Where the moved dash no longer reaches, nothing of it may remain.
  let newR = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (work[(y * W + x) * 4] < 120) newR = Math.max(newR, x + 1)
  assert.ok(newR < inkR - size * 0.4, `ink still reaches ${newR}, the old dash ended at ${inkR}`)
})

test('deleting a letter that touches its neighbour is drawn, not taken for a correction', () => {
  // A bold serif's "D" and "E" touch in "VIRTUDES": the word is seven ink
  // runs, as many as "VIRTUES" has letters.
  const W = 900, H = 140, size = 14 / 0.36
  const font = new mupdf.Font('Tinos', fs.readFileSync(ROOT + '/public/fonts/match/Tinos-Bold.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const t = new mupdf.Text()
  t.showString(font, [size, 0, 0, -size, 40, 90], 'LAS VIRTUDES ESTOICAS')
  dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  dev.close()
  const g = new Uint8Array(pix.getPixels()), st = pix.getStride()
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, a = 1 - g[y * st + x] / 255
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(252 * (1 - a) + 20 * a)
    rgba[i + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Touch')
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, { id: 't', text: 'LAS VIRTUDES ESTOICAS', inkRect: { x: 30 * 0.36, y: 50 * 0.36, width: 760 * 0.36, height: 50 * 0.36 }, confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li], 0)])
  assert.equal(SE.findCorrections(pi, li, atlas, 'LAS VIRTUES ESTOICAS').size, 0)
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, li, atlas, 'LAS VIRTUES ESTOICAS', work, {})
  assert.ok(res.ok, res.reason)
  let changed = 0
  for (let i = 0; i < work.length; i += 4) if (Math.abs(work[i] - raster.data[i]) > 40) changed++
  assert.ok(changed > 200, `only ${changed} pixels changed`)
})

test('a synthesised letter is as sharp as the line it goes into, not as the page\'s other text', async () => {
  // 200 DPI: a crisp line of big bold capitals that wants an "X", and three
  // lines of small lowercase printed soft — what the look is fitted on, the
  // capitals giving no lowercase to judge by.
  const W = 1400, H = 520
  const bold = new mupdf.Font('B', fs.readFileSync(ROOT + '/public/fonts/match/Arimo-Bold.ttf'))
  const reg = new mupdf.Font('R', fs.readFileSync(ROOT + '/public/fonts/match/Arimo-Regular.ttf'))
  const draw = (font, size, x, y, s) => {
    const p = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
    p.clear(255)
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, p)
    const t = new mupdf.Text()
    t.showString(font, [size, 0, 0, -size, x, y], s)
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
    dev.close()
    const g = new Uint8Array(p.getPixels()), st = p.getStride(), out = new Float32Array(W * H)
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) out[yy * W + xx] = 1 - g[yy * st + xx] / 255
    return out
  }
  const blur = (f, sigma) => {
    const r = Math.ceil(sigma * 3), k = []
    let sum = 0
    for (let i = -r; i <= r; i++) { k.push(Math.exp(-(i * i) / (2 * sigma * sigma))); sum += k[k.length - 1] }
    const tmp = new Float32Array(W * H), out = new Float32Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let a = 0; for (let i = -r; i <= r; i++) { const xx = Math.min(W - 1, Math.max(0, x + i)); a += f[y * W + xx] * k[i + r] } tmp[y * W + x] = a / sum }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let a = 0; for (let i = -r; i <= r; i++) { const yy = Math.min(H - 1, Math.max(0, y + i)); a += tmp[yy * W + x] * k[i + r] } out[y * W + x] = a / sum }
    return out
  }
  const sentence = 'the quick brown dog sounds rather timid'
  const layers = [draw(bold, 60, 60, 110, 'RYAN')]
  for (const y of [250, 330, 410]) layers.push(blur(draw(reg, 30, 60, y, sentence), 1.3))
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let p = 0; p < W * H; p++) {
    let a = 0
    for (const l of layers) a = Math.max(a, l[p])
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.round(252 * (1 - a) + 20 * a)
    rgba[p * 4 + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Soft')
  const pi = LI.preparePage(raster)
  const items = [{ id: 'big', text: 'RYAN', inkRect: { x: 50 * 0.36, y: 60 * 0.36, width: 200 * 0.36, height: 60 * 0.36 }, confidence: 98 }]
  for (const [k, y] of [250, 330, 410].entries()) items.push({ id: 's' + k, text: sentence, inkRect: { x: 50 * 0.36, y: (y - 26) * 0.36, width: 600 * 0.36, height: 36 * 0.36 }, confidence: 98 })
  const lis = items.map(it => LI.analyzeLine(pi, it))
  for (const li of lis) assert.ok(li, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, lis, 0)])
  const res = SE.applyLineEdit(pi, lis[0], atlas, 'RYAN X', raster.data.slice(), {})
  const want = res.wanting?.find(w => w.char === 'X')
  assert.ok(want, `no X wanted: ${res.reason}`)
  const fonts = new Map()
  const rasterize = async (file, chars, emPx) => {
    let f = fonts.get(file)
    if (!f) { f = new mupdf.Font(file, fs.readFileSync(`${ROOT}/public/fonts/match/${file}.ttf`)); fonts.set(file, f) }
    return chars.map(ch => GS.rasterizeGlyph(mupdf, f, ch, emPx))
  }
  const look = await GS.fitScanLook(atlas, rasterize, { near: { line: 'big', page: 0, emPx: lis[0].fit.emPx } })
  assert.ok(look, 'no look')
  const g = await GS.synthGlyph(look, rasterize, atlas, want)
  assert.ok(g, 'no glyph')
  // The 20–80% width of the strokes' edges, the median over rows.
  const edgeOf = (get, x0, x1, y0, y1) => {
    const ws = []
    for (let y = y0; y < y1; y++) {
      let x = x0
      while (x < x1) {
        if (get(x, y) < 0.06) { x++; continue }
        let j = x, peak = 0
        while (j < x1 && get(j, y) >= 0.06) { peak = Math.max(peak, get(j, y)); j++ }
        if (peak >= 0.5) {
          const at = (level, from, step) => { let k = from; while (get(k, y) < level) k += step; const v0 = get(k - step, y); return k - step + step * (level - v0) / (get(k, y) - v0) }
          ws.push(at(peak * 0.8, x, 1) - at(peak * 0.2, x, 1), at(peak * 0.2, j - 1, -1) - at(peak * 0.8, j - 1, -1))
        }
        x = j + 1
      }
    }
    ws.sort((a, b) => a - b)
    return ws[ws.length >> 1]
  }
  const lineEdge = edgeOf((x, y) => 1 - raster.data[(y * W + x) * 4] / 255, 50, 260, 70, 112)
  const glyphEdge = edgeOf((x, y) => x < 0 || y < 0 || x >= g.w || y >= g.h ? 0 : 1 - g.t[(y * g.w + x) * 3] / 255, 1, g.w - 1, 1, g.h - 1)
  assert.ok(Math.abs(glyphEdge - lineEdge) <= 0.6, `the X's edges ${glyphEdge.toFixed(2)} px, the line's ${lineEdge.toFixed(2)} px`)
})

test('a full stop fainter than its figures is the line\'s: changing the figure before it keeps it', () => {
  // 200 DPI, small figures: "1.00" whose stop prints at under half the
  // figures' darkness — below the core level, so it was no piece at all.
  const W = 300, H = 130, size = 7 / 0.36
  const font = new mupdf.Font('Arimo', fs.readFileSync(ROOT + '/public/fonts/match/Arimo-Regular.ttf'))
  const render = (s, y = 55) => {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
    pix.clear(255)
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
    const t = new mupdf.Text()
    t.showString(font, [size, 0, 0, -size, 40, y], s)
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
    dev.close()
    const g = new Uint8Array(pix.getPixels()), st = pix.getStride(), a = new Float32Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = 1 - g[y * st + x] / 255
    return a
  }
  // A second line gives the page its 2s.
  const all = render('1.00'), digits = render('1 00'), twos = render('2 22 222', 105)
  const rgba = new Uint8ClampedArray(W * H * 4)
  let stopX0 = W, stopX1 = 0
  for (let p = 0; p < W * H; p++) {
    // The stop is what "1.00" inks and "1 00" does not: printed at 0.4.
    const isStop = all[p] > 0.05 && digits[p] < 0.05
    if (isStop) { const x = p % W; stopX0 = Math.min(stopX0, x); stopX1 = Math.max(stopX1, x) }
    const a = Math.max(isStop ? all[p] * 0.4 : all[p], twos[p])
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.round(250 * (1 - a) + 40 * a)
    rgba[p * 4 + 3] = 255
  }
  assert.ok(stopX1 > stopX0, 'no stop rendered')
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Stop')
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, { id: 'q', text: '1.00', inkRect: { x: 36 * 0.36, y: 35 * 0.36, width: 50 * 0.36, height: 24 * 0.36 }, confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  const dot = li.cells.find(c => c.char === '.')
  assert.ok(dot && dot.x0 <= stopX1 && dot.x1 > stopX0, `the "." cell [${dot?.x0}-${dot?.x1}] is not on the stop [${stopX0}-${stopX1}]`)
  const li2 = LI.analyzeLine(pi, { id: 't', text: '2 22 222', inkRect: { x: 36 * 0.36, y: 85 * 0.36, width: 90 * 0.36, height: 24 * 0.36 }, confidence: 95 })
  assert.ok(li2, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li, li2], 0)])
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, li, atlas, '2.00', work, {})
  assert.ok(res.ok, res.reason)
  // Still a stop between the "2" and the "00": ink at its darkness or more
  // somewhere in the band it sat in, a little to the right of where it was.
  let ink = 0
  for (let y = 0; y < H; y++) for (let x = stopX0 - 1; x <= stopX1 + 6; x++) if (250 - work[(y * W + x) * 4] > 30) ink++
  assert.ok(ink >= 3, `no stop left (${ink} inked pixels)`)
})

test('a number redrawn whole keeps its characters\' places: a date whose figures touch is not set letter-spaced', () => {
  // 200 DPI, bold, set tight enough that the stops touch the figures: the
  // date cannot keep any of its letters and is redrawn whole.
  const W = 700, H = 200, size = 12 / 0.36
  const font = new mupdf.Font('Carlito', fs.readFileSync(ROOT + '/public/fonts/match/Carlito-Bold.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  // Character by character, the date's set tight enough that every
  // character touches the next: one run of ink.
  let x = 40
  const t = new mupdf.Text()
  const text = 'en fecha 20.07.2022.'
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const adv = font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)), 0) * size
    t.showGlyph(font, [size, 0, 0, -size, x, 80], font.encodeCharacter(ch.codePointAt(0)), ch.codePointAt(0), 0)
    x += i >= 9 ? adv - 3 : adv
  }
  // A second line, set normally, holds the page's own copies of the date's characters.
  const t2 = new mupdf.Text()
  t2.showString(font, [size, 0, 0, -size, 40, 160], 'el 20 de 07 . 2022 . 7')
  dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  dev.fillText(t2, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  dev.close()
  const g = new Uint8Array(pix.getPixels()), st = pix.getStride()
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let p = 0; p < W * H; p++) {
    const a = 1 - g[Math.floor(p / W) * st + (p % W)] / 255
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.round(252 * (1 - a) + 25 * a)
    rgba[p * 4 + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Date')
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, { id: 'd', text: 'en fecha 20.07.2022.', inkRect: { x: 30 * 0.36, y: 45 * 0.36, width: (x - 20) * 0.36, height: 50 * 0.36 }, confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  // The date is the last ten characters of the reading.
  const oldX0 = li.cells[li.cells.length - 11].inkL, oldX1 = li.cells[li.cells.length - 1].inkR
  const li2 = LI.analyzeLine(pi, { id: 'c', text: 'el 20 de 07 . 2022 . 7', inkRect: { x: 30 * 0.36, y: 125 * 0.36, width: 420 * 0.36, height: 50 * 0.36 }, confidence: 95 })
  assert.ok(li2, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li, li2], 0)])
  const res = SE.applyLineEdit(pi, li, atlas, 'en fecha 22.07.2022.', raster.data.slice(), {})
  assert.ok(res.ok, res.reason)
  const nw = res.words[res.words.length - 1]
  assert.ok(Math.abs(nw.x0 - oldX0) <= 1 && Math.abs(nw.x1 - oldX1) <= 2, `the date spans ${nw.x0}-${nw.x1}, it spanned ${oldX0}-${oldX1}`)
})

test('a large bold title on white paper is edited without grey halos: its thick strokes are ink, not paper', () => {
  // A bilevel scan at 300 DPI (0.24 pt a pixel): a 45pt bold title, its stems
  // ~34 px wide — wider than the paper estimate's 3.6pt filter can see across.
  const W = 1900, H = 320
  const font = new mupdf.Font('Carlito', fs.readFileSync(ROOT + '/public/fonts/match/Carlito-Bold.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  // Set letter by letter with room between them, so the grown strokes below
  // stay apart and every word still cuts one ink run per letter.
  const t = new mupdf.Text()
  let pen = 40
  for (const ch of 'La estrategia') {
    t.showString(font, [190, 0, 0, -190, pen, 230], ch)
    pen += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0))) * 190 + (ch === ' ' ? 30 : 22)
  }
  dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  dev.close()
  const g = pix.getPixels(), stride = pix.getStride()
  // Heavier than Carlito Bold: every stroke grown 8 px, so stems are ~37 px
  // and letters touch, as on the cover this came from.
  const ink = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y * stride + x] < 128) ink[y * W + x] = 1
  const heavy = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!ink[y * W + x]) continue
    for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
      const xx = x + dx, yy = y + dy
      if (xx >= 0 && yy >= 0 && xx < W && yy < H && dx * dx + dy * dy <= 64) heavy[yy * W + xx] = 1
    }
  }
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = heavy[y * W + x] ? 0 : 255
    const i = (y * W + x) * 4
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v
    rgba[i + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.24, 0, 0, H * 0.24, 0, 0], W * 0.24, H * 0.24, 'Title')
  const pi = LI.preparePage(raster)
  // The paper under the title is the page's white: read as paper, a stem's
  // black middle greyed the estimate round every letter.
  let darkPaper = 0
  for (let p = 0; p < W * H; p++) if (pi.paper[p * 3] < 230) darkPaper++
  assert.equal(darkPaper, 0, 'paper estimated darker than the page under the title')
  const li = LI.analyzeLine(pi, { id: 't', text: 'La estrategia', inkRect: { x: 30 * 0.24, y: 60 * 0.24, width: 1800 * 0.24, height: 230 * 0.24 }, confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li], 0)])
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, li, atlas, 'La estategia', work, {})
  assert.ok(res.ok, res.reason)
  // A black-and-white scan stays black and white: a grey pixel is the paper
  // estimate's grey, printed round the letters moved and where they had been.
  let changed = 0, grey = 0
  for (let p = 0; p < W * H; p++) {
    const i = p * 4
    if (work[i] === raster.data[i]) continue
    changed++
    if (work[i] > 40 && work[i] < 215) grey++
  }
  assert.ok(changed > 2000, 'the edit drew something')
  assert.ok(grey < changed * 0.02, `grey pixels: ${grey} of ${changed} changed`)
})

test('a rounded box\'s side is carved off whole: its blurred edge column and the corner it curves round are the border\'s', () => {
  // The shape a form's day cell gave, at a 28.5 px em: the box's left side
  // three columns of solid ink with a fringe column inked over its lower third
  // only, and at its foot the corner curving away towards the bottom rule
  // (whose straight run the rule mask has already taken). The baseline is at
  // row 36; the letters' band runs from row 14 to row 39.
  const pageW = 200, pix = []
  const at = (x, y) => pix.push(y * pageW + x)
  for (let y = 6; y <= 45; y++) for (const x of [16, 17, 18]) at(x, y)
  for (let y = 28; y <= 41; y++) at(15, y)
  for (const [y, x0, x1] of [[40, 19, 19], [41, 19, 19], [42, 19, 20], [43, 19, 21], [44, 19, 23], [45, 19, 26], [46, 21, 30]]) for (let x = x0; x <= x1; x++) at(x, y)
  const xs = pix.map(p => p % pageW), ys = pix.map(p => (p - p % pageW) / pageW)
  const c = { pix, x0: Math.min(...xs), x1: Math.max(...xs) + 1, y0: Math.min(...ys), y1: Math.max(...ys) + 1, area: pix.length, cx: xs.reduce((a, b) => a + b, 0) / pix.length, cy: ys.reduce((a, b) => a + b, 0) / pix.length }
  const ends = { base: 36, onRule: () => false }
  // A piece taller than any letter may step over its blurred edge column.
  const carved = LI.carveBorder(c, pageW, 14, 39, 5, ends, 2)
  assert.ok(carved, 'the side was not carved')
  assert.ok(carved.rest.length < 4, `${carved.rest.length} pixels left over — the corner would be taken for a letter`)
  // Without that allowance there is no full column at the piece's edge.
  assert.equal(LI.carveBorder(c, pageW, 14, 39, 5, ends, 0), null)
  // A bold "l" whose stem ends a pixel under the baseline is not a border: a
  // piece no taller than a letter gets no allowance for its edge columns.
  const l = []
  for (let y = 13; y <= 40; y++) for (const x of [50, 51]) l.push(y * pageW + x)
  for (let y = 15; y <= 38; y++) { l.push(y * pageW + 49); l.push(y * pageW + 52) }
  for (let y = 30; y <= 36; y++) for (const x of [53, 54]) l.push(y * pageW + x)
  const lx = l.map(p => p % pageW), ly = l.map(p => (p - p % pageW) / pageW)
  const lc = { pix: l, x0: Math.min(...lx), x1: Math.max(...lx) + 1, y0: Math.min(...ly), y1: Math.max(...ly) + 1, area: l.length, cx: 51, cy: 27 }
  assert.equal(LI.carveBorder(lc, pageW, 14, 39, 4, ends, 0), null)
})

test('an amount in a column set flush right grows to the left, its figures on the column\'s pitch', () => {
  // 200 DPI: "13,000.00" over "0.00" over "13,000.00", each set flush right
  // against the same edge with no rule beside them; a line below gives the
  // page its "2" and "5". "0.00" is retyped "2,500.00".
  const W = 520, H = 230, size = 22, xr = 420
  const font = new mupdf.Font('Arimo', fs.readFileSync(ROOT + '/public/fonts/match/Arimo-Regular.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const widthOf = (s) => [...s].reduce((t, ch) => t + font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)), 0) * size, 0)
  const lines = [['13,000.00', 50], ['0.00', 90], ['13,000.00', 130], ['25 52 2,5 5.2', 190]]
  for (const [text, y] of lines) {
    const t = new mupdf.Text()
    t.showString(font, [size, 0, 0, -size, text.startsWith('25') ? 40 : xr - widthOf(text), y], text)
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  }
  dev.close()
  const g = new Uint8Array(pix.getPixels()), st = pix.getStride()
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let p = 0; p < W * H; p++) {
    const a = 1 - g[Math.floor(p / W) * st + (p % W)] / 255
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.round(250 * (1 - a) + 30 * a)
    rgba[p * 4 + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Column')
  const pi = LI.preparePage(raster)
  const lis = lines.map(([text, y], k) => {
    const x0 = text.startsWith('25') ? 36 : xr - widthOf(text) - 4
    return LI.analyzeLine(pi, { id: `a${k}`, text, inkRect: { x: x0 * 0.36, y: (y - 20) * 0.36, width: (text.startsWith('25') ? 200 : widthOf(text) + 8) * 0.36, height: 26 * 0.36 }, confidence: 95 })
  })
  lis.forEach((li, k) => assert.ok(li, `line ${k}: ${LI.lastLineFailure()}`))
  assert.equal(SEP.alignedRight(lis, lis[1]), true)
  assert.equal(SEP.alignedRight(lis, lis[3]), false)
  const atlas = GA.atlasFrom([GA.harvestPage(pi, lis, 0)])
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, lis[1], atlas, '2,500.00', work, { columnRight: true, pageLines: lis })
  assert.ok(res.ok, res.reason)
  // The ink runs of the edited line against the line above: tabular figures
  // flush right, so "2,500.00" sits figure for figure under "3,000.00".
  const runsOf = (data, y0, y1) => {
    const out = []
    let start = -1
    for (let x = 0; x <= W; x++) {
      let ink = false
      if (x < W) for (let y = y0; y < y1 && !ink; y++) if (data[(y * W + x) * 4] < 150) ink = true
      if (ink && start < 0) start = x
      if (!ink && start >= 0) { out.push((start + x - 1) / 2); start = -1 }
    }
    return out
  }
  const above = runsOf(raster.data, 30, 56), edited = runsOf(work, 70, 96)
  assert.equal(edited.length, 8, `runs ${edited.join(' ')}`)
  const tail = above.slice(-8)
  for (let k = 0; k < 8; k++) assert.ok(Math.abs(edited[k] - tail[k]) <= 1, `figure ${k} at ${edited[k]}, the column has it at ${tail[k]}`)
})

test('an amount retyped as another of the same shape keeps its separators and every figure\'s place', () => {
  // 200 DPI, bold: "16,949.15" retyped "21,186.44" — as many characters, the
  // separators where they were. A second line gives the page its new figures.
  const W = 520, H = 180, size = 26
  const font = new mupdf.Font('Arimo', fs.readFileSync(ROOT + '/public/fonts/match/Arimo-Bold.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  for (const [text, y] of [['16,949.15', 60], ['21 86 48 2,1 4.4', 140]]) {
    const t = new mupdf.Text()
    t.showString(font, [size, 0, 0, -size, 40, y], text)
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  }
  dev.close()
  const g = new Uint8Array(pix.getPixels()), st = pix.getStride()
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let p = 0; p < W * H; p++) {
    const a = 1 - g[Math.floor(p / W) * st + (p % W)] / 255
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.round(250 * (1 - a) + 25 * a)
    rgba[p * 4 + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Amount')
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, { id: 'n', text: '16,949.15', inkRect: { x: 34 * 0.36, y: 36 * 0.36, width: 160 * 0.36, height: 30 * 0.36 }, confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  const li2 = LI.analyzeLine(pi, { id: 'd', text: '21 86 48 2,1 4.4', inkRect: { x: 34 * 0.36, y: 116 * 0.36, width: 300 * 0.36, height: 30 * 0.36 }, confidence: 95 })
  assert.ok(li2, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li, li2], 0)])
  const res = SE.applyLineEdit(pi, li, atlas, '21,186.44', raster.data.slice(), { pageLines: [li, li2] })
  assert.ok(res.ok, res.reason)
  // The comma and the stop are the scan's own, where they were.
  assert.equal(res.drawn[2], 'k', `drawn ${res.drawn}`)
  assert.equal(res.drawn[6], 'k', `drawn ${res.drawn}`)
  const oldX0 = li.cells[0].inkL, oldX1 = li.cells[li.cells.length - 1].inkR
  const nw = res.words[0]
  assert.ok(Math.abs(nw.x0 - oldX0) <= 2 && Math.abs(nw.x1 - oldX1) <= 2, `the amount spans ${nw.x0}-${nw.x1}, it spanned ${oldX0}-${oldX1}`)
})

test('a line of old-style figures is sized by its letters, not by figures taken for capitals', () => {
  // "Fecha: 28/08/2025" set with old-style figures: the 2s and 0s stand at the
  // x-height, the 8s rise, the 5 and the slashes hang below the baseline. The
  // box's width says an em of 14 px.
  const base = 100, xh = 7, asc = 10
  const glyphs = [['F', base - 9.7, base], ['e', base - xh, base], ['c', base - xh, base], ['h', base - asc, base], ['a', base - xh, base],
    ['2', base - xh, base], ['8', base - asc, base], ['/', base - asc, base + 2], ['0', base - xh, base], ['8', base - asc, base],
    ['/', base - asc, base + 2], ['2', base - xh, base], ['0', base - xh, base], ['2', base - xh, base], ['5', base - xh, base + 3]]
  const blobs = glyphs.map(([, y0, y1], k) => ({ x0: 10 + k * 8, x1: 16 + k * 8, y0, y1, area: 30, cx: 13 + k * 8, cy: (y0 + y1) / 2, w: 1 }))
  const fit = WS.fitLine(blobs, 14, 'Fecha: 28/08/2025')
  assert.ok(fit, 'no fit')
  assert.ok(Math.abs(fit.emPx - 13.5) < 1, `em ${fit.emPx.toFixed(1)}`)
  // The same line in lining figures — every figure at the capitals' height —
  // keeps the capitals' measure.
  const lining = glyphs.map(([ch, y0, y1], k) => ({ x0: 10 + k * 8, x1: 16 + k * 8, y0: /[0-9]/.test(ch) ? base - 9.7 : y0, y1: /[0-9]/.test(ch) ? base : y1, area: 30, cx: 13 + k * 8, cy: base - 5, w: 1 }))
  const fit2 = WS.fitLine(lining, 14, 'Fecha: 28/08/2025')
  assert.ok(Math.abs(fit2.emPx - 9.7 / 0.72) < 1, `em ${fit2.emPx.toFixed(1)}`)
})


test('a signature crossing a line stays where it is: the letters move under it and an erased letter gives it back', () => {
  // 200 DPI: a black line of capitals with a blue pen stroke drawn across it,
  // over "DIAS" (densities multiply where the inks overlap). "TRES" retyped
  // "CUATRO" moves everything after it to the right, under the stroke.
  const W = 900, H = 230, size = 26
  const font = new mupdf.Font('Carlito', fs.readFileSync(ROOT + '/public/fonts/match/Carlito-Bold.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  for (const [text, y] of [['A LOS TRES DIAS DEL MES DE MAYO', 80], ['CUATRO TRES DOS UNO', 180]]) {
    const t = new mupdf.Text()
    t.showString(font, [size, 0, 0, -size, 40, y], text)
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  }
  dev.close()
  const g = new Uint8Array(pix.getPixels()), st = pix.getStride()
  // The stroke: a 3 px line from (330, 20) down to (290, 140).
  const stroke = new Float32Array(W * H)
  for (let k = 0; k <= 600; k++) {
    const x = 330 - 40 * k / 600, y = 20 + 120 * k / 600
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const X = Math.round(x + dx), Y = Math.round(y + dy), d = Math.hypot(x + dx - X, y + dy - Y)
      const a = Math.max(0, Math.min(1, 1.6 - Math.hypot(dx, dy) * 0.6 - d * 0.2))
      if (X >= 0 && Y >= 0 && X < W && Y < H) stroke[Y * W + X] = Math.max(stroke[Y * W + X], a)
    }
  }
  const paper = [248, 246, 240], blue = [55, 90, 205]
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let p = 0; p < W * H; p++) {
    const a = 1 - g[Math.floor(p / W) * st + (p % W)] / 255
    for (let c = 0; c < 3; c++) {
      const tText = 1 - a * (1 - 30 / paper[c]), tBlue = 1 - stroke[p] * (1 - blue[c] / paper[c])
      rgba[p * 4 + c] = Math.round(paper[c] * tText * tBlue)
    }
    rgba[p * 4 + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Signed')
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, { id: 's', text: 'A LOS TRES DIAS DEL MES DE MAYO', inkRect: { x: 34 * 0.36, y: 54 * 0.36, width: 760 * 0.36, height: 34 * 0.36 }, confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  assert.ok(li.overInk, 'the blue stroke was not seen as another ink')
  const li2 = LI.analyzeLine(pi, { id: 'w', text: 'CUATRO TRES DOS UNO', inkRect: { x: 34 * 0.36, y: 154 * 0.36, width: 500 * 0.36, height: 34 * 0.36 }, confidence: 95 })
  assert.ok(li2, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li, li2], 0)])
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, li, atlas, 'A LOS CUATRO DIAS DEL MES DE MAYO', work, {})
  assert.ok(res.ok, res.reason)
  // Every pixel where the stroke ran alone (no letter under it, before or
  // after) is still the stroke: blue well over red.
  const blueAt = (d, p) => d[p * 4 + 2] - d[p * 4] > 60
  let alone = 0, kept = 0
  for (let p = 0; p < W * H; p++) {
    if (stroke[p] < 0.9 || !blueAt(rgba, p)) continue
    // Not on a letter now: no dark neutral ink at it in the result.
    if (work[p * 4 + 2] < 120) continue
    alone++
    if (blueAt(work, p)) kept++
  }
  assert.ok(alone > 100, `only ${alone} stroke pixels to check`)
  assert.ok(kept >= alone * 0.97, `${alone - kept} of ${alone} stroke pixels lost`)
})

test('amounts in a column are set flush right even when every one is as wide as the next', () => {
  // A purchase order's TOTAL column: "930.00" down every row, nothing in the
  // column itself telling a left alignment from a right one. A column of
  // codes as wide as each other is not taken for one.
  const W = 400, H = 260, size = 22
  const font = new mupdf.Font('Arimo', fs.readFileSync(ROOT + '/public/fonts/match/Arimo-Regular.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const rows = [['930.00', '923-002', 50], ['930.00', '923-002', 100], ['930.00', '923-002', 150]]
  for (const [a, c, y] of rows) for (const [text, x] of [[a, 240], [c, 40]]) {
    const t = new mupdf.Text()
    t.showString(font, [size, 0, 0, -size, x, y], text)
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  }
  dev.close()
  const g = new Uint8Array(pix.getPixels()), st = pix.getStride()
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let p = 0; p < W * H; p++) {
    const a = 1 - g[Math.floor(p / W) * st + (p % W)] / 255
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.round(250 * (1 - a) + 30 * a)
    rgba[p * 4 + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Totals')
  const pi = LI.preparePage(raster)
  const lis = []
  rows.forEach(([a, c, y], k) => {
    lis.push(LI.analyzeLine(pi, { id: `a${k}`, text: a, inkRect: { x: 236 * 0.36, y: (y - 20) * 0.36, width: 90 * 0.36, height: 26 * 0.36 }, confidence: 95 }))
    lis.push(LI.analyzeLine(pi, { id: `c${k}`, text: c, inkRect: { x: 36 * 0.36, y: (y - 20) * 0.36, width: 100 * 0.36, height: 26 * 0.36 }, confidence: 95 }))
  })
  lis.forEach((li, k) => assert.ok(li, `line ${k}: ${LI.lastLineFailure()}`))
  assert.equal(SEP.alignedRight(lis, lis[2]), true, 'an amount in a column of amounts')
  assert.equal(SEP.alignedRight(lis, lis[3]), false, 'a code in a column of codes')
})

/**
 * One line set letter by letter on a BOW, as a phone photo of a curled page
 * prints it: the feet sag `sag` px in the middle against the ends.
 */
function bowedScan(text, sag) {
  const W = 1200, H = 160, em = 25, x0 = 60, y0 = 90
  const font = new mupdf.Font('Carlito', fs.readFileSync(ROOT + '/public/fonts/match/Carlito-Regular.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  let width = 0
  for (const ch of text) width += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)), 0) * em
  let x = x0
  for (const ch of text) {
    const u = (x - x0) / width * 2 - 1
    const t = new mupdf.Text()
    t.showString(font, [em, 0, 0, -em, x, y0 + sag * (1 - u * u)], ch)
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
    x += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)), 0) * em
  }
  dev.close()
  const g = new Uint8Array(pix.getPixels()), st = pix.getStride()
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let p = 0; p < W * H; p++) {
    const a = 1 - g[Math.floor(p / W) * st + (p % W)] / 255
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.round(248 * (1 - a * 0.9))
    rgba[p * 4 + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Bowed')
  return { raster, item: { id: 'b', text, inkRect: { x: (x0 - 6) * 0.36, y: (y0 - 24) * 0.36, width: (width + 12) * 0.36, height: 34 * 0.36 }, confidence: 95 }, x0, width }
}

test('a bowed line is measured and set on its own feet, not on a straight line through them', () => {
  const text = 'Las partes firman el presente documento en la ciudad de Lima el 18/07/2022'
  const flat = bowedScan(text, 0)
  const flatLi = LI.analyzeLine(LI.preparePage(flat.raster), flat.item)
  assert.ok(flatLi, LI.lastLineFailure())
  assert.equal(flatLi.fit.bend, undefined, 'a straight line has no bend')
  const { raster, item, x0, width } = bowedScan(text, 3)
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, item)
  assert.ok(li, LI.lastLineFailure())
  assert.ok(li.fit.bend, 'the bow was not found')
  const base = WS.baselineAtOf(li.fit)
  const sag = base(x0 + width / 2) - (base(x0 + width * 0.03) + base(x0 + width * 0.97)) / 2
  assert.ok(Math.abs(sag - 3) < 1.2, `bend ${sag.toFixed(2)} px`)
  // The date's figures stand at the risen end: measured on the bend, their
  // height is the straight line's.
  const fh = GA.lineMetrics(li).figH, fh0 = GA.lineMetrics(flatLi).figH
  assert.ok(Math.abs(fh - fh0) < 0.8, `figures ${fh?.toFixed(2)} px against ${fh0?.toFixed(2)}`)
  // A figure changed there sits on its neighbours' feet.
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li], 0)])
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, li, atlas, text.replace('2022', '2027'), work, {})
  assert.ok(res.ok, res.reason)
  const footOf = (data, xa, xb) => {
    let foot = -1
    for (let y = 0; y < raster.h; y++) for (let x = xa; x < xb; x++) if (data[(y * raster.w + x) * 4] < 120) foot = Math.max(foot, y)
    return foot
  }
  const k = li.chars.length - 1
  const last = li.cells[k], prev = li.cells[k - 1]
  const newFoot = footOf(work, Math.floor(last.inkL) - 1, Math.ceil(last.inkR) + 2)
  const prevFoot = footOf(raster.data, Math.floor(prev.inkL), Math.ceil(prev.inkR) + 1)
  assert.ok(newFoot >= 0 && Math.abs(newFoot - prevFoot) <= 1, `the new 7 stands at ${newFoot}, its neighbour at ${prevFoot}`)
})

test('a figure made for a word printed in the look\'s own face is not re-weighed', async () => {
  // The re-weigh compares like with like: the stem the WORD measures against
  // the same characters measured in the face that will draw the new one. A
  // word's stem is a median over every stroke its figures cross, and in many
  // faces 0, 2, 3, 8 and 9 are crossed wider than a straight stem, so aiming
  // a "1" at that raw median made it heavier than the page's own "1" (a
  // service order's date, measured in the lab). Here the date IS the face as
  // the look prints it, so the like-for-like target is the glyph as made.
  const W = 900, H = 120, size = 34, sigma = 1.1, text = '10/08/2023'
  const font = new mupdf.Font('Arimo-Regular', fs.readFileSync(ROOT + '/public/fonts/match/Arimo-Regular.ttf'))
  const field = new Float32Array(W * H)
  let x = 60
  for (const ch of text) {
    const g = GS.rasterizeGlyph(mupdf, font, ch, size)
    if (g) {
      const d = GS.printedDarkness(g, sigma, 1)
      for (let yy = 0; yy < g.h; yy++) for (let xx = 0; xx < g.w; xx++) {
        const X = Math.round(x) + xx - Math.round(g.inkL), Y = 80 - Math.round(g.baseY) + yy
        if (X >= 0 && X < W && Y >= 0 && Y < H) field[Y * W + X] = Math.max(field[Y * W + X], d[yy * g.w + xx])
      }
    }
    x += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)), 0) * size
  }
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let p = 0; p < W * H; p++) {
    const a = Math.min(1, field[p])
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.round(250 * (1 - a) + 20 * a)
    rgba[p * 4 + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Date')
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, { id: 'd', text, inkRect: { x: 50 * 0.36, y: (80 - size) * 0.36, width: (x - 50) * 0.36, height: size * 1.2 * 0.36 }, confidence: 98 })
  assert.ok(li, LI.lastLineFailure())
  const word = li.words[0]
  assert.ok(word && word.weight !== null, 'the date has no measured stem')
  const { capH } = GA.lineMetrics(li, { loose: true })
  const fonts = new Map()
  const rasterize = async (file, chars, emPx) => {
    let f = fonts.get(file)
    if (!f) { f = new mupdf.Font(file, fs.readFileSync(`${ROOT}/public/fonts/match/${file}.ttf`)); fonts.set(file, f) }
    return chars.map(ch => GS.rasterizeGlyph(mupdf, f, ch, emPx))
  }
  const look = { family: 'Arimo', sigma, gamma: 1, score: 0.95, xhPerEm: 0.52, capPerEm: 0.716, regularAs: 'regular', boldAs: 'bold' }
  const atlas = { stem: { regular: NaN, bold: NaN } }
  const req = { char: '1', emPx: li.fit.emPx, xh: null, capH, bold: false, ink: [20, 20, 20], coreDark: li.coreDark }
  const natural = await GS.synthGlyph(look, rasterize, atlas, req)
  const made = await GS.synthGlyph(look, rasterize, atlas, { ...req, stem: word.weight, stemChars: text })
  assert.ok(natural && made, 'no glyph')
  const ink = (gl) => { let s = 0; for (let i = 0; i < gl.w * gl.h; i++) if (gl.m[i]) s += 1 - gl.t[i * 3] / 250; return s }
  const a = ink(natural), b = ink(made)
  assert.ok(Math.abs(b - a) <= a * 0.03, `made ${b.toFixed(1)} against ${a.toFixed(1)} as the face draws it`)
})

/** Lines of text drawn by MuPDF on white paper at 200 DPI: `[font file, size px, x, baseline y, text]`. */
function printedPage(W, H, lines, paper = (x, y) => 250) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  for (const [file, size, x, y, text] of lines) {
    const font = new mupdf.Font(file, fs.readFileSync(`${ROOT}/public/fonts/match/${file}.ttf`))
    const t = new mupdf.Text()
    t.showString(font, [size, 0, 0, -size, x, y], text)
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  }
  dev.close()
  const g = new Uint8Array(pix.getPixels()), st = pix.getStride()
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = 1 - g[y * st + x] / 255, p = (y * W + x) * 4, v = Math.round(paper(x, y) * (1 - a) + 15 * a)
    rgba[p] = rgba[p + 1] = rgba[p + 2] = v
    rgba[p + 3] = 255
  }
  return R.scanRasterOf(W, H, rgba, [W * 0.36, 0, 0, H * 0.36, 0, 0], W * 0.36, H * 0.36, 'Printed')
}

test('a serif heading never borrows a sans letter silently: it asks for the letter in its own face', () => {
  // The registry page's shape: a serif bold heading over a sans body, and
  // the edit needs an "E" and an "H" only the body prints.
  const raster = printedPage(1400, 360, [
    ['Tinos-Bold', 44, 60, 100, 'SIGA TICS'],
    ['Arimo-Bold', 44, 60, 260, 'ESTE HECHO HOY TECHO'],
  ])
  const pi = LI.preparePage(raster)
  const items = [
    { id: 'h', text: 'SIGA TICS', inkRect: { x: 50 * 0.36, y: 60 * 0.36, width: 340 * 0.36, height: 50 * 0.36 }, confidence: 99 },
    { id: 'b', text: 'ESTE HECHO HOY TECHO', inkRect: { x: 50 * 0.36, y: 220 * 0.36, width: 720 * 0.36, height: 50 * 0.36 }, confidence: 99 },
  ]
  const lis = items.map(it => LI.analyzeLine(pi, it))
  for (const li of lis) assert.ok(li, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, lis, 0)])
  const [hx, bx] = [lis[0], lis[1]].map(li => (li.words[0].x0 + li.words[li.words.length - 1].x1) / 2)
  assert.equal(GA.faceAt(atlas, 'h', hx, lis[0].fit.emPx), 'serif')
  assert.equal(GA.faceAt(atlas, 'b', bx, lis[1].fit.emPx), 'sans')
  const res = SE.applyLineEdit(pi, lis[0], atlas, 'SIGA TECH', raster.data.slice(), {})
  assert.ok(res.ok, res.reason)
  const asked = new Set((res.wanting ?? []).map(w => w.char))
  assert.ok(asked.has('E') && asked.has('H'), `asked for ${[...asked].join(',') || 'nothing'}`)
})

test('a security hatch continues through an erased word', () => {
  // Faint dots at a four-pixel pitch over the whole sheet (ten levels: a
  // registry page's hatch is six), a line of text over them.
  const hatch = (x, y) => (x % 4 === 0 && y % 4 === 0) ? 240 : 250
  const raster = printedPage(1400, 520, [['Arimo-Regular', 40, 60, 260, 'HATCH TEXT HERE']], hatch)
  const pi = LI.preparePage(raster)
  assert.ok(pi.texture, 'the hatch was not found')
  const li = LI.analyzeLine(pi, { id: 't', text: 'HATCH TEXT HERE', inkRect: { x: 50 * 0.36, y: 220 * 0.36, width: 520 * 0.36, height: 50 * 0.36 }, confidence: 99 })
  assert.ok(li, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li], 0)])
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, li, atlas, 'HATCH HERE', work, {})
  assert.ok(res.ok, res.reason)
  // Where "TEXT" was, the dots are back: the hatch positions print darker
  // than the paper between them, as everywhere else on the sheet.
  const w = li.words[1]
  let dots = 0, dotSum = 0, rest = 0, restSum = 0
  for (let y = Math.round(w.y0 ?? 225); y < 262; y++) for (let x = Math.round(w.x0) + 2; x < Math.round(w.x1) - 2; x++) {
    const v = work[(y * 1400 + x) * 4]
    if (raster.data[(y * 1400 + x) * 4] < 200) continue
    if (x % 4 === 0 && y % 4 === 0) { dots++; dotSum += v } else { rest++; restSum += v }
  }
  assert.ok(dots >= 20, `only ${dots} dot positions measured`)
  assert.ok(restSum / rest - dotSum / dots >= 6, `dots ${(dotSum / dots).toFixed(1)} against paper ${(restSum / rest).toFixed(1)}`)
})

test('a watermark over the text is found by its grey plateau, and its second reading only adds lines', async () => {
  const WM = await loadOcr('ocrWatermark.ts')
  // White paper, black text, a diagonal band of light grey (188) over a tenth of the sheet.
  const W = 400, H = 300, rgba = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 252
    if (Math.abs(x - y - 50) < 15) v = 188
    if (y % 40 > 30 && x % 9 < 5) v = 10
    const p = (y * W + x) * 4
    rgba[p] = rgba[p + 1] = rgba[p + 2] = v
    rgba[p + 3] = 255
  }
  const level = WM.watermarkLevel(rgba)
  assert.ok(level !== null && Math.abs(level - 188) <= 3, `level ${level}`)
  // The same page without the band has a smooth tail and no plateau.
  const plain = rgba.slice()
  for (let i = 0; i < plain.length; i += 4) if (plain[i] === 188) plain[i] = plain[i + 1] = plain[i + 2] = 252
  assert.equal(WM.watermarkLevel(plain), null)
  // A darker band (a colour behind reversed lettering) is never a watermark.
  const dark = rgba.slice()
  for (let i = 0; i < dark.length; i += 4) if (dark[i] === 188) dark[i] = dark[i + 1] = dark[i + 2] = 120
  assert.equal(WM.watermarkLevel(dark), null)
  const line = (x0, y0, x1, y1, text, confidence = 99) => ({ box: { x0, y0, x1, y1 }, text, confidence })
  const base = [line(10, 10, 300, 30, 'PRIMERA LINEA'), line(10, 50, 300, 70, 'SEGUNDA LINEA')]
  const extra = [
    line(12, 12, 298, 31, 'PRIMERA LlNEA'),        // the same line read again: never replaces it
    line(10, 90, 300, 110, '15.VIRTUALIZACION'),   // missed by the first reading: added
    line(10, 130, 40, 150, 'C'),                    // a stray letter: not a line
    line(10, 170, 300, 190, 'SERVIDORES', 70),      // unsure: not added
  ]
  assert.deepEqual(WM.linesMissed(base, extra).map(l => l.text), ['15.VIRTUALIZACION'])
})

test('ink the recogniser box barely touches is left out of the reading, unless the reading then breaks a word of its own', () => {
  // A seal's edge beside "UNAJMA", no space between: one-word reading, two ink words, the first outside the box.
  const chars = [...'UNAJMA']
  const words = [{ x0: 0, x1: 64, outside: true }, { x0: 85, x1: 460 }]
  const m = WS.alignCharsToWords(words, chars, new Set())
  assert.deepEqual(m.map(x => [x.word, x.from, x.to]), [[1, 0, 6]])
  // Without the flag the edge took the "U".
  const plain = WS.alignCharsToWords(words.map(w => ({ x0: w.x0, x1: w.x1 })), chars, new Set())
  assert.equal(plain[0].word, 0)
  // A clipped dash the reading names as a word of its own (" -") keeps its label.
  const dash = WS.alignCharsToWords([{ x0: 0, x1: 70 }, { x0: 80, x1: 82, outside: true }], [...'DBSANF00-'], new Set([8]))
  assert.deepEqual(dash.map(x => [x.word, x.from, x.to]), [[0, 0, 8], [1, 8, 9]])
})

/** A cover at 72 DPI: `text` in heavy Carlito Bold, `fg` on a flat `bg` with JPEG-like noise. */
function flatCoverScan(text, fg, bg, size = 200) {
  const W = 1400, H = 360
  const font = new mupdf.Font('Carlito', fs.readFileSync(ROOT + '/public/fonts/match/Carlito-Bold.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const t = new mupdf.Text()
  let pen = 60
  const boxes = []
  for (const ch of text) {
    const adv = font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0))) * size
    t.showString(font, [size, 0, 0, -size, pen, 260], ch)
    boxes.push([pen, pen + adv])
    pen += adv + 18
  }
  dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  dev.close()
  const g = pix.getPixels(), stride = pix.getStride()
  let seed = 12345
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = 1 - g[y * stride + x] / 255
    const i = (y * W + x) * 4
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(bg[c] * (1 - a) + fg[c] * a + (rnd() - 0.5) * 10)
    rgba[i + 3] = 255
  }
  return { raster: R.scanRasterOf(W, H, rgba, [W, 0, 0, H, 0, 0], W, H, 'Cover'), boxes, W, H }
}

/** How far the region [x0, x1) × the title's rows is from `bg`, at its worst (the 98th percentile). */
function offGround(work, W, x0, x1, bg) {
  const d = []
  for (let y = 90; y < 280; y++) for (let x = Math.round(x0); x < Math.round(x1); x++) {
    const i = (y * W + x) * 4
    d.push(Math.hypot(work[i] - bg[0], work[i + 1] - bg[1], work[i + 2] - bg[2]))
  }
  d.sort((a, b) => a - b)
  return d[Math.floor(d.length * 0.98)]
}

test('a white title on a flat red cover is read on its flat ground, and a deleted letter leaves the red', () => {
  const bg = [165, 20, 45]
  const { raster, boxes, W } = flatCoverScan('PIENSE', [250, 250, 250], bg)
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, { id: 't', text: 'PIENSE', inkRect: { x: 50, y: 110, width: boxes.at(-1)[1] - 40, height: 160 }, confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  assert.equal(LI.domainOfLine(li), 7, 'white on red is read with every channel inverted')
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li], 0)])
  const pl = LI.domainPage(pi, 7)
  const w = pl.s.data.slice()
  const res = SE.applyLineEdit(pl, li, atlas, 'PIENS', w, {})
  assert.ok(res.ok, res.reason)
  const work = raster.data.slice()
  for (let i = 0; i < w.length; i += 4) if (w[i] !== pl.s.data[i] || w[i + 1] !== pl.s.data[i + 1] || w[i + 2] !== pl.s.data[i + 2]) for (let c = 0; c < 3; c++) work[i + c] = 255 - w[i + c]
  const [x0, x1] = boxes.at(-1)
  assert.ok(offGround(work, W, x0, x1, bg) < 30, `the erased E is ${offGround(work, W, x0, x1, bg).toFixed(0)} off the red`)
})

test('peach lettering on purple is read with only its lighter channels inverted, and a deleted letter leaves the purple', () => {
  const bg = [140, 10, 240]
  const { raster, boxes, W } = flatCoverScan('OFFERS', [255, 215, 105], bg)
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, { id: 't', text: 'OFFERS', inkRect: { x: 50, y: 110, width: boxes.at(-1)[1] - 40, height: 160 }, confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  assert.equal(LI.domainOfLine(li), 3, 'red and green inverted, blue kept')
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li], 0)])
  const pl = LI.domainPage(pi, 3)
  const w = pl.s.data.slice()
  const res = SE.applyLineEdit(pl, li, atlas, 'OFFER', w, {})
  assert.ok(res.ok, res.reason)
  const work = raster.data.slice()
  for (let i = 0; i < w.length; i += 4) if (w[i] !== pl.s.data[i] || w[i + 1] !== pl.s.data[i + 1] || w[i + 2] !== pl.s.data[i + 2]) {
    work[i] = 255 - w[i]; work[i + 1] = 255 - w[i + 1]; work[i + 2] = w[i + 2]
  }
  const [x0, x1] = boxes.at(-1)
  assert.ok(offGround(work, W, x0, x1, bg) < 30, `the erased S is ${offGround(work, W, x0, x1, bg).toFixed(0)} off the purple`)
})

test('the page plan edits coloured lettering in its own domain and folds back only the channels it inverted', () => {
  const bg = [140, 10, 240]
  const { raster, boxes, W } = flatCoverScan('OFFERS', [255, 215, 105], bg)
  const pi = LI.preparePage(raster)
  const inkRect = { x: 50, y: 110, width: boxes.at(-1)[1] - 40, height: 160 }
  const li = LI.analyzeLine(pi, { id: 't', text: 'OFFERS', inkRect, confidence: 95 })
  assert.ok(li, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li], 0)])
  const items = [{ id: 't', text: 'OFFER', originalText: 'OFFERS', edited: true, removed: false, inkRect, rect: inkRect }]
  const plan = SEP.planScanEdits(pi, new Map([['t', li]]), atlas, items)
  assert.equal(plan.overlays.length, 1, JSON.stringify(plan.modes))
  assert.ok(plan.modes.t.startsWith('scan'), plan.modes.t)
  // The page as a viewer shows it: the overlay over the scan.
  const o = plan.overlays[0]
  const [ox, oy] = R.apply(raster.toPx, o.rect[0], o.rect[1])
  const work = raster.data.slice()
  for (let y = 0; y < o.height; y++) for (let x = 0; x < o.width; x++) {
    const a = o.alpha[y * o.width + x] / 255
    const p = ((Math.round(oy) + y) * W + Math.round(ox) + x) * 4
    for (let c = 0; c < 3; c++) work[p + c] = work[p + c] * (1 - a) + o.rgb[(y * o.width + x) * 3 + c] * a
  }
  const [x0, x1] = boxes.at(-1)
  assert.ok(offGround(work, W, x0, x1, bg) < 30, `the erased S is ${offGround(work, W, x0, x1, bg).toFixed(0)} off the purple`)
  // And the letters it kept are still peach.
  const [k0, k1] = boxes[0]
  let peach = 0
  for (let y = 140; y < 250; y++) for (let x = Math.round(k0); x < Math.round(k1); x++) {
    const i = (y * W + x) * 4
    if (work[i] > 230 && work[i + 1] > 190 && work[i + 2] < 140) peach++
  }
  assert.ok(peach > 500, `only ${peach} peach pixels left in the O`)
})

/** A table header's cell at 1 pt per pixel: white Carlito Bold over coarse grey stipple (a copier's screen), the cell a little wider than its text, on white paper. */
function stippleHeaderScan(text, size = 40) {
  // The band ends a third of an em under the baseline, as a header row does.
  const W = 900, H = 300, base = 160, Y0 = 60, Y1 = base + 14
  const font = new mupdf.Font('Carlito', fs.readFileSync(ROOT + '/public/fonts/match/Carlito-Bold.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const t = new mupdf.Text()
  let pen = 80
  const boxes = []
  for (const ch of text) {
    const adv = font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0))) * size
    t.showString(font, [size, 0, 0, -size, pen, base], ch)
    boxes.push([pen, pen + adv])
    pen += adv
  }
  dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  dev.close()
  const g = pix.getPixels(), stride = pix.getStride()
  let seed = 4242
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  // Clumps of two pixels, each clump's level spread ±35 about 122, and a little grain on top.
  const clump = new Float32Array(Math.ceil(W / 2) * Math.ceil(H / 2))
  for (let i = 0; i < clump.length; i++) clump[i] = (rnd() - 0.5) * 70
  const rgba = new Uint8ClampedArray(W * H * 4)
  const X0 = 50, X1 = Math.round(pen) + 30
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inBand = y >= Y0 && y < Y1 && x >= X0 && x < X1
    const ground = inBand ? Math.max(40, Math.min(205, 122 + clump[(y >> 1) * Math.ceil(W / 2) + (x >> 1)] + (rnd() - 0.5) * 24)) : 250
    const a = 1 - g[y * stride + x] / 255
    const v = Math.round(ground * (1 - a) + 250 * a)
    const i = (y * W + x) * 4
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v
    rgba[i + 3] = 255
  }
  const inkRect = { x: 74, y: base - size * 0.66 - 5, width: pen - 68, height: size * 0.66 + 11 }
  return { raster: R.scanRasterOf(W, H, rgba, [W, 0, 0, H, 0, 0], W, H, 'Header'), boxes, W, H, inkRect, base, band: [Y0, Y1], cell: [X0, X1] }
}

test('white letters on a stippled header band are read on the stipple, and a deleted letter leaves stipple', () => {
  const { raster, boxes, W, inkRect, base, band } = stippleHeaderScan('CONDICION')
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, { id: 'h', text: 'CONDICION', inkRect, confidence: 97 })
  assert.ok(li, LI.lastLineFailure())
  assert.equal(LI.domainOfLine(li), 7, 'white on grey is read inverted')
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li], 0)])
  const pl = LI.domainPage(pi, 7)
  const w = pl.s.data.slice()
  const res = SE.applyLineEdit(pl, li, atlas, 'CONDICON', w, {})
  assert.ok(res.ok, res.reason)
  const work = raster.data.slice()
  for (let i = 0; i < w.length; i += 4) if (w[i] !== pl.s.data[i] || w[i + 1] !== pl.s.data[i + 1] || w[i + 2] !== pl.s.data[i + 2]) for (let c = 0; c < 3; c++) work[i + c] = 255 - w[i + c]
  const lum = (d, x, y) => d[(y * W + x) * 4]
  const sd = (d, x0, x1, y0, y1) => {
    let s = 0, s2 = 0, n = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = lum(d, x, y); s += v; s2 += v * v; n++ }
    return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2))
  }
  // Where the last letter's right half stood, the stipple is back — as
  // rough as the band beside the line, not a smooth patch.
  const end = Math.round(boxes.at(-1)[1])
  const vac = sd(work, end - 10, end - 2, base - 22, base - 4)
  const ref = sd(raster.data, 52, 72, base - 22, base - 4)
  assert.ok(vac >= ref * 0.55, `vacated stipple spread ${vac.toFixed(1)} against ${ref.toFixed(1)} beside the line`)
  // Nothing darker than the stipple ever was, and nothing changed outside the band.
  let darkest = 255, outside = 0
  for (let y = 0; y < raster.h; y++) for (let x = 0; x < W; x++) {
    const v = lum(work, x, y)
    if (y >= band[0] && y < band[1]) darkest = Math.min(darkest, v)
    else if (v !== lum(raster.data, x, y)) outside++
  }
  assert.ok(darkest >= 35, `a pixel at ${darkest}: darker than any of the stipple`)
  assert.equal(outside, 0, 'pixels changed off the band')
})

test('a whole header line rewritten on a stipple keeps the stipple between its letters, with no grain from beyond the band', () => {
  const { raster, W, inkRect, base, band } = stippleHeaderScan('DNI NOMBRES')
  const pi = LI.preparePage(raster)
  const li = LI.analyzeLine(pi, { id: 'h', text: 'DNI NOMBRES', inkRect, confidence: 97 })
  assert.ok(li, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [li], 0)])
  const pl = LI.domainPage(pi, LI.domainOfLine(li))
  const w = pl.s.data.slice()
  const res = SE.applyLineEdit(pl, li, atlas, 'NOMBRES DNI', w, {})
  assert.ok(res.ok, res.reason)
  const work = raster.data.slice()
  for (let i = 0; i < w.length; i += 4) if (w[i] !== pl.s.data[i] || w[i + 1] !== pl.s.data[i + 1] || w[i + 2] !== pl.s.data[i + 2]) for (let c = 0; c < 3; c++) work[i + c] = 255 - w[i + c]
  // The ground among the letters (what is not a letter's white): as rough
  // as the band beside the line. A whole-line hole has nowhere to copy
  // grain from but outside the band, and taken from there it was flat.
  const spreadOf = (d, x0, x1) => {
    let s = 0, s2 = 0, n = 0
    for (let y = base - 22; y < base - 2; y++) for (let x = x0; x < x1; x++) {
      const v = d[(y * W + x) * 4]
      if (v > 215) continue
      s += v; s2 += v * v; n++
    }
    return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2))
  }
  const among = spreadOf(work, Math.round(inkRect.x) + 8, Math.round(inkRect.x + inkRect.width) - 8)
  const beside = spreadOf(raster.data, 52, 72)
  assert.ok(among >= beside * 0.6, `ground among the new letters spreads ${among.toFixed(1)} against ${beside.toFixed(1)} beside them`)
  let darkest = 255
  for (let y = band[0]; y < band[1]; y++) for (let x = 0; x < W; x++) darkest = Math.min(darkest, work[(y * W + x) * 4])
  assert.ok(darkest >= 35, `a pixel at ${darkest}: darker than any of the stipple`)
})

test('a lone figure in a ruled cell is sized by its ink, not by the cell its box was padded to', () => {
  // A results table's first column: one figure per row, rows 30 px apart,
  // ruled; the recogniser's box for each figure is the whole cell.
  const W = 400, H = 360, rowH = 30, top = 40, cx0 = 100, cx1 = 150, size = 24
  const font = new mupdf.Font('Carlito', fs.readFileSync(ROOT + '/public/fonts/match/Carlito-Regular.ttf'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const t = new mupdf.Text()
  const digits = '1234567890'
  for (let r = 0; r < digits.length; r++) {
    const adv = font.advanceGlyph(font.encodeCharacter(digits.codePointAt(r))) * size
    t.showString(font, [size, 0, 0, -size, (cx0 + cx1) / 2 - adv / 2, top + r * rowH + 23], digits[r])
  }
  // The next column's ID numbers: where the page's figures come from (a
  // one-figure reading gives none).
  t.showString(font, [size, 0, 0, -size, cx1 + 20, top + 23], '7346829105')
  dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
  dev.close()
  const g = pix.getPixels(), stride = pix.getStride()
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const rule = (x >= cx0 - 1 && x <= cx1 + 1 && y >= top && y < top + digits.length * rowH && ((y - top) % rowH < 2)) || ((x === cx0 || x === cx0 - 1 || x === cx1 || x === cx1 + 1) && y >= top && y < top + digits.length * rowH)
    const v = rule ? 30 : Math.round(250 * g[y * stride + x] / 255 + 30 * (1 - g[y * stride + x] / 255))
    const i = (y * W + x) * 4
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v
    rgba[i + 3] = 255
  }
  const raster = R.scanRasterOf(W, H, rgba, [W, 0, 0, H, 0, 0], W, H, 'Table')
  const pi = LI.preparePage(raster)
  const cell = (r) => ({ x: cx0 + 2, y: top + r * rowH + 2, width: cx1 - cx0 - 4, height: rowH - 3 })
  const lis = [...digits].map((d, r) => LI.analyzeLine(pi, { id: `r${r}`, text: d, inkRect: cell(r), confidence: 99 }))
  const li = lis[0]
  assert.ok(li, LI.lastLineFailure())
  // A figure 24 px of em, not the 70 the cell's width implied.
  assert.ok(Math.abs(li.fit.emPx - size) <= size * 0.3, `em ${li.fit.emPx.toFixed(1)} for a ${size} px figure`)
  assert.equal(li.cells.length, 1, 'the cell holds one figure')
  assert.ok(li.cells[0].x1 - li.cells[0].x0 < size * 0.6, 'the figure is its own ink, not the cell')
  const idWidth = [...'7346829105'].reduce((t, c) => t + font.advanceGlyph(font.encodeCharacter(c.codePointAt(0))) * size, 0)
  const ids = LI.analyzeLine(pi, { id: 'ids', text: '7346829105', inkRect: { x: cx1 + 18, y: top + 4, width: idWidth + 4, height: rowH - 6 }, confidence: 99 })
  assert.ok(ids, LI.lastLineFailure())
  const atlas = GA.atlasFrom([GA.harvestPage(pi, [...lis.filter(Boolean), ids], 0)])
  const work = raster.data.slice()
  const res = SE.applyLineEdit(pi, li, atlas, '7', work, {})
  assert.ok(res.ok, res.reason)
  // Nothing outside the edited cell changed: the rules and the other rows stand.
  let outside = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inCell = x > cx0 + 1 && x < cx1 - 1 && y >= top + 2 && y < top + rowH
    if (!inCell && work[(y * W + x) * 4] !== raster.data[(y * W + x) * 4]) outside++
  }
  assert.equal(outside, 0, `${outside} pixels changed outside the cell`)
})
