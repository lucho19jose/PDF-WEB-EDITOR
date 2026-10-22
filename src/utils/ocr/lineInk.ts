import { pxRectOf, readerCtx, lumAt, type ScanRaster } from './scanRaster'
import { pushPull } from './inpaint'
import { fitLine, fitBend, baselineAtOf, splitWords, alignCharsToWords, spaceBoundaries, type Blob, type LineFit } from './wordSeg'
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
  /** Faint straight lines taken as paper (a notebook's grid), 1 where one runs; the plain-paper tests look past them. */
  lines?: Uint8Array
  /** A paper's regular fine texture (a security hatch), RGB residual over its smoothed level, 3 a pixel — only where the page has one (`paperTexture`). */
  texture?: Int8Array
  /** The channels inverted to make this page (`domainPage`: bit 0 red, 1 green, 2 blue), with the page it was made from. */
  domain?: number
  base?: PageInk
}

/** Ideographs (and full-width forms): composed of radicals, so stacked pieces are their nature, not a sign of a broken letter. */
const CJK_CHAR = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/
/** Darkness a pixel needs to be a letter's CORE (0..255): the stroke, not its anti-aliased fringe. */
export const CORE = 110
/** Darkness of the fringe that still belongs to a letter: what an erase must clear around its core. */
export const FRINGE = 26
/** Darkness of a pale piece of a letter that is not core — a faint dot or accent (see the owner map). */
const FAINT = 60
/** The darkness a flat ground's off-colour pixels are given (`flattenGround`): a letter's haze, under FAINT and CORE. */
const HAZE = 40

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

/** The darkest closed level a GROUND may have: anything darker is a stroke or a band of colour. */
const GROUND_MIN = 150

/**
 * The paper under a restored ground's letters, from that ground's OWN known
 * pixels. The page's fill reaches past a ground's edge into whatever surrounds
 * it, and on a button barely taller than its words the surround is most of
 * what it finds. A ground is the region a closed level runs through without a
 * step (neighbours within 2 levels), seeded where the closing restored it; it
 * must be flat (closed levels within 6) and mostly bare (half its pixels on
 * the ground level), which a photograph is not. One with too few known pixels
 * takes the median of its bare pixels, letters' margins included.
 */
function fillGrounds(ch: Float32Array[], known: Float32Array, d: Uint8ClampedArray, L: Uint8Array, C: Uint8Array, ground: Uint8Array, w: number, h: number): void {
  const N = w * h
  const seg = new Int32Array(N).fill(-1)
  const stack = new Int32Array(N)
  let id = 0
  for (let s0 = 0; s0 < N; s0++) {
    if (!ground[s0] || seg[s0] >= 0) continue
    let top = 0
    stack[top++] = s0
    seg[s0] = id
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0, bare = 0, lo = 255, hi = 0, nKnown = 0
    while (top) {
      const p = stack[--top]
      const x = p % w, y = (p - x) / w
      area++
      if (Math.abs(L[p] - C[p]) <= 6) bare++
      if (known[p] >= 1) nKnown++
      if (C[p] < lo) lo = C[p]
      if (C[p] > hi) hi = C[p]
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      const cp = C[p]
      if (x > 0) { const q = p - 1; if (seg[q] < 0 && C[q] >= GROUND_MIN && Math.abs(C[q] - cp) <= 2) { seg[q] = id; stack[top++] = q } }
      if (x < w - 1) { const q = p + 1; if (seg[q] < 0 && C[q] >= GROUND_MIN && Math.abs(C[q] - cp) <= 2) { seg[q] = id; stack[top++] = q } }
      if (y > 0) { const q = p - w; if (seg[q] < 0 && C[q] >= GROUND_MIN && Math.abs(C[q] - cp) <= 2) { seg[q] = id; stack[top++] = q } }
      if (y < h - 1) { const q = p + w; if (seg[q] < 0 && C[q] >= GROUND_MIN && Math.abs(C[q] - cp) <= 2) { seg[q] = id; stack[top++] = q } }
    }
    const me = id++
    // The page's own paper, or a gradient that drifted across it: the page's fill is right there.
    if (area > N * 0.25 || hi - lo > 6 || bare < area * 0.5 || nKnown === area) continue
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1
    if (nKnown >= Math.max(12, area * 0.02)) {
      const sub = [new Float32Array(bw * bh), new Float32Array(bw * bh), new Float32Array(bw * bh)]
      const sk = new Float32Array(bw * bh)
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const p = y * w + x, q = (y - y0) * bw + (x - x0)
        if (seg[p] === me && known[p] >= 1) { sk[q] = 1; for (let c = 0; c < 3; c++) sub[c][q] = ch[c][p] }
      }
      pushPull(sub, sk, bw, bh)
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const p = y * w + x
        if (seg[p] !== me || known[p] >= 1) continue
        const q = (y - y0) * bw + (x - x0)
        for (let c = 0; c < 3; c++) ch[c][p] = sub[c][q]
      }
    } else {
      // No known pixel to speak of: the median colour of the ground's bare pixels.
      const vals: number[][] = [[], [], []]
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const p = y * w + x
        if (seg[p] === me && Math.abs(L[p] - C[p]) <= 3) for (let c = 0; c < 3; c++) vals[c].push(d[p * 4 + c])
      }
      if (vals[0].length < 12) continue
      const med = vals.map(v => { v.sort((a, b) => a - b); return v[v.length >> 1] })
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const p = y * w + x
        if (seg[p] === me && known[p] < 1) for (let c = 0; c < 3; c++) ch[c][p] = med[c]
      }
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
 * A squared-paper GRID darker than the faint-line test allows: thin straight
 * runs lighter than the pen (above its cores by 30 levels, never within a pixel
 * of one), found by `scan`, and accepted only when the runs of BOTH directions
 * repeat at one pitch — the autocorrelation of the row and of the column
 * profiles peaking at the same lag, within 12%. A form's table has rows at one
 * pitch and columns at none, and its rules are as dark as its text. Null when
 * the page is no such grid.
 */
let latticeDebug = ''
/** What the last page's grid test found (lab only). */
export function lastLatticeTest(): string { return latticeDebug }
function latticeLines(L: Uint8Array, inkish: Uint8Array, w: number, h: number, pxPerPt: number,
  scan: (m: Uint8Array, rows: boolean, on: (p: number) => boolean, thin: number, into: { p: number; a: number; b: number; t: number }[]) => void): { mask: Uint8Array; bridges: { p: number; a: number; b: number; t: number }[] } | null {
  const N = w * h
  // The pen: the darker tail of what reads as ink. (An Otsu split of the ink
  // into pen and grid was tried: on real notes it fell between the pen-and-
  // grid and their fringes, above the grid, and took a book cover's texture
  // for squares.)
  const v: number[] = []
  for (let p = 0; p < N; p += 5) if (inkish[p]) v.push(L[p])
  if (v.length < 200) return null
  v.sort((a, b) => a - b)
  const pen = v[Math.floor(v.length * 0.1)]
  const lo = Math.max(55, pen + 30)
  const nearPen = new Uint8Array(N)
  for (let p = 0; p < N; p++) if (L[p] < lo) nearPen[p] = 1
  maxFilter1D(nearPen, w, h, 1, true)
  maxFilter1D(nearPen, w, h, 1, false)
  const on = (p: number) => !!inkish[p] && !nearPen[p]
  const thin = Math.max(2, Math.round(0.8 * pxPerPt))
  const H = new Uint8Array(N), V = new Uint8Array(N)
  const bh: { p: number; a: number; b: number; t: number }[] = [], bv: { p: number; a: number; b: number; t: number }[] = []
  scan(H, true, on, thin, bh)
  scan(V, false, on, thin, bv)
  // The pitch of each direction: the autocorrelation of its profile.
  const pitch = (m: Uint8Array, rows: boolean): { lag: number; r: number } | null => {
    const n = rows ? h : w
    const prof = new Float64Array(n)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) prof[rows ? y : x]++
    // Smoothed a little: a photographed grid wanders by a pixel or two.
    const sm = new Float64Array(n)
    for (let i = 0; i < n; i++) { let t = 0; for (let k = -2; k <= 2; k++) t += prof[Math.min(n - 1, Math.max(0, i + k))]; sm[i] = t }
    let e = 0
    for (let i = 0; i < n; i++) e += sm[i] * sm[i]
    if (!e) return null
    // A notebook's squares are 4 to 10 mm. A halftone screen is a lattice too
    // — of dots a point or two apart — and its runs, bridged from dot to dot,
    // made the stippled header of a results table and the halftone letters of
    // its title read as a grid.
    const lo = Math.round(8 * pxPerPt), hi = Math.min(Math.round(n / 4), Math.round(30 * pxPerPt))
    if (hi <= lo + 2) return null
    const ac = (lag: number) => { let t = 0; for (let i = 0; i + lag < n; i++) t += sm[i] * sm[i + lag]; return t / e }
    let best: { lag: number; r: number } | null = null
    let prev = ac(lo - 1), cur = ac(lo)
    for (let lag = lo; lag < hi; lag++) {
      const next = ac(lag + 1)
      if (cur >= prev && cur >= next && (!best || cur > best.r)) best = { lag, r: cur }
      prev = cur; cur = next
    }
    // And as many lines as a page of squares has: the profile's peaks at that pitch.
    if (!best) return null
    // And the lines of a page of squares: five at least, spread over a fifth
    // of it or more (a curled notebook page shows its rules over part of it).
    let lines = 0, first = -1, last = -1
    const top = Math.max(...sm)
    for (let i = 1; i < n - 1; i++) if (sm[i] >= top * 0.25 && sm[i] >= sm[i - 1] && sm[i] > sm[i + 1]) { lines++; if (first < 0) first = i; last = i }
    latticeDebug += ` ${rows ? 'rows' : 'cols'}: lag ${best.lag} r ${best.r.toFixed(2)} lines ${lines} spread ${((last - first) / n).toFixed(2)}`
    return lines >= 5 && last - first >= n * 0.2 ? best : null
  }
  latticeDebug = `pen ${pen} lo ${lo}`
  const ph = pitch(H, true), pv = pitch(V, false)
  if (!ph || !pv || ph.r < 0.3 || pv.r < 0.3) return null
  if (Math.abs(ph.lag - pv.lag) > Math.max(ph.lag, pv.lag) * 0.12) return null
  latticeDebug += ' GRID'
  const mask = new Uint8Array(N)
  for (let p = 0; p < N; p++) if (H[p] || V[p]) mask[p] = 1
  return { mask, bridges: [...bh, ...bv] }
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
  // A flat light GROUND smaller than the page — a dashboard's button, a
  // shaded table cell — is darker than the paper around it, and within R of
  // its edge the filter saw that paper: a band all round its inside read as
  // ink. On a button barely taller than its words the band and the margin
  // around the letters left none of the button known, its paper came from the
  // panel outside, and every letter an edit moved carried a box of the
  // button's colour over the panel's (ocr3/021: "Last 3 days" → "Last days").
  // A closing (the max filter, then a min filter as wide) brings back any
  // ground wider than the filter; where it is light, flat and the pixel itself
  // is that ground, the pixel is paper. A thick black stem is closed too, and
  // stays ink: its closed level is dark.
  const C = new Uint8Array(N)
  for (let p = 0; p < N; p++) C[p] = 255 - B[p]
  maxFilter1D(C, s.w, s.h, R, true)
  maxFilter1D(C, s.w, s.h, R, false)
  for (let p = 0; p < N; p++) C[p] = 255 - C[p]
  const ground = new Uint8Array(N)
  let grounds = 0
  for (let p = 0; p < N; p++) {
    if (B[p] - C[p] > 12 && C[p] >= GROUND_MIN && Math.abs(L[p] - C[p]) <= 6) { ground[p] = 1; B[p] = C[p]; grounds++ }
  }
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
  const line = new Uint8Array(N)
  const gridPix = new Uint8Array(N)
  const bridges: { p: number; a: number; b: number; t: number }[] = []
  // A notebook's GRID is paper: faint, thin, straight lines running on long
  // past any letter. Read as ink, it was filled in under the letters and the
  // line's regions took its pieces with them — an edit on squared paper moved
  // grid segments along with the moved words and left white gaps in the grid
  // where they had stood. Taken as paper, a moved letter's grid pixels are
  // transmittance one (they stay put) and an erased one is refilled with the
  // grid. Faint: well short of a letter's core and not hugging one (the haze
  // along an underline or a dark rule stays ink, or trimming it would leave a
  // ghost). Thin: a line, not a band — a light grey title's stems are
  // thicker. Long: 8pt and more unbroken, which no letter's stroke is.
  // Not on the inverted page: a cover's art reversed holds long faint
  // strokes of its own, and taken as paper they made a reversed author line
  // read as set on rough ground.
  if (opts.strokes !== false) {
    // Judged on the pixel's own lightness: inside a stroke wider than the
    // filter the local maximum is the stroke itself, and against it a bold
    // title's stem edges read "faint".
    const nearDark = new Uint8Array(N)
    for (let p = 0; p < N; p++) if (L[p] < 120) nearDark[p] = 1
    maxFilter1D(nearDark, s.w, s.h, 2, true)
    maxFilter1D(nearDark, s.w, s.h, 2, false)
    const faint = (p: number) => !!inkish[p] && !nearDark[p]
    const minRun = Math.max(12, Math.round(8 * pxPerPt))
    const scan = (rows: boolean, m: Uint8Array, on: (p: number) => boolean, thin: number, gapTol: number, into: typeof bridges, minLen = minRun) => {
      const outer = rows ? s.h : s.w, inner = rows ? s.w : s.h
      const at = (o: number, i: number) => rows ? o * s.w + i : i * s.w + o
      for (let o = thin; o < outer - thin; o++) {
        let start = -1, lastOn = -1
        for (let i = 0; i <= inner; i++) {
          const here = i < inner && on(at(o, i))
          if (here && start < 0) start = i
          if (here) lastOn = i
          // A break of a few pixels — grain darker or lighter than the line —
          // does not end it.
          if (!here && start >= 0 && i < inner && i - lastOn <= gapTol) continue
          if (!here && start >= 0) {
            const end = lastOn + 1
            if (end - start >= minLen) {
              // Thin: the pixels `thin` either side across it are mostly not the line too.
              let thick = 0
              for (let k = start; k < end; k++) if (on(at(o - thin, k)) && on(at(o + thin, k))) thick++
              if (thick < (end - start) * 0.3) for (let k = start; k < end; k++) m[at(o, k)] = 1
            }
            start = -1
          }
        }
        // Where a letter crosses the line it is still the line: a gap of up
        // to 40pt between two of its stretches is bridged, its paper the
        // line's own colour from one end to the other.
        let last = -1
        for (let i = 0; i < inner; i++) {
          if (!m[at(o, i)]) continue
          if (last >= 0 && i - last > 1 && i - last - 1 <= maxGap) {
            const a = at(o, last), b = at(o, i)
            for (let k = last + 1; k < i; k++) { m[at(o, k)] = 1; into.push({ p: at(o, k), a, b, t: (k - last) / (i - last) }) }
          }
          last = i
        }
      }
    }
    const maxGap = Math.round(40 * pxPerPt)
    const lineH = new Uint8Array(N), lineV = new Uint8Array(N)
    scan(true, lineH, faint, 2, 0, bridges)
    scan(false, lineV, faint, 2, 0, bridges)
    for (let p = 0; p < N; p++) if (lineH[p] || lineV[p]) line[p] = 1
    // A DARK grid: a phone photo of squared paper prints its rules at
    // luminance 80–130, four pixels wide at 280 DPI — darker than the faint
    // bar above, and read as ink a handwritten line welded into one piece with
    // its squares: no word gap, no letter, and every edit of a student's notes
    // fell back to Helvetica over the grid. Such a grid is told by what no
    // form's table has: thin straight lines CLEARLY LIGHTER than the pen, at
    // ONE pitch across the page in both directions. Its lines are taken as
    // paper only when both directions keep the same pitch.
    const g = latticeLines(L, inkish, s.w, s.h, pxPerPt, (m, rows, on, thin, into) => scan(rows, m, on, thin, 3, into, Math.round(12 * pxPerPt)))
    if (g) {
      for (let p = 0; p < N; p++) if (g.mask[p]) { line[p] = 1; gridPix[p] = 1 }
      for (const b of g.bridges) bridges.push(b)
    }
    const bridged = new Uint8Array(N)
    for (const b of bridges) bridged[b.p] = 1
    for (let p = 0; p < N; p++) if (line[p] && !bridged[p]) inkish[p] = 0
  }
  // The paper is sampled BEYOND the haze around the letters: a scan's strokes
  // are ringed by blur and JPEG ringing a few levels darker than the paper out
  // to ~4 px at 200 DPI (measured: 248–252 at 2–4 px from the ink, 254 beyond
  // 6), and a letter erased with paper sampled in that ring left a soft grey
  // blob where it had been.
  const grow = Math.max(2, Math.round(1.8 * pxPerPt))
  maxFilter1D(inkish, s.w, s.h, grow, true)
  maxFilter1D(inkish, s.w, s.h, grow, false)
  // A grid line next to a letter is still the grid: its paper is its own
  // colour, unless it is the letter's own core. But it is no source for the
  // paper AROUND it: filled from the line's tint as well as the white, the
  // paper under a letter beside a grid line came out a grey smudge. The fill
  // sees the line and its blurred fringe as unknown; the line's own pixels
  // take back their colour afterwards.
  let anyLine = false
  for (let p = 0; p < N; p++) if (line[p]) { anyLine = true; break }
  const band = anyLine ? line.slice() : line
  if (anyLine) { maxFilter1D(band, s.w, s.h, 2, true); maxFilter1D(band, s.w, s.h, 2, false) }
  const known = new Float32Array(N)
  for (let p = 0; p < N; p++) known[p] = !inkish[p] && !band[p] ? 1 : 0
  const ch = [new Float32Array(N), new Float32Array(N), new Float32Array(N)]
  for (let p = 0, i = 0; p < N; p++, i += 4) { ch[0][p] = d[i]; ch[1][p] = d[i + 1]; ch[2][p] = d[i + 2] }
  pushPull(ch, known, s.w, s.h)
  const texture = opts.strokes !== false ? paperTexture(ch, known, s.w, s.h) : null
  // Most pages are plain paper and hold no ground: skip the region pass.
  if (grounds) fillGrounds(ch, known, d, L, C, ground, s.w, s.h)
  if (anyLine) for (let p = 0, i = 0; p < N; p++, i += 4) {
    if (band[p] && (!inkish[p] || (line[p] && (B[p] - L[p] < 110 || gridPix[p])))) { ch[0][p] = d[i]; ch[1][p] = d[i + 1]; ch[2][p] = d[i + 2] }
  }
  // A bridge across ink is the line it continues, its colour from one end to the other.
  for (const b of bridges) for (let c = 0; c < 3; c++) ch[c][b.p] = d[b.a * 4 + c] * (1 - b.t) + d[b.b * 4 + c] * b.t
  const paper = new Uint8ClampedArray(N * 3)
  const dark = new Uint8Array(N)
  for (let p = 0; p < N; p++) {
    const r = ch[0][p], g = ch[1][p], b = ch[2][p]
    paper[p * 3] = r; paper[p * 3 + 1] = g; paper[p * 3 + 2] = b
    const lp = (r * 299 + g * 587 + b * 114) / 1000
    const t = lp > 1 ? L[p] / lp : 1
    dark[p] = t >= 1 ? 0 : Math.round((1 - t) * 255)
  }
  // What the plain-paper tests look past is the line AND its fringe: a
  // scanned grid line is blurred, its pale edges are paper of the grid's tint,
  // and counted as the page's paper they read every squared page as rough.
  const out: PageInk = { s, paper, dark }
  if (anyLine) out.lines = band
  if (texture) out.texture = texture
  return out
}

const domainPages = new WeakMap<PageInk, Map<number, PageInk>>()

/**
 * The page with the channels in `mask` inverted (bit 0 red, 1 green, 2 blue),
 * prepared like the page itself. Letters are printed as ink MULTIPLIED onto
 * the paper, which can only darken it; lettering lighter than its ground in a
 * channel is darker than it there once that channel is inverted. White on a
 * band of colour is lighter in all three (mask 7, the inverted page); peach
 * lettering on a purple cover only in red and green (mask 3) — read wholly
 * inverted its blue was still lighter than the ground's, and the edit came
 * back pinkish with the old letters left as ghosts. Made on first need and
 * kept with the page.
 */
export function domainPage(pi: PageInk, mask: number): PageInk {
  const base = pi.base ?? pi
  if (!mask) return base
  let m = domainPages.get(base)
  if (!m) { m = new Map(); domainPages.set(base, m) }
  let pg = m.get(mask)
  if (!pg) {
    const d = base.s.data
    const data = new Uint8ClampedArray(d.length)
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) data[i + c] = (mask >> c) & 1 ? 255 - d[i + c] : d[i + c]
      data[i + 3] = d[i + 3]
    }
    pg = preparePage({ ...base.s, data }, { strokes: false })
    pg.domain = mask
    pg.base = base
    m.set(mask, pg)
  }
  return pg
}

/** The page with every pixel's colour inverted: reversed-out lettering is dark ink on light paper there. */
export function invertedPage(pi: PageInk): PageInk {
  return domainPage(pi, 7)
}

/** The channels inverted for a line's analysis (`LineInk.domain`). */
export function domainOfLine(li: LineInk): number {
  return li.domain ?? (li.inverted ? 7 : 0)
}

/** The prepared page a line was read on: the page, or the one with its lighter channels inverted. */
export function pageOfLine(pi: PageInk, li: LineInk): PageInk {
  return domainPage(pi, domainOfLine(li))
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
  /**
   * The colour (RGB 0..255) of ink of ANOTHER colour in the line's box — a
   * signature or a stamp crossing it. An edit then shares every pixel's
   * darkness between the two inks and erases and moves the line's own only.
   */
  overInk?: [number, number, number]
  /** The darkness (0..255) this line's letters were GROUPED at: `CORE`, or lower for a line whose thin strokes break apart there (its pixels are core pixels either way). */
  coreLevel: number
  /**
   * Light letters on a dark ground, read on the INVERTED scan: every pixel
   * index, paper and darkness of this analysis is `invertedPage(pi)`'s, and an
   * edit of the line is made there and inverted back.
   */
  inverted?: boolean
  /** Which channels its analysis inverted (`domainPage`): 7 for light on dark, fewer for coloured lettering. */
  domain?: number
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

/**
 * The 20–80% widths of the stroke edges along the rows of a box: for every
 * run of darkness a row crosses, its rise and its fall, each measured between
 * the points where it reaches a fifth and four fifths of the run's OWN peak —
 * so a grey line and a black one are measured alike. A run must peak at
 * `minPeak` and be 2 px wide at half its peak (a stem, not a hairline); an
 * edge wider than `maxW` is a gradient, not an edge.
 */
export function strokeEdgeWidths(get: (x: number, y: number) => number, x0: number, x1: number, y0: number, y1: number, minPeak: number, maxW: number): number[] {
  const out: number[] = []
  const n = x1 - x0
  if (n < 3) return out
  const v = new Float32Array(n)
  const crossUp = (from: number, to: number, level: number) => {
    let k = from
    while (k < to && v[k] < level) k++
    const vp = k > 0 ? v[k - 1] : 0
    return k - 1 + (v[k] - vp > 1e-6 ? (level - vp) / (v[k] - vp) : 1)
  }
  const crossDown = (from: number, to: number, level: number) => {
    let k = from
    while (k > to && v[k] < level) k--
    const vn = k < n - 1 ? v[k + 1] : 0
    return k + 1 - (v[k] - vn > 1e-6 ? (level - vn) / (v[k] - vn) : 1)
  }
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) v[x - x0] = get(x, y)
    let i = 1
    while (i < n - 1) {
      if (v[i] < 0.06) { i++; continue }
      let j = i, peak = 0, pk = i
      while (j < n && v[j] >= 0.06) { if (v[j] > peak) { peak = v[j]; pk = j } j++ }
      if (peak >= minPeak && j < n) {
        let a = i, b = j - 1
        while (a < pk && v[a] < peak / 2) a++
        while (b > pk && v[b] < peak / 2) b--
        if (b - a + 1 >= 2) {
          const up = crossUp(i, pk, peak * 0.8) - crossUp(i, pk, peak * 0.2)
          const down = crossDown(j - 1, pk, peak * 0.2) - crossDown(j - 1, pk, peak * 0.8)
          if (up > 0 && up <= maxW) out.push(up)
          if (down > 0 && down <= maxW) out.push(down)
        }
      }
      i = j + 1
    }
  }
  return out
}

/**
 * How soft the line prints: the median 20–80% width of its letters' stroke
 * edges, px. Null when its letters give too few edges to say.
 */
export function edgeWidthOf(pi: PageInk, li: LineInk): number | null {
  const s = pi.s
  const ws: number[] = []
  const minPeak = Math.max(0.25, li.coreDark * 0.7)
  for (const c of li.cells) {
    if (!c || c.suspect || c.approx || !/[\p{L}\p{N}]/u.test(c.char)) continue
    let y0 = Infinity, y1 = -Infinity
    for (const p of c.pix) { const y = (p - (p % s.w)) / s.w; if (y < y0) y0 = y; if (y > y1) y1 = y }
    if (!(y1 > y0)) continue
    const x0 = Math.max(0, c.x0 - 3), x1 = Math.min(s.w, c.x1 + 3)
    for (const w of strokeEdgeWidths((x, y) => pi.dark[y * s.w + x] / 255, x0, x1, y0, y1 + 1, minPeak, li.fit.emPx * 0.25)) ws.push(w)
  }
  if (ws.length < 12) return null
  ws.sort((a, b) => a - b)
  return ws[ws.length >> 1]
}
/**
 * A paper whose fine texture is a REGULAR pattern — a registry certificate's
 * security hatch, a halftone screen — keeps that pattern under the ink.
 * Push-pull fills an erased letter with the paper's smoothed level, and a
 * hatch of dots at an eight-pixel pitch then shows a clean patch wherever a
 * letter was; worse, a letter borrowed from elsewhere carried the hatch of
 * where it was taken (its fringe's transmittance against the smooth fill), a
 * faint box of misaligned dots around every new letter. Where the paper's
 * residual against its own blur repeats on a lattice (autocorrelation over
 * 0.6 at a shift of three pixels or more, measured on windows of plain
 * paper), every unknown pixel takes the residual of the nearest lattice
 * translate that is plain paper, on top of the smooth fill.
 */
function paperTexture(ch: Float32Array[], known: Float32Array, W: number, H: number): Int8Array | null {
  const N = W * H
  const R = 6
  const blur = (src: Float32Array): Float32Array => {
    const tmp = new Float32Array(N), out = new Float32Array(N), k = 2 * R + 1
    for (let y = 0; y < H; y++) {
      const o = y * W
      let acc = 0
      for (let x = -R; x <= R; x++) acc += src[o + Math.min(W - 1, Math.max(0, x))]
      for (let x = 0; x < W; x++) { tmp[o + x] = acc / k; acc += src[o + Math.min(W - 1, x + R + 1)] - src[o + Math.max(0, x - R)] }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0
      for (let y = -R; y <= R; y++) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x]
      for (let y = 0; y < H; y++) { out[y * W + x] = acc / k; acc += tmp[Math.min(H - 1, y + R + 1) * W + x] - tmp[Math.max(0, y - R) * W + x] }
    }
    return out
  }
  const lum = new Float32Array(N)
  for (let p = 0; p < N; p++) lum[p] = (ch[0][p] * 299 + ch[1][p] * 587 + ch[2][p] * 114) / 1000
  const sm = blur(lum)
  const res = new Float32Array(N)
  let ss = 0, n = 0
  for (let p = 0; p < N; p++) if (known[p] === 1) { res[p] = lum[p] - sm[p]; ss += res[p] * res[p]; n++ }
  if (n < N * 0.2 || Math.sqrt(ss / n) < 1) return null
  // Windows of plain paper to measure the pattern on.
  const WIN = 48, K = 12
  const wins: { x: number; y: number }[] = []
  for (let gy = 0; gy < 10 && wins.length < 40; gy++) for (let gx = 0; gx < 10 && wins.length < 40; gx++) {
    const x = Math.round(K + (W - WIN - 2 * K) * (gx + 0.5) / 10), y = Math.round((H - WIN - K) * (gy + 0.5) / 10)
    if (x < K || y < 0 || x + WIN + K > W || y + WIN + K > H) continue
    let k = 0
    for (let yy = y; yy < y + WIN + K; yy += 2) for (let xx = x - K; xx < x + WIN + K; xx += 2) if (known[yy * W + xx] === 1) k++
    if (k >= (WIN + K) * (WIN + 2 * K) / 4 * 0.95) wins.push({ x, y })
  }
  if (wins.length < 6) return null
  const corr = (dx: number, dy: number) => {
    let num = 0, den = 0
    for (const w of wins) for (let y = w.y; y < w.y + WIN; y++) for (let x = w.x; x < w.x + WIN; x++) {
      const a = y * W + x, b = a + dy * W + dx
      if (known[a] !== 1 || known[b] !== 1) continue
      num += res[a] * res[b]; den += res[a] * res[a]
    }
    return den > 0 ? num / den : 0
  }
  const peaks: { dx: number; dy: number; c: number; len: number }[] = []
  for (let dy = 0; dy <= K; dy++) for (let dx = -K; dx <= K; dx++) {
    if (dy === 0 && dx <= 0) continue
    const len = Math.hypot(dx, dy)
    if (len < 3) continue
    peaks.push({ dx, dy, c: corr(dx, dy), len })
  }
  const best = Math.max(...peaks.map(q => q.c))
  if (!(best >= 0.6)) return null
  const strong = peaks.filter(q => q.c >= best - 0.08).sort((a, b) => a.len - b.len)
  const v1 = strong[0]
  const v2 = strong.find(q => q.dx * v1.dy - q.dy * v1.dx !== 0)
  if (!v2) return null
  const offsets: { dx: number; dy: number; len: number }[] = []
  const M = 14
  for (let a = -M; a <= M; a++) for (let b = -M; b <= M; b++) {
    if (!a && !b) continue
    const dx = a * v1.dx + b * v2.dx, dy = a * v1.dy + b * v2.dy
    const len = Math.hypot(dx, dy)
    if (len <= 96) offsets.push({ dx, dy, len })
  }
  offsets.sort((a, b) => a.len - b.len)
  const smC = ch.map(c => blur(c))
  // The residual every pixel carries, kept with the page: what relaxing an
  // erased hole (a smooth harmonic fill) has to add back.
  const tex = new Int8Array(N * 3)
  for (let p = 0; p < N; p++) if (known[p] === 1) for (let c = 0; c < 3; c++) tex[p * 3 + c] = Math.max(-127, Math.min(127, Math.round(ch[c][p] - smC[c][p])))
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x
    if (known[p] === 1) continue
    for (const o of offsets) {
      const X = x + o.dx, Y = y + o.dy
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue
      const q = Y * W + X
      if (known[q] !== 1) continue
      for (let c = 0; c < 3; c++) { const r = ch[c][q] - smC[c][q]; ch[c][p] += r; tex[p * 3 + c] = Math.max(-127, Math.min(127, Math.round(r))) }
      break
    }
  }
  return tex
}

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
let flatDebug: string[] = []
/** Why each ground test of the last line analysed gave up, or what it found (lab only). */
export function lastFlatTest(): string[] { const v = flatDebug; flatDebug = []; return v }

/**
 * How far the paper estimate departs from its own local average, over the
 * line's region: the 90th percentile of |paper − box blur(paper)| at pixels
 * that are not ink, in levels. A gradient reads one or two; a photograph's
 * texture tens.
 */
function paperRoughness(pi: PageInk, roi: { x0: number; y0: number; x1: number; y1: number }, em: number): number {
  const s = pi.s, W = roi.x1 - roi.x0, H = roi.y1 - roi.y0
  const P = new Float32Array(W * H)
  const lumAtP = (p: number) => (pi.paper[p * 3] * 299 + pi.paper[p * 3 + 1] * 587 + pi.paper[p * 3 + 2] * 114) / 1000
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (roi.y0 + y) * s.w + roi.x0 + x
    let v = lumAtP(p)
    // A grid line's paper is the grid: bridged with the paper a few pixels
    // off it, or every squared page reads as rough as a photograph.
    if (pi.lines?.[p]) {
      let best = -1
      const px = roi.x0 + x, py = roi.y0 + y
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        for (let k = 1; k <= 12; k++) {
          const qx = px + dx * k, qy = py + dy * k
          if (qx < 0 || qy < 0 || qx >= s.w || qy >= s.h) break
          const q = qy * s.w + qx
          if (!pi.lines[q]) { best = Math.max(best, lumAtP(q)); break }
        }
      }
      if (best >= 0) v = best
    }
    P[y * W + x] = v
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
    if (pi.dark[p] >= FRINGE || pi.lines?.[p]) continue
    res.push(Math.abs(P[y * W + x] - blur[y * W + x]))
  }
  if (res.length < 20) return Infinity
  res.sort((a, b) => a - b)
  return res[Math.floor(res.length * 0.9)]
}

/**
 * The line's GROUND re-estimated where it is one flat colour — a book
 * cover's band of red, blue or purple behind its title. The page's paper is
 * found with a max filter 3.6pt wide, and a cover title's strokes are wider
 * than that: their middles never saw the ground inside the filter and were
 * read as paper, black (on the inverted page) inside cyan, and every such
 * line failed the plain-paper test it should have passed best ("PIENSE",
 * "RICO", "$100M" measured 47–99 of roughness against a bar of 8). Letters of
 * ANOTHER line in the region did the same from the other side: lighter than
 * the ground, the filter took them for paper ("NAPOLEON HILL" above the white
 * "PIENSE").
 *
 * The ground's colour is the commonest colour of the region's padding — the
 * ring between the recogniser's box and the region's edge — refined by a
 * mean shift. It must DOMINATE that ring (60% of it within 32 levels of it)
 * and be tight (a median distance of 8 levels, a 90th percentile of 20 —
 * JPEG chroma noise on a 72 DPI cover reaches 18), cover at least 30% of the
 * region, and be lighter than the ink: the line is read in the domain where
 * its letters are the dark side. A photograph fails the first test outright —
 * an ocean behind a title put 10–14% of its ring near its commonest colour,
 * the picture behind a sign 30%, a flat cover 70–82%. The paper is then filled
 * from the ground's own pixels alone (push-pull), so a stroke of any width is
 * a hole in it, and the darkness recomputed against it — a lighter letter of
 * another line now reads as no ink at all, which is what it is to this line.
 * Writes the region's paper and darkness into the page; false, with nothing
 * written, when the ground is not flat.
 *
 * Anything else off the ground's colour belongs to SOME ink, whichever way
 * its luminance points — a title's drop shadow is darker than the ground in
 * the scan and, read with two channels inverted, lighter than it here, so as
 * darkness it was paper: erasing a letter of "OFFERS" left its shadow on the
 * purple as a dark "S". Such a pixel gets the darkness of a letter's haze:
 * enough to be erased and moved with the letter whose region it is in, never
 * enough to be a core.
 */
/** The median luminance of a region's padding ring (outside the recogniser's box): near white on paper. */
function ringLum(pi: PageInk, roi: { x0: number; y0: number; x1: number; y1: number }, box: { x0: number; y0: number; x1: number; y1: number }): number {
  const v: number[] = []
  for (let y = roi.y0; y < roi.y1; y += 2) for (let x = roi.x0; x < roi.x1; x += 2) {
    if (x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) continue
    v.push(lumAt(pi.s.data, y * pi.s.w + x))
  }
  if (!v.length) return 255
  v.sort((a, b) => a - b)
  return v[v.length >> 1]
}

function flattenGround(pi: PageInk, roi: { x0: number; y0: number; x1: number; y1: number }, box: { x0: number; y0: number; x1: number; y1: number }, em: number): boolean {
  const s = pi.s, d = s.data, W = roi.x1 - roi.x0, H = roi.y1 - roi.y0, N = W * H
  if (W < 8 || H < 8) return false
  const pAt = (j: number) => (roi.y0 + Math.floor(j / W)) * s.w + roi.x0 + (j % W)
  const hist = new Uint32Array(4096)
  let ring = 0
  for (let j = 0; j < N; j++) {
    const x = roi.x0 + (j % W), y = roi.y0 + Math.floor(j / W)
    if (x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) continue
    const i = pAt(j) * 4
    hist[((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4)]++
    ring++
  }
  if (ring < 100) return false
  let top = 0
  for (let k = 1; k < 4096; k++) if (hist[k] > hist[top]) top = k
  let g = [((top >> 8) << 4) + 8, (((top >> 4) & 15) << 4) + 8, ((top & 15) << 4) + 8]
  const dist = (i: number) => Math.hypot(d[i] - g[0], d[i + 1] - g[1], d[i + 2] - g[2])
  for (let it = 0; it < 4; it++) {
    let sr = 0, sg = 0, sb = 0, n = 0
    for (let j = 0; j < N; j++) {
      const i = pAt(j) * 4
      if (dist(i) > 24) continue
      sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++
    }
    if (!n) return false
    g = [sr / n, sg / n, sb / n]
  }
  let ringNear = 0
  for (let j = 0; j < N; j++) {
    const x = roi.x0 + (j % W), y = roi.y0 + Math.floor(j / W)
    if (x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) continue
    if (dist(pAt(j) * 4) <= 32) ringNear++
  }
  if (ringNear < ring * 0.6) { flatDebug.push(`flat: ringNear ${(ringNear / ring).toFixed(2)}`); return false }
  const near: number[] = []
  for (let j = 0; j < N; j += 2) { const v = dist(pAt(j) * 4); if (v <= 32) near.push(v) }
  if (near.length < 20) return false
  near.sort((a, b) => a - b)
  const noise = near[Math.floor(near.length * 0.9)]
  if (near[Math.floor(near.length * 0.5)] > 8 || noise > 20) { flatDebug.push(`flat: median ${near[Math.floor(near.length * 0.5)].toFixed(1)} noise ${noise.toFixed(1)}`); return false }
  const T = Math.max(8, Math.min(24, noise * 1.3))
  const lg = (g[0] * 299 + g[1] * 587 + g[2] * 114) / 1000
  const known = new Float32Array(N)
  let ground = 0, darkInk = 0
  for (let j = 0; j < N; j++) {
    const i = pAt(j) * 4
    const v = dist(i)
    if (v <= T) { known[j] = 1; ground++ } else if (v > 60 && lumAt(d, pAt(j)) < lg - 40) darkInk++
  }
  if (ground < N * 0.3 || darkInk < Math.max(30, N * 0.005)) return false
  // The ground is sampled beyond the haze around the letters, as the page's
  // own paper is (`preparePage`): blur and JPEG ringing hug every stroke.
  const grow = Math.max(2, Math.round(1.8 / Math.abs(s.toPage[0] || 1)))
  const off = new Uint8Array(N)
  for (let j = 0; j < N; j++) off[j] = known[j] ? 0 : 1
  maxFilter1D(off, W, H, grow, true)
  maxFilter1D(off, W, H, grow, false)
  const k2 = new Float32Array(N)
  for (let j = 0; j < N; j++) k2[j] = off[j] ? 0 : 1
  const ch = [new Float32Array(N), new Float32Array(N), new Float32Array(N)]
  for (let j = 0; j < N; j++) { const i = pAt(j) * 4; ch[0][j] = d[i]; ch[1][j] = d[i + 1]; ch[2][j] = d[i + 2] }
  if (!pushPull(ch, k2, W, H)) return false
  // Only where the page's estimate was WRONG — off by more than the ground's
  // own noise: elsewhere it stands, so a line analysed after this one on the
  // same pixels reads what it always read ("LA RIQUEZA…" lies inside the
  // inflated box of the "RICO" above it). A fixed ten levels left the
  // estimate a few levels off beside every letter, and on a noiseless blue
  // cover an erased "M" showed as a ghost of that.
  const bar = Math.max(3, noise * 1.5)
  for (let j = 0; j < N; j++) {
    const p = pAt(j)
    const r = ch[0][j], gg = ch[1][j], b = ch[2][j]
    const lp = (r * 299 + gg * 587 + b * 114) / 1000
    const lo = (pi.paper[p * 3] * 299 + pi.paper[p * 3 + 1] * 587 + pi.paper[p * 3 + 2] * 114) / 1000
    if (Math.abs(lp - lo) <= bar) continue
    pi.paper[p * 3] = r; pi.paper[p * 3 + 1] = gg; pi.paper[p * 3 + 2] = b
    const t = lp > 1 ? lumAt(d, p) / lp : 1
    pi.dark[p] = t >= 1 ? 0 : Math.round((1 - t) * 255)
  }
  // The haze: off-colour pixels beside a letter's core — its ringing, its
  // shadow — whichever way their luminance points. Measured against the
  // ground's own noise: on a noiseless digital cover the ringing round a
  // letter is five to twelve levels off, and left as ground it was what the
  // fill of an erased letter was made from, a faint ghost of the letter on
  // the blue. Only beside letters: haze strewn over a noisy ground counts
  // as faint ink to every measure of the line's strokes.
  const beside = new Uint8Array(N)
  for (let j = 0; j < N; j++) if (pi.dark[pAt(j)] >= CORE) beside[j] = 1
  const reach = Math.max(3, Math.round(em * 0.1))
  maxFilter1D(beside, W, H, reach, true)
  maxFilter1D(beside, W, H, reach, false)
  const hazeAt = Math.max(6, T * 0.8)
  for (let j = 0; j < N; j++) {
    if (!beside[j]) continue
    const p = pAt(j)
    if (pi.dark[p] < HAZE && dist(p * 4) > hazeAt) {
      pi.dark[p] = HAZE
    }
  }
  return true
}

/** A box blur of radius r (edges replicated), for one channel. */
function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H), k = 2 * r + 1
  for (let y = 0; y < H; y++) {
    const row = y * W
    let sum = 0
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(W - 1, Math.max(0, x))]
    for (let x = 0; x < W; x++) {
      tmp[row + x] = sum / k
      sum += src[row + Math.min(W - 1, x + r + 1)] - src[row + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(H - 1, Math.max(0, y)) * W + x]
    for (let y = 0; y < H; y++) {
      out[y * W + x] = sum / k
      sum += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x]
    }
  }
  return out
}

/**
 * A STIPPLED ground — a table header's grey that a copier laid down as a
 * coarse screen, 40 to 190 within a few pixels — is one flat grey to the eye
 * and nothing like one to `flattenGround`. On the inverted page the page's
 * own estimate under a white-on-grey header row was black, so its letters had
 * no darkness at all: every header cell of a results table came back "no
 * letters in the box".
 *
 * Such a ground shows as a flat LOCAL MEAN: averaged over a sixth of an em,
 * away from the letters, it hardly varies (a photograph's or a gradient's
 * does). The stipple is then left as it is — each of its pixels is its own
 * paper — and only the letters, the ink darker than anything the stipple
 * reaches, and a fringe around them get a paper filled from that mean and a
 * darkness against it. A moved letter carries none of the stipple with it, an
 * erased one is refilled with stipple copied from beside it (`groundGrain`),
 * and the stipple's own dark grain is never ink: measured against the mean, a
 * third of it read as letter cores and welded the letters into one blob.
 * Writes the region's paper and darkness into the page; false, with nothing
 * written, when the ground is not such a screen.
 */
function screenGround(pi: PageInk, roi: { x0: number; y0: number; x1: number; y1: number }, em: number): boolean {
  const s = pi.s, d = s.data, W = roi.x1 - roi.x0, H = roi.y1 - roi.y0, N = W * H
  if (W < 12 || H < 12) return false
  const pAt = (j: number) => (roi.y0 + Math.floor(j / W)) * s.w + roi.x0 + (j % W)
  const L = new Float32Array(N)
  for (let j = 0; j < N; j++) L[j] = lumAt(d, pAt(j))
  const sorted = Float32Array.from(L).sort()
  const q90 = sorted[Math.floor(N * 0.9)]
  const fr = Math.max(1, Math.round(em * 0.08))
  // The stipple's level and spread, measured on the stipple alone: a header
  // cell of three lines of letters between two white rules is a third ink,
  // and over the whole region the spread came out a third too wide — wide
  // enough to leave no room below it for the letters. What is plainly ink
  // (under a third of the ground's light side) and its edge are set aside.
  const plain = new Uint8Array(N)
  for (let j = 0; j < N; j++) if (L[j] <= q90 * 0.35) plain[j] = 1
  maxFilter1D(plain, W, H, fr + 1, true)
  maxFilter1D(plain, W, H, fr + 1, false)
  const gl: number[] = []
  for (let j = 0; j < N; j++) if (!plain[j]) gl.push(L[j])
  if (gl.length < N * 0.2) { flatDebug.push(`screen: stipple ${(gl.length / N).toFixed(2)}`); return false }
  gl.sort((a, b) => a - b)
  const med = gl[gl.length >> 1]
  const sigma = (gl[Math.floor(gl.length * 0.75)] - gl[Math.floor(gl.length * 0.25)]) / 1.349
  if (sigma < 8) { flatDebug.push(`screen: spread ${sigma.toFixed(1)}`); return false }
  // Ink is what the stipple never reaches: three spreads below its level, and
  // dark enough against that level to be a core.
  const tInk = Math.min(med - 3 * sigma, med * (1 - CORE / 255))
  if (tInk < 8) { flatDebug.push(`screen: no room for ink under ${med.toFixed(0)}±${sigma.toFixed(0)}`); return false }
  const seed = new Uint8Array(N)
  for (let j = 0; j < N; j++) if (L[j] <= tInk) seed[j] = 1
  // A speck of the stipple's darkest grain is no letter.
  for (const c of components(seed, W, H, 0, 0, W)) if (c.area < 4) for (const j of c.pix) seed[j] = 0
  let inkN = 0
  for (let j = 0; j < N; j++) inkN += seed[j]
  if (inkN < Math.max(20, N * 0.004)) { flatDebug.push(`screen: ink ${inkN}`); return false }
  const r = Math.max(2, Math.round(em * 0.15))
  // The letters and their anti-aliased edge, whose paper is unknown.
  const zone = seed.slice()
  maxFilter1D(zone, W, H, fr, true)
  maxFilter1D(zone, W, H, fr, false)
  // Where the local mean is pulled by the letters.
  const near = zone.slice()
  maxFilter1D(near, W, H, r, true)
  maxFilter1D(near, W, H, r, false)
  const raw = [new Float32Array(N), new Float32Array(N), new Float32Array(N)]
  for (let j = 0; j < N; j++) { const i = pAt(j) * 4; raw[0][j] = d[i]; raw[1][j] = d[i + 1]; raw[2][j] = d[i + 2] }
  const mean = raw.map(c => boxBlur(c, W, H, r))
  let free = 0
  let g = [0, 0, 0]
  for (let j = 0; j < N; j++) if (!near[j]) { free++; for (let c = 0; c < 3; c++) g[c] += mean[c][j] }
  if (free < N * 0.2) { flatDebug.push(`screen: ground ${(free / N).toFixed(2)}`); return false }
  g = g.map(v => v / free)
  const dev = (j: number) => Math.hypot(mean[0][j] - g[0], mean[1][j] - g[1], mean[2][j] - g[2])
  // Towards the commonest level: a neighbouring band at the region's edge is not this ground.
  for (let it = 0; it < 3; it++) {
    const a = [0, 0, 0]
    let n = 0
    for (let j = 0; j < N; j++) if (!near[j] && dev(j) <= 24) { n++; for (let c = 0; c < 3; c++) a[c] += mean[c][j] }
    if (!n) return false
    g = a.map(v => v / n)
  }
  const devs: number[] = []
  for (let j = 0; j < N; j += 2) if (!near[j]) devs.push(dev(j))
  devs.sort((a, b) => a - b)
  const dMed = devs[devs.length >> 1], d90 = devs[Math.floor(devs.length * 0.9)]
  if (dMed > 10 || d90 > 24) { flatDebug.push(`screen: local mean ${dMed.toFixed(1)}/${d90.toFixed(1)}`); return false }
  const known = new Float32Array(N)
  for (let j = 0; j < N; j++) known[j] = near[j] ? 0 : 1
  const fill = mean.map(c => c.slice())
  if (!pushPull(fill, known, W, H)) return false
  for (let j = 0; j < N; j++) {
    const p = pAt(j)
    const r0 = fill[0][j], g0 = fill[1][j], b0 = fill[2][j]
    const lp = (r0 * 299 + g0 * 587 + b0 * 114) / 1000
    // Beside a letter, grain lighter than the mean is no part of the letter:
    // with the mean for its paper it travelled with a moved letter as tint
    // above the paper and printed a ring of dark specks round it.
    if (!zone[j] || L[j] >= lp) {
      pi.paper[p * 3] = raw[0][j]; pi.paper[p * 3 + 1] = raw[1][j]; pi.paper[p * 3 + 2] = raw[2][j]
      pi.dark[p] = 0
      continue
    }
    pi.paper[p * 3] = r0; pi.paper[p * 3 + 1] = g0; pi.paper[p * 3 + 2] = b0
    const t = lp > 1 ? L[j] / lp : 1
    pi.dark[p] = t >= 1 ? 0 : Math.round((1 - t) * 255)
  }
  flatDebug.push(`screen: ok level ${med.toFixed(0)}±${sigma.toFixed(0)} ink<${tInk.toFixed(0)} mean ${dMed.toFixed(1)}/${d90.toFixed(1)}`)
  return true
}

/**
 * The em a short reading's own ink implies: its tallest core piece inside the
 * box, as a capital or figure (0.72 em) or, for x-height letters alone, as an
 * x-height (0.52 em). A piece spanning most of the box along either side and
 * sparse in its own bounds is a rule, or rules meeting at a corner, and does
 * not count. Null when nothing letter-like is there.
 */
function shortInkEm(pi: PageInk, box: { x0: number; y0: number; x1: number; y1: number }, chars: string[]): number | null {
  const s = pi.s
  const x0 = Math.max(0, box.x0), y0 = Math.max(0, box.y0), x1 = Math.min(s.w, box.x1), y1 = Math.min(s.h, box.y1)
  const W = x1 - x0, H = y1 - y0
  if (W < 3 || H < 6) return null
  const mask = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (pi.dark[(y0 + y) * s.w + x0 + x] >= CORE) mask[y * W + x] = 1
  let tallest = 0
  for (const c of components(mask, W, H, 0, 0, W)) {
    const w = c.x1 - c.x0, h = c.y1 - c.y0
    if (c.area < 6) continue
    if ((h >= H * 0.85 || w >= W * 0.85) && c.area < w * h * 0.2) continue
    tallest = Math.max(tallest, h)
  }
  if (tallest < Math.max(4, H * 0.2)) return null
  const xHeightOnly = chars.every(c => /[acemnorsuvwxz]/.test(c))
  return tallest / (xHeightOnly ? 0.52 : 0.72)
}

/**
 * Analyse one recognised line on the prepared page. `inkRect` is in page
 * points (top-left), as OCR reports it. Null when the line's ink cannot be
 * told apart (no letters, a baseline that cannot be fitted, a reading that
 * cannot be shared among the words) — the caller then leaves the line to the
 * vector redraw.
 */
export function analyzeLine(pi: PageInk, item: { id: string; text: string; inkRect: { x: number; y: number; width: number; height: number }; confidence?: number }, opts: { inverted?: boolean; growX?: [number, number]; typed?: boolean; domain?: number; recolored?: boolean } = {}): LineInk | null {
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
  // A short reading's box says little about its size: the recogniser pads a
  // lone "1" in a table cell out to the cell (39×33 px round a 13 px figure),
  // and the em its width implied, three times the figure's, made a region
  // spanning three rows and reaching into the header above — every row number
  // of a results table came back "set over a picture". The ink inside the box
  // says better: its tallest piece that is not a rule crossing the box.
  if (chars.length <= 3) {
    const inkEm = shortInkEm(pi, box, chars)
    if (inkEm !== null && inkEm < emGuess * 0.75) emGuess = Math.max(inkEm, boxH * 0.3)
  }
  const padY = Math.round(emGuess * 0.9), padX = Math.round(emGuess * 0.6)
  const [growL, growR] = opts.growX ?? [0, 0]
  const roi = { x0: Math.max(0, box.x0 - padX - growL), y0: Math.max(0, box.y0 - padY), x1: Math.min(s.w, box.x1 + padX + growR), y1: Math.min(s.h, box.y1 + padY) }
  // Reversed-out lettering on a BAND barely taller than itself — a table's
  // header row, white on grey — is read within the band. The region reached
  // past it into the white page above and below, which on the inverted scan
  // is as dark as the letters, and no ground test can pass over it. The
  // band's rows are those where a quarter of the box's width is at least as
  // light as the band's light side.
  if (opts.inverted) {
    const lumsIn: number[] = []
    for (let y = Math.max(0, box.y0); y < Math.min(s.h, box.y1); y++) for (let x = Math.max(0, box.x0); x < Math.min(s.w, box.x1); x += 2) lumsIn.push(lumAt(s.data, y * s.w + x))
    if (lumsIn.length > 20) {
      lumsIn.sort((a, b) => a - b)
      const bandL = lumsIn[Math.floor(lumsIn.length * 0.8)]
      const lightRow = (y: number) => {
        let n = 0, light = 0
        for (let x = Math.max(0, box.x0); x < Math.min(s.w, box.x1); x++) { n++; if (lumAt(s.data, y * s.w + x) >= bandL - 40) light++ }
        return n ? light / n : 0
      }
      const mid = Math.round((box.y0 + box.y1) / 2)
      if (bandL >= 90 && lightRow(mid) >= 0.25) {
        let by0 = mid, by1 = mid
        while (by0 - 1 >= roi.y0 && lightRow(by0 - 1) >= 0.25) by0--
        while (by1 + 1 < roi.y1 && lightRow(by1 + 1) >= 0.25) by1++
        if (by1 - by0 + 1 >= (box.y1 - box.y0) * 0.8) {
          roi.y0 = Math.max(roi.y0, by0 - 1)
          roi.y1 = Math.min(roi.y1, by1 + 2)
        }
      }
    }
  }
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
        const li = analyzeLine(domainPage(pi, 7), item, { inverted: true, domain: 7, typed: opts.typed })
        return li ?? fail(`the text is lighter than its ground, and reversed: ${failedBecause}`)
      }
    }
  }
  // Plain paper behind the line, or nothing is erased cleanly: lettering set
  // over a photograph or a gradient (a brochure's title on its picture) has no
  // paper to fill from, and an erase there punched pale holes in the picture.
  let smoothGround = false
  let flatGround = false
  // The ground is a stipple (`screenGround`): its paper is its own pixels, as rough as it is.
  let screened = false
  {
    const paperRange = (): number | null => {
      const lums: number[] = []
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 3) {
        const p = at(x, y)
        if (pi.dark[p] >= FRINGE || pi.lines?.[p]) continue
        lums.push((pi.paper[p * 3] * 299 + pi.paper[p * 3 + 1] * 587 + pi.paper[p * 3 + 2] * 114) / 1000)
      }
      if (lums.length <= 40) return null
      lums.sort((a, b) => a - b)
      return lums[Math.floor(lums.length * 0.95)] - lums[Math.floor(lums.length * 0.05)]
    }
    let range = paperRange()
    // Reversed or coloured lettering is given its flat ground BEFORE it is
    // judged: the page's estimate under a thick stroke can be a smooth mix of
    // the ground and the stroke's own middle, against which the middle reads
    // as ink and the test below passes — and an erase then wrote that mix (a
    // white "E" on red came out pinkish white). Where the estimate was right
    // already, nothing is rewritten.
    if (opts.inverted || ringLum(pi, roi, box) < 215) {
      if (flattenGround(pi, roi, box, emGuess)) { flatGround = true; range = paperRange() }
      // Only for REVERSED lettering. Dark letters on a light textured ground
      // keep the gradient rule below, which asks for a clean cut: a
      // certificate's condensed capitals on a mottled blue passed the screen
      // test (level 213±10) with their touching tops read as a rule and the
      // first cell holding "AL" — deleting the "A" deleted the "L" with it.
      else if (opts.inverted && screenGround(pi, roi, emGuess)) { flatGround = true; screened = true }
    }
    if (range !== null && range > 40 && !screened) {
      // A wide range is not a picture when it is SMOOTH: a cover's gradient
      // spans a hundred levels across a line and a pixel's paper differs
      // from the paper around it by a level or two. What the erase needs is
      // that the paper can be filled from its surroundings, and a gradient
      // can — a photograph's texture cannot.
      let rough = paperRoughness(pi, roi, emGuess)
      // Nor when the GROUND is flat and only the page's estimate of it is
      // rough (`flattenGround`): a cover title's strokes are wider than the
      // filter that finds ink, and their middles were read as paper.
      if (rough > 8 && !flatGround && flattenGround(pi, roi, box, emGuess)) {
        flatGround = true
        range = paperRange()
        rough = range !== null && range > 40 ? paperRoughness(pi, roi, emGuess) : 0
      }
      smoothDebug = { range, rough, flat: flatGround }
      if (range !== null && range > 40) {
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
  // Only what lies in the LINE's own band counts: the recogniser's box of a
  // table's first row reaches past the rule into the speckled grey header
  // above it, and that header — wide, tall, one component — refused the
  // cell's "250.80" as set over a picture while the figures sat on clean
  // white. The band is the letters' own: their median centre, ±0.6 em.
  {
    const letterish = comps.filter(c => { const h = c.y1 - c.y0; return h >= emGuess * 0.3 && h <= emGuess * 1.2 && c.x1 - c.x0 <= emGuess * 1.5 })
    const midY = letterish.length >= 2 ? median(letterish.map(c => c.cy)) : null
    let big = 0
    for (const c of comps) {
      const w = c.x1 - c.x0, h = c.y1 - c.y0
      if (w < emGuess * 0.5) continue
      if (!((w > emGuess * 3 && h > emGuess * 0.8) || h > emGuess * 2.2 || c.area > emGuess * emGuess * 2.5)) continue
      if (midY === null) { big += c.area; continue }
      for (const p of c.pix) { const y = (p - p % s.w) / s.w; if (Math.abs(y + 0.5 - midY) <= emGuess * 0.6) big++ }
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
  // The straight fit judges whether this is one printed line, and a level
  // one; the line's BEND (below) is added only once it has passed.
  const straight = (x: number) => fit!.y + fit!.slope * (x - fit!.centreX)
  // A recognised "line" that is really two printed lines (the detector took
  // both in one box) has letters well clear of the fitted line on the other
  // side: the edit would be planned on one line's ink with both lines' text.
  {
    let off = 0, total = 0
    for (const c of letters) {
      total++
      const b = straight(c.cx)
      if (c.y1 < b - em * 1.05 || c.y0 > b + em * 0.25) off++
    }
    if (total >= 6 && off > total * 0.3) return fail('the box holds more than one printed line')
  }
  // Text set on an ARC (a seal's "REPÚBLICA DEL PERÚ") has no baseline: the
  // straight fit runs under its middle letters and through its end ones, and
  // an edit laid along it put the moved letters off the curve. The letters
  // standing on the fit in each third of the line, middle against ends.
  {
    const sitting = band.filter(c => Math.abs(c.y1 - straight(c.cx)) < em * 0.3).sort((a, b) => a.cx - b.cx)
    if (sitting.length >= 9) {
      const third = Math.floor(sitting.length / 3)
      const thirds = [sitting.slice(0, third), sitting.slice(third, sitting.length - third), sitting.slice(sitting.length - third)]
      const med = (v: number[]) => [...v].sort((p, q) => p - q)[Math.floor(v.length / 2)]
      // On an arc the letters' TOPS bend with their feet. Bottoms alone are
      // fooled by old-style figures — a run of descending 3s and 9s in the
      // middle of "RUC: 20319363221" read as the line bending — and tops alone
      // by capitals beside figures; a seal's "REPÚBLICA DEL PERÚ" bends both
      // (2.7 and 2.3 px on a 16.6 px em), its middle off BOTH ends the same way.
      const [ba, bm, bb] = thirds.map(cs => med(cs.map(c => c.y1 - straight(c.cx))))
      const [ta, tm, tb] = thirds.map(cs => med(cs.map(c => c.y0 - straight(c.cx))))
      const dB = bm - (ba + bb) / 2, dT = tm - (ta + tb) / 2
      arcDebug = { n: sitting.length, em, bottoms: [ba, bm, bb], tops: [ta, tm, tb], dB, dT }
      const bends = Math.abs(dB) > em * 0.12 && Math.abs(dT) > em * 0.08 && Math.sign(dB) === Math.sign(dT) &&
        Math.sign(tm - ta) === Math.sign(dT) && Math.sign(tm - tb) === Math.sign(dT) && Math.min(Math.abs(tm - ta), Math.abs(tm - tb)) > em * 0.03
      if (bends) return fail('the line is set on a curve')
    }
  }
  // A phone photo of a curled page bows its lines; the letters' feet are
  // followed where they stray from the straight fit by more than a scan's
  // quantisation (`fitBend`).
  fit.bend = fitBend(band.map(c => asBlob(c)), fit)
  const base = baselineAtOf(fit)

  // Which ink is this line's: a component whose centre sits in the line's
  // letter band. A component far taller than a letter is a vertical rule or
  // two lines' strokes welded together; only its pixels inside the band are
  // the line's.
  /** A flat stroke: a dash, an underscore, a rule's stub — long, and no taller than a quarter em. */
  const isDash = (c: Comp) => c.y1 - c.y0 <= Math.max(2, em * 0.25) && c.x1 - c.x0 >= em * 0.3
  const ownPieces: Comp[] = []
  const protect = new Set<number>()
  const own = new Set<number>()
  /** Where vertical rules stand in the line's band — a cell's borders. */
  const borders: number[] = []
  // How thick the band's horizontal rules are: a box's sides are drawn with
  // the same pen as its top and bottom.
  const penThick = (() => {
    const ns: number[] = []
    for (const r of components(ruleMask, W, H, roi.x0, roi.y0, s.w)) {
      if (r.x1 - r.x0 < ruleLen) continue
      const cols = new Map<number, number>()
      for (const p of r.pix) { const x = p % s.w; cols.set(x, (cols.get(x) ?? 0) + 1) }
      ns.push(median([...cols.values()]))
    }
    return ns.length ? median(ns) : 0
  })()
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
      // A piece taller than any letter — a box's side running from its top
      // rule round a corner into its bottom one — may be as thick as the
      // box's pen, and its blurred edge columns are its own.
      const tall = c.y1 - c.y0 >= em * 1.3
      const maxW = Math.max(2, Math.round(em * 0.15), tall ? Math.min(Math.round(em * 0.3), penThick + 1) : 0)
      const carved = carveBorder(c, s.w, Math.round(b0 - em * 0.78), Math.round(b0 + Math.max(2, em * 0.1)), maxW, { base: Math.round(b0), onRule }, tall ? 2 : 0)
      if (carved) {
        for (const p of carved.rule) protect.add(p)
        borders.push(carved.x)
        if (carved.rest.length < 4) continue
        c = compOf(carved.rest, s.w)
      }
    }
    const h = c.y1 - c.y0, w = c.x1 - c.x0
    // A dash the region was widened for (see below) is the line's however
    // far it runs on: it starts inside the margin the line owns.
    const inX = (c.cx >= box.x0 - em * 0.6 && c.cx <= box.x1 + em * 0.6) ||
      (isDash(c) && ((growR > 0 && c.x0 <= box.x1 + em * 0.6 && c.x1 > box.x1) || (growL > 0 && c.x1 >= box.x0 - em * 0.6 && c.x0 < box.x0)))
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
  // The band is a fixed share of the em, and a title's em is huge: on a
  // cover the 166 px band of "RICO" took in the bottom of "Y HÁGASE" above it
  // and both lines of the subtitle below, and their letters were shared out
  // among R, I, C and O. Judged against the line's OWN letters instead: a
  // piece whose bottom stands higher above the baseline than the letters'
  // tops, too big for an accent, is the line above's; one that starts
  // clearly below the baseline and is far smaller than the line's letters is
  // the line below's — a comma or a descender starts at the baseline, and a
  // handwritten letter's detached tail is half a letter tall. Letters, not
  // flat strokes: the fragments of a form's blank under the line are its
  // own, and taken away the date typed into the blank moved off it.
  {
    const rise = (c: Comp) => base(c.cx) - c.y0
    const tall = ownPieces.filter(c => c.y1 - c.y0 >= em * 0.4)
    if (tall.length >= 3) {
      const capRise = median(tall.map(rise))
      const letterH = median(tall.map(c => c.y1 - c.y0))
      for (let i = ownPieces.length - 1; i >= 0; i--) {
        const c = ownPieces[i], h = c.y1 - c.y0, b = base(c.cx)
        const above = b - c.y1 > capRise + em * 0.04 && h >= em * 0.2
        const below = c.y0 > b + Math.max(2, letterH * 0.08) && h < letterH * 0.35 && h >= 3 && c.x1 - c.x0 <= h * 2.5
        if (!above && !below) continue
        for (const p of c.pix) protect.add(p)
        ownPieces.splice(i, 1)
      }
    }
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

  // A full stop or a comma printed fainter than the letters' cores — a small
  // figure's "." peaked at darkness 80 against its figures' 180 — is no piece
  // at the core level, and the reading's labels slid over the gap: "1.00" put
  // its "." on the first "0" and split the second over two halves, and the
  // edit that changed the "1" erased the stop it never knew about ("2.00"
  // printed "200"). A faint mark of its own (touching no piece's core),
  // small, sitting on the baseline in a GAP between pieces, joins the line's
  // pieces — but only as many as the reading has stops and commas its own
  // small pieces do not already account for, the darkest first: on
  // handwriting, any faint mark near the baseline would do, and every pen
  // skip taken for a stop slid the labels the other way.
  const stopsInReading = [...text].filter(ch => ch === '.' || ch === ',').length
  const isStopSized = (c: Comp) => c.x1 - c.x0 <= em * 0.3 && c.y1 - c.y0 <= em * 0.3 && (() => {
    const b = base(c.cx)
    return c.y1 >= b - em * 0.15 && c.y1 <= b + em * 0.35 && c.y0 >= b - em * 0.4
  })()
  const missingStops = stopsInReading - ownPieces.filter(isStopSized).length
  if (missingStops > 0) {
    const near = new Uint8Array(W * H)
    const mark = (p: number) => {
      const x = p % s.w - roi.x0, y = (p - (p % s.w)) / s.w - roi.y0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) near[yy * W + xx] = 1
      }
    }
    for (const c of ownPieces) for (const p of c.pix) mark(p)
    for (const p of protect) mark(p)
    const faint = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const j = y * W + x
      if (!near[j] && pi.dark[(roi.y0 + y) * s.w + roi.x0 + x] >= 55) faint[j] = 1
    }
    const candidates: { c: Comp; peak: number }[] = []
    for (const c of components(faint, W, H, roi.x0, roi.y0, s.w)) {
      if (c.area < 2 || !isStopSized(c)) continue
      if (c.cx < box.x0 - em * 0.6 || c.cx > box.x1 + em * 0.6) continue
      // In a gap: under or over a piece it would be part of a letter, or dirt.
      if (ownPieces.some(o => c.x1 > o.x0 && c.x0 < o.x1)) continue
      let peak = 0
      for (const p of c.pix) if (pi.dark[p] > peak) peak = pi.dark[p]
      candidates.push({ c, peak })
    }
    candidates.sort((a, b) => b.peak - a.peak)
    for (const { c } of candidates.slice(0, missingStops)) {
      ownPieces.push(c)
      for (const p of c.pix) own.add(p)
    }
  }

  // A dash of the line's own cut off by the region's edge runs on past it,
  // and the part outside belonged to no line: a book cover's closing "—",
  // longer than the recogniser's box, was split when the tail moved — half of
  // it went with "ESTOICAS", half stayed where it was. The line is read again
  // on a region two ems wider on that side, once. Only a dash — a flat
  // stroke that runs on past the edge and ENDS within an em and a half:
  // widened for any piece at the edge (a cover's specks, a title's last
  // letter) the line read differently and some could no longer be read at
  // all, and widened for a form's blank, its underline running on for ems,
  // a date typed into it was set somewhere else.
  if (!opts.growX) {
    const runsOn = (c: Comp, x: number, dir: number) => {
      let longest = 0
      for (let y = c.y0; y < c.y1; y++) {
        let n = 0
        for (let xx = x; xx >= 0 && xx < s.w && n <= em * 1.5 + 1; xx += dir, n++) if (pi.dark[y * s.w + xx] < 60) break
        longest = Math.max(longest, n)
      }
      return longest >= 1 && longest <= em * 1.5
    }
    const needL = roi.x0 > 0 && ownPieces.some(c => c.x0 <= roi.x0 && isDash(c) && runsOn(c, roi.x0 - 1, -1))
    const needR = roi.x1 < s.w && ownPieces.some(c => c.x1 >= roi.x1 && isDash(c) && runsOn(c, roi.x1, 1))
    if (needL || needR) return analyzeLine(pi, item, { ...opts, growX: [needL ? Math.round(em * 2) : 0, needR ? Math.round(em * 2) : 0] })
  }

  // Words: the line's own ink split at its word gaps, then the reading
  // shared among them by width.
  const blobs: Blob[] = ownPieces.map(c => ({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, area: c.area, cx: c.cx, cy: c.cy }))
  const split = splitWords(blobs, fit, box)
  if (!split.words.length) return fail('no words')
  markBullets(split.words, ownPieces, em, text, s.w)
  // An END word lying mostly outside the recogniser's box — the region is the
  // box padded by more than half an em each side, and it takes in the edge of
  // a seal or the next cell's figures — is not part of what was read. Every
  // piece of it must be at least half outside, not just most of its span: a
  // cell's border outside the box makes one word with the first letter just
  // inside it, and leaving that word out dropped the letter ("INGRESÓ" read
  // its N as the I).
  if (split.words.length > 1) {
    const outsideL = (x0: number, x1: number) => Math.max(0, Math.min(x1, box.x0) - x0)
    const outsideR = (x0: number, x1: number) => Math.max(0, x1 - Math.max(x0, box.x1))
    const out = (w: { x0: number; x1: number }, side: (x0: number, x1: number) => number) =>
      side(w.x0, w.x1) >= (w.x1 - w.x0) * 0.7 &&
      ownPieces.filter(c => c.cx >= w.x0 && c.cx < w.x1).every(c => side(c.x0, c.x1) >= (c.x1 - c.x0) * 0.5)
    const first = split.words[0], last = split.words[split.words.length - 1]
    if (out(first, outsideL)) first.outside = true
    if (out(last, outsideR)) last.outside = true
  }
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
    const byRuns = cutExact ? null : runCellsOf(pieces, wordChars, em) ?? figureCellsOf(pieces, wordChars, em)
    // And where the cutter DID cut it, one run per letter is still the truer
    // boundary: the cutter places its cells by the letters' advances, and on a
    // notarial deed's bold "FBERERO" it put the F|B boundary four pixels into
    // the B's stem — the B's piece straddled it, was divided by column, and the
    // F took a strip of the stem with it. The edit erased the B and left the
    // strip standing beside the F: "FEBRERO" printed as "F|EBRERO". The
    // cutter's verdicts (suspect cells) stand; its boundaries give way to the
    // runs, when every run is about as wide as its letter can be — and lies
    // mostly inside the cell the cutter gave its letter. A count that matches
    // by accident does not: re-read with a typed text, the ink of "G." took
    // the reading "ING." (its G, its stop and two specks for four runs), cut
    // on those runs every letter "looked like" its label, and the line was
    // re-read as "INING. CIVIL" — the N and G went from the page.
    const exactRuns = cutExact ? runCellsOf(pieces, wordChars, em) : null
    const runsAgree = !!exactRuns && exactRuns.every((r, i) => {
      const c = cut!.cells[i]
      return Math.min(r.x1, c.x1) - Math.max(r.x0, c.x0) >= (r.x1 - r.x0) * 0.5
    })
    // Where the two DISAGREE, the runs are still the truth when every run
    // that takes a letter or a figure is letter-sized: the cutter places its
    // cells by advances guessed for an ordinary face, and on a cover's
    // condensed "NAPOLEON" they drifted a letter's width by the end — the
    // word stayed "exact", its labels sat on the wrong letters, and deleting
    // the O erased the E. The specks that made "G." four runs for "ING." are
    // not letter-sized. And the runs' widths must be CONSISTENT with their
    // letters — a condensed face narrows every letter alike (0.47–0.70 of
    // its advance across "NAPOLEON"), where a border's fragment labelled "N"
    // beside a real "G" does not (0.24 against 0.67): that is the typed text
    // "ING." laid over the ink of "G." in a table cell, which took it for
    // confirmed and printed "INING. CIVIL". Letters whose ink is far narrower
    // than their advance (an I, an l, a t) say nothing either way. Never for a
    // reading the user typed: there a coincidence confirms a misreading.
    const runsLetterSized = !opts.typed && !!exactRuns && !runsAgree && (() => {
      const spans = inkSpans(pieces)
      const ratios: number[] = []
      for (let i = 0; i < spans.length; i++) {
        const ch = wordChars[i] ?? ''
        if (!/[p{L}p{N}]/u.test(ch)) continue
        let y0 = Infinity, y1 = -Infinity
        for (const c of spans[i].pieces) { y0 = Math.min(y0, c.y0); y1 = Math.max(y1, c.y1) }
        if (y1 - y0 < em * 0.35) return false
        if (!/[IlijJ1!|tfr]/.test(ch)) ratios.push((spans[i].x1 - spans[i].x0) / em / expectedAdvance(ch))
      }
      if (ratios.length < 2) return false
      const med = [...ratios].sort((a, b) => a - b)[ratios.length >> 1]
      return ratios.every(r => r >= med * 0.6 && r <= med * 1.67)
    })()
    const runsDisown = !opts.typed && !!exactRuns && !runsAgree && !runsLetterSized
    const ok = cutOk || !!byRuns
    let wordCells: { char: string; x0: number; x1: number; suspect: boolean }[]
    if (byRuns) {
      wordCells = byRuns
    } else if (exactRuns && (runsAgree || runsLetterSized)) {
      wordCells = exactRuns.map((c, i) => ({ ...c, suspect: !!cut!.cells[i].suspect }))
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
    // A run held by one cell goes to it whole — a broken "/" whose foot sat in
    // the gap before its cell went, piece by piece, to the figure beside it,
    // and was erased with that figure.
    const runCell = new Map<Comp, number>()
    for (const sp of inkSpans(pieces)) {
      if (sp.pieces.length < 2) continue
      const counts = wordCells.map(wc => Math.max(0, Math.min(sp.x1, wc.x1) - Math.max(sp.x0, wc.x0)))
      const best = counts.indexOf(Math.max(...counts))
      if (counts[best] > 0 && counts.filter(n => n > 0).length === 1) for (const c of sp.pieces) runCell.set(c, best)
    }
    for (const c of pieces) {
      const held = runCell.get(c)
      if (held !== undefined) { for (const p of c.pix) pixOf[held].push(p); continue }
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
    words.push({ x0: iw.x0, x1: iw.x1, top: iw.top, bottom: iw.bottom, from, to, cut: ok, exact: (cutExact && !runsDisown) || !!byRuns, weight: wordWeight(pi, pieces, iw, base, em), err })
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

  // The ink colour: the darkest pixels of the line's LETTERS' cores. A bullet
  // the reading never named is ink of the line too — and a solid green disc
  // in front of "49.7% good" outweighed the grey letters, so an "X" appended
  // to them came out green. Every pixel of the line only when its letters
  // give too few.
  const inkRgb: [number, number, number] = [0, 0, 0]
  {
    const letterPix: number[] = []
    for (const c of cells) if (c && /[\p{L}\p{N}]/u.test(c.char)) for (const p of c.pix) letterPix.push(p)
    const pool = letterPix.length >= 24 ? letterPix : [...own]
    const ps = [...pool].sort((a, b) => pi.dark[b] - pi.dark[a]).slice(0, Math.max(8, Math.floor(pool.length * 0.3)))
    if (ps.length) {
      const rs = ps.map(p => s.data[p * 4]), gs = ps.map(p => s.data[p * 4 + 1]), bs = ps.map(p => s.data[p * 4 + 2])
      inkRgb[0] = median(rs); inkRgb[1] = median(gs); inkRgb[2] = median(bs)
      // Letters are printed as ink MULTIPLIED onto the paper, channel by
      // channel, and a product never comes out brighter than the paper. Ink
      // brighter than its ground in any channel cannot be printed that way:
      // yellow lettering on a purple cover (read inverted: blue on green)
      // came back pinkish white, its old letters left as ghosts.
      // Such a line is read again with those channels inverted as well
      // (`domainPage`), where the lettering is darker in every channel.
      let flip = 0
      for (let c = 0; c < 3; c++) {
        const ground = median(ps.map(p => pi.paper[p * 3 + c]))
        if (inkRgb[c] > ground + 24) flip |= 1 << c
      }
      if (flip) {
        if (opts.recolored) return fail('the lettering is a colour its ground cannot be printed with')
        const next = (pi.domain ?? 0) ^ flip
        const li = analyzeLine(domainPage(pi, next), item, { ...opts, inverted: next !== 0, domain: next, recolored: true })
        return li ?? fail(`the lettering is coloured: ${failedBecause}`)
      }
    }
  }

  // Ink of ANOTHER COLOUR in the line's box — a signature's stroke, a stamp's
  // rim — that the letters lie under or over (see `LineInk.overInk`).
  // Judged as a density DIRECTION and in strokes: by plain hue, a dark ink's
  // anti-aliased edge on a tinted paper reads as another colour too (a
  // service order's navy letters came out greyish blue at their edges), and
  // taking that fringe for a second ink shared the letters' own density out
  // to it — erased, they stayed on the page.
  const overInk = ((): [number, number, number] | null => {
    if (cells.length < 2) return null
    // An ink is a DIRECTION of density, -ln(pixel / paper) per channel: its
    // edges, where it thins out over the paper, keep the direction, whatever
    // tint the paper has. Measured on the letters' mid-dark pixels — a dark
    // ink's cores are clipped by the scanner and say little.
    const dir = (p: number): [number, number, number] | null => {
      const d: number[] = []
      for (let c = 0; c < 3; c++) d.push(-Math.log(Math.min(1, Math.max(0.01, s.data[p * 4 + c] / Math.max(1, pi.paper[p * 3 + c])))))
      const n = Math.hypot(d[0], d[1], d[2])
      return n > 0.15 ? [d[0] / n, d[1] / n, d[2] / n] : null
    }
    const ds: [number, number, number][] = []
    for (const c of cells) for (const p of c.pix) {
      if (pi.dark[p] < 60 || pi.dark[p] > 200) continue
      const v = dir(p)
      if (v) ds.push(v)
    }
    if (ds.length < 20) return null
    const own = [median(ds.map(v => v[0])), median(ds.map(v => v[1])), median(ds.map(v => v[2]))]
    const on = Math.hypot(own[0], own[1], own[2])
    const fm = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = (roi.y0 + y) * s.w + roi.x0 + x
      // Unclipped pixels only: a dark core is cut off at zero in one channel
      // and points anywhere.
      if (pi.dark[p] < 60 || pi.dark[p] > 200) continue
      const d = dir(p)
      // Ten degrees and more off the line's own ink.
      if (!d || (d[0] * own[0] + d[1] * own[1] + d[2] * own[2]) / on > 0.985) continue
      fm[y * W + x] = 1
    }
    // In STROKES, an em long at least: colour noise round other letters and a
    // form's rules comes in specks.
    const v: [number, number, number][] = []
    let n = 0, away = 0
    // And strokes that run AWAY from the letters: a signature crosses into
    // the gaps and the space around the line, where a cover title's drop
    // shadow, or its colour fringe, hugs the letters it belongs to. Taken for
    // a second ink, the shadow under "OFFERS" was split off its letters, and
    // erasing one left a lilac ghost of it on the purple.
    // Grown from the LETTERS' pixels, not the core: a signature's stroke is
    // core too, and grown from itself it was never away from anything.
    const near = new Uint8Array(W * H)
    for (const c of cells) for (const p of c.pix) {
      const x = p % s.w - roi.x0, y = Math.floor(p / s.w) - roi.y0
      if (x >= 0 && y >= 0 && x < W && y < H) near[y * W + x] = 1
    }
    const reach = Math.max(3, Math.round(em * 0.12))
    maxFilter1D(near, W, H, reach, true)
    maxFilter1D(near, W, H, reach, false)
    // And strokes that CROSS the line's letters, in the band they stand in:
    // another line set in another colour lies in the region's padding — the
    // white "$100M" above the peach "OFFERS" was taken for a second ink of
    // "OFFERS", and an erased "S" kept a lilac share of it.
    let bandTop = Infinity, bandBottom = -Infinity
    for (const c of cells) if (c.pix.length) { bandTop = Math.min(bandTop, c.top); bandBottom = Math.max(bandBottom, c.bottom) }
    let inBand = 0
    for (const c of components(fm, W, H, roi.x0, roi.y0, s.w)) {
      if (Math.max(c.x1 - c.x0, c.y1 - c.y0) < em) continue
      n += c.area
      for (const p of c.pix) {
        if (pi.dark[p] >= 90) v.push([s.data[p * 4], s.data[p * 4 + 1], s.data[p * 4 + 2]])
        const x = p % s.w - roi.x0, y = Math.floor(p / s.w) - roi.y0
        if (!near[y * W + x]) away++
        if (y + roi.y0 >= bandTop && y + roi.y0 <= bandBottom) inBand++
      }
    }
    if (n < Math.max(30, em * 2) || v.length < 10 || away < n * 0.3 || inBand < Math.max(20, n * 0.1)) return null
    return [median(v.map(c => c[0])), median(v.map(c => c[1])), median(v.map(c => c[2]))]
  })()

  // The Voronoi partition of the ROI among the inks in it, out to ~1.4 pt.
  // Out to ~2.2 pt: as far as a letter's JPEG ringing reaches (the edge of
  // its 8×8 block at 200 DPI). The block does not shrink with the
  // resolution: on a 72 DPI cover 2.2 pt is two pixels, and the ringing round
  // its big letters stayed on the page when they were erased — the outline of
  // a deleted "SE" in the red. A big letter's region reaches up to six pixels.
  // On a flat ground a letter's region takes its effects as well — a drop
  // shadow, a glow, an outline — out to a tenth of an em.
  const ownR = Math.max(3, Math.round(2.2 / Math.abs(s.toPage[0] || 1)), Math.min(6, Math.round(em * 0.08)), flatGround ? Math.round(em * 0.1) : 0)
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
    ...(opts.inverted ? { inverted: true, domain: opts.domain ?? 7 } : {}),
    ...(overInk ? { overInk } : {}),
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
  const spans = inkSpans(pieces)
  if (spans.length !== chars.length) return null
  for (let i = 0; i < chars.length; i++) {
    const adv = expectedAdvance(chars[i])
    const w = (spans[i].x1 - spans[i].x0) / em
    if (w > adv * 1.6 + 0.12 || (adv >= 0.45 && w < adv * 0.3)) return null
  }
  return spans.map((sp, i) => ({ char: chars[i], x0: sp.x0, x1: sp.x1, suspect: false }))
}

/**
 * A NUMBER whose figures touch — "9408100" at 150 DPI, its "08" one run of
 * ink — cut by its pitch: lining figures share one advance, so the figures
 * stand at equal steps across the word and a run that holds k of them is k
 * equal cells. The pitch comes from the word itself (its ink spans n figures
 * less the sidebearing of the two outer ones, about a fifth of a figure); each
 * run takes as many figures as its width holds, within a third of a figure,
 * and the counts must add up to the reading's exactly. Only for words of
 * figures and the separators of a number — a "1" is narrow but stands in a
 * full figure's cell, and no letter has that property. A separator (". , : /
 * -") is one narrow run of its own; which runs are separators is decided with
 * the counts, in reading order, so a bold "20,000.00" whose "20", "000" and
 * "00" each touch is cut as well as a code. Null otherwise; the kept-letter
 * shape check in the edit still refuses a figure cut wrong.
 */
function figureCellsOf(pieces: Comp[], chars: string[], em: number): { char: string; x0: number; x1: number; suspect: boolean }[] | null {
  const isFigure = (c: string) => c >= '0' && c <= '9'
  // Figures, and the separators of a number (each of which stands apart).
  if (chars.length < 2 || !chars.every(c => isFigure(c) || c === '.' || c === ',' || c === ':' || c === '/' || c === '-')) return null
  const figures = chars.filter(isFigure).length
  if (figures < 2) return null
  const spans = inkSpans(pieces)
  if (spans.length >= chars.length || !spans.length) return null
  // The reading as tokens: one separator, or a run of figures.
  const tokens: { from: number; to: number; sep: boolean }[] = []
  for (let i = 0; i < chars.length;) {
    if (!isFigure(chars[i])) { tokens.push({ from: i, to: i + 1, sep: true }); i++; continue }
    let j = i
    while (j < chars.length && isFigure(chars[j])) j++
    tokens.push({ from: i, to: j, sep: false })
    i = j
  }
  const T = tokens.length, N = spans.length
  /** How many characters each run holds at this pitch — a separator one narrow run, a run of figures as many as its width holds — or null when no assignment of the reading fits the runs. */
  const assign = (pitch: number): number[] | null => {
    const best = Array.from({ length: T + 1 }, () => new Float64Array(N + 1).fill(Infinity))
    const back: ({ s: number; counts: number[] } | null)[][] = Array.from({ length: T + 1 }, () => new Array(N + 1).fill(null))
    best[0][0] = 0
    for (let t = 0; t < T; t++) for (let s = 0; s < N; s++) {
      if (best[t][s] === Infinity) continue
      const tok = tokens[t]
      if (tok.sep) {
        if (spans[s].x1 - spans[s].x0 <= pitch * 0.6 && best[t][s] < best[t + 1][s + 1]) { best[t + 1][s + 1] = best[t][s]; back[t + 1][s + 1] = { s, counts: [1] } }
        continue
      }
      const d = tok.to - tok.from
      for (let m = 1; m <= d && s + m <= N; m++) {
        const counts: number[] = []
        let cost = 0, ok = true
        for (let q = s; q < s + m && ok; q++) {
          const w = spans[q].x1 - spans[q].x0
          const k = Math.max(1, Math.round((w + pitch * 0.2) / pitch))
          const err = Math.abs(w + pitch * 0.2 - k * pitch) / pitch
          // A run a third of a figure off its count is not the count; a lone
          // figure may be narrow (a "1" stands in a full cell) but not wide.
          if ((k > 1 && err > 1 / 3) || (k === 1 && w > pitch * 1.3)) ok = false
          counts.push(k)
          cost += k > 1 ? err * err : 0
        }
        if (!ok || counts.reduce((a, b) => a + b, 0) !== d) continue
        if (best[t][s] + cost < best[t + 1][s + m]) { best[t + 1][s + m] = best[t][s] + cost; back[t + 1][s + m] = { s, counts } }
      }
    }
    if (best[T][N] === Infinity) return null
    const per = new Array<number>(N)
    let s = N
    for (let t = T; t > 0; t--) { const b = back[t][s]!; b.counts.forEach((k, i) => { per[b.s + i] = k }); s = b.s }
    return per
  }
  // The pitch: first as a figure's share of the word (a separator about half
  // a figure), then refitted once on the figures' own runs.
  let pitch = (spans[N - 1].x1 - spans[0].x0) / (figures + 0.5 * (chars.length - figures) - 0.2)
  if (!(pitch > em * 0.3 && pitch < em * 0.8)) return null
  let counts = assign(pitch)
  if (!counts) return null
  {
    let w = 0, k = 0, runs = 0
    let i = 0
    for (let s = 0; s < N; s++) {
      if (isFigure(chars[i])) { w += spans[s].x1 - spans[s].x0; k += counts[s]; runs++ }
      i += counts[s]
    }
    const refit = k > runs * 0.2 ? w / (k - runs * 0.2) : pitch
    if (Math.abs(refit - pitch) > pitch * 0.02) {
      if (!(refit > em * 0.3 && refit < em * 0.8)) return null
      pitch = refit
      counts = assign(pitch)
      if (!counts) return null
    }
  }
  const out: { char: string; x0: number; x1: number; suspect: boolean }[] = []
  let i = 0
  for (let s = 0; s < N; s++) {
    const sp = spans[s], k = counts[s], w = sp.x1 - sp.x0
    for (let j = 0; j < k; j++) out.push({ char: chars[i++], x0: Math.round(sp.x0 + w * j / k), x1: Math.round(sp.x0 + w * (j + 1) / k), suspect: false })
  }
  return out
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
export function carveBorder(c: Comp, pageW: number, top: number, bottom: number, maxW: number, ends?: { base: number; onRule: (x: number, y: number) => boolean }, fringe = 0): { rule: number[]; rest: number[]; x: number } | null {
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
    const edge = dir > 0 ? c.x0 : c.x1 - 1
    // A scanned border is ringed by blur, and its outermost column or two are
    // inked only where the stroke ran darkest — the border's all the same. A
    // form's day cell had its left border's fringe inked over a third of its
    // height, so no column at the very edge was "full" and the border became
    // the "0" of "05". Only on a piece taller than any letter (`fringe`): a
    // bold "l" whose stem ends two pixels under the fitted baseline is "full"
    // too, and stepping past its edge columns carved it as a border.
    let skip = 0
    while (skip < fringe && !full(edge + dir * skip)) skip++
    const start = edge + dir * skip
    let n = 0
    while (n <= maxW && full(start + dir * n)) n++
    if (!n || n > maxW || skip + n >= c.x1 - c.x0 - 1) continue
    const ruleCols = new Set<number>()
    for (let k = 0; k < skip + n; k++) ruleCols.add(edge + dir * k)
    const rule: number[] = [], rest: number[] = []
    for (const p of c.pix) (ruleCols.has(p % pageW) ? rule : rest).push(p)
    // What is left of the piece wholly outside the letters' band, touching
    // the border, is the border's too: a rounded box's corner curving from it
    // into the rule under the text. Left as a piece of its own it sat below
    // the baseline at the cell's edge, a column run of its own — and taken as
    // the first letter.
    const lo = ends ? ends.base + 1 : bottom
    moveOutsideBand(rule, rest, ruleCols, pageW, top, lo)
    return { rule, rest, x: start + dir * (n - 1) / 2 }
  }
  return null
}

/** Moves the components of `rest` lying wholly above row `top` or below row `lo` that touch a column of `cols` into `rule`. */
function moveOutsideBand(rule: number[], rest: number[], cols: Set<number>, pageW: number, top: number, lo: number): void {
  if (!rest.length) return
  const left = new Set(rest)
  const ruleSet = new Set(rule)
  const keep: number[] = []
  for (const seed of rest) {
    if (!left.has(seed)) continue
    left.delete(seed)
    const comp = [seed]
    for (let k = 0; k < comp.length; k++) {
      const p = comp[k], x = p % pageW
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        if ((dx < 0 && x === 0) || (dx > 0 && x === pageW - 1)) continue
        const q = p + dy * pageW + dx
        if (left.has(q)) { left.delete(q); comp.push(q) }
      }
    }
    let y0 = Infinity, y1 = -Infinity, touches = false
    for (const p of comp) {
      const x = p % pageW, y = (p - x) / pageW
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (!touches) for (const dx of [-1, 1]) if (cols.has(x + dx) && (ruleSet.has(p + dx) || ruleSet.has(p + dx - pageW) || ruleSet.has(p + dx + pageW))) touches = true
    }
    if (touches && (y0 >= lo || y1 <= top)) { for (const p of comp) rule.push(p) }
    else for (const p of comp) keep.push(p)
  }
  rest.length = 0
  for (const p of keep) rest.push(p)
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

/**
 * A word's pieces as runs of inked columns: pieces that share a column are
 * one run, and so are pieces that only TOUCH column to column when they are
 * steps of one stroke — one above the other, their rows barely overlapping.
 * A thin diagonal breaks into such a staircase at small sizes: each "/" of a
 * 7.8pt "09/08/2023" was three pieces in neighbouring columns, the date
 * counted fourteen runs for ten characters, was never exact, and changing its
 * day redrew it whole from figures off other lines, visibly heavier. Two
 * letters that merely touch stand side by side, rows overlapping, and stay
 * two runs.
 */
function inkSpans(pieces: Comp[]): { x0: number; x1: number; pieces: Comp[] }[] {
  const spans: { x0: number; x1: number; pieces: Comp[]; last: Comp }[] = []
  for (const c of [...pieces].sort((a, b) => a.x0 - b.x0)) {
    const sp = spans[spans.length - 1]
    const step = !!sp && c.x0 === sp.x1 && c.x0 === sp.last.x1 &&
      Math.min(c.y1, sp.last.y1) - Math.max(c.y0, sp.last.y0) < Math.min(c.y1 - c.y0, sp.last.y1 - sp.last.y0) * 0.3
    if (sp && (c.x0 < sp.x1 || step)) {
      sp.pieces.push(c)
      if (c.x1 >= sp.x1) { sp.x1 = c.x1; sp.last = c }
    } else spans.push({ x0: c.x0, x1: c.x1, pieces: [c], last: c })
  }
  return spans.map(({ x0, x1, pieces }) => ({ x0, x1, pieces }))
}

function columnRuns(pieces: Comp[]): number {
  return inkSpans(pieces).length
}

/** What a recogniser may write for a bullet: one of these at the reading's end means it named the bullet. */
const BULLET_LIKE = /[•·●◦▪■□○◆◇►▸‣⁃∙*oO0–—-]/

/**
 * Marks the ink word at either end of a line that is a list BULLET the
 * reading does not name: one piece, about square, solid (most of its box
 * inked) and with no counter. A letter that is all of that does not exist —
 * an "o" or a "0" has a hole, an "l" or an "I" is thin, a full stop is a fifth
 * of the size.
 */
function markBullets(words: { x0: number; x1: number; bullet?: boolean }[], pieces: Comp[], em: number, text: string, pageW: number): void {
  const t = text.trim()
  if (!t || words.length < 2) return
  const isBullet = (w: { x0: number; x1: number }) => {
    const ps = pieces.filter(c => c.x0 >= w.x0 - 1 && c.x1 <= w.x1 + 1)
    if (ps.length !== 1) return false
    const c = ps[0]
    const bw = c.x1 - c.x0, bh = c.y1 - c.y0
    if (bh < em * 0.3 || bh > em * 1.1 || bw < bh * 0.65 || bw > bh * 1.5) return false
    if (c.area < bw * bh * 0.68) return false
    // No counter: every pixel of the box the piece does not cover is
    // reached from the box's edge.
    const inBox = new Uint8Array(bw * bh)
    for (const p of c.pix) { const x = p % pageW - c.x0, y = (p - (p % pageW)) / pageW - c.y0; inBox[y * bw + x] = 1 }
    const seen = new Uint8Array(bw * bh)
    const stack: number[] = []
    for (let x = 0; x < bw; x++) for (const y of [0, bh - 1]) { const q = y * bw + x; if (!inBox[q] && !seen[q]) { seen[q] = 1; stack.push(q) } }
    for (let y = 0; y < bh; y++) for (const x of [0, bw - 1]) { const q = y * bw + x; if (!inBox[q] && !seen[q]) { seen[q] = 1; stack.push(q) } }
    while (stack.length) {
      const q = stack.pop()!
      const x = q % bw, y = (q - x) / bw
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue
        const r = yy * bw + xx
        if (!inBox[r] && !seen[r]) { seen[r] = 1; stack.push(r) }
      }
    }
    let holes = 0
    for (let q = 0; q < bw * bh; q++) if (!inBox[q] && !seen[q]) holes++
    return holes < 2
  }
  if (!BULLET_LIKE.test(t[0]) && isBullet(words[0])) words[0].bullet = true
  if (!BULLET_LIKE.test(t[t.length - 1]) && isBullet(words[words.length - 1])) words[words.length - 1].bullet = true
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
