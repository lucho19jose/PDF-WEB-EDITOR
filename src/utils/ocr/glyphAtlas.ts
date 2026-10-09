import { cellRegion, pageOfLine, type PageInk, type LineInk, type LineCell } from './lineInk'
import { expectedAdvance } from './glyphCut'
import { baselineAtOf } from './wordSeg'

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
  /** The median height of its line's figures above the baseline, px (old-style figures stand lower than capitals). */
  figH?: number | null
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
  /** Doubted against its letter's medoid, which is another size's (another face's), but its own size's copies agree with it: picked when nothing else can be. */
  peerVouched?: boolean
  /**
   * Doubted only against a medoid set in the other kind of face (`faceAt`),
   * and its peers in its own face vouch for it: picked when nothing else can
   * be, for a request known to want this face — never for one whose face is
   * unknown, where it would put a serif letter in a sans word.
   */
  faceVouched?: FaceClass
  /**
   * Doubted only on a comparison its size makes unreliable: its letter's
   * medoid is another size, no copy at its own size can vouch for it, and it
   * is no more like another letter than like its own (a small "7" agreed 0.64
   * with the body text's 7 and 0.65 with its 1). For a request from its OWN
   * line — the same face, size and weight by definition — it is still the
   * best copy there is: picked there when nothing else can be.
   */
  ownLineOnly?: boolean
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
  medoids: Map<string, { shape: Float32Array; cohesion: number; emPx?: number }>
  /** How often each word (`vocabKey`) is read on the pages — what the document says elsewhere. */
  vocab?: Map<string, number>
  /** The same, case kept (`formKey`). */
  forms?: Map<string, number>
}

/** A reading's word with the punctuation around it dropped; '' for a token with no letter in it. */
export function formKey(token: string): string {
  const t = token.normalize('NFC').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  return /\p{L}/u.test(t) ? t : ''
}

/** A reading's word as the document's vocabulary counts it: `formKey`, case-folded. */
export function vocabKey(token: string): string {
  return formKey(token).toLowerCase()
}

/** The x-height and cap height of a line, px, from its cut letters. */
export function lineMetrics(li: LineInk, opts: { loose?: boolean } = {}): { xh: number | null; capH: number | null; figH: number | null } {
  const base = baselineAtOf(li.fit)
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
    return { xh: xs.length >= 3 ? med(xs) : null, capH, figH: figures.length >= 2 ? med(figures) : null }
  }
  const exact = measure(false)
  if (!opts.loose || (exact.xh !== null && exact.capH !== null)) return exact
  // For sizing a letter the line is given: a word that could not be cut
  // still has its letters about where its reading puts them, and a letter's
  // TOP is where the ink is over its columns. On a low-resolution receipt no
  // word of "S/ 250.00" cut, and an "X" sized from the em came out the height
  // of a lowercase x.
  const loose = measure(true)
  return { xh: exact.xh ?? loose.xh, capH: exact.capH ?? loose.capH, figH: exact.figH ?? loose.figH }
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
  const base = baselineAtOf(li.fit)
  const { xh, capH, figH } = lineMetrics(li)
  for (const word of li.words) {
    // Only a word whose n-th run of ink is its n-th letter: see `LineWord.exact`.
    if (!word.cut || !word.exact) continue
    for (let k = word.from; k < word.to; k++) {
      const c = li.cells[k]
      if (c.suspect || c.approx || c.inkR <= c.inkL || c.pix.length < 3) continue
      // A stop, a comma or a colon is SMALL: a cell labelled one that is a
      // figure's width is a figure read as one. A purchase order's quantity
      // column read "1.00" over ink whose stop was too faint to be a piece;
      // the "." took the first "0", every row gave the page the same
      // "full stop", and an amount typed "1,050.00" printed "1,050000".
      if (/^[.,:;'·]$/.test(c.char) && (c.inkR - c.inkL + 1 > li.fit.emPx * 0.24 || (c.char !== ':' && c.char !== ';' && c.bottom - c.top > li.fit.emPx * 0.4))) continue
      // A letter labelled without a mark whose ink rises well over its class
      // carries one the reading dropped: a cover's "HÁGASE" was read "HAGASE",
      // its "Á" went into the atlas as an "A", and "PIENSE" retyped
      // "PIENSA" came out "PIENSÁ".
      const rise = base((c.inkL + c.inkR) / 2) - c.top
      if (/^[A-Z]$/.test(c.char) && capH && rise > capH * 1.18) continue
      if (/^[acemnorsuvwxz]$/.test(c.char) && xh && rise > xh * 1.35) continue
      const ex = cutExemplar(pi, li, c, k, base, word.weight, xh, capH, page)
      if (ex) { ex.figH = figH; out.push(ex) }
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
function markDoubts(byChar: Map<string, Exemplar[]>, boldAt: number | null): Map<string, { shape: Float32Array; cohesion: number; emPx?: number }> {
  const boldOf = (ex: Exemplar) => boldAt !== null && ex.weight !== null && ex.weight >= boldAt
  const faceCache = new Map<Exemplar, FaceClass | null>()
  const faceOf = (ex: Exemplar) => {
    if (!faceCache.has(ex)) faceCache.set(ex, faceAt({ byChar }, ex.lineId, ex.x0 + (ex.inkL + ex.inkR) / 2, ex.emPx))
    return faceCache.get(ex)!
  }
  // A class's face: its medoid's, else what two thirds of the copies LIKE the
  // medoid are set in, of those whose face can be told (the medoid itself may
  // stand where no stem foot is near enough to tell; the copies of the other
  // face are the ones it does not look like).
  const classFace = (best: Exemplar, members: Exemplar[], cohesion: number): FaceClass | null => {
    const f = faceOf(best)
    if (f) return f
    let serif = 0, sans = 0
    for (const m of members) {
      if (shapeAgreement(m.shape, best.shape) < cohesion - 0.05) continue
      const g = faceOf(m)
      if (g === 'serif') serif++; else if (g === 'sans') sans++
    }
    return serif + sans >= 2 ? (serif >= 2 * sans ? 'serif' : sans >= 2 * serif ? 'sans' : null) : null
  }
  const medoids: { char: string; bold: boolean; shape: Float32Array; cohesion: number; emPx: number; face: FaceClass | null }[] = []
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
        const cohesion = agreements[Math.floor(agreements.length / 2)] ?? 0.85
        medoids.push({ char, bold, shape: best.shape, cohesion, emPx: best.emPx, face: classFace(best, members, cohesion) })
      }
    }
  }
  for (const [char, list] of byChar) {
    for (const ex of list) {
      const bold = boldOf(ex)
      let own = -1, ownCohesion = 0.85, ownEm = 0, ownFace: FaceClass | null = null, other = -1, otherChar = '', otherCohesion = 0.85
      for (const m of medoids) {
        if (m.bold !== bold) continue
        const a = shapeAgreement(ex.shape, m.shape)
        if (m.char === char) { own = a; ownCohesion = m.cohesion; ownEm = m.emPx; ownFace = m.face }
        else if (a > other) { other = a; otherChar = m.char; otherCohesion = m.cohesion }
      }
      // The medoid set in the other kind of face — a registry page's serif
      // headings beside its sans body, at one size — is no measure of this
      // copy either: its serif bold "E"s agreed 0.57 with the body's sans
      // "E" and 0.74 with a "D", every one was doubted, and a heading's
      // edit borrowed the sans "E". Its peers are then the copies in its OWN
      // kind of face.
      const face = own >= 0 && ownFace ? faceOf(ex) : null
      const otherFace = face !== null && face !== ownFace
      // A page sets its title in one face and its body in another, and the
      // letter's medoid is whichever face holds more copies: a book cover's
      // serif "I"s agreed 0.49 with the title's sans "I" and were doubted, so
      // an edit of the body synthesised its "I". Copies of the letter at its
      // own size (on a page, the size goes with the face) from OTHER words
      // that agree with it vouch for it (`peerVouched`) — a fallback for the
      // picker, never a reason to prefer it: un-doubted outright, such copies
      // were picked over true ones (a re-weighed regular "7" over the page's
      // bold one) on a page whose medoids were fine.
      if (own < 0 || ex.emPx / ownEm > 1.2 || ownEm / ex.emPx > 1.2 || otherFace) {
        const peers = list.filter(o => o !== ex && boldOf(o) === bold && o.emPx >= ex.emPx / 1.2 && o.emPx <= ex.emPx * 1.2 &&
          (o.lineId !== ex.lineId || Math.abs(o.x0 - ex.x0) > ex.emPx) && (!otherFace || faceOf(o) === face)).slice(0, 12)
        if (peers.length) {
          const ag = peers.map(o => shapeAgreement(ex.shape, o.shape)).sort((a, b) => a - b)
          const mid = ag[Math.floor(ag.length / 2)]
          if (mid >= 0.8 && mid > other + 0.02) {
            // Vouched for its face alone, it serves a request for that face only.
            if (otherFace && !(own < 0 || ex.emPx / ownEm > 1.2 || ownEm / ex.emPx > 1.2)) ex.faceVouched = face!
            else ex.peerVouched = true
          }
        }
      }
      ex.doubtNote = `own ${own.toFixed(2)} vs "${otherChar}" ${other.toFixed(2)}${ex.peerVouched ? ' (peers vouch)' : ex.faceVouched ? ` (${ex.faceVouched} peers vouch)` : ''}`
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
      const crossSize = own >= 0 && (ex.emPx / ownEm > 1.2 || ownEm / ex.emPx > 1.2)
      ex.ownLineOnly = !!ex.doubt && crossSize && !ex.peerVouched && other <= own + 0.02
      // Wider than its letter can be: the cell holds a neighbour as well
      // (";/" under "/"). A narrow letter's ink is far under its advance,
      // so only the upper side is tested.
      if ((ex.inkR - ex.inkL) / ex.emPx > expectedAdvance(char) * 1.3 + 0.08) { ex.doubt = true; ex.ownLineOnly = false }
    }
  }
  return new Map(medoids.map(m => [`${m.char}|${m.bold}`, { shape: m.shape, cohesion: m.cohesion, emPx: m.emPx }]))
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
  /** Its lines' words, counted (`formKey`). */
  forms: Map<string, number>
}

export function harvestPage(pi: PageInk, lines: LineInk[], page: number): PageHarvest {
  const exemplars: Exemplar[] = []
  const weights: number[] = [], wordGaps: number[] = []
  const gaps: PageHarvest['gaps'] = []
  const forms = new Map<string, number>()
  for (const li of lines) {
    for (const t of li.text.split(/\s+/)) { const f = formKey(t); if (f) forms.set(f, (forms.get(f) ?? 0) + 1) }
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
  return { page, exemplars, weights, gaps, wordGaps, forms }
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
  const forms = new Map<string, number>(), vocab = new Map<string, number>()
  for (const h of harvests) for (const [f, n] of h.forms ?? []) {
    forms.set(f, (forms.get(f) ?? 0) + n)
    const v = f.toLowerCase()
    vocab.set(v, (vocab.get(v) ?? 0) + n)
  }
  const med = (v: number[]) => v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : null
  const regW = med(weights.filter(w => boldAt === null || w < boldAt)) ?? 0.06
  const boldW = med(weights.filter(w => boldAt !== null && w >= boldAt)) ?? regW * 1.7
  return {
    byChar, boldAt,
    spacing: { regular: fitSpacing(regular), bold: fitSpacing(bold.length >= 20 ? bold : [...bold, ...regular]) },
    wordGapEm: wordGaps.length ? wordGaps[Math.floor(wordGaps.length / 2)] : 0.28,
    stem: { regular: regW, bold: boldW },
    medoids, vocab, forms
  }
}

export interface GlyphRequest {
  char: string
  /** The target line's em, x-height and cap height, px. */
  emPx: number
  xh: number | null
  capH?: number | null
  /** The target line's figures' median height, px — what a figure is sized by first. */
  figH?: number | null
  bold: boolean
  /**
   * The face the letter is wanted in, as the target line's own letters near
   * it show it: copies are taken from lines whose letters look like these.
   */
  style?: { line: string; refs: { char: string; shape: Float32Array }[]; face?: FaceClass | null }
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
 * Letters whose stem stands alone on the baseline: a serif face widens that
 * foot into a slab, a sans face leaves it as wide as the stem. The lowercase
 * n, m and r are left out: at body sizes their serifs are a pixel and merge
 * into the stem (a Times paragraph read 0.5 to 1.4 on them).
 */
const FOOT_CHARS = /^[ITHFPil]$/

/**
 * How much darker the last rows of a letter's stem are than its lower stem:
 * about 2 under a serif's slab, about 1 for a sans stem. Null for a letter
 * that shows no lone stem foot, or one too small to tell.
 */
export function footRatio(ex: Pick<Exemplar, 'char' | 't' | 'm' | 'w' | 'h' | 'baseY' | 'emPx' | 'xh' | 'capH'>): number | null {
  if (!FOOT_CHARS.test(ex.char)) return null
  const H = ex.char === 'i' ? ex.xh : (ex.capH ?? ex.emPx * 0.7)
  if (!H || H < 6) return null
  const row = (y: number) => {
    if (y < 0 || y >= ex.h) return 0
    let s = 0
    for (let x = 0; x < ex.w; x++) {
      const i = y * ex.w + x
      if (ex.m[i]) s += 1 - (ex.t[i * 3] * 299 + ex.t[i * 3 + 1] * 587 + ex.t[i * 3 + 2] * 114) / 1000 / 255
    }
    return s
  }
  const b = Math.round(ex.baseY)
  const foot = Math.max(row(b - 1), row(b - 2))
  const mids: number[] = []
  for (let y = Math.round(ex.baseY - 0.4 * H); y <= Math.round(ex.baseY - 0.22 * H); y++) mids.push(row(y))
  if (!mids.length) return null
  mids.sort((a, q) => a - q)
  const mid = mids[mids.length >> 1]
  return mid > 0.5 ? foot / mid : null
}

export type FaceClass = 'serif' | 'sans'

/** Each source line's stem feet (centre x in page px, `footRatio`), per letter map — doubted copies included: a doubt is about which letter, not which face. */
const footIndex = new WeakMap<Map<string, Exemplar[]>, Map<string, { x: number; r: number }[]>>()

/**
 * Whether the text around `x` on a line is set in a serif face or a sans one,
 * by the stem feet of its letters within eight ems, the five nearest: their
 * median over 1.5 is a serif's slab, between 0.75 and 1.2 a sans stem (under
 * 0.75 is a baseline found a pixel or two off, not a face). Two at least;
 * null when it cannot be told.
 */
export function faceAt(atlas: Pick<Atlas, 'byChar'>, line: string, x: number, emPx: number): FaceClass | null {
  let idx = footIndex.get(atlas.byChar)
  if (!idx) {
    idx = new Map()
    for (const list of atlas.byChar.values()) for (const ex of list) {
      const r = footRatio(ex)
      if (r === null) continue
      let l = idx.get(ex.lineId)
      if (!l) { l = []; idx.set(ex.lineId, l) }
      l.push({ x: ex.x0 + (ex.inkL + ex.inkR) / 2, r })
    }
    footIndex.set(atlas.byChar, idx)
  }
  const all = idx.get(line) ?? []
  const classOf = (fs: { r: number }[]): FaceClass | null => {
    if (fs.length < 2) return null
    const rs = fs.map(f => f.r).sort((a, b) => a - b)
    const med = rs.length % 2 ? rs[rs.length >> 1] : (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2
    return med >= 1.5 ? 'serif' : med <= 1.2 && med >= 0.75 ? 'sans' : null
  }
  const near = all.filter(f => Math.abs(f.x - x) <= 8 * emPx)
    .sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x)).slice(0, 5)
  // Too few within reach, or no clear answer there: the line's own feet, all
  // of them — a paragraph line set in one face shows them somewhere along it
  // even where a stretch holds none, or holds two a baseline found off.
  return classOf(near) ?? (all.length >= 3 ? classOf(all) : null)
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
  // The request's own line is in its own style by definition; the OTHER lines
  // compete among themselves. Measured against the own line's perfect 1, every
  // other line of the same face (0.85–0.9 is what one face agrees with itself
  // across lines) fell outside the margin, and a single copy on the own line —
  // the "8" of a bold "18/07/2022." that touches its slash, so not whole —
  // shut out every bold "8" the page printed elsewhere: the digit was
  // synthesised.
  const own = req.style!.line
  const known = copies.filter(ex => ex.lineId !== own).map(ex => scoreOf(ex.lineId)).filter((v): v is number => v !== null)
  if (!known.length) {
    const mine = copies.filter(ex => ex.lineId === own)
    return mine.length ? mine : copies
  }
  const top = Math.max(...known)
  const kept = copies.filter(ex => { const v = scoreOf(ex.lineId); return ex.lineId === own || (v !== null && v >= top - 0.05) })
  return kept.length ? kept : copies
}

/**
 * How much bigger the request's line sets this letter than the copy's line
 * did, measured on what both lines measured — and on the height the LETTER
 * stands at. A capital or a figure stands at the cap height, anything else on
 * the x-height, and the two need not keep one proportion from line to line:
 * a form's "RUC: 20613872893" line measured an x-height within 3% of the page
 * header's and a cap height 13% above it, and by x-height its "2" passed into
 * "Página: 2 de 3" two pixels taller than the "1" it replaced. The em a
 * line's fit reports is the least reliable measure of all — 21 to 25 px
 * across lines set in the same 9 pt face on one page — and is the last resort.
 */
function sizeRatioOf(req: GlyphRequest, ex: Exemplar): number {
  const base = req.char.normalize('NFD')[0] ?? req.char
  if (/^[A-Z]$/.test(base)) {
    // A capital by its OWN height first: a line can mix sizes (a form sets
    // "RUC: 20613872893" larger than the "Teléfono :" after it), and then
    // neither of its measures is the height of the letter taken from it.
    const own = req.capH ? ownCapHeight(ex) : null
    if (req.capH && own) return req.capH / own
    if (req.capH && ex.capH) return req.capH / ex.capH
    if (req.xh && ex.xh) return req.xh / ex.xh
  } else if (/^[0-9]$/.test(base)) {
    // A figure by the lines' cap heights first, its own height only where its
    // line measured none: OLD-STYLE figures stand at the x-height, rise or
    // fall below the baseline, and a receipt's "1980" → "1985" judged by
    // their own heights had every figure of the page refused and set in
    // lining figures instead.
    // Figures by FIGURES first, where both lines measured theirs: the same
    // face's figures are the same height on every line, whatever the em fit
    // made of a line of figures alone (a purchase order's "930.00" rows
    // fitted 10% larger than its "1.00" rows, and a "1" from those came out
    // re-weighed from the bold header instead).
    if (req.figH && ex.figH) return req.figH / ex.figH
    if (req.capH && ex.capH) return req.capH / ex.capH
    const own = req.capH && !ex.xh ? ownCapHeight(ex) : null
    if (req.capH && own) return req.capH / own
    if (req.xh && ex.xh) return req.xh / ex.xh
  } else {
    if (req.xh && ex.xh) return req.xh / ex.xh
    if (req.capH && ex.capH) return req.capH / ex.capH
  }
  return req.emPx / ex.emPx
}

/**
 * A capital's or a figure's own height over the baseline, px — what its
 * line's cap height would have measured. A line that measured neither
 * x-height nor cap height (a lone "8" in a table cell) could only be compared
 * by its em, and a line's em is the least reliable measure there is: that
 * "8" passed at 0.97 by em, and set into "9408100" it stood 2px short of the
 * figures beside it. Null for any other letter, whose height says nothing
 * about the line's.
 */
const ownCapCache = new WeakMap<Exemplar, number | null>()
function ownCapHeight(ex: Exemplar): number | null {
  if (ownCapCache.has(ex)) return ownCapCache.get(ex)!
  let v: number | null = null
  // The letters `lineMetrics` measures a cap height on, and figures as it
  // takes them (lining figures stand at 0.98 of it).
  const figure = /^[0-9]$/.test(ex.char)
  if (figure || /^[A-HK-PR-Z]$/.test(ex.char)) {
    // Its CORE — the fringe would add a row of anti-aliasing the line's own
    // measure does not count.
    const core = (j: number) => ex.m[j] && Math.min(ex.t[j * 3], ex.t[j * 3 + 1], ex.t[j * 3 + 2]) < 145
    let top = -1
    for (let y = 0; y < ex.h && top < 0; y++) for (let x = Math.max(0, Math.floor(ex.inkL)); x < Math.min(ex.w, Math.ceil(ex.inkR)); x++) if (core(y * ex.w + x)) { top = y; break }
    if (top >= 0 && ex.baseY - top > 2) v = (ex.baseY - top) / (figure ? 0.98 : 1)
  }
  ownCapCache.set(ex, v)
  return v
}

/**
 * The exemplar that stands for `req.char` at the request's size and weight:
 * the medoid of the compatible copies, provided it is typical enough of them
 * and — when it is the only copy — clean (whole, alone, from a confident
 * line). Null when the pages hold no trustworthy copy.
 */
export function pickGlyph(atlas: Atlas, req: GlyphRequest): PickedGlyph | null {
  return pickFrom(atlas, req, false) ?? pickFrom(atlas, req, true)
}

function pickFrom(atlas: Atlas, req: GlyphRequest, vouched: boolean): PickedGlyph | null {
  const list = atlas.byChar.get(req.char)
  if (!list?.length) return null
  // The second pass: copies doubted on grounds their own size or their own
  // line answers for (`peerVouched`, `ownLineOnly`).
  const fallback = (ex: Exemplar) => !!ex.doubt && (!!ex.peerVouched || (!!ex.faceVouched && ex.faceVouched === req.style?.face) || (!!ex.ownLineOnly && ex.lineId === req.style?.line))
  if (vouched && !list.some(fallback)) return null
  // Sizes compare on what both lines measured: the x-height, else the cap
  // height. The em a line's fit reports is the least reliable of the three —
  // 21 to 25 px across lines set in the same 9 pt face on one page.
  const sizeRatio = (ex: Exemplar) => sizeRatioOf(req, ex)
  const boldOf = (ex: Exemplar) => atlas.boldAt === null ? false : ex.weight === null ? null : ex.weight >= atlas.boldAt
  // A copy from text set in the other kind of face — a sans "H" for a serif
  // heading — is no copy at all: the letter is then made in the line's own
  // look, and only where it cannot be is such a copy used (`applyLineEdit`).
  // The shape scores cannot see this: one coarse grid per letter, and a sans
  // "E" agreed 0.76 with a serif title's letters where copies of one face
  // agree 0.78 across the lines of a table.
  const face = req.style?.face
  const otherFace = face ? (ex: Exemplar) => {
    const f = faceAt(atlas, ex.lineId, ex.x0 + (ex.inkL + ex.inkR) / 2, ex.emPx)
    return f !== null && f !== face
  } : () => false
  const compatible = inStyle(atlas, req, list.filter(ex => {
    if (ex.doubt && !(vouched && fallback(ex))) return false
    const r = sizeRatio(ex)
    if (r < 0.9 || r > 1.11) return false
    const b = boldOf(ex)
    if (b === null || b !== req.bold) return false
    return !otherFace(ex)
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

/** What copies of one face agree across lines (0.85–0.9) clear, and a sans letter against a serif title's (0.76) does not. */
const SAME_STYLE = 0.8

/**
 * How CONDENSED a line's letters are: the median of each letter's ink width
 * over the advance an ordinary face gives it (narrow letters left out — an I
 * is mostly side bearing). A face's fingerprint that needs no letter in
 * common: a cover's condensed "RICO" shares only its I with the "PIENSE"
 * above it, and measures 0.59 where that line measures 0.69 (three letters
 * each: a noisy median, hence a fifth of tolerance) and a regular sans 0.85
 * to 0.9.
 */
const widthIndex = new WeakMap<Atlas, Map<string, number | null>>()
function lineWidthRatio(atlas: Atlas, line: string): number | null {
  let m = widthIndex.get(atlas)
  if (!m) { m = new Map(); widthIndex.set(atlas, m) }
  if (m.has(line)) return m.get(line)!
  // Every copy on the line, doubted ones too: a doubt is about the shape a
  // label names, and a title in a face of its own has its letters doubted
  // for want of peers at its size — its width is still its width.
  const r: number[] = []
  for (const [ch, list] of atlas.byChar) {
    if (/[IlijJ1!|.,:;'tfr]/.test(ch)) continue
    for (const ex of list) if (ex.lineId === line) r.push((ex.inkR - ex.inkL) / ex.emPx / expectedAdvance(ch))
  }
  r.sort((a, b) => a - b)
  const v = r.length >= 3 ? r[r.length >> 1] : null
  m.set(line, v)
  return v
}

/**
 * A copy of the letter at ANOTHER size, from a line set in the request's own
 * face — for a letter the page holds only in a bigger or a smaller line of
 * that face. A book cover sets its title in three sizes of one condensed
 * display face ("PIENSE", "Y HÁGASE", "RICO"); none of the bundled faces is
 * anything like it, and an "A" made for "PIENSA" came out a wide regular sans
 * between condensed bold capitals — while the "Á" of "HÁGASE", a third
 * smaller, was the very letter. `pickGlyph` takes copies within 10% of the
 * size; this takes them from 0.6 to 1.7 times, but only from a line whose
 * letters agree with the requesting word's own (`SAME_STYLE`), in the same
 * weight class and kind of face, and only whole letters. The nearest size
 * wins, a copy scaled down before one scaled up (a resample softens what it
 * enlarges), the better style match breaking ties. Null without the style
 * evidence: two letters of the word at least.
 */
export function pickGlyphRescaled(atlas: Atlas, req: GlyphRequest): PickedGlyph | null {
  const list = atlas.byChar.get(req.char)
  const refs = req.style?.refs
  if (!list?.length || !refs || refs.length < 2) return null
  const face = req.style?.face
  const scores = new Map<string, number | null>()
  const lineScore = (line: string): number | null => {
    if (scores.has(line)) return scores.get(line)!
    let v: number | null = null
    if (line === req.style!.line) v = 1
    else {
      const own = copiesOnLine(atlas, line)
      let sum = 0, n = 0
      for (const r of refs) {
        const l = own.get(r.char)
        if (!l) continue
        let best = 0
        for (const ex of l) best = Math.max(best, shapeAgreement(ex.shape, r.shape))
        sum += best
        n++
      }
      v = n >= 2 ? sum / n : null
    }
    scores.set(line, v)
    return v
  }
  let best: Exemplar | null = null, bestCost = Infinity
  for (const ex of list) {
    if (ex.doubt && !ex.peerVouched && !(ex.faceVouched && ex.faceVouched === face)) continue
    if (!ex.isolated) continue
    const b = atlas.boldAt === null ? false : ex.weight === null ? null : ex.weight >= atlas.boldAt
    if (b === null || b !== req.bold) continue
    if (face) {
      const f = faceAt(atlas, ex.lineId, ex.x0 + (ex.inkL + ex.inkR) / 2, ex.emPx)
      if (f !== null && f !== face) continue
    }
    const r = sizeRatioOf(req, ex)
    if (!(r >= 0.6 && r <= 1.7)) continue
    let v = lineScore(ex.lineId)
    // Too few letters in common to compare shapes: the two lines must at
    // least be as condensed as each other — for DISPLAY lines only (an em of
    // 60 px and more): a title's few letters rarely share two with anything,
    // where body text has letters to compare, and its lines are too alike in
    // width for this to tell faces apart — a bold italic form label took
    // upright letters from three other lines this way, a checkbox for its R.
    if (v === null && req.emPx >= 60) {
      const a = lineWidthRatio(atlas, req.style!.line), b = lineWidthRatio(atlas, ex.lineId)
      if (a !== null && b !== null && Math.abs(Math.log(a / b)) <= Math.log(1.2)) v = SAME_STYLE
    }
    if (v === null || v < SAME_STYLE) continue
    const cost = Math.abs(Math.log(r)) + (r > 1 ? 0.1 : 0) - (v - SAME_STYLE) * 0.5
    if (cost < bestCost) { bestCost = cost; best = ex }
  }
  return best ? { ex: best, scale: sizeRatioOf(req, best), support: 0 } : null
}

/** Why each copy of a letter would or would not be picked — for the lab. */
export function explainPick(atlas: Atlas, req: GlyphRequest): string[] {
  const list = atlas.byChar.get(req.char) ?? []
  const sizeRatio = (ex: Exemplar) => sizeRatioOf(req, ex)
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
  const baseY = baselineAtOf(li.fit)((inkL + inkR) / 2) - y0
  return shapeOf(t, m, w, h, baseY, inkL - x0, li.fit.emPx)
}

/** A line cell's shape on the atlas's grid — to check it against its label's established shape. */
export function cellShapeOf(pi: PageInk, li: LineInk, k: number): Float32Array | null {
  const c = li.cells[k]
  if (!c || !c.pix.length || c.inkR <= c.inkL) return null
  const base = baselineAtOf(li.fit)
  const ex = cutExemplar(pi, li, c, k, base, null, null, null, -1)
  return ex?.shape ?? null
}
