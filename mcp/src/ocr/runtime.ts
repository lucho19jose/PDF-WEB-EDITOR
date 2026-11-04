/**
 * Scanned pages for the MCP server: recognition (PaddleOCR in Node) and the
 * app's scan edit — kept letters stay the scan's pixels, new ones are the
 * page's own letters or a face fitted to the scan, drawn back as pixel
 * overlays on the scan's own grid with the new words as invisible text.
 *
 * Built as its own bundle (`dist-mcp/ocr/ocr.mjs`) beside a `node_modules`
 * holding ppu-paddle-ocr, onnxruntime-node and @napi-rs/canvas, and loaded
 * the first time a scan tool runs: the server starts as fast as before and
 * a missing OCR install fails one tool, not the server.
 *
 * The sequence mirrors the app's live bake (`EditorLayout.applyOcrLiveNow`):
 * a page keeps its PRISTINE content, and every edit restores it and applies
 * ALL of the page's edits again, each against its original ink — so editing
 * a line twice redraws it from the scan, not from the first edit.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PaddleOcrService } from 'ppu-paddle-ocr'
import { createCanvas } from 'ppu-ocv'
import { setCanvasFactory } from '../../../src/utils/ocr/canvasFactory'
import { recognizeRaster } from '../../../src/utils/ocr/recognizePipeline'
import type { OcrEngine, OcrLine, OcrRecognition } from '../../../src/utils/ocr/ocrEngine'
import type { OcrTextItem } from '../../../src/utils/ocr/ocrTypes'
import { scanRasterOf, isUpright } from '../../../src/utils/ocr/scanRaster'
import { preparePage, analyzeLine, lastLineFailure, pageOfLine, type PageInk, type LineInk } from '../../../src/utils/ocr/lineInk'
import { harvestPage, atlasFrom, type PageHarvest, type Atlas } from '../../../src/utils/ocr/glyphAtlas'
import { planScanEdits, type ScanEditPlan } from '../../../src/utils/ocr/scanEditPage'
import { wantKey, repairReading, repairIsDisplayable, isProseLine, type GlyphImage } from '../../../src/utils/ocr/scanEdit'
import { fitScanLook, synthGlyph, type Rasterize, type ScanLook } from '../../../src/utils/ocr/glyphSynth'
import { snapItemsToTextLayer, dropRunsOnVisibleText } from '../../../src/utils/ocr/snapToLayer'
import type { TextBlock } from '../../../src/engine/types'

/** What this module needs of a document's engine thread. */
export interface EngineLike { send<T = any>(type: string, data?: Record<string, unknown>): Promise<T> }

const OCR_SCALE = 220 / 72
const LANG = 'spa+chi_sim'
/** Sixteen megapixels at most, as in the app: the paper estimate's working memory. */
const MAX_SCAN_PX = 16e6

// ───────── Canvas and engine ─────────

setCanvasFactory((w, h) => createCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h))) as unknown as HTMLCanvasElement)

function modelsDir(): string {
  const env = process.env.PDF_MCP_ASSETS
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.join(env || path.join(here, '..', 'assets'), 'paddle')
}

/** PaddleOCR (PP-OCRv6 small, the app's models) on onnxruntime-node — the app's PaddleEngine, in Node. */
class PaddleNodeEngine implements OcrEngine {
  readonly id = 'paddle' as const
  readonly label = 'PaddleOCR'
  private svc: PaddleOcrService | null = null
  private init: Promise<void> | null = null

  ready(): Promise<void> {
    this.init ??= (async () => {
      const read = (f: string) => { const b = fs.readFileSync(path.join(modelsDir(), f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }
      const svc = new PaddleOcrService({
        model: { detection: read('PP-OCRv6_small_det.ort'), recognition: read('PP-OCRv6_small_rec.ort'), charactersDictionary: read('ppocrv6_dict.txt') },
        processing: { engine: 'canvas-native' },
        recognition: { strategy: 'per-box', minimumConfidence: 0.3 }
      } as any)
      await svc.initialize()
      this.svc = svc
    })().catch(err => { this.init = null; throw err })
    return this.init
  }

  async recognize(canvas: HTMLCanvasElement): Promise<OcrRecognition> {
    await this.ready()
    const result: any = await this.svc!.recognize(canvas as any, { flatten: true } as any)
    // As engines/paddleEngine.ts maps the worker's results.
    const lines: OcrLine[] = []
    for (const r of result.results ?? []) {
      const text = String(r.text ?? '')
      if (!text.trim() || !(r.box?.width > 1) || !(r.box?.height > 1)) continue
      lines.push({ box: { x0: r.box.x, y0: r.box.y, x1: r.box.x + r.box.width, y1: r.box.y + r.box.height }, text, confidence: Math.round(Number(r.confidence ?? 0) * 100) })
    }
    return { lines }
  }

  async destroy(): Promise<void> { await (this.svc as any)?.destroy?.().catch?.(() => {}) }
}

let paddle: PaddleNodeEngine | null = null
function engineInstance(): PaddleNodeEngine { return (paddle ??= new PaddleNodeEngine()) }

// ───────── Per-page state ─────────

const fnv1a = (b: Uint8Array) => { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) } return h >>> 0 }

interface PageContent { bytes: Uint8Array; xobjects: string[]; fonts: string[] }
interface ScanPage { raster: unknown; pi: PageInk; lines: Map<string, LineInk | null>; unread: Map<string, string> }

interface PageState {
  pageIndex: number
  pageWidth: number
  pageHeight: number
  items: OcrTextItem[]
  /** Bumped by every recognition: a scan analysis is valid for one. */
  gen: number
  /** The page as recognised, before any scan edit: every apply starts from it. */
  pristine: PageContent | null
  /** The content hash after the last apply (after save and reload). */
  hash: number | null
}

/** What undo and redo carry besides the bytes: the runs and what the bytes already show. */
export interface ScanSnapshot { pages: [number, PageState][] }

export interface RunInfo { ref: string; text: string; confidence: number; box: [number, number, number, number]; edited: boolean; editable: string | null }

export interface ApplyOutcome { ref: string; text: string; drawn: boolean; how: string }

export const refOf = (page: number, id: string) => `p${page + 1}r${id.split(':').pop()}`

/** Scan state of one open document. */
export class ScanDoc {
  private pages = new Map<number, PageState>()
  /** Scan analyses, at most two pages' pixels (~30 MB each), keyed by recognition generation. */
  private scans = new Map<number, { gen: number; sp: ScanPage | null }>()
  /** Each analysed page's letters for the glyph atlas (eight pages kept, as the app does). */
  private harvests = new Map<number, { gen: number; h: PageHarvest }>()
  private atlasCache: { key: string; atlas: Atlas } | null = null
  private looks = new Map<string, ScanLook | null>()
  private synthCache = new Map<string, GlyphImage>()

  constructor(private readonly eng: () => Promise<EngineLike>) {}

  has(page: number): boolean { return this.pages.has(page) }

  /** Forget a page (or all): a page operation moved or reshaped it. */
  forget(page?: number) {
    if (page === undefined) { this.pages.clear(); this.scans.clear(); this.harvests.clear() }
    else { this.pages.delete(page); this.scans.delete(page); this.harvests.delete(page) }
    this.atlasCache = null
  }

  capture(): ScanSnapshot {
    return { pages: [...this.pages].map(([k, p]) => [k, { ...p, items: p.items.map(i => structuredClone(i)) }]) }
  }

  restore(snap: ScanSnapshot) {
    this.pages = new Map(snap.pages.map(([k, p]) => [k, { ...p, items: p.items.map(i => structuredClone(i)) }]))
  }

  runs(page: number): RunInfo[] {
    const st = this.pages.get(page)
    if (!st) return []
    return st.items.filter(i => !i.removed).map(i => ({
      ref: refOf(page, i.id), text: i.text, confidence: i.confidence,
      box: [r1(i.inkRect.x), r1(i.inkRect.y), r1(i.inkRect.x + i.inkRect.width), r1(i.inkRect.y + i.inkRect.height)],
      edited: i.edited || i.removed,
      editable: i.vertical ? 'set sideways' : i.baked ? 'changed by another tool since recognition' : null
    }))
  }

  item(page: number, ref: string): OcrTextItem | undefined {
    return this.pages.get(page)?.items.find(i => refOf(page, i.id) === ref)
  }

  // ───────── Recognition ─────────

  async recognize(page: number, onStage?: (s: string) => void): Promise<{ runs: number; repaired: number; ms: number; scan: string | null }> {
    const t0 = Date.now()
    const e = await this.eng()
    const size = await e.send<{ width: number; height: number }>('getPageSize', { pageIndex: page })
    const px = await e.send<{ width: number; height: number; rgba: ArrayBuffer } | null>('renderPixmap', { pageIndex: page, scale: OCR_SCALE })
    if (!px?.width) throw new Error('the page could not be rendered for recognition')
    const canvas = createCanvas(px.width, px.height)
    const ctx = canvas.getContext('2d')
    const img = ctx.createImageData(px.width, px.height)
    img.data.set(new Uint8ClampedArray(px.rgba))
    ctx.putImageData(img, 0, 0)
    // The size in points, from the render when the engine's disagrees about the shape (as the app does).
    let pageWidth = size.width, pageHeight = size.height
    if (Math.abs(px.width / px.height - pageWidth / pageHeight) > 0.005) { pageWidth = px.width / OCR_SCALE; pageHeight = px.height / OCR_SCALE }
    const r = await recognizeRaster({
      canvas: canvas as unknown as HTMLCanvasElement, pageIndex: page, pageWidth, pageHeight,
      engine: engineInstance(), lang: LANG, readVertical: false, hooks: { onStage }
    })
    const tRead = Date.now()
    let items = r.items
    if (items.length) {
      const { blocks } = await e.send<{ blocks: TextBlock[] }>('getPageText', { pageIndex: page }).catch(() => ({ blocks: [] as TextBlock[] }))
      items = snapItemsToTextLayer(items, blocks).items
      items = dropRunsOnVisibleText(items, blocks).items
    }
    const prev = this.pages.get(page)
    const st: PageState = { pageIndex: page, pageWidth, pageHeight, items, gen: (prev?.gen ?? 0) + 1, pristine: prev?.pristine ?? null, hash: prev?.hash ?? null }
    this.pages.set(page, st)
    this.atlasCache = null
    // The page's letters, and its runs re-read from them, as the app does in
    // the background (`repairReadings`): Claude sees the page's own reading.
    onStage?.('Reading the page from its own letters...')
    const sp = await this.scanPage(page)
    const tScan = Date.now()
    let repaired = 0
    const atlas = this.atlas()
    if (sp && atlas) {
      for (const [id, li] of [...sp.lines]) {
        if (!li || li.reread) continue
        const it = st.items.find(i => i.id === id)
        if (!it || it.edited || it.removed || it.baked || it.vertical || it.text !== it.originalText || it.originalText !== li.text || !isProseLine(li)) continue
        const rep = repairReading(pageOfLine(sp.pi, li), li, atlas)
        if (!rep || rep.text === it.text || !repairIsDisplayable(li, rep.text)) continue
        it.text = it.originalText = rep.text
        it.reread = true
        sp.lines.set(id, rep.li)
        repaired++
      }
    }
    console.error(`[pdf-editor-mcp] page ${page + 1} recognised: read ${tRead - t0} ms, scan analysis ${tScan - tRead} ms, re-read ${Date.now() - tScan} ms, ${items.length} runs`)
    return { runs: items.length, repaired, ms: Date.now() - t0, scan: sp ? null : 'the page has no scan image the edit can work on' }
  }

  /** The page's scan analysed (raster, paper, lines) — `useOCR.scanPageFor`. */
  private async scanPage(page: number): Promise<ScanPage | null> {
    const st = this.pages.get(page)
    if (!st) return null
    const have = this.scans.get(page)
    if (have && have.gen === st.gen) return have.sp
    const e = await this.eng()
    let img = await e.send<any>('getScanImage', { pageIndex: page }).catch(() => null)
    if (!(img && Math.abs(img.ctm[1]) < 1e-6 && Math.abs(img.ctm[2]) < 1e-6 && img.ctm[0] > 0 && img.ctm[3] > 0)) {
      // Not one upright scan image (an office scanner's layered PDF, a /Rotate
      // page, tiles): the page's content rendered, as the layout's scan loader does.
      const scale = Math.min(300 / 72, Math.sqrt(16e6 / (st.pageWidth * st.pageHeight)))
      const r = await e.send<any>('renderPixmap', { pageIndex: page, scale, contentOnly: true }).catch(() => null)
      img = r?.width ? { width: r.width, height: r.height, rgba: r.rgba, ctm: [r.width / scale, 0, 0, r.height / scale, 0, 0], pageWidth: r.width / scale, pageHeight: r.height / scale, name: '' } : null
    }
    let sp: ScanPage | null = null
    if (img && img.width * img.height <= MAX_SCAN_PX && Math.abs(img.pageWidth - st.pageWidth) < 1 && Math.abs(img.pageHeight - st.pageHeight) < 1) {
      const raster = scanRasterOf(img.width, img.height, new Uint8ClampedArray(img.rgba), img.ctm, img.pageWidth, img.pageHeight, img.name)
      if (raster && isUpright(raster)) {
        const pi = preparePage(raster)
        const lines = new Map<string, LineInk | null>()
        const unread = new Map<string, string>()
        for (const it of st.items) {
          if (it.vertical || it.baked) continue
          const li = analyzeLine(pi, { id: it.id, text: it.originalText, inkRect: it.inkRect, confidence: it.confidence, tilt: it.tilt })
          if (li && it.reread) li.reread = true
          lines.set(it.id, li)
          if (!li) unread.set(it.id, lastLineFailure())
        }
        sp = { raster, pi, lines, unread }
        this.harvests.delete(page)
        this.harvests.set(page, { gen: st.gen, h: harvestPage(pi, [...lines.values()].filter((l): l is LineInk => !!l), page) })
        while (this.harvests.size > 8) this.harvests.delete(this.harvests.keys().next().value!)
        this.atlasCache = null
      }
    }
    this.scans.delete(page)
    this.scans.set(page, { gen: st.gen, sp })
    while (this.scans.size > 2) this.scans.delete(this.scans.keys().next().value!)
    return sp
  }

  private atlas(): Atlas | null {
    const list = [...this.harvests.entries()].filter(([p, e]) => e.gen === this.pages.get(p)?.gen).sort((a, b) => a[0] - b[0])
    if (!list.length) return null
    const key = list.map(([p, e]) => `${p}:${e.gen}`).join(',')
    if (this.atlasCache?.key === key) return this.atlasCache.atlas
    const atlas = atlasFrom(list.map(([, e]) => e.h))
    this.atlasCache = { key, atlas }
    this.looks.clear()
    this.synthCache.clear()
    return atlas
  }

  // ───────── Editing ─────────

  /**
   * Set runs' new text ('' removes a run) and draw every edit of the page on
   * its scan. Runs the scan edit cannot draw are put back as they were and
   * reported. Call inside the session's mutation; `recordHash` after it.
   */
  async edit(page: number, changes: { ref: string; text: string }[]): Promise<{ ok: boolean; outcomes: ApplyOutcome[] }> {
    const st = this.pages.get(page)
    if (!st) throw new Error(`page ${page + 1} has not been recognised`)
    const before = new Map<string, OcrTextItem>()
    for (const c of changes) {
      const it = this.item(page, c.ref)
      if (!it) throw new Error(`Unknown run ${c.ref} on page ${page + 1}. Call recognize_page and use its references.`)
      before.set(it.id, structuredClone(it))
      const text = c.text.replace(/\s+/g, ' ').trim()
      it.text = text || it.originalText
      it.removed = !text
      it.edited = !!text && text !== it.originalText
    }
    const e = await this.eng()
    // Something else wrote to the page since the last apply (a header, an
    // annotation flattened, another tool): its applied runs become part of
    // the page and the page as it is becomes the new pristine (`adoptLivePage`).
    const cur = await e.send<PageContent>('getPageContent', { pageIndex: page })
    if (st.pristine && st.hash !== null && fnv1a(cur.bytes) !== st.hash) {
      for (const it of st.items) {
        if (before.has(it.id)) continue
        if (it.applied && (it.edited || it.removed)) Object.assign(it, { baked: true, edited: false, removed: false, originalText: it.text })
      }
      st.pristine = null
    }
    if (!st.pristine) st.pristine = cur
    else await e.send('setPageContent', { pageIndex: page, bytes: st.pristine.bytes.slice(0), keep: { xobjects: st.pristine.xobjects, fonts: st.pristine.fonts } })

    const plan = await this.plan(page)
    const outcomes: ApplyOutcome[] = []
    for (const c of changes) {
      const it = this.item(page, c.ref)!
      const mode = plan?.modes[it.id] ?? 'no scan to edit on this page'
      const drawn = !!plan?.handled.has(it.id)
      outcomes.push({ ref: c.ref, text: it.removed ? '' : it.text, drawn, how: drawn ? mode : mode.replace(/^vector \((.*)\)$/, '$1') })
      if (!drawn) Object.assign(it, before.get(it.id)!)
    }
    if (!plan || !plan.handled.size) {
      // Nothing to draw: the page goes back to what the bytes already hold.
      return { ok: false, outcomes }
    }
    await this.draw(page, plan)
    for (const it of st.items) if ((it.edited || it.removed) && plan.handled.has(it.id)) it.applied = true
    return { ok: true, outcomes }
  }

  /** After the session saved and reloaded: what the page's content now is. */
  async recordHash(page: number) {
    const st = this.pages.get(page)
    if (!st) return
    const e = await this.eng()
    const after = await e.send<PageContent>('getPageContent', { pageIndex: page })
    st.hash = fnv1a(after.bytes)
  }

  /** `useOCR.planScanEditsFor`: plan, and plan again with letters made in the line's look. */
  private async plan(page: number): Promise<ScanEditPlan | null> {
    const st = this.pages.get(page)!
    const sp = await this.scanPage(page)
    if (!sp) return null
    let atlas = this.atlas()
    if (!atlas) return null
    const items = st.items
    let plan = planScanEdits(sp.pi, sp.lines, atlas, items, undefined, sp.unread)
    if (plan.wanting.length) {
      const e = await this.eng()
      const rasterize: Rasterize = async (file, chars, emPx) => {
        const out = await e.send<any[]>('rasterGlyphs', { fontFile: file, chars, emPx })
        return out.map(g => g ? { ...g, cov: new Float32Array(g.cov) } : null)
      }
      const synth = new Map<string, GlyphImage>()
      const refused = new Map<string, string>()
      for (const w of plan.wanting) {
        const lk = w.line ? `${page}|${w.line}` : ''
        let look = this.looks.get(lk)
        if (look === undefined) {
          look = await fitScanLook(atlas, rasterize, { near: w.line ? { line: w.line, page, emPx: w.emPx } : undefined }).catch(() => null)
          this.looks.set(lk, look)
        }
        // Only a face that prints like this line (the app's gate).
        if (!look || look.score < 0.75) {
          if (w.line) refused.set(w.line, look ? `no face prints like this line (best ${look.family} at ${look.score.toFixed(2)})` : 'no face could be fitted to this line')
          continue
        }
        const key = `${w.line ?? ''}|${look.family}|${look.regularAs ?? ''}|${wantKey(w)}|${w.ink.map(v => v >> 3).join(',')}|${(w.stem ?? 0).toFixed(3)}`
        let g = this.synthCache.get(key)
        if (!g) {
          g = await synthGlyph(look, rasterize, atlas, w).catch(() => null) ?? undefined
          if (g) this.synthCache.set(key, g)
        }
        if (g) synth.set(w.line ? `${w.line}|${wantKey(w)}` : wantKey(w), g)
      }
      if (synth.size) plan = planScanEdits(sp.pi, sp.lines, atlas, items, synth, sp.unread)
      for (const [id, m] of Object.entries(plan.modes)) {
        const why = refused.get(id)
        if (why && m.includes('no letter on the page')) plan.modes[id] = m.replace(/\)$/, `; ${why})`)
      }
    }
    return plan
  }

  /** The bake's scan part (`EditorLayout.bakeOcrEdits`): old words blanked, pixels drawn, new words as invisible text. */
  private async draw(page: number, plan: ScanEditPlan) {
    const st = this.pages.get(page)!
    const e = await this.eng()
    const inkOf = (i: OcrTextItem) => [i.inkRect.x, i.inkRect.y, i.inkRect.x + i.inkRect.width, i.inkRect.y + i.inkRect.height] as [number, number, number, number]
    const touched = st.items.filter(i => (i.edited || i.removed) && plan.handled.has(i.id))
    const fresh = touched.filter(i => !i.baked).map(inkOf)
    if (fresh.length) await e.send('blankInvisibleText', { pageIndex: page, rects: fresh, all: false }).catch(() => 0)
    const baked = touched.filter(i => i.baked).map(inkOf)
    if (baked.length) await e.send('blankInvisibleText', { pageIndex: page, rects: baked, all: true }).catch(() => 0)
    const handled = plan.overlays.filter(o => plan.handled.has(o.item))
    if (handled.length) {
      const r = await e.send<{ success: boolean; error?: string }>('drawPixelOverlays', {
        pageIndex: page,
        overlays: handled.map(o => ({ rect: o.rect, width: o.width, height: o.height, rgb: o.rgb.buffer.slice(o.rgb.byteOffset, o.rgb.byteOffset + o.rgb.byteLength), alpha: o.alpha.buffer.slice(o.alpha.byteOffset, o.alpha.byteOffset + o.alpha.byteLength) }))
      })
      if (r && r.success === false) throw new Error(r.error || 'the edit could not be drawn on the scan')
    }
    const byItem = new Map<string, typeof plan.texts>()
    for (const t of plan.texts) {
      if (!t.group || !plan.handled.has(t.group)) continue
      const list = byItem.get(t.group) ?? []
      list.push(t)
      byItem.set(t.group, list)
    }
    for (const run of byItem.values()) {
      await e.send('addTextRun', {
        pageIndex: page,
        parts: run.map(o => ({ x: o.x, y: st.pageHeight - o.y, text: o.text, fontSize: o.fontSize, fontName: o.fontName, color: o.color, invisible: true, fitWidth: o.fitWidth })),
        rotation: run[0].rotation ?? 0
      })
    }
  }
}

function r1(v: number) { return Math.round(v * 10) / 10 }

/** Load the recogniser now (tests, warm-up). */
export async function warmUp(): Promise<void> { await engineInstance().ready() }
