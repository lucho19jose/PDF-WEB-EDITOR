import type { OcrTextItem } from './ocrTypes'
import type { RectT } from '@/engine/types'
import type { GlyphCutResult } from './glyphCut'
import type { PatchOp, TextOp, ImageOp } from './ocrExport'

/**
 * Redrawing only what the user CHANGED in a scanned run.
 *
 * The export used to paint over a run's whole ink box and draw the whole new
 * text again, so every word the user never touched was replaced by a traced
 * outline — or by Helvetica when the cut refused, which on the corpus is half
 * of all edited runs. A scan's own pixels are the most faithful rendering of
 * its words there is; the untouched head and tail of a run should keep them.
 *
 * What this module knows about a run is its `SpanCut`: where each letter of
 * the ORIGINAL text sits on the page (from the glyph cut made when the edit was
 * committed), the fitted baseline, and the gaps the scan leaves between letters
 * and between words. From that and the exact width of the new stretch (measured
 * in the engine with the fonts that will draw it) `planPartial` decides:
 *
 *  - FITS: the new stretch takes the room the old one had (give or take a
 *    pixel, or up to a space's worth of slack when it is shorter) — patch the
 *    old stretch only, draw the new one, leave head and tail as they are;
 *  - SHIFT: the untouched tail is moved by transplanting its pixels (an image
 *    of the scan drawn at the new position), when the caller allows it and the
 *    tail would not run into the next run or the page edge;
 *  - otherwise the caller falls back to the whole-run redraw.
 *
 * Everything here is in page points, visible frame, top-left origin — the frame
 * the OCR raster is rendered in and the frame `fillRect`, `addTextToPage` and
 * (since the same fix) `drawImageInContent` correct into the stream's own.
 */

export interface SpanCut {
  /** One per NON-SPACE character of the original text, in reading order. */
  cells: { char: string; x0: number; x1: number; suspect: boolean }[]
  /** Fitted ink baseline: y(x) = yAtCentre + slope * (x - centreX). */
  baseline: { yAtCentre: number; slope: number; centreX: number }
  /** The em the cut measured, in points. */
  emPt: number
  /** Median gap between adjacent letters of a word, and between words. */
  letterGapPt: number
  wordGapPt: number
  source: 'symbols' | 'profile' | 'tesseract'
}

export interface PartialContext {
  cut: SpanCut
  /** Pen advance of the new stretch at `sizeOf(ctx)`, in points; null when the engine could not measure it exactly. */
  stretchWidthPt: number | null
  /** Whether the untouched tail may be moved by transplanting its pixels. */
  allowShift: boolean
  fontName: string
  color: [number, number, number]
  faceId?: string
}

export interface PartialPlan {
  patches: PatchOp[]
  images: ImageOp[]
  texts: TextOp[]
  mode: 'partial' | 'partial+shift'
}

export type PartialOutcome = PartialPlan | { reason: string }

const nonSpace = (s: string) => [...s].filter(c => c !== ' ')

/**
 * The common prefix and suffix of two character arrays — what an edit left
 * alone at either end. This is also what the tracer trusts (`trustedCells` in
 * scanFace.ts): the two must agree on what "unchanged" means.
 */
export function commonAffix(original: string[], edited: string[]): { prefix: number; suffix: number } {
  let prefix = 0
  while (prefix < original.length && prefix < edited.length && original[prefix] === edited[prefix]) prefix++
  let suffix = 0
  while (
    suffix < original.length - prefix && suffix < edited.length - prefix &&
    original[original.length - 1 - suffix] === edited[edited.length - 1 - suffix]
  ) suffix++
  return { prefix, suffix }
}

/** A glyph cut in raster pixels → the run's span geometry in points. */
export function toSpanCut(cut: GlyphCutResult, toPt: number, originalText: string, source: SpanCut['source']): SpanCut {
  const cells = cut.cells.map(c => ({ char: c.char, x0: c.x0 * toPt, x1: c.x1 * toPt, suspect: !!c.suspect }))
  const cx = cut.bin.x + cut.bin.w / 2
  const yAtCentre = cut.baselineAt(cx) * toPt
  const slope = (cut.baselineAt(cx + 100) - cut.baselineAt(cx)) / 100
  // Gaps, sorted into letter gaps and word gaps by whether the original text
  // has a space between the two characters.
  const letterGaps: number[] = [], wordGaps: number[] = []
  const chars = [...originalText]
  let cellIndex = -1
  let pendingSpace = false
  let prev: { x1: number; suspect: boolean } | null = null
  for (const ch of chars) {
    if (ch === ' ') { pendingSpace = true; continue }
    cellIndex++
    const cell = cells[cellIndex]
    if (!cell) break
    if (prev && !prev.suspect && !cell.suspect) {
      const gap = cell.x0 - prev.x1
      if (gap >= 0) (pendingSpace ? wordGaps : letterGaps).push(gap)
    }
    prev = cell
    pendingSpace = false
  }
  const emPt = cut.emPx * toPt
  const median = (v: number[], fallback: number) => {
    if (!v.length) return fallback
    const s = [...v].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  return {
    cells,
    baseline: { yAtCentre, slope, centreX: cx * toPt },
    emPt,
    letterGapPt: median(letterGaps, emPt * 0.08),
    wordGapPt: median(wordGaps, emPt * 0.3),
    source
  }
}

export interface Stretch {
  prefix: number
  suffix: number
  /** The new characters between the untouched head and tail, spaces trimmed. */
  text: string
  /** Whether the new text puts a space between the head and the stretch / the stretch and the tail. */
  spaceBefore: boolean
  spaceAfter: boolean
}

/** What the edit changed, as the run's non-space characters see it. */
export function stretchOf(item: OcrTextItem): Stretch | null {
  const original = nonSpace(item.originalText)
  const edited = nonSpace(item.text)
  const { prefix, suffix } = commonAffix(original, edited)
  // Indices into the FULL edited text of the first changed non-space character
  // and of the first non-space character of the tail.
  const positions: number[] = []
  const t = [...item.text]
  t.forEach((c, i) => { if (c !== ' ') positions.push(i) })
  const start = prefix < positions.length ? positions[prefix] : t.length
  const end = edited.length - suffix < positions.length ? positions[edited.length - suffix] : t.length
  const raw = t.slice(start, end).join('')
  // Is there a space between the head and what follows it, and between what
  // precedes the tail and the tail? For a pure deletion both look at the same
  // gap, which is right: the head and tail then meet across that one space.
  const spaceBefore = prefix > 0 && start > 0 && t[start - 1] === ' '
  const spaceAfter = suffix > 0 && end > 0 && t[end - 1] === ' '
  return { prefix, suffix, text: raw.trim(), spaceBefore, spaceAfter }
}

/** The size the stretch is drawn at: the cut's own em, held near the run's. */
export function sizeOf(item: OcrTextItem, cut: SpanCut): number {
  // The cut's em is measured on the letters; the item's came from the box,
  // which a rule or a neighbour can inflate by half again. Trust the letters,
  // within a wide sanity band.
  return Math.round(Math.min(item.fontSize * 2, Math.max(item.fontSize * 0.5, cut.emPt)) * 10) / 10
}

/** The left edge of the nearest run to the right on the same line (its ink), or null. */
export function nextRunInkRight(item: OcrTextItem, all: OcrTextItem[]): number | null {
  const ink = item.inkRect ?? item.rect
  const midY = ink.y + ink.height / 2
  const floor = ink.x + ink.width * 0.5
  let best: number | null = null
  for (const o of all) {
    if (o === item || o.vertical) continue
    const r = o.inkRect ?? o.rect
    const left = Math.min(r.x, o.rect.x)
    if (midY < r.y || midY > r.y + r.height) continue
    if (left < floor) continue
    if (best === null || left < best) best = left
  }
  return best
}

const TOUCH_PT = 0.34 // about one raster pixel at 220 DPI

export function planPartial(item: OcrTextItem, ctx: PartialContext, all: OcrTextItem[], pageWidth?: number): PartialOutcome {
  const { cut } = ctx
  if (item.vertical) return { reason: 'vertical run' }
  if (item.baked) return { reason: 'baked already' }
  if (item.restyled) return { reason: 'restyled' }
  const ink = item.inkRect ?? item.rect
  if (Math.abs(item.rect.x - ink.x) > 0.5 || Math.abs(item.rect.y - ink.y) > 0.5) return { reason: 'run was moved' }
  if (Math.abs(item.rotation) > 2 || Math.abs(cut.baseline.slope) > 0.03) return { reason: 'line is tilted' }
  const original = nonSpace(item.originalText)
  const n = cut.cells.length
  if (n !== original.length) return { reason: 'cut does not match the text' }
  const st = stretchOf(item)
  if (!st) return { reason: 'no stretch' }
  const { prefix, suffix } = st
  if (prefix + suffix === 0) return { reason: 'whole text changed' }
  if (prefix + suffix >= n && st.text.length === 0) return { reason: 'only spaces changed' }
  if (ctx.stretchWidthPt === null && st.text.length > 0) return { reason: 'width unknown' }

  const cells = cut.cells
  const changed = { from: prefix, to: n - suffix } // [from, to) indices of replaced cells
  // Boundary cells must be trustworthy and clear of their neighbours: a cut
  // that lands a column inside a letter would leave a fringe or clip it.
  const boundary = (i: number) => cells[i] && !cells[i].suspect
  if (prefix > 0 && !boundary(prefix - 1)) return { reason: 'head boundary suspect' }
  if (suffix > 0 && !boundary(n - suffix)) return { reason: 'tail boundary suspect' }
  if (prefix > 0 && changed.from < n && cells[changed.from].x0 - cells[prefix - 1].x1 < TOUCH_PT) return { reason: 'head touches the changed letters' }
  if (suffix > 0 && changed.to > 0 && changed.to - 1 >= 0 && changed.to - 1 < n && changed.to - 1 >= changed.from && cells[n - suffix].x0 - cells[changed.to - 1].x1 < TOUCH_PT) return { reason: 'tail touches the changed letters' }
  if (suffix > 0 && changed.to === changed.from && prefix > 0 && cells[n - suffix].x0 - cells[prefix - 1].x1 < TOUCH_PT) return { reason: 'no room between head and tail' }

  const sizePt = sizeOf(item, cut)
  const bearing = sizePt * 0.05
  const headEnd = prefix > 0 ? cells[prefix - 1].x1 : ink.x
  const tailStart = suffix > 0 ? cells[n - suffix].x0 : null
  const oldSpan = changed.to > changed.from ? { x0: cells[changed.from].x0, x1: cells[changed.to - 1].x1 } : null
  const inkRight = ink.x + ink.width
  const gapBefore = st.spaceBefore ? cut.wordGapPt : cut.letterGapPt
  const gapAfter = st.spaceAfter ? cut.wordGapPt : cut.letterGapPt

  const width = st.text.length ? (ctx.stretchWidthPt ?? 0) : 0
  const penX = oldSpan ? oldSpan.x0 - bearing : (prefix > 0 ? headEnd + gapBefore - bearing : ink.x - bearing)
  const inkEnd = st.text.length ? penX + width - bearing : headEnd
  const baselineY = cut.baseline.yAtCentre + cut.baseline.slope * (penX - cut.baseline.centreX)
  const padY = Math.max(1, ink.height * 0.12)
  const padX = Math.max(1, ink.height * 0.15)
  const padHead = prefix > 0 ? Math.min(1, Math.max(0.4, gapBefore / 2)) : padX
  const patchX0 = prefix > 0 ? headEnd + padHead : ink.x - padX

  // The words the scan keeps drawing are put back into the page as INVISIBLE
  // text at their own positions (render mode 3), so the line still extracts,
  // copies and searches as one line; otherwise only the stretch would be text.
  const t = [...item.text]
  const positions: number[] = []
  t.forEach((c, i) => { if (c !== ' ') positions.push(i) })
  const edited = nonSpace(item.text)
  const headText = prefix > 0 ? t.slice(0, positions[prefix - 1] + 1).join('').trim() : ''
  const tailText = suffix > 0 ? t.slice(positions[edited.length - suffix]).join('').trim() : ''
  const invisible = (text: string, x: number): TextOp[] => text ? [{
    text, x, y: cut.baseline.yAtCentre + cut.baseline.slope * (x - cut.baseline.centreX), fontSize: sizePt,
    fontName: ctx.fontName, color: ctx.color, rotation: 0, invisible: true
  }] : []
  const textOp = (tailShift = 0): TextOp[] => [
    ...invisible(headText, cells[0].x0 - bearing),
    ...(st.text.length ? [{
      text: st.text, x: penX, y: baselineY, fontSize: sizePt,
      fontName: ctx.fontName, color: ctx.color, rotation: 0, faceId: ctx.faceId
    } as TextOp] : []),
    ...(tailStart !== null ? invisible(tailText, tailStart + tailShift - bearing) : [])
  ]

  if (tailStart === null) {
    // No tail: an append or a deletion at the end. The stretch may grow past
    // the old ink but not into the next run or off the page - there the
    // whole-run redraw's `fitSize` is the right tool.
    const limit = Math.min(nextRunInkRight(item, all) ?? Infinity, pageWidth ? pageWidth - 12 : Infinity)
    if (inkEnd > limit) return { reason: 'stretch would run into the next run' }
    return {
      mode: 'partial',
      patches: [{ rect: [patchX0, ink.y - padY, Math.max(inkRight, inkEnd) + padX, ink.y + ink.height + padY], color: plain(item.background) }],
      images: [],
      texts: textOp()
    }
  }

  const newTail0 = (st.text.length ? inkEnd : headEnd) + gapAfter
  const dx = newTail0 - tailStart
  const padTail = Math.min(1, Math.max(0.4, gapAfter / 2))
  // Fits when the tail keeps at least 40% of the gap before it (a word gap
  // closing from 6.5pt to 4 is invisible; a letter gap of 1.6pt yields a
  // pixel), or opens by up to a space's worth.
  if (dx <= Math.max(TOUCH_PT, gapAfter * 0.6) && dx >= -0.6 * sizePt) {
    return {
      mode: 'partial',
      patches: [{ rect: [patchX0, ink.y - padY, tailStart - padTail, ink.y + ink.height + padY], color: plain(item.background) }],
      images: [],
      texts: textOp()
    }
  }
  if (!ctx.allowShift) return { reason: dx > 0 ? 'stretch is wider than the old one' : 'stretch is much narrower than the old one' }
  if (item.align !== 'left') return { reason: 'aligned run cannot shift its tail' }
  const nextInk = nextRunInkRight(item, all)
  const limit = Math.min(nextInk ?? Infinity, pageWidth ? pageWidth - 12 : Infinity)
  if (inkRight + dx + 1 > limit) return { reason: 'tail would run into the next run' }
  // The tail's pixels, with a hair of paper on either side that copies no
  // old-span ink on the left and no neighbour's ink on the right.
  const padL = Math.min(1, Math.max(0.3, (oldSpan ? tailStart - oldSpan.x1 : gapAfter) / 2))
  const padR = Math.min(1.5, nextInk !== null ? Math.max(0, nextInk - inkRight) : 1.5)
  const src: RectT = [tailStart - padL, ink.y - padY, inkRight + padR, ink.y + ink.height + padY]
  const dst: RectT = [src[0] + dx, src[1], src[2] + dx, src[3]]
  return {
    mode: 'partial+shift',
    patches: [{ rect: [patchX0, ink.y - padY, Math.max(inkRight, inkRight + dx) + padX, ink.y + ink.height + padY], color: plain(item.background) }],
    images: [{ srcRect: src, dstRect: dst }],
    texts: textOp(dx)
  }
}

function plain(c: readonly number[] | undefined): [number, number, number] {
  return [Number(c?.[0] ?? 0), Number(c?.[1] ?? 0), Number(c?.[2] ?? 0)]
}
