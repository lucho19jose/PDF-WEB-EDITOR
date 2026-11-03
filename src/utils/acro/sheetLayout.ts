import type { SheetPageData, SheetWord, SheetHRule, SheetVRule, SheetFill, SheetMark } from '../../engine/worker/sheetExtract'

/**
 * "Exportar a Excel": a page's words and drawing, rebuilt as rows and columns.
 *
 * A PDF has no cells. What it has is text at coordinates and, often, the
 * lines of a table drawn around it. Two kinds of table are rebuilt here, the
 * same two every PDF-to-spreadsheet tool distinguishes:
 *
 *  - RULED ("lattice"): the borders are drawn. Their x and y positions are the
 *    grid; where a border is MISSING between two grid cells they are one
 *    merged cell — which is exactly how a form made in Excel was drawn, so it
 *    comes back with its merges. Words go to the cell their centre lies in.
 *    Each ruled table keeps its OWN columns from column A: fitting every
 *    table's borders into every other's (one grid for the whole page) turns a
 *    clean data table into a sheet of merged cells nobody can sort or filter.
 *
 *  - UNRULED ("stream"): only the text is there. Rows are the text's
 *    baselines; columns are the GUTTERS, the vertical strips of white that run
 *    down every row of a block, or — on a form — the underlines each value is
 *    written on. All the unruled text of a sheet shares ONE set of columns
 *    (`placeStream`): seeded by the biggest block, every other row's pieces
 *    are placed by where they sit on the paper, and a column boundary is
 *    added only where two pieces of one row would otherwise share a cell. So
 *    a form's labels and values land where they sit on the page, and a data
 *    table's columns stay contiguous.
 */

export type HAlign = 'left' | 'center' | 'right'
export interface XBorder { style: 'thin' | 'medium' | 'thick'; color: number }
export interface XCell {
  r: number
  c: number
  text: string
  /** Number of rows/columns this cell spans (merged), 1 when absent. */
  rows?: number
  cols?: number
  bold?: boolean
  italic?: boolean
  size?: number
  color?: number
  font?: string
  fill?: number
  border?: { top?: XBorder; bottom?: XBorder; left?: XBorder; right?: XBorder }
  ha?: HAlign
  va?: 'top' | 'center' | 'bottom'
  wrap?: boolean
  rotation?: number
  /** Never convert to a number: it would not fit its cell and would print as #####. */
  keepText?: boolean
}

export interface XSheet {
  name: string
  cells: XCell[]
  /** Excel character units, by column index. */
  colWidths: number[]
  /** Points, by row index. */
  rowHeights: Map<number, number>
  landscape: boolean
  /** OOXML paperSize: 9 = A4, 1 = Letter, 5 = Legal. */
  paper: number
  gridLines: boolean
  /** One note for the user, in the first cell, when the page gave nothing. */
  note?: string
}

/** Rules this close are the same line. */
const SNAP = 2.5
/** A rule ending this close to another still meets it. */
const TOL = 3

interface HSeg { y: number; x0: number; x1: number; w: number; color: number; virtual?: boolean }
interface VSeg { x: number; y0: number; y1: number; w: number; color: number; virtual?: boolean }
interface Box { x0: number; y0: number; x1: number; y1: number }

const cx = (w: Box) => (w.x0 + w.x1) / 2
const cy = (w: Box) => (w.y0 + w.y1) / 2
const median = (v: number[]) => {
  if (!v.length) return 0
  const s = v.slice().sort((a, b) => a - b)
  return s[s.length >> 1]
}

// ───────────────────────── Rules ─────────────────────────

function mergeH(rules: SheetHRule[]): HSeg[] {
  const s = rules.slice().sort((a, b) => a.y - b.y || a.x0 - b.x0)
  const out: HSeg[] = []
  let group: SheetHRule[] = []
  const flush = () => {
    if (!group.length) return
    group.sort((a, b) => a.x0 - b.x0)
    let cur: HSeg | null = null
    let len = 0, ysum = 0
    for (const r of group) {
      const l = r.x1 - r.x0
      if (cur && r.x0 <= cur.x1 + 1.5) {
        cur.x1 = Math.max(cur.x1, r.x1); cur.w = Math.max(cur.w, r.w)
        len += l; ysum += r.y * l; cur.y = ysum / Math.max(len, 1e-6)
      } else {
        cur = { y: r.y, x0: r.x0, x1: r.x1, w: r.w, color: r.color }
        len = l; ysum = r.y * l
        out.push(cur)
      }
    }
    group = []
  }
  for (const r of s) {
    if (group.length && r.y - group[group.length - 1].y > 1.0) flush()
    group.push(r)
  }
  flush()
  return out
}

function mergeV(rules: SheetVRule[]): VSeg[] {
  return mergeH(rules.map(r => ({ y: r.x, x0: r.y0, x1: r.y1, w: r.w, color: r.color })))
    .map(h => ({ x: h.y, y0: h.x0, y1: h.x1, w: h.w, color: h.color }))
}

function meets(h: HSeg, v: VSeg): boolean {
  return v.x >= h.x0 - TOL && v.x <= h.x1 + TOL && h.y >= v.y0 - TOL && h.y <= v.y1 + TOL
}

function cluster(values: number[], snap = SNAP): number[] {
  const s = values.slice().sort((a, b) => a - b)
  const out: number[] = []
  let group: number[] = []
  for (const v of s) {
    if (group.length && v - group[group.length - 1] > snap) { out.push(group.reduce((a, b) => a + b, 0) / group.length); group = [] }
    group.push(v)
  }
  if (group.length) out.push(group.reduce((a, b) => a + b, 0) / group.length)
  return out
}

function nearestIndex(sorted: number[], v: number, tol: number): number {
  let best = -1, bd = Infinity
  for (let i = 0; i < sorted.length; i++) {
    const d = Math.abs(sorted[i] - v)
    if (d < bd) { bd = d; best = i }
  }
  return bd <= tol ? best : -1
}

/** Which grid band [edges[i], edges[i+1]) holds v (clamped). */
function bandOf(edges: number[], v: number): number {
  let lo = 0, hi = edges.length - 2
  if (v <= edges[0]) return 0
  if (v >= edges[edges.length - 1]) return hi
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (edges[mid] <= v) lo = mid
    else hi = mid - 1
  }
  return lo
}

class UnionFind {
  p: Int32Array
  constructor(n: number) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i }
  find(i: number): number { while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]]; i = this.p[i] } return i }
  union(a: number, b: number) { a = this.find(a); b = this.find(b); if (a !== b) this.p[b] = a }
}

function unionIntervals(iv: [number, number][]): [number, number][] {
  const s = iv.slice().sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const [a, b] of s) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

function coverage(intervals: [number, number][], a: number, b: number): number {
  let cov = 0
  for (const [s, e] of intervals) {
    const lo = Math.max(a, s), hi = Math.min(b, e)
    if (hi > lo) cov += hi - lo
  }
  return cov
}

// ───────────────────────── Ruled tables ─────────────────────────

/** A grid edge: `on` separates two cells; `visible` when a real line is drawn there (not only a virtual one). */
interface Edge { on: boolean; visible: boolean; w: number; color: number }
interface Region { r0: number; r1: number; c0: number; c1: number; words: SheetWord[] }
export interface TableItem {
  kind: 'table'
  top: number; bottom: number; left: number; right: number
  xs: number[]; ys: number[]
  /** hEdges[i][j]: the border along ys[i] over column j. */
  hEdges: Edge[][]
  /** vEdges[i][j]: the border along xs[j] over row i. */
  vEdges: Edge[][]
  regions: Region[]
  fills: SheetFill[]
}

type Grid = Omit<TableItem, 'regions' | 'fills'>

function buildGrid(H: HSeg[], V: VSeg[]): Grid | null {
  const minHX = Math.min(...H.map(h => h.x0)), maxHX = Math.max(...H.map(h => h.x1))
  const minVY = Math.min(...V.map(v => v.y0)), maxVY = Math.max(...V.map(v => v.y1))
  const xsRaw = V.map(v => v.x)
  if (minHX < Math.min(...xsRaw) - SNAP) xsRaw.push(minHX)
  if (maxHX > Math.max(...xsRaw) + SNAP) xsRaw.push(maxHX)
  const ysRaw = H.map(h => h.y)
  if (minVY < Math.min(...ysRaw) - SNAP) ysRaw.push(minVY)
  if (maxVY > Math.max(...ysRaw) + SNAP) ysRaw.push(maxVY)
  const xs = cluster(xsRaw), ys = cluster(ysRaw)
  if (xs.length < 2 || ys.length < 2) return null
  const nR = ys.length - 1, nC = xs.length - 1

  const hLines: { iv: [number, number][]; segs: HSeg[] }[] = ys.map(() => ({ iv: [], segs: [] }))
  for (const h of H) {
    const i = nearestIndex(ys, h.y, SNAP + h.w / 2)
    if (i >= 0) { hLines[i].iv.push([h.x0 - TOL, h.x1 + TOL]); hLines[i].segs.push(h) }
  }
  const vLines: { iv: [number, number][]; segs: VSeg[] }[] = xs.map(() => ({ iv: [], segs: [] }))
  for (const v of V) {
    const j = nearestIndex(xs, v.x, SNAP + v.w / 2)
    if (j >= 0) { vLines[j].iv.push([v.y0 - TOL, v.y1 + TOL]); vLines[j].segs.push(v) }
  }
  const hU = hLines.map(l => unionIntervals(l.iv)), vU = vLines.map(l => unionIntervals(l.iv))
  const realOf = (segs: (HSeg | VSeg)[], lo: (s: any) => number, hi: (s: any) => number) =>
    unionIntervals(segs.filter(s => !s.virtual).map(s => [lo(s) - TOL, hi(s) + TOL] as [number, number]))
  const hR = hLines.map(l => realOf(l.segs, s => s.x0, s => s.x1)), vR = vLines.map(l => realOf(l.segs, s => s.y0, s => s.y1))
  const edgeOf = (iv: [number, number][], real: [number, number][], segs: (HSeg | VSeg)[], a: number, b: number, lo: (s: any) => number, hi: (s: any) => number): Edge => {
    const len = b - a
    const on = len > 0 && coverage(iv, a, b) >= len * 0.6
    const visible = on && coverage(real, a, b) >= len * 0.6
    let w = 0, color = 0
    if (visible) for (const s of segs) if (!s.virtual && hi(s) > a && lo(s) < b && s.w > w) { w = s.w; color = s.color }
    return { on, visible, w, color }
  }
  const hEdges: Edge[][] = ys.map((_, i) => xs.slice(0, -1).map((x, j) => edgeOf(hU[i], hR[i], hLines[i].segs, x, xs[j + 1], s => s.x0, s => s.x1)))
  const vEdges: Edge[][] = ys.slice(0, -1).map((y, i) => xs.map((_, j) => edgeOf(vU[j], vR[j], vLines[j].segs, y, ys[i + 1], s => s.y0, s => s.y1)))
  return { kind: 'table', xs, ys, hEdges, vEdges, top: ys[0], bottom: ys[nR], left: xs[0], right: xs[nC] }
}

/**
 * The merged cells: grid cells with no border between them are one cell. An
 * area that is not a rectangle (borders that stop short, a checkbox drawn in
 * the corner of a cell) cannot be one Excel cell, so it is cut into the
 * fewest rectangles its rows allow — one strip per row, strips of the same
 * columns stacked back together.
 */
function regionsOf(g: Grid): Region[] {
  const nR = g.ys.length - 1, nC = g.xs.length - 1
  const uf = new UnionFind(nR * nC)
  for (let i = 0; i < nR; i++) {
    for (let j = 0; j < nC; j++) {
      if (j + 1 < nC && !g.vEdges[i][j + 1].on) uf.union(i * nC + j, i * nC + j + 1)
      if (i + 1 < nR && !g.hEdges[i + 1][j].on) uf.union(i * nC + j, (i + 1) * nC + j)
    }
  }
  const groups = new Map<number, number[]>()
  for (let k = 0; k < nR * nC; k++) {
    const root = uf.find(k)
    let a = groups.get(root)
    if (!a) groups.set(root, a = [])
    a.push(k)
  }
  const out: Region[] = []
  for (const cells of groups.values()) {
    let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1
    for (const k of cells) {
      const i = Math.floor(k / nC), j = k % nC
      r0 = Math.min(r0, i); r1 = Math.max(r1, i); c0 = Math.min(c0, j); c1 = Math.max(c1, j)
    }
    if ((r1 - r0 + 1) * (c1 - c0 + 1) === cells.length) { out.push({ r0, r1, c0, c1, words: [] }); continue }
    const byRow = new Map<number, number[]>()
    for (const k of cells) {
      const i = Math.floor(k / nC)
      let a = byRow.get(i)
      if (!a) byRow.set(i, a = [])
      a.push(k % nC)
    }
    const open: Region[] = []
    for (const i of [...byRow.keys()].sort((a, b) => a - b)) {
      const js = byRow.get(i)!.sort((a, b) => a - b)
      let s = 0
      while (s < js.length) {
        let e = s
        while (e + 1 < js.length && js[e + 1] === js[e] + 1) e++
        const prev = open.find(o => o.c0 === js[s] && o.c1 === js[e] && o.r1 === i - 1)
        if (prev) prev.r1 = i
        else { const reg = { r0: i, r1: i, c0: js[s], c1: js[e], words: [] }; open.push(reg); out.push(reg) }
        s = e + 1
      }
    }
  }
  out.sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0)
  return out
}

interface Checkbox extends Box { checked: boolean }

const regionArea = (g: Grid, r: Region) => (g.xs[r.c1 + 1] - g.xs[r.c0]) * (g.ys[r.r1 + 1] - g.ys[r.r0])

/**
 * The ruled tables of a page, the checkboxes among the rules, and the rules
 * no table took (a form's underlines, which say where its columns are).
 * Words a table claims are removed from `words`.
 */
function findTables(page: SheetPageData, words: SheetWord[]): { tables: TableItem[]; boxes: Checkbox[]; freeH: HSeg[] } {
  let H = mergeH(page.hRules)
  let V = mergeV(page.vRules)
  if (!H.length || !V.length) return { tables: [], boxes: [], freeH: H }

  const components = () => {
    const n = H.length + V.length
    const uf = new UnionFind(n)
    // Sorting V by x lets each H look only at the verticals it can reach.
    const vOrder = V.map((_, i) => i).sort((a, b) => V[a].x - V[b].x)
    const vx = vOrder.map(i => V[i].x)
    for (let i = 0; i < H.length; i++) {
      const h = H[i]
      let lo = 0, hi = vx.length
      while (lo < hi) { const m = (lo + hi) >> 1; if (vx[m] < h.x0 - TOL) lo = m + 1; else hi = m }
      for (let k = lo; k < vx.length && vx[k] <= h.x1 + TOL; k++) {
        if (meets(h, V[vOrder[k]])) uf.union(i, H.length + vOrder[k])
      }
    }
    const comps = new Map<number, { h: HSeg[]; v: VSeg[] }>()
    for (let i = 0; i < n; i++) {
      const r = uf.find(i)
      let c = comps.get(r)
      if (!c) comps.set(r, c = { h: [], v: [] })
      if (i < H.length) c.h.push(H[i]); else c.v.push(V[i - H.length])
    }
    return [...comps.values()]
  }

  const inside = (b: Box, w: Box, pad = 0.5) => cx(w) >= b.x0 - pad && cx(w) <= b.x1 + pad && cy(w) >= b.y0 - pad && cy(w) <= b.y1 + pad
  const bboxOf = (c: { h: HSeg[]; v: VSeg[] }): Box => ({
    x0: Math.min(...c.h.map(h => h.x0), ...c.v.map(v => v.x)),
    x1: Math.max(...c.h.map(h => h.x1), ...c.v.map(v => v.x)),
    y0: Math.min(...c.v.map(v => v.y0), ...c.h.map(h => h.y)),
    y1: Math.max(...c.v.map(v => v.y1), ...c.h.map(h => h.y))
  })

  /** Ticked: a coloured fill about its own size, or a mark (an X, a tick) inside it. */
  const checkedAt = (b: Box) => {
    const area = (b.x1 - b.x0) * (b.y1 - b.y0)
    return page.fills.some(f => {
      const ix = Math.min(f.x1, b.x1) - Math.max(f.x0, b.x0), iy = Math.min(f.y1, b.y1) - Math.max(f.y0, b.y0)
      return ix > 0 && iy > 0 && ix * iy >= area * 0.3 && (f.x1 - f.x0) * (f.y1 - f.y0) <= area * 4
    }) || page.marks.some((mk: SheetMark) => cx(mk) > b.x0 && cx(mk) < b.x1 && cy(mk) > b.y0 && cy(mk) < b.y1)
  }

  // A small square with nothing written in it is a checkbox, not a table.
  const boxes: Checkbox[] = []
  const drop = new Set<HSeg | VSeg>()
  for (const c of components()) {
    if (c.h.length < 2 || c.v.length < 2 || c.h.length > 4 || c.v.length > 4) continue
    const b = bboxOf(c)
    const w = b.x1 - b.x0, h = b.y1 - b.y0
    if (w < 4 || w > 18 || h < 4 || h > 18 || w / h > 1.5 || h / w > 1.5) continue
    if (words.some(wd => inside(b, wd, -0.5))) continue
    boxes.push({ ...b, checked: checkedAt(b) })
    for (const s of c.h) drop.add(s)
    for (const s of c.v) drop.add(s)
  }
  if (drop.size) { H = H.filter(s => !drop.has(s)); V = V.filter(s => !drop.has(s)) }

  // A ruled block drawn inside another (a sub-table in a cell) joins it.
  const comps = components().filter(c => c.h.length >= 2 && c.v.length >= 2)
  comps.sort((a, b) => {
    const ba = bboxOf(a), bb = bboxOf(b)
    return (bb.x1 - bb.x0) * (bb.y1 - bb.y0) - (ba.x1 - ba.x0) * (ba.y1 - ba.y0)
  })
  const merged: { h: HSeg[]; v: VSeg[]; box: Box }[] = []
  for (const c of comps) {
    const b = bboxOf(c)
    const host = merged.find(m => b.x0 >= m.box.x0 - TOL && b.x1 <= m.box.x1 + TOL && b.y0 >= m.box.y0 - TOL && b.y1 <= m.box.y1 + TOL)
    if (host) { host.h.push(...c.h); host.v.push(...c.v) }
    else merged.push({ h: c.h.slice(), v: c.v.slice(), box: b })
  }

  const tables: TableItem[] = []
  const usedH = new Set<HSeg>()
  const pageArea = page.width * page.height
  const assign = (g: Grid, regions: Region[]) => {
    const taken: SheetWord[] = []
    const tbox = { x0: g.left, y0: g.top, x1: g.right, y1: g.bottom }
    for (const w of words) {
      if (!inside(tbox, w, 1)) continue
      const i = bandOf(g.ys, cy(w)), j = bandOf(g.xs, cx(w))
      const reg = regions.find(r => i >= r.r0 && i <= r.r1 && j >= r.c0 && j <= r.c1)
      if (reg) { reg.words.push(w); taken.push(w) }
    }
    return taken
  }
  for (const m of merged) {
    const g0 = buildGrid(m.h, m.v)
    if (!g0) continue
    let g: Grid = g0
    let regions = regionsOf(g)
    let taken = assign(g, regions)
    // A checkbox drawn against a cell's border joins the table's lines and
    // comes out as a tiny bordered cell (or a stray bracket where it shares
    // an edge). Such cells — small, square, empty, closed on all four sides —
    // are taken back out: their own lines go, and they become ☐ / ☒ text.
    const squares: Box[] = []
    for (const r of regions) {
      if (r.words.length) continue
      const x0 = g.xs[r.c0], x1 = g.xs[r.c1 + 1], y0 = g.ys[r.r0], y1 = g.ys[r.r1 + 1]
      const w = x1 - x0, h = y1 - y0
      if (w < 4 || w > 18 || h < 4 || h > 18 || w / h > 1.6 || h / w > 1.6) continue
      let closed = true
      for (let j = r.c0; j <= r.c1 && closed; j++) closed = g.hEdges[r.r0][j].on && g.hEdges[r.r1 + 1][j].on
      for (let i = r.r0; i <= r.r1 && closed; i++) closed = g.vEdges[i][r.c0].on && g.vEdges[i][r.c1 + 1].on
      if (closed) squares.push({ x0, y0, x1, y1 })
    }
    if (squares.length) {
      const ownH = (h: HSeg) => {
        const iv = unionIntervals(squares.filter(q => Math.abs(h.y - q.y0) <= SNAP || Math.abs(h.y - q.y1) <= SNAP).map(q => [q.x0 - 2, q.x1 + 2] as [number, number]))
        return coverage(iv, h.x0, h.x1) >= (h.x1 - h.x0) * 0.9
      }
      const ownV = (v: VSeg) => {
        const iv = unionIntervals(squares.filter(q => Math.abs(v.x - q.x0) <= SNAP || Math.abs(v.x - q.x1) <= SNAP).map(q => [q.y0 - 2, q.y1 + 2] as [number, number]))
        return coverage(iv, v.y0, v.y1) >= (v.y1 - v.y0) * 0.9
      }
      const h2 = m.h.filter(h => !ownH(h)), v2 = m.v.filter(v => !ownV(v))
      const g2 = h2.length >= 2 && v2.length >= 2 ? buildGrid(h2, v2) : null
      if (g2) {
        for (const r of regions) r.words = []
        // The checkbox's own lines are spent: they are no form's underlines.
        for (const h of m.h) if (!h2.includes(h)) usedH.add(h)
        g = g2; m.h = h2; m.v = v2
        regions = regionsOf(g)
        for (const q of squares) boxes.push({ ...q, checked: checkedAt(q) })
        taken = assign(g, regions)
      }
    }
    // A frame round the page (or round most of it) is decoration, not a
    // table: one "cell" holding half the document is worth less than the
    // text laid out as rows. Its words go back to the page.
    const big = regions.filter(r => {
      const lines = buildRows(r.words).length
      return lines > 7 || (lines > 3 && regionArea(g, r) > pageArea * 0.12)
    })
    const bigArea = big.reduce((s, r) => s + regionArea(g, r), 0)
    const tableArea = (g.right - g.left) * (g.bottom - g.top)
    if (big.length && (regions.length <= 4 || bigArea > tableArea * 0.45)) continue
    if (!regions.some(r => r.words.length) && regions.length <= 2) continue
    // A ruled cell holding lines of several columns ("ITEM  CODIGO  DESCRIPCION
    // CANT.  TOTAL" in a box with no lines between the columns, or "VALOR DE
    // VENTA  78,243.32" over "I.G.V 18%  14,083.80") is a table whose inner
    // lines were never drawn. It gets them back, invisible: a row per text
    // line and a column per gutter, so each value is a cell of its own.
    const sub = subdivide(g, regions, m)
    if (sub) {
      const g3 = buildGrid(sub.h, sub.v)
      if (g3) {
        for (const r of regions) r.words = []
        g = g3
        regions = regionsOf(g)
        taken = assign(g, regions)
      }
    }
    // A diagram (a network map, an org chart) is lines that happen to meet:
    // dozens of "columns" and almost every "cell" empty. Not a table.
    const filled = regions.filter(r => r.words.length).length
    if ((g.xs.length > 41 || regions.length > 150) && filled < regions.length * 0.15) continue
    for (const w of taken) words.splice(words.indexOf(w), 1)
    for (const h of m.h) usedH.add(h)
    tables.push({ ...g, regions, fills: page.fills })
  }
  return { tables, boxes, freeH: H.filter(h => !usedH.has(h)) }
}

function subdivide(g: Grid, regions: Region[], m: { h: HSeg[]; v: VSeg[] }): { h: HSeg[]; v: VSeg[] } | null {
  const textOf = (r: Region) => r.words.filter(w => !w.glyph && !w.vertical)
  const groups = new Map<string, { reg: Region; rows: Row[] }[]>()
  for (const r of regions) {
    const ws = textOf(r)
    if (ws.length < 2) continue
    const rows = buildRows(ws)
    if (!rows.some(row => row.segs.length >= 2)) continue
    const key = `${r.c0}:${r.c1}`
    let a = groups.get(key)
    if (!a) groups.set(key, a = [])
    a.push({ reg: r, rows })
  }
  const addH: HSeg[] = [], addV: VSeg[] = []
  for (const list of groups.values()) {
    // Regions stacked in the same columns share their gutters, so the cells
    // of a header and of the rows under it line up.
    const seps = gutterSeps(list.flatMap(e => e.rows))
    for (const { reg, rows } of list) {
      const x0 = g.xs[reg.c0], x1 = g.xs[reg.c1 + 1], y0 = g.ys[reg.r0], y1 = g.ys[reg.r1 + 1]
      const ordered = rows.slice().sort((a, b) => a.top - b.top)
      const cuts: number[] = [y0]
      for (let i = 1; i < ordered.length; i++) {
        const y = (ordered[i - 1].bottom + ordered[i].top) / 2
        if (y > y0 + 1 && y < y1 - 1) { addH.push({ y, x0, x1, w: 0, color: 0, virtual: true }); cuts.push(y) }
      }
      cuts.push(y1)
      // A column line stops at a line of text that runs across it: that row's
      // cell then spans the columns, as a merged cell.
      for (const sx of seps) {
        if (sx <= x0 + 2 || sx >= x1 - 2) continue
        for (let k = 0; k + 1 < cuts.length; k++) {
          const band = ordered.filter(r => (r.top + r.bottom) / 2 > cuts[k] && (r.top + r.bottom) / 2 < cuts[k + 1])
          if (band.some(r => r.segs.some(sg => sg.x0 < sx - 1 && sg.x1 > sx + 1))) continue
          addV.push({ x: sx, y0: cuts[k], y1: cuts[k + 1], w: 0, color: 0, virtual: true })
        }
      }
    }
  }
  if (!addH.length && !addV.length) return null
  return { h: [...m.h, ...addH], v: [...m.v, ...addV] }
}

// ───────────────────────── Rows ─────────────────────────

interface Seg { x0: number; x1: number; words: SheetWord[] }
interface Row { base: number; top: number; bottom: number; size: number; words: SheetWord[]; segs: Seg[] }

/** Words grouped into visual lines: one baseline, no two words drawn on top of each other. */
export function buildRows(words: SheetWord[]): Row[] {
  const rows: Row[] = []
  const sorted = words.filter(w => !w.glyph).sort((a, b) => a.base - b.base || a.x0 - b.x0)
  for (const w of sorted) {
    if (w.vertical) {
      rows.push({ base: w.y1, top: w.y0, bottom: w.y1, size: w.size, words: [w], segs: [] })
      continue
    }
    let best: Row | null = null, bd = Infinity
    for (let k = rows.length - 1; k >= 0; k--) {
      const r = rows[k]
      if (r.base < w.base - 40) break
      if (r.words[0].vertical) continue
      const tol = Math.max(1.2, 0.3 * Math.min(r.size, w.size))
      const d = Math.abs(r.base - w.base)
      if (d > tol || d >= bd) continue
      // Two runs drawn over each other (a stamp over a stamp) are two lines.
      const clash = r.words.some(u => {
        const ov = Math.min(u.x1, w.x1) - Math.max(u.x0, w.x0)
        return ov > 0.3 * Math.min(u.x1 - u.x0, w.x1 - w.x0)
      })
      if (clash) continue
      best = r; bd = d
    }
    if (best) {
      best.words.push(w)
      best.top = Math.min(best.top, w.y0); best.bottom = Math.max(best.bottom, w.y1)
      if (!w.glyph) best.size = Math.max(best.size, w.size)
    } else rows.push({ base: w.base, top: w.y0, bottom: w.y1, size: w.size, words: [w], segs: [] })
  }
  // A checkbox has no baseline: it belongs to the line it overlaps most.
  for (const g of words.filter(w => w.glyph)) {
    let best: Row | null = null, bo = 0
    for (const r of rows) {
      if (r.words[0].vertical) continue
      const ov = Math.min(r.bottom, g.y1) - Math.max(r.top, g.y0)
      if (ov < 0.5 * Math.min(r.bottom - r.top, g.y1 - g.y0) || ov <= bo) continue
      if (r.words.some(u => Math.min(u.x1, g.x1) - Math.max(u.x0, g.x0) > 0.3 * (g.x1 - g.x0))) continue
      best = r; bo = ov
    }
    if (best) best.words.push(g)
    else rows.push({ base: g.base, top: g.y0, bottom: g.y1, size: g.size, words: [g], segs: [] })
  }
  for (const r of rows) {
    r.words.sort((a, b) => a.x0 - b.x0)
    r.segs = []
    // Letter-spaced text ("O R D E N   D E   V I A J E") is one piece, not a
    // row of one-letter columns.
    const letters = r.words.filter(w => [...w.text].length === 1).length
    const spaced = r.words.length >= 4 && letters >= r.words.length * 0.6
    let cur: Seg | null = null
    for (const w of r.words) {
      const gap = cur ? w.x0 - cur.x1 : 0
      const em = Math.max(w.size, cur ? cur.words[cur.words.length - 1].size : 0)
      if (cur && (spaced || gap <= Math.max(2.5, 0.8 * em))) { cur.words.push(w); cur.x1 = Math.max(cur.x1, w.x1) }
      else { cur = { x0: w.x0, x1: w.x1, words: [w] }; r.segs.push(cur) }
    }
  }
  rows.sort((a, b) => a.top - b.top || a.base - b.base)
  return rows
}

/** A run of words as text, with a space where the page had one. */
export function wordsText(ws: SheetWord[]): string {
  let s = ''
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]
    if (i) {
      const p = ws[i - 1]
      const gap = w.x0 - p.x1
      if (w.sp && w.sp > 1) s += ' '.repeat(Math.min(3, w.sp))
      else if (w.sp || p.glyph || w.glyph || gap > 0.15 * Math.min(w.size, p.size)) s += ' '
    }
    s += w.text
  }
  return s
}

// ───────────────────────── Unruled text ─────────────────────────

interface StreamCell { x0: number; x1: number; words: SheetWord[] }
export interface StreamRow {
  kind: 'row'
  top: number; bottom: number; base: number; size: number
  cells: StreamCell[]
  /** Part of a table-like block: its cells were cut by the block's columns. */
  block?: number
  /** The first row of its block (a header, maybe repeated on the next page). */
  blockFirst?: boolean
  /** Column of each cell, once placed on the sheet's columns. */
  cols?: number[]
}
export type LayoutItem = TableItem | StreamRow
interface Block { id: number; seps: number[]; rows: StreamRow[]; weight: number }

function gapOk(a: Row, b: Row): boolean {
  return b.base - a.base <= 2.8 * Math.max(a.size, b.size) + 1
}

function gutterSeps(rows: Row[]): number[] {
  const freq = new Map<number, number>()
  for (const r of rows) freq.set(r.segs.length, (freq.get(r.segs.length) ?? 0) + 1)
  let mode = 2, mf = 0
  for (const [c, f] of freq) if (c >= 2 && (f > mf || (f === mf && c > mode))) { mode = c; mf = f }
  const gaps = (rs: Row[]) => {
    const iv = unionIntervals(rs.flatMap(r => r.segs.map(s => [s.x0, s.x1] as [number, number])))
    const out: number[] = []
    for (let i = 1; i < iv.length; i++) if (iv[i][0] - iv[i - 1][1] >= 1) out.push((iv[i][0] + iv[i - 1][1]) / 2)
    return out
  }
  // Rows with fewer cells than usual are the ones that span or spill over
  // columns; leaving them out keeps their text from closing a gutter.
  const full = rows.filter(r => r.segs.length >= mode)
  let seps = gaps(full)
  if (seps.length + 1 < mode) {
    const alt = gaps(rows.filter(r => r.segs.length === mode))
    if (alt.length > seps.length) seps = alt
  }
  // A heading is often wider than its column ("ITM" over the item numbers
  // overhangs the gap before the codes): read the gutters off the rows under
  // it as well, and keep whichever finds more.
  const top = full.slice().sort((a, b) => a.top - b.top)
  if (top.length >= 3) {
    const alt = gaps(top.slice(1))
    if (alt.length > seps.length) seps = alt
  }
  return seps
}

/**
 * A form writes each value on its own underline, and the underlines line up
 * in columns more reliably than the text does: a long name runs past its
 * field into the next one's, closing the gutter between them, but never moves
 * the line it was written on.
 */
function fieldSeps(rows: Row[], freeH: HSeg[]): { seps: number[]; spans: [number, number][] } {
  const top = rows[0].top - 3, bottom = rows[rows.length - 1].bottom + 8
  const left = Math.min(...rows.flatMap(r => r.segs.map(s => s.x0)))
  const right = Math.max(...rows.flatMap(r => r.segs.map(s => s.x1)))
  const width = Math.max(1, right - left)
  const lines = freeH.filter(h => h.y >= top && h.y <= bottom && h.x1 - h.x0 >= 20 && h.x1 - h.x0 <= width * 0.6 &&
    h.x1 > left - 10 && h.x0 < right + 10)
  const spans = unionIntervals(lines.map(h => [h.x0, h.x1] as [number, number]))
  const seps: number[] = []
  for (let i = 1; i < spans.length; i++) if (spans[i][0] - spans[i - 1][1] >= 2) seps.push((spans[i][0] + spans[i - 1][1]) / 2)
  return { seps: spans.length >= 2 ? seps : [], spans: spans.length >= 2 ? spans : [] }
}

/**
 * Which column a piece of a row belongs to. Text is set from the left and a
 * figure from the right, so a cell is placed by its first or last em: placed
 * by its whole width, a long sentence lands in whichever column it happens
 * to cover most, and a wide amount in the column before its own.
 */
function columnOf(x0: number, x1: number, words: SheetWord[], seps: number[]): number {
  const size = words[0]?.size ?? 10
  const reach = Math.min(x1 - x0, 2 * size)
  const numeric = NUMERIC_LIKE.test(wordsText(words))
  const a = numeric ? x1 - reach : x0, b = numeric ? x1 : x0 + reach
  let best = 0, bo = -Infinity
  for (let k = 0; k <= seps.length; k++) {
    const lo = k ? seps[k - 1] : -Infinity, hi = k < seps.length ? seps[k] : Infinity
    const ov = Math.min(hi, b) - Math.max(lo, a)
    if (ov > bo) { bo = ov; best = k }
  }
  return best
}

function cellsBySeps(row: Row, seps: number[]): StreamCell[] {
  const n = seps.length + 1
  const out: (StreamCell | null)[] = new Array(n).fill(null)
  for (const s of row.segs) {
    const best = columnOf(s.x0, s.x1, s.words, seps)
    const c = out[best]
    if (c) { c.words.push(...s.words); c.x0 = Math.min(c.x0, s.x0); c.x1 = Math.max(c.x1, s.x1) }
    else out[best] = { x0: s.x0, x1: s.x1, words: s.words.slice() }
  }
  return out.filter((c): c is StreamCell => !!c)
}

const asStreamRow = (r: Row, cells: StreamCell[]): StreamRow =>
  ({ kind: 'row', top: r.top, bottom: r.bottom, base: r.base, size: r.size, cells })

let blockIds = 0

function streamItems(words: SheetWord[], freeH: HSeg[]): { rows: StreamRow[]; blocks: Block[] } {
  const rows = buildRows(words)
  const out: StreamRow[] = []
  const blocks: Block[] = []
  const loose = (r: Row) => {
    const cells = r.segs.length ? r.segs.map(s => ({ x0: s.x0, x1: s.x1, words: s.words })) : [{ x0: r.words[0].x0, x1: r.words[0].x1, words: r.words }]
    out.push(asStreamRow(r, cells))
  }
  let i = 0
  while (i < rows.length) {
    const r = rows[i]
    if (r.segs.length < 2) { loose(r); i++; continue }
    // Grow a block over consecutive multi-cell rows, letting one or two
    // single-cell rows (a wrapped cell, a sub-heading) sit inside it.
    const block: Row[] = [r]
    let j = i + 1
    while (j < rows.length) {
      if (!gapOk(block[block.length - 1], rows[j])) break
      if (rows[j].segs.length >= 2) { block.push(rows[j]); j++; continue }
      let k = j
      while (k < rows.length && k - j < 2 && rows[k].segs.length < 2 && gapOk(rows[k - 1], rows[k])) k++
      if (k < rows.length && k > j && rows[k].segs.length >= 2 && gapOk(rows[k - 1], rows[k])) {
        for (let q = j; q <= k; q++) block.push(rows[q])
        j = k + 1
        continue
      }
      break
    }
    i = j
    const multi = block.filter(b => b.segs.length >= 2)
    let seps = multi.length >= 2 ? gutterSeps(block) : []
    const field = fieldSeps(block, freeH)
    if (field.seps.length) {
      const inField = (x: number) => field.spans.some(([a, b]) => x > a + 3 && x < b - 3)
      seps = [...field.seps, ...seps.filter(s => !inField(s) && !field.seps.some(f => Math.abs(f - s) < 10))].sort((a, b) => a - b)
    }
    // A row whose pieces the block's columns would put in one cell does not
    // share its columns (a line of a form that happens to sit under a table
    // row): it is placed on its own, where it gets a column for each piece.
    const fits = (row: Row) => cellsBySeps(row, seps).length === row.segs.length
    if (!seps.length || block.filter(b => b.segs.length >= 2 && fits(b)).length < 2) { for (const b of block) loose(b); continue }
    const id = ++blockIds
    let first = true
    const brows: StreamRow[] = []
    for (const row of block) {
      if (!fits(row)) { loose(row); continue }
      const sr = asStreamRow(row, cellsBySeps(row, seps))
      sr.block = id
      if (first) { sr.blockFirst = true; first = false }
      brows.push(sr)
      out.push(sr)
    }
    blocks.push({ id, seps, rows: brows, weight: brows.filter(r => r.cells.length >= 2).length * (seps.length + 1) })
  }
  return { rows: out, blocks }
}

// ───────────────────────── Page ─────────────────────────

export interface PageLayout {
  page: SheetPageData
  items: LayoutItem[]
  blocks: Block[]
}

export function layoutPage(page: SheetPageData): PageLayout {
  const words = page.words.filter(w => w.text.trim())
  const { tables, boxes, freeH } = findTables(page, words)
  const textSize = median(words.map(w => w.size)) || 10
  for (const b of boxes) {
    // A checkbox reads as a character on the line it sits on.
    const glyph: SheetWord = {
      x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, base: cy(b) + 0.36 * textSize, size: textSize,
      text: b.checked ? '☒' : '☐', bold: false, italic: false, color: 0, font: '', sp: 1, glyph: true
    }
    const t = tables.find(t => cx(b) >= t.left && cx(b) <= t.right && cy(b) >= t.top && cy(b) <= t.bottom)
    if (t) {
      const i = bandOf(t.ys, cy(b)), j = bandOf(t.xs, cx(b))
      const reg = t.regions.find(r => i >= r.r0 && i <= r.r1 && j >= r.c0 && j <= r.c1)
      if (reg) { reg.words.push(glyph); continue }
    }
    words.push(glyph)
  }
  const { rows, blocks } = streamItems(words, freeH)
  const items: LayoutItem[] = [...tables, ...rows]
  items.sort((a, b) => a.top - b.top)
  return { page, items, blocks }
}

// ───────────────────────── Sheet ─────────────────────────

const KNOWN_FONTS = ['Arial', 'Arial Narrow', 'Calibri', 'Cambria', 'Candara', 'Century Gothic', 'Consolas', 'Courier New', 'Garamond',
  'Georgia', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Aptos', 'Book Antiqua', 'Franklin Gothic', 'Lucida Sans', 'Palatino Linotype']

/** The Excel font for a PDF font name: a family Excel knows, or Calibri. */
export function familyFor(name: string): string {
  const base = name.replace(/^[A-Z]{6}\+/, '').replace(/[-,].*$/, '')
  const spaced = base.replace(/(PSMT|MT|PS|Std|Pro)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim()
  const lower = spaced.toLowerCase().replace(/\s+/g, ' ')
  if (lower.startsWith('helvetica') || lower === 'arial mt') return 'Arial'
  if (lower.startsWith('times')) return 'Times New Roman'
  if (lower.startsWith('courier')) return 'Courier New'
  for (const f of KNOWN_FONTS) if (lower === f.toLowerCase() || lower.replace(/ /g, '') === f.toLowerCase().replace(/ /g, '')) return f
  return 'Calibri'
}

/** Excel's column width (characters of the default font) for a width in points. */
export function pointsToChars(pt: number): number {
  const px = pt * 96 / 72
  return px >= 12 ? Math.round(((px - 5) / 7) * 100) / 100 : Math.max(0.08, Math.round((px / 12) * 100) / 100)
}

function luminance(rgb: number): number {
  return (0.2126 * ((rgb >> 16) & 255) + 0.7152 * ((rgb >> 8) & 255) + 0.0722 * (rgb & 255)) / 255
}

function styleOfWords(ws: SheetWord[]): Pick<XCell, 'bold' | 'italic' | 'size' | 'color' | 'font' | 'rotation'> {
  const real = ws.filter(w => !w.glyph)
  const src = real.length ? real : ws
  let chars = 0, bold = 0, italic = 0
  const sizes: number[] = []
  const colors = new Map<number, number>()
  const fonts = new Map<string, number>()
  for (const w of src) {
    const n = w.text.length
    chars += n
    if (w.bold) bold += n
    if (w.italic) italic += n
    sizes.push(w.size)
    colors.set(w.color, (colors.get(w.color) ?? 0) + n)
    if (w.font) fonts.set(w.font, (fonts.get(w.font) ?? 0) + n)
  }
  let color = 0, cn = -1
  for (const [c, n] of colors) if (n > cn) { color = c; cn = n }
  let font = '', fn = -1
  for (const [f, n] of fonts) if (n > fn) { font = f; fn = n }
  const size = Math.max(6, Math.min(48, Math.round(median(sizes) * 2) / 2))
  const vertical = src.length > 0 && src.every(w => w.vertical)
  return {
    bold: bold > chars / 2, italic: italic > chars / 2, size, color: color || undefined, font: familyFor(font),
    rotation: vertical ? 90 : undefined
  }
}

/**
 * A cell's lines joined. A line that ran to the cell's edge mid-sentence was
 * wrapped there and continues with a space; any other line ended on purpose
 * (a list in a form cell, a label over its value) and keeps its break.
 */
function cellText(ws: SheetWord[], left: number, right: number): { text: string; lines: number } {
  const rows = buildRows(ws).sort((a, b) => a.base - b.base)
  let text = ''
  rows.forEach((r, i) => {
    const t = wordsText(r.words)
    if (i) {
      const p = rows[i - 1]
      const pText = wordsText(p.words)
      const real = p.words.filter(w => !w.glyph)
      const last = real[real.length - 1]
      const width = right - left
      // Wrapped text fills the cell; a list of short labels does not.
      const filled = last ? (last.x1 - real[0].x0) / Math.max(1, width) : 0
      const ran = !!last && real.length >= 4 && filled >= 0.6 && last.x1 >= right - Math.max(0.15 * width, 2 * p.size)
      const lower = /^[a-záéíóúñü]/.test(t)
      const continues = (ran && /[\p{L}\p{N},]$/u.test(pText) && /^[\p{L}\p{N}(¿¡"]/u.test(t)) || (lower && !/[.:;!?]$/.test(pText))
      if (continues && /[A-Za-zÀ-ÿ]-$/.test(pText) && lower) text = text.slice(0, -1)
      else text += continues ? ' ' : '\n'
    }
    text += t
  })
  return { text, lines: rows.length }
}

/** Width a text needs, in Excel character units, at a font size. */
function textChars(text: string, size: number): number {
  const longest = Math.max(...text.split('\n').map(l => [...l].length))
  return longest * size * 0.095 + 1.3
}

const NUMERIC_LIKE = /^[\s(]*[-−]?\s*(S\/\.?|US\$|\$|USD|PEN|EUR|€)?\s*[-−]?[\d.,]+\s*[%)-]?\s*$|^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/i

export interface SheetBuildOptions {
  name: string
}

/**
 * The columns of a sheet: sorted x boundaries on the page. Column k runs from
 * b[k] to b[k+1]; the first also takes whatever lies to its left, the last
 * whatever lies to its right.
 */
class Columns {
  b: number[] = []
  get seps(): number[] { return this.b.slice(1) }
  insert(x: number): boolean {
    if (this.b.some(v => Math.abs(v - x) < 1)) return false
    if (this.b.length >= MAX_COLUMNS) return false
    this.b.push(x)
    this.b.sort((a, b) => a - b)
    return true
  }
  /** The column whose span holds x. */
  at(x: number): number {
    let k = 0
    while (k < this.b.length && this.b[k] <= x) k++
    return Math.max(0, k - 1)
  }
  /** The index of the boundary nearest x. */
  index(x: number): number {
    let best = 0, bd = Infinity
    this.b.forEach((v, i) => { const d = Math.abs(v - x); if (d < bd) { bd = d; best = i } })
    return best
  }
}

/** More columns than this is a drawing being read as a table, not a table. */
const MAX_COLUMNS = 200

interface Dominant {
  /** Ruled: x extents of its filled cells — a boundary through one makes it a merged cell. */
  cells: [number, number][]
  /**
   * Unruled: where each column's cells are set from (the left of text, the
   * right of a figure). A boundary in among those points sends some of the
   * column's cells one way and the rest the other — the column torn in two.
   * One to the left of all of them (inside a column of left-set labels)
   * moves none of them, and costs nothing.
   */
  anchors?: number[][]
  left: number
  right: number
}

/**
 * Where a ruled table's borders go on the sheet's columns. Each border may
 * land on an existing boundary, at the cost of the distance it moves, or
 * become a new one, at the cost of every filled cell of the sheet's main table
 * that the new boundary would cut in two (each would become a merged cell).
 * A form's header box over a data table therefore shifts its inner border a
 * few points onto the table's own column rather than splitting the table's
 * description column down its whole length — and a box with nothing under
 * it keeps every border where it was drawn.
 */
function mapTable(t: TableItem, cols: Columns, cuts: (x: number) => number): number[] {
  const B = cols.b
  interface Cand { pos: number; cost: number }
  const cands: Cand[][] = t.xs.map(x => {
    const list: Cand[] = []
    for (const v of B) if (Math.abs(v - x) <= 160) list.push({ pos: v, cost: Math.abs(v - x) })
    list.push({ pos: x, cost: 0.5 + 4 * cuts(x) })
    return list
  })
  let prev = cands[0].map(c => c.cost)
  const back: number[][] = [cands[0].map(() => -1)]
  for (let j = 1; j < cands.length; j++) {
    const cur: number[] = [], from: number[] = []
    for (const c of cands[j]) {
      let best = Infinity, f = -1
      cands[j - 1].forEach((p, k) => {
        if (p.pos < c.pos - 0.5 && prev[k] + c.cost < best) { best = prev[k] + c.cost; f = k }
      })
      cur.push(best); from.push(f)
    }
    prev = cur; back.push(from)
  }
  let k = 0
  prev.forEach((v, i) => { if (v < prev[k]) k = i })
  const pos: number[] = new Array(t.xs.length)
  for (let j = t.xs.length - 1; j >= 0; j--) {
    pos[j] = cands[j][k]?.pos ?? t.xs[j]
    k = back[j][k] ?? -1
    if (k < 0 && j > 0) {
      // No ordered path (cannot happen: inserting every border is one); keep the drawing.
      for (let q = 0; q < j; q++) pos[q] = t.xs[q]
      break
    }
  }
  for (const p of pos) cols.insert(p)
  return pos
}

/**
 * The unruled text placed on the sheet's columns. A loose line is placed by
 * where its pieces start; a block's cells by their first or last em. Two
 * pieces of one line never share a cell: a boundary goes between them, unless
 * it would cut through the main table, in which case the later piece moves on
 * to the next column.
 */
function placeStream(rows: StreamRow[], cols: Columns, dominantBlock: number | undefined, cuts: (x: number) => number, domRows: number) {
  const colOf = (c: StreamCell, inBlock: boolean) => inBlock ? columnOf(c.x0, c.x1, c.words, cols.seps) : cols.at(c.x0 + 2)
  const assign = (r: StreamRow) => r.cells.map(c => colOf(c, r.block !== undefined))
  const maxCuts = Math.max(2, Math.ceil(domRows * 0.15))
  const others = rows.filter(r => r.block === undefined || r.block !== dominantBlock)
  // Blocks first (they carry the most structure), then loose lines.
  others.sort((a, b) => (a.block !== undefined ? 0 : 1) - (b.block !== undefined ? 0 : 1))
  for (const r of others) {
    for (let guard = 0; guard < r.cells.length + 1; guard++) {
      const cs = assign(r)
      let at = -1, overflow = false
      for (let k = 1; k < cs.length; k++) if (cs[k] <= cs[k - 1]) { at = k; break }
      // A line whose next piece's column starts before the text in front of
      // it ends: that text would be cut off at the boundary ("Tipo de gastos
      // autorizados por la|Viaticos"). Give the gap a boundary.
      if (at < 0) {
        for (let k = 1; k < cs.length; k++) {
          const lo = cols.b[cs[k]]
          if (lo !== undefined && lo < r.cells[k - 1].x1 - 1 && r.cells[k].x0 - r.cells[k - 1].x1 >= 2) { at = k; overflow = true; break }
        }
      }
      if (at < 0) break
      const x = (r.cells[at - 1].x1 + r.cells[at].x0) / 2
      if (cuts(x) > (overflow ? 0 : maxCuts) || !cols.insert(x)) break
    }
  }
  for (const r of rows) {
    let cs = assign(r)
    // Two pieces that still share a column (no boundary could go between
    // them: "$" and the amount beside it in a table's total) are one cell.
    for (let k = cs.length - 1; k > 0; k--) {
      if (cs[k] > cs[k - 1]) continue
      const a = r.cells[k - 1], b = r.cells[k]
      a.words.push(...b.words.map((w, i) => i ? w : { ...w, sp: Math.max(1, w.sp ?? 0) }))
      a.x1 = Math.max(a.x1, b.x1)
      r.cells.splice(k, 1)
    }
    cs = increasing(assign(r))
    // Where no boundary could be added, the next piece moves to the next
    // free column, so the text before it can still spill into the gap.
    if (r.block === undefined || r.block !== dominantBlock) {
      for (let k = 1; k < cs.length; k++) {
        for (let n = 0; n < 2; n++) {
          const lo = cols.b[cs[k]]
          if (lo === undefined || lo >= r.cells[k - 1].x1 - 1) break
          if (k + 1 < cs.length && cs[k] + 1 >= cs[k + 1]) break
          cs[k]++
        }
      }
    }
    r.cols = cs
  }
}

interface Unit {
  item: LayoutItem
  top: number
  bottom: number
  c0: number
  c1: number
}

/**
 * One or more pages laid out into one worksheet.
 *
 * Everything on the sheet shares ONE set of columns (`Columns`), seeded by
 * its main table — the ruled table or unruled block with the most filled
 * cells — so the rest of the page lines up with it: the header row printed
 * as text over a ruled table sits over its own columns, a label and its value
 * land where they sit on the paper, and a table running on over several pages
 * keeps its columns. Things side by side on the page (a company's address
 * beside the box with its tax number, two signature boxes) share rows too:
 * they are laid out together in one BAND, whose rows are the union of theirs.
 */
export function buildSheet(layouts: PageLayout[], opts: SheetBuildOptions): XSheet {
  const cells: XCell[] = []
  const rowHeights = new Map<number, number>()
  const fromTable = new Set<XCell>()

  const tables = layouts.flatMap(L => L.items.filter((i): i is TableItem => i.kind === 'table'))
  const streamRows = layouts.flatMap(L => L.items.filter((i): i is StreamRow => i.kind === 'row'))
  const blocks = layouts.flatMap(L => L.blocks)

  // ── Columns ──
  const tableWeight = (t: TableItem) => t.regions.filter(r => r.words.length).length
  const blockWeight = (b: Block) => b.rows.reduce((n, r) => n + r.cells.length, 0)
  const bestTable = tables.slice().sort((a, b) => tableWeight(b) - tableWeight(a))[0]
  const bestBlock = blocks.slice().sort((a, b) => blockWeight(b) - blockWeight(a))[0]
  const cols = new Columns()
  let dom: Dominant | null = null
  let domBlock: number | undefined
  let domRows = 0
  if (bestTable && (!bestBlock || tableWeight(bestTable) >= blockWeight(bestBlock))) {
    for (const x of bestTable.xs) cols.insert(x)
    dom = {
      cells: bestTable.regions.filter(r => r.words.length).map(r => [bestTable.xs[r.c0], bestTable.xs[r.c1 + 1]] as [number, number]),
      left: bestTable.left, right: bestTable.right
    }
    domRows = bestTable.ys.length - 1
  } else if (bestBlock) {
    const all = bestBlock.rows.flatMap(r => r.cells)
    const left = Math.min(...all.map(c => c.x0))
    cols.insert(left)
    for (const s of bestBlock.seps) cols.insert(s)
    const anchors: number[][] = bestBlock.seps.map(() => []).concat([[]])
    for (const c of all) {
      const k = columnOf(c.x0, c.x1, c.words, bestBlock.seps)
      anchors[k].push(NUMERIC_LIKE.test(wordsText(c.words)) ? c.x1 : c.x0)
    }
    dom = { cells: [], anchors, left, right: Math.max(...all.map(c => c.x1)) }
    domBlock = bestBlock.id
    domRows = bestBlock.rows.length
  }
  const cuts = (x: number) => {
    if (!dom) return 0
    if (dom.anchors) {
      let harm = 0
      for (const a of dom.anchors) {
        const l = a.filter(v => v < x - 1).length, r = a.filter(v => v > x + 1).length
        harm += Math.min(l, r)
      }
      return harm
    }
    return dom.cells.reduce((n, [a, b]) => n + (a < x - 1 && b > x + 1 ? 1 : 0), 0)
  }
  const tablePos = new Map<TableItem, number[]>()
  if (bestTable && dom && domBlock === undefined) tablePos.set(bestTable, bestTable.xs.slice())
  for (const t of tables.slice().sort((a, b) => tableWeight(b) - tableWeight(a))) {
    if (tablePos.has(t)) continue
    tablePos.set(t, cols.b.length ? mapTable(t, cols, cuts) : (t.xs.forEach(x => cols.insert(x)), t.xs.slice()))
  }
  placeStream(streamRows, cols, domBlock, cuts, domRows)
  mergeContinuations(streamRows)
  /** Sheet column where each grid column of a table starts — strictly increasing, so no two of its merges can overlap. */
  const tableCols = new Map<TableItem, number[]>()
  for (const [t, pos] of tablePos) tableCols.set(t, increasing(pos.map(p => cols.index(p))))

  // ── Widths: the page's own geometry ──
  const allX1 = [...tables.map(t => t.right), ...streamRows.flatMap(r => r.cells.map(c => c.x1))]
  const allX0 = [...tables.map(t => t.left), ...streamRows.flatMap(r => r.cells.map(c => c.x0))]
  const rightmost = allX1.length ? Math.max(...allX1) : 0
  const leftmost = allX0.length ? Math.min(...allX0) : 0
  const nCols = Math.max(1, cols.b.length)
  const colWidths: number[] = []
  for (let k = 0; k < nCols; k++) {
    const lo = k === 0 ? Math.min(cols.b[0] ?? leftmost, leftmost) : cols.b[k]
    const hi = k + 1 < cols.b.length ? cols.b[k + 1] : Math.max(rightmost, (cols.b[k] ?? 0) + 40)
    colWidths[k] = pointsToChars(Math.max(3, hi - lo))
  }
  const span = (k: number): [number, number] => [
    k === 0 ? Math.min(cols.b[0] ?? leftmost, leftmost) : cols.b[k],
    k + 1 < cols.b.length ? cols.b[k + 1] : Math.max(rightmost, (cols.b[k] ?? 0) + 40)
  ]

  // ── Rows: bands of what sits side by side ──
  let row = 0
  const seenHeaders = new Set<string>()
  layouts.forEach((L, pi) => {
    if (pi && row) row++
    const pageHeaders: string[] = []
    const units: Unit[] = []
    for (const item of L.items) {
      if (item.kind === 'table') {
        const cs = tableCols.get(item)!
        units.push({ item, top: item.top, bottom: item.bottom, c0: cs[0], c1: cs[cs.length - 1] - 1 })
        continue
      }
      if (!item.cells.length || !item.cols) continue
      if (item.blockFirst) {
        // A table continued from the page before repeats its header row.
        const header = item.cells.map(c => wordsText(c.words)).join('\t')
        if (pi && seenHeaders.has(header)) continue
        pageHeaders.push(header)
      }
      const c1 = Math.max(...item.cells.map((c, k) => Math.max(item.cols![k], cols.at(c.x1 - 1))))
      units.push({ item, top: item.top, bottom: item.bottom, c0: item.cols[0], c1 })
    }
    for (const h of pageHeaders) seenHeaders.add(h)
    units.sort((a, b) => a.top - b.top)

    const bands: { top: number; bottom: number; members: Unit[] }[] = []
    for (const u of units) {
      const b = bands[bands.length - 1]
      const clash = b && b.members.some(m => Math.min(m.bottom, u.bottom) - Math.max(m.top, u.top) > 2 && m.c0 <= u.c1 && u.c0 <= m.c1)
      if (b && u.top < b.bottom - 2 && !clash) { b.members.push(u); b.bottom = Math.max(b.bottom, u.bottom) }
      else bands.push({ top: u.top, bottom: u.bottom, members: [u] })
    }

    let prevBottom = -Infinity
    for (const band of bands) {
      const lead = band.members[0].item
      const size = lead.kind === 'row' ? lead.size : 10
      if (row && prevBottom > -Infinity && band.top - prevBottom > Math.max(10, 1.6 * size)) row++
      prevBottom = band.bottom
      const ysRaw: number[] = [band.bottom]
      for (const m of band.members) {
        if (m.item.kind === 'table') ysRaw.push(...m.item.ys)
        else ysRaw.push(m.top)
      }
      const Y = cluster(ysRaw, 2)
      const at = (y: number) => nearestIndex(Y, y, Infinity)
      const tableRows = new Map<TableItem, number[]>()
      let bandRows = Math.max(1, Y.length - 1)
      for (const m of band.members) {
        if (m.item.kind !== 'table') continue
        const rs = increasing(m.item.ys.map(at))
        tableRows.set(m.item, rs)
        bandRows = Math.max(bandRows, rs[rs.length - 1])
      }
      const minH: number[] = new Array(bandRows).fill(0)
      for (const m of band.members) {
        if (m.item.kind === 'table') {
          const t = m.item
          const rs = tableRows.get(t)!, cs = tableCols.get(t)!
          emitTable(t, row, i => [rs[i], rs[i + 1]], j => [cs[j], cs[j + 1]], cells, minH, fromTable)
          continue
        }
        const r = m.item
        const br = Math.min(Math.max(0, bandOf(Y, (r.top + r.bottom) / 2)), minH.length - 1)
        minH[br] = Math.max(minH[br], r.size * 1.25)
        emitStreamRow(r, row + br, L.page.fills, span, cols, cells)
      }
      for (let k = 0; k < minH.length; k++) {
        const geo = k + 1 < Y.length ? Y[k + 1] - Y[k] : 0
        rowHeights.set(row + k, Math.round(Math.max(1, geo, minH[k]) * 100) / 100)
      }
      row += minH.length
    }
  })

  // A number cannot spill into the next cell the way text does: one wider
  // than its column prints as #####. Unruled columns grow to fit it; a ruled
  // table's columns are the form's own, so there it stays text instead.
  for (const c of cells) {
    if (!c.text || c.text.includes('\n') || !NUMERIC_LIKE.test(c.text)) continue
    const need = textChars(c.text, c.size ?? 11)
    let have = 0
    for (let k = 0; k < (c.cols ?? 1); k++) have += colWidths[c.c + k] ?? 8.43
    if (need <= have) continue
    if (fromTable.has(c)) c.keepText = true
    else colWidths[c.c] = Math.max(colWidths[c.c] ?? 0, Math.min(40, need))
  }

  const first = layouts[0]?.page
  const landscape = !!first && first.width > first.height
  const short = first ? Math.min(first.width, first.height) : 595, long = first ? Math.max(first.width, first.height) : 842
  const paper = Math.abs(short - 612) < 8 && Math.abs(long - 792) < 8 ? 1 : Math.abs(short - 612) < 8 && Math.abs(long - 1008) < 8 ? 5 : 9
  return { name: opts.name, cells, colWidths, rowHeights, landscape, paper, gridLines: !tables.length }
}

/** Each value at least one past the one before. */
function increasing(v: number[]): number[] {
  const out = v.slice()
  for (let i = 1; i < out.length; i++) if (out[i] <= out[i - 1]) out[i] = out[i - 1] + 1
  return out
}

function emitStreamRow(r: StreamRow, row: number, fills: SheetFill[], span: (k: number) => [number, number], cols: Columns, cells: XCell[]) {
  // A band of colour behind a line of text (a table's header row printed
  // over a coloured bar) is the cells' fill, across every column it covers.
  const cyR = (r.top + r.bottom) / 2, h = r.bottom - r.top
  const band = fills.filter(f => cyR >= f.y0 && cyR <= f.y1 && f.y1 - f.y0 <= Math.max(4 * h, 30))
  const fillOf = (k: number) => {
    const [a, b] = span(k)
    const mid = (a + b) / 2
    let best: SheetFill | undefined, ba = Infinity
    for (const f of band) if (mid >= f.x0 && mid <= f.x1) { const ar = (f.x1 - f.x0) * (f.y1 - f.y0); if (ar < ba) { ba = ar; best = f } }
    return best?.color
  }
  const used = new Set<number>()
  r.cells.forEach((c, k) => {
    const col = r.cols?.[k] ?? k
    used.add(col)
    const text = wordsText(c.words)
    const st = styleOfWords(c.words)
    const fill = fillOf(col)
    if (fill !== undefined && luminance(fill) < 0.4 && luminance(st.color ?? 0) < 0.4) st.color = 0xFFFFFF
    if (fill === undefined && st.color !== undefined && luminance(st.color) > 0.85) st.color = undefined
    cells.push({ r: row, c: col, text, ...st, fill })
  })
  if (band.length) {
    for (let k = 0; k < Math.max(1, cols.b.length); k++) {
      if (used.has(k)) continue
      const fill = fillOf(k)
      if (fill !== undefined) cells.push({ r: row, c: k, text: '', fill })
    }
  }
}

/**
 * A ruled table written onto the sheet. `rowsOf(i)` and `colsOf(j)` say which
 * sheet rows and columns its grid row i and column j cover — more than one
 * where something beside it, or another table, needed a boundary inside it.
 */
function emitTable(item: TableItem, row: number, rowsOf: (i: number) => [number, number], colsOf: (j: number) => [number, number],
  cells: XCell[], minH: number[], fromTable: Set<XCell>) {
  const nR = item.ys.length - 1, nC = item.xs.length - 1
  const border = (e: Edge): XBorder | undefined => e.visible
    ? { style: e.w > 2.3 ? 'thick' : e.w > 1.3 ? 'medium' : 'thin', color: luminance(e.color) > 0.75 ? 0 : e.color }
    : undefined
  const fillAt = (x: number, y: number) => {
    let best: SheetFill | null = null, ba = Infinity
    for (const f of item.fills) {
      if (x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1) {
        const a = (f.x1 - f.x0) * (f.y1 - f.y0)
        if (a < ba) { ba = a; best = f }
      }
    }
    return best?.color
  }
  const regionAt = new Map<number, Region>()
  for (const reg of item.regions) for (let i = reg.r0; i <= reg.r1; i++) for (let j = reg.c0; j <= reg.c1; j++) regionAt.set(i * nC + j, reg)
  for (let i = 0; i < nR; i++) {
    const [r0, r1] = rowsOf(i)
    for (let j = 0; j < nC; j++) {
      const reg = regionAt.get(i * nC + j)
      if (!reg) continue
      const [c0, c1] = colsOf(j)
      const box = { x0: item.xs[reg.c0], x1: item.xs[reg.c1 + 1], y0: item.ys[reg.r0], y1: item.ys[reg.r1 + 1] }
      const fill = fillAt((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2)
      const anchorCell = reg.r0 === i && reg.c0 === j
      for (let rr = r0; rr < r1; rr++) {
        for (let cc = c0; cc < c1; cc++) {
          const b = {
            top: rr === r0 ? border(item.hEdges[i][j]) : undefined,
            bottom: rr === r1 - 1 ? border(item.hEdges[i + 1][j]) : undefined,
            left: cc === c0 ? border(item.vEdges[i][j]) : undefined,
            right: cc === c1 - 1 ? border(item.vEdges[i][j + 1]) : undefined
          }
          if (!(anchorCell && rr === r0 && cc === c0)) {
            if (b.top || b.bottom || b.left || b.right || fill !== undefined) cells.push({ r: row + rr, c: cc, text: '', border: b, fill })
            continue
          }
          const cell: XCell = { r: row + rr, c: cc, text: '', border: b, fill }
          const spanR = rowsOf(reg.r1)[1] - r0, spanC = colsOf(reg.c1)[1] - c0
          if (spanR > 1) cell.rows = spanR
          if (spanC > 1) cell.cols = spanC
          if (reg.words.length) {
            const { text, lines } = cellText(reg.words, box.x0, box.x1)
            Object.assign(cell, styleOfWords(reg.words))
            cell.text = text
            // Text set dark on a dark fill was written to be read light.
            if (fill !== undefined && luminance(fill) < 0.4 && luminance(cell.color ?? 0) < 0.4) cell.color = 0xFFFFFF
            if (cell.color !== undefined && fill === undefined && luminance(cell.color) > 0.85) cell.color = undefined
            const real = reg.words.filter(w => !w.glyph)
            const src = real.length ? real : reg.words
            const ux0 = Math.min(...src.map(w => w.x0)), ux1 = Math.max(...src.map(w => w.x1))
            const W = box.x1 - box.x0
            const lg = ux0 - box.x0, rg = box.x1 - ux1
            cell.ha = (lg > 0.12 * W && rg > 0.12 * W && Math.abs(lg - rg) < 0.3 * (lg + rg)) ? 'center'
              : (rg < 0.5 * lg && lg > 0.15 * W) ? 'right' : 'left'
            cell.va = 'center'
            if (lines > 1) cell.wrap = true
            if (spanR === 1 && r0 < minH.length) minH[r0] = Math.max(minH[r0], lines * (cell.size ?? 11) * 1.25 + 2)
          }
          cells.push(cell)
          fromTable.add(cell)
        }
      }
    }
  }
}

/**
 * A row holding only the rest of the cell above — a description wrapped onto
 * a second line — goes back into that cell. Only when it plainly continues a
 * sentence: it starts in lowercase, in the same column, close under it.
 */
function mergeContinuations(rows: StreamRow[]) {
  for (let k = rows.length - 1; k > 0; k--) {
    const cur = rows[k], prev = rows[k - 1]
    // Only into a cell of a row with several (a description wrapped under its
    // item); lines of a paragraph stay the lines they were printed as.
    if (cur.cells.length !== 1 || !cur.cols || !prev.cols || prev.cells.length < 2) continue
    const col = cur.cols[0]
    const at = prev.cols.indexOf(col)
    if (at < 0) continue
    const above = prev.cells[at]
    const first = cur.cells[0].words[0]
    if (!/^[a-záéíóúñü]/.test(first.text)) continue
    const aboveText = wordsText(above.words)
    if (/[.:;!?]$/.test(aboveText)) continue
    if (Math.abs(cur.cells[0].x0 - above.x0) > Math.max(4, first.size * 1.5)) continue
    if (cur.base - prev.base > 1.9 * Math.max(cur.size, prev.size) || cur.base < prev.base) continue
    above.words.push(...cur.cells[0].words.map((w, i) => i ? w : { ...w, sp: 1 }))
    cur.cells = []
  }
}
