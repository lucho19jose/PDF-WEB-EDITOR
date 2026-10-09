import { ref, watch } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
import { pdfjsDocumentOptions } from '@/composables/usePDFViewer'
import { useDocumentStore } from '@/stores/document'

/**
 * Page thumbnails for the Organize grid and the page pane, drawn ONCE per
 * document revision and shared by both.
 *
 * pdf.js on its own document, not the viewer's: thumbnails must not cancel,
 * or be cancelled by, the pages the viewer is painting, and they must not go
 * through the engine's op queue either — a grid of forty pages would hold up
 * every edit behind forty rasterisations. Renders run one at a time, nearest
 * first as they are asked for, and each result is kept as an object URL until
 * the document changes.
 */
let singleton: ReturnType<typeof create> | null = null

export function useThumbnails() {
  if (!singleton) singleton = create()
  return singleton
}

function create() {
  const docStore = useDocumentStore()
  /** Bumped whenever cached thumbnails stop describing the document. */
  const version = ref(0)
  const urls = ref(new Map<string, string>())
  let doc: pdfjsLib.PDFDocumentProxy | null = null
  let docVersion = -1
  let loading: Promise<pdfjsLib.PDFDocumentProxy | null> | null = null
  const queue: { key: string; page: number; width: number; resolve: (u: string | null) => void }[] = []
  let busy = false

  function key(page: number, width: number) { return `${version.value}:${page}:${width}` }

  async function ensureDoc(): Promise<pdfjsLib.PDFDocumentProxy | null> {
    if (doc && docVersion === version.value) return doc
    if (loading) return loading
    loading = (async () => {
      if (doc) { await doc.destroy().catch(() => {}); doc = null }
      if (!docStore.pdfBytes) return null
      const v = version.value
      const d = await pdfjsLib.getDocument(pdfjsDocumentOptions(docStore.pdfBytes.slice())).promise
      if (v !== version.value) { await d.destroy().catch(() => {}); return null }
      doc = d
      docVersion = v
      return d
    })().finally(() => { loading = null })
    return loading
  }

  async function pump() {
    if (busy) return
    busy = true
    try {
      while (queue.length) {
        const job = queue.shift()!
        if (urls.value.has(job.key)) { job.resolve(urls.value.get(job.key)!); continue }
        if (!job.key.startsWith(`${version.value}:`)) { job.resolve(null); continue }
        try {
          const d = await ensureDoc()
          if (!d || job.page > d.numPages) { job.resolve(null); continue }
          const page = await d.getPage(job.page)
          const base = page.getViewport({ scale: 1 })
          const vp = page.getViewport({ scale: (job.width * (window.devicePixelRatio || 1)) / base.width })
          const canvas = document.createElement('canvas')
          canvas.width = Math.ceil(vp.width)
          canvas.height = Math.ceil(vp.height)
          const ctx = canvas.getContext('2d')!
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          await page.render({ canvasContext: ctx, viewport: vp, canvas } as any).promise
          const blob: Blob | null = await new Promise(res => canvas.toBlob(b => res(b), 'image/png'))
          if (!blob || !job.key.startsWith(`${version.value}:`)) { job.resolve(null); continue }
          const url = URL.createObjectURL(blob)
          const next = new Map(urls.value)
          next.set(job.key, url)
          urls.value = next
          job.resolve(url)
        } catch (err) {
          console.warn('[Thumbnails] render failed', err)
          job.resolve(null)
        }
      }
    } finally {
      busy = false
    }
  }

  /** The thumbnail of `page` (1-based) at `width` CSS pixels, drawing it if needed. */
  function request(page: number, width: number, urgent = false): Promise<string | null> {
    const k = key(page, width)
    const have = urls.value.get(k)
    if (have) return Promise.resolve(have)
    return new Promise(resolve => {
      const job = { key: k, page, width, resolve }
      if (urgent) queue.unshift(job); else queue.push(job)
      pump()
    })
  }

  /** What is cached for a page right now, without drawing anything. */
  function cached(page: number, width: number): string | null {
    return urls.value.get(key(page, width)) ?? null
  }

  function invalidate() {
    version.value++
    for (const u of urls.value.values()) URL.revokeObjectURL(u)
    urls.value = new Map()
    queue.length = 0
  }

  watch(() => docStore.renderVersion, invalidate)
  watch(() => docStore.loaded, (l) => { if (!l) invalidate() })

  return { version, request, cached, invalidate }
}
