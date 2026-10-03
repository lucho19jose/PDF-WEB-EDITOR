/**
 * A vector patch made on the scan's GROUND, not in one flat colour.
 *
 * When the scan edit cannot take a line — it is set over a gradient, a band of
 * colour, a photograph, or its reading could not be trusted — the vector
 * redraw paints a rectangle the colour of the background over the old words
 * and draws the replacement on top. On white paper that is invisible; on a
 * book cover it is a box: a flat navy block over a photograph of water, a
 * flat green over a green-to-yellow gradient, with the tops of the next line
 * cut off where the box reached them.
 *
 * Here the rectangle is filled the way the scan edit erases a letter: what is
 * printed in it is found against the ground AROUND it, and only those pixels
 * (with their blurred edge) are filled from the ground that surrounds them
 * (`pushPull`). On a flat or graded ground the fill is the ground itself; on a
 * photograph it is a smooth blend of it — still visible, but as a soft patch
 * of the picture's own colours, not a box.
 *
 * Three things the page-wide paper estimate (`preparePage`) does not do, and
 * a cover needs:
 *
 * - The max filter that finds the ground is as wide as the LETTERS' strokes,
 *   not 3.6pt: a 160pt title's stems are 40 pixels wide, and a narrower
 *   filter called their insides ground — the fill left a blurred copy of the
 *   word where it had been.
 * - The threshold is relative to the run's own contrast. Dark red letters on
 *   a red cover are 35 levels deep; the fixed 12 left their soft edges and
 *   their ringing behind as a ghost of the line.
 * - Other runs' boxes are never ground. White letters beside a dark line read
 *   as the brightest thing around, and with them as "ground" the red between
 *   them was taken for ink and filled white.
 *
 * Light text on a dark ground is found on the inverted luminance, exactly as
 * `analyzeLine` reads it; the fill itself is always of the original colours.
 */
import type { ScanRaster } from './scanRaster'
import { lumAt } from './scanRaster'
import { maxFilter1D } from './lineInk'
import { pushPull } from './inpaint'
import { expectedAdvance } from './glyphCut'

export interface PxRect { x0: number; y0: number; x1: number; y1: number }

/** The ground under a fill's region: every pixel's paper colour, the letters' places filled in. */
export interface GroundField { X0: number; Y0: number; W: number; H: number; ch: Float32Array[]; /** This run's letters and their edges (255), the only pixels that are its own. */ mark: Uint8Array; /** Light print on a dark ground: transmittance is taken on the inverted colours. */ reversed: boolean }

let lastDebug: Record<string, number> | null = null
let debugComps: Record<string, unknown>[] | null = null
/** Keep every classified shape of the next fills, for the lab. */
export function debugGroundFill(on: boolean): Record<string, unknown>[] | null { const v = debugComps; debugComps = on ? [] : null; return v }
/** The last fill's filter radius, contrast and ground grain — for the lab. */
export function lastGroundFill(): Record<string, number> | null { return lastDebug }

/**
 * Light text on a dark ground? On paper the TYPICAL pixel of a line and its
 * surroundings is paper, light; reversed out it is the ground. The same test
 * `analyzeLine` makes, on the box widened by a third of an em.
 */
export function isReversedAt(s: ScanRaster, box: PxRect, emPx: number): boolean {
  const r = Math.max(2, Math.round(emPx * 0.35))
  const lums: number[] = []
  for (let y = Math.max(0, box.y0 - r); y < Math.min(s.h, box.y1 + r); y += 2) {
    for (let x = Math.max(0, box.x0 - r); x < Math.min(s.w, box.x1 + r); x += 2) lums.push(lumAt(s.data, y * s.w + x))
  }
  if (lums.length <= 40) return false
  lums.sort((a, b) => a - b)
  const lo = lums[Math.floor(lums.length * 0.03)], hi = lums[Math.floor(lums.length * 0.97)], med = lums[Math.floor(lums.length / 2)]
  return hi - lo > 60 && med - lo < (hi - med) * 0.8
}

/**
 * Fill `rects` of `work` (RGBA, the scan's size) from the ground around what is
 * printed in it. `emPx` is the run's em in scan pixels, `own` its ink box;
 * `others` are the other runs' boxes, never taken for ground — and a letter
 * that belongs to one of them is never filled, even inside the rectangle.
 * Returns the box of the pixels changed; 'empty' when nothing of the run is
 * printed in the rectangle (there is nothing to erase, and nothing should be
 * painted); 'refused' when the fill cannot be trusted there — the caller
 * keeps its flat patch.
 *
 * Which letters are another run's is decided letter by letter, not by
 * cutting the rectangle: a detector box is often inflated over the next line
 * (a 166pt box around a 140pt title held the whole line beneath it), while on
 * tightly set text two honest boxes overlap by an ascender — cut at the
 * neighbour's edge, the tops of the erased capitals stayed on the page. A
 * letter whose centre lies in a box that is ANOTHER line (its centre outside
 * this run's middle band) or another run along this one (its centre outside
 * this run's span) is that run's.
 */
export function groundFill(s: ScanRaster, rects: PxRect | PxRect[], emPx: number, reversed: boolean, work: Uint8ClampedArray, own: PxRect, others: PxRect[] = [], out?: { field?: GroundField }): PxRect | 'empty' | 'refused' {
  // One run's patches are judged TOGETHER: a tilted line's patch is a
  // staircase of rectangles, and judged one by one some steps were refused
  // and painted flat while the letters straddling the others were half erased.
  const list = (Array.isArray(rects) ? rects : [rects]).filter(r => r.x1 > r.x0 && r.y1 > r.y0)
  if (!list.length) return 'refused'
  const rect = { x0: Math.min(...list.map(r => r.x0)), y0: Math.min(...list.map(r => r.y0)), x1: Math.max(...list.map(r => r.x1)), y1: Math.max(...list.map(r => r.y1)) }
  const exclude = others
  const pxPerPt = 1 / Math.abs(s.toPage[0] || 1)
  // Wider than half the boldest stroke: a heavy display face's stems are a
  // fifth of an em and more.
  const R = Math.max(3, Math.round(3.6 * pxPerPt), Math.round(emPx * 0.25))
  // A letter's blurred edge and its ringing, as far as `preparePage` reaches.
  const grow = Math.max(2, Math.round(1.8 * pxPerPt), Math.round(emPx * 0.04))
  const M = R + 2 * grow + 2
  const X0 = Math.max(0, rect.x0 - M), Y0 = Math.max(0, rect.y0 - M)
  const X1 = Math.min(s.w, rect.x1 + M), Y1 = Math.min(s.h, rect.y1 + M)
  const W = X1 - X0, H = Y1 - Y0
  const rx0 = Math.max(rect.x0, 0) - X0, ry0 = Math.max(rect.y0, 0) - Y0
  const rx1 = Math.min(rect.x1, s.w) - X0, ry1 = Math.min(rect.y1, s.h) - Y0
  if (W < 3 || H < 3 || rx1 - rx0 < 1 || ry1 - ry0 < 1) return 'refused'
  // The pixels the patches cover — the only ones written.
  const inside = new Uint8Array(W * H)
  for (const r of list) {
    for (let y = Math.max(0, r.y0 - Y0); y < Math.min(H, r.y1 - Y0); y++) for (let x = Math.max(0, r.x0 - X0); x < Math.min(W, r.x1 - X0); x++) inside[y * W + x] = 255
  }
  const d = s.data
  const L = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const l = lumAt(d, (Y0 + y) * s.w + X0 + x)
    L[y * W + x] = reversed ? 255 - l : l
  }
  // The other runs: another line (its centre outside this run's middle
  // band), or another run along this one (its centre outside this run's
  // span). A box that is neither is this run read twice, or a piece of it.
  const ocy = (own.y0 + own.y1) / 2 - Y0, oh = own.y1 - own.y0
  // A box that covers most of this run is not a neighbour: a picture the
  // recogniser read as a run (a cover's "10013 P04" over half its artwork)
  // held a title whole, and taken for another line it made every pixel of
  // the title "someone else's".
  const ownArea = Math.max(1, (own.x1 - own.x0) * (own.y1 - own.y0))
  const lines = exclude.map(e => ({ x0: e.x0 - X0, y0: e.y0 - Y0, x1: e.x1 - X0, y1: e.y1 - Y0 })).filter(e => {
    const cx = (e.x0 + e.x1) / 2, cy = (e.y0 + e.y1) / 2
    const ix = Math.max(0, Math.min(e.x1, own.x1 - X0) - Math.max(e.x0, own.x0 - X0))
    const iy = Math.max(0, Math.min(e.y1, own.y1 - Y0) - Math.max(e.y0, own.y0 - Y0))
    if (ix * iy > ownArea * 0.5) return false
    return cy < ocy - oh * 0.25 || cy > ocy + oh * 0.25 || cx < own.x0 - X0 || cx > own.x1 - X0
  })
  // Their letters are never ground. Of the other polarity — white letters
  // beside a dark line — they are the brightest thing around, and as the
  // "ground" they made the colour between them read as deep as ink: a title
  // welded to it was kept as "picture", a dark line above them lost half its
  // letters. So the ground is measured twice: from everything (`Ball`), and
  // from what lies outside the other runs' boxes (`B`), which wins wherever it
  // found anything within reach. Boxes overlap, and where another run's box
  // covers this run whole — a title whose box the line above was inflated
  // over — nothing outside it is in reach and the plain measure stands. Any
  // single brightness to cap the boxes at was fooled by something: the white
  // page beyond a navy band took the title's whole ground away. The boxes take
  // a margin, because a detector's box is tight: the tops of white letters
  // poked two pixels out of theirs.
  const other = new Uint8Array(W * H)
  for (const e of lines) {
    const my = Math.max(2, Math.round((e.y1 - e.y0) * 0.2)), mx = Math.max(2, Math.round((e.y1 - e.y0) * 0.1))
    const ex0 = Math.max(0, e.x0 - mx), ey0 = Math.max(0, e.y0 - my)
    const ex1 = Math.min(W, e.x1 + mx), ey1 = Math.min(H, e.y1 + my)
    for (let y = ey0; y < ey1; y++) for (let x = ex0; x < ex1; x++) other[y * W + x] = 1
  }
  const Ball = L.slice()
  maxFilter1D(Ball, W, H, R, true)
  maxFilter1D(Ball, W, H, R, false)
  const B = L.slice()
  for (let j = 0; j < W * H; j++) if (other[j]) B[j] = 0
  maxFilter1D(B, W, H, R, true)
  maxFilter1D(B, W, H, R, false)
  for (let j = 0; j < W * H; j++) if (B[j] === 0) B[j] = Ball[j]
  // An other run's pixel brighter than this ground is its letter, not ground.
  const brighter = (j: number) => other[j] && L[j] > B[j] + 4
  const depth = new Uint8Array(W * H)
  for (let j = 0; j < W * H; j++) depth[j] = B[j] > L[j] ? B[j] - L[j] : 0
  // The print's own contrast: how far its darkest pixels sit below the ground.
  const inRect: number[] = []
  for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) if (inside[y * W + x]) inRect.push(depth[y * W + x])
  inRect.sort((a, b) => a - b)
  const C = inRect[Math.floor(inRect.length * 0.97)] ?? 0
  lastDebug = { R, grow, C }
  if (C < 14) return 'empty'
  // Pass 1: every shape printed here, at a bar any letter clears, is one of
  // four things — a letter of THIS run, a letter of another run, a piece of
  // the picture the line is set on, or a speck of grain. Only the first is
  // filled; the second and third are kept off the fill and out of the ground.
  const strong0 = Math.max(8, Math.round(C * 0.3))
  const core = new Uint8Array(W * H)
  for (let j = 0; j < W * H; j++) if (depth[j] >= strong0) core[j] = 255
  const foreign = new Uint8Array(W * H)
  let bandInk = 0, bandPicture = 0
  {
    // A letter inside two boxes — a tilted line's end inside the box of the
    // line beneath — is the run whose middle it is nearer, each box measured
    // in its own half-size.
    const ownBox = { x0: own.x0 - X0, y0: own.y0 - Y0, x1: own.x1 - X0, y1: own.y1 - Y0 }
    const inOwn = (x: number, y: number) => x >= ownBox.x0 && x < ownBox.x1 && y >= ownBox.y0 && y < ownBox.y1
    const reach = (e: PxRect, x: number, y: number) => Math.max(
      Math.abs(x - (e.x0 + e.x1) / 2) / Math.max(1, (e.x1 - e.x0) / 2),
      Math.abs(y - (e.y0 + e.y1) / 2) / Math.max(1, (e.y1 - e.y0) / 2))
    // This run's letters have their middle in its box — widened enough to
    // take an accent over a capital or a dot over an i, which stand apart.
    const mine = { x0: ownBox.x0 - emPx * 0.2, y0: ownBox.y0 - emPx * 0.35, x1: ownBox.x1 + emPx * 0.2, y1: ownBox.y1 + emPx * 0.35 }
    const minArea = Math.max(3, Math.round((emPx * 0.05) ** 2))
    // The run's middle band, where its letters certainly are.
    const bandY0 = ocy - oh * 0.25, bandY1 = ocy + oh * 0.25
    const inBand = (j: number) => { const x = j % W, y = (j - x) / W; return y >= bandY0 && y < bandY1 && x >= ownBox.x0 && x < ownBox.x1 }
    for (let j = 0; j < W * H; j++) if (core[j] && inBand(j)) bandInk++
    const seen = new Uint8Array(W * H), stack: number[] = [], comp: number[] = []
    for (let j0 = 0; j0 < W * H; j0++) {
      if (!core[j0] || seen[j0]) continue
      comp.length = 0
      stack.push(j0); seen[j0] = 1
      let sx = 0, sy = 0, cx0 = W, cy0 = H, cx1 = -1, cy1 = -1
      while (stack.length) {
        const j = stack.pop()!
        comp.push(j)
        const x = j % W, y = (j - x) / W
        sx += x; sy += y
        if (x < cx0) cx0 = x
        if (x > cx1) cx1 = x
        if (y < cy0) cy0 = y
        if (y > cy1) cy1 = y
        if (x > 0 && core[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; stack.push(j - 1) }
        if (x < W - 1 && core[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; stack.push(j + 1) }
        if (y > 0 && core[j - W] && !seen[j - W]) { seen[j - W] = 1; stack.push(j - W) }
        if (y < H - 1 && core[j + W] && !seen[j + W]) { seen[j + W] = 1; stack.push(j + W) }
      }
      if (comp.length < minArea) { for (const j of comp) core[j] = 0; continue }
      const cx = sx / comp.length + 0.5, cy = sy / comp.length + 0.5
      // Not a letter at all: something of the picture the line is set on —
      // the photograph beyond a sticker's edge reads as "ink" against the
      // sticker's yellow, and filled from it, the yellow ran over the photo.
      // A letter is bounded: it lies mostly inside the run's box, stands at
      // most an em and a half tall and covers at most a few em². Reaching the
      // edge of the region is no proof on its own — on a photograph of water a
      // title's "L" is welded to the ripples, which run out to the edge, and
      // called picture for it the L stayed while the rest of the word went.
      const box = { x0: ownBox.x0 - emPx * 0.25, y0: ownBox.y0 - emPx * 0.25, x1: ownBox.x1 + emPx * 0.25, y1: ownBox.y1 + emPx * 0.25 }
      let outside = 0
      for (const j of comp) { const x = j % W, y = (j - x) / W; if (x < box.x0 || x >= box.x1 || y < box.y0 || y >= box.y1) outside++ }
      const outFrac = outside / comp.length
      const edge = cx0 === 0 || cy0 === 0 || cx1 === W - 1 || cy1 === H - 1
      const picture = outFrac > 0.5 || (edge && outFrac > 0.25) || cy1 - cy0 + 1 > emPx * 1.6 || comp.length > emPx * emPx * 2.5
      if (debugComps) debugComps.push({ x: Math.round(cx + X0), y: Math.round(cy + Y0), w: cx1 - cx0 + 1, h: cy1 - cy0 + 1, area: comp.length, picture, edge, outFrac: Math.round(outFrac * 100) / 100 })
      // A letter the patches only clip, most of it outside them, is one the
      // edit KEEPS — the head or tail of a partial redraw — cut by a glyph
      // cut that placed the boundary inside it. Erased up to the patch's edge
      // it is lost: a boundary two thirds of the way into a kept letter left
      // a sliver of it beside the redrawn stretch.
      let within = 0
      for (const j of comp) if (inside[j]) within++
      const clipped = within > 0 && within < comp.length * 0.5
      if (clipped || picture || lines.some(e => cx >= e.x0 && cx < e.x1 && cy >= e.y0 && cy < e.y1 && (!inOwn(cx, cy) || reach(e, cx, cy) < reach(ownBox, cx, cy)))) {
        if (picture) for (const j of comp) if (inBand(j)) bandPicture++
        for (const j of comp) { core[j] = 0; foreign[j] = 255 }
      } else if (cx < mine.x0 || cx > mine.x1 || cy < mine.y0 || cy > mine.y1) {
        // A feature of the ground itself (a ripple of the photograph): left
        // as it is, and part of the ground the fill is made from.
        for (const j of comp) core[j] = 0
      }
    }
    maxFilter1D(foreign, W, H, grow, true)
    maxFilter1D(foreign, W, H, grow, false)
  }
  // The run's own letters taken for picture — welded to something that
  // reaches the region's edge — would stay on the page under the redraw:
  // better the flat patch than that.
  lastDebug.bandPicture = bandInk ? Math.round(100 * bandPicture / bandInk) / 100 : 0
  if (bandInk && bandPicture > bandInk * 0.35) return 'refused'
  // Pass 2: how deep the GROUND itself reads, around the rectangle, off every
  // letter and every piece of the picture: JPEG noise on a flat colour, the
  // texture of a photograph. The letters' bodies must stand clear of it —
  // taken as letters, the grain of a red cover had the whole rectangle
  // smoothed, and its edge showed as a box.
  const lettersNear = core.slice()
  maxFilter1D(lettersNear, W, H, 2 * grow, true)
  maxFilter1D(lettersNear, W, H, 2 * grow, false)
  const ring: number[] = []
  const insideNear = inside.slice()
  maxFilter1D(insideNear, W, H, grow, true)
  maxFilter1D(insideNear, W, H, grow, false)
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    if (insideNear[y * W + x]) continue
    const j = y * W + x
    if (!foreign[j] && !lettersNear[j] && !brighter(j)) ring.push(depth[j])
  }
  ring.sort((a, b) => a - b)
  // The upper quartile, not the tail: a shadow or a ripple the shapes above
  // did not catch is still not grain.
  const grain = ring.length >= 20 ? ring[Math.floor(ring.length * 0.75)] : 0
  lastDebug.grain = grain
  if (C < grain * 2.5) return 'refused'
  const strong = Math.max(strong0, grain + 6), weak = Math.max(4, Math.round(C * 0.08))
  if (strong > strong0) for (let j = 0; j < W * H; j++) if (core[j] && depth[j] < strong) core[j] = 0
  const near = core.slice()
  maxFilter1D(near, W, H, 2 * grow, true)
  maxFilter1D(near, W, H, 2 * grow, false)
  const mark = new Uint8Array(W * H)
  for (let j = 0; j < W * H; j++) if (core[j] || (near[j] && depth[j] >= weak)) mark[j] = 255
  maxFilter1D(mark, W, H, grow, true)
  maxFilter1D(mark, W, H, grow, false)
  for (let j = 0; j < W * H; j++) if (foreign[j]) mark[j] = 0
  const known = new Float32Array(W * H)
  for (let j = 0; j < W * H; j++) known[j] = mark[j] || foreign[j] || brighter(j) ? 0 : 1
  const ch = [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)]
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = ((Y0 + y) * s.w + X0 + x) * 4, j = y * W + x
    ch[0][j] = d[i]; ch[1][j] = d[i + 1]; ch[2][j] = d[i + 2]
  }
  // The ground the letters stand on, and no other: a title on a narrow navy
  // band between red stripes was filled from both, and came out pink. The
  // ground is what can be reached from beside the letters without crossing an
  // EDGE — a step in colour bigger than grain makes, measured on a lightly
  // smoothed copy. A gradient is all small steps and is reached whole; a
  // band's edge stops the walk, and what lies past it is not a source.
  {
    const sm = [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)]
    for (let c = 0; c < 3; c++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let acc = 0, n = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
        acc += ch[c][yy * W + xx]; n++
      }
      sm[c][y * W + x] = acc / n
    }
    const step = (a: number, b: number) => Math.max(Math.abs(sm[0][a] - sm[0][b]), Math.abs(sm[1][a] - sm[1][b]), Math.abs(sm[2][a] - sm[2][b]))
    const STEP = Math.max(8, grain * 0.6)
    const reach = new Uint8Array(W * H)
    const queue: number[] = []
    // Seeds: ground right beside the letters (within reach of a letter's mark).
    const beside = mark.slice()
    maxFilter1D(beside, W, H, grow + 1, true)
    maxFilter1D(beside, W, H, grow + 1, false)
    for (let j = 0; j < W * H; j++) if (beside[j] && known[j]) { reach[j] = 1; queue.push(j) }
    for (let q = 0; q < queue.length; q++) {
      const j = queue[q], x = j % W, y = (j - x) / W
      for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1]) {
        if (k < 0 || reach[k] || !known[k] || step(j, k) > STEP) continue
        reach[k] = 1
        queue.push(k)
      }
    }
    let kept = 0, all = 0
    for (let j = 0; j < W * H; j++) if (known[j]) { all++; if (reach[j]) kept++ }
    lastDebug.reach = all ? Math.round(100 * kept / all) / 100 : 0
    // However little is reached, it is the ground beside the letters: a
    // title on a narrow navy band reaches only the band's ends, 2% of what
    // lies around it, and filled from everything instead it came out the
    // white of the page beyond. Only when NOTHING is reached (grain breaks
    // every walk) do the known pixels stand as they were.
    if (kept >= 30) for (let j = 0; j < W * H; j++) if (!reach[j]) known[j] = 0
  }
  if (!pushPull(ch, known, W, H)) return 'refused'
  if (out) out.field = { X0, Y0, W, H, ch, mark, reversed }
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
  for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) {
    const j = y * W + x
    if (!mark[j] || !inside[j]) continue
    const i = ((Y0 + y) * s.w + X0 + x) * 4
    work[i] = Math.round(ch[0][j]); work[i + 1] = Math.round(ch[1][j]); work[i + 2] = Math.round(ch[2][j])
    if (x < bx0) bx0 = x
    if (y < by0) by0 = y
    if (x + 1 > bx1) bx1 = x + 1
    if (y + 1 > by1) by1 = y + 1
  }
  if (lastDebug) {
    let m = 0, c = 0
    let n = 0
    for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) { if (!inside[y * W + x]) continue; n++; if (mark[y * W + x]) m++; if (core[y * W + x]) c++ }
    lastDebug.marked = Math.round(1000 * m / Math.max(1, n)) / 1000
    lastDebug.cored = Math.round(1000 * c / Math.max(1, n)) / 1000
  }
  // Print in the rectangle, none of it this run's: something was misjudged.
  if (bx0 === Infinity) return 'refused'
  return { x0: X0 + bx0, y0: Y0 + by0, x1: X0 + bx1, y1: Y0 + by1 }
}

/**
 * A run's em in scan pixels, from its box: the width the reading's letters
 * take (a box is inflated in height by a tilt or by a neighbour's tips, never
 * much in width), capped by the box's height.
 */
export function emOfRun(box: PxRect, text: string): number {
  const chars = [...text].filter(c => c !== ' ')
  const adv = chars.reduce((t, c) => t + expectedAdvance(c), 0)
  const h = box.y1 - box.y0
  const byWidth = adv > 0 ? (box.x1 - box.x0) / adv : h
  return Math.max(2, Math.min(h, byWidth))
}
