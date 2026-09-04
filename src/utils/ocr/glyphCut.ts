import type { OcrBox } from './ocrEngine'
import { clearRuleSpans } from './inkMeasure'

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
  /** Canvas y of the baseline at the box's centre — fitted through the cell bottoms, descenders excluded. */
  baselineY: number
  /**
   * The baseline at canvas x. A scanned line is rarely level: on a title 677px
   * wide the letter bottoms drifted four rows from left to right, and one
   * baseline for the lot set the left-hand glyphs two pixels low and the
   * right-hand ones two high — a ragged line drawn from perfectly good ink.
   */
  baselineAt: (x: number) => number
  /** Em in canvas pixels. */
  emPx: number
  /** Threshold used, so the tracer binarises the same way. */
  threshold: number
  /** Light glyphs on a dark ground — the tracer must flip the bitmap too. */
  inverted: boolean
  /**
   * The binarised box the cut was made on — rules and their fragments already
   * cleared, light-on-dark already flipped. The tracer takes its cell bitmaps
   * from HERE, never from the pixels again: re-reading them put the crumbs of a
   * cleared border fragment back on top of the letters under it, and a title
   * came out with a bar over its J, E and T.
   */
  bin: { x: number; y: number; w: number; h: number; ink: Uint8Array }
}

interface Bin { x: number; y: number; w: number; h: number; ink: Uint8Array; threshold: number; inverted: boolean }

/** Why the last cut was refused — for the sweep, which counts the reasons. */
let refusedBecause = ''
export function lastCutReason(): string { return refusedBecause }
function refuse(why: string): null { refusedBecause = why; return null }

const DESCENDER_CHARS = /[gjpqyQ,;()\[\]{}]/
const CJK = /[\p{Script=Han}　-〿＀-￯]/u

function binarise(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, ruleSpan: number, ruleThick: number): Bin | null {
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
  // And a rule that crosses only PART of the box — a skewed border clipping
  // one corner. It fused the first seven letters of a title into one ink run
  // (see `clearRuleSpans`), which is the misalignment the sliver test below
  // then refuses; better not to be misaligned at all. The bar is two and a
  // half ems guessed from the text's expected advances — no glyph, CJK
  // included, runs that wide, and a pair of fused bold letters does not either.
  clearRuleSpans(ink, w, h, ruleSpan, ruleThick)
  return { x, y, w, h, ink, threshold, inverted }
}

/**
 * Expected width of a character as a fraction of the em.
 *
 * CJK punctuation is deliberately NOT given a narrower expectation. Its cell
 * is a full em with the mark in one corner, so a third of an em looks like
 * the honest number — measured, it moved one of this corpus's Chinese lines
 * from traced to refused ("7 of 33 cells suspect") and fixed none, because
 * the profile merges a comma into its neighbour's run as often as it reports
 * it alone. The uniform 0.95 is what the corpus supports.
 */
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
  const emGuess = rect.width / Math.max(1, chars.reduce((s, c) => s + expectedAdvance(c), 0))
  const bin = binarise(ctx, rect, emGuess * 2.5, Math.max(4, Math.round(emGuess * 0.25)))
  if (!bin) return refuse('blank or unreadable box')
  refusedBecause = ''

  const cjk = chars.filter(c => CJK.test(c)).length * 2 >= chars.length
  // The same ratios `boxPerEm` in useOCR uses: a letter descender makes the
  // box 0.95 of an em, punctuation alone (a comma, a parenthesis) 0.85.
  const emPx = bin.h / (cjk ? 0.92 : chars.some(c => /[gjpqyQ]/.test(c)) ? 0.95 : chars.some(c => DESCENDER_CHARS.test(c)) ? 0.85 : 0.76)

  let cells: GlyphCell[] | null = null
  if (symbols && symbols.length === chars.length) {
    // An engine's glyph boxes are vetted like a profile cut: Tesseract's box
    // for a touching pair can straddle the join, and a wrong shape under a
    // letter is the one outcome worse than no trace.
    cells = vetCells(bin, symbols.map((s, i) => ({ char: chars[i], x0: Math.round(s.x0), x1: Math.round(s.x1) })), chars)
    // And with NO suspect cell at all. Engine boxes admitted at the profile
    // cut's fifth traced a 6-letter "MINERA" as nonsense (re-read similarity
    // 0) and a 4.7pt watermark at 0.67 on the corpus, against one good line;
    // a box that straddles a join fails the width test, and one such box
    // means the engine misread the run's segmentation.
    if (cells && cells.some(c => c.suspect)) return refuse(`${cells.filter(c => c.suspect).length} of ${cells.length} engine boxes suspect`)
  } else {
    cells = cutByProfile(bin, chars, emPx, cjk)
  }
  if (!cells) return null

  const base = baselineOf(bin, cells)
  const centreX = bin.x + bin.w / 2
  const baselineAt = (x: number) => base.y + base.slope * (x - centreX)
  // The em from the LETTERS when they can say: the box's height is what a rule
  // crossing it or a neighbour's tips inflate, and an em taken from a box 82
  // rows tall around letters 46 rows high made the traced glyphs half an em
  // and a fallback "C" beside them a giant. A capital is about 0.72 em, an
  // x-height letter about 0.52; the median over the trusted cells of either
  // class is the line's own measure. CJK keeps the box rule - an ideograph
  // fills its em.
  const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
  const heightOf = (c: GlyphCell) => { const e = cellExtent(bin, c); return e.top < 0 ? 0 : e.bottom - e.top + 1 }
  const caps = cjk ? [] : cells.filter(c => !c.suspect && TALL_CHARS.test(c.char)).map(heightOf).filter(h => h > 2)
  const xs = cjk ? [] : cells.filter(c => !c.suspect && X_HEIGHT_CHARS.test(c.char)).map(heightOf).filter(h => h > 2)
  const letterEm = caps.length >= 2 ? median(caps) / 0.72 : xs.length >= 3 ? median(xs) / 0.52 : null
  const em = letterEm !== null && letterEm > 4 ? letterEm : emPx
  return { cells, baselineY: base.y, baselineAt, emPx: em, threshold: bin.threshold, inverted: bin.inverted, bin: { x: bin.x, y: bin.y, w: bin.w, h: bin.h, ink: bin.ink } }
}

function cutByProfile(bin: Bin, chars: string[], emPx: number, cjk = false): GlyphCell[] | null {
  // Excluding fully-inked ROWS here (the rule `inkMeasure` applies on the axis
  // a rule crosses) was tried and reverted: measured on the two documents that
  // report "1 runs for N characters" — a letterhead's company name and a 73pt
  // heading — neither box contains a rule and neither refusal changed. Whatever
  // fuses those columns, it is not an underline.
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
  // A one-column run is a speck, not a glyph: at OCR resolution the thinnest
  // stem is two pixels. The fringe of a cell border at the very edge of the
  // box left one such column, it took the last cell, and "…de MSP" was refused
  // as misaligned on the strength of a one-pixel "P".
  if (runs.length > 1) {
    const kept = runs.filter(r => r.x1 - r.x0 > 1)
    if (kept.length) runs.splice(0, runs.length, ...kept)
  }
  const target = chars.length
  // Letters that mostly TOUCH cannot be cut by profile: an italic serif
  // footer gave 69 characters in far fewer ink runs, and however the runs were
  // shared out, every second cell held the wrong letter. Tesseract's glyph
  // boxes are the only honest cut for such a line; without them, refuse.
  if (runs.length < target * 0.6) return refuse(`letters touch (${runs.length} runs for ${target} characters)`)
  // An IDEOGRAPH is drawn as separated radicals: 报 is two, 遗 two or three,
  // and the column profile reports each as its own run. A Chinese line
  // therefore arrives with one and a half to two runs per character — 66 for
  // 44 — and the Latin budget of a third refused every CJK line on the page,
  // so a scanned Chinese memo could never be redrawn in its own face. Merging
  // is the safe direction (it only ever joins ADJACENT pieces, smallest gap
  // first) and a CJK cell is close to square, so a wrong merge shows up as a
  // width outlier in the suspect check below. Two merges per character covers
  // a three-part ideograph.
  const budget = cjk ? Math.max(1, target * 2) : Math.max(1, Math.round(target * 0.35))
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
      // Not AT the proportional point but at the emptiest column near it. Two
      // letters that touch ("EJ" on a scanned title, one 20px run) are not
      // split by their advances: "E" is the wider of the pair, so the halfway
      // cut fell three columns inside it and the "J" cell carried the ends of
      // the E's bars into the face — the J then drew with a bar on top. The
      // join between two letters is a column with little ink; look for it
      // within a fifth of an em either side.
      const x1 = k === held.length - 1 ? r.x1 : splitAt(cols, x + w, x, r.x1, emPx)
      cells.push({ char: c, x0: bin.x + Math.round(x), x1: bin.x + Math.round(x1) })
      x = x1
    })
  }
  return vetCells(bin, cells, chars)
}

/**
 * The checks every cut has to pass, whoever made the cells — the column
 * profile or an engine's own glyph boxes. Cells that fail are marked suspect
 * (never traced); a run with too many of them, or a sliver at an end, is
 * refused whole.
 */
function vetCells(bin: Bin, cells: GlyphCell[], chars: string[]): GlyphCell[] | null {
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
    // `expectedAdvance` is an ADVANCE; a thin letter's ink is a third of it (a
    // sans "I" is a three-pixel stem against a want of eight), so a thin cell
    // is only suspect for being too WIDE. Narrow is what it is meant to be.
    const thinChar = /[iljtfrI.,;:'!|1]/.test(c.char)
    const off = thinChar ? Math.max(0, got - want) : Math.abs(got - want)
    if (off > Math.max(3, want * 0.4) || got < 2) { c.suspect = true; suspects++ }
  }
  // And each cell's SHAPE against its letter: a cell shifted by one letter
  // keeps a plausible width, which is how "República" came back reading
  // "Rpúbbiica". An x-height letter must neither rise nor descend, a
  // descender must descend, an ascender or a capital must rise — measured
  // against the run's own x-height and baseline.
  suspects += flagByShape(bin, cells)
  // A cell a THIRD of what its letter needs is not a narrow glyph, it is a
  // MISALIGNMENT - and one misaligned cell means every cell after it holds the
  // wrong ink. A bilingual contract's ALL-CAPS title cut as
  //   "M"[696-698] "E"[702-717] "J"[717-732] ... "M"[776-796]
  // - the first M two pixels wide against twenty for the same letter later,
  // because an extra ink run at the left edge (a table rule) took a cell.
  // Only 6 of 39 cells were flagged, under the one-fifth bar, so the run was
  // traced and every glyph the face learned came from the letter NEXT to it:
  // the line rendered as "QRAI MIEJOR MNIIEIIC TAI DR IIIFORNAEDRUEROR" while
  // still EXTRACTING as its correct text - which is what makes it so confusing
  // to report, since copy and search say the document is fine while the page
  // is unreadable.
  //
  // The shape check cannot see this on an all-caps line: every letter is a
  // capital of the same height, so a one-letter shift keeps every shape
  // plausible. Width against the letter's OWN expectation is the signal that
  // survives, and `expectedAdvance` already gives i/l/. a third of an em, so a
  // legitimately narrow glyph is not caught by it.
  //
  // At an END only. A shift happens when something extra at one EDGE of the box
  // takes a cell: everything moves along by one and the cell at that edge is
  // left a sliver. A sliver in the MIDDLE is a different thing - a broken
  // letter, a thin glyph the profile clipped - and it costs one glyph, which
  // the suspect flag already keeps out of the face. Measured on the 14-document
  // OCR corpus, 71 edits: refusing on ANY sliver, or on any grossly wrong width
  // either way, took tracing from 25 runs to 20 with 19 refusals; the end test
  // alone keeps 24 with 7 refusals, the reported title among them. All three
  // variants read back 69 of 71 edits, so the traces lost were pure fidelity.
  //
  // A THIN character at an end says nothing. `expectedAdvance` gives "." and
  // "i" three tenths of an em, which is their ADVANCE; their ink is a tenth,
  // so a full stop at the end of "sin incluir IGV." measured three pixels
  // against a want of nine and read as a sliver — and every sentence on the
  // page, ending as sentences do, was refused. Where the end cell is thin the
  // test is skipped; a misaligned cut still shows up wherever the end cell is
  // a letter with a body ("M" two pixels wide against twenty).
  // CJK punctuation is thin too: "）" and "。" take a full-em advance and put
  // a few pixels of ink in one corner of it, so a Chinese line ending as most
  // do ("…不含增值税。") read as misaligned every time.
  const thin = /[iljtfrI.,;:'!|1（）「」『』【】《》〈〉、。，；：！？·]/
  const sliver = (i: number) => {
    const c = cells[i]
    if (thin.test(c.char)) return false
    const want = expectedAdvance(c.char) / totalE * totalW
    return want > 2 && (c.x1 - c.x0) < want * 0.35
  }
  if (cells.length > 2 && (sliver(0) || sliver(cells.length - 1))) {
    return refuse('the first or last cell is a sliver — the cut is misaligned')
  }
  // A fifth: suspect cells are never traced anyway, so the bar is about
  // whether the REST can be trusted. Measured on 22 files, honest runs came
  // back with 2 of 18 or 2 of 15 suspect (a comma, an accent) and were being
  // refused whole at a tenth; the shifted italic footer was 16 of 69.
  // A fifth OR MORE. "AV. REPUBLICA DE CHILE Nº 262,08 (OCTAVO PISO)- JESUS
  // MARIA" on the RJ notice cut to exactly 10 of 50 suspect and, admitted, drew
  // as a jumble of half-height capitals: its box takes in the bottom rows of
  // the bold line touching it above, so the em is inflated and every cell
  // carries a sliver of the neighbour. At the bar is not under it.
  if (suspects >= cells.length * 0.2) return refuse(`${suspects} of ${cells.length} cells suspect`)
  // The letters must FILL their box. A Latin line's glyph rows are at least
  // three quarters of a tight box; a box holding a rule that crosses it, or a
  // neighbour the trim could not strip, is far taller than its letters, the
  // em taken from it is inflated, and the traced glyphs draw at half size
  // beside any fallback glyph at full size (a 35pt underlined title with a
  // tilted rule through its top: letters 46 rows in a box of 82). Better the
  // whole run in the fallback face.
  // Judged on the SECOND-tallest cell: the tallest may be the one holding
  // the foreign ink, and on a line of x-height letters the tallest cells are
  // the few with ascenders - the box is only as tall as they are.
  const heights = cells.filter(c => !c.suspect).map(c => { const e = cellExtent(bin, c); return e.top < 0 ? 0 : e.bottom - e.top + 1 }).filter(h => h > 0).sort((a, b) => b - a)
  if (heights.length >= 3 && heights[1] < bin.h * 0.55) {
    return refuse('the box is far taller than its letters')
  }
  return cells
}

/**
 * The column to cut a fused run at: the one with the least ink within a fifth
 * of an em of `want`, ties going to the nearer. Kept a pixel or more inside
 * (`lo`, `hi`) so neither side is left empty.
 */
function splitAt(cols: Uint16Array, want: number, lo: number, hi: number, emPx: number): number {
  const win = Math.max(2, Math.round(emPx * 0.2))
  const from = Math.max(Math.ceil(lo) + 1, Math.round(want) - win)
  const to = Math.min(Math.floor(hi) - 1, Math.round(want) + win)
  if (from > to) return want
  let best = Math.round(want), bestInk = Infinity
  for (let xx = from; xx <= to; xx++) {
    const ink = cols[xx]
    if (ink < bestInk || (ink === bestInk && Math.abs(xx - want) < Math.abs(best - want))) { bestInk = ink; best = xx }
  }
  return best
}

const X_HEIGHT_CHARS = /^[aceimnorsuvwxzáéíóúñäëïöüàèìòùâêîôû]$/
const ASCENDER_CHARS = /^[bdfhklt]$/
const DESCENDER_ONLY = /^[gpqy]$/
const TALL_CHARS = /^[A-Z0-9ÁÉÍÓÚÑ]$/

/**
 * A cell's top and bottom ink rows (bin-relative), where a row COUNTS only
 * with a few pixels in it: at least two, and a sixth of the cell's densest
 * row. Any single pixel used to set the bottom, and the anti-aliased fringe
 * of an underline puts one or two under most letters of a line — every cell
 * then ended in the fringe, the baseline was fitted through it three rows
 * below the letters, and the traced glyphs hung above their own baseline
 * with the fringe attached as feet.
 */
function cellExtent(bin: Bin, c: GlyphCell): { top: number; bottom: number } {
  const x0 = Math.max(0, c.x0 - bin.x), x1 = Math.min(bin.w, c.x1 - bin.x)
  const rows = new Uint16Array(bin.h)
  let densest = 0
  for (let yy = 0; yy < bin.h; yy++) {
    let n = 0
    for (let xx = x0; xx < x1; xx++) n += bin.ink[yy * bin.w + xx]
    rows[yy] = n
    if (n > densest) densest = n
  }
  const min = Math.max(2, Math.ceil(densest / 6))
  let top = -1, bottom = -1
  for (let yy = 0; yy < bin.h; yy++) if (rows[yy] >= min) { if (top < 0) top = yy; bottom = yy }
  return { top, bottom }
}

/** Mark cells whose ink extent contradicts their letter's class; returns how many. */
function flagByShape(bin: Bin, cells: GlyphCell[]): number {
  // Extents are measured against the line's TILT, not the page's rows: on a
  // scan whose baseline drifts four rows across the box, a capital "S" read as
  // "s" at the low end sat two rows lower than the level median expected and
  // its rise came out 0.27 - under the bar - so a cap-height shape went into
  // the face as the lowercase letter, and every "s" on the line drew as "S".
  const line = baselineOf(bin, cells)
  const centreX = bin.x + bin.w / 2
  const extents = cells.map(c => {
    const { top, bottom } = cellExtent(bin, c)
    if (top < 0) return { top, bottom }
    const tilt = line.slope * ((c.x0 + c.x1) / 2 - centreX)
    return { top: top - tilt, bottom: bottom - tilt }
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

/**
 * The baseline: a LINE fitted through where the non-descending glyphs end,
 * given as its height at the box's centre and its slope. The median alone
 * used to serve, and on a level scan it still would — but a tilted line puts
 * every glyph's bottom a little further from the median the further it sits
 * from the middle, and the traced face then carried that offset into each
 * glyph. Fitted by least squares with the outliers (a broken letter, a comma
 * that slipped past the descender test) dropped once and the fit remade.
 */
function baselineOf(bin: Bin, cells: GlyphCell[]): { y: number; slope: number } {
  const pts: { x: number; y: number }[] = []
  for (const c of cells) {
    if (DESCENDER_CHARS.test(c.char)) continue
    const e = cellExtent(bin, c)
    if (e.bottom >= 0) pts.push({ x: (c.x0 + c.x1) / 2, y: bin.y + e.bottom + 1 })
  }
  const centreX = bin.x + bin.w / 2
  if (!pts.length) return { y: bin.y + bin.h, slope: 0 }
  const median = (vals: number[]) => { const s = [...vals].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
  const fit = (p: { x: number; y: number }[]) => {
    if (p.length < 3) return { y: median(p.map(q => q.y)), slope: 0 }
    let sx = 0, sy = 0, sxx = 0, sxy = 0
    for (const q of p) { const dx = q.x - centreX; sx += dx; sy += q.y; sxx += dx * dx; sxy += dx * q.y }
    const n = p.length
    const denom = n * sxx - sx * sx
    if (Math.abs(denom) < 1e-6) return { y: median(p.map(q => q.y)), slope: 0 }
    const slope = (n * sxy - sx * sy) / denom
    return { y: (sy - slope * sx) / n, slope }
  }
  let line = fit(pts)
  const kept = pts.filter(q => Math.abs(q.y - (line.y + line.slope * (q.x - centreX))) <= 1.5)
  if (kept.length >= 3 && kept.length < pts.length) line = fit(kept)
  // A slope steeper than a few degrees is not a scan's tilt; fall back to level.
  if (Math.abs(line.slope) > 0.05) line = { y: median(pts.map(q => q.y)), slope: 0 }
  return line
}

/**
 * Binarised ImageData of one cell, black ink on white, for the tracer — sliced
 * from the cut's own cleaned bitmap (`cut.bin`), the full height of the box
 * plus `pad` white pixels all round. `x`/`y` are the bitmap's origin in canvas
 * pixels, which is what the outline is placed by.
 */
export function cellBitmap(
  cut: Pick<GlyphCutResult, 'bin'> & Partial<Pick<GlyphCutResult, 'cells' | 'baselineAt' | 'emPx'>>,
  cell: GlyphCell,
  pad = 1
): { image: ImageData; x: number; y: number } | null {
  const { bin } = cut
  const x = cell.x0 - pad, y = bin.y - pad
  const w = cell.x1 - cell.x0 + pad * 2
  const h = bin.h + pad * 2
  if (w < 2 || h < 2) return null
  // A letter that does not descend has no ink below the baseline, so nothing
  // below it belongs to the glyph: an underline touching the letter bottoms
  // put a piece of its fringe under the "M" and a comma-shaped foot under the
  // "R" of a heavy 35pt line, connected to the letters and so beyond any
  // speck rule. Only a descending character keeps what hangs below.
  // The fitted baseline is the first row BELOW the letter bottoms, so the cut
  // is at the baseline itself; an overshoot (the foot of an "O") costs a pixel.
  const floor = cut.baselineAt && cut.emPx && !DESCENDER_CHARS.test(cell.char)
    ? cut.baselineAt((cell.x0 + cell.x1) / 2) - 0.5
    : Infinity
  const on = new Uint8Array(w * h)
  for (let yy = 0; yy < h; yy++) {
    const by = yy - pad
    if (y + yy > floor) continue
    for (let xx = 0; xx < w; xx++) {
      const bx = x + xx - bin.x
      on[yy * w + xx] = (by >= 0 && by < bin.h && bx >= 0 && bx < bin.w && bin.ink[by * bin.w + bx] === 1) ? 1 : 0
    }
  }
  // Where this cell TOUCHES its neighbour (a fused pair split by profile or by
  // an engine's boxes) the boundary column is ambiguous, and the part of the
  // neighbour's stroke that lands on this side of it is connected to this
  // glyph's ink, so no component test can tell it apart. The edge is eroded
  // instead: one to three columns on the touching side, which costs a sliver
  // off a stem and removes the "I" drawn with a piece of the "N" beside it.
  const cells = (cut as GlyphCutResult).cells
  if (cells) {
    const i = cells.indexOf(cell)
    const k = Math.max(1, Math.min(3, Math.round((cell.x1 - cell.x0) * 0.08)))
    const touchesLeft = i > 0 && cell.x0 - cells[i - 1].x1 <= 1
    const touchesRight = i >= 0 && i + 1 < cells.length && cells[i + 1].x0 - cell.x1 <= 1
    for (let yy = 0; yy < h; yy++) {
      if (touchesLeft) for (let xx = pad; xx < pad + k && xx < w; xx++) on[yy * w + xx] = 0
      if (touchesRight) for (let xx = w - 1 - pad; xx > w - 1 - pad - k && xx >= 0; xx--) on[yy * w + xx] = 0
    }
  }
  stripEdgeCrumbs(on, w, h, pad)
  const out = new ImageData(w, h)
  const o = out.data
  for (let j = 0; j < on.length; j++) {
    const v = on[j] ? 0 : 255
    o[j * 4] = v; o[j * 4 + 1] = v; o[j * 4 + 2] = v; o[j * 4 + 3] = 255
  }
  return { image: out, x, y }
}

/**
 * Drop the ink of a NEIGHBOUR that reaches into the cell: a connected piece
 * that touches the cell's left or right edge, is narrower than a fifth of
 * the cell, and holds under a quarter of the cell's ink. Where two letters
 * touch, the cut between them lands a column or two inside one of them (an
 * engine's box, a profile split), and the sliver of the other letter that
 * lands in the cell went into the face as part of the glyph - an "I" with a
 * piece of the "N" beside it, an "R" with a foot of the "A". A glyph's own
 * strokes are wider than that, or hold most of the ink, or both.
 */
function stripEdgeCrumbs(on: Uint8Array, w: number, h: number, pad: number): void {
  const label = new Int32Array(w * h)
  let total = 0
  for (let j = 0; j < on.length; j++) total += on[j]
  if (total < 4) return
  const left = pad, right = w - 1 - pad
  const cellW = Math.max(1, right - left + 1)
  let next = 0
  const stack: number[] = []
  for (let start = 0; start < on.length; start++) {
    if (!on[start] || label[start]) continue
    next++
    let area = 0, x0 = w, x1 = -1
    stack.push(start); label[start] = next
    while (stack.length) {
      const j = stack.pop()!
      area++
      const xx = j % w, yy = (j - xx) / w
      if (xx < x0) x0 = xx
      if (xx > x1) x1 = xx
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = xx + dx, ny = yy + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const n = ny * w + nx
        if (on[n] && !label[n]) { label[n] = next; stack.push(n) }
      }
    }
    const touchesEdge = x0 <= left || x1 >= right
    // And a SPECK anywhere: the anti-aliased fringe of an underline two rows
    // below the letters, a scanner's grain, holds a few pixels where Potrace's
    // turd size drops only one. Under 3% of the cell's ink is no part of a
    // letter — an "i" dot is a tenth of its stem, an accent more.
    const speck = area <= Math.max(4, Math.round(total * 0.03))
    if (speck || (touchesEdge && (x1 - x0 + 1) < cellW * 0.2 && area < total * 0.25)) {
      for (let j = 0; j < on.length; j++) if (label[j] === next) on[j] = 0
    }
  }
}
