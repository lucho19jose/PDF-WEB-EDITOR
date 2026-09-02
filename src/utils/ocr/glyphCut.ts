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
  /** The cell's width contradicts its character; do not trace it. */
  suspect?: boolean
}

export interface GlyphCutResult {
  cells: GlyphCell[]
  /** Canvas y of the baseline — the mode of the cell bottoms, descenders excluded. */
  baselineY: number
  /** Em in canvas pixels. */
  emPx: number
  /** Threshold used, so the tracer binarises the same way. */
  threshold: number
  /** Light glyphs on a dark ground — the tracer must flip the bitmap too. */
  inverted: boolean
}

interface Bin { x: number; y: number; w: number; h: number; ink: Uint8Array; threshold: number; inverted: boolean }

/** Why the last cut was refused — for the sweep, which counts the reasons. */
let refusedBecause = ''
export function lastCutReason(): string { return refusedBecause }
function refuse(why: string): null { refusedBecause = why; return null }

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
  let dark = 0
  for (let j = 0; j < gray.length; j++) { const on = gray[j] < threshold ? 1 : 0; ink[j] = on; dark += on }
  // Light text on a dark band (a slide's title bar, a table header): the
  // dark side is the paper there, and read as ink it made the whole box ONE
  // run ("1 runs for 21 characters"). More than half the box dark means the
  // glyphs are the light side; flip it.
  const inverted = dark > gray.length * 0.5
  if (inverted) for (let j = 0; j < ink.length; j++) ink[j] = 1 - ink[j]
  // A rule across the box — an underline, a cell border — joins every glyph
  // column into one run and drags the baseline down. Rows inked across most
  // of the width are not glyph rows; clear them.
  for (let yy = 0; yy < h; yy++) {
    let n = 0
    for (let xx = 0; xx < w; xx++) n += ink[yy * w + xx]
    if (n >= w * 0.8) for (let xx = 0; xx < w; xx++) ink[yy * w + xx] = 0
  }
  return { x, y, w, h, ink, threshold, inverted }
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
  if (!chars.length) return refuse('no characters')
  const bin = binarise(ctx, rect)
  if (!bin) return refuse('blank or unreadable box')
  refusedBecause = ''

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
  return { cells, baselineY, emPx, threshold: bin.threshold, inverted: bin.inverted }
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
  if (!runs.length) return refuse('no ink runs')
  const target = chars.length
  // Letters that mostly TOUCH cannot be cut by profile: an italic serif
  // footer gave 69 characters in far fewer ink runs, and however the runs were
  // shared out, every second cell held the wrong letter. Tesseract's glyph
  // boxes are the only honest cut for such a line; without them, refuse.
  if (runs.length < target * 0.6) return refuse(`letters touch (${runs.length} runs for ${target} characters)`)
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
    if (++edits > budget) return refuse(`too many fragments (${runs.length + edits} runs for ${target} characters)`)
  }
  // Too few: touching letters. Which run holds which characters is decided
  // by WIDTH, not by splitting the widest run — the widest run in
  // "Atentamente," is the m, and cutting it in half made an m out of two
  // half-glyphs and shifted every letter after it. Characters are assigned
  // to runs in order, each run taking one or more, minimising how far each
  // run's width is from the expected advances of the letters it holds; a run
  // that took several is then divided among them by those advances.
  const groups = assignByWidth(runs, chars, emPx)
  if (!groups) return refuse('widths do not fit the letters')
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
  // Every cell's width against its character. An italic serif footer whose
  // letters touch fit the least-squares partition well enough as a WHOLE and
  // still gave a 5px "b" beside a 12px "i" — and those shapes went into the
  // face as b and i. A cell off by more than 40% is not traced; a run with
  // more than a quarter of them so is not cut at all.
  const totalW = cells.reduce((s, c) => s + (c.x1 - c.x0), 0)
  const totalE = chars.reduce((s, c) => s + expectedAdvance(c), 0) || 1
  let suspects = 0
  for (const c of cells) {
    const want = expectedAdvance(c.char) / totalE * totalW
    const got = c.x1 - c.x0
    if (Math.abs(got - want) > Math.max(3, want * 0.4)) { c.suspect = true; suspects++ }
  }
  // And each cell's SHAPE against its letter: a cell shifted by one letter
  // keeps a plausible width, which is how "República" came back reading
  // "Rpúbbiica". An x-height letter must neither rise nor descend, a
  // descender must descend, an ascender or a capital must rise — measured
  // against the run's own x-height and baseline.
  suspects += flagByShape(bin, cells)
  // A fifth: suspect cells are never traced anyway, so the bar is about
  // whether the REST can be trusted. Measured on 22 files, honest runs came
  // back with 2 of 18 or 2 of 15 suspect (a comma, an accent) and were being
  // refused whole at a tenth; the shifted italic footer was 16 of 69.
  if (suspects > cells.length * 0.2) return refuse(`${suspects} of ${cells.length} cells suspect`)
  return cells
}

const X_HEIGHT_CHARS = /^[aceimnorsuvwxzáéíóúñäëïöüàèìòùâêîôû]$/
const ASCENDER_CHARS = /^[bdfhklt]$/
const DESCENDER_ONLY = /^[gpqy]$/
const TALL_CHARS = /^[A-Z0-9ÁÉÍÓÚÑ]$/

/** Mark cells whose ink extent contradicts their letter's class; returns how many. */
function flagByShape(bin: Bin, cells: GlyphCell[]): number {
  const extents = cells.map(c => {
    const x0 = Math.max(0, c.x0 - bin.x), x1 = Math.min(bin.w, c.x1 - bin.x)
    let top = -1, bottom = -1
    for (let yy = 0; yy < bin.h; yy++) {
      let on = false
      for (let xx = x0; xx < x1; xx++) if (bin.ink[yy * bin.w + xx]) { on = true; break }
      if (on) { if (top < 0) top = yy; bottom = yy }
    }
    return { top, bottom }
  })
  // Baseline and x-height from the cells that define them.
  const bottoms: number[] = [], xTops: number[] = []
  cells.forEach((c, i) => {
    if (extents[i].top < 0) return
    if (!DESCENDER_ONLY.test(c.char) && !/[,;()]/.test(c.char)) bottoms.push(extents[i].bottom)
    if (X_HEIGHT_CHARS.test(c.char)) xTops.push(extents[i].top)
  })
  if (bottoms.length < 2 || xTops.length < 2) return 0
  bottoms.sort((a, b) => a - b); xTops.sort((a, b) => a - b)
  const baseline = bottoms[Math.floor(bottoms.length / 2)]
  const xTop = xTops[Math.floor(xTops.length / 2)]
  const xh = Math.max(3, baseline - xTop)
  let flagged = 0
  cells.forEach((c, i) => {
    const e = extents[i]
    if (e.top < 0 || c.suspect) return
    const rise = (xTop - e.top) / xh          // how far above the x-height line
    const drop = (e.bottom - baseline) / xh   // how far below the baseline
    let bad = false
    if (X_HEIGHT_CHARS.test(c.char)) bad = rise > 0.3 || drop > 0.25
    else if (DESCENDER_ONLY.test(c.char)) bad = drop < 0.15 || rise > 0.3
    else if (ASCENDER_CHARS.test(c.char) || TALL_CHARS.test(c.char)) bad = rise < 0.12 || drop > 0.25
    if (bad) { c.suspect = true; flagged++ }
  })
  return flagged
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
  pad = 1,
  invert = false
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
    const isInk = invert ? g >= threshold : g < threshold
    const v = isInk ? 0 : 255
    o[i] = v; o[i + 1] = v; o[i + 2] = v; o[i + 3] = 255
  }
  return { image: out, x, y }
}
