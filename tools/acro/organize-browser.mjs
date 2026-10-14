/** Browser regression for Organizar páginas. Start npm run dev first.
 * Requires Playwright (or PLAYWRIGHT_MODULE pointing at its index.mjs).
 * Optional: BROWSER_EXECUTABLE, APP_URL. Fixtures contain synthetic text only.
 *   node tools/acro/organize-browser.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { basename } from 'node:path'
import { PDFDocument, Matrix, ColorSpace, emptyStore } from 'mupdf'
import { createHash } from 'node:crypto'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const browser = await chromium.launch({ headless: true,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.setDefaultTimeout(30000)
const errors = []
page.on('pageerror', e => errors.push(e.message))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

function fixture(count) {
  const fontId = 3 + count * 2
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({length: count}, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`]
  for (let i = 0; i < count; i++) {
    const stream = `BT /F1 24 Tf 60 720 Td (Page ${i + 1} heading) Tj ET\n`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}endstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((obj, i) => { const offset = pdf.length; pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; return offset })
  const start = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return { name: `organize-${count}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(pdf) }
}
const check = (label, result) => { assert.ok(result, label); console.log('PASS', label) }
const ready = () => page.waitForFunction(() => window.__pdfEngine?.docLoaded.value && window.__pdfHooks.acro.ui.activeTool === 'organize')
const imagesReady = () => page.waitForFunction(() => [...document.querySelectorAll('.organize .cell')].every(el => {
  const img = el.querySelector('img'); return img?.complete && img.naturalWidth > 0
}))
const text = index => page.evaluate(async i => (await window.__pdfEngine.getPageText(i)).blocks.map(b => b.text).join(' '), index)

try {
  await page.goto(process.env.APP_URL || 'http://localhost:9000/')
  await page.getByRole('button', { name: /Organizar páginas.*Usar ahora/ }).click()
  await page.locator('.no-doc input[type=file]').setInputFiles(fixture(6))
  await ready()
  await imagesReady()
  check('home tool remains open after file finishes loading', await page.locator('.organize .cell').count() === 6)
  await page.evaluate(() => {
    window.__organizeFullRenders = 0
    const render = window.__pdfViewer.renderPage
    window.__pdfViewer.renderPage = (...args) => { window.__organizeFullRenders++; return render(...args) }
  })
  const first = page.locator('.organize .cell').first()
  const oldUrl = await first.locator('img').getAttribute('src')
  await first.hover()
  await first.getByTitle('Girar a la derecha', {exact: true}).click()
  await page.waitForFunction(() => document.querySelector('.organize img')?.naturalWidth > document.querySelector('.organize img')?.naturalHeight)
  check('rotation refreshes the thumbnail', await first.locator('img').getAttribute('src') !== oldUrl)
  check('rotation is applied to PDF bytes', (await page.evaluate(() => window.__pdfEngine.getPageSize(0))).rotation === 90)
  await page.evaluate(() => window.__pdfHooks.undo())
  await imagesReady()
  check('undo restores rotation', (await page.evaluate(() => window.__pdfEngine.getPageSize(0))).rotation === 0)
  await page.evaluate(() => window.__pdfHooks.redo())
  check('redo restores rotation', (await page.evaluate(() => window.__pdfEngine.getPageSize(0))).rotation === 90)
  await first.dragTo(page.locator('.organize .cell').nth(2), {targetPosition: {x: 250, y: 120}})
  await page.waitForFunction(() => window.__pdfHooks.acro.ui.selectedPages[0] === 2)
  check('drag reorders the actual PDF pages', (await text(0)).replace(/\s/g, '').includes('Page2heading') && (await text(2)).replace(/\s/g, '').includes('Page1heading'))
  await page.evaluate(() => window.__pdfHooks.acro.commands.duplicatePages([0]))
  check('duplicate inserts a page', await page.locator('.organize .cell').count() === 7 && (await text(1)).includes('Page 2 heading'))
  await page.evaluate(() => window.__pdfHooks.acro.commands.insertBlank(7))
  check('blank page inserts at the end', await page.locator('.organize .cell').count() === 8 && !(await text(7)).trim())
  await page.locator('.organize .cell').last().hover()
  await page.locator('.organize .cell').last().getByTitle('Eliminar páginas', {exact:true}).click()
  await page.getByRole('button', {name:'Aceptar', exact:true}).click()
  await page.waitForFunction(() => document.querySelectorAll('.organize .cell').length === 7)
  check('delete updates the page grid', await page.locator('.organize .cell').count() === 7)
  // Invalidate with active and queued work: every caller must settle, then a
  // fresh request must produce an image rather than wait behind a dead job.
  const queue = await page.evaluate(async () => {
    const thumbs = window.__pdfHooks.thumbnails
    const jobs = Array.from({length: 7}, (_, i) => thumbs.request(i + 1, 237))
    const duplicate = thumbs.request(7, 237)
    const deduped = duplicate === jobs[6]
    thumbs.invalidate()
    const settled = await Promise.race([Promise.all(jobs).then(() => true), new Promise(r => setTimeout(() => r(false), 5000))])
    const fresh = await Promise.race([thumbs.request(1, 238), new Promise(r => setTimeout(() => r(null), 10000))])
    return {settled, fresh: !!fresh, deduped}
  })
  check('duplicate thumbnail requests share work', queue.deduped)
  check('invalidating active/queued thumbnails settles every caller', queue.settled && queue.fresh)
  check('organizer edits do not render the hidden full-size viewer', await page.evaluate(() => window.__organizeFullRenders === 0))
  await page.locator('.organize .cell').nth(2).dblclick()
  await page.waitForSelector('.pdf-viewer-container', {state:'visible'})
  check('double-click returns to the chosen page', await page.evaluate(() => window.__pdfHooks.acro.ui.activeTool === null))
  // Long document: only visible/nearby thumbnails should render.
  await page.reload()
  await page.getByRole('button', {name: /Organizar páginas.*Usar ahora/}).click()
  await page.locator('.no-doc input[type=file]').setInputFiles(fixture(120))
  await ready()
  await page.waitForSelector('.organize img')
  check('large document uses lazy thumbnails', await page.locator('.organize .cell').count() === 120 && await page.locator('.organize img').count() < 30)
  await page.locator('.organize .cell').last().scrollIntoViewIfNeeded()
  await page.locator('.organize .cell').last().locator('img').waitFor()
  check('last page renders when scrolled into view', await page.locator('.organize .cell').last().locator('img').count() === 1)
  const slider = page.locator('.organize input[type=range]')
  await slider.evaluate(el => { for (const width of [180, 220, 300, 420, 100, 200]) { el.value = width; el.dispatchEvent(new Event('input', {bubbles:true})) } })
  await page.locator('.organize .cell').last().scrollIntoViewIfNeeded()
  await page.waitForFunction(() => document.querySelector('.organize .cell:last-of-type img')?.naturalWidth === 200 * Math.min(2, devicePixelRatio))
  check('rapid resizing finishes at the final thumbnail width', true)
  // No reload between files: the same worker, store, queue and thumbnail
  // service must survive repeated organizing, including scanned PDFs.
  async function openNext(file) {
    const oldTime = await page.evaluate(() => window.__pdfHooks.acro.ui.notifications[0]?.at || 0)
    await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles(file)
    await page.waitForFunction(({name, oldTime}) => window.__pdfHooks.acro.ui.notifications.some(n => n.at > oldTime && n.text.startsWith(name + ' abierto')),
      {name: typeof file === 'string' ? basename(file) : file.name, oldTime})
    await page.evaluate(() => { window.__pdfHooks.acro.ui.organizeThumbWidth = 150; window.__pdfHooks.acro.shell.openTool('organize') })
    await ready()
  }
  async function warmFirst(count) {
    await page.waitForFunction(count => {
      const {ui} = window.__pdfHooks.acro
      const thumbs = window.__pdfHooks.thumbnails
      return [...document.querySelectorAll('.organize .cell')].slice(0, count).every((el, i) => {
        const img = el.querySelector('img')
        return img?.complete && img.naturalWidth && img.src === thumbs.cached(i + 1, ui.organizeThumbWidth)
      })
    }, count)
  }
  const savedFingerprints = async count => {
    const encoded = await page.evaluate(async () => {
      const bytes = await window.__pdfEngine.saveDocument()
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result.split(',')[1])
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(new Blob([bytes]))
      })
    })
    const doc = new PDFDocument(new Uint8Array(Buffer.from(encoded, 'base64')))
    try {
      return Array.from({length: count}, (_, i) => {
        const p = doc.loadPage(i)
        const pixels = p.toPixmap(Matrix.scale(0.12, 0.12), ColorSpace.DeviceRGB, false, true)
        try { return createHash('sha256').update(pixels.getPixels()).digest('hex') }
        finally { pixels.destroy(); p.destroy() }
      })
    } finally { doc.destroy(); emptyStore() }
  }
  for (const [documentIndex, file] of [fixture(6), fixture(4), fixture(6), ...process.argv.slice(2)].entries()) {
    await openNext(file)
    const count = await page.locator('.organize .cell').count()
    if (count < 2) continue
    const warm = Math.min(count, 4)
    await warmFirst(warm)
    await page.waitForFunction(() => window.__pdfHooks.thumbnails.stats.pendingRequests === 0)
    const originals = await savedFingerprints(warm)
    const expected = [...originals]
    const initialRenders = await page.evaluate(() => window.__pdfHooks.thumbnails.stats.renders)
    const initialLoads = await page.evaluate(() => window.__pdfHooks.thumbnails.stats.documentLoads)
    const times = []
    for (let attempt = 0; attempt < 20; attempt++) {
      const start = performance.now()
      await page.evaluate(before => window.__pdfHooks.acro.commands.movePages([0], before), warm)
      times.push(Math.round(performance.now() - start))
      expected.push(expected.shift())
      await warmFirst(warm)
      assert.deepEqual(await savedFingerprints(warm), expected, 'saved PDF order must match every repeated move')
    }
    const stats = await page.evaluate(() => window.__pdfHooks.thumbnails.stats)
    check(`document ${documentIndex + 1}: 20 repeated moves update the saved PDF`, true)
    check(`document ${documentIndex + 1}: reorders reuse every rendered thumbnail`, stats.renders === initialRenders && stats.documentLoads === initialLoads)
    console.log(`PERF document ${documentIndex + 1}: ${count} pages, median ${[...times].sort((a,b) => a-b)[10]} ms, max ${Math.max(...times)} ms, 0 extra thumbnail renders`)
    // Human-paced drag: cross a cell first, then release in the white area.
    // Fast dragTo() skipped that intermediate dragover and missed the bug.
    if (count <= 6) {
      await page.setViewportSize({width:1840,height:1000})
      await warmFirst(count)
      const beforeGap = await savedFingerprints(count)
      const bounds = await page.locator('.organize .cell').first().boundingBox()
      await page.mouse.move(bounds.x + 40, bounds.y + 80)
      await page.mouse.down()
      await page.mouse.move(bounds.x + 48, bounds.y + 90, {steps:4})
      await page.mouse.move(bounds.x + 50, bounds.y + 180, {steps:4})
      await page.mouse.move(bounds.x + 50, bounds.y + 650, {steps:20})
      await page.mouse.up()
      await page.waitForFunction(last => !window.__pdfHooks.acro.ui.pageOperationBusy && window.__pdfHooks.acro.ui.selectedPages[0] === last, count - 1)
      assert.deepEqual(await savedFingerprints(count), [...beforeGap.slice(1), beforeGap[0]])
      check(`document ${documentIndex + 1}: a slow drag into empty space moves the page to the end`, true)
      await page.setViewportSize({width:1440,height:900})
    }
  }
  await openNext(fixture(4))
  const inserted = [fixture(2), fixture(3)]
  await page.locator('.organize .grid').evaluate((el, files) => {
    const transfer = new DataTransfer()
    for (const f of files) transfer.items.add(new File([new Uint8Array(f.bytes)], f.name, {type:'application/pdf'}))
    const r = el.getBoundingClientRect()
    const event = {bubbles:true, cancelable:true, dataTransfer:transfer, clientX:r.left + 30, clientY:r.bottom - 20}
    el.dispatchEvent(new DragEvent('dragover', event))
    el.dispatchEvent(new DragEvent('drop', event))
  }, inserted.map(f => ({name: f.name, bytes:[...f.buffer]})))
  await page.waitForFunction(() => document.querySelectorAll('.organize .cell').length === 9 && !window.__pdfHooks.acro.ui.pageOperationBusy)
  await warmFirst(9)
  const merged = await savedFingerprints(9)
  assert.deepEqual(merged.slice(4, 6), merged.slice(0, 2))
  assert.deepEqual(merged.slice(6), merged.slice(0, 3))
  await page.evaluate(() => window.__pdfHooks.acro.commands.movePages([0, 2], 9))
  const moved = [...merged.filter((_, i) => i !== 0 && i !== 2), merged[0], merged[2]]
  assert.deepEqual(await savedFingerprints(9), moved)
  check('dropping multiple PDFs then moving multiple pages updates the saved file', true)
  await page.evaluate(() => window.__pdfHooks.acro.commands.rotatePages([0], 90))
  await page.evaluate(() => window.__pdfHooks.undo())
  assert.deepEqual(await savedFingerprints(9), moved)
  check('a content change and undo preserve the reordered document', true)
  const locked = await page.evaluate(async () => {
    const viewer = window.__pdfViewer
    const reload = viewer.reloadDocument
    let release
    const gate = new Promise(r => { release = r })
    viewer.reloadDocument = async (...args) => { await gate; return reload(...args) }
    try {
      const first = window.__pdfHooks.acro.commands.movePages([0], 4)
      const busy = window.__pdfHooks.acro.ui.pageOperationBusy
      await window.__pdfHooks.acro.commands.movePages([1], 4)
      release()
      await first
      return busy && !window.__pdfHooks.acro.ui.pageOperationBusy
    } finally { release(); viewer.reloadDocument = reload }
  })
  assert.deepEqual(await savedFingerprints(9), [...moved.slice(1, 4), moved[0], ...moved.slice(4)])
  check('an overlapping drag cannot enqueue a reorder with stale page indices', locked)
  check('no browser runtime errors', errors.length === 0 || (console.log(errors), false))
} finally {
  await browser.close()
}
console.log('All organizer browser checks passed')
