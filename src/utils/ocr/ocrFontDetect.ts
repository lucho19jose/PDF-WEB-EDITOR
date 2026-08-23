/**
 * Reading a typeface off the pixels of a scan.
 *
 * OCR reports words and where they are. It does not report what they are SET
 * IN — with the LSTM engine there are no font attributes at all, and the
 * `font_name` that occasionally appears names a face that is not in this
 * document and cannot be embedded. So the face is measured from the ink, which
 * is the only place the information exists.
 *
 * Every threshold here was measured, not chosen. `tools/ocr-calibrate` renders
 * the base-14 faces at 12pt and 24pt at OCR resolution and reports the three
 * cues below; the numbers in each comment are that page's output.
 */

export interface FaceCues {
  bold: boolean
  italic: boolean
  monospace: boolean
  /** Median ink run over the em — how thick the stems are. */
  strokeRatio: number
  /** Shear, in x per y, that stands the stems upright. */
  slant: number
  /** Thick-to-thin run ratio. High on monospace faces. */
  contrast: number
  /** False when there was too little ink to measure and defaults were used. */
  measured: boolean
}

const NEUTRAL: FaceCues = {
  bold: false, italic: false, monospace: false,
  strokeRatio: 0, slant: 0, contrast: 0, measured: false
}

/**
 * Regular runs 0.055–0.095 of the em, bold 0.136–0.150 — measured across
 * Helvetica, Times and Courier at both sizes. The gap is wide and the midpoint
 * is nowhere near either cluster.
 */
const BOLD_STROKE = 0.115

/** Upright measures -0.02..0.00, oblique and italic 0.22..0.26. */
const ITALIC_SLANT = 0.10

/** Courier 2.50–3.25, the proportional faces 1.30–1.70. */
const MONO_CONTRAST = 2.05

/**
 * Measure the face of one run of text.
 *
 * @param rect     the run's box in CANVAS pixels
 * @param emPx     the run's font size in canvas pixels
 * @param baselineY the run's baseline in canvas pixels, absolute
 */
export function detectFace(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  emPx: number,
  baselineY: number
): FaceCues {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const w = Math.min(Math.ceil(rect.width), ctx.canvas.width - x0)
  const h = Math.min(Math.ceil(rect.height), ctx.canvas.height - y0)
  if (w < 4 || h < 4 || emPx < 3) return NEUTRAL

  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(x0, y0, w, h).data
  } catch (_) {
    // A tainted canvas cannot be read; a neutral face beats a crash.
    return NEUTRAL
  }

  // Ink is split from paper at the midpoint of the range actually present, not
  // at a fixed level: a faint grey scan and a crisp black one both have ink.
  const gray = new Uint8Array(w * h)
  let lo = 255, hi = 0
  for (let i = 0; i < w * h; i++) {
    const v = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000
    gray[i] = v
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (hi - lo < 24) return NEUTRAL
  const threshold = (lo + hi) / 2

  const runs: number[] = []
  const inkX: number[] = []
  const inkY: number[] = []
  for (let row = 0; row < h; row++) {
    let run = 0
    for (let col = 0; col <= w; col++) {
      const ink = col < w && gray[row * w + col] < threshold
      if (ink) {
        run++
        inkX.push(col)
        inkY.push(row)
      } else if (run > 0) {
        runs.push(run)
        run = 0
      }
    }
  }
  if (runs.length < 8 || inkX.length < 20) return NEUTRAL

  // A run longer than about half the em is a crossbar or an underline, not a
  // stem, and a handful of them drags any average right off the stems.
  const stems = runs.filter(r => r <= emPx * 0.55).sort((a, b) => a - b)
  if (stems.length < 8) return NEUTRAL
  const pick = (p: number) => stems[Math.min(stems.length - 1, Math.floor(stems.length * p))]
  const strokeRatio = pick(0.5) / emPx
  const contrast = pick(0.85) / Math.max(pick(0.3), 0.5)

  // Slant by SHEAR SEARCH.
  //
  // The obvious measure — where the ink sits high against where it sits low —
  // reads which LETTERS are in the run, not how they lean: upright
  // "Hamburgefonstiv" scored 0.165 that way, well into italic territory.
  // Shearing the ink and taking the angle that packs the column histogram
  // tightest finds the angle the stems actually stand at.
  let yMid = 0
  for (const y of inkY) yMid += y
  yMid /= inkY.length
  let bestShear = 0
  let bestEnergy = -1
  for (let s = -0.6; s <= 0.6001; s += 0.02) {
    const hist = new Map<number, number>()
    for (let i = 0; i < inkX.length; i++) {
      const xs = Math.round(inkX[i] + s * (inkY[i] - yMid))
      hist.set(xs, (hist.get(xs) ?? 0) + 1)
    }
    let energy = 0
    for (const v of hist.values()) energy += v * v
    if (energy > bestEnergy) {
      bestEnergy = energy
      bestShear = s
    }
  }

  return {
    bold: strokeRatio > BOLD_STROKE,
    italic: bestShear > ITALIC_SLANT,
    monospace: contrast > MONO_CONTRAST,
    strokeRatio,
    slant: bestShear,
    contrast,
    measured: true
  }
}

/**
 * Are these glyphs all the same width?
 *
 * A far better monospace test than any pixel cue when the boxes are there:
 * a monospaced face advances by exactly one width per glyph whatever the glyph
 * is. Reported alongside the pixel cue rather than instead of it, because a run
 * of four characters has too few advances to judge.
 *
 * Measured between glyph CENTRES, not between left edges. A recognition box
 * hugs the ink, and in a monospaced face a narrow glyph sits centred in a wide
 * cell — so the left edges of "1" and "M" are indented by different amounts and
 * the advances between them look irregular even though the cells are identical.
 * A centre sits in the middle of its cell whatever the glyph is.
 *
 * The test is only DECIDABLE when the run contains glyphs a proportional face
 * would set at different widths. All-caps text is nearly monospaced in every
 * face — P, R, O, C, E and S are all much the same width — so "PROCESS" came
 * back as uniform and was set in Courier. Undecidable is reported as `null`,
 * which leaves the decision to the pixel cue, rather than as `false`, which
 * would be a claim the evidence does not support.
 */
const NARROW = /[iljtfr1.,;:'!|()[\]]/
const WIDE = /[mwMW@%]/

export function advancesAreUniform(
  boxes: { x0: number; x1: number }[],
  text: string
): boolean | null {
  if (boxes.length < 6) return null
  if (!NARROW.test(text) || !WIDE.test(text)) return null
  const centres = boxes.map(b => (b.x0 + b.x1) / 2).sort((a, b) => a - b)
  const advances: number[] = []
  for (let i = 1; i < centres.length; i++) {
    const d = centres[i] - centres[i - 1]
    // A jump across a word gap is not an advance.
    if (d > 0) advances.push(d)
  }
  if (advances.length < 5) return null
  advances.sort((a, b) => a - b)
  const median = advances[Math.floor(advances.length / 2)]
  if (median <= 0) return null
  const inner = advances.filter(a => a < median * 2.2)
  if (inner.length < 5) return null
  const mean = inner.reduce((s, a) => s + a, 0) / inner.length
  const variance = inner.reduce((s, a) => s + (a - mean) ** 2, 0) / inner.length
  return Math.sqrt(variance) / mean < 0.14
}
