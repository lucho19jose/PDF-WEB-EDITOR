import type { PageTextData } from './types'
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

  get ready() { return this._ready }

  /**
   * Initialize the worker and load the WASM module.
   */
  async init(): Promise<void> {
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
      for (const [id, p] of this.pending) {
        p.reject(new Error(`Worker error: ${err.message}`))
      }
      this.pending.clear()
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
  ): Promise<{ success: boolean; error?: string }> {
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
    color?: [number, number, number]
  ): Promise<{ success: boolean; error?: string }> {
    return this.send('addText', { pageIndex, x, y, text, fontSize, fontName, color })
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
  ): Promise<{ success: boolean; error?: string }> {
    return this.send('transformTextBlock', { pageIndex, blockId, dx, dy, sx, sy, anchorX, anchorY })
  }

  /**
   * Debug: inspect font encodings on a page.
   */
  async debugFonts(pageIndex: number): Promise<any> {
    return this.send('debugFonts', { pageIndex })
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
    await this.send('destroy')
    this.worker.terminate()
    this.worker = null
    this._ready = false
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
