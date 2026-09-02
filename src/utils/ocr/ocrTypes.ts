/**
 * The model for text recovered from a scanned page.
 *
 * A scanned PDF has no text objects at all — the page is a picture of a
 * document. OCR gives back where the ink is and what it probably says, and this
 * is the shape that knowledge takes so the rest of the app can treat it like
 * text without pretending it came from a content stream.
 *
 * Everything here is in PDF PAGE space (top-left origin, y down, points), NOT
 * in the pixels OCR actually worked on. The conversion happens once, at the
 * boundary, so nothing downstream has to know what resolution the page was
 * rasterised at.
 */

/** Where a run of recognised text sits, in page points. */
export interface OcrRect {
  x: number
  y: number
  width: number
  height: number
}

export type OcrAlign = 'left' | 'center' | 'right'

/**
 * One editable run of recognised text — a LINE, not a word.
 *
 * Lines are the unit a person edits: words are what OCR is confident about, but
 * nobody wants to click twenty boxes to fix a sentence. Word boxes are kept so
 * a replacement can be measured against what was actually there.
 */
export interface OcrTextItem {
  id: string
  pageIndex: number

  /** What OCR read. `text` is what the user has since made of it. */
  originalText: string
  text: string

  rect: OcrRect
  /**
   * Where the INK is on the scan — the box OCR read, never moved.
   *
   * `rect` is where the run is now, and the user may have dragged it. The two
   * were one field, and a dragged run then patched out the paper it had moved
   * ONTO while leaving its own photographed ink uncovered: the words appeared
   * twice, once in the scan and once in the replacement. A patch has to cover
   * where the ink was; only the text follows the box.
   */
  inkRect: OcrRect
  /** Word boxes inside the line, page space — kept for measurement and debugging. */
  words: OcrRect[]
  /** Per-glyph boxes, page space, one per non-space character — when the engine reported them. */
  symbols?: OcrRect[]

  /** Point size estimated from the line's ascender-to-descender height. */
  fontSize: number
  /** A base-14 face chosen to look like what OCR saw; the user may change it. */
  fontFamily: string
  bold: boolean
  italic: boolean
  /** Sampled from the darkest pixels inside the line, normalized 0-1. */
  color: [number, number, number]
  /** Sampled from the page around the line — what a patch must be painted with. */
  background: [number, number, number]

  align: OcrAlign
  /** Degrees clockwise from horizontal, from the OCR baseline. */
  rotation: number
  /**
   * True for a run that reads bottom-to-top up the page.
   *
   * Its `rect` is the upright box the text occupies — tall and narrow — while
   * the text inside runs along the box's HEIGHT. Kept as its own flag rather
   * than as `rotation: -90`, because the two mean different things: rotation is
   * a scan's few degrees of skew, and every consumer has to lay a vertical run
   * out differently rather than just tilting it.
   */
  vertical: boolean

  /** 0-100 from OCR. Low confidence is worth showing rather than hiding. */
  confidence: number

  /** True once the user has changed anything that has to be drawn over the scan. */
  edited: boolean
  /** True when the user deleted it: the area is patched and nothing is drawn. */
  removed: boolean
}

/** What one page's OCR pass produced. */
export interface OcrPageResult {
  pageIndex: number
  items: OcrTextItem[]
  /** Page size in points, so the caller can check the geometry matches. */
  pageWidth: number
  pageHeight: number
  /** Mean confidence, for telling the user how much to trust it. */
  confidence: number
  lang: string
  /** How many runs were read sideways — worth reporting, it is optional work. */
  verticalCount?: number
  /** Which recogniser produced this — the status line says so, and a fallback is visible. */
  engine?: 'paddle' | 'tesseract' | 'mistral'
  /** Set when the chosen engine could not run and another read the page instead. */
  fallbackNote?: string
}

/** Why a page was judged to need OCR — reported so the decision is not a black box. */
export interface ScannedVerdict {
  scanned: boolean
  /** Characters the PDF's own text layer holds for this page. */
  extractedChars: number
  reason: string
}
