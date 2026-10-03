import type { Atlas, Exemplar } from './glyphAtlas'
import type { GlyphImage } from './scanEdit'
import { reweighImage } from './scanEdit'
import type { RasterGlyph } from './glyphRaster'
import { CORE, strokeEdgeWidths } from './lineInk'
export type { RasterGlyph } from './glyphRaster'
export { rasterizeGlyph } from './glyphRaster'

/**
 * Letters the scan does not hold at all, made to look as if it did.
 *
 * The page's own letters (glyphAtlas.ts) cover what the document printed; a
 * "W" in a document that never printed one has no exemplar in any weight. It
 * is drawn from a FONT then — one metric-compatible with what offices print
 * (Carlito ≈ Calibri, Arimo ≈ Arial, Tinos ≈ Times New Roman, Caladea ≈
 * Cambria; public/fonts/match, OFL) — chosen, and degraded, by comparison
 * with the page's own letters: the face whose letters agree best with the
 * scan's, blurred and toned the way the scan blurs and tones its own. The
 * result is in the exemplars' form (transmittance over the paper) and prints
 * exactly like them.
 *
 * Rasterising is MuPDF's (`rasterizeGlyph` takes the module, so the worker and
 * the node lab run the same code); everything else is DOM-free.
 */

export interface MatchFace {
  family: string
  /** File stems under /fonts/match. */
  regular: string
  bold: string
  italic?: string
  boldItalic?: string
}

export const MATCH_FACES: MatchFace[] = [
  { family: 'Carlito', regular: 'Carlito-Regular', bold: 'Carlito-Bold', italic: 'Carlito-Italic', boldItalic: 'Carlito-BoldItalic' },
  { family: 'Arimo', regular: 'Arimo-Regular', bold: 'Arimo-Bold' },
  { family: 'Tinos', regular: 'Tinos-Regular', bold: 'Tinos-Bold' },
  { family: 'Caladea', regular: 'Caladea-Regular', bold: 'Caladea-Bold' }
]

export function faceFile(face: MatchFace, bold: boolean): string {
  return bold ? face.bold : face.regular
}

/** How the scan prints: the face, and its blur and tone. */
export interface ScanLook {
  family: string
  /** Gaussian blur, px. */
  sigma: number
  /** Coverage → darkness exponent. */
  gamma: number
  /** Mean agreement with the page's letters over the probes (0..1). */
  score: number
  /** The face's x-height and cap height over its em, measured on its own glyphs. */
  xhPerEm: number
  capPerEm: number
  /**
   * Which of the face's weights each of the page's weight classes prints
   * like. A page set almost entirely in bold has no regular to split it from:
   * its "regular" class IS bold, and judged against the regular face a bold
   * Times page chose a sans.
   */
  regularAs?: 'regular' | 'bold'
  boldAs?: 'regular' | 'bold'
}

/** Separable Gaussian blur of a w × h field. */
function blur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.05) return src.slice()
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float32Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r] }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0
    for (let i = -r; i <= r; i++) { const xx = x + i; if (xx >= 0 && xx < w) a += src[y * w + xx] * k[i + r] }
    tmp[y * w + x] = a
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0
    for (let i = -r; i <= r; i++) { const yy = y + i; if (yy >= 0 && yy < h) a += tmp[yy * w + x] * k[i + r] }
    out[y * w + x] = a
  }
  return out
}

/** Darkness of a rasterised glyph as the scan would print it. */
export function printedDarkness(g: RasterGlyph, sigma: number, gamma: number): Float32Array {
  const b = blur(g.cov, g.w, g.h, sigma)
  for (let i = 0; i < b.length; i++) b[i] = Math.pow(Math.min(1, b[i]), gamma)
  return b
}

/** An exemplar's darkness (1 − its transmittance's luma), 0..1. */
export function exemplarDarkness(ex: Pick<Exemplar, 't' | 'w' | 'h'>): Float32Array {
  const d = new Float32Array(ex.w * ex.h)
  for (let i = 0; i < d.length; i++) d[i] = 1 - (ex.t[i * 3] * 299 + ex.t[i * 3 + 1] * 587 + ex.t[i * 3 + 2] * 114) / 1000 / 255
  return d
}

/**
 * How well a printed glyph matches an exemplar: normalised cross-correlation
 * of the two darkness fields with their ink-left edges and baselines aligned,
 * best over a pixel of slack each way.
 */
export function agreement(a: Float32Array, aw: number, ah: number, aInkL: number, aBase: number,
                   b: Float32Array, bw: number, bh: number, bInkL: number, bBase: number): number {
  let best = -1
  for (let sy = -1; sy <= 1; sy++) for (let sx = -1; sx <= 1; sx++) {
    // b's pixel (x, y) sits over a's (x + ox, y + oy).
    const ox = Math.round(aInkL - bInkL) + sx, oy = Math.round(aBase - bBase) + sy
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0
    const x0 = Math.min(0, ox), y0 = Math.min(0, oy), x1 = Math.max(aw, bw + ox), y1 = Math.max(ah, bh + oy)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const va = x >= 0 && y >= 0 && x < aw && y < ah ? a[y * aw + x] : 0
      const bx = x - ox, by = y - oy
      const vb = bx >= 0 && by >= 0 && bx < bw && by < bh ? b[by * bw + bx] : 0
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n++
    }
    if (!n) continue
    const cov = sab / n - (sa / n) * (sb / n)
    const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2
    if (va <= 0 || vb <= 0) continue
    const r = cov / Math.sqrt(va * vb)
    if (r > best) best = r
  }
  return best
}

export type Rasterize = (fontFile: string, chars: string[], emPx: number) => Promise<(RasterGlyph | null)[]>

const PROBES = 'aeonsrtidlcumpbgh'
/**
 * Capitals and figures, for a page that sets too few lowercase letters to
 * judge by — a form in capitals, a table of amounts, a title page. Without
 * them no face could be fitted to such a page at all, and every letter it
 * lacked (one appended "X") sent the whole line to the vector redraw.
 */
const CAP_PROBES = 'EAONRSTILDCMPBHU0123456789'

/** An exemplar's own ink height: rows from its top ink to its baseline. */
function inkHeight(ex: Exemplar): number | null {
  for (let y = 0; y < ex.h; y++) for (let x = 0; x < ex.w; x++) if (ex.m[y * ex.w + x] && ex.t[(y * ex.w + x) * 3] < 200) return ex.baseY - y
  return null
}

/**
 * Choose the face and the blur that make a font print like this scan: the
 * page's own regular letters (the established, most typical copy of each of a
 * dozen common ones) against each candidate face rendered at the same x-height,
 * blurred and toned over a small grid. Null when the page holds too few
 * letters to judge by.
 */
export async function fitScanLook(atlas: Atlas, rasterize: Rasterize, opts: { log?: (line: string) => void; near?: LookNear } = {}): Promise<ScanLook | null> {
  const picked = lookRefs(atlas, opts.near)
  if (!picked) return null
  const { refs, boldRef, capRef } = picked
  return fitOnRefs(refs, boldRef, capRef, rasterize, opts)
}

/**
 * The page letters a look is judged on: for each probe letter, its most
 * typical copy (regular class first). Capitals and figures carry their own
 * ink height, which is what they are sized by.
 */
export interface LookNear {
  /** The line a letter is wanted for, its page and its em. */
  line: string
  page: number
  emPx: number
}

export function lookRefs(atlas: Atlas, near?: LookNear): { refs: Exemplar[]; boldRef: Set<Exemplar>; capRef: Map<Exemplar, number> } | null {
  // The pool, nearest first. A page sets several faces — a logo, a heading,
  // the body — and a look fitted to their mix picked a flared sans for a
  // certificate's Times Bold body line, because the four letters it was
  // judged on came from the logo. The wanting line's own letters first, then
  // those of lines set at its size (an em within 12%) on its page, then the
  // whole document.
  const tiers: ((ex: Exemplar) => boolean)[] = near
    ? [
        ex => ex.lineId === near.line && ex.page === near.page,
        ex => ex.page === near.page && Math.abs(ex.emPx / near.emPx - 1) <= 0.12,
        ex => Math.abs(ex.emPx / near.emPx - 1) <= 0.12,
        () => true
      ]
    : [() => true]
  for (let t = 0; t < tiers.length; t++) {
    const inPool = (ex: Exemplar) => tiers.slice(0, t + 1).some(f => f(ex))
    const picked = pickRefs(atlas, inPool)
    if (picked) return picked
  }
  return null
}

function pickRefs(atlas: Atlas, inPool: (ex: Exemplar) => boolean): { refs: Exemplar[]; boldRef: Set<Exemplar>; capRef: Map<Exemplar, number> } | null {
  const byChar = (ch: string) => (atlas.byChar.get(ch) ?? []).filter(inPool)
  // The references: for each probe letter, its regular exemplars' medoid copy.
  const refs: Exemplar[] = []
  const boldRef = new Set<Exemplar>()
  /** Capitals and figures are sized by their own height; lowercase by the x-height. */
  const capRef = new Map<Exemplar, number>()
  const isBold = (ex: Exemplar) => atlas.boldAt !== null && (ex.weight ?? 0) >= atlas.boldAt
  const lowerCount = [...PROBES].filter(ch => byChar(ch).filter(ex => !ex.doubt && ex.xh).length >= 3).length
  const probes = lowerCount >= 6 ? PROBES : PROBES + CAP_PROBES
  // Three copies of a letter make its typical shape trustworthy. A page that
  // holds fewer of most letters (a certificate's few lines of capitals) is
  // judged on single copies instead: one mislabelled copy among eight probe
  // letters moves the average agreement, it does not decide it.
  const enough = (min: number) => [...probes].filter(ch => byChar(ch).filter(ex => !ex.doubt).length >= min).length
  const minCopies = enough(3) >= 4 ? 3 : 1
  for (const ch of probes) {
    const cap = CAP_PROBES.includes(ch)
    const usable = (ex: Exemplar) => !ex.doubt && (cap ? (inkHeight(ex) ?? 0) > 4 : !!ex.xh)
    let list = byChar(ch).filter(ex => usable(ex) && !isBold(ex))
    let bold = false
    // A page set mostly in bold (a form's labels) judges the face by its bold.
    if (list.length < minCopies) { list = byChar(ch).filter(ex => usable(ex) && isBold(ex)); bold = true }
    if (list.length < minCopies) continue
    const m = atlas.medoids.get(`${ch}|${bold}`)
    let best = list[0], bestA = -1
    if (m) for (const ex of list) {
      // Closest to the established shape, a whole and isolated copy first.
      let s = 0
      for (let k = 0; k < m.shape.length; k++) s -= Math.abs(m.shape[k] - ex.shape[k])
      if (ex.isolated) s += 0.05
      if (s > bestA) { bestA = s; best = ex }
    }
    refs.push(best)
    if (bold) boldRef.add(best)
    if (cap) capRef.set(best, inkHeight(best)!)
    if (refs.length >= 8) break
  }
  if (refs.length < 4) return null
  return { refs, boldRef, capRef }
}

async function fitOnRefs(refs: Exemplar[], boldRef: Set<Exemplar>, capRef: Map<Exemplar, number>, rasterize: Rasterize, opts: { log?: (line: string) => void }): Promise<ScanLook | null> {
  let bestLook: ScanLook | null = null
  let bestFit = -Infinity
  // The look is chosen on shape AND on stroke width. Shape agreement is a
  // correlation, blind to weight once the blur has spread the strokes:
  // against a heavy bold serif every face's regular scored what its bold did
  // (0.89 to 0.95 either way), the regular was as likely to be chosen, and the
  // letter synthesised for "Universidad" came out a pale, thin "s" in the
  // middle of the word. A stem's darkness summed across it is its width,
  // whatever the blur — the page's taken over its ink's darkness (black at
  // least three quarters: a thin black stroke on a coarse scan never prints
  // full, and read as grey ink it measured twice its width). The score
  // reported, and gated on, stays the shape agreement.
  const darks = refs.map(ex => exemplarDarkness(ex))
  const refStems = refs.map((ex, i) => {
    const inkDark = Math.max(0.75, 1 - (ex.inkT[0] * 299 + ex.inkT[1] * 587 + ex.inkT[2] * 114) / 1000 / 255)
    const cov = new Float32Array(darks[i].length)
    for (let k = 0; k < cov.length; k++) cov[k] = ex.m[k] ? Math.min(1, darks[i][k] / inkDark) : 0
    return stemOf(cov, ex.w, ex.h, ex.baseY, ex.emPx)
  })
  const stemFactor = (i: number, g: RasterGlyph | null, em: number): number | null => {
    const want = refStems[i]
    const have = g ? stemOf(g.cov, g.w, g.h, g.baseY, em) : null
    if (want === null || have === null) return null
    return Math.min(want, have) / Math.max(want, have)
  }
  for (const face of MATCH_FACES) {
    // The face's own proportions, from its x and H at a nominal size.
    const nominal = 100
    const [gx, gH] = await rasterize(face.regular, ['x', 'H'], nominal)
    if (!gx || !gH) continue
    const xhPerEm = (gx.baseY - gx.top) / nominal, capPerEm = (gH.baseY - gH.top) / nominal
    // Both weights of the face for every reference: the page's weight
    // classes are the atlas's guess, and the face is chosen on SHAPE.
    const emOf = (ex: Exemplar) => capRef.has(ex) ? capRef.get(ex)! / capPerEm : (ex.xh ?? ex.emPx * 0.5) / xhPerEm
    const reg = await Promise.all(refs.map(ex => rasterize(face.regular, [ex.char], emOf(ex)).then(r => r[0])))
    const bld = await Promise.all(refs.map(ex => rasterize(face.bold, [ex.char], emOf(ex)).then(r => r[0])))
    const regW = refs.map((ex, i) => stemFactor(i, reg[i], emOf(ex)))
    const bldW = refs.map((ex, i) => stemFactor(i, bld[i], emOf(ex)))
    let faceBest = -1
    for (const sigma of [0.45, 0.65, 0.85, 1.05, 1.3]) for (const gamma of [0.75, 1, 1.35]) {
      let sum = 0, shapeSum = 0, n = 0
      // Per weight class, how often the face's bold fitted better.
      let regBold = 0, regN = 0, boldBold = 0, boldN = 0
      for (let i = 0; i < refs.length; i++) {
        const ex = refs[i]
        const judge = (g: RasterGlyph | null) => {
          if (!g) return -1
          return agreement(darks[i], ex.w, ex.h, ex.inkL, ex.baseY, printedDarkness(g, sigma, gamma), g.w, g.h, g.inkL, g.baseY)
        }
        const ar = judge(reg[i]), ab = judge(bld[i])
        if (ar < 0 && ab < 0) continue
        // The weight by its stems where both can be measured, else by shape;
        // the face, the blur and the tone by shape.
        const rw = regW[i], bw = bldW[i]
        const useBold = ab >= 0 && (ar < 0 || (rw !== null && bw !== null ? bw > rw : ab > ar))
        sum += useBold ? ab : ar
        shapeSum += useBold ? ab : ar
        n++
        if (boldRef.has(ex)) { boldN++; if (useBold) boldBold++ } else { regN++; if (useBold) regBold++ }
      }
      if (n < 4) continue
      const fit = sum / n
      faceBest = Math.max(faceBest, shapeSum / n)
      if (!bestLook || fit > bestFit) {
        bestFit = fit
        bestLook = {
          family: face.family, sigma, gamma, score: shapeSum / n, xhPerEm, capPerEm,
          regularAs: regN && regBold > regN / 2 ? 'bold' : 'regular',
          boldAs: boldN && boldBold <= boldN / 2 ? 'regular' : 'bold'
        }
      }
    }
    opts.log?.(`${face.family}: ${faceBest.toFixed(3)}`)
  }
  return bestLook
}

/**
 * The glyph for `char` in the scan's look, as the transplant prints it: sized
 * so its x-height (else its cap height) is the target line's, blurred and
 * toned like the scan, in the line's ink, and re-weighed to the stem the
 * page's own letters of that weight have.
 */
/** A line's core level as a darkness, 0..1 (lineInk's `CORE`). */
const CORE_DARK = CORE / 255

export async function synthGlyph(look: ScanLook, rasterize: Rasterize, atlas: Atlas, req: { char: string; emPx: number; xh: number | null; capH?: number | null; bold: boolean; ink: [number, number, number]; coreDark?: number; stem?: number | null; stemChars?: string | null; edge?: number | null }): Promise<GlyphImage | null> {
  const face = MATCH_FACES.find(f => f.family === look.family)
  if (!face) return null
  const emRender = req.xh ? req.xh / look.xhPerEm : req.capH ? req.capH / look.capPerEm : req.emPx * 0.9
  // The weight the page's class prints like (see `ScanLook.regularAs`).
  const heavy = req.bold ? (look.boldAs ?? 'bold') === 'bold' : look.regularAs === 'bold'
  const [g] = await rasterize(faceFile(face, heavy), [req.char], emRender)
  if (!g) return null
  // Blurred as soft as the LINE's own edges, measured the same way on both.
  // The look's blur is fitted on the page's references, and a face that does
  // not quite match correlates better blurred: a cover's crisp 44 px "RYAN"
  // was given an "X" at the grid's softest, fitted on small lowercase
  // elsewhere on the page — a blurred letter beside sharp ones.
  let sigma = look.sigma
  if (req.edge) {
    let best = Infinity
    for (let s = 0; s <= 2.501; s += 0.1) {
      const dd = printedDarkness(g, s, look.gamma)
      const ws = strokeEdgeWidths((x, y) => dd[y * g.w + x], 0, g.w, 0, g.h, 0.5, emRender * 0.25)
      if (ws.length < 8) continue
      ws.sort((a, b) => a - b)
      const err = Math.abs(ws[ws.length >> 1] - req.edge)
      if (err < best - 1e-9) { best = err; sigma = s }
    }
  }
  const d = printedDarkness(g, sigma, look.gamma)
  // Its stems as dark as the line's own: the blur leaves a rendered stem's
  // core short of full ink, and a synthesised letter read grey beside the
  // scan's. The cores' darkness over the ink's is what a stem has to reach.
  // Like is compared with like: the line's figure is the MEDIAN of its core
  // pixels (darkness 110 and over), so the glyph's is the median of its own
  // pixels that print that dark. Aiming the glyph's 90th percentile at the
  // line's median toned a bold serif's "s" to four fifths of its neighbours'
  // stroke centres — a grey letter in a black word.
  let bestK = 1
  if (req.coreDark) {
    const inkLum = (req.ink[0] * 299 + req.ink[1] * 587 + req.ink[2] * 114) / 1000 / 255
    const inkAbs = Math.max(0.3, 1 - inkLum)
    const coreMedian = (k: number) => {
      const v: number[] = []
      for (let i = 0; i < d.length; i++) { const a = Math.min(1, d[i] * k) * inkAbs; if (a >= CORE_DARK) v.push(a) }
      return v.length >= 5 ? v.sort((a, b) => a - b)[Math.floor(v.length / 2)] : null
    }
    let bestErr = Infinity
    for (let k = 0.7; k <= 2.0001; k += 0.05) {
      const m = coreMedian(k)
      if (m === null) continue
      const err = Math.abs(m - req.coreDark)
      if (err < bestErr - 1e-9) { bestErr = err; bestK = k }
    }
    if (bestK !== 1) for (let i = 0; i < d.length; i++) d[i] = Math.min(1, d[i] * bestK)
  }
  const t = new Uint8ClampedArray(g.w * g.h * 3).fill(255)
  const m = new Uint8Array(g.w * g.h)
  for (let i = 0; i < d.length; i++) {
    if (d[i] < 0.015) continue
    m[i] = 1
    for (let c = 0; c < 3; c++) t[i * 3 + c] = 255 * (1 - d[i] * (1 - req.ink[c] / 255))
  }
  let img: GlyphImage = { t, m, w: g.w, h: g.h, baseY: g.baseY, inkL: g.inkL, inkR: g.inkR }
  // The stem of the word it goes into (else the page's letters of its
  // weight), against the face's. The page's is darkness summed across a
  // stroke, the glyph's is in shares of its ink: compared as they were, a
  // letter on grey ink was thinned to the grey's share of the stem — an "X"
  // after "Bo08-190845" came out a hairline beside the figures.
  const inkShare = Math.max(0.3, 1 - (req.ink[0] * 299 + req.ink[1] * 587 + req.ink[2] * 114) / 1000 / 255)
  const pageStem = (req.stem ?? (req.bold ? atlas.stem.bold : atlas.stem.regular)) * req.emPx / inkShare
  const have = stemOf(d, g.w, g.h, g.baseY, emRender)
  // Like against like: a word's stem is a median over every stroke its
  // letters cross, and a curve or a diagonal is crossed wider than a stem.
  // The face is measured on the SAME characters, printed as this glyph is,
  // and the glyph takes the ratio of the page's word to the face's word —
  // the letters' shapes cancel. Against the raw stem, a "1" put into
  // "09/08/2023" was thickened to the crossings of its 0s, 9s and 8s.
  let want = pageStem
  if (req.stem != null && req.stemChars && have !== null) {
    const chars = [...req.stemChars].filter(ch => ch.trim()).slice(0, 16)
    if (chars.length >= 2) {
      const gs = await rasterize(faceFile(face, heavy), chars, emRender)
      const runs: number[] = []
      for (const gi of gs) {
        if (!gi) continue
        const di = printedDarkness(gi, sigma, look.gamma)
        if (bestK !== 1) for (let i = 0; i < di.length; i++) di[i] = Math.min(1, di[i] * bestK)
        stemRuns(di, gi.w, gi.h, gi.baseY, emRender, runs)
      }
      if (runs.length >= 4) {
        runs.sort((a, b) => a - b)
        const faceStem = runs[Math.floor(runs.length / 2)]
        if (faceStem > 0) want = have * pageStem / faceStem
      }
    }
  }
  if (have !== null && Math.abs(want - have) > 0.25) {
    const delta = Math.max(-1.2, Math.min(1.2, want - have))
    img = reweighImage(img, delta, delta * 0.35)
  }
  return img
}

/** A glyph's stem: darkness summed across each stroke a row of its x-height band crosses, the median. */
function stemOf(d: Float32Array, w: number, h: number, baseY: number, emPx: number): number | null {
  const runs: number[] = []
  stemRuns(d, w, h, baseY, emPx, runs)
  if (runs.length < 3) return null
  runs.sort((a, b) => a - b)
  return runs[Math.floor(runs.length / 2)]
}

/** Every stroke crossing `stemOf` takes its median of, appended to `runs`. */
function stemRuns(d: Float32Array, w: number, h: number, baseY: number, emPx: number, runs: number[]): void {
  // As lineInk's word weight: a crossing wider than a stem is a bar, not a stem.
  const maxRun = Math.max(4, emPx * 0.24)
  for (let y = Math.round(baseY - emPx * 0.38); y <= Math.round(baseY - emPx * 0.12); y++) {
    if (y < 0 || y >= h) continue
    let sum = 0, len = 0, inRun = false
    for (let x = 0; x <= w; x++) {
      const v = x < w ? d[y * w + x] : 0
      if (v > 0.15) { inRun = true; sum += v; len++ }
      else if (inRun) { if (sum > 0.5 && len <= maxRun) runs.push(sum); inRun = false; sum = 0; len = 0 }
    }
  }
}

/** `stemOf`, for the lab's look report. */
export const stemOfForLab = stemOf
