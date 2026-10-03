import { cellRegion, pageOfLine, type PageInk, type LineInk, type LineCell } from './lineInk'
import { expectedAdvance } from './glyphCut'

/**
 * The page's own letters, cut out of the scan, for typesetting an edit.
 *
 * A letter typed into a scanned line has to look like the letters around it:
 * the same face, the same size, the same weight, the same blur, the same
 * grain. No font does that — not a base-14 face, not one traced from the
 * scan. The scan itself does: it holds hundreds of instances of most letters,
 * printed by the same printer and scanned by the same scanner as the line
 * being edited. An exemplar is one such instance, kept as its TRANSMITTANCE
 * over the paper (pixel ÷ the paper behind it): multiplied onto any paper, it
 * prints that letter exactly as the scan did.
 *
 * Which instance stands for a letter is decided by agreement: the copies of a
 * letter are compared with each other and the most typical one (the medoid)
 * is taken. A cell holding the wrong ink — a misreading, a cut one letter off —
 * is never the most typical of its letter's copies.
 *
 * DOM-free.
 */

export interface Exemplar {
  char: string
  /** Crop box in the source page's pixels. */
  x0: number
  y0: number
  w: number
  h: number
  /** Transmittance, RGB interleaved, 0..255 (255 = paper): the pixel over the paper behind it. */
  t: Uint8ClampedArray
  /** Which crop pixels belong to the glyph (core and fringe). */
  m: Uint8Array
  /** Baseline row in crop coordinates (fractional), and the ink's columns in the crop, [inkL, inkR). */
  baseY: number
  inkL: number
  inkR: number
  /** The source line's em, x-height and cap height, px. */
  emPx: number
  xh: number | null
  capH: number | null
  /** Stem weight of the word it came from (stem / em). */
  weight: number | null
  page: number
  lineId: string
  isolated: boolean
  /** Recogniser confidence of the line it came from. */
  conf: number
  /** Its line's ink over its paper, RGB 0..255 — to tone it to another line's ink. */
  inkT: [number, number, number]
  /** Shape descriptor (darkness on a grid in ems about the baseline). */
  shape: Float32Array
  /**
   * It looks more like ANOTHER letter's established shape than like its own:
   * a misreading the cut could not see ("El" read "EI"), or a cell one letter
   * off. Never picked.
   */
  doubt?: boolean
  /** Why: the letter it looks most like, with both agreements — for the lab. */
  doubtNote?: string
}

export interface SpacingModel {
  mu: number
  R: Map<string, number>
  L: Map<string, number>
  n: number
}

export interface Atlas {
  byChar: Map<string, Exemplar[]>
  /** Word weight (stem / em) at or above which a word is bold — null when the pages show one weight only. */
  boldAt: number | null
  spacing: { regular: SpacingModel; bold: SpacingModel }
  /** Word gaps measured on the pages, in ems: the fallback for a line that has too few of its own. */
  wordGapEm: number
  /** Median stem weight (stem / em) of the regular words and of the bold ones. */
  stem: { regular: number; bold: number }
  /** Each established letter's medoid shape and how closely its copies agree with it, keyed `char|bold`. */
  medoids: Map<string, { shape: Float32Array; cohesion: number }>
}

/** The x-height and cap height of a line, px, from its cut letters. */
export function lineMetrics(li: LineInk, opts: { loose?: boolean } = {}): { xh: number | null; capH: number | null } {
  const base = (x: number) => li.fit.y + li.fit.slope * (x - li.fit.centreX)
  const measure = (approx: boolean) => {
    const xs: number[] = [], caps: number[] = [], figures: number[] = []
    for (const c of li.cells) {
      if (c.approx !== approx || c.suspect || c.inkR <= c.inkL || !c.pix.length) continue
      const h = base((c.inkL + c.inkR) / 2) - c.top
      if (/^[acemnorsuvwxz]$/.test(c.char)) xs.push(h)
      else if (/^[A-HK-PR-Z]$/.test(c.char)) caps.push(h)
      else if (/^[0-9]$/.test(c.char)) figures.push(h)
    }
    const med = (v: number[]) => v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : null
    // A line of figures alone (a DNI, an amount in a table cell) has no capital
    // to size one by: its figures stand in, lining figures being cap height to
    // within a few percent. Sized from the em instead, an "X" appended to an
    // eight-digit number came out at four fifths of the digits' height.
    // Figures are not always cap height, though: old-style ones stand lower,
    // so a capital the line does show (the S of "S/ 250.00") outranks them.
    const capH = caps.length >= 2 ? med(caps) : figures.length >= 2 ? Math.max(med(figures)! / 0.98, caps[0] ?? 0) : null
    return { xh: xs.length >= 3 ? med(xs) : null, capH }
  }
  const exact = measure(false)
  if (!opts.loose || (exact.xh !== null && exact.capH !== null)) return exact
  // For sizing a letter the line is given: a word that could not be cut
  // still has its letters about where its reading puts them, and a letter's
  // TOP is where the ink is over its columns. On a low-resolution receipt no
  // word of "S/ 250.00" cut, and an "X" sized from the em came out the height
  // of a lowercase x.
  const loose = measure(true)
  return { xh: exact.xh ?? loose.xh, capH: exact.capH ?? loose.capH }
}

/** The grid a shape is compared on: COLS × ROWS cells over [inkL, inkL + 1.1 em] × [base − 1.05 em, base + 0.35 em]. */
const COLS = 11, ROWS = 14

function shapeOf(t: Uint8ClampedArray, m: Uint8Array, w: number, h: number, baseY: number, inkL: number, emPx: number): Float32Array {
  const out = new Float32Array(COLS * ROWS)
  const cw = emPx * 1.1 / COLS, ch = emPx * 1.4 / ROWS
  const top = baseY - emPx * 1.05
  const n = new Float32Array(COLS * ROWS)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    if (!m[i]) continue
    const gx = Math.floor((x + 0.5 - inkL) / cw), gy = Math.floor((y + 0.5 - top) / ch)
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) continue
    const d = 1 - (t[i * 3] * 299 + t[i * 3 + 1] * 587 + t[i * 3 + 2] * 114) / 1000 / 255
    out[gy * COLS + gx] += d
    n[gy * COLS + gx] += 1
  }
  // Mean darkness per cell over the cell's AREA (pixels outside the glyph are paper).
  const area = cw * ch
  for (let k = 0; k < out.length; k++) out[k] = out[k] / Math.max(1, area)
  return out
}

/** 1 − the mean absolute difference of two shapes, scaled so identical = 1 and a letter against blank paper ≈ 0. */
export function shapeAgreement(a: Float32Array, b: Float32Array): number {
  let diff = 0, mass = 0
  for (let k = 0; k < a.length; k++) { diff += Math.abs(a[k] - b[k]); mass += a[k] + b[k] }
  return mass > 0 ? 1 - diff / mass : 0
}

/**
 * The exemplars one line offers: every letter of a word that was cut, not
 * flagged, with ink. Its pixel set is its core grown by its fringe — two
 * pixels, never into another letter's core, a rule or another line.
 */
export function harvestLine(pi: PageInk, li: LineInk, page: number, out: Exemplar[]): void {
  const s = pi.s
  const base = (x: number) => li.fit.y + li.fit.slope * (x - li.fit.centreX)
  const { xh, capH } = lineMetrics(li)
  for (const word of li.words) {
    // Only a word whose n-th run of ink is its n-th letter: see `LineWord.exact`.
    if (!word.cut || !word.exact) continue
    for (let k = word.from; k < word.to; k++) {
      const c = li.cells[k]
      if (c.suspect || c.approx || c.inkR <= c.inkL || c.pix.length < 3) continue
      const ex = cutExemplar(pi, li, c, k, base, word.weight, xh, capH, page)
      if (ex) out.push(ex)
    }
  }
}

function cutExemplar(pi: PageInk, li: LineInk, c: LineCell, k: number, base: (x: number) => number, weight: number | null, xh: number | null, capH: number | null, page: number): Exemplar | null {
  const s = pi.s
  // The letter's region: its core, fringe and haze, nothing nearer another ink.
  const set = new Set(cellRegion(li, k, s.w))
  if (!set.size) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of set) {
    const x = p % s.w, y = (p - x) / s.w
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1
  const t = new Uint8ClampedArray(w * h * 3).fill(255)
  const m = new Uint8Array(w * h)
  for (const p of set) {
    const x = p % s.w, y = (p - x) / s.w
    const i = (y - y0) * w + (x - x0)
    m[i] = 1
    for (let ch = 0; ch < 3; ch++) {
      const paper = pi.paper[p * 3 + ch]
      t[i * 3 + ch] = paper > 0 ? Math.min(255, Math.round(255 * s.data[p * 4 + ch] / paper)) : 255
    }
  }
  const cx = (c.inkL + c.inkR) / 2
  const baseY = base(cx) - y0
  const p0 = c.pix[0]
  const inkT = [0, 1, 2].map(ch => Math.min(255, Math.round(255 * li.ink[ch] / Math.max(1, pi.paper[p0 * 3 + ch])))) as [number, number, number]
  const inkL = c.inkL - x0, inkR = c.inkR - x0
  return {
    char: c.char, x0, y0, w, h, t, m, baseY, inkL, inkR,
    emPx: li.fit.emPx, xh, capH, weight, page, lineId: li.id, isolated: c.isolated, conf: li.confidence, inkT,
    shape: shapeOf(t, m, w, h, baseY, inkL, li.fit.emPx)
  }
}

/**
 * `core` grown by `r` pixels (8-neighbourhood steps), never into a pixel
 * `blocked` says belongs to something else; `core` itself is always in.
 */
export function grownSet(W: number, H: number, core: ArrayLike<number>, r: number, blocked: (p: number) => boolean): Set<number> {
  const set = new Set<number>()
  for (let i = 0; i < core.length; i++) set.add(core[i])
  let frontier = Array.from(set)
  for (let step = 0; step < r; step++) {
    const next: number[] = []
    for (const p of frontier) {
      const x = p % W, y = (p - x) / W
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const q = ny * W + nx
        if (set.has(q) || blocked(q)) continue
        set.add(q)
        next.push(q)
      }
    }
    frontier = next
  }
  return set
}

/**
 * Mark the exemplars that look more like another letter than their own.
 *
 * A letter with four copies or more of one weight has an ESTABLISHED shape,
 * its medoid. Every exemplar is compared with every established shape of its
 * weight: one closer to another letter's than to its own letter's (or, when
 * its own letter is not established, one that matches another letter's shape
 * closely) holds the wrong ink under its label. Copies are compared on a
 * sample of up to 40 per class — enough to find a medoid.
 */
function markDoubts(byChar: Map<string, Exemplar[]>, boldAt: number | null): Map<string, { shape: Float32Array; cohesion: number }> {
  const boldOf = (ex: Exemplar) => boldAt !== null && ex.weight !== null && ex.weight >= boldAt
  const medoids: { char: string; bold: boolean; shape: Float32Array; cohesion: number }[] = []
  for (const [char, list] of byChar) {
    for (const bold of [false, true]) {
      const members = list.filter(ex => boldOf(ex) === bold)
      if (members.length < 4) continue
      const sample = members.length > 40 ? members.filter((_, i) => i % Math.ceil(members.length / 40) === 0) : members
      let best: Exemplar | null = null, bestMean = -1
      for (const a of sample) {
        let sum = 0
        for (const b of sample) if (a !== b) sum += shapeAgreement(a.shape, b.shape)
        const mean = sum / (sample.length - 1)
        if (mean > bestMean) { bestMean = mean; best = a }
      }
      if (best) {
        // How closely the class's own copies agree with it: the bar another
        // letter's copy has to clear to be mistaken for one of them.
        const agreements = sample.filter(e => e !== best).map(e => shapeAgreement(e.shape, best!.shape)).sort((a, b) => a - b)
        medoids.push({ char, bold, shape: best.shape, cohesion: agreements[Math.floor(agreements.length / 2)] ?? 0.85 })
      }
    }
  }
  for (const [char, list] of byChar) {
    for (const ex of list) {
      const bold = boldOf(ex)
      let own = -1, ownCohesion = 0.85, other = -1, otherChar = '', otherCohesion = 0.85
      for (const m of medoids) {
        if (m.bold !== bold) continue
        const a = shapeAgreement(ex.shape, m.shape)
        if (m.char === char) { own = a; ownCohesion = m.cohesion }
        else if (a > other) { other = a; otherChar = m.char; otherCohesion = m.cohesion }
      }
      ex.doubtNote = `own ${own.toFixed(2)} vs "${otherChar}" ${other.toFixed(2)}`
      // A letter with no established shape of its own is doubted only when it
      // would pass for a TYPICAL copy of another letter: a bold "5" agrees with
      // the bold "6" at 0.8, where the 6s agree with each other at ~0.88.
      ex.doubt = own >= 0 ? other > own + 0.02 : other >= Math.min(0.9, otherCohesion - 0.03)
      // And a copy far less like its letter than the letter's copies are like
      // each other, about as like another letter, is no copy to draw from: an
      // "N" cut from a misread line agreed 0.72 with the N's and 0.73 with the
      // R's, where N's agree at ~0.9 — drawn in a reversed word, it printed as
      // an "A".
      if (own >= 0 && own < ownCohesion - 0.12 && other >= own - 0.03) ex.doubt = true
      // Wider than its letter can be: the cell holds a neighbour as well
      // (";/" under "/"). A narrow letter's ink is far under its advance,
      // so only the upper side is tested.
      if ((ex.inkR - ex.inkL) / ex.emPx > expectedAdvance(char) * 1.3 + 0.08) ex.doubt = true
    }
  }
  return new Map(medoids.map(m => [`${m.char}|${m.bold}`, { shape: m.shape, cohesion: m.cohesion }]))
}

/** Otsu's split of a list of values; null when they do not divide. */
function otsuSplit(values: number[]): number | null {
  const v = [...values].sort((a, b) => a - b)
  const n = v.length
  if (n < 6) return null
  const pre = [0]
  for (const x of v) pre.push(pre[pre.length - 1] + x)
  let best = -1, at = -1
  for (let k = 2; k <= n - 2; k++) {
    const m1 = pre[k] / k, m2 = (pre[n] - pre[k]) / (n - k)
    const between = k * (n - k) * (m2 - m1) ** 2
    if (between > best) { best = between; at = k }
  }
  if (at < 0) return null
  const lo = v.slice(0, at), hi = v.slice(at)
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length
  // Two weights, not one weight's spread: the classes' means a third apart
  // at least, and each holding a few words.
  if (lo.length < 3 || hi.length < 3 || mean(hi) < mean(lo) * 1.35) return null
  return (v[at - 1] + v[at]) / 2
}

/** The letter-gap model g(a, b) ≈ mu + R[a] + L[b] (ems), fitted by alternating ridge steps. */
function fitSpacing(obs: { a: string; b: string; g: number }[]): SpacingModel {
  const R = new Map<string, number>(), L = new Map<string, number>()
  if (!obs.length) return { mu: 0.06, R, L, n: 0 }
  const sorted = obs.map(o => o.g).sort((x, y) => x - y)
  let mu = sorted[Math.floor(sorted.length / 2)]
  const LAMBDA = 3
  for (let it = 0; it < 12; it++) {
    const rs = new Map<string, { s: number; n: number }>()
    for (const o of obs) { const e = rs.get(o.a) ?? { s: 0, n: 0 }; e.s += o.g - mu - (L.get(o.b) ?? 0); e.n++; rs.set(o.a, e) }
    for (const [ch, e] of rs) R.set(ch, e.s / (e.n + LAMBDA))
    const ls = new Map<string, { s: number; n: number }>()
    for (const o of obs) { const e = ls.get(o.b) ?? { s: 0, n: 0 }; e.s += o.g - mu - (R.get(o.a) ?? 0); e.n++; ls.set(o.b, e) }
    for (const [ch, e] of ls) L.set(ch, e.s / (e.n + LAMBDA))
    let s = 0
    for (const o of obs) s += o.g - (R.get(o.a) ?? 0) - (L.get(o.b) ?? 0)
    mu = s / obs.length
  }
  return { mu, R, L, n: obs.length }
}

export function predictGap(m: SpacingModel, a: string, b: string): number {
  return m.mu + (m.R.get(a) ?? 0) + (m.L.get(b) ?? 0)
}

/**
 * What one page contributes to the atlas: its exemplars and the measurements
 * the models are fitted on. Kept per page so a long document is harvested
 * lazily, page by page, and a page's 30 MB of pixels can be let go once its
 * letters (a few kilobytes each) have been cut out.
 */
export interface PageHarvest {
  page: number
  exemplars: Exemplar[]
  /** Word weights (stem / em) of words of three letters or more. */
  weights: number[]
  /** Letter gaps inside cut words (ems), with their word's weight. */
  gaps: { a: string; b: string; g: number; weight: number | null }[]
  /** Word gaps, ems. */
  wordGaps: number[]
}

export function harvestPage(pi: PageInk, lines: LineInk[], page: number): PageHarvest {
  const exemplars: Exemplar[] = []
  const weights: number[] = [], wordGaps: number[] = []
  const gaps: PageHarvest['gaps'] = []
  for (const li of lines) {
    harvestLine(pageOfLine(pi, li), li, page, exemplars)
    const em = li.fit.emPx
    // Only gaps the reading puts a space in: the ink's split also cuts one
    // word at a wide letter gap, and a page of capitals cells measured its
    // "word gap" at 0.15 em that way.
    for (let i = 1; i < li.words.length; i++) if (li.spaceAfter.has(li.words[i].from)) wordGaps.push((li.words[i].x0 - li.words[i - 1].x1) / em)
    for (const w of li.words) {
      if (w.weight !== null && w.to - w.from >= 3) weights.push(w.weight)
      if (!w.cut) continue
      for (let i = w.from + 1; i < w.to; i++) {
        const a = li.cells[i - 1], b = li.cells[i]
        if (a.suspect || b.suspect || a.inkR <= a.inkL || b.inkR <= b.inkL) continue
        const g = (b.inkL - a.inkR) / em
        if (g < -0.2 || g > 0.4) continue
        gaps.push({ a: a.char, b: b.char, g, weight: w.weight })
      }
    }
  }
  return { page, exemplars, weights, gaps, wordGaps }
}

/** Build the atlas from analysed lines (of one page or several pages scanned alike). */
export function buildAtlas(lines: { pi: PageInk; li: LineInk; page: number }[]): Atlas {
  const byPage = new Map<number, { pi: PageInk; lis: LineInk[] }>()
  for (const { pi, li, page } of lines) {
    const e = byPage.get(page) ?? { pi, lis: [] }
    e.lis.push(li)
    byPage.set(page, e)
  }
  return atlasFrom([...byPage.entries()].map(([page, e]) => harvestPage(e.pi, e.lis, page)))
}

/** The atlas over a set of page harvests. */
export function atlasFrom(harvests: PageHarvest[]): Atlas {
  const all = harvests.flatMap(h => h.exemplars)
  const weights = harvests.flatMap(h => h.weights)
  const boldAt = otsuSplit(weights)
  const byChar = new Map<string, Exemplar[]>()
  for (const ex of all) {
    ex.doubt = false
    const list = byChar.get(ex.char) ?? []
    list.push(ex)
    byChar.set(ex.char, list)
  }
  const medoids = markDoubts(byChar, boldAt)
  const regular: { a: string; b: string; g: number }[] = [], bold: { a: string; b: string; g: number }[] = []
  for (const h of harvests) {
    for (const o of h.gaps) {
      const isBold = boldAt !== null && o.weight !== null && o.weight >= boldAt
      ;(isBold ? bold : regular).push(o)
    }
  }
  const wordGaps = harvests.flatMap(h => h.wordGaps).sort((a, b) => a - b)
  const med = (v: number[]) => v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : null
  const regW = med(weights.filter(w => boldAt === null || w < boldAt)) ?? 0.06
  const boldW = med(weights.filter(w => boldAt !== null && w >= boldAt)) ?? regW * 1.7
  return {
    byChar, boldAt,
    spacing: { regular: fitSpacing(regular), bold: fitSpacing(bold.length >= 20 ? bold : [...bold, ...regular]) },
    wordGapEm: wordGaps.length ? wordGaps[Math.floor(wordGaps.length / 2)] : 0.28,
    stem: { regular: regW, bold: boldW },
    medoids
  }
}

export interface GlyphRequest {
  char: string
  /** The target line's em, x-height and cap height, px. */
  emPx: number
  xh: number | null
  capH?: number | null
  bold: boolean
  /**
   * The face the letter is wanted in, as the target line's own letters near
   * it show it: copies are taken from lines whose letters look like these.
   */
  style?: { line: string; refs: { char: string; shape: Float32Array }[] }
}

export interface PickedGlyph {
  ex: Exemplar
  /** Scale to apply (1 within 4%). */
  scale: number
  /** How many copies agreed with it. */
  support: number
}

/** Agreement two copies of a letter show when they really are the same letter. */
const AGREE = 0.62

/** Each source line's copies by letter, per atlas. */
const lineIndex = new WeakMap<Atlas, Map<string, Map<string, Exemplar[]>>>()
function copiesOnLine(atlas: Atlas, line: string): Map<string, Exemplar[]> {
  let idx = lineIndex.get(atlas)
  if (!idx) {
    idx = new Map()
    for (const [ch, list] of atlas.byChar) for (const ex of list) {
      if (ex.doubt) continue
      let m = idx.get(ex.lineId)
      if (!m) { m = new Map(); idx.set(ex.lineId, m) }
      let l = m.get(ch)
      if (!l) { l = []; m.set(ch, l) }
      l.push(ex)
    }
    lineIndex.set(atlas, idx)
  }
  return idx.get(line) ?? new Map()
}

/**
 * The copies whose LINE is set in the face the request wants. A form sets
 * its labels in one face and its values in another, at one size and weight,
 * and the medoid of all their copies drew a reversed serif label
 * ("CORRELATIVO" → "OVITALERROC") in the sans of the values. Each source
 * line is scored on the letters it shares with the request's references
 * (each reference against that line's closest copy, two letters at least);
 * the copies kept are those of the lines within a few hundredths of the best.
 * All of them when no line can be scored — or when none is left.
 */
function inStyle(atlas: Atlas, req: GlyphRequest, copies: Exemplar[]): Exemplar[] {
  const refs = req.style?.refs
  if (!refs || refs.length < 2) return copies
  const scores = new Map<string, number | null>()
  const scoreOf = (line: string): number | null => {
    if (scores.has(line)) return scores.get(line)!
    let v: number | null
    if (line === req.style!.line) v = 1
    else {
      const own = copiesOnLine(atlas, line)
      let sum = 0, n = 0
      for (const r of refs) {
        const list = own.get(r.char)
        if (!list) continue
        let best = 0
        for (const ex of list) best = Math.max(best, shapeAgreement(ex.shape, r.shape))
        sum += best
        n++
      }
      v = n >= 2 ? sum / n : null
    }
    scores.set(line, v)
    return v
  }
  const known = copies.map(ex => scoreOf(ex.lineId)).filter((v): v is number => v !== null)
  if (!known.length) return copies
  const top = Math.max(...known)
  const kept = copies.filter(ex => { const v = scoreOf(ex.lineId); return v !== null && v >= top - 0.05 })
  return kept.length ? kept : copies
}

/**
 * The exemplar that stands for `req.char` at the request's size and weight:
 * the medoid of the compatible copies, provided it is typical enough of them
 * and — when it is the only copy — clean (whole, alone, from a confident
 * line). Null when the pages hold no trustworthy copy.
 */
export function pickGlyph(atlas: Atlas, req: GlyphRequest): PickedGlyph | null {
  const list = atlas.byChar.get(req.char)
  if (!list?.length) return null
  // Sizes compare on what both lines measured: the x-height, else the cap
  // height. The em a line's fit reports is the least reliable of the three —
  // 21 to 25 px across lines set in the same 9 pt face on one page.
  const sizeRatio = (ex: Exemplar) => (req.xh && ex.xh) ? req.xh / ex.xh : (req.capH && ex.capH) ? req.capH / ex.capH : req.emPx / ex.emPx
  const boldOf = (ex: Exemplar) => atlas.boldAt === null ? false : ex.weight === null ? null : ex.weight >= atlas.boldAt
  const compatible = inStyle(atlas, req, list.filter(ex => {
    if (ex.doubt) return false
    const r = sizeRatio(ex)
    if (r < 0.9 || r > 1.11) return false
    const b = boldOf(ex)
    return b === null ? false : b === req.bold
  }))
  if (!compatible.length) return null
  // The copies closest in size first, among which the medoid is chosen.
  compatible.sort((a, b) => Math.abs(Math.log(sizeRatio(a))) - Math.abs(Math.log(sizeRatio(b))))
  const pool = compatible.slice(0, 24)
  let best: Exemplar | null = null, bestScore = -1, bestSupport = 0
  for (const a of pool) {
    let sum = 0, agree = 0
    for (const b of pool) {
      if (a === b) continue
      const sim = shapeAgreement(a.shape, b.shape)
      sum += sim
      if (sim >= AGREE) agree++
    }
    const mean = pool.length > 1 ? sum / (pool.length - 1) : 0
    // Ties go to a whole, isolated letter from a confident line.
    const score = mean + (a.isolated ? 0.03 : 0) + (a.conf >= 90 ? 0.01 : 0)
    if (score > bestScore) { bestScore = score; best = a; bestSupport = agree }
  }
  if (!best) return null
  if (pool.length === 1) {
    if (!best.isolated || best.conf < 85) return null
  } else if (bestSupport < 1) {
    // Copies that do not agree: with two or three, one of them may simply be
    // the odd one out. A copy that is whole and alone, that the cross-letter
    // check did not doubt, from a confident line, stands; otherwise none.
    if (pool.length > 3) return null
    const alone = pool.filter(e => e.isolated && e.conf >= 90).sort((a, b) => b.conf - a.conf)
    if (!alone.length) return null
    best = alone[0]
  }
  const r = sizeRatio(best)
  // Within 7% the copy is used at its own size: a resample softens the stem
  // more visibly than a few percent of size shows.
  return { ex: best, scale: Math.abs(r - 1) <= 0.07 ? 1 : r, support: bestSupport }
}

/** Why each copy of a letter would or would not be picked — for the lab. */
export function explainPick(atlas: Atlas, req: GlyphRequest): string[] {
  const list = atlas.byChar.get(req.char) ?? []
  const sizeRatio = (ex: Exemplar) => (req.xh && ex.xh) ? req.xh / ex.xh : (req.capH && ex.capH) ? req.capH / ex.capH : req.emPx / ex.emPx
  return list.map(ex => {
    const bold = atlas.boldAt === null ? false : ex.weight === null ? null : ex.weight >= atlas.boldAt
    return `${ex.doubtNote ?? ''} ${ex.lineId} p${ex.page} w=${ex.weight?.toFixed(3)} bold=${bold} ratio=${sizeRatio(ex).toFixed(3)} (xh ${ex.xh?.toFixed(1)} cap ${ex.capH?.toFixed(1)} em ${ex.emPx.toFixed(1)}) doubt=${!!ex.doubt} iso=${ex.isolated} conf=${ex.conf}`
  })
}

/**
 * The shape of a run of ink given by its CORE pixels (page indices) — a
 * letter of a word the cut never labelled, to check it against a letter's
 * established shape. Its region is the core and every pixel near it that the
 * line owns, so it is described as an exemplar would be.
 */
export function shapeOfCore(pi: PageInk, li: LineInk, core: ArrayLike<number>): Float32Array | null {
  if (!core.length) return null
  const s = pi.s
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (let k = 0; k < core.length; k++) {
    const p = core[k], x = p % s.w, y = (p - x) / s.w
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
  }
  const inkL = x0, inkR = x1
  const W = li.roi.x1 - li.roi.x0
  const coreSet = new Set<number>()
  for (let k = 0; k < core.length; k++) coreSet.add(core[k])
  x0 -= 2; x1 += 2; y0 -= 2; y1 += 2
  const w = x1 - x0 + 1, h = y1 - y0 + 1
  const t = new Uint8ClampedArray(w * h * 3).fill(255)
  const m = new Uint8Array(w * h)
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue
    const p = y * s.w + x
    // The core, and the fringe around it inside its own columns: a
    // neighbouring letter's fringe is not this one's.
    let mine = coreSet.has(p)
    if (!mine && x >= inkL - 1 && x <= inkR + 1 && x >= li.roi.x0 && x < li.roi.x1 && y >= li.roi.y0 && y < li.roi.y1) {
      const o = li.owner[(y - li.roi.y0) * W + (x - li.roi.x0)]
      mine = o >= 0 && o < li.cells.length
    }
    if (!mine) continue
    const i = (y - y0) * w + (x - x0)
    m[i] = 1
    for (let c = 0; c < 3; c++) {
      const paper = pi.paper[p * 3 + c]
      t[i * 3 + c] = paper > 0 ? Math.min(255, Math.round(255 * s.data[p * 4 + c] / paper)) : 255
    }
  }
  const baseY = li.fit.y + li.fit.slope * ((inkL + inkR) / 2 - li.fit.centreX) - y0
  return shapeOf(t, m, w, h, baseY, inkL - x0, li.fit.emPx)
}

/** A line cell's shape on the atlas's grid — to check it against its label's established shape. */
export function cellShapeOf(pi: PageInk, li: LineInk, k: number): Float32Array | null {
  const c = li.cells[k]
  if (!c || !c.pix.length || c.inkR <= c.inkL) return null
  const base = (x: number) => li.fit.y + li.fit.slope * (x - li.fit.centreX)
  const ex = cutExemplar(pi, li, c, k, base, null, null, null, -1)
  return ex?.shape ?? null
}
