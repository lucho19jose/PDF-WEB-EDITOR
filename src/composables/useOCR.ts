import { ref } from 'vue'
import type { OcrPageResult, OcrTextItem, OcrAlign, ScannedVerdict } from '@/utils/ocr/ocrTypes'
import { sampleLineColors, samplePatchColor } from '@/utils/ocr/ocrSampling'
import { judgeScanned as judgeScannedPure } from '@/utils/pageKind'
import { detectFace, advancesAreUniform, isLightOnDark } from '@/utils/ocr/ocrFontDetect'
import type { OcrEngine, OcrEngineId, OcrLine, OcrRecognition, OcrWord, OcrBox } from '@/utils/ocr/ocrEngine'
import { ENGINE_LABELS } from '@/utils/ocr/ocrEngine'
import { TesseractEngine } from '@/utils/ocr/engines/tesseractEngine'
import { PaddleEngine } from '@/utils/ocr/engines/paddleEngine'
import { MistralEngine } from '@/utils/ocr/engines/mistralEngine'
import { inkBounds, inkGaps, inkBands, extendDescenders, extendAscenders, extendForTilt, walkNote, type InkCut } from '@/utils/ocr/inkMeasure'
import { scanFaceFor, scanFacesOf, styleKeyOf, traceRunIntoFace, clearScanFaces, type ScanFace, type TraceResult } from '@/utils/ocr/scanFace'
import { cutGlyphs, lastCutReason, lastCutDebug, expectedAdvance, type GlyphCutResult } from '@/utils/ocr/glyphCut'
import { toSpanCut, toSpanCutFromWords, stretchOf, sizeOf, type SpanCut } from '@/utils/ocr/partialRedraw'
import { segmentLine, baselineAtOf, type LineWords } from '@/utils/ocr/wordSeg'
import { scanRasterOf, isUpright, type ScanRaster } from '@/utils/ocr/scanRaster'
import { preparePage, analyzeLine, lastLineFailure, pageOfLine, type PageInk, type LineInk } from '@/utils/ocr/lineInk'
import { harvestPage, atlasFrom, type PageHarvest, type Atlas } from '@/utils/ocr/glyphAtlas'
import { planScanEdits, inkAwareFallback, type ScanEditPlan, type FallbackOps, type PixelOverlay } from '@/utils/ocr/scanEditPage'
import { wantKey, repairReading, repairIsDisplayable, isProseLine, type GlyphImage } from '@/utils/ocr/scanEdit'
import { fitScanLook, synthGlyph, type Rasterize, type ScanLook, type LookNear } from '@/utils/ocr/glyphSynth'
import { watermarkLevel, whitenFrom, linesMissed } from '@/utils/ocr/ocrWatermark'
import { estimateSkew, levelCanvas, unlevelRecognition } from '@/utils/ocr/deskew'
import { useOcrStore } from '@/stores/ocr'
import { withoutFaintLayer, whitenAbove } from '@/utils/ocr/faintLayer'

/** A line cut word by word — see `wordSpanFor`. Rects are each word's cut box, raster pixels. */
interface WordSpan {
  raster: { ctx: CanvasRenderingContext2D; toPt: number }
  lw: LineWords
  cuts: (GlyphCutResult | null)[]
  rects: { x: number; y: number; width: number; height: number }[]
  span: SpanCut
}

/**
 * Recognising the text in a scanned page.
 *
 * A scanned PDF is a picture of a document: there is no text to edit, only ink.
 * This turns that ink into an editable model WITHOUT touching the page itself —
 * the scan stays exactly as it is and becomes the background. Nothing here
 * writes to the document; that only happens when the user actually edits
 * something, and then only over the area they changed.
 *
 * Tesseract runs in its own worker, so a page of OCR does not freeze the editor.
 */

/** Rasterisation used for OCR (220 DPI) and PDF user space (72 to the inch) — see recognizePipeline.ts. */
import { OCR_DPI, PDF_DPI, recognizeRaster } from '@/utils/ocr/recognizePipeline'
export { boxPerEm } from '@/utils/ocr/recognizePipeline'

type Box = OcrBox

/** The languages recognised by default: the document's Spanish and its Chinese labels. */
export const OCR_DEFAULT_LANG = 'spa+chi_sim'

/**
 * ONE recogniser for the whole app.
 *
 * `useOCR()` used to build fresh state per caller, so the toolbar's spinner
 * watched a `busy` that the layout's runner never set — the button sat idle
 * through every recognition. Everything shares this instance now.
 */
let instance: ReturnType<typeof createOCR> | null = null
export function useOCR() {
  if (!instance) instance = createOCR()
  return instance
}

function createOCR() {
  const busy = ref(false)
  const progress = ref(0)
  const stage = ref('')
  const error = ref<string | null>(null)

  /** One instance per engine, made on first use and kept warm. */
  const engines = new Map<OcrEngineId, OcrEngine>()
  function engineFor(id: OcrEngineId): OcrEngine {
    let e = engines.get(id)
    if (!e) {
      e = id === 'paddle' ? new PaddleEngine()
        : id === 'mistral' ? new MistralEngine()
        : new TesseractEngine()
      engines.set(id, e)
    }
    return e
  }
  const onProgress = (s: string, pct: number) => { stage.value = s; progress.value = pct }

  /**
   * The 220 DPI raster each page was recognised on, kept for the scan face:
   * tracing a glyph needs the very pixels the boxes were measured on. Two
   * pages at most (~19 MB each) — the current one and the last.
   */
  const rasters = new Map<number, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; toPt: number }>()
  /**
   * Bumped when a page is RECOGNISED, never when its raster is merely rendered
   * again. A cut made against one recognition must not be adopted for the next
   * (the runs it describes are gone); a raster evicted and re-rendered from the
   * same scan describes the same runs to the pixel.
   */
  const rasterGen = new Map<number, number>()
  const genOf = (pageIndex: number) => rasterGen.get(pageIndex) ?? 0
  function keepRaster(pageIndex: number, entry: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; toPt: number }, recognised = false) {
    rasters.delete(pageIndex)
    rasters.set(pageIndex, entry)
    if (recognised) {
      rasterGen.set(pageIndex, genOf(pageIndex) + 1)
      traceRasters.delete(pageIndex)
    }
    while (rasters.size > 2) rasters.delete(rasters.keys().next().value!)
  }
  /**
   * The page's OCR raster — rendered again from its PRISTINE scan when the
   * two-page cache has let it go.
   *
   * Recognising a whole document ("Reconocer texto en este archivo", or three
   * pages in a row) left only the last two pages' rasters, and an edit on any
   * earlier page then found none: `traceItemNow` returned before cutting a
   * glyph, no partial redraw was possible, and every edit on page 1 of a
   * three-page contract was redrawn whole in Helvetica. The render is the
   * same MuPDF rasterisation recognition used, at the same size, so the cut
   * sees the pixels the boxes were measured on.
   */
  async function rasterFor(pageIndex: number) {
    const have = rasters.get(pageIndex)
    if (have) return have
    const page = useOcrStore().pages.get(pageIndex)
    if (!pageRenderer || !page) return null
    const scale = OCR_DPI / PDF_DPI
    const canvas = await pageRenderer(pageIndex, scale).catch(() => null)
    if (!canvas) return null
    const again = rasters.get(pageIndex)
    if (again) return again
    // The size rule `recognizePage` follows, so the two rasters agree.
    const target = document.createElement('canvas')
    target.width = Math.round(page.pageWidth * scale)
    target.height = Math.round(page.pageHeight * scale)
    if (Math.abs(canvas.width - target.width) <= 2 && Math.abs(canvas.height - target.height) <= 2) {
      target.width = canvas.width
      target.height = canvas.height
    }
    const tctx = target.getContext('2d', { willReadFrequently: true })
    if (!tctx) return null
    tctx.drawImage(canvas, 0, 0, target.width, target.height)
    const entry = { canvas: target, ctx: tctx, toPt: page.pageWidth / target.width }
    keepRaster(pageIndex, entry)
    return entry
  }
  /** Bumped whenever a page's scan face gains glyphs; the layer's styles watch it. */
  const faceVersion = ref(0)

  /**
   * Trace an edited run's ORIGINAL glyphs into its page's scan face.
   *
   * Runs when the user commits an edit, on the run's ink box and original
   * text — what the scan shows, not what was typed. Quiet on every failure:
   * a run that cannot be cut simply contributes no glyphs and the export
   * falls back to the base font for them.
   */
  /**
   * Every trace still running. `commitEdit` fires `traceItem` and forgets it,
   * and a save that landed a second later consulted the faces before the trace
   * had added a glyph — the run baked in Helvetica although its own letterforms
   * were a moment away. `bakeOcrEdits` awaits `settleTraces()` first.
   */
  const pendingTraces = new Set<Promise<unknown>>()

  /**
   * Where each letter of a run's ORIGINAL text sits on the page, from the glyph
   * cut made when the edit was committed — what the partial redraw keeps and
   * what it replaces. Keyed by item id (stable until the page is recognised
   * again), in points, so it outlives the raster LRU. Not reactive: nothing on
   * screen depends on it.
   */
  const spanCuts = new Map<string, SpanCut>()
  function spanCutFor(item: OcrTextItem): SpanCut | null { return spanCuts.get(item.id) ?? null }
  function forgetSpanCut(id: string) { spanCuts.delete(id) }

  /**
   * A second raster, at twice the OCR resolution, for TRACING only.
   *
   * Recognition is happy at 220 DPI; an outline tracer is not — a bold face's
   * crossbar is a one-pixel bump there and Potrace smooths it away ("Cta. Cte"
   * traced as "Cla. Cle"). The page is rendered again at 440 DPI the first time
   * a run on it is traced, through a renderer the layout lends us (this
   * composable has no viewer of its own), and kept for one page: at Letter
   * size it is ~72 MB of pixels. Everything downstream is scale-relative (the
   * em from the letters, `scale = UPM / emPx`), so the cut and the face need
   * no other change. Capped so no side exceeds what a canvas may be.
   */
  const TRACE_DPI = 440
  const MAX_CANVAS_SIDE = 16000
  let pageRenderer: ((pageIndex: number, scale: number) => Promise<HTMLCanvasElement | null>) | null = null
  function setPageRenderer(fn: typeof pageRenderer) { pageRenderer = fn }
  const traceRasters = new Map<number, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; toPt: number }>()
  /**
   * The luminance a page's faint layer (a watermark) was painted out from when
   * it was recognised — see faintLayer.ts. The tracing raster is cleaned the
   * same way, or the glyph cut would measure the watermark crossing a letter.
   */
  const faintCutoffs = new Map<number, number>()
  async function traceRasterFor(pageIndex: number, base: { canvas: HTMLCanvasElement; toPt: number }) {
    const have = traceRasters.get(pageIndex)
    if (have) return have
    if (!pageRenderer) return null
    const pageWidth = base.canvas.width * base.toPt, pageHeight = base.canvas.height * base.toPt
    const scale = Math.min(TRACE_DPI / PDF_DPI, MAX_CANVAS_SIDE / Math.max(pageWidth, pageHeight))
    if (scale <= (OCR_DPI / PDF_DPI) * 1.2) return null
    try {
      const canvas = await pageRenderer(pageIndex, scale)
      const ctx = canvas?.getContext('2d', { willReadFrequently: true })
      if (!canvas || !ctx) return null
      const cutoff = faintCutoffs.get(pageIndex)
      if (cutoff !== undefined) whitenAbove(ctx, cutoff)
      const entry = { canvas, ctx, toPt: pageWidth / canvas.width }
      traceRasters.clear()
      traceRasters.set(pageIndex, entry)
      return entry
    } catch (_) { return null }
  }
  function forgetTraceRaster(pageIndex: number) { traceRasters.delete(pageIndex) }
  function faintCutoffFor(pageIndex: number): number | undefined { return faintCutoffs.get(pageIndex) }
  async function settleTraces(): Promise<void> {
    while (pendingTraces.size) await Promise.allSettled([...pendingTraces])
  }
  /**
   * `measureOnly`: cut the run and adopt its letters' size, trace nothing.
   * For an editor that has just OPENED: nothing is agreed yet, and tracing
   * then took the engine's whole reading into the face - the stretch the user
   * was about to correct included (measured on the OCR corpus: an "i" traced
   * as a "t" before the user retyped the run).
   */
  function traceItem(item: OcrTextItem, opts: { measureOnly?: boolean } = {}): Promise<TraceResult> {
    const p = traceItemNow(item, opts)
    pendingTraces.add(p)
    p.finally(() => pendingTraces.delete(p)).catch(() => {})
    return p
  }

  async function traceItemNow(item: OcrTextItem, opts: { measureOnly?: boolean } = {}): Promise<TraceResult> {
    if (item.vertical) return { added: 0, refused: null }
    const gen = genOf(item.pageIndex)
    const base = await rasterFor(item.pageIndex)
    if (!base || genOf(item.pageIndex) !== gen) return { added: 0, refused: null }
    // Trace from the 2x raster when the layout can render one; the OCR raster
    // stands in where it cannot - and where the finer raster's cut REFUSES: the
    // cut's pixel floors were calibrated at 220 DPI, and a 35pt line that cuts
    // 21/3 there came back 21/5 at 440 and was refused, which would have cost
    // it the partial redraw as well as the trace. Every conversion below goes
    // through `toPt`.
    const hi = await traceRasterFor(item.pageIndex, base)
    // Rendering yields while the user can type, restyle, or replace the page.
    // Continue with the current run so a late measurement cannot overwrite
    // their font size, and a committed trace learns the latest confirmed text.
    if (genOf(item.pageIndex) !== gen) return { added: 0, refused: null }
    const current = useOcrStore().itemsFor(item.pageIndex).find(i => i.id === item.id)
    if (!current || current.originalText !== item.originalText || current.baked) return { added: 0, refused: null }
    item = current
    let raster = hi ?? base
    if (hi) {
      const kHi = 1 / hi.toPt
      const rectHi = { x: item.inkRect.x * kHi, y: item.inkRect.y * kHi, width: item.inkRect.width * kHi, height: item.inkRect.height * kHi }
      const perGlyphHi = !!item.symbols && item.symbols.length === [...item.originalText].filter(c => c !== ' ').length
      const symbolsHi = perGlyphHi ? item.symbols!.map(s => ({ x0: s.x * kHi, y0: s.y * kHi, x1: (s.x + s.width) * kHi, y1: (s.y + s.height) * kHi })) : undefined
      if (!cutGlyphs(hi.ctx, rectHi, item.originalText, symbolsHi)) raster = base
    }
    const k = 1 / raster.toPt
    const rect = { x: item.inkRect.x * k, y: item.inkRect.y * k, width: item.inkRect.width * k, height: item.inkRect.height * k }
    const symbols = item.symbols?.map(s => ({ x0: s.x * k, y0: s.y * k, x1: (s.x + s.width) * k, y1: (s.y + s.height) * k }))
    // A run a bake has already drawn: the raster under it is a patch and new
    // text, not its original ink, so neither a cut nor a trace can be made.
    if (item.baked) return { added: 0, refused: null }
    let face = scanFaceFor(item.pageIndex, styleKeyOf(item))
    const rememberCut = (cut: GlyphCutResult, source: SpanCut['source']): boolean =>
      rememberSpan(toSpanCut(cut, raster.toPt, item.originalText, source))
    const rememberSpan = (span: SpanCut): boolean => {
      // The fallback recogniser also yields. Recheck the user style before
      // adopting its measurement and picking the face keyed by that size.
      const latest = useOcrStore().itemsFor(item.pageIndex).find(i => i.id === item.id)
      if (genOf(item.pageIndex) !== gen || !latest || latest.baked || latest.originalText !== item.originalText) return false
      item = latest
      const hadSpan = spanCuts.has(item.id)
      spanCuts.set(item.id, span)
      // Use the letters' em, rather than a bounding box inflated by skew.
      // This metadata update preserves edited/applied; a user-set size stands.
      if (!item.restyled) {
        const size = sizeOf(item, span)
        if (Math.abs(size - item.fontSize) > 0.05) {
          useOcrStore().updateItem(item.id, { fontSize: size, restyled: false })
          item = { ...item, fontSize: size }
        }
      }
      // A live bake already in flight when the edit was committed planned the
      // run before this cut existed: it drew the WHOLE line in a base font and
      // marked it applied, and nothing ever asked again — "02" → "03" in a
      // table, edited a second after the line above, stayed a Helvetica cell
      // for good. A first cut for an applied edit makes the bake stale.
      if (!hadSpan && item.edited && item.applied && !item.restyled) {
        useOcrStore().updateItem(item.id, { applied: false })
        item = { ...item, applied: false }
      }
      face = scanFaceFor(item.pageIndex, styleKeyOf(item))
      return true
    }
    try {
      // The cut is made FIRST and kept whatever the tracer then does with it:
      // the partial redraw needs the letters' positions even when every glyph
      // is already in the face and there is nothing to trace.
      // A PaddleOCR run carries ONE box as its "symbols" (its own line box,
      // from `refineLines`); only a box per character is a glyph cut.
      const perGlyph = !!symbols && symbols.length === [...item.originalText].filter(c => c !== ' ').length
      let cut = cutGlyphs(raster.ctx, rect, item.originalText, perGlyph ? symbols : undefined)
      let source: SpanCut['source'] = perGlyph ? 'symbols' : 'profile'
      const firstReason = cut ? '' : lastCutReason()
      if (cut && !rememberCut(cut, source)) return { added: 0, refused: null }
      // A line that will not cut WHOLE is cut word by word (wordSeg.ts): one
      // letter the recogniser dropped then costs its own word, not the line,
      // and an edit redraws the words it changed instead of the whole line in
      // a base font. Every body line over 80 characters of the SEIDOR
      // appendix refused the line cut.
      let words: WordSpan | null = null
      if (!cut && !perGlyph) {
        words = wordSpanFor(hi ?? raster, item)
        if (words && !rememberSpan(words.span)) return { added: 0, refused: null }
      }
      if (opts.measureOnly) return { added: 0, refused: null }
      if (words) {
        const added = await traceUnchangedWords(face, words, item)
        if (added) faceVersion.value++
        if (await borrowMissingGlyphs(item, raster, face)) faceVersion.value++
        return { added, refused: null }
      }
      const res = await traceRunIntoFace(face, raster.ctx, rect, item.originalText, perGlyph ? symbols : undefined, item.text, cut)
      if (res.added) faceVersion.value++
      if (cut && await borrowMissingGlyphs(item, raster, face)) faceVersion.value++
      if (res.added || !res.refused || perGlyph || cut) return res
      // The profile cut refused — letters that touch, too many fragments, a
      // misaligned end. PaddleOCR reports no glyph boxes, and the column
      // profile is the only cut there was; Tesseract does report them, and
      // segments touching letters with its recogniser rather than by ink.
      // Half the corpus's refusals are "letters touch", so the run is cropped
      // and read once more, by Tesseract, for its boxes alone. Its READING has
      // to agree with the run's text (same count, four letters in five the
      // same) or the boxes describe some other line; and the cells it gives
      // are vetted exactly as a profile cut is.
      const boxes = await glyphBoxesFromTesseract(raster.ctx, rect, item.originalText, item.inkRect.height).catch(() => null)
      if (!boxes) return res
      cut = cutGlyphs(raster.ctx, rect, item.originalText, boxes)
      source = 'tesseract'
      if (cut && !rememberCut(cut, source)) return { added: 0, refused: null }
      const again = await traceRunIntoFace(face, raster.ctx, rect, item.originalText, boxes, item.text, cut)
      if (again.added) { faceVersion.value++; return again }
      return { added: 0, refused: `${firstReason || res.refused}; on Tesseract's glyph boxes: ${again.refused || 'nothing to add'}` }
    } catch (err) {
      console.warn('[OCR] scan face tracing failed:', err)
      return { added: 0, refused: null }
    }
  }

  /**
   * Glyphs the edit needs that neither the run nor the face holds, BORROWED
   * from another run of the page at the same size and weight.
   *
   * The face only ever learned from the runs the user edited, so typing a
   * lowercase "e" into an all-caps heading drew it in Helvetica, while the
   * page carried bold lowercase "e"s of the same size a few lines down
   * ("09 de marzo de 2016" on the SEIDOR appendix). A donor cell is taken only
   * when its em is within 15% of the run's and the letters AROUND it (not the
   * letter itself - its shape biases the measure) weigh what the run's cells
   * do, within 20%: a bold heading borrows from a bold span, never from the
   * regular prose around it. At most three donor lines per commit, nearest
   * first; each is cut on the same raster, so the weights compare.
   */
  async function borrowMissingGlyphs(item: OcrTextItem, raster: { ctx: CanvasRenderingContext2D; toPt: number }, face: ScanFace): Promise<number> {
    const target = spanCuts.get(item.id)
    if (!target) return 0
    const missing = new Set([...item.text].filter(c => c.trim() && !face.glyphs.has(c)))
    if (!missing.size) return 0
    const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
    const tw = target.cells.filter(c => !c.suspect && c.weight).map(c => c.weight!)
    if (tw.length < 3) return 0
    const tMed = median(tw)
    const cy = item.inkRect.y + item.inkRect.height / 2
    const donors = useOcrStore().itemsFor(item.pageIndex)
      // A donor's text is the ENGINE's reading alone - nobody checked it the
      // way the user checks the run they edit - so only a confident reading.
      .filter(d => d.id !== item.id && !d.edited && !d.removed && !d.baked && !d.vertical && d.confidence >= 90 && [...d.originalText].some(c => missing.has(c)))
      .sort((a, b) => Math.abs(a.inkRect.y + a.inkRect.height / 2 - cy) - Math.abs(b.inkRect.y + b.inkRect.height / 2 - cy))
    const k = 1 / raster.toPt
    // Three donors CUT, out of eight tried: a long line of a skewed scan
    // refuses its cut far more often than a short one, and on the SEIDOR
    // appendix the three lines nearest the heading all refused while the one
    // that carried the bold "e" was fifth.
    let added = 0, cutOk = 0, tried = 0
    for (const d of donors) {
      if (!missing.size || cutOk >= 3 || tried >= 8) break
      if (![...d.originalText].some(c => missing.has(c))) continue
      tried++
      const rect = { x: d.inkRect.x * k, y: d.inkRect.y * k, width: d.inkRect.width * k, height: d.inkRect.height * k }
      const nonSpace = [...d.originalText].filter(c => c !== ' ').length
      const symbols = d.symbols && d.symbols.length === nonSpace
        ? d.symbols.map(s => ({ x0: s.x * k, y0: s.y * k, x1: (s.x + s.width) * k, y1: (s.y + s.height) * k }))
        : undefined
      const cut = cutGlyphs(raster.ctx, rect, d.originalText, symbols)
      if (!cut) continue
      cutOk++
      // ...and a cut with almost nothing suspect: a cell a single letter off
      // is a plausible shape under the wrong name, and a borrowed one lands in
      // lines the user never looked at. Measured on the OCR corpus: donors
      // at the ordinary vetting bar put a "u" for an "i" and an "n" for an
      // "o" into two runs that had baked cleanly in Helvetica.
      if (cut.cells.filter(c => c.suspect).length > cut.cells.length * 0.1) continue
      const span = toSpanCut(cut, raster.toPt, d.originalText, symbols ? 'symbols' : 'profile')
      if (!(span.emPt > 0) || Math.abs(span.emPt / target.emPt - 1) > 0.15) continue
      const acceptCell = (i: number) => {
        const c = span.cells[i]
        if (!c || c.suspect || !missing.has(c.char)) return false
        if (span.cells[i - 1]?.suspect || span.cells[i + 1]?.suspect) return false
        const around: number[] = []
        for (let j = Math.max(0, i - 3); j <= Math.min(span.cells.length - 1, i + 3); j++) {
          const o = span.cells[j]
          if (j !== i && !o.suspect && o.weight) around.push(o.weight)
        }
        return around.length >= 3 && Math.abs(median(around) - tMed) <= tMed * 0.2
      }
      const res = await traceRunIntoFace(face, raster.ctx, rect, d.originalText, symbols, undefined, cut, { only: missing, acceptCell })
      added += res.added
      for (const c of [...missing]) if (face.glyphs.has(c)) missing.delete(c)
    }
    return added
  }

  /**
   * A line that would not cut whole, cut WORD BY WORD on the raster (see
   * wordSeg.ts): its ink split into words, the reading shared among them by
   * width, and each word cut alone on its own ink box with the LINE's em and
   * baseline (`LineHint`) — a word's own two or three letters are a poor
   * measure of either. A word whose cut refuses keeps approximate cells
   * (`toSpanCutFromWords`), so an edit that reaches into it takes it whole.
   * Null when the line's ink cannot be segmented at all.
   */
  function wordSpanFor(raster: { ctx: CanvasRenderingContext2D; toPt: number }, item: OcrTextItem): WordSpan | null {
    const k = 1 / raster.toPt
    const rect = { x: item.inkRect.x * k, y: item.inkRect.y * k, width: item.inkRect.width * k, height: item.inkRect.height * k }
    const lw = segmentLine(raster.ctx, rect, item.originalText)
    if (!lw) return null
    const hint = { emPx: lw.fit.emPx, baselineAt: baselineAtOf(lw.fit) }
    const rects: WordSpan['rects'] = []
    const cuts = lw.matches.map(m => {
      const r = { x: m.ink.x0 - 1, y: m.ink.top - 1, width: m.ink.x1 - m.ink.x0 + 2, height: m.ink.bottom - m.ink.top + 2 }
      rects.push(r)
      return cutGlyphs(raster.ctx, r, lw.chars.slice(m.from, m.to).join(''), undefined, hint)
    })
    return { raster, lw, cuts, rects, span: toSpanCutFromWords(lw, cuts, raster.toPt) }
  }

  /**
   * Trace into the face the glyphs of the words the edit did NOT change —
   * the ones the engine's reading and the user's text agree on (the common
   * prefix and suffix, as `trustedCells` has it for a whole run). Each word
   * goes in on its own cut; a word that refused contributes nothing.
   */
  async function traceUnchangedWords(face: ScanFace, words: WordSpan, item: OcrTextItem): Promise<number> {
    const st = stretchOf(item, words.span)
    const n = words.lw.chars.length
    const prefix = st?.prefix ?? n, suffix = st?.suffix ?? 0
    let added = 0
    for (const [i, m] of words.lw.matches.entries()) {
      const cut = words.cuts[i]
      if (!cut || cut.cells.length !== m.to - m.from) continue
      if (!(m.to <= prefix || m.from >= n - suffix)) continue
      const text = words.lw.chars.slice(m.from, m.to).join('')
      const res = await traceRunIntoFace(face, words.raster.ctx, words.rects[i], text, undefined, undefined, cut)
      added += res.added
    }
    return added
  }

  /**
   * Tesseract's per-glyph boxes for the run at `rect` (raster pixels), in
   * raster coordinates and reading order — or null when its reading does not
   * match `text` closely enough to trust the boxes.
   */
  async function glyphBoxesFromTesseract(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, text: string, heightPt: number): Promise<OcrBox[] | null> {
    const chars = [...text].filter(c => c !== ' ')
    // Eight characters at least: on the corpus the fallback's wrong traces were
    // the short runs ("MINERA", "EL EGO"), where a count that matches and four
    // letters in five agreeing is little evidence that the boxes are the run's.
    if (chars.length < 8) return null
    // And a run tall enough to trace at all: a 4.7pt "Escaneado con
    // CamScanner" watermark (14px of ink) passed every other gate and traced
    // at 0.67 similarity — glyphs seven pixels tall are not letterforms.
    if (heightPt < 6.5) return null
    // Room around the run: the recogniser wants margin, and a crop cut at the
    // ink loses the descenders' tails and the accents.
    const pad = Math.max(6, Math.round(rect.height * 0.6))
    const x = Math.max(0, Math.floor(rect.x) - pad), y = Math.max(0, Math.floor(rect.y) - pad)
    const w = Math.min(ctx.canvas.width - x, Math.ceil(rect.width) + pad * 2)
    const h = Math.min(ctx.canvas.height - y, Math.ceil(rect.height) + pad * 2)
    if (w < 4 || h < 4) return null
    const crop = document.createElement('canvas')
    crop.width = w; crop.height = h
    const cctx = crop.getContext('2d')
    if (!cctx) return null
    cctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h)
    const rec = await engineFor('tesseract').recognize(crop, { lang: OCR_DEFAULT_LANG })
    // The line that overlaps the run most; a crop this tight rarely holds two.
    const cy = rect.y - y + rect.height / 2
    let best: OcrLine | null = null, bestScore = 0
    for (const line of rec.lines) {
      const oy = Math.min(line.box.y1, cy + rect.height / 2) - Math.max(line.box.y0, cy - rect.height / 2)
      if (oy > bestScore) { bestScore = oy; best = line }
    }
    // A confident reading only: a 4.7pt "Escaneado con CamScanner" watermark
    // read at low confidence traced at 0.67 similarity.
    if (!best || best.confidence < 85) return null
    const got: string[] = [], boxes: OcrBox[] = []
    for (const word of best.words ?? []) {
      const wc = [...(word.text ?? '')].filter(c => c !== ' ')
      const syms = word.symbols ?? []
      if (wc.length !== syms.length) return null
      got.push(...wc)
      for (const s of syms) boxes.push({ x0: s.x0 + x, y0: s.y0 + y, x1: s.x1 + x, y1: s.y1 + y })
    }
    if (got.length !== chars.length) return null
    const fold = (c: string) => c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    let same = 0
    for (let i = 0; i < chars.length; i++) if (fold(got[i]) === fold(chars[i])) same++
    if (same < chars.length * 0.8) return null
    // Where two letters touch, Tesseract's box for the first often runs on
    // over the second ("R" 131–196 beside "A" 170–196 on a heavy 35pt line)
    // while the second's own box is right. A box is clipped at the next one's
    // start; the vetting then judges what is left. Boxes must be in reading
    // order for that, and a box emptied by the clip means the pair was one
    // blob to the engine too - give up rather than guess. The boxes stay in
    // the engine's order, which is the order of `got`: sorting would break
    // the pairing with the characters.
    for (let i = 0; i + 1 < boxes.length; i++) {
      if (boxes[i].x1 > boxes[i + 1].x0) boxes[i] = { ...boxes[i], x1: boxes[i + 1].x0 }
      if (boxes[i].x1 - boxes[i].x0 < 2) return null
    }
    return boxes
  }

  /** How an item's ink would be cut into glyph cells — for tests and the harness. */
  function cutFor(item: OcrTextItem): { cells: { char: string; x0: number; x1: number; suspect?: boolean }[]; emPx: number; baselineY: number; toPt: number; reason?: string } | null {
    const raster = rasters.get(item.pageIndex)
    if (!raster) return null
    const k = 1 / raster.toPt
    const rect = { x: item.inkRect.x * k, y: item.inkRect.y * k, width: item.inkRect.width * k, height: item.inkRect.height * k }
    const symbols = item.symbols?.map(s => ({ x0: s.x * k, y0: s.y * k, x1: (s.x + s.width) * k, y1: (s.y + s.height) * k }))
    const cut = cutGlyphs(raster.ctx, rect, item.originalText, symbols)
    return cut
      ? { cells: cut.cells, emPx: cut.emPx, baselineY: cut.baselineY, toPt: raster.toPt }
      : { cells: [], emPx: 0, baselineY: 0, toPt: raster.toPt, reason: lastCutReason() }
  }

  /**
   * Every cut `traceItemNow` could make for an item, side by side — the OCR
   * raster, the tracing raster and Tesseract's glyph boxes — for the harness.
   * Says which one the trace would have used.
   */
  async function debugCuts(item: OcrTextItem) {
    const base = await rasterFor(item.pageIndex)
    if (!base) return null
    const describe = (raster: { ctx: CanvasRenderingContext2D; toPt: number }, boxes?: OcrBox[]) => {
      const k = 1 / raster.toPt
      const rect = { x: item.inkRect.x * k, y: item.inkRect.y * k, width: item.inkRect.width * k, height: item.inkRect.height * k }
      const cut = cutGlyphs(raster.ctx, rect, item.originalText, boxes)
      return cut
        ? { toPt: raster.toPt, emPx: cut.emPx, emPt: cut.emPx * raster.toPt, cells: cut.cells.map(c => `${c.char}[${Math.round(c.x0)}-${Math.round(c.x1)}${c.suspect ? '!' : ''}]`).join(' '), debug: lastCutDebug() }
        : { toPt: raster.toPt, reason: lastCutReason(), debug: lastCutDebug() }
    }
    const hi = await traceRasterFor(item.pageIndex, base)
    const out: Record<string, unknown> = { base: describe(base) }
    if (hi) out.hi = describe(hi)
    const raster = hi && !('reason' in (out.hi as { reason?: string })) ? hi : base
    out.used = raster === hi ? 'hi' : 'base'
    const k = 1 / raster.toPt
    const rect = { x: item.inkRect.x * k, y: item.inkRect.y * k, width: item.inkRect.width * k, height: item.inkRect.height * k }
    const boxes = await glyphBoxesFromTesseract(raster.ctx, rect, item.originalText, item.inkRect.height).catch(() => null)
    out.tesseractBoxes = boxes ? boxes.map(b => `${Math.round(b.x0)}-${Math.round(b.x1)}`).join(' ') : null
    if (boxes) out.tesseract = describe(raster, boxes)
    return out
  }

  /** The page's scan face for a run's style, if any glyph has been traced for it. */
  function faceOf(pageIndex: number, styleKey: string): ScanFace | null {
    const f = scanFaceFor(pageIndex, styleKey)
    return f.glyphs.size ? f : null
  }

  /** Every face of a page with glyphs — the bake registers them all. */
  function facesOf(pageIndex: number): ScanFace[] {
    return scanFacesOf(pageIndex)
  }

  // ===== SCAN EDITS (scanEdit.ts) =====
  /**
   * Edits made ON the scan: the letters a line keeps stay the scan's pixels,
   * the ones it adds are the page's own letters, and the result is drawn back
   * over exactly the scan's pixel grid. Everything below caches what that
   * needs per page — the scan at its own resolution, its paper, its lines
   * analysed — keyed by the recognition generation (a page recognised again
   * describes different runs), at most two pages' pixels at a time (~30 MB
   * each); what each page contributes to the glyph atlas is kept small and
   * for the whole document.
   */
  type ScanImage = { width: number; height: number; rgba: ArrayBuffer; ctm: [number, number, number, number, number, number]; pageWidth: number; pageHeight: number; name: string }
  let scanLoader: ((pageIndex: number) => Promise<ScanImage | null>) | null = null
  function setScanLoader(fn: typeof scanLoader) { scanLoader = fn }
  interface ScanPage { gen: number; raster: ScanRaster; pi: PageInk; lines: Map<string, LineInk | null>; unread: Map<string, string> }
  const scanPages = new Map<number, { gen: number; sp: ScanPage | null }>()
  const harvests = new Map<number, { gen: number; h: PageHarvest }>()
  /**
   * Pages whose letters the atlas keeps. A harvest holds 4 to 10 MB of glyph
   * crops, and every page recognised is harvested now (its runs are re-read
   * from its letters) — recognising a hundred-page document kept them all.
   * The eight used last are plenty: a document sets its pages in the same
   * few faces.
   */
  const MAX_HARVESTS = 8
  function keepHarvest(pageIndex: number, entry: { gen: number; h: PageHarvest }) {
    harvests.delete(pageIndex)
    harvests.set(pageIndex, entry)
    while (harvests.size > MAX_HARVESTS) harvests.delete(harvests.keys().next().value!)
  }
  let atlasCache: { key: string; atlas: Atlas } | null = null

  // One build of a page at a time: the background re-read and an edit's plan
  // ask for the same page within moments of each other, and two builds of it
  // cost the main thread twice.
  const building = new Map<string, Promise<ScanPage | null>>()
  /**
   * `keep: false` — only HARVEST the page for the atlas (a letter the edited
   * page lacks): its pixels are not kept, so the page being edited is never
   * pushed out of the two-page cache by its own neighbours.
   */
  function scanPageFor(pageIndex: number, keep = true): Promise<ScanPage | null> {
    const have = scanPages.get(pageIndex)
    if (have && have.gen === genOf(pageIndex)) {
      // In use: its letters are the last the atlas lets go.
      const h = harvests.get(pageIndex)
      if (h) keepHarvest(pageIndex, h)
      return Promise.resolve(have.sp)
    }
    const key = `${pageIndex}:${genOf(pageIndex)}:${keep}`
    const pending = building.get(key)
    if (pending) return pending
    const p: Promise<ScanPage | null> = scanPageForNow(pageIndex, keep).finally(() => { building.delete(key) })
    building.set(key, p)
    return p
  }
  async function scanPageForNow(pageIndex: number, keep: boolean): Promise<ScanPage | null> {
    const gen = genOf(pageIndex)
    const have = scanPages.get(pageIndex)
    if (have && have.gen === gen) return have.sp
    const page = useOcrStore().pages.get(pageIndex)
    if (!scanLoader || !page) return null
    const img = await scanLoader(pageIndex).catch(() => null)
    if (genOf(pageIndex) !== gen) return null
    let sp: ScanPage | null = null
    // Sixteen megapixels at most (A4 at 400 DPI): the paper estimate takes
    // four bytes a channel a pixel while it is made, and a 600 DPI page would
    // ask the tab for half a gigabyte. Such a page keeps the vector redraw.
    const MAX_SCAN_PX = 16e6
    if (img && img.width * img.height <= MAX_SCAN_PX && Math.abs(img.pageWidth - page.pageWidth) < 1 && Math.abs(img.pageHeight - page.pageHeight) < 1) {
      const raster = scanRasterOf(img.width, img.height, new Uint8ClampedArray(img.rgba), img.ctm, img.pageWidth, img.pageHeight, img.name)
      if (raster && isUpright(raster)) {
        const pi = preparePage(raster)
        const lines = new Map<string, LineInk | null>()
        const unread = new Map<string, string>()
        // A run a bake already finalised reads its NEW text over ink the scan
        // still shows the old way: analysed, it would teach the atlas the
        // wrong letters, and it cannot be redrawn from the scan anyway.
        // A page is analysed as soon as it is recognised, in the background
        // (`repairReadings`): a few lines at a time, so the tab stays live.
        let n = 0
        for (const it of page.items) {
          if (it.vertical || it.baked) continue
          if (++n % 8 === 0) {
            await new Promise(r => setTimeout(r, 0))
            if (genOf(pageIndex) !== gen) return null
          }
          const li = analyzeLine(pi, { id: it.id, text: it.originalText, inkRect: it.inkRect, confidence: it.confidence, tilt: it.tilt })
          if (li && it.reread) li.reread = true
          lines.set(it.id, li)
          if (!li) unread.set(it.id, lastLineFailure())
        }
        sp = { gen, raster, pi, lines, unread }
        keepHarvest(pageIndex, { gen, h: harvestPage(pi, [...lines.values()].filter((l): l is LineInk => !!l), pageIndex) })
      }
    }
    if (!keep) return sp
    scanPages.delete(pageIndex)
    scanPages.set(pageIndex, { gen, sp })
    while (scanPages.size > 2) scanPages.delete(scanPages.keys().next().value!)
    return sp
  }

  /**
   * The page's runs re-read from its own letters, so the editor opens on what
   * the page says rather than on what the recogniser made of it. PaddleOCR
   * drops the spaces and letters at word joins of small body text —
   * "Lostérminos queenel presente Apéndice … deinidos" — and a user editing
   * that edits a garbled line, while the letters it lost are on the page
   * beside the ones it kept (`repairReading`; every gate it applies applies
   * here, so a line whose shapes the atlas cannot read is left as read — and
   * `repairIsDisplayable` on top: prose only, never a changed figure).
   *
   * Only runs nobody has touched: not edited, moved, restyled or baked, not
   * the one selected (an editor may be open on it), and still read as they
   * were analysed. Each run is a store update of its reading AND its original,
   * so it is not an edit and nothing is baked. Yields between lines, and stops
   * when the page is recognised again.
   */
  const repairing = new Set<Promise<number>>()
  function repairReadings(pageIndex: number): Promise<number> {
    const p: Promise<number> = repairReadingsNow(pageIndex).finally(() => { repairing.delete(p) })
    repairing.add(p)
    return p
  }
  /** Every re-read in progress, finished — for drivers that look runs up by their reading. */
  async function settleRepairs(): Promise<void> {
    while (repairing.size) await Promise.allSettled([...repairing])
  }
  async function repairReadingsNow(pageIndex: number): Promise<number> {
    const gen = genOf(pageIndex)
    const sp = await scanPageFor(pageIndex)
    if (!sp || genOf(pageIndex) !== gen) return 0
    const atlas = currentAtlas()
    if (!atlas) return 0
    const store = useOcrStore()
    let n = 0
    for (const [id, li] of [...sp.lines]) {
      if (!li || li.reread) continue
      await new Promise(r => setTimeout(r, 0))
      if (genOf(pageIndex) !== gen) return n
      const it = store.pages.get(pageIndex)?.items.find(i => i.id === id)
      if (!it || it.edited || it.removed || it.baked || it.vertical || it.restyled || store.selectedId === id ||
          it.text !== it.originalText || it.originalText !== li.text || !isProseLine(li)) continue
      const rep = repairReading(pageOfLine(sp.pi, li), li, atlas)
      if (!rep || rep.text === it.text || !repairIsDisplayable(li, rep.text)) continue
      store.updateItem(id, { text: rep.text, originalText: rep.text, reread: true })
      sp.lines.set(id, rep.li)
      n++
    }
    return n
  }

  /** The atlas over every page harvested so far (of the current recognitions). */
  function currentAtlas(): Atlas | null {
    const list = [...harvests.entries()].filter(([p, e]) => e.gen === genOf(p)).sort((a, b) => a[0] - b[0])
    if (!list.length) return null
    const key = list.map(([p, e]) => `${p}:${e.gen}`).join(',')
    if (atlasCache?.key === key) return atlasCache.atlas
    const atlas = atlasFrom(list.map(([, e]) => e.h))
    atlasCache = { key, atlas }
    return atlas
  }

  /**
   * Plan a page's scan edits (see scanEditPage.ts), or null when the page has
   * no scan to edit (a vector page, a rotated or tiled scan). A line refused
   * for want of a letter is planned again once up to four more recognised
   * pages have been harvested, nearest first — the same printer and scanner
   * set the rest of the document.
   */
  async function planScanEditsFor(pageIndex: number, items: OcrTextItem[]): Promise<ScanEditPlan | null> {
    const t0 = performance.now()
    const sp = await scanPageFor(pageIndex)
    if (!sp) return null
    const t1 = performance.now()
    let atlas = currentAtlas()
    if (!atlas) return null
    const t2 = performance.now()
    let plan = planScanEdits(sp.pi, sp.lines, atlas, items, undefined, sp.unread)
    if (import.meta.env.DEV) ((window as any).__scanEditTimes ??= []).push({ page: pageIndex, scanPage: Math.round(t1 - t0), atlas: Math.round(t2 - t1), plan: Math.round(performance.now() - t2) })
    // A letter no page holds, or holds only in another kind of face: the rest
    // of the document may print it in this one.
    const wanting = plan.wanting.length > 0 || Object.values(plan.modes).some(m => m.includes('no letter on the page'))
    if (wanting) {
      const others = [...useOcrStore().pages.keys()]
        .filter(q => q !== pageIndex && harvests.get(q)?.gen !== genOf(q))
        .sort((a, b) => Math.abs(a - pageIndex) - Math.abs(b - pageIndex))
        .slice(0, 4)
      for (const q of others) await scanPageFor(q, false)
      if (others.length) {
        atlas = currentAtlas() ?? atlas
        plan = planScanEdits(sp.pi, sp.lines, atlas, items, undefined, sp.unread)
      }
    }
    // Letters no harvested page holds in either weight: drawn from the face
    // that prints most like this scan (glyphSynth.ts), and planned again.
    if (plan.wanting.length && glyphRasterizer) {
      // Each line's letters in that LINE's look: a page sets a logo, headings
      // and body in different faces, and one look for the page fitted their
      // mix (see `lookRefs`).
      const synth = new Map<string, GlyphImage>()
      const refused = new Map<string, string>()
      for (const w of plan.wanting) {
        const look = await lookFor(atlas, w.line ? { line: w.line, page: pageIndex, emPx: w.emPx } : undefined)
        // Only a face that prints like this line: below this agreement the
        // synthesised letters read as another face (a serif X on a sans form,
        // a typeface for handwriting — 0.43 to 0.69 on the corpus). Between it
        // and 0.85 a letter is still made: the line may take two at most
        // (`applyLineEdit`), and what it is refused for draws a foreign face
        // anyway — Helvetica, crisp, placed by a coarser measure of the line.
        // A receipt set in a geometric sans none of the faces is (0.77 to
        // 0.81) floated a Helvetica "X" two points over its baseline.
        if (!look || look.score < 0.75) {
          if (w.line) refused.set(w.line, look ? `no face prints like this line (best ${look.family} at ${look.score.toFixed(2)})` : 'no face could be fitted to this line')
          continue
        }
        const key = `${w.line ?? ''}|${look.family}|${look.regularAs ?? ''}|${wantKey(w)}|${w.ink.map(v => v >> 3).join(',')}|${(w.stem ?? 0).toFixed(3)}`
        let g = synthCache.get(key)
        if (!g) {
          g = await synthGlyph(look, glyphRasterizer, atlas, w).catch(() => null) ?? undefined
          if (g) synthCache.set(key, g)
        }
        if (import.meta.env.DEV) ((window as any).__synthLog ??= []).push({ page: pageIndex, line: w.line, char: w.char, face: look.family, score: +look.score.toFixed(2), made: !!g })
        if (g) synth.set(w.line ? `${w.line}|${wantKey(w)}` : wantKey(w), g)
      }
      if (synth.size) plan = planScanEdits(sp.pi, sp.lines, atlas, items, synth, sp.unread)
      // Say why a letter was not made: the status line and the sweep read it.
      for (const [id, m] of Object.entries(plan.modes)) {
        const why = refused.get(id)
        if (why && m.includes('no letter on the page')) plan.modes[id] = m.replace(/\)$/, `; ${why})`)
      }
    }
    return plan
  }

  /**
   * The vector redraw's patches and moved tails made on the scan's pixels
   * (`inkAwareFallback`), for every run whose line the page's scan analysis
   * read — null when the page has no scan analysis to hand. Only reads the
   * cache `planScanEditsFor` filled for this bake: it never loads a page.
   */
  function inkAwareFallbackFor(pageIndex: number, ops: FallbackOps): ReturnType<typeof inkAwareFallback> | null {
    const have = scanPages.get(pageIndex)
    if (!have || have.gen !== genOf(pageIndex) || !have.sp) return null
    // Every patch is a candidate: one whose line was read is erased letter by
    // letter, any other is filled from its ground (`groundFill`).
    if (!ops.patches.some(p => p.item && p.paint !== false)) return null
    return inkAwareFallback(have.sp.pi, have.sp.lines, ops)
  }

  /**
   * Glyphs of the bundled match faces, rasterised by the engine — lent by the
   * layout, like the page renderer. Synthesised letters and the fitted look
   * are cached per atlas: a different set of harvested pages is a different
   * judgement of how the scan prints.
   */
  let glyphRasterizer: Rasterize | null = null
  function setGlyphRasterizer(fn: Rasterize | null) { glyphRasterizer = fn }
  let lookCache: { atlasKey: string; looks: Map<string, ScanLook | null> } | null = null
  const synthCache = new Map<string, GlyphImage>()
  async function lookFor(atlas: Atlas, near?: LookNear): Promise<ScanLook | null> {
    const atlasKey = atlasCache?.key ?? ''
    if (lookCache?.atlasKey !== atlasKey) { lookCache = { atlasKey, looks: new Map() }; synthCache.clear() }
    const key = near ? `${near.page}|${near.line}` : ''
    if (lookCache.looks.has(key)) return lookCache.looks.get(key)!
    const look = await fitScanLook(atlas, glyphRasterizer!, { near }).catch(() => null)
    lookCache.looks.set(key, look)
    return look
  }

  /** Forget rasters and faces — a different document is being opened. */
  function reset() {
    rasters.clear()
    traceRasters.clear()
    faintCutoffs.clear()
    spanCuts.clear()
    scanPages.clear()
    harvests.clear()
    atlasCache = null
    lookCache = null
    synthCache.clear()
    clearScanFaces()
    faceVersion.value++
  }

  /**
   * Does this page need OCR?
   *
   * Judged on the PDF's OWN text, not on appearance: a page whose text layer is
   * empty is a page the existing editor cannot touch, whatever it looks like.
   * The verdict carries its reason so the UI can explain itself instead of
   * silently deciding for the user.
   */
  function judgeScanned(extractedChars: number, textCoverage?: number): ScannedVerdict {
    // A signing service stamps a scanned contract with its ID strip — a line
    // of 8pt text at the foot of every page, once per signing pass, so 34
    // copies of "Intellisign ID: …" put 1768 characters on a page that is
    // otherwise a photograph. Counted, they made the page a "text page" and
    // the edit tool showed 34 unreachable blocks instead of recognising it.
    // Text that covers under 2% of the paper is a stamp, a page number or a
    // footer, whatever its character count. The rule lives in utils/pageKind,
    // shared with the MCP server.
    return judgeScannedPure(extractedChars, textCoverage)
  }

  /**
   * Recognise one page — see `recognizeRaster` (recognizePipeline.ts), which
   * holds the pipeline. What stays here is the recogniser's state: one
   * recognition at a time, progress for the toolbar, the engine instances and
   * the rasters the glyph tracer and the scan edit read afterwards.
   *
   * @param canvas the page already rendered by the viewer, at any scale
   * @param pageIndex 0-based
   * @param pageWidth  page width in POINTS
   * @param pageHeight page height in POINTS
   * @param readVertical also look for text set on its side
   */
  async function recognizePage(
    canvas: HTMLCanvasElement,
    pageIndex: number,
    pageWidth: number,
    pageHeight: number,
    lang = OCR_DEFAULT_LANG,
    readVertical = true,
    engineId: OcrEngineId = 'paddle'
  ): Promise<OcrPageResult | null> {
    if (busy.value) return null
    busy.value = true
    error.value = null
    progress.value = 0

    try {
      // The chosen engine, or Tesseract when it cannot run here. Only the
      // in-browser default falls back on its own: a cloud call that fails is
      // something the user asked for and must hear about, not paper over.
      const r = await recognizeRaster({
        canvas, pageIndex, pageWidth, pageHeight, lang, readVertical,
        engine: engineFor(engineId),
        fallback: engineId === 'paddle' ? () => engineFor('tesseract') : undefined,
        fallbackLabel: (err) => `${ENGINE_LABELS.paddle} could not run (${err?.message || err}); read with ${ENGINE_LABELS.tesseract} instead`,
        hooks: { onStage: s => { stage.value = s }, onProgress }
      })
      if (r.faintCutoff !== undefined) faintCutoffs.set(pageIndex, r.faintCutoff)
      else faintCutoffs.delete(pageIndex)

      let confSum = 0
      for (const it of r.items) confSum += it.confidence

      keepRaster(pageIndex, r.clean, true)
      // Warm the recogniser the glyph-box fallback will ask for, so the first
      // edit on a fresh browser does not pay its ~20 s worker start. Not
      // awaited, and a failure is the fallback's to report when it is needed.
      if (engineId !== 'tesseract') void engineFor('tesseract').ready({ lang }).catch(() => {})

      return {
        pageIndex,
        items: r.items,
        pageWidth,
        pageHeight,
        confidence: r.items.length ? Math.round(confSum / r.items.length) : 0,
        lang,
        verticalCount: r.verticalCount,
        engine: r.engine.id,
        fallbackNote: r.fallbackNote
      }
    } catch (err: any) {
      error.value = err?.message || String(err)
      return null
    } finally {
      busy.value = false
      stage.value = ''
      progress.value = 0
    }
  }

  async function destroy() {
    for (const [, e] of engines) await e.destroy().catch(() => {})
    engines.clear()
  }

  return { busy, progress, stage, error, faceVersion, judgeScanned, recognizePage, engineFor, traceItem, settleTraces, spanCutFor, forgetSpanCut, setPageRenderer, setScanLoader, setGlyphRasterizer, planScanEditsFor, inkAwareFallbackFor, repairReadings, settleRepairs, forgetTraceRaster, faintCutoffFor, cutFor, debugCuts, faceOf, facesOf, reset, destroy }
}
