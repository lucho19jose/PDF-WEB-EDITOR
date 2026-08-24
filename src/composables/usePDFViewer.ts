import { ref, shallowRef } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
// Vite-bundled module worker — avoids the "Setting up fake worker" fallback
// (main-thread parsing) that workerSrc URL strings trigger under Vite dev
import PdfJsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfJsWorker()

export function usePDFViewer() {
  const docStore = useDocumentStore()
  const editorStore = useEditorStore()

  const pdfDoc = shallowRef<pdfjsLib.PDFDocumentProxy | null>(null)
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  async function loadDocument(bytes: Uint8Array, fileName: string) {
    try {
      isLoading.value = true
      error.value = null
      editorStore.setStatus('Loading PDF...')

      // Destroy previous document
      if (pdfDoc.value) {
        await pdfDoc.value.destroy()
        pdfDoc.value = null
      }

      const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() })
      const doc = await loadingTask.promise

      pdfDoc.value = doc
      docStore.setDocument(fileName, doc.numPages, bytes)
      editorStore.setStatus(`Loaded: ${fileName} (${doc.numPages} pages)`)

      return { success: true, totalPages: doc.numPages }
    } catch (err: any) {
      error.value = err.message
      editorStore.setStatus(`Error: ${err.message}`)
      return { success: false, error: err.message }
    } finally {
      isLoading.value = false
    }
  }

  /** Reload PDF.js with new bytes without resetting document state (page, tool, etc.) */
  async function reloadDocument(bytes: Uint8Array) {
    if (pdfDoc.value) {
      await pdfDoc.value.destroy()
      pdfDoc.value = null
    }
    const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() })
    const doc = await loadingTask.promise
    pdfDoc.value = doc
    docStore.reloadBytes(bytes, doc.numPages)
  }

  let renderToken = 0
  let currentRenderTask: any = null

  /**
   * Draw a page into an OFF-SCREEN canvas, then copy it onto the visible one.
   *
   * Painting straight onto the visible canvas means clearing it first — setting
   * `width` is what resizes it, and that wipes it — and from that moment until
   * the render finishes, the page on screen is blank. A render that never
   * finishes leaves it blank for good: cancelled by the next one, or thrown out
   * because the document was reloaded under it. The page then shows white while
   * the thumbnails, which read the bytes independently, show the document
   * perfectly well. That is the "the text disappears on the editing sheet"
   * report in its second form.
   *
   * Off-screen, a failed render costs nothing: the visible canvas still holds
   * the last good picture of the page, which for an unedited page is still
   * correct and for an edited one is at worst one revision stale.
   */
  async function renderPage(canvas: HTMLCanvasElement, pageNum: number) {
    if (!pdfDoc.value) return

    // Supersede any in-flight render so stale pages can't paint over the latest.
    if (currentRenderTask) { try { currentRenderTask.cancel() } catch (_) {} currentRenderTask = null }
    const myToken = ++renderToken

    try {
      const page = await pdfDoc.value.getPage(pageNum)
      if (myToken !== renderToken) return // superseded during getPage
      const viewport = page.getViewport({ scale: docStore.scale })

      // Render at devicePixelRatio so HiDPI displays get sharp text; the
      // canvas is styled at CSS-pixel size so all overlay math is unchanged.
      const dpr = window.devicePixelRatio || 1
      const w = Math.floor(viewport.width * dpr)
      const h = Math.floor(viewport.height * dpr)

      const offscreen = document.createElement('canvas')
      offscreen.width = w
      offscreen.height = h
      const ctx = offscreen.getContext('2d')!
      const task = page.render({
        canvasContext: ctx,
        viewport,
        canvas: offscreen,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
      } as any)
      currentRenderTask = task
      await task.promise
      if (myToken === renderToken) currentRenderTask = null
      if (myToken !== renderToken) return // superseded during render

      // Only now does the visible canvas change at all.
      canvas.width = w
      canvas.height = h
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      canvas.getContext('2d')!.drawImage(offscreen, 0, 0)

      return { viewport, width: viewport.width, height: viewport.height }
    } catch (err: any) {
      if (err?.name === 'RenderingCancelledException') return
      console.error('Error rendering page:', err)
      error.value = err.message
    }
  }

  async function getTextContent(pageNum: number) {
    if (!pdfDoc.value) return null
    const page = await pdfDoc.value.getPage(pageNum)
    return page.getTextContent()
  }

  async function getPageViewport(pageNum: number) {
    if (!pdfDoc.value) return null
    const page = await pdfDoc.value.getPage(pageNum)
    return page.getViewport({ scale: docStore.scale })
  }

  return {
    pdfDoc, isLoading, error,
    loadDocument, reloadDocument, renderPage, getTextContent, getPageViewport
  }
}
