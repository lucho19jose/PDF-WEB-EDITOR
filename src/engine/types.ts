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
