import type { OcrTextItem } from './ocrTypes'
import type { RectT } from '@/engine/types'
import { cellStrokeRatio, expectedAdvance, type GlyphCutResult } from './glyphCut'
import type { LineWords } from './wordSeg'
import type { PatchOp, TextOp, ImageOp } from './ocrExport'
import { strokeWidthFor, tracedStrokeUpTo } from './ocrStroke'

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
  /**
   * One per NON-SPACE character of the original text, in reading order.
   * `weight` is the cell's stem over the em (`cellStrokeRatio`). `approx`: the
   * cell's word could not be cut, and the cell is that word's ink shared out
   * by expected advances — exact at the word's edges, a guess inside it.
   */
  cells: { char: string; x0: number; x1: number; suspect: boolean; weight?: number; approx?: boolean }[]
  /** Fitted ink baseline: y(x) = yAtCentre + slope * (x - centreX). */
  baseline: { yAtCentre: number; slope: number; centreX: number }
  /** The em the cut measured, in points. */
  emPt: number
  /** Median gap between adjacent letters of a word, and between words. */
  letterGapPt: number
  wordGapPt: number
  source: 'symbols' | 'profile' | 'tesseract' | 'words'
  /**
   * The line's ink WORDS (cells [from, to) each), when the span was built word
   * by word (`toSpanCutFromWords`). A word with `cut: false` holds approximate
   * cells; an edit whose edge falls inside it takes the whole word.
   */
  words?: { from: number; to: number; x0: number; x1: number; cut: boolean; err: number }[]
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
  /** The scan's measured stem over the em; the fallback glyphs of the stretch are stroked up to it. */
  strokeRatio?: number
  /** From `weightPlan`: characters the scan face must NOT draw for this stretch (their traced weight is the other half of the line's). */
  faceSkip?: string
  /** From `weightPlan`: the stretch's neighbours' weight over the line's median — scales `strokeRatio` to the local weight. */
  weightScale?: number
  /** From `weightPlan`: the base-14 face of the stretch's OWN weight, when it differs from the line's. */
  localFontName?: string
  /** From `weightPlan`: the median measured weight of the traced glyphs the stretch will use; they are stroked up to the scan's. */
  tracedStrokeRatio?: number
}

/** The face detector's bold threshold (ocrFontDetect.ts): stems over this share of the em are bold. */
const BOLD_STROKE = 0.115

/**
 * A line can change weight in the middle. "Conste por el presente documento
 * el CONTRATO DE "MEJORAMIENTO…"" is regular up to the quote and bold after
 * it, one OCR line, one face detection (bold — the heavier half has more
 * ink), and one scan face keyed by that style: the "S" typed into "CONTRATOS"
 * was traced from "SALA" in the bold half and drawn heavy inside a regular
 * word. Which weight the stretch should have is what its NEIGHBOURS say —
 * the cells on either side of the change, measured by `cellStrokeRatio` —
 * and a face glyph whose own cell weight disagrees with them is skipped
 * (the base-14 face then draws it, stroked to the neighbours' weight by
 * `weightScale` × the line's `strokeRatio`). Null when the cut carries no
 * weights or the neighbours cannot be measured.
 */
/**
 * How much heavier than its neighbours a letter's SHAPE makes it read on this
 * line: the median weight of its cells over the median of the three cells
 * either side of each. Null when the letter does not occur (unsuspect, with a
 * weight) or has no measurable context.
 */
export function letterBias(cells: SpanCut['cells'], ch: string): number | null {
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
  const own: number[] = [], ctx: number[] = []
  cells.forEach((c, i) => {
    if (c.char !== ch || c.suspect || !c.weight) return
    const around: number[] = []
    for (let k = Math.max(0, i - 3); k <= Math.min(cells.length - 1, i + 3); k++) {
      const o = cells[k]
      if (k !== i && o.char !== ch && !o.suspect && o.weight) around.push(o.weight)
    }
    if (around.length < 2) return
    own.push(c.weight)
    ctx.push(median(around))
  })
  if (!own.length) return null
  const b = median(own) / median(ctx)
  return b > 0 && Number.isFinite(b) ? b : null
}

export function weightPlan(
  item: OcrTextItem,
  cut: SpanCut,
  faceWeightOf?: (ch: string) => number | undefined,
  /** The face detector's stroke ratio over the run's ink between two page x's, or null when it cannot be measured. */
  measureRatio?: (x0: number, x1: number) => number | null
): { faceSkip: string; weightScale: number; bold: boolean | null; tracedRatio: number | null } | null {
  const st = stretchOf(item, cut)
  if (!st || !st.text) return null
  const cells = cut.cells
  const n = cells.length
  const weights = cells.filter(c => !c.suspect && c.weight).map(c => c.weight!)
  if (weights.length < 3) return null
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
  const lineMedian = median(weights)
  const near: number[] = []
  for (let i = st.prefix - 1, k = 0; i >= 0 && k < 3; i--, k++) { const c = cells[i]; if (c && !c.suspect && c.weight) near.push(c.weight) }
  for (let i = n - st.suffix, k = 0; i < n && k < 3; i++, k++) { const c = cells[i]; if (c && !c.suspect && c.weight) near.push(c.weight) }
  if (!near.length || !(lineMedian > 0)) return null
  const local = median(near)
  // One raster pixel of stem, in the ratio's units: the smallest step between
  // two distinct cell weights on this line.
  const distinct = [...new Set(weights.map(w => Math.round(w * 1e4)))].sort((a, b) => a - b)
  let quantum = Infinity
  for (let i = 1; i < distinct.length; i++) quantum = Math.min(quantum, (distinct[i] - distinct[i - 1]) / 1e4)
  if (!Number.isFinite(quantum)) quantum = 0
  let faceSkip = ''
  const tracedWeights: number[] = []
  if (faceWeightOf) {
    for (const ch of new Set([...st.text])) {
      if (ch === ' ') continue
      const w = faceWeightOf(ch)
      if (w === undefined) continue
      // The weight is a HORIZONTAL run over the em, so a diagonal stroke reads
      // wider than it is thick: an "A" measured 0.126 among a same-weight
      // title's "I"/"D" at 0.097, and the face's own A was skipped for a
      // Helvetica one. Where the letter occurs on this line its shape is
      // divided out against its own context there.
      const norm = w / (letterBias(cells, ch) ?? 1)
      // A third apart is a weight, not a measurement: regular and bold stems
      // differ by 60–70% of the regular one. And never on two pixels alone.
      const diff = Math.abs(norm - local)
      if (diff > local * 0.3 && diff > quantum * 2) faceSkip += ch
      else tracedWeights.push(w)
    }
  }
  const tracedRatio = tracedWeights.length ? median(tracedWeights) : null
  let weightScale = local / lineMedian
  // The base-14 face's weight follows the neighbours too. The per-cell ratios
  // above are quantised to a pixel of the em (0.036 at 9pt) and a thin letter
  // reads light whatever its weight, so they can say "different" but not
  // "bold". `measureRatio` is the face detector's OWN measurement over a
  // window of the line's ink — the six cells before the change and the six
  // after — on the same raster and threshold as the line's `strokeRatio`, so
  // it compares with the detector's calibrated bold bar directly. Without it
  // the verdict stays the line's (null).
  let bold: boolean | null = null
  if (measureRatio) {
    const windows: number[] = []
    const head = cells.slice(Math.max(0, st.prefix - 6), st.prefix).filter(c => !c.suspect)
    const tail = cells.slice(n - st.suffix, Math.min(n, n - st.suffix + 6)).filter(c => !c.suspect)
    // The side the stretch is GLUED to decides when only one is: an "S"
    // typed onto "CONTRATO" belongs to that word, and the bold quote that
    // follows the space after it says nothing about the S's weight.
    const sides = st.prefix > 0 && st.suffix > 0 && st.spaceBefore !== st.spaceAfter
      ? [st.spaceBefore ? tail : head]
      : [head, tail]
    for (const w of sides) {
      if (w.length < 2) continue
      const r = measureRatio(w[0].x0, w[w.length - 1].x1)
      if (r !== null && r > 0) windows.push(r)
    }
    if (windows.length) {
      const ratio = windows.reduce((s, x) => s + x, 0) / windows.length
      bold = ratio >= BOLD_STROKE
      if (item.strokeRatio) weightScale = ratio / item.strokeRatio
    }
  }
  return { faceSkip, weightScale, bold, tracedRatio }
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
  const cells = cut.cells.map(c => ({ char: c.char, x0: c.x0 * toPt, x1: c.x1 * toPt, suspect: !!c.suspect, weight: cellStrokeRatio(cut, c) ?? undefined }))
  const cx = cut.bin.x + cut.bin.w / 2
  const yAtCentre = cut.baselineAt(cx) * toPt
  const slope = (cut.baselineAt(cx + 100) - cut.baselineAt(cx)) / 100
  // Gaps, sorted into letter gaps and word gaps by whether the original text
  // has a space between the two characters.
  const letterGaps: number[] = [], wordGaps: number[] = []
  const chars = [...originalText]
  let cellIndex = -1
  let pendingSpace = false
  let prev: { x1: number; suspect: boolean; cjk: boolean } | null = null
  // An ideograph sits in a full em with air on both sides, so the gap between
  // two of them is several times a Latin letter gap. On "(承包商 Proveedor)"
  // three such gaps pulled the median letter gap to 4pt at 9pt, and a tail
  // shifted by that gap left a space inside "Provedor". Letter gaps are
  // measured between Latin neighbours only.
  const CJK_CHAR = /[　-鿿豈-﫿＀-￯]/
  for (const ch of chars) {
    if (ch === ' ') { pendingSpace = true; continue }
    cellIndex++
    const cell = cells[cellIndex]
    if (!cell) break
    const cjk = CJK_CHAR.test(ch)
    if (prev && !prev.suspect && !cell.suspect) {
      const gap = cell.x0 - prev.x1
      if (gap >= 0 && (pendingSpace || (!cjk && !prev.cjk))) (pendingSpace ? wordGaps : letterGaps).push(gap)
    }
    prev = { x1: cell.x1, suspect: cell.suspect, cjk }
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

/**
 * A line segmented into words (`segmentLine`) and cut word by word → the run's
 * span geometry in points. `cuts[k]` is the glyph cut of `lw.matches[k]`, or
 * null where that word could not be cut; its cells are then the word's ink
 * shared out by expected advances and marked `approx`.
 */
export function toSpanCutFromWords(lw: LineWords, cuts: (GlyphCutResult | null)[], toPt: number): SpanCut {
  const cells: SpanCut['cells'] = new Array(lw.chars.length)
  const words: NonNullable<SpanCut['words']> = []
  const letterGaps: number[] = []
  const ems: number[] = []
  lw.matches.forEach((m, k) => {
    const cut = cuts[k]
    const ok = !!cut && cut.cells.length === m.to - m.from
    words.push({ from: m.from, to: m.to, x0: m.ink.x0 * toPt, x1: m.ink.x1 * toPt, cut: ok, err: m.err })
    if (ok) {
      cut!.cells.forEach((c, i) => {
        cells[m.from + i] = { char: c.char, x0: c.x0 * toPt, x1: c.x1 * toPt, suspect: !!c.suspect, weight: cellStrokeRatio(cut!, c) ?? undefined }
        const prev = i > 0 ? cut!.cells[i - 1] : null
        if (prev && !prev.suspect && !c.suspect && c.x0 >= prev.x1) letterGaps.push((c.x0 - prev.x1) * toPt)
      })
      if (cut!.letterEmPx) ems.push(cut!.letterEmPx)
      return
    }
    const chars = lw.chars.slice(m.from, m.to)
    const total = chars.reduce((s, c) => s + expectedAdvance(c), 0) || 1
    let x = m.ink.x0
    chars.forEach((ch, i) => {
      const x1 = i === chars.length - 1 ? m.ink.x1 : x + (m.ink.x1 - m.ink.x0) * expectedAdvance(ch) / total
      cells[m.from + i] = { char: ch, x0: x * toPt, x1: x1 * toPt, suspect: false, approx: true }
      x = x1
    })
  })
  const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
  // The em: what the cut words' own letters measured, pooled — the line fit's
  // estimate only seeds the cuts.
  const emPx = ems.length >= 2 ? median(ems) : lw.fit.emPx
  return {
    cells,
    baseline: { yAtCentre: lw.fit.y * toPt, slope: lw.fit.slope, centreX: lw.fit.centreX * toPt },
    emPt: emPx * toPt,
    letterGapPt: letterGaps.length >= 3 ? median(letterGaps) : lw.split.letterGapPx * toPt,
    wordGapPt: lw.split.wordGapPx * toPt,
    source: 'words',
    words
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

/**
 * Whether the boundary BEFORE cell `k` (between cells k-1 and k) is known to
 * the pixel: the edge of a line, a gap between two ink words, or a join inside
 * a word that was cut. Inside a word that could not be cut, its cells are a
 * guess, and an edit there has to take the whole word.
 */
function boundaryKnown(cut: SpanCut, k: number): boolean {
  if (!cut.words || k <= 0 || k >= cut.cells.length) return true
  const w = cut.words.find(w => k > w.from && k < w.to)
  return !w || (w.cut && !cut.cells[k - 1].approx && !cut.cells[k].approx)
}

/**
 * What the edit changed, as the run's non-space characters see it. With a
 * word-built span (`cut.words`), an edge that falls inside a word that could
 * not be cut is moved out to that word's edge — the word is replaced whole.
 */
export function stretchOf(item: OcrTextItem, cut?: SpanCut | null): Stretch | null {
  const original = nonSpace(item.originalText)
  const edited = nonSpace(item.text)
  let { prefix, suffix } = commonAffix(original, edited)
  if (cut?.words && cut.cells.length === original.length) {
    const n = original.length
    if (!boundaryKnown(cut, prefix)) prefix = cut.words.find(w => prefix > w.from && prefix < w.to)!.from
    if (!boundaryKnown(cut, n - suffix)) suffix = n - cut.words.find(w => n - suffix > w.from && n - suffix < w.to)!.to
  }
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

/**
 * Whether the ORIGINAL text has a space right before its `prefix`-th non-space
 * character — i.e. whether the old span began a word gap after the head.
 * False when there is no such character (the edit appends).
 */
export function originalSpaceBefore(originalText: string, prefix: number): boolean {
  if (prefix <= 0) return false
  const o = [...originalText]
  let seen = 0
  for (let i = 0; i < o.length; i++) {
    if (o[i] === ' ') continue
    if (seen === prefix) return o[i - 1] === ' '
    seen++
  }
  return false
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

/**
 * A line's letter BAND over [x0, x1], as rectangles: `above` over the fitted
 * baseline and `below` under it, inside [clampTop, clampBottom].
 *
 * A long line of a skewed scan has an axis-aligned box far taller than its
 * letters (a 0.7° tilt over 470pt is 5.6pt of rise), and one rectangle over it
 * reaches into the line above at one end and the line below at the other — a
 * patch erased the lower half of the line above, and a moved tail carried the
 * tips of both neighbours along with it. Laid as a staircase of segments over
 * which the baseline moves by half a point at most, the band follows the
 * letters; each segment overlaps the last by a hair so no seam survives.
 */
export function bandRects(x0: number, x1: number, yAt: (x: number) => number, slope: number, above: number, below: number, clampTop: number, clampBottom: number): RectT[] {
  if (!(x1 > x0)) return []
  const segW = Math.abs(slope) > 1e-4 ? Math.max(8, 0.5 / Math.abs(slope)) : x1 - x0
  const n = Math.min(60, Math.max(1, Math.ceil((x1 - x0) / segW)))
  const step = (x1 - x0) / n
  const out: RectT[] = []
  for (let i = 0; i < n; i++) {
    const xa = x0 + i * step, xb = i === n - 1 ? x1 : x0 + (i + 1) * step
    const ya = Math.min(yAt(xa), yAt(xb)), yb = Math.max(yAt(xa), yAt(xb))
    const top = Math.max(clampTop, ya - above), bottom = Math.min(clampBottom, yb + below)
    if (bottom > top) out.push([i === 0 ? xa : xa - 0.15, top, xb, bottom])
  }
  return out
}

/**
 * Whether the boundary in front of `words[k]` sits one letter off the ink.
 *
 * A word's width against what its letters take is no test on its own: a
 * display face is wider or narrower than the advance table letter by letter —
 * the "U" and "N" of a wide techno "UNAJMA" each measured half again what the
 * table expects, and its words were split right. A letter on the wrong side
 * of a boundary shows as a PAIR: one word too wide by about a letter, the next
 * too narrow by the same, and both fit once that letter crosses over (the
 * "NAPOLEON | HILL" split 0.12 and 0.30 off, 0.01 and 0.05 with the "H"
 * moved). A word the glyph cut took apart has its letters counted, and gives
 * none up.
 */
function boundaryOffByOne(words: NonNullable<SpanCut['words']>, chars: string[], k: number): boolean {
  const a = words[k - 1], b = words[k]
  if (!a || !b || a.to !== b.from || (a.cut && b.cut)) return false
  const adv = (from: number, to: number) => { let t = 0; for (let i = from; i < to; i++) t += expectedAdvance(chars[i]); return t }
  let ink = 0, want = 0
  for (const w of words) { ink += w.x1 - w.x0; want += adv(w.from, w.to) }
  if (!(want > 0) || !(ink > 0)) return false
  const s = ink / want
  const err = (w: number, e: number) => Math.abs(w - s * e) / Math.max(s * e, 1e-6)
  const wa = a.x1 - a.x0, wb = b.x1 - b.x0, ea = adv(a.from, a.to), eb = adv(b.from, b.to)
  const now = Math.max(err(wa, ea), err(wb, eb))
  if (now < 0.2) return false
  const moved: number[] = []
  if (!a.cut && a.to - a.from > 1) { const c = expectedAdvance(chars[a.to - 1]); moved.push(Math.max(err(wa, ea - c), err(wb, eb + c))) }
  if (!b.cut && b.to - b.from > 1) { const c = expectedAdvance(chars[b.from]); moved.push(Math.max(err(wa, ea + c), err(wb, eb - c))) }
  return moved.some(m => m < now * 0.5)
}

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
  const st = stretchOf(item, cut)
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
  // An edit whose edge falls inside a word the cut could not take apart takes
  // that whole word (`stretchOf`), so the edges sit on ink-word boundaries —
  // and a boundary is only where the letters part if the reading's letters
  // were shared among the ink words correctly. On a condensed cover title the
  // ink split fell between the "H" and the "I" of "HILL", the "H" was counted
  // with "NAPOLEON", and the patch over the edited word erased it.
  if (cut.words && cut.words.some((w, k) => k > 0 && (w.from === prefix || w.from === n - suffix) && boundaryOffByOne(cut.words!, original, k))) {
    return { reason: "the line's words do not fit its ink" }
  }

  const sizePt = sizeOf(item, cut)
  const bearing = sizePt * 0.05
  const headEnd = prefix > 0 ? cells[prefix - 1].x1 : ink.x
  const tailStart = suffix > 0 ? cells[n - suffix].x0 : null
  const oldSpan = changed.to > changed.from ? { x0: cells[changed.from].x0, x1: cells[changed.to - 1].x1 } : null
  const inkRight = ink.x + ink.width
  const gapBefore = st.spaceBefore ? cut.wordGapPt : cut.letterGapPt
  const gapAfter = st.spaceAfter ? cut.wordGapPt : cut.letterGapPt

  const width = st.text.length ? (ctx.stretchWidthPt ?? 0) : 0
  // The old span's first letter is where the stretch starts only while the
  // boundary keeps its kind. "USUARIO DESIGNADO" → "USUARIOS DESIGNADOS"
  // replaces " DESIGNADO" with "S DESIGNADOS": the old span began a WORD gap
  // after the head, the new one is glued to it, and starting at the old "D"
  // drew "USUARIO S DESIGNADOS". Where the space came or went, the pen starts
  // from the head by the gap the NEW text asks for.
  const penX = oldSpan && (prefix === 0 || st.spaceBefore === originalSpaceBefore(item.originalText, prefix))
    ? oldSpan.x0 - bearing
    : (prefix > 0 ? headEnd + gapBefore - bearing : ink.x - bearing)
  const inkEnd = st.text.length ? penX + width - bearing : headEnd
  // The fitted baseline is a LINE, and the redraw follows it: a stretch laid
  // level from its start drifts off a tilted scan's line by slope x width -
  // on the SEIDOR appendix, redrawing most of a 460pt line left the untouched
  // tail 'el "Contrato"). Este Apéndice se emite' visibly above the text before
  // it. Every part of the group is rotated by the line's own angle and placed
  // on the line at its own x; a tilt under a twentieth of a degree is level.
  const yAt = (x: number) => cut.baseline.yAtCentre + cut.baseline.slope * (x - cut.baseline.centreX)
  const tiltDeg = -Math.atan(cut.baseline.slope) * 180 / Math.PI
  const rotation = Math.abs(tiltDeg) < 0.05 ? 0 : tiltDeg
  const baselineY = yAt(penX)
  // The patch reaches at least as far as the ink measured OUTSIDE the box
  // (an accent, a blurred fringe — `item.halo`), on the vertical axis where
  // the head and tail cannot object; horizontally the pads stay tight, since
  // a neighbouring word is what lies past the box's ends.
  const halo = item.halo
  const padTop = Math.max(1, ink.height * 0.12, (halo?.top ?? 0) + 0.5)
  const padBottom = Math.max(1, ink.height * 0.12, (halo?.bottom ?? 0) + 0.5)
  const padX = Math.max(1, ink.height * 0.15)
  const padHead = prefix > 0 ? Math.min(1, Math.max(0.4, gapBefore / 2)) : padX
  const patchX0 = prefix > 0 ? headEnd + padHead : ink.x - padX
  // Patches and moved tails cover the letter band along the baseline, not the
  // box (`bandRects`): an em above it for capital accents, a third below for
  // descenders, plus the halo — and never more than the box.
  const above = cut.emPt + 0.6 + (halo?.top ?? 0)
  const below = cut.emPt * 0.35 + 0.6 + (halo?.bottom ?? 0)
  const boxTop = ink.y - padTop, boxBottom = ink.y + ink.height + padBottom
  const band = (x0: number, x1: number) => bandRects(x0, x1, yAt, cut.baseline.slope, above, below, boxTop, boxBottom)
  const patchesOver = (x0: number, x1: number, paint?: boolean): PatchOp[] =>
    band(x0, x1).map(rect => ({ rect, color: plain(item.background), item: item.id, ...(paint === undefined ? {} : { paint }) }))

  // The words the scan keeps drawing are put back into the page as INVISIBLE
  // text at their own positions (render mode 3), so the line still extracts,
  // copies and searches as one line; otherwise only the stretch would be text.
  const t = [...item.text]
  const positions: number[] = []
  t.forEach((c, i) => { if (c !== ' ') positions.push(i) })
  const edited = nonSpace(item.text)
  const headText = prefix > 0 ? t.slice(0, positions[prefix - 1] + 1).join('').trim() : ''
  const tailText = suffix > 0 ? t.slice(positions[edited.length - suffix]).join('').trim() : ''
  // On the fitted line, at the group's shared rotation. Laid LEVEL, each at
  // its own point of the line, a scan tilted by 0.7° put the head's baseline
  // 0.8pt from the stretch's sixty points away and the extractor read a step
  // that size as two lines ("X" listed before "Las partes que"); on one
  // rotated line the parts are collinear, which is what reads as one line.
  const invisible = (text: string, x: number, fitWidth: number): TextOp[] => text ? [{
    text, x, y: rotation ? yAt(x) : baselineY, fontSize: sizePt,
    fontName: ctx.fontName, color: ctx.color, rotation, invisible: true, group: item.id, fitWidth
  }] : []
  // An extractor puts a SPACE wherever one glyph's advance ends a sixth of an
  // em or more before the next begins. The invisible head is fitted to its
  // ink, the stretch is placed a letter gap after that ink, and a scanned
  // face's letter gap at 9pt is 2pt — "MSP-SIST-CS-2026-777" read back as
  // "202 6-777". Where the text has NO space at the boundary, the invisible
  // run is stretched (or started) to within a hair of the stretch, so the
  // extracted advances meet; where it has one, the gap is left to say so.
  const HAIR = 0.3
  const stretchEnd = st.text.length ? penX + width : null
  const textOp = (tailShift = 0): TextOp[] => {
    const headX = cells[0].x0 - bearing
    const joinHead = headText && !st.spaceBefore && (stretchEnd !== null || tailStart !== null)
    const headTo = joinHead
      ? (st.text.length ? penX : tailStart! + tailShift - bearing) - HAIR
      : headEnd + bearing
    const tailX = tailStart !== null
      ? (!st.spaceAfter && stretchEnd !== null ? Math.min(tailStart + tailShift - bearing, stretchEnd + HAIR) : tailStart + tailShift - bearing)
      : null
    return [
      ...invisible(headText, headX, Math.max(1, headTo - headX)),
      ...(st.text.length ? [{
        text: st.text, x: penX, y: baselineY, fontSize: sizePt,
        fontName: ctx.fontName, color: ctx.color, rotation, faceId: ctx.faceId, group: item.id,
        strokeWidth: strokeWidthFor(ctx.strokeRatio ? ctx.strokeRatio * (ctx.weightScale ?? 1) : undefined, ctx.fontName, sizePt),
        tracedStrokeWidth: tracedStrokeUpTo(ctx.strokeRatio ? ctx.strokeRatio * (ctx.weightScale ?? 1) : undefined, ctx.tracedStrokeRatio, sizePt),
        faceSkip: ctx.faceSkip || undefined
      } as TextOp] : []),
      ...(tailX !== null ? invisible(tailText, tailX, inkRight + tailShift - tailX) : [])
    ]
  }

  if (tailStart === null) {
    // No tail: an append or a deletion at the end. The stretch may grow past
    // the old ink but not into the next run or off the page - there the
    // whole-run redraw's `fitSize` is the right tool.
    const limit = Math.min(nextRunInkRight(item, all) ?? Infinity, pageWidth ? pageWidth - 12 : Infinity)
    if (inkEnd > limit) return { reason: 'stretch would run into the next run' }
    return {
      mode: 'partial',
      // A pure append covers no old ink — nothing to paint. On a textured
      // ground (an identity card's strip) a flat patch there showed as a block
      // behind the new letters, and it hid nothing. The rectangle is still
      // reported (`paint: false`) so the run's box grows to the new letters.
      patches: patchesOver(patchX0, Math.max(inkRight, inkEnd) + padX, !!oldSpan),
      images: [],
      texts: textOp()
    }
  }

  const newTail0 = (st.text.length ? inkEnd : headEnd) + gapAfter
  const dx = newTail0 - tailStart
  const padTail = Math.min(1, Math.max(0.4, gapAfter / 2))
  // Fits when the tail keeps at least 40% of the gap before it (a word gap
  // closing from 6.5pt to 4 is invisible; a letter gap of 1.6pt yields a
  // pixel), or opens by up to a space's worth — BETWEEN words. Inside a word
  // a gap of a letter's width reads as a typo: deleting the "e" of
  // "presente" left "pres nte" on the page, and extraction put a space in
  // it. There the tail may open by a letter gap and a hair, no more; past
  // that it is shifted onto the vacated ink.
  const insideWord = prefix > 0 && suffix > 0 && !st.spaceBefore && !st.spaceAfter
  const mayOpen = insideWord ? cut.letterGapPt * 1.5 + TOUCH_PT : 0.6 * sizePt
  if (dx <= Math.max(TOUCH_PT, gapAfter * 0.6) && dx >= -mayOpen) {
    return {
      mode: 'partial',
      // An insertion the tail absorbs in place covers only the gap's paper.
      patches: patchesOver(patchX0, tailStart - padTail, !!oldSpan),
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
  // Along the line, not level: moved dx to the right on a tilted scan the
  // tail's pixels must also move by slope x dx, or they leave its line. Moved
  // as band segments, so the neighbours' tips stay where they are.
  const dy = cut.baseline.slope * dx
  const images: ImageOp[] = band(tailStart - padL, inkRight + padR)
    .map(src => ({ srcRect: src, dstRect: [src[0] + dx, src[1] + dy, src[2] + dx, src[3] + dy] as RectT, item: item.id }))
  return {
    mode: 'partial+shift',
    patches: patchesOver(patchX0, Math.max(inkRight, inkRight + dx) + padX),
    images,
    texts: textOp(dx)
  }
}

function plain(c: readonly number[] | undefined): [number, number, number] {
  return [Number(c?.[0] ?? 0), Number(c?.[1] ?? 0), Number(c?.[2] ?? 0)]
}
