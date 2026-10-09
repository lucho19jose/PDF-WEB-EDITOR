import type { TextBlock } from '@/engine/types'

/**
 * How much of the paper a page's text blocks cover, as a share of a 64×64 grid
 * they touch.
 *
 * A union, not a sum: a signing service stamps its ID strip once per signing
 * pass, so a scanned contract can carry 34 copies of the same line, and a sum
 * would count them 34 times. Measured on the grid the strip counts once, and
 * a stamp, a footer or a page number stays under a few percent of the page
 * however many characters it has. The scan verdict and the edit tool's "is
 * this text only a stamp?" both read this one measure.
 */
export function textCoverage(blocks: Pick<TextBlock, 'text' | 'bbox'>[], size: { width: number; height: number }): number {
  const G = 64
  const grid = new Uint8Array(G * G)
  if (!(size.width > 0) || !(size.height > 0)) return 0
  for (const b of blocks) {
    if (!b.text.trim()) continue
    const x0 = Math.max(0, Math.floor(Math.min(b.bbox[0], b.bbox[2]) / size.width * G))
    const x1 = Math.min(G - 1, Math.floor(Math.max(b.bbox[0], b.bbox[2]) / size.width * G))
    const y0 = Math.max(0, Math.floor(Math.min(b.bbox[1], b.bbox[3]) / size.height * G))
    const y1 = Math.min(G - 1, Math.floor(Math.max(b.bbox[1], b.bbox[3]) / size.height * G))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y * G + x] = 1
  }
  let touched = 0
  for (const v of grid) touched += v
  return touched / (G * G)
}

/** Text covering less than this share of the paper is a stamp, a footer or a page number. */
export const STAMP_TEXT_COVERAGE = 0.02

/** The area of a top-left page-space rectangle that lies ON the paper. */
export function areaOnPaper(rect: [number, number, number, number], size: { width: number; height: number }): number {
  const x0 = Math.max(0, Math.min(rect[0], rect[2]))
  const x1 = Math.min(size.width, Math.max(rect[0], rect[2]))
  const y0 = Math.max(0, Math.min(rect[1], rect[3]))
  const y1 = Math.min(size.height, Math.max(rect[1], rect[3]))
  return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0
}
