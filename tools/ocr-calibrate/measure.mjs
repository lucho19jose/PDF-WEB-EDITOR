/**
 * Measure the pixel cues the font detector will use, on type we KNOW.
 *
 * Three cues, all read from the ink of a rendered line:
 *   strokeRatio  — median horizontal ink run over the em. Bold has thicker stems.
 *   contrast     — p85 run over p30 run. Serif faces are high-contrast, sans are
 *                  nearly monoline, so this separates Times from Helvetica.
 *   slant        — how far the ink leans, in em per em of height. Italic leans.
 */
import * as mupdf from 'mupdf'
import fs from 'fs'

const DPI = 220
const scale = DPI / 72
const doc = mupdf.Document.openDocument(fs.readFileSync('tools/ocr-calibrate/sample.pdf'), 'application/pdf')
const page = doc.loadPage(0)
const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false)
const W = pix.getWidth(), H = pix.getHeight()
const raw = pix.getPixels()
const stride = raw.length / (W * H)
const gray = new Uint8Array(W * H)
for (let i = 0; i < W * H; i++) gray[i] = raw[i * stride]

const rows = JSON.parse(fs.readFileSync('tools/ocr-calibrate/sample.json', 'utf8'))

function measure(x0, y0, x1, y1, emPx, baseY) {
  let lo = 255, hi = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const v = gray[y * W + x]; if (v < lo) lo = v; if (v > hi) hi = v
  }
  const thr = (lo + hi) / 2
  const runs = []
  const colAt = []   // per ink pixel: x, y
  for (let y = y0; y < y1; y++) {
    let run = 0
    for (let x = x0; x <= x1; x++) {
      const ink = x < x1 && gray[y * W + x] < thr
      if (ink) { run++; colAt.push([x, y]) }
      else { if (run > 0) runs.push(run); run = 0 }
    }
  }
  if (runs.length < 8) return null
  // Long runs are horizontal bars (the crossbar of an 'e', a serif foot), not
  // stems, and they swamp a mean. Cap and take order statistics.
  const kept = runs.filter(r => r <= emPx * 0.55).sort((a, b) => a - b)
  if (kept.length < 8) return null
  const q = p => kept[Math.min(kept.length - 1, Math.floor(kept.length * p))]
  const strokeRatio = q(0.5) / emPx
  const contrast = q(0.85) / Math.max(q(0.3), 0.5)

  // Slant by SHEAR SEARCH, not by centroids.
  //
  // Centroid-of-top minus centroid-of-bottom measures which letters happen to
  // have ink high and which have it low — "Hamburgefonstiv" reads as slanted at
  // 0.165 when it is perfectly upright. Shearing the ink and looking for the
  // angle that packs the column histogram tightest finds the angle the STEMS
  // stand at, which is what italic actually is.
  const ys2 = colAt.map(p => p[1])
  const yMid = (Math.min(...ys2) + Math.max(...ys2)) / 2
  let bestS = 0, bestE = -1
  for (let s = -0.6; s <= 0.6001; s += 0.02) {
    const hist = new Map()
    for (const [x, y] of colAt) {
      const xs = Math.round(x + s * (y - yMid))
      hist.set(xs, (hist.get(xs) || 0) + 1)
    }
    let e = 0
    for (const v of hist.values()) e += v * v
    if (e > bestE) { bestE = e; bestS = s }
  }
  const slant = bestS

  // Serifs FLARE the foot of a stem.
  //
  // Anchored on the BASELINE, not on the extent of the ink: the bottom of the
  // ink is where the descenders end, so a band measured from there samples the
  // tail of a 'g' and says nothing about serifs at all.
  //
  // What is compared is the median ink RUN in the band just above the baseline
  // against the one across the middle of the x-height. A sans stem is the same
  // width at both; a serif stem widens into its feet.
  const runsIn = (yA, yB) => {
    const rs = []
    for (let y = Math.round(yA); y < Math.round(yB); y++) {
      if (y < y0 || y >= y1) continue
      let run = 0
      for (let x = x0; x <= x1; x++) {
        const ink = x < x1 && gray[y * W + x] < thr
        if (ink) run++
        else { if (run > 0) rs.push(run); run = 0 }
      }
    }
    rs.sort((a, b) => a - b)
    return rs.length ? rs[Math.floor(rs.length / 2)] : 0
  }
  const footRun = runsIn(baseY - emPx * 0.09, baseY + emPx * 0.01)
  const midRun = runsIn(baseY - emPx * 0.42, baseY - emPx * 0.20)
  const footRatio = midRun > 0 ? footRun / midRun : 0

  // Every serif foot sits ON the baseline, so they all align into one dense
  // row band. A sans face has only its stems there, the same as anywhere else.
  const densIn = (yA, yB) => {
    let n = 0, rowsN = 0
    for (let y = Math.round(yA); y < Math.round(yB); y++) {
      if (y < y0 || y >= y1) continue
      rowsN++
      for (let x = x0; x < x1; x++) if (gray[y * W + x] < thr) n++
    }
    return rowsN ? n / rowsN : 0
  }
  const baseDens = densIn(baseY - emPx * 0.07, baseY + emPx * 0.01)
  const midDens = densIn(baseY - emPx * 0.42, baseY - emPx * 0.18)
  const baseSpike = midDens > 0 ? baseDens / midDens : 0

  return { strokeRatio, contrast, slant, footRatio, baseSpike, ink: colAt.length }
}

console.log('face'.padEnd(18), 'size', 'stroke', 'contr', 'slant', 'foot', 'spike')
const out = []
for (const r of rows) {
  const emPx = r.size * scale
  const yTop = Math.round((792 - r.baselineY - r.size * 0.82) * scale)
  const yBot = Math.round((792 - r.baselineY + r.size * 0.28) * scale)
  const m = measure(Math.round(50 * scale), yTop, Math.round(400 * scale), yBot, emPx, (792 - r.baselineY) * scale)
  if (!m) { console.log(r.face, r.size, 'no ink'); continue }
  out.push({ ...r, ...m })
  console.log(r.face.padEnd(18), String(r.size).padEnd(4),
    m.strokeRatio.toFixed(3).padEnd(6), m.contrast.toFixed(2).padEnd(6),
    m.slant.toFixed(2).padEnd(6), m.footRatio.toFixed(2).padEnd(6), m.baseSpike.toFixed(2))
}
fs.writeFileSync('tools/ocr-calibrate/measured.json', JSON.stringify(out, null, 2))
