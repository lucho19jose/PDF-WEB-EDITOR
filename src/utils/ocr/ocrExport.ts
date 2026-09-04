import type { OcrTextItem } from './ocrTypes'
import type { RectT } from '@/engine/types'
import { planPartial, sizeOf, type PartialContext } from './partialRedraw'

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
  return [
    ink.x - padX,
    ink.y - padY,
    ink.x + ink.width + padX,
    ink.y + ink.height + padY
  ]
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
function fitSize(item: OcrTextItem, text: string, pageWidth: number | undefined, all: OcrTextItem[]): number {
  const size = item.fontSize
  if (item.vertical) return size
  const margin = 12
  let room = pageWidth ? Math.max(20, pageWidth - margin - item.rect.x) : Infinity
  const near = nextRunRight(item, all)
  if (near !== null) room = Math.min(room, Math.max(20, near - item.rect.x))
  if (!Number.isFinite(room)) return size
  const width = approxWidth(text, size, item.fontFamily)
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
  partialFor?: (item: OcrTextItem) => Omit<PartialContext, 'fontName' | 'color' | 'faceId'> | null
): OcrExportPlan {
  const patches: PatchOp[] = []
  const images: ImageOp[] = []
  const texts: TextOp[] = []
  const modes: Record<string, string> = {}

  for (const item of items) {
    if (!item.edited && !item.removed) continue

    if (item.removed) {
      patches.push({ rect: patchRect(item), color: plainColor(item.background) })
      modes[item.id] = 'removed'
      continue
    }

    const fontName = base14(item.fontFamily, item.bold, item.italic)

    // Only the CHANGED stretch, when its geometry is known: the untouched
    // head and tail keep the scan's own pixels. See partialRedraw.ts.
    const partial = !item.vertical ? partialFor?.(item) : null
    if (partial) {
      const outcome = planPartial(item, { ...partial, fontName, color: plainColor(item.color), faceId: faceIdFor?.(item) }, items, pageWidth)
      if ('mode' in outcome) {
        patches.push(...outcome.patches)
        images.push(...outcome.images)
        texts.push(...outcome.texts)
        modes[item.id] = outcome.mode
        continue
      }
      modes[item.id] = `whole (${outcome.reason})`
    } else {
      modes[item.id] = 'whole'
    }

    patches.push({ rect: patchRect(item), color: plainColor(item.background) })

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
        faceId: faceIdFor?.(item)
      })
      continue
    }

    // The baseline sits about four fifths of the way down the em from the top
    // of the box — placing text at the box top would print it a whole line high.
    const baselineY = item.rect.y + item.rect.height - Math.max(1, item.rect.height * 0.2)

    let x = item.rect.x
    if (item.align !== 'left') {
      const w = approxWidth(item.text, item.fontSize, item.fontFamily)
      x = item.align === 'center'
        ? item.rect.x + (item.rect.width - w) / 2
        : item.rect.x + item.rect.width - w
      // Never push it off its own left edge, however wrong the estimate is.
      x = Math.max(x, item.rect.x)
    }

    // With a cut in hand the size comes from the letters themselves, not from
    // the box (see `sizeOf`); the whole-run redraw then agrees with the
    // partial one and with the traced face's own proportions.
    const sized = partial ? { ...item, fontSize: sizeOf(item, partial.cut) } : item
    texts.push({
      text: String(item.text),
      x: Number(x),
      y: Number(baselineY),
      fontSize: Number(fitSize(sized, item.text, pageWidth, items)),
      fontName,
      color: plainColor(item.color),
      rotation: 0,
      faceId: faceIdFor?.(item)
    })
  }

  return { patches, images, texts, modes }
}
