import { useQuasar } from 'quasar'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { useUiStore } from '@/stores/ui'
import { enqueueOp, beginTransaction, settleTransactions } from '@/utils/opQueue'
import { makeZip } from '@/utils/acro/zip'
import { buildDocx, type StPage } from '@/utils/acro/docx'
import { buildXlsx } from '@/utils/acro/xlsx'
import { isScannedPage, scannedNote, sheetsFor } from '@/utils/acro/sheetExport'
import { pageRangeLabel } from '@/utils/acro/pageRange'
import type { SheetPageData, SheetWord } from '@/engine/worker/sheetExtract'
import { useOcrStore } from '@/stores/ocr'
import type { usePDFEngine } from '@/composables/usePDFEngine'
import type { RectT } from '@/engine/types'

/**
 * Every Acrobat-style command the new shell offers, in one place.
 *
 * Each document change goes the way every other edit in this app goes: through
 * the op queue, with an undo snapshot taken only once the engine reports
 * success, the OCR results forgotten when the page STRUCTURE changed (their
 * page indices would lie), and one save→reload of both engines at the end so
 * what the viewer shows is the bytes the worker holds.
 */
export interface AcroCommandDeps {
  pdfEngine: ReturnType<typeof usePDFEngine>
  syncAfterEdit: (opts?: { pageOrder?: number[] }) => Promise<void>
  pushUndo: () => void
  forgetOcr: () => void
  loadBytes: (bytes: Uint8Array, name: string) => Promise<void>
  flushOpenEditor: () => Promise<void>
  bakeOcrEdits: () => Promise<number>
  /** Recognise one scanned page (OCR) into the OCR store; absent where OCR is unavailable. */
  recognisePage?: (pageIndex: number) => Promise<void>
}

export interface ExportOptions {
  dpi?: number
  quality?: number
  pages?: number[]
  /** Excel: one worksheet per page, or the whole document in one. */
  sheetMode?: 'page' | 'single'
  /** Excel: turn amounts, percentages and dates into numbers (default true). */
  convertValues?: boolean
}


type Result = { success: boolean; error?: string; [k: string]: any }

export function useAcroCommands(deps: AcroCommandDeps) {
  const $q = useQuasar()
  const docStore = useDocumentStore()
  const editorStore = useEditorStore()
  const ui = useUiStore()
  const ocrStore = useOcrStore()
  const { pdfEngine } = deps

  function say(msg: string) {
    editorStore.setStatus(msg)
    ui.notify(msg)
  }

  /**
   * One document change: engine call, undo point on success, re-sync.
   * `structure` = the page list changed (count, order, rotation).
   */
  async function change(label: string, fn: () => Promise<Result>, structure = false, pageOrder?: number[]): Promise<Result> {
    if (structure && ui.pageOperationBusy) return { success: false, error: 'Espere a que termine la operación de páginas' }
    if (structure) ui.pageOperationBusy = true
    const documentId = docStore.documentId
    let result: Result = { success: false }
    try {
      await enqueueOp(async () => {
        if (docStore.documentId !== documentId) {
          result = { success: false, error: 'El documento cambió; seleccione las páginas de nuevo' }
          say(`${label}: ${result.error}`)
          return
        }
        result = await fn()
        if (!result?.success) {
          say(`${label}: ${result?.error || pdfEngine.error.value || 'no se pudo completar'}`)
          return
        }
        deps.pushUndo()
        if (structure) deps.forgetOcr()
        await deps.syncAfterEdit(pageOrder ? { pageOrder } : undefined)
      })
    } catch (err: any) {
      result = { success: false, error: err?.message || String(err) }
      say(`${label}: ${result.error}`)
    } finally {
      if (structure) ui.pageOperationBusy = false
    }
    return result
  }

  // ───────────────────────── Downloads ─────────────────────────

  /**
   * Hand a file to the browser. Same three rules the save path learned: the
   * anchor is in the document before the click, the URL outlives the click,
   * and when the click's activation has expired a fresh click is asked for
   * rather than a download claimed that never started.
   */
  function download(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob)
    const fire = () => {
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.rel = 'noopener'
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      setTimeout(() => a.remove(), 0)
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }
    const activation = (navigator as any).userActivation as { isActive: boolean } | undefined
    if (activation && !activation.isActive) {
      $q.notify({
        message: `"${fileName}" está listo.`,
        caption: 'Haga clic para descargarlo.',
        color: 'primary', icon: 'download', timeout: 0, multiLine: true,
        actions: [
          { label: 'Descargar', color: 'white', handler: () => { fire(); say(`Descarga iniciada: ${fileName}`) } },
          { label: 'Cancelar', color: 'white', handler: () => URL.revokeObjectURL(url) }
        ]
      })
      return
    }
    fire()
    say(`Descarga iniciada: ${fileName}`)
  }

  function baseName(): string {
    return (docStore.fileName || 'documento.pdf').replace(/ \*$/, '').replace(/\.pdf$/i, '')
  }

  /** Write the engine's current document out under another name (Extraer, Dividir…). */
  function pdfBlob(bytes: ArrayBuffer): Blob {
    return new Blob([bytes], { type: 'application/pdf' })
  }

  // ───────────────────────── Organize pages ─────────────────────────

  const rotatePages = (indices: number[], degrees: number) =>
    change('Girar', () => pdfEngine.acro('rotatePages', { indices, degrees }), true)
      .then(r => { if (r.success) say(`${indices.length} página(s) girada(s) ${degrees > 0 ? 'a la derecha' : 'a la izquierda'}`); return r })

  async function deletePages(indices: number[]) {
    if (!indices.length) return
    if (indices.length >= docStore.totalPages) { say('No se pueden eliminar todas las páginas del documento'); return }
    const ok = await confirm('Eliminar páginas', `¿Desea eliminar ${indices.length === 1 ? `la página ${indices[0] + 1}` : `${indices.length} páginas`} del documento?`)
    if (!ok) return
    const r = await change('Eliminar', () => pdfEngine.acro('deletePages', { indices }), true)
    if (r.success) { ui.selectedPages = []; say(`${indices.length} página(s) eliminada(s)`) }
  }

  /** Move the pages in `indices` (in their order) so they land before page `before` (0..n). */
  async function movePages(indices: number[], before: number) {
    const n = docStore.totalPages
    const moving = [...new Set(indices)].filter(i => Number.isInteger(i) && i >= 0 && i < n).sort((a, b) => a - b)
    if (!moving.length || !Number.isInteger(before) || before < 0 || before > n) return
    const movingSet = new Set(moving)
    const rest: number[] = []
    for (let i = 0; i < n; i++) if (!movingSet.has(i)) rest.push(i)
    const at = rest.filter(i => i < before).length
    const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)]
    if (order.every((v, i) => v === i)) return
    const r = await change('Mover', () => pdfEngine.acro('rearrange', { order }), true, order)
    if (r.success) {
      ui.selectedPages = moving.map((_, k) => at + k)
      docStore.setPage(at + 1)
      say(`${moving.length} página(s) movida(s)`)
    }
  }

  async function reverseOrder() {
    const order = Array.from({ length: docStore.totalPages }, (_, i) => docStore.totalPages - 1 - i)
    const r = await change('Invertir', () => pdfEngine.acro('rearrange', { order }), true, order)
    if (r.success) say('Orden de las páginas invertido')
  }

  async function duplicatePages(indices: number[]) {
    const list = [...indices].sort((a, b) => b - a)
    const r = await change('Duplicar', async () => {
      for (const i of list) {
        const ok = await pdfEngine.duplicatePage(i)
        if (ok === false) return { success: false, error: pdfEngine.error.value || 'duplicate failed' }
      }
      return { success: true }
    }, true)
    if (r.success) say(`${list.length} página(s) duplicada(s)`)
  }

  async function insertBlank(at: number) {
    const ref = Math.max(0, Math.min(at, docStore.totalPages) - 1)
    const r = await change('Insertar', async () => {
      const size = await pdfEngine.getPageSize(ref).catch(() => ({ width: 612, height: 792 }))
      const ok = await pdfEngine.insertBlankPage(at, size.width, size.height)
      return ok === false ? { success: false, error: pdfEngine.error.value || '' } : { success: true }
    }, true)
    if (r.success) { docStore.setPage(at + 1); say(`Página en blanco insertada en la posición ${at + 1}`) }
  }

  /** Insert another file's pages at `at` (0..n). Images become pages too. */
  async function insertFile(file: File, at: number) {
    const bytes = await pdfBytesOf(file)
    if (!bytes) return
    const r = await change('Insertar', async () => {
      const m = await pdfEngine.mergePages(bytes, at)
      return m === false ? { success: false, error: pdfEngine.error.value || '' } : { success: true, added: m.added }
    }, true)
    if (r.success) { docStore.setPage(at + 1); say(`${file.name}: ${r.added} página(s) insertada(s) en la posición ${at + 1}`) }
  }

  async function replacePages(indices: number[], file: File) {
    const bytes = await pdfBytesOf(file)
    if (!bytes) return
    const r = await change('Reemplazar', () => pdfEngine.acro('replacePages', { indices, bytes }, [bytes]), true)
    if (r.success) say(`${r.replaced} página(s) reemplazada(s) con ${file.name}`)
  }

  async function extractPages(indices: number[], opts: { deleteAfter?: boolean; separate?: boolean } = {}) {
    const list = [...indices].sort((a, b) => a - b)
    if (!list.length) { say('Seleccione las páginas que desea extraer'); return }
    await deps.flushOpenEditor()
    await deps.bakeOcrEdits()
    const name = baseName()
    if (opts.separate && list.length > 1) {
      const entries = []
      for (const i of list) {
        const r = await pdfEngine.acro<Result>('extractPages', { indices: [i] })
        if (!r.success) { say(`Extraer: ${r.error}`); return }
        entries.push({ name: `${name} - página ${i + 1}.pdf`, data: new Uint8Array(r.bytes) })
      }
      download(makeZip(entries), `${name} - páginas.zip`)
    } else {
      const r = await pdfEngine.acro<Result>('extractPages', { indices: list })
      if (!r.success) { say(`Extraer: ${r.error}`); return }
      download(pdfBlob(r.bytes), `${name} - ${pageRangeLabel(list)}.pdf`)
    }
    if (opts.deleteAfter && list.length < docStore.totalPages) {
      const d = await change('Eliminar', () => pdfEngine.acro('deletePages', { indices: list }), true)
      if (d.success) ui.selectedPages = []
    }
  }

  /**
   * The given pages as a PDF of their own, named as Extraer names it: what
   * dragging pages out of the Windows app hands to Explorer. Built when the
   * pointer goes down on a thumbnail, so it is usually ready by the time the
   * drag starts; one entry is kept, keyed by document, revision and pages.
   * Read inside the op queue: a read landing between an edit's save and its
   * reload would extract from a document about to be replaced.
   */
  let pagesFileCache: { key: string; promise: Promise<{ name: string; bytes: ArrayBuffer } | null>; timer?: ReturnType<typeof setTimeout> } | null = null
  function pagesFile(indices: number[]): Promise<{ name: string; bytes: ArrayBuffer } | null> {
    const list = [...new Set(indices)].filter(i => i >= 0 && i < docStore.totalPages).sort((a, b) => a - b)
    if (!list.length) return Promise.resolve(null)
    const key = `${docStore.documentId}|${docStore.renderVersion}|${list.join(',')}`
    if (pagesFileCache?.key === key) return pagesFileCache.promise
    forgetPagesFile()
    const promise = (async () => {
      await deps.bakeOcrEdits()
      const r = await enqueueOp(() => pdfEngine.acro<Result>('extractPages', { indices: list }))
      if (!r?.success || !r.bytes) { editorStore.setStatus(`No se pudieron preparar las páginas: ${r?.error || 'error desconocido'}`); return null }
      let base = baseName().trim() || 'documento'
      // Deep OneDrive folders come close to Windows' 260-character path limit.
      if (base.length > 100) base = base.slice(0, 100).trimEnd()
      return { name: `${base} - ${pageRangeLabel(list)}.pdf`, bytes: r.bytes as ArrayBuffer }
    })().catch(() => null)
    // A selection that is never dragged must not hold its bytes for good.
    pagesFileCache = { key, promise, timer: setTimeout(() => { if (pagesFileCache?.key === key) pagesFileCache = null }, 30_000) }
    return promise
  }
  function forgetPagesFile() {
    if (pagesFileCache?.timer) clearTimeout(pagesFileCache.timer)
    pagesFileCache = null
  }

  async function splitDocument(opts: { every?: number; at?: number[] }) {
    await deps.flushOpenEditor()
    await deps.bakeOcrEdits()
    const r = await pdfEngine.acro<Result>('split', opts)
    if (!r.success) { say(`Dividir: ${r.error}`); return }
    const name = baseName()
    const parts: ArrayBuffer[] = r.parts
    download(makeZip(parts.map((p, k) => ({ name: `${name}_Parte${k + 1}.pdf`, data: new Uint8Array(p) }))), `${name} - dividido.zip`)
    say(`Documento dividido en ${parts.length} archivos`)
  }

  // ───────────────────────── Page design ─────────────────────────

  const cropPages = (indices: number[], margins: { top: number; right: number; bottom: number; left: number }) =>
    change('Recortar', () => pdfEngine.acro('cropPages', { indices, margins }), true)
      .then(r => { if (r.success) say(`${indices.length} página(s) recortada(s)`); return r })

  const headerFooter = (opts: any) =>
    change('Encabezado y pie de página', () => pdfEngine.acro('headerFooter', opts))
      .then(r => { if (r.success) say(`Encabezado y pie de página aplicados a ${r.pages} página(s)`); return r })

  const watermark = (opts: any) =>
    change('Marca de agua', () => pdfEngine.acro('watermark', opts))
      .then(r => { if (r.success) say(`Marca de agua aplicada a ${r.pages} página(s)`); return r })

  const background = (opts: any) =>
    change('Fondo', () => pdfEngine.acro('background', opts))
      .then(r => { if (r.success) say(`Fondo aplicado a ${r.pages} página(s)`); return r })

  async function removeTagged(kind: 'headerFooter' | 'watermark' | 'background') {
    const label = kind === 'headerFooter' ? 'Encabezado y pie de página' : kind === 'watermark' ? 'Marca de agua' : 'Fondo'
    const r = await change(label, async () => {
      const x = await pdfEngine.acro<Result>('removeTagged', { kind })
      return x.removed ? x : { success: false, error: 'el documento no tiene ninguno que se haya agregado aquí' }
    })
    if (r.success) say(`${label}: quitado de ${r.removed} página(s)`)
  }

  const hasTagged = () => pdfEngine.acro<{ headerFooter: boolean; watermark: boolean; background: boolean }>('hasTagged')

  // ───────────────────────── Redact, links, properties ─────────────────────────

  const addRedaction = (pageIndex: number, rect: RectT) =>
    change('Redactar', () => pdfEngine.acro('addRedaction', { pageIndex, rect: [...rect] }))
      .then(r => { if (r.success) say('Área marcada para redacción — use "Aplicar" para eliminar el contenido'); return r })

  async function applyRedactions() {
    const n = await pdfEngine.acro<number>('countRedactions').catch(() => 0)
    if (!n) { say('No hay áreas marcadas para redacción'); return }
    const ok = await confirm('Aplicar redacciones',
      `Se eliminará de forma permanente el contenido de ${n} área(s) marcada(s). Puede deshacerlo con Ctrl+Z mientras no cierre el archivo.`)
    if (!ok) return
    const r = await change('Aplicar redacciones', () => pdfEngine.acro('applyRedactions'), false)
    if (r.success) say(`Redacciones aplicadas en ${r.pages} página(s): el contenido se ha eliminado del archivo`)
  }

  const addLink = (pageIndex: number, rect: RectT, target: { uri?: string; page?: number }) =>
    change('Vínculo', () => pdfEngine.acro('addLink', { pageIndex, rect: [...rect], target }))
      .then(r => { if (r.success) say(target.uri ? `Vínculo a ${target.uri} creado` : `Vínculo a la página ${target.page} creado`); return r })

  const deleteLink = (pageIndex: number, index: number) =>
    change('Vínculo', () => pdfEngine.acro('deleteLink', { pageIndex, index }))
      .then(r => { if (r.success) say('Vínculo eliminado'); return r })

  const listLinks = (pageIndex: number) => pdfEngine.acro<{ rect: number[]; uri: string; external: boolean; page: number | null }[]>('listLinks', { pageIndex })

  const setMetadata = (meta: Record<string, string>) =>
    change('Propiedades', () => pdfEngine.acro('setMetadata', { meta }))
      .then(r => { if (r.success) say('Propiedades del documento actualizadas'); return r })

  const getMetadata = () => pdfEngine.acro<Record<string, string>>('getMetadata')
  const outline = () => pdfEngine.acro<any[]>('outline')

  async function flatten() {
    const ok = await confirm('Acoplar', 'Los comentarios y los campos de formulario pasarán a formar parte de la página y ya no se podrán editar. ¿Continuar?')
    if (!ok) return
    const r = await change('Acoplar', () => pdfEngine.acro('flatten'))
    if (r.success) say('Comentarios y campos acoplados en las páginas')
  }

  // ───────────────────────── Export ─────────────────────────

  /**
   * The recognised runs of a scanned page as words, in the page's own points.
   * They stand in for the page's text: whatever text the page does hold under
   * them (an edit already baked in) is the same words again.
   */
  function withOcrWords(d: SheetPageData): SheetPageData {
    const res = ocrStore.resultFor(d.pageIndex)
    const items = ocrStore.itemsFor(d.pageIndex).filter(i => !i.removed && i.text.trim())
    if (!res || !items.length) return d
    const sx = d.width / (res.pageWidth || d.width), sy = d.height / (res.pageHeight || d.height)
    const runs: SheetWord[] = items.map(i => {
      const x0 = i.rect.x * sx, y0 = i.rect.y * sy, x1 = (i.rect.x + i.rect.width) * sx, y1 = (i.rect.y + i.rect.height) * sy
      const [r, g, b] = (i.color ?? [0, 0, 0]).map(v => Math.max(0, Math.min(255, Math.round(v * 255))))
      return {
        x0, y0, x1, y1, base: y1 - (y1 - y0) * 0.22, size: i.fontSize || (y1 - y0) * 0.8, text: i.text.replace(/s+/g, ' ').trim(),
        bold: !!i.bold, italic: !!i.italic, color: (r << 16) | (g << 8) | b, font: i.fontFamily || '', vertical: i.vertical || undefined, sp: 1
      }
    })
    // A recogniser's point sizes are estimates from the ink and scatter far
    // more than the page did (a 9pt value read as 20pt beside a 5pt label):
    // held to the page's typical size, a title still reads a little larger.
    const sizes = runs.map(r => r.size).sort((a, b) => a - b)
    const typical = sizes[sizes.length >> 1] || 10
    for (const r of runs) r.size = Math.min(typical * 1.5, Math.max(typical * 0.8, r.size))
    const under = (w: SheetWord) => runs.some(r => (w.x0 + w.x1) / 2 >= r.x0 && (w.x0 + w.x1) / 2 <= r.x1 && (w.y0 + w.y1) / 2 >= r.y0 && (w.y0 + w.y1) / 2 <= r.y1)
    return { ...d, words: [...d.words.filter(w => !under(w)), ...runs] }
  }

  /**
   * "Exportar a Microsoft Excel": every chosen page read by the engine (its
   * words and the lines of its tables), rebuilt as rows, columns and merged
   * cells (`sheetLayout.ts`) and written as an .xlsx (`xlsx.ts`).
   *
   * A scanned page holds no text to export, only a picture of it. Pages the
   * user has already recognised use their OCR runs; for the rest the user is
   * offered recognition first — a page left as a picture becomes a sheet that
   * says so, rather than an empty one that looks like a failure.
   */
  async function exportXlsx(name: string, opts: ExportOptions) {
    const pages = opts.pages?.length ? opts.pages : Array.from({ length: docStore.totalPages }, (_, i) => i)
    let data: SheetPageData[] = []
    for (const [k, i] of pages.entries()) {
      say(`Exportando a Excel: analizando la página ${i + 1} (${k + 1} de ${pages.length})…`)
      data.push(await pdfEngine.acro<SheetPageData>('sheetPage', { pageIndex: i }))
    }
    const unread = data.filter(d => isScannedPage(d) && !ocrStore.itemsFor(d.pageIndex).length)
    if (unread.length && deps.recognisePage) {
      const which = unread.length === 1 ? `La página ${unread[0].pageIndex + 1} es una imagen escaneada` : `${unread.length} páginas son imágenes escaneadas`
      const ok = await confirm('Exportar a Excel', `${which}, sin texto que llevar a Excel. ¿Reconocer su texto (OCR) antes de exportar? Tarda unos segundos por página.`)
      if (ok) {
        for (const [k, d] of unread.entries()) {
          say(`Exportando a Excel: reconociendo el texto de la página ${d.pageIndex + 1} (${k + 1} de ${unread.length})…`)
          try { await deps.recognisePage(d.pageIndex) } catch (err: any) { say(`No se pudo reconocer la página ${d.pageIndex + 1}: ${err?.message || err}`) }
        }
      }
    }
    data = data.map(withOcrWords)
    say('Exportando a Excel: armando las tablas…')
    const { sheets, still } = sheetsFor(data, pages, name, opts.sheetMode)
    const note = scannedNote
    const blob = await buildXlsx(sheets, { convertValues: opts.convertValues !== false, title: name })
    download(blob, `${name}.xlsx`)
    if (still.length) say(`Excel listo. ${note(still)}`)
  }

  async function exportAs(format: 'docx' | 'xlsx' | 'txt' | 'html' | 'png' | 'jpeg', opts: ExportOptions = {}) {
    if (!docStore.loaded) return
    await deps.flushOpenEditor()
    await deps.bakeOcrEdits()
    const name = baseName()
    if (format === 'xlsx') {
      // Recognition (offered for scanned pages) does queue work of its own,
      // so this export holds no transaction: it only reads the document.
      try { await exportXlsx(name, opts) } catch (err: any) { say(`No se pudo exportar: ${err?.message || err}`) }
      return
    }
    const end = beginTransaction()
    try {
      if (format === 'docx') {
        say('Exportando a Microsoft Word…')
        const pages = await pdfEngine.acro<StPage[]>('exportStructured')
        download(buildDocx(pages, name), `${name}.docx`)
      } else if (format === 'txt') {
        const text = await pdfEngine.acro<string>('exportText')
        download(new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' }), `${name}.txt`)
      } else if (format === 'html') {
        const html = await pdfEngine.acro<string>('exportHtml')
        const doc = `<!DOCTYPE html>\n<html lang="es"><head><meta charset="utf-8"><title>${name}</title>` +
          `<style>body{background:#525659;margin:0;padding:24px}div[id^=page]{position:relative;background:#fff;margin:0 auto 24px;box-shadow:0 2px 8px rgba(0,0,0,.4)}p{position:absolute;margin:0;white-space:pre}</style></head><body>\n${html}\n</body></html>`
        download(new Blob([doc], { type: 'text/html;charset=utf-8' }), `${name}.html`)
      } else {
        const scale = (opts.dpi ?? 150) / 72
        const pages = opts.pages?.length ? opts.pages : Array.from({ length: docStore.totalPages }, (_, i) => i)
        const ext = format === 'png' ? 'png' : 'jpg'
        const entries = []
        for (const [k, i] of pages.entries()) {
          say(`Exportando página ${i + 1} (${k + 1} de ${pages.length})…`)
          const bytes = await pdfEngine.acro<ArrayBuffer>('renderImage', { pageIndex: i, scale, format, quality: opts.quality ?? 90 })
          entries.push({ name: `${name}_Página_${i + 1}.${ext}`, data: new Uint8Array(bytes) })
        }
        if (entries.length === 1) download(new Blob([entries[0].data as BlobPart], { type: format === 'png' ? 'image/png' : 'image/jpeg' }), entries[0].name)
        else download(makeZip(entries), `${name} - imágenes.zip`)
      }
    } catch (err: any) {
      say(`No se pudo exportar: ${err?.message || err}`)
    } finally {
      end()
    }
  }

  // ───────────────────────── Create & combine ─────────────────────────

  function isImage(file: File) {
    return /^image\/(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(file.type) || /\.(png|jpe?g|gif|bmp|tiff?)$/i.test(file.name)
  }

  /** A file as PDF bytes: a PDF as it is, an image made into a one-page PDF. */
  async function pdfBytesOf(file: File): Promise<ArrayBuffer | null> {
    const raw = await file.arrayBuffer()
    if (!isImage(file)) return raw
    let img = raw
    // MuPDF reads PNG, JPEG, GIF, BMP and TIFF; anything else goes through a canvas first.
    if (/webp/i.test(file.type)) img = await reencodePng(file)
    const r = await pdfEngine.acro<Result>('createPdf', { images: [img] }, [img])
    if (!r.success) { say(`${file.name}: ${r.error}`); return null }
    return r.bytes
  }

  async function reencodePng(file: File): Promise<ArrayBuffer> {
    const bmp = await createImageBitmap(file)
    const c = document.createElement('canvas')
    c.width = bmp.width; c.height = bmp.height
    c.getContext('2d')!.drawImage(bmp, 0, 0)
    const blob: Blob = await new Promise(res => c.toBlob(b => res(b!), 'image/png'))
    return blob.arrayBuffer()
  }

  /** "Crear archivo PDF": from images (one page each), or a blank page. */
  async function createPdf(files: File[], blank?: { width: number; height: number }) {
    const images: ArrayBuffer[] = []
    for (const f of files) images.push(/webp/i.test(f.type) ? await reencodePng(f) : await f.arrayBuffer())
    const r = await pdfEngine.acro<Result>('createPdf', { images, blank }, images)
    if (!r.success) { say(`Crear PDF: ${r.error}`); return }
    const name = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') + '.pdf' : files.length ? 'Imágenes combinadas.pdf' : 'Sin título.pdf'
    await deps.loadBytes(new Uint8Array(r.bytes), name)
    ui.view = 'document'
    say(`${name} creado — ${r.pages} página(s). Guárdelo con Ctrl+S`)
  }

  /** "Combinar archivos": a new document, the files' pages in the order given. */
  let combineInFlight = false
  /** `openAt`: where the open document goes among `files` (0 = first). */
  async function combine(files: File[], includeOpen = false, openAt = 0): Promise<Result> {
    if (combineInFlight) return { success: false, error: 'Ya hay una combinacion en curso' }
    if (!files.length && !includeOpen) return { success: false, error: 'Agregue archivos para combinar' }
    combineInFlight = true
    try {
      if (includeOpen) { await deps.flushOpenEditor(); await deps.bakeOcrEdits() }
      await settleTransactions()
      return await enqueueOp(async () => {
        const inputs: ArrayBuffer[] = [], names: string[] = []
        for (const file of files) {
          say(`Preparando ${file.name}...`)
          const bytes = await pdfBytesOf(file)
          if (!bytes) return { success: false, error: `No se pudo leer ${file.name}` }
          inputs.push(bytes); names.push(file.name)
        }
        if (includeOpen && docStore.loaded) {
          const at = Math.max(0, Math.min(openAt, inputs.length))
          inputs.splice(at, 0, await pdfEngine.saveDocument()); names.splice(at, 0, docStore.fileName || 'documento.pdf')
        }
        say(`Combinando ${inputs.length} archivos...`)
        const r = await pdfEngine.acro<Result>('combinePdf', { files: inputs }, inputs)
        if (!r.success) return { ...r, error: `${names[r.fileIndex] || 'Archivo'}: ${r.error}` }
        // One load and one save for the whole batch, regardless of file count.
        await deps.loadBytes(new Uint8Array(r.bytes), 'Combinados.pdf')
        docStore.markModified(); ui.view = 'document'
        say(`${names.length} archivos combinados - ${r.pages} paginas. Guarde con Ctrl+S`)
        return r
      })
    } catch (err: any) { return { success: false, error: err?.message || String(err) } }
    finally { combineInFlight = false }
  }

  // ───────────────────────── helpers ─────────────────────────

  function confirm(title: string, message: string): Promise<boolean> {
    return new Promise(resolve => {
      $q.dialog({ title, message, cancel: { label: 'Cancelar', flat: true }, ok: { label: 'Aceptar', unelevated: true }, persistent: true, class: 'acro-dialog' })
        .onOk(() => resolve(true)).onCancel(() => resolve(false)).onDismiss(() => resolve(false))
    })
  }

  return {
    say, change, download, confirm, pdfBytesOf, isImage,
    rotatePages, deletePages, movePages, reverseOrder, duplicatePages, insertBlank, insertFile,
    replacePages, extractPages, splitDocument, pagesFile, forgetPagesFile,
    cropPages, headerFooter, watermark, background, removeTagged, hasTagged,
    addRedaction, applyRedactions, addLink, deleteLink, listLinks,
    setMetadata, getMetadata, outline, flatten,
    exportAs, createPdf, combine
  }
}

export type AcroCommands = ReturnType<typeof useAcroCommands>

export { pageRangeLabel, parsePageRange } from '@/utils/acro/pageRange'
