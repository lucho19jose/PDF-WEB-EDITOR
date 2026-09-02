import { createWorker, type Worker as TesseractWorker } from 'tesseract.js'
import type { OcrEngine, OcrLine, OcrRecognition, OcrRecognizeOptions, OcrWord } from '../ocrEngine'

/**
 * Tesseract, as it has always run here: its own worker, language data served
 * from `/tessdata` (offline, no CDN), sparse-text page segmentation.
 *
 * SPARSE TEXT segmentation, not the library's default of one uniform block.
 * A form is a grid of short cells, and read as a single block the Chinese
 * supplier survey lost half of them — 公司地址, 联系人, the phone number, the
 * SWIFT code all absent. Measured on that page: mode 6 finds 15 of 30 expected
 * cells, automatic (3) 26, sparse (11) 28 with the fewest table borders read as
 * "|". On a prose scan sparse finds every expected phrase at 94% against 95%,
 * at about twice the time.
 */
export class TesseractEngine implements OcrEngine {
  readonly id = 'tesseract' as const
  readonly label = 'Tesseract'
  private worker: TesseractWorker | null = null
  private workerLang = ''
  private onProgress: ((stage: string, percent: number) => void) | undefined

  async ready(opts: { lang: string; onProgress?: (stage: string, percent: number) => void }): Promise<void> {
    this.onProgress = opts.onProgress
    if (this.worker && this.workerLang === opts.lang) return
    if (this.worker) {
      await this.worker.terminate().catch(() => {})
      this.worker = null
    }
    opts.onProgress?.('Loading the recogniser...', 0)
    const w = await createWorker(opts.lang, 1, {
      langPath: '/tessdata',
      gzip: true,
      logger: (m: any) => {
        if (m.status === 'recognizing text') this.onProgress?.('Recognising text...', Math.round((m.progress ?? 0) * 100))
        else if (typeof m.status === 'string') this.onProgress?.(m.status, 0)
      }
    })
    await w.setParameters({ tessedit_pageseg_mode: '11' as any })
    this.worker = w
    this.workerLang = opts.lang
  }

  async recognize(canvas: HTMLCanvasElement, opts: OcrRecognizeOptions): Promise<OcrRecognition> {
    await this.ready({ lang: opts.lang, onProgress: opts.onProgress })
    this.onProgress = opts.onProgress
    const { data } = await this.worker!.recognize(canvas, {}, { blocks: true })
    return { lines: flatten(data) }
  }

  async destroy(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate().catch(() => {})
      this.worker = null
      this.workerLang = ''
    }
  }
}

const toBox = (b: any) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 })

/** Tesseract's block → paragraph → line → word → symbol tree, as `OcrLine`s. */
function flatten(data: any): OcrLine[] {
  const lines: OcrLine[] = []
  for (const block of data?.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      const paraLines = para.lines ?? []
      for (const line of paraLines) {
        const words: OcrWord[] = (line.words ?? [])
          .filter((w: any) => (w.text ?? '').trim())
          .map((w: any) => ({
            text: w.text ?? '',
            box: toBox(w.bbox),
            confidence: w.confidence ?? 0,
            symbols: (w.symbols ?? []).map((s: any) => toBox(s.bbox))
          }))
        if (!words.length) continue
        const conf = words.reduce((s, w) => s + w.confidence, 0) / words.length
        lines.push({
          box: toBox(line.bbox),
          text: words.map(w => w.text).join(' '),
          confidence: conf,
          words,
          baseline: line.baseline
            ? { x0: line.baseline.x0, y0: line.baseline.y0, x1: line.baseline.x1, y1: line.baseline.y1 }
            : undefined,
          paragraph: { box: toBox(para.bbox), lineCount: paraLines.length }
        })
      }
    }
  }
  return lines
}
