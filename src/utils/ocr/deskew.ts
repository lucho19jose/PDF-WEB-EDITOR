import type { OcrBox, OcrLine, OcrRecognition } from './ocrEngine'

/**
 * Reading a TILTED scan level.
 *
 * PaddleOCR's detector and this app's SDK work in axis-aligned boxes. On a
 * page scanned 1.75° off level (a bilingual contract, 9pt body text set
 * tight) a full-width line rises 14pt from one end to the other, so its box
 * is two lines tall: the detector's padded regions of neighbouring lines
 * overlap and merge, and the recogniser is handed crops holding pieces of
 * three lines. Measured on that page: six lines of the main clause came back
 * as ONE box reading "L" at 45% and nothing else, a Chinese line at 55%, and
 * every line of the page's dense paragraphs went the same way — whole
 * paragraphs had no run to click and could not be edited.
 *
 * The page is read LEVELLED instead: its skew is measured, the raster turned
 * by it, recognised, and each box mapped back onto the page as the
 * axis-aligned box enclosing it — the shape every consumer downstream
 * already gets for a tilted line — with the tilt kept beside it (`tilt`) for
 * what can use it. The same page then reads every line of that clause at
 * 99–100%, and its mean confidence goes from 96.5% to 98.4%.
 */

/** Degrees, clockwise on the raster (y down): positive when lines descend to the right. */
export interface Skew {
  degrees: number
  /** How much sharper the row profile is at that angle than level (≥ 1). */
  gain: number
}

/** Below this the page is level as far as reading goes; above it, not a skew. */
const MIN_SKEW = 0.3
const MAX_SKEW = 6
/** A skew only counts when the profile is clearly sharper there than level. */
const MIN_GAIN = 1.1

/**
 * The page's skew from the projection profile: ink pixels (quarter scale) are
 * summed along sheared rows, and the angle whose row sums change most sharply
 * from row to row — lines and the gaps between them lined up — wins. Null
 * when the page is level, blank, or the evidence is weak.
 */
export function estimateSkew(rgba: Uint8ClampedArray, width: number, height: number): Skew | null {
  const q = 4
  const w = Math.floor(width / q), h = Math.floor(height / q)
  if (w < 32 || h < 32) return null
  // Ink: darker than three quarters of the page's median luminance (and than 170).
  const lum = new Uint8Array(w * h)
  const hist = new Uint32Array(256)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let dy = 0; dy < q; dy++) {
        let i = ((y * q + dy) * width + x * q) * 4
        for (let dx = 0; dx < q; dx++, i += 4) sum += rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
      }
      const v = Math.round(sum / (q * q))
      lum[y * w + x] = v
      hist[v]++
    }
  }
  let acc = 0, median = 255
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= (w * h) / 2) { median = v; break } }
  const cut = Math.min(170, median * 0.75)
  const xs: number[] = [], ys: number[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lum[y * w + x] < cut) { xs.push(x); ys.push(y) }
  // A page with almost no ink has no lines to level.
  if (xs.length < 1500 || xs.length > w * h * 0.5) return null
  const span = h + w
  const rows = new Float64Array(span * 2)
  const scoreAt = (deg: number) => {
    const t = Math.tan(deg * Math.PI / 180)
    rows.fill(0)
    const off = span
    for (let k = 0; k < xs.length; k++) {
      const r = Math.round(ys[k] - xs[k] * t) + off
      if (r >= 0 && r < rows.length) rows[r]++
    }
    let sc = 0
    for (let i = 1; i < rows.length; i++) { const d = rows[i] - rows[i - 1]; sc += d * d }
    return sc
  }
  const level = scoreAt(0)
  if (!(level > 0)) return null
  let best = 0, bestScore = level
  for (let a = -MAX_SKEW; a <= MAX_SKEW + 1e-9; a += 0.1) {
    const s = scoreAt(a)
    if (s > bestScore) { bestScore = s; best = a }
  }
  for (let a = best - 0.1; a <= best + 0.1 + 1e-9; a += 0.02) {
    const s = scoreAt(a)
    if (s > bestScore) { bestScore = s; best = a }
  }
  const gain = bestScore / level
  if (Math.abs(best) < MIN_SKEW || Math.abs(best) > MAX_SKEW || gain < MIN_GAIN) return null
  return { degrees: Math.round(best * 100) / 100, gain: Math.round(gain * 100) / 100 }
}

/** A raster turned level, with what it takes to map its coordinates back. */
export interface Levelled {
  canvas: HTMLCanvasElement
  /** The skew undone (degrees, as `Skew.degrees`). */
  degrees: number
  /** Source size and the margin the levelled canvas adds on every side. */
  srcW: number
  srcH: number
  margin: number
}

/**
 * The raster turned by −skew about its centre, on a canvas grown so no
 * corner is cut off, the new margins white like paper.
 */
export function levelCanvas(src: HTMLCanvasElement, degrees: number): Levelled | null {
  const rad = degrees * Math.PI / 180
  const margin = Math.ceil(Math.max(src.width, src.height) * Math.abs(Math.sin(rad)) / 2) + 4
  const canvas = document.createElement('canvas')
  canvas.width = src.width + margin * 2
  canvas.height = src.height + margin * 2
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate(-rad)
  ctx.drawImage(src, -src.width / 2, -src.height / 2)
  return { canvas, degrees, srcW: src.width, srcH: src.height, margin }
}

/** A point of the levelled canvas, back on the source raster. */
export function unlevelPoint(L: Levelled, x: number, y: number): [number, number] {
  const rad = L.degrees * Math.PI / 180
  const c = Math.cos(rad), s = Math.sin(rad)
  const vx = x - (L.srcW / 2 + L.margin), vy = y - (L.srcH / 2 + L.margin)
  return [L.srcW / 2 + vx * c - vy * s, L.srcH / 2 + vx * s + vy * c]
}

/** A levelled box, back on the source: the axis-aligned box enclosing it, clamped to the raster. */
export function unlevelBox(L: Levelled, b: OcrBox): OcrBox {
  const pts = [unlevelPoint(L, b.x0, b.y0), unlevelPoint(L, b.x1, b.y0), unlevelPoint(L, b.x1, b.y1), unlevelPoint(L, b.x0, b.y1)]
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  return {
    x0: Math.max(0, Math.min(...xs)), y0: Math.max(0, Math.min(...ys)),
    x1: Math.min(L.srcW, Math.max(...xs)), y1: Math.min(L.srcH, Math.max(...ys))
  }
}

/**
 * A recognition made on the levelled raster, put back on the source: every
 * line's, word's and glyph's box mapped back, and each line told its tilt —
 * the slope of its centre line and the half-height of its level box, which
 * is the band its letters occupy (`OcrLine.tilt`).
 */
export function unlevelRecognition(L: Levelled, data: OcrRecognition): OcrRecognition {
  const slope = Math.tan(L.degrees * Math.PI / 180)
  return {
    lines: data.lines.map((line): OcrLine => {
      const [mx, my] = unlevelPoint(L, (line.box.x0 + line.box.x1) / 2, (line.box.y0 + line.box.y1) / 2)
      return {
        ...line,
        box: unlevelBox(L, line.box),
        words: line.words?.map(w => ({ ...w, box: unlevelBox(L, w.box), symbols: w.symbols?.map(s => unlevelBox(L, s)) })),
        baseline: line.baseline ? (() => {
          const [ax, ay] = unlevelPoint(L, line.baseline.x0, line.baseline.y0)
          const [bx, by] = unlevelPoint(L, line.baseline.x1, line.baseline.y1)
          return { x0: ax, y0: ay, x1: bx, y1: by }
        })() : undefined,
        paragraph: line.paragraph ? { ...line.paragraph, box: unlevelBox(L, line.paragraph.box) } : undefined,
        tilt: { slope, midX: mx, midY: my, half: (line.box.y1 - line.box.y0) / 2 }
      }
    })
  }
}
