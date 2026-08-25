import { ref, readonly } from 'vue'
import { getMuPDFBridge } from '@/engine/bridge'
import type { PageTextData, TextBlock, Quad, Pt, RectT, AnnotationInfo, ContentImageInfo, MarkupType, ShapeType, SearchHit, BlockTransformOp, BlockStyleOp, BlockTransformResult } from '@/engine/types'

/**
 * Composable for interacting with the MuPDF editing engine.
 *
 * Wraps the MuPDF bridge with reactive state for Vue components.
 */
export function usePDFEngine() {
  const bridge = getMuPDFBridge()
  const isReady = ref(false)
  const isLoading = ref(false)
  const docLoaded = ref(false)
  const error = ref<string | null>(null)
  /** Internal path taken by the last transformTextBlock — read by the sweep harness. */
  const lastTransform = ref<{ strategy?: string; clipAdjusted?: boolean }>({})
  const pageTextCache = new Map<number, PageTextData>()

  /**
   * Initialize the MuPDF WASM engine.
   */
  async function initEngine(): Promise<boolean> {
    if (isReady.value) return true

    isLoading.value = true
    error.value = null

    try {
      await bridge.init()
      isReady.value = true
      console.log('[PDFEngine] MuPDF WASM initialized')
      return true
    } catch (err: any) {
      error.value = `Failed to init MuPDF: ${err.message}`
      console.error('[PDFEngine]', error.value)
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Load a PDF document into the MuPDF engine.
   * This is separate from PDF.js — MuPDF is used for editing,
   * while PDF.js handles rendering.
   */
  async function loadDocument(bytes: ArrayBuffer): Promise<number> {
    if (!isReady.value) {
      await initEngine()
    }

    isLoading.value = true
    error.value = null
    pageTextCache.clear()

    try {
      // Pass a copy since the original may be transferred
      const copy = bytes.slice(0)
      const result = await bridge.loadDocument(copy)
      docLoaded.value = true
      console.log(`[PDFEngine] Document loaded: ${result.pageCount} pages`)
      return result.pageCount
    } catch (err: any) {
      error.value = `Failed to load document: ${err.message}`
      console.error('[PDFEngine]', error.value)
      throw err
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Get text blocks for a page, with caching.
   */
  async function getPageText(pageIndex: number): Promise<PageTextData> {
    const cached = pageTextCache.get(pageIndex)
    if (cached) return cached

    try {
      const data = await bridge.getPageText(pageIndex)
      pageTextCache.set(pageIndex, data)
      return data
    } catch (err: any) {
      error.value = `Failed to get page text: ${err.message}`
      throw err
    }
  }

  /**
   * Get text blocks for a specific page.
   */
  async function getTextBlocks(pageIndex: number): Promise<TextBlock[]> {
    const data = await getPageText(pageIndex)
    return data.blocks
  }

  /** Triage aid: BT blocks per content source, as the worker's matchers see them. */
  async function debugBtBlocks(pageIndex: number, maxLen?: number): Promise<any[]> {
    return bridge.debugBtBlocks(pageIndex, maxLen)
  }

  /**
   * Read the raw content stream for a page (for debugging/inspection).
   */
  async function readContentStream(pageIndex: number): Promise<string> {
    try {
      const result = await bridge.readContentStream(pageIndex)
      return result.stream
    } catch (err: any) {
      error.value = `Failed to read content stream: ${err.message}`
      throw err
    }
  }

  /**
   * Replace text in a specific block on a page.
   * This modifies the actual PDF content stream.
   */
  async function replaceText(
    pageIndex: number,
    blockId: string,
    newText: string
  ): Promise<{ success: boolean; substitutedFont?: string; strategy?: string; lines: number }> {
    try {
      const result = await bridge.replaceText(pageIndex, blockId, newText)
      if (result.success) {
        // Invalidate cache for this page since content changed
        pageTextCache.delete(pageIndex)
        console.log(`[PDFEngine] Text replaced in block ${blockId}`)
      } else {
        error.value = result.error || 'Unknown error replacing text'
        console.warn('[PDFEngine]', error.value)
      }
      return {
        success: result.success,
        substitutedFont: result.substitutedFont,
        strategy: result.strategy,
        lines: result.lines ?? 1
      }
    } catch (err: any) {
      error.value = `Failed to replace text: ${err.message}`
      throw err
    }
  }

  /**
   * Add new text at a position on a page.
   */
  async function addText(
    pageIndex: number,
    x: number,
    y: number,
    text: string,
    fontSize: number,
    fontName: string,
    color?: [number, number, number],
    rotation?: number
  ): Promise<boolean> {
    try {
      const result = await bridge.addText(pageIndex, x, y, text, fontSize, fontName, color, rotation)
      if (result.success) {
        pageTextCache.delete(pageIndex)
      } else {
        error.value = result.error || 'Unknown error adding text'
      }
      return result.success
    } catch (err: any) {
      error.value = `Failed to add text: ${err.message}`
      throw err
    }
  }

  /**
   * Transform a text block (move/resize) by modifying its Tm matrix.
   */
  async function transformTextBlock(
    pageIndex: number,
    blockId: string,
    dx: number,
    dy: number,
    sx: number,
    sy: number,
    anchorX: number,
    anchorY: number
  ): Promise<boolean> {
    try {
      const result = await bridge.transformTextBlock(pageIndex, blockId, dx, dy, sx, sy, anchorX, anchorY)
      // Which internal path handled it — read by the sweep harness, not the UI.
      lastTransform.value = { strategy: result.strategy, clipAdjusted: result.clipAdjusted }
      if (result.success) {
        pageTextCache.delete(pageIndex)
      } else {
        error.value = result.error || 'Unknown error transforming text block'
      }
      return result.success
    } catch (err: any) {
      error.value = `Failed to transform text block: ${err.message}`
      throw err
    }
  }

  /**
   * Move/scale several blocks at once (multi-block drag + collision pushes).
   *
   * Returns how many ops the engine actually applied. A partial result is
   * reported rather than swallowed: the caller tells the user "moved 3 of 4"
   * instead of claiming a success that half happened.
   */
  async function transformTextBlocks(
    pageIndex: number,
    ops: BlockTransformOp[]
  ): Promise<{ applied: number; total: number; results: BlockTransformResult[] }> {
    if (ops.length === 0) return { applied: 0, total: 0, results: [] }
    try {
      const result = await bridge.transformTextBlocks(pageIndex, ops)
      if (result.applied > 0) pageTextCache.delete(pageIndex)
      const failed = result.results.find(r => !r.success)
      if (failed) error.value = failed.error || 'Unknown error transforming text blocks'
      return { applied: result.applied, total: ops.length, results: result.results }
    } catch (err: any) {
      error.value = `Failed to transform text blocks: ${err.message}`
      throw err
    }
  }

  /**
   * Restyle blocks already on the page (font family / size / colour).
   *
   * Batched for the same reason the transform is: ids are extraction indices,
   * so the page must not be renumbered between the ops of one user action.
   */
  async function restyleTextBlocks(
    pageIndex: number,
    ops: BlockStyleOp[]
  ): Promise<{ applied: number; total: number; results: BlockTransformResult[] }> {
    if (ops.length === 0) return { applied: 0, total: 0, results: [] }
    try {
      const result = await bridge.restyleTextBlocks(pageIndex, ops)
      if (result.applied > 0) pageTextCache.delete(pageIndex)
      const failed = result.results.find(r => !r.success)
      if (failed) error.value = failed.error || 'Unknown error restyling text blocks'
      return { applied: result.applied, total: ops.length, results: result.results }
    } catch (err: any) {
      error.value = `Failed to restyle text blocks: ${err.message}`
      throw err
    }
  }

  // ===== ANNOTATIONS =====

  async function getPageSize(pageIndex: number) {
    return bridge.getPageSize(pageIndex)
  }

  async function getAnnotations(pageIndex: number): Promise<AnnotationInfo[]> {
    try {
      const res = await bridge.getAnnotations(pageIndex)
      return res.annotations
    } catch (err: any) {
      error.value = `Failed to get annotations: ${err.message}`
      return []
    }
  }

  function wrap(result: { success: boolean; error?: string }, ctx: string, pageIndex?: number): boolean {
    if (result.success) {
      if (pageIndex !== undefined) pageTextCache.delete(pageIndex)
    } else {
      error.value = result.error || `Unknown error: ${ctx}`
      console.warn('[PDFEngine]', ctx, error.value)
    }
    return result.success
  }

  async function addTextMarkup(pageIndex: number, markupType: MarkupType, quads: Quad[], color: [number, number, number], opacity?: number): Promise<boolean> {
    return wrap(await bridge.addTextMarkup(pageIndex, markupType, quads, color, opacity), 'addTextMarkup', pageIndex)
  }
  async function addShape(pageIndex: number, shapeType: ShapeType, opts: { rect?: RectT; points?: [Pt, Pt]; color: [number, number, number]; interiorColor?: [number, number, number] | null; width: number; opacity?: number }): Promise<boolean> {
    return wrap(await bridge.addShape(pageIndex, shapeType, opts), 'addShape', pageIndex)
  }
  async function addInk(pageIndex: number, strokes: Pt[][], color: [number, number, number], width: number, opacity?: number): Promise<boolean> {
    return wrap(await bridge.addInk(pageIndex, strokes, color, width, opacity), 'addInk', pageIndex)
  }
  async function addFreeText(pageIndex: number, rect: RectT, text: string, fontSize: number, color: [number, number, number], fontName?: string): Promise<boolean> {
    return wrap(await bridge.addFreeText(pageIndex, rect, text, fontSize, color, fontName), 'addFreeText', pageIndex)
  }
  async function addStickyNote(pageIndex: number, x: number, y: number, text: string, color: [number, number, number]): Promise<boolean> {
    return wrap(await bridge.addStickyNote(pageIndex, x, y, text, color), 'addStickyNote', pageIndex)
  }
  async function addImageStamp(pageIndex: number, rect: RectT, imageBytes: ArrayBuffer): Promise<boolean> {
    return wrap(await bridge.addImageStamp(pageIndex, rect, imageBytes), 'addImageStamp', pageIndex)
  }
  async function deleteAnnotation(pageIndex: number, annotIndex: number): Promise<boolean> {
    return wrap(await bridge.deleteAnnotation(pageIndex, annotIndex), 'deleteAnnotation', pageIndex)
  }
  async function updateAnnotation(pageIndex: number, annotIndex: number, changes: { rect?: RectT; color?: [number, number, number]; interiorColor?: [number, number, number] | null; opacity?: number; width?: number; contents?: string }): Promise<boolean> {
    return wrap(await bridge.updateAnnotation(pageIndex, annotIndex, changes), 'updateAnnotation', pageIndex)
  }

  // ===== PAGE MANAGEMENT =====

  async function rotatePage(pageIndex: number, degrees: number): Promise<boolean> {
    return wrap(await bridge.rotatePage(pageIndex, degrees), 'rotatePage', pageIndex)
  }
  /**
   * Splice another PDF's pages in. Returns the new page count, or false.
   */
  /** Move an annotation into the page content, behind everything already there. */
  async function flattenAnnotationBehind(pageIndex: number, annotIndex: number): Promise<boolean> {
    return wrap(await bridge.flattenAnnotationBehind(pageIndex, annotIndex), 'flattenAnnotationBehind', pageIndex)
  }

  /** Turn a Stamp image a quarter turn clockwise. */
  async function rotateStampImage(pageIndex: number, annotIndex: number): Promise<boolean> {
    return wrap(await bridge.rotateStampImage(pageIndex, annotIndex), 'rotateStampImage', pageIndex)
  }

  /** Reparent an annotation onto another page, with a new rect in that page's space. */
  async function moveAnnotationToPage(pageIndex: number, annotIndex: number, targetPage: number, rect: RectT): Promise<boolean> {
    return wrap(await bridge.moveAnnotationToPage(pageIndex, annotIndex, targetPage, rect), 'moveAnnotationToPage', pageIndex)
  }

  /** Images drawn by the page CONTENT (logos, photos, scans), with their rects. */
  async function listContentImages(pageIndex: number): Promise<ContentImageInfo[]> {
    try { return await bridge.listContentImages(pageIndex) } catch (_) { return [] }
  }

  /** Move/resize a content-drawn image to `rect` (page space, y-down). */
  async function transformContentImage(pageIndex: number, sourceKey: string, doOffset: number, name: string, rect: RectT): Promise<boolean> {
    return wrap(await bridge.transformContentImage(pageIndex, sourceKey, doOffset, name, rect), 'transformContentImage', pageIndex)
  }

  /** Draw an image into the page content — behind everything, or over everything. */
  async function drawImageInContent(pageIndex: number, rect: RectT, bytes: ArrayBuffer, behind: boolean): Promise<boolean> {
    return wrap(await bridge.drawImageInContent(pageIndex, rect, bytes, behind), 'drawImageInContent', pageIndex)
  }

  /** Paint a filled rectangle into the page content stream (behind later drawing). */
  async function fillRect(pageIndex: number, rect: RectT, color: [number, number, number]): Promise<boolean> {
    return wrap(await bridge.fillRect(pageIndex, rect, color), 'fillRect', pageIndex)
  }

  /**
   * Move the rules and fills below `thresholdY` down with the text.
   *
   * Reported rather than boolean: a page can hold geometry this must decline to
   * touch — a path straddling the line, a rotated transform — and the caller
   * says so instead of showing a table it half moved.
   */
  async function shiftGraphicsBelow(pageIndex: number, thresholdY: number, dy: number):
    Promise<{ moved: number; skipped: number }> {
    const r = await bridge.shiftGraphicsBelow(pageIndex, thresholdY, dy)
    pageTextCache.delete(pageIndex)
    if (!r.success) { error.value = r.error || 'shiftGraphicsBelow failed'; return { moved: 0, skipped: 0 } }
    return { moved: r.moved, skipped: r.skipped }
  }

  async function mergePages(bytes: ArrayBuffer, atIndex: number): Promise<{ pages: number; added: number } | false> {
    const r = await bridge.mergePages(bytes, atIndex)
    pageTextCache.clear()
    if (r.success) return { pages: r.pageCount ?? 0, added: r.added ?? 0 }
    error.value = r.error || 'merge failed'
    return false
  }

  async function insertBlankPage(atIndex: number, width: number, height: number): Promise<number | false> {
    const r = await bridge.insertBlankPage(atIndex, width, height)
    pageTextCache.clear()
    return r.success ? (r.pageCount ?? 0) : (error.value = r.error || 'insert failed', false)
  }
  async function deletePage(pageIndex: number): Promise<number | false> {
    const r = await bridge.deletePageOp(pageIndex)
    pageTextCache.clear()
    return r.success ? (r.pageCount ?? 0) : (error.value = r.error || 'delete failed', false)
  }
  async function duplicatePage(pageIndex: number): Promise<number | false> {
    const r = await bridge.duplicatePage(pageIndex)
    pageTextCache.clear()
    return r.success ? (r.pageCount ?? 0) : (error.value = r.error || 'duplicate failed', false)
  }
  async function movePage(from: number, to: number): Promise<number | false> {
    const r = await bridge.movePage(from, to)
    pageTextCache.clear()
    return r.success ? (r.pageCount ?? 0) : (error.value = r.error || 'move failed', false)
  }

  // ===== SEARCH =====

  async function searchPage(pageIndex: number, needle: string, maxHits?: number): Promise<SearchHit[]> {
    const r = await bridge.searchPage(pageIndex, needle, maxHits)
    return r.hits
  }
  async function searchDocument(needle: string, maxHitsPerPage?: number): Promise<SearchHit[]> {
    const r = await bridge.searchDocument(needle, maxHitsPerPage)
    return r.hits
  }

  /**
   * Save the modified document and return the PDF bytes.
   */
  async function saveDocument(): Promise<ArrayBuffer> {
    isLoading.value = true
    try {
      const bytes = await bridge.saveDocument()
      console.log(`[PDFEngine] Document saved: ${(bytes.byteLength / 1024).toFixed(1)} KB`)
      return bytes
    } catch (err: any) {
      error.value = `Failed to save document: ${err.message}`
      throw err
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Destroy the engine and free resources.
   */
  async function destroyEngine(): Promise<void> {
    pageTextCache.clear()
    await bridge.destroy()
    isReady.value = false
    docLoaded.value = false
    error.value = null
  }

  return {
    // State
    isReady: readonly(isReady),
    isLoading: readonly(isLoading),
    docLoaded: readonly(docLoaded),
    error: readonly(error),

    // Methods
    initEngine,
    loadDocument,
    getPageText,
    getTextBlocks,
    debugBtBlocks,
    readContentStream,
    replaceText,
    addText,
    transformTextBlock,
    transformTextBlocks,
    restyleTextBlocks,
    lastTransform,
    saveDocument,
    destroyEngine,
    // geometry
    getPageSize,
    // annotations
    getAnnotations,
    addTextMarkup,
    addShape,
    addInk,
    addFreeText,
    addStickyNote,
    addImageStamp,
    deleteAnnotation,
    updateAnnotation,
    // page management
    rotatePage,
    flattenAnnotationBehind,
    rotateStampImage,
    moveAnnotationToPage,
    listContentImages,
    transformContentImage,
    drawImageInContent,
    fillRect,
    shiftGraphicsBelow,
    mergePages,
    insertBlankPage,
    deletePage,
    duplicatePage,
    movePage,
    // search
    searchPage,
    searchDocument
  }
}
