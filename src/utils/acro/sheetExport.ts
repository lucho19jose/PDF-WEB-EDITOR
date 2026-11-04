/**
 * The pure half of "Exportar a Microsoft Excel": which pages are scans, the
 * note a scanned page's sheet carries, and the worksheets built from the
 * engine's `sheetPage` data. Shared by the Acrobat commands and the MCP server.
 */
import type { SheetPageData } from '@/engine/worker/sheetExtract'
import { layoutPage, buildSheet } from './sheetLayout'

/** A page that is a picture with (almost) no text on it: a scan. */
export function isScannedPage(d: SheetPageData): boolean {
  if (d.imageCover < 0.4) return false
  const textArea = d.words.reduce((a, w) => a + (w.x1 - w.x0) * (w.y1 - w.y0), 0)
  return textArea < d.width * d.height * 0.015
}

/** What a sheet says about pages left as pictures (1-based numbers). */
export function scannedNote(pages: number[]): string | undefined {
  return pages.length
    ? `${pages.length === 1 ? 'La página' : 'Las páginas'} ${pages.join(', ')} ${pages.length === 1 ? 'es una imagen escaneada' : 'son imágenes escaneadas'} sin texto: use «Reconocer texto» (OCR) para exportar su contenido.`
    : undefined
}

/**
 * Worksheets for the pages' sheet data: one per page, or the whole document
 * in one. `pages` are the 0-based indices the data was read from. Returns the
 * 1-based numbers of the pages still without text, for the caller's message.
 */
export function sheetsFor(data: SheetPageData[], pages: number[], name: string, mode: 'page' | 'single' = 'page') {
  const layouts = data.map(d => layoutPage(d))
  const still = data.filter(d => isScannedPage(d)).map(d => d.pageIndex + 1)
  const sheets = mode === 'single'
    ? [Object.assign(buildSheet(layouts, { name }), { note: scannedNote(still) })]
    : layouts.map((L, k) => Object.assign(buildSheet([L], { name: `Página ${pages[k] + 1}` }), { note: scannedNote(still.filter(p => p === pages[k] + 1)) }))
  return { sheets, still }
}
