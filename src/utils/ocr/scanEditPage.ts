import type { OcrTextItem } from './ocrTypes'
import type { TextOp } from './ocrExport'
import { cellRegion, invertedPage, type PageInk, type LineInk } from './lineInk'
import type { Atlas } from './glyphAtlas'
import { applyLineEdit, overlayOf, wantKey, type GlyphImage, type GlyphWant } from './scanEdit'
import { apply, pageRectOfPx, pxRectOf, type ScanRaster } from './scanRaster'
import { groundFill, isReversedAt, emOfRun, type GroundField } from './groundFill'

/**
 * A page's scan edits, planned together on one working copy of its pixels:
 * every edited or removed line the scan itself can redraw (scanEdit.ts),
 * turned into pixel overlays drawn exactly on the scan's grid and an
 * invisible text layer that says what the lines now read. Lines it cannot
 * redraw — moved or restyled runs, a character the page holds no letter for —
 * are left to the vector redraw (ocrExport.ts), with the reason.
 *
 * DOM-free.
 */

export interface PixelOverlay {
  /** Page points, top-left origin: exactly the scan pixels it replaces. */
  rect: [number, number, number, number]
  width: number
  height: number
  /** RGB, 3 bytes a pixel, and the soft mask (255 where the scan changed). */
  rgb: Uint8Array
  alpha: Uint8Array
  item: string
}

export interface ScanEditPlan {
  /** Items drawn here, by id. */
  handled: Set<string>
  /** Per edited item: how it was drawn, or why the scan edit declined it. */
  modes: Record<string, string>
  overlays: PixelOverlay[]
  /** The new lines as invisible text, one op per word, grouped per item. */
  texts: TextOp[]
  /** Glyphs the page holds no copy of that some line needed (deduplicated by `wantKey`). */
  wanting: GlyphWant[]
}

/**
 * The overlays for the pixels changed in `work` inside each box: one image and
 * soft mask per box, on exactly the scan's pixel rectangle.
 */
function overlaysOf(s: ScanRaster, work: Uint8ClampedArray, entries: { item: string; box: { x0: number; y0: number; x1: number; y1: number } }[]): PixelOverlay[] {
  const overlays: PixelOverlay[] = []
  for (const { item, box: b } of entries) {
    if (!(b.x1 > b.x0 && b.y1 > b.y0)) continue
    // Room for the mask's margins below: the image's own edge must fall where
    // nothing changed either, or it is a seam of its own.
    const m = 8
    const box = { x0: Math.max(0, b.x0 - m), y0: Math.max(0, b.y0 - m), x1: Math.min(s.w, b.x1 + m), y1: Math.min(s.h, b.y1 + m) }
    const o = overlayOf(s.data, work, s.w, box)
    if (!o.changed) continue
    const n = o.w * o.h
    const rgb = new Uint8Array(n * 3), alpha = new Uint8Array(n)
    const changed = new Uint8Array(n)
    for (let i = 0; i < n; i++) changed[i] = o.rgba[i * 4 + 3]
    // A renderer INTERPOLATES the image and its soft mask, separately (MuPDF
    // does), so wherever the mask steps from opaque to transparent the two
    // layers mix. A mask that is exactly the changed pixels steps ON the old
    // letters' anti-aliased edges — an erased letter whose edge pixels were
    // already paper-coloured inside, and dark outside — and their ink showed
    // through at half strength: a grey outline of every erased letter and
    // specks along every moved one, plain at 24pt on a book's title page.
    // So the overlay is OPAQUE for three pixels around every change (there it
    // carries the scan's own values: an exact render is unchanged), and three
    // more carry the scan's colour while transparent, so the mask's edge
    // falls where both layers are the same picture. Farther out it carries
    // white, which compresses to nothing.
    const opaque = dilateMask(changed, o.w, o.h, 3)
    const carry = dilateMask(changed, o.w, o.h, 6)
    for (let i = 0; i < n; i++) {
      alpha[i] = opaque[i] ? 255 : 0
      const keep = carry[i]
      rgb[i * 3] = keep ? o.rgba[i * 4] : 255
      rgb[i * 3 + 1] = keep ? o.rgba[i * 4 + 1] : 255
      rgb[i * 3 + 2] = keep ? o.rgba[i * 4 + 2] : 255
    }
    overlays.push({ rect: pageRectOfPx(s, box.x0, box.y0, box.x1, box.y1), width: o.w, height: o.h, rgb, alpha, item })
  }
  return overlays
}

/** The vector redraw's paper patches, as the bake would paint them (page points, top-left origin), and how each run is drawn. */
export interface FallbackOps {
  patches: { rect: [number, number, number, number]; item?: string; paint?: boolean }[]
  /** Per run: the vector redraw's mode ("whole …", "removed", "partial …"). */
  modes: Record<string, string>
  /** The page's runs as planned — where each run's ink is, for the ground fill. */
  items?: Pick<OcrTextItem, 'id' | 'originalText' | 'text' | 'inkRect' | 'rect' | 'vertical'>[]
  /** The partial redraws' moved tails (page points, top-left), as the bake would paste them. */
  images?: { srcRect: [number, number, number, number]; dstRect: [number, number, number, number]; item?: string }[]
}

/**
 * Whether a line's analysis can be trusted to say which pixels are its
 * letters: most of its words cut one ink run per letter. Handwriting is not —
 * on graph paper the grid's segments came out as "letters", and an erase
 * driven by them took the grid with it.
 */
export function analysisTrusted(li: LineInk): boolean {
  if (!li.words.length) return false
  const exact = li.words.filter(w => w.cut && w.exact).length
  return exact >= Math.max(1, Math.ceil(li.words.length * 0.5))
}

/**
 * Whether the paper around a line is plain and nearly neutral — what an erase
 * that stands in for a painted patch may assume. A book cover's yellow
 * sticker over a photograph passed every test of the line analysis when it
 * was read right, and the erase smeared the sticker's yellow over the photo.
 */
function plainNeutralPaper(pi: PageInk, li: LineInk): boolean {
  const s = pi.s
  const lums: number[] = []
  let chroma = 0, n = 0
  for (let y = li.roi.y0; y < li.roi.y1; y += 3) for (let x = li.roi.x0; x < li.roi.x1; x += 3) {
    const p = y * s.w + x
    const r = pi.paper[p * 3], g = pi.paper[p * 3 + 1], b = pi.paper[p * 3 + 2]
    lums.push((r * 299 + g * 587 + b * 114) / 1000)
    chroma += Math.max(r, g, b) - Math.min(r, g, b)
    n++
  }
  if (n < 20) return false
  lums.sort((a, b) => a - b)
  return lums[Math.floor(n * 0.5)] >= 170 && lums[Math.floor(n * 0.97)] - lums[Math.floor(n * 0.03)] <= 35 && chroma / n <= 45
}

/**
 * The vector redraw's paper patches made ON THE SCAN, for a run redrawn WHOLE
 * (or removed) whose line was read and can be trusted: every letter of the
 * line is erased — its region, exactly as the scan edit erases it — and
 * nothing else, not the line beneath, not a rule, not ink the reading never
 * named. A rectangle of paper colour erased whatever fell inside it: under a
 * tilted line, the top of the line beneath (an edit of "EMPRESA : MINERA
 * SHOUXIN PERU S.A." took "RUC : 20392776975" with it).
 *
 * Only whole runs: a PARTIAL redraw's rectangles and moved tails are placed
 * on the vector planner's own letter cut, and erasing this analysis' letters
 * inside them disagreed with it by a letter — a deleted "J" stayed on the page
 * under the "M" moved onto it.
 *
 * Returns the overlays and which patches (by index) they stand in for: the
 * caller paints the rest as before.
 */
export function inkAwareFallback(pi: PageInk, lines: Map<string, LineInk | null>, ops: FallbackOps): { overlays: PixelOverlay[]; patches: Set<number>; images: Set<number>; grounded: Set<string> } {
  const s = pi.s, W = s.w
  const work = s.data.slice()
  const boxes = new Map<string, { x0: number; y0: number; x1: number; y1: number }>()
  const touch = (id: string, p: number) => {
    const x = p % W, y = (p - x) / W
    const b = boxes.get(id)
    if (!b) boxes.set(id, { x0: x, y0: y, x1: x + 1, y1: y + 1 })
    else { if (x < b.x0) b.x0 = x; if (y < b.y0) b.y0 = y; if (x + 1 > b.x1) b.x1 = x + 1; if (y + 1 > b.y1) b.y1 = y + 1 }
  }
  const nearPx = Math.max(2, Math.round(1.1 / Math.abs(s.toPage[0] || 1)))
  const eraseOpts = { dark: pi.dark, near: nearPx, minDark: 9 }
  const patches = new Set<number>()
  const done = new Set<string>()
  const runs = new Map((ops.items ?? []).map(i => [i.id, i]))
  const grounded = new Set<string>()
  const toGround = new Map<string, number[]>()
  const images = new Set<number>()
  ops.patches.forEach((patch, n) => {
    if (patch.paint === false || !patch.item) return
    const mode = ops.modes[patch.item] ?? ''
    const li = lines.get(patch.item)
    if ((mode.startsWith('whole') || mode.startsWith('removed')) && li && !li.inverted && analysisTrusted(li) && plainNeutralPaper(pi, li)) {
      patches.add(n)
      if (done.has(patch.item)) return
      done.add(patch.item)
      li.cells.forEach((_, k) => {
        for (const p of cellRegion(li, k, W, eraseOpts)) {
          work[p * 4] = pi.paper[p * 3]; work[p * 4 + 1] = pi.paper[p * 3 + 1]; work[p * 4 + 2] = pi.paper[p * 3 + 2]
          touch(patch.item!, p)
        }
      })
      return
    }
    const list = toGround.get(patch.item) ?? []
    list.push(n)
    toGround.set(patch.item, list)
  })
  // Every other patch is filled from the run's GROUND (`groundFill`), all of a
  // run's patches together: the letters they cover, and nothing else, taken
  // back to the colours around them — a gradient stays a gradient, a
  // neighbour's letters stay where they are. Patches with nothing of the run
  // in them are left unpainted; a run the fill declines (a ground too rough to
  // tell from the letters) keeps its flat patches.
  for (const [item, ns] of toGround) {
    const run = runs.get(item)
    if (!run || run.vertical) continue
    const own = pxRectOf(s, run.inkRect ?? run.rect)
    const rects = ns.map(n => {
      const [rx0, ry0, rx1, ry1] = ops.patches[n].rect
      return pxRectOf(s, { x: Math.min(rx0, rx1), y: Math.min(ry0, ry1), width: Math.abs(rx1 - rx0), height: Math.abs(ry1 - ry0) })
    })
    const em = emOfRun(own, run.originalText ?? run.text)
    const others = (ops.items ?? []).filter(o => o.id !== run.id && !o.vertical).map(o => pxRectOf(s, o.inkRect ?? o.rect))
    const out: { field?: GroundField } = {}
    const got = groundFill(s, rects, em, isReversedAt(s, own, em), work, own, others, out)
    if (got === 'refused') continue
    for (const n of ns) patches.add(n)
    if (got === 'empty') continue
    grounded.add(item)
    for (const [x, y] of [[got.x0, got.y0], [got.x1 - 1, got.y1 - 1]]) touch(item, y * W + x)
    // The run's moved tail, moved on the scan's own pixels: each pixel's
    // transmittance over the ground it was printed on, laid on the ground
    // where it lands. Pasted as a picture, the tail brought its old ground
    // with it, and on a gradient that showed as a box around the words.
    const field = out.field
    if (!field) continue
    ;(ops.images ?? []).forEach((img, k) => {
      if (img.item !== item) return
      const [sx0, sy0, sx1, sy1] = img.srcRect, [dx0, dy0] = img.dstRect
      const srcPx = pxRectOf(s, { x: Math.min(sx0, sx1), y: Math.min(sy0, sy1), width: Math.abs(sx1 - sx0), height: Math.abs(sy1 - sy0) })
      const [ax, ay] = apply(s.toPx, sx0, sy0), [bx, by] = apply(s.toPx, dx0, dy0)
      const ddx = Math.round(bx - ax), ddy = Math.round(by - ay)
      const inField = (x: number, y: number) => x >= field.X0 && y >= field.Y0 && x < field.X0 + field.W && y < field.Y0 + field.H
      // Every source pixel read before any is written: the tail's old and new
      // places overlap.
      const moved: [number, number, number, number][] = []
      for (let y = srcPx.y0; y < srcPx.y1; y++) for (let x = srcPx.x0; x < srcPx.x1; x++) {
        if (!inField(x, y) || !inField(x + ddx, y + ddy)) continue
        const p = y * W + x, j = (y - field.Y0) * field.W + (x - field.X0)
        // Only the run's own letters: a tail's band also crosses the tips of
        // the lines either side, and those stay where they are.
        if (!field.mark[j]) continue
        // Light letters on a dark ground print by LIGHTENING it: their
        // transmittance is taken on the inverted colours, and laid on that way.
        const t = [0, 1, 2].map(c => {
          const g = field.reversed ? 255 - field.ch[c][j] : field.ch[c][j], v = field.reversed ? 255 - s.data[p * 4 + c] : s.data[p * 4 + c]
          return g > 1 ? Math.min(1, v / g) : 1
        })
        if (t[0] > 0.995 && t[1] > 0.995 && t[2] > 0.995) continue
        moved.push([p + ddy * W + ddx, t[0], t[1], t[2]])
      }
      for (const [q, t0, t1, t2] of moved) {
        if (field.reversed) { work[q * 4] = 255 - (255 - work[q * 4]) * t0; work[q * 4 + 1] = 255 - (255 - work[q * 4 + 1]) * t1; work[q * 4 + 2] = 255 - (255 - work[q * 4 + 2]) * t2 }
        else { work[q * 4] = work[q * 4] * t0; work[q * 4 + 1] = work[q * 4 + 1] * t1; work[q * 4 + 2] = work[q * 4 + 2] * t2 }
        touch(item, q)
      }
      images.add(k)
    })
  }
  return { overlays: overlaysOf(s, work, [...boxes.entries()].map(([item, box]) => ({ item, box }))), patches, images, grounded }
}

/** Pixels within `r` (chessboard) of a nonzero one: a separable max over rows, then columns. */
function dilateMask(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const rows = new Uint8Array(w * h), out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    let last = -Infinity
    for (let x = 0; x < w; x++) { if (m[y * w + x]) last = x; if (x - last <= r) rows[y * w + x] = 1 }
    last = Infinity
    for (let x = w - 1; x >= 0; x--) { if (m[y * w + x]) last = x; if (last - x <= r) rows[y * w + x] = 1 }
  }
  for (let x = 0; x < w; x++) {
    let last = -Infinity
    for (let y = 0; y < h; y++) { if (rows[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1 }
    last = Infinity
    for (let y = h - 1; y >= 0; y--) { if (rows[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1 }
  }
  return out
}

/** Whether a run's place and style are still the scan's — the only runs the scan edit redraws. */
export function scanEditable(item: OcrTextItem): string | null {
  if (item.vertical) return 'vertical run'
  if (item.baked) return 'baked already'
  if (item.restyled) return 'restyled'
  const ink = item.inkRect ?? item.rect
  if (Math.abs(item.rect.x - ink.x) > 0.5 || Math.abs(item.rect.y - ink.y) > 0.5) return 'run was moved'
  return null
}

/**
 * The page's right text margin: where its long lines end (the upper part of
 * their spread — a justified paragraph's lines all end there).
 */
export function textMargin(lines: Iterable<LineInk | null>): number | null {
  const ends: number[] = []
  for (const li of lines) if (li && li.words.length >= 5) ends.push(li.words[li.words.length - 1].x1)
  ends.sort((a, b) => a - b)
  return ends.length >= 3 ? ends[Math.floor(ends.length * 0.8)] : null
}

/**
 * The margin a line is respaced to after its edit, or null. A justified line
 * is a line of a justified PARAGRAPH: one just above or below it ends at the
 * same margin. A title that alone reaches it — a slide's "Introduction to
 * Deep Learning" — is not respaced: deleting one letter from it spread every
 * word gap to keep an edge it never kept.
 */
export function justifiedMargin(margin: number | null, lines: Iterable<LineInk | null>, li: LineInk): number | null {
  if (margin === null || !li.words.length) return null
  const em = li.fit.emPx
  if (Math.abs(li.words[li.words.length - 1].x1 - margin) > em * 0.6) return null
  // A line of a paragraph spans most of the text: a form's value field ending
  // at the right margin (": Mantenimiento Instrumentacion", in the right-hand
  // column of a purchase order) had a neighbouring field end there too, and
  // an edit spread its one word gap by half again to keep an edge it never
  // kept. The text's left edge is where its lines usually start.
  const all = [...lines].filter((o): o is LineInk => !!o && o.words.length > 0)
  const starts = all.map(o => o.words[0].x0).sort((a, b) => a - b)
  const left = starts.length ? starts[Math.floor(starts.length * 0.1)] : li.words[0].x0
  const spans = (o: LineInk) => margin - o.words[0].x0 >= (margin - left) * 0.5
  if (!spans(li)) return null
  for (const o of all) {
    if (o === li || !spans(o)) continue
    if (Math.abs(o.words[o.words.length - 1].x1 - margin) > em * 0.6) continue
    const dy = Math.abs(o.fit.y - li.fit.y)
    if (dy > em * 0.5 && dy < em * 2.5) return margin
  }
  return null
}

/**
 * Whether a line of figures is one of a COLUMN set flush right: another line
 * of figures near it ends where it ends and starts somewhere else — an
 * amounts column with no rule beside it, "13,000.00" over "0.00" over
 * "13,000.00". Such a line keeps its right edge when an edit changes its
 * length; set from its start instead, "2,500.00" ran out past the column.
 */
export function alignedRight(lines: Iterable<LineInk | null>, li: LineInk): boolean {
  const figures = (o: LineInk) => {
    const d = o.chars.filter(ch => /[0-9]/.test(ch)).length
    return d >= 2 && d >= o.chars.length * 0.6
  }
  if (!li.cells.length || !figures(li)) return false
  const em = li.fit.emPx
  const right = (o: LineInk) => Math.max(...o.cells.map(c => c.inkR))
  const left = (o: LineInk) => Math.min(...o.cells.map(c => c.inkL))
  const r0 = right(li), l0 = left(li)
  // An AMOUNT (figures ending in a decimal separator and two decimals) in a
  // column of amounts that end where it ends is set flush right even when
  // they all start where it starts: a purchase order's TOTAL column read
  // "930.00" down every row, nothing told the alignments apart, and an edit
  // to "1,050.00" grew out to the right. Amounts are set flush right.
  const amount = (o: LineInk) => /^[0-9.,']*[0-9][.,][0-9]{2}$/.test(o.chars.join(''))
  for (const o of lines) {
    if (!o || o === li || !o.cells.length || !!o.inverted !== !!li.inverted || !figures(o)) continue
    if (Math.abs(o.fit.y - li.fit.y) > em * 6 || Math.abs(o.fit.emPx - em) > em * 0.3) continue
    if (Math.abs(right(o) - r0) <= Math.max(2, em * 0.12) && (Math.abs(left(o) - l0) > em * 0.5 || (amount(li) && amount(o)))) return true
  }
  return false
}

export function planScanEdits(pi: PageInk, lines: Map<string, LineInk | null>, atlas: Atlas, items: OcrTextItem[], synth?: Map<string, GlyphImage>, unread?: Map<string, string>): ScanEditPlan {
  const s = pi.s
  // .slice(), not Uint8ClampedArray.from: `from` walks the iterator and took
  // most of a second over a 15 MB page on every live bake.
  const work = s.data.slice()
  const handled = new Set<string>()
  const modes: Record<string, string> = {}
  const wanting = new Map<string, GlyphWant>()
  const margin = textMargin(lines.values())
  const justifyFor = (li: LineInk) => justifiedMargin(margin, lines.values(), li)
  // And no line may run off the paper: a quarter inch from its edge at most.
  const limitRight = s.w - Math.round(18 / Math.abs(s.toPage[0] || 1))
  const pageLines = [...lines.values()].filter((o): o is LineInk => !!o)
  const done: { item: OcrTextItem; box: { x0: number; y0: number; x1: number; y1: number }; words: { text: string; x0: number; x1: number; base: number }[]; li: LineInk }[] = []
  let workInv: Uint8ClampedArray | null = null
  for (const item of items) {
    if (!item.edited && !item.removed) continue
    const why = scanEditable(item)
    if (why) { modes[item.id] = `vector (${why})`; continue }
    // A page can carry its scan inset (a phone app's margin) or in pieces: a
    // line outside the image is not on these pixels at all.
    {
      const [ax, ay] = apply(s.toPx, item.inkRect.x, item.inkRect.y)
      const [bx, by] = apply(s.toPx, item.inkRect.x + item.inkRect.width, item.inkRect.y + item.inkRect.height)
      const slack = 2
      if (Math.min(ax, bx) < -slack || Math.min(ay, by) < -slack || Math.max(ax, bx) > s.w + slack || Math.max(ay, by) > s.h + slack) {
        modes[item.id] = 'vector (the line is outside the scan image)'
        continue
      }
    }
    const li = lines.get(item.id)
    if (!li) { modes[item.id] = `vector (the line could not be read on the scan${unread?.get(item.id) ? `: ${unread.get(item.id)}` : ''})`; continue }
    // Reversed-out lettering is edited on the inverted scan, in a working copy
    // of its own, and folded back into this one below.
    const pl = li.inverted ? invertedPage(pi) : pi
    const w = li.inverted ? (workInv ??= pl.s.data.slice()) : work
    const res = applyLineEdit(pl, li, atlas, item.text, w, { remove: item.removed, justifyTo: justifyFor(li), limitRight, synth, columnRight: alignedRight(lines.values(), li), pageLines })
    if (!res.ok) {
      modes[item.id] = `vector (${res.reason})`
      // Per LINE: each line's letter is made in that line's look and looked up
      // under the line's id. Keyed by the letter alone, two lines wanting the
      // same comma kept only the last line's want, and the first line of a
      // purchase order's two edited amounts went on wanting its comma.
      for (const w of res.wanting ?? []) wanting.set(`${w.line ?? ''}|${wantKey(w)}`, w)
      continue
    }
    handled.add(item.id)
    const reweighed = (res.drawn ?? '').split('w').length - 1
    const made = (res.drawn ?? '').split('s').length - 1
    const how = [reweighed ? `${reweighed} re-weighed` : '', made ? `${made} synthesised` : '', res.corrected ? `${res.corrected} corrected in the text` : ''].filter(Boolean).join(', ')
    modes[item.id] = item.removed ? 'scan (removed)' : `scan${how ? ` (${how})` : ''}`
    if (res.box) done.push({ item, box: res.box, words: res.words ?? [], li })
    else if (!item.removed) done.push({ item, box: { x0: 0, y0: 0, x1: 0, y1: 0 }, words: res.words ?? [], li })
  }

  if (workInv) {
    const orig = invertedPage(pi).s.data
    for (let i = 0; i < work.length; i += 4) {
      if (workInv[i] === orig[i] && workInv[i + 1] === orig[i + 1] && workInv[i + 2] === orig[i + 2]) continue
      work[i] = 255 - workInv[i]; work[i + 1] = 255 - workInv[i + 1]; work[i + 2] = 255 - workInv[i + 2]
    }
  }
  const overlays = overlaysOf(s, work, done.map(d => ({ item: d.item.id, box: d.box })))

  // The words as invisible text, each fitted to the ink it stands for, so the
  // line extracts, searches and copies as it now reads.
  const texts: TextOp[] = []
  for (const d of done) {
    if (d.item.removed) continue
    const ptPerPx = Math.abs(s.toPage[0])
    const emPt = d.li.fit.emPx * ptPerPx
    const rotation = -Math.atan(d.li.fit.slope) * 180 / Math.PI
    for (const w of d.words) {
      const [x, y] = apply(s.toPage, w.x0, w.base)
      texts.push({
        text: w.text, x, y, fontSize: Math.max(4, emPt * 0.9), fontName: 'Helvetica', color: [0, 0, 0],
        rotation, invisible: true, fitWidth: Math.max(0.5, (w.x1 - w.x0) * ptPerPx), group: d.item.id
      })
    }
  }
  return { handled, modes, overlays, texts, wanting: [...wanting.values()] }
}
