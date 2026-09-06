// Try replaceText on blocks found by text, report outcome and readback.
//   node tools/pdf-sweep/try-edits.mjs <pdf> <pageIndex> "<find>=><new>" ["<find>=><new>" ...]
import { createEngine } from './node-harness.mjs'

const [file, pageArg, ...edits] = process.argv.slice(2)
const p = Number(pageArg)
const eng = await createEngine()
await eng.load(file)
for (const e of edits) {
  const [find, repl] = e.split('=>')
  const { blocks } = await eng.send('getPageText', { pageIndex: p })
  const b = blocks.find(b => !b.invisible && b.text.includes(find))
  if (!b) { console.log(`NOT FOUND: ${JSON.stringify(find)}`); continue }
  const newText = b.text.replace(find, repl)
  let r
  try { r = await eng.send('replaceText', { pageIndex: p, blockId: b.id, newText }) } catch (err) { r = { success: false, error: err.message } }
  const after = (await eng.send('getPageText', { pageIndex: p })).blocks
  const hit = after.find(x => !x.invisible && x.text.includes(repl.trim()))
  console.log(`${b.id} ${JSON.stringify(b.text.slice(0, 50))} -> ${JSON.stringify(newText.slice(0, 50))}: ${r.success ? 'OK' : 'FAIL ' + r.error} strategy=${r.strategy ?? ''} subst=${r.substitutedFont ?? ''} readback=${hit ? JSON.stringify(hit.text.slice(0, 60)) : 'MISSING'}`)
}
await eng.close()
process.exit(0)
