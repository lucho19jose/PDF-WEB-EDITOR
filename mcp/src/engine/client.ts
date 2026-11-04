/**
 * One engine thread and the calls made to it.
 *
 * - Calls go ONE AT A TIME. The worker's handler is async and awaits inside
 *   several messages (replaceText, addText, …), so two in flight can
 *   interleave on one document. The app serialises a level up (`enqueueOp`);
 *   here the client does it.
 * - Nothing is TRANSFERRED to the thread: structured clone copies, so a call
 *   can be retried after a crash with its arguments intact.
 * - A crash is a WASM trap reported as an error (`fatal`, or Emscripten's
 *   messages), the thread's `error` event or a non-zero exit. The thread is
 *   torn down, a fresh one gets the last document back, and the call that
 *   met the crash is retried once — the same recovery as `src/engine/bridge.ts`.
 */
import { Worker } from 'node:worker_threads'

export class EngineError extends Error {}

/** The messages Emscripten's runtime produces when the WASM heap is gone (as bridge.ts). */
export function isWasmFatal(message: string | undefined): boolean {
  return /memory access out of bounds|table index is out of bounds|unreachable|RuntimeError|null function or function signature mismatch|index out of bounds/i.test(message || '')
}

const READ_ONLY = new Set(['init', 'getPageCount', 'getPageText', 'getPageSize', 'getAnnotations', 'getSignatures', 'listContentImages',
  'searchPage', 'searchDocument', 'saveDocument', 'measureRuns', 'renderPixmap', 'debugBtBlocks', 'debugFonts'])
const READ_ONLY_ACRO = new Set(['cropOf', 'hasTagged', 'countRedactions', 'listLinks', 'outline', 'getMetadata', 'exportText', 'exportHtml',
  'exportStructured', 'sheetPage', 'renderImage', 'renderRegion', 'extractPages', 'split', 'saveProtected', 'needsPassword', 'copyImage'])

/** Calls that change nothing, and so can be replayed after a crash. */
function isReadOnly(type: string, data?: Record<string, unknown>): boolean {
  if (type === 'acro') return READ_ONLY_ACRO.has(String(data?.op))
  return READ_ONLY.has(type)
}

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void }
class CrashError extends Error {}

export class EngineClient {
  private worker: Worker | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private chain: Promise<unknown> = Promise.resolve()
  /** The document the thread holds, to give a fresh thread after a crash. */
  private lastDoc: ArrayBuffer | null = null
  /** The thread died; the next call starts a fresh one holding `lastDoc`. */
  private lost = false
  crashes = 0
  /** Test hook: kill the thread as a WASM trap would. */
  async killForTest(): Promise<void> { await this.worker?.terminate() }

  constructor(private readonly threadFile: string) {}

  /** Queue one call; the queue survives a failed call. */
  send<T = any>(type: string, data?: Record<string, unknown>): Promise<T> {
    const run = this.chain.then(() => this.callWithRecovery<T>(type, data))
    this.chain = run.catch(() => {})
    return run
  }

  /** Load a document (kept for crash recovery). */
  async load(bytes: ArrayBuffer): Promise<{ pageCount: number }> {
    const r = await this.send<{ pageCount: number }>('loadDocument', { bytes })
    this.lastDoc = bytes.slice(0)
    return r
  }

  /** Run `acro` sub-operations (acroTools.ts). */
  acro<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.send<T>('acro', { op, args })
  }

  async close(): Promise<void> {
    const w = this.worker
    this.worker = null
    this.ready = null
    this.rejectAll(new EngineError('engine closed'))
    if (w) await w.terminate().catch(() => {})
  }

  private async callWithRecovery<T>(type: string, data?: Record<string, unknown>): Promise<T> {
    // A thread that died BETWEEN calls (an exit, an error event) left no call
    // to retry, but the next one must not meet an empty engine.
    if (this.lost && type !== 'loadDocument') {
      await this.respawnWithDocument(type)
      this.lost = false
    }
    try {
      return await this.callNow<T>(type, data)
    } catch (err) {
      if (!(err instanceof CrashError)) throw err
      // The thread died. Bring it back holding the last LOADED document.
      // A read is retried once. An edit is not: one tool may make several
      // engine calls, and replaying only the last against the reloaded
      // document would silently drop the ones before it. The session puts
      // its document back and the tool reports the interruption.
      await this.respawnWithDocument(type)
      this.lost = false
      if (!isReadOnly(type, data)) throw new EngineError(`The PDF engine stopped during this operation (${err.message}). The document was restored to its state before the operation; it can be tried again.`)
      try {
        return await this.callNow<T>(type, data)
      } catch (again) {
        if (again instanceof CrashError) {
          await this.respawnWithDocument(type).catch(() => {})
          this.lost = false
          throw new EngineError(`The PDF engine crashed twice reading this document (${(again as Error).message}).`)
        }
        throw again
      }
    }
  }

  private async respawnWithDocument(type: string): Promise<void> {
    await this.ensureThread()
    if (this.lastDoc && type !== 'loadDocument') {
      try {
        await this.callNow('loadDocument', { bytes: this.lastDoc.slice(0) })
      } catch (err) {
        // The document itself kills the engine: forget it rather than loop.
        this.lastDoc = null
        throw new EngineError(`The PDF engine could not reopen the document after a crash: ${(err as Error).message}`)
      }
    }
  }

  private ensureThread(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const w = new Worker(this.threadFile, { stdout: true, stderr: true })
      w.stdout.pipe(process.stderr)
      w.stderr.pipe(process.stderr)
      w.on('message', (msg: any) => {
        const p = this.pending.get(msg?.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.type === 'success') p.resolve(msg.data)
        else if (msg.type === 'error') {
          if (msg.fatal || isWasmFatal(msg.error)) {
            p.reject(new CrashError(msg.error))
            this.teardown(w, msg.error)
          } else p.reject(new EngineError(msg.error || 'engine error'))
        }
      })
      w.on('error', (err: Error) => this.teardown(w, err?.message || String(err)))
      w.on('exit', (code) => { if (this.worker === w) this.teardown(w, `engine thread exited with code ${code}`) })
      this.worker = w
      await this.post(w, 'init')
    })().catch((err) => {
      this.ready = null
      throw err
    })
    return this.ready
  }

  private async callNow<T>(type: string, data?: Record<string, unknown>): Promise<T> {
    await this.ensureThread()
    return this.post<T>(this.worker!, type, data)
  }

  private post<T>(w: Worker, type: string, data?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      w.postMessage(data ? { id, type, data } : { id, type })
    })
  }

  private teardown(w: Worker, reason: string) {
    if (this.worker !== w) return
    this.worker = null
    this.ready = null
    this.lost = true
    this.crashes++
    console.error(`[pdf-editor-mcp] engine thread lost: ${reason}`)
    this.rejectAll(new CrashError(reason))
    void w.terminate().catch(() => {})
  }

  private rejectAll(err: Error) {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }
}
