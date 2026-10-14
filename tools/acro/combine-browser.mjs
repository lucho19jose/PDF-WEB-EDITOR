/** Combine dialog regression: real row drags, external drops and repeated batches. */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { PDFDocument, Font, Matrix, ColorSpace, Pixmap, emptyStore } from 'mupdf'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})})
const page=await browser.newPage({viewport:{width:1440,height:1000}})
page.setDefaultTimeout(20000)
const errors=[];page.on('pageerror',e=>errors.push(e.message))
const check=(label,ok)=>{assert.ok(ok,label);console.log('PASS',label)}
function fixture(label,count=1,protectedPdf=false) {
  const d=new PDFDocument(),font=new Font('Helvetica'),f=d.addSimpleFont(font,'Latin')
  for(let p=1;p<=count;p++)d.insertPage(-1,d.addPage([0,0,612,792],0,{Font:{F:f}},`BT /F 20 Tf 60 710 Td (${label}-${p}) Tj ET`))
  const buf=d.saveToBuffer(protectedPdf?'encrypt=aes-256,user-password=test,owner-password=secret':'compress')
  const file={name:`${label}.pdf`,mimeType:'application/pdf',buffer:Buffer.from(buf.asUint8Array())}
  buf.destroy();font.destroy();d.destroy();return file
}
const a=fixture('A',2),b=fixture('B'),c=fixture('C',3),d=fixture('D')
async function drop(selector,files) {
  const transfer=await page.evaluateHandle(files=>{
    const dt=new DataTransfer()
    for(const f of files)dt.items.add(new File([new Uint8Array(f.bytes)],f.name,{type:f.type}))
    return dt
  },files.map(f=>({name:f.name,type:f.mimeType,bytes:[...f.buffer]})))
  await page.locator(selector).first().dispatchEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true})
  await transfer.dispose()
}
const names=()=>page.locator('.combine-list .cf-row:not(.fixed) .cf-name').allTextContents()
async function openDialog(include=false) {
  await page.evaluate(include=>window.__pdfHooks.acro.ui.openDialog('combine',include?{}:{files:[]}),include)
  await page.locator('.combine-list').waitFor()
}
async function combine(expected) {
  const oldId=await page.evaluate(()=>window.__combineDoc.documentId)
  await page.getByRole('button',{name:'Combinar',exact:true}).click()
  await page.waitForFunction(id=>window.__combineDoc.documentId>id,oldId)
  await page.locator('.combine-list').waitFor({state:'detached'})
  const saved=await page.evaluate(async()=>Array.from(new Uint8Array(await window.__pdfEngine.saveDocument())))
  const doc=new PDFDocument(new Uint8Array(saved)),text=[]
  for(let i=0;i<doc.countPages();i++){const p=doc.loadPage(i),st=p.toStructuredText();text.push(st.asText().trim());st.destroy();p.destroy()}
  doc.destroy();assert.deepEqual(text,expected)
}
async function savedPdf() {
  const data=await page.evaluate(async()=>{
    const bytes=await window.__pdfEngine.saveDocument()
    return new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.readAsDataURL(new Blob([bytes]))})
  })
  return Buffer.from(data,'base64')
}
function fingerprints(bytes) {
  const doc=new PDFDocument(bytes),result=[]
  try {
    for(let i=0;i<doc.countPages();i++) {
      const p=doc.loadPage(i),pix=p.toPixmap(Matrix.scale(.08,.08),ColorSpace.DeviceRGB,false,true)
      result.push(createHash('sha256').update(pix.asPNG()).digest('hex'))
      pix.destroy();p.destroy();emptyStore()
    }
  } finally {doc.destroy();emptyStore()}
  return result
}
try {
  await page.goto(process.env.APP_URL||'http://localhost:9000/')
  await page.waitForFunction(()=>window.__pdfHooks?.acro)
  await page.evaluate(async()=>{window.__combineDoc=(await import('/src/stores/document.ts')).useDocumentStore()})
  // Drop on Inicio: all files enter the combination instead of just opening the first.
  await drop('.home',[a,b,c]);await page.locator('.combine-list').waitFor()
  assert.deepEqual(await names(),['A.pdf','B.pdf','C.pdf'])
  check('multiple PDF drop on Home keeps every file',true)
  // An external file dropped DIRECTLY on a populated row must be added.
  await drop('.combine-list .cf-row',[d]);assert.deepEqual(await names(),['A.pdf','B.pdf','C.pdf','D.pdf'])
  check('external drop onto a row adds the file',true)
  const rows=page.locator('.combine-list .cf-row:not(.fixed)')
  await rows.first().dragTo(rows.last(),{targetPosition:{x:150,y:35}})
  assert.deepEqual(await names(),['B.pdf','C.pdf','D.pdf','A.pdf'])
  check('real downward drag moves to the indicated insertion boundary',true)
  await rows.last().dragTo(rows.first(),{targetPosition:{x:150,y:3}})
  assert.deepEqual(await names(),['A.pdf','B.pdf','C.pdf','D.pdf'])
  check('real upward drag moves to the beginning',true)
  // Slow drag traverses a row, then drops in the whitespace below the list.
  const from=await rows.first().boundingBox(),last=await rows.last().boundingBox(),list=await page.locator('.combine-list').boundingBox()
  await page.mouse.move(from.x+100,from.y+15);await page.mouse.down()
  await page.mouse.move(last.x+100,last.y+10,{steps:8})
  await page.mouse.move(list.x+100,list.y+list.height-2,{steps:8});await page.mouse.up()
  assert.deepEqual(await names(),['B.pdf','C.pdf','D.pdf','A.pdf'])
  check('drag into empty list space moves to the end',true)
  await rows.first().getByTitle('Bajar',{exact:true}).click()
  assert.deepEqual(await names(),['C.pdf','B.pdf','D.pdf','A.pdf'])
  check('arrow controls preserve the same ordering',true)
  await combine(['C-1','C-2','C-3','B-1','D-1','A-1','A-2'])
  check('saved combination contains every page in the displayed order',true)
  // Include an edited open PDF: its current bytes, not its old file contents.
  await page.evaluate(()=>window.__pdfHooks.acro.commands.headerFooter({pages:[0],header:{left:'EDITED',center:'',right:''},footer:{left:'',center:'',right:''},fontName:'Helvetica',fontSize:10,color:[0,0,0],margins:{top:20,bottom:20,left:20,right:20},startNumber:1,date:''}))
  await openDialog(true);await drop('.combine-list',[b])
  await page.getByRole('button',{name:'Combinar',exact:true}).click();await page.locator('.combine-list').waitFor({state:'detached'})
  check('include open document retains unsaved edits',await page.evaluate(async()=>JSON.stringify(await window.__pdfEngine.getPageText(0)).includes('EDITED')))
  check('include open document adds the new pages',await page.evaluate(()=>window.__combineDoc.totalPages===8))
  // Invalid inputs keep both the existing PDF and the dialog list for recovery.
  await openDialog();await drop('.combine-list',[a,{name:'broken.pdf',mimeType:'application/pdf',buffer:Buffer.from('invalid PDF')}])
  const id=await page.evaluate(()=>window.__combineDoc.documentId)
  await page.getByRole('button',{name:'Combinar',exact:true}).click();await page.locator('.combine-error').waitFor()
  check('failed batch preserves the open PDF',await page.evaluate(old=>window.__combineDoc.documentId===old,id))
  check('failed batch identifies the file and keeps the list',(await page.locator('.combine-error').innerText()).includes('broken.pdf')&&(await names()).length===2)
  await rows.last().getByTitle('Quitar',{exact:true}).click();await drop('.combine-list',[b]);await combine(['A-1','A-2','B-1'])
  check('correcting the list and retrying succeeds',true)
  await openDialog();await drop('.combine-list',[a,fixture('Locked',1,true)])
  const lockedId=await page.evaluate(()=>window.__combineDoc.documentId)
  await page.getByRole('button',{name:'Combinar',exact:true}).click();await page.locator('.combine-error').waitFor()
  check('password protected PDF fails without replacing the document',await page.evaluate(id=>window.__combineDoc.documentId===id,lockedId))
  await page.getByRole('button',{name:'Cancelar',exact:true}).click();await page.locator('.combine-list').waitFor({state:'detached'})
  // Repeated batches with the same filenames and a single load per batch.
  await page.evaluate(()=>{window.__combineLoads=0;const load=window.__pdfEngine.loadDocument;window.__pdfEngine.loadDocument=(...args)=>{window.__combineLoads++;return load(...args)}})
  for(let i=0;i<10;i++) {
    await openDialog();await drop('.combine-list',[a,b,c]);await rows.last().dragTo(rows.first(),{targetPosition:{x:150,y:3}})
    await combine(['C-1','C-2','C-3','A-1','A-2','B-1'])
  }
  check('10 consecutive combinations retain correct page order',true)
  check('each combination reloads the engine once',await page.evaluate(()=>window.__combineLoads===10))
  const image=new Pixmap(ColorSpace.DeviceRGB,[0,0,40,20],false);image.clear(200)
  const png={name:'picture.png',mimeType:'image/png',buffer:Buffer.from(image.asPNG())};image.destroy()
  await openDialog();await drop('.combine-list',[a,png]);await combine(['A-1','A-2',''])
  check('mixed PDF and image combination keeps the image page',true)
  await openDialog()
  const chooserPromise=page.waitForEvent('filechooser')
  await page.getByRole('button',{name:'Agregar archivos',exact:true}).click()
  await (await chooserPromise).setFiles([a,b])
  await page.waitForFunction(()=>document.querySelectorAll('.combine-list .cf-row').length===2)
  check('Agregar archivos uses the same ordered list as file drops',true)
  // Cancelled native drag must not affect the next external drop.
  const dt=await page.evaluateHandle(()=>new DataTransfer())
  await rows.first().dispatchEvent('dragstart',{dataTransfer:dt})
  await rows.first().dispatchEvent('dragend',{dataTransfer:dt})
  await drop('.combine-list .cf-row',[c])
  assert.deepEqual(await names(),['A.pdf','B.pdf','C.pdf'])
  await dt.dispose()
  check('cancelled drag leaves no stale source index',true)
  // Slow worker: all controls stay disabled and duplicate commands are rejected.
  await page.evaluate(()=>{
    const acro=window.__pdfEngine.acro
    window.__beforeCombineGate=acro
    window.__pdfEngine.acro=async (...args)=>{
      if(args[0]==='combinePdf')await new Promise(r=>window.__releaseCombine=r)
      return acro(...args)
    }
  })
  await page.getByRole('button',{name:'Combinar',exact:true}).click()
  await page.waitForFunction(()=>typeof window.__releaseCombine==='function')
  check('busy combination disables buttons and row dragging',await page.getByRole('button',{name:'Combinando...',exact:true}).isDisabled()&&await rows.first().getAttribute('draggable')==='false')
  check('second combine cannot overlap the first',await page.evaluate(async()=>!(await window.__pdfHooks.acro.commands.combine([])).success))
  await drop('.combine-list .cf-row',[d]);assert.equal((await names()).length,3)
  await page.evaluate(()=>window.__releaseCombine())
  await page.locator('.combine-list').waitFor({state:'detached'})
  check('slow batch finishes with the original selected files',await page.evaluate(()=>window.__combineDoc.totalPages===6))
  await page.evaluate(()=>window.__pdfEngine.acro=window.__beforeCombineGate)
  if(process.argv.length>2) {
    const paths=process.argv.slice(2),expected=paths.flatMap(path=>fingerprints(readFileSync(path)))
    await openDialog()
    const chooser=page.waitForEvent('filechooser')
    await page.getByRole('button',{name:'Agregar archivos',exact:true}).click()
    await(await chooser).setFiles(paths)
    await page.waitForFunction(n=>document.querySelectorAll('.combine-list .cf-row').length===n,paths.length)
    const started=performance.now()
    await page.getByRole('button',{name:'Combinar',exact:true}).click()
    await page.locator('.combine-list').waitFor({state:'detached'})
    const elapsed=performance.now()-started,actual=fingerprints(await savedPdf())
    check('real PDFs retain every rendered page in order',actual.length===expected.length&&actual.every((hash,i)=>hash===expected[i]))
    console.log(`PERF ${paths.length} real PDFs, ${actual.length} pages, ${Math.round(elapsed)} ms`)
  }
  assert.deepEqual(errors,[]);console.log('All combination browser checks passed')
}finally{await browser.close()}
