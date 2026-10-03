/**
 * One glyph of a font rasterised by MuPDF at a scan's pixel size — the raw
 * material glyphSynth.ts degrades into a letter the scan never printed. Kept
 * free of imports: the engine worker runs it (`rasterGlyphs`), and so do the
 * node labs, each passing its own MuPDF module.
 */

/** A glyph rasterised at native pixels: coverage 0..1, origin on the baseline. */
export interface RasterGlyph {
  w: number
  h: number
  cov: Float32Array
  /** Baseline row and the origin's column. */
  baseY: number
  originX: number
  /** Ink columns [inkL, inkR) and rows [top, bottom). */
  inkL: number
  inkR: number
  top: number
  bottom: number
  /** Advance in px. */
  advance: number
}

/**
 * Rasterise `char` from a MuPDF font at `emPx` pixels to the em, `ss`× over
 * and box-filtered down — the coverage an ideal scanner would see before its
 * own blur. Null when the font has no glyph for it.
 */
export function rasterizeGlyph(mupdf: any, font: any, char: string, emPx: number, ss = 4): RasterGlyph | null {
  const cp = char.codePointAt(0)!
  const gid = font.encodeCharacter(cp)
  if (!gid || gid <= 0) return null
  const S = emPx * ss
  const W = Math.ceil(1.8 * S), H = Math.ceil(1.8 * S)
  const ox = Math.round(0.35 * S / ss) * ss, oy = Math.round(1.3 * S / ss) * ss
  const text = new mupdf.Text()
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  try {
    text.showGlyph(font, [S, 0, 0, -S, ox, oy], gid, cp, 0)
    pix.clear(255)
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
    try {
      dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
      dev.close()
    } finally { try { dev.destroy?.() } catch (_) {} }
    const p = pix.getPixels()
    const stride = pix.getStride?.() ?? W
    const w = Math.ceil(W / ss), h = Math.ceil(H / ss)
    const cov = new Float32Array(w * h)
    for (let y = 0; y < H; y++) {
      const row = Math.floor(y / ss) * w
      for (let x = 0; x < W; x++) cov[row + Math.floor(x / ss)] += (255 - p[y * stride + x]) / 255
    }
    let inkL = w, inkR = -1, top = h, bottom = -1
    for (let i = 0; i < cov.length; i++) {
      cov[i] /= ss * ss
      if (cov[i] > 0.04) {
        const x = i % w, y = (i - x) / w
        if (x < inkL) inkL = x
        if (x > inkR) inkR = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
    return { w, h, cov, baseY: oy / ss, originX: ox / ss, inkL, inkR: inkR + 1, top, bottom: bottom + 1, advance: font.advanceGlyph(gid) * emPx }
  } finally {
    try { text.destroy?.() } catch (_) {}
    try { pix.destroy?.() } catch (_) {}
  }
}

