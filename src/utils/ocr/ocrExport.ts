import type { OcrTextItem } from './ocrTypes'
import type { RectT } from '@/engine/types'
import { planPartial, sizeOf, bandRects, type PartialContext, type SpanCut } from './partialRedraw'
import { strokeWidthFor, tracedStrokeUpTo } from './ocrStroke'

/**
 * Turning edited OCR runs into PDF operations.
 *
 * The scan is never rebuilt. Every page keeps its original image, its size and
 * its resolution; only the areas the user actually changed are touched, and
 * each of those in two steps:
 *
 *   1. a filled rectangle the colour of the surrounding paper, hiding the ink
 *      that was photographed there;
 *   2. the replacement text on top of it.
 *
 * A deleted run gets step 1 only. A run the user never touched gets neither —
 * which is what keeps tables, rules, signatures, stamps and letterhead exactly
 * as they were: they are simply never drawn over.
 *
 * This module builds the plan; the caller feeds it to the engine. Keeping the
 * geometry separate from the engine calls is what makes it testable at all.
 */

export interface PatchOp {
  /** Rectangle to paint over, in PDF page space (top-left origin). */
  rect: RectT
  color: [number, number, number]
  /** The run this patch belongs to: after the bake its ink box grows to what was painted. */
  item?: string
  /** False for a rectangle that only reports where new letters went (a pure append covers no old ink) — not painted. */
  paint?: boolean
}

export interface TextOp {
  text: string
  /** Baseline start, in PDF page space (top-left origin, y down). */
  x: number
  y: number
  fontSize: number
  /** A base-14 name the engine can register. */
  fontName: string
  color: [number, number, number]
  /** Degrees counter-clockwise. 90 for a run that reads up the page. */
  rotation: number
  /**
   * The page's traced scan face, when it has glyphs: the engine draws every
   * character the face holds with it and the rest with `fontName`, in one run.
   */
  faceId?: string
  /**
   * Drawn with render mode 3 — no ink, but text a reader extracts, copies and
   * searches. The partial redraw keeps the scan's pixels for the words it did
   * not change and puts their words back into the page this way.
   */
  invisible?: boolean
  /**
   * Stroke the glyphs the base-14 fallback draws by this many points (render
   * mode 2, the text's own colour) so their stems match the scan's — see
   * ocrStroke.ts. Traced glyphs are never stroked.
   */
  strokeWidth?: number
  /** Stroke the TRACED glyphs by this many points — an outline traced at the mass-conserving level renders lighter than the scan's blurred stems. */
  tracedStrokeWidth?: number
  /** Characters the scan face must not draw in this run (see `weightPlan`); the base-14 face takes them. */
  faceSkip?: string
  /**
   * Ops sharing a group are ONE line — the invisible head, the visible stretch
   * and the invisible tail of a partial redraw — and the bake writes them as
   * one text object. As three, MuPDF listed the visible stretch before its
   * own line's head, so the line no longer copied or searched in order.
   */
  group?: string
  /** For an invisible run: the width of the ink it stands for, so the engine can scale its advance to match. */
  fitWidth?: number
}

/** The scan's own pixels moved: read at `srcRect`, drawn at `dstRect` (same size), page points, top-left origin. */
export interface ImageOp {
  srcRect: RectT
  dstRect: RectT
  /** The run whose tail it moves. */
  item?: string
}

export interface OcrExportPlan {
  patches: PatchOp[]
  /** Painted after the patches and before the texts. */
  images: ImageOp[]
  texts: TextOp[]
  /** Per edited item id: how it was drawn, or why the partial redraw declined — for the sweep and the status line. */
  modes: Record<string, string>
}

/** The base-14 face for a family plus its weight and slant. */
export function base14(family: string, bold: boolean, italic: boolean): string {
  if (family.startsWith('Courier')) {
    return bold && italic ? 'Courier-BoldOblique' : bold ? 'Courier-Bold' : italic ? 'Courier-Oblique' : 'Courier'
  }
  if (family.startsWith('Times')) {
    return bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman'
  }
  return bold && italic ? 'Helvetica-BoldOblique' : bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica'
}

/**
 * Rough width of a string at a size, in points.
 *
 * Only used to place centred and right-aligned text. It does not have to be
 * exact — being a few points out shifts a line slightly, whereas not doing it
 * at all puts every centred heading hard against the left of its box.
 */
function approxWidth(text: string, fontSize: number, family: string): number {
  const perEm = family.startsWith('Courier') ? 0.6 : family.startsWith('Times') ? 0.48 : 0.52
  return text.length * fontSize * perEm
}

/**
 * The patch has to be a little larger than the box OCR reported.
 *
 * Recognition boxes hug the ink; the anti-aliased edges of the scan reach past
 * them, and a patch flush with the box leaves a grey outline of the old word.
 */
function patchRect(item: OcrTextItem): RectT {
  // The INK box, not the current one. They differ as soon as the run is dragged,
  // and painting over where the text has GONE leaves the photographed words
  // exactly where they were — so the page came back with them twice, once in
  // the scan and once as the replacement.
  const ink = item.inkRect ?? item.rect
  // The padding is around the RUN, not around the axes: a vertical run is tall
  // and narrow, so the generous pad has to go on x and the tight one on y or
  // the patch is a wide band across the page with the old ink still showing at
  // the ends of it.
  const across = item.vertical ? ink.width : ink.height
  const padY = item.vertical ? Math.max(1, across * 0.15) : Math.max(1, across * 0.12)
  const padX = item.vertical ? Math.max(1, across * 0.12) : Math.max(1, across * 0.15)
  // The ink measured OUTSIDE the box (an accent over the caps, a blurred
  // fringe) is covered too, with a hair to spare — the fixed pad alone left
  // the accent of a deleted "PERÚ" on the page.
  const halo = item.halo
  return [
    ink.x - Math.max(padX, (halo?.left ?? 0) + 0.5),
    ink.y - Math.max(padY, (halo?.top ?? 0) + 0.5),
    ink.x + ink.width + Math.max(padX, (halo?.right ?? 0) + 0.5),
    ink.y + ink.height + Math.max(padY, (halo?.bottom ?? 0) + 0.5)
  ]
}

/**
 * A patch never reaches over another run's words.
 *
 * The pads are proportional to the run's height, and on a cover's title that
 * is a lot of paper: 12% of a 166pt "RICO" is 20pt, and the patch took the
 * bottom half of "Y HÁGASE" above it and the whole of "LA RIQUEZA Y LA
 * REALIZACIÓN PERSONAL" below — the detector's box around the title already
 * held that line. So the patch stops at a neighbour:
 *
 * - a run whose centre lies OUTSIDE this one's box (the line above or below,
 *   a word beside it) trims only the pad — never into this run's own box,
 *   because on tightly set text two honest boxes overlap by an ascender, and
 *   cut at the neighbour's edge the tops of the erased capitals stay behind;
 * - a run whose centre lies INSIDE this one's box, but outside its middle
 *   band, is a line the box was inflated over: the patch stops at it, though
 *   never closer than a quarter of the run's height to its middle.
 *
 * On the scan's own pixels the ground fill (`groundFill`) decides the same
 * thing letter by letter; this is what a flat patch can do.
 */
export function clampToNeighbours(r: RectT, item: OcrTextItem, all: OcrTextItem[]): RectT {
  if (item.vertical) return r
  const ink = item.inkRect ?? item.rect
  let [x0, y0, x1, y1] = r
  const top = ink.y, bottom = ink.y + ink.height, left = ink.x, right = ink.x + ink.width
  const cy = top + ink.height / 2, band = ink.height * 0.25
  for (const o of all) {
    if (o === item || o.vertical) continue
    const b = o.inkRect ?? o.rect
    const bx1 = b.x + b.width, by1 = b.y + b.height, bcx = b.x + b.width / 2, bcy = b.y + b.height / 2
    if (b.x < x1 && bx1 > x0) {
      if (bcy < top) y0 = Math.max(y0, Math.min(top, by1 + 0.3))
      else if (bcy < cy - band) y0 = Math.max(y0, Math.min(cy - band, by1 + 0.3))
      else if (bcy > bottom) y1 = Math.min(y1, Math.max(bottom, b.y - 0.3))
      else if (bcy > cy + band) y1 = Math.min(y1, Math.max(cy + band, b.y - 0.3))
    }
    if (b.y < y1 && by1 > y0 && bcy >= cy - band && bcy <= cy + band) {
      if (bcx < left) x0 = Math.max(x0, Math.min(left, bx1 + 0.3))
      else if (bcx > right) x1 = Math.min(x1, Math.max(right, b.x - 0.3))
    }
  }
  return [x0, y0, x1, y1]
}

/**
 * The whole-run patch, following the LETTERS rather than the box.
 *
 * A long line of a skewed scan has an axis-aligned box far taller than its
 * letters (a 0.7° tilt over 470pt is 5.6pt of rise), and one rectangle over it
 * reaches into the line above at one end and the line below at the other: the
 * SEIDOR appendix lost the lower half of "…cantidad total de USD 3,150.00" when
 * the line under it was redrawn. With the glyph cut's fitted baseline the patch
 * is laid as a staircase of segments, each covering the letter band — an em
 * above the baseline (capital accents), a third below (descenders) — over a
 * stretch of the line where the baseline moves by half a point at most; each
 * stays inside the old rectangle, so it can only cover less.
 */
function bandPatches(item: OcrTextItem, cut: SpanCut | undefined): RectT[] {
  const box = patchRect(item)
  if (!cut || item.vertical || !(cut.emPt > 0)) return [box]
  const [X0, Y0, X1, Y1] = box
  const { yAtCentre, slope, centreX } = cut.baseline
  const yAt = (x: number) => yAtCentre + slope * (x - centreX)
  const rects = bandRects(X0, X1, yAt, slope, cut.emPt + 0.6 + (item.halo?.top ?? 0), cut.emPt * 0.35 + 0.6 + (item.halo?.bottom ?? 0), Y0, Y1)
  // A band that does not fit in the box means the cut does not describe this
  // run's ink; the box it always used is the honest answer.
  if (!rects.length || rects.some(r => !(r[3] - r[1] > cut.emPt * 0.5))) return [box]
  return rects
}

/**
 * A plain array, not the reactive one the store holds.
 *
 * Everything built here crosses postMessage into the engine worker, and a Vue
 * proxy cannot be structured-cloned — it fails as DataCloneError halfway
 * through, which is the same trap the ink tool and the page spill document.
 */
function plainColor(c: readonly number[] | undefined): [number, number, number] {
  return [Number(c?.[0] ?? 0), Number(c?.[1] ?? 0), Number(c?.[2] ?? 0)]
}

/**
 * Build the operations for one page's edited runs.
 *
 * @param items every run on the page; untouched ones are skipped here
 */
/**
 * The size a replacement can be drawn at without leaving the paper.
 *
 * A base-14 face is often wider than the scan's: Helvetica-Bold's "=" is
 * 0.58 em where a typewriter's is a third of that, so a run of them appended
 * to ended 80pt past the page edge and read back truncated. The run may
 * grow past its own box — that is what an edit does — but not past the
 * page, less a small margin; the size comes down just enough, never below
 * half the original.
 */
function fitSize(item: OcrTextItem, text: string, pageWidth: number | undefined, all: OcrTextItem[], widthAt10: number | null = null, originalWidthAt10: number | null = null, measured = false): number {
  let size = item.fontSize
  if (item.vertical) return size
  // The run's own WIDTH is the one measure a box cannot inflate. Its height
  // can: a tilted line's box is taller than its letters, a blurred cell
  // border with no empty row above it joins the box, and a table header set
  // at 4.7pt read 9.5pt from a 7.2pt box — the redraw then covered the row
  // above and ran across the next column. Set at the box's size, the
  // ORIGINAL words in the base-14 face should be about as wide as their ink;
  // when they come out a quarter wider or more, the size is brought down so
  // they are, never below six tenths.
  const ink = item.inkRect ?? item.rect
  const original = (item.originalText || item.text).trim()
  // Once the letters have been measured (or the user chose a size), do not
  // shrink that size again using a character-count estimate. Condensed faces
  // and narrow letters make that estimate especially misleading.
  if (!measured && !item.restyled && original && ink.width > 4) {
    if (originalWidthAt10 !== null && originalWidthAt10 > 0) {
      const natural = originalWidthAt10 * size / 10
      if (natural > ink.width * 1.05) size = Math.max(size * 0.6, Math.round(ink.width / originalWidthAt10 * 100) / 10)
    } else {
      const natural = approxWidth(original, size, item.fontFamily)
      if (natural > ink.width * 1.25) size = Math.max(size * 0.6, Math.round(size * (ink.width * 1.1 / natural) * 10) / 10)
    }
  }
  const margin = 12
  let room = pageWidth ? Math.max(20, pageWidth - margin - item.rect.x) : Infinity
  const near = nextRunRight(item, all)
  if (near !== null) room = Math.min(room, Math.max(20, near - item.rect.x))
  if (!Number.isFinite(room)) return size
  // The width the ENGINE will draw when the caller could measure it (the
  // traced face's own advances, the CJK face's ems), else the estimate: the
  // estimate counts every character as half an em, and "中國銀行 X" in a
  // traced calligraphic face is twice that, so the appended X was drawn
  // across the "秘鲁" beside it while the estimate said it fit.
  const width = widthAt10 !== null ? widthAt10 * size / 10 : approxWidth(text, size, item.fontFamily)
  if (width <= room) return size
  return Math.max(size * 0.5, Math.round(size * (room / width) * 10) / 10)
}

/**
 * The left edge of the next run along this line, or null when there is none.
 *
 * The paper is not the only thing a replacement can run into. A bilingual
 * inspection sheet puts "Within specifications (i)" and
 * "Within specifications* (ii) Outside specifications" side by side on one
 * row; appending a single character to the first drew it in Helvetica, which
 * is wider than the scan's face, straight across the second — and the page
 * then reads as one interleaved run of nonsense, exactly the shape of a
 * garbled edit even though the text itself is right. This is the same
 * accommodation `fitSize` already makes for the page edge, applied to the
 * nearer obstacle.
 *
 * Only a run that is CLEARLY to the right counts (its left edge past the
 * middle of this one) and only one sharing the line: detector boxes touch and
 * overlap a little, and a neighbour that starts inside this run's own box
 * cannot be what bounds it. A removed or edited neighbour still occupies the
 * row - the edit redraws it in place.
 */
function nextRunRight(item: OcrTextItem, all: OcrTextItem[]): number | null {
  const midY = item.rect.y + item.rect.height / 2
  const floor = item.rect.x + item.rect.width * 0.5
  let best: number | null = null
  for (const o of all) {
    if (o === item || o.vertical) continue
    if (midY < o.rect.y || midY > o.rect.y + o.rect.height) continue
    // Its INK is what is really there on the paper, wherever its box was dragged.
    const left = Math.min(o.rect.x, o.inkRect?.x ?? o.rect.x)
    if (left < floor) continue
    if (best === null || left < best) best = left
  }
  // A hair of clearance, so the two runs do not touch.
  return best === null ? null : best - 2
}

export function planOcrExport(
  items: OcrTextItem[],
  faceIdFor?: (item: OcrTextItem) => string | undefined,
  pageWidth?: number,
  /** The span geometry and measured stretch width for an item, when the caller has them — enables the partial redraw. */
  partialFor?: (item: OcrTextItem) => Omit<PartialContext, 'fontName' | 'color' | 'faceId'> | null,
  /** The engine-measured width of an item's full text at 10pt in the fonts that will draw it, when the caller has it. */
  widthAt10For?: (item: OcrTextItem) => number | null,
  /** The median measured weight of the traced glyphs an item's text will use, when the caller has a face — they are stroked up to the scan's stems. */
  tracedRatioFor?: (item: OcrTextItem) => number | null,
  /** Original reading measured in the same face: calibrates uncut, inflated OCR boxes. */
  originalWidthAt10For?: (item: OcrTextItem) => number | null
): OcrExportPlan {
  const patches: PatchOp[] = []
  const images: ImageOp[] = []
  const texts: TextOp[] = []
  const modes: Record<string, string> = {}

  for (const item of items) {
    if (!item.edited && !item.removed) continue

    if (item.removed) {
      patches.push({ rect: clampToNeighbours(patchRect(item), item, items), color: plainColor(item.background), item: item.id })
      modes[item.id] = 'removed'
      continue
    }

    const fontName = base14(item.fontFamily, item.bold, item.italic)

    // Only the CHANGED stretch, when its geometry is known: the untouched
    // head and tail keep the scan's own pixels. See partialRedraw.ts.
    const partial = !item.vertical ? partialFor?.(item) : null
    if (partial) {
      const outcome = planPartial(item, { ...partial, fontName: partial.localFontName ?? fontName, color: plainColor(item.color), faceId: faceIdFor?.(item), strokeRatio: item.strokeRatio }, items, pageWidth)
      if ('mode' in outcome) {
        patches.push(...outcome.patches.map(p => ({ ...p, rect: clampToNeighbours(p.rect, item, items) })))
        images.push(...outcome.images)
        texts.push(...outcome.texts)
        modes[item.id] = outcome.mode
        continue
      }
      modes[item.id] = `whole (${outcome.reason})`
    } else {
      modes[item.id] = 'whole'
    }

    for (const rect of bandPatches(item, partial?.cut)) patches.push({ rect: clampToNeighbours(rect, item, items), color: plainColor(item.background), item: item.id })

    if (item.vertical) {
      // Rotated a quarter turn anti-clockwise, the glyphs' own "up" points LEFT
      // across the page, so the ascenders are at the box's left edge and the
      // baseline runs down its right-hand side. Reading goes UP, so the run
      // starts at the foot of the box, not its head.
      texts.push({
        text: String(item.text),
        x: Number(item.rect.x + item.rect.width * 0.8),
        y: Number(item.rect.y + item.rect.height),
        fontSize: Number(item.fontSize),
        fontName,
        color: plainColor(item.color),
        rotation: 90,
        faceId: faceIdFor?.(item),
        strokeWidth: strokeWidthFor(item.strokeRatio, fontName, Number(item.fontSize)),
        tracedStrokeWidth: tracedStrokeUpTo(item.strokeRatio, tracedRatioFor?.(item) ?? undefined, Number(item.fontSize))
      })
      continue
    }

    // With a cut in hand the size comes from the letters themselves, not from
    // the box (see `sizeOf`); the whole-run redraw then agrees with the
    // partial one and with the traced face's own proportions.
    const ink = item.inkRect ?? item.rect
    // The scan's fitted baseline, unless the user restyled or moved the run —
    // a rotation they chose must not be overridden by the scan's tilt.
    const baseline = !item.restyled ? partial?.cut.baseline : undefined

    let x = item.rect.x
    const widthAt10 = widthAt10For?.(item) ?? null
    const sized = partial && !item.restyled ? { ...item, fontSize: sizeOf(item, partial.cut) } : item
    const fontSize = Number(fitSize(sized, item.text, pageWidth, items, widthAt10, originalWidthAt10For?.(item) ?? null, !!partial))
    if (item.align !== 'left') {
      const w = widthAt10 !== null ? widthAt10 * fontSize / 10 : approxWidth(item.text, fontSize, item.fontFamily)
      x = item.align === 'center'
        ? item.rect.x + (item.rect.width - w) / 2
        : item.rect.x + item.rect.width - w
      // Never push it off its own left edge, however wrong the estimate is.
      x = Math.max(x, item.rect.x)
    }

    // On the scan's fitted baseline (a skewed line's letters do not sit at a
    // fixed share of its box), mapped from the ink box to wherever the run now
    // is; without a cut, about four fifths of the way down the box.
    const baselineY = baseline
      ? baseline.yAtCentre + baseline.slope * (x - (item.rect.x - ink.x) - baseline.centreX) + item.rect.y - ink.y
      : item.rect.y + item.rect.height - Math.max(1, item.rect.height * 0.2)
    texts.push({
      text: String(item.text),
      x: Number(x),
      y: Number(baselineY),
      fontSize,
      fontName,
      color: plainColor(item.color),
      rotation: baseline ? -Math.atan(baseline.slope) * 180 / Math.PI : -item.rotation,
      faceId: faceIdFor?.(item),
      strokeWidth: strokeWidthFor(item.strokeRatio, fontName, fontSize),
      tracedStrokeWidth: tracedStrokeUpTo(item.strokeRatio, tracedRatioFor?.(item) ?? undefined, fontSize)
    })
  }

  return { patches, images, texts, modes }
}
