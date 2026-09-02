/**
 * The contract every OCR engine answers to.
 *
 * Three recognisers feed the same editable model: Tesseract (in its own
 * worker, the richest output — words, glyph boxes, baselines), PaddleOCR
 * (ONNX Runtime Web in a worker — one box per text region, nothing finer) and
 * a cloud model (blocks with coordinates). `buildItems` in `useOCR` consumes
 * this shape and degrades honestly when an optional field is missing: no
 * `words` means no gap-splitting, no `symbols` means the em comes from the box
 * height, no `paragraph` means left alignment.
 *
 * Every box is in the PIXEL space of the canvas that was recognised, top-left
 * origin, y down.
 */

export interface OcrBox { x0: number; y0: number; x1: number; y1: number }

export interface OcrWord {
  text: string
  box: OcrBox
  /** 0–100 */
  confidence: number
  /** Per-glyph boxes, when the engine reports them. */
  symbols?: OcrBox[]
}

export interface OcrLine {
  box: OcrBox
  text: string
  /** 0–100 */
  confidence: number
  /** Word granularity, when the engine has it. */
  words?: OcrWord[]
  /** Baseline segment in canvas pixels, when the engine reports one. */
  baseline?: { x0: number; y0: number; x1: number; y1: number }
  /** Skew in degrees, clockwise, when the engine reports the box as a rotated quad. */
  angle?: number
  /** The paragraph the line belongs to, for alignment inference. */
  paragraph?: { box: OcrBox; lineCount: number }
}

export interface OcrRecognition {
  lines: OcrLine[]
}

export type OcrEngineId = 'paddle' | 'tesseract' | 'mistral'

export interface OcrRecognizeOptions {
  /** Tesseract language string, ignored by engines with one multilingual model. */
  lang: string
  /** Progress in 0–100 and a short stage label. */
  onProgress?: (stage: string, percent: number) => void
}

export interface OcrEngine {
  readonly id: OcrEngineId
  /** Human name for the status line. */
  readonly label: string
  /** Load models / workers. Idempotent. Throws when the engine cannot run here. */
  ready(opts: { lang: string; onProgress?: (stage: string, percent: number) => void }): Promise<void>
  recognize(canvas: HTMLCanvasElement, opts: OcrRecognizeOptions): Promise<OcrRecognition>
  destroy(): Promise<void>
}

export const ENGINE_LABELS: Record<OcrEngineId, string> = {
  paddle: 'PaddleOCR',
  tesseract: 'Tesseract',
  mistral: 'Mistral OCR (cloud)'
}
