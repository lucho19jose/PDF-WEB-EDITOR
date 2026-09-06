/**
 * Matching the WEIGHT of a fallback glyph to the scan it sits beside.
 *
 * A character the scan face cannot draw (a letter the page never showed) is
 * set in a base-14 face, and Helvetica-Bold's stems are not the scan's:
 * appending "MAESTRA" to a scanned title measured 0.161 em of stem on the
 * scan and 0.138 em on the Helvetica-Bold beside it, and the word read as
 * pasted in from another document — lighter, at the same size, on the same
 * baseline. The face detector already measures the scan's stems
 * (`FaceCues.strokeRatio`, the median horizontal ink run over the em); the
 * base-14 faces' stems come from `tools/ocr-calibrate/measure.mjs` at the
 * same resolution. The difference is drawn as a STROKE around the fallback
 * glyphs (render mode 2, fill + stroke, in the text's own colour), which
 * widens every stem by the stroke width. A traced glyph is never stroked: it
 * already has the scan's weight, because it is the scan's ink.
 */

/** Median stem over the em of each base-14 face, measured at 220 DPI (12pt and 24pt averaged). */
const FACE_STEM: Record<string, number> = {
  'Helvetica': 0.088, 'Helvetica-Oblique': 0.088,
  'Helvetica-Bold': 0.143, 'Helvetica-BoldOblique': 0.143,
  'Times-Roman': 0.082, 'Times-Italic': 0.082,
  'Times-Bold': 0.136, 'Times-BoldItalic': 0.136,
  'Courier': 0.055, 'Courier-Oblique': 0.055,
  'Courier-Bold': 0.136, 'Courier-BoldOblique': 0.136
}

/**
 * Below this the difference is one pixel of measurement at OCR resolution
 * (a 12pt em is 37 px at 220 DPI, so one pixel is 0.027 em), not a weight.
 */
const MIN_EXTRA_EM = 0.015
/** A stroke past this turns letters into blobs; a heavier scan is a picture, not a weight. */
const MAX_EXTRA_EM = 0.05

/**
 * Stroke width in points that brings `fontName` at `fontSize` up to the
 * scan's measured stem, or undefined when the face is already as heavy.
 */
export function strokeWidthFor(strokeRatio: number | undefined, fontName: string, fontSize: number): number | undefined {
  return strokeUpTo(strokeRatio, FACE_STEM[fontName], fontSize)
}

/**
 * Stroke width in points that brings a face whose stems measure `have` (over
 * the em) up to `target`, or undefined when there is nothing to add. Used for
 * the base-14 faces (their stems from the table above) and for the TRACED
 * glyphs: an outline traced at the mass-conserving level renders crisp, and
 * measured the same way as the scan's blurred stems it comes out lighter —
 * 0.148 em against 0.172 on a title — so beside a stroked fallback "M" the
 * traced "AE" read thin. Both are brought to the scan's own measurement.
 */
export function strokeUpTo(target: number | undefined, have: number | undefined, fontSize: number): number | undefined {
  if (!target || !(target > 0) || !(fontSize > 0) || have === undefined || !(have >= 0)) return undefined
  const extra = target - have
  if (extra < MIN_EXTRA_EM) return undefined
  return Math.round(Math.min(extra, MAX_EXTRA_EM) * fontSize * 100) / 100
}

/**
 * The same for a TRACED glyph, at half the nominal width. A traced outline is
 * not a designed one: potrace leaves it with many short segments, and a
 * round-joined stroke puffs every one of them, so the stems grow by about
 * twice the line width. Measured on the contract's title (detector ratio at
 * 220 DPI): traced unstroked 0.148, target 0.172, stroked at the nominal
 * 0.37pt 0.197 — half the width lands on the target.
 */
export function tracedStrokeUpTo(target: number | undefined, have: number | undefined, fontSize: number): number | undefined {
  if (!target || !(target > 0) || !(fontSize > 0) || have === undefined || !(have >= 0)) return undefined
  const extra = target - have
  // A lower floor than the base-14 case: the bitmap's ratio overstates what
  // the traced outline renders at by about a hundredth of an em, so a
  // difference the fallback rule would call noise is still a lighter glyph
  // here — and the halved, round-joined stroke is gentle.
  if (extra < 0.008) return undefined
  return Math.round(Math.min(extra, MAX_EXTRA_EM) * fontSize * 50) / 100
}
