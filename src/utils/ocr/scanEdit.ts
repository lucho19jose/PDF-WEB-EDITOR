import { cellRegion, looseRegion, analyzeLine, edgeWidthOf, domainOfLine, CORE, FRINGE, type PageInk, type LineInk } from './lineInk'
import { pickGlyph, pickGlyphRescaled, predictGap, lineMetrics, cellShapeOf, shapeOfCore, shapeAgreement, vocabKey, formKey, faceAt, type Atlas, type Exemplar, type FaceClass, type GlyphRequest } from './glyphAtlas'
import { expectedAdvance } from './glyphCut'
import { baselineAtOf } from './wordSeg'

/**
 * Editing a scanned line ON THE SCAN: the letters the edit keeps are the
 * scan's own pixels, the letters it adds are the page's own letters
 * (glyphAtlas.ts), and nothing the edit did not touch changes by one pixel.
 *
 * The plan, for one line:
 *  1. The old reading and the new text are aligned letter by letter. A word
 *     the edit only touches keeps its unchanged letters' pixels; a word it
 *     mostly rewrites, or one whose ink could not be cut into letters, is
 *     redrawn whole.
 *  2. The new line is laid out left to right. Everything before the first
 *     change stays where it is; every gap the edit did not touch keeps its
 *     width to the pixel (a justified line keeps its spacing); new gaps take
 *     the line's own word gap or the page's letter-gap model.
 *  3. The removed and moved letters' pixels are ERASED — filled from the
 *     paper behind them (`PageInk.paper`), never painted over with a flat
 *     colour — and the kept letters are printed at their new places, the new
 *     ones from their exemplars, by multiplying their transmittance onto the
 *     paper, as ink prints.
 *  4. An underline is carried along: extended with its own pixels under new
 *     letters, trimmed where letters went.
 *
 * All of it on a working copy of the page's native pixels; the caller turns
 * the pixels that changed into an overlay drawn exactly on the scan's grid.
 *
 * DOM-free.
 */

export interface GlyphImage {
  /** RGB transmittance, 0..255 (255 = paper). */
  t: Uint8ClampedArray
  /** Glyph pixels (core and fringe). */
  m: Uint8Array
  w: number
  h: number
  baseY: number
  inkL: number
  inkR: number
}

function imageOf(ex: Exemplar): GlyphImage {
  return { t: ex.t, m: ex.m, w: ex.w, h: ex.h, baseY: ex.baseY, inkL: ex.inkL, inkR: ex.inkR }
}

/**
 * A copy toned to another line's ink: its darkness scaled, per channel, by
 * how much darker (or lighter) that line prints than the line it came from.
 * A signature line printed a shade darker than the body text the letters were
 * borrowed from read as a lighter word set into it.
 */
function toned(g: GlyphImage, fromInk: [number, number, number], toInk: [number, number, number]): GlyphImage {
  // Each pixel's DARKNESS, as a share of the copy's own ink, printed in the
  // target line's ink: the hue is the line's, never the copy's. Scaled channel
  // by channel instead, a copy kept the colour fringes of where it was taken
  // from — JPEG chroma, a stamp's red — and a "123" borrowed into a grey form
  // came with a pink haze (ten levels of red over the green) the line around
  // it did not have.
  const lum = (r: number, gg: number, b: number) => (r * 299 + gg * 587 + b * 114) / 1000
  const fromDark = Math.max(1, 255 - lum(fromInk[0], fromInk[1], fromInk[2]))
  const toDark = Math.max(1, 255 - lum(toInk[0], toInk[1], toInk[2]))
  // How much darker the target's ink is, within the old bounds: a copy is
  // never made more than a third darker or a quarter lighter than it was.
  const k = Math.max(0.75, Math.min(1.35, toDark / fromDark))
  const scale = k * fromDark / toDark
  const t = new Uint8ClampedArray(g.t.length)
  for (let i = 0; i < g.w * g.h; i++) {
    const d = (255 - lum(g.t[i * 3], g.t[i * 3 + 1], g.t[i * 3 + 2])) / fromDark
    for (let c = 0; c < 3; c++) t[i * 3 + c] = 255 - d * scale * (255 - toInk[c])
  }
  return { ...g, t }
}

/**
 * A letter borrowed from the other weight, as dark as the line it goes into.
 * Re-weighing widens a regular letter's thinner strokes but not their paler
 * cores: borrowed into a bold date, the "s" and "t" of "septiembre" read grey
 * beside their neighbours. The median of its core-level pixels is brought to
 * the line's (`LineInk.coreDark`, measured the same way), never past the
 * line's own ink.
 */
function matchCore(g: GlyphImage, coreDark: number, ink: [number, number, number]): GlyphImage {
  const v: number[] = []
  for (let i = 0; i < g.w * g.h; i++) {
    const d = 1 - (g.t[i * 3] * 299 + g.t[i * 3 + 1] * 587 + g.t[i * 3 + 2] * 114) / 1000 / 255
    if (d >= CORE / 255) v.push(d)
  }
  if (v.length < 5) return g
  v.sort((a, b) => a - b)
  const med = v[Math.floor(v.length / 2)]
  if (med >= coreDark - 0.03) return g
  const k = Math.min(1.5, coreDark / med)
  const t = new Uint8ClampedArray(g.t.length)
  for (let i = 0; i < g.t.length; i++) t[i] = Math.max(Math.min(g.t[i], ink[i % 3]), 255 - (255 - g.t[i]) * k)
  return { ...g, t }
}

/**
 * Resample a glyph by `s`: Catmull-Rom on the transmittance, which keeps a
 * stem's edge as sharp as the scan's own where bilinear softened it (a resized
 * capital read visibly greyer than the scan's letters beside it).
 */
export function scaleImage(g: GlyphImage, s: number): GlyphImage {
  if (Math.abs(s - 1) < 1e-3) return g
  const w = Math.max(1, Math.round(g.w * s)), h = Math.max(1, Math.round(g.h * s))
  const t = new Uint8ClampedArray(w * h * 3).fill(255)
  const m = new Uint8Array(w * h)
  const cr = (x: number) => {
    const a = Math.abs(x)
    return a < 1 ? 1.5 * a ** 3 - 2.5 * a ** 2 + 1 : a < 2 ? -0.5 * a ** 3 + 2.5 * a ** 2 - 4 * a + 2 : 0
  }
  const T = (X: number, Y: number, c: number) => X < 0 || Y < 0 || X >= g.w || Y >= g.h ? 255 : g.t[(Y * g.w + X) * 3 + c]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = (x + 0.5) / s - 0.5, sy = (y + 0.5) / s - 0.5
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0
    let any = false
    for (let dy = -1; dy <= 2 && !any; dy++) for (let dx = -1; dx <= 2; dx++) {
      const X = x0 + dx, Y = y0 + dy
      if (X >= 0 && Y >= 0 && X < g.w && Y < g.h && g.m[Y * g.w + X] && Math.abs(dx - fx) < 1.5 && Math.abs(dy - fy) < 1.5) { any = true; break }
    }
    if (!any) continue
    for (let c = 0; c < 3; c++) {
      let acc = 0, wsum = 0
      for (let dy = -1; dy <= 2; dy++) {
        const wy = cr(dy - fy)
        for (let dx = -1; dx <= 2; dx++) {
          const wt = wy * cr(dx - fx)
          acc += T(x0 + dx, y0 + dy, c) * wt
          wsum += wt
        }
      }
      t[(y * w + x) * 3 + c] = acc / wsum
    }
    m[y * w + x] = 1
  }
  return { t, m, w, h, baseY: g.baseY * s, inkL: g.inkL * s, inkR: g.inkR * s }
}

/**
 * A glyph moved down by a fraction of a pixel, `fy` in (0, 1), resampled with
 * the same cubic kernel `scaleImage` uses. One row taller, so nothing of it is
 * cut off at the foot; the baseline goes down with the ink.
 */
export function shiftDown(g: GlyphImage, fy: number): GlyphImage {
  const w = g.w, h = g.h + 1
  const t = new Uint8ClampedArray(w * h * 3).fill(255)
  const m = new Uint8Array(w * h)
  const cr = (x: number) => {
    const a = Math.abs(x)
    return a < 1 ? 1.5 * a ** 3 - 2.5 * a ** 2 + 1 : a < 2 ? -0.5 * a ** 3 + 2.5 * a ** 2 - 4 * a + 2 : 0
  }
  for (let y = 0; y < h; y++) {
    const sy = y - fy, y0 = Math.floor(sy), f = sy - y0
    for (let x = 0; x < w; x++) {
      let any = false
      for (let dy = -1; dy <= 2; dy++) { const Y = y0 + dy; if (Y >= 0 && Y < g.h && g.m[Y * w + x] && Math.abs(dy - f) < 1.5) { any = true; break } }
      if (!any) continue
      for (let c = 0; c < 3; c++) {
        let acc = 0, wsum = 0
        for (let dy = -1; dy <= 2; dy++) {
          const Y = y0 + dy, wt = cr(dy - f)
          acc += (Y < 0 || Y >= g.h ? 255 : g.t[(Y * w + x) * 3 + c]) * wt
          wsum += wt
        }
        t[(y * w + x) * 3 + c] = acc / wsum
      }
      m[y * w + x] = 1
    }
  }
  return { ...g, t, m, w, h, baseY: g.baseY + fy }
}

/**
 * Thicken (dx > 0) or thin (dx < 0) a glyph's strokes by |dx| pixels across
 * and |dy| down — the weight of a letter the page holds only in the other
 * weight. At 200 DPI the difference between a face's regular and its bold is
 * mostly the stem: two pixels against three and a half.
 */
export function reweighImage(g: GlyphImage, dx: number, dy: number): GlyphImage {
  const grow = dx > 0
  const ex = grow ? Math.ceil(dx) : 0, ey = grow ? Math.ceil(Math.max(0, dy)) : 0
  const w = g.w + ex, h = g.h + ey
  const t = new Uint8ClampedArray(w * h * 3).fill(255)
  const m = new Uint8Array(w * h)
  const get = (x: number, y: number, c: number) => x < 0 || y < 0 || x >= g.w || y >= g.h ? 255 : g.t[(y * g.w + x) * 3 + c]
  const mOf = (x: number, y: number) => x >= 0 && y >= 0 && x < g.w && y < g.h && g.m[y * g.w + x] === 1
  // Horizontal pass into a temporary of the output's width, then vertical.
  const tmp = new Uint8ClampedArray(w * g.h * 3).fill(255)
  const tmpM = new Uint8Array(w * g.h)
  const ax = Math.abs(dx)
  for (let y = 0; y < g.h; y++) for (let x = 0; x < w; x++) {
    let mm = mOf(x, y)
    for (let c = 0; c < 3; c++) {
      let v = get(x, y, c)
      if (grow) {
        // The stroke's right edge moves right by dx: the pixel takes the
        // darkest of itself and the pixels up to dx to its left.
        for (let k = 1; k <= Math.ceil(ax); k++) {
          const f = Math.min(1, ax - (k - 1))
          const u = 255 - f * (255 - get(x - k, y, c))
          if (u < v) v = u
          if (c === 0 && mOf(x - k, y)) mm = true
        }
      } else {
        // The stroke's left edge moves right by |dx|: lighter where the
        // pixel to the left is lighter.
        const left = get(x - 1, y, c)
        if (left > v) v = v + Math.min(1, ax) * (left - v)
      }
      tmp[(y * w + x) * 3 + c] = v
    }
    if (mm) tmpM[y * w + x] = 1
  }
  const ay = Math.abs(dy)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gt = (yy: number, c: number) => yy < 0 || yy >= g.h ? 255 : tmp[(yy * w + x) * 3 + c]
    let mm = y < g.h && tmpM[y * w + x] === 1
    for (let c = 0; c < 3; c++) {
      let v = gt(y, c)
      if (grow && ay > 0) {
        const u = 255 - Math.min(1, ay) * (255 - gt(y - 1, c))
        if (u < v) v = u
        if (c === 0 && y - 1 >= 0 && y - 1 < g.h && tmpM[(y - 1) * w + x]) mm = true
      } else if (!grow && ay > 0) {
        const up = gt(y - 1, c)
        if (up > v) v = v + Math.min(1, ay) * (up - v)
      }
      t[(y * w + x) * 3 + c] = v
    }
    if (mm) m[y * w + x] = 1
  }
  return { t, m, w, h, baseY: g.baseY, inkL: g.inkL, inkR: g.inkR + (grow ? dx : 0) }
}

export interface EditOutcome {
  ok: boolean
  reason?: string
  /** Pixel box everything the edit wrote falls in (page px, [x0, x1) × [y0, y1)). */
  box?: { x0: number; y0: number; x1: number; y1: number }
  /** The new line's words, page px: ink extent and the baseline at the word's left edge. */
  words?: { text: string; x0: number; x1: number; base: number }[]
  /** What was done, for the status line and the sweep. */
  notes: string[]
  /** How each new character was drawn: 'k' kept in place, 'm' moved, 'g' an exemplar, 'w' an exemplar re-weighed or re-sized, 's' synthesised from a matched face. */
  drawn?: string
  /** When refused for want of letters: exactly the glyphs it lacked, for the caller to synthesise. */
  wanting?: GlyphWant[]
  /** Layout and underline decisions, for the lab. */
  debug?: { layout: string[]; underlines: string[] }
  /** Tokens the user corrected to what the ink already said: changed in the text layer only. */
  corrected?: number
  /** Ink words whose misreading was repaired from the page's own letters before the edit was planned. */
  repaired?: number
}

type Kind = 'orig' | 'synth'
interface NewChar {
  ch: string
  /** A space before it in the new text. */
  space: boolean
  kind: Kind
  /** The old character it keeps (orig). */
  old: number
  /** The old word its style comes from. */
  styleWord: number
  /** Old anchors: the old character its left / right edge stands where (-1 none). */
  anchorL: number
  anchorR: number
  /** Laid out: ink left, and for orig the shift. */
  x: number
  dx: number
  dy: number
  glyph?: GlyphImage
  drawnAs?: string
  /** A synthesised glyph's stand-in: the page's copy from text in the other kind of face, used if the line may not take that many made letters. */
  alt?: { glyph: GlyphImage; drawnAs: string }
}

/** Longest common subsequence alignment of two character lists, preferring contiguous runs: the matched index pairs. */
/** Characters drawn alike by design: at a small size their shapes cannot tell them apart. */
const LOOK_ALIKE = ['B8', 'O0', 'o0', 'D0', 'Q0', 'I1', 'l1', 'i1', 'Il', 'S5', 's5', 'Z2', 'z2', 'G6', 'b6', 'g9', 'q9', 'Oo', 'Ss', 'Zz', 'Cc', 'Vv', 'Ww', 'Xx', 'Uu']
function lookAlike(a: string, b: string): boolean {
  return LOOK_ALIKE.some(p => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a))
}

export function alignChars(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length
  // score[i][j]: best (matches * 4 + adjacency bonuses) aligning a[i:] and b[j:].
  const S = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  const run = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    let best = Math.max(S[i + 1][j], S[i][j + 1]), r = 0
    if (a[i] === b[j]) {
      // A match continuing a run is worth twice a lone one, so "iento" stays
      // one run rather than six letters picked from all over the old word
      // (which plain LCS prefers: six beats five).
      const v = S[i + 1][j + 1] + 2 + (run[i + 1][j + 1] > 0 ? 2 : 0)
      if (v >= best) { best = v; r = run[i + 1][j + 1] + 1 }
    }
    S[i][j] = best
    run[i][j] = r
  }
  const out: [number, number][] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (run[i][j] > 0) { out.push([i, j]); i++; j++ }
    else if (S[i + 1][j] >= S[i][j + 1]) i++
    else j++
  }
  return out
}


/** A glyph the page holds no copy of, at the size and weight a line needs it. */
export interface GlyphWant {
  char: string
  emPx: number
  xh: number | null
  capH: number | null
  bold: boolean
  /** The line's ink, RGB over its paper, 0..255. */
  ink: [number, number, number]
  /** How dark the line's letter cores print, 0..1 (`LineInk.coreDark`). */
  coreDark: number
  /** The line that wants it: a look is fitted to the line's own face, not the page's mix of faces. */
  line?: string
  /** Stem over em (lineInk's word weight) of the word it goes into — what its stems are re-weighed to; else the page's for its weight. */
  stem?: number | null
  /**
   * The characters that stem was measured on: the face is measured on the
   * same ones, and the letter takes the RATIO — a word's stem depends on its
   * letters' shapes (a curve or a diagonal is crossed wider than a stem), so
   * a "1" re-weighed to the raw stem of "09/08/2023" came out bold.
   */
  stemChars?: string | null
  /** How soft the line's stroke edges print, px (`edgeWidthOf`): what the letter is blurred to. */
  edge?: number | null
}

/** The key a synthesised glyph is cached under: the same letter at the same size and weight is the same glyph. */
export function wantKey(w: Pick<GlyphWant, 'char' | 'bold' | 'xh' | 'capH' | 'emPx'>): string {
  const size = w.xh ? `x${Math.round(w.xh * 2)}` : w.capH ? `c${Math.round(w.capH * 2)}` : `e${Math.round(w.emPx * 2)}`
  return `${w.char}|${w.bold ? 'b' : 'r'}|${size}`
}

export interface EditOptions {
  /** Glyphs synthesised for letters the page does not hold (glyphSynth.ts), looked up by `wantKey`. */
  synth?: Map<string, GlyphImage>
  /** The line is to be removed whole. */
  remove?: boolean
  /** The page's right text margin (px): a line that ended there before the edit is respaced to end there after it. */
  justifyTo?: number | null
  /** No line may end past this (px) — the paper's edge less a margin. */
  limitRight?: number | null
  /** The line is one of a column of figures set flush right (`alignedRight` in scanEditPage): it keeps its right edge. */
  columnRight?: boolean
  /** The page's analysed lines: what the line's own figures are too few to measure, its size's lines measure. */
  pageLines?: LineInk[]
}

/**
 * Apply one line's edit to `work` (the page's RGBA working copy, same size as
 * the raster). Returns what was drawn, or `ok: false` with why the line has to
 * be left to the vector redraw (a character no exemplar can supply, a line
 * that cannot be laid out).
 */
export function applyLineEdit(pi: PageInk, li: LineInk, atlas: Atlas, newText: string, work: Uint8ClampedArray, opts: EditOptions = {}): EditOutcome {
  if (opts.remove) return applyOnPixels(pi, li, atlas, '', work, opts)
  // The user's text is a better reading of the ink than the recogniser's
  // wherever the ink agrees with it — a user retypes a garbled line as it is
  // printed, plus the one change they meant. Read with that text, the line's
  // labels stop being shifted across words ("Productivoyuatro" shared as
  // "Productiv | o | yuatro" over "Productivo y cuatro" printed "y y cuatro"),
  // and only the words the ink does NOT confirm are planned as changes.
  const refined = refineReading(pi, li, atlas, newText)
  if (refined) {
    const res = applyOnPixels(pi, refined.li, atlas, newText, work, opts)
    if (res.ok) {
      if (refined.confirmed) res.notes.push(`${refined.confirmed} word${refined.confirmed > 1 ? 's' : ''} read from the text typed`)
      res.corrected = refined.confirmed
      return res
    }
    // Refused for want of letters: those are the letters to make. Falling
    // back instead had the caller synthesise for the OTHER plan, and the
    // refined one never got its letters.
    if (res.wanting?.length) return res
  }
  // REPAIR. More often the user edits the reading AS THE EDITOR SHOWED IT,
  // garbled words and all: "(5)laves" → "(6)laves" over ink that says
  // "(5) claves". Planned on that reading the "(5" word — one label short of
  // its ink — was redrawn whole, its ")" lost, and the line came out
  // "(6claves". The line's misread words are re-read from the page's own
  // letters, and the user's change is carried onto that reading
  // (`mergeReadings`): the change lands on the ink it was meant for, and
  // every word the user did not touch is the ink's own reading.
  const rep = repairReading(pi, li, atlas)
  if (rep) {
    const res = planWithCorrections(pi, rep.li, atlas, mergeReadings(li.text, newText, rep.text), work, opts)
    if (res.ok) {
      res.notes.push(`${rep.repaired} misread word${rep.repaired > 1 ? 's' : ''} re-read from the page's letters`)
      res.repaired = rep.repaired
      return res
    }
    if (res.wanting?.length) return res
  }
  return planWithCorrections(pi, li, atlas, newText, work, opts)
}

/**
 * CORRECTIONS. The reading was wrong and the user typed what the page
 * already says ("deinidos" → "definidos", "026" → "2026"): that word's ink
 * reads the new token, so not one of its pixels has to change — redrawing it
 * would only put the scan's letters back where they were, at best. Such
 * tokens are planned on the pixels as their OLD reading (untouched), and
 * only the text layer says what the user typed.
 */
function planWithCorrections(pi: PageInk, li: LineInk, atlas: Atlas, newText: string, work: Uint8ClampedArray, opts: EditOptions): EditOutcome {
  const fixes = findCorrections(pi, li, atlas, newText)
  if (!fixes.size) return applyOnPixels(pi, li, atlas, newText, work, opts)
  const userTokens = newText.split(/\s+/).filter(Boolean)
  const pixelTokens = userTokens.map((t, k) => fixes.get(k) ?? t)
  const res = applyOnPixels(pi, li, atlas, pixelTokens.join(' '), work, opts)
  if (!res.ok) return res
  if (res.words && res.words.length === userTokens.length) res.words.forEach((w, k) => { w.text = userTokens[k] })
  res.notes.push(`${fixes.size} misreading${fixes.size > 1 ? 's' : ''} corrected in the text only`)
  res.corrected = fixes.size
  return res
}

/**
 * The ink of characters [from, to) of `L` in runs of inked columns, left to
 * right: wherever letters stand apart, the n-th run IS the n-th letter.
 */
function columnRuns(pi: PageInk, L: LineInk, from: number, to: number): number[][] {
  const W = pi.s.w
  const byCol = new Map<number, number[]>()
  for (let i = from; i < to; i++) {
    const pix = L.cells[i].pix
    for (let q = 0; q < pix.length; q++) {
      const p = pix[q], x = p % W
      let list = byCol.get(x)
      if (!list) { list = []; byCol.set(x, list) }
      list.push(p)
    }
  }
  const xs = [...byCol.keys()].sort((a, b) => a - b)
  const runs: number[][] = []
  let cur: number[] = [], last = -9
  for (const x of xs) {
    if (x > last + 1 && cur.length) { runs.push(cur); cur = [] }
    for (const p of byCol.get(x)!) cur.push(p)
    last = x
  }
  if (cur.length) runs.push(cur)
  return runs
}

/**
 * Whether ink word `k` of `L` reads as its labels: cut one ink run per
 * letter, and every letter the page has an established shape for looking
 * like it — or, with none, not plainly like another letter. The letters in
 * `mustKnow` (indices into `L.chars`) are held to more: the page must have
 * an established shape for them and the ink must look like it. Those are the
 * letters a user's text CHANGES: taking a change for what the ink already
 * says drops the edit, so a letter the page cannot vouch for is never
 * evidence that it does — "(4)" retyped "(5)" on a page with no 5 in it
 * read as confirmed on its brackets alone, and nothing was drawn.
 */
function wordReadsAs(pi: PageInk, L: LineInk, atlas: Atlas, k: number, mustKnow?: Set<number>): boolean {
  const w = L.words[k]
  if (!w) return false
  const bold = atlas.boldAt !== null && (w.weight ?? 0) >= atlas.boldAt
  const n = w.to - w.from
  // Each letter's shape: from its cell when the cut is exact, else from the
  // word's ink split into runs of inked columns — when there are exactly as
  // many runs as letters (a cut can fail on a word whose letters stand apart).
  const shapes: (Float32Array | null)[] = []
  if (w.cut && w.exact) {
    for (let i = w.from; i < w.to; i++) shapes.push(cellShapeOf(pi, L, i))
  } else {
    const runs = columnRuns(pi, L, w.from, w.to)
    if (runs.length !== n) return false
    for (const r of runs) shapes.push(shapeOfCore(pi, L, r))
  }
  let checked = 0, passed = 0
  for (let i = w.from; i < w.to; i++) {
    const shape = shapes[i - w.from]
    if (!shape) continue
    const m = atlas.medoids.get(`${L.chars[i]}|${bold}`)
    const own = m ? shapeAgreement(shape, m.shape) : 0
    // A label shifted onto its neighbour's ink looks plainly like ANOTHER
    // letter: that refuses the word outright. A weak match alone does not —
    // a thin letter's established shape is a poor one (this page's "i"
    // agrees 0.24–0.44 with correct i's).
    let other = 0
    for (const [key, med] of atlas.medoids) {
      const bar = key.lastIndexOf('|')
      if (key.slice(bar + 1) !== String(bold) || key.slice(0, bar) === L.chars[i]) continue
      const a = shapeAgreement(shape, med.shape)
      if (a > other) other = a
    }
    if (other >= Math.max(0.8, own + 0.15)) return false
    if (mustKnow?.has(i) && (!m || own < Math.max(0.62, m.cohesion - 0.12))) return false
    if (!m) continue
    checked++
    if (own >= Math.max(0.58, m.cohesion - 0.16)) passed++
  }
  return checked >= Math.max(1, Math.ceil((w.to - w.from) * 0.6)) && passed >= checked * 0.7
}

/**
 * The line read again with the user's text wherever its ink confirms it.
 * Analysed with `newText` as the reading, each ink word whose letters look
 * like that text's keeps the user's words; every other ink word keeps the
 * recogniser's — those are the user's real changes. The line is analysed
 * once more with that mixed reading, and the edit is planned on it. Null when
 * the text confirms nothing the recogniser had not already read, or the line
 * cannot be analysed that way.
 */
/** The text without its diacritics: "SEDUCCIÓN" → "SEDUCCION". */
function stripMarks(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')
}

export function refineReading(pi: PageInk, li: LineInk, atlas: Atlas, newText: string, log?: (line: string) => void): { li: LineInk; confirmed: number } | null {
  const squash = (t: string) => t.replace(/\s+/g, '')
  if (squash(newText) === squash(li.text)) return null
  const lu = analyzeLine(pi, { id: li.id, text: newText, inkRect: li.inkRect, confidence: li.confidence }, { typed: true })
  if (!lu || !lu.words.length) { log?.('the line cannot be read with the typed text'); return null }
  const overlap = (a: { x0: number; x1: number }, b: { x0: number; x1: number }) =>
    Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0)
  const labelOf = (L: LineInk, w: LineInk['words'][number]) => {
    let t = ''
    for (let i = w.from; i < w.to; i++) { if (i > w.from && L.spaceAfter.has(i)) t += ' '; t += L.chars[i] }
    return t
  }
  const parts: { x0: number; text: string; spaceBefore: boolean }[] = []
  const used = new Set<number>()
  let confirmed = 0
  for (const v of li.words) {
    const ocr = labelOf(li, v)
    let text = ocr, spaceBefore = li.spaceAfter.has(v.from)
    const us = lu.words.map((w, k) => ({ w, k })).filter(({ w }) => overlap(v, w))
    // Only a one-to-one match of ink words: anything else is not the same word.
    if (us.length === 1 && li.words.filter(v2 => overlap(v2, us[0].w)).length === 1) {
      const { w, k } = us[0]
      used.add(k)
      const user = labelOf(lu, w)
      // The letters the typed word has and the recogniser's had not.
      const changed = new Set<number>()
      if (user !== ocr) {
        const typed = lu.chars.slice(w.from, w.to)
        const kept = new Set(alignChars(li.chars.slice(v.from, v.to), typed).map(([, j]) => j))
        typed.forEach((_, j) => { if (!kept.has(j)) changed.add(w.from + j) })
      }
      if (user === ocr) spaceBefore = lu.spaceAfter.has(w.from)
      // An ACCENT is never confirmed by the ink's shapes: an "O" and an "Ó"
      // are the same letter to them, and "SEDUCCIÓN" retyped "SEDUCCION" was
      // taken for what the ink already said — the accent stayed on the page
      // while the text layer dropped it. A change in marks alone is an edit.
      else if (stripMarks(user) === stripMarks(ocr)) log?.(`"${ocr}" -> "${user}" differs in marks only: an edit`)
      else if (wordReadsAs(pi, lu, atlas, k, changed)) { text = user; spaceBefore = lu.spaceAfter.has(w.from); confirmed++ }
      log?.(`"${ocr}" -> "${user}" cut=${w.cut} exact=${w.exact} ${text === user ? 'TYPED' : 'ocr'}`)
    } else log?.(`"${ocr}" -> ${us.length} typed words: kept`)
    parts.push({ x0: v.x0, text, spaceBefore })
  }
  // Ink the recogniser never read that the user's text names, and the ink confirms.
  lu.words.forEach((w, k) => {
    // Every letter of it is one the recogniser never read: all must be vouched for.
    const all = new Set<number>()
    for (let i = w.from; i < w.to; i++) all.add(i)
    if (used.has(k) || li.words.some(v => overlap(v, w)) || !wordReadsAs(pi, lu, atlas, k, all)) return
    parts.push({ x0: w.x0, text: labelOf(lu, w), spaceBefore: lu.spaceAfter.has(w.from) })
    confirmed++
  })
  if (!confirmed) return null
  parts.sort((a, b) => a.x0 - b.x0)
  const text = parts.map((p, i) => (i > 0 && p.spaceBefore ? ' ' : '') + p.text).join('')
  const ln = analyzeLine(pi, { id: li.id, text, inkRect: li.inkRect, confidence: li.confidence }, { typed: true })
  log?.(`refined: "${text}" ${ln ? 'analysed' : 'NOT analysed'}`)
  return ln ? { li: ln, confirmed } : null
}

/**
 * Tokens of `newText` (by index) that correct a misreading of the line, each
 * mapped to the OLD reading of the ink word it lands on.
 *
 * A token qualifies only when the ink answers for it better than for the old
 * reading: it lands on exactly one ink word and takes all of it; the word's
 * ink falls into exactly as many column runs as the token has letters; every
 * letter the token CHANGES looks like that letter's established shape on the
 * page (a letter the page holds no copy of is no evidence, and refuses) —
 * and, where the old reading had a letter there too, more like the new
 * letter than the old one. "2025" → "2026" over ink that says 2025 keeps the
 * 5 as a 5; only ink that already shows a 6 makes it a correction.
 */
export function findCorrections(pi: PageInk, li: LineInk, atlas: Atlas, newText: string): Map<number, string> {
  const out = new Map<number, string>()
  const tokens = newText.split(/\s+/).filter(Boolean)
  const chars: string[] = [], tokenOf: number[] = []
  tokens.forEach((t, k) => { for (const ch of t) { chars.push(ch); tokenOf.push(k) } })
  const pairs = alignChars(li.chars, chars)
  const matchOfNew = new Int32Array(chars.length).fill(-1)
  const matchOfOld = new Int32Array(li.chars.length).fill(-1)
  for (const [i, j] of pairs) { matchOfNew[j] = i; matchOfOld[i] = j }
  const agree = (run: Int32Array | number[], ch: string, bold: boolean): number | null => {
    const m = atlas.medoids.get(`${ch}|${bold}`)
    if (!m) return null
    const shape = shapeOfCore(pi, li, run)
    return shape ? shapeAgreement(shape, m.shape) : null
  }
  tokens.forEach((tok, k) => {
    const js: number[] = []
    for (let j = 0; j < chars.length; j++) if (tokenOf[j] === k) js.push(j)
    const words = new Set(js.filter(j => matchOfNew[j] >= 0).map(j => li.cells[matchOfNew[j]].word))
    if (words.size !== 1) return
    const wi = [...words][0]
    const w = li.words[wi]
    const old = li.chars.slice(w.from, w.to)
    if (old.join('') === tok) return
    // Marks alone are never a correction: the shapes cannot see them.
    if (stripMarks(old.join('')) === stripMarks(tok)) return
    // The whole word, and nothing of it in another token.
    for (let i = w.from; i < w.to; i++) if (matchOfOld[i] >= 0 && tokenOf[matchOfOld[i]] !== k) return
    const kept = js.filter(j => matchOfNew[j] >= 0).length
    if (kept < old.length * 0.5) return
    // The word's ink in runs of inked columns: one per letter of the token.
    const runs = columnRuns(pi, li, w.from, w.to)
    const letters = [...tok]
    if (runs.length !== letters.length) return
    // Each run IS one letter of the token, so none may be wider than a
    // letter: two that touch make one run, and deleting the first of them
    // ("VIRTUDES" → "VIRTUES" in a bold serif, its D against its E) left as
    // many runs as the token has letters — taken for a correction, the edit
    // changed the text and drew nothing.
    for (let r = 0; r < letters.length; r++) {
      let lo = Infinity, hi = -Infinity
      for (const p of runs[r]) { const x = p % pi.s.w; if (x < lo) lo = x; if (x > hi) hi = x }
      if ((hi - lo + 1) / li.fit.emPx > expectedAdvance(letters[r]) * 1.3 + 0.12) return
    }
    const bold = atlas.boldAt !== null && (w.weight ?? 0) >= atlas.boldAt
    // Old letters by position, when the reading only SUBSTITUTED letters.
    const sameLength = old.length === letters.length
    let unchangedOk = 0, unchangedChecked = 0
    for (let r = 0; r < letters.length; r++) {
      const j = js[r]
      const unchanged = matchOfNew[j] >= 0
      const a = agree(runs[r], letters[r], bold)
      const m = atlas.medoids.get(`${letters[r]}|${bold}`)
      if (unchanged) {
        if (a === null || !m) continue
        unchangedChecked++
        if (a >= Math.max(0.58, m.cohesion - 0.16)) unchangedOk++
        continue
      }
      // A changed letter: the page must know it, the ink must look like it…
      if (a === null || !m || a < Math.max(0.62, m.cohesion - 0.12)) return
      // …and more like it than like the letter the old reading put there.
      if (sameLength && old[r] !== letters[r]) {
        const b = agree(runs[r], old[r], bold)
        if (b !== null && a < b + 0.04) return
      }
    }
    // The unchanged letters vouch for the alignment of runs to letters.
    if (unchangedChecked && unchangedOk < Math.ceil(unchangedChecked * 0.6)) return
    out.set(k, old.join(''))
  })
  return out
}

/**
 * Where a character's ink sits about the baseline, in ems of the line (an em
 * of 1.92 x-heights): the span its top rises to and its bottom drops to.
 * Null for a character not modelled — no evidence either way.
 */
function extentOf(ch: string): { rise: [number, number]; drop: [number, number] } | null {
  if (/^[acemnorsuvwxz]$/.test(ch)) return { rise: [0.32, 0.58], drop: [-0.1, 0.1] }
  if (/^[áéóúàèòùâêôûäëöüñ]$/.test(ch)) return { rise: [0.7, 1], drop: [-0.1, 0.1] }
  if (/^[bdhkl]$/.test(ch)) return { rise: [0.62, 1], drop: [-0.1, 0.14] }
  if (ch === 'f') return { rise: [0.62, 1], drop: [-0.1, 0.25] }
  if (ch === 't') return { rise: [0.5, 0.85], drop: [-0.1, 0.14] }
  if (ch === 'i' || ch === 'í') return { rise: [0.55, 1], drop: [-0.1, 0.14] }
  if (/^[gpqy]$/.test(ch)) return { rise: [0.32, 0.58], drop: [0.12, 0.42] }
  if (ch === 'j') return { rise: [0.55, 1], drop: [0.12, 0.42] }
  if (/^[A-ZÁÉÍÓÚÑÜ0-9]$/.test(ch)) return { rise: [0.58, 1.05], drop: [-0.1, 0.16] }
  if (ch === '.') return { rise: [-0.05, 0.22], drop: [-0.1, 0.12] }
  if (ch === ',') return { rise: [-0.05, 0.25], drop: [0, 0.35] }
  if (ch === ':') return { rise: [0.3, 0.62], drop: [-0.1, 0.12] }
  if (ch === ';') return { rise: [0.3, 0.62], drop: [0, 0.35] }
  if ('()[]{}'.includes(ch)) return { rise: [0.58, 1.08], drop: [0.06, 0.42] }
  if ('-–—'.includes(ch)) return { rise: [0.12, 0.5], drop: [-0.5, -0.08] }
  // Quotes hang high, off the baseline altogether.
  if ('"“”\'‘’'.includes(ch)) return { rise: [0.55, 1.08], drop: [-0.85, -0.22] }
  return null
}

/**
 * Letters that never carry a piece standing apart on top. A run that has one —
 * a dot or an accent, cut off by an empty row — is none of them: the shapes
 * alone put "I", "l" and "i" within a few hundredths of each other, and read
 * "instalación" as "lnstalación". Only that way round: in bold type an accent
 * touches its letter, so a run without one may still be an "ó".
 */
const NO_DETACHED_TOP = /^[lI1|!aeouAEIOUnN]$/

/** Letters that hang below the baseline. */
const DESCENDS = /^[gjpqy]$/

/** The share of a line's kept letters its shapes must read right for it to be re-read. */
const READ_RATE = 0.8

/** A letter with the mark a Spanish text puts over it: the acute, or the tilde over n. */
const MARKED: Record<string, string> = { a: 'á', e: 'é', o: 'ó', u: 'ú', n: 'ñ', A: 'Á', E: 'É', O: 'Ó', U: 'Ú', N: 'Ñ' }

/** Characters drawn as two strokes side by side, by design. */
const TWO_STROKES = new Set(['"', '“', '”'])

/** An accented letter's plain form. */
const FOLD: Record<string, string> = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', à: 'a', è: 'e', ì: 'i', ò: 'o', ù: 'u', ü: 'u', Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ú: 'U' }
const fold = (c: string) => FOLD[c] ?? c
const classOf = (c: string) => /\p{Nd}/u.test(c) ? 'digit' : /\p{L}/u.test(c) ? 'letter' : 'mark'

/**
 * The line read again from the page's own letters: every ink word's column
 * runs, each against every letter the page has an established shape for (and
 * that could sit where the run sits about the baseline — an accent rises above
 * the x-height, a comma hangs at the foot of the line), and the recogniser's
 * labels aligned to the runs of the WHOLE line: a label kept where its run
 * looks like it, replaced where the run plainly looks like another letter,
 * dropped where no ink stands for it, and a letter added where ink stands that
 * no label names. Over the line, not word by word, because the labels were
 * shared among the ink's words by width: "presente contrato" read
 * "presentecontrat" was shared "present | econtrat", and a word on its own
 * cannot hand its "e" back. Every change costs, so the reading keeps the
 * recogniser's labels unless the ink plainly says otherwise.
 *
 * Per ink word: its new reading, or null where it keeps the old one
 * — a word that does not read well this way either keeps it outright, a guess
 * being worse than the old reading, which at least changes nothing.
 */
function rereadLine(pi: PageInk, li: LineInk, atlas: Atlas, log?: (line: string) => void, keepOld?: Set<number>): { texts: (string | null)[]; reads: boolean[] } {
  const W = pi.s.w
  const out: (string | null)[] = li.words.map(() => null)
  const readsAlready: boolean[] = li.words.map(() => false)
  const result = () => ({ texts: out, reads: li.words.map((_, k) => out[k] !== null || readsAlready[k]) })
  const { xh } = lineMetrics(li)
  // Heights are judged on the x-height where the line shows one: the em a
  // fit reports varies more than the letters do.
  const em = xh ? xh * 1.92 : li.fit.emPx
  const medsOf = (bold: boolean) => {
    const list: { ch: string; shape: Float32Array }[] = []
    for (const [key, m] of atlas.medoids) {
      const bar = key.lastIndexOf('|')
      if (key.slice(bar + 1) === String(bold)) list.push({ ch: key.slice(0, bar), shape: m.shape })
    }
    return list
  }
  const medsByWeight = { regular: medsOf(false), bold: medsOf(true) }
  // A small piece on top, cut off from the rest by an empty row: the row of
  // the cut, or -1.
  const topCut = (pix: ArrayLike<number>): number => {
    let top = Infinity, bottom = -Infinity, x0 = Infinity, x1 = -Infinity
    const rows = new Map<number, number>()
    for (let q = 0; q < pix.length; q++) {
      const p = pix[q], x = p % W, y = (p - x) / W
      if (y < top) top = y
      if (y > bottom) bottom = y
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      rows.set(y, (rows.get(y) ?? 0) + 1)
    }
    const base = baselineAtOf(li.fit)((x0 + x1) / 2)
    for (let y = top + 1, above = rows.get(top) ?? 0; y < bottom; y++) {
      const n = rows.get(y) ?? 0
      if (!n) return above > 0 && above <= pix.length * 0.4 && y < base - em * 0.3 ? y : -1
      above += n
    }
    return -1
  }
  // Whether the line's i's show their dot apart, read from its exact words:
  // where they do, a thin stroke with no dot is no "i" ("el" came back "ei").
  let iCells = 0, dotted = 0
  for (const w of li.words) if (w.cut && w.exact) for (let i = w.from; i < w.to; i++) {
    if ((li.chars[i] !== 'i' && li.chars[i] !== 'j') || !li.cells[i].pix.length) continue
    iCells++
    if (topCut(li.cells[i].pix) >= 0) dotted++
  }
  const iNeedsDot = iCells >= 2 && dotted >= iCells * 0.75
  // A capital stands no taller than the line's capitals: a stroke clearly
  // above them is an ascender ("la" came back "Ia").
  const { capH } = lineMetrics(li)
  const capRise = capH ? capH / em : null
  const TOL = 0.06
  const fits = (ch: string, g: { rise: number; drop: number; capped: boolean; ruled: boolean }) => {
    const e = extentOf(ch)
    if (NO_DETACHED_TOP.test(ch) && g.capped) return false
    if (iNeedsDot && (ch === 'i' || ch === 'j' || ch === 'í') && !g.capped) return false
    if (capRise !== null && /^[A-Z0-9]$/.test(ch) && g.rise > capRise + 0.07) return false
    // Over a rule a descender is cut off where it crosses: it may show none.
    const dropLo = g.ruled ? Math.min(e?.drop[0] ?? 0, -0.1) : e?.drop[0] ?? 0
    return !e || (g.rise >= e.rise[0] - TOL && g.rise <= e.rise[1] + TOL && g.drop >= dropLo - TOL && g.drop <= e.drop[1] + TOL)
  }
  // Every run of every word, left to right: where it sits, and how it looks
  // against every letter of its word's weight.
  type Run = {
    word: number; pix: number[]; x0: number; x1: number; n: number; g: { rise: number; drop: number; capped: boolean; ruled: boolean }
    agree: Map<string, number>; known: Set<string>; meds: { ch: string; shape: Float32Array }[]
    b1: string; a1: number; a2: number
    /** Its word mostly reads as its labels: replacing one takes more. */
    strict: boolean
  }
  const runs: Run[] = []
  li.words.forEach((w, k) => {
    const bold = atlas.boldAt !== null && (w.weight ?? 0) >= atlas.boldAt
    const meds = bold ? medsByWeight.bold : medsByWeight.regular
    const known = new Set(meds.map(m => m.ch))
    const strict = wordReadsAs(pi, li, atlas, k)
    readsAlready[k] = strict
    // The word's case: a letter added to a word in small letters is a small
    // letter — a thin stroke looks as much like an "I" as an "i".
    const own = li.chars.slice(w.from, w.to)
    const lower = own.filter(c => /\p{Ll}/u.test(c)).length, upper = own.filter(c => /\p{Lu}/u.test(c)).length
    const digits = own.filter(c => /\p{Nd}/u.test(c)).length
    const kind = lower > upper + digits ? 'lower' : upper > lower + digits ? 'upper' : digits > lower + upper ? 'digit' : ''
    // A word of letters takes no figure, and its FIRST letter may be a
    // capital whatever the rest are: read by the rest, the "S" of "Software"
    // was demoted to the "3" it looks like, and the "L" of "Licencia" to "l".
    const mark = (c: string) => !/\p{L}/u.test(c) && !/\p{Nd}/u.test(c)
    const ofKind = (c: string, first: boolean) => kind === 'lower' ? /\p{Ll}/u.test(c) || (first && /\p{Lu}/u.test(c)) || mark(c)
      : kind === 'upper' ? /\p{Lu}/u.test(c) || mark(c)
      : kind === 'digit' ? !/\p{L}/u.test(c) : true
    let nth = 0
    for (const pix of columnRuns(pi, li, w.from, w.to)) {
      const first = nth++ === 0
      let x0 = Infinity, x1 = -Infinity, top = Infinity, bottom = -Infinity
      for (const p of pix) {
        const x = p % W, y = (p - x) / W
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
      const base = baselineAtOf(li.fit)((x0 + x1) / 2)
      const cutRow = topCut(pix)
      // An underline, or the rule under a table cell, runs through where a
      // descender would hang: the "p" of "Upgrade" came back a "u".
      const xc = (x0 + x1) / 2
      const ruled = li.rules.some(rl => {
        if (rl.x0 > x1 || rl.x1 < x0) return false
        const ry = rl.y + rl.slope * (xc - rl.centreX)
        return ry >= base - em * 0.05 && ry <= base + em * 0.45
      })
      const g = { rise: (base - top) / em, drop: (bottom - base) / em, capped: cutRow >= 0, ruled }
      const shape = shapeOfCore(pi, li, pix)
      const agree = new Map<string, number>()
      if (shape) for (const m of meds) agree.set(m.ch, shapeAgreement(shape, m.shape))
      // An accented letter is read from the letter UNDER its mark as well:
      // judged whole, the mark outweighs the vowel, and "número" came back
      // "nómero" (ó 0.74 against ú 0.68) — a page may hold one copy of an
      // "ú", or none at all.
      if (cutRow >= 0) {
        const below = shapeOfCore(pi, li, pix.filter(p => (p - p % W) / W > cutRow))
        if (below) for (const m of meds) {
          const acc = MARKED[m.ch]
          if (!acc) continue
          const a = shapeAgreement(below, m.shape)
          if (a > (agree.get(acc) ?? 0)) agree.set(acc, a)
        }
      }
      // The letter it plainly is: the best of those that could sit there — an
      // accented one only when the plain one does clearly worse, the accent
      // being a few pixels a shape barely weighs — and how far ahead of every
      // letter that is not a form of it.
      // When the word's kind decides, its rivals are of that kind too: a
      // margin measured against the letter the kind rule set aside could
      // never be met.
      let cands = [...agree].filter(([ch]) => fits(ch, g)).sort((a, b) => b[1] - a[1])
      let best = cands[0]
      if (best && !ofKind(best[0], first)) {
        const inKind = cands.filter(c => ofKind(c[0], first))
        if (inKind[0] && inKind[0][1] >= best[1] - 0.08) { best = inKind[0]; cands = inKind }
      }
      if (best && fold(best[0]) !== best[0]) {
        const plain = cands.find(c => c[0] === fold(best[0]))
        if (plain && plain[1] >= best[1] - 0.05) best = plain
      }
      const b1 = best?.[0] ?? ''
      runs.push({
        word: k, pix, x0, x1: x1 + 1, n: pix.length, g, agree, known, meds, strict,
        b1, a1: best?.[1] ?? 0, a2: cands.find(c => fold(c[0]) !== fold(b1))?.[1] ?? 0
      })
    }
  })
  const labels = li.chars
  const N = labels.length, M = runs.length
  if (!M || medsByWeight.regular.length + medsByWeight.bold.length < 8) return result()
  const masses = runs.map(r => r.n).sort((a, b) => a - b)
  const midMass = masses[Math.floor(masses.length / 2)] || 1
  // A small blob at the foot of the line: a full stop on the baseline, a
  // comma hanging below it — or nothing the place can name.
  const markAt = (r: Run): string => {
    if (r.n > midMass * 0.5 || r.x1 - r.x0 > li.fit.emPx * 0.3 || r.g.rise > 0.3) return ''
    if (r.g.drop >= 0.06 && r.g.drop <= 0.4) return ','
    return r.g.rise <= 0.22 ? '.' : ''
  }
  // Two neighbouring runs of one word as ONE letter (a letter broken in the scan).
  const pairShape = new Map<number, Float32Array | null>()
  const pairAgree = (j: number, ch: string) => {
    if (!pairShape.has(j)) pairShape.set(j, shapeOfCore(pi, li, [...runs[j].pix, ...runs[j + 1].pix]))
    const shape = pairShape.get(j)!
    const m = runs[j].meds.find(m => m.ch === ch)
    return shape && m ? shapeAgreement(shape, m.shape) : 0
  }
  type Op = { op: 'keep' | 'sub' | 'ins' | 'del' | 'noise' | 'two' | 'broken'; text: string; fit: number; run: number; label: number; labels: number }
  const INF = Number.POSITIVE_INFINITY
  const cost = Array.from({ length: N + 1 }, () => new Float64Array(M + 1).fill(INF))
  const back: ({ i: number; j: number; o: Op } | null)[][] = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(null))
  cost[0][0] = 0
  const relax = (i0: number, j0: number, i: number, j: number, c: number, o: Op) => {
    const v = cost[i0][j0] + c
    if (v < cost[i][j]) { cost[i][j] = v; back[i][j] = { i: i0, j: j0, o } }
  }
  const SUB = 0.25, INS = 0.3, DEL = 0.8
  for (let i = 0; i <= N; i++) for (let j = 0; j <= M; j++) {
    if (cost[i][j] === INF) continue
    const r = j < M ? runs[j] : null
    if (i < N && r) {
      const ch = labels[i]
      const sits = fits(ch, r.g)
      // The label kept on this run: as good as the run looks like it. A label
      // the page holds no shape for is no evidence either way — unless it
      // could not sit where the run sits.
      const own = r.known.has(ch) ? (r.agree.get(ch) ?? 0) : -1
      const keepFit = own >= 0 ? 1 - own + (sits ? 0 : 0.3) : sits ? 0.3 : 0.65
      relax(i, j, i + 1, j + 1, keepFit, { op: 'keep', text: ch, fit: keepFit, run: j, label: i, labels: 1 })
      // …or replaced by the letter the run plainly is. A digit the page has
      // no shape for is never taken for a letter that happens to be like it
      // ("5" and "S"): only for one of its own kind, or where it cannot sit.
      if (r.b1 && r.b1 !== ch && r.a1 >= 0.72 && r.a1 - r.a2 >= 0.03 && !(r.g.ruled && DESCENDS.test(ch) && !DESCENDS.test(r.b1)) &&
          (own >= 0 ? r.a1 >= own + (sits ? (r.strict ? 0.25 : 0.15) : 0.05) : !sits || (classOf(ch) === classOf(r.b1) && r.a1 >= 0.85))) {
        relax(i, j, i + 1, j + 1, 1 - r.a1 + SUB, { op: 'sub', text: r.b1, fit: 1 - r.a1, run: j, label: i, labels: 1 })
      }
      // Letters that touch, two to four in one run ("00/" in "00/100").
      for (let k = 2, want = expectedAdvance(ch) * li.fit.emPx; k <= 4 && i + k <= N; k++) {
        want += expectedAdvance(labels[i + k - 1]) * li.fit.emPx
        if (r.x1 - r.x0 >= want * 0.7) relax(i, j, i + k, j + 1, 0.5 * (k - 1), { op: 'two', text: labels.slice(i, i + k).join(''), fit: 0.4, run: j, label: i, labels: k })
      }
      // One letter broken into two runs: only when the second run makes it
      // MORE like the letter — a "v" and the "o" beside it are not a "v".
      if (j + 1 < M && runs[j + 1].word === r.word && r.known.has(ch) && runs[j + 1].x0 - r.x1 <= Math.max(1, li.fit.emPx * 0.06)) {
        const a = pairAgree(j, ch)
        if (a > Math.max(own, runs[j + 1].agree.get(ch) ?? 0) + 0.05) relax(i, j, i + 1, j + 2, 1 - a + 0.1, { op: 'broken', text: ch, fit: 1 - a, run: j, label: i, labels: 1 })
      }
      // A character drawn in separate strokes by design — a double quote's
      // two ticks — that the page holds no shape for: two neighbouring runs
      // that both sit where it sits are that one character, at the price of
      // any unknown label that sits. Read as two, the second tick took the
      // next label and the letter it belonged to was read twice: `("Software")`
      // came back `("SSoftware"))`.
      if (j + 1 < M && runs[j + 1].word === r.word && !r.known.has(ch) && TWO_STROKES.has(ch) && sits && fits(ch, runs[j + 1].g) &&
          runs[j + 1].x0 - r.x1 <= Math.max(2, li.fit.emPx * 0.15)) {
        relax(i, j, i + 1, j + 2, 0.3, { op: 'broken', text: ch, fit: 0.3, run: j, label: i, labels: 1 })
      }
    }
    // A label with no ink of its own.
    if (i < N) relax(i, j, i + 1, j, DEL, { op: 'del', text: '', fit: -1, run: -1, label: i, labels: 1 })
    if (r) {
      // Ink no label names: the letter it plainly is…
      // (An ambiguous one — an "o" barely ahead of an "a" — at a price, not
      // refused: refused, the alignment accounted for the run worse, keeping
      // the "d" of "calculad" on the "o" of "calculado".)
      if (r.b1 && r.a1 >= 0.7) relax(i, j, i, j + 1, 1 - r.a1 + INS + Math.max(0, 0.06 - (r.a1 - r.a2)) * 3, { op: 'ins', text: r.b1, fit: 1 - r.a1, run: j, label: -1, labels: 0 })
      // …or the full stop or comma its place says it is. A mark's shape is a
      // blob the atlas barely knows, so the shapes never name it; where it
      // sits does. Unnamed, the comma after "Perú" took the "ú" label and the
      // "ú" itself was read as a "d": "Perdú".
      const mark = markAt(r)
      if (mark) relax(i, j, i, j + 1, INS + 0.15, { op: 'ins', text: mark, fit: 0.3, run: j, label: -1, labels: 0 })
      // …or a speck that looks like nothing.
      if (r.n < midMass * 0.15 && r.x1 - r.x0 < li.fit.emPx * 0.15 && r.a1 < 0.65) relax(i, j, i, j + 1, 0.05, { op: 'noise', text: '', fit: -1, run: j, label: -1, labels: 0 })
    }
  }
  if (cost[N][M] === INF) return result()
  const ops: Op[] = []
  for (let i = N, j = M; i > 0 || j > 0;) {
    const b = back[i][j]
    if (!b) return result()
    ops.push(b.o)
    i = b.i; j = b.j
  }
  ops.reverse()
  // The page's shapes must be able to read this line at all: where the
  // alignment KEEPS a label, the run should plainly be that letter. On a
  // form whose small bold letters the atlas cannot tell apart, "Normal" read
  // as "e" for its "o" and "a" and came back "Normel", "Valorización"
  // "Valorizacien" — the re-read is worse than the recogniser there, and
  // where too few kept letters are judged it cannot be told, so nothing is
  // changed. Thin strokes count as agreeing with each other.
  {
    const thin = (c: string) => /^[iIl1|íìj!]$/.test(c)
    const same = (a: string, b: string) => fold(a.toLowerCase()) === fold(b.toLowerCase()) || (thin(a) && thin(b))
    let judged = 0, agreeing = 0
    for (const o of ops) {
      if (o.op !== 'keep' || o.run < 0 || !runs[o.run].known.has(o.text) || !runs[o.run].b1) continue
      judged++
      if (same(runs[o.run].b1, o.text)) agreeing++
    }
    log?.(`shapes read the kept letters: ${agreeing} of ${judged}`)
    if (judged < 8 || agreeing < judged * READ_RATE) return result()
  }
  // Each op to its word: a dropped label to the word of the next run.
  const wordOf = new Array<number>(ops.length).fill(-1)
  let nextWord = runs[M - 1].word
  for (let q = ops.length - 1; q >= 0; q--) {
    if (ops[q].run >= 0) nextWord = runs[ops[q].run].word
    wordOf[q] = nextWord
  }
  const labelOf = (w: LineInk['words'][number]) => labels.slice(w.from, w.to).join('')
  const range = li.words.map(() => ({ lo: Infinity, hi: -Infinity }))
  li.words.forEach((w, k) => {
    const mine = ops.filter((_, q) => wordOf[q] === k)
    for (const o of mine) if (o.label >= 0) { range[k].lo = Math.min(range[k].lo, o.label); range[k].hi = Math.max(range[k].hi, o.label + o.labels) }
    // A mark with no ink of its own found is not shown to be absent — a
    // colon's dots are specks, and "PROYECTO:" came back "PROYECTO" — so a
    // dropped mark stays.
    const markKept = (o: Op) => o.op === 'del' && !/\p{L}/u.test(labels[o.label]) && !/\p{Nd}/u.test(labels[o.label])
    const text = mine.map(o => markKept(o) ? labels[o.label] : o.text).join('')
    const old = labelOf(w)
    const changes = mine.filter(o => (o.op === 'sub' || o.op === 'ins' || o.op === 'del') && !markKept(o)).length
    const scored = mine.filter(o => o.fit >= 0)
    const meanFit = scored.reduce((t, o) => t + o.fit, 0) / Math.max(1, scored.length)
    // A small letter followed by a capital inside one word ("eL") is a thin
    // stroke read as the wrong one of "l", "I", "L" — unless the reading had
    // that shape already.
    const oddCase = /\p{Ll}\p{Lu}/u.test(text) && !/\p{Ll}\p{Lu}/u.test(old)
    // Ink taller than any letter, that looks like none, is something drawn
    // over the word — a signature's stroke, a stamp's edge — and the word
    // under it cannot be read from its runs: "Add-Ons" came back "Adddnns".
    const marked = mine.some(o => o.run >= 0 && runs[o.run].g.rise + runs[o.run].g.drop > 1.25 && runs[o.run].a1 < 0.6)
    const ok = text !== old && text.length > 0 && scored.length > 0 && meanFit <= 0.33 && !oddCase && !marked && changes <= Math.max(2, Math.ceil(Math.max(old.length, text.length) * 0.5))
    log?.(`"${old}" -> "${text}" ${mine.map(o => `${o.op}${o.text ? ':' + o.text : ''}`).join(' ')} fit ${meanFit.toFixed(2)}${ok ? '' : text === old ? '' : ' REFUSED'}`)
    // The runs of a word read differently, each with its three best letters.
    if (log && text !== old) for (const o of mine) {
      if (o.run < 0) continue
      const r = runs[o.run]
      const top = [...r.agree].filter(([ch]) => fits(ch, r.g)).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([ch, v]) => `${ch}${v.toFixed(2)}`).join(' ')
      log(`      run ${o.run} x ${r.x0}-${r.x1} rise ${r.g.rise.toFixed(2)} drop ${r.g.drop.toFixed(2)} ${o.op}:${o.text} chosen ${r.b1} ${r.a1.toFixed(2)} next ${r.a2.toFixed(2)} | ${top}`)
    }
    if (ok) out[k] = text
  })
  // Words held to their old labels by the caller (`repairReading`'s
  // vocabulary check).
  if (keepOld) for (const k of keepOld) out[k] = null
  // A word that keeps its old labels keeps ALL of them: a neighbour the
  // alignment gave one of those labels to keeps its own too, or the label
  // would be read twice — and a neighbour whose labels the kept word's
  // alignment took keeps ITS old ones, or they would be read by nobody
  // (refused "N" → "N2" took the "2" of "2039277697", which came back
  // "039277697").
  for (let changed = true; changed;) {
    changed = false
    li.words.forEach((w, k) => {
      if (out[k] !== null) return
      li.words.forEach((w2, k2) => {
        if (out[k2] === null || k2 === k) return
        if ((range[k2].lo < w.to && range[k2].hi > w.from) || (range[k].lo < w2.to && range[k].hi > w2.from)) { out[k2] = null; changed = true }
      })
    })
  }
  return result()
}

/** A reading repaired from the page's own letters — see `repairReading`. */
export interface RepairedReading {
  text: string
  li: LineInk
  /** Ink words read differently from the recogniser. */
  repaired: number
}

/**
 * The line's reading repaired wherever the recogniser's labels do not fit the
 * ink (`rereadLine`), with a space wherever the ink shows a word's gap — the
 * recogniser drops letters at word joins ("(5) claves" read "(5)laves"), and
 * shares what it read out shifted by a letter across whole words. Null when
 * nothing needed repairing, or the repaired reading cannot be analysed.
 */
export function repairReading(pi: PageInk, li: LineInk, atlas: Atlas, log?: (line: string) => void): RepairedReading | null {
  const labelOf = (w: LineInk['words'][number]) => {
    let t = ''
    for (let i = w.from; i < w.to; i++) { if (i > w.from && li.spaceAfter.has(i)) t += ' '; t += li.chars[i] }
    return t
  }
  const em = li.fit.emPx
  const wordGap = li.wordGapPx > 0 ? li.wordGapPx : Math.min(0.6, Math.max(0.25, atlas.wordGapEm)) * em
  const keepOld = new Set<number>()
  for (let round = 0; round < 4; round++) {
    const { texts: fixed, reads } = rereadLine(pi, li, atlas, round ? undefined : log, keepOld)
    const repaired = fixed.filter(f => f !== null).length
    if (!repaired) return null
    let text = ''
    li.words.forEach((w, k) => {
      // A word's gap the reading missed is put back only between words whose
      // labels fit their ink: between two that do not, the gap is not where the
      // labels part ("l\"|Contrato\"" over ink saying "el \"Contrato\"").
      const inkGap = w.x0 - li.words[k - 1]?.x1 >= wordGap * 0.6 && reads[k] && reads[k - 1]
      if (k > 0 && (li.spaceAfter.has(w.from) || inkGap)) text += ' '
      text += fixed[k] ?? labelOf(w)
    })
    if (text === li.text) return null
    const stray = wordsLeavingVocab(li, text, atlas, log)
    const fresh = [...stray].filter(k => !keepOld.has(k))
    if (stray.size) {
      if (!fresh.length) return null
      for (const k of fresh) keepOld.add(k)
      continue
    }
    text = lookalikeFix(li, text, atlas, log)
    const ln = analyzeLine(pi, { id: li.id, text, inkRect: li.inkRect, confidence: li.confidence })
    log?.(`repaired: "${text}" ${ln ? 'analysed' : 'NOT analysed'}`)
    return ln ? { text, li: ln, repaired } : null
  }
  return null
}

/**
 * Whether a repaired reading may stand in for the recogniser's where nobody
 * asked for it — the reading the editor opens on for a line the user has not
 * touched (`repairReadings` in useOCR). Held to more than an edit's repair:
 *
 * - **Prose only** — three ink words, fifteen letters, mostly small letters.
 *   That is where the recogniser loses the spaces and letters at word joins,
 *   and where the page's letters read well. A table of names in capitals is
 *   neither: a cell border or a speck after a name has no label, the
 *   alignment shifts the letters onto it, and "TAHIWA" came back "TAHIHIWA".
 * - **No figure changes** — a wrong letter in a word reads as a typo; a wrong
 *   figure in an amount or an ID number reads as the document's, and an RUC
 *   came back with a "5" in the wrong place.
 *
 * An edit's own repair (`applyLineEdit`) is not held to this: the user is
 * changing the line, and the repair only steers where the change lands.
 */
export function repairIsDisplayable(li: LineInk, text: string): boolean {
  if (!isProseLine(li)) return false
  // A mark put in front of a line the recogniser started on a word is a
  // bullet read as the nearest glyph the page has ("*" for "•").
  const first = text.trim().split(/\s+/)[0] ?? ''
  if (first && !/[\p{L}\p{N}]/u.test(first) && !li.text.trim().startsWith(first)) return false
  return li.text.replace(/\D/g, '') === text.replace(/\D/g, '')
}

/**
 * A line of prose: three ink words, fifteen letters, mostly small letters —
 * asked BEFORE a line is re-read for the editor, so a page of table cells
 * costs nothing (the re-read of 500 cells took a dense page 17 s longer).
 */
export function isProseLine(li: LineInk): boolean {
  const letters = [...li.text].filter(c => /\p{L}/u.test(c))
  const lower = letters.filter(c => /\p{Ll}/u.test(c)).length
  return li.words.length >= 3 && letters.length >= 15 && lower >= letters.length * 0.5
}

/** Strokes the shapes cannot tell apart in most faces. */
const LOOKALIKE: Record<string, string[]> = { i: ['l'], l: ['i', 'I'], I: ['l'], 'ó': ['ú'], 'ú': ['ó'], 'á': ['í'], 'í': ['á'], v: ['y'], y: ['v'] }

/**
 * A word the re-read made that the document reads nowhere, one lookalike
 * stroke from a word it reads at least twice, is that word: "ei" is "el",
 * "Ia" is "la" — a thin stroke is an "i", an "l" or an "I" in most faces, and
 * the shapes cannot say which. Only for the words the re-read changed: the
 * recogniser's own readings stay as it read them.
 */
function lookalikeFix(li: LineInk, text: string, atlas: Atlas, log?: (line: string) => void): string {
  const forms = atlas.forms
  if (!forms?.size) return text
  const old = new Set(li.text.split(/\s+/).map(formKey))
  return text.split(' ').map(tok => {
    const core = formKey(tok)
    if (core.length < 2 || old.has(core) || (forms.get(core) ?? 0) > 0) return tok
    const chars = [...core]
    for (let i = 0; i < chars.length; i++) for (const alt of LOOKALIKE[chars[i]] ?? []) {
      // "va" and "ya" are both words: a two-letter v/y swap decides nothing.
      if ((alt === 'v' || alt === 'y') && chars.length < 3) continue
      const v = [...chars.slice(0, i), alt, ...chars.slice(i + 1)].join('')
      if ((forms.get(v) ?? 0) >= 2) {
        log?.(`"${core}" read as "${v}", a word of the document`)
        return tok.replace(core, v)
      }
    }
    return tok
  }).join(' ')
}

/**
 * A word the document reads elsewhere is not re-read into one it reads
 * nowhere. The shapes confuse letters a reader never would — "Limitado" came
 * back "Lmitado" (its "i" touching the "m"), "Upgrade" "Uugrade", "o
 * Licencia:" "ooi Ucencia:" over an underline that had cut the descenders off
 * — while the same words, read the same way on other lines, say what they
 * are. Each token of the old reading that is a word of the document (read
 * elsewhere: three letters once, two letters three times) is followed into
 * the new text by aligning the two letter by letter; unless it comes back
 * intact, or only as words the document also reads, the ink words holding
 * its letters are returned — to keep their old labels.
 */
function wordsLeavingVocab(li: LineInk, text: string, atlas: Atlas, log?: (line: string) => void): Set<number> {
  const out = new Set<number>()
  const vocab = atlas.vocab
  if (!vocab?.size) return out
  const own = new Map<string, number>()
  for (const t of li.text.split(/\s+/)) { const v = vocabKey(t); if (v) own.set(v, (own.get(v) ?? 0) + 1) }
  const known = (v: string) => { const e = (vocab.get(v) ?? 0) - (own.get(v) ?? 0); return v.length >= 3 ? e >= 1 : v.length === 2 && e >= 3 }
  const labels = li.chars
  const N = labels.length
  const newToks = text.split(/\s+/).filter(Boolean)
  const newChars: string[] = [], tokOf: number[] = []
  newToks.forEach((t, ti) => { for (const c of t) { newChars.push(c); tokOf.push(ti) } })
  const toNew = new Map<number, number>(alignChars(labels, newChars))
  for (let i = 1, s = 0; i <= N; i++) {
    if (i < N && !li.spaceAfter.has(i)) continue
    const a = s, b = i
    s = i
    const v = vocabKey(labels.slice(a, b).join(''))
    if (!v || !known(v)) continue
    const js: number[] = []
    for (let p = a; p < b; p++) { const j = toNew.get(p); if (j !== undefined) js.push(j) }
    const now = [...new Set(js.map(j => tokOf[j]))].map(ti => newToks[ti])
    if (now.length && now.every(t => { const nv = vocabKey(t); return !nv || nv === v || (vocab.get(nv) ?? 0) >= 1 })) continue
    // Letters only ADDED at its edges leave the word as it was read: "no"
    // was "uno" with its "u" lost, and a misreading the recogniser repeats
    // ("mitidas" for "emitidas") is a "word of the document" too. Unless the
    // added letter repeats the one beside it — a broken letter's second half
    // read as another copy ("Precio" came back "Precioo").
    if (js.length === b - a && js.every((j, q) => j === js[0] + q) && now.length === 1) {
      const ti = tokOf[js[0]]
      let t0 = js[0], t1 = js[js.length - 1]
      while (t0 > 0 && tokOf[t0 - 1] === ti) t0--
      while (t1 + 1 < newChars.length && tokOf[t1 + 1] === ti) t1++
      const same = (x: string | undefined, y: string | undefined) => x !== undefined && y !== undefined && x.toLowerCase() === y.toLowerCase()
      const doubled = (t0 < js[0] && same(newChars[js[0] - 1], labels[a])) || (t1 > js[js.length - 1] && same(newChars[js[js.length - 1] + 1], labels[b - 1]))
      if (!doubled) continue
    }
    log?.(`"${labels.slice(a, b).join('')}" is a word of the document; ${now.length ? `"${now.join(' ')}" is not` : 'it is gone'}: kept`)
    li.words.forEach((w, k) => { if (w.from < b && w.to > a) out.add(k) })
  }
  return out
}

/** Where `b` differs from `a`: each stretch of `a` [a0, a1) and what `b` has in its place. */
function hunksOf(a: string[], b: string[]): { a0: number; a1: number; text: string }[] {
  const out: { a0: number; a1: number; text: string }[] = []
  let pa = 0, pb = 0
  for (const [i, j] of [...alignChars(a, b), [a.length, b.length] as [number, number]]) {
    if (i > pa || j > pb) out.push({ a0: pa, a1: i, text: b.slice(pb, j).join('') })
    pa = i + 1
    pb = j + 1
  }
  return out
}

/**
 * The user's change carried onto a repaired reading: a three-way merge of
 * the recogniser's reading (`base`, what the editor showed), the text the
 * user typed over it, and the reading repaired from the ink. Where only one
 * side changed a stretch it is taken; where both did, the user's text wins
 * — keeping a word gap the ink shows at either end of it — unless the two
 * agree. "(5)laves" edited to "(6)laves" over ink repaired as "(5) claves"
 * becomes "(6) claves".
 */
export function mergeReadings(base: string, user: string, repair: string): string {
  const O = [...base]
  const all = [
    ...hunksOf(O, [...user]).map(h => ({ ...h, side: 'u' as const })),
    ...hunksOf(O, [...repair]).map(h => ({ ...h, side: 'r' as const }))
  ].sort((x, y) => x.a0 - y.a0 || x.a1 - y.a1)
  let out = '', cur = 0
  for (let g = 0; g < all.length;) {
    const u0 = all[g].a0
    let u1 = all[g].a1, e = g + 1
    while (e < all.length && all[e].a0 <= u1) { u1 = Math.max(u1, all[e].a1); e++ }
    const group = all.slice(g, e)
    const versionOf = (side: 'u' | 'r') => {
      let t = '', p = u0
      for (const h of group) if (h.side === side) { t += O.slice(p, h.a0).join('') + h.text; p = h.a1 }
      return t + O.slice(p, u1).join('')
    }
    out += O.slice(cur, u0).join('')
    const sides = new Set(group.map(h => h.side))
    if (sides.size === 1) out += versionOf(group[0].side)
    else {
      const u = versionOf('u'), r = versionOf('r')
      let t = u
      if (u !== r) {
        if (/^\s/.test(r) && !/^\s/.test(u) && out && !/\s$/.test(out)) t = ' ' + t
        if (/\s$/.test(r) && !/\s$/.test(t)) t += ' '
      }
      out += t
    }
    cur = u1
    g = e
  }
  out += O.slice(cur).join('')
  return out.replace(/\s{2,}/g, ' ').trim()
}

/** The edit as planned on the pixels — see `applyLineEdit`. */
function applyOnPixels(pi: PageInk, li: LineInk, atlas: Atlas, newText: string, work: Uint8ClampedArray, opts: EditOptions = {}): EditOutcome {
  const s = pi.s
  const W = s.w
  const notes: string[] = []
  const em = li.fit.emPx
  const base = baselineAtOf(li.fit)
  const { xh, capH, figH } = lineMetrics(li, { loose: true })
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  const touch = (p: number) => {
    const x = p % W, y = (p - x) / W
    if (x < box.x0) box.x0 = x
    if (x + 1 > box.x1) box.x1 = x + 1
    if (y < box.y0) box.y0 = y
    if (y + 1 > box.y1) box.y1 = y + 1
  }

  const oldChars = li.chars
  const text = opts.remove ? '' : newText
  const newList: { ch: string; space: boolean }[] = []
  {
    let pending = false
    for (const ch of text) {
      if (ch === ' ' || ch === ' ' || ch === '\t') { pending = newList.length > 0; continue }
      newList.push({ ch, space: pending })
      pending = false
    }
  }

  // The weight a redrawn character is set in: its word's, or the line's.
  const lineWeights = li.words.map(w => w.weight).filter((w): w is number => w !== null)
  const lineWeight = lineWeights.length ? [...lineWeights].sort((a, b) => a - b)[Math.floor(lineWeights.length / 2)] : null
  /** The stem of word k (else its nearest measured neighbour's) and the characters it was measured on. */
  const stemSource = (k: number): { w: number | null; chars: string | null } => {
    const of = (i: number) => {
      const wd = li.words[i]
      return wd && wd.weight !== null ? { w: wd.weight, chars: li.chars.slice(wd.from, wd.to).join('') } : null
    }
    let r = of(k)
    // A short word says nothing; its neighbours on the line do.
    for (let d = 1; d < li.words.length && !r; d++) r = of(k - d) ?? of(k + d)
    return r ?? { w: lineWeight, chars: null }
  }
  const weightOfWord = (k: number): number | null => stemSource(k).w
  const boldOfWord = (k: number): boolean => {
    if (atlas.boldAt === null) return false
    return (weightOfWord(k) ?? 0) >= atlas.boldAt
  }

  // 1. Align, then decide per old word: intact, partially kept, or redrawn.
  // An edit that only changes FIGURES for figures — every word the same
  // length, every changed character a figure where a figure stood: an amount,
  // a date, a code — is aligned position by position, so every character
  // keeps its place and whatever did not change (a separator, a figure that
  // happens to stay) keeps its pixels. Aligned by value instead, "16,949.15"
  // → "21,186.44" paired the "1" of "16" with the "1" of "21": the comma
  // could not be kept and the number was redrawn whole.
  const positional = (() => {
    const tokens = (n: number, spaceBefore: (i: number) => boolean) => {
      const out: { from: number; to: number }[] = []
      for (let i = 0; i < n; i++) {
        if (!out.length || spaceBefore(i)) out.push({ from: i, to: i + 1 })
        else out[out.length - 1].to = i + 1
      }
      return out
    }
    const a = tokens(oldChars.length, i => li.spaceAfter.has(i)), b = tokens(newList.length, j => newList[j].space)
    if (!a.length || a.length !== b.length) return null
    const out: [number, number][] = []
    let changed = false
    for (let t = 0; t < a.length; t++) {
      const n = a[t].to - a[t].from
      if (b[t].to - b[t].from !== n) return null
      for (let q = 0; q < n; q++) {
        const x = oldChars[a[t].from + q], y = newList[b[t].from + q].ch
        if (x === y) { out.push([a[t].from + q, b[t].from + q]); continue }
        if (!/^[0-9]$/.test(x) || !/^[0-9]$/.test(y)) return null
        changed = true
      }
    }
    return changed ? out : null
  })()
  const pairs = positional ?? alignChars(oldChars, newList.map(c => c.ch))
  const matchOfOld = new Int32Array(oldChars.length).fill(-1)
  const matchOfNew = new Int32Array(newList.length).fill(-1)
  for (const [i, j] of pairs) { matchOfOld[i] = j; matchOfNew[j] = i }
  // Which new token (word of the new text) each new character is in.
  const tokenOf = new Int32Array(newList.length)
  for (let j = 0, t = 0; j < newList.length; j++) { if (j > 0 && newList[j].space) t++; tokenOf[j] = t }
  // PURE insertions — letters typed where nothing of the old text was
  // removed — and the old letters either side of each. Letters that replace a
  // removed word are that word's, not a change to the word they now touch:
  // the reading "Liceniatariocinco" with "cinco" replaced by "seis" does not
  // make "Licenciatario" an edited word (redrawn, it took the misreading with
  // it).
  const insertions: { token: number; oldPrev: number; oldNext: number }[] = []
  for (let j = 0; j < newList.length; j++) {
    if (matchOfNew[j] >= 0) continue
    let jp = j - 1, jn = j + 1
    while (jp >= 0 && matchOfNew[jp] < 0) jp--
    while (jn < newList.length && matchOfNew[jn] < 0) jn++
    const oldPrev = jp >= 0 ? matchOfNew[jp] : -1
    const oldNext = jn < newList.length ? matchOfNew[jn] : oldChars.length
    if (oldNext - oldPrev - 1 === 0) insertions.push({ token: tokenOf[j], oldPrev, oldNext })
  }
  const redraw = new Uint8Array(li.words.length)
  li.words.forEach((w, k) => {
    const len = w.to - w.from
    let kept = 0
    let firstJ = Infinity, lastJ = -Infinity
    for (let i = w.from; i < w.to; i++) if (matchOfOld[i] >= 0) { kept++; firstJ = Math.min(firstJ, matchOfOld[i]); lastJ = Math.max(lastJ, matchOfOld[i]) }
    if (kept === 0) return
    const insertedInside = kept && lastJ - firstJ + 1 - kept
    // A letter typed AGAINST the word (no space between) changes the word as
    // much as one typed inside it — and when the word's ink was never cut,
    // nothing says the scan does not already hold that letter: the reading
    // "026" was the ink "2026", and the "2" typed before it printed "22026".
    // Only letters typed AT the word: a code without spaces is one token, and
    // "MSP" reversed in "MSP-SIST-202309006" glued nothing to its figures.
    const glued = insertions.some(t => (t.token === tokenOf[firstJ] || t.token === tokenOf[lastJ]) && (t.oldNext === w.from || t.oldPrev === w.to - 1))
    const untouched = kept === len && insertedInside === 0 && (!glued || (w.cut && w.exact))
    if (untouched) return
    // A word whose letters could not be cut has no letters to keep — nor one
    // whose cut is not EXACT (one ink run per character): its labels may be
    // shifted. The reading "026" over ink saying "2026" cut three labels onto
    // four digits, and keeping "the 0, 2 and 6" printed "2202".
    if (!w.cut || !w.exact) { redraw[k] = 1; return }
    // One the edit changes only at its START or END keeps the rest, however
    // short: "24" → "25" keeps the scan's "2". Anything else is kept only when
    // most of it survives; a word the edit mostly rewrites ("cientocincuenta"
    // → "quinientos" shares "iento" by accident) is redrawn whole rather than
    // patched together from letters picked out of the old one.
    let prefix = 0, suffix = 0
    while (w.from + prefix < w.to && matchOfOld[w.from + prefix] >= 0 && (prefix === 0 || matchOfOld[w.from + prefix] === matchOfOld[w.from + prefix - 1] + 1)) prefix++
    while (w.to - 1 - suffix >= w.from + prefix && matchOfOld[w.to - 1 - suffix] >= 0 && (suffix === 0 || matchOfOld[w.to - 1 - suffix] === matchOfOld[w.to - suffix] - 1)) suffix++
    const edgesOnly = prefix + suffix === kept
    // Figures changed in place keep whatever stayed, however little: each
    // kept character is in its own place, not picked out of the old word.
    if (!positional && !(edgesOnly && kept >= 1) && (kept < len * 0.6 || kept < (lastJ - firstJ + 1) * 0.6)) { redraw[k] = 1; return }
    // The letters kept have to BE their labels. An exact cut is one ink run
    // per character, which a misreading can still satisfy: ink "claves" read
    // ")laves" cuts cleanly, and keeping its ")" kept a "c". A kept letter
    // that does not look like its label at all, or plainly looks like ANOTHER
    // letter, makes the word redrawn whole. Not one that merely matches its
    // label less well than the page's best copies do: at 14 px of em every
    // letter does, and "SIST" in a code was redrawn for an "I" at 0.67.
    const bold = boldOfWord(k)
    const peerAgreement = (ch: string, isBold: boolean, shape: Float32Array, cx0: number, cx1: number) => {
      const ag: number[] = []
      for (const ex of atlas.byChar.get(ch) ?? []) {
        if (ex.doubt && !ex.peerVouched) continue
        if ((atlas.boldAt !== null && ex.weight !== null && ex.weight >= atlas.boldAt) !== isBold) continue
        if (ex.emPx < li.fit.emPx / 1.2 || ex.emPx > li.fit.emPx * 1.2) continue
        if (ex.lineId === li.id && ex.x0 < cx1 && ex.x0 + ex.w > cx0) continue
        ag.push(shapeAgreement(shape, ex.shape))
        if (ag.length >= 8) break
      }
      if (!ag.length) return -1
      ag.sort((a, b) => a - b)
      return ag[Math.floor(ag.length / 2)]
    }
    // Shapes are compared at the line's own size or not at all: a cover's
    // condensed title judged against the medoids of its small subtitle read
    // a heavy "H" as an "O" (0.82) and an "N" as nothing (0.46), and deleting
    // two letters from "HÁGASE" redrew the four it kept from a foreign face.
    const nearSize = (e: number | undefined) => !e || (li.fit.emPx / e <= 1.25 && e / li.fit.emPx <= 1.25)
    const bestOther = (shape: Float32Array, ch: string) => {
      let best = 0, bestCh = ''
      for (const [key, med] of atlas.medoids) {
        const bar = key.lastIndexOf('|')
        if (key.slice(bar + 1) !== String(bold) || key.slice(0, bar) === ch || !nearSize(med.emPx)) continue
        const a = shapeAgreement(shape, med.shape)
        if (a > best) { best = a; bestCh = key.slice(0, bar) }
      }
      return { best, bestCh }
    }
    for (let i = w.from; i < w.to; i++) {
      if (matchOfOld[i] < 0) continue
      const m = atlas.medoids.get(`${oldChars[i]}|${bold}`)
      const shape = cellShapeOf(pi, li, i)
      if (!shape) continue
      if (m) {
        let own = shapeAgreement(shape, m.shape)
        // The medoid may be another face's (a title's): copies of the letter
        // at this line's size, from other words, speak for it too.
        if (own < 0.75 && m.emPx && (li.fit.emPx / m.emPx > 1.08 || m.emPx / li.fit.emPx > 1.08)) {
          const peers = peerAgreement(oldChars[i], bold, shape, li.cells[i].x0, li.cells[i].x1)
          // Nothing at this size to judge it by: only a plainly different
          // letter at this size can still say it is not what it is labelled.
          own = peers < 0 && !nearSize(m.emPx) ? 1 : Math.max(own, peers)
        }
        // Unless what it plainly is is the label's look-alike: the ink of a
        // receipt's "B008" was read "Bo08", and its zero — an old-style one,
        // shaped like an "o" — is the right pixels to keep wherever the edit
        // does not touch it. A shifted reading pairs letters that look nothing
        // alike (")" on a "c"), and that is what this check is for.
        const other = bestOther(shape, oldChars[i])
        if ((own < 0.5 || other.best >= Math.max(0.75, own + 0.15)) && !(other.best >= 0.75 && lookAlike(oldChars[i], other.bestCh))) { redraw[k] = 1; return }
        continue
      }
      // The page has no established shape for the label — a ")" is rare —
      // but the ink may plainly be ANOTHER letter's: that is the mislabel
      // above, and with nothing to check the ")" against, the "c" was kept.
      // Not when the other letter is the label's look-alike: a small "B" IS
      // shaped like an "8".
      // A LETTER with no established shape is judged on stronger evidence
      // than a mark: a title's heavy "L" agreed 0.83 with the big "C" of its
      // own line on the coarse grid, and deleting a letter of
      // "ACTUALIZACIÓN" redrew the word from letters the page did not hold.
      const { best, bestCh } = bestOther(shape, oldChars[i])
      if (bestCh && best >= (/[\p{L}\p{N}]/u.test(oldChars[i]) ? 0.86 : 0.8) && !lookAlike(oldChars[i], bestCh)) { redraw[k] = 1; return }
    }
  })

  // 2. The new characters, their kind and style.
  const nc: NewChar[] = newList.map((c, j) => {
    const i = matchOfNew[j]
    const keep = i >= 0 && !redraw[li.cells[i].word]
    return { ch: c.ch, space: c.space, kind: keep ? 'orig' : 'synth', old: keep ? i : -1, styleWord: i >= 0 ? li.cells[i].word : -1, anchorL: -1, anchorR: -1, x: 0, dx: 0, dy: 0 }
  })
  // Anchors: a kept character stands for itself; a redrawn word's first and
  // last characters stand where that word's first and last letters were.
  for (let j = 0; j < nc.length; j++) {
    const i = matchOfNew[j]
    if (i < 0) continue
    if (nc[j].kind === 'orig') { nc[j].anchorL = nc[j].anchorR = i; continue }
    const w = li.words[li.cells[i].word]
    // The first new character of the token that maps into this word.
    if (i === w.from || (j > 0 && nc[j - 1].space) || j === 0) nc[j].anchorL = w.from
    if (i === w.to - 1 || (j + 1 < nc.length && nc[j + 1].space) || j === nc.length - 1) nc[j].anchorR = w.to - 1
  }
  // A character with no old letter of its own takes its style from the
  // nearest one in its token, then from the nearest one at all.
  for (let j = 0; j < nc.length; j++) {
    if (nc[j].styleWord >= 0) continue
    let found = -1
    for (let d = 1; d < nc.length && found < 0; d++) {
      for (const k of [j - d, j + d]) {
        if (k < 0 || k >= nc.length || found >= 0) continue
        if (tokenOf[k] === tokenOf[j] && nc[k].styleWord >= 0) found = nc[k].styleWord
      }
    }
    for (let d = 1; d < nc.length && found < 0; d++) {
      for (const k of [j - d, j + d]) if (k >= 0 && k < nc.length && found < 0 && nc[k].styleWord >= 0) found = nc[k].styleWord
    }
    nc[j].styleWord = found >= 0 ? found : 0
  }

  const stemPx = (bold: boolean) => (bold ? atlas.stem.bold : atlas.stem.regular) * em

  // 3. Glyphs for the characters to be drawn.
  const missing: string[] = []
  const wanting: GlyphWant[] = []
  // The line's ink over its paper: what a synthesised glyph is printed in.
  const inkOverPaper: [number, number, number] = (() => {
    const p = li.cells.find(c => c.pix.length)?.pix[0]
    const paper = p !== undefined ? [pi.paper[p * 3], pi.paper[p * 3 + 1], pi.paper[p * 3 + 2]] : [255, 255, 255]
    return [0, 1, 2].map(c => Math.min(255, Math.round(255 * li.ink[c] / Math.max(1, paper[c])))) as [number, number, number]
  })()
  // The face each redrawn word is wanted in: the letters of the exact words
  // nearest it on its own line (a form's label and its value sit side by side
  // in two faces, so the nearest, not the line's mix).
  const styleRefs = new Map<number, { char: string; shape: Float32Array }[]>()
  const styleOf = (k: number) => {
    let refs = styleRefs.get(k)
    if (refs) return refs
    refs = []
    const w0 = li.words[k]
    const order = li.words.map((w, i) => ({ w, i })).filter(({ w }) => w.cut && w.exact)
      .sort((p, q) => Math.abs((p.w.x0 + p.w.x1) / 2 - (w0.x0 + w0.x1) / 2) - Math.abs((q.w.x0 + q.w.x1) / 2 - (w0.x0 + w0.x1) / 2))
    for (const { w, i } of order) {
      if (refs.length >= 4 || Math.abs(i - k) > 2) break
      for (let q = w.from; q < w.to; q++) {
        if (li.cells[q].suspect || !/[\p{L}\p{N}]/u.test(li.chars[q])) continue
        const shape = cellShapeOf(pi, li, q)
        if (shape) refs.push({ char: li.chars[q], shape })
      }
    }
    styleRefs.set(k, refs)
    return refs
  }
  let lineEdge: number | null | undefined
  // Serif or sans, as the line's own letters around each word show it.
  const faces = new Map<number, FaceClass | null>()
  const faceOfWord = (k: number): FaceClass | null => {
    if (!faces.has(k)) { const w = li.words[k]; faces.set(k, w ? faceAt(atlas, li.id, (w.x0 + w.x1) / 2, em) : null) }
    return faces.get(k)!
  }
  // A copy from the page in either weight, as a glyph for this line.
  const fromPage = (req: GlyphRequest): { glyph: GlyphImage; drawnAs: string } | null => {
    const pick = pickGlyph(atlas, req)
    if (pick) return { glyph: toned(scaleImage(imageOf(pick.ex), pick.scale), pick.ex.inkT, inkOverPaper), drawnAs: pick.scale === 1 ? 'g' : 'w' }
    // The page has the letter only in the other weight: re-weigh it.
    const other = pickGlyph(atlas, { ...req, bold: !req.bold })
    if (!other) return null
    const d = stemPx(req.bold) - stemPx(!req.bold)
    return { glyph: matchCore(toned(reweighImage(scaleImage(imageOf(other.ex), other.scale), d, d * 0.35), other.ex.inkT, inkOverPaper), li.coreDark, inkOverPaper), drawnAs: 'w' }
  }
  for (const c of nc) {
    if (c.kind !== 'synth') continue
    const bold = boldOfWord(c.styleWord)
    const face = faceOfWord(c.styleWord)
    const req: GlyphRequest = { char: c.ch, emPx: em, xh, capH, figH, bold, style: { line: li.id, refs: styleOf(c.styleWord), face } }
    const found = fromPage(req)
    if (found) { c.glyph = found.glyph; c.drawnAs = found.drawnAs; continue }
    // The page's own letter at another size, from a line in this word's face
    // (`pickGlyphRescaled`): truer than any bundled face where the page is
    // set in something none of them resembles, and nothing is made for it.
    const rescaled = pickGlyphRescaled(atlas, req)
    if (rescaled) { c.glyph = toned(scaleImage(imageOf(rescaled.ex), rescaled.scale), rescaled.ex.inkT, inkOverPaper); c.drawnAs = 'w'; continue }
    // Neither weight on any harvested page, in this kind of face: a glyph
    // synthesised from the matched face, if the caller has made one.
    if (lineEdge === undefined) lineEdge = edgeWidthOf(pi, li)
    const src = stemSource(c.styleWord)
    const want: GlyphWant = { char: c.ch, emPx: em, xh, capH, bold, ink: inkOverPaper, coreDark: li.coreDark, line: li.id, stem: src.w, stemChars: src.chars, edge: lineEdge }
    const made = opts.synth?.get(`${li.id}|${wantKey(want)}`) ?? opts.synth?.get(wantKey(want))
    // The page's copy from text set in the other kind of face — a sans "H"
    // for a serif heading: what a registry page's title was given, an "H" and
    // an "E" from the body text standing out of "SIGA TECH" at a glance. Made
    // in the line's own look instead whenever it can be; the copy is used only
    // where it cannot (no face prints like the line, or the line may not take
    // that many made letters).
    const foreign = face ? fromPage({ ...req, style: { ...req.style!, face: null } }) : null
    if (made) {
      c.glyph = made
      c.drawnAs = 's'
      if (foreign) c.alt = foreign
    } else if (foreign) {
      c.glyph = foreign.glyph
      c.drawnAs = foreign.drawnAs
      wanting.push(want)
    } else { missing.push(c.ch); wanting.push(want) }
  }
  if (missing.length) return { ok: false, reason: `no letter on the page for ${[...new Set(missing)].map(ch => `"${ch}"`).join(', ')}`, notes, wanting }
  // A synthesised letter is the last resort, and it shows: a word made mostly
  // of them reads as a word in another face (a brochure's title redrawn ten
  // letters out of ten). More than two, or more than a quarter of what the
  // line draws, and the line is left to the vector redraw. LETTERS only:
  // figures and brackets from the fitted face do not read as a foreign word,
  // and counting them refused "seis (6)" — the parentheses and the 6 made,
  // three of seven — while a plan redrawing twenty more letters passed.
  {
    const madeLetters = () => nc.filter(c => c.drawnAs === 's' && /\p{L}/u.test(c.ch)).length
    const drawn = nc.filter(c => c.kind === 'synth' && /\p{L}/u.test(c.ch)).length
    // Over the limit, a made letter that has a page copy in the other kind of
    // face takes that copy: it was the drawing before such copies gave way.
    if (madeLetters() > Math.max(2, drawn * 0.25)) for (const c of nc) if (c.drawnAs === 's' && c.alt) { c.glyph = c.alt.glyph; c.drawnAs = c.alt.drawnAs }
    const made = madeLetters()
    if (made > Math.max(2, drawn * 0.25)) return { ok: false, reason: `too many letters the page does not hold (${made} of ${drawn})`, notes }
  }

  // 4. The line, in three parts. Everything BEFORE the first change keeps
  // its place to the pixel. Everything AFTER the last change moves as ONE
  // block — every letter, every mark the reading never named (handwriting in
  // a form's blank, a stamp's edge), the rules that lie wholly under it — by
  // however much the middle grew or shrank; its own spacing is the scan's,
  // whatever the reading made of it. Only the middle is typeset. Laid out
  // whole from the reading, a real form line reversing ONE word respaced
  // every word on it, erased the handwriting in its blank and drew a rule
  // under all of it.
  const spacing = (k: number) => boldOfWord(k) ? atlas.spacing.bold : atlas.spacing.regular
  // A one-word line has no word gap of its own: the page's, within what a
  // word space can be, ink to ink. A page of table cells measured 0.15 em
  // (its "words" were mostly letter groups), and "<first name> X" came out
  // glued.
  const wordGapPx = li.wordGapPx > 0 ? li.wordGapPx : Math.min(0.6, Math.max(0.25, atlas.wordGapEm)) * em
  // A letter-spaced line (a title set "J U D E A") adds the same tracking to
  // every pair: what its own letter gaps exceed the page's typical one by.
  // Set at the body's spacing, a new letter in it read as a word squeezed in.
  const tracking = (() => {
    const extra = li.letterGapPx - atlas.spacing.regular.mu * em
    return extra > em * 0.08 ? extra : 0
  })()
  // Optical spacing: each letter's profile over the letter band — per row,
  // how far its ink sits inside its left and right ink edges — and the mean
  // white between two profiles, every row's depth capped at a quarter em (a
  // counter wide open on one side is not more white than that to the eye).
  const D = em * 0.25
  const bandTop = -Math.round(capH ?? em * 0.68)
  const bandRows = -bandTop + 1
  type Prof = { l: Float32Array; r: Float32Array }
  const cellProfs = new Map<number, Prof | null>()
  const cellProf = (i: number): Prof | null => {
    if (cellProfs.has(i)) return cellProfs.get(i)!
    const c = li.cells[i]
    let out: Prof | null = null
    if (c && c.pix.length && c.inkR >= c.inkL) {
      const l = new Float32Array(bandRows).fill(Infinity), r = new Float32Array(bandRows).fill(Infinity)
      for (let q = 0; q < c.pix.length; q++) {
        const pp = c.pix[q], x = pp % W, y = (pp - x) / W
        const k = y - Math.round(base(x)) - bandTop
        if (k < 0 || k >= bandRows) continue
        if (x - c.inkL < l[k]) l[k] = x - c.inkL
        if (c.inkR - x < r[k]) r[k] = c.inkR - x
      }
      out = { l, r }
    }
    cellProfs.set(i, out)
    return out
  }
  const glyphProfs = new Map<GlyphImage, Prof>()
  const glyphProf = (g: GlyphImage): Prof => {
    let out = glyphProfs.get(g)
    if (out) return out
    const l = new Float32Array(bandRows).fill(Infinity), r = new Float32Array(bandRows).fill(Infinity)
    for (let y = 0; y < g.h; y++) {
      const k = Math.round(y - g.baseY) - bandTop
      if (k < 0 || k >= bandRows) continue
      for (let x = 0; x < g.w; x++) {
        const i = y * g.w + x
        // Ink: the core, as the cells' pixels are — well under the paper.
        if (!g.m[i] || g.t[i * 3] > 140) continue
        if (x - g.inkL < l[k]) l[k] = x - g.inkL
        if (g.inkR - x < r[k]) r[k] = g.inkR - x
      }
    }
    out = { l, r }
    glyphProfs.set(g, out)
    return out
  }
  const profOf = (c: NewChar): Prof | null => c.kind === 'orig' ? cellProf(c.old) : c.glyph ? glyphProf(c.glyph) : null
  const whiteOf = (a: Prof, b: Prof): number => {
    let s = 0
    for (let k = 0; k < bandRows; k++) s += Math.min(Math.max(0, a.r[k]), D) + Math.min(Math.max(0, b.l[k]), D)
    return s / bandRows
  }
  /** How each typeset gap was decided, for the lab: 'o' optical, 'p' the pair model. */
  const gapNotes = new Map<number, string>()
  // What the line's own neighbouring letters measure, ink gap plus white.
  const opticalTarget = (() => {
    const v: number[] = []
    for (const w of li.words) {
      if (!w.cut || !w.exact) continue
      for (let i = w.from + 1; i < w.to; i++) {
        if (li.cells[i - 1].suspect || li.cells[i].suspect) continue
        const a = cellProf(i - 1), b = cellProf(i)
        if (a && b) v.push(li.cells[i].inkL - li.cells[i - 1].inkR + whiteOf(a, b))
      }
    }
    if (v.length < 4) return null
    v.sort((x, y) => x - y)
    return v[Math.floor(v.length / 2)]
  })()
  const oldSpace = (i: number) => li.spaceAfter.has(i)
  const inkWordBoundary = (i: number) => i > 0 && li.cells[i].word !== li.cells[i - 1].word
  const oldGap = (i: number) => li.cells[i].inkL - li.cells[i - 1].inkR
  const widthOf = (c: NewChar) => c.kind === 'orig' ? li.cells[c.old].inkR - li.cells[c.old].inkL : c.glyph!.inkR - c.glyph!.inkL
  /** The gap before nc[j] is the scan's own (both kept, neighbours in the old text, spacing untouched). */
  const scanGap = (j: number): boolean => {
    const c = nc[j], p = nc[j - 1]
    if (!p || c.kind !== 'orig' || p.kind !== 'orig' || c.old !== p.old + 1) return false
    return oldSpace(c.old) === c.space || inkWordBoundary(c.old) === c.space
  }
  let pre = 0
  if (nc.length && nc[0].kind === 'orig' && nc[0].old === 0) { pre = 1; while (pre < nc.length && scanGap(pre)) pre++ }
  let tail = nc.length
  if (nc.length > pre && nc[nc.length - 1].kind === 'orig' && nc[nc.length - 1].old === oldChars.length - 1) {
    tail = nc.length - 1
    while (tail > pre && scanGap(tail)) tail--
  }
  // Figures are set on a PITCH: lining figures share one advance, and a stop
  // or a comma between two takes its own. Centre to centre, as this line's
  // figures measure it (a "1" is narrow ink in a full-width cell, so ink gaps
  // vary where centres do not). Typeset by the pair model instead, "0.00"
  // retyped "2,500.00" opened a gap after the comma that "13,000.00" above it
  // does not have.
  const isFig = (ch: string) => /^[0-9]$/.test(ch)
  const isSep = (ch: string) => ch === '.' || ch === ','
  // The line's own figures first; a line with few of them ("0.00" has one
  // pair) borrows the page's lines at its size, whose figures were set from
  // the same table — one pair is a pixel's rounding either way, and three new
  // figures to its left carried that error three times.
  const pitch = (() => {
    const samples = (o: LineInk) => {
      const dd: number[] = [], ds: number[] = [], sd: number[] = []
      for (let i = 1; i < o.cells.length; i++) {
        const a = o.cells[i - 1], b = o.cells[i]
        if (o.spaceAfter.has(i) || a.approx || b.approx || a.suspect || b.suspect || a.inkR < a.inkL || b.inkR < b.inkL) continue
        const d = (b.inkL + b.inkR) / 2 - (a.inkL + a.inkR) / 2
        if (d <= 0 || d > em) continue
        if (isFig(a.char) && isFig(b.char)) dd.push(d)
        else if (isFig(a.char) && isSep(b.char)) ds.push(d)
        else if (isSep(a.char) && isFig(b.char)) sd.push(d)
      }
      return { dd, ds, sd }
    }
    const own = samples(li)
    const page = { dd: [] as number[], ds: [] as number[], sd: [] as number[] }
    for (const o of opts.pageLines ?? []) {
      if (o === li || domainOfLine(o) !== domainOfLine(li) || Math.abs(o.fit.emPx - em) > em * 0.08) continue
      const v = samples(o)
      page.dd.push(...v.dd); page.ds.push(...v.ds); page.sd.push(...v.sd)
    }
    const med = (v: number[]) => v.length ? [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)] : null
    const pick = (mine: number[], theirs: number[], need: number) => med(mine.length >= need ? mine : [...mine, ...theirs])
    const P = pick(own.dd, page.dd, 3)
    if (P === null) return null
    // A stop or comma is half a figure's advance in every common face, so the
    // centres either side of one sit three quarters of a pitch from it.
    return { P, S1: pick(own.ds, page.ds, 2) ?? P * 0.75, S2: pick(own.sd, page.sd, 2) ?? P * 0.75 }
  })()
  /** Where a figure laid on the pitch was MEANT to be centred, before rounding. */
  const figCentre = new Map<number, number>()
  /** The gap before nc[j] when it is not the scan's own. */
  const gapBefore = (j: number): number => {
    const c = nc[j], p = nc[j - 1]
    if (p.anchorR >= 0 && c.anchorL === p.anchorR + 1) {
      const i = c.anchorL
      if (oldSpace(i) === c.space || inkWordBoundary(i) === c.space) return oldGap(i)
    }
    if (pitch && !c.space && (isFig(p.ch) || isFig(c.ch)) && (isFig(p.ch) || isSep(p.ch)) && (isFig(c.ch) || isSep(c.ch))) {
      const d = isFig(p.ch) && isFig(c.ch) ? pitch.P : isFig(p.ch) ? pitch.S1 : pitch.S2
      gapNotes.set(j, 'f')
      // Chained on the exact centres, not the rounded places: rounded at every
      // step, three figures drifted a pixel and a half off their column.
      const from = figCentre.get(j - 1) ?? p.x + widthOf(p) / 2
      figCentre.set(j, from + d)
      return from + d - widthOf(c) / 2 - (p.x + widthOf(p))
    }
    // A new letter right after one that stays, where the old text broke: the
    // gap the break had. The line's typical word gap is the wrong figure — on
    // ": Mantenimiento Instrumentacion" it was the 10 px after the colon, and
    // "Electrico" stood 3 px further off than the word it replaced — and so is
    // a letter gap where the INK broke but the reading did not: ":09/08/2023"
    // read without its space came back ":20/08/2023", glued to the colon.
    // So is a word given a new FIRST letter, its old first letter now its
    // second: "Moneda : S/." retyped "US$" put the "U" a word gap off the
    // colon, ten pixels further than the "S" had stood.
    if (c.kind !== 'orig' && p.kind === 'orig' && p.anchorR >= 0) {
      const i = p.anchorR + 1
      const leadsOld = () => {
        for (let q = j + 1; q < nc.length && !nc[q].space; q++) if (nc[q].kind === 'orig') return nc[q].old === i
        return false
      }
      if (i < li.cells.length && (c.space ? oldSpace(i) && (matchOfOld[i] < 0 || leadsOld()) : !oldSpace(i) && inkWordBoundary(i))) return oldGap(i)
    }
    if (c.space) return wordGapPx
    const model = spacing(c.styleWord)
    // A pair the page never printed has no gap of its own in the model, and
    // the average gap is optically wrong for a letter whose closest point is
    // a foot or an arm ("PEARL" + "S" read as a word space). It is set so the
    // WHITE between the two letters' profiles matches this line's own pairs.
    if (!(model.R.has(p.ch) && model.L.has(c.ch)) && opticalTarget !== null) {
      const pa = profOf(p), pb = profOf(c)
      if (pa && pb) { gapNotes.set(j, 'o'); return Math.max(1, Math.min(em * 0.6, opticalTarget - whiteOf(pa, pb))) }
    }
    gapNotes.set(j, 'p')
    return predictGap(model, p.ch, c.ch) * em + tracking
  }
  const place = (c: NewChar, x: number) => {
    if (c.kind === 'orig') {
      const cell = li.cells[c.old]
      c.dx = Math.round(x - cell.inkL)
      // Along the line's baseline, bend included: a letter moved along a
      // bowed line rises or falls with it.
      const cx = (cell.inkL + cell.inkR) / 2
      c.dy = Math.round(base(cx + c.dx) - base(cx))
      c.x = cell.inkL + c.dx
      c.drawnAs = c.dx === 0 && c.dy === 0 ? 'k' : 'm'
    } else {
      c.x = Math.round(x)
    }
  }
  /** Lay out nc[from..to) after `pen`, the gap before each (scan's own or typeset) plus `extra`. */
  const layoutRun = (from: number, to: number, pen: number, extra: Float64Array): number => {
    for (let j = from; j < to; j++) {
      const c = nc[j]
      let x: number
      if (j === 0) {
        // The line starts where it always started, whatever letter now comes
        // first: a reversed "PERU" begins with the old LAST letter, and
        // placing it at its own ink moved the whole line right by the rest of
        // the word.
        x = li.cells[0]?.inkL ?? li.words[0]?.x0 ?? li.roi.x0
      } else {
        x = pen + (scanGap(j) ? oldGap(nc[j].old) : gapBefore(j)) + extra[j]
      }
      place(c, x)
      pen = c.x + widthOf(c)
    }
    return pen
  }
  const extra = new Float64Array(nc.length)
  // The prefix stays where it is.
  for (let j = 0; j < pre; j++) place(nc[j], li.cells[nc[j].old].inkL)
  let pen = pre > 0 ? nc[pre - 1].x + widthOf(nc[pre - 1]) : -Infinity
  // Figures replacing as many figures take the old ones' CELLS, each centred
  // where its predecessor stood: lining figures share one advance, so an
  // amount or a code keeps its spacing to the pixel and nothing after it
  // moves. Typeset by the gap model instead, "13,000.00" → "13,500.00" put
  // the new "5" two pixels right of the old "0" and moved ",00.00" with it.
  // Every new character of the middle must be such a figure — one for one,
  // between kept characters — and the kept ones between them stay where
  // they are: "del 03 de abril al 01" → "del 04 de abril al 02" changes two
  // figures, and typeset by the gap model it moved "de abril al 0" between
  // them by the new "4"'s width.
  const sameCells = (() => {
    if (pre < 1 || tail >= nc.length || tail <= pre) return null
    const slots = new Map<number, number>() // middle index → the old cell it takes
    // A kept character keeps the space (or none) it had before it.
    const sameSpace = (c: NewChar) => oldSpace(c.old) === c.space || inkWordBoundary(c.old) === c.space
    if (!sameSpace(nc[tail])) return null
    for (let j = pre; j < tail;) {
      if (nc[j].kind === 'orig') {
        // Kept characters keep their order, their neighbours and their spacing.
        if (!sameSpace(nc[j]) || (nc[j - 1].kind === 'orig' && nc[j].old !== nc[j - 1].old + 1)) return null
        j++
        continue
      }
      let k = j
      while (k < tail && nc[k].kind !== 'orig') k++
      const a = nc[j - 1].old, b = nc[k].old
      if (b - a - 1 !== k - j) return null
      for (let q = 0; q < k - j; q++) {
        const c = nc[j + q], oi = a + 1 + q
        // An approximate cell is a share of a word's ink, not a figure's place.
        if (c.space !== oldSpace(oi) || !/^[0-9]$/.test(c.ch) || !/^[0-9]$/.test(oldChars[oi]) || li.cells[oi].approx) return null
        slots.set(j + q, oi)
      }
      j = k
    }
    if (nc[tail].old !== nc[tail - 1].old + 1 && nc[tail - 1].kind === 'orig') return null
    return slots.size ? slots : null
  })()
  // A number redrawn whole in the same characters' places — its figures
  // touched its separators, so it could not keep any of them — takes the old
  // characters' cells one for one: figure for figure, every other character
  // the same. Set at the spacing model's gaps instead, a bold "18/07/2022."
  // whose slashes touched its figures came back "25/07/2022." letter-spaced.
  const sameSpan = sameCells ? null : (() => {
    if (tail <= pre) return null
    const from = pre > 0 ? (nc[pre - 1].kind === 'orig' ? nc[pre - 1].old + 1 : -1) : 0
    const to = tail < nc.length ? nc[tail].old : oldChars.length
    if (from < 0 || to - from !== tail - pre) return null
    for (let q = 0; q < tail - pre; q++) {
      const c = nc[pre + q], oi = from + q
      const ok = c.ch === oldChars[oi] || (/^[0-9]$/.test(c.ch) && /^[0-9]$/.test(oldChars[oi]))
      // Approximate cells too: lining figures share one advance, so a share of
      // the run by advance is the figure's place, and the span keeps its extent.
      if (!ok || (q > 0 && c.space !== oldSpace(oi))) return null
      if (c.kind === 'orig' && c.old !== oi) return null
    }
    // Only a number: figures, and its separators.
    if (!nc.slice(pre, tail).every(c => /^[0-9.,:/-]$/.test(c.ch)) || !nc.slice(pre, tail).some(c => /^[0-9]$/.test(c.ch))) return null
    return from
  })()
  if (sameCells) {
    for (let j = pre; j < tail; j++) {
      const c = nc[j]
      if (c.kind === 'orig') { place(c, li.cells[c.old].inkL); continue }
      const cell = li.cells[sameCells.get(j)!]
      place(c, cell.inkL + ((cell.inkR - cell.inkL) - widthOf(c)) / 2)
    }
    pen = nc[tail - 1].x + widthOf(nc[tail - 1])
  } else if (sameSpan !== null) {
    for (let j = pre; j < tail; j++) {
      const c = nc[j], cell = li.cells[sameSpan + j - pre]
      if (c.kind === 'orig') { place(c, cell.inkL); continue }
      place(c, cell.inkL + ((cell.inkR - cell.inkL) - widthOf(c)) / 2)
    }
    pen = nc[tail - 1].x + widthOf(nc[tail - 1])
  } else pen = layoutRun(pre, tail, pen, extra)
  // The tail, as one block, after the middle.
  let dxTail = 0, dyTail = 0
  const oldTailX = tail < nc.length ? li.cells[nc[tail].old].inkL : Infinity
  if (tail < nc.length) {
    // A line whose first letters went starts where it always started.
    const x = tail === 0 ? li.cells[0].inkL : sameCells || sameSpan !== null ? oldTailX : pen + gapBefore(tail)
    dxTail = Math.round(x - oldTailX)
    // A change about as wide as what it replaced ("5" → "6") keeps the tail
    // where it is: the difference goes into the gaps either side of the
    // change, as a figure set in the same advance would. Moved by a pixel
    // instead, every word after it moved, and a justified line was respaced
    // to its margin again — thousands of pixels rewritten for one character.
    if (dxTail !== 0 && pre > 0 && tail > pre && Math.abs(dxTail) <= Math.max(2, Math.round(em * 0.08))) {
      const s = -Math.round(dxTail / 2)
      const leftGap = nc[pre].x + s - (nc[pre - 1].x + widthOf(nc[pre - 1]))
      let midRight = -Infinity
      for (let j = pre; j < tail; j++) midRight = Math.max(midRight, nc[j].x + widthOf(nc[j]))
      const rightGap = oldTailX - (midRight + s)
      if (leftGap >= 1 && rightGap >= 1) {
        for (let j = pre; j < tail; j++) {
          const c = nc[j]
          if (c.kind === 'orig') place(c, c.x + s)
          else c.x += s
        }
        dxTail = 0
      }
    }
    dyTail = Math.round(base(oldTailX + dxTail) - base(oldTailX))
    for (let j = tail; j < nc.length; j++) {
      const c = nc[j], cell = li.cells[c.old]
      c.dx = dxTail; c.dy = dyTail; c.x = cell.inkL + dxTail
      c.drawnAs = dxTail === 0 && dyTail === 0 ? 'k' : 'm'
    }
  }
  let newRight = nc.length ? Math.max(...nc.map(c => c.x + widthOf(c))) : 0

  // Ink the reading never named, where the edit goes: refused rather than
  // erased or printed over (a form's handwriting, a mark the size of a letter).
  const oldMidX0 = pre > 0 ? li.cells[nc[pre - 1].old].inkR : -Infinity
  const oldMidX1 = tail < nc.length ? oldTailX : Infinity
  // A piece the size of a letter's stroke at least: specks and the dot of a
  // misread "i" are not worth refusing an edit over.
  const significant = (piece: LineInk['loose'][number]) => piece.area >= em * em * 0.05
  if (pre < tail || tail < nc.length || nc.length < oldChars.length) {
    for (const piece of li.loose) {
      if (!significant(piece)) continue
      if (piece.x1 > oldMidX0 + 1 && piece.x0 < oldMidX1 - 1) return { ok: false, reason: 'the edit falls on ink the reading does not account for (handwriting, a mark)', notes }
    }
  }

  // Justification. A line set to the margin stays set to it: the width the
  // edit gained or lost is taken back from the word gaps after the first
  // change, every one by the same share of itself, within reason — a gap gives
  // up a quarter of itself at most, or grows by three fifths. Only on a CLEAN
  // line (no ink the reading misses, no rule): there the tail need not move
  // as one block, its words move each by their share. A line that does not
  // reach the margin keeps its natural length — unless it would now run off
  // the paper, which a rigid tail is not allowed to do either.
  const oldRight = Math.max(...li.cells.map(c => c.inkR))
  // The rules of THIS line: in its own band. The analysed box reaches into
  // the lines either side, and the underline of the heading above is theirs.
  const ownRules = li.rules.filter(r => {
    const off = r.y + r.slope * ((r.x0 + r.x1) / 2 - r.centreX) - base((r.x0 + r.x1) / 2)
    return off > -em * 0.9 && off < em * 0.5
  })
  const clean = !li.loose.some(significant) && !ownRules.length
  // A figure column is set flush RIGHT against its cell's border, and a
  // longer amount grows to the left: "20,000.00" → "25,000.00" redrawn from
  // the line's start ran its last "0" into the border. A line of figures
  // (most of it digits) that ends within an em and a half of a vertical rule,
  // with more room on its left than on its right, keeps its right edge.
  let rigid = true
  const oldLeft = li.cells.length ? Math.min(...li.cells.map(c => c.inkL)) : 0
  const flushRight = (() => {
    // Figures set in the old ones' cells already keep the number's extent: a
    // new last figure narrower than the old one is not a shorter number.
    if (sameCells || sameSpan !== null) return false
    if (!clean || !nc.length || Math.abs(newRight - oldRight) < 1) return false
    const visible = oldChars.filter(ch => ch.trim())
    const digits = visible.filter(ch => /[0-9]/.test(ch)).length
    if (digits < 2 || digits < visible.length * 0.6) return false
    const right = li.borders.filter(x => x >= oldRight - 1 && x <= oldRight + em * 1.5)
    // No rule beside it, but a column of figures ending where it ends
    // (`columnRight`): "0.00" under "13,000.00" typed as "2,500.00" grew out
    // past the column's edge.
    if (!right.length) return !!opts.columnRight
    const left = li.borders.filter(x => x <= oldLeft + 1).sort((a, b) => b - a)[0]
    return left === undefined || oldLeft - left > (Math.min(...right) - oldRight) * 2
  })()
  if (flushRight) {
    const d = Math.round(oldRight - newRight)
    for (const c of nc) {
      if (c.kind === 'orig') place(c, c.x + d)
      else c.x += d
    }
    newRight += d
    rigid = false
    notes.push('set flush right in its cell')
  }
  // What a respacing moves is the line from its first change on — unless it
  // has to spread into the whole line. A rule or a mark BEFORE the change
  // never moves: a deed's line opens with an underlined "INTRODUCCIÓN.-", and
  // "TRES" retyped "CUATRO" further along was refused as running off the
  // paper because the line was not clean.
  const firstChangeX = pre > 0 ? li.cells[nc[pre - 1].old].inkR : -Infinity
  const cleanAfter = !li.loose.some(p => significant(p) && p.x1 > firstChangeX) && !ownRules.some(r => r.x1 > firstChangeX)
  let target: number | null = null
  if (!flushRight && opts.justifyTo != null && cleanAfter && Math.abs(oldRight - opts.justifyTo) <= em * 0.6 && nc.length) target = oldRight
  else if (!flushRight && opts.limitRight != null && newRight > opts.limitRight) target = opts.limitRight
  if (target !== null && Math.abs(newRight - target) >= 1 && pre < nc.length) {
    if (!cleanAfter) return { ok: false, reason: 'the edit would run the line off the paper', notes }
    rigid = false
    const delta = target - newRight
    const isGap = (j: number) => {
      const c = nc[j], p = nc[j - 1]
      return c.space || (c.kind === 'orig' && p.kind === 'orig' && c.old === p.old + 1 && inkWordBoundary(c.old))
    }
    const gapWidth = (j: number) => Math.max(0, nc[j].x - (nc[j - 1].x + widthOf(nc[j - 1])))
    const after: number[] = [], all: number[] = []
    for (let j = 1; j < nc.length; j++) if (isGap(j)) { all.push(j); if (j >= pre) after.push(j) }
    // The gaps after the change take the difference while they take it
    // lightly, and the words before it keep their pixels. Past that the whole
    // line is respaced, every gap by the same share, as a typesetter
    // re-justifies: on "el 30 de septiembre de 2026" the gaps after the date
    // alone closed to "porlas" and the line still ran 18px past its margin.
    const afterWidth = after.reduce((t, j) => t + gapWidth(j), 0)
    const light = Math.abs(delta) <= afterWidth * (delta > 0 ? 0.25 : 0.12)
    const gaps = light || all.length === after.length || !clean ? after : all
    const capOf = (j: number) => gapWidth(j) * (delta > 0 ? 0.6 : 0.3)
    const total = gaps.reduce((t, j) => t + capOf(j), 0)
    const f = total > 0 ? Math.min(1, Math.abs(delta) / total) : 0
    for (const j of gaps) extra[j] = Math.sign(delta) * capOf(j) * f
    const left = Math.abs(delta) - total * f
    const from = gaps === after ? pre : 1
    pen = from > 0 ? nc[from - 1].x + widthOf(nc[from - 1]) : -Infinity
    newRight = layoutRun(from, nc.length, pen, extra)
    if (left >= 1) notes.push(`the line could not be respaced by ${Math.round(left)} px`)
  }
  // Respaced as far as it goes and still past the scan's own pixels, where
  // no overlay can draw it: the end of the line would not be on the page at
  // all. The vector redraw can set it smaller. Only the image's edge — a
  // margin short of it is still paper, and a cover sets its title there
  // (refused 6pt short of the edge, an "X" appended to a cover's "NATURE"
  // went from the page's own letters to a redraw in another face).
  if (newRight > s.w - 1 && newRight > oldRight) return { ok: false, reason: 'the edit would run the line off the paper', notes }
  const layoutLog = nc.map((c, j) => `${gapNotes.get(j) ?? ''}${c.ch}${c.kind === 'orig' ? (c.drawnAs) : 'g'}@${c.x}+${Math.round(widthOf(c))}`)
  layoutLog.push(`optical target ${opticalTarget?.toFixed(1) ?? '-'}`)

  // 5. What moves and what goes.
  const erased = new Set<number>()      // old cell indices whose pixels leave
  const keptInPlace = new Set<number>()
  const movers = new Map<number, NewChar>()
  for (const c of nc) {
    if (c.kind !== 'orig') continue
    if (c.dx === 0 && c.dy === 0) keptInPlace.add(c.old)
    else { erased.add(c.old); movers.set(c.old, c) }
  }
  for (let i = 0; i < oldChars.length; i++) if (!keptInPlace.has(i) && !movers.has(i)) erased.add(i)
  // The tail's loose ink and the rules wholly under the tail go with it.
  const tailLoose = rigid && (dxTail || dyTail) ? li.loose.map((p, k) => p.x0 >= oldTailX - 1 ? k : -1).filter(k => k >= 0) : []
  const underlines = rulesUnder(li, base, em)
  const tailRules = rigid && (dxTail || dyTail) ? ownRules.filter(r => r.x0 >= oldTailX - 1) : []

  // What goes is each erased letter's REGION (lineInk's Voronoi partition):
  // its core, its fringe and the haze around it, never a pixel nearer to a
  // kept letter, another line or a rule.
  const eraseSet = new Set<number>()
  const nearPx = Math.max(2, Math.round(1.1 / Math.abs(s.toPage[0] || 1)))
  const eraseOpts = { dark: pi.dark, near: nearPx, minDark: 9 }
  for (const i of erased) for (const p of cellRegion(li, i, W, eraseOpts)) eraseSet.add(p)
  for (const k of tailLoose) for (const p of looseRegion(li, k, W)) eraseSet.add(p)
  const ruleRegion = (r: LineInk['rules'][number]) => {
    // A rule's pixels and the fringe rows beside them.
    const out: number[] = []
    for (const p of r.pix) for (let dy = -1; dy <= 1; dy++) { const q = p + dy * W; if (q >= 0 && q < W * s.h) out.push(q) }
    return out
  }
  for (const r of tailRules) for (const p of ruleRegion(r)) eraseSet.add(p)

  // Moving pixels read the ORIGINAL scan, never the working copy.
  const src = s.data
  // Two inks, one over the other (`LineInk.overInk`): a signature or a
  // stamp in another colour crossing the line. Each pixel's density is
  // shared out between the line's ink and the other one — as densities add
  // where inks overlap, by least squares over the three channels — so that
  // an erased letter gives back the stroke that ran over it, and a moved one
  // takes its own ink and leaves the stroke where it was. Erased and moved
  // as plain pixels, a respaced line under a notarised deed's blue signature
  // carried every stretch of stroke inside its letters' reach along with
  // them, and the signature came back broken at every line it crossed.
  const layers = (() => {
    if (!li.overInk) return null
    const pr: number[] = [], pg: number[] = [], pb: number[] = []
    for (const c of li.cells) for (let k = 0; k < c.pix.length; k += Math.max(1, Math.floor(c.pix.length / 8))) {
      const p = c.pix[k]
      pr.push(pi.paper[p * 3]); pg.push(pi.paper[p * 3 + 1]); pb.push(pi.paper[p * 3 + 2])
    }
    if (!pr.length) return null
    const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
    const P0 = [med(pr), med(pg), med(pb)]
    const dens = (rgb: [number, number, number]) => [0, 1, 2].map(c => -Math.log(Math.min(0.98, Math.max(0.02, rgb[c] / Math.max(1, P0[c])))))
    const Dt = dens(li.ink), Ds = dens(li.overInk)
    const tt = Dt.reduce((t, v) => t + v * v, 0), ss = Ds.reduce((t, v) => t + v * v, 0)
    const ts = Dt[0] * Ds[0] + Dt[1] * Ds[1] + Dt[2] * Ds[2]
    const det = tt * ss - ts * ts
    // Two inks of one colour cannot be told apart.
    if (det < 0.067 * tt * ss) return null
    const memo = new Map<number, [number, number]>()
    /** The densities of the line's ink and of the other ink at p. */
    const split = (p: number): [number, number] => {
      let v = memo.get(p)
      if (v) return v
      let td = 0, sd = 0
      for (let c = 0; c < 3; c++) {
        const d = -Math.log(Math.min(1, Math.max(0.01, src[p * 4 + c] / Math.max(1, pi.paper[p * 3 + c]))))
        td += Dt[c] * d; sd += Ds[c] * d
      }
      let a = (ss * td - ts * sd) / det, b = (tt * sd - ts * td) / det
      if (a < 0) { a = 0; b = Math.max(0, sd / ss) } else if (b < 0) { b = 0; a = Math.max(0, td / tt) }
      v = [a, b]
      memo.set(p, v)
      return v
    }
    return { Dt, Ds, split }
  })()
  const T = (p: number, ch: number) => {
    if (layers) return Math.min(1, Math.exp(-layers.split(p)[0] * layers.Dt[ch]))
    const paper = pi.paper[p * 3 + ch]
    return paper > 0 ? Math.min(1, src[p * 4 + ch] / paper) : 1
  }
  // What the pixel shows ABOVE its paper, in a channel where it is lighter:
  // black lettering on a red cover carries twice the red's green in its JPEG
  // tint, and multiplied (clamped at the paper) every moved letter lost that
  // channel and printed a shade darker than the letters left in place.
  // Added rather than multiplied: the red's green is 15, and a ratio over it
  // turned the tint of an "L" into a green glow wherever the paper it landed
  // on differed by a few levels. On white paper there is nothing above 255.
  const excess = (p: number, ch: number) => layers ? 0 : Math.max(0, src[p * 4 + ch] - pi.paper[p * 3 + ch])
  /** What an erased pixel shows: the paper, under the other ink where it ran. */
  const erasedTo = (p: number, ch: number) => layers ? pi.paper[p * 3 + ch] * Math.exp(-layers.split(p)[1] * layers.Ds[ch]) : pi.paper[p * 3 + ch]
  const printShifted = (set: Iterable<number>, dx: number, dy: number) => {
    const shift = dy * W + dx
    const seen = new Set<number>()
    for (const p of set) {
      if (seen.has(p)) continue
      seen.add(p)
      const x = p % W + dx, y = Math.floor(p / W) + dy
      if (x < 0 || y < 0 || x >= W || y >= s.h) continue
      const q = p + shift
      for (let ch = 0; ch < 3; ch++) work[q * 4 + ch] = work[q * 4 + ch] * T(p, ch) + excess(p, ch)
      touch(q)
    }
  }

  // Nothing is printed on ink the line does not own: another line's letters,
  // the next cell's, a table's border. " X" appended to a narrow table cell
  // was set past the cell's border onto the first letter of the next one —
  // inside the edit's own box, so no check of what lies outside it saw it.
  // The line's own rules (an underline its letters sit on) are its own.
  {
    const ownRule = (q: number) => {
      const x = q % W, y = Math.floor(q / W)
      return ownRules.some(r => x >= r.x0 - 2 && x < r.x1 + 2 && Math.abs(y - (r.y + r.slope * (x - r.centreX))) <= r.thick / 2 + 2)
    }
    // Ink the line does not own: what the analysis protected, and beyond the
    // analysed box any ink at all (the next cell's letters lie outside it).
    const RW = li.roi.x1 - li.roi.x0
    const foreign = (q: number) => {
      const x = q % W, y = Math.floor(q / W)
      if (x < li.roi.x0 || x >= li.roi.x1 || y < li.roi.y0 || y >= li.roi.y1) return pi.dark[q] >= CORE
      const o = li.owner[(y - li.roi.y0) * RW + (x - li.roi.x0)]
      return o < 0 && pi.dark[q] >= CORE && !ownRule(q)
    }
    let hits = 0
    const land = (q: number) => { if (q >= 0 && q < W * s.h && foreign(q)) hits++ }
    for (const [i, c] of movers) for (const p of li.cells[i].pix) land(p + c.dy * W + c.dx)
    for (const k of tailLoose) for (const p of li.loose[k].pix) land(p + dyTail * W + dxTail)
    for (const c of nc) {
      if (c.kind !== 'synth' || !c.glyph) continue
      const g = c.glyph
      const X = Math.round(c.x - g.inkL), Y = Math.round(base(c.x + (g.inkR - g.inkL) / 2) - g.baseY)
      for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
        const i = y * g.w + x
        // Ink on ink, core on core: a letter's soft edge beside a cell's rule
        // is how every letter of the page sits in its cell.
        if (!g.m[i] || Math.min(g.t[i * 3], g.t[i * 3 + 1], g.t[i * 3 + 2]) > 150) continue
        if (X + x < 0 || Y + y < 0 || X + x >= W || Y + y >= s.h) continue
        land((Y + y) * W + X + x)
      }
    }
    if (hits > 3) return { ok: false, reason: 'the edit would print over ink it does not own (the next cell, a border, another line)', notes }
  }

  // Underlines, before anything is written: which new characters run over one.
  const ulPlans = underlines.filter(u => !tailRules.includes(u)).map(u => planUnderline(li, u, nc, tokenOf))

  // 6. Erase.
  for (const p of eraseSet) {
    work[p * 4] = erasedTo(p, 0); work[p * 4 + 1] = erasedTo(p, 1); work[p * 4 + 2] = erasedTo(p, 2)
    touch(p)
  }
  // The other ink's strokes are held where they are, not relaxed away.
  relaxErased(work, eraseSet, pi, W, s.h, layers ? (p: number) => layers.split(p)[1] > 0.15 : undefined)
  for (const plan of ulPlans) if (plan) plan.erase(work, pi, touch)

  // 7. Print: the moved letters with their own pixels, the new ones from
  // their exemplars, and what travels with the tail.
  for (const [i, c] of movers) printShifted(cellRegion(li, i, W), c.dx, c.dy)
  for (const k of tailLoose) printShifted(looseRegion(li, k, W), dxTail, dyTail)
  for (const r of tailRules) printShifted(ruleRegion(r), dxTail, dyTail)
  // A bilevel scan's letters hold no grey, and a sub-pixel shift (below) is a
  // resample that puts grey rows into a glyph: there each lands on the whole
  // pixel nearest its baseline, as the scan's own letters do.
  let bilevel: boolean | undefined
  for (const c of nc) {
    if (c.kind !== 'synth' || !c.glyph) continue
    const g = c.glyph
    const cx = c.x + (g.inkR - g.inkL) / 2
    // On the baseline to the sub-pixel: rounded, each glyph lands up to half
    // a pixel off it, two neighbours a whole pixel apart — "PYT000123" came
    // out with its first new "0" a pixel above the next.
    const yExact = base(cx) - g.baseY
    const Y0 = Math.floor(yExact), fy = yExact - Y0
    const X = Math.round(c.x - g.inkL)
    if (fy > 0.2 && fy < 0.8 && bilevel === undefined) {
      if (lineEdge === undefined) lineEdge = edgeWidthOf(pi, li)
      bilevel = lineEdge !== null && lineEdge <= 0.65
    }
    if (fy > 0.2 && fy < 0.8 && !bilevel) printGlyph(work, W, s.h, shiftDown(g, fy), X, Y0, touch)
    else printGlyph(work, W, s.h, g, X, fy >= 0.8 ? Y0 + 1 : Y0, touch)
  }
  for (const plan of ulPlans) if (plan) plan.print(work, pi, touch)

  // The new words, for the text layer.
  const words: EditOutcome['words'] = []
  for (let j = 0; j < nc.length; j++) {
    const c = nc[j]
    const w = c.kind === 'orig' ? li.cells[c.old].inkR - li.cells[c.old].inkL : c.glyph!.inkR - c.glyph!.inkL
    if (j === 0 || c.space) words.push({ text: c.ch, x0: c.x, x1: c.x + w, base: base(c.x) })
    else { const last = words[words.length - 1]; last.text += c.ch; last.x1 = Math.max(last.x1, c.x + w) }
  }
  if (nc.some(c => c.drawnAs === 'w')) notes.push('some letters re-weighed or re-sized from the page')
  return {
    ok: true, notes, words,
    // Letters drawn from text in another kind of face: the caller makes them
    // in the line's look if it can, and plans again.
    wanting: wanting.length ? wanting : undefined,
    box: box.x0 < box.x1 ? box : undefined,
    drawn: nc.map(c => c.drawnAs ?? '?').join(''),
    debug: { layout: layoutLog, underlines: ulPlans.map(p => p ? p.span : 'unchanged') }
  }
}

/**
 * The erased pixels relaxed to a harmonic fill of the ground around them.
 *
 * The paper estimate under a letter is push-pull over the pixels `preparePage`
 * did not call ink — and on a coloured, noisy ground (a scanned cover's JPEG
 * grain) the darker grain near the letters is called ink too, so the fill is
 * made from the brighter grain alone: a vacated word on a green cover came out
 * a shade lighter than the green around it, a box where it had been. Relaxed
 * (successive over-relaxation of the four-neighbour average) with the scan's
 * OWN pixels held fixed around the hole — the estimate only where a neighbour
 * is real ink — the fill takes the ground's true level, and a gradient stays
 * exact across it. On plain paper the two agree and nothing changes.
 */
function relaxErased(work: Uint8ClampedArray, erase: Set<number>, pi: PageInk, W: number, H: number, held?: (p: number) => boolean): void {
  if (!erase.size) return
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (const p of erase) { const x = p % W, y = (p - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  // A frame one pixel wider, for the fixed neighbours.
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(W - 1, x1 + 1); y1 = Math.min(H - 1, y1 + 1)
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1
  const free = new Uint8Array(bw * bh)
  const v = [new Float32Array(bw * bh), new Float32Array(bw * bh), new Float32Array(bw * bh)]
  const src = pi.s.data
  // A paper with a regular texture is relaxed on its LEVEL: the residual is
  // taken off every value first and put back on the hole afterwards, or the
  // harmonic fill smooths a security hatch into a clean patch.
  const tex = pi.texture
  const tx = (p: number, c: number) => tex ? tex[p * 3 + c] : 0
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const p = (y0 + y) * W + x0 + x, j = y * bw + x
    // A grid line through the hole is the grid (`PageInk.lines`): held, not relaxed away.
    if (erase.has(p) && pi.lines?.[p]) { for (let c = 0; c < 3; c++) { v[c][j] = pi.paper[p * 3 + c] - tx(p, c); work[p * 4 + c] = pi.paper[p * 3 + c] } }
    else if (erase.has(p) && held?.(p)) { for (let c = 0; c < 3; c++) v[c][j] = work[p * 4 + c] - tx(p, c) }
    else if (erase.has(p)) { free[j] = 1; for (let c = 0; c < 3; c++) v[c][j] = work[p * 4 + c] - tx(p, c) }
    else for (let c = 0; c < 3; c++) v[c][j] = (pi.dark[p] < 50 ? src[p * 4 + c] : pi.paper[p * 3 + c]) - tx(p, c)
  }
  const idx: number[] = []
  for (let j = 0; j < bw * bh; j++) if (free[j]) idx.push(j)
  const omega = 1.85
  for (let it = 0; it < 120; it++) {
    for (const j of idx) {
      const x = j % bw, y = (j - x) / bw
      const l = x > 0 ? j - 1 : j, r = x < bw - 1 ? j + 1 : j, u = y > 0 ? j - bw : j, d = y < bh - 1 ? j + bw : j
      for (let c = 0; c < 3; c++) {
        const a = v[c]
        a[j] += omega * ((a[l] + a[r] + a[u] + a[d]) * 0.25 - a[j])
      }
    }
  }
  const grain = groundGrain(erase, pi, W, H, x0, y0, bw, bh)
  for (const j of idx) {
    const x = j % bw, y = (j - x) / bw, p = (y0 + y) * W + x0 + x
    for (let c = 0; c < 3; c++) work[p * 4 + c] = v[c][j] + tx(p, c) + (grain ? grain[j * 3 + c] : 0)
  }
}

/**
 * The GRAIN of the ground beside a hole, to lay over its harmonic fill: a
 * fill is smooth, and on a JPEG cover's red, noisy to a few levels in every
 * 8×8 block, a vacated word showed as a clean patch with the outline of the
 * letters that had been there. The residual of the scan against its own local
 * mean is copied from the nearest patch of clean ground beside the hole —
 * shifted by a multiple of 8 pixels, so the compression's blocks stay where
 * they were. Null where there is no such patch, or no grain worth copying
 * (plain white paper, whose residual is a level or less: those scans stay
 * exactly as they were).
 */
function groundGrain(erase: Set<number>, pi: PageInk, W: number, H: number, x0: number, y0: number, bw: number, bh: number): Float32Array | null {
  const src = pi.s.data
  const clean = (q: number) => pi.dark[q] < FRINGE / 2 && !erase.has(q) && !pi.lines?.[q]
  const r8 = (v: number) => Math.ceil(v / 8) * 8
  const offsets: [number, number][] = [[r8(bw + 2), 0], [-r8(bw + 2), 0], [0, r8(bh + 2)], [0, -r8(bh + 2)], [r8(bw + 2), r8(bh + 2)], [-r8(bw + 2), -r8(bh + 2)]]
  let best: [number, number] | null = null, bestN = 0
  for (const [ox, oy] of offsets) {
    let n = 0, all = 0
    for (const p of erase) {
      const x = p % W + ox, y = Math.floor(p / W) + oy
      all++
      if (x >= 0 && y >= 0 && x < W && y < H && clean(y * W + x)) n++
    }
    if (n > bestN && n >= all * 0.7) { bestN = n; best = [ox, oy] }
  }
  if (!best) return null
  const [ox, oy] = best
  // The residual against a 9×9 mean of the clean pixels around it.
  const res = (q: number, c: number): number | null => {
    const qx = q % W, qy = (q - qx) / W
    let sum = 0, n = 0
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = qx + dx, y = qy + dy
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const u = y * W + x
      if (!clean(u)) continue
      sum += src[u * 4 + c]; n++
    }
    return n >= 20 ? src[q * 4 + c] - sum / n : null
  }
  const out = new Float32Array(bw * bh * 3)
  const mags: number[] = []
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const p = (y0 + y) * W + x0 + x
    if (!erase.has(p)) continue
    const qx = x0 + x + ox, qy = y0 + y + oy
    if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue
    const q = qy * W + qx
    if (!clean(q)) continue
    for (let c = 0; c < 3; c++) {
      const v = res(q, c)
      if (v === null) continue
      out[(y * bw + x) * 3 + c] = v
      mags.push(Math.abs(v))
    }
  }
  if (mags.length < 30) return null
  mags.sort((a, b) => a - b)
  return mags[mags.length >> 1] >= 1.5 ? out : null
}

/** Multiply a glyph's transmittance onto the working copy with its top-left at (X, Y). */
function printGlyph(work: Uint8ClampedArray, W: number, H: number, g: GlyphImage, X: number, Y: number, touch: (p: number) => void): void {
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const i = y * g.w + x
    if (!g.m[i]) continue
    const tx = X + x, ty = Y + y
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue
    const q = ty * W + tx
    work[q * 4] = work[q * 4] * g.t[i * 3] / 255
    work[q * 4 + 1] = work[q * 4 + 1] * g.t[i * 3 + 1] / 255
    work[q * 4 + 2] = work[q * 4 + 2] * g.t[i * 3 + 2] / 255
    touch(q)
  }
}

interface UnderlinePlan {
  span: string
  erase(work: Uint8ClampedArray, pi: PageInk, touch: (p: number) => void): void
  print(work: Uint8ClampedArray, pi: PageInk, touch: (p: number) => void): void
}

/**
 * The rules that are UNDERLINES: below the baseline, running under letters
 * of the line for most of their length. A form's blank (a rule with nothing,
 * or handwriting the reading missed, above it) and a table border are not:
 * they are left where they are, or move with the tail as a whole.
 */
/** The extent of rule `r` together with the rules it continues into end to end — the steps of one tilted rule. */
function ruleChain(li: LineInk, r: LineInk['rules'][number]): [number, number] {
  const yAt = (q: LineInk['rules'][number], x: number) => q.y + q.slope * (x - q.centreX)
  let x0 = r.x0, x1 = r.x1
  for (let grew = true; grew;) {
    grew = false
    for (const q of li.rules) {
      if (q.x1 <= x1 && q.x0 >= x0) continue
      const tol = Math.max(3, Math.max(q.thick, r.thick) + 1)
      if (q.x0 >= x1 - 2 && q.x0 <= x1 + 4 && Math.abs(yAt(q, q.x0) - yAt(r, x1)) <= tol) { x1 = q.x1; grew = true }
      else if (q.x1 <= x0 + 2 && q.x1 >= x0 - 4 && Math.abs(yAt(q, q.x1) - yAt(r, x0)) <= tol) { x0 = q.x0; grew = true }
    }
  }
  return [x0, x1]
}

function rulesUnder(li: LineInk, base: (x: number) => number, em: number): LineInk['rules'] {
  return li.rules.filter(r => {
    const by = base((r.x0 + r.x1) / 2)
    const ry = r.y + r.slope * ((r.x0 + r.x1) / 2 - r.centreX)
    if (!(ry > by - em * 0.05 && ry < by + em * 0.45)) return false
    // A rule that runs on past what was analysed — off either end of the
    // line's box — is a table's border or a form's line, not this text's
    // underline: cut to the box, a narrow cell's text covered most of it, and
    // an edit "trimmed the underline" by breaking the table's rule. Judged
    // with the segments it continues into: a tilted rule is found as
    // stair-steps, and its last step ended inside the box.
    const [cx0, cx1] = ruleChain(li, r)
    if (cx0 <= li.roi.x0 + 1 || cx1 >= li.roi.x1 - 1) return false
    // …and so is one that ends at a cell's border, or crosses one.
    if (li.borders.some(x => x > cx0 - 4 && x < cx1 + 4)) return false
    let covered = 0
    for (const c of li.cells) {
      if (c.inkR <= c.inkL) continue
      covered += Math.max(0, Math.min(c.inkR, r.x1) - Math.max(c.inkL, r.x0))
    }
    return covered >= (r.x1 - r.x0) * 0.45
  })
}

/**
 * Carry an underline to the new letters. Old letters it ran under keep it
 * over their new place; a new letter inherits it from the letters of its OWN
 * word (an entirely new word, from the words on both sides of it). Inherited
 * from the nearest underlined letter anywhere on the line, a word typed after
 * a form's label took the label's underline across the whole line. The rule
 * keeps its own pixels where it stays, is trimmed where it no longer has
 * letters over it, and is extended with its own columns (and its own end cap)
 * where the new letters reach past it.
 */
function planUnderline(li: LineInk, u: LineInk['rules'][number], nc: NewChar[], tokenOf: Int32Array): UnderlinePlan | null {
  const covered = (i: number) => {
    const c = li.cells[i]
    const a = Math.max(c.inkL, u.x0), b = Math.min(c.inkR, u.x1)
    return c.inkR > c.inkL && b - a >= (c.inkR - c.inkL) * 0.5
  }
  const under: (boolean | null)[] = nc.map(c => c.kind === 'orig' ? covered(c.old) : null)
  // Within a token: from the nearest kept letter of the same token.
  for (let j = 0; j < nc.length; j++) {
    if (under[j] !== null) continue
    for (let d = 1; d < nc.length && under[j] === null; d++) {
      for (const k of [j - d, j + d]) {
        if (under[j] !== null || k < 0 || k >= nc.length || tokenOf[k] !== tokenOf[j] || nc[k].kind !== 'orig') continue
        under[j] = covered(nc[k].old)
      }
    }
  }
  // A token with no kept letter: underlined when the tokens either side are.
  for (let j = 0; j < nc.length; j++) {
    if (under[j] !== null) continue
    let l = j - 1, r = j + 1
    while (l >= 0 && tokenOf[l] === tokenOf[j]) l--
    while (r < nc.length && tokenOf[r] === tokenOf[j]) r++
    under[j] = l >= 0 && r < nc.length && under[l] === true && under[r] === true
  }
  const idx = under.map((v, j) => v ? j : -1).filter(j => j >= 0)
  const oldCovered = li.cells.map((_, i) => covered(i))
  const oldFirst = oldCovered.indexOf(true), oldLast = oldCovered.lastIndexOf(true)
  if (oldFirst < 0) return null
  const leadIn = li.cells[oldFirst].inkL - u.x0, leadOut = u.x1 - li.cells[oldLast].inkR
  const widthOf = (c: NewChar) => c.kind === 'orig' ? li.cells[c.old].inkR - li.cells[c.old].inkL : c.glyph!.inkR - c.glyph!.inkL
  const newX0 = idx.length ? Math.round(nc[idx[0]].x - leadIn) : u.x1
  const newX1 = idx.length ? Math.round(nc[idx[idx.length - 1]].x + widthOf(nc[idx[idx.length - 1]]) + leadOut) : u.x1
  if (newX0 === u.x0 && newX1 === u.x1) return null
  // The rule's rows at a column: its centre line ± its half thickness and a pixel of fringe.
  const yAt = (x: number) => u.y + u.slope * (x - u.centreX)
  const half = Math.max(1, Math.ceil(u.thick / 2) + 1)
  const CAP = Math.max(2, Math.round(u.thick))
  return {
    span: `${newX0}-${newX1}`,
    erase(work, pi, touch) {
      const Wd = pi.s.w
      const clear = (x: number) => {
        if (x < 0 || x >= Wd) return
        const yc = Math.round(yAt(x))
        for (let y = yc - half - 1; y <= yc + half + 1; y++) {
          if (y < 0 || y >= pi.s.h) continue
          const p = y * Wd + x
          // Only the rule's pixels and its grey fringe: never a letter's
          // descender that crosses it (those are erased with their letter).
          if (pi.dark[p] < 20) continue
          work[p * 4] = pi.paper[p * 3]; work[p * 4 + 1] = pi.paper[p * 3 + 1]; work[p * 4 + 2] = pi.paper[p * 3 + 2]
          touch(p)
        }
      }
      // Trimmed ends, and the old end caps where the rule grows (they are
      // printed again at the new ends).
      for (let x = u.x0; x < Math.min(u.x1, newX0); x++) clear(x)
      for (let x = Math.max(u.x0, newX1); x < u.x1; x++) clear(x)
      if (newX1 > u.x1) for (let x = u.x1 - CAP; x < u.x1; x++) clear(x)
      if (newX0 < u.x0) for (let x = u.x0; x < u.x0 + CAP; x++) clear(x)
    },
    print(work, pi, touch) {
      const Wd = pi.s.w, s = pi.s
      const copyCol = (from: number, to: number) => {
        const yf = Math.round(yAt(from)), yt = Math.round(yAt(to))
        for (let dy = -half - 1; dy <= half + 1; dy++) {
          const ys = yf + dy, yd = yt + dy
          if (ys < 0 || ys >= s.h || yd < 0 || yd >= s.h || to < 0 || to >= Wd) continue
          const p = ys * Wd + from, q = yd * Wd + to
          for (let ch = 0; ch < 3; ch++) {
            const paper = pi.paper[p * 3 + ch]
            const t = paper > 0 ? Math.min(1, s.data[p * 4 + ch] / paper) : 1
            work[q * 4 + ch] = work[q * 4 + ch] * t
          }
          touch(q)
        }
      }
      // Interior tiles come from the rule's own middle, cycled so its grain repeats no faster than the source.
      const tileFrom = Math.max(u.x0 + CAP, Math.round((u.x0 + u.x1) / 2) - 12)
      const tileTo = Math.min(u.x1 - CAP, tileFrom + 24)
      const tile = (k: number) => tileFrom + (((k % (tileTo - tileFrom)) + (tileTo - tileFrom)) % (tileTo - tileFrom))
      if (tileTo <= tileFrom) return
      if (newX1 > u.x1) {
        for (let x = u.x1 - CAP, k = 0; x < newX1 - CAP; x++, k++) copyCol(tile(k), x)
        for (let k = 0; k < CAP; k++) copyCol(u.x1 - CAP + k, newX1 - CAP + k)
      } else if (newX1 < u.x1 && newX1 > u.x0 + CAP) {
        // The trimmed end gets the old end cap.
        for (let k = 0; k < CAP; k++) copyCol(u.x1 - CAP + k, newX1 - CAP + k)
      }
      if (newX0 < u.x0) {
        for (let x = newX0 + CAP, k = 0; x < u.x0 + CAP; x++, k++) copyCol(tile(k), x)
        for (let k = 0; k < CAP; k++) copyCol(u.x0 + k, newX0 + k)
      }
    }
  }
}

/**
 * The overlay for a region of the page: the working copy's pixels where they
 * differ from the scan, transparent where they do not. Pixels left as they
 * were cost nothing to draw and cannot disagree with the scan under them.
 */
export function overlayOf(orig: Uint8ClampedArray, work: Uint8ClampedArray, W: number, box: { x0: number; y0: number; x1: number; y1: number }): { rgba: Uint8ClampedArray; w: number; h: number; changed: number } {
  const w = box.x1 - box.x0, h = box.y1 - box.y0
  const rgba = new Uint8ClampedArray(w * h * 4)
  let changed = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = ((box.y0 + y) * W + box.x0 + x) * 4, o = (y * w + x) * 4
    const diff = orig[p] !== work[p] || orig[p + 1] !== work[p + 1] || orig[p + 2] !== work[p + 2]
    rgba[o] = work[p]; rgba[o + 1] = work[p + 1]; rgba[o + 2] = work[p + 2]
    if (diff) { rgba[o + 3] = 255; changed++ }
  }
  return { rgba, w, h, changed }
}
