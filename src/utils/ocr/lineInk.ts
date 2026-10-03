import { pxRectOf, readerCtx, lumAt, type ScanRaster } from './scanRaster'
import { pushPull } from './inpaint'
import { fitLine, splitWords, alignCharsToWords, spaceBoundaries, type Blob, type LineFit } from './wordSeg'
import { cutGlyphs, expectedAdvance } from './glyphCut'

/**
 * What a recognised LINE is made of, on the scan's own pixels: its baseline,
 * the ink that belongs to it (and not to the lines above and below, nor to an
 * underline or a table rule), its words, and — where the ink can be cut — one
 * cell per letter with that letter's own pixels.
 *
 * This is what an edit of a scanned page is planned on (scanEdit.ts) and what
 * the page's glyph atlas is harvested from (glyphAtlas.ts): every decision
 * there is about WHICH PIXELS are which letter, and it is made here once.
 *
 * DOM-free; coordinates are the native raster's pixels unless stated.
 */

/** The page prepared once: the paper behind the ink, and each pixel's darkness against it. */
export interface PageInk {
  s: ScanRaster
  /**
   * The paper as it would be with no ink on it, RGB (3 bytes a pixel): the
   * scan with every inked pixel filled from the paper around it. Erasing a
   * letter writes these values; a letter's transmittance is its pixels over
   * them.
   */
  paper: Uint8ClampedArray
  /** Darkness against the pixel's own paper, 0 (paper) .. 255 (black): 255 · (1 − L / L_paper). */
  dark: Uint8Array
}

/** Ideographs (and full-width forms): composed of radicals, so stacked pieces are their nature, not a sign of a broken letter. */
const CJK_CHAR = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/
/** Darkness a pixel needs to be a letter's CORE (0..255): the stroke, not its anti-aliased fringe. */
export const CORE = 110
/** Darkness of the fringe that still belongs to a letter: what an erase must clear around its core. */
export const FRINGE = 26
/** Darkness of a pale piece of a letter that is not core — a faint dot or accent (see the owner map). */
const FAINT = 60

/**
 * Max-filter `src` (w × h) in place along rows or columns with a window of
 * 2r + 1 — van Herk/Gil-Werman, O(1) per pixel whatever the radius.
 */
export function maxFilter1D(src: Uint8Array, w: number, h: number, r: number, alongRows: boolean): void {
  const k = 2 * r + 1
  const n = alongRows ? w : h, lines = alongRows ? h : w
  const line = new Uint8Array(n + 2 * r)
  const g = new Uint8Array(n + 2 * r), hh = new Uint8Array(n + 2 * r)
  for (let l = 0; l < lines; l++) {
    // Pad with zeros (the filter is a max: zero never wins).
    line.fill(0)
    for (let i = 0; i < n; i++) line[i + r] = alongRows ? src[l * w + i] : src[i * w + l]
    const len = n + 2 * r
    for (let i = 0; i < len; i++) g[i] = i % k === 0 ? line[i] : Math.max(g[i - 1], line[i])
    for (let i = len - 1; i >= 0; i--) hh[i] = (i % k === k - 1 || i === len - 1) ? line[i] : Math.max(hh[i + 1], line[i])
    for (let i = 0; i < n; i++) {
      // Window [i, i + 2r] in padded coordinates is centred on pixel i.
      const a = hh[i], b = g[i + 2 * r]
      const v = a > b ? a : b
      if (alongRows) src[l * w + i] = v
      else src[i * w + l] = v
    }
  }
}

/** Whether a page is printed on white paper: its non-ink pixels mostly at 240 or above, few below 225. */
function whitePaper(L: Uint8Array, inkish: Uint8Array): boolean {
  const v: number[] = []
  for (let p = 0; p < L.length; p += 7) if (!inkish[p]) v.push(L[p])
  if (v.length < 100) return false
  v.sort((a, b) => a - b)
  return v[Math.floor(v.length * 0.1)] >= 225 && v[Math.floor(v.length * 0.5)] >= 240
}

/**
 * The brightest pixel within `r` on each side of every pixel along one axis:
 * `before[p]` over the r pixels before p, `after[p]` over the r after; pixels
 * off the page count as 0. Windows of r by van Herk / Gil-Werman, O(n).
 */
function sideMax(L: Uint8Array, w: number, h: number, r: number, alongRows: boolean): { before: Uint8Array; after: Uint8Array } {
  const N = w * h
  const before = new Uint8Array(N), after = new Uint8Array(N)
  const n = alongRows ? w : h, lines = alongRows ? h : w
  const len = n + 2 * r
  const line = new Uint8Array(len), g = new Uint8Array(len), hh = new Uint8Array(len)
  for (let l = 0; l < lines; l++) {
    line.fill(0)
    for (let i = 0; i < n; i++) line[i + r] = alongRows ? L[l * w + i] : L[i * w + l]
    for (let i = 0; i < len; i++) g[i] = i % r === 0 ? line[i] : Math.max(g[i - 1], line[i])
    for (let i = len - 1; i >= 0; i--) hh[i] = (i % r === r - 1 || i === len - 1) ? line[i] : Math.max(hh[i + 1], line[i])
    for (let i = 0; i < n; i++) {
      // Padded index of pixel i is i + r; the r before it start at i, the r
      // after it at i + r + 1. A window [a, a + r - 1] is max(hh[a], g[a + r - 1]).
      const a0 = i, a1 = i + r + 1
      const vb = Math.max(hh[a0], g[a0 + r - 1])
      const va = Math.max(hh[a1], g[a1 + r - 1])
      const p = alongRows ? l * w + i : i * w + l
      before[p] = vb
      after[p] = va
    }
  }
  return { before, after }
}

/**
 * The paper and the darkness for a whole page. The paper is estimated in two
 * steps: a max filter wider than any stroke finds how bright the paper is
 * around each pixel, which marks what is ink; then every inked pixel (with a
 * margin for its fringe) is filled from the true paper around it (`pushPull`).
 */
export function preparePage(s: ScanRaster, opts: { strokes?: boolean } = {}): PageInk {
  const N = s.w * s.h
  const L = new Uint8Array(N)
  const d = s.data
  for (let p = 0, i = 0; p < N; p++, i += 4) L[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
  // A radius of 3.6pt: wider than a bold heading's stems at any resolution.
  const pxPerPt = 1 / Math.abs(s.toPage[0] || 1)
  const R = Math.max(3, Math.round(3.6 * pxPerPt))
  const B = L.slice()
  maxFilter1D(B, s.w, s.h, R, true)
  maxFilter1D(B, s.w, s.h, R, false)
  const inkish = new Uint8Array(N)
  for (let p = 0; p < N; p++) {
    const diff = B[p] - L[p]
    if (diff > Math.max(12, B[p] * 0.08)) inkish[p] = 255
  }
  // Strokes wider than that: a 45pt bold title's stems are 8pt wide, their
  // middles never saw paper inside the filter, and read as paper they greyed
  // the estimate around every letter — an edit printed grey halos round the
  // letters it moved and left a grey smear where they had been. A near-black
  // pixel with far brighter paper on BOTH sides along one axis, within 24pt,
  // is the inside of a stroke (letters that touch make dark runs four ems of a
  // stem long). Only on a page of WHITE paper: a band of colour has paper on
  // one side only, and a tinted, patterned ground (a certificate) measured
  // this way let lines through whose ground the edit cannot match — the old
  // estimate refused them, rightly. Not on the inverted page either: cover
  // titles reversed out of a band were let through with drop shadows and
  // colour fringes the edit cannot reproduce.
  if (opts.strokes !== false && whitePaper(L, inkish)) {
    const R2 = Math.max(R + 1, Math.round(24 * pxPerPt))
    // Paper this white on both sides: a light tint (a certificate's pattern, 243)
    // is not white paper.
    const bright = (side: number, l: number) => side >= 247 && side >= l + 80
    for (const rows of [true, false]) {
      const { before, after } = sideMax(L, s.w, s.h, R2, rows)
      for (let p = 0; p < N; p++) if (!inkish[p] && L[p] < 90 && bright(before[p], L[p]) && bright(after[p], L[p])) inkish[p] = 255
    }
  }
  // The paper is sampled BEYOND the haze around the letters: a scan's strokes
  // are ringed by blur and JPEG ringing a few levels darker than the paper out
  // to ~4 px at 200 DPI (measured: 248–252 at 2–4 px from the ink, 254 beyond
  // 6), and a letter erased with paper sampled in that ring left a soft grey
  // blob where it had been.
  const grow = Math.max(2, Math.round(1.8 * pxPerPt))
  maxFilter1D(inkish, s.w, s.h, grow, true)
  maxFilter1D(inkish, s.w, s.h, grow, false)
  const known = new Float32Array(N)
  for (let p = 0; p < N; p++) known[p] = inkish[p] ? 0 : 1
  const ch = [new Float32Array(N), new Float32Array(N), new Float32Array(N)]
  for (let p = 0, i = 0; p < N; p++, i += 4) { ch[0][p] = d[i]; ch[1][p] = d[i + 1]; ch[2][p] = d[i + 2] }
  pushPull(ch, known, s.w, s.h)
  const paper = new Uint8ClampedArray(N * 3)
  const dark = new Uint8Array(N)
  for (let p = 0; p < N; p++) {
    const r = ch[0][p], g = ch[1][p], b = ch[2][p]
    paper[p * 3] = r; paper[p * 3 + 1] = g; paper[p * 3 + 2] = b
    const lp = (r * 299 + g * 587 + b * 114) / 1000
    const t = lp > 1 ? L[p] / lp : 1
    dark[p] = t >= 1 ? 0 : Math.round((1 - t) * 255)
  }
  return { s, paper, dark }
}

const invertedPages = new WeakMap<PageInk, PageInk>()

/**
 * The page with every pixel's colour inverted, prepared like the page itself:
 * reversed-out lettering (white on a band of colour) is dark ink on light
 * paper there. Made on first need and kept with the page.
 */
export function invertedPage(pi: PageInk): PageInk {
  let inv = invertedPages.get(pi)
  if (!inv) {
    const d = pi.s.data
    const data = new Uint8ClampedArray(d.length)
    for (let i = 0; i < d.length; i += 4) { data[i] = 255 - d[i]; data[i + 1] = 255 - d[i + 1]; data[i + 2] = 255 - d[i + 2]; data[i + 3] = d[i + 3] }
    inv = preparePage({ ...pi.s, data }, { strokes: false })
    invertedPages.set(pi, inv)
  }
  return inv
}

/** The prepared page a line was read on: the page, or its inverse for reversed-out lettering. */
export function pageOfLine(pi: PageInk, li: LineInk): PageInk {
  return li.inverted ? invertedPage(pi) : pi
}

/** A horizontal rule under (or through) the line — an underline, a cell border. */
export interface LineRule {
  x0: number
  x1: number
  /** Its centre row at column x, fitted. */
  y: number
  slope: number
  centreX: number
  /** Rows it is thick, at its core. */
  thick: number
  /** Its core pixels (page linear indices). */
  pix: Int32Array
}

export interface LineCell {
  char: string
  /** Column range of the cell, [x0, x1). */
  x0: number
  x1: number
  /** The cut flagged it (width or shape against its letter). */
  suspect: boolean
  /** Its word could not be cut: the cell is the word's ink shared out by expected advances. */
  approx: boolean
  word: number
  /** The letter's CORE pixels (page linear indices) — its fringe is grown from these when it is erased or moved. */
  pix: Int32Array
  /** Ink extent of `pix`; inkL > inkR when the cell holds no ink. */
  inkL: number
  inkR: number
  top: number
  bottom: number
  /** The cell's edges fall on blank columns: its letter is whole and alone. */
  isolated: boolean
}

export interface LineWord {
  x0: number
  x1: number
  top: number
  bottom: number
  /** Characters [from, to) of the reading (spaces removed) that it holds. */
  from: number
  to: number
  /** Cut into letters. */
  cut: boolean
  /**
   * The word's ink falls into exactly as many column runs as it has
   * characters, so the n-th run IS the n-th letter. Only then are its cells'
   * labels certain: a reading that dropped one letter of "20515471681" shifts
   * every cell after it, and with every digit the same width no check on the
   * cells can see it — the atlas learned a "4" from a "5".
   */
  exact: boolean
  /** Stem thickness over the em, from the darkness of the x-height band; null for a word too short to say. */
  weight: number | null
  /** How far its ink width is from what its letters should occupy (relative). */
  err: number
}

export interface LineInk {
  id: string
  text: string
  /** The recogniser's box the line was analysed in (page points) — to analyse it again with another reading. */
  inkRect: { x: number; y: number; width: number; height: number }
  /** The reading's characters, spaces removed. */
  chars: string[]
  /** Non-space indices the reading puts a space BEFORE (the first character of each word after the first). */
  spaceAfter: Set<number>
  confidence: number
  /** The pixel box analysed. */
  roi: { x0: number; y0: number; x1: number; y1: number }
  fit: LineFit
  words: LineWord[]
  /** One per character of `chars`, in order. */
  cells: LineCell[]
  rules: LineRule[]
  /** Where vertical rules (a table cell's borders) stand in the line's band, page x. */
  borders: number[]
  /** Every core pixel of every OTHER line's ink and of the rules inside the ROI, page indices — what an erase must not touch. */
  protect: Set<number>
  /** Every core pixel of this line's own letters. */
  own: Set<number>
  letterGapPx: number
  /** Median gap where the reading has a space; 0 when the line has none. */
  wordGapPx: number
  /** Median ink colour of the line's cores, RGB 0..255. */
  ink: [number, number, number]
  /** Median darkness of the line's letter cores, 0..1 — how dark this line prints. */
  coreDark: number
  /** The darkness (0..255) this line's letters were GROUPED at: `CORE`, or lower for a line whose thin strokes break apart there (its pixels are core pixels either way). */
  coreLevel: number
  /**
   * Light letters on a dark ground, read on the INVERTED scan: every pixel
   * index, paper and darkness of this analysis is `invertedPage(pi)`'s, and an
   * edit of the line is made there and inverted back.
   */
  inverted?: boolean
  /**
   * Which ink each pixel of the ROI belongs to: the cell index of the nearest
   * core pixel within `ownR` (a Voronoi partition of the line's surroundings),
   * −2 when the nearest ink is another line's or a rule's, −1 when no ink is
   * that close. A letter's REGION — what is erased, moved or harvested with
   * it — is the pixels it owns: its core, its fringe and its haze, and never
   * a neighbour's.
   */
  owner: Int16Array
  /**
   * Ink the line OWNS that no character of the reading accounts for —
   * handwriting in a form's blank, a mark, a word the recogniser skipped.
   * Owner ids `cells.length + k` in `owner`. An edit never erases it: it
   * moves with the line's tail, and an edit that would land on it is refused.
   */
  loose: { pix: Int32Array; x0: number; x1: number; y0: number; y1: number; area: number }[]
  /** Each ROI pixel's distance (8-neighbour steps) to its owner's core. */
  ownDist: Uint8Array
  ownR: number
}

/** The pixels a loose piece owns (its region, as `cellRegion` for a cell). */
export function looseRegion(li: LineInk, k: number, pageW: number): number[] {
  const piece = li.loose[k]
  const out: number[] = []
  if (!piece) return out
  const id = li.cells.length + k
  const W = li.roi.x1 - li.roi.x0
  const x0 = Math.max(li.roi.x0, piece.x0 - li.ownR - 1), x1 = Math.min(li.roi.x1, piece.x1 + li.ownR + 1)
  const y0 = Math.max(li.roi.y0, piece.y0 - li.ownR - 1), y1 = Math.min(li.roi.y1, piece.y1 + li.ownR + 1)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (li.owner[(y - li.roi.y0) * W + (x - li.roi.x0)] === id) out.push(y * pageW + x)
  }
  return out
}

/**
 * The pixels (page linear indices) a cell owns — see `LineInk.owner`. With
 * `erase`, only those an erase must clear: everything within `near` of the
 * letter, and beyond that only what is visibly darker than the paper — the
 * JPEG ringing a letter leaves out to the edge of its 8×8 block (a pixel at
 * 234 on 254 paper five rows under a word), not the paper's own grain, which
 * a fill would flatten into a smooth, visible patch.
 */
export function cellRegion(li: LineInk, k: number, pageW: number, erase?: { dark: Uint8Array; near: number; minDark: number }): number[] {
  const c = li.cells[k]
  const out: number[] = []
  if (!c || !c.pix.length) return out
  const W = li.roi.x1 - li.roi.x0
  const x0 = Math.max(li.roi.x0, c.inkL - li.ownR - 1), x1 = Math.min(li.roi.x1, c.inkR + li.ownR + 1)
  const y0 = Math.max(li.roi.y0, c.top - li.ownR - 1), y1 = Math.min(li.roi.y1, c.bottom + li.ownR + 1)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const j = (y - li.roi.y0) * W + (x - li.roi.x0)
    if (li.owner[j] !== k) continue
    const p = y * pageW + x
    if (erase && li.ownDist[j] > erase.near && erase.dark[p] < erase.minDark) continue
    out.push(p)
  }
  return out
}

/** Why the last line analysis returned null — for the lab. */
let failedBecause = ''
export function lastLineFailure(): string { return failedBecause }
/** The last analysis's fragmentation measure — for the lab. */
let fragDebug: unknown = null
export function lastFragTest(): unknown { const v = fragDebug; fragDebug = null; return v }
/** The last arc test's thirds — for the lab. */
let arcDebug: unknown = null
export function lastArcTest(): unknown { const v = arcDebug; arcDebug = null; return v }
/** The blobs the last analysis fitted its baseline to — for the lab. */
let fitBlobs: Blob[] = []
export function lastFitBlobs(): Blob[] { return fitBlobs }
function fail(why: string): null { failedBecause = why; return null }

interface Comp { pix: number[]; x0: number; x1: number; y0: number; y1: number; area: number; cx: number; cy: number }

/** 8-connected components of `mask` (ROI-sized), in page coordinates. */
function components(mask: Uint8Array, W: number, H: number, ox: number, oy: number, pageW: number): Comp[] {
  const label = new Int32Array(W * H)
  const out: Comp[] = []
  const stack: number[] = []
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!mask[s0] || label[s0]) continue
    const id = out.length + 1
    const c: Comp = { pix: [], x0: W, x1: -1, y0: H, y1: -1, area: 0, cx: 0, cy: 0 }
    label[s0] = id
    stack.push(s0)
    let sx = 0, sy = 0
    while (stack.length) {
      const j = stack.pop()!
      const x = j % W, y = (j - x) / W
      c.pix.push((oy + y) * pageW + ox + x)
      c.area++; sx += x; sy += y
      if (x < c.x0) c.x0 = x
      if (x > c.x1) c.x1 = x
      if (y < c.y0) c.y0 = y
      if (y > c.y1) c.y1 = y
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const n = ny * W + nx
        if (mask[n] && !label[n]) { label[n] = id; stack.push(n) }
      }
    }
    c.x0 += ox; c.x1 += ox + 1; c.y0 += oy; c.y1 += oy + 1
    c.cx = ox + sx / c.area + 0.5; c.cy = oy + sy / c.area + 0.5
    out.push(c)
  }
  return out
}

/**
 * Components stacked in the same columns joined into one: pieces overlapping
 * across by half the narrower one's width, a small vertical gap apart, as
 * long as the union stays the size of a letter. A letter's dot or accent
 * joins it too, which changes nothing its foot or its height is used for.
 */
function stackPieces(comps: Comp[], em: number, gapLimit?: number): Comp[] {
  const n = comps.length
  if (n < 2) return comps
  const parent = comps.map((_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const ext = comps.map(c => ({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 }))
  const order = comps.map((_, i) => i).sort((a, b) => comps[a].x0 - comps[b].x0)
  const gapMax = gapLimit ?? Math.max(2, em * 0.2)
  for (let a = 0; a < n; a++) {
    const ci = comps[order[a]]
    for (let b = a + 1; b < n; b++) {
      const cj = comps[order[b]]
      if (cj.x0 >= ci.x1) break
      const ov = Math.min(ci.x1, cj.x1) - Math.max(ci.x0, cj.x0)
      if (ov < Math.max(1, Math.min(ci.x1 - ci.x0, cj.x1 - cj.x0) * 0.5)) continue
      if (Math.max(ci.y0, cj.y0) - Math.min(ci.y1, cj.y1) > gapMax) continue
      const ri = find(order[a]), rj = find(order[b])
      if (ri === rj) continue
      const e = ext[ri], f = ext[rj]
      const u = { x0: Math.min(e.x0, f.x0), x1: Math.max(e.x1, f.x1), y0: Math.min(e.y0, f.y0), y1: Math.max(e.y1, f.y1) }
      if (u.y1 - u.y0 > em * 1.3 || u.x1 - u.x0 > em * 1.2) continue
      parent[rj] = ri
      ext[ri] = u
    }
  }
  const groups = new Map<number, Comp[]>()
  comps.forEach((c, i) => { const r = find(i); const g = groups.get(r); if (g) g.push(c); else groups.set(r, [c]) })
  return [...groups.values()].map(g => {
    if (g.length === 1) return g[0]
    const area = g.reduce((t, c) => t + c.area, 0)
    return {
      pix: g.flatMap(c => c.pix), area,
      x0: Math.min(...g.map(c => c.x0)), x1: Math.max(...g.map(c => c.x1)),
      y0: Math.min(...g.map(c => c.y0)), y1: Math.max(...g.map(c => c.y1)),
      cx: g.reduce((t, c) => t + c.cx * c.area, 0) / area, cy: g.reduce((t, c) => t + c.cy * c.area, 0) / area
    }
  })
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

let smoothDebug: unknown = null
export function lastSmoothTest(): unknown { const v = smoothDebug; smoothDebug = null; return v }

/**
 * How far the paper estimate departs from its own local average, over the
 * line's region: the 90th percentile of |paper − box blur(paper)| at pixels
 * that are not ink, in levels. A gradient reads one or two; a photograph's
 * texture tens.
 */
function paperRoughness(pi: PageInk, roi: { x0: number; y0: number; x1: number; y1: number }, em: number): number {
  const s = pi.s, W = roi.x1 - roi.x0, H = roi.y1 - roi.y0
  const P = new Float32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (roi.y0 + y) * s.w + roi.x0 + x
    P[y * W + x] = (pi.paper[p * 3] * 299 + pi.paper[p * 3 + 1] * 587 + pi.paper[p * 3 + 2] * 114) / 1000
  }
  const r = Math.max(3, Math.round(em * 0.5))
  // Separable box blur with edge clamping, via running sums.
  const tmp = new Float32Array(W * H), blur = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    let acc = 0, n = 0
    for (let x = -r; x <= r; x++) if (x >= 0 && x < W) { acc += P[y * W + x]; n++ }
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = acc / n
      const out = x - r, inn = x + r + 1
      if (out >= 0) { acc -= P[y * W + out]; n-- }
      if (inn < W) { acc += P[y * W + inn]; n++ }
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0, n = 0
    for (let y = -r; y <= r; y++) if (y >= 0 && y < H) { acc += tmp[y * W + x]; n++ }
    for (let y = 0; y < H; y++) {
      blur[y * W + x] = acc / n
      const out = y - r, inn = y + r + 1
      if (out >= 0) { acc -= tmp[out * W + x]; n-- }
      if (inn < H) { acc += tmp[inn * W + x]; n++ }
    }
  }
  const res: number[] = []
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const p = (roi.y0 + y) * s.w + roi.x0 + x
    if (pi.dark[p] >= FRINGE) continue
    res.push(Math.abs(P[y * W + x] - blur[y * W + x]))
  }
  if (res.length < 20) return Infinity
  res.sort((a, b) => a - b)
  return res[Math.floor(res.length * 0.9)]
}

/**
 * Analyse one recognised line on the prepared page. `inkRect` is in page
 * points (top-left), as OCR reports it. Null when the line's ink cannot be
 * told apart (no letters, a baseline that cannot be fitted, a reading that
 * cannot be shared among the words) — the caller then leaves the line to the
 * vector redraw.
 */
export function analyzeLine(pi: PageInk, item: { id: string; text: string; inkRect: { x: number; y: number; width: number; height: number }; confidence?: number }, opts: { inverted?: boolean } = {}): LineInk | null {
  failedBecause = ''
  const s = pi.s
  const text = item.text
  const chars = [...text].filter(c => c !== ' ')
  if (!chars.length) return fail('no characters')
  const box = pxRectOf(s, item.inkRect)
  if (box.x1 - box.x0 < 2 || box.y1 - box.y0 < 2) return fail('box too small')
  const advSum = chars.reduce((t, c) => t + expectedAdvance(c), 0) || 1
  // The em the box's WIDTH implies: a skewed line's box is too tall, never too wide.
  let emGuess = (box.x1 - box.x0) / advSum
  const boxH = box.y1 - box.y0
  if (chars.length <= 2) emGuess = Math.max(emGuess, boxH / 1.2)
  emGuess = Math.min(emGuess, boxH * 1.6)
  const padY = Math.round(emGuess * 0.9), padX = Math.round(emGuess * 0.6)
  const roi = { x0: Math.max(0, box.x0 - padX), y0: Math.max(0, box.y0 - padY), x1: Math.min(s.w, box.x1 + padX), y1: Math.min(s.h, box.y1 + padY) }
  const W = roi.x1 - roi.x0, H = roi.y1 - roi.y0
  const at = (x: number, y: number) => (roi.y0 + y) * s.w + roi.x0 + x
  // Light text on a dark ground — a title reversed out of a band of colour,
  // a book cover's lettering, a logo's badge — is not ink on paper, and read
  // as such the paper estimate takes the white letters for paper and the
  // ground for ink: an "erase" painted pale blobs around letters it never
  // removed. On paper the TYPICAL pixel of a line and its surroundings is
  // paper, light, and the ink is the dark minority; reversed out, the typical
  // pixel is the ground. The median luminance says which end it sits nearer.
  // Such a line is read on the scan INVERTED (`invertedPage`), where it is
  // dark ink on light paper, and edited there; its pixels are inverted back
  // when the edit is laid over the page. Judged before the paper is: the
  // paper estimate around white letters is their ground, never plain.
  if (!opts.inverted) {
    const r = Math.max(2, Math.round(emGuess * 0.35))
    const lums: number[] = []
    for (let y = Math.max(0, box.y0 - r); y < Math.min(s.h, box.y1 + r); y += 2) {
      for (let x = Math.max(0, box.x0 - r); x < Math.min(s.w, box.x1 + r); x += 2) lums.push(lumAt(s.data, y * s.w + x))
    }
    if (lums.length > 40) {
      lums.sort((a, b) => a - b)
      const lo = lums[Math.floor(lums.length * 0.03)], hi = lums[Math.floor(lums.length * 0.97)], med = lums[Math.floor(lums.length / 2)]
      if (hi - lo > 60 && med - lo < (hi - med) * 0.8) {
        const li = analyzeLine(invertedPage(pi), item, { inverted: true })
        return li ?? fail(`the text is lighter than its ground, and reversed: ${failedBecause}`)
      }
    }
  }
  // Plain paper behind the line, or nothing is erased cleanly: lettering set
  // over a photograph or a gradient (a brochure's title on its picture) has no
  // paper to fill from, and an erase there punched pale holes in the picture.
  let smoothGround = false
  {
    const lums: number[] = []
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 3) {
      const p = at(x, y)
      if (pi.dark[p] >= FRINGE) continue
      lums.push((pi.paper[p * 3] * 299 + pi.paper[p * 3 + 1] * 587 + pi.paper[p * 3 + 2] * 114) / 1000)
    }
    if (lums.length > 40) {
      const sorted = [...lums].sort((a, b) => a - b)
      const range = sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.05)]
      if (range > 40) {
        // A wide range is not a picture when it is SMOOTH: a cover's gradient
        // spans a hundred levels across a line and a pixel's paper differs
        // from the paper around it by a level or two. What the erase needs is
        // that the paper can be filled from its surroundings, and a gradient
        // can — a photograph's texture cannot.
        const rough = paperRoughness(pi, roi, emGuess)
        smoothDebug = { range, rough }
        if (rough > 8) return fail('the background is not plain paper')
        smoothGround = true
      }
    }
  }
  // The core is the stroke, not its fringe. Thin strokes that print grey —
  // a 96-DPI receipt's light sans, its strokes a pixel wide and peaking at
  // darkness 175 — fall out of it where they thin: every letter broke into
  // specks one to three pixels tall, the baseline was fitted to the specks'
  // bottoms (two pixels above the letters', so a letter set on it floated),
  // and a quarter of the words could be cut. Such a line is analysed again at
  // half its strokes' peak — but only when its letters DO fall apart at the
  // fixed level: grey ink in thick strokes (a bilingual form) is whole there,
  // and lowered, its letters fattened, its words merged and its em grew by a
  // third, which cost the page twenty of its edits. A line with ideographs in
  // it keeps the fixed level: their radicals are pieces by design, and joined
  // they made "NO APLICA 不适用" a line of tall letters.
  const weakLevel = (() => {
    const v: number[] = []
    for (let y = Math.max(0, box.y0); y < Math.min(s.h, box.y1); y++) for (let x = Math.max(0, box.x0); x < Math.min(s.w, box.x1); x++) {
      const d = pi.dark[y * s.w + x]
      if (d >= FRINGE) v.push(d)
    }
    if (v.length < 30) return null
    v.sort((a, b) => a - b)
    const peak = v[Math.floor(v.length * 0.9)]
    return peak >= 200 ? null : Math.max(70, Math.round(peak * 0.5))
  })()
  const coreAt = (level: number) => {
    const core = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (pi.dark[at(x, y)] >= level) core[y * W + x] = 1
    return core
  }
  let coreLevel = CORE
  const core = coreAt(CORE)

  // Horizontal rules: core runs far longer than any letter is wide. Taken
  // out of the core BEFORE the letters are labelled, or an underline welds
  // every letter sitting on it into one component.
  const ruleLen = Math.max(8, emGuess * 1.6)
  const ruleMask = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    let start = -1
    for (let x = 0; x <= W; x++) {
      const on = x < W && core[y * W + x]
      if (on && start < 0) start = x
      if (!on && start >= 0) { if (x - start >= ruleLen) ruleMask.fill(1, y * W + start, y * W + x); start = -1 }
    }
  }
  // A rule's blurred edge rows are part of it where they run along it.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const j = y * W + x
    if (ruleMask[j] || !core[j]) continue
    if ((y > 0 && ruleMask[j - W]) || (y < H - 1 && ruleMask[j + W])) {
      // Only when the pixel is not the start of a letter's stem: a stem
      // continues away from the rule, a rule's edge does not.
      const away = y > 0 && ruleMask[j - W] ? (y < H - 1 ? core[j + W] : 0) : (y > 0 ? core[j - W] : 0)
      if (!away) ruleMask[j] = 1
    }
  }
  const glyphCore = new Uint8Array(W * H)
  for (let j = 0; j < W * H; j++) glyphCore[j] = core[j] && !ruleMask[j] ? 1 : 0
  let comps = components(glyphCore, W, H, roi.x0, roi.y0, s.w)
  // Do the letters fall apart here? A line's pieces are about one per
  // character when its letters print whole (an i's dot or an accent adds a
  // few, letters that touch take a few away). The receipt's thin strokes
  // came in at two pieces a character; at half their peak, one. A grey form
  // in thick strokes is whole at the fixed level already — one a character —
  // and lowered, its letters FUSE (fewer pieces than characters). The level
  // whose count is nearer one a character is the line's. Ideographs are
  // several radicals each by design and keep the fixed level.
  let stacking = false
  const piecesPerChar = (cs: Comp[]) => cs.filter(c => c.area >= 2 && c.cx >= box.x0 && c.cx <= box.x1 && c.cy >= box.y0 - emGuess * 0.3 && c.cy <= box.y1 + emGuess * 0.3).length / Math.max(1, chars.length)
  if (weakLevel !== null && weakLevel < CORE && chars.length >= 3 && !chars.some(c => CJK_CHAR.test(c))) {
    const atCore = piecesPerChar(comps)
    // The lower level only says which pieces BELONG together; every pixel a
    // letter keeps is still a core pixel at the fixed level. Taken whole at
    // the lower level, a letter gained its fringe rows top and bottom: heights
    // grew by a pixel or two, the em by up to a quarter, and the letters such
    // a line gave the atlas matched the size of no letter wanted elsewhere —
    // "no letter on the page" for an X the form had printed.
    const weakMask = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const j = y * W + x
      if (!ruleMask[j] && pi.dark[at(x, y)] >= weakLevel) weakMask[j] = 1
    }
    const grouped: Comp[] = []
    for (const c of components(weakMask, W, H, roi.x0, roi.y0, s.w)) {
      const pix = c.pix.filter(p => pi.dark[p] >= CORE)
      if (!pix.length) continue
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, sx = 0, sy = 0
      for (const p of pix) {
        const x = p % s.w, y = (p - x) / s.w
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        sx += x; sy += y
      }
      grouped.push({ pix, area: pix.length, x0, x1: x1 + 1, y0, y1: y1 + 1, cx: sx / pix.length + 0.5, cy: sy / pix.length + 0.5 })
    }
    const atWeak = piecesPerChar(grouped)
    fragDebug = { weakLevel, atCore, atWeak }
    if (atCore > 1.25 && Math.abs(Math.log(Math.max(0.05, atWeak))) + 0.1 < Math.abs(Math.log(atCore))) {
      coreLevel = weakLevel
      comps = grouped
      stacking = true
    }
  }
  // A line set over a PICTURE: a book cover's sticker over a photograph of
  // water, where the water reads as ink against the sticker's yellow, so the
  // plain-paper test above (which samples only what is lighter) saw a plain
  // yellow ground — and an erase smeared yellow over the photograph. A
  // picture shows here as ink no letter can be: wide AND tall, or simply
  // vast. A thin rule or a table border is not one.
  {
    let big = 0
    for (const c of comps) {
      const w = c.x1 - c.x0, h = c.y1 - c.y0
      if (w < emGuess * 0.5) continue
      if ((w > emGuess * 3 && h > emGuess * 0.8) || h > emGuess * 2.2 || c.area > emGuess * emGuess * 2.5) big += c.area
    }
    if (big > W * H * 0.06) return fail('the line is set over a picture')
  }

  // The baseline, from the letters inside the recogniser's own box — and
  // those in a band around it. A TILTED line's box is not where its letters
  // are: the recogniser boxes its middle, and on a phone photo of a
  // certificate the box of a 3° line sat 30 px above its left half, held the
  // centres of only two of its letters, and the baseline fitted to those two
  // ran level through the middle of the line. The box's own letters count
  // double, so its line outvotes a neighbour's caught in the band; a fit that
  // does not pass through the box at all is refused for the strict one.
  // A letter whose thin strokes print paler than its stems — a diagonal on a
  // low-resolution scan, an S's spine, the 2's — falls apart into pieces
  // stacked in its own columns, each too short to count as a letter and most
  // ending above its foot: the baseline was fitted to the pieces' bottoms, two
  // pixels over the letters'. For the letters' geometry, pieces stacked in
  // the same columns are one letter (the pixels stay the components' own).
  // Only on such a line: where letters print whole, a piece under a letter is
  // something else — an underline's stub — and joined to the letter it pulled
  // the baseline down onto the rule.
  const sized = (stacking ? stackPieces(comps, emGuess) : comps).filter(c => { const h = c.y1 - c.y0; return c.area >= 4 && h >= emGuess * 0.25 && h <= emGuess * 1.5 })
  const inBox = (c: Comp) => c.cy >= box.y0 && c.cy <= box.y1 && c.cx >= box.x0 && c.cx <= box.x1
  const letters = sized.filter(inBox)
  const band = sized.filter(c => c.cx >= box.x0 && c.cx <= box.x1 && c.cy >= box.y0 - emGuess * 0.6 && c.cy <= box.y1 + emGuess * 0.6)
  if (letters.length < Math.min(2, chars.length) && band.length < Math.min(3, chars.length)) return fail('no letters in the box')
  const asBlob = (c: Comp, w = 1): Blob => ({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, area: c.area, cx: c.cx, cy: c.cy, w })
  fitBlobs = band.map(c => asBlob(c, inBox(c) ? 2 : 1))
  let fit: LineFit | null = band.length >= 2 ? fitLine(band.map(c => asBlob(c, inBox(c) ? 2 : 1)), emGuess, text) : null
  if (fit) {
    const mid = fit.y + fit.slope * ((box.x0 + box.x1) / 2 - fit.centreX)
    if (mid < box.y0 || mid > box.y1 + fit.emPx * 0.9) fit = null
  }
  if (!fit && letters.length >= 2) fit = fitLine(letters.map(c => asBlob(c)), emGuess, text)
  if (!fit) {
    const c = letters[0] ?? band[0]
    if (!c) return fail('no letters in the box')
    fit = { y: c.y1, slope: 0, centreX: (c.x0 + c.x1) / 2, emPx: emGuess }
  }
  const em = fit.emPx
  const base = (x: number) => fit!.y + fit!.slope * (x - fit!.centreX)
  // A recognised "line" that is really two printed lines (the detector took
  // both in one box) has letters well clear of the fitted line on the other
  // side: the edit would be planned on one line's ink with both lines' text.
  {
    let off = 0, total = 0
    for (const c of letters) {
      total++
      const b = base(c.cx)
      if (c.y1 < b - em * 1.05 || c.y0 > b + em * 0.25) off++
    }
    if (total >= 6 && off > total * 0.3) return fail('the box holds more than one printed line')
  }
  // Text set on an ARC (a seal's "REPÚBLICA DEL PERÚ") has no baseline: the
  // straight fit runs under its middle letters and through its end ones, and
  // an edit laid along it put the moved letters off the curve. The letters
  // standing on the fit in each third of the line, middle against ends.
  {
    const sitting = band.filter(c => Math.abs(c.y1 - base(c.cx)) < em * 0.3).sort((a, b) => a.cx - b.cx)
    if (sitting.length >= 9) {
      const third = Math.floor(sitting.length / 3)
      const thirds = [sitting.slice(0, third), sitting.slice(third, sitting.length - third), sitting.slice(sitting.length - third)]
      const med = (v: number[]) => [...v].sort((p, q) => p - q)[Math.floor(v.length / 2)]
      // On an arc the letters' TOPS bend with their feet. Bottoms alone are
      // fooled by old-style figures — a run of descending 3s and 9s in the
      // middle of "RUC: 20319363221" read as the line bending — and tops alone
      // by capitals beside figures; a seal's "REPÚBLICA DEL PERÚ" bends both
      // (2.7 and 2.3 px on a 16.6 px em), its middle off BOTH ends the same way.
      const [ba, bm, bb] = thirds.map(cs => med(cs.map(c => c.y1 - base(c.cx))))
      const [ta, tm, tb] = thirds.map(cs => med(cs.map(c => c.y0 - base(c.cx))))
      const dB = bm - (ba + bb) / 2, dT = tm - (ta + tb) / 2
      arcDebug = { n: sitting.length, em, bottoms: [ba, bm, bb], tops: [ta, tm, tb], dB, dT }
      const bends = Math.abs(dB) > em * 0.12 && Math.abs(dT) > em * 0.08 && Math.sign(dB) === Math.sign(dT) &&
        Math.sign(tm - ta) === Math.sign(dT) && Math.sign(tm - tb) === Math.sign(dT) && Math.min(Math.abs(tm - ta), Math.abs(tm - tb)) > em * 0.03
      if (bends) return fail('the line is set on a curve')
    }
  }

  // Which ink is this line's: a component whose centre sits in the line's
  // letter band. A component far taller than a letter is a vertical rule or
  // two lines' strokes welded together; only its pixels inside the band are
  // the line's.
  const ownPieces: Comp[] = []
  const protect = new Set<number>()
  const own = new Set<number>()
  /** Where vertical rules stand in the line's band — a cell's borders. */
  const borders: number[] = []
  for (let c of comps) {
    // A cell's text set hard against its border welds the first letter to
    // the border, and the piece is too wide to be a rule: "ING. CIVIL" took
    // the border for part of its "I". Columns at either edge of a piece that
    // are inked unbroken from above the capitals to below the baseline are
    // the border, carved off.
    if (c.x1 - c.x0 > Math.max(3, em * 0.18) && c.y1 - c.y0 >= em * 0.95) {
      const b0 = base(c.cx)
      const onRule = (x: number, y: number) => {
        for (let dy = 1; dy <= 3; dy++) for (let dx = -1; dx <= 1; dx++) {
          const lx = x + dx - roi.x0, ly = y + dy - roi.y0
          if (lx >= 0 && ly >= 0 && lx < W && ly < H && ruleMask[ly * W + lx]) return true
        }
        return false
      }
      const carved = carveBorder(c, s.w, Math.round(b0 - em * 0.78), Math.round(b0 + Math.max(2, em * 0.1)), Math.max(2, Math.round(em * 0.15)), { base: Math.round(b0), onRule })
      if (carved) {
        for (const p of carved.rule) protect.add(p)
        borders.push(carved.x)
        if (carved.rest.length < 4) continue
        c = compOf(carved.rest, s.w)
      }
    }
    const h = c.y1 - c.y0, w = c.x1 - c.x0
    const inX = c.cx >= box.x0 - em * 0.6 && c.cx <= box.x1 + em * 0.6
    if (h > em * 1.45 && w < em * 0.3) {
      for (const p of c.pix) protect.add(p)
      const b0 = base(c.cx)
      if (c.y0 <= b0 - em * 0.5 && c.y1 >= b0) borders.push(c.cx)
      continue
    }
    // A table's vertical rule, cut into row-high pieces where the horizontal
    // rules cross it: thin, standing from above the capitals to below the
    // baseline, and STRAIGHT (a parenthesis is as tall and bows). Taken for a
    // letter, it was the first letter of the cell's text: reversing "QUISPE"
    // erased the border and set the new word where it had stood, over the
    // number in the column before.
    if (w <= Math.max(3, em * 0.18) && h >= em * 0.95) {
      const b0 = base(c.cx)
      if (c.y0 <= b0 - em * 0.78 && c.y1 >= b0 + Math.max(2, em * 0.1) && isStraightUpright(c, s.w, Math.max(1.2, em * 0.04))) {
        for (const p of c.pix) protect.add(p)
        borders.push(c.cx)
        continue
      }
    }
    if (h > em * 1.6) {
      const mine: number[] = []
      for (const p of c.pix) {
        const x = p % s.w, y = (p - x) / s.w
        const b = base(x)
        if (inX && y >= b - em * 1.12 && y <= b + em * 0.4) mine.push(p)
        else protect.add(p)
      }
      if (mine.length >= 4) ownPieces.push(compOf(mine, s.w))
      continue
    }
    const b = base(c.cx)
    if (inX && c.cy >= b - em * 1.02 && c.cy <= b + em * 0.36) ownPieces.push(c)
    else for (const p of c.pix) protect.add(p)
  }
  // A cell's text stops at the cell's borders. The recogniser's box of
  // "QUISPE…" reached across the border into the column before, and the "51"
  // of "351" was read as its "Q" — reversing the name then set "EPSIUQ" over
  // the number. Where a border stands within the box's span, the line's ink
  // is the stretch between borders that holds most of it.
  {
    const inside = borders.filter(x => x > box.x0 - em * 0.6 && x < box.x1 + em * 0.6).sort((a, b) => a - b)
    if (inside.length) {
      const edges = [-Infinity, ...inside, Infinity]
      let best = 0, bestMass = -1
      for (let k = 0; k + 1 < edges.length; k++) {
        const mass = ownPieces.filter(c => c.cx > edges[k] && c.cx < edges[k + 1]).reduce((t, c) => t + c.area, 0)
        if (mass > bestMass) { bestMass = mass; best = k }
      }
      for (let i = ownPieces.length - 1; i >= 0; i--) {
        const c = ownPieces[i]
        if (c.cx > edges[best] && c.cx < edges[best + 1]) continue
        for (const p of c.pix) protect.add(p)
        ownPieces.splice(i, 1)
      }
    }
  }
  // A mark lying wholly BELOW the baseline is the line beneath's when it is
  // shaped and placed like an accent — small and short, none of this line's
  // letters reaching down to it, and sitting right on top of a letter that is
  // NOT this line's. Set tight, the next line's accents sit inside this
  // line's band, and taken as its loose ink the accent travelled with the
  // line's tail: deleting "LOS" from a title moved the accent of "SEDUCCIÓN"
  // under it onto its U. Asking less (any piece below the baseline nothing
  // reaches) took a form's handwritten blank and a tilted heading's "S".
  for (let i = ownPieces.length - 1; i >= 0; i--) {
    const c = ownPieces[i]
    if (c.y0 <= base(c.cx) + em * 0.08 || c.area > em * em * 0.06 || c.y1 - c.y0 > em * 0.35) continue
    const hangs = ownPieces.some(o => o !== c && o.x1 > c.x0 && o.x0 < c.x1 && o.y0 < c.y0 && o.y1 >= c.y0 - em * 0.1)
    if (hangs) continue
    const over = comps.some(o => !ownPieces.includes(o) && o.x1 > c.x0 && o.x0 < c.x1 && o.y0 >= c.y1 - 1 && o.y0 <= c.y1 + em * 0.45 && o.area >= c.area)
    if (!over) continue
    for (const p of c.pix) protect.add(p)
    ownPieces.splice(i, 1)
  }
  for (const c of ownPieces) for (const p of c.pix) own.add(p)

  // Rules: the rule mask's runs, grouped into rules by row adjacency.
  const rules: LineRule[] = []
  {
    const rc = components(ruleMask, W, H, roi.x0, roi.y0, s.w)
    for (const r of rc) {
      if (r.x1 - r.x0 < ruleLen) continue
      // Its centre line: least squares through each column's mean row.
      const cols = new Map<number, { sum: number; n: number }>()
      for (const p of r.pix) {
        const x = p % s.w, y = (p - x) / s.w
        const e = cols.get(x) ?? { sum: 0, n: 0 }
        e.sum += y; e.n++
        cols.set(x, e)
      }
      const xs: number[] = [], ys: number[] = [], ns: number[] = []
      for (const [x, e] of cols) { xs.push(x); ys.push(e.sum / e.n); ns.push(e.n) }
      const cx = xs.reduce((a, b) => a + b, 0) / xs.length
      const cy = ys.reduce((a, b) => a + b, 0) / ys.length
      let sxy = 0, sxx = 0
      for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - cx) * (ys[i] - cy); sxx += (xs[i] - cx) ** 2 }
      const slope = sxx > 0 ? sxy / sxx : 0
      rules.push({ x0: r.x0, x1: r.x1, y: cy, slope: Math.abs(slope) < 0.05 ? slope : 0, centreX: cx, thick: median(ns), pix: Int32Array.from(r.pix) })
      for (const p of r.pix) protect.add(p)
      // A rule fades out at its ends, below a core's darkness but still
      // plainly the rule — and the owner map gave that pale end to the nearest
      // letter: moving the "Ó" of a table cell carried the last twelve pixels
      // of the cell's rule with it, a darker stretch where they landed and a
      // gap where they had been. The rule is followed out along its own line
      // through every column that still holds a pixel of its fringe.
      const rs = Math.abs(slope) < 0.05 ? slope : 0
      const half = Math.max(1, Math.ceil(median(ns) / 2) + 1)
      for (const dir of [-1, 1]) {
        for (let x = dir < 0 ? r.x0 - 1 : r.x1; x >= roi.x0 && x < roi.x1; x += dir) {
          const yc = Math.round(cy + rs * (x - cx))
          let any = false
          for (let y = yc - half; y <= yc + half; y++) {
            if (y < roi.y0 || y >= roi.y1) continue
            const p = y * s.w + x
            if (pi.dark[p] < FRINGE) continue
            protect.add(p)
            any = true
          }
          if (!any) break
        }
      }
    }
    // Rule pixels too short to be a rule of their own were a letter's.
  }
  // A piece of the line's ink lying on a rule's line is the rule's: its far
  // end, cut off from the rest by a pale stretch, came out as a short run of
  // its own, and was taken for part of the letter above it.
  for (let i = ownPieces.length - 1; i >= 0; i--) {
    const c = ownPieces[i]
    let on = 0
    for (const p of c.pix) if (protect.has(p)) on++
    if (on < c.pix.length * 0.6) continue
    for (const p of c.pix) { protect.add(p); own.delete(p) }
    ownPieces.splice(i, 1)
  }

  // Words: the line's own ink split at its word gaps, then the reading
  // shared among them by width.
  const blobs: Blob[] = ownPieces.map(c => ({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, area: c.area, cx: c.cx, cy: c.cy }))
  const split = splitWords(blobs, fit)
  if (!split.words.length) return fail('no words')
  const spaceAfter = spaceBoundaries(text)
  const matches = alignCharsToWords(split.words, chars, spaceAfter)
  if (!matches) return fail('the reading does not fit the words')
  // The reading as a whole against the ink as a whole: letters it dropped or
  // invented by the dozen (a line read as half of itself) leave every word's
  // share of the reading wrong, and nothing on it can be trusted to edit.
  {
    const inkW = split.words.reduce((t, w) => t + (w.x1 - w.x0), 0)
    const want = chars.reduce((t, c) => t + expectedAdvance(c), 0) * em * 0.92
    if (chars.length >= 8 && (inkW > want * 1.45 || inkW < want * 0.6)) {
      // A LETTER-SPACED title ("J U D E A  P E A R L" on a book's title page)
      // is far wider than its letters' advances, and is read exactly right:
      // its letters stand apart, one piece each, as many as the reading has.
      // A reading that dropped or invented letters by the dozen cannot match
      // the count as well as the width.
      const letterish = ownPieces.filter(c => c.y1 - c.y0 >= em * 0.3).length
      const visible = chars.filter(c => !/[.,:;'"`´\-–—]/.test(c)).length
      if (Math.abs(letterish - visible) > Math.max(1, Math.round(visible * 0.12))) return fail('the reading does not fit the ink')
    }
  }

  const ctx = readerCtx(s)
  const hint = { emPx: em, baselineAt: base }
  const words: LineWord[] = []
  const assigned = new Set<Comp>()
  const cells: LineCell[] = new Array(chars.length)
  /** One ink word, or one part of one: characters [from, to) of the reading, its pieces of ink and their box. */
  const addWord = (from: number, to: number, pieces: Comp[], iw: { x0: number; x1: number; top: number; bottom: number }, err: number) => {
    const wi = words.length
    const wordChars = chars.slice(from, to)
    // Cut the word alone, on its own ink box, with the line's em and baseline.
    const cut = cutGlyphs(ctx, { x: iw.x0 - 1, y: iw.top - 1, width: iw.x1 - iw.x0 + 2, height: iw.bottom - iw.top + 2 }, wordChars.join(''), undefined, hint)
    const cutOk = !!cut && cut.cells.length === wordChars.length
    const cutExact = cutOk && columnRuns(pieces) === wordChars.length
    // Letters that stand apart need no cutter: one ink run per character IS
    // the cut. The cutter refuses a line under 16 px of em ("too small to
    // trace" — a floor for OUTLINES, not for moving pixels) and vets widths
    // against a face it can only guess; on a 150 DPI office scan that left 70
    // of 72 words uncut, and an edit could keep none of their letters — a
    // letter deleted from a logo redrew the whole word, from letters the page
    // did not hold.
    const byRuns = cutExact ? null : runCellsOf(pieces, wordChars, em)
    const ok = cutOk || !!byRuns
    let wordCells: { char: string; x0: number; x1: number; suspect: boolean }[]
    if (byRuns) {
      wordCells = byRuns
    } else if (ok) {
      wordCells = cut!.cells.map(c => ({ char: c.char, x0: c.x0, x1: c.x1, suspect: !!c.suspect }))
      // The cut's cells are inclusive of the box's pad; the word's ink is the truth at its ends.
      wordCells[0].x0 = Math.min(wordCells[0].x0, iw.x0)
      wordCells[wordCells.length - 1].x1 = Math.max(wordCells[wordCells.length - 1].x1, iw.x1)
    } else {
      const total = wordChars.reduce((t, c) => t + expectedAdvance(c), 0) || 1
      let x = iw.x0
      wordCells = wordChars.map((ch, i) => {
        const x1 = i === wordChars.length - 1 ? iw.x1 : x + (iw.x1 - iw.x0) * expectedAdvance(ch) / total
        const c = { char: ch, x0: Math.round(x), x1: Math.round(x1), suspect: false }
        x = x1
        return c
      })
    }
    // Each piece of ink goes to the cell holding most of its columns; a piece
    // that two letters share (they touch) is divided at the cells' boundary.
    const pixOf: number[][] = wordCells.map(() => [])
    for (const c of pieces) {
      const counts = wordCells.map(wc => Math.max(0, Math.min(c.x1, wc.x1) - Math.max(c.x0, wc.x0)))
      const best = counts.indexOf(Math.max(...counts))
      const span = c.x1 - c.x0
      if (counts[best] >= span * 0.8 || wordCells.length === 1) { for (const p of c.pix) pixOf[best].push(p); continue }
      for (const p of c.pix) {
        const x = p % s.w
        let k = wordCells.findIndex(wc => x >= wc.x0 && x < wc.x1)
        // A pixel in the gap between two cells goes to the NEARER one; sent
        // to the word's last cell, one pixel of an "I" stretched a colon to
        // 85 pixels and its move pushed it across half the page.
        if (k < 0) {
          let best = Infinity
          wordCells.forEach((wc, i) => {
            const d = x < wc.x0 ? wc.x0 - x : x - (wc.x1 - 1)
            if (d < best) { best = d; k = i }
          })
        }
        pixOf[k].push(p)
      }
    }
    // A cell's edge is clean when no core pixel of the word sits on the
    // column either side of it.
    const colInk = new Map<number, number>()
    for (const c of pieces) for (const p of c.pix) { const x = p % s.w; colInk.set(x, (colInk.get(x) ?? 0) + 1) }
    wordCells.forEach((wc, i) => {
      const pix = pixOf[i]
      let inkL = Infinity, inkR = -Infinity, top = Infinity, bottom = -Infinity
      for (const p of pix) {
        const x = p % s.w, y = (p - x) / s.w
        if (x < inkL) inkL = x
        if (x > inkR) inkR = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
      const leftClean = i === 0 || !colInk.get(wc.x0) || !colInk.get(wc.x0 - 1) || pixOf[i - 1].every(p => p % s.w < wc.x0 - 1)
      const rightClean = i === wordCells.length - 1 || !colInk.get(wc.x1 - 1) || !colInk.get(wc.x1) || pixOf[i + 1].every(p => p % s.w > wc.x1)
      cells[from + i] = {
        char: wc.char, x0: wc.x0, x1: wc.x1, suspect: wc.suspect, approx: !ok, word: wi,
        pix: Int32Array.from(pix), inkL: inkL === Infinity ? wc.x0 : inkL, inkR: inkR === -Infinity ? wc.x0 - 1 : inkR + 1,
        top: top === Infinity ? 0 : top, bottom: bottom === -Infinity ? 0 : bottom + 1,
        isolated: leftClean && rightClean
      }
    })
    words.push({ x0: iw.x0, x1: iw.x1, top: iw.top, bottom: iw.bottom, from, to, cut: ok, exact: cutExact || !!byRuns, weight: wordWeight(pi, pieces, iw, base, em), err })
  }
  for (const m of matches) {
    const iw = split.words[m.word]
    const pieces = ownPieces.filter(c => c.cx >= iw.x0 && c.cx < iw.x1)
    for (const c of pieces) assigned.add(c)
    // A word whose letters do not ALL stand apart — a code at 150 DPI,
    // "MSP-SIST-202309006" with its "20" and "900" touching — is one ink run
    // short of its letters, so it was never exact, and an edit of its first
    // three letters redrew all eighteen from letters the page did not hold:
    // four synthesised figures, "2023000б". Its ends that DO stand apart are
    // words of their own; the touching middle stays whole.
    const parts = peelWord(pieces, chars.slice(m.from, m.to), em)
    if (parts) {
      for (const part of parts) {
        const box = { x0: Math.min(...part.pieces.map(c => c.x0)), x1: Math.max(...part.pieces.map(c => c.x1)), top: Math.min(...part.pieces.map(c => c.y0)), bottom: Math.max(...part.pieces.map(c => c.y1)) }
        addWord(m.from + part.from, m.from + part.to, part.pieces, box, m.err)
      }
      continue
    }
    addWord(m.from, m.to, pieces, iw, m.err)
  }
  // A character no ink word took (the alignment skips nothing, but be safe).
  for (let i = 0; i < cells.length; i++) if (!cells[i]) return fail('a character has no ink')
  const loose = ownPieces.filter(c => !assigned.has(c)).map(c => ({ pix: Int32Array.from(c.pix), x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, area: c.area }))

  const letterGaps: number[] = []
  for (const w of words) {
    if (!w.cut) continue
    for (let i = w.from + 1; i < w.to; i++) {
      const a = cells[i - 1], b = cells[i]
      if (a.suspect || b.suspect || a.inkR <= a.inkL || b.inkR <= b.inkL) continue
      letterGaps.push(b.inkL - a.inkR)
    }
  }
  // Word gaps are the gaps the READING puts a space in. The ink's own split
  // can cut one word at a wide letter gap ("ESTE | FAN | I" in a capitals
  // cell), and counted as word gaps those set the next word glued on.
  const wordGaps: number[] = []
  for (let i = 1; i < words.length; i++) if (spaceAfter.has(words[i].from)) wordGaps.push(words[i].x0 - words[i - 1].x1)

  // The ink colour: the darkest pixels of the line's cores.
  const inkRgb: [number, number, number] = [0, 0, 0]
  {
    const ps = [...own].sort((a, b) => pi.dark[b] - pi.dark[a]).slice(0, Math.max(8, Math.floor(own.size * 0.3)))
    if (ps.length) {
      const rs = ps.map(p => s.data[p * 4]), gs = ps.map(p => s.data[p * 4 + 1]), bs = ps.map(p => s.data[p * 4 + 2])
      inkRgb[0] = median(rs); inkRgb[1] = median(gs); inkRgb[2] = median(bs)
      // Letters are printed as ink MULTIPLIED onto the paper, channel by
      // channel, and a product never comes out brighter than the paper. Ink
      // brighter than its ground in any channel cannot be printed that way:
      // yellow lettering on a purple cover (read inverted: blue on green)
      // came back pinkish white, its old letters left as ghosts.
      for (let c = 0; c < 3; c++) {
        const ground = median(ps.map(p => pi.paper[p * 3 + c]))
        if (inkRgb[c] > ground + 24) return fail('the lettering is a colour its ground cannot be printed with')
      }
    }
  }

  // The Voronoi partition of the ROI among the inks in it, out to ~1.4 pt.
  // Out to ~2.2 pt: as far as a letter's JPEG ringing reaches (the edge of
  // its 8×8 block at 200 DPI).
  const ownR = Math.max(3, Math.round(2.2 / Math.abs(s.toPage[0] || 1)))
  const owner = new Int16Array(W * H).fill(-1)
  const dist = new Uint8Array(W * H).fill(255)
  {
    let frontier: number[] = []
    const seed = (p: number, id: number) => {
      const x = p % s.w - roi.x0, y = Math.floor(p / s.w) - roi.y0
      if (x < 0 || y < 0 || x >= W || y >= H) return
      const j = y * W + x
      if (dist[j] === 0) return
      dist[j] = 0; owner[j] = id; frontier.push(j)
    }
    cells.forEach((c, k) => { for (const p of c.pix) seed(p, k) })
    // A dot or an accent a little paler than a core (a colon's top dot at
    // darkness 106 against a core of 110) is no ink of its own, and an edit
    // that moved its letter left it behind: half a dot where the colon had
    // been. A small faint piece touching no core, over a letter's columns and
    // within half an em of it, is that letter's.
    {
      const faint = new Uint8Array(W * H)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const j = y * W + x
        if (!core[j] && pi.dark[(roi.y0 + y) * s.w + roi.x0 + x] >= FAINT) faint[j] = 1
      }
      for (const c of components(faint, W, H, roi.x0, roi.y0, s.w)) {
        if (c.area > em * em * 0.12) continue
        let touches = false
        for (const p of c.pix) {
          const x = p % s.w - roi.x0, y = Math.floor(p / s.w) - roi.y0
          for (let dy = -1; dy <= 1 && !touches; dy++) for (let dx = -1; dx <= 1 && !touches; dx++) {
            const nx = x + dx, ny = y + dy
            if (nx >= 0 && ny >= 0 && nx < W && ny < H && core[ny * W + nx]) touches = true
          }
          if (touches) break
        }
        if (touches) continue
        const k = cells.findIndex(cell => cell.inkR > cell.inkL && c.cx >= cell.inkL - 1 && c.cx <= cell.inkR + 1 &&
          Math.max(cell.top - c.y1, c.y0 - cell.bottom) <= em * 0.5)
        if (k >= 0) for (const p of c.pix) seed(p, k)
      }
    }
    loose.forEach((c, k) => { for (const p of c.pix) seed(p, cells.length + k) })
    for (const p of protect) seed(p, -2)
    // Other ink in the ROI that no one claimed (a speck outside the band).
    for (let j = 0; j < W * H; j++) if (core[j] && dist[j] !== 0) { dist[j] = 0; owner[j] = -2; frontier.push(j) }
    for (let r = 1; r <= ownR && frontier.length; r++) {
      const next: number[] = []
      for (const j of frontier) {
        const x = j % W, y = (j - x) / W
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const n = ny * W + nx
          if (dist[n] <= r) continue
          dist[n] = r; owner[n] = owner[j]; next.push(n)
        }
      }
      frontier = next
    }
  }

  // On a GRADIENT (a ground the plain-paper test let through for being
  // smooth) only a line cut cleanly is taken: every word one ink run per
  // letter. A cover title printed in two inks — black "APOCALÍP", grey "SEX"
  // — reaches the core level only in places in its grey half, its reading is
  // shared out over the wrong ink, and deleting "SEX" erased the "P". No
  // test of the letters' darkness told its cells from a misread's; the
  // approximate cut is what both have, and on plain paper the old rules stand.
  if (smoothGround && words.some(w => !(w.cut && w.exact))) return fail('the line is set on a gradient and could not be cut cleanly')

  return {
    id: item.id, text, inkRect: { ...item.inkRect }, chars, spaceAfter, confidence: item.confidence ?? 100, roi, fit, words, cells, rules, borders, protect, own,
    letterGapPx: letterGaps.length >= 3 ? median(letterGaps) : em * 0.08,
    wordGapPx: wordGaps.length ? median(wordGaps) : 0,
    ink: inkRgb,
    coreDark: (() => {
      const v: number[] = []
      for (const p of own) if (pi.dark[p] >= CORE) v.push(pi.dark[p])
      if (v.length < 8) for (const p of own) if (pi.dark[p] >= coreLevel && pi.dark[p] < CORE) v.push(pi.dark[p])
      return v.length ? median(v) / 255 : 0.8
    })(),
    coreLevel,
    ...(opts.inverted ? { inverted: true } : {}),
    owner, ownDist: dist, ownR, loose
  }
}

/** How many runs of inked columns a word's pieces make: stacked pieces (an i and its dot, a letter and its accent) are one run. */
/**
 * A word's letters from its ink alone, where its pieces fall into exactly one
 * run per character (pieces that overlap across are one letter: an "i" and
 * its dot), each about as wide as its letter can be — a count that matches by
 * accident (two letters that touch, another broken in two) does not. Null
 * otherwise, and for ideographs, whose radicals are runs of their own.
 */
function runCellsOf(pieces: Comp[], chars: string[], em: number): { char: string; x0: number; x1: number; suspect: boolean }[] | null {
  if (!pieces.length || chars.some(c => /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(c))) return null
  const spans: { x0: number; x1: number }[] = []
  for (const c of [...pieces].sort((a, b) => a.x0 - b.x0)) {
    const last = spans[spans.length - 1]
    if (last && c.x0 < last.x1) last.x1 = Math.max(last.x1, c.x1)
    else spans.push({ x0: c.x0, x1: c.x1 })
  }
  if (spans.length !== chars.length) return null
  for (let i = 0; i < chars.length; i++) {
    const adv = expectedAdvance(chars[i])
    const w = (spans[i].x1 - spans[i].x0) / em
    if (w > adv * 1.6 + 0.12 || (adv >= 0.45 && w < adv * 0.3)) return null
  }
  return spans.map((sp, i) => ({ char: chars[i], x0: sp.x0, x1: sp.x1, suspect: false }))
}

/**
 * A word whose ink falls into fewer runs than it has characters (letters that
 * touch), split where its letters DO stand apart at its ends: the leading
 * runs that each hold one letter — about that letter's width, short of a
 * pair's — and the trailing ones likewise, from the other end. Labels are
 * counted from each end, so a letter the reading dropped in the middle shifts
 * neither. Null when nothing at either end stands apart, or the word's runs
 * already match its letters.
 */
function peelWord(pieces: Comp[], chars: string[], em: number): { from: number; to: number; pieces: Comp[] }[] | null {
  if (chars.length < 2 || chars.some(c => /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(c))) return null
  const spans: { x0: number; x1: number; pieces: Comp[] }[] = []
  for (const c of [...pieces].sort((a, b) => a.x0 - b.x0)) {
    const last = spans[spans.length - 1]
    if (last && c.x0 < last.x1) { last.x1 = Math.max(last.x1, c.x1); last.pieces.push(c) }
    else spans.push({ x0: c.x0, x1: c.x1, pieces: [c] })
  }
  if (spans.length < 2 || spans.length >= chars.length) return null
  const single = (k: number, ch: string, other: string) => {
    const w = (spans[k].x1 - spans[k].x0) / em
    const adv = expectedAdvance(ch)
    return w <= adv * 1.45 + 0.1 && (adv < 0.45 || w >= adv * 0.3) && w < (adv + expectedAdvance(other)) * 0.8
  }
  let p = 0
  while (p < spans.length - 1 && p < chars.length - 1 && single(p, chars[p], chars[p + 1])) p++
  let q = 0
  while (q < spans.length - 1 - p && q < chars.length - 1 - p && single(spans.length - 1 - q, chars[chars.length - 1 - q], chars[chars.length - 2 - q])) q++
  if (!p && !q) return null
  const n = chars.length, m = spans.length
  const take = (a: number, b: number) => spans.slice(a, b).flatMap(sp => sp.pieces)
  const parts: { from: number; to: number; pieces: Comp[] }[] = []
  if (p) parts.push({ from: 0, to: p, pieces: take(0, p) })
  parts.push({ from: p, to: n - q, pieces: take(p, m - q) })
  if (q) parts.push({ from: n - q, to: n, pieces: take(m - q, m) })
  return parts
}

/**
 * The columns at a piece's left or right edge that a vertical rule stands in —
 * each inked from row `top` to row `bottom` with no gap over a row — at most
 * `maxW` of them, and not the whole piece: the rule's pixels, the rest, and
 * where the rule stands. Null when neither edge holds one.
 */
function carveBorder(c: Comp, pageW: number, top: number, bottom: number, maxW: number, ends?: { base: number; onRule: (x: number, y: number) => boolean }): { rule: number[]; rest: number[]; x: number } | null {
  if (c.y0 > top || c.y1 - 1 < (ends ? ends.base : bottom)) return null
  const cols = new Map<number, number[]>()
  for (const p of c.pix) {
    const x = p % pageW
    let l = cols.get(x)
    if (!l) { l = []; cols.set(x, l) }
    l.push(p)
  }
  const full = (x: number) => {
    const l = cols.get(x)
    if (!l) return false
    const rows = new Set(l.map(p => (p - p % pageW) / pageW))
    let gap = 0, last = top - 1
    for (let y = top; y <= bottom; y++) {
      if (rows.has(y)) { gap = 0; last = y }
      else if (++gap > 1) break
    }
    if (last >= bottom) return true
    // A border that meets the rule under its row ends where the rule begins —
    // with the text set on that rule, at the baseline itself.
    return !!ends && last >= ends.base && ends.onRule(x, last)
  }
  for (const dir of [1, -1]) {
    const start = dir > 0 ? c.x0 : c.x1 - 1
    let n = 0
    while (n <= maxW && full(start + dir * n)) n++
    if (!n || n > maxW || n >= c.x1 - c.x0 - 1) continue
    const ruleCols = new Set<number>()
    for (let k = 0; k < n; k++) ruleCols.add(start + dir * k)
    const rule: number[] = [], rest: number[] = []
    for (const p of c.pix) (ruleCols.has(p % pageW) ? rule : rest).push(p)
    return { rule, rest, x: start + dir * (n - 1) / 2 }
  }
  return null
}

/** Whether a piece's rows line up on one straight line (a rule's do; a curve's bow): each row's centre within `tol` px of the fit. */
function isStraightUpright(c: Comp, pageW: number, tol: number): boolean {
  const rows = new Map<number, { sum: number; n: number }>()
  for (const p of c.pix) {
    const x = p % pageW, y = (p - x) / pageW
    const e = rows.get(y) ?? { sum: 0, n: 0 }
    e.sum += x; e.n++
    rows.set(y, e)
  }
  const ys: number[] = [], xs: number[] = []
  for (const [y, e] of rows) { ys.push(y); xs.push(e.sum / e.n) }
  if (ys.length < 4) return false
  const my = ys.reduce((a, b) => a + b, 0) / ys.length, mx = xs.reduce((a, b) => a + b, 0) / xs.length
  let sxy = 0, syy = 0
  for (let i = 0; i < ys.length; i++) { sxy += (ys[i] - my) * (xs[i] - mx); syy += (ys[i] - my) ** 2 }
  const slope = syy > 0 ? sxy / syy : 0
  return xs.every((x, i) => Math.abs(x - (mx + slope * (ys[i] - my))) <= tol)
}

function columnRuns(pieces: Comp[]): number {
  const spans = pieces.map(c => [c.x0, c.x1] as [number, number]).sort((a, b) => a[0] - b[0])
  let runs = 0, end = -Infinity
  for (const [x0, x1] of spans) {
    if (x0 >= end) runs++
    end = Math.max(end, x1)
  }
  return runs
}

function compOf(pix: number[], pageW: number): Comp {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, sx = 0, sy = 0
  for (const p of pix) {
    const x = p % pageW, y = (p - x) / pageW
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
    sx += x; sy += y
  }
  return { pix, x0, x1: x1 + 1, y0, y1: y1 + 1, area: pix.length, cx: sx / pix.length + 0.5, cy: sy / pix.length + 0.5 }
}

/**
 * A word's stem thickness over the em: in each row of the x-height band, the
 * darkness summed across every stroke the row crosses (a stem w pixels wide
 * sums to about w however blurred — blur moves ink, it does not add any), the
 * median over the strokes. Bold and regular separate cleanly on it where a
 * binary width does not: at 200 DPI a regular stem is two pixels and a bold
 * one three or four, and the thresholded width of either wobbles by one.
 */
function wordWeight(pi: PageInk, pieces: Comp[], iw: { x0: number; x1: number }, base: (x: number) => number, em: number): number | null {
  if (!pieces.length) return null
  const s = pi.s
  const coreAt = new Set<number>()
  for (const c of pieces) for (const p of c.pix) coreAt.add(p)
  const runs: number[] = []
  const yTop = Math.round(Math.min(base(iw.x0), base(iw.x1)) - em * 0.4)
  const yBot = Math.round(Math.max(base(iw.x0), base(iw.x1)) - em * 0.12)
  // A crossing far wider than any stem is a horizontal stroke — the bar of an
  // "E", the foot of an "L", the arm of a "T" — run along, not across: it
  // measures its LENGTH. Counted, it read every all-capitals word as bold.
  const maxRun = Math.max(4, em * 0.24)
  for (let y = yTop; y <= yBot; y++) {
    if (y < 0 || y >= s.h) continue
    let sum = 0, len = 0, hasCore = false, inRun = false
    const close = () => { if (hasCore && sum > 0.5 && len <= maxRun) runs.push(sum); inRun = false; sum = 0; len = 0; hasCore = false }
    for (let x = Math.max(0, iw.x0 - 1); x <= Math.min(s.w - 1, iw.x1); x++) {
      const p = y * s.w + x
      const dk = pi.dark[p]
      if (dk >= FRINGE * 1.5) {
        inRun = true
        sum += dk / 255
        len++
        if (coreAt.has(p)) hasCore = true
      } else if (inRun) close()
    }
    if (inRun) close()
  }
  // A two-letter word crosses a dozen strokes over the band; fewer than four
  // is a lone mark whose "stem" says nothing about the face.
  if (runs.length < 4) return null
  return median(runs) / em
}
