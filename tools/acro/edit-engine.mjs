/** Worker checks for inherited crop boxes and failed batch atomicity. */
import assert from 'node:assert/strict'
import { PDFDocument } from 'mupdf'
import { createEngine } from '../pdf-sweep/node-harness.mjs'
const eng = await createEngine()
const d = new PDFDocument()
for (const size of [[612,792],[300,400]]) d.insertPage(-1,d.addPage([0,0,...size],0,{},''))
const first = d.findPage(0)
first.get('Parent').put('CropBox',[20,30,280,370])
const buf=d.saveToBuffer('compress'), bytes=new Uint8Array(buf.asUint8Array()).buffer
buf.destroy();d.destroy()
const acro=(op,args)=>eng.send('acro',{op,args})
try {
  await eng.send('loadDocument',{bytes})
  assert.equal((await eng.send('getPageSize',{pageIndex:0})).width,260)
  assert.ok((await acro('cropPages',{indices:[0,1],margins:{top:0,bottom:0,left:0,right:0}})).success)
  assert.equal((await eng.send('getPageSize',{pageIndex:0})).width,612)
  assert.equal((await eng.send('getPageSize',{pageIndex:1})).width,300)
  console.log('PASS reset overrides inherited CropBox')
  const failed=await acro('cropPages',{indices:[0,1],margins:{top:5,bottom:5,left:180,right:180}})
  assert.equal(failed.success,false)
  assert.equal((await eng.send('getPageSize',{pageIndex:0})).width,612)
  console.log('PASS invalid multi-page crop changes no pages')
  assert.equal((await acro('cropPages',{indices:[0],margins:{top:NaN,bottom:0,left:0,right:0}})).success,false)
  console.log('PASS invalid numeric margins rejected')
  await acro('rotatePages',{indices:[0],degrees:90})
  assert.ok((await acro('cropPages',{indices:[0],margins:{top:20,bottom:40,left:10,right:30}})).success)
  const size=await eng.send('getPageSize',{pageIndex:0})
  assert.equal(size.width,752);assert.equal(size.height,552)
  assert.deepEqual(await acro('cropOf',{pageIndex:0}),{top:20,bottom:40,left:10,right:30})
  console.log('PASS rotated crop preserves visible-edge margins')
  assert.ok((await acro('addLink',{pageIndex:0,rect:[40,40,180,60],target:{uri:'https://example.com',appearance:{visible:true,width:2,dashed:true,color:[1,0,0]}}})).success)
  const links=await acro('listLinks',{pageIndex:0})
  assert.deepEqual(links[0].appearance,{width:2,dashed:true,color:[1,0,0]})
  console.log('PASS link color, width and dashed style persist')
} finally {await eng.close()}
