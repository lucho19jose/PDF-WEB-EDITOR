/**
 * What the INK inside a box says, for engines that report nothing finer than
 * the box.
 *
 * PaddleOCR returns one detector box per text region and no glyph boxes, and
 * the detector pads generously: a 6.5pt Chinese label came back in a box 11.5pt
 * tall, so sizing from the box put every cell at nearly double its size. The
 * pixels are still there. A binarised projection of the box gives the tight
 * vertical extent of the glyphs (the em, near enough), and the run of empty
 * columns between two table cells that the detector merged.
 */

export interface InkRect { x: number; y: number; width: number; height: number }

interface Profile {
  /** Ink pixels per column, left to right. */
  cols: Uint16Array
  /** Ink pixels per row, top to bottom. */
  rows: Uint16Array
  /** 1 where a column is a vertical rule (inked down most of the box). */
  ruleCol: Uint8Array
  x: number
  y: number
  width: number
  height: number
}

function profile(ctx: CanvasRenderingContext2D, rect: InkRect): Profile | null {
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const w = Math.min(ctx.canvas.width - x, Math.ceil(rect.width))
  const h = Math.min(ctx.canvas.height - y, Math.ceil(rect.height))
  if (w < 3 || h < 3) return null
  let px: Uint8ClampedArray
  try { px = ctx.getImageData(x, y, w, h).data } catch (_) { return null }
  // Threshold at the midpoint of the box's own range, as the face detector does.
  const gray = new Uint8Array(w * h)
  let lo = 255, hi = 0
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000
    gray[j] = g
    if (g < lo) lo = g
    if (g > hi) hi = g
  }
  if (hi - lo < 24) return null
  const threshold = (lo + hi) / 2
  const ink = new Uint8Array(w * h)
  const rawCols = new Uint16Array(w)
  const rawRows = new Uint16Array(h)
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      if (gray[yy * w + xx] < threshold) { ink[yy * w + xx] = 1; rawCols[xx]++; rawRows[yy]++ }
    }
  }
  // Table rules are not glyphs. A column inked down most of the box is a
  // vertical rule (measured: a 3px rule at the edge of every cell box put 3
  // ink pixels on every blank row, so no row ever read as empty); a row inked
  // across most of the box is a horizontal one. Both are left out of the
  // other axis's profile, so a rule neither inflates the glyph height nor
  // closes the gap between two cells.
  const ruleCol = new Uint8Array(w)
  const ruleRow = new Uint8Array(h)
  for (let xx = 0; xx < w; xx++) if (rawCols[xx] >= h * 0.8) ruleCol[xx] = 1
  for (let yy = 0; yy < h; yy++) if (rawRows[yy] >= w * 0.8) ruleRow[yy] = 1
  const cols = new Uint16Array(w)
  const rows = new Uint16Array(h)
  for (let yy = 0; yy < h; yy++) {
    if (ruleRow[yy]) continue
    for (let xx = 0; xx < w; xx++) {
      if (ruleCol[xx] || !ink[yy * w + xx]) continue
      cols[xx]++
      rows[yy]++
    }
  }
  return { cols, rows, ruleCol, x, y, width: w, height: h }
}

/**
 * The tight box of the ink inside `rect`, in canvas pixels, or `rect` itself
 * when the box is blank or unreadable.
 *
 * A row or column counts as inked when it holds more than a speck — a table
 * rule grazing the top of a box is one or two rows of solid ink, and those
 * are dropped by asking for ink on more than 2% of the box's other axis only
 * AFTER trimming the outermost such rows. Rules are handled by the caller
 * where they matter (they are wide, glyph rows are not).
 */
export function inkBounds(ctx: CanvasRenderingContext2D, rect: InkRect): InkRect {
  const p = profile(ctx, rect)
  if (!p) return rect
  const minRow = Math.max(1, Math.round(p.width * 0.01))
  const minCol = Math.max(1, Math.round(p.height * 0.05))
  let top = 0, bottom = p.height - 1
  while (top < bottom && p.rows[top] < minRow) top++
  while (bottom > top && p.rows[bottom] < minRow) bottom--
  // A horizontal rule is a row inked across most of the width; glyph rows
  // never are. Strip such rows from the ends so a cell border does not read
  // as an ascender.
  const rule = p.width * 0.85
  while (top < bottom && p.rows[top] > rule) top++
  while (bottom > top && p.rows[bottom] > rule) bottom--
  while (top < bottom && p.rows[top] < minRow) top++
  while (bottom > top && p.rows[bottom] < minRow) bottom--
  let left = 0, right = p.width - 1
  while (left < right && p.cols[left] < minCol) left++
  while (right > left && p.cols[right] < minCol) right--
  if (bottom - top < 2 || right - left < 2) return rect
  return { x: p.x + left, y: p.y + top, width: right - left + 1, height: bottom - top + 1 }
}

/**
 * Where a merged box should be cut: the centres of the empty column runs
 * wider than `minGap` pixels, left to right, as x offsets in canvas pixels.
 * A gap that is the box's own margin (touching either end) is not a cut.
 */
export interface InkCut {
  /** Canvas x of the cut. */
  x: number
  /** Share (0–1) of the box's ink that lies left of the cut — what the text is shared out by. */
  inkShare: number
}

export function inkGaps(ctx: CanvasRenderingContext2D, rect: InkRect, minGap: number): InkCut[] {
  const p = profile(ctx, rect)
  if (!p) return []
  const minCol = Math.max(1, Math.round(p.height * 0.05))
  // Cumulative OCCUPIED columns, rules excluded: the share of inked columns
  // left of a cut tracks the share of glyphs. Width does not (the gap and the
  // rule take width no glyph does — the cut fell one ideograph early), and
  // ink MASS does not either (辽宁泓瑞 carries twice the strokes of 有限公司 —
  // the cut then fell three ideographs early). A glyph occupies about the same
  // run of columns whatever its stroke count.
  let total = 0
  const cumInk = new Float64Array(p.width + 1)
  for (let xx = 0; xx < p.width; xx++) { total += (!p.ruleCol[xx] && p.cols[xx] >= minCol) ? 1 : 0; cumInk[xx + 1] = total }
  const shareAt = (x: number) => {
    const i = Math.max(0, Math.min(p.width, Math.round(x - p.x)))
    return total > 0 ? cumInk[i] / total : (x - p.x) / Math.max(p.width, 1)
  }
  const cuts: number[] = []
  let runStart = -1
  for (let xx = 0; xx <= p.width; xx++) {
    const empty = xx < p.width && p.cols[xx] < minCol
    if (empty && runStart < 0) runStart = xx
    if (!empty && runStart >= 0) {
      const len = xx - runStart
      if (len >= minGap && runStart > 0 && xx < p.width) cuts.push(p.x + runStart + len / 2)
      runStart = -1
    }
  }
  // A vertical rule INSIDE the box is a cell boundary whatever the gap either
  // side of it: the survey's cells sit five points from their rules, less
  // than any word gap, and the detector read straight across.
  //
  // Looked for on a box stretched HALF ITS HEIGHT up and down: in the tight
  // glyph box every stem of a 司 or an "l" spans most of the height and read
  // as a rule — the page came back shredded into 276 one-glyph pieces. A rule
  // runs on past the glyph band; a stem stops at it.
  const tall = { x: rect.x, y: rect.y - rect.height * 0.5, width: rect.width, height: rect.height * 2 }
  const t = profile(ctx, tall)
  if (!t) return cuts.sort((a, b) => a - b).map(x => ({ x, inkShare: shareAt(x) }))
  const edge = Math.max(2, Math.round(t.width * 0.03))
  let ruleStart = -1
  for (let xx = 0; xx <= t.width; xx++) {
    const isRule = xx < t.width && t.ruleCol[xx] === 1
    if (isRule && ruleStart < 0) ruleStart = xx
    if (!isRule && ruleStart >= 0) {
      const mid = ruleStart + (xx - ruleStart) / 2
      if (ruleStart > edge && xx < t.width - edge) cuts.push(t.x + mid)
      ruleStart = -1
    }
  }
  return cuts.sort((a, b) => a - b).map(x => ({ x, inkShare: shareAt(x) }))
}
