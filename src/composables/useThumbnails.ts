import { ref, watch } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
import { pdfjsDocumentOptions, createPdfjsWorker } from '@/composables/usePDFViewer'
import { useDocumentStore } from '@/stores/document'

/**
 * Page thumbnails shared by the Organize grid and the page pane. Content
 * edits invalidate pixels; pure reorders only remap indices into a snapshot.
 *
 * pdf.js on its own document, not the viewer's: thumbnails must not cancel,
 * or be cancelled by, the pages the viewer is painting, and they must not go
 * through the engine's op queue either — a grid of forty pages would hold up
 * every edit behind forty rasterisations. Renders run one at a time, nearest
 * first as they are asked for, and each result is kept as an object URL until
 * the document changes.
 */
let singleton: ReturnType<typeof create> | null = null
if (import.meta.hot) import.meta.hot.dispose(() => { singleton?.dispose(); singleton = null })

export function useThumbnails() {
  if (!singleton) singleton = create()
  return singleton
}

function create() {
  const docStore = useDocumentStore()
  /** Bumped whenever cached thumbnails stop describing the document. */
  const version = ref(0)
  let generation = 0
  let sourcePages = Array.from({ length: docStore.totalPages }, (_, i) => i + 1)
  let snapshotBytes = docStore.pdfBytes
  let pdfWorker: ReturnType<typeof createPdfjsWorker> | null = null
  const stats = { renders: 0, documentLoads: 0, get pendingRequests() { return pending.size } }
  const urls = new Map<string, string>()
  let doc: pdfjsLib.PDFDocumentProxy | null = null
  let docVersion = -1
  let loading: Promise<pdfjsLib.PDFDocumentProxy | null> | null = null
  let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null
  let renderTask: pdfjsLib.RenderTask | null = null
  const pending = new Map<string, Promise<string | null>>()
  let abandon!: () => void
  let abandoned = new Promise<null>(resolve => { abandon = () => resolve(null) })
  const queue: { key: string; page: number; width: number; resolve: (u: string | null) => void }[] = []
  let busy = false

  function key(sourcePage: number, width: number) { return `${generation}:${sourcePage}:${width}` }

  async function ensureDoc(): Promise<pdfjsLib.PDFDocumentProxy | null> {
    if (doc && docVersion === generation) return doc
    if (loading) return loading
    const v = generation
    const work = (async () => {
      if (!snapshotBytes) return null
      pdfWorker ??= createPdfjsWorker()
      stats.documentLoads++
      const task = pdfjsLib.getDocument(pdfjsDocumentOptions(snapshotBytes.slice(), pdfWorker.worker))
      loadingTask = task
      const d = await task.promise
      if (v !== generation) { await d.destroy().catch(() => {}); return null }
      doc = d
      docVersion = v
      return d
    })().finally(() => { if (loading === work) loading = null })
    loading = work
    return loading
  }

  async function pump() {
    if (busy) return
    busy = true
    try {
      while (queue.length) {
        const job = queue.shift()!
        if (urls.has(job.key)) { job.resolve(urls.get(job.key)!); continue }
        if (!job.key.startsWith(`${generation}:`)) { job.resolve(null); continue }
        try {
          const cancelled = abandoned
          const d = await Promise.race([ensureDoc(), cancelled])
          if (!d || job.page > d.numPages) { job.resolve(null); continue }
          const page = await Promise.race([d.getPage(job.page), cancelled])
          if (!page || !job.key.startsWith(`${generation}:`)) { job.resolve(null); continue }
          const base = page.getViewport({ scale: 1 })
          const vp = page.getViewport({ scale: (job.width * Math.min(2, window.devicePixelRatio || 1)) / base.width })
          const canvas = document.createElement('canvas')
          canvas.width = Math.ceil(vp.width)
          canvas.height = Math.ceil(vp.height)
          const ctx = canvas.getContext('2d')!
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          const task = page.render({ canvasContext: ctx, viewport: vp, canvas } as any)
          stats.renders++
          renderTask = task
          await Promise.race([task.promise, cancelled])
          if (renderTask === task) renderTask = null
          if (!job.key.startsWith(`${generation}:`)) { job.resolve(null); continue }
          const blob = await Promise.race([new Promise<Blob | null>(res => canvas.toBlob(b => res(b), 'image/png')), cancelled])
          canvas.width = canvas.height = 0
          if (!blob || !job.key.startsWith(`${generation}:`)) { job.resolve(null); continue }
          const url = URL.createObjectURL(blob)
          // The URL holds the pixels now; release decoded page images rather
          // than retain full-resolution scans for every thumbnail visited.
          page.cleanup()
          urls.set(job.key, url)
          job.resolve(url)
        } catch (err) {
          if (job.key.startsWith(`${generation}:`)) console.warn('[Thumbnails] render failed', err)
          job.resolve(null)
        }
      }
    } finally {
      busy = false
    }
  }

  /** The thumbnail of `page` (1-based) at `width` CSS pixels, drawing it if needed. */
  function request(page: number, width: number, urgent = false): Promise<string | null> {
    const sourcePage = sourcePages[page - 1]
    if (!sourcePage || !Number.isFinite(width) || width <= 0) return Promise.resolve(null)
    const k = key(sourcePage, width)
    const have = urls.get(k)
    if (have) return Promise.resolve(have)
    const existing = pending.get(k)
    if (existing) return existing
    const promise = new Promise<string | null>(resolve => {
      const job = { key: k, page: sourcePage, width, resolve }
      if (urgent) queue.unshift(job); else queue.push(job)
      pump()
    }).finally(() => { if (pending.get(k) === promise) pending.delete(k) })
    pending.set(k, promise)
    return promise
  }

  /** What is cached for a page right now, without drawing anything. */
  function cached(page: number, width: number): string | null {
    return urls.get(key(sourcePages[page - 1], width)) ?? null
  }

  function invalidate() {
    generation++
    sourcePages = Array.from({ length: docStore.totalPages }, (_, i) => i + 1)
    snapshotBytes = docStore.pdfBytes
    version.value++
    abandon()
    abandoned = new Promise<null>(resolve => { abandon = () => resolve(null) })
    renderTask?.cancel()
    renderTask = null
    const oldTask = loadingTask
    const oldDoc = doc
    loadingTask = null
    loading = null
    doc = null
    docVersion = -1
    if (oldTask) void oldTask.destroy().catch(() => {})
    else if (oldDoc) void oldDoc.destroy().catch(() => {})
    for (const u of urls.values()) URL.revokeObjectURL(u)
    urls.clear()
    for (const job of queue.splice(0)) job.resolve(null)
    pending.clear()
  }

  const stopRevision = watch(() => docStore.renderVersion, () => {
    const order = docStore.pageOrder
    if (order && order.length === sourcePages.length && new Set(order).size === order.length
        && order.every(i => Number.isInteger(i) && i >= 0 && i < sourcePages.length)) {
      // A reorder changes indices, not pixels. Keep the snapshot, in-flight
      // renders and URLs; translate each logical page back into that snapshot.
      sourcePages = order.map(i => sourcePages[i])
      version.value++
    } else invalidate()
  }, { flush: 'sync' })
  const stopLoaded = watch(() => docStore.loaded, (l) => { if (!l) invalidate() })

  function dispose() {
    stopRevision()
    stopLoaded()
    invalidate()
    snapshotBytes = null
    pdfWorker?.destroy()
    pdfWorker = null
  }

  return { version, request, cached, invalidate, dispose, stats }
}
