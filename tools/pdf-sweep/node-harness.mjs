/**
 * Node harness for the MuPDF worker — the engine without a browser.
 *
 * Loads `src/engine/worker/mupdf.worker.ts` through Vite's SSR loader with a
 * fake `self`, so the SAME matchers and writers the app uses can be driven
 * from a script: reproduce a report in seconds, or run the sweep in under a
 * minute (the browser sweep takes ~9 min). `PDF_ROOT` points it at another
 * checkout (a `git worktree` of the baseline commit, with `node_modules` and
 * `public/_sweep` junctioned in) so two trees can be compared side by side.
 *
 *   import { createEngine } from './node-harness.mjs'
 *   const eng = await createEngine()
 *   await eng.load('C:/path/to/file.pdf')
 *   const { blocks } = await eng.send('getPageText', { pageIndex: 0 })
 *   await eng.send('replaceText', { pageIndex: 0, blockId: blocks[3].id, newText: '21' })
 *
 * Only the engine runs here: nothing that needs the DOM, a fetch of
 * `/fonts/*` (the CJK face) or the viewer.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

export const ROOT = (process.env.PDF_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')).replace(/\\/g, '/')

export async function createEngine() {
  const { createServer } = await import(pathToFileURL(ROOT + '/node_modules/vite/dist/node/index.js').href)
  const server = await createServer({
    root: ROOT,
    configFile: ROOT + '/vite.config.ts',
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  globalThis.self = globalThis
  const pending = new Map()
  let nextId = 1
  globalThis.postMessage = (msg) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.type === 'success') p.resolve(msg.data)
    else p.reject(new Error(msg.error || JSON.stringify(msg)))
  }
  await server.ssrLoadModule('/src/engine/worker/mupdf.worker.ts')
  const send = (type, data = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    globalThis.self.onmessage({ data: { id, type, data } })
  })
  await send('init')
  return {
    send,
    async load(file) {
      const b = fs.readFileSync(file)
      return send('loadDocument', { bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) })
    },
    close: () => server.close(),
  }
}
