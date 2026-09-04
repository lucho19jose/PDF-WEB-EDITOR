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
  /** The binarised box, rules already cleared — for tests that need more than the two profiles. */
  ink: Uint8Array
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
export function clearRuleSpans(ink: Uint8Array, w: number, h: number, minSpan: number, maxThick = 4): number {
  let cleared = 0
  // How many rows, counting this one, carry ink over most of the span's
  // columns. A rule is THIN - a hairline is one row at 220 DPI, a 1pt border
  // three, and a skewed one drifts a column or two per row, which the 70%
  // overlap absorbs. A word whose bold letters touch is not: "Detracción" at
  // 19px per em put a 60-column span in every row of its x-height band, nine
  // rows deep, and read as a rule it was blanked row by row until the box had
  // no ink left to measure. Thickness is what separates them.
  const thickness = (yy: number, start: number, end: number): number => {
    const cols = end - start + 1
    // Over 90% of the span's columns, not 70%: the bottoms of a heavy caps line
    // sitting ON its underline cover two thirds of the underline's columns,
    // and counted as part of it they made the rule "thick" and kept it.
    const inked = (r: number) => { let n = 0; for (let xx = start; xx <= end; xx++) n += ink[r * w + xx]; return n >= cols * 0.9 }
    let t = 1
    for (let r = yy - 1; r >= 0 && t <= maxThick && inked(r); r--) t++
    for (let r = yy + 1; r < h && t <= maxThick && inked(r); r++) t++
    return t
  }
  // Every thin span of at least a third of the bar is a CANDIDATE, and
  // candidates in neighbouring rows whose columns overlap are one thing: a
  // tilted rule crosses a box diagonally, and a 35pt line's underline put a
  // 120-column piece in each of six rows where the bar was 270 - no row on
  // its own was a rule, the underline stayed, the baseline was fitted through
  // it and the glyphs were traced floating above a bar. What is judged is
  // the CHAIN's extent, min x0 to max x1. A glyph's bottom bar ("E", "L") is
  // a few rows of the same 0.6em span - a chain no wider than the bar itself.
  const spans: { row: number; start: number; end: number }[] = []
  for (let yy = 0; yy < h; yy++) {
    const row = yy * w
    let start = -1, lastOn = -1
    for (let xx = 0; xx <= w; xx++) {
      const on = xx < w && ink[row + xx] === 1
      if (on) { if (start < 0) start = xx; lastOn = xx; continue }
      if (start < 0) continue
      if (xx - lastOn <= 1 && xx < w) continue
      const len = lastOn + 1 - start
      // A third of the bar. An eighth was tried, for a rule tilted enough to
      // leave 28 columns per row: it chained the tops of the letters it
      // crossed into the rule and shaved them off. That rule stays; a box it
      // crosses is refused by the height guard in the glyph cut instead.
      if (len >= minSpan * 0.3 && thickness(yy, start, lastOn) <= maxThick) spans.push({ row: yy, start, end: lastOn })
      start = -1
    }
  }
  if (!spans.length) return 0
  // Union-find over spans in adjacent rows that overlap in x (two columns of
  // slack for a rule that steps as it tilts).
  const parent = spans.map((_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  spans.sort((a, b) => a.row - b.row || a.start - b.start)
  let rowStart = 0
  for (let i = 0; i < spans.length; i++) {
    while (spans[rowStart].row < spans[i].row - 1) rowStart++
    for (let j = rowStart; j < i; j++) {
      if (spans[j].row !== spans[i].row - 1) continue
      if (spans[j].end + 2 >= spans[i].start && spans[i].end + 2 >= spans[j].start) {
        const a = find(i), b = find(j)
        if (a !== b) parent[a] = b
      }
    }
  }
  const chains = new Map<number, { x0: number; x1: number; members: number[] }>()
  spans.forEach((s, i) => {
    const r = find(i)
    const c = chains.get(r) ?? { x0: s.start, x1: s.end, members: [] }
    c.x0 = Math.min(c.x0, s.start); c.x1 = Math.max(c.x1, s.end); c.members.push(i)
    chains.set(r, c)
  })
  for (const c of chains.values()) {
    // A chain cut off by the box's own edge is only PART of whatever it is,
    // so the bar is lowered for it: a rule leaving the box through its side
    // showed 46 columns of a 200-column fragment, and a glyph touching the
    // edge is still no wider than a glyph (an ideograph about one em, the
    // bar here is 1.2 of the hinted em).
    const bar = (c.x0 === 0 || c.x1 === w - 1) ? minSpan * 0.6 : minSpan
    if (c.x1 - c.x0 + 1 < bar) continue
    // Blanked only now, after every row has been judged, or clearing one row
    // would thin the band the next row's thickness is measured against.
    for (const i of c.members) { const s = spans[i]; ink.fill(0, s.row * w + s.start, s.row * w + s.end + 1); cleared += s.end - s.start + 1 }
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
  // A rule's thickness: a quarter of the em when the em is known (the hint is
  // two ems), else a tenth of the box, never under four rows.
  clearRuleSpans(ink, w, h, ruleSpan ?? h * 1.5, Math.max(4, Math.round(ruleSpan ? ruleSpan * 0.125 : h * 0.12)))
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
  return { cols, rows, ruleCol, ink, x, y, width: w, height: h }
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
  let box = trimProfile(p, emHint)
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
    const box2 = p2 && trimProfile(p2, emHint)
    if (p2 && box2) return { x: p2.x + box2.left, y: p2.y + box2.top, width: box2.right - box2.left + 1, height: box2.bottom - box2.top + 1 }
  }
  return { x: p.x + box.left, y: p.y + box.top, width: box.right - box.left + 1, height: box.bottom - box.top + 1 }
}

/**
 * Extend a tight ink box DOWN through the rows its descenders occupy.
 *
 * PaddleOCR's detector boxes a line of small body text at its baseline, so
 * `inkBounds`, which only ever measures into the box it is given, returned a
 * box with no descender in it: the letters were sized a quarter too small and
 * the glyph cut flagged every p, q and g as not descending. Below the baseline
 * a line's ink is a few stems — sparse rows — and then an empty row before the
 * next line's ascenders. Rows are taken while they hold a stem's worth of ink
 * and stay sparse (under 15% of the width inked), up to 0.35 of the box's
 * height; the first empty or dense row stops it, so a neighbouring line is
 * never entered. A box that already held its descenders meets the empty row at
 * once and is unchanged.
 */
export function extendDescenders(ctx: CanvasRenderingContext2D, box: InkRect, text: string): InkRect {
  // Only a run that HAS descenders, and only as many stems as it has. Judged
  // on sparseness alone the walk went wherever the ink under a line was thin
  // enough: a 93pt logo's box grew down through the 16pt tagline beneath it
  // (the tagline's rows are under 15% of the logo's width), so the logo's
  // patch painted the tagline out; and under a book cover's title the
  // photograph read as sparse rows, the box grew into it, and the re-read
  // pieces came back as "ENE 40 ES". A descender row is a few NARROW stems —
  // at most one per descending letter, plus a couple for a comma or a tail
  // the box edge split — each no wider than a third of the line's height.
  const descenders = [...text].filter(c => /[gjpqyQ]/.test(c)).length
  if (!descenders) return box
  const maxRows = Math.round(box.height * 0.35)
  if (maxRows < 1) return box
  const band = { x: box.x, y: box.y + box.height, width: box.width, height: maxRows }
  const p = profile(ctx, band, box.width * 4)
  if (!p) return box
  // A stem's worth, NOT a share of the width: four descenders on an 81-letter
  // line are six pixels at 220 DPI, and one percent of that line's width is
  // thirteen — the walk stopped on the first row and nothing was extended.
  const minRow = 2
  const dense = p.width * 0.15
  const maxRun = Math.max(2, box.height * 0.34)
  const stemsOnly = (yy: number): boolean => {
    let runs = 0, run = 0
    for (let xx = 0; xx <= p.width; xx++) {
      const on = xx < p.width && p.ink[yy * p.width + xx] === 1
      if (on) run++
      else if (run) { if (run > maxRun) return false; runs++; run = 0 }
    }
    return runs <= descenders + 2
  }
  let ext = 0
  while (ext < p.height && p.rows[ext] >= minRow && p.rows[ext] < dense && stemsOnly(ext)) ext++
  return ext ? { ...box, height: box.height + ext } : box
}

/** The tight ink extent of a profile, or null when it holds nothing worth boxing. */
function trimProfile(p: Profile, emHint?: number): { top: number; bottom: number; left: number; right: number } | null {
  // Never one pixel: the edge column of a three-pixel cell border is inked
  // down 77% of the box, under the rule test's 80%, and its one pixel per row
  // held a box nine empty rows above its word ("Detracción", 15.1pt for a
  // 6pt word). A glyph row has at least a stem's worth.
  const minRow = Math.max(2, Math.round(p.width * 0.01))
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
  //
  // A band behind such a gap that is NOT sparse is a neighbouring line's
  // letters: the bold caps line above the RJ notice's address ends four rows
  // inside the address's box (200, 161, 112, 41 inked columns of 733), then
  // three empty rows, then the address. Sparse it is not — 27% of the width
  // in its densest row, against the 2% an accent or an "i" dot puts on a
  // line — so density tells the two apart. Such a band is stripped when it
  // is short beside the body (a quarter of it at most), dense (a row inked
  // over 15% of the width), on a box wide enough to be a line (four ems),
  // and what remains is at least half an em tall. Without it the address's
  // patch painted over the bottom of the line above, and its em, taken from
  // a box four rows too tall, drew the traced glyphs at 85% of their size.
  const emPx = emHint && emHint > 2 ? emHint : 0
  const strayBand = (from: number, limit: number, step: 1 | -1): number => {
    let yy = from, ink = 0, densest = 0
    while (Math.abs(yy - from) < bandRows && yy !== limit) {
      ink += p.rows[yy]
      if (p.rows[yy] > densest) densest = p.rows[yy]
      let gap = 0
      while (yy + step * (1 + gap) !== limit + step && p.rows[yy + step * (1 + gap)] < minRow) gap++
      if (gap >= gapRows) {
        const next = yy + step * (1 + gap)
        if (ink <= stray) return next
        const bandH = Math.abs(yy - from) + 1
        const bodyH = Math.abs(limit - next) + 1
        // A dense band behind a clear gap is the neighbouring line whatever
        // its height, up to most of the body's: a 4.5pt table set at 5.2pt
        // leading (the OT-GA order) put the bottom HALF of "ELABORACION" in
        // "MODALIDAD"'s box — five rows against a ten-row body, twice the
        // quarter the rule allowed — so the box read 5.9pt for 3.3pt of
        // letters, the em came out 7.8pt for 4.6, and the redraw painted
        // over the row above. The gap is what separates lines; accents and
        // dots never reach 15% of the width, so density still keeps them.
        const neighbour = emPx > 0 && p.width >= emPx * 4 && densest >= p.width * 0.15 &&
          bandH < bodyH * 0.8 && bodyH >= emPx * 0.5
        if (neighbour) return next
        // A blob in one CORNER: the black edge of a scanned page reaching into
        // the top-left of a title's box, tall and dense but confined to a
        // few columns. Text runs the width of its box; ink whose columns span
        // under an eighth of it is not text. Half an em of body must remain.
        let cx0 = p.width, cx1 = -1
        for (let r = Math.min(from, yy); r <= Math.max(from, yy); r++) {
          for (let xx = 0; xx < p.width; xx++) if (p.ink[r * p.width + xx] && !p.ruleCol[xx]) { if (xx < cx0) cx0 = xx; if (xx > cx1) cx1 = xx }
        }
        const corner = cx1 >= cx0 && (cx1 - cx0 + 1) <= p.width * 0.125 && p.width >= 8 * (cx1 - cx0 + 1) &&
          (emPx <= 0 || bodyH >= emPx * 0.5)
        return corner ? next : from
      }
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
