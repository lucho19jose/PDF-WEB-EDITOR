import type { OcrEngine, OcrLine, OcrRecognition, OcrRecognizeOptions } from '../ocrEngine'

/**
 * Mistral OCR, opt-in: the page image LEAVES THE MACHINE.
 *
 * The caller (EditorLayout) asks for consent once per session and holds the
 * key; this adapter only speaks the protocol. The API answers with blocks —
 * a paragraph, a title, a table — each with a box in pixels of the image sent
 * and its content as markdown. A block is coarser than a line, so its content
 * is split on newlines and the lines are spread evenly down the block's box.
 * Good for prose; a table comes back as one block, which reads as one run.
 *
 * Field names are those documented for OCR 3/4 (`blocks[].top_left_x` …).
 * The response is treated as untrusted: anything missing falls back to one
 * line per markdown line over the whole page, never to a throw.
 */
export const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr'

export class MistralEngine implements OcrEngine {
  readonly id = 'mistral' as const
  readonly label = 'Mistral OCR (cloud)'
  /** Set by the layout before use; never persisted here. */
  apiKey = ''
  /** Override for a same-origin proxy when the API refuses browser origins. */
  endpoint = MISTRAL_OCR_URL

  async ready(): Promise<void> {
    if (!this.apiKey) throw new Error('Mistral OCR needs an API key — paste one in OCR settings')
    if (!navigator.onLine) throw new Error('Mistral OCR needs a network connection')
  }

  async recognize(canvas: HTMLCanvasElement, opts: OcrRecognizeOptions): Promise<OcrRecognition> {
    await this.ready()
    opts.onProgress?.('Sending the page to Mistral...', 5)
    const dataUrl = canvas.toDataURL('image/png')
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: 'mistral-ocr-latest',
        document: { type: 'image_url', image_url: dataUrl },
        include_blocks: true,
        confidence_scores_granularity: 'word'
      })
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Mistral OCR: HTTP ${res.status}${body ? ` — ${body.slice(0, 160)}` : ''}`)
    }
    opts.onProgress?.('Reading the answer...', 80)
    const json: any = await res.json()
    return { lines: toLines(json, canvas.width, canvas.height) }
  }

  async destroy(): Promise<void> { /* nothing held */ }
}

function toLines(json: any, width: number, height: number): OcrLine[] {
  const page = json?.pages?.[0]
  if (!page) return []
  // The API reports its own image dimensions; boxes are in that space.
  const dims = page.dimensions ?? {}
  const sx = dims.width ? width / dims.width : 1
  const sy = dims.height ? height / dims.height : 1
  const lines: OcrLine[] = []
  const blocks: any[] = Array.isArray(page.blocks) ? page.blocks : []
  const pushBlock = (box: { x0: number; y0: number; x1: number; y1: number }, content: string, confidence: number) => {
    const rows = String(content ?? '').split(/\r?\n/).map(s => stripMarkdown(s)).filter(s => s.trim())
    if (!rows.length) return
    const rowH = (box.y1 - box.y0) / rows.length
    rows.forEach((text, i) => {
      lines.push({
        box: { x0: box.x0, y0: box.y0 + i * rowH, x1: box.x1, y1: box.y0 + (i + 1) * rowH },
        text,
        confidence,
        paragraph: { box, lineCount: rows.length }
      })
    })
  }
  if (blocks.length) {
    for (const b of blocks) {
      if (b.type === 'image') continue
      const box = {
        x0: Number(b.top_left_x ?? 0) * sx, y0: Number(b.top_left_y ?? 0) * sy,
        x1: Number(b.bottom_right_x ?? 0) * sx, y1: Number(b.bottom_right_y ?? 0) * sy
      }
      if (box.x1 <= box.x0 || box.y1 <= box.y0) continue
      const conf = blockConfidence(b)
      pushBlock(box, b.content ?? b.markdown ?? '', conf)
    }
  }
  if (!lines.length && typeof page.markdown === 'string') {
    pushBlock({ x0: 0, y0: 0, x1: width, y1: height }, page.markdown, 70)
  }
  return lines
}

function blockConfidence(b: any): number {
  const cs = b.confidence_scores ?? b.confidence
  if (typeof cs === 'number') return cs <= 1 ? Math.round(cs * 100) : Math.round(cs)
  if (cs && typeof cs === 'object') {
    const v = cs.block ?? cs.mean ?? cs.average ?? cs.score
    if (typeof v === 'number') return v <= 1 ? Math.round(v * 100) : Math.round(v)
  }
  return 75
}

/** Markdown emphasis and table pipes are not on the page. */
function stripMarkdown(s: string): string {
  return s
    .replace(/^#{1,6}\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\|\s*|\s*\|$/g, '')
    .replace(/\s*\|\s*/g, '   ')
    .replace(/^[-:| ]+$/, '')
    .trim()
}
