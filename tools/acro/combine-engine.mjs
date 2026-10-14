/** Preserve annotations and internal destinations without changing the live PDF. */
import assert from 'node:assert/strict'
import { PDFDocument, Font } from 'mupdf'
import { createEngine } from '../pdf-sweep/node-harness.mjs'
const eng=await createEngine()
function input(label) {
  const d=new PDFDocument(),font=new Font('Helvetica'),ref=d.addSimpleFont(font,'Latin')
  for(let p=0;p<2;p++)d.insertPage(-1,d.addPage([0,0,612,792],0,{Font:{F:ref}},`BT /F 20 Tf 60 700 Td (${label}-${p+1}) Tj ET`))
  const page=d.loadPage(0)
  page.createLink([40,100,180,120],d.formatLinkURI({type:'Fit',page:1}))
  page.createLink([40,140,180,160],'https://example.com')
  const note=page.createAnnotation('Text');note.setRect([200,100,220,120]);note.setContents('Retained note');note.update()
  page.destroy();font.destroy()
  const b=d.saveToBuffer('compress'),bytes=new Uint8Array(b.asUint8Array()).buffer
  b.destroy();d.destroy();return bytes
}
try {
  const a=input('A'),b=input('B')
  await eng.send('loadDocument',{bytes:a})
  const result=await eng.send('acro',{op:'combinePdf',args:{files:[a,b]}})
  assert.ok(result.success);assert.equal(result.pages,4)
  assert.equal((await eng.send('getPageCount')).pageCount,2)
  console.log('PASS batch construction leaves the live PDF untouched')
  const doc=new PDFDocument(new Uint8Array(result.bytes)),p=doc.loadPage(2)
  const links=p.getLinks()
  assert.ok(links.some(l=>l.getURI().startsWith('#page=4')))
  assert.ok(links.some(l=>l.getURI()==='https://example.com'))
  assert.ok(p.getAnnotations().some(a=>a.getContents()==='Retained note'))
  console.log('PASS external links, internal page destinations and notes are preserved')
  p.destroy();doc.destroy()
}finally{await eng.close()}
