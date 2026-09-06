import { ref, shallowRef } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
// Vite-bundled module worker — avoids the "Setting up fake worker" fallback
// (main-thread parsing) that workerSrc URL strings trigger under Vite dev
import PdfJsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfJsWorker()

/**
 * Everything pdf.js needs that is not in its bundle, served from `public/pdfjs`
 * (copied from `node_modules/pdfjs-dist`).
 *
 * pdf.js 5 decodes JBIG2 and JPX images and ICC colour spaces through
 * WebAssembly modules it fetches from `wasmUrl`. With no URL set the fetch
 * 404s and the page's render NEVER SETTLES: any page holding such an image
 * stayed unpainted, and the render queue behind it with it. This editor's own
 * OCR bake writes one — the tail of a partially redrawn line is transplanted
 * as a PNG, which MuPDF stores under an ICC-based colour space — so every
 * scanned page edited that way came back un-renderable in the viewer (page 3
 * of the user's contract: 8 ms in MuPDF, a 30-second timeout in pdf.js).
 * Scans encoded as JBIG2 or JPEG 2000 were in the same state from the start.
 * `cMapUrl` and `standardFontDataUrl` are the same class: CJK text in a
 * non-embedded font and the base-14 faces this editor substitutes.
 */
export function pdfjsDocumentOptions(data: Uint8Array): Parameters<typeof pdfjsLib.getDocument>[0] {
  const base = `${import.meta.env.BASE_URL || '/'}pdfjs/`.replace(/\/\/+/g, '/')
  return {
    data,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`
  } as any
}

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

      // Destroy previous document — the reference dropped first, and any
      // render still on it let go (see reloadDocument).
      const old = pdfDoc.value
      pdfDoc.value = null
      abandonRenders()
      let doc: pdfjsLib.PDFDocumentProxy
      try {
        if (old) await old.destroy()
        const loadingTask = pdfjsLib.getDocument(pdfjsDocumentOptions(bytes.slice()))
        doc = await loadingTask.promise
        pdfDoc.value = doc
      } finally {
        documentReady()
      }
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
    // The reference is dropped BEFORE the (asynchronous) destroy: a render the
    // queue starts during the destroy would otherwise call `getPage` on a
    // document that is going away, and that call never settles — its wake-up
    // had already fired, so nothing could abandon it.
    const old = pdfDoc.value
    pdfDoc.value = null
    abandonRenders()
    try {
      if (old) await old.destroy()
      const loadingTask = pdfjsLib.getDocument(pdfjsDocumentOptions(bytes.slice()))
      const doc = await loadingTask.promise
      pdfDoc.value = doc
    } finally {
      documentReady()
    }
    docStore.reloadBytes(bytes, pdfDoc.value!.numPages)
  }

  let renderToken = 0
  let currentRenderTask: any = null

  /**
   * Which document a render belongs to, and a way to let go of the one it
   * started on.
   *
   * Every edit saves and RELOADS the document, and the reload destroys the
   * pdf.js document a background render may be in the middle of — the render
   * queue paints the neighbouring pages while the user types. A `getPage` or
   * `render` promise on a destroyed document never settles, so `renderPage`
   * never returned, the queue's `renderBusy` stayed true for good, and the
   * edited page sat behind it unpainted: the engine had the new text, the
   * status bar said "Text replaced", and the canvas showed the old line until
   * something else happened to render it. Measured: after one edit the queue
   * logged "render start 2" and never "render end 2".
   *
   * Reloading bumps the generation and wakes every waiter, and a render races
   * each of its awaits against that wake-up, so it returns nothing — the queue
   * re-queues the page and moves on — instead of hanging.
   */
  let docGeneration = 0
  const reloadWaiters = new Set<() => void>()
  /** Resolves when the document being loaded is in place — a render arriving mid-reload waits for it rather than burning a retry. */
  let nextDoc: { promise: Promise<void>; resolve: () => void } | null = null
  function abandonRenders() {
    docGeneration++
    for (const wake of reloadWaiters) wake()
    reloadWaiters.clear()
    if (!nextDoc) {
      let resolve!: () => void
      const promise = new Promise<void>(r => { resolve = r })
      nextDoc = { promise, resolve }
    }
  }
  function documentReady() {
    nextDoc?.resolve()
    nextDoc = null
  }
  function untilReload(): { promise: Promise<undefined>; done: () => void } {
    let wake!: () => void
    const promise = new Promise<undefined>(resolve => { wake = () => resolve(undefined); reloadWaiters.add(wake) })
    return { promise, done: () => reloadWaiters.delete(wake) }
  }

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
    // Mid-reload: wait for the document being loaded rather than fail — the
    // queue allows a page three failures, and a reload's few tens of
    // milliseconds used to burn all three on the pages behind the edited one.
    if (!pdfDoc.value && nextDoc) await nextDoc.promise
    if (!pdfDoc.value) return

    // Supersede any in-flight render so stale pages can't paint over the latest.
    if (currentRenderTask) { try { currentRenderTask.cancel() } catch (_) {} currentRenderTask = null }
    const myToken = ++renderToken
    const myGen = docGeneration
    const reload = untilReload()

    try {
      const page = await Promise.race([pdfDoc.value.getPage(pageNum), reload.promise])
      if (!page || myGen !== docGeneration) return // the document was reloaded under this render
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
      const outcome = await Promise.race([task.promise.then(() => true), reload.promise])
      if (myToken === renderToken) currentRenderTask = null
      if (!outcome || myGen !== docGeneration) { try { task.cancel() } catch (_) {} return }
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
    } finally {
      reload.done()
    }
  }

  /**
   * Render one page to a canvas of its own at an explicit scale.
   *
   * For OCR, which wants ~220 DPI whatever the zoom is, and which used to read
   * `document.querySelector('canvas.pdf-canvas')` — the FIRST canvas on the
   * page, i.e. page 1's in continuous scroll, whatever page was current. This
   * render has its own task and never touches `renderToken`, so it neither
   * cancels nor is cancelled by the visible pages' rendering.
   */
  async function renderPageToCanvas(pageNum: number, scale: number): Promise<HTMLCanvasElement | null> {
    if (!pdfDoc.value) return null
    const page = await pdfDoc.value.getPage(pageNum)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    await page.render({ canvasContext: ctx, viewport, canvas } as any).promise
    return canvas
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
    loadDocument, reloadDocument, renderPage, renderPageToCanvas, getTextContent, getPageViewport
  }
}
