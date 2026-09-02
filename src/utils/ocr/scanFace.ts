import * as opentype from 'opentype.js'
import { init as potraceInit, potrace } from 'esm-potrace-wasm'
import { cutGlyphs, cellBitmap, expectedAdvance } from './glyphCut'
import type { OcrBox } from './ocrEngine'

/**
 * The scan face: a font whose glyphs are traced from the scan's own ink.
 *
 * Acrobat's "Editable text and images" does this for a whole page. Here a
 * face is built PER PAGE, lazily, from the runs the user edits: each character
 * of an edited run is cut out of the 220 DPI raster (`glyphCut`), binarised,
 * traced to outlines with Potrace and scaled onto a 1000-unit em, and the
 * glyph library is compiled into an OpenType font with opentype.js. The same
 * bytes register as a `FontFace` for the on-screen preview and are embedded by
 * the engine on export, so an edited run keeps the look of the document
 * instead of arriving in Helvetica.
 *
 * Only characters the scan actually SHOWED get glyphs. A character the user
 * types that the page never contained falls back to the base font inside the
 * same line — the engine lays the mixed run out; the preview relies on the
 * CSS font stack. First seen wins: the glyph for "a" is the first "a" traced
 * on the page, in that run's weight and slant.
 */

const UPM = 1000
const ASCENDER = 800
const DESCENDER = -200

export interface TracedGlyph {
  char: string
  path: opentype.Path
  advance: number
}

export interface ScanFace {
  pageIndex: number
  familyName: string
  glyphs: Map<string, TracedGlyph>
  /** Font bytes for the current glyph set, rebuilt on change. */
  bytes: ArrayBuffer | null
  /** Bumped on every rebuild — the export sends bytes once per version. */
  version: number
  fontFace: FontFace | null
}

const faces = new Map<number, ScanFace>()
let potraceReady: Promise<void> | null = null

export function scanFaceFor(pageIndex: number): ScanFace {
  let f = faces.get(pageIndex)
  if (!f) {
    f = { pageIndex, familyName: `ScanFace-p${pageIndex + 1}`, glyphs: new Map(), bytes: null, version: 0, fontFace: null }
    faces.set(pageIndex, f)
  }
  return f
}

export function clearScanFaces() {
  for (const f of faces.values()) {
    if (f.fontFace) { try { document.fonts.delete(f.fontFace) } catch (_) { /* gone */ } }
  }
  faces.clear()
}

/** The characters of `text` the face can draw. */
export function canDrawAll(face: ScanFace, text: string): boolean {
  for (const ch of text) if (ch !== ' ' && !face.glyphs.has(ch)) return false
  return true
}

/**
 * Trace the glyphs of one run and add the new ones to the page's face.
 *
 * @param ctx the page raster the run was recognised on
 * @param inkRect the run's ink box in that raster's pixels
 * @param text what the run reads
 * @param symbols per-glyph boxes, when the engine reported them
 * @returns how many glyphs were added (0 when the run could not be cut)
 */
export async function traceRunIntoFace(
  face: ScanFace,
  ctx: CanvasRenderingContext2D,
  inkRect: { x: number; y: number; width: number; height: number },
  text: string,
  symbols?: OcrBox[],
  /** What the user made of the run; characters they changed are not traced. */
  editedText?: string
): Promise<number> {
  const wanted = [...text].filter(c => c !== ' ' && !face.glyphs.has(c))
  if (!wanted.length) return 0
  const cut = cutGlyphs(ctx, inkRect, text, symbols)
  if (!cut) return 0
  if (!potraceReady) potraceReady = potraceInit()
  await potraceReady

  // Only glyphs the engine and the user AGREE on. A scan's broken "m" read
  // as "rh" by both engines at 99%, and tracing on the engine's text stored
  // the two halves of the m as the face's "r" and "h" — every later r and h
  // on the page would have drawn as half an m. Where the user corrected the
  // run, the changed stretch is trusted by neither side: those characters
  // fall back to the base font, and no wrong shape enters the face.
  const trusted = trustedCells(cut.cells.length, [...text].filter(c => c !== ' '), editedText ? [...editedText].filter(c => c !== ' ') : null)

  const scale = UPM / cut.emPx
  const top = inkRect.y
  const bottom = inkRect.y + inkRect.height
  let added = 0
  for (const [index, cell] of cut.cells.entries()) {
    if (!trusted(index)) continue
    if (face.glyphs.has(cell.char)) continue
    const bmp = cellBitmap(ctx, cell, top, bottom, cut.threshold)
    if (!bmp) continue
    let svg: string
    try {
      svg = await potrace(bmp.image, { turdsize: 1, alphamax: 1, opticurve: 1, opttolerance: 0.2, pathonly: false, extractcolors: false })
    } catch (_) { continue }
    const path = svgToGlyphPath(svg, bmp, cell, cut.baselineY, scale)
    if (!path) continue
    // Side bearings of a twentieth of an em each; the advance is the cell's
    // width plus both, so traced text sets at the scan's own spacing.
    const bearing = UPM * 0.05
    const advance = Math.round((cell.x1 - cell.x0) * scale + bearing * 2)
    face.glyphs.set(cell.char, { char: cell.char, path, advance })
    added++
  }
  if (added) await rebuild(face)
  return added
}

/**
 * Which cells (by index into the run's non-space characters) both the engine's
 * reading and the user's text vouch for: the common prefix and the common
 * suffix of the two. With no edit, or an identical one, every cell.
 */
function trustedCells(count: number, original: string[], edited: string[] | null): (index: number) => boolean {
  if (!edited) return () => true
  let prefix = 0
  while (prefix < original.length && prefix < edited.length && original[prefix] === edited[prefix]) prefix++
  let suffix = 0
  while (
    suffix < original.length - prefix && suffix < edited.length - prefix &&
    original[original.length - 1 - suffix] === edited[edited.length - 1 - suffix]
  ) suffix++
  const cut = Math.min(count, original.length)
  return (index: number) => index < prefix || index >= cut - suffix
}

/**
 * Potrace's SVG → an opentype path in font units, the cell's left edge at the
 * left bearing and the baseline at y = 0, y up.
 *
 * The SVG carries its coordinates in the bitmap's pixels, usually under a
 * `<g transform="translate(…) scale(…)">` that flips the axis; the transform
 * is applied before the font mapping so either form of output lands right.
 */
function svgToGlyphPath(
  svg: string,
  bmp: { x: number; y: number },
  cell: { x0: number; x1: number },
  baselineY: number,
  scale: number
): opentype.Path | null {
  const tf = parseTransform(svg)
  const ds = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(m => m[1])
  if (!ds.length) return null
  const path = new opentype.Path()
  const bearing = UPM * 0.05
  // Bitmap pixel → font units.
  const map = (px: number, py: number): [number, number] => {
    const bx = tf.a * px + tf.c * py + tf.e
    const by = tf.b * px + tf.d * py + tf.f
    const cx = bmp.x + bx, cy = bmp.y + by
    return [(cx - cell.x0) * scale + bearing, (baselineY - cy) * scale]
  }
  let drew = false
  for (const d of ds) {
    for (const seg of parsePathData(d)) {
      if (seg.cmd === 'M') { const [x, y] = map(seg.pts[0], seg.pts[1]); path.moveTo(x, y) }
      else if (seg.cmd === 'L') { const [x, y] = map(seg.pts[0], seg.pts[1]); path.lineTo(x, y); drew = true }
      else if (seg.cmd === 'C') {
        const [x1, y1] = map(seg.pts[0], seg.pts[1]); const [x2, y2] = map(seg.pts[2], seg.pts[3]); const [x, y] = map(seg.pts[4], seg.pts[5])
        path.curveTo(x1, y1, x2, y2, x, y); drew = true
      } else if (seg.cmd === 'Q') {
        const [x1, y1] = map(seg.pts[0], seg.pts[1]); const [x, y] = map(seg.pts[2], seg.pts[3])
        path.quadTo(x1, y1, x, y); drew = true
      } else if (seg.cmd === 'Z') path.close()
    }
  }
  return drew ? path : null
}

interface Affine { a: number; b: number; c: number; d: number; e: number; f: number }

function parseTransform(svg: string): Affine {
  const tf: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const m = svg.match(/<g[^>]*transform="([^"]+)"/)
  if (!m) return tf
  let cur = { ...tf }
  for (const op of m[1].matchAll(/(translate|scale|matrix)\(([^)]*)\)/g)) {
    const n = op[2].split(/[\s,]+/).filter(Boolean).map(Number)
    let t: Affine
    if (op[1] === 'translate') t = { a: 1, b: 0, c: 0, d: 1, e: n[0] || 0, f: n[1] || 0 }
    else if (op[1] === 'scale') t = { a: n[0] ?? 1, b: 0, c: 0, d: n[1] ?? n[0] ?? 1, e: 0, f: 0 }
    else t = { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] }
    // cur = cur × t (SVG applies the listed transforms right to left to the point).
    cur = {
      a: cur.a * t.a + cur.c * t.b, b: cur.b * t.a + cur.d * t.b,
      c: cur.a * t.c + cur.c * t.d, d: cur.b * t.c + cur.d * t.d,
      e: cur.a * t.e + cur.c * t.f + cur.e, f: cur.b * t.e + cur.d * t.f + cur.f
    }
  }
  return cur
}

interface Seg { cmd: 'M' | 'L' | 'C' | 'Q' | 'Z'; pts: number[] }

/** Absolute M/L/C/Q/Z and their relative and H/V forms, as absolute segments. */
function parsePathData(d: string): Seg[] {
  const out: Seg[] = []
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? []
  let i = 0, cmd = '', cx = 0, cy = 0, sx = 0, sy = 0
  const num = () => Number(tokens[i++])
  while (i < tokens.length) {
    const t = tokens[i]
    if (/[a-zA-Z]/.test(t)) { cmd = t; i++ }
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    if (C === 'M') {
      let x = num(), y = num(); if (rel) { x += cx; y += cy }
      cx = sx = x; cy = sy = y; out.push({ cmd: 'M', pts: [x, y] })
      cmd = rel ? 'l' : 'L'
    } else if (C === 'L') {
      let x = num(), y = num(); if (rel) { x += cx; y += cy }
      cx = x; cy = y; out.push({ cmd: 'L', pts: [x, y] })
    } else if (C === 'H') { let x = num(); if (rel) x += cx; cx = x; out.push({ cmd: 'L', pts: [cx, cy] }) }
    else if (C === 'V') { let y = num(); if (rel) y += cy; cy = y; out.push({ cmd: 'L', pts: [cx, cy] }) }
    else if (C === 'C') {
      let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num()
      if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy }
      cx = x; cy = y; out.push({ cmd: 'C', pts: [x1, y1, x2, y2, x, y] })
    } else if (C === 'Q') {
      let x1 = num(), y1 = num(), x = num(), y = num()
      if (rel) { x1 += cx; y1 += cy; x += cx; y += cy }
      cx = x; cy = y; out.push({ cmd: 'Q', pts: [x1, y1, x, y] })
    } else if (C === 'Z') { cx = sx; cy = sy; out.push({ cmd: 'Z', pts: [] }) }
    else { i++ }
  }
  return out
}

/** Compile the glyph library into font bytes and (re)register the preview face. */
async function rebuild(face: ScanFace) {
  const notdef = new opentype.Glyph({ name: '.notdef', advanceWidth: Math.round(UPM * 0.5), path: new opentype.Path() })
  const glyphs = [notdef]
  for (const g of face.glyphs.values()) {
    const cp = g.char.codePointAt(0)!
    glyphs.push(new opentype.Glyph({ name: `uni${cp.toString(16).toUpperCase().padStart(4, '0')}`, unicode: cp, advanceWidth: g.advance, path: g.path }))
  }
  const font = new opentype.Font({
    familyName: face.familyName, styleName: 'Regular', unitsPerEm: UPM, ascender: ASCENDER, descender: DESCENDER, glyphs
  })
  face.bytes = font.toArrayBuffer()
  face.version++
  if (typeof FontFace !== 'undefined' && typeof document !== 'undefined') {
    if (face.fontFace) { try { document.fonts.delete(face.fontFace) } catch (_) { /* gone */ } }
    try {
      const ff = new FontFace(face.familyName, face.bytes)
      await ff.load()
      document.fonts.add(ff)
      face.fontFace = ff
    } catch (_) { face.fontFace = null }
  }
}

/** Width of `text` in the face, in ems, for characters it has; others by the base estimate. */
export function faceAdvanceEm(face: ScanFace, text: string): number {
  let em = 0
  for (const ch of text) {
    const g = face.glyphs.get(ch)
    em += g ? g.advance / UPM : (ch === ' ' ? 0.3 : expectedAdvance(ch))
  }
  return em
}
