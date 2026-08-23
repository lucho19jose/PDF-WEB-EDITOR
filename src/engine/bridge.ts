import type { PageTextData, Quad, Pt, RectT, AnnotationInfo, MarkupType, ShapeType, SearchHit, BlockTransformOp, BlockStyleOp, BlockTransformResult } from './types'
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
      } else if (msg.type === 'success') {
        pending.resolve(msg.data)
      }
      // 'progress' type is not resolved, just ignored for now
    }

    this.worker.onerror = (err) => {
      console.error('[MuPDF Bridge] Worker error:', err)
      // Reject all pending promises
      for (const [, p] of this.pending) {
        p.reject(new Error(`Worker error: ${err.message}`))
      }
      this.pending.clear()
      // Tear down so future sends fail fast (reject) instead of hanging forever
      // against a dead worker, and so init() can recreate it.
      try { this.worker?.terminate() } catch (_) {}
      this.worker = null
      this._ready = false
      this.initPromise = null
    }

    // Send init message and wait for WASM to load
    await this.send('init')
    this._ready = true
  }

  /**
   * Load a PDF document from raw bytes.
   */
  async loadDocument(bytes: ArrayBuffer): Promise<{ pageCount: number }> {
    return this.send('loadDocument', { bytes }, [bytes])
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
    rotation?: number
  ): Promise<{ success: boolean; error?: string }> {
    return this.send('addText', { pageIndex, x, y, text, fontSize, fontName, color, rotation })
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

  /** Draw an image into the page content — behind everything, or over everything. */
  async drawImageInContent(pageIndex: number, rect: RectT, bytes: ArrayBuffer, behind: boolean): Promise<{ success: boolean; name?: string; error?: string }> {
    return this.send('drawImageInContent', { pageIndex, rect, bytes, behind }, [bytes])
  }

  /** Paint a filled rectangle into the page content, behind anything drawn after it. */
  async fillRect(pageIndex: number, rect: RectT, color: [number, number, number]): Promise<{ success: boolean; error?: string }> {
    return this.send('fillRect', { pageIndex, rect, color })
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

/** Singleton bridge instance */
let bridgeInstance: MuPDFBridge | null = null

export function getMuPDFBridge(): MuPDFBridge {
  if (!bridgeInstance) {
    bridgeInstance = new MuPDFBridge()
  }
  return bridgeInstance
}
