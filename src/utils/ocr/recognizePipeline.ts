/**
 * Recognising a page's raster: the pipeline from a 220 DPI canvas to the
 * editable runs (`OcrTextItem`) — faint-layer cleaning, levelling a tilted
 * scan, the engine's reading, the watermark's second reading, ink measurement
 * and the re-read of cut pieces (`refineLines`), the runs themselves
 * (`buildItems`) and the sideways pass.
 *
 * Moved out of `useOCR` unchanged so the MCP server (Node, no DOM, no Vue)
 * runs the very same code: nothing here holds state, and every canvas comes
 * from `makeCanvas` (canvasFactory.ts). `useOCR` keeps the recogniser's
 * state — busy, progress, the raster caches, the engines — and delegates.
 */
import type { OcrTextItem, OcrAlign } from './ocrTypes'
import { sampleLineColors, samplePatchColor } from './ocrSampling'
import { detectFace, advancesAreUniform, isLightOnDark } from './ocrFontDetect'
import type { OcrEngine, OcrLine, OcrRecognition, OcrWord, OcrBox } from './ocrEngine'
import { inkBounds, inkGaps, inkBands, extendDescenders, extendAscenders, extendForTilt, walkNote, type InkCut } from './inkMeasure'
import { expectedAdvance } from './glyphCut'
import { watermarkLevel, whitenFrom, linesMissed } from './ocrWatermark'
import { estimateSkew, levelCanvas, unlevelRecognition } from './deskew'
import { withoutFaintLayer } from './faintLayer'
import { makeCanvas } from './canvasFactory'

/** Where a recognition reports what it is doing. */
export interface RecognizeHooks {
  onStage?: (stage: string) => void
  onProgress?: (stage: string, percent: number) => void
}

/** Rasterisation used for OCR, in DPI. */
export const OCR_DPI = 220
/** PDF user space is 72 units to the inch. */
export const PDF_DPI = 72

// The scanned-page thresholds (SCANNED_TEXT_THRESHOLD: a scan often carries a
// stray character or two, so not zero; SCANNED_TEXT_COVERAGE: text covering
// under 2% of the paper is a stamp or a footer) live in utils/pageKind.

/**
 * The tallest symbol box of a line WITH descenders, as a fraction of the em.
 *
 * Measured, not derived: a 12pt line rasterised at 220 DPI has a 36.7px em and
 * its tallest symbol box comes back at 35.1px. Treating the box as a cap height
 * (0.7) put every size 30% over; `rowAttributes`, which is in the type
 * definitions, is not in absolute pixels and put them out by a factor of 2.6.
 */
const GLYPH_BOX_PER_EM = 0.95

/**
 * The same fraction for a run with NO descenders.
 *
 * The constant above is only right when something in the line reaches below the
 * baseline. A row of capitals has nothing that does, so its tallest box is the
 * cap height and the em derived from it came out a fifth short — an 11pt row of
 * headings read as 9pt, and the replacement was visibly smaller than the
 * headings either side of it that had not been touched.
 *
 * Measured on the same page: "DATA" and "DETAIL" set at 11pt gave boxes of 8.17
 * and 8.55 points, i.e. 0.74 and 0.78 of the em.
 */
const GLYPH_BOX_PER_EM_NO_DESCENDER = 0.76


/**
 * How much of an em the tallest glyph box is, for `text`.
 *
 * A comma or a parenthesis hangs a tenth of an em below the baseline where a
 * "g" or a "p" hangs a quarter, so a line whose only descenders are
 * punctuation - an all-caps address, "262,08 (OCTAVO PISO)" - is about 0.85
 * of an em tall, not 0.95. Reading it as 0.95 set the RJ notice's address at
 * 7.6pt beside a 10.3pt line drawn in the same face.
 */
const LETTER_DESCENDERS = /[gjpqyQ]/
const PUNCT_DESCENDERS = /[,;()\[\]{}]/
export function boxPerEm(text: string): number {
  if (LETTER_DESCENDERS.test(text)) return GLYPH_BOX_PER_EM
  if (PUNCT_DESCENDERS.test(text)) return 0.85
  return GLYPH_BOX_PER_EM_NO_DESCENDER
}

/**
 * The same fraction for a monospaced face.
 *
 * Courier's ascenders reach 0.63 of the em where Helvetica's reach 0.72, so the
 * tallest box in a line of it is proportionally shorter and the em derived from
 * it came out about 30% low — a 12pt line read as 8.3pt. Measured the same way
 * as the constant above, on the same page.
 */
const GLYPH_BOX_PER_EM_MONO = 0.625

/** A vertical run must be at least this much taller than it is wide. */
const VERTICAL_ASPECT = 1.6
/** Sideways recognition is speculative, so only confident runs are kept. */
const VERTICAL_MIN_CONFIDENCE = 55
/** Scale of the rotated raster the sideways pass reads (220 DPI × 0.7 ≈ 150 DPI). */
const VERTICAL_SCALE = 0.7
/**
 * Sideways CJK needs more conviction than sideways Latin: a Chinese glyph
 * turned a quarter turn still looks like a Chinese glyph to the model, so the
 * stamp and the table borders came back as seven confident sideways runs
 * ("总 | E", "> | 亚") on a page with no sideways text at all.
 */
const VERTICAL_MIN_CONFIDENCE_CJK = 78
/** A CJK glyph's box as a fraction of its em — the ideograph fills the square. */
const GLYPH_BOX_PER_EM_CJK = 0.92
/**
 * PaddleOCR's box of a line read LEVELLED (`OcrLine.tilt`), in ems of the
 * letters — the median over a tilted contract page measured against the em
 * the scan analysis fits from the letters themselves: 1.24 for 67 Latin lines
 * (p10 1.15, p90 1.61, short table cells at the top end), 1.42 for 22 CJK.
 */
const LEVEL_BOX_PER_EM = 1.24
const LEVEL_BOX_PER_EM_CJK = 1.42

/**
 * The em of a CJK run, from the MEDIAN glyph box.
 *
 * The word box will not do: on a ruled form it swallows the cell's border, and
 * a 6.5pt label came back in a 10.8pt box. Glyph boxes are individually
 * honest — a border inflates one or two of them, never the median. Fewer than
 * two glyph boxes falls back to the run's own height.
 */
export function cjkEm(run: OcrWord[], runHeight: number): number {
  // An ideograph is square, so a glyph box taller than it is wide has
  // swallowed a rule above or below: the smaller side is the honest one.
  // (Measured: 公司地址 kept a 10.8pt height on every glyph, 6.5pt widths.)
  const sides = run.flatMap(w => (w.symbols ?? []).map(s =>
    Math.min(s.y1 - s.y0, (s.x1 - s.x0) * 1.05)))
    .filter(h => h > 0).sort((a, b) => a - b)
  if (sides.length < 2) return runHeight / GLYPH_BOX_PER_EM_CJK
  return sides[Math.floor(sides.length / 2)] / GLYPH_BOX_PER_EM_CJK
}

/** Han characters make up at least half of the letters. */
export function isMostlyCjk(text: string): boolean {
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '')
  if (!letters) return false
  const han = (letters.match(/\p{Script=Han}/gu) ?? []).length
  return han * 2 >= letters.length
}

/**
 * A run that is noise, not text.
 *
 * A stamp, a signature and a table's corners come back as a dozen boxes
 * reading "ci Y", "ee", "N", "ze" at 0–40% — one box each over ink that is
 * not a word. A run the model itself hardly believes is dropped, and so is a
 * run of one or two letters it only half believes, unless it is Chinese (a
 * two-character cell like 邮箱 is a whole label) or a number (a form's "1").
 */
export function isJunkRun(text: string, confidence: number): boolean {
  if (confidence < 30) return true
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '')
  if (!letters) return true
  if (letters.length <= 2 && confidence < 60 && !/[\p{Script=Han}\p{N}]/u.test(letters)) return true
  return false
}

/** Table borders read as glyphs: a pipe on its own, or wrapped round a word. */
const BORDER_WORD = /^[|｜丨]+$/
export function stripBorders(text: string): string {
  return text.replace(/^[|｜丨]+|[|｜丨]+$/g, '')
}

type Box = OcrBox

/**
 * Where a line sits within its paragraph tells you how it is aligned.
 *
 * A single line says nothing — one line is flush with itself. Only when a
 * paragraph has several can the pattern of their left and right edges mean
 * anything, so anything else stays left.
 */
export function inferAlign(lineBox: Box, paraBox: Box, lineCount: number): OcrAlign {
  if (lineCount < 2) return 'left'
  const leftGap = lineBox.x0 - paraBox.x0
  const rightGap = paraBox.x1 - lineBox.x1
  const width = Math.max(paraBox.x1 - paraBox.x0, 1)
  const tol = width * 0.04
  if (Math.abs(leftGap - rightGap) < tol && leftGap > tol) return 'center'
  if (rightGap < tol && leftGap > tol * 2) return 'right'
  return 'left'
}

/**
 * Split a recognised line where it stops being one piece of text.
 *
 * Tesseract groups by VISUAL row, so five column headings printed side by
 * side across a page come back as ONE line. Editing that rewrites all five:
 * the user changes one heading and the whole row is redrawn as a single run,
 * in one font, on one baseline. That is the "it detects the whole line when
 * the text is only in one spot" report.
 *
 * A gap cuts when it is unmistakable ON ITS OWN — no word space is two and a
 * half ems wide — or when it is both wider than an em and several times this
 * line's own median gap.
 *
 * Requiring BOTH tests, which is what it did first, fails on exactly the case
 * it exists for: when every gap on the line is a column gap, they ARE the
 * median, the relative threshold climbs above all of them, and the row stays
 * whole. The relative test is there to protect letter-spaced text from being
 * shredded, so it can only ever ADD splits, never veto the absolute one.
 *
 * There is a third case the other two miss: a row of one-word headings, where
 * every gap is a column gap but none is wide enough to be unmistakable on its
 * own. It is recognised by its SMALLEST gap — if even that is wider than an
 * em, no gap on the line is a word space, so every one of them separates two
 * pieces of text. Prose can never trigger it: a line of prose always contains
 * a real word space, and a word space is about a third of an em.
 */
export function splitRuns(words: OcrWord[], emPx: number): OcrWord[][] {
  const ordered = [...words].sort((a, b) => a.box.x0 - b.box.x0)
  if (ordered.length < 2) return [ordered]

  const gaps: number[] = []
  for (let i = 1; i < ordered.length; i++) {
    gaps.push(Math.max(0, ordered[i].box.x0 - ordered[i - 1].box.x1))
  }
  const sorted = [...gaps].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] || 0
  const obvious = Math.max(emPx * 2.5, 1)
  const relative = Math.max(emPx * 1.1, median * 2.5, 1)
  const noWordSpaces = sorted[0] > emPx * 1.2

  const runs: OcrWord[][] = [[ordered[0]]]
  for (let i = 1; i < ordered.length; i++) {
    const gap = gaps[i - 1]
    if (noWordSpaces || gap > obvious || gap > relative) runs.push([ordered[i]])
    else runs[runs.length - 1].push(ordered[i])
  }
  return runs
}

/**
 * The em of a run, from its tallest glyph boxes — but not from ONE of them.
 *
 * How much of an em a box is depends on whether anything in the run goes
 * below the baseline, so the text has to be consulted, not just the boxes.
 *
 * A scan hands back the odd swollen box — a smear joining two letters, a
 * speck under a stem, an edge of the row beneath — and the plain maximum
 * believes it. One of those on a row of 11pt capitals reported 18.9pt, and
 * the size was not the worst of it: `lineEm` is what `splitRuns` measures its
 * column gaps against, so an em inflated by 70% pushed the "unmistakable gap"
 * threshold above three real column gaps and three separate headings came
 * back as ONE editable run.
 *
 * The tallest box is dropped only when it stands APART from the next one — a
 * quarter taller again — and never more than twice, and never on a run too
 * short for "apart" to mean anything. A percentile will not do this job: in
 * prose the tall boxes are the minority (ascenders and descenders against a
 * page of x-height), so p80 lands in the x-height band and reads a 12pt line
 * as 9pt. What is wanted is not a lower rank, it is the outlier gone.
 */
export function emOf(words: OcrWord[], fallbackHeight: number, text: string): number {
  const heights: number[] = []
  for (const word of words) {
    for (const sym of word.symbols ?? []) {
      const h = sym.y1 - sym.y0
      if (h > 1) heights.push(h)
    }
  }
  heights.sort((a, b) => b - a)
  let at = 0
  while (at < 2 && heights.length - at >= 4 && heights[at] > heights[at + 1] * 1.25) at++
  const capPx = heights[at] ?? 0
  const perEm = boxPerEm(text)
  return capPx > 1 ? capPx / perEm : fallbackHeight * 1.05
}

export function unionBox(words: OcrWord[]): Box {
  return {
    x0: Math.min(...words.map(w => w.box.x0)),
    y0: Math.min(...words.map(w => w.box.y0)),
    x1: Math.max(...words.map(w => w.box.x1)),
    y1: Math.max(...words.map(w => w.box.y1))
  }
}

/**
 * The base-14 face that best matches what the ink looks like.
 *
 * Weight, slant and monospace are MEASURED off the pixels (see
 * `ocrFontDetect`), because the LSTM engine reports no font attributes at all
 * and the `font_name` it occasionally carries names a face that is not in
 * this document and could not be embedded anyway.
 *
 * Monospace is decided ONLY by the advances, and only when the run holds both
 * narrow and wide glyphs — see `advancesAreUniform`. A run of capitals cannot
 * say: every face sets capitals at almost the same width.
 *
 * Serif against sans is NOT measured, and is not guessed either. Three cues
 * were calibrated against the base-14 faces rendered at OCR resolution —
 * stroke contrast, the flare at the foot of a stem, and the density of ink on
 * the baseline — and none of them separates Times from Helvetica: the two
 * overlap completely on all three (`tools/ocr-calibrate`). A coin flip that
 * changes the typeface of a whole document is worse than a consistent default
 * the user can see and change in one click, so sans is the default and OCR's
 * own `font_name` is used only when it actually says something.
 */
export function chooseFace(
  cues: ReturnType<typeof detectFace>,
  uniform: boolean | null,
  reported: string | undefined
): { fontFamily: string; bold: boolean; italic: boolean } {
  const name = (reported || '').toLowerCase()
  // Only the ADVANCES may call a run monospaced.
  //
  // The pixel cue — thick-to-thin stroke ratio — separates Courier cleanly on
  // a clean render, and not at all on a scan: on blurred bold capitals it
  // reads high because the crossbars fall inside the stem window, and it set
  // a row of Helvetica-Bold headings in Courier at half again their size.
  // Cues that only work on material this feature never sees are worse than no
  // cue, so it is now reported for inspection and nothing else.
  const mono = uniform === true
  let fontFamily = 'Helvetica'
  if (mono) fontFamily = 'Courier'
  else if (/times|serif|roman|georgia|garamond|book|minion/.test(name)) fontFamily = 'Times-Roman'

  return {
    fontFamily,
    bold: cues.bold || /bold|black|heavy/.test(name),
    italic: cues.italic || /italic|oblique/.test(name)
  }
}

/** Fraction of box `a` that box `b` covers. */
export function overlapFraction(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  if (w <= 0 || h <= 0) return 0
  const area = Math.max((a.x1 - a.x0) * (a.y1 - a.y0), 1)
  return (w * h) / area
}

/**
 * How much of `a` is covered by ALL of `boxes` together.
 *
 * Approximated by summing the pairwise intersections. Boxes that overlap each
 * other are double-counted, which can only make the answer larger — and the
 * answer is used to REJECT, so the error costs a doubtful run rather than
 * admitting a wrong one.
 */
export function coveredFraction(a: Box, boxes: Box[]): number {
  const area = Math.max((a.x1 - a.x0) * (a.y1 - a.y0), 1)
  let covered = 0
  for (const b of boxes) {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
    const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
    if (w > 0 && h > 0) covered += w * h
  }
  return covered / area
}

/**
 * Lines from an engine without word boxes, measured on their ink.
 *
 * Two things the detector box cannot say: how tall the glyphs are (the box
 * is padded — a 6.5pt label arrived in an 11.5pt box) and whether the box
 * spans two table cells (the survey's "辽宁泓瑞机电装备有限公司法定代表人" is
 * two cells the detector read across the rule between them). The ink says
 * both. Each line gets one word whose single "glyph box" is the tight ink
 * box, and a box with an empty column run wider than 1.2 em inside it is
 * cut there, the text shared out by cumulative advance — an ideograph one
 * em, a Latin letter half, a space a third — with Latin cuts snapped to the
 * nearest space. Lines that already have words are returned untouched.
 */
export async function refineLines(lines: OcrLine[], ctx: CanvasRenderingContext2D, engine: OcrEngine, lang: string, reread = true): Promise<OcrLine[]> {
  type Piece = { line: OcrLine; text: string; ink: { x: number; y: number; width: number; height: number }; cut: boolean; band?: boolean }
  const pieces: Piece[] = []
  const passthrough = new Set<OcrLine>()
  for (const line of lines) {
    if (line.words?.length) { passthrough.add(line); continue }
    const rect = { x: line.box.x0, y: line.box.y0, width: line.box.x1 - line.box.x0, height: line.box.y1 - line.box.y0 }
    // An em guessed from the TEXT, before any ink is measured: the box's
    // width over the advances its characters are expected to take. The
    // measurers use it to tell a skewed table border from glyphs — a span no
    // glyph could reach — and a bar set that way does not move when a border
    // fragment or a neighbouring line inflates the box's height, which is
    // exactly when it is needed.
    const emGuess = rect.width / Math.max(1, [...line.text].filter(c => c !== ' ').reduce((s, c) => s + expectedAdvance(c), 0))
    // The detector's box is measured INTO, never out of, and PaddleOCR's
    // box for a line of small body text stops at the BASELINE: on a 10pt
    // contract the descenders of every p, q and g sat below the box, the
    // box read as 0.95 em of a 7.6pt line, the replacements were drawn a
    // quarter too small, and the glyph cut flagged every descender as not
    // descending. The tight box is therefore extended DOWN through the
    // sparse rows a few descenders make, stopping at the first empty row.
    // Padding the probe on both sides was tried first and swallowed the
    // neighbouring lines whole (a 7pt box became 15pt): a line's descenders
    // touch the next line's ascenders on this leading, so the probe must
    // not cross the gap — it must stop at it.
    // And UP through the ascenders, which the same detector clips on small
    // body text — see `extendAscenders`.
    const cjk = isMostlyCjk(line.text)
    if (typeof window !== 'undefined' && (window as any).__lastWalkDebug) walkNote(`line "${line.text.slice(0, 30)}" box=${[rect.x, rect.y, rect.width, rect.height].map(v => v.toFixed(1)).join(',')} em=${emGuess.toFixed(1)}`)
    // A skewed scan's long line leaves its box at the ends — see `extendForTilt`.
    const ink = extendAscenders(ctx, extendDescenders(ctx, extendForTilt(ctx, inkBounds(ctx, rect, emGuess, !cjk)), line.text), line.text)
    if (typeof window !== 'undefined' && (window as any).__lastWalkDebug) walkNote(`  ink=${[ink.x, ink.y, ink.width, ink.height].map(v => v.toFixed(1)).join(',')}`)
    const emPx = ink.height / (cjk ? GLYPH_BOX_PER_EM_CJK : boxPerEm(line.text))
    // Only an UNMISTAKABLE gap cuts (two and a half ems — the same bar
    // `splitRuns` sets): justified prose opens word gaps past an em, and a
    // 1.2 em bar cut "En caso de incumplimiento…" in two and the re-read
    // pieces came back with a space inside a word. Rules cut regardless.
    // A box holding two STACKED lines — a table header set as "PAGADO" over
    // "SOLES" — is two runs, not one tall one: drawn as one it took its size
    // from the double-height box and ran off the page at 14pt. Two or three
    // row bands, each at least a quarter of the box and a few rows tall,
    // become their own pieces, read again like a cut piece; the words are
    // shared out by count only as the fallback for a band that reads as
    // nothing.
    const bands = reread ? inkBands(ctx, ink).filter(b => b.y1 - b.y0 >= Math.max(4, ink.height * 0.25)) : []
    // Lines of ONE text, so of similar height: a 93pt logo with its 16pt
    // tagline in the same box, or a cover title over a line of small print,
    // is not a stacked header, and re-reading those bands replaced a right
    // reading ("Ingenium") with a worse one ("Inaenium").
    const bandH = bands.map(b => b.y1 - b.y0)
    const similar = bands.length >= 2 && Math.max(...bandH) <= 2 * Math.min(...bandH)
    // And a box that is TALL for its text: two lines of the words it holds
    // need close to twice the line height its width implies (the em guessed
    // from the advances). A 93pt logo whose letters happen to break into
    // two row bands is one line by that measure — its box is 1.6 lines,
    // not 2 — and it has one word, which cannot be shared over two bands.
    const words = line.text.split(/\s+/).filter(Boolean)
    const stacked = similar && ink.height >= 1.8 * emGuess * 0.95 && words.length >= bands.length
    if (stacked && bands.length <= 3 && !isMostlyCjk(line.text)) {
      const groups: string[][] = bands.map(() => [])
      const total = words.reduce((s, w) => s + w.length, 0) || 1
      let acc = 0
      for (const w of words) {
        const idx = Math.min(bands.length - 1, Math.floor((acc + w.length / 2) / total * bands.length))
        groups[idx].push(w)
        acc += w.length
      }
      bands.forEach((b, i) => {
        const bandRect = { x: ink.x, y: b.y0, width: ink.width, height: b.y1 - b.y0 }
        pieces.push({ line, text: groups[i].join(' ') || line.text, ink: inkBounds(ctx, bandRect, emGuess), cut: true, band: true })
      })
      continue
    }
    const cuts = reread ? inkGaps(ctx, { x: ink.x, y: ink.y, width: ink.width, height: ink.height }, Math.max(6, emPx * 2.5), emGuess) : []
    const parts = cuts.length ? splitTextAtCuts(line.text, ink, cuts) : [{ text: line.text, x0: ink.x, x1: ink.x + ink.width }]
    for (const part of parts) {
      const partRect = { x: part.x0, y: ink.y, width: part.x1 - part.x0, height: ink.height }
      pieces.push({ line, text: part.text, ink: parts.length > 1 ? inkBounds(ctx, partRect, emGuess) : ink, cut: parts.length > 1 })
    }
  }
  // Cut boxes are READ AGAIN: sharing the text out by column occupancy is
  // an estimate, and on the survey's "辽宁泓瑞机电装备有限公司 | 法定代表人"
  // it kept landing one ideograph off. EVERY cut piece on the page goes
  // into one stacked sheet — one inference. Per box it was 22 sheets at
  // half a second each on a slide cut into 190 cells; per piece, 190 calls
  // and 13 s. The estimate stays as the fallback for a piece that reads as
  // nothing.
  const toRead = pieces.filter(p => p.cut && reread)
  const reads = toRead.length ? await recognizeSheet(ctx, toRead.map(p => p.ink), engine, lang) : []
  // A stacked band's re-read is trusted like any cut piece's. A guard that
  // kept the word-count share unless the re-read resembled it was tried and
  // was wrong on the very cell it was written for: the detector's box
  // "PAGADO SOLES" covered the lines "IMPORTE" and "PAGADO SOLES", the
  // shares were "PAGADO" / "SOLES", and the re-reads "MPORTE" / "PAGADO
  // SOLES" — right, and rejected. The share is only the fallback for a
  // band that reads as nothing.
  toRead.forEach((p, i) => { if (reads[i]) p.text = reads[i]! })

  const out: OcrLine[] = []
  for (const line of lines) {
    if (passthrough.has(line)) { out.push(line); continue }
    for (const p of pieces) {
      if (p.line !== line) continue
      if (p.ink.width < 2 || p.ink.height < 2 || !p.text.trim()) continue
      const box = { x0: p.ink.x, y0: p.ink.y, x1: p.ink.x + p.ink.width, y1: p.ink.y + p.ink.height }
      out.push({ ...line, box, text: p.text, words: [{ text: p.text, box, confidence: line.confidence, symbols: [box] }] })
    }
  }
  return out
}

/**
 * Read several boxes of the page in one inference: each is drawn on its own
 * band of a sheet, a gap of its height between bands so the detector sees
 * separate lines, and every line the engine returns is handed to the band
 * its centre falls in. A band with no line reads as null.
 */
export async function recognizeSheet(ctx: CanvasRenderingContext2D, inks: { x: number; y: number; width: number; height: number }[], engine: OcrEngine, lang: string): Promise<(string | null)[]> {
  // The detector shrinks anything taller than ~1900px, so a page's worth of
  // pieces is read in sheets of at most SHEET_MAX_H, in order.
  const SHEET_MAX_H = 1800
  if (inks.length > 1) {
    let total = 0
    for (const ink of inks) total += ink.height + Math.round(ink.height * 0.6) * 2
    if (total > SHEET_MAX_H) {
      const out: (string | null)[] = []
      let batch: typeof inks = [], batchH = 0
      const flush = async () => { if (batch.length) out.push(...await recognizeSheetOnce(ctx, batch, engine, lang)); batch = []; batchH = 0 }
      for (const ink of inks) {
        const h = ink.height + Math.round(ink.height * 0.6) * 2
        if (batch.length && batchH + h > SHEET_MAX_H) await flush()
        batch.push(ink); batchH += h
      }
      await flush()
      return out
    }
  }
  return recognizeSheetOnce(ctx, inks, engine, lang)
}

async function recognizeSheetOnce(ctx: CanvasRenderingContext2D, inks: { x: number; y: number; width: number; height: number }[], engine: OcrEngine, lang: string): Promise<(string | null)[]> {
  // Room above and below so the detector finds a line; almost none to the
  // sides, or the crop takes its neighbours' letters with it — at 60% of
  // the height a 41pt title's pieces read back "SIL CAPACI", "SINE
  // CAPACITACIÓ", each with a letter of the piece next door.
  const pad = (h: number) => Math.round(h * 0.6)
  const padX = (h: number) => Math.round(h * 0.12) + 2
  // Drawn 1:1. Enlarging pieces under 20px to twice their size was tried
  // for the 11px bands of a stacked table header and the detector then
  // found NOTHING in them, where at 1:1 it reads them (noisily: "PAGADO
  // SOLES" one run, "PAGADO SCES the" the next). The scale hook stays for
  // a measured retry.
  const scaleOf = (_h: number) => 1
  const bands: { y: number; h: number; ok: boolean }[] = []
  let sheetW = 0, sheetH = 0
  for (const ink of inks) {
    const p = pad(ink.height), px = padX(ink.height), s = scaleOf(ink.height)
    const w = (ink.width + px * 2) * s, h = (ink.height + p * 2) * s
    const ok = ink.width >= 2 && ink.height >= 2
    bands.push({ y: sheetH, h, ok })
    sheetW = Math.max(sheetW, w)
    sheetH += h
  }
  if (sheetW < 4 || sheetH < 4) return inks.map(() => null)
  const sheet = makeCanvas(sheetW, sheetH)
  const sctx = sheet.getContext('2d')
  if (!sctx) return inks.map(() => null)
  sctx.fillStyle = '#fff'
  sctx.fillRect(0, 0, sheetW, sheetH)
  inks.forEach((ink, i) => {
    if (!bands[i].ok) return
    const p = pad(ink.height), px = padX(ink.height), s = scaleOf(ink.height)
    const x = Math.max(0, ink.x - px), y = Math.max(0, ink.y - p)
    const w = Math.min(ctx.canvas.width - x, ink.width + px * 2)
    const h = Math.min(ctx.canvas.height - y, ink.height + p * 2)
    if (w > 0 && h > 0) sctx.drawImage(ctx.canvas, x, y, w, h, 0, bands[i].y, w * s, h * s)
  })
  try {
    const res = await engine.recognize(sheet, { lang })
    const perBand: OcrLine[][] = inks.map(() => [])
    for (const l of res.lines) {
      if (!l.text.trim() || l.confidence < 30) continue
      const cy = (l.box.y0 + l.box.y1) / 2
      const i = bands.findIndex(b => cy >= b.y && cy < b.y + b.h)
      if (i >= 0) perBand[i].push(l)
    }
    return perBand.map(ls => {
      if (!ls.length) return null
      return ls.sort((a, b) => a.box.x0 - b.box.x0).map(l => l.text.trim()).join(' ')
        .replace(/([\p{Script=Han}　-〿＀-￯])\s+(?=[\p{Script=Han}　-〿＀-￯])/gu, '$1') || null
    })
  } catch (_) {
    return inks.map(() => null)
  }
}


/** Advance weight of a character, in ems, for sharing text across a cut box. */
export function advanceOf(ch: string): number {
  if (/\p{Script=Han}|[　-〿＀-￯]/u.test(ch)) return 1
  if (ch === ' ') return 0.33
  if (/[iljtfrI.,;:'!|()\[\]]/.test(ch)) return 0.3
  if (/[mwMW@%]/.test(ch)) return 0.85
  return 0.55
}

export function splitTextAtCuts(text: string, ink: { x: number; width: number }, cuts: InkCut[]): { text: string; x0: number; x1: number }[] {
  const chars = [...text]
  const weights = chars.map(advanceOf)
  const total = weights.reduce((s, w) => s + w, 0) || 1
  const cum: number[] = []
  let acc = 0
  for (const w of weights) { acc += w; cum.push(acc / total) }
  const pieces: { text: string; x0: number; x1: number }[] = []
  let start = 0
  let x0 = ink.x
  for (const { x: cut, inkShare } of cuts) {
    // The glyph whose cumulative advance first reaches the ink share left
    // of the cut is the first glyph of the NEXT piece — the share is the
    // ink of whole glyphs, so a glyph straddling the boundary is rare and
    // the nearer side wins.
    const frac = inkShare
    let idx = cum.findIndex(c => c >= frac - 1e-6)
    if (idx < 0) idx = chars.length - 1
    if (idx > 0 && Math.abs(cum[idx - 1] - frac) < Math.abs(cum[idx] - frac)) idx -= 1
    idx += 1
    // Latin text: cut at the nearest space so a word is never torn in two.
    if (!isMostlyCjk(text)) {
      let best = -1
      for (let i = start; i < chars.length; i++) if (chars[i] === ' ' && Math.abs(i - idx) < Math.abs(best - idx)) best = i
      if (best >= 0 && Math.abs(best - idx) <= 3) idx = best
    }
    if (idx <= start) continue
    pieces.push({ text: chars.slice(start, idx).join('').trim(), x0, x1: cut })
    start = idx
    x0 = cut
  }
  pieces.push({ text: chars.slice(start).join('').trim(), x0, x1: ink.x + ink.width })
  return pieces
}

/**
 * Build the editable runs for one recognition pass.
 *
 * @param mapBox turns a box in THIS pass's pixel space into page-space points
 */
export async function buildItems(
  data: OcrRecognition,
  ctx: CanvasRenderingContext2D,
  pageIndex: number,
  toPt: number,
  seq: { n: number },
  vertical: boolean,
  mapBox: (b: Box) => { x: number; y: number; width: number; height: number },
  engine: OcrEngine,
  lang: string,
  /** Re-read cut boxes (upright pass); the sideways pass skips it. */
  reread = true,
  /**
   * Where the colours are sampled, when `ctx` is a cleaned copy: a patch is
   * painted in the page's REAL paper colour, watermark and tinted fill and all.
   */
  colorCtx: CanvasRenderingContext2D = ctx
): Promise<OcrTextItem[]> {
  const items: OcrTextItem[] = []

  for (const line of await refineLines(data.lines, ctx, engine, lang, reread)) {
    // An engine that reports no words (PaddleOCR: one box per text region)
    // gets the line as its one word, carrying the INK's box as its one
    // glyph box so the em is measured on the glyphs, not on the detector's
    // padded box. Its detector already boxes per cell — and where it merged
    // two, `refineLines` has cut them apart on the empty columns between.
    const hasWords = !!line.words?.length
    const sourceWords: OcrWord[] = hasWords
      ? line.words!
      : [{ text: line.text, box: line.box, confidence: line.confidence }]

    // A table's vertical rules come back as "|" glyphs — on their own or
    // stuck to the word beside them — and a rule between two cells glued
    // "辽宁泓瑞机电装备有限公司 | 法定代表人" into one run. A border-only
    // word is a cell boundary: the line is cut there and the border
    // dropped; a border on the edge of a word is shaved off it.
    const rawWords = sourceWords
      .map(w => BORDER_WORD.test((w.text ?? '').trim()) ? w : { ...w, text: stripBorders(w.text ?? '') })
      .filter(w => (w.text ?? '').trim())
    const segments: OcrWord[][] = [[]]
    for (const w of rawWords) {
      if (BORDER_WORD.test(w.text.trim())) { if (segments[segments.length - 1].length) segments.push([]); continue }
      segments[segments.length - 1].push(w)
    }
    const allWords = rawWords.filter(w => !BORDER_WORD.test(w.text.trim()))
    if (!allWords.length) continue
    const lineText = allWords.map(w => w.text).join(' ')
    const lineEm = emOf(allWords, line.box.y1 - line.box.y0, lineText)

    const runs = hasWords
      ? segments.filter(s => s.length).flatMap(seg => splitRuns(seg, lineEm))
      : segments.filter(s => s.length)
    for (const run of runs) {
      // Tesseract's Chinese model puts a "word" space between adjacent
      // characters; Chinese has none, so those are closed up again.
      const text = run.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim()
        .replace(/([\p{Script=Han}　-〿＀-￯])\s+(?=[\p{Script=Han}　-〿＀-￯])/gu, '$1')
      if (!text) continue

      const bb = unionBox(run)
      const pxRect = { x: bb.x0, y: bb.y0, width: bb.x1 - bb.x0, height: bb.y1 - bb.y0 }
      if (pxRect.width < 2 || pxRect.height < 2) continue

      // A CJK glyph fills its em, ascender to descender, so the box IS
      // the em; the Latin rule (tallest box = 0.76 of an em when nothing
      // descends) sized a 10pt Chinese cell at 13pt.
      const emRaw = isMostlyCjk(text) ? cjkEm(run, pxRect.height) : emOf(run, pxRect.height, text)
      // A line read levelled (deskew.ts) sits in the box ENCLOSING it, and
      // ink measured in that box takes in the rise across the line and the
      // corners of its neighbours: a 10pt line on a page tilted 1.75° came
      // out anywhere between 5 and 25pt. The detector's LEVEL box is the
      // steady measure — LEVEL_BOX_PER_EM of the letters' em — and caps it.
      const levelEm = !vertical && line.tilt
        ? (2 * line.tilt.half) / (isMostlyCjk(text) ? LEVEL_BOX_PER_EM_CJK : LEVEL_BOX_PER_EM)
        : Infinity
      const emPx = Math.min(emRaw, levelEm)
      const { color } = sampleLineColors(colorCtx, pxRect)
      const background = samplePatchColor(colorCtx, pxRect)

      // The baseline OCR reports is the whole LINE's, and a run taken out
      // of that line sits on the same one. The face detector needs it:
      // without it, it would look for serif feet in the middle of the
      // x-height and measure stroke widths across a crossbar.
      const baseY = line.baseline
        ? (line.baseline.y0 + line.baseline.y1) / 2
        : bb.y1 - pxRect.height * 0.2
      const cues = detectFace(ctx, pxRect, emPx, baseY, isLightOnDark(color, background))
      const uniform = advancesAreUniform(run.flatMap(w => w.symbols ?? []), text)
      const face = chooseFace(cues, uniform, undefined)
      // The em has to be re-derived once the family is known: it comes
      // from the tallest glyph box, and how much of an em that is depends
      // on the face.
      const emCorrected = face.fontFamily === 'Courier'
        ? emPx * (GLYPH_BOX_PER_EM / GLYPH_BOX_PER_EM_MONO)
        : emPx

      // The baseline's slope is the line's own skew. A sideways pass has
      // already been turned upright, so its slope is measured in that
      // frame and says nothing about how the run sits on the page.
      const base = line.baseline
      const rotation = vertical ? 0
        : base ? Math.round(Math.atan2(base.y1 - base.y0, Math.max(base.x1 - base.x0, 1)) * (180 / Math.PI) * 10) / 10
        : line.angle ? Math.round(line.angle * 10) / 10
        : 0

      const conf = run.reduce((s, w) => s + (w.confidence ?? 0), 0) / run.length
      if (isJunkRun(text, conf)) continue
      // A red stamp over the signatures read as "maa b" at 53% — four letters
      // 116pt tall on a page of 10pt text, with one ink run for the lot. A
      // genuine title that size is read with confidence; a doubtful reading
      // that large is a picture.
      if (emCorrected * toPt >= 48 && conf < 70) continue
      // A horizontal run of several characters cannot be narrower than it
      // is tall: a 26×81pt box reading "O pa: F 是一 053 89" is a stamp or a
      // sideways column read the wrong way, and baked as an 85pt line it
      // ran off the page.
      const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length
      if (!vertical && letters >= 3 && pxRect.width < pxRect.height) continue

      items.push({
        id: `${pageIndex}:ocr:${seq.n++}`,
        pageIndex,
        originalText: text,
        text,
        rect: mapBox(bb),
        // Same box to begin with, and the one that stays put when the run
        // is dragged — it is where the scan's own ink is.
        inkRect: mapBox(bb),
        words: hasWords ? run.map(word => mapBox(word.box)) : [],
        // One box per non-space character, for the scan face's tracer.
        // Tesseract reports them; an engine without them leaves this out and
        // the tracer cuts the run on its column profile instead.
        symbols: hasWords && run.every(w => w.symbols?.length)
          ? run.flatMap(w => w.symbols!.map(mapBox))
          : undefined,
        fontSize: Math.max(4, Math.round(emCorrected * toPt * 10) / 10),
        fontFamily: face.fontFamily,
        bold: face.bold,
        italic: face.italic,
        color,
        background,
        strokeRatio: cues.measured && cues.strokeRatio > 0 ? cues.strokeRatio : undefined,
        // A run split out of a line IS its own box, so there is nothing
        // left for it to be aligned within; only a whole line can say.
        align: run.length === allWords.length && line.paragraph
          ? inferAlign(bb, line.paragraph.box, line.paragraph.lineCount)
          : 'left',
        rotation,
        vertical,
        // The band a tilted line's letters occupy inside its enclosing box,
        // relative to the box: the layer draws the run's target there, or
        // neighbouring lines' boxes overlap and a click at the end of one
        // line opens the next.
        tilt: !vertical && line.tilt ? {
          slope: line.tilt.slope,
          dy: (line.tilt.midY + line.tilt.slope * (bb.x0 - line.tilt.midX) - line.tilt.half - bb.y0) * toPt,
          height: 2 * line.tilt.half * toPt
        } : undefined,
        confidence: Math.round(conf),
        edited: false,
        removed: false
      })
    }
  }
  return items
}

/**
 * Recognise one page's raster.
 *
 * @param canvas the page rendered at any scale (copied pixel for pixel when it
 *   is already within 2px of the OCR size)
 * @param pageWidth / pageHeight the page in POINTS
 * @param fallback the engine to read with when `engine` cannot run here
 */
export async function recognizeRaster(opts: {
  canvas: HTMLCanvasElement
  pageIndex: number
  pageWidth: number
  pageHeight: number
  engine: OcrEngine
  lang: string
  readVertical?: boolean
  fallback?: () => OcrEngine
  fallbackLabel?: (err: any, from: OcrEngine, to: OcrEngine) => string
  hooks?: RecognizeHooks
}): Promise<{
  items: OcrTextItem[]
  engine: OcrEngine
  fallbackNote?: string
  verticalCount: number
  /** The raster the runs were measured on (faint layer painted out), and its points per pixel. */
  clean: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; toPt: number }
  /** The luminance the faint layer was painted out from, when the page has one. */
  faintCutoff?: number
}> {
  const { canvas, pageIndex, pageWidth, pageHeight, lang, readVertical = true, hooks = {} } = opts
  let engine = opts.engine
  // OCR reads its own rasterisation, not the one on screen: accuracy falls
  // off badly below ~200 DPI, and the viewer's zoom is the user's business.
  // A canvas already rendered at OCR resolution is copied PIXEL FOR PIXEL.
  // The viewer floors its size and this rounds, so the two differed by one
  // row, and `drawImage` then resampled the whole page — every row a blend
  // of two — which smeared a thin skewed table border into crumbs that no
  // rule test could see and left a line measured 40 rows tall for 33 rows
  // of glyphs. The glyph tracer reads these same pixels, so the smear went
  // into the scan face as well.
  let tw = Math.round(pageWidth * (OCR_DPI / PDF_DPI)), th = Math.round(pageHeight * (OCR_DPI / PDF_DPI))
  if (Math.abs(canvas.width - tw) <= 2 && Math.abs(canvas.height - th) <= 2) { tw = canvas.width; th = canvas.height }
  const target = makeCanvas(tw, th)
  const tctx = target.getContext('2d', { willReadFrequently: true })
  if (!tctx) throw new Error('Could not prepare the page for recognition')
  tctx.drawImage(canvas, 0, 0, target.width, target.height)
  // A watermark printed across the page is read as text and glued to every
  // cell it crosses; the recogniser and the ink measurers read a copy with
  // it painted out. `tctx` keeps the real pixels for the colour samplers.
  const clean = withoutFaintLayer(target)

  let fallbackNote: string | undefined
  let data: OcrRecognition
  // A TILTED page is read levelled and its boxes put back (deskew.ts): in
  // axis-aligned boxes a 1.75° tilt made every full-width line two lines
  // tall, the detector merged the paragraph's lines and whole clauses of a
  // contract had no run to edit. Everything below works on the page as
  // scanned; only the recogniser sees it level.
  const cleanPx = clean.ctx.getImageData(0, 0, target.width, target.height).data
  const skew = estimateSkew(cleanPx, target.width, target.height)
  const levelled = skew ? levelCanvas(clean.canvas, skew.degrees) : null
  const recognise = async (c: HTMLCanvasElement): Promise<OcrRecognition> => {
    const L = !levelled ? null : c === clean.canvas ? levelled : levelCanvas(c, levelled.degrees)
    if (!L) return engine.recognize(c, { lang, onProgress: hooks.onProgress })
    return unlevelRecognition(L, await engine.recognize(L.canvas, { lang, onProgress: hooks.onProgress }))
  }
  try {
    hooks.onStage?.('Recognising text...')
    data = await recognise(clean.canvas)
  } catch (err: any) {
    if (!opts.fallback) throw err
    const from = engine
    engine = opts.fallback()
    fallbackNote = opts.fallbackLabel?.(err, from, engine)
    hooks.onStage?.('Recognising text...')
    data = await recognise(clean.canvas)
  }

  // A light grey watermark printed over the text hides whole lines from
  // the recogniser: the page is read a second time with the watermark's
  // grey whitened, and only the lines that reading finds where the first
  // found nothing are added (`ocrWatermark.ts`). Never for a cloud
  // engine: a second call costs money.
  // It reads the same copy the first pass did — a pale faint layer already
  // painted out — so the two readings differ only by this whitening.
  if (engine.id !== 'mistral') {
    const level = watermarkLevel(cleanPx)
    if (level !== null) {
      const under = makeCanvas(target.width, target.height)
      const uctx = under.getContext('2d', { willReadFrequently: true })
      if (uctx) {
        const img = clean.ctx.getImageData(0, 0, target.width, target.height)
        whitenFrom(img.data, level - 20)
        uctx.putImageData(img, 0, 0)
        hooks.onStage?.('Reading under the watermark...')
        const again = await recognise(under).catch(() => null)
        const missed = again ? linesMissed(data.lines, again.lines) : []
        if (missed.length) data = { ...data, lines: [...data.lines, ...missed] }
      }
    }
  }

  // Canvas pixels -> page points.
  const toPt = pageWidth / target.width
  const seq = { n: 0 }
  const items = await buildItems(data, clean.ctx, pageIndex, toPt, seq, false, b => ({
    x: b.x0 * toPt,
    y: b.y0 * toPt,
    width: (b.x1 - b.x0) * toPt,
    height: (b.y1 - b.y0) * toPt
  }), engine, lang, true, tctx)

  let verticalCount = 0
  // A cloud call costs money and a round trip; sideways text is rare.
  if (readVertical && engine.id !== 'mistral') {
    const sideways = await addVerticalRuns(clean.canvas, tctx, pageIndex, toPt, seq, items, engine, lang, hooks)
    verticalCount = sideways.length
  }
  return { items, engine, fallbackNote, verticalCount, clean: { canvas: clean.canvas, ctx: clean.ctx, toPt }, faintCutoff: clean.layer?.cutoff }
}

/**
 * A second pass for text set on its side.
 *
 * Tesseract reads a line left to right. A label printed up the side of a
 * chart is not a line to it — it comes back as nothing, or as a column of
 * unrelated single letters, and either way the user cannot edit it. The only
 * way to read it is to turn the page: the raster is rotated a quarter turn
 * clockwise, which stands bottom-to-top text up horizontally, and recognised
 * again.
 *
 * Everything that pass finds is speculative, so three things must hold before
 * a run is kept: it must be confident; it must be taller than it is wide once
 * mapped back, which is what vertical text looks like on the page; and the
 * upright pass must not already have read the same ink — otherwise every
 * ordinary line comes back a second time as gibberish read sideways.
 *
 * That last test is CUMULATIVE, over every upright run at once. Comparing
 * against one at a time let thirteen false runs through on a page with one
 * real one: a tall narrow box laid over a block of prose crosses six lines
 * and covers barely a sixth of each, so no single comparison ever looks like
 * a clash while the box is plainly sitting on top of the paragraph.
 *
 * And only SUBSTANTIAL upright runs count towards it. The upright pass reads
 * a sideways label as a column of unrelated single letters, and letting those
 * count would have the misreading of a label veto the correct reading of it.
 * Once a vertical run is accepted those misreadings are dropped: they are the
 * same ink, read the wrong way round.
 */
export async function addVerticalRuns(
  source: HTMLCanvasElement,
  sourceCtx: CanvasRenderingContext2D,
  pageIndex: number,
  toPt: number,
  seq: { n: number },
  into: OcrTextItem[],
  engine: OcrEngine,
  lang: string,
  hooks: RecognizeHooks = {}
): Promise<OcrTextItem[]> {
  const H = source.height

  // Read at a reduced scale: a sideways label is a chart axis or a margin
  // note, never six-point body text, and the rotated pass of a full page in
  // the Chinese model took four times as long as the upright one. The
  // rotated raster is drawn at VERTICAL_SCALE and every box mapped back.
  const k = VERTICAL_SCALE
  // Full-size rotated copy for the face detector and the colour samplers,
  // which read pixels at the boxes' own coordinates.
  const rot = makeCanvas(source.height, source.width)
  const rctx = rot.getContext('2d', { willReadFrequently: true })
  if (!rctx) return []
  // A quarter turn clockwise: source (x, y) lands at (H - y, x).
  rctx.translate(H, 0)
  rctx.rotate(Math.PI / 2)
  rctx.drawImage(source, 0, 0)
  // The reduced copy the recogniser actually reads.
  const small = makeCanvas(Math.max(1, Math.round(rot.width * k)), Math.max(1, Math.round(rot.height * k)))
  const sctx = small.getContext('2d')
  if (!sctx) return []
  sctx.drawImage(rot, 0, 0, small.width, small.height)

  hooks.onStage?.('Looking for sideways text...')
  const raw = await engine.recognize(small, { lang, onProgress: hooks.onProgress })
  // Back to the unscaled rotated frame, so the mapping below is unchanged.
  const unscale = (b: Box): Box => ({ x0: b.x0 / k, y0: b.y0 / k, x1: b.x1 / k, y1: b.y1 / k })
  const data: OcrRecognition = {
    lines: raw.lines.map((l: OcrLine): OcrLine => ({
      ...l,
      box: unscale(l.box),
      baseline: l.baseline ? { x0: l.baseline.x0 / k, y0: l.baseline.y0 / k, x1: l.baseline.x1 / k, y1: l.baseline.y1 / k } : undefined,
      paragraph: l.paragraph ? { box: unscale(l.paragraph.box), lineCount: l.paragraph.lineCount } : undefined,
      words: l.words?.map(wd => ({ ...wd, box: unscale(wd.box), symbols: wd.symbols?.map(unscale) }))
    }))
  }

  const boxOf = (it: OcrTextItem): Box => ({
    x0: it.rect.x / toPt,
    y0: it.rect.y / toPt,
    x1: (it.rect.x + it.rect.width) / toPt,
    y1: (it.rect.y + it.rect.height) / toPt
  })
  const uprightBoxes = into
    .filter(it => it.text.replace(/\s/g, '').length >= 4 && it.confidence >= 60)
    .map(boxOf)

  const found = await buildItems(data, rctx, pageIndex, toPt, seq, true, b => ({
    // Inverse of the quarter turn: rotated (x', y') came from (y', H - x').
    x: b.y0 * toPt,
    y: (H - b.x1) * toPt,
    width: (b.y1 - b.y0) * toPt,
    height: (b.x1 - b.x0) * toPt
  }), engine, lang, false)

  const kept: OcrTextItem[] = []
  for (const item of found) {
    const letters = item.text.replace(/[^\p{L}\p{N}]/gu, '')
    const cjk = /\p{Script=Han}/u.test(item.text)
    if (item.confidence < (cjk ? VERTICAL_MIN_CONFIDENCE_CJK : VERTICAL_MIN_CONFIDENCE)) continue
    // Three real characters, and no table border in them: "总 | E" is a
    // border and a stamp read sideways, not a label.
    if (letters.length < 3) continue
    if (/[|｜丨]/.test(item.text)) continue
    if (item.rect.height < item.rect.width * VERTICAL_ASPECT) continue
    const box = {
      x0: item.rect.x / toPt,
      y0: item.rect.y / toPt,
      x1: (item.rect.x + item.rect.width) / toPt,
      y1: (item.rect.y + item.rect.height) / toPt
    }
    if (coveredFraction(box, uprightBoxes) > 0.30) continue

    // The colours were sampled on the rotated canvas, which was only ever a
    // means of reading the letters; re-read them where the run actually is.
    const pxRect = { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 }
    item.color = sampleLineColors(sourceCtx, pxRect).color
    item.background = samplePatchColor(sourceCtx, pxRect)
    kept.push(item)
    into.push(item)
  }

  // Drop the upright pass's attempts at this same ink. They are the single
  // letters a sideways label decomposes into when it is read left to right,
  // and leaving them puts a dozen meaningless boxes on top of the one box
  // that says what the label actually is.
  for (const run of kept) {
    const vbox = boxOf(run)
    for (let i = into.length - 1; i >= 0; i--) {
      const other = into[i]
      if (other === run || other.vertical) continue
      if (overlapFraction(boxOf(other), vbox) > 0.55) into.splice(i, 1)
    }
  }
  return kept
}
