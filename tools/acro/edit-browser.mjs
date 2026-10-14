/** Regression tests for image clipboard, links, crop and text formatting.
 * Requires a running dev server and Playwright, as organize-browser.mjs does.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { PDFDocument, Font, Pixmap, Image, ColorSpace } from 'mupdf'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) })
const context = await browser.newContext({ viewport: {width: 1440, height: 1000}, permissions: ['clipboard-read', 'clipboard-write'] })
const page = await context.newPage()
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', e => errors.push(e.message))
const check = (label, result) => { assert.ok(result, label); console.log('PASS', label) }
const d = new PDFDocument(), font = new Font('Helvetica')
const fontRef = d.addSimpleFont(font, 'Latin')
const pix = new Pixmap(ColorSpace.DeviceRGB, [0,0,32,16], false)
const pixels = pix.getPixels()
for (let i=0;i<pixels.length;i+=3) {pixels[i]=20;pixels[i+1]=100;pixels[i+2]=240}
const image = new Image(pix), imageRef = d.addImage(image)
for (let i=0;i<2;i++) d.insertPage(-1, d.addPage([0,0,612,792],0,{Font:{F1:fontRef},XObject:{Pic:imageRef}},
  `BT /F1 20 Tf 60 710 Td (Editable heading ${i+1}) Tj ET\nq 160 0 0 80 60 530 cm /Pic Do Q`))
const buf = d.saveToBuffer('compress'), bytes = Buffer.from(buf.asUint8Array())
buf.destroy(); image.destroy(); pix.destroy(); font.destroy(); d.destroy()
const fixture = {name:'edit-regression.pdf', mimeType:'application/pdf',buffer:bytes}
async function openFixture() {
  const oldId = await page.evaluate(() => window.__editDoc?.documentId ?? -1)
  await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles(fixture)
  await page.waitForFunction(() => window.__pdfEngine?.docLoaded.value)
  if (oldId >= 0) await page.waitForFunction(id => window.__editDoc.documentId > id, oldId)
  await page.evaluate(async () => {
    window.__editDoc = (await import('/src/stores/document.ts')).useDocumentStore()
    window.__editState = (await import('/src/stores/editor.ts')).useEditorStore()
    window.__pdfHooks.acro.shell.openTool('edit')
    window.__editDoc.setScale(1)
  })
  await page.locator('.cimg-hit').first().waitFor()
}
async function dragArea(tool,x,y,w,h) {
  await page.evaluate(t => window.__editState.setTool(t),tool)
  const capture = page.locator('.annot-capture'), box = await capture.boundingBox()
  await page.mouse.move(box.x+x,box.y+y); await page.mouse.down()
  await page.mouse.move(box.x+x+w,box.y+y+h,{steps:6}); await page.mouse.up()
}
try {
  await page.goto(process.env.APP_URL || 'http://localhost:9000/')
  await openFixture()
  // Real image selection and browser keyboard clipboard, with repeated pastes.
  await page.locator('.cimg-hit').first().click()
  await page.keyboard.press('Control+c')
  await page.waitForFunction(() => window.__editState.statusMessage.includes('Imagen copiada'))
  await page.waitForFunction(async () => (await navigator.clipboard.read()).some(i => i.types.includes('image/png')))
  const copied = await page.evaluate(async () => {
    const items = await navigator.clipboard.read(); const png = await items[0].getType('image/png')
    return {type:png.type,size:png.size}
  })
  check('Ctrl+C puts only the selected image on the system clipboard',copied.type==='image/png' && copied.size>0)
  await page.evaluate(() => {
    window.__clipboardCopies = 0
    const acro = window.__pdfEngine.acro
    window.__pdfEngine.acro = (...args) => { if (args[0] === 'copyImage') window.__clipboardCopies++; return acro(...args) }
  })
  const pasteTimes=[]
  for (let i=1;i<=5;i++) {
    const started=performance.now()
    await page.keyboard.press('Control+v')
    await page.waitForFunction(async count => (await window.__pdfEngine.getAnnotations(0)).filter(a => a.type==='Stamp').length===count,i)
    await page.evaluate(async () => (await import('/src/utils/opQueue.ts')).enqueueOp(async()=>{}))
    pasteTimes.push(performance.now()-started)
  }
  check('five repeated Ctrl+V operations retain every image',true)
  check('repeated pastes reuse the encoded image',await page.evaluate(()=>window.__clipboardCopies===0))
  console.log(`Paste median ${Math.round(pasteTimes.sort((a,b)=>a-b)[2])} ms (synthetic PDF)`)
  await page.evaluate(() => window.__pdfHooks.undo())
  check('image paste can be undone',await page.evaluate(async () => (await window.__pdfEngine.getAnnotations(0)).filter(a => a.type==='Stamp').length===4))
  await page.evaluate(() => window.__editDoc.setPage(2))
  await page.locator('.cimg-hit').first().waitFor()
  await page.keyboard.press('Control+v')
  await page.waitForFunction(async () => (await window.__pdfEngine.getAnnotations(1)).some(a=>a.type==='Stamp'))
  check('copied image survives moving to another page',true)
  await page.locator('.annot-hit').first().click()
  await page.keyboard.press('Control+c')
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+v')
  await page.waitForFunction(async () => (await window.__pdfEngine.getAnnotations(1)).filter(a=>a.type==='Stamp').length===2)
  check('inserted images can also be copied and pasted',true)
  await openFixture()
  await page.locator('.text-block').first().waitFor()
  await page.locator('.text-block').first().click()
  await page.getByTitle('Negrita',{exact:true}).click()
  await page.waitForFunction(async () => (await window.__pdfEngine.getTextBlocks(0)).some(b=>b.isBold))
  check('bold applies to existing text through the T button',true)
  await page.getByTitle('Negrita',{exact:true}).click()
  await page.waitForFunction(async () => (await window.__pdfEngine.getTextBlocks(0)).every(b=>!b.isBold))
  check('bold can be toggled off repeatedly',true)
  await page.locator('.text-block').first().click()
  await page.locator('.inline-editor[contenteditable]').fill('Changed heading')
  await page.getByTitle('Negrita',{exact:true}).click()
  await page.waitForFunction(async()=> (await window.__pdfEngine.getTextBlocks(0)).some(b=>b.text.includes('Changed heading') && b.isBold))
  check('bold preserves uncommitted inline text changes',true)
  await page.evaluate(() => { window.__editState.setTool('addText'); window.__editState.fontFamily='Helvetica-Bold' })
  await page.locator('.add-text-target').click({position:{x:300,y:350}})
  await page.locator('.add-text-editor').fill('Added bold text')
  await page.locator('.add-text-editor').press('Control+Enter')
  await page.waitForFunction(async () => (await window.__pdfEngine.getTextBlocks(0)).some(b=>b.text.includes('Added bold') && b.isBold))
  check('new text respects the chosen bold font',true)
  // External clipboard images use the normal insertion path.
  await page.evaluate(async()=> {
    const canvas=document.createElement('canvas');canvas.width=80;canvas.height=40
    const ctx=canvas.getContext('2d');ctx.fillStyle='#ff6600';ctx.fillRect(0,0,80,40)
    const blob=await new Promise(r=>canvas.toBlob(r,'image/png'))
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})])
  })
  await page.locator('.add-text-target').click({position:{x:300,y:450}})
  await page.locator('.add-text-editor').press('Escape')
  await page.keyboard.press('Control+v')
  await page.waitForFunction(async()=> (await window.__pdfEngine.getAnnotations(0)).some(a=>a.type==='Stamp'))
  await page.evaluate(async()=> (await import('/src/utils/opQueue.ts')).settleTransactions())
  check('Ctrl+V also inserts images copied from outside the PDF',true)
  for (let i=0;i<3;i++) await page.keyboard.press('Control+v')
  await page.waitForFunction(async()=> (await window.__pdfEngine.getAnnotations(0)).filter(a=>a.type==='Stamp').length===4)
  await page.evaluate(async()=> (await import('/src/utils/opQueue.ts')).settleTransactions())
  await page.evaluate(()=>window.__pdfHooks.undo())
  check('rapid external pastes each have their own undo point',await page.evaluate(async()=> (await window.__pdfEngine.getAnnotations(0)).filter(a=>a.type==='Stamp').length===3))
  await dragArea('link',300,250,160,40)
  await page.locator('.q-dialog input[placeholder="https://"]').fill('https://example.com')
  await page.getByRole('button',{name:'Aceptar',exact:true}).click()
  await page.evaluate(() => window.__editState.setTool('select'))
  await page.locator('.pdf-link').waitFor()
  check('inserted web link has a visible border',await page.locator('.pdf-link').evaluate(el=>parseFloat(getComputedStyle(el).borderTopWidth)>0))
  check('web link destination is active',await page.locator('.pdf-link').getAttribute('href')==='https://example.com')
  await page.evaluate(() => window.__pdfHooks.acro.commands.addLink(0,[300,310,460,350],{page:2}))
  await page.locator('.pdf-link').nth(1).click()
  check('page link navigates to its destination',await page.evaluate(()=>window.__editDoc.currentPage===2))
  await page.evaluate(()=>window.__editDoc.setPage(1))
  await dragArea('crop',50,50,500,650)
  await page.getByRole('button',{name:'Aceptar',exact:true}).click()
  await page.waitForFunction(async()=>Math.abs((await window.__pdfEngine.getPageSize(0)).width-500)<1)
  await page.waitForFunction(()=>Math.abs(document.querySelector('.pdf-page-wrapper.current').getBoundingClientRect().width-500)<2)
  check('drag crop changes the saved page and displayed canvas size',true)
  await page.locator('.q-dialog').waitFor({state:'detached'})
  await dragArea('crop',20,20,450,600)
  await page.getByRole('button',{name:'Aceptar',exact:true}).click()
  await page.waitForFunction(async()=>Math.abs((await window.__pdfEngine.getPageSize(0)).width-450)<1)
  check('second crop uses the already cropped page coordinates',true)
  await page.evaluate(()=>window.__pdfHooks.undo())
  check('crop undo restores the previous dimensions',await page.evaluate(async()=>Math.abs((await window.__pdfEngine.getPageSize(0)).width-500)<1))
  await page.evaluate(()=>window.__pdfHooks.acro.commands.cropPages([0],{top:0,left:0,right:0,bottom:0}))
  check('reset crop restores the original paper',await page.evaluate(async()=>(await window.__pdfEngine.getPageSize(0)).width===612))
  const saved=await page.evaluate(async()=>Array.from(new Uint8Array(await window.__pdfEngine.saveDocument())))
  const reopened=new PDFDocument(new Uint8Array(saved)), p=reopened.loadPage(0)
  check('link appearance persists after saving and reopening',p.getObject().get('Annots').get(p.getObject().get('Annots').length-2).get('Border').get(2).asNumber()===1)
  p.destroy();reopened.destroy()
  assert.deepEqual(errors,[])
  console.log('All editing browser checks passed')
} finally {await browser.close()}
