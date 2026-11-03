/**
 * What a page holds for a SPREADSHEET export: its words with their exact
 * positions, and the drawing that makes its tables — the rules (borders,
 * underlines), the coloured fills behind cells, and the small marks that tick
 * a checkbox. `src/utils/acro/sheetLayout.ts` turns this into rows, columns
 * and merged cells; this side only reads, so it never touches the document.
 *
 * Coordinates are MuPDF's page space: top-left origin, y down, /Rotate
 * already applied — the same space the structured text reports, so a word and
 * the rule under it can be compared directly.
 *
 * A table border is drawn in at least four ways, and every one of them is
 * met in ordinary office files:
 *  - a stroked line or rectangle (`re S`, `m l S`);
 *  - a thin FILLED rectangle — Excel and Word export every cell border this
 *    way, often dozens per path;
 *  - a filled FRAME: an outer and an inner rectangle in one path, which an
 *    even-odd fill paints as a border and must not read as a black cell;
 *  - a one-pixel-thick IMAGE stretched along the edge (some Word exports).
 */

export interface SheetWord {
  x0: number; y0: number; x1: number; y1: number
  /** Baseline (y of the glyph origins). */
  base: number
  size: number
  text: string
  bold: boolean
  italic: boolean
  /** 0xRRGGBB */
  color: number
  font: string
  /** Text set along another direction (a label up the side of a cell). */
  vertical?: boolean
  /** Space glyphs right before this word on its line (0 when none). */
  sp?: number
  /** Not text the page holds but a checkbox, written as ☐ / ☒ by the layout. */
  glyph?: boolean
}

/** A horizontal rule: y, x0..x1. Thickness in points. */
export interface SheetHRule { y: number; x0: number; x1: number; w: number; color: number }
/** A vertical rule: x, y0..y1. */
export interface SheetVRule { x: number; y0: number; y1: number; w: number; color: number }
export interface SheetFill { x0: number; y0: number; x1: number; y1: number; color: number }
export interface SheetMark { x0: number; y0: number; x1: number; y1: number }

export interface SheetPageData {
  pageIndex: number
  width: number
  height: number
  words: SheetWord[]
  hRules: SheetHRule[]
  vRules: SheetVRule[]
  fills: SheetFill[]
  marks: SheetMark[]
  /** Characters on the page, before any word was dropped (0 = no text layer). */
  chars: number
  /** Share of the page covered by pictures (a scan is one picture covering it). */
  imageCover: number
}

type Mat = [number, number, number, number, number, number]

/** Thinner than this along one axis, a filled shape is a rule, not a cell fill. */
const RULE_MAX = 2.6
/** Shorter than this, a rule is a speck. */
const RULE_MIN_LEN = 2.5

function rgbOf(color: ArrayLike<number> | null | undefined): number {
  if (!color || !color.length) return 0
  let r: number, g: number, b: number
  if (color.length === 1) r = g = b = color[0]
  else if (color.length === 3) { r = color[0]; g = color[1]; b = color[2] }
  else if (color.length >= 4) {
    const k = color[3]
    r = (1 - color[0]) * (1 - k); g = (1 - color[1]) * (1 - k); b = (1 - color[2]) * (1 - k)
  } else return 0
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)))
  return (c(r) << 16) | (c(g) << 8) | c(b)
}

function isNearWhite(rgb: number): boolean {
  return ((rgb >> 16) & 255) > 245 && ((rgb >> 8) & 255) > 245 && (rgb & 255) > 245
}

function tx(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

interface SubPath { pts: [number, number][]; curved: boolean; closed: boolean }

function subPathsOf(path: any, ctm: Mat): SubPath[] {
  const out: SubPath[] = []
  let cur: SubPath | null = null
  path.walk({
    moveTo(x: number, y: number) { cur = { pts: [tx(ctm, x, y)], curved: false, closed: false }; out.push(cur) },
    lineTo(x: number, y: number) { if (!cur) { cur = { pts: [], curved: false, closed: false }; out.push(cur) } cur.pts.push(tx(ctm, x, y)) },
    curveTo(_x1: number, _y1: number, _x2: number, _y2: number, x3: number, y3: number) {
      if (!cur) { cur = { pts: [], curved: false, closed: false }; out.push(cur) }
      cur.curved = true; cur.pts.push(tx(ctm, x3, y3))
    },
    closePath() { if (cur) cur.closed = true }
  })
  return out
}

/** The axis-aligned rectangle a sub-path draws, or null. */
function rectOf(sp: SubPath): [number, number, number, number] | null {
  if (sp.curved) return null
  const p = sp.pts.slice()
  if (p.length >= 2) {
    const a = p[0], z = p[p.length - 1]
    if (Math.abs(a[0] - z[0]) < 0.01 && Math.abs(a[1] - z[1]) < 0.01) p.pop()
  }
  if (p.length !== 4) return null
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4]
    if (Math.abs(a[0] - b[0]) > 0.05 && Math.abs(a[1] - b[1]) > 0.05) return null
  }
  const xs = p.map(q => q[0]), ys = p.map(q => q[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

export function extractSheetPage(mupdf: any, doc: any, pageIndex: number, watermark = ''): SheetPageData {
  const page = doc.loadPage(pageIndex)
  try {
    const b = page.getBounds()
    const ox = b[0], oy = b[1]
    const width = b[2] - b[0], height = b[3] - b[1]
    const hRules: SheetHRule[] = []
    const vRules: SheetVRule[] = []
    const fills: SheetFill[] = []
    const marks: SheetMark[] = []
    let imageArea = 0

    const addH = (y: number, x0: number, x1: number, w: number, color: number) => {
      if (x1 - x0 >= RULE_MIN_LEN) hRules.push({ y: y - oy, x0: x0 - ox, x1: x1 - ox, w, color })
    }
    const addV = (x: number, y0: number, y1: number, w: number, color: number) => {
      if (y1 - y0 >= RULE_MIN_LEN) vRules.push({ x: x - ox, y0: y0 - oy, y1: y1 - oy, w, color })
    }
    /** A filled or imaged rectangle: a rule when thin, a fill when coloured. */
    const addRect = (x0: number, y0: number, x1: number, y1: number, color: number, asFill: boolean) => {
      const w = x1 - x0, h = y1 - y0
      if (h <= RULE_MAX && w > h) addH((y0 + y1) / 2, x0, x1, Math.max(h, 0.1), color)
      else if (w <= RULE_MAX && h > w) addV((x0 + x1) / 2, y0, y1, Math.max(w, 0.1), color)
      else if (asFill && !isNearWhite(color) && w * h < width * height * 0.6) {
        fills.push({ x0: x0 - ox, y0: y0 - oy, x1: x1 - ox, y1: y1 - oy, color })
      }
    }

    const dev = new mupdf.Device({
      fillPath(path: any, _evenOdd: boolean, ctm: Mat, _cs: any, color: number[], alpha: number) {
        if (alpha <= 0.05) return
        const rgb = rgbOf(color)
        // White is paper: Excel paints white borders to hide its gridlines,
        // and a white box is an eraser. Neither is a line anyone can see.
        if (isNearWhite(rgb)) return
        const subs = subPathsOf(path, ctm)
        const rects: ([number, number, number, number] | null)[] = subs.map(rectOf)
        // A frame: one rectangle inside another with a thin margin all round,
        // painted as a border by the fill rule. Its edges are the rules.
        const used = new Set<number>()
        for (let i = 0; i < rects.length; i++) {
          const o = rects[i]
          if (!o || used.has(i)) continue
          for (let j = 0; j < rects.length; j++) {
            const n = rects[j]
            if (i === j || !n || used.has(j)) continue
            const m = [n[0] - o[0], n[1] - o[1], o[2] - n[2], o[3] - n[3]]
            if (m.every(v => v >= -0.01 && v <= RULE_MAX) && n[2] > n[0] && n[3] > n[1]) {
              used.add(i); used.add(j)
              addH((o[1] + n[1]) / 2, o[0], o[2], Math.max(m[1], 0.1), rgb)
              addH((o[3] + n[3]) / 2, o[0], o[2], Math.max(m[3], 0.1), rgb)
              addV((o[0] + n[0]) / 2, o[1], o[3], Math.max(m[0], 0.1), rgb)
              addV((o[2] + n[2]) / 2, o[1], o[3], Math.max(m[2], 0.1), rgb)
              break
            }
          }
        }
        rects.forEach((r, i) => {
          if (used.has(i)) return
          if (r) { addRect(r[0], r[1], r[2], r[3], rgb, true); return }
          const pts = subs[i].pts
          if (!pts.length) return
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
          const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys)
          if (bw <= 20 && bh <= 20 && !isNearWhite(rgb)) {
            marks.push({ x0: Math.min(...xs) - ox, y0: Math.min(...ys) - oy, x1: Math.max(...xs) - ox, y1: Math.max(...ys) - oy })
          }
        })
      },
      strokePath(path: any, stroke: any, ctm: Mat, _cs: any, color: number[], alpha: number) {
        if (alpha <= 0.05) return
        const rgb = rgbOf(color)
        if (isNearWhite(rgb)) return
        const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1
        const lw = Math.max(0.1, (stroke?.getLineWidth?.() ?? 1) * scale)
        for (const sp of subPathsOf(path, ctm)) {
          const pts = sp.closed && sp.pts.length > 2 ? [...sp.pts, sp.pts[0]] : sp.pts
          let diagonal = false
          for (let i = 1; i < pts.length; i++) {
            const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]
            if (Math.abs(y1 - y0) <= 0.6 && Math.abs(x1 - x0) > 0.6) addH((y0 + y1) / 2, Math.min(x0, x1), Math.max(x0, x1), lw, rgb)
            else if (Math.abs(x1 - x0) <= 0.6 && Math.abs(y1 - y0) > 0.6) addV((x0 + x1) / 2, Math.min(y0, y1), Math.max(y0, y1), lw, rgb)
            else if (Math.abs(x1 - x0) > 0.6 || Math.abs(y1 - y0) > 0.6) diagonal = true
          }
          if ((diagonal || sp.curved) && sp.pts.length) {
            const xs = sp.pts.map(p => p[0]), ys = sp.pts.map(p => p[1])
            if (Math.max(...xs) - Math.min(...xs) <= 20 && Math.max(...ys) - Math.min(...ys) <= 20) {
              marks.push({ x0: Math.min(...xs) - ox, y0: Math.min(...ys) - oy, x1: Math.max(...xs) - ox, y1: Math.max(...ys) - oy })
            }
          }
        }
      },
      fillImage(_image: any, ctm: Mat, alpha: number) {
        if (alpha <= 0.05) return
        const c = [tx(ctm, 0, 0), tx(ctm, 1, 0), tx(ctm, 0, 1), tx(ctm, 1, 1)]
        const xs = c.map(p => p[0]), ys = c.map(p => p[1])
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
        const w = x1 - x0, h = y1 - y0
        if (Math.min(w, h) <= RULE_MAX) addRect(x0, y0, x1, y1, 0, false)
        else imageArea += Math.min(w, width) * Math.min(h, height)
      },
      fillImageMask(_image: any, ctm: Mat, _cs: any, color: number[], alpha: number) {
        if (alpha <= 0.05) return
        const c = [tx(ctm, 0, 0), tx(ctm, 1, 0), tx(ctm, 0, 1), tx(ctm, 1, 1)]
        const xs = c.map(p => p[0]), ys = c.map(p => p[1])
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
        if (Math.min(x1 - x0, y1 - y0) <= RULE_MAX) { if (!isNearWhite(rgbOf(color))) addRect(x0, y0, x1, y1, rgbOf(color), false) }
        else imageArea += Math.min(x1 - x0, width) * Math.min(y1 - y0, height)
      }
    })
    try { page.run(dev, mupdf.Matrix.identity) } finally { try { dev.close() } catch (_) { /* closed */ } }

    // ── Words ──
    const words: SheetWord[] = []
    let chars = 0
    const wm = watermark.replace(/\s+/g, '')
    const st = page.toStructuredText('preserve-whitespace')
    try {
      let lineWords: SheetWord[] = []
      let lineText = ''
      let horizontal = true
      let turned = false
      let w: SheetWord | null = null
      let prev: { c: string; ox: number; x1: number; adv: number } | null = null
      let pendingSpace = 0
      const flushWord = () => { if (w && w.text) lineWords.push(w); w = null }
      const flushLine = () => {
        flushWord()
        const t = lineText.replace(/\s+/g, '')
        // A watermark this editor wrote is an artifact, not text to export.
        const isWm = !!wm && !!t && wm.includes(t) && (t === wm || turned)
        if (!isWm) for (const lw of lineWords) words.push(lw)
        lineWords = []; lineText = ''; prev = null; pendingSpace = 0
      }
      st.walk({
        beginLine(_bbox: number[], _wmode: number, dir: number[]) {
          flushLine()
          horizontal = Math.abs(dir[1]) < 0.2 && dir[0] > 0
          turned = !horizontal
        },
        onChar(c: string, origin: number[], font: any, size: number, quad: number[], color: number[]) {
          chars++
          // A glyph the font cannot name is nothing a cell can show.
          if (c === '�') return
          lineText += c
          const qx = [quad[0], quad[2], quad[4], quad[6]], qy = [quad[1], quad[3], quad[5], quad[7]]
          const x0 = Math.min(...qx) - ox, x1 = Math.max(...qx) - ox
          const y0 = Math.min(...qy) - oy, y1 = Math.max(...qy) - oy
          if (!horizontal) {
            // Turned text is kept whole: one word per line, placed by its box.
            if (!w) {
              w = { x0, y0, x1, y1, base: origin[1] - oy, size, text: '', bold: false, italic: false, color: rgbOf(color), font: '', vertical: true }
              const name = String(font?.getName?.() ?? '')
              w.font = name; w.bold = !!font?.isBold?.() || /bold|black|heavy/i.test(name); w.italic = !!font?.isItalic?.() || /italic|oblique/i.test(name)
            }
            w.text += c
            w.x0 = Math.min(w.x0, x0); w.x1 = Math.max(w.x1, x1); w.y0 = Math.min(w.y0, y0); w.y1 = Math.max(w.y1, y1)
            return
          }
          // (\s covers the no-break space too.)
          if (/\s/.test(c)) { flushWord(); pendingSpace++; prev = null; return }
          const adv = x1 - x0
          // The same glyph drawn twice a hair apart is fake bold, not two letters.
          if (prev && prev.c === c && Math.abs((origin[0] - ox) - prev.ox) < Math.max(0.3, adv * 0.2)) return
          const gap = prev ? x0 - prev.x1 : 0
          if (w && prev && (gap > size * 0.25 || x0 < prev.ox - 0.5)) flushWord()
          if (!w) {
            const name = String(font?.getName?.() ?? '')
            w = {
              x0, y0, x1, y1, base: origin[1] - oy, size, text: '',
              bold: !!font?.isBold?.() || /bold|black|heavy|semibold|demi/i.test(name),
              italic: !!font?.isItalic?.() || /italic|oblique/i.test(name),
              color: rgbOf(color), font: name, sp: pendingSpace || undefined
            }
            pendingSpace = 0
          }
          w.text += c
          w.x0 = Math.min(w.x0, x0); w.x1 = Math.max(w.x1, x1); w.y0 = Math.min(w.y0, y0); w.y1 = Math.max(w.y1, y1)
          w.size = Math.max(w.size, size)
          prev = { c, ox: origin[0] - ox, x1, adv }
        },
        endLine() { flushLine() }
      })
      flushLine()
    } finally {
      try { st.destroy() } catch (_) { /* gone */ }
    }

    const imageCover = Math.min(1, imageArea / Math.max(1, width * height))
    return { pageIndex, width, height, words, hRules, vRules, fills, marks, chars, imageCover }
  } finally {
    page.destroy()
  }
}
