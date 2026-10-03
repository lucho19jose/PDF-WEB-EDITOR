import { binarise, expectedAdvance, type Bin } from './glyphCut'

/**
 * The WORDS of a scanned line, found in its ink.
 *
 * The glyph cut works on a whole recognised line, and on a long line of a
 * skewed scan it almost never succeeds: one letter the recogniser dropped
 * ("deinidos" for "definidos") or one space it lost ("Lostérminos queenel")
 * shifts every cell after it, the cut refuses, and the edit falls back to
 * redrawing the whole line in a base font — on the SEIDOR appendix every body
 * line over 80 characters refused (35 of 57 runs on page 1).
 *
 * Words are what a person edits, and the ink states them plainly: at 220 DPI
 * the gaps between this document's words are 8–12 px and between its letters
 * 2–5 px, whether or not the recogniser kept the space. So the line is split
 * into words on its own ink, the recogniser's characters are shared among
 * those words by width, and each word is cut ALONE on the line's letter band —
 * a misreading then costs the word it is in, not the line.
 *
 * Everything that does not touch pixels is DOM-free and unit-tested in
 * tools/ocr-calibrate/wordseg.test.mjs. Coordinates are canvas pixels.
 */

/** A connected piece of ink (8-connectivity). x1/y1 exclusive. */
export interface Blob { x0: number; x1: number; y0: number; y1: number; area: number; cx: number; cy: number; /** How much its vote counts in the baseline search (default 1). */ w?: number }

export interface InkBitmap { x: number; y: number; w: number; h: number; ink: Uint8Array }

export function blobsOf(bm: InkBitmap): Blob[] {
  const { w, h, ink } = bm
  const label = new Int32Array(w * h)
  const out: Blob[] = []
  const stack: number[] = []
  for (let s = 0; s < w * h; s++) {
    if (!ink[s] || label[s]) continue
    const id = out.length + 1
    let x0 = w, x1 = -1, y0 = h, y1 = -1, area = 0, sx = 0, sy = 0
    label[s] = id
    stack.push(s)
    while (stack.length) {
      const j = stack.pop()!
      const xx = j % w, yy = (j - xx) / w
      area++; sx += xx; sy += yy
      if (xx < x0) x0 = xx
      if (xx > x1) x1 = xx
      if (yy < y0) y0 = yy
      if (yy > y1) y1 = yy
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = xx + dx, ny = yy + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const n = ny * w + nx
        if (ink[n] && !label[n]) { label[n] = id; stack.push(n) }
      }
    }
    out.push({ x0: bm.x + x0, x1: bm.x + x1 + 1, y0: bm.y + y0, y1: bm.y + y1 + 1, area, cx: bm.x + sx / area + 0.5, cy: bm.y + sy / area + 0.5 })
  }
  return out
}

/** A line's fitted baseline and size: y(x) = y + slope * (x - centreX). */
export interface LineFit { y: number; slope: number; centreX: number; emPx: number }

export const baselineAtOf = (f: Pick<LineFit, 'y' | 'slope' | 'centreX'>) => (x: number) => f.y + f.slope * (x - f.centreX)

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

/**
 * The baseline through the bottoms of the line's letters, and the em.
 *
 * Theil–Sen first (the median of the pairwise slopes), because a least-squares
 * fit through every bottom is dragged down by the descenders — a sixth of a
 * Spanish line's letters — while the median slope is not; then least squares
 * over the letters that sit on that line, to settle it. The em comes from the
 * letter heights above the baseline: the x-height band (a lower share of them
 * in prose) is 0.52 em and a capital 0.72 — the ratios the glyph cut uses, so
 * the two measure the same em.
 */
export function fitLine(blobs: Blob[], emGuess: number, text: string): LineFit | null {
  const letters = blobs.filter(b => {
    const h = b.y1 - b.y0
    return h >= emGuess * 0.25 && h <= emGuess * 1.4 && b.area >= 4
  })
  if (letters.length < 2) return null
  const xs = letters.map(b => (b.x0 + b.x1) / 2), ys = letters.map(b => b.y1)
  const centreX = (Math.min(...letters.map(b => b.x0)) + Math.max(...letters.map(b => b.x1))) / 2
  // The baseline is the line MOST letters' bottoms sit on, searched over the
  // slopes a scan can have. The median of pairwise slopes it replaces was
  // pulled by the letters of the lines above and below that a tilted line's
  // tall box takes in: on a 3° line it went past its clamp, was reset to
  // level, and the "baseline" ran through the middle of the letters — every
  // capital measured half its height, no word could be cut, and a letter
  // synthesised for the line came out at half size.
  let slope = 0, y = median(ys)
  {
    // Narrow enough that a descender is not ON the line: at a 12px em an
    // old-style 9, 4 or 5 hangs only two pixels below it, and a band that took
    // them in tilted "Bo08-190845" towards its last three figures.
    const tol = Math.max(0.6, emGuess * 0.06)
    const wts = letters.map(b => b.w ?? 1)
    let bestW = -1
    const proj = new Float64Array(ys.length)
    const idx = letters.map((_, i) => i)
    for (let k = -45; k <= 45; k++) {
      const sl = k * 0.002
      for (let i = 0; i < ys.length; i++) proj[i] = ys[i] - sl * (xs[i] - centreX)
      idx.sort((a, b) => proj[a] - proj[b])
      let wsum = 0
      for (let i = 0, j = 0; i < idx.length; i++) {
        wsum += wts[idx[i]]
        while (proj[idx[i]] - proj[idx[j]] > 2 * tol) { wsum -= wts[idx[j]]; j++ }
        // Ties go to the level line: a short line's few letters agree on many slopes.
        if (wsum > bestW + 1e-9 || (Math.abs(wsum - bestW) <= 1e-9 && Math.abs(sl) < Math.abs(slope))) {
          bestW = wsum; slope = sl; y = (proj[idx[i]] + proj[idx[j]]) / 2
        }
      }
    }
  }
  // Settle on the letters within a tenth of an em of that line.
  for (let iter = 0; iter < 2; iter++) {
    const inl: number[] = []
    for (let i = 0; i < letters.length; i++) if (Math.abs(ys[i] - (y + slope * (xs[i] - centreX))) <= emGuess * 0.1) inl.push(i)
    if (inl.length < 3) break
    let sx = 0, sy = 0, sxx = 0, sxy = 0
    for (const i of inl) { const dx = xs[i] - centreX; sx += dx; sy += ys[i]; sxx += dx * dx; sxy += dx * ys[i] }
    const n = inl.length, den = n * sxx - sx * sx
    if (Math.abs(den) < 1e-6) break
    const s = (n * sxy - sx * sy) / den
    if (Math.abs(s) > 0.095) break
    slope = s
    y = (sy - s * sx) / n
  }
  // Heights above the baseline of the letters sitting on it.
  const heights: number[] = []
  for (let i = 0; i < letters.length; i++) {
    const base = y + slope * (xs[i] - centreX)
    if (Math.abs(ys[i] - base) <= emGuess * 0.12) heights.push(base - letters[i].y0)
  }
  if (heights.length < 2) return { y, slope, centreX, emPx: emGuess }
  heights.sort((a, b) => a - b)
  const chars = [...text].filter(c => c.trim())
  const xShare = chars.filter(c => /[acemnorsuvwxz]/.test(c)).length / Math.max(1, chars.length)
  // Prose: the x-height band is the lower part of the heights; capitals only:
  // every letter is a capital.
  let em = xShare >= 0.25
    ? heights[Math.floor(heights.length * Math.min(0.45, xShare * 0.6))] / 0.52
    : median(heights) / 0.72
  // OLD-STYLE figures stand at the x-height and hang below the baseline (3,
  // 4, 5, 7, 9), so a line that is mostly figures measures its x-height where
  // it takes it for capitals: a receipt's "Fecha: 28/08/2025" came out at
  // 9.6 px of em where its letters and its box say 14, every figure was then
  // too wide to cut, and an edit redrew the date from glyphs of the wrong
  // size. Said by the ink, not assumed: more pieces hang below the line than
  // the reading has descending letters, and the box's width disagrees.
  {
    const visible = chars.length
    const digits = chars.filter(c => /[0-9]/.test(c)).length
    if (visible && digits >= 2 && digits >= visible * 0.3 && em < emGuess * 0.85) {
      const descending = chars.filter(c => /[gjpqyQJ(),;]/.test(c)).length
      const hanging = letters.filter(b => b.y1 - (y + slope * ((b.x0 + b.x1) / 2 - centreX)) > emGuess * 0.12).length
      const alt = median(heights) / 0.52
      if (hanging > descending && Math.abs(alt - emGuess) < Math.abs(em - emGuess) && alt <= emGuess * 1.25) em = alt
    }
  }
  return { y, slope, centreX, emPx: em > 4 ? em : emGuess }
}

/** Whether a blob belongs to the line: its centre inside the line's letter band. */
export function ownedBy(b: Blob, fit: LineFit): boolean {
  const base = fit.y + fit.slope * (b.cx - fit.centreX)
  return b.cy >= base - fit.emPx * 1.0 && b.cy <= base + fit.emPx * 0.22
}

export interface InkWord {
  x0: number; x1: number; top: number; bottom: number
  /** A list bullet the reading does not name (`markBullets`): it may be left out at an end wherever it stands. */
  bullet?: boolean
}

export interface WordSplit { words: InkWord[]; threshold: number; letterGapPx: number; wordGapPx: number }

/**
 * The line's words: its own blobs merged into column runs, and the runs joined
 * across every gap narrower than the word-gap threshold — Otsu's split of the
 * line's own gaps, held between an eighth and two fifths of an em. A justified
 * line stretches its word gaps and a tracked heading its letter gaps, so the
 * split is the line's, not a constant.
 */
export function splitWords(blobs: Blob[], fit: LineFit): WordSplit {
  const own = blobs.filter(b => ownedBy(b, fit)).sort((a, b) => a.x0 - b.x0)
  const runs: { x0: number; x1: number; top: number; bottom: number }[] = []
  for (const b of own) {
    const last = runs[runs.length - 1]
    if (last && b.x0 <= last.x1 + 1) {
      last.x1 = Math.max(last.x1, b.x1); last.top = Math.min(last.top, b.y0); last.bottom = Math.max(last.bottom, b.y1)
    } else runs.push({ x0: b.x0, x1: b.x1, top: b.y0, bottom: b.y1 })
  }
  if (!runs.length) return { words: [], threshold: 0, letterGapPx: 0, wordGapPx: 0 }
  const gaps: number[] = []
  for (let i = 1; i < runs.length; i++) gaps.push(runs[i].x0 - runs[i - 1].x1)
  const lo = fit.emPx * 0.12, hi = fit.emPx * 0.4
  let threshold = fit.emPx * 0.22
  if (gaps.length >= 3) {
    // Gaps wider than any word space count as no wider than that. A form's
    // line runs on into its blank — a 58px stretch before the handwriting in
    // it — and that one gap outvoted the line's spacing: the threshold went
    // over every word gap (9 to 11 px), clamped to 0.4 em, and "el mismo que
    // acredita con copia de mi recibo" came out as one word.
    const t = otsu(gaps.map(g => Math.min(g, fit.emPx * 0.6)))
    if (t !== null) threshold = Math.min(hi, Math.max(lo, t))
  }
  const words: InkWord[] = []
  let cur: InkWord = { x0: runs[0].x0, x1: runs[0].x1, top: runs[0].top, bottom: runs[0].bottom }
  for (let i = 1; i < runs.length; i++) {
    if (gaps[i - 1] >= threshold) { words.push(cur); cur = { x0: runs[i].x0, x1: runs[i].x1, top: runs[i].top, bottom: runs[i].bottom } }
    else { cur.x1 = runs[i].x1; cur.top = Math.min(cur.top, runs[i].top); cur.bottom = Math.max(cur.bottom, runs[i].bottom) }
  }
  words.push(cur)
  const letterGaps = gaps.filter(g => g < threshold), wordGaps = gaps.filter(g => g >= threshold)
  return {
    words, threshold,
    letterGapPx: letterGaps.length ? median(letterGaps) : fit.emPx * 0.08,
    wordGapPx: wordGaps.length ? median(wordGaps) : fit.emPx * 0.3
  }
}

/** Otsu's threshold over a list of gaps: the split that maximises the between-class variance. */
export function otsu(values: number[]): number | null {
  const v = [...values].sort((a, b) => a - b)
  const n = v.length
  if (n < 2 || v[0] === v[n - 1]) return null
  const prefix = [0]
  for (const x of v) prefix.push(prefix[prefix.length - 1] + x)
  let best = -1, at: number | null = null
  for (let k = 1; k < n; k++) {
    if (v[k] === v[k - 1]) continue
    const m1 = prefix[k] / k, m2 = (prefix[n] - prefix[k]) / (n - k)
    const between = k * (n - k) * (m2 - m1) * (m2 - m1)
    if (between > best) { best = between; at = (v[k] + v[k - 1]) / 2 }
  }
  return at
}

/** One ink word and the characters (indices into the text's non-space characters, [from, to)) it holds. */
export interface WordMatch { word: number; from: number; to: number; /** |ink − expected| / expected */ err: number }

/**
 * Share the recogniser's characters among the ink words by WIDTH.
 *
 * Every ink word takes a contiguous, non-empty run of the characters, so the
 * order is the reading's; the cost is the squared relative miss between a
 * word's ink width and the expected advances of what it holds (scaled so the
 * totals agree), plus a little for a cut where the reading had no space (a
 * space the recogniser lost — "Lostérminos") and more for a reading's space
 * inside one ink word. An ink word may also be left with NO characters at a
 * price — a stray mark the recogniser rightly ignored. Null when even the best
 * sharing leaves the widths far from the letters.
 */
export function alignCharsToWords(words: { x0: number; x1: number; bullet?: boolean }[], chars: string[], spaceAfter: Set<number>): WordMatch[] | null {
  // Ink at either END of the line that the reading never named — the
  // handwriting in a form's blank the recogniser boxed with the printed line
  // and did not read — takes part in the width scale the fit is judged by,
  // and then fitting the reading over it costs less than skipping it: the
  // last printed words were spread over the handwriting, every label shifted
  // by one, and an edit typeset 58px word spaces. Up to two ink words at each
  // end may be left out, the scale taken from the rest, for a little each —
  // but only ink set apart from the line by a clear blank, an em or more (the
  // handwriting sat two ems past "de:"). Behind an ordinary word space it is
  // the line's own last word: trimmed freely, a table row's short final cells
  // were dropped whenever the scale was a little off.
  const totalAdv = chars.reduce((t, c) => t + expectedAdvance(c), 0)
  const emEst = totalAdv > 0 ? words.reduce((t, w) => t + (w.x1 - w.x0), 0) / totalAdv : 0
  const apart = (i: number) => i > 0 && i < words.length && words[i].x0 - words[i - 1].x1 >= emEst
  // A bullet the recogniser did not read sits an ordinary word space from the
  // text, and given the first label it shifted every label after it by one:
  // "● 49.7% good" read "49.7% good" put the "4" on the disc, and an "X"
  // appended to it was toned green. It may be left out however close it is.
  // And it MUST be: its width is a letter's, so it fits a label about as well
  // as the trim costs, and the "4" went on it anyway.
  const startOk = (a: number) => apart(a) || words.slice(0, a).every(w => w.bullet)
  const endOk = (b: number) => apart(words.length - b) || words.slice(words.length - b).every(w => w.bullet)
  const search = (minA: number, minB: number) => {
    let best: { cost: number; out: WordMatch[] } | null = null
    for (let a = minA; a <= 2; a++) for (let b = minB; b <= 2; b++) {
      if (a + b >= words.length) continue
      if ((a > 0 && !startOk(a)) || (b > 0 && !endOk(b))) continue
      const res = alignOn(words.slice(a, words.length - b), chars, spaceAfter)
      if (!res) continue
      const cost = res.cost + (a + b) * TRIM_COST
      if (!best || cost < best.cost - 1e-9) best = { cost, out: res.out.map(m => ({ ...m, word: m.word + a })) }
    }
    return best
  }
  const minA = words[0]?.bullet ? 1 : 0, minB = words.length > 1 && words[words.length - 1]?.bullet ? 1 : 0
  const best = ((minA || minB) && search(minA, minB)) || search(0, 0)
  return best ? best.out : null
}

/** An ink word left out at an end of the line. */
const TRIM_COST = 0.3

function alignOn(words: { x0: number; x1: number }[], chars: string[], spaceAfter: Set<number>): { cost: number; out: WordMatch[] } | null {
  const M = words.length, N = chars.length
  if (!M || !N) return null
  const MISSING_SPACE = 0.12, EXTRA_SPACE = 0.5, SKIP = 0.8, MAX = 40
  const widths = words.map(w => w.x1 - w.x0)
  const adv = chars.map(expectedAdvance)
  const pre = [0]
  for (const a of adv) pre.push(pre[pre.length - 1] + a)
  // Ink is the advance less the outer side bearings; the scale makes the two
  // totals agree, so the fit is about how the width is SHARED.
  const scale = widths.reduce((s, w) => s + w, 0) / Math.max(1e-6, pre[N])
  // spacesUpTo[k]: how many of the boundaries 1..k carry a reading space
  // (boundary j sits between chars[j-1] and chars[j]). A slice [p, n) holds
  // the boundaries p+1 .. n-1.
  const spacesUpTo = [0]
  for (let j = 1; j <= N; j++) spacesUpTo.push(spacesUpTo[j - 1] + (j < N && spaceAfter.has(j) ? 1 : 0))
  const INF = Number.POSITIVE_INFINITY
  const dp: Float64Array[] = Array.from({ length: M + 1 }, () => new Float64Array(N + 1).fill(INF))
  const back: Int32Array[] = Array.from({ length: M + 1 }, () => new Int32Array(N + 1).fill(-2))
  dp[0][0] = 0
  for (let m = 1; m <= M; m++) {
    const wpx = widths[m - 1]
    for (let n = 0; n <= N; n++) {
      // Skip the ink word.
      if (dp[m - 1][n] < INF) {
        const c = dp[m - 1][n] + SKIP
        if (c < dp[m][n]) { dp[m][n] = c; back[m][n] = -1 }
      }
      for (let p = Math.max(0, n - MAX); p < n; p++) {
        const prev = dp[m - 1][p]
        if (prev === INF) continue
        const exp = (pre[n] - pre[p]) * scale
        const rel = (wpx - exp) / Math.max(exp, 1)
        let c = prev + rel * rel
        if (n < N && !spaceAfter.has(n)) c += MISSING_SPACE
        c += (spacesUpTo[n - 1] - spacesUpTo[p]) * EXTRA_SPACE
        if (c < dp[m][n]) { dp[m][n] = c; back[m][n] = p }
      }
    }
  }
  if (dp[M][N] === INF) return null
  const out: WordMatch[] = []
  let n = N
  for (let m = M; m >= 1; m--) {
    const p = back[m][n]
    if (p === -1) continue
    const exp = (pre[n] - pre[p]) * scale
    out.unshift({ word: m - 1, from: p, to: n, err: Math.abs(widths[m - 1] - exp) / Math.max(exp, 1) })
    n = p
  }
  if (n !== 0) return null
  return { cost: dp[M][N], out }
}

/** The non-space indices after which the reading has a space (a word boundary). */
export function spaceBoundaries(text: string): Set<number> {
  const out = new Set<number>()
  let k = 0
  let pending = false
  for (const ch of text) {
    if (ch === ' ') { pending = true; continue }
    if (pending && k > 0) out.add(k)
    pending = false
    k++
  }
  return out
}

export interface LineWords {
  fit: LineFit
  split: WordSplit
  /** One per ink word that holds characters, in reading order. */
  matches: (WordMatch & { ink: InkWord })[]
  /** Characters of the reading, spaces removed. */
  chars: string[]
}

/**
 * Segment a recognised line's ink into words and share its reading among them.
 * `rect` is the line's ink box in canvas pixels.
 */
export function segmentLine(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, text: string): LineWords | null {
  const chars = [...text].filter(c => c !== ' ')
  if (chars.length < 2) return null
  const emGuess = rect.width / Math.max(1, chars.reduce((s, c) => s + expectedAdvance(c), 0))
  // The same binarisation the glyph cut makes, rules cleared: an underline
  // joins every word of a heading into one run otherwise.
  const bin: Bin | null = binarise(ctx, rect, emGuess * 2.5, Math.max(4, Math.round(emGuess * 0.25)))
  if (!bin) return null
  return segmentBitmap(bin, text, emGuess)
}

/** `segmentLine` on an already-binarised box — what the unit tests drive. */
export function segmentBitmap(bin: InkBitmap, text: string, emGuess: number): LineWords | null {
  const chars = [...text].filter(c => c !== ' ')
  const blobs = blobsOf(bin)
  const fit = fitLine(blobs, emGuess, text)
  if (!fit) return null
  const split = splitWords(blobs, fit)
  if (!split.words.length) return null
  const matches = alignCharsToWords(split.words, chars, spaceBoundaries(text))
  if (!matches) return null
  return { fit, split, chars, matches: matches.map(m => ({ ...m, ink: split.words[m.word] })) }
}
