/**
 * Is a page a text page or a scan? Pure functions over plain data (text
 * blocks, page size, image rects), shared by the editor and the MCP server.
 *
 * The editor's rules, in one place:
 * - `judgeScanned`: a page whose text layer is empty, or whose text covers
 *   under 2% of the paper (a signing service's ID strip over a photograph),
 *   is a page the content-stream editor cannot touch.
 * - `textLayerOf`: invisible text (a searchable OCR layer, `3 Tr`) is not
 *   the page's own text; coverage is a UNION over a 64×64 grid, so a stamp
 *   drawn 34 times over itself counts once.
 * - `pageKind`: invisible text outweighing the visible makes a scan even when
 *   a few visible stamps give the page "enough" characters (contrato111 p3:
 *   ~2000 invisible against ~120 visible), and a judged-scanned page is a
 *   scan only when images cover half the paper (a blank page is not a scan).
 */
import type { ScannedVerdict } from '@/utils/ocr/ocrTypes'

export const SCANNED_TEXT_THRESHOLD = 12
export const SCANNED_TEXT_COVERAGE = 0.02

interface BlockLike { text: string; bbox: number[]; invisible?: boolean }
type Size = { width: number; height: number }

export function judgeScanned(extractedChars: number, textCoverage?: number): ScannedVerdict {
  if (extractedChars > SCANNED_TEXT_THRESHOLD && textCoverage !== undefined && textCoverage < SCANNED_TEXT_COVERAGE) {
    return {
      scanned: true,
      extractedChars,
      reason: `the page's ${extractedChars} characters of text cover only ${(textCoverage * 100).toFixed(1)}% of the paper — a stamp or footer over an image`
    }
  }
  if (extractedChars > SCANNED_TEXT_THRESHOLD) {
    return {
      scanned: false,
      extractedChars,
      reason: `the page already has ${extractedChars} characters of real text — edit it directly`
    }
  }
  return {
    scanned: true,
    extractedChars,
    reason: extractedChars === 0
      ? 'the page has no text at all, only an image'
      : `the page has only ${extractedChars} characters of text, too few to be a text page`
  }
}

/** Visible characters and the share of the paper their blocks cover. */
export function textLayerOf(blocks: BlockLike[], size: Size): { chars: number; coverage: number } {
  const visible = blocks.filter(b => !b.invisible)
  const chars = visible.reduce((n, b) => n + b.text.trim().length, 0)
  const G = 64
  const grid = new Uint8Array(G * G)
  for (const b of visible) {
    if (!b.text.trim()) continue
    const x0 = Math.max(0, Math.floor(Math.min(b.bbox[0], b.bbox[2]) / size.width * G))
    const x1 = Math.min(G - 1, Math.floor(Math.max(b.bbox[0], b.bbox[2]) / size.width * G))
    const y0 = Math.max(0, Math.floor(Math.min(b.bbox[1], b.bbox[3]) / size.height * G))
    const y1 = Math.min(G - 1, Math.floor(Math.max(b.bbox[1], b.bbox[3]) / size.height * G))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y * G + x] = 1
  }
  let touched = 0
  for (const v of grid) touched += v
  return { chars, coverage: touched / (G * G) }
}

/** Share of the paper the images cover, summed (a scan may be tiled), each clipped to the page. */
export function imageCoverage(rects: number[][], size: Size): number {
  const paper = Math.max(1, size.width * size.height)
  let covered = 0
  for (const r of rects) {
    const x0 = Math.max(0, Math.min(r[0], r[2])), x1 = Math.min(size.width, Math.max(r[0], r[2]))
    const y0 = Math.max(0, Math.min(r[1], r[3])), y1 = Math.min(size.height, Math.max(r[1], r[3]))
    if (x1 > x0 && y1 > y0) covered += (x1 - x0) * (y1 - y0)
  }
  return covered / paper
}

export interface PageKind {
  kind: 'text' | 'scan'
  visibleChars: number
  invisibleChars: number
  reason: string
}

/** The editor's verdict for a page, from its blocks, size and image rects. */
export function pageKind(blocks: BlockLike[], size: Size, imageRects: number[][]): PageKind {
  const visibleChars = blocks.reduce((n, b) => n + (b.invisible ? 0 : b.text.trim().length), 0)
  const invisibleChars = blocks.reduce((n, b) => n + (b.invisible ? b.text.trim().length : 0), 0)
  if (invisibleChars > Math.max(visibleChars, 40)) {
    return { kind: 'scan', visibleChars, invisibleChars, reason: 'a scanned image with a searchable (invisible) OCR text layer' }
  }
  const layer = textLayerOf(blocks, size)
  const verdict = judgeScanned(layer.chars, layer.coverage)
  if (verdict.scanned && imageCoverage(imageRects, size) >= 0.5) {
    return { kind: 'scan', visibleChars, invisibleChars, reason: verdict.reason }
  }
  return { kind: 'text', visibleChars, invisibleChars, reason: verdict.scanned ? 'little or no text, and no page-sized image' : verdict.reason }
}
