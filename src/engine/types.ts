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

/** A text search hit: one match made of one or more quads (multi-line). */
export interface SearchHit {
  pageIndex: number
  quads: Quad[]
  /** Bounding rect of all quads in page space */
  rect: RectT
}
