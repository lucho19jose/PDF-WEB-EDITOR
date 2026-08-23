/**
 * Keeping moved text from landing on top of other text.
 *
 * A PDF content stream has no notion of flow: every run is drawn at absolute
 * coordinates, so dragging a paragraph on top of another one produces two
 * paragraphs painted over each other rather than a reflow. What IS well defined
 * is "these two runs now occupy the same strip of page" — so the text that was
 * already there is pushed clear along Y, and nothing else on the page is
 * touched. That is a displacement, not a reflow, and the difference matters:
 * reflow would have to re-break lines and re-justify, which no amount of
 * content-stream editing can do safely on a table or a form.
 *
 * All rects are PDF PAGE space: [x0, y0, x1, y1] with a TOP-LEFT origin and y
 * growing DOWNWARDS, which is what MuPDF's text extraction reports. The Tm-space
 * flip (y up) happens at the engine boundary, not here.
 */

export type Rect = [number, number, number, number]

/** Blocks that share a baseline band and therefore have to move together. */
export interface Row {
  blockIds: string[]
  rect: Rect
}

export interface CollisionOptions {
  /** Clearance to leave between the moved text and what it displaces, in points. */
  gap?: number
  /** Cascade iterations before giving up on a chain of pushes. */
  maxPasses?: number
  /** Rows may not be pushed off the page. */
  pageHeight?: number
  /** Upper bound on how much of the page one drag may rearrange. */
  maxRows?: number
}

export interface CollisionResult {
  /** rowIndex → vertical displacement in page space (positive = down). */
  shifts: Map<number, number>
  /**
   * Rows that overlap but were left alone: pushing them would have run off the
   * page or fought a push already committed in the other direction. Surfaced so
   * the UI can say so rather than quietly leaving text overlapping.
   */
  blocked: number
  /** True when maxRows stopped the cascade before it settled. */
  capped: boolean
}

function centerY(r: Rect): number {
  return (r[1] + r[3]) / 2
}

function union(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

/**
 * Do these two runs fight for the same strip of page?
 *
 * The gap is applied on Y only. Padding X as well would make the two columns of
 * a two-column layout — or a label and its value with a narrow gutter — read as
 * a collision, and dragging anything would shove half the page around.
 */
export function overlaps(a: Rect, b: Rect, gapY: number): boolean {
  const horizontal = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
  if (horizontal <= 0.5) return false
  return a[1] < b[3] + gapY && b[1] < a[3] + gapY
}

/**
 * Cluster blocks into baseline rows.
 *
 * Text extraction splits a visual line at every wide gap ("Label:" and "Value"
 * become two blocks), so displacing blocks individually would break lines apart:
 * the half that overlapped would move and the half that didn't would stay. A row
 * is the unit that has to move.
 */
export function groupIntoRows(blocks: { id: string; bbox: Rect }[]): Row[] {
  const sorted = [...blocks].sort((a, b) => centerY(a.bbox) - centerY(b.bbox))
  const rows: Row[] = []

  for (const b of sorted) {
    const cy = centerY(b.bbox)
    const height = Math.max(1, b.bbox[3] - b.bbox[1])
    const last = rows[rows.length - 1]
    // Same band when the centres are within ~half a line height of each other.
    if (last && Math.abs(cy - centerY(last.rect)) <= Math.max(2, height * 0.6)) {
      last.blockIds.push(b.id)
      last.rect = union(last.rect, b.bbox)
    } else {
      rows.push({ blockIds: [b.id], rect: [...b.bbox] as Rect })
    }
  }

  return rows
}

/**
 * Work out how far each row has to move so the dragged selection can land.
 *
 * `selRects` are where the dragged blocks are GOING, not where they came from.
 * Rows are pushed away from them, and then — because a displaced row can land on
 * its own neighbour — the pushes cascade in the same direction until nothing
 * overlaps or `maxPasses` runs out.
 */
export function resolveCollisions(
  selRects: Rect[],
  rows: Row[],
  opts: CollisionOptions = {}
): CollisionResult {
  const gap = opts.gap ?? 2
  const maxPasses = opts.maxPasses ?? 8
  const pageHeight = opts.pageHeight ?? Infinity
  const maxRows = opts.maxRows ?? 40

  const shifts = new Map<number, number>()
  let blocked = 0
  let capped = false

  const rectAt = (i: number): Rect => {
    const dy = shifts.get(i) ?? 0
    const r = rows[i].rect
    return [r[0], r[1] + dy, r[2], r[3] + dy]
  }

  /**
   * Commit a displacement, or refuse it. Refusing is the safe outcome: leaving
   * two runs overlapping is visible and fixable by hand, whereas pushing text
   * off the page edge destroys it silently.
   */
  function push(i: number, delta: number, dir: 1 | -1): boolean {
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.05) return false
    const prev = shifts.get(i) ?? 0
    // A row already committed the other way is left where it is. Two obstacles
    // pushing one row in opposite directions has no stable answer, and letting
    // them alternate would never converge.
    if (prev !== 0 && Math.sign(prev) !== dir) { blocked++; return false }

    const next = prev + delta
    if (Math.sign(next) !== dir) return false
    if (Math.abs(next - prev) < 0.05) return false

    const r = rows[i].rect
    if (r[1] + next < 0 || r[3] + next > pageHeight) { blocked++; return false }

    shifts.set(i, next)
    return true
  }

  // Pass 1 — rows the dragged selection lands on.
  for (let i = 0; i < rows.length; i++) {
    for (const s of selRects) {
      const r = rectAt(i)
      if (!overlaps(r, s, gap)) continue
      // Move it the way it is already leaning: a row whose centre sits below the
      // incoming text goes down, one above goes up. Choosing by "shortest push"
      // instead would let two halves of the same paragraph split in opposite
      // directions.
      const down = centerY(r) >= centerY(s)
      const delta = down ? (s[3] + gap - r[1]) : (s[1] - gap - r[3])
      push(i, delta, down ? 1 : -1)
    }
  }

  // Pass 2..n — a displaced row lands on the next one, which lands on the one
  // after that. Each row only ever moves further in the direction it started,
  // so the cascade is monotonic and terminates.
  for (let pass = 0; pass < maxPasses; pass++) {
    if (shifts.size > maxRows) { capped = true; break }
    let changed = false

    for (const a of [...shifts.keys()]) {
      const shift = shifts.get(a)!
      if (shift === 0) continue
      const dir: 1 | -1 = shift > 0 ? 1 : -1
      const ra = rectAt(a)

      for (let b = 0; b < rows.length; b++) {
        if (b === a) continue
        const rb = rectAt(b)
        if (!overlaps(ra, rb, gap)) continue
        // Only rows ahead of `a` in its direction of travel are displaced. A row
        // behind it is the space `a` just vacated; shoving that would undo the
        // very move being made.
        if (dir > 0 && centerY(rb) <= centerY(ra)) continue
        if (dir < 0 && centerY(rb) >= centerY(ra)) continue

        const delta = dir > 0 ? (ra[3] + gap - rb[1]) : (ra[1] - gap - rb[3])
        if (push(b, delta, dir)) changed = true
      }
    }

    if (!changed) break
  }

  for (const [i, dy] of [...shifts]) if (dy === 0) shifts.delete(i)
  return { shifts, blocked, capped }
}

export interface ReflowOptions {
  /** Rows are never pulled above this page-space Y (the top margin). */
  minY?: number
  /** Upper bound on how many rows one delete may pull up. */
  maxRows?: number
}

export interface ReflowResult {
  /** rowIndex → distance to pull that row UP, in points (always positive). */
  shifts: Map<number, number>
  /** True when maxRows stopped the reflow before the bottom of the page. */
  capped: boolean
}

/**
 * Close the vertical hole a deleted line leaves behind.
 *
 * Emptying a run out of a content stream removes the ink and nothing else — the
 * lines below keep the absolute coordinates they were drawn at, so the page is
 * left with a gap where the text used to be. Pulling everything below it up by
 * the deleted line's ADVANCE — the distance from its top to the top of the line
 * under it, not merely its own height — closes the gap while preserving the
 * leading between the lines that remain.
 *
 * Two rules keep this from rearranging text it has no business touching:
 *
 * - Only rows that lost EVERY block count as deleted. A line that merely lost
 *   its second half is still a line, still occupies its band, and pulling the
 *   page up into it would overlap the half that survived.
 * - A row moves only if it shares a horizontal span with the deleted text, the
 *   same test `overlaps` applies. Otherwise deleting a line in the left column
 *   of a two-column page would drag the right column up with it.
 */
export function planReflow(
  rows: Row[],
  deletedRows: Set<number>,
  opts: ReflowOptions = {}
): ReflowResult {
  const minY = opts.minY ?? 0
  const maxRows = opts.maxRows ?? 40

  const shifts = new Map<number, number>()
  let capped = false
  let cumulative = 0
  let span: Rect | null = null

  // `groupIntoRows` returns rows ordered top-to-bottom, so one pass accumulates
  // every hole opened above the row currently under consideration.
  for (let i = 0; i < rows.length; i++) {
    if (deletedRows.has(i)) {
      const next = rows[i + 1]
      const advance = next
        ? next.rect[1] - rows[i].rect[1]
        : rows[i].rect[3] - rows[i].rect[1]
      if (advance > 0) cumulative += advance
      span = span ? union(span, rows[i].rect) : ([...rows[i].rect] as Rect)
      continue
    }

    if (cumulative <= 0.05 || !span) continue
    if (Math.min(rows[i].rect[2], span[2]) - Math.max(rows[i].rect[0], span[0]) <= 0.5) continue

    if (shifts.size >= maxRows) { capped = true; break }

    // A row is never pulled off the top of the page, even if the hole above it
    // was larger than the space it has to move into.
    const headroom = rows[i].rect[1] - minY
    const shift = Math.min(cumulative, Math.max(0, headroom))
    if (shift > 0.05) shifts.set(i, shift)
  }

  return { shifts, capped }
}

/**
 * Make room for text that grew taller.
 *
 * The mirror of `planReflow`. A run that now draws N extra lines needs N line
 * advances of space beneath it, and everything below has to move down — a
 * content stream has no flow, so without this the new lines are simply painted
 * on top of the next paragraph.
 *
 * Shifts are returned as DOWNWARD distances (planReflow's are upward). The two
 * horizontal-overlap and page-bound rules are the same: a row in another column
 * is left alone, and a row that would be pushed off the bottom is refused and
 * counted, because text shoved off the page is destroyed silently while
 * overlapping text is visible and fixable by hand.
 */
export function planPushDown(
  rows: Row[],
  grownRow: number,
  amount: number,
  opts: { pageHeight?: number; maxRows?: number; span?: Rect } = {}
): ReflowResult {
  const pageHeight = opts.pageHeight ?? Infinity
  const maxRows = opts.maxRows ?? 40

  const shifts = new Map<number, number>()
  let capped = false

  if (!(amount > 0.05) || grownRow < 0 || grownRow >= rows.length) return { shifts, capped }

  // Callers that are making room for something wider than one row — an image
  // spanning the whole text column — pass that span, so a row is not skipped
  // just because it does not sit under the line the insertion was anchored to.
  const span = opts.span ?? rows[grownRow].rect
  for (let i = grownRow + 1; i < rows.length; i++) {
    const r = rows[i].rect
    if (Math.min(r[2], span[2]) - Math.max(r[0], span[0]) <= 0.5) continue
    if (shifts.size >= maxRows) { capped = true; break }
    if (r[3] + amount > pageHeight) { capped = true; break }
    shifts.set(i, amount)
  }

  return { shifts, capped }
}
