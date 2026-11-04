/**
 * The engine thread: the app's own MuPDF worker (`src/engine/worker`), run in
 * a Node `worker_threads` Worker. One thread holds one document, exactly as
 * the browser worker does; a WASM trap kills only this thread, and the client
 * brings it back with the document.
 */
import './threadShim'
import '../../../src/engine/worker/mupdf.worker'
import { parentPort } from 'node:worker_threads'

parentPort!.on('message', (data: unknown) => {
  ;(globalThis as any).onmessage({ data })
})
