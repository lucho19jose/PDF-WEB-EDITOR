import type { OcrTextItem } from './ocrTypes'
import type { TextBlock } from '@/engine/types'

/**
 * The page's own words beat the recogniser's spacing when the two agree
 * letter for letter.
 *
 * PaddleOCR reads a line as one box and guesses where the word gaps are; on
 * bold capitals it guesses badly — the contract's title came back as
 * "CONTRATODEOBRAMAESTRA" while the page carried a text layer (Acrobat's OCR,
 * or this editor's own bake) reading "CONTRATO DE OBRA MAESTRA". The user then
 * edits a run with no spaces in it, and the words written back — the
 * invisible head of a partial redraw, a whole-run replacement — have none
 * either, so the page stops copying and searching as words.
 *
 * For each run, the text-layer blocks that sit on its ink (visible or not,
 * measured in page points, top-left origin) are joined in reading order; when
 * their letters, ignoring spaces and case, equal the run's — or contain them
 * as one stretch — the run takes the layer's spacing for that stretch, and
 * nothing else: the recogniser's box, size, colours and face all stay. The
 * glyph cut counts non-space characters, so it is unaffected.
 */
export function snapItemsToTextLayer(items: OcrTextItem[], blocks: TextBlock[]): { items: OcrTextItem[]; snapped: number } {
  if (!items.length || !blocks.length) return { items, snapped: 0 }
  let snapped = 0
  const out = items.map(item => {
    if (item.vertical) return item
    const ink = item.inkRect ?? item.rect
    const y0 = ink.y, y1 = ink.y + ink.height, x0 = ink.x, x1 = ink.x + ink.width
    const onRun = blocks.filter(b => {
      const bx0 = Math.min(b.bbox[0], b.bbox[2]), bx1 = Math.max(b.bbox[0], b.bbox[2])
      const by0 = Math.min(b.bbox[1], b.bbox[3]), by1 = Math.max(b.bbox[1], b.bbox[3])
      const vy = Math.min(y1, by1) - Math.max(y0, by0)
      const vx = Math.min(x1, bx1) - Math.max(x0, bx0)
      return vy > 0.6 * Math.min(ink.height, by1 - by0) && vx > 0
    }).sort((a, b) => Math.min(a.bbox[0], a.bbox[2]) - Math.min(b.bbox[0], b.bbox[2]))
    if (!onRun.length) return item
    const layerText = onRun.map(b => b.text).join(' ').replace(/\s+/g, ' ').trim()
    const snapped1 = snapText(item.text, layerText)
    if (snapped1 === null || snapped1 === item.text) return item
    snapped++
    return { ...item, text: snapped1, originalText: item.originalText === item.text ? snapped1 : item.originalText }
  })
  return { items: out, snapped }
}

const fold = (s: string) => s.normalize('NFC').toLowerCase()
const noSpace = (s: string) => s.replace(/\s+/g, '')

/**
 * The layer's spelling of `read` — with the layer's spaces — when the two
 * agree on every letter, or null. The comparison is space-free and
 * case-insensitive; the result keeps the LAYER's case and spacing, since its
 * letters were vouched for by the agreement.
 */
export function snapText(read: string, layerText: string): string | null {
  const target = noSpace(fold(read))
  if (target.length < 2) return null
  const layerFolded = fold(layerText)
  // Map every non-space character of the layer text to its index.
  const idx: number[] = []
  const chars = [...layerFolded]
  let flat = ''
  chars.forEach((c, i) => { if (!/\s/.test(c)) { flat += c; idx.push(i) } })
  const at = flat.indexOf(target)
  if (at < 0) return null
  // A stretch inside the layer's line must begin and end at word edges, or
  // the run is a piece of a word the recogniser broke — leave that alone.
  const first = idx[at], last = idx[at + target.length - 1]
  const layerChars = [...layerText]
  if (first > 0 && !/\s/.test(chars[first - 1])) return null
  if (last < chars.length - 1 && !/\s/.test(chars[last + 1])) return null
  return layerChars.slice(first, last + 1).join('').replace(/\s+/g, ' ').trim()
}
