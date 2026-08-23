import { ref, shallowRef } from 'vue'
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js'
import type { OcrPageResult, OcrTextItem, OcrAlign, ScannedVerdict } from '@/utils/ocr/ocrTypes'
import { sampleLineColors, samplePatchColor } from '@/utils/ocr/ocrSampling'

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
   * A base-14 face that looks like what OCR saw.
   *
   * Tesseract names a font only sometimes, and never one that is actually
   * embedded here. What it does report is enough to tell a serif from a
   * monospace, which is the difference a reader notices; the user can change it
   * afterwards, which is why this only has to be close.
   */
  function pickFace(fontName: string | undefined): { fontFamily: string; bold: boolean; italic: boolean } {
    const n = (fontName || '').toLowerCase()
    const bold = /bold|black|heavy/.test(n)
    const italic = /italic|oblique/.test(n)
    if (/mono|courier|consol/.test(n)) return { fontFamily: 'Courier', bold, italic }
    if (/times|serif|roman|georgia|garamond|book/.test(n)) return { fontFamily: 'Times-Roman', bold, italic }
    return { fontFamily: 'Helvetica', bold, italic }
  }

  /**
   * Where a line sits within its paragraph tells you how it is aligned.
   *
   * A single line says nothing — one line is flush with itself. Only when a
   * paragraph has several can the pattern of their left and right edges mean
   * anything, so anything else stays left.
   */
  function inferAlign(lineBox: { x0: number; x1: number }, paraBox: { x0: number; x1: number }, lineCount: number): OcrAlign {
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
   * Recognise one page.
   *
   * @param canvas the page already rendered by the viewer, at any scale
   * @param pageIndex 0-based
   * @param pageWidth  page width in POINTS
   * @param pageHeight page height in POINTS
   */
  async function recognizePage(
    canvas: HTMLCanvasElement,
    pageIndex: number,
    pageWidth: number,
    pageHeight: number,
    lang = 'spa'
  ): Promise<OcrPageResult | null> {
    if (busy.value) return null
    busy.value = true
    error.value = null
    progress.value = 0

    try {
      // OCR reads its own rasterisation, not the one on screen: accuracy falls
      // off badly below ~200 DPI, and the viewer's zoom is the user's business.
      const scale = (OCR_DPI / PDF_DPI) * (pageWidth / Math.max(canvas.width, 1))
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
      const items: OcrTextItem[] = []
      let confSum = 0
      let confCount = 0
      let seq = 0

      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs ?? []) {
          const lines = para.lines ?? []
          for (const line of lines) {
            const text = (line.text ?? '').replace(/\s+/g, ' ').trim()
            if (!text) continue

            const bb = line.bbox
            const pxRect = { x: bb.x0, y: bb.y0, width: bb.x1 - bb.x0, height: bb.y1 - bb.y0 }
            if (pxRect.width < 2 || pxRect.height < 2) continue

            const { color } = sampleLineColors(tctx, pxRect)
            const background = samplePatchColor(tctx, pxRect)

            // Size from the tallest GLYPH box in the line.
            //
            // Measured against known type rather than derived: a 12pt line
            // rasterised at 220 DPI has a 36.7px em, and its tallest symbol box
            // comes back at 35.1px — so Tesseract's symbol boxes run at about
            // 0.95 em, not at the 0.7 a cap height would suggest. Using 0.7 put
            // every size 30% over.
            //
            // Not `rowAttributes` either: it is in the type definitions but the
            // values are not absolute pixel heights, and using them put sizes
            // out by a factor of about 2.6.
            const GLYPH_BOX_PER_EM = 0.95
            let capPx = 0
            for (const word of line.words ?? []) {
              for (const sym of word.symbols ?? []) {
                const h = sym.bbox.y1 - sym.bbox.y0
                if (h > capPx) capPx = h
              }
            }
            // A line with no symbol data at all still has its own box to go on.
            const emPx = capPx > 1 ? capPx / GLYPH_BOX_PER_EM : pxRect.height * 1.05
            const fontSize = Math.max(4, Math.round(emPx * toPt * 10) / 10)

            // The baseline's slope is the line's own rotation.
            const base = line.baseline
            const rotation = base
              ? Math.round(Math.atan2(base.y1 - base.y0, Math.max(base.x1 - base.x0, 1)) * (180 / Math.PI) * 10) / 10
              : 0

            const face = pickFace(line.words?.[0]?.font_name)
            const conf = line.confidence ?? 0
            confSum += conf
            confCount++

            items.push({
              id: `${pageIndex}:ocr:${seq++}`,
              pageIndex,
              originalText: text,
              text,
              rect: {
                x: pxRect.x * toPt,
                y: pxRect.y * toPt,
                width: pxRect.width * toPt,
                height: pxRect.height * toPt
              },
              words: (line.words ?? []).map(word => ({
                x: word.bbox.x0 * toPt,
                y: word.bbox.y0 * toPt,
                width: (word.bbox.x1 - word.bbox.x0) * toPt,
                height: (word.bbox.y1 - word.bbox.y0) * toPt
              })),
              fontSize,
              fontFamily: face.fontFamily,
              bold: face.bold,
              italic: face.italic,
              color,
              background,
              align: inferAlign(bb, para.bbox, lines.length),
              rotation,
              confidence: Math.round(conf),
              edited: false,
              removed: false
            })
          }
        }
      }

      return {
        pageIndex,
        items,
        pageWidth,
        pageHeight,
        confidence: confCount > 0 ? Math.round(confSum / confCount) : 0,
        lang
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
    if (worker.value) {
      await worker.value.terminate().catch(() => {})
      worker.value = null
      workerLang = ''
    }
  }

  return { busy, progress, stage, error, judgeScanned, recognizePage, destroy }
}
