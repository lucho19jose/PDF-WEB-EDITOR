/**
 * A scanned page's own pixels, at the resolution they were scanned at.
 *
 * Every other raster in the OCR code is a RENDER of the page at some DPI the
 * app chose (220 for recognition, 440 for tracing), resampled from the scan.
 * An edit that is to be indistinguishable from the scan has to be made on the
 * scan's own pixel grid: an overlay drawn over exactly the scan's pixels, with
 * exactly their values where nothing changed, is invisible at any zoom and in
 * any viewer, because both images are resampled the same way. A render at
 * another DPI is not — its pixels straddle the scan's, and the edge of the
 * overlay shows as a faint box.
 *
 * DOM-free: the node labs (tools/ocr-calibrate) drive the same code.
 */

/** [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Mat6 = [number, number, number, number, number, number]

export interface ScanRaster {
  /** Pixel size. */
  w: number
  h: number
  /** RGBA, row-major, top row first — the decoded image, alpha 255. */
  data: Uint8ClampedArray
  /**
   * A pixel CORNER (column i, row j) to page points in the visible frame, top-left
   * origin (the frame OCR boxes are in): pixel (i, j) covers the unit square from
   * `apply(toPage, i, j)` to `apply(toPage, i + 1, j + 1)`.
   */
  toPage: Mat6
  /** The inverse of `toPage`. */
  toPx: Mat6
  pageWidth: number
  pageHeight: number
  /** The image's resource name on the page — for logs. */
  name?: string
}

export function apply(m: Mat6, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

export function invert(m: Mat6): Mat6 | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]
}

/**
 * The raster for an image drawn through `ctm` (the unit square to the VISIBLE
 * frame, bottom-up user space, as `getFullCtmAtOffset` composes it) on a page
 * `pageHeight` points tall. Image row 0 is the TOP of the picture: it maps to
 * v = 1 of the unit square.
 */
export function scanRasterOf(w: number, h: number, data: Uint8ClampedArray, ctm: Mat6, pageWidth: number, pageHeight: number, name?: string): ScanRaster | null {
  const [a, b, c, d, e, f] = ctm
  // (i, j) -> unit (i / w, 1 - j / h) -> user -> top-left (x, pageHeight - y).
  const toPage: Mat6 = [a / w, -b / w, -c / h, d / h, c + e, pageHeight - d - f]
  const toPx = invert(toPage)
  if (!toPx) return null
  return { w, h, data, toPage, toPx, pageWidth, pageHeight, name }
}

/**
 * True when the pixel grid runs along the page's axes, unflipped: rows down
 * the page, columns across. Only then is a page rectangle a pixel rectangle,
 * and only then does the transplant run (a rotated or mirrored placement would
 * need its overlays drawn through the same rotation — not implemented).
 */
export function isUpright(s: ScanRaster): boolean {
  const [a, b, c, d] = s.toPage
  return a > 0 && d > 0 && Math.abs(b) < 1e-9 * Math.abs(a) + 1e-12 && Math.abs(c) < 1e-9 * Math.abs(d) + 1e-12
}

/** Points per pixel along x and y (upright rasters). */
export function ptPerPx(s: ScanRaster): { x: number; y: number } {
  return { x: s.toPage[0], y: s.toPage[3] }
}

/** A page rectangle (points, top-left) → the pixel rectangle covering it, clamped, integer, [x0, x1) × [y0, y1). */
export function pxRectOf(s: ScanRaster, r: { x: number; y: number; width: number; height: number }, pad = 0): { x0: number; y0: number; x1: number; y1: number } {
  const [ax, ay] = apply(s.toPx, r.x, r.y)
  const [bx, by] = apply(s.toPx, r.x + r.width, r.y + r.height)
  return {
    x0: Math.max(0, Math.floor(Math.min(ax, bx) - pad)),
    y0: Math.max(0, Math.floor(Math.min(ay, by) - pad)),
    x1: Math.min(s.w, Math.ceil(Math.max(ax, bx) + pad)),
    y1: Math.min(s.h, Math.ceil(Math.max(ay, by) + pad))
  }
}

/** A pixel rectangle → page points [x0, y0, x1, y1], top-left origin. Exact: overlays drawn there sit on the scan's own grid. */
export function pageRectOfPx(s: ScanRaster, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  const [ax, ay] = apply(s.toPage, x0, y0)
  const [bx, by] = apply(s.toPage, x1, y1)
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
}

/** Rec. 601 luma of the pixel at linear index `p` (pixels, not bytes). */
export function lumAt(data: Uint8ClampedArray, p: number): number {
  const i = p * 4
  return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
}

/**
 * Just enough of a CanvasRenderingContext2D for `cutGlyphs`, `binarise` and
 * `segmentLine` — they only read pixels — over a raster's buffer. The page's
 * own canvas is never needed: the native raster has no element.
 */
export function readerCtx(s: Pick<ScanRaster, 'w' | 'h' | 'data'>): CanvasRenderingContext2D {
  return {
    canvas: { width: s.w, height: s.h },
    getImageData(x: number, y: number, w: number, h: number) {
      const out = new Uint8ClampedArray(w * h * 4)
      for (let yy = 0; yy < h; yy++) {
        const sy = y + yy
        if (sy < 0 || sy >= s.h) continue
        const x0 = Math.max(0, x), x1 = Math.min(s.w, x + w)
        if (x1 <= x0) continue
        out.set(s.data.subarray((sy * s.w + x0) * 4, (sy * s.w + x1) * 4), (yy * w + (x0 - x)) * 4)
      }
      return { data: out, width: w, height: h, colorSpace: 'srgb' } as unknown as ImageData
    }
  } as unknown as CanvasRenderingContext2D
}
