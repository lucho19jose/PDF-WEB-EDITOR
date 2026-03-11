import { ref, readonly } from 'vue'
import { getMuPDFBridge } from '@/engine/bridge'
import type { PageTextData, TextBlock } from '@/engine/types'

/**
 * Composable for interacting with the MuPDF editing engine.
 *
 * Wraps the MuPDF bridge with reactive state for Vue components.
 */
export function usePDFEngine() {
  const bridge = getMuPDFBridge()
  const isReady = ref(false)
  const isLoading = ref(false)
  const error = ref<string | null>(null)
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
  ): Promise<boolean> {
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
      return result.success
    } catch (err: any) {
      error.value = `Failed to replace text: ${err.message}`
      throw err
    }
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
  }

  return {
    // State
    isReady: readonly(isReady),
    isLoading: readonly(isLoading),
    error: readonly(error),

    // Methods
    initEngine,
    loadDocument,
    getPageText,
    getTextBlocks,
    readContentStream,
    replaceText,
    saveDocument,
    destroyEngine
  }
}
