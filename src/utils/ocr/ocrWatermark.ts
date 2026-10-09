import type { OcrLine } from './ocrEngine'

/**
 * A LIGHT GREY printed over the text — a registry certificate's diagonal
 * "verify at…" watermark, ten letters each a hand tall — hides whole lines
 * from the recogniser: on one such page four list items and two lines of
 * body text came back as nothing at all, though every one of them is black
 * and perfectly legible. Such a page shows the watermark as a plateau in its
 * luminance histogram: a bump between the text and the paper (a page of
 * black text on white has a smooth tail there instead). This finds it.
 *
 * Paper is the histogram's mode, and must be light (≥ 230). The plateau is
 * the tallest local maximum of the smoothed histogram from 170 to 20 below
 * the paper, holding 0.4% of the page at least and twice what the histogram
 * holds 25 levels darker (a tail falls away smoothly; a plateau stands up
 * from it). Darker plateaus are left alone: a band of colour behind reversed
 * white lettering lies there, and whitening it would erase the lettering.
 */
export function watermarkLevel(rgba: Uint8ClampedArray): number | null {
  const n = rgba.length / 4
  if (!n) return null
  const hist = new Float64Array(256)
  for (let i = 0; i < rgba.length; i += 4) hist[Math.round((rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000)]++
  let paper = 0
  for (let v = 1; v < 256; v++) if (hist[v] > hist[paper]) paper = v
  if (paper < 230) return null
  const sm = new Float64Array(256)
  for (let v = 0; v < 256; v++) {
    let s = 0, k = 0
    for (let u = v - 2; u <= v + 2; u++) if (u >= 0 && u < 256) { s += hist[u]; k++ }
    sm[v] = s / k
  }
  let best: number | null = null
  for (let v = 170; v <= paper - 20; v++) {
    if (sm[v] < sm[v - 1] || sm[v] < sm[v + 1]) continue
    if (sm[v] * 5 / n < 0.004 || sm[v] < 2 * sm[v - 25]) continue
    if (best === null || sm[v] > sm[best]) best = v
  }
  return best
}

/** Every pixel as light as the plateau or lighter, to white (in place). */
export function whitenFrom(rgba: Uint8ClampedArray, level: number): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const l = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000
    if (l >= level) rgba[i] = rgba[i + 1] = rgba[i + 2] = 255
  }
}

/**
 * The lines a reading of the page with its watermark whitened found that the
 * plain reading did not — and nothing else. Whitening is no cure in itself:
 * it also eats the soft edges of letters on an ordinary grey scan ("GERENTE"
 * read back "CERENTE", "Thumbnails" "Thurmbnails"), so the second reading
 * never REPLACES a line, it only adds those the first reading has no box for
 * (overlapping no first-reading box by a quarter of the smaller), read with
 * confidence (90 and over) and carrying three letters or figures at least —
 * a whitened page also yields the odd "2" or "一" out of a stamp.
 */
export function linesMissed(base: OcrLine[], extra: OcrLine[]): OcrLine[] {
  const area = (b: OcrLine['box']) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0)
  const overlaps = (a: OcrLine['box'], b: OcrLine['box']) => {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
    if (w <= 0 || h <= 0) return false
    return (w * h) / Math.max(1, Math.min(area(a), area(b))) >= 0.25
  }
  const kept: OcrLine[] = []
  for (const e of extra) {
    if (e.confidence < 90) continue
    if ((e.text.match(/[\p{L}\p{N}]/gu) ?? []).length < 3) continue
    if (base.some(b => overlaps(b.box, e.box)) || kept.some(k => overlaps(k.box, e.box))) continue
    kept.push(e)
  }
  return kept
}
