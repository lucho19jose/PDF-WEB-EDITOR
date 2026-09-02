import type { OcrBox } from './ocrEngine'

/**
 * Cutting a recognised run into one cell per character, on the scan's pixels.
 *
 * The traced scan face needs a bitmap per GLYPH, and PaddleOCR reports only
 * the run's box. Tesseract's glyph boxes are used when they are there and
 * agree with the text; otherwise the run is cut on its column profile:
 * connected runs of inked columns are merged or split until there is one
 * cell per non-space character, guided by what each character is expected to
 * occupy (an ideograph an em, a Latin letter about half). When the profile
 * cannot be reconciled with the text within reason the run yields NOTHING —
 * a fallback font is a lesser evil than a wrong glyph under a letter.
 */

export interface GlyphCell {
  char: string
  /** Canvas pixel columns, inclusive–exclusive. */
  x0: number
  x1: number
}

export interface GlyphCutResult {
  cells: GlyphCell[]
  /** Canvas y of the baseline — the mode of the cell bottoms, descenders excluded. */
  baselineY: number
  /** Em in canvas pixels. */
  emPx: number
  /** Threshold used, so the tracer binarises the same way. */
  threshold: number
}

interface Bin { x: number; y: number; w: number; h: number; ink: Uint8Array; threshold: number }

const DESCENDER_CHARS = /[gjpqyQ,;()\[\]{}]/
const CJK = /[\p{Script=Han}　-〿＀-￯]/u

function binarise(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }): Bin | null {
  const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y))
  const w = Math.min(ctx.canvas.width - x, Math.ceil(rect.width)), h = Math.min(ctx.canvas.height - y, Math.ceil(rect.height))
  if (w < 3 || h < 3) return null
  let px: Uint8ClampedArray
  try { px = ctx.getImageData(x, y, w, h).data } catch (_) { return null }
  const gray = new Float32Array(w * h)
  let lo = 255, hi = 0
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000
    gray[j] = g
    if (g < lo) lo = g
    if (g > hi) hi = g
  }
  if (hi - lo < 24) return null
  // Biased towards white: a scan's strokes are ringed with anti-aliased grey,
  // and cutting at the midpoint keeps that ring as ink, so the traced glyphs
  // came out visibly heavier than the page. At 0.42 of the range the ring
  // goes and the stems keep their width.
  const threshold = lo + (hi - lo) * 0.42
  const ink = new Uint8Array(w * h)
  for (let j = 0; j < gray.length; j++) ink[j] = gray[j] < threshold ? 1 : 0
  return { x, y, w, h, ink, threshold }
}

/** Expected width of a character as a fraction of the em. */
export function expectedAdvance(ch: string): number {
  if (CJK.test(ch)) return 0.95
  if (/[iljtfrI.,;:'!|1]/.test(ch)) return 0.3
  if (/[mwMW@%]/.test(ch)) return 0.85
  if (/[A-Z0-9]/.test(ch)) return 0.65
  return 0.52
}

/**
 * Cut `text`'s run at `rect` (canvas pixels) into glyph cells.
 *
 * @param symbols per-glyph boxes from the engine, if it reported them
 */
export function cutGlyphs(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  text: string,
  symbols?: OcrBox[]
): GlyphCutResult | null {
  const chars = [...text].filter(c => c !== ' ')
  if (!chars.length) return null
  const bin = binarise(ctx, rect)
  if (!bin) return null

  const cjk = chars.filter(c => CJK.test(c)).length * 2 >= chars.length
  const emPx = bin.h / (cjk ? 0.92 : (chars.some(c => DESCENDER_CHARS.test(c)) ? 0.95 : 0.76))

  let cells: GlyphCell[] | null = null
  if (symbols && symbols.length === chars.length) {
    cells = symbols.map((s, i) => ({ char: chars[i], x0: Math.round(s.x0), x1: Math.round(s.x1) }))
  } else {
    cells = cutByProfile(bin, chars, emPx)
  }
  if (!cells) return null

  const baselineY = baselineOf(bin, cells)
  return { cells, baselineY, emPx, threshold: bin.threshold }
}

function cutByProfile(bin: Bin, chars: string[], emPx: number): GlyphCell[] | null {
  const cols = new Uint16Array(bin.w)
  for (let yy = 0; yy < bin.h; yy++) for (let xx = 0; xx < bin.w; xx++) cols[xx] += bin.ink[yy * bin.w + xx]
  const minCol = 1
  // Connected runs of inked columns; a one-pixel break does not split (a
  // scanner drops pixels off thin strokes).
  const runs: { x0: number; x1: number }[] = []
  let start = -1, blank = 0
  for (let xx = 0; xx <= bin.w; xx++) {
    const on = xx < bin.w && cols[xx] >= minCol
    if (on) { if (start < 0) start = xx; blank = 0 }
    else if (start >= 0) {
      blank++
      if (blank > 1 || xx === bin.w) { runs.push({ x0: start, x1: xx - blank + 1 }); start = -1; blank = 0 }
    }
  }
  if (!runs.length) return null
  const target = chars.length
  const budget = Math.max(1, Math.round(target * 0.35))
  let edits = 0

  // Too many pieces: an ideograph's radicals, a broken stroke, an accent
  // above its letter. Merge the pair with the smallest gap first.
  while (runs.length > target) {
    let best = -1, bestGap = Infinity
    for (let i = 1; i < runs.length; i++) {
      const gap = runs[i].x0 - runs[i - 1].x1
      if (gap < bestGap) { bestGap = gap; best = i }
    }
    runs.splice(best - 1, 2, { x0: runs[best - 1].x0, x1: runs[best].x1 })
    if (++edits > budget) return null
  }
  // Too few: touching letters. Which run holds which characters is decided
  // by WIDTH, not by splitting the widest run — the widest run in
  // "Atentamente," is the m, and cutting it in half made an m out of two
  // half-glyphs and shifted every letter after it. Characters are assigned
  // to runs in order, each run taking one or more, minimising how far each
  // run's width is from the expected advances of the letters it holds; a run
  // that took several is then divided among them by those advances.
  const groups = assignByWidth(runs, chars, emPx)
  if (!groups) return null
  const cells: GlyphCell[] = []
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    const held = groups[i]
    const sum = held.reduce((s, c) => s + expectedAdvance(c), 0) || 1
    let x = r.x0
    held.forEach((c, k) => {
      const w = (r.x1 - r.x0) * (expectedAdvance(c) / sum)
      const x1 = k === held.length - 1 ? r.x1 : x + w
      cells.push({ char: c, x0: bin.x + Math.round(x), x1: bin.x + Math.round(x1) })
      x = x1
    })
  }
  return cells
}

/**
 * Partition `chars` into `runs.length` consecutive non-empty groups so that
 * each run's pixel width matches the expected advances of its group as
 * closely as possible (least squares, dynamic programming). Null when even
 * the best partition leaves the widths far from the letters — a run the
 * text does not describe is not one to trace.
 */
function assignByWidth(runs: { x0: number; x1: number }[], chars: string[], emPx: number): string[][] | null {
  const R = runs.length, N = chars.length
  if (R > N || R === 0) return null
  const widths = runs.map(r => (r.x1 - r.x0) / emPx)
  const adv = chars.map(expectedAdvance)
  // Scale expectations so the totals agree: the face's letters may be wider
  // or narrower than the table assumes, uniformly.
  const scale = widths.reduce((s, w) => s + w, 0) / Math.max(adv.reduce((s, a) => s + a, 0), 1e-6)
  const prefix = [0]
  for (const a of adv) prefix.push(prefix[prefix.length - 1] + a * scale)
  // best[i][j]: min cost placing the first j chars into the first i runs.
  const INF = Number.POSITIVE_INFINITY
  const best: number[][] = Array.from({ length: R + 1 }, () => new Array(N + 1).fill(INF))
  const from: number[][] = Array.from({ length: R + 1 }, () => new Array(N + 1).fill(-1))
  best[0][0] = 0
  for (let i = 1; i <= R; i++) {
    for (let j = i; j <= N - (R - i); j++) {
      for (let k = i - 1; k < j; k++) {
        if (best[i - 1][k] === INF) continue
        const want = prefix[j] - prefix[k]
        const d = widths[i - 1] - want
        const cost = best[i - 1][k] + d * d
        if (cost < best[i][j]) { best[i][j] = cost; from[i][j] = k }
      }
    }
  }
  if (best[R][N] === INF) return null
  // Reject a fit whose average error is a third of an em per run or more.
  if (Math.sqrt(best[R][N] / R) > 0.34) return null
  const groups: string[][] = []
  let j = N
  for (let i = R; i >= 1; i--) {
    const k = from[i][j]
    groups.unshift(chars.slice(k, j))
    j = k
  }
  return groups
}

/** The baseline: where most non-descending glyphs end. */
function baselineOf(bin: Bin, cells: GlyphCell[]): number {
  const bottoms: number[] = []
  for (const c of cells) {
    if (DESCENDER_CHARS.test(c.char)) continue
    const x0 = Math.max(0, c.x0 - bin.x), x1 = Math.min(bin.w, c.x1 - bin.x)
    for (let yy = bin.h - 1; yy >= 0; yy--) {
      let on = false
      for (let xx = x0; xx < x1; xx++) if (bin.ink[yy * bin.w + xx]) { on = true; break }
      if (on) { bottoms.push(bin.y + yy + 1); break }
    }
  }
  if (!bottoms.length) return bin.y + bin.h
  bottoms.sort((a, b) => a - b)
  return bottoms[Math.floor(bottoms.length / 2)]
}

/** Binarised ImageData of one cell, black ink on white, for the tracer. */
export function cellBitmap(
  ctx: CanvasRenderingContext2D,
  cell: GlyphCell,
  top: number,
  bottom: number,
  threshold: number,
  pad = 1
): { image: ImageData; x: number; y: number } | null {
  const x = Math.max(0, cell.x0 - pad), y = Math.max(0, Math.floor(top) - pad)
  const w = Math.min(ctx.canvas.width - x, cell.x1 - cell.x0 + pad * 2)
  const h = Math.min(ctx.canvas.height - y, Math.ceil(bottom) - Math.floor(top) + pad * 2)
  if (w < 2 || h < 2) return null
  let src: ImageData
  try { src = ctx.getImageData(x, y, w, h) } catch (_) { return null }
  const out = new ImageData(w, h)
  const d = src.data, o = out.data
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
    const v = g < threshold ? 0 : 255
    o[i] = v; o[i + 1] = v; o[i + 2] = v; o[i + 3] = 255
  }
  return { image: out, x, y }
}
