import type { PageTextData, Quad, Pt, RectT, AnnotationInfo, MarkupType, ShapeType, SearchHit, BlockTransformOp, BlockStyleOp, BlockTransformResult, ImageOrient, ImageAlign } from './types'
import type { WorkerResponse } from './worker/worker-protocol'

/**
 * MuPDF Engine Bridge
 *
 * Provides a Promise-based API on the main thread that communicates
 * with the MuPDF Web Worker via postMessage.
 */
export class MuPDFBridge {
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<number, {
    resolve: (data: any) => void
    reject: (err: Error) => void
  }>()
  private _ready = false
  private initPromise: Promise<void> | null = null

  get ready() { return this._ready }

  /**
   * Initialize the worker and load the WASM module.
   * Memoized: concurrent callers all await the SAME init round-trip — the old
   * `if (this.worker) return` returned immediately for caller #2 while WASM
   * was still compiling, letting loadDocument hit an uninitialized worker.
   */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch(err => {
        this.initPromise = null // allow retry after failure
        throw err
      })
    }
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    if (this.worker) return

    this.worker = new Worker(
      new URL('./worker/mupdf.worker.ts', import.meta.url),
      { type: 'module' }
    )

    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      const pending = this.pending.get(msg.id)
      if (!pending) return

      this.pending.delete(msg.id)

      if (msg.type === 'error') {
        pending.reject(new Error(msg.error))
        // A WASM trap answers as an ordinary error, and the worker that sent
        // it is still running on a corrupted heap: every later call fails —
        // measured, one "memory access out of bounds" in a sweep turned the
        // 83 files after it into "No document loaded". It is a crash and is
        // handled as one.
        if (msg.fatal || isWasmFatal(msg.error)) this.markCrashed(msg.error)
      } else if (msg.type === 'success') {
        pending.resolve(msg.data)
      }
      // 'progress' type is not resolved, just ignored for now
    }

    this.worker.onerror = (err) => {
      console.error('[MuPDF Bridge] Worker error:', err)
      this.markCrashed(err.message || 'the PDF engine stopped')
    }

    // Send init message and wait for WASM to load
    await this.send('init')
    this._ready = true
  }

  /**
   * Load a PDF document from raw bytes.
   */
  async loadDocument(bytes: ArrayBuffer): Promise<{ pageCount: number }> {
    // Kept so a crashed worker can be given the document back — see `send`.
    this.lastDoc = bytes.slice(0)
    return this.send('loadDocument', { bytes }, [bytes])
  }

  /** The document most recently loaded, for putting back after a crash. */
  private lastDoc: ArrayBuffer | null = null
  /** Set by `onerror`; cleared once a fresh worker holds the document again. */
  private crashed = false
  private recovering: Promise<void> | null = null
  /** Told when the worker dies and is brought back, so the UI can say so. */
  onCrash: ((reason: string) => void) | null = null

  /**
   * Tear the worker down after a crash so the next call recovers instead of
   * hanging forever (`onerror`) or running on a corrupted heap (a WASM trap
   * reported as an error message).
   */
  private markCrashed(reason: string): void {
    for (const [, p] of this.pending) {
      p.reject(new Error(`Worker error: ${reason}`))
    }
    this.pending.clear()
    try { this.worker?.terminate() } catch (_) {}
    this.worker = null
    this._ready = false
    this.initPromise = null
    this.crashed = true
    try { this.onCrash?.(reason) } catch (_) { /* listener's problem */ }
  }

  /**
   * Bring a dead worker back with the document it had.
   *
   * MuPDF's WASM aborts on some malformed files and takes the whole worker
   * with it; before this, every later call answered "Worker not initialized"
   * and the app was dead until a reload (measured: one bad PDF in a sweep
   * of 110 failed the 68 that followed). The worker is respawned and the
   * last document reloaded; the call that found it dead is then retried
   * once. If the document itself is what kills the worker, the reload fails
   * and the caller gets that error rather than a hang.
   */
  private async recover(): Promise<void> {
    if (this.recovering) return this.recovering
    this.recovering = (async () => {
      await this.init()
      if (this.lastDoc) {
        const copy = this.lastDoc.slice(0)
        try {
          await this.send('loadDocument', { bytes: copy }, [copy])
        } catch (err) {
          // The document itself kills the worker: forget it, so the next
          // recovery yields an empty engine instead of another crash.
          this.lastDoc = null
          throw err
        }
      }
      this.crashed = false
    })().finally(() => { this.recovering = null })
    return this.recovering
  }

  /**
   * Get total page count of the loaded document.
   */
  async getPageCount(): Promise<{ pageCount: number }> {
    return this.send('getPageCount')
  }

  /**
   * Extract text blocks with character-level position data from a page.
   */
  async getPageText(pageIndex: number): Promise<PageTextData> {
    return this.send('getPageText', { pageIndex })
  }

  /**
   * Read the raw content stream string from a page.
   */
  async readContentStream(pageIndex: number): Promise<{ stream: string }> {
    return this.send('readContentStream', { pageIndex })
  }

  /** Triage aid: BT blocks per content source, as the matchers see them. */
  async debugBtBlocks(pageIndex: number, maxLen?: number): Promise<any[]> {
    return this.send('debugBtBlocks', { pageIndex, maxLen })
  }

  /**
   * Write raw content stream bytes to a page.
   */
  async writeContentStream(pageIndex: number, streamBytes: ArrayBuffer): Promise<{ written: boolean }> {
    return this.send('writeContentStream', { pageIndex, streamBytes }, [streamBytes])
  }

  /**
   * Replace text in a specific block of a page's content stream.
   */
  async replaceText(
    pageIndex: number,
    blockId: string,
    newText: string
  ): Promise<{ success: boolean; error?: string; substitutedFont?: string; strategy?: string; lines?: number }> {
    return this.send('replaceText', { pageIndex, blockId, newText })
  }

  /**
   * Add new text at a position on a page.
   */
  async addText(
    pageIndex: number,
    x: number,
    y: number,
    text: string,
    fontSize: number,
    fontName: string,
    color?: [number, number, number],
    rotation?: number,
    faceId?: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.send('addText', { pageIndex, x, y, text, fontSize, fontName, color, rotation, faceId })
  }

  /** Hand the worker a traced scan face to embed for runs that name it. */
  async registerFace(faceId: string, bytes: ArrayBuffer): Promise<{ success: boolean; error?: string }> {
    return this.send('registerFace', { faceId, bytes })
  }

  /**
   * Transform a text block's position and/or scale.
   * dx, dy: translation in PDF Tm coords (bottom-left origin)
   * sx, sy: scale factors (1.0 = no change)
   * anchorX, anchorY: anchor for scaling in PDF Tm coords
   */
  async transformTextBlock(
    pageIndex: number,
    blockId: string,
    dx: number,
    dy: number,
    sx: number,
    sy: number,
    anchorX: number,
    anchorY: number
  ): Promise<{ success: boolean; error?: string; strategy?: string; clipAdjusted?: boolean }> {
    return this.send('transformTextBlock', { pageIndex, blockId, dx, dy, sx, sy, anchorX, anchorY })
  }

  /**
   * Move/scale several blocks in ONE engine round-trip.
   *
   * Block ids are extraction indices, so a page can only be renumbered between
   * calls, never inside one: a multi-block move has to go through here rather
   * than looping transformTextBlock, or ops after the first address stale ids.
   */
  async transformTextBlocks(
    pageIndex: number,
    ops: BlockTransformOp[]
  ): Promise<{ results: BlockTransformResult[]; applied: number }> {
    return this.send('transformTextBlocks', { pageIndex, ops })
  }

  /**
   * Change font family / size / colour of blocks already on the page, in ONE
   * round-trip — same id-stability reason as transformTextBlocks.
   */
  async restyleTextBlocks(
    pageIndex: number,
    ops: BlockStyleOp[]
  ): Promise<{ results: BlockTransformResult[]; applied: number }> {
    return this.send('restyleTextBlocks', { pageIndex, ops })
  }

  /** Splice another PDF's pages into this document at `atIndex`. */
  async mergePages(bytes: ArrayBuffer, atIndex: number): Promise<{
    success: boolean; pageCount?: number; added?: number; error?: string }> {
    return this.send('mergePages', { bytes, atIndex }, [bytes])
  }

  /** Move an annotation into the page content, behind everything already there. */
  async flattenAnnotationBehind(pageIndex: number, annotIndex: number): Promise<{ success: boolean; error?: string }> {
    return this.send('flattenAnnotationBehind', { pageIndex, annotIndex })
  }

  /** Turn a Stamp image a quarter turn clockwise (appearance matrix + rect swap). */
  async rotateStampImage(pageIndex: number, annotIndex: number): Promise<{ success: boolean; error?: string }> {
    return this.send('rotateStampImage', { pageIndex, annotIndex })
  }

  /** Reparent an annotation onto another page, with a new rect in that page's space. */
  async moveAnnotationToPage(pageIndex: number, annotIndex: number, targetPage: number, rect: RectT): Promise<{ success: boolean; index?: number; error?: string }> {
    return this.send('moveAnnotationToPage', { pageIndex, annotIndex, targetPage, rect })
  }

  /** Images drawn by the page CONTENT (logos, photos, scans), with their rects. */
  async listContentImages(pageIndex: number): Promise<any[]> {
    return this.send('listContentImages', { pageIndex })
  }

  /** Move/resize a content-drawn image to `rect` (page space, y-down). */
  async transformContentImage(pageIndex: number, sourceKey: string, doOffset: number, name: string, rect: RectT): Promise<{ success: boolean; error?: string }> {
    return this.send('transformContentImage', { pageIndex, sourceKey, doOffset, name, rect })
  }

  /** Remove a content-drawn image's `Do` invocation from the stream. */
  async deleteContentImage(pageIndex: number, sourceKey: string, doOffset: number, name: string): Promise<{ success: boolean; error?: string }> {
    return this.send('deleteContentImage', { pageIndex, sourceKey, doOffset, name })
  }

  /** Mirror or quarter-turn a content-drawn image about its own centre. */
  async orientContentImage(pageIndex: number, sourceKey: string, doOffset: number, name: string, op: ImageOrient): Promise<{ success: boolean; error?: string }> {
    return this.send('orientContentImage', { pageIndex, sourceKey, doOffset, name, op })
  }

  /** Crop a content-drawn image to `rect` (page space, y-down) — the part to KEEP. */
  async cropContentImage(pageIndex: number, sourceKey: string, doOffset: number, name: string, rect: RectT): Promise<{ success: boolean; error?: string }> {
    return this.send('cropContentImage', { pageIndex, sourceKey, doOffset, name, rect })
  }

  /** Align a content-drawn image to the page, keeping its size. */
  async alignContentImage(pageIndex: number, sourceKey: string, doOffset: number, name: string, mode: ImageAlign, margin?: number): Promise<{ success: boolean; error?: string }> {
    return this.send('alignContentImage', { pageIndex, sourceKey, doOffset, name, mode, margin })
  }

  /** Bring a page image to the front of the paint order, or send it behind. */
  async reorderContentImage(pageIndex: number, sourceKey: string, doOffset: number, name: string, where: 'front' | 'back'): Promise<{ success: boolean; error?: string }> {
    return this.send('reorderContentImage', { pageIndex, sourceKey, doOffset, name, where })
  }

  /** Swap the picture an invocation draws, keeping its placement. */
  async replaceContentImage(pageIndex: number, sourceKey: string, doOffset: number, name: string, imageBytes: Uint8Array): Promise<{ success: boolean; name?: string; error?: string }> {
    return this.send('replaceContentImage', { pageIndex, sourceKey, doOffset, name, imageBytes })
  }

  /** Draw an image into the page content — behind everything, or over everything. */
  async drawImageInContent(pageIndex: number, rect: RectT, bytes: ArrayBuffer, behind: boolean): Promise<{ success: boolean; name?: string; error?: string }> {
    return this.send('drawImageInContent', { pageIndex, rect, bytes, behind }, [bytes])
  }

  /** Paint a filled rectangle into the page content, behind anything drawn after it. */
  async fillRect(pageIndex: number, rect: RectT, color: [number, number, number]): Promise<{ success: boolean; error?: string }> {
    return this.send('fillRect', { pageIndex, rect, color })
  }

  /**
   * Slide the drawn geometry below `thresholdY` by `dy`, both in PDF user
   * space (y-up), so a table's rules travel with the text inside them.
   */
  async shiftGraphicsBelow(pageIndex: number, thresholdY: number, dy: number):
    Promise<{ success: boolean; moved: number; skipped: number; error?: string }> {
    return this.send('shiftGraphicsBelow', { pageIndex, thresholdY, dy })
  }

  /**
   * Debug: inspect font encodings on a page.
   */
  async debugFonts(pageIndex: number): Promise<any> {
    return this.send('debugFonts', { pageIndex })
  }

  /** Page size + rotation in PDF points (top-left origin). */
  async getPageSize(pageIndex: number): Promise<{ width: number; height: number; rotation: number }> {
    return this.send('getPageSize', { pageIndex })
  }

  // ===== ANNOTATIONS =====

  async getAnnotations(pageIndex: number): Promise<{ annotations: AnnotationInfo[] }> {
    return this.send('getAnnotations', { pageIndex })
  }

  async addTextMarkup(pageIndex: number, markupType: MarkupType, quads: Quad[], color: [number, number, number], opacity?: number): Promise<{ success: boolean; index?: number; error?: string }> {
    return this.send('addTextMarkup', { pageIndex, markupType, quads, color, opacity })
  }

  async addShape(pageIndex: number, shapeType: ShapeType, opts: { rect?: RectT; points?: [Pt, Pt]; color: [number, number, number]; interiorColor?: [number, number, number] | null; width: number; opacity?: number }): Promise<{ success: boolean; index?: number; error?: string }> {
    return this.send('addShape', { pageIndex, shapeType, ...opts })
  }

  async addInk(pageIndex: number, strokes: Pt[][], color: [number, number, number], width: number, opacity?: number): Promise<{ success: boolean; index?: number; error?: string }> {
    return this.send('addInk', { pageIndex, strokes, color, width, opacity })
  }

  async addFreeText(pageIndex: number, rect: RectT, text: string, fontSize: number, color: [number, number, number], fontName?: string): Promise<{ success: boolean; index?: number; error?: string }> {
    return this.send('addFreeText', { pageIndex, rect, text, fontSize, color, fontName })
  }

  async addStickyNote(pageIndex: number, x: number, y: number, text: string, color: [number, number, number]): Promise<{ success: boolean; index?: number; error?: string }> {
    return this.send('addStickyNote', { pageIndex, x, y, text, color })
  }

  async addImageStamp(pageIndex: number, rect: RectT, imageBytes: ArrayBuffer): Promise<{ success: boolean; index?: number; error?: string }> {
    return this.send('addImageStamp', { pageIndex, rect, imageBytes }, [imageBytes])
  }

  async deleteAnnotation(pageIndex: number, annotIndex: number): Promise<{ success: boolean; error?: string }> {
    return this.send('deleteAnnotation', { pageIndex, annotIndex })
  }

  async updateAnnotation(pageIndex: number, annotIndex: number, changes: { rect?: RectT; color?: [number, number, number]; interiorColor?: [number, number, number] | null; opacity?: number; width?: number; contents?: string }): Promise<{ success: boolean; error?: string }> {
    return this.send('updateAnnotation', { pageIndex, annotIndex, ...changes })
  }

  // ===== PAGE MANAGEMENT =====

  async rotatePage(pageIndex: number, degrees: number): Promise<{ success: boolean; rotation?: number; error?: string }> {
    return this.send('rotatePage', { pageIndex, degrees })
  }
  async insertBlankPage(atIndex: number, width: number, height: number): Promise<{ success: boolean; pageCount?: number; error?: string }> {
    return this.send('insertBlankPage', { atIndex, width, height })
  }
  async deletePageOp(pageIndex: number): Promise<{ success: boolean; pageCount?: number; error?: string }> {
    return this.send('deletePageOp', { pageIndex })
  }
  async duplicatePage(pageIndex: number): Promise<{ success: boolean; pageCount?: number; error?: string }> {
    return this.send('duplicatePage', { pageIndex })
  }
  async movePage(from: number, to: number): Promise<{ success: boolean; pageCount?: number; error?: string }> {
    return this.send('movePage', { from, to })
  }

  // ===== SEARCH =====

  async searchPage(pageIndex: number, needle: string, maxHits?: number): Promise<{ hits: SearchHit[] }> {
    return this.send('searchPage', { pageIndex, needle, maxHits })
  }
  async searchDocument(needle: string, maxHitsPerPage?: number): Promise<{ hits: SearchHit[] }> {
    return this.send('searchDocument', { needle, maxHitsPerPage })
  }

  /**
   * Save the current document state to a new PDF buffer.
   */
  async saveDocument(): Promise<ArrayBuffer> {
    const result = await this.send('saveDocument')
    return result.bytes
  }

  /**
   * Destroy the loaded document and free WASM memory.
   */
  async destroy(): Promise<void> {
    if (!this.worker) return
    try { await this.send('destroy') } catch (_) { /* worker may already be dead */ }
    this.worker.terminate()
    this.worker = null
    this._ready = false
    this.initPromise = null
    // Reject anything still in flight — otherwise those callers hang forever
    // (stuck isLoading/searching flags after unmount).
    for (const [, p] of this.pending) {
      p.reject(new Error('Bridge destroyed'))
    }
    this.pending.clear()
  }

  /**
   * Send a message to the worker and return a Promise for the response.
   */
  private send(type: string, data?: any, transfer?: Transferable[]): Promise<any> {
    if (!this.worker) {
      // Dead after a crash: bring it back with its document, then carry on
      // with this call. Recovery's own sends run once the worker exists.
      if (this.crashed && type !== 'init') {
        return this.recover().then(() => this.send(type, data, transfer))
      }
      return Promise.reject(new Error('Worker not initialized'))
    }

    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const msg = { id, type, ...(data ? { data } : {}) }
      if (transfer?.length) {
        this.worker!.postMessage(msg, transfer)
      } else {
        this.worker!.postMessage(msg)
      }
    })
  }
}

/** The messages Emscripten's runtime produces when the WASM heap is gone. */
function isWasmFatal(message: string | undefined): boolean {
  return /memory access out of bounds|table index is out of bounds|unreachable|RuntimeError|null function or function signature mismatch|index out of bounds/i.test(message || '')
}

/** Singleton bridge instance */
let bridgeInstance: MuPDFBridge | null = null

export function getMuPDFBridge(): MuPDFBridge {
  if (!bridgeInstance) {
    bridgeInstance = new MuPDFBridge()
  }
  return bridgeInstance
}
