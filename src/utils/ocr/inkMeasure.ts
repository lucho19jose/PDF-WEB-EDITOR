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

/**
 * Blank every horizontal ink span of `minSpan` pixels or more, and return how
 * many pixels went.
 *
 * A table border on a scan is never quite level, so where a box's edge meets
 * one, the rule lies inside the box for PART of its width and leaves it
 * again: on a bilingual contract form the row border ran through the top
 * pixel row of a title's box for 181 of its 690 columns, and through the
 * "UsD 204,754.68 …" box for 885 of 1099. The row-count test ("inked across
 * 80% of the width") cannot see a fragment like that, and it did two kinds of
 * damage. It fused every letter column under it into ONE ink run, so the
 * glyph cut had seven letters in a single cell and every cell after it held
 * the letter to its left — the line rendered as "MEJOR MIIIEI TAI DR …" — and
 * it counted as the top of the ink, so the box was measured ten rows too tall
 * and the line was sized 13.8pt where its neighbours are 10.3.
 *
 * What tells a rule from glyphs is not how much of the row it covers but how
 * FAR it runs unbroken: no glyph is wider than an em, so a contiguous span of
 * one and a half box heights or more is a rule whatever its share of the
 * width. Only the span is blanked, never the row — a fused pair of letters in
 * the x-height band of a blurred scan is left alone, and clearing the whole
 * row would cut every other glyph on it in two. A one-pixel break does not
 * end a span; a scanner drops pixels off a thin line as readily as off a stem.
 */
export function clearRuleSpans(ink: Uint8Array, w: number, h: number, minSpan: number): number {
  let cleared = 0
  for (let yy = 0; yy < h; yy++) {
    const row = yy * w
    let start = -1, lastOn = -1
    for (let xx = 0; xx <= w; xx++) {
      const on = xx < w && ink[row + xx] === 1
      if (on) { if (start < 0) start = xx; lastOn = xx; continue }
      if (start < 0) continue
      if (xx - lastOn <= 1 && xx < w) continue
      const len = lastOn + 1 - start
      // A span cut off by the box's own edge is only PART of whatever it is,
      // so the bar is lowered for it: a rule leaving the box through its side
      // showed 46 columns of a 200-column fragment, and a glyph touching the
      // edge is still no wider than a glyph (an ideograph about one em, the
      // bar here is 1.2 of the hinted em).
      const bar = (start === 0 || lastOn === w - 1) ? minSpan * 0.6 : minSpan
      if (len >= bar) { ink.fill(0, row + start, row + lastOn + 1); cleared += len }
      start = -1
    }
  }
  return cleared
}

function profile(ctx: CanvasRenderingContext2D, rect: InkRect, ruleSpan?: number): Profile | null {
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
  let dark = 0
  for (let j = 0; j < gray.length; j++) { if (gray[j] < threshold) { ink[j] = 1; dark++ } }
  // Light text on a dark band: the dark side is the paper there. Read as
  // ink, every letter became a "gap" and every stretch of background a
  // "rule", and a slide's title was cut between its letters and re-read as
  // "S CAP", "IN PACITAC", "ER CIÓN PRO". More than half dark means flip.
  if (dark > gray.length * 0.5) for (let j = 0; j < ink.length; j++) ink[j] = 1 - ink[j]
  // A rule that is only PARTLY inside the box — see `clearRuleSpans`. The
  // detector's box is padded, so on its own height the bar can only be set
  // generously; `inkBounds` comes back with a bar from the TIGHT height.
  clearRuleSpans(ink, w, h, ruleSpan ?? h * 1.5)
  const rawCols = new Uint16Array(w)
  const rawRows = new Uint16Array(h)
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      if (ink[yy * w + xx]) { rawCols[xx]++; rawRows[yy]++ }
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
export function inkBounds(ctx: CanvasRenderingContext2D, rect: InkRect, emHint?: number): InkRect {
  // Two ems is a span no glyph reaches (an ideograph is about one), and the
  // em can be GUESSED from the text before any ink is measured — the box's
  // width over the advances its characters are expected to take — which is
  // what makes the bar independent of the box's height. The height is the one
  // thing a rule fragment inflates, so a bar set from it chases its own tail.
  const hinted = emHint && emHint > 2 ? emHint * 2 : undefined
  const p = profile(ctx, rect, hinted)
  if (!p) return rect
  let box = trimProfile(p)
  if (!box) return rect
  // Second pass with the rule bar set from the TIGHT height. The first pass
  // could only measure spans against the detector's padded box, and a thick
  // skewed border left a 193px fragment in the top rows of a bold line's box
  // that was shorter than one and a half of THAT height — so the box kept the
  // fragment as its top and came out 13.8pt for an 11.4pt line. Twice the
  // tight height is a bar no glyph reaches (an ideograph is about one), and
  // the tight height is known now, so the profile is taken again against it.
  const tight = box.bottom - box.top + 1
  if (tight * 2 < (hinted ?? p.height * 1.5)) {
    const p2 = profile(ctx, rect, tight * 2)
    const box2 = p2 && trimProfile(p2)
    if (p2 && box2) return { x: p2.x + box2.left, y: p2.y + box2.top, width: box2.right - box2.left + 1, height: box2.bottom - box2.top + 1 }
  }
  return { x: p.x + box.left, y: p.y + box.top, width: box.right - box.left + 1, height: box.bottom - box.top + 1 }
}

/** The tight ink extent of a profile, or null when it holds nothing worth boxing. */
function trimProfile(p: Profile): { top: number; bottom: number; left: number; right: number } | null {
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
  // The detector's padded box reaches into the line above or below, and the
  // tips of THAT line's glyphs — a descender, the foot of an ideograph — are a
  // few inked pixels at the very edge of the box with a clear gap between them
  // and this line's own ink. Read as this line's ascender they made a 10pt
  // line 15pt tall. A band at either edge that is cut off from the body by an
  // empty gap and holds almost none of the box's ink is not this line's. An
  // accent or an "i" dot never qualifies: on a line with no ascender it forms a
  // band of its own, but a band worth several percent of the ink.
  //
  // The band runs up to the first gap of `gapRows` empty rows; smaller breaks
  // inside it are part of it. The crumbs a cleared rule leaves behind — its
  // anti-aliased fringe, a tail cut off by the box edge — come as several
  // thin rows with single empty rows between, and stopping at the first break
  // kept them as the top of the box (measured: a 40-row box for 33 rows of
  // glyphs). Up to three bands are stripped from each end, since one band's
  // removal can expose the next.
  const totalInk = p.rows.subarray(top, bottom + 1).reduce((s, v) => s + v, 0)
  const stray = totalInk * 0.015
  const gapRows = 3
  const bandRows = Math.max(2, Math.round((bottom - top + 1) * 0.3))
  const strayBand = (from: number, limit: number, step: 1 | -1): number => {
    let yy = from, ink = 0
    while (Math.abs(yy - from) < bandRows && yy !== limit) {
      ink += p.rows[yy]
      let gap = 0
      while (yy + step * (1 + gap) !== limit + step && p.rows[yy + step * (1 + gap)] < minRow) gap++
      if (gap >= gapRows) return ink <= stray ? yy + step * (1 + gap) : from
      yy += step * (1 + gap)
    }
    return from
  }
  for (let n = 0; n < 3; n++) { const t = strayBand(top, bottom, 1); if (t === top) break; top = t }
  for (let n = 0; n < 3; n++) { const b = strayBand(bottom, top, -1); if (b === bottom) break; bottom = b }
  let left = 0, right = p.width - 1
  while (left < right && p.cols[left] < minCol) left++
  while (right > left && p.cols[right] < minCol) right--
  if (bottom - top < 2 || right - left < 2) return null
  return { top, bottom, left, right }
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

export function inkGaps(ctx: CanvasRenderingContext2D, rect: InkRect, minGap: number, emHint?: number): InkCut[] {
  const hinted = emHint && emHint > 2 ? emHint * 2 : undefined
  const p = profile(ctx, rect, hinted)
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
  const t = profile(ctx, tall, hinted)
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
