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
 *
 * Fitted as ONE GRID over the whole run, not as a string of pairwise advances.
 * Pair by pair, every box's own error lands in two advances and nothing cancels:
 * measured on a 220 DPI scan, real Courier scored 0.244 and Helvetica prose
 * 0.284 — one threshold could not separate them, so monospaced text was never
 * recognised and came back a third short of its true size. Against a
 * least-squares grid the same two runs score **0.019 and 0.333**, because a
 * constant pitch is exactly what the fit is looking for and box noise averages
 * out instead of accumulating. Italic prose scores 0.445 and a page of OCR
 * rubbish 0.4–0.8, so 0.08 sits a factor of four clear on both sides.
 *
 * Spaces take a cell of their own. A monospaced face sets the blank to the same
 * width as a letter, so the grid only lines up when the gaps are counted — and
 * counting them is what lets one fit span a whole line instead of restarting at
 * every word.
 */
const NARROW = /[iljtfr1.,;:'!|()[\]]/
const WIDE = /[mwMW@%]/
/** Residual of the grid fit, as a fraction of the pitch, that still reads as monospaced. */
const MONO_GRID_RESIDUAL = 0.08

export function advancesAreUniform(
  boxes: { x0: number; x1: number }[],
  text: string
): boolean | null {
  if (boxes.length < 8) return null
  if (!NARROW.test(text) || !WIDE.test(text)) return null

  // One cell per character of the run, blanks included. The boxes arrive in
  // reading order and hold no blanks, so they pair off with the non-space
  // cells; if they do not pair off — a ligature read as one symbol, a dropped
  // glyph — the run cannot be laid on a grid and says nothing either way.
  const cells: number[] = []
  let cell = 0
  for (const ch of text) {
    if (ch !== ' ') cells.push(cell)
    cell++
  }
  if (cells.length !== boxes.length) return null

  // Sorted, so the pairing with the cells holds however the boxes were handed
  // over: both run left to right and the nth box is the nth cell.
  const centres = boxes.map(b => (b.x0 + b.x1) / 2).sort((a, b) => a - b)
  const n = centres.length
  const meanCell = cells.reduce((s, v) => s + v, 0) / n
  const meanCentre = centres.reduce((s, v) => s + v, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (cells[i] - meanCell) * (centres[i] - meanCentre)
    den += (cells[i] - meanCell) ** 2
  }
  if (den <= 0) return null
  const pitch = num / den
  if (!(pitch > 0.5)) return null

  const intercept = meanCentre - pitch * meanCell
  let ss = 0
  for (let i = 0; i < n; i++) ss += (centres[i] - (intercept + pitch * cells[i])) ** 2
  return Math.sqrt(ss / n) / pitch < MONO_GRID_RESIDUAL
}
