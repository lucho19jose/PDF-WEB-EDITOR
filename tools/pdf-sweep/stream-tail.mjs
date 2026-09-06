// Print the tail of a page's content stream.
//   node tools/pdf-sweep/stream-tail.mjs <pdf> <pageIndex> [chars]
import { createEngine } from './node-harness.mjs'
const [file, pageArg, n] = process.argv.slice(2)
const eng = await createEngine()
await eng.load(file)
const r = await eng.send('readContentStream', { pageIndex: Number(pageArg) })
const s = typeof r === 'string' ? r : (r.content ?? r.stream ?? new TextDecoder('latin1').decode(r.streamBytes ?? r))
console.log(s.slice(-Number(n || 3000)))
await eng.close()
process.exit(0)
