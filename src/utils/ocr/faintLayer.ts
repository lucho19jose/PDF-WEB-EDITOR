/**
 * A faint layer printed across the page: a watermark.
 *
 * A consultation printout stamps the requester's name and ID across the whole
 * sheet in pale lavender, "QUINTEROS PERALTA … (DNI) 70775173" thirty times
 * over the form. A person reads straight through it; the recogniser does not.
 * PaddleOCR read the watermark as text, boxed it together with the cells it
 * crosses, and a two-line label, the date beside it and a stretch of
 * watermark came back as ONE run reading "omento ivacional ge igenua Fechay
 * hora deacion1 consulta: …". Editing the date redrew all of that, in one
 * small face, over the label and the date alike.
 *
 * The layer is told apart by being FAINT and TEXT-SHAPED at once:
 *  - faint: its pixels sit just under the paper (here 225-245 against 255),
 *    far lighter than any ink a reader is meant to read;
 *  - away from ink: the anti-aliased fringe of real text is just as faint,
 *    but it always touches the dark core of its glyph, so pixels within two
 *    of dark ink are not counted;
 *  - text-shaped: a tinted paper or a grey cell fill is faint too, but it is
 *    an area — only its rim touches the paper. A watermark's strokes are a few
 *    pixels wide and most of them touch white.
 *
 * When the page carries one, everything lighter than the layer's darkest
 * strokes is painted paper-white on the raster the recogniser and the ink
 * measurers read. Nothing on the page changes: this is the raster OCR works
 * on, and the patch and the replacement are still measured on real ink.
 */

/** What was found; null when the page has no faint layer. */
export interface FaintLayer {
  /** Paper luminance, 0-255. */
  paper: number
  /** Pixels lighter than this luminance belong to the layer (or the paper). */
  cutoff: number
  /** Share of the page the layer's pixels cover. */
  share: number
  /** Share of those pixels that touch the paper: a stroke, not an area. */
  edge: number
  /** Darkness three quarters of the layer's pixels stay under. */
  p75: number
  /** Share of the page's tiles (a 12×12 grid) the layer reaches. */
  spread: number
}

/** Darkness (0 paper .. 1 black) below which a pixel can be part of the layer. */
const FAINT_MAX = 0.3
/**
 * The layer is never taken to be darker than this: past it a pale stroke is
 * grey text somebody may want to read (a footer, a caption), and a watermark
 * that dark is visible type in its own right.
 */
const CUTOFF_MAX = 0.2
/** Darkness at and above which a pixel is ink a reader reads. */
const INK_MIN = 0.4
/** Darkness under which a pixel IS the paper. */
const PAPER_MAX = 0.03
/**
 * Darkness from which a pixel can be the layer. Between the paper and this
 * lies a scan's grain and its JPEG ringing: on a dense contract page five
 * percent of the paper sits at 0.03-0.05, decaying from the paper's level,
 * where the watermark's pixels PEAK at 0.07-0.09.
 */
const FAINT_MIN = 0.06
/** The layer has to cover this much of the page to be a layer at all. */
const MIN_SHARE = 0.03
/** …and this share of its pixels must touch the paper. */
const MIN_EDGE = 0.4
/**
 * …and three quarters of it must be this faint. A watermark is printed at one
 * tint, so its pixels bunch (0.07-0.10 on the consultation printout); a
 * faded photocopy's grey text and a form's tinted cell fills spread right up
 * to the ink (a gastos table's p75 was 0.21), and painting THAT out would take
 * readable text with it.
 */
const MAX_P75 = 0.13
/**
 * …and it must reach across the sheet. A watermark is repeated over the whole
 * page; a chart's grey grid or a table's tinted header is faint, thin and
 * bunched just the same, but it occupies its own corner of the page.
 */
const MIN_SPREAD = 0.5
const GRID = 12

const lum = (px: Uint8ClampedArray, j: number) => 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2]

export function analyseFaintLayer(px: Uint8ClampedArray, w: number, h: number): FaintLayer | null {
  const m = measureFaintLayer(px, w, h)
  return m && m.share >= MIN_SHARE && m.edge >= MIN_EDGE && m.p75 <= MAX_P75 && m.spread >= MIN_SPREAD ? m : null
}

/** The layer's measurements whether or not they pass — for calibration. */
export function measureFaintLayer(px: Uint8ClampedArray, w: number, h: number): FaintLayer | null {
  const n = w * h
  if (n < 16) return null
  const L = new Uint8Array(n)
  const hist = new Float64Array(256)
  for (let i = 0; i < n; i++) { const v = Math.round(lum(px, i * 4)); L[i] = v; hist[v]++ }
  // The paper is the commonest LIGHT level. A page that is mostly dark (a
  // cover, a photograph) has no paper for a faint layer to sit on.
  let paper = 255, best = -1
  for (let v = 128; v < 256; v++) {
    const s = hist[v] + (v > 0 ? hist[v - 1] : 0) + (v < 255 ? hist[v + 1] : 0)
    if (s > best) { best = s; paper = v }
  }
  if (paper < 160 || best < n * 0.3) return null
  const dOf = (v: number) => Math.max(0, paper - v) / paper

  // Ink, dilated by two pixels: the fringe of a real glyph lives inside that.
  const inkLevel = paper * (1 - INK_MIN)
  const nearInk = new Uint8Array(n)
  const rowPass = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    const o = y * w
    for (let x = 0; x < w; x++) {
      if (L[o + x] > inkLevel) continue
      for (let k = Math.max(0, x - 2); k <= Math.min(w - 1, x + 2); k++) rowPass[o + k] = 1
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (!rowPass[y * w + x]) continue
      for (let k = Math.max(0, y - 2); k <= Math.min(h - 1, y + 2); k++) nearInk[k * w + x] = 1
    }
  }

  const paperLevel = paper * (1 - PAPER_MAX)
  // Lighter than the layer can be: the paper, or its grain.
  const clearLevel = paper * (1 - FAINT_MIN)
  const faintHist = new Float64Array(101)
  const tile = new Float64Array(GRID * GRID)
  let faint = 0, edge = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v = L[i]
      if (v >= paperLevel || nearInk[i]) continue
      const d = dOf(v)
      if (d < FAINT_MIN || d >= FAINT_MAX) continue
      faint++
      faintHist[Math.round(d * 100)]++
      tile[Math.min(GRID - 1, Math.floor(y * GRID / h)) * GRID + Math.min(GRID - 1, Math.floor(x * GRID / w))]++
      if (L[i - 1] > clearLevel || L[i + 1] > clearLevel || L[i - w] > clearLevel || L[i + w] > clearLevel) edge++
    }
  }
  const share = faint / n
  const edgeShare = faint ? edge / faint : 0
  const perTile = n / (GRID * GRID)
  let spread = 0
  for (const t of tile) if (t >= perTile * 0.03) spread++
  const pct = (q: number) => {
    let acc = 0
    for (let k = 0; k <= 100; k++) { acc += faintHist[k]; if (acc >= faint * q) return k / 100 }
    return FAINT_MAX
  }
  // The layer's darkest strokes: its 90th percentile, with room for where two
  // of its strokes cross. Not the 98th — on the printout that reaches the
  // table's pale blue rules, which the recogniser wants for telling cells apart.
  const cutoffD = Math.min(CUTOFF_MAX, pct(0.9) + 0.04)
  return { paper, cutoff: Math.round(paper * (1 - cutoffD)), share, edge: edgeShare, p75: pct(0.75), spread: spread / (GRID * GRID) }
}

/** Paint everything at or above `cutoff` luminance white, in place. */
export function whitenAbove(ctx: CanvasRenderingContext2D, cutoff: number): void {
  const { width: w, height: h } = ctx.canvas
  if (!w || !h) return
  const img = ctx.getImageData(0, 0, w, h)
  const px = img.data
  for (let j = 0; j < px.length; j += 4) {
    if (lum(px, j) >= cutoff) { px[j] = 255; px[j + 1] = 255; px[j + 2] = 255 }
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * A COPY of the raster with its faint layer painted out, for the recogniser
 * and the ink measurers — or the raster itself when the page has none. The
 * original stays as it is: the colours a patch is painted in are the page's
 * real ones, watermark and tinted fills included.
 */
export function withoutFaintLayer(canvas: HTMLCanvasElement): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; layer: FaintLayer | null } {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const { width: w, height: h } = canvas
  const layer = w && h ? analyseFaintLayer(ctx.getImageData(0, 0, w, h).data, w, h) : null
  if (!layer) return { canvas, ctx, layer: null }
  const copy = document.createElement('canvas')
  copy.width = w
  copy.height = h
  const cctx = copy.getContext('2d', { willReadFrequently: true })!
  cctx.drawImage(canvas, 0, 0)
  whitenAbove(cctx, layer.cutoff)
  return { canvas: copy, ctx: cctx, layer }
}
