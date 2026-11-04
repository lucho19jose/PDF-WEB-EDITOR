/**
 * Makes a Node worker thread look like the Web Worker the engine was written
 * for. Imported statically BEFORE `mupdf.worker.ts`, so it is in place before
 * the worker sets `self.onmessage` and before the first message arrives.
 *
 * - `self` is the global, and `self.postMessage` answers the parent thread.
 * - `fetch('/fonts/…')` is served from `assets/fonts` beside the bundle. The
 *   worker fetches the CJK fallback (`/fonts/NotoSansSC-Regular.otf`) and the
 *   metric-compatible faces (`/fonts/match/*.ttf`) by root-relative URL, which
 *   Node's fetch rejects; and `ensureCjkFontFor` remembers a failed load for
 *   the life of the thread, so this must work from the first call.
 */
import '../stdioGuard'
import { parentPort } from 'node:worker_threads'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const g = globalThis as any
g.self = g
g.postMessage = (msg: unknown, transfer?: Transferable[]) => parentPort!.postMessage(msg, (transfer ?? []) as any)

const assetsDir = process.env.PDF_MCP_ASSETS || path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets')
const realFetch: typeof fetch | undefined = g.fetch?.bind(g)

g.fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url
  if (typeof url === 'string' && url.startsWith('/fonts/')) {
    const rel = decodeURIComponent(url.split('?')[0]).replace(/^\/+/, '')
    const file = path.resolve(assetsDir, rel)
    if (!file.startsWith(path.resolve(assetsDir) + path.sep)) return new Response(null, { status: 404 })
    try {
      return new Response(await fs.promises.readFile(file), { status: 200 })
    } catch {
      return new Response(null, { status: 404 })
    }
  }
  if (!realFetch) throw new Error('fetch is not available')
  return realFetch(input, init)
}
