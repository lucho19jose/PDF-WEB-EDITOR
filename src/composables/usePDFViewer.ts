import { ref, shallowRef } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

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

  async function renderPage(canvas: HTMLCanvasElement, pageNum: number) {
    if (!pdfDoc.value) return

    try {
      const page = await pdfDoc.value.getPage(pageNum)
      const viewport = page.getViewport({ scale: docStore.scale })

      canvas.width = viewport.width
      canvas.height = viewport.height

      const ctx = canvas.getContext('2d')!
      await page.render({ canvasContext: ctx, viewport, canvas } as any).promise

      docStore.setPage(pageNum)
      return { viewport, width: viewport.width, height: viewport.height }
    } catch (err: any) {
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
