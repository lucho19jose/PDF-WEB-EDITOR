// Pages dragged OUT of the Windows app become a real PDF where they are
// dropped — a folder in Explorer, the desktop, a mail — as in PDF24.
//
// Windows' file drag (Electron's startDrag) cannot run beside the page's own
// HTML5 drag, so in the app every drag of a page thumbnail IS the file drag.
// Dropped back on a page list it is recognised as ours and reorders the pages,
// exactly what the HTML5 drag did; dropped anywhere else in this window it is
// ignored, or the tab bar would open the file as a new tab. The web app has no
// such drag (a browser cannot hand Explorer a file it makes on the fly) and
// keeps the HTML5 drag.
//
// The drop event and the end of the drag reach the page on different channels,
// so either may come first: the drag's record is kept until a drop uses it, or
// for a moment after the drag ends, and a drop is ours only when the single
// file dropped carries our file name.

import { desktopApi } from '@/tabs/frameClient'
import { useEditorStore } from '@/stores/editor'

export interface OwnDrag {
  pages: number[]
  documentId: number
  revision: number
  name: string
  endedAt: number | null
}

let own: OwnDrag | null = null
const KEEP_AFTER_END_MS = 2000
const PREPARE_TIMEOUT_MS = 15000

/** The Windows app can drag pages out as a file. */
export function canDragOut(): boolean {
  return typeof desktopApi()?.dragOut === 'function'
}

/** This frame's page drag, while it runs and for a moment after it ends. */
export function ownDrag(): OwnDrag | null {
  if (own && own.endedAt !== null && Date.now() - own.endedAt > KEEP_AFTER_END_MS) own = null
  return own
}

/** A drop of the file our own page drag carries (not a file from Explorer). */
export function isOwnFileDrop(e: DragEvent): boolean {
  const o = ownDrag()
  if (!o) return false
  const files = e.dataTransfer?.files
  return !!files && files.length === 1 && files[0].name === o.name
}

/** The drag's record, used up by the drop that handles it. */
export function takeOwnDrop(): OwnDrag | null {
  const o = ownDrag()
  own = null
  return o
}

/**
 * A file name Windows accepts — the same rule the main process applies, so
 * the name a drop reports is the one recorded here.
 */
export function dragFileName(name: string): string {
  let base = (name.split(/[\\/]/).pop() || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim()
  if (!base) base = 'documento.pdf'
  if (!/\.pdf$/i.test(base)) base += '.pdf'
  if (base.length > 150) base = base.slice(0, 146).trimEnd() + '.pdf'
  return base
}

let cursorStyle: HTMLStyleElement | null = null
function busyCursor(on: boolean) {
  if (on && !cursorStyle) {
    cursorStyle = document.createElement('style')
    cursorStyle.textContent = 'html.page-drag-preparing, html.page-drag-preparing * { cursor: progress !important; }'
    document.head.appendChild(cursorStyle)
  }
  document.documentElement.classList.toggle('page-drag-preparing', on)
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(null) })
  })
}

/**
 * Drag the pages out as a file. Called from a thumbnail's `dragstart` after
 * `preventDefault()`: waits for the file (usually built already, from the
 * pointer going down), then hands it to Windows. Resolves when the drag ends.
 * A button released before the file was ready abandons the drag — a late
 * start would drop the file wherever the pointer happens to be.
 */
export async function dragPagesOut(opts: {
  pages: number[]
  documentId: number
  revision: number
  /** The dragged pages' thumbnails as drawn, for the drag image. */
  images: (HTMLImageElement | null | undefined)[]
  getFile: () => Promise<{ name: string; bytes: ArrayBuffer } | null>
  onEnd?: () => void
}): Promise<void> {
  const api = desktopApi()
  const editorStore = useEditorStore()
  let released = false
  const onUp = () => { released = true }
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('mouseup', onUp, true)
  const cursorTimer = setTimeout(() => busyCursor(true), 150)
  const statusTimer = setTimeout(() => editorStore.setStatus('Preparando páginas…'), 400)
  const started = Date.now()
  try {
    if (!api?.dragOut) return
    const file = await withTimeout(opts.getFile(), PREPARE_TIMEOUT_MS)
    clearTimeout(cursorTimer)
    clearTimeout(statusTimer)
    busyCursor(false)
    if (!file) return
    if (released) {
      if (Date.now() - started > 250) editorStore.setStatus('Las páginas aún se estaban preparando: vuelva a arrastrarlas')
      return
    }
    const icon = await dragIcon(opts.images, opts.pages.length).catch(() => null)
    if (released) return
    const name = dragFileName(file.name)
    own = { pages: [...opts.pages], documentId: opts.documentId, revision: opts.revision, name, endedAt: null }
    if (Date.now() - started > 400) editorStore.setStatus('')
    try {
      await api.dragOut({ name, bytes: new Uint8Array(file.bytes), icon: icon?.png, scale: icon?.scale })
    } catch (err: any) {
      editorStore.setStatus(`No se pudieron arrastrar las páginas: ${err?.message || err}`)
    } finally {
      if (own) own.endedAt = Date.now()
    }
  } finally {
    clearTimeout(cursorTimer)
    clearTimeout(statusTimer)
    busyCursor(false)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('mouseup', onUp, true)
    opts.onEnd?.()
  }
}

/**
 * The drag image: the first page's thumbnail, 72 px wide, with a second sheet
 * behind it and a count when several pages go. Windows writes the file's name
 * under it. Drawn at the screen's pixel ratio so it is not blurred.
 */
async function dragIcon(images: (HTMLImageElement | null | undefined)[], count: number): Promise<{ png: Uint8Array; scale: number } | null> {
  const img = images.find((i): i is HTMLImageElement => !!i && i.complete && i.naturalWidth > 0) ?? null
  const scale = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
  const W = 72
  const ratio = img ? img.naturalHeight / img.naturalWidth : 1.294
  const H = Math.round(W * Math.min(Math.max(ratio, 0.4), 2.2))
  const many = count > 1
  const pad = 2, back = many ? 6 : 0, badgeR = 11
  const top = many ? badgeR : pad, right = many ? badgeR : pad
  const cw = pad + W + back + right, ch = top + H + back + pad
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(cw * scale)
  canvas.height = Math.round(ch * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(scale, scale)
  const sheet = (x: number, y: number) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x, y, W, H)
    ctx.strokeStyle = '#8a8a8a'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, W - 1, H - 1)
  }
  if (many) sheet(pad + back, top + back)
  sheet(pad, top)
  if (img) {
    try { ctx.drawImage(img, pad + 1, top + 1, W - 2, H - 2) } catch { /* an image the canvas refuses: the blank sheet stands */ }
  }
  if (many) {
    const label = count > 99 ? '99+' : String(count)
    ctx.fillStyle = '#1473e6'
    ctx.beginPath()
    ctx.arc(pad + W, top, badgeR, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${label.length > 2 ? 9 : 12}px "Segoe UI", Arial, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, pad + W, top + 0.5)
  }
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) return null
  return { png: new Uint8Array(await blob.arrayBuffer()), scale }
}
