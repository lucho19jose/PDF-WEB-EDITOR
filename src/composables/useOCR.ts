import { ref, shallowRef } from 'vue'
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js'
import type { OcrPageResult, OcrTextItem, OcrAlign, ScannedVerdict } from '@/utils/ocr/ocrTypes'
import { sampleLineColors, samplePatchColor } from '@/utils/ocr/ocrSampling'
import { detectFace, advancesAreUniform } from '@/utils/ocr/ocrFontDetect'

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

/** Rasterisation used for OCR, in DPI. */
const OCR_DPI = 220
/** PDF user space is 72 units to the inch. */
const PDF_DPI = 72

/**
 * Below this, a page's own text layer is treated as absent.
 *
 * Not zero: a scan often carries a stray character or two — a stamped page
 * number, a producer's watermark — and a page with three characters on it is
 * still a page nobody can edit.
 */
const SCANNED_TEXT_THRESHOLD = 12

/**
 * The tallest symbol box of a line WITH descenders, as a fraction of the em.
 *
 * Measured, not derived: a 12pt line rasterised at 220 DPI has a 36.7px em and
 * its tallest symbol box comes back at 35.1px. Treating the box as a cap height
 * (0.7) put every size 30% over; `rowAttributes`, which is in the type
 * definitions, is not in absolute pixels and put them out by a factor of 2.6.
 */
const GLYPH_BOX_PER_EM = 0.95

/**
 * The same fraction for a run with NO descenders.
 *
 * The constant above is only right when something in the line reaches below the
 * baseline. A row of capitals has nothing that does, so its tallest box is the
 * cap height and the em derived from it came out a fifth short — an 11pt row of
 * headings read as 9pt, and the replacement was visibly smaller than the
 * headings either side of it that had not been touched.
 *
 * Measured on the same page: "DATA" and "DETAIL" set at 11pt gave boxes of 8.17
 * and 8.55 points, i.e. 0.74 and 0.78 of the em.
 */
const GLYPH_BOX_PER_EM_NO_DESCENDER = 0.76

/**
 * Characters that reach below the baseline.
 *
 * Q descends in most faces, and the comma and semicolon hang below it. J does
 * in some faces and not others, so it is left out: guessing high here shrinks
 * text, and shrinking is the failure being fixed.
 */
const DESCENDERS = /[gjpqyQ,;]/

/**
 * The same fraction for a monospaced face.
 *
 * Courier's ascenders reach 0.63 of the em where Helvetica's reach 0.72, so the
 * tallest box in a line of it is proportionally shorter and the em derived from
 * it came out about 30% low — a 12pt line read as 8.3pt. Measured the same way
 * as the constant above, on the same page.
 */
const GLYPH_BOX_PER_EM_MONO = 0.625

/** A vertical run must be at least this much taller than it is wide. */
const VERTICAL_ASPECT = 1.6
/** Sideways recognition is speculative, so only confident runs are kept. */
const VERTICAL_MIN_CONFIDENCE = 55

interface Box { x0: number; y0: number; x1: number; y1: number }

export function useOCR() {
  const busy = ref(false)
  const progress = ref(0)
  const stage = ref('')
  const error = ref<string | null>(null)
  const worker = shallowRef<TesseractWorker | null>(null)
  let workerLang = ''

  /**
   * Does this page need OCR?
   *
   * Judged on the PDF's OWN text, not on appearance: a page whose text layer is
   * empty is a page the existing editor cannot touch, whatever it looks like.
   * The verdict carries its reason so the UI can explain itself instead of
   * silently deciding for the user.
   */
  function judgeScanned(extractedChars: number): ScannedVerdict {
    if (extractedChars > SCANNED_TEXT_THRESHOLD) {
      return {
        scanned: false,
        extractedChars,
        reason: `the page already has ${extractedChars} characters of real text — edit it directly`
      }
    }
    return {
      scanned: true,
      extractedChars,
      reason: extractedChars === 0
        ? 'the page has no text at all, only an image'
        : `the page has only ${extractedChars} characters of text, too few to be a text page`
    }
  }

  /** Start the OCR worker, or reuse the running one when the language matches. */
  async function ensureWorker(lang: string): Promise<TesseractWorker> {
    if (worker.value && workerLang === lang) return worker.value
    if (worker.value) {
      await worker.value.terminate().catch(() => {})
      worker.value = null
    }
    stage.value = 'Loading the recogniser...'
    // Language data is served from this app, not a CDN: OCR then works offline
    // and starts in a fraction of the time.
    const w = await createWorker(lang, 1, {
      langPath: '/tessdata',
      gzip: true,
      logger: (m: any) => {
        if (m.status === 'recognizing text') progress.value = Math.round((m.progress ?? 0) * 100)
        if (typeof m.status === 'string') stage.value = m.status
      }
    })
    worker.value = w
    workerLang = lang
    return w
  }

  /**
   * Where a line sits within its paragraph tells you how it is aligned.
   *
   * A single line says nothing — one line is flush with itself. Only when a
   * paragraph has several can the pattern of their left and right edges mean
   * anything, so anything else stays left.
   */
  function inferAlign(lineBox: Box, paraBox: Box, lineCount: number): OcrAlign {
    if (lineCount < 2) return 'left'
    const leftGap = lineBox.x0 - paraBox.x0
    const rightGap = paraBox.x1 - lineBox.x1
    const width = Math.max(paraBox.x1 - paraBox.x0, 1)
    const tol = width * 0.04
    if (Math.abs(leftGap - rightGap) < tol && leftGap > tol) return 'center'
    if (rightGap < tol && leftGap > tol * 2) return 'right'
    return 'left'
  }

  /**
   * Split a recognised line where it stops being one piece of text.
   *
   * Tesseract groups by VISUAL row, so five column headings printed side by
   * side across a page come back as ONE line. Editing that rewrites all five:
   * the user changes one heading and the whole row is redrawn as a single run,
   * in one font, on one baseline. That is the "it detects the whole line when
   * the text is only in one spot" report.
   *
   * A gap cuts when it is unmistakable ON ITS OWN — no word space is two and a
   * half ems wide — or when it is both wider than an em and several times this
   * line's own median gap.
   *
   * Requiring BOTH tests, which is what it did first, fails on exactly the case
   * it exists for: when every gap on the line is a column gap, they ARE the
   * median, the relative threshold climbs above all of them, and the row stays
   * whole. The relative test is there to protect letter-spaced text from being
   * shredded, so it can only ever ADD splits, never veto the absolute one.
   *
   * There is a third case the other two miss: a row of one-word headings, where
   * every gap is a column gap but none is wide enough to be unmistakable on its
   * own. It is recognised by its SMALLEST gap — if even that is wider than an
   * em, no gap on the line is a word space, so every one of them separates two
   * pieces of text. Prose can never trigger it: a line of prose always contains
   * a real word space, and a word space is about a third of an em.
   */
  function splitRuns(words: any[], emPx: number): any[][] {
    const ordered = [...words].sort((a, b) => a.bbox.x0 - b.bbox.x0)
    if (ordered.length < 2) return [ordered]

    const gaps: number[] = []
    for (let i = 1; i < ordered.length; i++) {
      gaps.push(Math.max(0, ordered[i].bbox.x0 - ordered[i - 1].bbox.x1))
    }
    const sorted = [...gaps].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] || 0
    const obvious = Math.max(emPx * 2.5, 1)
    const relative = Math.max(emPx * 1.1, median * 2.5, 1)
    const noWordSpaces = sorted[0] > emPx * 1.2

    const runs: any[][] = [[ordered[0]]]
    for (let i = 1; i < ordered.length; i++) {
      const gap = gaps[i - 1]
      if (noWordSpaces || gap > obvious || gap > relative) runs.push([ordered[i]])
      else runs[runs.length - 1].push(ordered[i])
    }
    return runs
  }

  /**
   * The em of a run, from the tallest glyph box in it.
   *
   * How much of an em that box is depends on whether anything in the run goes
   * below the baseline, so the text has to be consulted, not just the boxes.
   */
  function emOf(words: any[], fallbackHeight: number, text: string): number {
    let capPx = 0
    for (const word of words) {
      for (const sym of word.symbols ?? []) {
        const h = sym.bbox.y1 - sym.bbox.y0
        if (h > capPx) capPx = h
      }
    }
    const perEm = DESCENDERS.test(text) ? GLYPH_BOX_PER_EM : GLYPH_BOX_PER_EM_NO_DESCENDER
    return capPx > 1 ? capPx / perEm : fallbackHeight * 1.05
  }

  function unionBox(words: any[]): Box {
    return {
      x0: Math.min(...words.map(w => w.bbox.x0)),
      y0: Math.min(...words.map(w => w.bbox.y0)),
      x1: Math.max(...words.map(w => w.bbox.x1)),
      y1: Math.max(...words.map(w => w.bbox.y1))
    }
  }

  /**
   * The base-14 face that best matches what the ink looks like.
   *
   * Weight, slant and monospace are MEASURED off the pixels (see
   * `ocrFontDetect`), because the LSTM engine reports no font attributes at all
   * and the `font_name` it occasionally carries names a face that is not in
   * this document and could not be embedded anyway.
   *
   * Monospace is decided ONLY by the advances, and only when the run holds both
   * narrow and wide glyphs — see `advancesAreUniform`. A run of capitals cannot
   * say: every face sets capitals at almost the same width.
   *
   * Serif against sans is NOT measured, and is not guessed either. Three cues
   * were calibrated against the base-14 faces rendered at OCR resolution —
   * stroke contrast, the flare at the foot of a stem, and the density of ink on
   * the baseline — and none of them separates Times from Helvetica: the two
   * overlap completely on all three (`tools/ocr-calibrate`). A coin flip that
   * changes the typeface of a whole document is worse than a consistent default
   * the user can see and change in one click, so sans is the default and OCR's
   * own `font_name` is used only when it actually says something.
   */
  function chooseFace(
    cues: ReturnType<typeof detectFace>,
    uniform: boolean | null,
    reported: string | undefined
  ): { fontFamily: string; bold: boolean; italic: boolean } {
    const name = (reported || '').toLowerCase()
    // Only the ADVANCES may call a run monospaced.
    //
    // The pixel cue — thick-to-thin stroke ratio — separates Courier cleanly on
    // a clean render, and not at all on a scan: on blurred bold capitals it
    // reads high because the crossbars fall inside the stem window, and it set
    // a row of Helvetica-Bold headings in Courier at half again their size.
    // Cues that only work on material this feature never sees are worse than no
    // cue, so it is now reported for inspection and nothing else.
    const mono = uniform === true
    let fontFamily = 'Helvetica'
    if (mono) fontFamily = 'Courier'
    else if (/times|serif|roman|georgia|garamond|book|minion/.test(name)) fontFamily = 'Times-Roman'

    return {
      fontFamily,
      bold: cues.bold || /bold|black|heavy/.test(name),
      italic: cues.italic || /italic|oblique/.test(name)
    }
  }

  /** Fraction of box `a` that box `b` covers. */
  function overlapFraction(a: Box, b: Box): number {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
    const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
    if (w <= 0 || h <= 0) return 0
    const area = Math.max((a.x1 - a.x0) * (a.y1 - a.y0), 1)
    return (w * h) / area
  }

  /**
   * How much of `a` is covered by ALL of `boxes` together.
   *
   * Approximated by summing the pairwise intersections. Boxes that overlap each
   * other are double-counted, which can only make the answer larger — and the
   * answer is used to REJECT, so the error costs a doubtful run rather than
   * admitting a wrong one.
   */
  function coveredFraction(a: Box, boxes: Box[]): number {
    const area = Math.max((a.x1 - a.x0) * (a.y1 - a.y0), 1)
    let covered = 0
    for (const b of boxes) {
      const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
      const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
      if (w > 0 && h > 0) covered += w * h
    }
    return covered / area
  }

  /**
   * Build the editable runs for one recognition pass.
   *
   * @param mapBox turns a box in THIS pass's pixel space into page-space points
   */
  function buildItems(
    data: any,
    ctx: CanvasRenderingContext2D,
    pageIndex: number,
    toPt: number,
    seq: { n: number },
    vertical: boolean,
    mapBox: (b: Box) => { x: number; y: number; width: number; height: number }
  ): OcrTextItem[] {
    const items: OcrTextItem[] = []

    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        const lines = para.lines ?? []
        for (const line of lines) {
          const allWords = (line.words ?? []).filter((w: any) => (w.text ?? '').trim())
          if (!allWords.length) continue
          const lineText = allWords.map((w: any) => w.text).join(' ')
          const lineEm = emOf(allWords, line.bbox.y1 - line.bbox.y0, lineText)

          for (const run of splitRuns(allWords, lineEm)) {
            const text = run.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim()
            if (!text) continue

            const bb = unionBox(run)
            const pxRect = { x: bb.x0, y: bb.y0, width: bb.x1 - bb.x0, height: bb.y1 - bb.y0 }
            if (pxRect.width < 2 || pxRect.height < 2) continue

            const emPx = emOf(run, pxRect.height, text)
            const { color } = sampleLineColors(ctx, pxRect)
            const background = samplePatchColor(ctx, pxRect)

            // The baseline OCR reports is the whole LINE's, and a run taken out
            // of that line sits on the same one. The face detector needs it:
            // without it, it would look for serif feet in the middle of the
            // x-height and measure stroke widths across a crossbar.
            const baseY = line.baseline
              ? (line.baseline.y0 + line.baseline.y1) / 2
              : bb.y1 - pxRect.height * 0.2
            const cues = detectFace(ctx, pxRect, emPx, baseY)
            const uniform = advancesAreUniform(
              run.flatMap((w: any) => (w.symbols ?? []).map((s: any) => s.bbox)),
              text
            )
            const face = chooseFace(cues, uniform, run[0]?.font_name)
            // The em has to be re-derived once the family is known: it comes
            // from the tallest glyph box, and how much of an em that is depends
            // on the face.
            const emCorrected = face.fontFamily === 'Courier'
              ? emPx * (GLYPH_BOX_PER_EM / GLYPH_BOX_PER_EM_MONO)
              : emPx


            // The baseline's slope is the line's own skew. A sideways pass has
            // already been turned upright, so its slope is measured in that
            // frame and says nothing about how the run sits on the page.
            const base = line.baseline
            const rotation = !vertical && base
              ? Math.round(Math.atan2(base.y1 - base.y0, Math.max(base.x1 - base.x0, 1)) * (180 / Math.PI) * 10) / 10
              : 0

            const conf = run.reduce((s: number, w: any) => s + (w.confidence ?? 0), 0) / run.length

            items.push({
              id: `${pageIndex}:ocr:${seq.n++}`,
              pageIndex,
              originalText: text,
              text,
              rect: mapBox(bb),
              words: run.map((word: any) => mapBox(word.bbox)),
              fontSize: Math.max(4, Math.round(emCorrected * toPt * 10) / 10),
              fontFamily: face.fontFamily,
              bold: face.bold,
              italic: face.italic,
              color,
              background,
              // A run split out of a line IS its own box, so there is nothing
              // left for it to be aligned within; only a whole line can say.
              align: run.length === allWords.length
                ? inferAlign(bb, para.bbox, lines.length)
                : 'left',
              rotation,
              vertical,
              confidence: Math.round(conf),
              edited: false,
              removed: false
            })
          }
        }
      }
    }
    return items
  }

  /**
   * Recognise one page.
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
    lang = 'spa',
    readVertical = true
  ): Promise<OcrPageResult | null> {
    if (busy.value) return null
    busy.value = true
    error.value = null
    progress.value = 0

    try {
      // OCR reads its own rasterisation, not the one on screen: accuracy falls
      // off badly below ~200 DPI, and the viewer's zoom is the user's business.
      const target = document.createElement('canvas')
      target.width = Math.round(pageWidth * (OCR_DPI / PDF_DPI))
      target.height = Math.round(pageHeight * (OCR_DPI / PDF_DPI))
      const tctx = target.getContext('2d', { willReadFrequently: true })
      if (!tctx) throw new Error('Could not prepare the page for recognition')
      tctx.drawImage(canvas, 0, 0, target.width, target.height)

      const w = await ensureWorker(lang)
      stage.value = 'Recognising text...'
      const { data } = await w.recognize(target, {}, { blocks: true })

      // Canvas pixels -> page points.
      const toPt = pageWidth / target.width
      const seq = { n: 0 }
      const items = buildItems(data, tctx, pageIndex, toPt, seq, false, b => ({
        x: b.x0 * toPt,
        y: b.y0 * toPt,
        width: (b.x1 - b.x0) * toPt,
        height: (b.y1 - b.y0) * toPt
      }))

      let verticalCount = 0
      if (readVertical) {
        const sideways = await addVerticalRuns(target, tctx, pageIndex, toPt, seq, items, w)
        verticalCount = sideways.length
      }

      let confSum = 0
      for (const it of items) confSum += it.confidence

      return {
        pageIndex,
        items,
        pageWidth,
        pageHeight,
        confidence: items.length ? Math.round(confSum / items.length) : 0,
        lang,
        verticalCount
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

  /**
   * A second pass for text set on its side.
   *
   * Tesseract reads a line left to right. A label printed up the side of a
   * chart is not a line to it — it comes back as nothing, or as a column of
   * unrelated single letters, and either way the user cannot edit it. The only
   * way to read it is to turn the page: the raster is rotated a quarter turn
   * clockwise, which stands bottom-to-top text up horizontally, and recognised
   * again.
   *
   * Everything that pass finds is speculative, so three things must hold before
   * a run is kept: it must be confident; it must be taller than it is wide once
   * mapped back, which is what vertical text looks like on the page; and the
   * upright pass must not already have read the same ink — otherwise every
   * ordinary line comes back a second time as gibberish read sideways.
   *
   * That last test is CUMULATIVE, over every upright run at once. Comparing
   * against one at a time let thirteen false runs through on a page with one
   * real one: a tall narrow box laid over a block of prose crosses six lines
   * and covers barely a sixth of each, so no single comparison ever looks like
   * a clash while the box is plainly sitting on top of the paragraph.
   *
   * And only SUBSTANTIAL upright runs count towards it. The upright pass reads
   * a sideways label as a column of unrelated single letters, and letting those
   * count would have the misreading of a label veto the correct reading of it.
   * Once a vertical run is accepted those misreadings are dropped: they are the
   * same ink, read the wrong way round.
   */
  async function addVerticalRuns(
    source: HTMLCanvasElement,
    sourceCtx: CanvasRenderingContext2D,
    pageIndex: number,
    toPt: number,
    seq: { n: number },
    into: OcrTextItem[],
    w: TesseractWorker
  ): Promise<OcrTextItem[]> {
    const H = source.height

    const rot = document.createElement('canvas')
    rot.width = source.height
    rot.height = source.width
    const rctx = rot.getContext('2d', { willReadFrequently: true })
    if (!rctx) return []
    // A quarter turn clockwise: source (x, y) lands at (H - y, x).
    rctx.translate(H, 0)
    rctx.rotate(Math.PI / 2)
    rctx.drawImage(source, 0, 0)

    stage.value = 'Looking for sideways text...'
    const { data } = await w.recognize(rot, {}, { blocks: true })

    const boxOf = (it: OcrTextItem): Box => ({
      x0: it.rect.x / toPt,
      y0: it.rect.y / toPt,
      x1: (it.rect.x + it.rect.width) / toPt,
      y1: (it.rect.y + it.rect.height) / toPt
    })
    const uprightBoxes = into
      .filter(it => it.text.replace(/\s/g, '').length >= 4 && it.confidence >= 60)
      .map(boxOf)

    const found = buildItems(data, rctx, pageIndex, toPt, seq, true, b => ({
      // Inverse of the quarter turn: rotated (x', y') came from (y', H - x').
      x: b.y0 * toPt,
      y: (H - b.x1) * toPt,
      width: (b.y1 - b.y0) * toPt,
      height: (b.x1 - b.x0) * toPt
    }))

    const kept: OcrTextItem[] = []
    for (const item of found) {
      if (item.confidence < VERTICAL_MIN_CONFIDENCE) continue
      if (item.text.replace(/\s/g, '').length < 2) continue
      if (item.rect.height < item.rect.width * VERTICAL_ASPECT) continue
      const box = {
        x0: item.rect.x / toPt,
        y0: item.rect.y / toPt,
        x1: (item.rect.x + item.rect.width) / toPt,
        y1: (item.rect.y + item.rect.height) / toPt
      }
      if (coveredFraction(box, uprightBoxes) > 0.30) continue

      // The colours were sampled on the rotated canvas, which was only ever a
      // means of reading the letters; re-read them where the run actually is.
      const pxRect = { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 }
      item.color = sampleLineColors(sourceCtx, pxRect).color
      item.background = samplePatchColor(sourceCtx, pxRect)
      kept.push(item)
      into.push(item)
    }

    // Drop the upright pass's attempts at this same ink. They are the single
    // letters a sideways label decomposes into when it is read left to right,
    // and leaving them puts a dozen meaningless boxes on top of the one box
    // that says what the label actually is.
    for (const run of kept) {
      const vbox = boxOf(run)
      for (let i = into.length - 1; i >= 0; i--) {
        const other = into[i]
        if (other === run || other.vertical) continue
        if (overlapFraction(boxOf(other), vbox) > 0.55) into.splice(i, 1)
      }
    }
    return kept
  }

  async function destroy() {
    if (worker.value) {
      await worker.value.terminate().catch(() => {})
      worker.value = null
      workerLang = ''
    }
  }

  return { busy, progress, stage, error, judgeScanned, recognizePage, destroy }
}
