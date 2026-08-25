/** A text block extracted from the PDF content stream */
export interface TextBlock {
  /** Unique ID for this block (pageIndex:blockIndex) */
  id: string
  pageIndex: number

  /** Position in PDF user space (bottom-left origin) */
  x: number
  y: number
  width: number
  height: number

  /** Bounding box [x0, y0, x1, y1] in PDF coords */
  bbox: [number, number, number, number]

  /** Decoded text content */
  text: string

  /** Font info */
  fontName: string
  fontSize: number
  isBold: boolean
  isItalic: boolean

  /** Color as [r, g, b] normalized 0-1 */
  color: [number, number, number]

  /** Characters with individual positions (for precise editing) */
  chars: TextChar[]
}

export interface TextChar {
  /** The character */
  c: string
  /** Origin point [x, y] in PDF coords */
  origin: [number, number]
  /** Quad corners [ulx, uly, urx, ury, llx, lly, lrx, lry] */
  quad: [number, number, number, number, number, number, number, number]
  /** Font size at this char */
  size: number
  /** Font name */
  fontName: string
  /**
   * Fill colour as [r, g, b] normalized 0-1.
   *
   * Per CHARACTER, not per block: MuPDF merges a whole paragraph into one
   * structured-text block, so a block-level colour is whatever its first line
   * happened to be. A line recoloured on its own would report the paragraph's
   * colour and the toolbar would show the wrong swatch for it.
   */
  color?: [number, number, number]
}

/** A line of text (group of chars on the same baseline) */
export interface TextLine {
  bbox: [number, number, number, number]
  wmode: number
  chars: TextChar[]
  text: string
}

/** Result of parsing a page's text */
export interface PageTextData {
  pageIndex: number
  blocks: TextBlock[]
  lines: TextLine[]
}

/** Quad: [ulx, uly, urx, ury, llx, lly, lrx, lry] — matches MuPDF Quad & TextChar.quad */
export type Quad = [number, number, number, number, number, number, number, number]
/** Point [x, y] in page space (top-left origin, y-down) */
export type Pt = [number, number]
/** Rect [x0, y0, x1, y1] in page space (top-left origin, y-down) */
export type RectT = [number, number, number, number]

export type MarkupType = 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly'
export type ShapeType = 'Square' | 'Circle' | 'Line'

/** Summary of an existing annotation on a page (index is positional within the page). */
/**
 * An image drawn by the page CONTENT (an /Image XObject invoked with Do) —
 * a logo, a photo, a scan — as opposed to an image the user stamped as an
 * annotation. Identified by where its Do sits, since the same XObject can be
 * invoked more than once.
 */
export interface ContentImageInfo {
  id: number
  /** Content source that invokes it ('page' or 'xobj:/…'). */
  sourceKey: string
  /** Offset of the `/Name Do` in that source's stream. */
  doOffset: number
  name: string
  /** Bounds in page space (top-left origin, y-down), rotation included. */
  rect: RectT
}

export interface AnnotationInfo {
  index: number
  type: string
  /** Bounds in page space (top-left origin, y-down) */
  rect: RectT
  color: number[]
  interiorColor: number[]
  opacity: number
  borderWidth: number
  contents: string
  author: string
  hasQuadPoints: boolean
}

/**
 * One block's share of a batched transform.
 *
 * Moving a multi-block selection — and pushing whatever it would have landed
 * on out of the way — has to be ONE engine call: every separate call re-extracts
 * the page, and block ids are extraction indices, so the second call in a pair
 * would be addressing a page that the first one already renumbered.
 *
 * dx/dy are in PDF Tm space (bottom-left origin, y up); anchorX/anchorY too.
 */
export interface BlockTransformOp {
  blockId: string
  dx: number
  dy: number
  sx: number
  sy: number
  anchorX: number
  anchorY: number
}

/**
 * Restyle one already-drawn text block. Every field is optional: an absent one
 * means "leave this as the page has it", which is what makes changing only the
 * colour of text in a font this engine cannot re-encode still work.
 */
export interface BlockStyleOp {
  blockId: string
  /** Base-14 family name — 'Helvetica' | 'Times-Roman' | 'Courier'. */
  fontName?: string
  fontSize?: number
  /** Fill colour as [r, g, b] normalized 0-1. */
  color?: [number, number, number]
}

/** Per-op outcome of a batched transform, in the order the ops were given. */
export interface BlockTransformResult {
  blockId: string
  success: boolean
  error?: string
  /**
   * Lines the block draws after the op. Grows when a bigger font no longer fits
   * between its left edge and the right margin and has to wrap — the caller
   * needs it to push the rest of the page down, or the extra lines are painted
   * over the next paragraph.
   */
  lines?: number
  /**
   * Points the block's own baseline was moved down, in page space.
   *
   * A bigger font grows UPWARD from the baseline as well as down, so a resized
   * run climbs into the line above it unless it descends by the ascent it
   * gained. The engine does that as part of the same rewrite — the block's text
   * changes when it wraps, so it cannot be re-found and moved afterwards — and
   * reports it, because the room made below has to include it.
   */
  baselineDrop?: number
  strategy?: string
  clipAdjusted?: boolean
}

/** A text search hit: one match made of one or more quads (multi-line). */
export interface SearchHit {
  pageIndex: number
  quads: Quad[]
  /** Bounding rect of all quads in page space */
  rect: RectT
}
