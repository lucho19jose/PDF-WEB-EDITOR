import type { OcrTextItem } from './ocrTypes'
import type { RectT } from '@/engine/types'

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
}

export interface OcrExportPlan {
  patches: PatchOp[]
  texts: TextOp[]
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
  // The padding is around the RUN, not around the axes: a vertical run is tall
  // and narrow, so the generous pad has to go on x and the tight one on y or
  // the patch is a wide band across the page with the old ink still showing at
  // the ends of it.
  const across = item.vertical ? item.rect.width : item.rect.height
  const padY = item.vertical ? Math.max(1, across * 0.15) : Math.max(1, across * 0.12)
  const padX = item.vertical ? Math.max(1, across * 0.12) : Math.max(1, across * 0.15)
  return [
    item.rect.x - padX,
    item.rect.y - padY,
    item.rect.x + item.rect.width + padX,
    item.rect.y + item.rect.height + padY
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
export function planOcrExport(items: OcrTextItem[]): OcrExportPlan {
  const patches: PatchOp[] = []
  const texts: TextOp[] = []

  for (const item of items) {
    if (!item.edited && !item.removed) continue

    patches.push({ rect: patchRect(item), color: plainColor(item.background) })
    if (item.removed) continue

    const fontName = base14(item.fontFamily, item.bold, item.italic)

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
        rotation: 90
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

    texts.push({
      text: String(item.text),
      x: Number(x),
      y: Number(baselineY),
      fontSize: Number(item.fontSize),
      fontName,
      color: plainColor(item.color),
      rotation: 0
    })
  }

  return { patches, texts }
}
