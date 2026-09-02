/// <reference lib="webworker" />

import type { WorkerRequest, WorkerResponse } from './worker-protocol'
import { glyphNameToUnicode } from './glyphNames'
import * as opentype from 'opentype.js'
import type {
  TextBlock, TextChar, TextLine, PageTextData,
  BlockTransformOp, BlockStyleOp, BlockTransformResult, ContentImageInfo,
  ImageOrient, ImageAlign
} from '../types'

// MuPDF module — loaded dynamically to catch errors
let mupdf: typeof import('mupdf') | null = null
let pdfDoc: any = null // mupdf.PDFDocument

// Font encoding cache: fontName → { unicodeToGlyph, glyphToUnicode, codeBytes } (null = no ToUnicode CMap)
const fontEncodingCache = new Map<string, {
  unicodeToGlyph: Map<number, number>
  glyphToUnicode: Map<number, number>
  glyphToText?: Map<number, string>
  codeBytes?: number
} | null>()

function respond(msg: WorkerResponse) {
  self.postMessage(msg)
}

// Set up message handler IMMEDIATELY (before WASM loads)
self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data
  try {
    switch (req.type) {
      case 'init': {
        // Loading WASM
        try {
          mupdf = await import('mupdf')
          console.log('[MuPDF Worker] WASM ready')
        } catch (err: any) {
          console.error('[MuPDF Worker] Failed to load MuPDF:', err)
          throw new Error(`Failed to load MuPDF WASM: ${err.message || err}`)
        }
        respond({ id: req.id, type: 'success', data: { version: 'mupdf-wasm-ready' } })
        break
      }

      case 'loadDocument': {
        if (!mupdf) throw new Error('MuPDF not initialized — call init first')
        if (pdfDoc) {
          pdfDoc.destroy()
          pdfDoc = null
        }
        fontEncodingCache.clear()
        simpleFontInfoCache.clear()
        invalidateContentSources()
        const bytes = new Uint8Array(req.data.bytes)
        pdfDoc = new mupdf.PDFDocument(bytes)
        const pageCount = pdfDoc.countPages()
        respond({ id: req.id, type: 'success', data: { pageCount } })
        break
      }

      case 'getPageCount': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: { pageCount: pdfDoc.countPages() } })
        break
      }

      case 'getPageText': {
        if (!pdfDoc) throw new Error('No document loaded')
        const pageData = extractPageText(req.data.pageIndex)
        respond({ id: req.id, type: 'success', data: pageData })
        break
      }

      case 'readContentStream': {
        if (!pdfDoc) throw new Error('No document loaded')
        const streamStr = readContentStream(req.data.pageIndex)
        respond({ id: req.id, type: 'success', data: { stream: streamStr } })
        break
      }

      case 'writeContentStream': {
        if (!pdfDoc) throw new Error('No document loaded')
        writeContentStream(req.data.pageIndex, new Uint8Array(req.data.streamBytes))
        respond({ id: req.id, type: 'success', data: { written: true } })
        break
      }

      case 'replaceText': {
        if (!pdfDoc) throw new Error('No document loaded')
        // The CJK face is the substitute for text WinAnsi cannot hold; it is
        // fetched once, here, because the writers below are synchronous.
        await ensureCjkFontFor(req.data.newText)
        const result = replaceTextInStream(req.data.pageIndex, req.data.blockId, req.data.newText)
        respond({ id: req.id, type: 'success', data: result })
        break
      }

      case 'addText': {
        if (!pdfDoc) throw new Error('No document loaded')
        await ensureCjkFontFor(req.data.text)
        const addResult = addTextToPage(
          req.data.pageIndex, req.data.x, req.data.y,
          req.data.text, req.data.fontSize, req.data.fontName, req.data.color,
          req.data.rotation, req.data.faceId
        )
        respond({ id: req.id, type: 'success', data: addResult })
        break
      }

      case 'registerFace': {
        if (!mupdf) throw new Error('MuPDF not initialized')
        try {
          scanFaces.set(req.data.faceId, new mupdf.Font(req.data.faceId, new Uint8Array(req.data.bytes)))
          respond({ id: req.id, type: 'success', data: { success: true } })
        } catch (err: any) {
          respond({ id: req.id, type: 'success', data: { success: false, error: err?.message || String(err) } })
        }
        break
      }

      case 'transformTextBlock': {
        if (!pdfDoc) throw new Error('No document loaded')
        const transformResult = transformTextBlock(
          req.data.pageIndex, req.data.blockId,
          req.data.dx, req.data.dy,
          req.data.sx, req.data.sy,
          req.data.anchorX, req.data.anchorY
        )
        respond({ id: req.id, type: 'success', data: transformResult })
        break
      }

      case 'transformTextBlocks': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({
          id: req.id,
          type: 'success',
          data: transformTextBlocks(req.data.pageIndex, req.data.ops)
        })
        break
      }

      case 'restyleTextBlocks': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({
          id: req.id,
          type: 'success',
          data: restyleTextBlocks(req.data.pageIndex, req.data.ops)
        })
        break
      }

      case 'debugFonts': {
        if (!pdfDoc) throw new Error('No document loaded')
        const debugInfo = debugPageFonts(req.data.pageIndex)
        respond({ id: req.id, type: 'success', data: debugInfo })
        break
      }

      // Triage aid: the BT blocks each content source scans, as the matchers
      // see them. Read-only; drives no editing path.
      case 'debugBtBlocks': {
        if (!pdfDoc) throw new Error('No document loaded')
        const out: any[] = []
        for (const s of getContentSources(req.data.pageIndex)) {
          const blocks = withSource(s, () => scanBtBlocks(s.stream, req.data.pageIndex))
          out.push({
            key: s.key,
            invokeCtm: s.invokeCtm ?? null,
            blocks: blocks.map(b => ({
              start: b.start, end: b.end, xPos: b.xPos, yPos: b.yPos,
              hasPos: b.hasPos, hasTm: b.hasTm, fontRef: b.fontRef,
              text: b.decodedText.slice(0, req.data.maxLen ?? 60)
            }))
          })
        }
        respond({ id: req.id, type: 'success', data: out })
        break
      }

      case 'getPageSize': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: getPageSize(req.data.pageIndex) })
        break
      }

      // ===== ANNOTATIONS =====
      case 'getAnnotations': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: { annotations: listAnnotations(req.data.pageIndex) } })
        break
      }
      case 'addTextMarkup': {
        if (!pdfDoc) throw new Error('No document loaded')
        const d = req.data
        respond({ id: req.id, type: 'success', data: addTextMarkup(d.pageIndex, d.markupType, d.quads, d.color, d.opacity) })
        break
      }
      case 'addShape': {
        if (!pdfDoc) throw new Error('No document loaded')
        const d = req.data
        respond({ id: req.id, type: 'success', data: addShape(d.pageIndex, d.shapeType, d.rect, d.points, d.color, d.interiorColor, d.width, d.opacity) })
        break
      }
      case 'addInk': {
        if (!pdfDoc) throw new Error('No document loaded')
        const d = req.data
        respond({ id: req.id, type: 'success', data: addInk(d.pageIndex, d.strokes, d.color, d.width, d.opacity) })
        break
      }
      case 'addFreeText': {
        if (!pdfDoc) throw new Error('No document loaded')
        const d = req.data
        respond({ id: req.id, type: 'success', data: addFreeText(d.pageIndex, d.rect, d.text, d.fontSize, d.color, d.fontName) })
        break
      }
      case 'addStickyNote': {
        if (!pdfDoc) throw new Error('No document loaded')
        const d = req.data
        respond({ id: req.id, type: 'success', data: addStickyNote(d.pageIndex, d.x, d.y, d.text, d.color) })
        break
      }
      case 'addImageStamp': {
        if (!pdfDoc) throw new Error('No document loaded')
        const d = req.data
        respond({ id: req.id, type: 'success', data: addImageStamp(d.pageIndex, d.rect, new Uint8Array(d.imageBytes)) })
        break
      }
      case 'deleteAnnotation': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: deleteAnnotationAt(req.data.pageIndex, req.data.annotIndex) })
        break
      }
      case 'updateAnnotation': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: updateAnnotationAt(req.data) })
        break
      }

      // ===== PAGE MANAGEMENT =====
      case 'rotatePage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: rotatePage(req.data.pageIndex, req.data.degrees) })
        break
      }
      case 'rotateStampImage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: rotateStampImage(req.data.pageIndex, req.data.annotIndex) })
        break
      }
      case 'moveAnnotationToPage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: moveAnnotationToPage(req.data.pageIndex, req.data.annotIndex, req.data.targetPage, req.data.rect) })
        break
      }
      case 'listContentImages': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: listContentImages(req.data.pageIndex) })
        break
      }
      case 'transformContentImage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: transformContentImage(req.data.pageIndex, req.data.sourceKey, req.data.doOffset, req.data.name, req.data.rect) })
        break
      }
      case 'deleteContentImage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: deleteContentImage(req.data.pageIndex, req.data.sourceKey, req.data.doOffset, req.data.name) })
        break
      }
      case 'orientContentImage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: orientContentImage(req.data.pageIndex, req.data.sourceKey, req.data.doOffset, req.data.name, req.data.op) })
        break
      }
      case 'cropContentImage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: cropContentImage(req.data.pageIndex, req.data.sourceKey, req.data.doOffset, req.data.name, req.data.rect) })
        break
      }
      case 'alignContentImage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: alignContentImage(req.data.pageIndex, req.data.sourceKey, req.data.doOffset, req.data.name, req.data.mode, req.data.margin) })
        break
      }
      case 'reorderContentImage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: reorderContentImage(req.data.pageIndex, req.data.sourceKey, req.data.doOffset, req.data.name, req.data.where) })
        break
      }
      case 'replaceContentImage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: replaceContentImage(req.data.pageIndex, req.data.sourceKey, req.data.doOffset, req.data.name, req.data.imageBytes) })
        break
      }
      case 'flattenAnnotationBehind': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({
          id: req.id, type: 'success',
          data: flattenAnnotationBehind(req.data.pageIndex, req.data.annotIndex)
        })
        break
      }

      case 'drawImageInContent': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({
          id: req.id,
          type: 'success',
          data: drawImageInContent(
            req.data.pageIndex, req.data.rect,
            new Uint8Array(req.data.bytes), req.data.behind
          )
        })
        break
      }

      case 'fillRect': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: fillRect(req.data.pageIndex, req.data.rect, req.data.color) })
        break
      }

      case 'shiftGraphicsBelow': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({
          id: req.id, type: 'success',
          data: shiftGraphicsBelow(req.data.pageIndex, req.data.thresholdY, req.data.dy)
        })
        break
      }

      case 'mergePages': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: mergePages(req.data.bytes, req.data.atIndex) })
        break
      }

      case 'insertBlankPage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: insertBlankPage(req.data.atIndex, req.data.width, req.data.height) })
        break
      }
      case 'deletePageOp': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: deletePageOp(req.data.pageIndex) })
        break
      }
      case 'duplicatePage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: duplicatePage(req.data.pageIndex) })
        break
      }
      case 'movePage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: movePage(req.data.from, req.data.to) })
        break
      }

      // ===== SEARCH =====
      case 'searchPage': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: { hits: searchPage(req.data.pageIndex, req.data.needle, req.data.maxHits) } })
        break
      }
      case 'searchDocument': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: { hits: searchDocument(req.data.needle, req.data.maxHitsPerPage) } })
        break
      }

      case 'saveDocument': {
        if (!pdfDoc) throw new Error('No document loaded')
        // garbage=compact removes orphaned objects (e.g. content streams replaced
        // wholesale during edits) so the output doesn't bloat across edit cycles.
        const buf = pdfDoc.saveToBuffer('compress,garbage=compact')
        const savedBytes = buf.asUint8Array().slice()
        buf.destroy()
        // Transfer instead of structured-cloning the whole document
        self.postMessage(
          { id: req.id, type: 'success', data: { bytes: savedBytes.buffer } },
          [savedBytes.buffer] as any
        )
        break
      }

      case 'destroy': {
        if (pdfDoc) {
          pdfDoc.destroy()
          pdfDoc = null
        }
        fontEncodingCache.clear()
        simpleFontInfoCache.clear()
        respond({ id: req.id, type: 'success', data: null })
        break
      }

      default:
        throw new Error(`Unknown message type: ${(req as any).type}`)
    }
  } catch (err: any) {
    console.error('[MuPDF Worker] Error handling message:', req.type, err)
    // A trap in the WASM leaves this worker's heap unusable; the bridge
    // needs to know so it can respawn rather than keep asking a dead engine.
    const fatal = (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError)
    respond({ id: req.id, type: 'error', error: err.message || String(err), ...(fatal ? { fatal: true } : {}) })
  }
}

// Worker ready

// ==========================================
// TEXT EXTRACTION
// ==========================================

function extractPageText(pageIndex: number): PageTextData {
  if (!pdfDoc || !mupdf) throw new Error('No document or engine')

  const page = pdfDoc.loadPage(pageIndex)
  const stext = page.toStructuredText('preserve-whitespace')

  const blocks: TextBlock[] = []
  const lines: TextLine[] = []
  let currentBlock: TextBlock | null = null
  let currentLine: TextLine | null = null
  let blockIndex = 0

  try {
  stext.walk({
    beginTextBlock(bbox: number[]) {
      currentBlock = {
        id: `${pageIndex}:${blockIndex}`,
        pageIndex,
        x: bbox[0],
        y: bbox[1],
        width: bbox[2] - bbox[0],
        height: bbox[3] - bbox[1],
        bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
        text: '',
        fontName: '',
        fontSize: 0,
        isBold: false,
        isItalic: false,
        color: [0, 0, 0],
        chars: []
      }
      blockIndex++
    },

    beginLine(bbox: number[], wmode: number, _direction: number[]) {
      currentLine = {
        bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
        wmode,
        chars: [],
        text: ''
      }
    },

    onChar(c: string, origin: number[], font: any, size: number, quad: number[], color: number[]) {
      const charData: TextChar = {
        c,
        origin: [origin[0], origin[1]],
        quad: [quad[0], quad[1], quad[2], quad[3], quad[4], quad[5], quad[6], quad[7]],
        size,
        fontName: font.getName(),
        color: color && color.length >= 3
          ? [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0]
          : undefined
      }

      if (currentLine) {
        currentLine.chars.push(charData)
        currentLine.text += c
      }

      if (currentBlock) {
        currentBlock.chars.push(charData)
        currentBlock.text += c

        if (currentBlock.chars.length === 1) {
          currentBlock.fontName = font.getName()
          currentBlock.fontSize = size
          currentBlock.isBold = font.isBold()
          currentBlock.isItalic = font.isItalic()
          if (color && color.length >= 3) {
            currentBlock.color = [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0]
          }
        }
      }
    },

    endLine() {
      if (currentLine && currentLine.chars.length > 0) {
        lines.push(currentLine)
      }
      currentLine = null
    },

    endTextBlock() {
      if (currentBlock && currentBlock.chars.length > 0) {
        blocks.push(currentBlock)
      }
      currentBlock = null
    }
  })
  } finally {
    stext.destroy()
    page.destroy()
  }

  // The same char objects sit in both `lines` and `blocks`, so marking them
  // through the lines marks the blocks — and survives the split below, which
  // copies the objects rather than rebuilding them.
  markUnreadableGlyphs(pageIndex, lines)

  // Split blocks at significant horizontal gaps so each text segment
  // becomes its own clickable/movable element (e.g., "Label:" and "Value"
  // on the same line become separate blocks instead of one big block)
  const splitBlocks = splitBlocksAtGaps(blocks, pageIndex)

  return { pageIndex, blocks: splitBlocks, lines }
}

/** What a well-behaved ToUnicode legitimately expands ONE glyph to. */
const LIGATURE_TEXT = /^(ff|fi|fl|ffi|ffl|ft|st|Th|ij|IJ|[a-z]{2,3})$/
/**
 * A CID subset with this few printable codes and at least one proven lie is a
 * CJK subset in disguise: every glyph it draws is a lie, including the ones
 * that happen to claim a single plausible letter.
 */
const TINY_SUBSET_CODES = 32

/**
 * Mark the glyphs whose ToUnicode entry is provably wrong.
 *
 * A signed order re-subsetted by a Chinese generator maps CJK glyphs to Latin
 * junk: `<0005>` → "i:l", `<003E>` → "El", `<0004>` → "f". CFF subsets carry no
 * Unicode of their own, so the real characters are unrecoverable, and matching
 * must go on comparing the junk against the stream's decode of the same junk.
 * What CAN be told is which glyphs are lying, so an editor can show the drawn
 * glyph instead of the junk and refuse to retype it.
 *
 * The tell is in the quads. MuPDF gives the FIRST character of a multi-char
 * destination the glyph's advance and every further one a zero-width quad at
 * its right edge (measured: `"i"(adv) ":"(0) "l"(0)`). A real ligature does the
 * same, so the joined string is checked against the ligature shapes first;
 * "i:l", "El" and U+FFFD are lies.
 *
 * Single-letter lies ("f", "H", "M") are indistinguishable from real text on
 * their own. They are caught at FONT level: a font already caught lying whose
 * ToUnicode holds no more than `TINY_SUBSET_CODES` printable codes is a CJK
 * subset, and everything it draws is marked. A big font with one lying glyph
 * (`*Verdana-14399`: 170 codes, one "El") keeps per-glyph marking, so the date
 * it also draws stays editable.
 */
function markUnreadableGlyphs(pageIndex: number, lines: TextLine[]) {
  const lyingFonts = new Set<string>()

  for (const line of lines) {
    const chars = line.chars
    let i = 0
    while (i < chars.length) {
      const head = chars[i]
      if (head.c === '�') {
        head.unreadable = true
        lyingFonts.add(head.fontName)
        i++
        continue
      }
      const rightEdge = head.quad[2]
      let j = i + 1
      while (j < chars.length && isDestinationContinuation(chars[j], rightEdge, head.fontName)) j++
      if (j > i + 1) {
        const text = chars.slice(i, j).map(ch => ch.c).join('')
        if (!LIGATURE_TEXT.test(text)) {
          for (let k = i; k < j; k++) chars[k].unreadable = true
          lyingFonts.add(head.fontName)
        }
      }
      i = j
    }
  }
  if (lyingFonts.size === 0) return

  const tiny = new Set<string>()
  for (const name of lyingFonts) {
    if (isTinyLyingSubset(pageIndex, name)) tiny.add(name)
  }
  if (tiny.size === 0) return
  for (const line of lines) {
    for (const ch of line.chars) if (tiny.has(ch.fontName)) ch.unreadable = true
  }
}

/** A zero-width, non-space char of the same font sitting on the head's right edge. */
function isDestinationContinuation(ch: TextChar, rightEdge: number, fontName: string): boolean {
  if (ch.fontName !== fontName) return false
  if (/\s/.test(ch.c)) return false
  const width = Math.abs(ch.quad[2] - ch.quad[0])
  return width < 0.05 && Math.abs(ch.quad[0] - rightEdge) < 0.05
}

/** Structured-text font name and /BaseFont, made comparable. */
function normalizeFontName(name: string): string {
  return name
    .replace(/^\//, '')
    .replace(/#20/g, ' ')
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/-Identity-[HV]$/, '')
    .trim()
}

/**
 * Does the page font with this structured-text name have a tiny ToUnicode?
 *
 * Only the PAGE's own /Font dictionary is searched. A font that lives inside a
 * Form XObject is not found and the answer is no, which leaves that font with
 * per-glyph marking only — a miss, never a false positive.
 */
function isTinyLyingSubset(pageIndex: number, stextFontName: string): boolean {
  if (!pdfDoc) return false
  const wanted = normalizeFontName(stextFontName)
  let page: any = null
  try {
    page = pdfDoc.loadPage(pageIndex)
    const resources = resolveResources(page.getObject())
    const fontDict = resources?.get('Font')
    if (!fontDict || String(fontDict) === 'null') return false
    const resolvedDict = fontDict.resolve?.() ?? fontDict
    let refName: string | null = null
    resolvedDict.forEach((val: any, key: any) => {
      if (refName) return
      try {
        const base = val.resolve().get('BaseFont')
        const baseName = normalizeFontName(String(base?.asName?.() || base || ''))
        if (baseName === wanted) refName = String(key).replace(/^\//, '')
      } catch (_) { /* not a font we can read */ }
    })
    if (!refName) return false
    const enc = getFontEncoding(pageIndex, refName)
    if (!enc) return false
    let printable = enc.glyphToText?.size ?? 0
    for (const uni of enc.glyphToUnicode.values()) {
      if (uni > 0x20 && uni !== 0xA0 && uni !== 0xAD && uni !== 0xFFFD) printable++
    }
    return printable <= TINY_SUBSET_CODES
  } catch (_) {
    return false
  } finally {
    try { page?.destroy() } catch (_) { /* already destroyed */ }
  }
}

/**
 * Split TextBlocks at large horizontal gaps between characters.
 * MuPDF groups all text on the same line into one block, but for
 * move/resize we need finer granularity (like Adobe Acrobat).
 */
/** Room kept between wrapped text and the right edge of the page, in points. */
const PAGE_RIGHT_MARGIN = 20

/**
 * Leading given to lines this engine emits, as a multiple of the font size.
 * Mirrored by `lineStep` in TextBlockOverlay — see the note at `tdStep`.
 */
const LINE_LEADING = 1.4

/**
 * A TJ kern at least this wide, in thousandths of an em, is a word space.
 *
 * TeX draws inter-word space as a kern jump rather than as a space character —
 * `[(This)-333(is)]TJ` — so a paragraph decoded without this reads "Thisis…",
 * which never matches the text the page actually shows. Ordinary kerning pairs
 * are well under a tenth of an em, so the threshold sits between the two rather
 * than near either.
 */
const KERN_SPACE = 180

function splitBlocksAtGaps(blocks: TextBlock[], pageIndex: number): TextBlock[] {
  let subIndex = 0

  /** Create a TextBlock from a group of characters */
  function makeBlock(chars: TextChar[], parentBlock: TextBlock): TextBlock {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const ch of chars) {
      minX = Math.min(minX, ch.quad[0], ch.quad[4])
      minY = Math.min(minY, ch.quad[1], ch.quad[3])
      maxX = Math.max(maxX, ch.quad[2], ch.quad[6])
      maxY = Math.max(maxY, ch.quad[5], ch.quad[7])
    }
    const firstChar = chars[0]
    return {
      id: `${pageIndex}:${subIndex++}`,
      pageIndex,
      x: minX, y: minY,
      width: maxX - minX, height: maxY - minY,
      bbox: [minX, minY, maxX, maxY],
      text: chars.map(c => c.c).join(''),
      fontName: firstChar.fontName,
      fontSize: firstChar.size,
      isBold: parentBlock.isBold,
      isItalic: parentBlock.isItalic,
      // The parent's colour is only a fallback. MuPDF merges a paragraph into
      // one block and its colour is the first LINE's, so a line recoloured on
      // its own would report the paragraph's — which is what made the toolbar
      // show black for text the user had just turned blue.
      color: firstChar.color ?? parentBlock.color,
      chars
    }
  }

  const result: TextBlock[] = []

  for (const block of blocks) {
    if (block.chars.length < 2) {
      block.id = `${pageIndex}:${subIndex++}`
      result.push(block)
      continue
    }

    // Step 1: Split into lines by Y position
    // Group characters by baseline Y (chars on same line have similar Y)
    const lineMap = new Map<number, TextChar[]>()
    for (const ch of block.chars) {
      // Use origin Y rounded to nearest 0.5 for grouping
      const yKey = Math.round(ch.origin[1] * 2) / 2
      if (!lineMap.has(yKey)) lineMap.set(yKey, [])
      lineMap.get(yKey)!.push(ch)
    }

    // Sort lines by Y position (top to bottom in PDF coords)
    const lineKeys = [...lineMap.keys()].sort((a, b) => a - b)
    const lines: TextChar[][] = lineKeys.map(k => lineMap.get(k)!)

    // Step 2: For each line, split at horizontal gaps
    for (const lineChars of lines) {
      if (lineChars.length === 0) continue

      // Sort chars by X position (left to right)
      lineChars.sort((a, b) => a.origin[0] - b.origin[0])

      // Compute average char width for this line
      let totalW = 0, wCount = 0
      for (const ch of lineChars) {
        const cw = Math.abs(ch.quad[2] - ch.quad[0])
        if (cw > 0) { totalW += cw; wCount++ }
      }
      const avgCharW = wCount > 0 ? totalW / wCount : block.fontSize * 0.6
      const gapThreshold = Math.max(avgCharW * 3, block.fontSize * 1.5)

      // Find horizontal split points. Two kinds of column separator:
      //
      // - a GEOMETRIC gap between glyphs (kern-jump producers — nothing drawn
      //   between the cells);
      // - a RUN of whitespace GLYPHS wide enough to be a column gap. This
      //   fund-request form pads its amount strip with literal spaces —
      //   "S/    1,170.00S/    210.60S/ …" — so the four cells had no
      //   geometric gap anywhere and arrived as ONE block: clicking one
      //   amount opened an editor spanning four columns. The separator run
      //   is EXCLUDED from both segments (it belongs to neither cell); short
      //   runs and runs at the line's ends stay attached, so ordinary word
      //   spaces and trailing spaces read back exactly as before. A line of
      //   nothing but whitespace is kept whole — a blank form field is a
      //   legitimate block, not a separator.
      const isWs = (c: TextChar) => !c.c || /^\s+$/.test(c.c)
      const allWs = lineChars.every(isWs)
      // Count the whitespace-run separators first: a line carrying TWO or
      // more of them is a space-padded table strip, and there the cells that
      // touch — an amount right-aligned against the next column's "S/" — sit
      // a whole cell border apart (5.7pt here) yet under the prose threshold
      // (7.4pt at this 5pt font). Prose never shows two wide space runs, so
      // the evidence is cheap and the tighter geometric threshold applies to
      // THIS line only; intra-word gaps are two orders of magnitude smaller.
      let wsSeparators = 0
      if (!allWs) {
        for (let i = 0; i < lineChars.length;) {
          if (!isWs(lineChars[i])) { i++; continue }
          let j = i
          while (j < lineChars.length && isWs(lineChars[j])) j++
          if (j - i >= 3 && i > 0 && j < lineChars.length) {
            const prevEnd = Math.max(lineChars[i - 1].quad[2], lineChars[i - 1].quad[6])
            const nextStart = Math.min(lineChars[j].quad[0], lineChars[j].quad[4])
            if (nextStart - prevEnd > gapThreshold) wsSeparators++
          }
          i = j
        }
      }
      // The whole space-run treatment is gated on that same evidence: a line
      // with a SINGLE padded gap ("AZUFRE:   0.045% Máximo") is a label and
      // its value, and splitting those apart churned three corpus files for
      // no user-facing gain — the merged block was already editable. Only a
      // strip that pads BETWEEN several cells gets taken apart.
      const isStrip = wsSeparators >= 2
      const geomThreshold = isStrip
        ? Math.min(gapThreshold, Math.max(avgCharW * 2, block.fontSize * 0.9))
        : gapThreshold
      const segments: TextChar[][] = []
      let seg: TextChar[] = []
      let i = 0
      while (i < lineChars.length) {
        const ch = lineChars[i]
        if (isStrip && !allWs && isWs(ch)) {
          let j = i
          while (j < lineChars.length && isWs(lineChars[j])) j++
          if (j - i >= 3 && i > 0 && j < lineChars.length) {
            const prevEnd = Math.max(lineChars[i - 1].quad[2], lineChars[i - 1].quad[6])
            const nextStart = Math.min(lineChars[j].quad[0], lineChars[j].quad[4])
            if (nextStart - prevEnd > gapThreshold) {
              if (seg.length) segments.push(seg)
              seg = []
              i = j
              continue
            }
          }
          seg.push(ch)
          i++
          continue
        }
        if (seg.length) {
          const prev = seg[seg.length - 1]
          const gap = Math.min(ch.quad[0], ch.quad[4]) - Math.max(prev.quad[2], prev.quad[6])
          if (gap > geomThreshold) { segments.push(seg); seg = [] }
        }
        seg.push(ch)
        i++
      }
      if (seg.length) segments.push(seg)

      // Create a block for each segment
      for (const seg2 of segments) {
        if (seg2.length === 0) continue
        result.push(makeBlock(seg2, block))
      }
    }
  }

  return result
}

// ==========================================
// CONTENT STREAM READ / WRITE
// ==========================================

function readContentStream(pageIndex: number): string {
  if (!pdfDoc) throw new Error('No document')

  const page = pdfDoc.loadPage(pageIndex)
  const pageObj = page.getObject()
  const contents = pageObj.get('Contents')

  // Read as raw bytes to preserve non-UTF-8 characters (e.g., WinAnsi ñ = 0xF1)
  const chunks: Uint8Array[] = []

  // MuPDF quirk: readStream()/isStream() work on the INDIRECT reference but
  // not on the resolved object — resolving first made every array chunk read
  // as "not a stream", so multi-stream pages (Ghostscript output) appeared
  // EMPTY and nothing on them could be edited.
  function readChunk(obj: any): Uint8Array | null {
    // The candidates are built INSIDE the try: `resolve()` on MuPDF's null
    // object throws (it carries no document), and evaluating it while building
    // the array threw outside every guard — which is how an empty page took the
    // whole read down with it.
    let candidates: any[] = []
    try {
      candidates = [obj, obj?.resolve?.()]
    } catch (_) {
      candidates = [obj]
    }
    for (const target of candidates) {
      if (!target) continue
      try {
        const buf = target.readStream()
        const bytes = buf.asUint8Array().slice()
        buf.destroy()
        return bytes
      } catch (_) { /* try next */ }
    }
    return null
  }

  // A page created blank has /Contents set to MuPDF's NULL object — not JS
  // null, so a truthiness check waves it through. It is an empty stream, not an
  // error; treating it as one made every caller believe the page was unreadable.
  const hasContents = !!contents && String(contents) !== 'null'
  if (hasContents && typeof contents.isArray === 'function' && contents.isArray()) {
    for (let i = 0; i < contents.length; i++) {
      const bytes = readChunk(contents.get(i))
      if (bytes) chunks.push(bytes)
    }
  } else if (hasContents) {
    const bytes = readChunk(contents)
    if (bytes) chunks.push(bytes)
  }

  page.destroy()

  // Convert bytes to string using Latin-1 (byte-transparent: each byte maps 1:1 to a char)
  // This preserves raw bytes like 0xF1 (ñ) as char code 241
  // Join chunks with a newline separator between them. The PDF spec allows a
  // producer to split content streams at any token boundary; concatenating raw
  // bytes without whitespace can merge adjacent tokens (e.g. "Tj"+"ET" or two
  // numbers) and corrupt re-parsing.
  const sep = chunks.length > 1 ? chunks.length - 1 : 0
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0) + sep
  const allBytes = new Uint8Array(totalLen)
  let offset = 0
  for (let i = 0; i < chunks.length; i++) {
    allBytes.set(chunks[i], offset)
    offset += chunks[i].length
    if (i < chunks.length - 1) { allBytes[offset] = 0x0A; offset += 1 }
  }

  // Latin-1 decode: each byte becomes its corresponding code point
  let streamText = ''
  for (let i = 0; i < allBytes.length; i += 4096) {
    const slice = allBytes.subarray(i, Math.min(i + 4096, allBytes.length))
    streamText += String.fromCharCode(...slice)
  }

  return streamText
}

/**
 * Every content stream that can draw text on a page: the page's own, plus each
 * Form XObject it invokes with `Do`.
 *
 * Without this, whole generators are uneditable. TCPDF puts an entire page
 * inside one `/TPL0 Do` and leaves the page stream holding nothing but
 * `BT /F1 12 Tf ET`; Canva spreads text across thirty XObjects. MuPDF's text
 * extraction walks into them, so the UI shows blocks the editor could never
 * find — every edit failed with "Could not find matching text in content
 * stream".
 *
 * Nesting is followed to a small depth because it is load-bearing, not exotic:
 * TCPDF's page invokes /TPL0, and THAT form's stream invokes another /TPL0 from
 * its own resources — the real text is two levels down. Each level carries the
 * resource dict its own fonts resolve against, and a visited set guards against
 * a form that (directly or otherwise) invokes itself.
 */
interface ContentSource {
  key: string
  stream: string
  /** Resource dict fonts in this stream resolve against. */
  resources: any
  write(bytes: Uint8Array): void
  /** The Form XObject dict, when this source is one — its /BBox bounds the text. */
  formDict?: any
  /**
   * CTM that maps this source's coordinates into PAGE space: the form's own
   * /Matrix composed with the graphics state at its `Do` (and recursively with
   * the parent form's, when nested). Without it, a page-space drag applied to
   * text inside `0.24 0 0 -0.24 0 850 cm /X6 Do` moved 0.24x the ask and
   * upside down. Identity (absent) for the page's own stream. When a form is
   * invoked more than once the FIRST invocation's CTM is used.
   */
  invokeCtm?: Mat6
  /** Key of the source whose stream invokes this form ('page' or an ancestor form). */
  parentKey?: string
  /** Offset of this form's first `Do` within the parent's stream. */
  doOffset?: number
}

const MAX_XOBJECT_DEPTH = 4
/**
 * Ceiling on how many Form XObjects one page contributes.
 *
 * A Visio page invokes 230 of them. Reading and scanning every one on every
 * edit turned a 200ms operation into minutes — the editor simply hung. Sources
 * are ordered page-first and the search stops at the first match, so the cap
 * only bites when the text genuinely is not there; when it does, it is logged
 * rather than silently narrowing the search.
 */
const MAX_XOBJECT_SOURCES = 64

/** Content sources are re-read only when the document changes underneath us. */
let contentSourceCache = new Map<number, ContentSource[]>()
/**
 * EVERY node of the invocation tree ('page' + each form, text-bearing or not),
 * so a nested source's ancestors can be reached for clip/BBox widening even
 * when a wrapper form draws no text itself.
 */
let formNodeCache = new Map<number, Map<string, ContentSource>>()
function invalidateContentSources(pageIndex?: number) {
  if (pageIndex === undefined) { contentSourceCache = new Map(); formNodeCache = new Map() }
  else { contentSourceCache.delete(pageIndex); formNodeCache.delete(pageIndex) }
}

function getFormNode(pageIndex: number, key: string): ContentSource | null {
  getContentSources(pageIndex) // fills the cache
  return formNodeCache.get(pageIndex)?.get(key) ?? null
}

function getContentSources(pageIndex: number): ContentSource[] {
  if (!pdfDoc) return []
  const cached = contentSourceCache.get(pageIndex)
  if (cached) return cached
  const sources: ContentSource[] = []

  const pageStream = readContentStream(pageIndex)

  // /Rotate turns the page UNDER the content: extraction reports coordinates
  // in the rotated (visible) space while the stream draws in the raw one.
  // Composing the rotation into every source's invocation CTM makes deltas,
  // distance ranking and clip growth all operate in visible space — on a
  // 90-rotated page a "move right" used to land as "move up" while reporting
  // success.
  const baseCtm = pageRotationCtm(pageIndex) ?? undefined

  sources.push({
    key: 'page',
    stream: pageStream,
    resources: null, // null => the page's own Resources
    write: (bytes) => writeContentStream(pageIndex, bytes),
    invokeCtm: baseCtm
  })
  const nodes = new Map<string, ContentSource>()
  nodes.set('page', sources[0])

  let page: any = null
  try {
    page = pdfDoc.loadPage(pageIndex)
    const pageRes = page.getObject().get('Resources')
    const seen = new Set<string>()

    const walk = (stream: string, resources: any, path: string, depth: number, parentCtm: Mat6) => {
      if (depth > MAX_XOBJECT_DEPTH) return
      const xobjects = resources?.get?.('XObject')
      if (!xobjects || String(xobjects) === 'null') return

      // Only the forms this stream actually invokes. The first invocation's
      // offset is kept so the CTM in force at that `Do` can be replayed.
      const invokedAt = new Map<string, number>()
      for (const m of stream.matchAll(/\/([A-Za-z0-9_.+-]+)\s+Do(?![A-Za-z0-9])/g)) {
        if (!invokedAt.has(m[1])) invokedAt.set(m[1], m.index!)
      }
      const invoked = [...invokedAt.keys()]

      for (const name of invoked) {
        let ref: any
        try { ref = xobjects.get(name) } catch { continue }
        if (!ref || String(ref) === 'null') continue

        // Identity is the indirect reference, not the name: TCPDF nests a
        // /TPL0 inside /TPL0 (a different object), so name-based dedup would
        // stop at the wrapper and never reach the text. This still breaks a
        // genuine cycle.
        const id = String(ref)
        if (seen.has(id)) continue
        seen.add(id)

        let resolved: any
        try { resolved = ref.resolve() } catch { continue }
        if (String(resolved.get('Subtype') || '') !== '/Form') continue // images hold no text

        let text = ''
        try {
          const buf = ref.readStream()
          const bytes = buf.asUint8Array()
          for (let i = 0; i < bytes.length; i += 4096) {
            text += String.fromCharCode(...bytes.subarray(i, Math.min(i + 4096, bytes.length)))
          }
          buf.destroy()
        } catch { continue }

        // A Form XObject may omit /Resources and inherit from its parent.
        const ownRes = resolved.get('Resources')
        const childRes = (ownRes && String(ownRes) !== 'null') ? ownRes : resources

        if (sources.length > MAX_XOBJECT_SOURCES) return

        // Page space = form's /Matrix, then the CTM at its `Do`, then whatever
        // maps the PARENT stream to the page.
        let invokeCtm: Mat6 = matConcat(getCtmAtOffset(stream, invokedAt.get(name)!), parentCtm)
        try {
          const mtx = resolved.get('Matrix')
          if (mtx && String(mtx) !== 'null') {
            const arr = mtx.resolve ? mtx.resolve() : mtx
            const v = [0, 1, 2, 3, 4, 5].map(i => Number(String(arr.get(i))))
            if (v.every(n => Number.isFinite(n))) invokeCtm = matConcat(v as Mat6, invokeCtm)
          }
        } catch (_) { /* no /Matrix — identity */ }

        const key = path + '/' + name
        const target = ref
        const node: ContentSource = {
          key: 'xobj:' + key,
          stream: text,
          resources: childRes ?? pageRes,
          write: (bytes) => { target.writeStream(bytes) },
          formDict: resolved,
          invokeCtm,
          parentKey: path === '' ? 'page' : 'xobj:' + path,
          doOffset: invokedAt.get(name)!
        }
        nodes.set(node.key, node)
        if (/(?<![A-Za-z0-9])BT(?![A-Za-z0-9])/.test(text)) {
          sources.push(node)
        }
        walk(text, childRes ?? pageRes, key, depth + 1, invokeCtm)
      }
    }

    walk(pageStream, pageRes, '', 1, baseCtm ?? [1, 0, 0, 1, 0, 0])
  } catch (_) { /* fall back to the page stream alone */ }
  finally { try { page?.destroy() } catch (_) { /* already gone */ } }

  if (sources.length > MAX_XOBJECT_SOURCES + 1) {
    console.warn(`[MuPDF Worker] page ${pageIndex} has ${sources.length - 1} text-bearing ` +
      `Form XObjects; searching the first ${MAX_XOBJECT_SOURCES}`)
    sources.length = MAX_XOBJECT_SOURCES + 1
  }
  contentSourceCache.set(pageIndex, sources)
  formNodeCache.set(pageIndex, nodes)
  return sources
}

/** Run `fn` with font lookups and CTM composition scoped to a content source. */
function withSource<T>(src: ContentSource, fn: () => T): T {
  activeResources = src.resources ? { key: src.key, dict: src.resources } : null
  activeInvokeCtm = src.invokeCtm ?? null
  try { return fn() } finally { activeResources = null; activeInvokeCtm = null }
}

function writeContentStream(pageIndex: number, bytes: Uint8Array): void {
  if (!pdfDoc) throw new Error('No document')
  invalidateContentSources(pageIndex)

  const page = pdfDoc.loadPage(pageIndex)
  const pageObj = page.getObject()
  const contents = pageObj.get('Contents')

  if (contents.isArray()) {
    // readContentStream merged ALL array members — writing the merged bytes
    // into just the first element would draw members 1..n twice. Replace the
    // whole array with a single stream.
    const newStream = pdfDoc.addStream(bytes, {})
    pageObj.put('Contents', newStream)
  } else if (contents.isStream()) {
    contents.writeStream(bytes)
  } else {
    const newStream = pdfDoc.addStream(bytes, {})
    pageObj.put('Contents', newStream)
  }

  page.destroy()
}

// ==========================================
// FONT ENCODING — THE CORE OF REAL PDF EDITING
// ==========================================

/**
 * Parse a ToUnicode CMap stream and build bidirectional mappings.
 *
 * CMap format contains:
 *   beginbfchar / endbfchar — single glyph mappings: <glyphId> <unicode>
 *   beginbfrange / endbfrange — range mappings: <start> <end> <unicodeStart>
 */
function parseToUnicodeCMap(cmapText: string): {
  unicodeToGlyph: Map<number, number>
  glyphToUnicode: Map<number, number>
  glyphToText: Map<number, string>
  codeBytes: number
} {
  const unicodeToGlyph = new Map<number, number>()
  const glyphToUnicode = new Map<number, number>()
  const glyphToText = new Map<number, string>()
  // Track the code width: fonts with 1-byte codes write <41> keys; decoding
  // them with a fixed 2-byte stride turns "Hello" into CJK garbage.
  let maxKeyHexLen = 0

  // A destination is UTF-16BE and under no obligation to be ONE character.
  // Ligature subsets map a glyph to "ffi"; this signed order's re-subsetted
  // fonts map CJK glyphs to whatever Latin run their tool decided ("El" from
  // <0045006C>). parseInt on the whole hex made those glyphs decode as '?',
  // while MuPDF's extraction expands them — so the target text and the stream
  // decode could never agree, and the line containing such a glyph matched
  // nothing. Whether the mapping is semantically right is not this parser's
  // business: agreement with extraction is what matching runs on.
  const record = (glyphId: number, dstHex: string, keepExistingReverse = false) => {
    const setReverse = (u: number) => {
      if (!keepExistingReverse || !unicodeToGlyph.has(u)) unicodeToGlyph.set(u, glyphId)
    }
    if (dstHex.length <= 4) {
      const unicode = parseInt(dstHex, 16)
      glyphToUnicode.set(glyphId, unicode)
      setReverse(unicode)
      return
    }
    const units: number[] = []
    for (let i = 0; i + 4 <= dstHex.length; i += 4) units.push(parseInt(dstHex.slice(i, i + 4), 16))
    if (dstHex.length % 4 === 2) units.push(parseInt(dstHex.slice(-2), 16))
    const text = String.fromCharCode(...units)
    const cps = [...text]
    if (cps.length === 1) {
      // A surrogate pair is still ONE character (an astral code point).
      const u = text.codePointAt(0)!
      glyphToUnicode.set(glyphId, u)
      setReverse(u)
    } else {
      glyphToText.set(glyphId, text)
    }
  }

  // Parse bfchar entries: <glyphHex> <unicodeHex>
  const bfcharRegex = /beginbfchar\s([\s\S]*?)endbfchar/g
  let m: RegExpExecArray | null
  while ((m = bfcharRegex.exec(cmapText)) !== null) {
    const entries = m[1]
    const pairRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g
    let pair: RegExpExecArray | null
    while ((pair = pairRegex.exec(entries)) !== null) {
      const glyphId = parseInt(pair[1], 16)
      maxKeyHexLen = Math.max(maxKeyHexLen, pair[1].length)
      record(glyphId, pair[2])
    }
  }

  // Parse bfrange entries. The spec allows TWO destination forms and a naive
  // `<lo> <hi> <dst>` regex mishandles both halves of the problem: it skips the
  // array form entirely AND then re-matches triples of entries INSIDE the
  // array, inventing mappings that decode every glyph as '?' or worse. Qt's
  // output is entirely array-form, so its pages could not be edited at all.
  //
  //   <0001> <0003> <0041>                    incremental: 1→A, 2→B, 3→C
  //   <0001> <0003> [<0052> <0065> <0070>]    explicit list, one dst per code
  const bfrangeRegex = /beginbfrange\s([\s\S]*?)endbfrange/g
  while ((m = bfrangeRegex.exec(cmapText)) !== null) {
    const entries = m[1]
    // `<hex>` or a bracketed list, in order.
    const tokenRegex = /<([0-9A-Fa-f\s]+)>|(\[)|(\])/g
    const pending: string[] = []
    let inArray = false
    let arrayDst: string[] = []
    let lo: string | null = null, hi: string | null = null
    let tok: RegExpExecArray | null

    const firstCodePoint = (hex: string) => parseInt(hex.replace(/\s+/g, '').slice(0, 4) || '0', 16)
    const applyIncremental = (loHex: string, hiHex: string, dstHex: string) => {
      const start = parseInt(loHex, 16), end = parseInt(hiHex, 16)
      const base = firstCodePoint(dstHex)
      maxKeyHexLen = Math.max(maxKeyHexLen, loHex.length)
      // A corrupt range can span the whole 16-bit space; cap the work.
      for (let g = start; g <= end && g - start < 65536; g++) {
        const u = base + (g - start)
        glyphToUnicode.set(g, u)
        if (!unicodeToGlyph.has(u)) unicodeToGlyph.set(u, g)
      }
    }
    const applyArray = (loHex: string, dst: string[]) => {
      const start = parseInt(loHex, 16)
      maxKeyHexLen = Math.max(maxKeyHexLen, loHex.length)
      dst.forEach((d, i) => record(start + i, d, true))
    }

    while ((tok = tokenRegex.exec(entries)) !== null) {
      if (tok[2]) { inArray = true; arrayDst = []; continue }
      if (tok[3]) {
        inArray = false
        if (lo !== null) applyArray(lo, arrayDst)
        lo = hi = null
        pending.length = 0
        continue
      }
      const hex = tok[1].replace(/\s+/g, '')
      if (inArray) { arrayDst.push(hex); continue }
      pending.push(hex)
      if (pending.length === 2) { lo = pending[0]; hi = pending[1] }
      if (pending.length === 3) {
        applyIncremental(pending[0], pending[1], pending[2])
        lo = hi = null
        pending.length = 0
      }
    }
  }

  return { unicodeToGlyph, glyphToUnicode, glyphToText, codeBytes: maxKeyHexLen > 0 && maxKeyHexLen <= 2 ? 1 : 2 }
}

/**
 * Get font encoding for a font name (e.g., "F48") from the page's Resources.
 * Reads the ToUnicode CMap and caches the result.
 */
/**
 * Resource dictionary that font lookups should resolve against.
 *
 * Text is not always drawn by the page's own content stream: TCPDF wraps a
 * whole page in a single `/TPL0 Do`, and Canva emits dozens of Form XObjects.
 * Those carry their OWN /Resources, so while editing inside one, /F1 means a
 * different font than /F1 on the page. Set for the duration of one operation
 * (the worker handles one message at a time, so there is no interleaving) and
 * always cleared in a finally block.
 */
let activeResources: { key: string; dict: any } | null = null

/**
 * The active source's invocation CTM (see ContentSource.invokeCtm), consulted
 * by getFullCtmAtOffset so every page-space<->local conversion inside a Form
 * XObject includes the matrix the form is DRAWN under, not just the cm
 * operators inside its own stream.
 */
let activeInvokeCtm: Mat6 | null = null

/** CTM at `offset` composed with the active source's invocation CTM. */
function getFullCtmAtOffset(stream: string, offset: number): Mat6 {
  const local = getCtmAtOffset(stream, offset)
  return activeInvokeCtm ? matConcat(local, activeInvokeCtm) : local
}

/**
 * The matrix that maps RAW page user space onto the rotated (visible) space,
 * or null for an unrotated page. getBounds()/getPageSize are already rotated,
 * so width/height here are the VISIBLE ones.
 */
function pageRotationCtm(pageIndex: number): Mat6 | null {
  try {
    const size = getPageSize(pageIndex)
    if (size.rotation === 90) return [0, -1, 1, 0, 0, size.height]
    if (size.rotation === 270) return [0, 1, -1, 0, size.width, 0]
    if (size.rotation === 180) return [-1, 0, 0, -1, size.width, size.height]
  } catch (_) { /* unrotated */ }
  return null
}

/** Inverse of an affine Mat6, or null when singular. */
function matInvert(m: Mat6): Mat6 | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (Math.abs(det) < 1e-12) return null
  const ia = m[3] / det, ib = -m[1] / det, ic = -m[2] / det, id = m[0] / det
  return [ia, ib, ic, id, -(m[4] * ia + m[5] * ic), -(m[4] * ib + m[5] * id)]
}

/** Resources for the source currently being edited. */
function resolveResources(pageObj: any): any {
  return activeResources ? activeResources.dict : pageObj.get('Resources')
}

/** Cache-key prefix so page fonts and XObject fonts never collide. */
function sourceKey(): string {
  return activeResources ? activeResources.key : 'page'
}

function getFontEncoding(pageIndex: number, fontRefName: string): {
  unicodeToGlyph: Map<number, number>
  glyphToUnicode: Map<number, number>
  glyphToText?: Map<number, string>
  codeBytes?: number
} | null {
  const cacheKey = `${pageIndex}:${sourceKey()}:${fontRefName}`
  if (fontEncodingCache.has(cacheKey)) {
    return fontEncodingCache.get(cacheKey)!
  }

  if (!pdfDoc) return null

  let page: any = null
  try {
    page = pdfDoc.loadPage(pageIndex)
    const pageObj = page.getObject()
    const resources = resolveResources(pageObj)
    if (!resources) return null

    const fontDict = resources.get('Font')
    if (!fontDict) return null

    // Access font by name directly (fontDict.length doesn't work reliably)
    const fontObj = fontDict.get(fontRefName)
    if (!fontObj) {
      console.warn(`[MuPDF Worker] Font ${fontRefName} not found in Resources`)
      return null
    }

    const resolved = fontObj.resolve()

    // Try reading ToUnicode CMap — check both the font itself and as a stream reference
    const encoding = tryReadToUnicode(resolved)
    if (encoding) {
      fontEncodingCache.set(cacheKey, encoding)
      return encoding
    }

    // For Type0 fonts, check DescendantFonts
    const descendants = resolved.get('DescendantFonts')
    if (descendants && descendants.isArray()) {
      for (let i = 0; i < descendants.length; i++) {
        const desc = descendants.get(i).resolve()
        const descEncoding = tryReadToUnicode(desc)
        if (descEncoding) {
          fontEncodingCache.set(cacheKey, descEncoding)
          return descEncoding
        }
      }
    }

    console.warn(`[MuPDF Worker] No ToUnicode CMap for font ${fontRefName} — will use simple-encoding path`)
    fontEncodingCache.set(cacheKey, null)
    return null
  } catch (err) {
    console.error(`[MuPDF Worker] Error reading font encoding for ${fontRefName}:`, err)
    return null
  } finally {
    try { page?.destroy() } catch (_) { /* already destroyed */ }
  }
}

/**
 * Try to read a ToUnicode CMap from a font dictionary.
 */
function tryReadToUnicode(fontObj: any): {
  unicodeToGlyph: Map<number, number>
  glyphToUnicode: Map<number, number>
  glyphToText?: Map<number, string>
  codeBytes?: number
} | null {
  try {
    const toUnicode = fontObj.get('ToUnicode')
    const tuStr = String(toUnicode)
    if (!toUnicode || tuStr === 'null' || tuStr === 'undefined' || tuStr === '') return null

    // Try readStream on the raw reference first (MuPDF quirk: isStream works
    // on the indirect ref but not on the resolved object)
    const targets = [toUnicode, toUnicode.resolve?.()]
    for (const target of targets) {
      if (!target) continue
      try {
        if (target.isStream()) {
          const buf = target.readStream()
          const cmapText = buf.asString()
          buf.destroy()
          if (cmapText.length > 0) {
            // CMap parsed
            return parseToUnicodeCMap(cmapText)
          }
        }
      } catch (_) {
        // Try next target
      }
    }
  } catch (err: any) {
    console.error(`[MuPDF Worker] tryReadToUnicode error:`, err.message || err)
  }
  return null
}

/**
 * Encode a Unicode string into hex glyph IDs for a specific font.
 * Returns the hex string (e.g., "003200580057") or null if encoding fails.
 */
function encodeTextForFont(
  text: string,
  encoding: { unicodeToGlyph: Map<number, number>; codeBytes?: number },
  /**
   * Glyph code to use for a character, ahead of the reverse CMap. A subset's
   * ToUnicode routinely claims the SAME character for several glyphs, and the
   * reverse map then guesses which to write — on one signed order it picked a
   * glyph that claims 'l' but draws '1', and "al" came back "a1". A code the
   * run being edited already uses for a character is not a guess: it provably
   * drew that character on this very page.
   */
  preferCodes?: Map<number, number>
): { hex: string } | { error: string; missingChars: string[] } {
  let hex = ''
  const missingChars: string[] = []
  const pad = (encoding.codeBytes === 1 ? 1 : 2) * 2
  for (let i = 0; i < text.length; i++) {
    const codePoint = text.codePointAt(i)!
    const glyphId = preferCodes?.get(codePoint) ?? encoding.unicodeToGlyph.get(codePoint)
    if (glyphId === undefined) {
      missingChars.push(String.fromCodePoint(codePoint))
    } else {
      hex += glyphId.toString(16).padStart(pad, '0').toUpperCase()
    }
    // Handle surrogate pairs
    if (codePoint > 0xFFFF) i++
  }
  if (missingChars.length > 0) {
    const unique = [...new Set(missingChars)]
    return { error: `Characters not in font subset: ${unique.join(', ')}`, missingChars: unique }
  }
  return { hex }
}

// ==========================================
// SIMPLE FONT ENCODING (MacRoman / WinAnsi) + FONT SUBSTITUTION
// ==========================================

// MacRomanEncoding 0x80–0xFF → Unicode (0x00–0x7F is ASCII)
const MACROMAN_HIGH = [
  0x00C4, 0x00C5, 0x00C7, 0x00C9, 0x00D1, 0x00D6, 0x00DC, 0x00E1,
  0x00E0, 0x00E2, 0x00E4, 0x00E3, 0x00E5, 0x00E7, 0x00E9, 0x00E8,
  0x00EA, 0x00EB, 0x00ED, 0x00EC, 0x00EE, 0x00EF, 0x00F1, 0x00F3,
  0x00F2, 0x00F4, 0x00F6, 0x00F5, 0x00FA, 0x00F9, 0x00FB, 0x00FC,
  0x2020, 0x00B0, 0x00A2, 0x00A3, 0x00A7, 0x2022, 0x00B6, 0x00DF,
  0x00AE, 0x00A9, 0x2122, 0x00B4, 0x00A8, 0x2260, 0x00C6, 0x00D8,
  0x221E, 0x00B1, 0x2264, 0x2265, 0x00A5, 0x00B5, 0x2202, 0x2211,
  0x220F, 0x03C0, 0x222B, 0x00AA, 0x00BA, 0x03A9, 0x00E6, 0x00F8,
  0x00BF, 0x00A1, 0x00AC, 0x221A, 0x0192, 0x2248, 0x2206, 0x00AB,
  0x00BB, 0x2026, 0x00A0, 0x00C0, 0x00C3, 0x00D5, 0x0152, 0x0153,
  0x2013, 0x2014, 0x201C, 0x201D, 0x2018, 0x2019, 0x00F7, 0x25CA,
  0x00FF, 0x0178, 0x2044, 0x20AC, 0x2039, 0x203A, 0xFB01, 0xFB02,
  0x2021, 0x00B7, 0x201A, 0x201E, 0x2030, 0x00C2, 0x00CA, 0x00C1,
  0x00CB, 0x00C8, 0x00CD, 0x00CE, 0x00CF, 0x00CC, 0x00D3, 0x00D4,
  0xF8FF, 0x00D2, 0x00DA, 0x00DB, 0x00D9, 0x0131, 0x02C6, 0x02DC,
  0x00AF, 0x02D8, 0x02D9, 0x02DA, 0x00B8, 0x02DD, 0x02DB, 0x02C7
]

// WinAnsiEncoding (CP1252) 0x80–0x9F → Unicode (rest of high range is Latin-1)
const WINANSI_HIGH: Record<number, number> = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
  0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
  0x9E: 0x017E, 0x9F: 0x0178
}

let _unicodeToMacRoman: Map<number, number> | null = null
function unicodeToMacRoman(): Map<number, number> {
  if (!_unicodeToMacRoman) {
    _unicodeToMacRoman = new Map()
    for (let b = 0x20; b < 0x80; b++) _unicodeToMacRoman.set(b, b)
    for (let i = 0; i < 128; i++) _unicodeToMacRoman.set(MACROMAN_HIGH[i], 0x80 + i)
  }
  return _unicodeToMacRoman
}

let _unicodeToWinAnsi: Map<number, number> | null = null
function unicodeToWinAnsi(): Map<number, number> {
  if (!_unicodeToWinAnsi) {
    _unicodeToWinAnsi = new Map()
    for (let b = 0x20; b < 0x80; b++) _unicodeToWinAnsi.set(b, b)
    for (let b = 0xA0; b <= 0xFF; b++) _unicodeToWinAnsi.set(b, b)
    for (const [byte, uni] of Object.entries(WINANSI_HIGH)) _unicodeToWinAnsi.set(uni, Number(byte))
  }
  return _unicodeToWinAnsi
}

function byteToUnicode(byte: number, encodingName: string): number {
  if (byte < 0x80) return byte
  if (encodingName === 'MacRoman') return MACROMAN_HIGH[byte - 0x80]
  if (byte >= 0x80 && byte <= 0x9F && WINANSI_HIGH[byte] !== undefined) return WINANSI_HIGH[byte]
  return byte // Latin-1 / WinAnsi high range
}

interface SimpleFontInfo {
  encodingName: 'MacRoman' | 'WinAnsi' | 'Standard' | 'Unknown'
  firstChar: number
  lastChar: number
  widths: number[] | null
  baseFont: string
  flags: number
  isEmbedded: boolean
  isSubset: boolean
  /** /MissingWidth from the FontDescriptor (PDF default 0). */
  missingWidth: number
  isType0: boolean
  /**
   * Byte code -> glyph NAME, from the font's /Encoding /Differences array.
   *
   * This is what makes a LaTeX document readable. pdfTeX names every character
   * it uses and remaps the low codes, so byte 12 is the "fi" ligature and not a
   * form feed; decoded through a plain WinAnsi table the words come out as
   * control characters and nothing on the page can be matched.
   */
  differences: Map<number, string> | null
}

const simpleFontInfoCache = new Map<string, SimpleFontInfo | null>()

/**
 * Read encoding + glyph availability info for a simple (non-CID) font.
 * Widths of 0 inside [FirstChar..LastChar] indicate glyphs missing from a subset.
 */
function getSimpleFontInfo(pageIndex: number, fontRefName: string): SimpleFontInfo | null {
  const cacheKey = `${pageIndex}:${sourceKey()}:${fontRefName}`
  if (simpleFontInfoCache.has(cacheKey)) return simpleFontInfoCache.get(cacheKey)!
  if (!pdfDoc) return null

  let info: SimpleFontInfo | null = null
  try {
    const page = pdfDoc.loadPage(pageIndex)
    const pageObj = page.getObject()
    const fontObj = resolveResources(pageObj)?.get('Font')?.get(fontRefName)
    if (fontObj && String(fontObj) !== 'null') {
      const r = fontObj.resolve()
      const subtype = String(r.get('Subtype') || '')
      const baseFont = String(r.get('BaseFont') || '').replace(/^\//, '')

      let encodingName: SimpleFontInfo['encodingName'] = 'Unknown'
      const encObj = r.get('Encoding')
      const encStr = String(encObj || 'null')
      if (encStr.includes('MacRoman')) encodingName = 'MacRoman'
      else if (encStr.includes('WinAnsi')) encodingName = 'WinAnsi'
      else if (encStr.includes('Standard')) encodingName = 'Standard'
      else if (encObj && encStr !== 'null') {
        // Encoding dictionary — use BaseEncoding if present
        try {
          const baseEnc = String(encObj.resolve().get('BaseEncoding') || '')
          if (baseEnc.includes('MacRoman')) encodingName = 'MacRoman'
          else if (baseEnc.includes('WinAnsi')) encodingName = 'WinAnsi'
          // Standard was missing here, and it is the one LaTeX uses: an
          // /Encoding dictionary over /StandardEncoding left the font
          // 'Unknown', so its bytes were passed through raw and every such
          // document read as uneditable.
          else if (baseEnc.includes('Standard')) encodingName = 'Standard'
        } catch (_) { /* keep Unknown */ }
      } else if (encStr === 'null' && subtype !== '/Type0') {
        // No /Encoding: only NON-symbolic fonts default to StandardEncoding.
        // Symbolic embedded subsets (Ghostscript output: byte codes are raw
        // glyph indices 1..N) must NOT be treated as ASCII — flagged below
        // once Flags is read.
        encodingName = 'Standard'
      }

      // /Differences: [code /name /name ... code /name ...]
      let differences: Map<number, string> | null = null
      if (encObj && encStr !== 'null' && !encStr.startsWith('/')) {
        try {
          const arr = encObj.resolve().get('Differences')
          if (arr && String(arr) !== 'null' && typeof arr.length === 'number') {
            const map = new Map<number, string>()
            let code = 0
            for (let i = 0; i < arr.length; i++) {
              const str = String(arr.get(i))
              if (/^-?[\d.]+$/.test(str)) code = Math.round(parseFloat(str))
              else if (str.startsWith('/')) map.set(code++, str.slice(1))
            }
            if (map.size > 0) {
              differences = map
              // A font that NAMES its glyphs is not an opaque symbolic subset,
              // whatever its flags say — the names are the encoding.
              if (encodingName === 'Unknown') encodingName = 'Standard'
            }
          }
        } catch (_) { /* a font with no usable Differences array is not an error */ }
      }

      const firstChar = parseInt(String(r.get('FirstChar') || '0')) || 0
      const lastChar = parseInt(String(r.get('LastChar') || '255')) || 255
      let widths: number[] | null = null
      try {
        const wObj = r.get('Widths')
        if (wObj && String(wObj) !== 'null') {
          const wr = wObj.resolve ? wObj.resolve() : wObj
          widths = []
          for (let i = 0; i < wr.length; i++) widths.push(Number(String(wr.get(i))) || 0)
        }
      } catch (_) { widths = null }

      let flags = 0
      let isEmbedded = false
      let missingWidth = 0
      try {
        const fd = r.get('FontDescriptor')
        if (fd && String(fd) !== 'null') {
          const fdr = fd.resolve()
          flags = parseInt(String(fdr.get('Flags') || '0')) || 0
          isEmbedded = ['FontFile', 'FontFile2', 'FontFile3']
            .some(k => String(fdr.get(k) || 'null') !== 'null')
          missingWidth = Number(String(fdr.get('MissingWidth') || '0')) || 0
        }
      } catch (_) { /* ignore */ }

      // Symbolic font (Flags bit 3) with no explicit /Encoding → the byte
      // codes are font-internal glyph indices, not any standard encoding
      // A named encoding survives the symbolic flag: LaTeX marks its fonts
      // symbolic and still names every glyph it draws.
      if (encodingName === 'Standard' && (flags & 4) !== 0 && !differences) {
        encodingName = 'Unknown'
      }

      info = {
        differences,
        encodingName,
        firstChar,
        lastChar,
        widths,
        baseFont,
        flags,
        isEmbedded,
        isSubset: /^[A-Z]{6}\+/.test(baseFont),
        missingWidth,
        isType0: subtype === '/Type0'
      }
    }
    page.destroy()
  } catch (err) {
    console.warn(`[MuPDF Worker] getSimpleFontInfo failed for ${fontRefName}:`, err)
  }

  simpleFontInfoCache.set(cacheKey, info)
  return info
}

/**
 * Encode Unicode text into this simple font's byte encoding, verifying each
 * glyph actually exists in the (possibly subsetted) font.
 * Returns a Latin-1 byte string (charCode === byte value) or the missing chars.
 */
function encodeForSimpleFont(
  text: string,
  info: SimpleFontInfo
): { bytes: string } | { missing: string[] } {
  const table = info.encodingName === 'MacRoman' ? unicodeToMacRoman() : unicodeToWinAnsi()
  let bytes = ''
  const missing: string[] = []

  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const byte = table.get(cp)
    if (byte === undefined) { missing.push(ch); continue }

    // A character is only usable if the font gives it a non-zero ADVANCE.
    //
    // Two traps here, both hit by real Word output:
    //  - the BaseFont name is not evidence of subsetting. Word subsets without
    //    the "ABCDEF+" prefix, so gating this on `isSubset` skipped the check
    //    for one of the commonest producers there is.
    //  - embedding is not the deciding factor either. Even for a NON-embedded
    //    font the viewer takes advances from this Widths array, so a width of 0
    //    stacks every such glyph on one spot no matter which face substitutes
    //    for it. That is how "SWEEPMARK" came back out as "SWEPMARK": the
    //    doubled zero-width E landed twice in the same place.
    //
    // Widths absent entirely (the standard 14) means the viewer supplies its
    // own metrics, and the check is skipped.
    if (info.widths && info.widths.length > 0) {
      const inRange = byte >= info.firstChar && byte <= info.lastChar
      const width = inRange ? (info.widths[byte - info.firstChar] || 0) : info.missingWidth
      if (width === 0) {
        missing.push(ch)
        continue
      }
    }
    bytes += String.fromCharCode(byte)
  }

  if (missing.length > 0) return { missing: [...new Set(missing)] }
  return { bytes }
}

/** Encode text as WinAnsi bytes for a standard base-14 font. */
function encodeWinAnsiText(text: string): { bytes: string } | { missing: string[] } {
  const table = unicodeToWinAnsi()
  let bytes = ''
  const missing: string[] = []
  for (const ch of text) {
    const byte = table.get(ch.codePointAt(0)!)
    if (byte === undefined) missing.push(ch)
    else bytes += String.fromCharCode(byte)
  }
  if (missing.length > 0) return { missing: [...new Set(missing)] }
  return { bytes }
}

/**
 * Pick the best-matching standard base-14 font for a font we can't re-encode
 * (what Acrobat does when the original font isn't fully embedded/usable).
 */
function pickSubstituteFont(info: SimpleFontInfo | null, targetBlock?: TextBlock): string {
  const name = (info?.baseFont || targetBlock?.fontName || '').replace(/^[A-Z]{6}\+/, '').toLowerCase()
  const flags = info?.flags || 0

  const fixedPitch = (flags & 1) !== 0 || /courier|mono/.test(name)
  const serif = (flags & 2) !== 0 || /times|georgia|garamond|book|palatino|serif|roman/.test(name)
  const bold = targetBlock?.isBold || /bold|black|heavy/.test(name) || ((flags & 0x40000) !== 0)
  const italic = targetBlock?.isItalic || /italic|oblique/.test(name) || ((flags & 0x40) !== 0)

  if (fixedPitch) {
    if (bold && italic) return 'Courier-BoldOblique'
    if (bold) return 'Courier-Bold'
    if (italic) return 'Courier-Oblique'
    return 'Courier'
  }
  if (serif) {
    if (bold && italic) return 'Times-BoldItalic'
    if (bold) return 'Times-Bold'
    if (italic) return 'Times-Italic'
    return 'Times-Roman'
  }
  if (bold && italic) return 'Helvetica-BoldOblique'
  if (bold) return 'Helvetica-Bold'
  if (italic) return 'Helvetica-Oblique'
  return 'Helvetica'
}

/**
 * The operators a BT block runs to place the pen BEFORE it draws anything —
 * Tm, Td, TD, TL and T*, in the order the generator wrote them.
 *
 * A rebuild has to re-emit all of them. Keeping only `Tm`, as this used to,
 * draws at the text-space origin, and on a clipped page that is not merely
 * misplaced — it is INVISIBLE: the block vanishes from the render and from
 * every extractor, which reads as the edit having deleted the text. Word (via
 * iLovePDF) is exactly that shape: every block sets an identity
 * `1 0 0 1 0 0 Tm` and positions with `TD`, so editing one line of a form blanked
 * it.
 *
 * Two things this has to get right, and both were the bug:
 * - **`TD` counts, not just `Td`.** They differ only in that TD also sets the
 *   leading, which has no bearing on where the pen is.
 * - **The cut-off is the first SHOW op, located on the MASKED content** — not
 *   the first `(`, `<` or `[`. Word writes `0 J [] 0 d 0 j 1 w 10 M` ahead of
 *   its positioning, so splitting at the first bracket stops at the empty dash
 *   array and never reaches the operator that matters. That alone breaks
 *   lowercase `Td` generators too.
 *
 * The operators are preserved verbatim rather than folded into a single `Tm`
 * because Td operands are multiplied by the text matrix: a block whose Tm
 * carries a scale cannot have its offsets added into the matrix.
 */
function leadingPositionOps(content: string): string {
  const masked = maskStreamLiterals(content)
  const showAt = masked.search(/(?<![A-Za-z0-9])(?:Tj|TJ)(?![A-Za-z0-9])|'|"/)
  const head = showAt >= 0 ? masked.slice(0, showAt) : masked
  const ops = head.match(
    /(?:-?[\d.]+\s+){5}-?[\d.]+\s+Tm\b|-?[\d.]+\s+-?[\d.]+\s+(?:Td|TD)\b|-?[\d.]+\s+TL\b|(?<![A-Za-z0-9])T\*(?![A-Za-z0-9])/g
  )
  if (ops && ops.length) return ops.join('\n')
  // Nothing positions the block before it draws. Fall back to the first Tm
  // anywhere inside it — a block that sets its matrix only between runs
  // (SUNAT/JasperReports) still starts at that matrix once rebuilt as one run.
  const tm = masked.match(/(?:-?[\d.]+\s+){5}-?[\d.]+\s+Tm\b/)
  return tm ? tm[0] : ''
}

/**
 * Rebuild a BT block's inner content to draw the given pre-encoded lines,
 * optionally switching to a different font resource. Preserves the original
 * positioning operators, color operators and Tf size.
 */
function rebuildBtContent(
  content: string,
  encodedLines: string[],
  newFontRef: string | null,
  hex = false,
  overrideSize?: number,
  overrideColorOp?: string | null,
  inheritedTf?: string | null
): string {
  const tfMatch = content.match(/\/([A-Za-z0-9_.+-]+)\s+([\d.]+)\s+Tf/)
  // A block with no Tf of its own inherits font AND size from the graphics
  // state, so the size has to come from the operator that was in force
  // (BtInfo.inheritedTf) — falling back to 12 drew this document's 11.04pt
  // fields half a point too large.
  const inheritedSize = inheritedTf ? inheritedTf.match(/([\d.]+)\s+Tf\s*$/)?.[1] : undefined
  const tfSize = overrideSize !== undefined
    ? fmtNum(overrideSize)
    : (tfMatch ? tfMatch[2] : (inheritedSize ?? '12'))
  const tfPart = newFontRef
    ? `/${newFontRef} ${tfSize} Tf`
    : (tfMatch
        ? (overrideSize !== undefined ? `/${tfMatch[1]} ${tfSize} Tf` : tfMatch[0])
        : '')

  const posPart = leadingPositionOps(content)

  const colorMatch = content.match(/[\d.]+(?:\s+[\d.]+){0,3}\s+(?:rg|g|k|sc|scn)\b/)
  const colorPart = overrideColorOp != null ? overrideColorOp : (colorMatch ? colorMatch[0] : '')

  // Td moves in text space (before Tm scaling), so the per-line step is the
  // raw Tf size — the Tm matrix applies any page-space scaling on top of it.
  //
  // LINE_LEADING, not 1.2: the base-14 faces this path substitutes to have an
  // ink box about 1.37em tall, so lines set at 1.2 overlapped the one under
  // them by ~2pt. The client sizes the room it makes with the same constant —
  // they have to agree or the page reflows by a different amount than the text
  // actually takes.
  const tdStep = (parseFloat(tfSize) || 12) * LINE_LEADING

  const tjParts: string[] = []
  for (let i = 0; i < encodedLines.length; i++) {
    const op = hex ? `<${encodedLines[i]}> Tj` : `(${escapePdfString(encodedLines[i])}) Tj`
    if (i === 0) tjParts.push(op)
    else tjParts.push(`0 ${(-tdStep).toFixed(2)} Td\n${op}`)
  }

  // Font state survives ET. Swapping this block's Tf for a substituted face
  // therefore re-fonts every LATER block that relied on inheriting it — one
  // edit on a Corel datasheet silently changed 702 characters across 36 blocks
  // that were never touched. Put the original font back on the way out.
  //
  // The block that needs this MOST is one with no Tf of its own, and that was
  // exactly the case the guard used to miss: PDF24 draws each form-field VALUE
  // as a fontless BT that inherits the /TT1 set by the labels block, so
  // `tfMatch` is null and nothing was restored. The substituted face then stood
  // as the font in force for every later fontless block, `scanBtBlocks`
  // attributed it to them, and the font filter rejected the very block holding
  // the target: editing one field made the NEXT one report "Could not find
  // matching text in content stream". Restore what the block inherited.
  const restoreTf = newFontRef
    ? (tfMatch ? `\n${tfMatch[0]}` : (inheritedTf ? `\n${inheritedTf}` : ''))
    : ''

  return `\n${colorPart ? colorPart + '\n' : ''}${tfPart}\n${posPart}\n${tjParts.join('\n')}${restoreTf}\n`
}

type EncodingPlan =
  | { kind: 'keep-hex'; hexLines: string[] }
  | { kind: 'keep-plain'; byteLines: string[] }
  | { kind: 'subst'; fontRef: string; fontName: string; byteLines: string[]; hex?: boolean; hexLines?: string[] }
  | { kind: 'error'; error: string }

/** The substitute's lines as the rebuild wants them: hex for an embedded CJK face. */
function substLines(plan: { byteLines: string[]; hex?: boolean; hexLines?: string[] }): string[] {
  return plan.hex && plan.hexLines ? plan.hexLines : plan.byteLines
}
/** The substitute's first line as a PDF string literal. */
function substLiteral(plan: { byteLines: string[]; hex?: boolean; hexLines?: string[] }): string {
  return plan.hex && plan.hexLines ? `<${plan.hexLines[0] ?? ''}>` : `(${escapePdfString(plan.byteLines[0] ?? '')})`
}

/**
 * Decide how to encode replacement text for a BT block:
 * 1. Re-encode with the original font when every character is available.
 * 2. Otherwise substitute a matching standard font (Acrobat-style fallback).
 */
function planTextEncoding(
  pageIndex: number,
  block: {
    mode: 'hex' | 'plain'; fontRef: string; encoding: ReturnType<typeof getFontEncoding>
    /** Glyph codes the run being edited already uses — see encodeTextForFont. */
    preferCodes?: Map<number, number>
  },
  lines: string[],
  targetBlock?: TextBlock
): EncodingPlan {
  // Empty replacement (deletion) never needs substitution
  const isEmpty = lines.every(l => l.length === 0)

  if (block.mode === 'hex' && block.encoding) {
    const hexLines: string[] = []
    let ok = true
    for (const line of lines) {
      const res = encodeTextForFont(line, block.encoding, block.preferCodes)
      if ('error' in res) { ok = false; break }
      hexLines.push(res.hex)
    }
    if (ok) return { kind: 'keep-hex', hexLines }
  } else if (block.mode === 'hex' && !block.encoding) {
    // Hex strings, no ToUnicode: a simple font whose hex pairs are its own
    // byte codes (pdf-lib writes every string that way). Re-encode through the
    // font's byte encoding and emit 1-byte hex — the font is kept.
    const info = getSimpleFontInfo(pageIndex, block.fontRef)
    if (info && !info.isType0 && info.encodingName !== 'Unknown') {
      const hexLines: string[] = []
      let ok = true
      for (const line of lines) {
        const res = encodeForSimpleFont(line, info)
        if ('missing' in res) { ok = false; break }
        let hex = ''
        for (let i = 0; i < res.bytes.length; i++) {
          hex += res.bytes.charCodeAt(i).toString(16).padStart(2, '0').toUpperCase()
        }
        hexLines.push(hex)
      }
      if (ok) return { kind: 'keep-hex', hexLines }
    }
  } else if (block.mode === 'plain') {
    if (isEmpty) return { kind: 'keep-plain', byteLines: lines.map(() => '') }
    const info = getSimpleFontInfo(pageIndex, block.fontRef)

    // Glyph-coded font drawing plain strings (bytes = CMap codes): re-encode
    // through the reverse CMap and emit HEX literals — a hex string is a
    // valid replacement for a plain one and avoids writing raw control bytes.
    if (block.encoding && (!info || info.encodingName === 'Unknown')) {
      const hexLines: string[] = []
      let ok = true
      for (const line of lines) {
        const res = encodeTextForFont(line, block.encoding, block.preferCodes)
        if ('error' in res) { ok = false; break }
        hexLines.push(res.hex)
      }
      if (ok) return { kind: 'keep-hex', hexLines }
    }

    if (info && !info.isType0 && info.encodingName !== 'Unknown') {
      const byteLines: string[] = []
      let ok = true
      for (const line of lines) {
        const res = encodeForSimpleFont(line, info)
        if ('missing' in res) { ok = false; break }
        byteLines.push(res.bytes)
      }
      if (ok) return { kind: 'keep-plain', byteLines }
    } else if (info === null) {
      // Font resource unreadable — trust plain ASCII only
      if (lines.every(l => /^[\x20-\x7E]*$/.test(l))) {
        return { kind: 'keep-plain', byteLines: [...lines] }
      }
    }
  }

  if (isEmpty) {
    return block.mode === 'hex'
      ? { kind: 'keep-hex', hexLines: lines.map(() => '') }
      : { kind: 'keep-plain', byteLines: lines.map(() => '') }
  }

  // ── Substitution fallback ──
  const byteLines: string[] = []
  let missing: string[] | null = null
  for (const line of lines) {
    const res = encodeWinAnsiText(line)
    if ('missing' in res) { missing = res.missing; break }
    byteLines.push(res.bytes)
  }
  if (missing) {
    // WinAnsi cannot hold it. For Chinese — the bilingual forms this editor
    // lives on end half their lines in 不适用 — a tiny font built from the
    // shipped CJK face draws the WHOLE run (it has Latin glyphs too), in the
    // resources the block's Tf resolves against. Anything else is an error.
    const cjk = lines.some(hasCjk) ? miniCjkFontFor(lines.join(' ')) : null
    if (cjk) {
      const hexLines: string[] = []
      let ok = true
      for (const line of lines) {
        let hex = ''
        for (const ch of line) {
          const gid = cjk.encodeCharacter(ch.codePointAt(0)!)
          if (!gid) { ok = false; break }
          hex += gid.toString(16).padStart(4, '0')
        }
        if (!ok) break
        hexLines.push(hex)
      }
      if (ok) {
        try {
          const dict = activeResources
            ? (activeResources.dict.resolve?.() ?? activeResources.dict)
            : (() => { const page = pdfDoc.loadPage(pageIndex); const r = page.getObject().get('Resources'); page.destroy(); return r })()
          const fontRef = registerFontIn(dict, cjk, 'FCJK')
          if (fontRef) {
            console.log(`[MuPDF Worker] Substituting font ${block.fontRef} → NotoSansSC (/${fontRef}) for CJK`)
            return { kind: 'subst', fontRef, fontName: 'NotoSansSC', byteLines: [], hex: true, hexLines }
          }
        } catch (err) {
          console.warn('[MuPDF Worker] CJK substitute failed:', err)
        }
      }
    }
    return { kind: 'error', error: `Cannot encode characters: ${missing.join(', ')} (not supported by fallback font)` }
  }

  const info = getSimpleFontInfo(pageIndex, block.fontRef)
  const fontName = pickSubstituteFont(info, targetBlock)

  try {
    let fontRef: string
    if (activeResources) {
      // Editing inside a Form XObject: the Tf name must resolve against the
      // FORM's Resources.
      const dict = activeResources.dict.resolve?.() ?? activeResources.dict
      fontRef = ensureStandardFontInResources(dict, fontName)
    } else {
      const page = pdfDoc.loadPage(pageIndex)
      const pageObj = page.getObject()
      fontRef = ensureStandardFont(pageObj, fontName)
      page.destroy()
    }
    console.log(`[MuPDF Worker] Substituting font ${info?.baseFont || block.fontRef} → ${fontName} (/${fontRef})`)
    return { kind: 'subst', fontRef, fontName, byteLines }
  } catch (err: any) {
    return { kind: 'error', error: `Font substitution failed: ${err.message || err}` }
  }
}

// ==========================================
// TEXT REPLACEMENT — FONT-AWARE
// ==========================================

/**
 * Add new text at a given position on a page.
 * Uses standard PDF fonts (Helvetica, Times-Roman, Courier) which are always available.
 */
function addTextToPage(
  pageIndex: number,
  x: number,
  y: number,
  text: string,
  fontSize: number,
  fontName: string,
  color?: [number, number, number],
  /** Degrees counter-clockwise. 90 sets the text reading up the page. */
  rotation = 0,
  /** A registered traced scan face: its glyphs draw the characters it has. */
  faceId?: string
): { success: boolean; error?: string } {
  if (!pdfDoc || !mupdf) return { success: false, error: 'No document' }

  try {
    const page = pdfDoc.loadPage(pageIndex)
    const pageObj = page.getObject()

    // 1–3. Fonts and show operators, one per SEGMENT. The run is cut into
    // maximal stretches the scan face can draw (glyphs traced from the page
    // itself) and stretches it cannot (characters the user typed that the
    // page never showed); each stretch gets its own Tf + Tj inside the one
    // BT, and the text matrix carries the pen from one to the next, so no
    // advances have to be computed here. A stretch outside the face goes to
    // WinAnsi in the base-14 face where it can — serializing raw Unicode with
    // "& 0xFF" would silently mangle €, smart quotes, dashes… — and to a
    // subset of the shipped CJK face for text WinAnsi cannot hold.
    const face = faceId ? scanFaces.get(faceId) : null
    const segments: { text: string; traced: boolean }[] = []
    for (const ch of text) {
      const traced = !!face && ch !== ' ' && face.encodeCharacter(ch.codePointAt(0)!) !== 0
      const last = segments[segments.length - 1]
      // A space joins whichever segment it follows; it draws nothing.
      if (last && (last.traced === traced || ch === ' ')) last.text += ch
      else segments.push({ text: ch, traced })
    }
    const ops: string[] = []
    for (const seg of segments) {
      if (seg.traced && face) {
        const run = registerEmbeddedRun(pageObj, face, seg.text, 'FSCN')
        if (run) { ops.push(`/${run.refName} ${fontSize} Tf <${run.hex}> Tj`); continue }
      }
      const winAnsi = encodeWinAnsiText(seg.text)
      if ('missing' in winAnsi) {
        const cjk = hasCjk(seg.text) ? registerCjkRun(pageObj, seg.text) : null
        if (!cjk) {
          page.destroy()
          const why = hasCjk(seg.text) && !cjkFont
            ? ' (the CJK font could not be loaded)'
            : ''
          return { success: false, error: `Characters not supported by ${fontName}: ${winAnsi.missing.join(', ')}${why}` }
        }
        ops.push(`/${cjk.refName} ${fontSize} Tf <${cjk.hex}> Tj`)
      } else {
        ops.push(`/${ensureStandardFont(pageObj, fontName)} ${fontSize} Tf (${escapePdfString(winAnsi.bytes)}) Tj`)
      }
    }
    const showOps = ops.join('\n')

    // 2. Read existing content stream
    const existingStream = readContentStream(pageIndex)

    const r = color?.[0] ?? 0
    const g = color?.[1] ?? 0
    const b = color?.[2] ?? 0

    // Rotation lives in the TEXT MATRIX, not in the font size: `a b c d` is
    // the rotation and `e f` the origin, so vertical text is the same code
    // path as horizontal with a different pair of cosines.
    const rad = (rotation * Math.PI) / 180
    const upright = Math.abs(rotation) < 0.01
    const ca = upright ? 1 : Math.cos(rad)
    const sa = upright ? 0 : Math.sin(rad)
    // x/y arrive in the VISIBLE (rotated) space the user clicked in; on a
    // /Rotate page the stream draws in the raw one, so the whole text matrix
    // goes through the rotation's inverse — glyphs come out upright on screen
    // and the origin lands where the click was.
    let tm: Mat6 = [ca, sa, -sa, ca, x, y]
    const pageRot = pageRotationCtm(pageIndex)
    if (pageRot) {
      const inv = matInvert(pageRot)
      if (inv) tm = matConcat(tm, inv)
    }
    // The block is APPENDED, so it draws under whatever CTM the stream leaves
    // in force at its end. Some generators bake an unbracketed rotation right
    // at the top (`0 1 -1 0 842 0 cm` compensating /Rotate 90) — inherited by
    // the new block, it rotated the added text a second time. Undo it.
    const endCtm = getCtmAtOffset(existingStream, existingStream.length)
    if (endCtm.some((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) > 1e-9)) {
      const endInv = matInvert(endCtm)
      if (endInv) tm = matConcat(tm, endInv)
    }
    const fmt = (n: number) => (Math.abs(n) < 1e-6 ? '0' : n.toFixed(4))
    const newBlock = `\nBT\n${r} ${g} ${b} rg\n${fmt(tm[0])} ${fmt(tm[1])} ${fmt(tm[2])} ${fmt(tm[3])} ${tm[4].toFixed(2)} ${tm[5].toFixed(2)} Tm\n${showOps}\nET\n`

    // 4. Append to content stream
    const combined = existingStream + newBlock
    const streamBytes = new Uint8Array(combined.length)
    for (let i = 0; i < combined.length; i++) {
      streamBytes[i] = combined.charCodeAt(i) & 0xFF
    }

    // 5. Write back.
    //
    // A page created by `insertBlankPage` has NO /Contents at all, and calling
    // `.isArray()` on that null threw — which the catch below turned into a
    // plain `success: false`. Text spilled onto a fresh page was silently
    // dropped that way. Anything that is not already a single stream gets one.
    const contents = pageObj.get('Contents')
    const isStream = !!contents && String(contents) !== 'null' &&
      typeof contents.isStream === 'function' && contents.isStream()
    if (isStream) {
      contents.writeStream(streamBytes)
    } else {
      const newStreamObj = pdfDoc.addStream(streamBytes, {})
      pageObj.put('Contents', newStreamObj)
    }

    page.destroy()
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Ensure a standard PDF font (Helvetica, Times-Roman, Courier) is registered
 * in the page's Resources/Font dictionary. Returns the font reference name (e.g. "F10").
 */
// ── A CJK face for text WinAnsi cannot hold ──

/** Where the shipped CJK face lives; fetched once, on the first run that needs it. */
const CJK_FONT_URL = '/fonts/NotoSansSC-Regular.otf'
let cjkFont: any = null
let cjkFontLoading: Promise<void> | null = null
/** Traced scan faces by id (`ScanFace-p<n>`), registered by the client before a bake. */
const scanFaces = new Map<string, any>()

/** Han, kana, hangul, CJK punctuation and full-width forms. */
function hasCjk(text: string): boolean {
  return /[⺀-鿿豈-﫿＀-￯　-〿가-힯]/.test(text)
}

/**
 * Load the CJK face if this text will need it. Awaited by the message handler
 * — the writers themselves are synchronous — and a failure is remembered as
 * "no font" rather than thrown, so the writer can say so in its own words.
 */
async function ensureCjkFontFor(text: string): Promise<void> {
  if (cjkFont || !mupdf || !hasCjk(text)) return
  if (!cjkFontLoading) {
    cjkFontLoading = (async () => {
      try {
        const res = await fetch(CJK_FONT_URL)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        // Parsed by opentype.js, not handed to MuPDF whole: MuPDF's CFF
        // subsetter fails on this face for some runs ("Insufficient operators
        // on the stack", "Index bounds") and then embeds all 8 MB. A tiny
        // font is built per run from the glyph outlines instead, and THAT is
        // what MuPDF embeds — the same route the traced scan faces take.
        cjkFont = opentype.parse(await res.arrayBuffer())
      } catch (err) {
        console.warn('[MuPDF Worker] CJK font unavailable:', err)
        cjkFont = null
      }
    })()
  }
  await cjkFontLoading
}

/**
 * A font holding exactly the glyphs of `text`, from the parsed CJK face.
 *
 * Built with opentype.js from the outlines, so it is small (a few KB per
 * glyph) and clean; MuPDF embeds it as it is. Null when a character has no
 * glyph in the face.
 */
function miniCjkFontFor(text: string): any | null {
  if (!cjkFont || !mupdf) return null
  const seen = new Map<number, opentype.Glyph>()
  for (const ch of text) {
    if (ch === ' ') continue
    const cp = ch.codePointAt(0)!
    if (seen.has(cp)) continue
    const g = cjkFont.charToGlyph(ch)
    if (!g || g.index === 0) return null
    seen.set(cp, new opentype.Glyph({ name: `uni${cp.toString(16).toUpperCase().padStart(4, '0')}`, unicode: cp, advanceWidth: g.advanceWidth, path: g.path }))
  }
  const space = cjkFont.charToGlyph(' ')
  const notdef = new opentype.Glyph({ name: '.notdef', advanceWidth: Math.round(cjkFont.unitsPerEm * 0.5), path: new opentype.Path() })
  const glyphs = [notdef, ...seen.values()]
  if (text.includes(' ') && space && space.index !== 0) {
    glyphs.push(new opentype.Glyph({ name: 'space', unicode: 32, advanceWidth: space.advanceWidth, path: new opentype.Path() }))
  }
  const mini = new opentype.Font({
    familyName: 'NotoSansSC', styleName: 'Regular',
    unitsPerEm: cjkFont.unitsPerEm, ascender: cjkFont.ascender, descender: cjkFont.descender, glyphs
  })
  return new mupdf.Font('NotoSansSC', new Uint8Array(mini.toArrayBuffer()))
}

/**
 * Register a SUBSET of the CJK face holding exactly this run's glyphs, and
 * encode the run for it.
 *
 * `addFont` embeds the whole 8 MB face, and `subsetFonts()` on the real
 * document would subset the ORIGINAL fonts too — glyphs the page does not
 * currently draw would be gone, and a later edit needing one of them would be
 * pushed into a substitute. So the run is drawn in a scratch document, THAT is
 * subsetted (≈40 KB), and the resulting font dictionary is grafted across.
 * Grafting carries the subset's own W array and ToUnicode, so the run
 * extracts back as the characters that were written.
 */
/**
 * Put an already-minimal font (opentype-built: a traced face, a CJK mini
 * font) into a Resources dictionary under a fresh `<prefix>n` name. No
 * scratch document and no subsetting: there is nothing to cut.
 */
function registerFontIn(resources: any, font: any, prefix: string): string | null {
  if (!pdfDoc || !resources || String(resources) === 'null') return null
  const res = resources.resolve?.() ?? resources
  let fontDict = res.get('Font')
  if (!fontDict || String(fontDict) === 'null') {
    fontDict = pdfDoc.newDictionary()
    res.put('Font', fontDict)
  }
  fontDict = fontDict.resolve?.() ?? fontDict
  let n = 1
  while (true) {
    const existing = fontDict.get(`${prefix}${n}`)
    if (!existing || String(existing) === 'null') break
    n++
  }
  const refName = `${prefix}${n}`
  fontDict.put(refName, pdfDoc.addFont(font))
  return refName
}

function registerCjkRun(pageObj: any, text: string): { refName: string; hex: string } | null {
  const mini = miniCjkFontFor(text)
  if (!mini) return null
  return registerEmbeddedRun(pageObj, mini, text, 'FCJK')
}

/**
 * Register a SUBSET of `font` holding exactly this run's glyphs under a fresh
 * `<prefix>n` name in the page's fonts, and encode the run as Identity-H hex.
 * Shared by the CJK fallback face and the traced scan faces.
 */
function registerEmbeddedRun(pageObj: any, font: any, text: string, prefix: string): { refName: string; hex: string } | null {
  if (!mupdf || !pdfDoc || !font) return null
  let hex = ''
  for (const ch of text) {
    const gid = font.encodeCharacter(ch.codePointAt(0)!)
    if (!gid) return null
    hex += gid.toString(16).padStart(4, '0')
  }
  let scratch: any = null
  try {
    scratch = new mupdf.PDFDocument()
    const fontRef = scratch.addFont(font)
    const res = scratch.newDictionary()
    const fd = scratch.newDictionary()
    fd.put('F1', fontRef)
    res.put('Font', fd)
    scratch.insertPage(-1, scratch.addPage([0, 0, 100, 100], 0, res, `BT /F1 10 Tf 0 0 Td <${hex}> Tj ET`))
    scratch.subsetFonts()
    const subsetFont = scratch.loadPage(0).getObject().get('Resources').get('Font').get('F1')
    const grafted = pdfDoc.graftObject(subsetFont)

    let resources = pageObj.get('Resources')
    if (!resources || resources.toString() === 'null') {
      resources = pdfDoc.newDictionary()
      pageObj.put('Resources', resources)
    }
    resources = resources.resolve()
    let fontDict = resources.get('Font')
    if (!fontDict || fontDict.toString() === 'null') {
      fontDict = pdfDoc.newDictionary()
      resources.put('Font', fontDict)
    }
    fontDict = fontDict.resolve()
    let n = 1
    while (true) {
      const existing = fontDict.get(`${prefix}${n}`)
      if (!existing || String(existing) === 'null') break
      n++
    }
    const refName = `${prefix}${n}`
    fontDict.put(refName, grafted)
    return { refName, hex }
  } catch (err) {
    console.warn('[MuPDF Worker] CJK subset failed:', err)
    return null
  } finally {
    try { scratch?.destroy() } catch (_) { /* nothing to free */ }
  }
}

function ensureStandardFont(pageObj: any, fontName: string): string {
  let resources = pageObj.get('Resources')
  if (!resources || resources.toString() === 'null') {
    resources = pdfDoc.newDictionary()
    pageObj.put('Resources', resources)
  }
  return ensureStandardFontInResources(resources.resolve(), fontName)
}

/**
 * Register (or find) a base-14 font in a specific Resources dictionary.
 *
 * A name written into a Form XObject's stream resolves against the FORM's
 * Resources, not the page's. Registering the substitute on the page while the
 * rewritten run lived inside /X6 made "/F1" resolve to the form's own F1 — a
 * subsetted CID face whose ToUnicode had no '1' — and the replacement's last
 * character silently vanished from extraction.
 */
function ensureStandardFontInResources(resources: any, fontName: string): string {
  let fontDict = resources.get('Font')
  if (!fontDict || fontDict.toString() === 'null') {
    fontDict = pdfDoc.newDictionary()
    resources.put('Font', fontDict)
  }
  fontDict = fontDict.resolve()

  // Check existing font references for our target font. Require an EXACT
  // BaseFont + Type1 + non-embedded match: a substring test would reuse
  // "Helvetica-Bold" for "Helvetica" (silently bolding new text) or an
  // embedded subset "ABCDEF+Helvetica" whose custom encoding garbles
  // WinAnsi bytes.
  const existingRefs = new Set<string>()
  for (let i = 1; i <= 99; i++) {
    const ref = `F${i}`
    try {
      const val = fontDict.get(ref)
      if (val && val.toString() !== 'null') {
        existingRefs.add(ref)
        const resolved = val.resolve()
        const baseFont = resolved.get('BaseFont')
        if (baseFont) {
          const baseFontStr = String(baseFont.asName?.() || baseFont.toString() || '').replace(/^\//, '')
          const subtype = String(resolved.get('Subtype') || '')
          if (baseFontStr === fontName && subtype === '/Type1') {
            return ref // Already registered
          }
        }
      }
    } catch (_) { /* skip */ }
  }

  // Create new font reference
  let newRefNum = 1
  while (existingRefs.has(`F${newRefNum}`)) newRefNum++
  const newRef = `F${newRefNum}`

  // Create Type1 font dictionary for a standard PDF font
  const newFontDict = pdfDoc.newDictionary()
  newFontDict.put('Type', pdfDoc.newName('Font'))
  newFontDict.put('Subtype', pdfDoc.newName('Type1'))
  newFontDict.put('BaseFont', pdfDoc.newName(fontName))
  newFontDict.put('Encoding', pdfDoc.newName('WinAnsiEncoding'))

  const fontIndirect = pdfDoc.addObject(newFontDict)
  fontDict.put(newRef, fontIndirect)

  return newRef
}

function replaceTextInStream(
  pageIndex: number,
  blockId: string,
  newText: string
): { success: boolean; error?: string; substitutedFont?: string; strategy?: string; lines?: number } {
  if (!pdfDoc) return { success: false, error: 'No document' }

  try {
    const pageData = extractPageText(pageIndex)
    let targetBlock = pageData.blocks.find(b => b.id === blockId)
    if (!targetBlock) {
      return { success: false, error: `Block ${blockId} not found` }
    }

    // Get page size for line wrapping + position-aware matching
    const pageBounds = pdfDoc.loadPage(pageIndex)
    const boundsRect = pageBounds.getBounds()
    let pageWidth = boundsRect[2] - boundsRect[0]
    let pageHeight = boundsRect[3] - boundsRect[1]
    let rotation = 0
    try {
      const r = pageBounds.getObject().get('Rotate')
      if (r && r.toString() !== 'null') {
        rotation = ((parseInt(r.toString(), 10) % 360) + 360) % 360
      }
    } catch (_) { /* unrotated */ }
    pageBounds.destroy()

    // NO coordinate conversion happens here, deliberately. /Rotate is already
    // handled a level down: getContentSources composes pageRotationCtm into
    // every source's invocation CTM, so getFullCtmAtOffset maps a block
    // straight into the rotated (visible) frame — the same frame extraction
    // reports the target's bbox in, with getBounds()'s post-rotation height as
    // the flip. Converting the bbox here as well rotates the target TWICE:
    // measured on this landscape form, the one exact-match candidate scored a
    // distance of 372.8pt while sitting dead on the click. The rotation value
    // is still needed below, but only to pick the LINE axis, which lives in
    // raw text space that the invocation CTM never touches.

    // The text may live in the page stream OR in a Form XObject it invokes.
    // Try each in turn, with font lookups scoped to that source's resources.
    let lastError: string | null = null
    const searched: string[] = []
    for (const src of getContentSources(pageIndex)) {
      searched.push(src.key)
      const outcome = withSource(src, () => {
        const stream = src.stream
        const fontRefs = [...new Set([...stream.matchAll(/\/([A-Za-z0-9_.+-]+)\s+[\d.]+\s+Tf/g)].map(m => m[1]))]
        const fontRefToBaseName = new Map<string, string>()
        for (const fontRef of fontRefs) {
          getFontEncoding(pageIndex, fontRef)
          let page2: any = null
          try {
            page2 = pdfDoc!.loadPage(pageIndex)
            const fDict = resolveResources(page2.getObject())?.get('Font')?.get(fontRef)
            if (fDict) {
              const baseFontStr = fDict.resolve().get('BaseFont')?.toString?.() || ''
              fontRefToBaseName.set(fontRef, baseFontStr.replace(/^\//, ''))
            }
          } catch (_) {
          } finally {
            try { page2?.destroy() } catch (_) { /* already destroyed */ }
          }
        }
        const targetFontRef = findMatchingFontRef(targetBlock.fontName, fontRefToBaseName)
        return replaceTextInContentStreamFontAware(
          stream, pageIndex, targetBlock!, newText, targetFontRef, pageWidth, pageHeight, rotation
        )
      })

      if (!outcome) continue
      if ('error' in outcome) { lastError = outcome.error; continue }

      // Longer text needs a wider window, or the tail is clipped away and lost.
      // The clip sits at a LOWER offset than the block it bounds, and the
      // replacement only rewrote bytes at/after that block, so the offset found
      // in the original stream is still valid in the rewritten one.
      let streamStr = outcome.stream
      // Every remaining edit sits at a LOWER offset than the blocks already
      // rewritten — a span's dictionary, then its clip window, then its BT —
      // so they are collected and applied together, highest offset first.
      // Two passes over the same region is how a clip rectangle ended up
      // spliced through the middle of an /ActualText.
      const pending: SpanRetag[] = [...(outcome.retags ?? [])]
      if (outcome.anchorOffset !== undefined && newText.length > 0) {
        const oldLen = Math.max(targetBlock.text.trim().length, 1)
        const avgCharWidth = targetBlock.width / oldLen
        // Deliberately generous. The average is taken over the ORIGINAL glyphs,
        // and a substituted base-14 face is usually wider — sizing the window to
        // the old average left "SWEEPMARK2" clipped to "SWEEP M". Over-widening
        // only reveals more of the group the clip bounds, which is the text run
        // itself, so erring high is free.
        const needed = avgCharWidth * newText.length * 1.6 + 8

        // How much DEEPER the replacement is than what it replaced. The engine
        // decides the line count — the user's own breaks plus whatever the
        // right margin forced — so it is read back from the outcome rather than
        // counted from the text.
        const drawnLines = Math.max(1, outcome.lines ?? 1)
        const extraHeight = (drawnLines - 1) * targetBlock.fontSize * LINE_LEADING
        // Every clip in force, highest offset first so each splice leaves the
        // earlier offsets valid.
        const clips = getActiveClipsAtOffset(src.stream, outcome.anchorOffset)
          .filter(c => c.index < outcome.anchorOffset!)
          .sort((a, b) => b.index - a.index)
        // Under withSource: the clip rectangles live in the SOURCE's space, and
        // converting the target's page-space box into it needs the invocation
        // CTM composed in. Widening them with the identity instead computed a
        // window a quarter the size on a 0.24-scaled form and the replacement
        // stayed truncated.
        withSource(src, () => {
          for (const clip of clips) {
            const widened = widenClipForText(src.stream, clip, targetBlock, needed, extraHeight, pageHeight)
            // Moved for the same reason the tags are: a line group can rewrite a
            // block that sits BELOW this clip, and the offset read from the
            // original stream then points a few bytes short of the rectangle.
            if (widened) pending.push({
              start: shiftOffset(clip.index, outcome.applied ?? []),
              end: shiftOffset(clip.index + clip.length, outcome.applied ?? []),
              text: widened
            })
          }
        })

        // A Form XObject is clipped to its own /BBox even without a `re W n`.
        // Canva nests its text two forms deep in a box sized to the original
        // string, so a wider replacement was cut off there instead —
        // "Plataforma" came back as "SWEEPMA".
        //
        // The BBox lives in the form's coordinate space, and the chain that maps
        // that to the page is not tracked here, so the box is grown by the same
        // RATIO the text grew by. Widening a form's BBox can only reveal more of
        // that form's own content, so a generous, capped factor is safe.
        const wider = needed > targetBlock.width
        const deeper = extraHeight > 0
        if (src.formDict && (wider || deeper)) {
          widenFormBBox(
            src.formDict,
            wider ? Math.min(needed / Math.max(targetBlock.width, 1), 3) : 1,
            deeper
              ? Math.min((targetBlock.height + extraHeight) / Math.max(targetBlock.height, 1), 4)
              : 1
          )
        }

        // A nested form is ALSO cut off by whatever clip is in force at its
        // `Do` in each ANCESTOR stream, and by each ancestor form's own /BBox.
        // Canva and pdftools invoke the text's form from inside another form,
        // and widening only the innermost left the edit truncated — the
        // long-standing "deeply nested text loses its last characters". Walk
        // the chain up, growing the clips around each invocation and every
        // ancestor's box.
        let child = src
        const seenAncestors = new Set([src.key])
        while (child.parentKey !== undefined && child.doOffset !== undefined) {
          const parent = getFormNode(pageIndex, child.parentKey)
          if (!parent || seenAncestors.has(parent.key)) break
          seenAncestors.add(parent.key)
          const doAt = child.doOffset
          const pclips = getActiveClipsAtOffset(parent.stream, doAt)
            .sort((a, b) => b.index - a.index)
          if (pclips.length) {
            let pstream = parent.stream
            let changed = false
            withSource(parent, () => {
              for (const clip of pclips) {
                const widened = widenClipForText(parent.stream, clip, targetBlock, needed, extraHeight, pageHeight)
                if (widened) {
                  pstream = pstream.slice(0, clip.index) + widened + pstream.slice(clip.index + clip.length)
                  changed = true
                }
              }
            })
            if (changed) {
              const pbytes = new Uint8Array(pstream.length)
              for (let i = 0; i < pstream.length; i++) pbytes[i] = pstream.charCodeAt(i) & 0xFF
              parent.write(pbytes)
            }
          }
          if (parent.formDict && (wider || deeper)) {
            widenFormBBox(
              parent.formDict,
              wider ? Math.min(needed / Math.max(targetBlock.width, 1), 3) : 1,
              deeper
                ? Math.min((targetBlock.height + extraHeight) / Math.max(targetBlock.height, 1), 4)
                : 1
            )
          }
          child = parent
        }
      }

      for (const sp of pending.sort((a, b) => b.start - a.start)) {
        streamStr = streamStr.slice(0, sp.start) + sp.text + streamStr.slice(sp.end)
      }

      const streamBytes = new Uint8Array(streamStr.length)
      for (let i = 0; i < streamStr.length; i++) {
        streamBytes[i] = streamStr.charCodeAt(i) & 0xFF
      }
      src.write(streamBytes)
      invalidateContentSources(pageIndex)
      return {
        success: true,
        substitutedFont: outcome.substitutedFont,
        strategy: (src.key === 'page' ? '' : src.key + ':') + (outcome.strategy ?? ''),
        // How many lines this run now draws. The caller needs it to make room:
        // extra lines are painted straight over the next paragraph otherwise.
        lines: outcome.lines ?? 1
      }
    }

    return {
      success: false,
      error: lastError ||
        `Could not find matching text in content stream ` +
        `[searched: ${searched.join(', ') || 'none'}] (${lastMatchDiagnostic || 'no diagnostic'})`
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Transform a text block's position and/or scale by modifying the Tm matrix in the content stream.
 * dx, dy: translation delta in PDF Tm coords (bottom-left origin)
 * sx, sy: scale factors (1.0 = no change)
 * anchorX, anchorY: anchor point in PDF Tm coords (used for scaling)
 */
function transformTextBlock(
  pageIndex: number,
  blockId: string,
  dx: number,
  dy: number,
  sx: number,
  sy: number,
  anchorX: number,
  anchorY: number
): { success: boolean; error?: string; strategy?: string; clipAdjusted?: boolean } {
  if (!pdfDoc) return { success: false, error: 'No document' }

  try {
    const pageData = extractPageText(pageIndex)
    const targetBlock = pageData.blocks.find(b => b.id === blockId)
    if (!targetBlock) {
      return { success: false, error: `Block ${blockId} not found` }
    }

    // Text may live in the page stream or in a Form XObject it invokes.
    for (const src of getContentSources(pageIndex)) {
      const done = withSource(src, () => transformInSource(
        src, pageIndex, targetBlock, dx, dy, sx, sy, anchorX, anchorY))
      if (done) return done
    }
    return { success: false, error: 'Could not find matching text in content stream' }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Move/scale SEVERAL blocks as one operation.
 *
 * Doing this as N separate `transformTextBlock` calls does not work: each call
 * re-extracts the page, block ids are extraction indices, and moving a block
 * changes where it sorts — so call #2 addresses a page that call #1 already
 * renumbered, and the wrong paragraph gets dragged. Here the extraction happens
 * ONCE and every op is resolved against that single snapshot.
 *
 * The `targetBlock` bboxes therefore stay the pre-move ones for the whole
 * batch, which is exactly what position-based matching needs: a block that has
 * not been rewritten yet is still where the snapshot says it is.
 *
 * Ops are applied in the order given. The caller sends the collision pushes
 * BEFORE the dragged selection so obstacles have vacated their old coordinates
 * by the time the dragged text is matched — otherwise two blocks with the same
 * text can sit close enough for the distance ranking to pick the wrong one.
 */
function transformTextBlocks(
  pageIndex: number,
  ops: BlockTransformOp[]
): { results: BlockTransformResult[]; applied: number } {
  if (!pdfDoc) {
    return {
      results: ops.map(o => ({ blockId: o.blockId, success: false, error: 'No document' })),
      applied: 0
    }
  }

  let pageData: PageTextData
  try {
    pageData = extractPageText(pageIndex)
  } catch (err: any) {
    return {
      results: ops.map(o => ({ blockId: o.blockId, success: false, error: err.message || String(err) })),
      applied: 0
    }
  }

  const results: BlockTransformResult[] = []
  let applied = 0

  for (const op of ops) {
    const targetBlock = pageData.blocks.find(b => b.id === op.blockId)
    if (!targetBlock) {
      results.push({ blockId: op.blockId, success: false, error: `Block ${op.blockId} not found` })
      continue
    }

    // A no-op push (the caller found nothing to move it by) must not rewrite
    // the stream at all — every rewrite is a chance to match the wrong block.
    if (op.dx === 0 && op.dy === 0 && op.sx === 1 && op.sy === 1) {
      results.push({ blockId: op.blockId, success: true, strategy: 'noop' })
      continue
    }

    let outcome: { success: boolean; error?: string; strategy?: string; clipAdjusted?: boolean } | null = null
    try {
      // Text may live in the page stream or in a Form XObject it invokes.
      for (const src of getContentSources(pageIndex)) {
        outcome = withSource(src, () => transformInSource(
          src, pageIndex, targetBlock, op.dx, op.dy, op.sx, op.sy, op.anchorX, op.anchorY))
        if (outcome) break
      }
    } catch (err: any) {
      outcome = { success: false, error: err.message || String(err) }
    }

    if (!outcome) outcome = { success: false, error: 'Could not find matching text in content stream' }
    if (outcome.success) applied++
    results.push({ blockId: op.blockId, ...outcome })
  }

  return { results, applied }
}

/** Transform work for ONE content stream. Returns null when it holds no match. */
function transformInSource(
  src: ContentSource,
  pageIndex: number,
  targetBlock: TextBlock,
  dx: number, dy: number, sx: number, sy: number,
  anchorX: number, anchorY: number
): { success: boolean; error?: string; strategy?: string; clipAdjusted?: boolean } | null {
  try {
    const stream = src.stream

    const fontRefs = [...new Set([...stream.matchAll(/\/([A-Za-z0-9_.+-]+)\s+[\d.]+\s+Tf/g)].map(m => m[1]))]
    const fontRefToBaseName = new Map<string, string>()
    for (const fontRef of fontRefs) {
      getFontEncoding(pageIndex, fontRef)
      let page2: any = null
      try {
        page2 = pdfDoc!.loadPage(pageIndex)
        const fDict = resolveResources(page2.getObject())?.get('Font')?.get(fontRef)
        if (fDict) {
          const baseFontStr = fDict.resolve().get('BaseFont')?.toString?.() || ''
          fontRefToBaseName.set(fontRef, baseFontStr.replace(/^\//, ''))
        }
      } catch (_) {
      } finally {
        try { page2?.destroy() } catch (_) { /* already destroyed */ }
      }
    }

    const targetFontRef = findMatchingFontRef(targetBlock.fontName, fontRefToBaseName)

    // For transforms, use position-based matching to find only the specific
    // BT block(s) that correspond to this text block — NOT the entire line.
    const pageHeight = getPageSize(pageIndex).height
    const matchedBlocks = findBtBlocksByPosition(stream, pageIndex, targetBlock, targetFontRef, pageHeight)
    if (!matchedBlocks || matchedBlocks.length === 0) return null

    // Every rewrite is collected as a splice and applied from the end of the
    // stream backwards, so earlier offsets stay valid. Clip rewrites sit BEFORE
    // their block, so a single pass over blocks cannot do it in place.
    interface Splice { start: number; end: number; text: string }
    const splices: Splice[] = []
    const clipsDone = new Set<number>()

    const sorted = [...matchedBlocks].sort((a, b) => b.start - a.start)

    let anyModified = false
    let usedStrategy: string | undefined
    let clipAdjusted = false
    for (const block of sorted) {
      // dx/dy/anchor arrive in PAGE space, but the text matrix lives inside the
      // enclosing CTM (print-to-PDF files wrap text in scaled/flipped cm like
      // "0.24 0 0 0.24 cm"). Convert through the inverse CTM so a 100pt page
      // drag moves the block exactly 100pt on screen.
      let dxL = dx, dyL = dy, anchorXL = anchorX, anchorYL = anchorY
      const ctm = getFullCtmAtOffset(stream, block.start)
      const det = ctm[0] * ctm[3] - ctm[1] * ctm[2]
      if (Math.abs(det) > 1e-9) {
        const ia = ctm[3] / det, ib = -ctm[1] / det
        const ic = -ctm[2] / det, id = ctm[0] / det
        dxL = dx * ia + dy * ic
        dyL = dx * ib + dy * id
        const ax = anchorX - ctm[4], ay = anchorY - ctm[5]
        anchorXL = ax * ia + ay * ic
        anchorYL = ax * ib + ay * id
      }

      // Literals are masked before locating the Tm so digits inside a string
      // like "(1 0 0 1 5 5 Tm)" can't be mistaken for the operator. Prefer the
      // Tm that actually governs the clicked text: a BT block can hold several
      // lines, each with its own Tm.
      const tmRegex = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/
      const governing = findGoverningTm(block, targetBlock.text, pageIndex)
      const fallback = maskStreamLiterals(block.content).match(tmRegex)
      const tmSource = governing
        ? { index: governing.index, text: governing.text }
        : (fallback ? { index: fallback.index!, text: fallback[0] } : null)
      const tmMatch = tmSource ? tmSource.text.match(tmRegex) : null

      // When the block draws MORE than the target, the Tm is shared with other
      // lines and moving it drags them along. Shift just this run instead, by
      // bracketing it with a Td and its inverse: the line matrix is restored
      // immediately afterwards, so every later line lands exactly where it did.
      // Only for pure translation — scaling one run inside a shared matrix
      // would need the glyph advances rebuilt.
      const blockLen = matchLength(block.decodedText)
      const targetLen = matchLength(targetBlock.text)
      const holdsMoreThanTarget = blockLen > targetLen * 1.4 + 4
      const pureTranslate = sx === 1 && sy === 1
      const local = blockLocalPoint(stream, block, targetBlock, pageHeight)
      const run = (holdsMoreThanTarget && pureTranslate)
        ? findTargetRun(block, targetBlock.text, pageIndex, local)
        : null

      /**
       * Last chance before refusing: the target may not be a show OP at all,
       * but a run of glyphs inside one TJ array.
       *
       * Word draws the three rules above a signature block as a single array
       * whose columns are kern jumps, and that array has no Tm and no
       * line-leading run to grab — so a drag on any of them found nothing and
       * said so, while the names on the lines either side moved perfectly well.
       *
       * Consulted ONLY where every other strategy has already given up, so no
       * move that works today can change.
       */
      const seg = (holdsMoreThanTarget && pureTranslate && !(run && run.startsLine) && !governing)
        ? findTargetSegment(block, targetBlock, pageIndex, stream, pageHeight)
        : null

      // When the block draws far more than the target and neither a
      // line-leading run nor a governing Tm can be pinned down, every remaining
      // strategy moves OTHER text: rewriting the first Tm dragged a table's
      // header row when a cell 50pt below it was asked to move. Refuse the
      // block — a loud "could not find matching text" beats a silent wrong drag.
      if (holdsMoreThanTarget && !(run && run.startsLine) && !seg && !governing) continue

      /** The page-space delta expressed in the text matrix's own space. */
      const inTmSpace = (): { tdx: number; tdy: number } => {
        if (!tmMatch) return { tdx: dxL, tdy: dyL }
        const a = parseFloat(tmMatch[1]), b2 = parseFloat(tmMatch[2])
        const c2 = parseFloat(tmMatch[3]), d2 = parseFloat(tmMatch[4])
        const det2 = a * d2 - b2 * c2
        if (!(Math.abs(det2) > 1e-9)) return { tdx: dxL, tdy: dyL }
        return {
          tdx: (dxL * d2 - dyL * c2) / det2,
          tdy: (dyL * a - dxL * b2) / det2
        }
      }

      let newContent: string
      if (seg) {
        const { tdx, tdy } = inTmSpace()
        const newRaw = shiftInsideTjArray(seg, tdx, tdy)
        if (!newRaw) continue
        newContent =
          block.content.slice(0, seg.op.start) + newRaw + block.content.slice(seg.op.end)
        usedStrategy ??= 'tj_segment_shift'
      } else if (run && run.startsLine) {
        // Td operands are multiplied by the TEXT matrix, so the delta has to be
        // expressed in Tm space — feeding it the CTM-space value moved this
        // block 5.9x too far on a page whose Tm scales by 0.17.
        const { tdx, tdy } = inTmSpace()
        newContent =
          block.content.slice(0, run.start) +
          `${fmtNum(tdx)} ${fmtNum(tdy)} Td ` +
          block.content.slice(run.start, run.end) +
          ` ${fmtNum(-tdx)} ${fmtNum(-tdy)} Td` +
          block.content.slice(run.end)
        usedStrategy ??= 'td_bracket_run'
      } else if (tmMatch && tmSource) {
        const a = parseFloat(tmMatch[1])
        const bVal = parseFloat(tmMatch[2])
        const c = parseFloat(tmMatch[3])
        const d = parseFloat(tmMatch[4])
        const e = parseFloat(tmMatch[5])
        const f = parseFloat(tmMatch[6])

        // Apply transformation: scale around anchor then translate
        const newA = a * sx
        const newD = d * sy
        const newE = anchorXL + (e - anchorXL) * sx + dxL
        const newF = anchorYL + (f - anchorYL) * sy + dyL

        const newTm = `${fmtNum(newA)} ${fmtNum(bVal)} ${fmtNum(c)} ${fmtNum(newD)} ${fmtNum(newE)} ${fmtNum(newF)} Tm`
        const at = tmSource.index
        newContent = block.content.slice(0, at) + newTm + block.content.slice(at + tmSource.text.length)
        usedStrategy ??= governing ? 'tm_rewrite_governing' : 'tm_rewrite_first'
      } else {
        // No Tm — the block positions itself with Td/TD/T* (wkhtmltopdf, FPDF,
        // TCPDF…). BT resets the line matrix to the identity, so every one of
        // those operators is relative to it: injecting the transform AS that
        // identity moves/scales the whole block, subsequent lines included.
        //   p' = anchor + (p - anchor)·s + d
        const mE = anchorXL * (1 - sx) + dxL
        const mF = anchorYL * (1 - sy) + dyL
        const injected = `${fmtNum(sx)} 0 0 ${fmtNum(sy)} ${fmtNum(mE)} ${fmtNum(mF)} Tm`
        newContent = ` ${injected}${block.content}`
        usedStrategy ??= 'tm_injected'
      }

      splices.push({ start: block.start, end: block.end, text: 'BT' + newContent + 'ET' })
      anyModified = true

      // Carry the clip window along. Without this, text drawn inside a tight
      // `re W* n` band (browser page headers/footers) simply disappears as soon
      // as the drag exceeds a few points.
      for (const clip of getActiveClipsAtOffset(stream, block.start)) {
        if (clipsDone.has(clip.index)) continue
        clipsDone.add(clip.index)
        const newRect = expandClipForTransform(stream, clip, dx, dy, sx, sy, anchorX, anchorY)
        if (newRect) {
          splices.push({ start: clip.index, end: clip.index + clip.length, text: newRect })
          clipAdjusted = true
        }
      }
    }

    if (!anyModified) return null

    let modifiedStream = stream
    for (const sp of splices.sort((a, b) => b.start - a.start)) {
      modifiedStream = modifiedStream.slice(0, sp.start) + sp.text + modifiedStream.slice(sp.end)
    }

    // Write modified stream back (Latin-1 for byte transparency)
    const streamBytes = new Uint8Array(modifiedStream.length)
    for (let i = 0; i < modifiedStream.length; i++) {
      streamBytes[i] = modifiedStream.charCodeAt(i) & 0xFF
    }

    src.write(streamBytes)
    invalidateContentSources(pageIndex)
    return {
      success: true,
      strategy: (src.key === 'page' ? '' : src.key + ':') + (usedStrategy ?? ''),
      clipAdjusted
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Pick the base-14 face for a family, keeping the block's existing weight and
 * slant — the user chose a typeface, not a reset to regular.
 */
function styledBase14(family: string, block: TextBlock): string {
  const bold = block.isBold
  const italic = block.isItalic
  if (/courier|mono/i.test(family)) {
    return bold && italic ? 'Courier-BoldOblique' : bold ? 'Courier-Bold' : italic ? 'Courier-Oblique' : 'Courier'
  }
  if (/times|serif|roman/i.test(family)) {
    return bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman'
  }
  return bold && italic ? 'Helvetica-BoldOblique' : bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica'
}

/**
 * Restyle text that is already on the page — font family, size, fill colour.
 *
 * Extraction happens ONCE for the whole batch, for the same reason
 * `transformTextBlocks` does it: block ids are extraction indices, and a
 * rewrite renumbers everything after it.
 */
function restyleTextBlocks(
  pageIndex: number,
  ops: BlockStyleOp[]
): { results: BlockTransformResult[]; applied: number } {
  if (!pdfDoc) {
    return {
      results: ops.map(o => ({ blockId: o.blockId, success: false, error: 'No document' })),
      applied: 0
    }
  }

  let pageData: PageTextData
  try {
    pageData = extractPageText(pageIndex)
  } catch (err: any) {
    return {
      results: ops.map(o => ({ blockId: o.blockId, success: false, error: err.message || String(err) })),
      applied: 0
    }
  }

  const results: BlockTransformResult[] = []
  let applied = 0

  for (const op of ops) {
    const targetBlock = pageData.blocks.find(b => b.id === op.blockId)
    if (!targetBlock) {
      results.push({ blockId: op.blockId, success: false, error: `Block ${op.blockId} not found` })
      continue
    }

    // Nothing asked for is not an edit. Every stream rewrite is a chance to
    // match the wrong block, so it has to be earned.
    if (op.fontName === undefined && op.fontSize === undefined && op.color === undefined) {
      results.push({ blockId: op.blockId, success: true, strategy: 'noop' })
      continue
    }

    let outcome: { success: boolean; error?: string; strategy?: string; lines?: number; baselineDrop?: number } | null = null
    try {
      for (const src of getContentSources(pageIndex)) {
        outcome = withSource(src, () => restyleInSource(src, pageIndex, targetBlock, op))
        if (outcome) break
      }
    } catch (err: any) {
      outcome = { success: false, error: err.message || String(err) }
    }

    if (!outcome) outcome = { success: false, error: 'Could not find matching text in content stream' }
    if (outcome.success) applied++
    results.push({ blockId: op.blockId, ...outcome })
  }

  return { results, applied }
}

/**
 * Restyle work for ONE content stream. Returns null when it holds no match.
 *
 * Two rewrites, because they carry very different risk:
 *
 * - Size and colour are applied SURGICALLY: the `Tf` operand and the fill
 *   colour operator are rewritten in place and every show op, TJ kern array and
 *   Td offset is left exactly as the generator wrote it. The text's encoding
 *   never changes, so nothing can be garbled — and justified text stays
 *   justified, which a rebuild cannot promise.
 * - A font FAMILY change cannot be surgical: the bytes in the string literals
 *   are codes into the OLD font's encoding, and pointing them at a different
 *   font renders mojibake. The run is decoded, re-encoded as WinAnsi and the BT
 *   block rebuilt around a freshly registered base-14 face — which costs the
 *   original kerning, the price of changing typeface at all.
 *
 * Either way the block is wrapped in `q`/`Q`. Font, size and colour are all
 * graphics state that outlives `ET`, so without the save/restore, restyling one
 * line silently restyles every later line that inherited its state — the same
 * trap `rebuildBtContent` documents for `Tf`, and it applies to colour too.
 */
/**
 * Move a block's text matrix down the page by `dropPagePts`.
 *
 * The delta arrives in PAGE space and the Tm lives inside the enclosing CTM, so
 * it goes through the inverse the same way `transformInSource` does it — a page
 * that wraps text in `0.24 0 0 -0.24 cm` would otherwise move by a quarter of
 * what was asked, in the wrong direction.
 */
function dropBaselineInBlock(inner: string, stream: string, blockStart: number, dropPagePts: number): string {
  if (!(dropPagePts > 0.05)) return inner

  // Page space is y-down; Tm space is y-up.
  const dy = -dropPagePts
  let dxL = 0
  let dyL = dy
  const ctm = getFullCtmAtOffset(stream, blockStart)
  const det = ctm[0] * ctm[3] - ctm[1] * ctm[2]
  if (Math.abs(det) > 1e-9) {
    const ib = -ctm[1] / det
    const ic = -ctm[2] / det
    const id = ctm[0] / det
    dxL = dy * ic
    dyL = dy * id
  }

  const tmRegex = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/
  // Masked so digits inside "(1 0 0 1 5 5 Tm)" cannot be mistaken for the
  // operator; the mask preserves length, so the offset is valid in `inner`.
  const hit = maskStreamLiterals(inner).match(tmRegex)
  if (!hit || hit.index === undefined) return inner
  const real = inner.slice(hit.index, hit.index + hit[0].length).match(tmRegex)
  if (!real) return inner

  const n = real.slice(1, 7).map(parseFloat)
  const rewritten =
    `${fmtNum(n[0])} ${fmtNum(n[1])} ${fmtNum(n[2])} ${fmtNum(n[3])} ` +
    `${fmtNum(n[4] + dxL)} ${fmtNum(n[5] + dyL)} Tm`
  return inner.slice(0, hit.index) + rewritten + inner.slice(hit.index + hit[0].length)
}

function restyleInSource(
  src: ContentSource,
  pageIndex: number,
  targetBlock: TextBlock,
  op: BlockStyleOp
): { success: boolean; error?: string; strategy?: string; lines?: number; baselineDrop?: number } | null {
  try {
    const stream = src.stream

    const fontRefs = [...new Set([...stream.matchAll(/\/([A-Za-z0-9_.+-]+)\s+[\d.]+\s+Tf/g)].map(m => m[1]))]
    const fontRefToBaseName = new Map<string, string>()
    for (const fontRef of fontRefs) {
      getFontEncoding(pageIndex, fontRef)
      let page2: any = null
      try {
        page2 = pdfDoc!.loadPage(pageIndex)
        const fDict = resolveResources(page2.getObject())?.get('Font')?.get(fontRef)
        if (fDict) {
          const baseFontStr = fDict.resolve().get('BaseFont')?.toString?.() || ''
          fontRefToBaseName.set(fontRef, baseFontStr.replace(/^\//, ''))
        }
      } catch (_) {
      } finally {
        try { page2?.destroy() } catch (_) { /* already destroyed */ }
      }
    }

    const targetFontRef = findMatchingFontRef(targetBlock.fontName, fontRefToBaseName)
    const pageHeight = getPageSize(pageIndex).height
    const matchedBlocks = findBtBlocksByPosition(stream, pageIndex, targetBlock, targetFontRef, pageHeight)
    if (!matchedBlocks || matchedBlocks.length === 0) return null

    // The face is registered once for the whole op, not per BT block: every
    // matched block is the same run of text and wants the same resource.
    let newFontRef: string | null = null
    let newFontName: string | null = null
    if (op.fontName) {
      newFontName = styledBase14(op.fontName, targetBlock)
      const page = pdfDoc!.loadPage(pageIndex)
      try {
        newFontRef = ensureStandardFont(page.getObject(), newFontName)
      } finally {
        try { page.destroy() } catch (_) { /* already destroyed */ }
      }
    }

    const colorOp = op.color
      ? `${fmtNum(op.color[0])} ${fmtNum(op.color[1])} ${fmtNum(op.color[2])} rg`
      : null

    interface Splice { start: number; end: number; text: string }
    const splices: Splice[] = []
    let usedStrategy: string | undefined

    /**
     * The `Tf` operand is NOT the visible size.
     *
     * Quartz and Distiller draw with `/F3.0 1 Tf` and keep the scale in the
     * text matrix (`12 0 0 -12 … Tm`); writing 24 into that Tf renders at
     * 24 × 12 = 288pt. What IS well defined is the ratio between the size the
     * user asked for and the size MuPDF reports for this block — the product of
     * both — so the ratio is what gets applied, to whatever operand is there.
     */
    const sizeRatio = op.fontSize !== undefined && targetBlock.fontSize > 0.01
      ? op.fontSize / targetBlock.fontSize
      : null
    if (op.fontSize !== undefined && sizeRatio === null) {
      return { success: false, error: 'Cannot resize: the engine reports no font size for this text' }
    }
    // Font-ref names are among the tokens `maskStreamLiterals` blanks out, so a
    // Tf lookup has to run on the raw content — the same way `transformInSource`
    // and `rebuildBtContent` do it. Colour operators are pure numbers and are
    // matched on the masked copy, where "(1 0 0 rg)" as literal text cannot lie.
    const TF_RE = /(\/[A-Za-z0-9_.+-]+\s+)([\d.]+)(\s+Tf)/g

    /**
     * Does the text still fit between its left edge and the right margin?
     *
     * Growing a font grows the run by the same ratio, and a content stream has
     * no margin of its own: the glyphs are simply drawn past the edge of the
     * paper, where they are neither visible nor recoverable. When that would
     * happen the run is re-emitted wrapped, which needs the rebuild path — the
     * surgical Tf rewrite cannot produce a second line.
     */
    const pageWidth = getPageSize(pageIndex).width
    const available = pageWidth - targetBlock.x - PAGE_RIGHT_MARGIN
    const overflows = sizeRatio !== null && sizeRatio > 1 &&
      targetBlock.width * sizeRatio > available && available > 0
    let drawnLines = 1

    /**
     * A bigger font grows UPWARD from the baseline as well as down, so a resized
     * run climbs straight into the line above it — at 30pt over a 12pt page the
     * two were fully interleaved. The run descends by the ascent it gained,
     * which is done HERE rather than as a follow-up move because wrapping
     * changes the block's text and it could not be re-found afterwards.
     *
     * The drop is the WHOLE em gained, not just the ascent: 0.8em cleared the
     * cap height but still let a 30pt ascender into the descender zone of the
     * 12pt line above. Erring high only adds leading, and the caller makes the
     * same room below, so the run stays centred in the space it was given.
     */
    const baselineDrop = op.fontSize !== undefined && targetBlock.fontSize > 0.01
      ? Math.max(0, op.fontSize - targetBlock.fontSize)
      : 0

    for (const block of matchedBlocks) {
      let inner: string
      /** Emitted between the `q` and the `BT` when the block sets no colour of its own. */
      let colorPrefix = ''

      if (!newFontRef && overflows && sizeRatio !== null) {
        if (matchLength(block.decodedText) > matchLength(targetBlock.text) * 1.4 + 4) {
          return {
            success: false,
            error: 'Cannot resize: the text would run past the margin and this run shares its BT block with other text'
          }
        }
        // Measured at the size the text will BE — the same routine the
        // replacement path uses, so a resize and a retype wrap identically.
        const wrapped = layoutReplacementLines(block.decodedText, targetBlock, pageWidth, sizeRatio)

        const plan = planTextEncoding(
          pageIndex,
          { mode: block.mode, fontRef: block.fontRef, encoding: block.encoding },
          wrapped,
          targetBlock
        )
        if (plan.kind === 'error') return { success: false, error: plan.error }

        const tf = block.content.match(/\/[A-Za-z0-9_.+-]+\s+([\d.]+)\s+Tf/)
        const cur = tf ? parseFloat(tf[1]) : NaN
        const sizeOverride = Number.isFinite(cur) ? cur * sizeRatio : undefined

        inner = plan.kind === 'keep-hex'
          ? rebuildBtContent(block.content, plan.hexLines, null, true, sizeOverride, colorOp)
          : plan.kind === 'keep-plain'
            ? rebuildBtContent(block.content, plan.byteLines, null, false, sizeOverride, colorOp)
            : rebuildBtContent(block.content, substLines(plan), plan.fontRef, !!plan.hex, sizeOverride, colorOp, block.inheritedTf)

        inner = stripActualText(inner)
        inner = dropBaselineInBlock(inner, stream, block.start, baselineDrop)
        drawnLines = Math.max(drawnLines, wrapped.length)
        usedStrategy ??= 'tf_scale_wrapped'
        splices.push({ start: block.start, end: block.end, text: `q${colorPrefix} BT${inner}ET Q` })
        continue
      }

      if (newFontRef) {
        // Re-encoding rewrites every glyph in the block, so a block that draws
        // more than the target would lose the rest of its text to this edit —
        // the same trap the replacement path guards against.
        if (matchLength(block.decodedText) > matchLength(targetBlock.text) * 1.4 + 4) {
          return {
            success: false,
            error: 'Cannot change the font: this run shares its BT block with other text'
          }
        }
        const enc = encodeWinAnsiText(block.decodedText)
        if ('missing' in enc) {
          return {
            success: false,
            error: `Cannot switch font: ${enc.missing.join(', ')} is not available in ${newFontName}`
          }
        }
        let sizeOverride: number | undefined
        if (sizeRatio !== null) {
          const tf = block.content.match(/\/[A-Za-z0-9_.+-]+\s+([\d.]+)\s+Tf/)
          const cur = tf ? parseFloat(tf[1]) : NaN
          if (Number.isFinite(cur)) sizeOverride = cur * sizeRatio
        }
        inner = rebuildBtContent(block.content, [enc.bytes], newFontRef, false, sizeOverride, colorOp, block.inheritedTf)
        usedStrategy ??= 'rebuild_font'
      } else {
        inner = block.content
        if (sizeRatio !== null) {
          const hits = [...inner.matchAll(TF_RE)]
          if (hits.length === 0) {
            return {
              success: false,
              error: 'Cannot resize: this run inherits its font size from outside its own BT block'
            }
          }
          for (const h of hits.reverse()) {
            const scaled = (parseFloat(h[2]) || 0) * sizeRatio
            inner = inner.slice(0, h.index!) + h[1] + fmtNum(scaled) + h[3] + inner.slice(h.index! + h[0].length)
          }
          usedStrategy ??= 'tf_scale'
        }
        if (colorOp) {
          const hits = [...maskStreamLiterals(inner).matchAll(/[\d.]+(?:\s+[\d.]+){0,3}\s+(?:rg|g|k|sc|scn)\b/g)]
          for (const h of hits.reverse()) {
            inner = inner.slice(0, h.index!) + colorOp + inner.slice(h.index! + h[0].length)
          }
          // Nothing to overwrite: this run inherits its colour from before the
          // BT (Quartz sets `0.3 sc` outside it). The new one goes in the same
          // place — ahead of the text object — because that is where MuPDF's
          // extractor picks the fill colour up from. Emitting it INSIDE renders
          // correctly but reports back as black, so the toolbar would show the
          // wrong swatch the next time the block was selected.
          if (hits.length === 0) colorPrefix = ` ${colorOp}`
          usedStrategy ??= 'color_rewrite'
        }
      }

      inner = dropBaselineInBlock(inner, stream, block.start, baselineDrop)
      splices.push({ start: block.start, end: block.end, text: `q${colorPrefix} BT${inner}ET Q` })
    }

    if (splices.length === 0) return null

    let modifiedStream = stream
    for (const sp of splices.sort((a, b) => b.start - a.start)) {
      modifiedStream = modifiedStream.slice(0, sp.start) + sp.text + modifiedStream.slice(sp.end)
    }

    // A rewrite that changed nothing is a failure, not a success. Reporting it
    // as applied is worse than reporting the error: the status bar says the
    // style landed, the page plainly disagrees, and the user has no idea which
    // to believe.
    if (modifiedStream === stream) {
      return { success: false, error: 'The style operators for this text could not be located' }
    }

    const streamBytes = new Uint8Array(modifiedStream.length)
    for (let i = 0; i < modifiedStream.length; i++) {
      streamBytes[i] = modifiedStream.charCodeAt(i) & 0xFF
    }

    src.write(streamBytes)
    invalidateContentSources(pageIndex)
    return {
      success: true,
      strategy: (src.key === 'page' ? '' : src.key + ':') + (usedStrategy ?? ''),
      lines: drawnLines,
      baselineDrop
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

// ── CTM tracking (q/Q/cm) so Tm edits can convert page-space deltas to local space ──

type Mat6 = [number, number, number, number, number, number]

/** Row-vector affine concat: apply A then B (PDF cm pre-concatenation: CTM' = Mcm × CTM). */
function matConcat(A: Mat6, B: Mat6): Mat6 {
  return [
    A[0] * B[0] + A[1] * B[2],
    A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2],
    A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4],
    A[4] * B[1] + A[5] * B[3] + B[5]
  ]
}

/**
 * Compute the effective CTM at a given stream offset by replaying q/Q/cm
 * operators. String literals are masked first so 'q' bytes inside text
 * can't corrupt the graphics-state stack.
 */
function getCtmAtOffset(stream: string, offset: number): Mat6 {
  let masked = stream.slice(0, offset)
  masked = masked.replace(/\((?:\\.|[^()\\])*\)/g, m => ' '.repeat(m.length))
  masked = masked.replace(/<[0-9A-Fa-f\s]*>/g, m => ' '.repeat(m.length))

  const stack: Mat6[] = []
  let ctm: Mat6 = [1, 0, 0, 1, 0, 0]
  const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm\b|(?:^|[\s\]>])([qQ])(?=[\s(<\[/%]|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    if (m[7] === 'q') stack.push([...ctm] as Mat6)
    else if (m[7] === 'Q') ctm = stack.pop() || [1, 0, 0, 1, 0, 0]
    else ctm = matConcat([+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]], ctm)
  }
  return ctm
}

/**
 * Byte range of the show-op run that draws the target text, and whether that
 * run begins a line (i.e. a positioning operator precedes it with no show op
 * in between).
 *
 * Needed to move ONE line out of a block that draws many. Adobe and TeX emit a
 * single BT whose lines are all positioned by Td/T* off one shared Tm; nudging
 * that Tm slides every line at once — dragging one label moved 34 blocks.
 */
function findTargetRun(
  block: BtInfo,
  targetText: string,
  pageIndex: number,
  /**
   * Where the clicked text sits in this block's own space, when it can be
   * worked out. A run that does not OVERLAP it is not the run: text alone
   * never identifies anything here, which is the same rule
   * `findBtBlocksByPosition` follows one level up. Three signature rules drawn
   * as one array score alike on text — a row of underscores fuzzy-matches any
   * other row of underscores — so once the first had been split out of the
   * array the other two both matched IT and were moved on top of it.
   */
  local?: { x: number; xEnd: number } | null
): { start: number; end: number; startsLine: boolean } | null {
  const targetNorm = targetText.replace(/\s+/g, ' ').trim()
  if (!targetNorm) return null
  const ops = scanShowOps(block.content, block.encoding, getSimpleFontInfo(pageIndex, block.fontRef),
    (name) => ({ encoding: getFontEncoding(pageIndex, name), simpleInfo: getSimpleFontInfo(pageIndex, name) }))
  if (ops.length === 0) return null

  let best: { i: number; j: number; score: number } | null = null
  for (let i = 0; i < ops.length; i++) {
    let acc = ''
    for (let j = i; j < ops.length; j++) {
      acc += ops[j].decoded
      const norm = acc.replace(/\s+/g, ' ').trim()
      if (norm.length > targetNorm.length * 1.5 + 8) break
      if (!norm) continue
      const ratio = matchRatio(norm, targetNorm)
      if (ratio < 0.7) continue
      let score = 0
      if (norm === targetNorm) score = 2
      else if (fuzzyTextMatch(norm, targetNorm)) score = ratio
      if (score > 0 && (!best || score > best.score)) best = { i, j, score }
    }
  }
  if (!best) return null

  // Does the winning run actually sit on the clicked text? Measured on real
  // advances, so it is only asked when every width is known; where it cannot be
  // answered the run stands, exactly as it did before.
  if (local) {
    const state = textStateAtOp(block, ops, best.i, pageIndex)
    if (state) {
      let width = 0
      let known = true
      for (let k = best.i; k <= best.j && known; k++) {
        const op = ops[k]
        const fr = op.fontRef && op.fontRef !== block.fontRef
          ? { encoding: getFontEncoding(pageIndex, op.fontRef), simpleInfo: getSimpleFontInfo(pageIndex, op.fontRef) }
          : { encoding: block.encoding, simpleInfo: getSimpleFontInfo(pageIndex, block.fontRef) }
        const w = showOpAdvance(op, fr.encoding, fr.simpleInfo, state.tfSize, 0, 0)
        if (w === null) known = false
        else width += w
      }
      if (known) {
        const lo = Math.min(local.x, local.xEnd) - 2
        const hi = Math.max(local.x, local.xEnd) + 2
        if (!(state.penX < hi && lo < state.penX + width)) return null
      }
    }
  }

  // A line-leading run has a positioning operator, and no other show op,
  // immediately before it. Inserting a Td in front of a MID-line run would
  // reset the pen to the line start and scramble the rest of that line.
  const runStart = ops[best.i].start
  const prevShowEnd = best.i > 0 ? ops[best.i - 1].end : 0
  const between = maskStreamLiterals(block.content.slice(prevShowEnd, runStart))
  const startsLine = best.i === 0 || /(?:Td|TD|Tm|T\*)/.test(between)

  return { start: runStart, end: ops[best.j].end, startsLine }
}

/**
 * The Tm operator that governs the clicked text inside a BT block.
 *
 * One BT can hold several independent lines, each with its own Tm — SUNAT and
 * JasperReports emit "Tm (line 1) Tj Tm (line 2) Tj ..." as a single block.
 * Rewriting the FIRST Tm, as a plain regex does, then drags a different line
 * than the one the user grabbed.
 *
 * Returns null when the text cannot be located or nothing positions it
 * absolutely, leaving the caller to fall back to whole-block handling.
 */
function findGoverningTm(
  block: BtInfo,
  targetText: string,
  pageIndex: number
): { index: number; text: string } | null {
  const targetNorm = targetText.replace(/\s+/g, ' ').trim()
  if (!targetNorm) return null

  const ops = scanShowOps(block.content, block.encoding, getSimpleFontInfo(pageIndex, block.fontRef),
    (name) => ({ encoding: getFontEncoding(pageIndex, name), simpleInfo: getSimpleFontInfo(pageIndex, name) }))
  if (ops.length === 0) return null

  // Best contiguous run of show-ops whose text matches the target
  let runStart = -1
  let bestScore = 0
  for (let i = 0; i < ops.length; i++) {
    let acc = ''
    for (let j = i; j < ops.length; j++) {
      acc += ops[j].decoded
      const norm = acc.replace(/\s+/g, ' ').trim()
      if (norm.length > targetNorm.length * 1.5 + 8) break
      if (!norm) continue
      const ratio = matchRatio(norm, targetNorm)
      if (ratio < 0.7) continue
      let score = 0
      if (norm === targetNorm) score = 2
      else if (fuzzyTextMatch(norm, targetNorm)) score = ratio
      if (score > bestScore) { bestScore = score; runStart = ops[i].start }
    }
  }
  if (runStart < 0) return null

  // The governing Tm is the last one before that run starts
  const masked = maskStreamLiterals(block.content)
  const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/g
  let found: { index: number; text: string } | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    if (m.index > runStart) break
    found = { index: m.index, text: m[0] }
  }
  return found
}

/**
 * How far a BT block sits from the text block the user clicked, in page points.
 *
 * The block's Tm origin is pushed through the enclosing CTM and flipped into
 * MuPDF's top-left page coords — print-to-PDF files wrap text in matrices like
 * "0.675 0 0 -0.675 28.5 813.42 cm", so raw Tm values are not comparable with a
 * bbox. Distance is measured to the NEAREST point of the target bbox, so a
 * multi-line block whose BT starts on its first line still scores 0.
 *
 * Returns Infinity when the position cannot be established, which sorts the
 * candidate last without discarding it.
 */
function btBlockDistanceToTarget(
  stream: string,
  block: BtInfo,
  targetBlock: TextBlock,
  pageHeight?: number
): number {
  if (pageHeight === undefined || !block.hasPos) return Infinity

  const ctm = getFullCtmAtOffset(stream, block.start)
  const ux = block.xPos * ctm[0] + block.yPos * ctm[2] + ctm[4]
  const uy = block.xPos * ctm[1] + block.yPos * ctm[3] + ctm[5]
  const x = ux
  const y = pageHeight - uy

  const [x0, y0, x1, y1] = targetBlock.bbox
  const nx = Math.min(Math.max(x, Math.min(x0, x1)), Math.max(x0, x1))
  const ny = Math.min(Math.max(y, Math.min(y0, y1)), Math.max(y0, y1))
  return Math.hypot(x - nx, y - ny)
}

/**
 * The innermost rectangular clip still in force at a stream offset.
 *
 * Browser print-to-PDF wraps each header/footer run in its own
 * `q <x y w h> re W* n  q <scale> cm  BT … ET  Q Q`, and the band is barely
 * taller than the line itself. Moving the text without moving that window
 * pushes it outside and it vanishes from both the render and MuPDF's
 * extraction — the text is still in the file, just clipped away.
 *
 * Only the simple `x y w h re W[*] n` form is recognised; anything more
 * complex returns null and the caller leaves the clip alone.
 */
function getActiveClipsAtOffset(
  stream: string,
  offset: number
): { index: number; length: number; rect: [number, number, number, number] }[] {
  type Clip = { index: number; length: number; rect: [number, number, number, number] }
  const masked = maskStreamLiterals(stream.slice(0, offset))
  // Depth marks, not array copies: a Q only ever pops clips added since the
  // matching q, so truncating to the saved length restores the state in O(1).
  // Copying the array per q was O(n^2) and crawled on streams with hundreds of
  // graphics-state saves.
  const depths: number[] = []
  const current: Clip[] = []

  const re = /((-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re)\s+W\*?\s+n\b|((-?[\d.]+)\s+(-?[\d.]+)\s+m\s+(-?[\d.]+)\s+(-?[\d.]+)\s+l\s+(-?[\d.]+)\s+(-?[\d.]+)\s+l\s+(-?[\d.]+)\s+(-?[\d.]+)\s+l\s+h?)\s*W\*?\s+n\b|(?:^|[\s\]>])([qQ])(?=[\s(<\[/%]|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    if (m[15] === 'q') { depths.push(current.length); continue }
    if (m[15] === 'Q') { current.length = depths.length > 0 ? depths.pop()! : 0; continue }
    // Clips INTERSECT, they do not replace one another. Word nests the SAME
    // rectangle twice around a table cell, so widening only the innermost left
    // the outer one still cutting the text off.
    if (m[1] !== undefined) {
      current.push({ index: m.index, length: m[1].length, rect: [+m[2], +m[3], +m[4], +m[5]] })
      continue
    }
    // A rectangle drawn as a PATH — `x0 y0 m x1 y1 l x2 y2 l x3 y3 l h W* n`
    // (ilovepdf clips every table cell this way). Accepted only when the four
    // points really form an axis-aligned rectangle; the rewrite emits the same
    // area as a `re`, which the expansion code already knows how to grow.
    const px = [+m[7], +m[9], +m[11], +m[13]]
    const py = [+m[8], +m[10], +m[12], +m[14]]
    const eq = (a: number, b: number) => Math.abs(a - b) < 0.01
    const hvhv = eq(py[0], py[1]) && eq(px[1], px[2]) && eq(py[2], py[3]) && eq(px[3], px[0])
    const vhvh = eq(px[0], px[1]) && eq(py[1], py[2]) && eq(px[2], px[3]) && eq(py[3], py[0])
    if (!hvhv && !vhvh) continue
    const x0 = Math.min(...px), x1 = Math.max(...px)
    const y0 = Math.min(...py), y1 = Math.max(...py)
    current.push({ index: m.index, length: m[6].length, rect: [x0, y0, x1 - x0, y1 - y0] })
  }
  return current
}

/**
 * Grow a Form XObject's /BBox so bigger text still shows.
 *
 * `ratio` widens it to the right, `heightRatio` deepens it downward — a form
 * sized to one line hides every line an edit adds below it just as surely as a
 * `re W n` clip does.
 */
function widenFormBBox(formDict: any, ratio: number, heightRatio = 1): void {
  if (!pdfDoc || !(ratio > 1)) return
  try {
    const bbox = formDict.get('BBox')
    if (!bbox || String(bbox) === 'null') return
    const arr = bbox.resolve ? bbox.resolve() : bbox
    if (arr.length !== 4) return
    const v = [0, 1, 2, 3].map(i => Number(String(arr.get(i))))
    if (v.some(n => !Number.isFinite(n))) return
    const x0 = Math.min(v[0], v[2]), x1 = Math.max(v[0], v[2])
    const y0 = Math.min(v[1], v[3]), y1 = Math.max(v[1], v[3])
    const grownX = x0 + (x1 - x0) * ratio
    // Down, not up: a form's own space has y increasing upwards like the page's,
    // so the lines an edit adds below the first sit at LOWER y.
    const grownY = y1 - (y1 - y0) * heightRatio
    const widen = grownX > x1 + 0.01
    const deepen = grownY < y0 - 0.01
    if (!widen && !deepen) return
    const out = pdfDoc.newArray()
    out.push(pdfDoc.newReal(x0))
    out.push(pdfDoc.newReal(deepen ? grownY : y0))
    out.push(pdfDoc.newReal(widen ? grownX : x1))
    out.push(pdfDoc.newReal(y1))
    formDict.put('BBox', out)
  } catch (_) { /* leave the box alone rather than corrupt it */ }
}

/**
 * Widened `x y w h re` when replacement text will not fit the clip it is drawn
 * inside, or null when it already fits.
 *
 * Word table cells and Canva text boxes bound each run with a clip barely wider
 * than the original string. Longer replacement text is then cut off mid-word —
 * "Plataforma" edited to "SWEEPMARK0" came back as "SWEEPMA" — which is silent
 * data loss, since the characters are in the file but can never be seen or
 * found again.
 *
 * It has to grow DOWNWARD as well, and for a while it did not. Those same clips
 * are barely one line TALL, so the moment an edit produced a second line — the
 * user pressing Enter, or the right margin forcing a wrap — that line was drawn
 * below the window and clipped away entirely. The text was in the file and
 * simply could not be seen: "I press Enter and the text disappears".
 *
 * Both edges are taken as a UNION with what the clip already covers, the same
 * as `expandClipForTransform`, because that can only ever reveal more of the
 * run it bounds and never hide something that was visible.
 */
function widenClipForText(
  stream: string,
  clip: { index: number; length: number; rect: [number, number, number, number] },
  targetBlock: TextBlock,
  newWidthPage: number,
  extraHeightPage: number,
  pageHeight: number
): string | null {
  const ctm = getFullCtmAtOffset(stream, clip.index)
  const det = ctm[0] * ctm[3] - ctm[1] * ctm[2]
  if (Math.abs(det) < 1e-9) return null
  const ia = ctm[3] / det, ib = -ctm[1] / det
  const ic = -ctm[2] / det, id = ctm[0] / det

  /** User space (bottom-left origin) -> this clip's own space. */
  const toClip = (ux: number, uy: number): [number, number] => {
    const ax = ux - ctm[4], ay = uy - ctm[5]
    return [ax * ia + ay * ic, ax * ib + ay * id]
  }

  const midY = pageHeight - (targetBlock.bbox[1] + targetBlock.bbox[3]) / 2
  const [needX] = toClip(targetBlock.bbox[0] + newWidthPage, midY)
  // The foot of the text once the extra lines are under it. The CTM may flip y,
  // so the mapped point is included in the rect rather than assumed to be below.
  const footY = pageHeight - (targetBlock.bbox[1] + targetBlock.bbox[3] + extraHeightPage)
  const [, needY] = toClip(targetBlock.bbox[0], footY)

  const [rx, ry, rw, rh] = clip.rect
  let x0 = Math.min(rx, rx + rw), x1 = Math.max(rx, rx + rw)
  let y0 = Math.min(ry, ry + rh), y1 = Math.max(ry, ry + rh)
  let grew = false

  if (Number.isFinite(needX) && needX > x1 + 0.5) { x1 = needX; grew = true }
  if (extraHeightPage > 0 && Number.isFinite(needY)) {
    if (needY < y0 - 0.5) { y0 = needY; grew = true }
    else if (needY > y1 + 0.5) { y1 = needY; grew = true }
  }
  if (!grew) return null
  return `${fmtNum(x0)} ${fmtNum(y0)} ${fmtNum(x1 - x0)} ${fmtNum(y1 - y0)} re`
}

/**
 * Rewritten `x y w h re` covering both the original clip window and its
 * transformed self, or null when nothing needs to change.
 *
 * The union — rather than a plain translation — is deliberate: it can only ever
 * reveal more of the group it bounds, never hide something that was visible.
 * Hiding content is the failure being fixed here, so that is the safe direction
 * to err in.
 */
function expandClipForTransform(
  stream: string,
  clip: { index: number; length: number; rect: [number, number, number, number] },
  dx: number, dy: number, sx: number, sy: number,
  anchorX: number, anchorY: number
): string | null {
  // The rect lives in the CTM at the `re` operator, which is NOT the one the
  // text sits in (the text has an extra `cm` inside the clip's q).
  const ctm = getFullCtmAtOffset(stream, clip.index)
  const det = ctm[0] * ctm[3] - ctm[1] * ctm[2]
  if (Math.abs(det) < 1e-9) return null

  const ia = ctm[3] / det, ib = -ctm[1] / det
  const ic = -ctm[2] / det, id = ctm[0] / det
  const dxL = dx * ia + dy * ic
  const dyL = dx * ib + dy * id
  const ax = anchorX - ctm[4], ay = anchorY - ctm[5]
  const anchorXL = ax * ia + ay * ic
  const anchorYL = ax * ib + ay * id

  const [rx, ry, rw, rh] = clip.rect
  const x0 = Math.min(rx, rx + rw), x1 = Math.max(rx, rx + rw)
  const y0 = Math.min(ry, ry + rh), y1 = Math.max(ry, ry + rh)
  const tX = (v: number) => anchorXL + (v - anchorXL) * sx + dxL
  const tY = (v: number) => anchorYL + (v - anchorYL) * sy + dyL

  const nx0 = Math.min(x0, x1, tX(x0), tX(x1))
  const nx1 = Math.max(x0, x1, tX(x0), tX(x1))
  const ny0 = Math.min(y0, y1, tY(y0), tY(y1))
  const ny1 = Math.max(y0, y1, tY(y0), tY(y1))

  const unchanged = Math.abs(nx0 - x0) < 0.01 && Math.abs(nx1 - x1) < 0.01 &&
                    Math.abs(ny0 - y0) < 0.01 && Math.abs(ny1 - y1) < 0.01
  if (unchanged) return null

  return `${fmtNum(nx0)} ${fmtNum(ny0)} ${fmtNum(nx1 - nx0)} ${fmtNum(ny1 - ny0)} re`
}

/** Format a number for PDF content stream (avoid excessive decimals) */
function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n)
  // Use enough precision for position/scale values
  const s = n.toFixed(4)
  // Strip trailing zeros
  return s.replace(/\.?0+$/, '') || '0'
}

/**
 * Mask string literals (with one nesting level), hex strings and name tokens
 * with spaces of identical length, so operator scans (BT/ET, q/Q, Tm…) can
 * never match text INSIDE a literal like "(BUDGET REPORT)" or "/GS_ET".
 * Offsets in the masked string map 1:1 to the original.
 */
function maskStreamLiterals(stream: string): string {
  return stream
    .replace(/\((?:\\.|[^()\\]|\((?:\\.|[^()\\])*\))*\)/g, m => '(' + ' '.repeat(m.length - 2) + ')')
    .replace(/<[0-9A-Fa-f\s]*>/g, m => '<' + ' '.repeat(Math.max(m.length - 2, 0)) + '>')
    .replace(/\/[^\s<>[\]()/%]+/g, m => '/' + ' '.repeat(m.length - 1))
}

/**
 * Text-space position where a BT block starts drawing.
 *
 * BT resets the text/line matrix to the identity, so replaying the
 * positioning operators (Tm, Td, TD, TL, T* and the implicit T* of the
 * quote operators) up to the FIRST show-text op yields the block's origin.
 * Reading only `Tm` — as this used to — reports "no position" for the very
 * common `BT x y Td (text) Tj ET` shape emitted by wkhtmltopdf/FPDF/TCPDF,
 * which silently disabled line grouping and move/resize for those files.
 *
 * `masked` must be the literal-masked content (see maskStreamLiterals) so
 * digits inside a string like "(1 0 0 1 5 5 Tm)" can't be read as operators.
 */
function getBlockOrigin(masked: string): { x: number; y: number; hasPos: boolean; hasTm: boolean } {
  const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm\b|(-?[\d.]+)\s+(-?[\d.]+)\s+(Td|TD)\b|(-?[\d.]+)\s+TL\b|T\*|\)\s*(?:Tj|TJ|'|")|>\s*(?:Tj|TJ|'|")|\]\s*TJ/g
  let x = 0, y = 0, leading = 0
  let hasPos = false, hasTm = false
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    if (m[1] !== undefined) {            // Tm — absolute line matrix
      x = parseFloat(m[5]); y = parseFloat(m[6])
      hasPos = true; hasTm = true
      continue
    }
    if (m[7] !== undefined) {            // Td / TD — relative to the line matrix
      x += parseFloat(m[7]); y += parseFloat(m[8])
      if (m[9] === 'TD') leading = -parseFloat(m[8])
      hasPos = true
      continue
    }
    if (m[10] !== undefined) { leading = parseFloat(m[10]); continue } // TL
    if (m[0] === 'T*') { y -= leading; hasPos = true; continue }
    // First show-text op — the pen is where the block starts drawing.
    // ' and " carry an implicit T*, but the block still starts on this line.
    break
  }
  return { x, y, hasPos, hasTm }
}

/**
 * Scan a content stream for BT...ET blocks, immune to "BT"/"ET" byte
 * sequences inside string literals or name tokens. Content is sliced from the
 * ORIGINAL stream so downstream regexes see the real bytes.
 */
function scanBtBlocks(stream: string, pageIndex: number): BtInfo[] {
  const masked = maskStreamLiterals(stream)

  // Font state persists across BT/ET — it is a property of the graphics state,
  // not of the text object. Corel sets Tf BEFORE the BT and leaves the block
  // itself fontless: requiring a Tf inside dropped 71 of that page's 95 blocks
  // outright, so most of the page could not be edited at all.
  const tfBefore: { at: number; name: string; raw: string }[] = []
  const tfRe = /\/([^\s<>[\]()/%]+)\s+[\d.-]+\s+Tf/g
  {
    let t: RegExpExecArray | null
    const maskedTf = /\/[ ]*\s+[\d.-]+\s+Tf/g
    while ((t = maskedTf.exec(masked)) !== null) {
      const nameMatch = stream.slice(t.index).match(/^\/([^\s<>[\]()/%]+)/)
      // `raw` is the operator VERBATIM — name AND size — because a rebuild that
      // substitutes a font has to put back exactly what the block inherited,
      // and the size is half of that. Slicing the ORIGINAL stream at a masked
      // offset is sound: maskStreamLiterals preserves length 1:1.
      if (nameMatch) {
        tfBefore.push({
          at: t.index,
          name: nameMatch[1],
          raw: stream.slice(t.index, t.index + t[0].length)
        })
      }
    }
  }
  void tfRe
  /** Font in force at a stream offset. */
  const fontAt = (offset: number): string | null => {
    let found: string | null = null
    for (const t of tfBefore) {
      if (t.at > offset) break
      found = t.name
    }
    return found
  }
  /** The whole Tf operator in force at a stream offset (`/TT1 11.04 Tf`). */
  const fontOpAt = (offset: number): string | null => {
    let found: string | null = null
    for (const t of tfBefore) {
      if (t.at > offset) break
      found = t.raw
    }
    return found
  }

  const re = /(?<![A-Za-z0-9])BT(?![A-Za-z0-9])([\s\S]*?)(?<![A-Za-z0-9])ET(?![A-Za-z0-9])/g
  const out: BtInfo[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    const start = m.index
    const end = m.index + m[0].length
    const content = stream.slice(start + 2, end - 2)
    const maskedContent = masked.slice(start + 2, end - 2)

    const fontMatch = maskedContent.match(/\/[ ]*\s+[\d.-]+\s+Tf/)
    let fontRef: string | null = null
    if (fontMatch) {
      const nameMatch = content.slice(fontMatch.index).match(/^\/([^\s<>[\]()/%]+)/)
      fontRef = nameMatch ? nameMatch[1] : null
    }

    // EVERY font the block uses, not just the first. One BT can switch fonts
    // per run (Ghostscript tables, or this engine's own substitutions), and a
    // font filter that only knows the first Tf rejects the very block that
    // draws the target — which is how a block became uneditable a second time
    // after an edit substituted Helvetica into it.
    const fonts: string[] = []
    let headDrawsInherited = false
    {
      const tfAll = /\/[ ]*\s+[\d.-]+\s+Tf/g
      let fm: RegExpExecArray | null
      let firstTfAt = -1
      while ((fm = tfAll.exec(maskedContent)) !== null) {
        if (firstTfAt < 0) firstTfAt = fm.index
        const nm = content.slice(fm.index).match(/^\/([^\s<>[\]()/%]+)/)
        if (nm && !fonts.includes(nm[1])) fonts.push(nm[1])
      }
      // The font inherited from outside the BT only DRAWS something here when a
      // show op precedes the block's first Tf (or it has none). Listing it
      // unconditionally made a bold "18.00" cell claim the regular font of the
      // stream above it and slip through the font filter for a "10.00" edit.
      const firstLit = maskedContent.search(/\(|<[^<]/)
      if (firstTfAt < 0 || (firstLit >= 0 && firstLit < firstTfAt)) {
        headDrawsInherited = true
        const inherited = fontAt(start)
        if (inherited && !fonts.includes(inherited)) fonts.push(inherited)
      }
    }
    // No Tf inside: inherit whatever was in force when the block opened, and
    // keep the operator itself — a rebuild that substitutes a font must restore
    // THIS on the way out, or the substitute becomes the inherited font of
    // every block after it (see rebuildBtContent's restoreTf).
    //
    // The SAME applies when the block has a Tf but its first show op runs
    // BEFORE it: the head is drawn in the entering font, so decoding it with
    // the block's own first Tf reads the wrong CMap. This signed order draws
    // "Plazo de ejecución" under the /C0_1 in force from the previous block,
    // then switches to /C0_7 mid-block — labelled C0_7, the head decoded as
    // "7ECIFNDDNDEDCICEMFN" and no edit on the block's 20 lines could match.
    // The decoder follows every in-block Tf, so starting from the entering
    // font changes only the head runs, which are exactly the ones it got wrong.
    let inheritedTf: string | null = null
    if (!fontRef) {
      fontRef = fontAt(start)
      inheritedTf = fontOpAt(start)
    } else if (headDrawsInherited) {
      const entering = fontAt(start)
      if (entering) {
        fontRef = entering
        inheritedTf = fontOpAt(start)
      }
    }
    if (!fontRef) continue

    const origin = getBlockOrigin(maskedContent)

    const encoding = getFontEncoding(pageIndex, fontRef)
    const mode = detectBlockEncoding(content)
    const decodedText = decodeBtBlockText(
      content, encoding, getSimpleFontInfo(pageIndex, fontRef),
      (name) => ({
        encoding: getFontEncoding(pageIndex, name),
        simpleInfo: getSimpleFontInfo(pageIndex, name)
      })
    )

    out.push({
      content,
      start,
      end,
      fontRef,
      fonts,
      inheritedTf,
      yPos: origin.y,
      xPos: origin.x,
      hasPos: origin.hasPos,
      hasTm: origin.hasTm,
      decodedText,
      mode,
      encoding,
      hasSubstantialText: decodedText.trim().length > 1
    })
  }
  return out
}

/**
 * Find the BT/ET blocks in the content stream that match a given TextBlock.
 * Reuses the same matching strategy as replaceTextInContentStreamFontAware.
 */
function findMatchingBtBlocks(
  stream: string,
  pageIndex: number,
  targetBlock: TextBlock,
  targetFontRef: string | null
): BtInfo[] | null {
  const allBlocks = scanBtBlocks(stream, pageIndex)

  const normalizedTarget = targetBlock.text.replace(/\s+/g, ' ').trim()

  // Try line-grouped matching first
  const lineGroups = new Map<number, BtInfo[]>()
  for (const block of allBlocks) {
    if (!block.hasPos) continue
    const yKey = Math.round(block.yPos * 2) / 2
    if (!lineGroups.has(yKey)) lineGroups.set(yKey, [])
    lineGroups.get(yKey)!.push(block)
  }

  for (const [, lineBlocks] of lineGroups) {
    if (lineBlocks.length < 2) continue
    const lineText = lineBlocks.map(b => b.decodedText).join('')
    const normalizedLine = lineText.replace(/\s+/g, ' ').trim()
    if (!normalizedLine || normalizedLine.length < 2) continue

    if (normalizedLine === normalizedTarget || fuzzyTextMatch(normalizedLine, normalizedTarget)) {
      return lineBlocks
    }
  }

  // Fallback: single-block matching
  for (const block of allBlocks) {
    if (targetFontRef && !blockUsesFont(block, targetFontRef)) continue
    const normalizedDecoded = block.decodedText.replace(/\s+/g, ' ').trim()
    if (!normalizedDecoded || normalizedDecoded.length < 2) continue

    if (normalizedDecoded === normalizedTarget || fuzzyTextMatch(normalizedDecoded, normalizedTarget)) {
      return [block]
    }
  }

  return null
}

/**
 * Position-based BT block matching for transforms.
 *
 * Text alone cannot identify a block: the same string often appears several
 * times on a page. Every textual match is therefore ranked by how far it sits
 * from the block the user clicked (in page points, via the enclosing CTM), and
 * the nearest one wins. Comparing raw Tm values against a page-space bbox — as
 * this used to — is wrong for any file that scales or flips text with a `cm`.
 */
function findBtBlocksByPosition(
  stream: string,
  pageIndex: number,
  targetBlock: TextBlock,
  targetFontRef: string | null,
  pageHeight?: number
): BtInfo[] | null {
  // Position matching needs a text-space origin; skip blocks without any
  // positioning operator at all (they draw at the identity origin).
  const allBlocks = scanBtBlocks(stream, pageIndex).filter(b => b.hasPos)
  const normalizedTarget = targetBlock.text.replace(/\s+/g, ' ').trim()

  const distCache = new Map<number, number>()
  const distOf = (b: BtInfo) => {
    let d = distCache.get(b.start)
    if (d === undefined) {
      d = btBlockDistanceToTarget(stream, b, targetBlock, pageHeight)
      distCache.set(b.start, d)
    }
    return d
  }
  // A block counts as "on" the clicked text when its origin lands within about
  // one line height of the bbox — enough for baseline/descender slack, tight
  // enough to exclude a neighbour sharing the same line.
  const onTarget = Math.max(6, targetBlock.height || 0)

  interface Candidate { blocks: BtInfo[]; score: number; dist: number; order: number }
  const candidates: Candidate[] = []

  // Line groups — MuPDF often merges several BT blocks into one TextBlock
  //
  // Read ACROSS the line as well as along the stream, because the target text is
  // in reading order and a content stream is under no obligation to be. One
  // producer emits a field's VALUE before its label, so the group read back as
  // "NO" + "Indicador de retorno de vehículo vacío:" and matched nothing at all;
  // only the label's own block did, so a reflow moved the label down the page
  // and left the "NO" behind on the old line, beside somebody else's answer.
  //
  // Both orders are tried rather than the sorted one alone. Sorting is right far
  // more often, but it is not always: on one file in the corpus the stream order
  // was the one that matched, and moving to x order alone turned a working drag
  // into "could not find matching text". Trying both can only ever add a match.
  const lineGroups = new Map<number, BtInfo[]>()
  for (const block of allBlocks) {
    const yKey = Math.round(block.yPos * 2) / 2
    if (!lineGroups.has(yKey)) lineGroups.set(yKey, [])
    lineGroups.get(yKey)!.push(block)
  }

  const joinOf = (blocks: BtInfo[]) =>
    blocks.map(b => b.decodedText).join('').replace(/\s+/g, ' ').trim()
  const foldedTarget = foldForMatch(normalizedTarget)
  const readsAs = (line: string) => {
    const foldedLine = foldForMatch(line)
    return fuzzyTextMatch(line, normalizedTarget) ||
      (foldedLine.length > 5 && foldedTarget.length > 5 &&
       (wildcardIncludes(foldedLine, foldedTarget) || foldedTarget.includes(foldedLine)))
  }
  // NOT space-stripped on the containment leg, deliberately: compacting let a
  // line of a WRAPPED pdfTeX paragraph match, and the td-bracket then landed
  // mid-line and sheared the paragraph — the previous line's glyphs interleaved
  // with the moved run. A loud "could not find" is the correct outcome there.

  for (const [, lineBlocks] of lineGroups) {
    const byX = [...lineBlocks].sort((a, b) => a.xPos - b.xPos)
    const alongStream = joinOf(lineBlocks)
    const acrossPage = joinOf(byX)
    const orders = acrossPage === alongStream ? [acrossPage] : [acrossPage, alongStream]
    let exact = orders.some(o => o === normalizedTarget)
    let isMatch = exact || orders.some(readsAs)
    let runBlocks: BtInfo[] | null = null

    // A contiguous RUN of the line's blocks. Extraction merges adjacent cells —
    // "SI" and "NO" a few points apart read back as one "SINO" block — and no
    // whole-line join matches that. Same search the replace matcher runs.
    if (!isMatch && lineBlocks.length > 1) {
      outer:
      for (const sorted of [byX, [...lineBlocks].sort((a, b) => a.start - b.start)]) {
        for (let i = 0; i < sorted.length; i++) {
          let acc = ''
          for (let j = i; j < sorted.length; j++) {
            acc += sorted[j].decodedText
            const norm = acc.replace(/\s+/g, ' ').trim()
            if (norm.length > normalizedTarget.length * 1.5 + 8) break
            if (norm === normalizedTarget) {
              runBlocks = sorted.slice(i, j + 1)
              exact = true; isMatch = true
              break outer
            }
          }
        }
      }
    }
    if (!isMatch) continue

    // Keep only the blocks sitting on the clicked text. A line group can hold
    // unrelated runs (a label and its value); transforming the whole group
    // would drag the label along.
    const near = lineBlocks.filter(b => distOf(b) <= onTarget)
    // A containment match ("the joined text has the target somewhere in it")
    // with NO member on the clicked position must keep only the members that
    // actually CARRY the target. A Ghostscript mega-block whose join contains
    // every cell of the table put "710.00" into a header-row group, and taking
    // the whole group moved the header row. Members that merely share the line
    // are dropped; when none carries it (the target spans blocks), only an
    // exact whole-line match may survive.
    let picked: BtInfo[]
    if (runBlocks) picked = runBlocks
    else if (near.length > 0) picked = near
    else if (exact) picked = lineBlocks
    else {
      const compact = (s: string) => foldForMatch(s).replace(/\s+/g, '').replace(ACCENT_MARKS, '')
      const carrying = lineBlocks.filter(b => wildcardIncludes(compact(b.decodedText), compact(normalizedTarget)))
      if (carrying.length === 0) continue
      picked = carrying
    }
    candidates.push({
      blocks: picked,
      score: exact ? 2 : 1,
      dist: Math.min(...picked.map(distOf)),
      order: candidates.length
    })
  }

  // Single blocks
  for (const block of allBlocks) {
    if (targetFontRef && !blockUsesFont(block, targetFontRef)) continue
    const nd = block.decodedText.replace(/\s+/g, ' ').trim()
    if (!nd || nd.length < 2) continue
    const exact = nd === normalizedTarget
    if (exact || fuzzyTextMatch(nd, normalizedTarget)) {
      candidates.push({ blocks: [block], score: exact ? 2 : 1, dist: distOf(block), order: candidates.length })
    }
  }

  // Fake-bold double draws (see the replace matcher): the target reads
  // doubled because the same run is drawn twice. Move BOTH copies.
  const halvedT = undouble(normalizedTarget)
  if (halvedT) {
    for (const block of allBlocks) {
      if (targetFontRef && !blockUsesFont(block, targetFontRef)) continue
      const nd = block.decodedText.replace(/\s+/g, ' ').trim()
      if (nd !== halvedT) continue
      const twin = allBlocks.find(o => o !== block &&
        o.decodedText.replace(/\s+/g, ' ').trim() === halvedT &&
        Math.abs(o.xPos - block.xPos) < 3 && Math.abs(o.yPos - block.yPos) < 3)
      candidates.push({
        blocks: twin ? [block, twin] : [block],
        score: 1.5, dist: distOf(block), order: candidates.length
      })
    }
  }

  // Last resort: ONE LINE of a block that draws several.
  //
  // Both passes above ask whether a block's WHOLE text reads as the target, so
  // a single line of a many-line block is only reachable through the
  // containment test — and that one demands more than five characters on both
  // sides. Table cells are mostly shorter: "N°", "GTIN", "Bien", "1", "NO".
  // They matched nothing, and a move that cannot find its text does not fail
  // loudly; it simply does not happen. That is how a reflowed table came apart,
  // the long cells moving down and the short ones staying behind on the rules.
  //
  // What makes this safe at two characters is that the text is not asked to
  // carry the identification on its own: the block has to SIT on the target,
  // and `findGoverningTm` has to find a run inside it that reads as the target.
  // It only runs when everything else has already come up empty, so no match
  // that worked before can change.
  if (candidates.length === 0) {
    // The position asked of the BLOCK is its first Tm's — for a Ghostscript
    // table drawn as one huge BT that is the top-left cell, hundreds of points
    // from the row being dragged. When the governing Tm of the matching run can
    // be read, measure THAT distance instead. The font filter also runs in two
    // passes: such a block switches fonts mid-stream, so its first Tf routinely
    // differs from the target run's font.
    const govDist = (block: BtInfo): number => {
      const gov = findGoverningTm(block, targetBlock.text, pageIndex)
      if (!gov) return Infinity
      const m = gov.text.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+Tm$/)
      if (!m || pageHeight === undefined) return distOf(block)
      const ctm = getFullCtmAtOffset(stream, block.start)
      const ux = parseFloat(m[1]) * ctm[0] + parseFloat(m[2]) * ctm[2] + ctm[4]
      const uy = parseFloat(m[1]) * ctm[1] + parseFloat(m[2]) * ctm[3] + ctm[5]
      const x = ux, y = pageHeight - uy
      const [x0, y0, x1, y1] = targetBlock.bbox
      const nx = Math.min(Math.max(x, Math.min(x0, x1)), Math.max(x0, x1))
      const ny = Math.min(Math.max(y, Math.min(y0, y1)), Math.max(y0, y1))
      return Math.hypot(x - nx, y - ny)
    }
    for (const fontFiltered of [true, false]) {
      for (const block of allBlocks) {
        if (fontFiltered && targetFontRef && !blockUsesFont(block, targetFontRef)) continue
        if (!fontFiltered && targetFontRef && blockUsesFont(block, targetFontRef)) continue
        const d = Math.min(distOf(block), govDist(block))
        if (!(d <= onTarget * 2)) continue
        if (!findGoverningTm(block, targetBlock.text, pageIndex)) continue
        candidates.push({ blocks: [block], score: 1, dist: d, order: candidates.length })
      }
      if (candidates.length > 0 || !targetFontRef) break
    }
  }

  if (candidates.length === 0) return null

  const bucket = (d: number) => Number.isFinite(d) ? Math.round(d / 8) : Number.MAX_SAFE_INTEGER
  candidates.sort((a, b) =>
    bucket(a.dist) - bucket(b.dist) ||
    b.score - a.score ||
    b.blocks.length - a.blocks.length || // prefer the fuller line match on a tie
    a.order - b.order
  )
  return candidates[0].blocks
}

interface BtInfo {
  content: string
  start: number
  end: number
  fontRef: string
  /** Every font the block switches to (first Tf, later Tfs, inherited). */
  fonts: string[]
  /**
   * The Tf operator in force when the block opened (`/TT1 11.04 Tf`), set when
   * the block carries no Tf of its own OR draws its first show op before its
   * first Tf (the head runs in the entering font, and fontRef then names that
   * font). A rewrite that substitutes a font restores this so the substitute
   * cannot become the inherited font of every block that follows.
   */
  inheritedTf?: string | null
  yPos: number
  xPos: number
  /** The block carries at least one text-positioning operator (Tm/Td/TD/T*). */
  hasPos: boolean
  /** The block positions its first show-op with Tm (vs. only Td/TD/T*). */
  hasTm: boolean
  decodedText: string
  mode: 'hex' | 'plain'
  encoding: ReturnType<typeof getFontEncoding>
  hasSubstantialText: boolean
}

/** Does the block draw anything in this font? (a BT can switch fonts per run) */
function blockUsesFont(b: BtInfo, ref: string): boolean {
  return b.fontRef === ref || b.fonts.includes(ref)
}

/**
 * The single-drawn text behind a fake-bold double draw, or null.
 *
 * Canva embolds by drawing the same run TWICE a fraction of a point apart;
 * extraction interleaves the copies and reports "AUTO" as "AAUUTTOO". A
 * target whose characters all come in adjacent pairs is undoubled so the
 * matchers can find the run each copy actually draws.
 */
function undouble(s: string): string | null {
  // Whitespace arrives already collapsed, so a single space stands for the
  // doubled pair the draw produced.
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length < 4) return null
  let out = ''
  let pairs = 0
  for (let i = 0; i < t.length; ) {
    if (t[i] === ' ') { out += ' '; i += 1; continue }
    if (t[i + 1] !== t[i]) return null
    out += t[i]; i += 2; pairs++
  }
  return pairs >= 2 ? out : null
}

/**
 * Standalone accent marks, stripped from BOTH sides of a containment compare.
 *
 * TeX composes "ó" by drawing the accent glyph and the letter as separate
 * show-ops, and this decoder and MuPDF's extraction disagree on which side of
 * the letter the mark lands ("segmentaci´on" vs "segmentacio´n") — one
 * transposed character defeated containment on a paragraph that plainly held
 * the target. The letters themselves carry the identification.
 */
const ACCENT_MARKS = /[´`¨ˆ˜¯˘˚¸ˇ^~̀-ͯ]/g

/**
 * Containment where a '?' in `hay` (an unmapped glyph — typically a ligature)
 * stands for ONE OR TWO characters of `needle`. A pdfTeX block decodes
 * "comprehension ?rst" while extraction reports "comprehension first"; a plain
 * .includes() then never matches and the paragraph cannot be edited at all.
 */
/**
 * Footnote/affiliation markers an academic PDF sets as superscripts. The
 * extraction splits them into their own blocks while the BT block carries
 * them inline ("Cruz-Moran 1,*" against a target of "Cruz-Moran *"), so
 * containment must be allowed to step over them — but ONLY directly after a
 * letter, and never when the target expects a digit there, or "18.00" would
 * quietly contain "1.00".
 */
const SUPERSCRIPT_MARKS = /[0-9*†‡§]/
const MAX_MARK_SKIPS = 4

function wildcardIncludes(hay: string, needle: string): boolean {
  if (!needle) return true
  if (hay.includes(needle)) return true
  const letter = (c: string | undefined) => !!c && /[a-zá-úñä-ü]/i.test(c)
  const canSkip = (i: number, j: number) => {
    if (j < needle.length && /[0-9]/.test(needle[j])) return false
    if (SUPERSCRIPT_MARKS.test(hay[i]) && letter(hay[i - 1])) return true
    // The comma the marker drags along: "Cruz-Moran 1," against "Cruz-Moran ,"
    // needs the pair stepped over, not just the digit.
    return hay[i] === ',' && i > 1 && SUPERSCRIPT_MARKS.test(hay[i - 1]) && letter(hay[i - 2]) &&
      needle[j] !== ','
  }
  if (!hay.includes('?') && !SUPERSCRIPT_MARKS.test(hay)) return false
  const n = needle.length
  for (let s = 0; s < hay.length; s++) {
    if (hay[s] !== '?' && hay[s] !== needle[0]) continue
    // frontier: needle position -> fewest mark-skips spent reaching it
    let frontier = new Map<number, number>([[0, 0]])
    for (let i = s; i < hay.length && frontier.size; i++) {
      const next = new Map<number, number>()
      const put = (j: number, k: number) => {
        const cur = next.get(j)
        if (cur === undefined || k < cur) next.set(j, k)
      }
      const c = hay[i]
      for (const [j, k] of frontier) {
        if (c === '?') { put(j + 1, k); put(j + 2, k) }
        else if (c === needle[j]) put(j + 1, k)
        if (k < MAX_MARK_SKIPS && canSkip(i, j)) put(j, k + 1)
      }
      for (const j of next.keys()) if (j >= n) return true
      frontier = new Map([...next].filter(([j]) => j < n))
    }
  }
  return false
}

/**
 * Same characters in any order — one string is a SHUFFLE of the other.
 *
 * MuPDF orders extracted glyphs by position, so when two runs overlap on the
 * page the block it reports is an INTERLEAVING of them, not a concatenation:
 * two copies of "Correo Electrónico: …" drawn 39pt apart come back as
 * `"Correo E Cleocrtrreóon iEcole: cbt arróbnoizcaog:o …"`. Neither the exact
 * test nor `fuzzyTextMatch` can see through that, so such a line matched
 * NOTHING and could not be edited or even deleted — it just reported "Could
 * not find matching text in content stream". This is what any page with
 * overlapping text does: double-struck fake bold, a watermark crossing a line,
 * a stamped value over a form field.
 *
 * A shuffle preserves the character multiset exactly, and the run loop already
 * has the run's concatenation in hand — so comparing sorted characters costs
 * one sort and needs no order-aware DP. It is a NECESSARY condition, not a
 * sufficient one (anagrams exist), which is why it is tried only after the
 * exact and fuzzy tests have both failed, is refused on short strings where
 * an accidental anagram is plausible, and still has to win the distance
 * ranking against every other candidate like anything else.
 */
const SHUFFLE_MIN_CHARS = 8

function sameCharacters(a: string, b: string): boolean {
  const key = (s: string) => foldForMatch(s).replace(/[\s?]/g, '').split('').sort().join('')
  const ka = key(a)
  if (ka.length < SHUFFLE_MIN_CHARS) return false
  return ka === key(b)
}

/**
 * Drop blocks carrying no visible glyph from both ends of a matched run.
 *
 * A run is ANCHORED on its first block: `dist` is measured from there, and
 * bucketed distance is the primary sort key over every candidate. A blank block
 * on the end contributes nothing to the text that matched — but it drags the
 * anchor with it, and one cell's trailing space belongs to the run that starts
 * in the NEXT cell.
 *
 * Word draws every word as its own BT, so the row
 * `Telf. Fijo/Móvil: | Correo Electrónico:` is eight blocks sharing one Tm y.
 * The run matching "Correo Electrónico:" exactly was found starting at the
 * space that ends "Fijo/Móvil:" — 82pt to the left — so it ranked BELOW a
 * single-block match on "Electrónico:" alone, which sits on the click and
 * carries two thirds of the target. That partial match won, the new text was
 * written into the "Electrónico:" block, and the "Correo" block went on drawing
 * beside it: the cell rendered the label twice, overlapping, in two different
 * faces.
 *
 * The blocks removed here would have been skipped by `applyLineReplacement`
 * anyway — it neither writes into nor blanks a block with no visible glyph — so
 * nothing about the edit changes except where the run is measured from. Never
 * trimmed to empty: a run of nothing but spaces is still a legitimate target
 * (an empty form field being filled in).
 */
function trimBlankEnds(blocks: BtInfo[]): BtInfo[] {
  let lo = 0, hi = blocks.length - 1
  while (lo < hi && !blocks[lo].decodedText.trim()) lo++
  while (hi > lo && !blocks[hi].decodedText.trim()) hi--
  return lo === 0 && hi === blocks.length - 1 ? blocks : blocks.slice(lo, hi + 1)
}

/**
 * Font-aware content stream text replacement.
 *
 * Strategy:
 * 1. Parse ALL BT...ET blocks, extract Y position, font, decoded text
 * 2. Group blocks by Y position (same line) — MuPDF often groups these into one TextBlock
 * 3. Concatenate decoded text per line, match against target
 * 4. On match: put new text in the first substantial block, blank the rest
 */
/** Why the last match attempt failed — read by callers to build a useful error. */
let lastMatchDiagnostic = ''

/**
 * Raw index in `text` where the space-free suffix `suffixFree` begins, spaces
 * in `text` skipped — or null when the text does not end with it.
 */
function consumeSuffixFree(text: string, suffixFree: string): number | null {
  let p = text.length
  for (let k = suffixFree.length - 1; k >= 0; k--) {
    while (p > 0 && /\s/.test(text[p - 1])) p--
    if (p <= 0 || text[p - 1] !== suffixFree[k]) return null
    p--
  }
  return p
}

/**
 * Raw index in `text` just past the space-free prefix `prefixFree`, spaces in
 * `text` skipped — or null when the text does not begin with it.
 */
function consumePrefixFree(text: string, prefixFree: string): number | null {
  let p = 0
  for (let k = 0; k < prefixFree.length; k++) {
    while (p < text.length && /\s/.test(text[p])) p++
    if (p >= text.length || text[p] !== prefixFree[k]) return null
    p++
  }
  return p
}

function replaceTextInContentStreamFontAware(
  stream: string,
  pageIndex: number,
  targetBlock: TextBlock,
  newText: string,
  targetFontRef: string | null,
  pageWidth?: number,
  pageHeight?: number,
  rotation = 0
): { stream: string; substitutedFont?: string; strategy?: string; anchorOffset?: number; lines?: number; retags?: SpanRetag[]; applied?: AppliedEdit[] } | { error: string } | null {
  // Step 1: Parse all BT blocks with position and text info
  const allBlocks = scanBtBlocks(stream, pageIndex)

  const normalizedTarget = targetBlock.text.replace(/\s+/g, ' ').trim()

  // The same string routinely appears more than once on a page: an email
  // subject repeated in the quoted original, a running header, a value in
  // several table rows. Text alone cannot tell those apart, so EVERY candidate
  // is collected with its distance to the block the user actually clicked and
  // the nearest one is applied. Returning the first textual match instead used
  // to silently rewrite a different paragraph while the clicked one appeared
  // not to be editable at all.
  interface Candidate {
    blocks: BtInfo[]; score: number; dist: number; line: boolean; partial?: boolean; order: number
    /**
     * Space-free tail of the target that is NOT drawn by this run — it lives
     * fused at the head of the block that follows the run, so it stays on the
     * page and must be trimmed off the replacement before applying.
     */
    tailFused?: string
  }
  const candidates: Candidate[] = []
  const distCache = new Map<number, number>()
  const distOf = (b: BtInfo) => {
    let d = distCache.get(b.start)
    if (d === undefined) {
      d = btBlockDistanceToTarget(stream, b, targetBlock, pageHeight)
      distCache.set(b.start, d)
    }
    return d
  }

  // Step 2: Group blocks into VISUAL lines and try line-grouped matching FIRST
  // (MuPDF often groups multiple BT blocks into one TextBlock).
  //
  // On an unrotated page a visual line is constant content-space Y. On a
  // /Rotate 90|270 page it is constant content-space X — the paper is turned,
  // so the reading direction runs along the content Y axis. Grouping by Y
  // there puts every glyph of a line in its own group (this fund-request form
  // draws ONE GLYPH PER BT, so "税号 RUC: 20606091380" was ~20 groups of one)
  // and no multi-block line could ever be assembled: the page read as almost
  // entirely uneditable while single-block cells edited fine.
  const sideways = rotation === 90 || rotation === 270
  const lineGroups = new Map<number, BtInfo[]>()
  for (const block of allBlocks) {
    if (!block.hasPos) continue
    // Round to nearest 0.5 to group same-line blocks
    const key = Math.round((sideways ? block.xPos : block.yPos) * 2) / 2
    if (!lineGroups.has(key)) lineGroups.set(key, [])
    lineGroups.get(key)!.push(block)
  }

  for (const [, lineBlocks] of lineGroups) {
    if (lineBlocks.length < 2) continue

    // Find the best CONTIGUOUS run of blocks whose concatenated text matches
    // the target — never treat the whole group as the match. Some generators
    // give EVERY block on a page the same Tm y and position lines via Td;
    // whole-group matching then blanks the entire page on a single edit.
    //
    // The run is read BOTH ways round: a content stream is under no obligation
    // to draw a line left-to-right, and one producer emits "  S/" before the
    // "TOTAL" it belongs after — stream order alone read "S/ TOTAL", matched
    // nothing, and a partial single-block match won and left the " S/" glyphs
    // stranded next to the replacement. (Same rule the move matcher already
    // applies; trying both can only ever ADD a candidate.)
    const byStart = [...lineBlocks].sort((a, b) => a.start - b.start)
    // Reading order along the line: X on an upright page; along the content Y
    // axis when the page is turned (ascending for /Rotate 90, descending for
    // 270 — the display X grows with content Y one way round and against it
    // the other); reversed X for 180.
    const byRead = [...lineBlocks].sort((a, b) =>
      rotation === 90 ? a.yPos - b.yPos :
      rotation === 270 ? b.yPos - a.yPos :
      rotation === 180 ? b.xPos - a.xPos :
      a.xPos - b.xPos)
    const orderings = byRead.every((b, i) => b === byStart[i]) ? [byStart] : [byStart, byRead]

    let best: { blocks: BtInfo[]; score: number } | null = null
    let bestFused: { blocks: BtInfo[]; coverage: number; rest: string } | null = null
    const tFree = normalizedTarget.replace(/\s+/g, '')
    for (const sorted of orderings) {
      for (let i = 0; i < sorted.length; i++) {
        let acc = ''
        for (let j = i; j < sorted.length; j++) {
          acc += sorted[j].decodedText
          const norm = acc.replace(/\s+/g, ' ').trim()
          if (norm.length > normalizedTarget.length * 1.5 + 8) break // overshot the target
          if (!norm) continue
          const ratio = matchRatio(norm, normalizedTarget)
          if (ratio < 0.7) continue
          // A LONE block holding more than the target is the containment
          // shape, not a line run: rewriting it whole eats the extra glyphs.
          // This form fuses the previous label's "）" onto "Importe Pagado "
          // in one block, and the line path deleted the bracket every time
          // the label was edited. The partial path edits inside such a block;
          // scoring it here just let the destructive route outrank it.
          const winFree = norm.replace(/\s+/g, '')
          if (i === j && winFree !== tFree && !winFree.includes('?') &&
              winFree.includes(tFree) && winFree.replace(tFree, '').length > 0) {
            continue
          }
          let score = 0
          if (norm === normalizedTarget) score = 2
          else if (fuzzyTextMatch(norm, normalizedTarget)) score = ratio
          // The extractor shuffled two overlapping runs together (see
          // sameCharacters). The run still COVERS the target, so it scores
          // above any fragment of it but below a match that reads in order.
          else if (sameCharacters(norm, normalizedTarget)) score = 1.5
          if (score > 0 && (!best || score > best.score)) {
            best = { blocks: trimBlankEnds(sorted.slice(i, j + 1)), score }
          }
          // The line's TAIL glyph is fused into the block that follows. This
          // bilingual form draws "暂扣款（质保金）" as seven one-glyph blocks
          // and then "）Importe Pagado …" as ONE block — the closing bracket
          // belongs to the label but is drawn by the neighbour, so no
          // contiguous run ever equals the target. A prefix run is accepted
          // when the next block PROVABLY starts with the missing remainder;
          // the remainder stays on the page, so it is trimmed off the
          // replacement at apply time — and when the edit CHANGED that tail,
          // the candidate is skipped there rather than half-applied.
          //
          // Checked whatever `score` says: the fuzzy matcher happily claims a
          // prefix window too, and applying THAT writes the fused tail a
          // second time. The structural reading — this run is the target
          // minus exactly what the neighbour starts with — explains the page
          // better than a fuzzy whole-match, so it is also RANKED above one:
          // just under an exact match, well above every fuzzy and shuffle.
          if (j + 1 < sorted.length) {
            const runFree = norm.replace(/\s+/g, '')
            if (runFree.length >= 3 && runFree.length >= tFree.length * 0.6 &&
                runFree.length < tFree.length && tFree.startsWith(runFree)) {
              const rest = tFree.slice(runFree.length)
              if (rest && sorted[j + 1].decodedText.replace(/\s+/g, '').startsWith(rest)) {
                if (!bestFused || runFree.length / tFree.length > bestFused.coverage) {
                  bestFused = {
                    blocks: trimBlankEnds(sorted.slice(i, j + 1)),
                    coverage: runFree.length / tFree.length, rest
                  }
                }
              }
            }
          }
        }
      }
    }

    if (best) {
      candidates.push({
        blocks: best.blocks, score: best.score,
        dist: distOf(best.blocks[0]), line: true, order: candidates.length
      })
    }
    if (bestFused) {
      candidates.push({
        blocks: bestFused.blocks, score: 1.9, tailFused: bestFused.rest,
        dist: distOf(bestFused.blocks[0]), line: true, order: candidates.length
      })
    }
  }

  // Step 3: single-block matching (for PDFs where each text block is one BT)
  for (const block of allBlocks) {
    if (targetFontRef && !blockUsesFont(block, targetFontRef)) continue
    const normalizedDecoded = block.decodedText.replace(/\s+/g, ' ').trim()
    if (!normalizedDecoded || normalizedDecoded.length < 2) continue

    // Space-free as well as collapsed: extraction invents spaces the stream
    // does not draw ("2 3.059,52" for a block that reads "23.059,52"), and a
    // collapse-only equality then failed the very block the click meant —
    // leaving a sloppy fuzzy line-run 50pt away as the best offer, which ate
    // the "$" beside the amount.
    const exact = normalizedDecoded === normalizedTarget ||
      normalizedDecoded.replace(/\s+/g, '') === normalizedTarget.replace(/\s+/g, '')
    if (exact || fuzzyTextMatch(normalizedDecoded, normalizedTarget)) {
      // Score by how much of the target this block actually CARRIES, not a flat
      // 1 for "fuzzy matched". A form draws "Código de Postulante" and its value
      // "70492487" as two runs that extraction reports as one line; the label
      // alone fuzzy-matches the whole line, and a flat 1 beat the line group
      // that covered both (≈0.97). The label was rewritten, the value was left
      // stranded beside the new text, and the edit reported success.
      candidates.push({
        blocks: [block],
        score: exact ? 2 : matchRatio(normalizedDecoded, normalizedTarget),
        dist: distOf(block), line: false, order: candidates.length
      })
    }
  }

  // Fake-bold DOUBLE DRAWS: Canva writes the same run twice a fraction of a
  // point apart, so extraction reports "AUTO" as "AAUUTTOO" and nothing above
  // matches. Match the halved text; when the twin copy sits on the same spot,
  // take both as a line group so the primary gets the new text and the twin
  // is blanked instead of shining through behind it.
  const halved = undouble(normalizedTarget)
  if (halved) {
    const normOf = (s: string) => s.replace(/\s+/g, ' ').trim()
    for (const block of allBlocks) {
      if (normOf(block.decodedText) !== halved) continue
      const twin = allBlocks.find(o => o !== block && normOf(o.decodedText) === halved &&
        Math.abs(o.xPos - block.xPos) < 3 && Math.abs(o.yPos - block.yPos) < 3)
      candidates.push({
        blocks: twin ? [block, twin] : [block],
        score: 1.5, dist: distOf(block), line: !!twin, order: candidates.length
      })
    }
  }

  // Step 4: Target CONTAINED inside a larger BT block (Ghostscript draws a
  // whole table column as one BT with each cell its own show-op — a short
  // cell like "16:00" never fuzzy-matches the whole block). These compete in
  // the SAME ranked list as the line and single-block candidates, not as a
  // last resort: a containment match sitting ON the click must outrank an
  // exact-text single block 300pt away (nine occurrences of "10.00" on one
  // timesheet — the far one used to win just by being tried first).
  const targetCompact = foldForMatch(normalizedTarget).replace(/\s+/g, '').replace(ACCENT_MARKS, '')
  /**
   * A ONE-character label is admitted, but only on a measured RUN position.
   *
   * This memo's addressee row is labelled `A`, against `De`, `Asunto` and `N°`
   * below it. Text cannot identify it — every `A` in "Alberto", "Adjunto" and
   * "Activos" reads the same — and when it was admitted on the block-level
   * ranking alone the engine rewrote the signature line 500pt away,
   * interleaving "PARA" into "Alberto" as "PAlbReArto". The reason was that a
   * block containing a lone letter is ranked by distance from the BLOCK's
   * origin, and the origin of the one BT drawing this whole header is nowhere
   * near the clicked row, so the ranking had nothing to go on.
   *
   * `runDistanceToTarget` is that missing signal: where inside the block the
   * character is actually drawn, measured on real advances. The block is only
   * admitted when a run carrying the target sits ON the click, and it is then
   * ranked by THAT distance rather than the block's. Nothing changes for
   * targets of two characters or more.
   */
  const loneChar = targetCompact.length === 1
  if (targetCompact.length >= 2 || loneChar) {
    const onTarget = Math.max(6, targetBlock.height || 0)
    for (const fontFiltered of [true, false]) {
      for (const block of allBlocks) {
        if (fontFiltered && targetFontRef && !blockUsesFont(block, targetFontRef)) continue
        if (!fontFiltered && targetFontRef && blockUsesFont(block, targetFontRef)) continue
        const decodedCompact = foldForMatch(block.decodedText).replace(/\s+/g, '').replace(ACCENT_MARKS, '')
        if (!(decodedCompact.length > targetCompact.length && wildcardIncludes(decodedCompact, targetCompact))) continue
        let dist = distOf(block)
        if (loneChar) {
          const runDist = runDistanceToTarget(block, normalizedTarget, pageIndex, stream, targetBlock, pageHeight)
          if (runDist === null || runDist > onTarget) continue
          dist = runDist
        } else {
          // Rank by where the target is DRAWN, not where the block starts.
          // One BT can straddle table rows, and every row repeats the same
          // value ("MSP-SIST-CS-2024-003-002" in eight rows): ranked by
          // origin, the block nearest the click was routinely the one drawing
          // the NEXT row's copy, and the edit landed one row down. Only when
          // an op carrying the target is found — a block whose ops decode to
          // '?' keeps its origin distance rather than being dropped.
          const runDist = opRunDistanceToTarget(block, normalizedTarget, pageIndex, stream, targetBlock, pageHeight)
          if (runDist !== null) dist = runDist
        }
        // Below every direct fuzzy score (>= 0.7): at equal distance a whole
        // match still beats a fragment of a bigger block.
        candidates.push({
          blocks: [block], score: 0.4, dist,
          line: false, partial: true, order: candidates.length
        })
      }
      if (!targetFontRef) break // second pass is identical when no font filter exists
    }
  }

  // Step 5: a target with NO text can only be identified by POSITION.
  //
  // A form's blank fields extract as whitespace-only blocks — the gap between
  // "Andahuaylas," and "de" where the day goes — and every step above needs
  // characters to work with: the line runs skip an empty normalized target,
  // single-block matching demands two characters, containment demands two. A
  // blank therefore produced ZERO candidates, and typing into one reported
  // "Could not find matching text in content stream" while the page sat
  // unchanged. Filling in a blank is the edit a form most obviously needs.
  //
  // Position is not a weaker signal here, it is the ONLY one: there is no text
  // to tell two blanks apart, and the user has already pointed at the one they
  // mean. The block must SIT on the clicked bbox — the same test
  // `findBtBlocksByPosition` applies — and only blocks that are THEMSELVES
  // blank are eligible, so a near miss can never overwrite the label beside it.
  if (!matchLength(normalizedTarget)) {
    const onTarget = Math.max(6, targetBlock.height || 0)
    for (const block of allBlocks) {
      if (!block.hasPos || block.decodedText.trim()) continue
      const dist = distOf(block)
      if (dist > onTarget) continue
      candidates.push({ blocks: [block], score: 1, dist, line: false, order: candidates.length })
    }
  }

  // Nearest wins. Distances are bucketed so that sub-bucket jitter (a baseline
  // sitting a couple of points off the bbox) does not outrank a better textual
  // match, and so the comparator stays a valid total order. Candidates with no
  // usable position keep their discovery order at the end.
  const bucket = (d: number) => Number.isFinite(d) ? Math.round(d / 8) : Number.MAX_SAFE_INTEGER
  candidates.sort((a, b) =>
    bucket(a.dist) - bucket(b.dist) ||
    b.score - a.score ||
    (b.line ? 1 : 0) - (a.line ? 1 : 0) ||
    a.order - b.order
  )

  for (const c of candidates) {
    // A line group provably FAR from the click is never the line the user
    // meant: a sloppy fuzzy run 90pt away once beat nothing at all, edited the
    // other copy of a repeated label, and clipped a glyph off its neighbour.
    // Only a KNOWN distance disqualifies — Infinity means the position could
    // not be measured, and the no-position fallback some generators need must
    // keep working.
    if (c.line && Number.isFinite(c.dist) && c.dist > 48) continue
    // A fused-tail run draws only part of the target; the rest stays on the
    // page in the neighbouring block, so it must be trimmed off the
    // replacement. An edit that CHANGED that tail cannot land through this
    // run — skip it rather than write a replacement that half-disagrees with
    // what remains drawn.
    let effNewText = newText
    if (c.tailFused) {
      const end = consumeSuffixFree(newText, c.tailFused)
      if (end === null) continue
      effNewText = newText.slice(0, end)
      if (!effNewText.trim() && newText.trim()) continue
    }
    const result = c.partial
      ? applyPartialBlockReplacement(stream, c.blocks[0], effNewText, pageIndex, targetBlock, pageHeight)
      : c.line
        ? applyLineReplacement(stream, c.blocks, effNewText, pageIndex, targetBlock, pageWidth, rotation)
        : applyBlockReplacement(stream, c.blocks, effNewText, pageIndex, targetBlock, pageWidth, pageHeight)
    if (result) {
      if (!('error' in result)) {
        result.strategy = c.partial ? 'partial_block' : c.line ? 'line_group' : 'single_block'
        result.anchorOffset = c.blocks[0].start
      }
      return result
    }
  }

  // Nothing matched. Report what was actually on the page so the next
  // unsupported generator can be classified without re-instrumenting the worker.
  // Record WHY nothing matched. Surfacing the decoder's own view is what turns
  // "Could not find matching text" from a dead end into a diagnosis: mojibake
  // here means a font-encoding problem, sensible text means a matcher problem.
  lastMatchDiagnostic =
    `${allBlocks.length} blocks, ${lineGroups.size} lines, font ${targetFontRef ?? 'any'}; saw ` +
    allBlocks.slice(0, 3).map(b =>
      `[${b.fontRef}@${b.hasPos ? `${Math.round(b.xPos)},${Math.round(b.yPos)}` : 'nopos'}]` +
      JSON.stringify(b.decodedText.slice(0, 28))
    ).join(' ')
  return null
}

/**
 * Rough glyph count for a BT block, straight from the show-op literals.
 *
 * Deliberately independent of decoding: the size guards must work even when a
 * font's ToUnicode is missing and the decoded text is empty or all '?'.
 */
function estimateGlyphCount(content: string): number {
  let n = 0
  const re = new RegExp(`(${STR_LIT_SRC})|(${HEX_LIT_SRC})`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) n += Math.max(m[1].length - 2, 0)
    else n += Math.floor(Math.max(m[2].replace(/\s+/g, '').length - 2, 0) / 2)
  }
  return n
}

/**
 * Apply replacement to a single matched BT block.
 */
function applyBlockReplacement(
  stream: string,
  blocks: BtInfo[],
  newText: string,
  pageIndex: number,
  targetBlock?: TextBlock,
  pageWidth?: number,
  pageHeight?: number
): { stream: string; substitutedFont?: string; strategy?: string; anchorOffset?: number; lines?: number; retags?: SpanRetag[]; applied?: AppliedEdit[] } | { error: string } | null {
  const block = blocks[0]

  // If this BT block holds much MORE text than the target (one BT drawing
  // several lines via Td/'), replacing the whole block would wipe the other
  // lines — replace only the show-ops that correspond to the target.
  if (targetBlock) {
    const targetNorm = targetBlock.text.replace(/\s+/g, ' ').trim()
    // Glyph count from the stream, not decoded length: when a font's ToUnicode
    // is incomplete the decoded text is empty or '????' while the block still
    // holds an entire table row, and a decoded-length test waves it through.
    const blockGlyphs = estimateGlyphCount(block.content)
    // Provable containment delegates too, however small the excess: a header
    // block reading "）Importe Pagado " is only ONE glyph bigger than its
    // target, far under any glyph-count slack, and the whole-block rewrite
    // deleted the bracket — which belongs to the label in the cell BEFORE.
    // Same test as the op-level gate: not the target, contains it, leftover
    // visible, and no '?' placeholders pretending to be foreign glyphs.
    const dFree = block.decodedText.replace(/\s+/g, '')
    const tFreeHere = targetNorm.replace(/\s+/g, '')
    const provablyHoldsMore = !!tFreeHere && dFree !== tFreeHere && !dFree.includes('?') &&
      dFree.includes(tFreeHere) && dFree.replace(tFreeHere, '').length > 0
    if (targetNorm && (blockGlyphs > targetNorm.length * 1.4 || provablyHoldsMore)) {
      const partial = applyPartialBlockReplacement(stream, block, newText, pageIndex, targetBlock, pageHeight)
      if (partial) return partial
      // Falling through would rewrite the WHOLE block, and this block holds far
      // more than the target: Ghostscript draws an entire table column as one
      // BT, so one edit destroyed 29 other blocks. Refusing the edit is bad;
      // silently deleting the rest of the column is far worse.
      return null
    }
  }

  // How many lines this text actually needs — explicit breaks plus whatever the
  // right margin forces. Anything past one goes down the rebuild path, which is
  // the only one that can emit a second line at all.
  const laidOut = targetBlock && pageWidth && newText.length > 0
    ? layoutReplacementLines(newText, targetBlock, pageWidth)
    : [newText]

  if (laidOut.length > 1 && targetBlock) {
    const wrappedResult = applyWrappedReplacement(stream, block, laidOut, targetBlock, pageIndex)
    if (wrappedResult) return wrappedResult
  }

  // Standard single-line replacement
  const plan = planTextEncoding(pageIndex, block, [laidOut[0] ?? newText], targetBlock)
  if (plan.kind === 'error') {
    // Not encodable in any ONE face. When a bullet is a block of its own its
    // "✓" is drawn by its own font and the sentence by another, so no single
    // face holds the line and the base-14 fallback has no U+2713. The partial
    // path can leave the ops the edit never touched alone (narrowToChangedOps)
    // — which is both the only way to encode this and the more faithful edit.
    // Reached only after the whole-block encode has already failed, so a block
    // that rewrites today still rewrites the same way.
    if (targetBlock) {
      const partial = applyPartialBlockReplacement(stream, block, newText, pageIndex, targetBlock, pageHeight)
      if (partial && !('error' in partial)) return partial
    }
    return { error: plan.error }
  }

  let newContent: string
  let substitutedFont: string | undefined
  if (plan.kind === 'keep-hex') {
    newContent = replaceTjInBlock(block.content, newText, 'hex', plan.hexLines[0])
  } else if (plan.kind === 'keep-plain') {
    newContent = replaceTjInBlock(block.content, plan.byteLines[0], 'plain')
  } else {
    newContent = rebuildBtContent(block.content, substLines(plan), plan.fontRef, !!plan.hex, undefined, undefined, block.inheritedTf)
    substitutedFont = plan.fontName
  }

  if (newContent !== block.content) {
    // The whole block was rewritten, so any /ActualText describing the old
    // glyphs is now a lie that extraction would report instead of the new text.
    newContent = stripActualText(newContent)
    // Same lie, told from outside the block, on a tagged page. Returned rather
    // than applied — see the note in applyLineReplacement.
    const tag = retagSpanActualText(stream, block.start, newText)
    const text = 'BT' + newContent + 'ET'
    const result = stream.substring(0, block.start) + text + stream.substring(block.end)
    // Only ONE block moved, and the tag sits below it, so no offset shifts.
    return {
      stream: result, substitutedFont, lines: 1,
      applied: [{ start: block.start, delta: text.length - (block.end - block.start) }],
      retags: tag ? [tag] : []
    }
  }
  return null
}


/**
 * Apply text replacement with automatic line wrapping.
 * Generates multiple Tj + Td operators for multi-line text.
 */
/** Base-14 faces kept around for measuring; MuPDF resolves the standard names. */
const measureFaceCache = new Map<string, any>()

function measureFace(name: string): any | null {
  if (!mupdf) return null
  if (!measureFaceCache.has(name)) {
    let f: any = null
    try { f = new mupdf.Font(name) } catch (_) { f = null }
    measureFaceCache.set(name, f)
  }
  return measureFaceCache.get(name)
}

/**
 * Width of `text` in em units — multiply by the font size for points.
 *
 * Real glyph advances, not a character count. Wrapping on an average char width
 * taken from the ORIGINAL text overflows the page the moment the replacement is
 * wider than what was there: "MMMM WWWW" is nearly twice the width of the same
 * number of lowercase letters, and the excess is drawn off the edge of the
 * paper, where it is neither visible nor recoverable.
 */
function measureEm(text: string, faceName: string): number {
  const font = measureFace(faceName)
  if (!font) return text.length * 0.5
  let w = 0
  for (const ch of text) {
    try {
      w += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)!))
    } catch (_) {
      w += 0.5
    }
  }
  return w
}

/** Greedy word wrap on MEASURED width, breaking a word too long to ever fit. */
function wrapToWidth(text: string, maxEm: number, faceName: string): string[] {
  if (!(maxEm > 0)) return [text]
  const words = text.split(/\s+/).filter(w => w.length > 0)
  if (words.length === 0) return ['']

  const lines: string[] = []
  let line = ''

  for (const word of words) {
    if (line && measureEm(`${line} ${word}`, faceName) <= maxEm) {
      line = `${line} ${word}`
      continue
    }
    if (line) { lines.push(line); line = '' }

    if (measureEm(word, faceName) <= maxEm) { line = word; continue }

    // A word wider than the whole line still has to go somewhere. Breaking it
    // mid-word is ugly; letting it run off the paper loses it.
    let chunk = ''
    for (const ch of word) {
      if (chunk && measureEm(chunk + ch, faceName) > maxEm) { lines.push(chunk); chunk = ch }
      else chunk += ch
    }
    line = chunk
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : ['']
}

/**
 * Break replacement text into the lines that will actually be drawn.
 *
 * Explicit newlines come first and are never merged away — a break the user
 * typed is an instruction, not a hint — and each of the resulting paragraphs is
 * then wrapped to the room left between the block's left edge and the right
 * margin. Doing both here is what makes "typed a line break" and "text outgrew
 * the page" one code path instead of two that disagree.
 *
 * `sizeRatio` is how much the font is growing, for the restyle path: the room
 * has to be measured at the size the text will BE, not the size it was.
 */
function layoutReplacementLines(
  newText: string,
  targetBlock: TextBlock,
  pageWidth: number,
  sizeRatio = 1
): string[] {
  const available = pageWidth - targetBlock.x - PAGE_RIGHT_MARGIN
  if (!(available > 0)) return newText.split('\n')

  const face = pickSubstituteFont(null, targetBlock)
  const size = Math.max(targetBlock.fontSize * sizeRatio, 0.01)

  // The face measured with is a base-14 stand-in for whatever the page really
  // uses, so it is calibrated against the one width known for certain: what this
  // block ACTUALLY occupies today. Clamped, because a wild ratio means the
  // stand-in was a bad guess and the raw metrics are the better bet.
  const referenceEm = measureEm(targetBlock.text, face)
  const raw = referenceEm > 0.01 && targetBlock.width > 0.01 && targetBlock.fontSize > 0.01
    ? targetBlock.width / (referenceEm * targetBlock.fontSize)
    : 1
  const calibration = Math.min(Math.max(raw, 0.5), 2)

  const maxEm = available / (size * calibration)

  const out: string[] = []
  for (const para of newText.split('\n')) {
    if (para.length === 0) { out.push(''); continue }
    out.push(...wrapToWidth(para, maxEm, face))
  }
  return out
}

function applyWrappedReplacement(
  stream: string,
  block: BtInfo,
  lines: string[],
  targetBlock: TextBlock,
  pageIndex: number
): { stream: string; substitutedFont?: string; strategy?: string; anchorOffset?: number; lines?: number; retags?: SpanRetag[]; applied?: AppliedEdit[] } | { error: string } | null {
  if (lines.length <= 1) return null // Single line — the surgical path is safer

  const plan = planTextEncoding(pageIndex, block, lines, targetBlock)
  if (plan.kind === 'error') return { error: plan.error }

  // Rebuild the ENTIRE BT block: keep only color/Tf/Tm, strip ALL old Tj/Td/TJ
  // content, then append the new wrapped lines (prevents duplication on re-edit).
  let newContent: string
  let substitutedFont: string | undefined
  if (plan.kind === 'keep-hex') {
    newContent = rebuildBtContent(block.content, plan.hexLines, null, true)
  } else if (plan.kind === 'keep-plain') {
    newContent = rebuildBtContent(block.content, plan.byteLines, null)
  } else {
    newContent = rebuildBtContent(block.content, substLines(plan), plan.fontRef, !!plan.hex, undefined, undefined, block.inheritedTf)
    substitutedFont = plan.fontName
  }

  return {
    stream: stream.substring(0, block.start) + 'BT' + newContent + 'ET' +
            stream.substring(block.end),
    substitutedFont,
    lines: lines.length
  }
}


/**
 * Apply replacement across multiple BT blocks on the same line.
 * Put new text in the first substantial block, blank text in all others.
 */
function applyLineReplacement(
  stream: string,
  lineBlocks: BtInfo[],
  newText: string,
  pageIndex: number,
  targetBlock?: TextBlock,
  pageWidth?: number,
  rotation = 0
): { stream: string; substitutedFont?: string; strategy?: string; anchorOffset?: number; lines?: number; retags?: SpanRetag[]; applied?: AppliedEdit[] } | { error: string } | null {
  // Sort by position in stream (ascending)
  const sorted = [...lineBlocks].sort((a, b) => a.start - b.start)

  // Any block carrying a visible glyph counts, NOT just those with >1 character.
  // Small-caps exports put a single letter in each BT block ("L", ".", ","), and
  // treating those as noise left them undeleted next to the replacement — the
  // line came out as "LZZZ." instead of "ZZZ".
  const contributes = (b: BtInfo) => b.decodedText.trim().length > 0

  // The replacement goes into the block that STARTS the line visually — the
  // leftmost one — not the first one in the stream. A producer that draws a
  // field's value before its label ("  S/" at x=463 emitted before "TOTAL" at
  // x=437) would otherwise get the new text at the value's position, 26pt to
  // the right of where the line begins. Stream order remains the tiebreak and
  // the fallback when any position is unknown.
  const contributing = sorted.filter(contributes)
  if (contributing.length === 0) return null
  // "Starts the line" follows the page's reading direction: min x upright,
  // along the content Y axis when the paper is turned (min y for /Rotate 90,
  // max for 270), reversed x for 180.
  const readCmp = (a: BtInfo, b: BtInfo) =>
    rotation === 90 ? a.yPos - b.yPos :
    rotation === 270 ? b.yPos - a.yPos :
    rotation === 180 ? b.xPos - a.xPos :
    a.xPos - b.xPos
  const primary = contributing.every(b => b.hasPos)
    ? contributing.reduce((min, b) => readCmp(b, min) < 0 ? b : min)
    : contributing[0]
  const primaryIdx = sorted.indexOf(primary)

  /**
   * RESCUE for a run whose blocks no single font can draw: drop the blocks
   * the edit did not change, from BOTH ends, and re-run on the middle.
   *
   * A bilingual form draws "税号 RUC: 20606091380" as ~20 one-glyph BT blocks
   * — the CJK in a CID font, the Latin in another — and re-encoding the whole
   * line has to find one face holding both scripts. There is none, WinAnsi has
   * no 税, and every such line failed with "Cannot encode characters" however
   * small the actual change was. This is `narrowToChangedOps` one level up,
   * with one difference that makes BOTH ends safe here: each BT block carries
   * its own absolute position (BT resets the line matrix), so an untouched
   * TRAILING block keeps its place no matter how the text before it changed —
   * the Td-offset hazard that forbids tail-trimming inside a single block
   * does not exist between blocks.
   *
   * Strictly a rescue: it runs only after the whole-run encode has FAILED, so
   * no line that encodes today changes, and the recursion terminates because
   * each pass strictly shrinks the run or stops.
   */
  const narrowLineAndRetry = (): ReturnType<typeof applyLineReplacement> => {
    if (!contributing.every(b => b.hasPos)) return null
    const reading = [...contributing].sort(readCmp)
    // Consume a block's space-free text from newText at `pos` forward (or
    // `end` backward); null = the block's text is not there, i.e. the edit
    // changed it.
    const forward = (pos: number, bf: string): number | null => {
      let p = pos
      for (let k = 0; k < bf.length; k++) {
        while (p < newText.length && /\s/.test(newText[p])) p++
        if (p >= newText.length || newText[p] !== bf[k]) return null
        p++
      }
      return p
    }
    const backward = (end: number, bf: string): number | null => {
      let p = end
      for (let k = bf.length - 1; k >= 0; k--) {
        while (p > 0 && /\s/.test(newText[p - 1])) p--
        if (p <= 0 || newText[p - 1] !== bf[k]) return null
        p--
      }
      return p
    }
    let head = 0, tail = reading.length, pos = 0, end = newText.length
    while (head < tail - 1) {
      const p = forward(pos, reading[head].decodedText.replace(/\s+/g, ''))
      if (p === null) break
      pos = p; head++
    }
    while (tail - 1 > head) {
      const p = backward(end, reading[tail - 1].decodedText.replace(/\s+/g, ''))
      if (p === null) break
      end = p; tail--
    }
    if (head === 0 && tail === reading.length) return null // nothing to drop
    const middleText = newText.slice(pos, end).trim()
    if (!middleText) return null
    return applyLineReplacement(stream, reading.slice(head, tail), middleText,
      pageIndex, targetBlock, pageWidth, rotation)
  }

  // Every block here except the primary gets blanked, so refuse when the run
  // carries far more text than the target: a bad line-group match on a Corel
  // datasheet wiped 702 characters across 36 blocks. Losing the edit is
  // recoverable; losing the page is not.
  if (targetBlock) {
    // Counted from the STREAM, not from decoded text. When a font's ToUnicode
    // is incomplete our decoder returns '' or '????' for glyphs that are
    // perfectly real on the page, so a decoded-length guard measured a 702
    // character run as empty and let it through. Glyph counts do not depend on
    // being able to read the text.
    const runGlyphs = sorted.reduce((n, b) => n + estimateGlyphCount(b.content), 0)
    const targetLen = targetBlock.text.replace(/\s+/g, ' ').trim().length
    if (targetLen > 0 && runGlyphs > targetLen * 2.5 + 16) return null

    // Every non-primary block here gets BLANKED — so every one of them must
    // be part of the target. A fuzzy run happily picks up a stray glyph from
    // the neighbouring cell (the tail of "S.A.C." in front of a RUC, the
    // label bracket fused before a header), and blanking that deletes ink
    // the edit never named. Judged case-folded and space-free; a block whose
    // decode carries '?' placeholders is exempt — unreadable is not the same
    // as foreign, and refusing on it broke fonts with incomplete CMaps.
    const tFold = foldForMatch(targetBlock.text).replace(/\s+/g, '')
    if (tFold) {
      for (const b of contributing) {
        if (b === primary) continue
        const bf = foldForMatch(b.decodedText).replace(/\s+/g, '')
        if (!bf || bf.includes('?')) continue
        if (!tFold.includes(bf)) return null
      }
      // The PRIMARY too, when the run has other members: it is REWRITTEN, so
      // glyphs of its own that the target never named are deleted just as
      // surely as a blanked neighbour's. A currency "$" drawn as its own block
      // led a fuzzy run for the amount beside it, took the replacement, and
      // the dollar sign vanished. A single-block run is exempt — there the
      // primary IS the match the scorer accepted.
      if (contributing.length > 1) {
        const pf = foldForMatch(primary.decodedText).replace(/\s+/g, '')
        if (pf && !pf.includes('?') && !tFold.includes(pf)) return null
      }
    }
  }

  // Build replacements (process from end to start to preserve offsets)
  const replacements: { start: number; end: number; newContent: string }[] = []
  const retags = new Map<number, { start: number; end: number; text: string }>()
  let substitutedFont: string | undefined
  let drawnLines = 1

  for (let i = sorted.length - 1; i >= 0; i--) {
    const block = sorted[i]
    let newContent: string

    if (i === primaryIdx) {
      // Primary block: insert the new text, word-wrapped if it won't fit the line
      const lines = targetBlock && pageWidth && newText.length > 0
        ? layoutReplacementLines(newText, targetBlock, pageWidth)
        : [newText]
      drawnLines = lines.length

      const plan = planTextEncoding(pageIndex, block, lines, targetBlock)
      if (plan.kind === 'error') {
        // Before giving up, stop re-encoding the blocks the edit never
        // touched — the CJK label beside an edited Latin value, or the other
        // way round. See narrowLineAndRetry above.
        return narrowLineAndRetry() ?? { error: plan.error }
      }
      if (plan.kind === 'subst') {
        newContent = rebuildBtContent(block.content, substLines(plan), plan.fontRef, !!plan.hex, undefined, undefined, block.inheritedTf)
        substitutedFont = plan.fontName
      } else if (lines.length > 1) {
        newContent = plan.kind === 'keep-hex'
          ? rebuildBtContent(block.content, plan.hexLines, null, true)
          : rebuildBtContent(block.content, plan.byteLines, null)
      } else if (plan.kind === 'keep-hex') {
        newContent = replaceTjInBlock(block.content, newText, 'hex', plan.hexLines[0])
      } else {
        newContent = replaceTjInBlock(block.content, plan.byteLines[0], 'plain')
      }
    } else if (contributes(block)) {
      // Other blocks with text: blank them
      newContent = replaceTjInBlock(block.content, '', block.mode, block.mode === 'hex' ? '' : undefined)
    } else {
      continue // Skip whitespace-only blocks — nothing visible to erase
    }

    // The glyphs these spans described are gone; leaving the overrides behind
    // makes extraction report the old text over the new.
    newContent = stripActualText(newContent)

    replacements.push({ start: block.start, end: block.end, newContent })
    // On a TAGGED page the words also live outside the BT, in the span this
    // block sits in. Correct that too, or the page prints one thing and reads
    // as another. Keyed by the dictionary so a span wrapping several blocks is
    // retagged once — and by the PRIMARY, which is the block that still draws.
    const tag = retagSpanActualText(stream, block.start, i === primaryIdx ? newText : '')
    if (tag && (i === primaryIdx || !retags.has(tag.start))) retags.set(tag.start, tag)
  }

  // Apply replacements from end to start
  let result = stream
  const applied: AppliedEdit[] = []
  for (const rep of replacements) {
    const text = 'BT' + rep.newContent + 'ET'
    result = result.substring(0, rep.start) + text + result.substring(rep.end)
    applied.push({ start: rep.start, delta: text.length - (rep.end - rep.start) })
  }

  // The retags are RETURNED, not applied. Their dictionaries sit at a LOWER
  // offset than the block they tag — and so do the clip windows the caller
  // widens next, off offsets taken from this same original stream. Splicing
  // them here would move those clips out from under it, and the widened
  // rectangle would land in the middle of a tag. It did: an /ActualText came
  // back with a clip rectangle written through it and the page's title vanished
  // from every extractor.
  //
  // Their offsets are moved to where they now sit, because a line group rewrites
  // blocks THROUGHOUT the run, not only after them.
  return result !== stream
    ? {
        stream: result,
        substitutedFont,
        lines: drawnLines,
        applied,
        retags: [...retags.values()].map(t => ({
          start: shiftOffset(t.start, applied),
          end: shiftOffset(t.end, applied),
          text: t.text
        }))
      }
    : null
}

/**
 * Fuzzy text match that accounts for '?' placeholders in decoded text
 * (from missing CMap entries). Also handles substring matching.
 */
/**
 * Comparison form for matching text decoded from the content stream against the
 * text MuPDF extracted.
 *
 * Case is folded because SMALL-CAPS fonts store every letter as a capital glyph
 * and only vary the Tf size — LibreOffice exports "El Principito" as
 * `20 Tf <E> 14 Tf <L> …`, so the raw stream decodes to "EL PRINCIPITO" while
 * MuPDF, honouring the `/Span <</ActualText (l)>>` marked content, reports
 * "El Principito". Comparing case-sensitively made every such block
 * uneditable.
 *
 * Discrimination lost to folding is recovered by the position ranking in the
 * callers: a case-only difference no longer blocks a match, but the nearest
 * candidate to the click still wins.
 */
function foldForMatch(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Length used to score a candidate run against the target.
 *
 * '?' placeholders (glyphs absent from the ToUnicode CMap) are dropped first.
 * Scoring on raw length rewarded a run for shedding its FIRST letter whenever
 * the full run carried an unmapped glyph: "ANTOINE DE SAINT-EXUP??ÉRY" scored
 * worse than "NTOINE DE SAINT-EXUP??ÉRY" against "Antoine de Saint-Exupéry",
 * so the leading "A" was left behind un-replaced.
 */
function matchLength(s: string): number {
  return foldForMatch(s).replace(/\?/g, '').length
}

/**
 * Drop `/ActualText` overrides from marked-content property dictionaries.
 *
 * LibreOffice small-caps exports wrap every single glyph in
 * `/Span <</ActualText (d) >> BDC … EMC`, and that string — not the glyph — is
 * what text extraction reports. Once the glyphs underneath are replaced the
 * override still claims the ORIGINAL letters, so the page renders the new text
 * while every extractor (this engine included, which then cannot find the block
 * again) keeps reading the old one. The dictionary itself is left in place so
 * any /MCID inside it still resolves against the structure tree.
 */
function stripActualText(content: string): string {
  return content.replace(
    /\/ActualText\s*(?:\((?:\\.|[^()\\])*\)|<[0-9A-Fa-f\s]*>)/g,
    ''
  )
}

/** A correction to one marked-content span's `/ActualText`, as a stream splice. */
interface SpanRetag { start: number; end: number; text: string }

/**
 * Where a rewrite landed and how many bytes it added or removed.
 *
 * A replacement rewrites BT blocks, but the clip window that bounds a block and
 * the marked-content dictionary that tags it both sit at LOWER offsets, and are
 * spliced afterwards off offsets read from the original stream. That holds only
 * while nothing below them has moved — and in a line group it does: the primary
 * block is rewritten in the middle of the run, so every span after it shifts by
 * the length it gained. One tag came back with the NEXT span's dictionary
 * spliced through it.
 */
interface AppliedEdit { start: number; delta: number }

/** An original-stream offset, moved to where it now sits after `edits`. */
function shiftOffset(offset: number, edits: AppliedEdit[]): number {
  let out = offset
  for (const e of edits) if (e.start < offset) out += e.delta
  return out
}

/** A PDF text string in UTF-16BE with the byte-order mark, as hex. */
function utf16beHex(text: string): string {
  let out = 'FEFF'
  for (const unit of text.split('')) {
    out += unit.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()
  }
  return out
}

/**
 * The inline property dictionary of the marked-content span that ENCLOSES an
 * offset, or null when there is none or it is a named resource.
 *
 * Literals are masked first so a `<<` inside a string cannot be counted, and the
 * dictionaries are balanced rather than matched with a regex — a property list
 * may hold a nested dictionary, and `/Span <</A <</B 1>> >> BDC` closes twice.
 */
function enclosingMarkedContentDict(
  masked: string,
  offset: number
): { start: number; end: number; bdcEnd: number } | null {
  const open: ({ start: number; end: number; bdcEnd: number } | null)[] = []

  const re = /\b(BDC|BMC|EMC)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    if (m.index >= offset) break
    if (m[1] === 'EMC') { open.pop(); continue }
    if (m[1] === 'BMC') { open.push(null); continue }

    // The property list is the operand immediately before BDC. A NAME there
    // (`/P1 BDC`) points into /Properties, which this cannot edit in place.
    let i = m.index - 1
    while (i >= 0 && /\s/.test(masked[i])) i--
    if (i < 1 || masked[i] !== '>' || masked[i - 1] !== '>') { open.push(null); continue }

    const end = i + 1
    let depth = 0
    let found: { start: number; end: number; bdcEnd: number } | null = null
    for (let k = i; k >= 1; k--) {
      if (masked[k] === '>' && masked[k - 1] === '>') { depth++; k-- }
      else if (masked[k] === '<' && masked[k - 1] === '<') {
        depth--
        if (depth === 0) { found = { start: k - 1, end, bdcEnd: m.index + 3 }; break }
        k--
      }
    }
    open.push(found)
  }

  for (let i = open.length - 1; i >= 0; i--) if (open[i]) return open[i]
  return null
}

/** Offset of the EMC that closes the span opened at `bdcEnd`, or -1. */
function matchingEmc(masked: string, bdcEnd: number): number {
  const re = /\b(BDC|BMC|EMC)\b/g
  re.lastIndex = bdcEnd
  let depth = 1
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    if (m[1] === 'EMC') { depth--; if (depth === 0) return m.index }
    else depth++
  }
  return -1
}

/** Literal-masked copy of the last stream asked about — masking is not cheap. */
let maskedCache: { key: string; masked: string } | null = null
function maskedOnce(stream: string): string {
  if (maskedCache && maskedCache.key === stream) return maskedCache.masked
  const masked = maskStreamLiterals(stream)
  maskedCache = { key: stream, masked }
  return masked
}

/**
 * Tell a TAGGED page what its edited span now says.
 *
 * In a tagged PDF every run sits inside `/Span <</MCID n …>> BDC … EMC`, and a
 * reader takes the words from the structure element that MCID points at, NOT
 * from the glyphs. Rewriting the glyphs therefore changes what is PRINTED and
 * nothing else: a SAP deck drew "TB1100 financial" while every extractor still
 * read "TB1100  Accounting" out of the tag — copy, search and a screen reader
 * all reporting a sentence the page no longer said. This engine's own
 * extraction read it too, so the block came back with its OLD text and a second
 * edit had nothing to match: "I can't edit any more once I have edited."
 *
 * `/ActualText` on the span is the standard override and the least invasive fix
 * there is: the tag, its /MCID and the structure tree are all left alone, so the
 * document stays tagged and accessible, and only what this one span claims to
 * say is corrected. Written UTF-16BE, the encoding a text string needs for
 * anything outside PDFDocEncoding — and an edit is exactly where accented and
 * non-Latin characters arrive.
 *
 * Only the INLINE dictionary form can be corrected. A named property list
 * (`/P1 BDC`) lives in the page's /Properties, and rewriting a shared resource
 * would retag every other span that points at it.
 *
 * And only a span that holds THIS BLOCK ALONE. `/ActualText` speaks for
 * everything inside its span, so putting one line's words on a span that also
 * wraps the next two replaces all three with the one — the corpus caught it at
 * once, a span losing 103 characters to a shorter override.
 */
function retagSpanActualText(
  stream: string,
  blockStart: number,
  text: string
): { start: number; end: number; text: string } | null {
  const masked = maskedOnce(stream)
  const dict = enclosingMarkedContentDict(masked, blockStart)
  if (!dict) return null

  const emc = matchingEmc(masked, dict.bdcEnd)
  if (emc < 0) return null
  const inside = masked.slice(dict.bdcEnd, emc)
  if ((inside.match(/\bBT\b/g) ?? []).length !== 1) return null
  const body = stripActualText(stream.slice(dict.start + 2, dict.end - 2))
  // An emptied span says nothing, and must not go on claiming the words whose
  // glyphs were just erased.
  const value = text.length > 0 ? `<${utf16beHex(text)}>` : '()'
  return { start: dict.start, end: dict.end, text: `<<${body}/ActualText${value}>>` }
}

/** Size-similarity of a candidate run to the target, ignoring case and '?'. */
function matchRatio(candidate: string, target: string): number {
  const a = matchLength(candidate)
  const b = matchLength(target)
  if (a === 0 || b === 0) return 0
  return Math.min(a, b) / Math.max(a, b)
}

function fuzzyTextMatch(decoded: string, target: string): boolean {
  // Exact match
  if (decoded === target) return true

  const d = foldForMatch(decoded)
  const t = foldForMatch(target)
  if (d && d === t) return true

  // Strip '?' from decoded and compare known characters
  const knownChars = d.replace(/\?/g, '')
  if (knownChars.length < 3) return false

  // Check if decoded is a substantial substring of target (or vice versa)
  // This handles cases where MuPDF groups multiple BT blocks into one text block
  if (t.includes(d) && d.length > 5) return true
  if (d.includes(t) && t.length > 5) return true

  // Check if target length is similar (within 40% tolerance)
  const lenRatio = Math.min(d.length, t.length) / Math.max(d.length, t.length)
  if (lenRatio < 0.6) return false

  // Check if known (non-?) characters appear in order in the target
  let targetIdx = 0
  let matchCount = 0
  for (let i = 0; i < knownChars.length && targetIdx < t.length; i++) {
    const found = t.indexOf(knownChars[i], targetIdx)
    if (found !== -1 && found - targetIdx <= 3) {
      matchCount++
      targetIdx = found + 1
    }
  }

  const matchRatio = matchCount / knownChars.length
  return matchRatio >= 0.8
}

/**
 * Find the content stream font reference (e.g., "F50") that matches
 * a MuPDF font name (e.g., "CAAAAA+Calibri").
 */
function findMatchingFontRef(
  mupdfFontName: string,
  fontRefToBaseName: Map<string, string>
): string | null {
  // Direct match
  for (const [ref, baseName] of fontRefToBaseName) {
    if (baseName === mupdfFontName) return ref
  }
  // Partial match (MuPDF might strip the subset prefix)
  const cleanName = mupdfFontName.replace(/^[A-Z]{6}\+/, '') // Remove "AAAAAA+" prefix
  for (const [ref, baseName] of fontRefToBaseName) {
    const cleanBase = baseName.replace(/^[A-Z]{6}\+/, '')
    if (cleanBase === cleanName) return ref
    if (baseName.includes(cleanName) || cleanName.includes(cleanBase)) return ref
  }
  return null
}

/**
 * Decode hex Tj strings in a BT block using the font's ToUnicode mapping.
 */
/**
 * Detect whether a BT block uses hex encoding (<hex> Tj) or plain text ((text) Tj / TJ arrays).
 */
function detectBlockEncoding(block: string): 'hex' | 'plain' {
  if (/<[0-9A-Fa-f\s]*[0-9A-Fa-f][0-9A-Fa-f\s]*>\s*(Tj|')/i.test(block)) return 'hex'
  // TJ arrays containing hex strings
  if (/<[0-9A-Fa-f\s]*[0-9A-Fa-f][0-9A-Fa-f\s]*>/.test(block) && /\]\s*TJ/.test(block)) return 'hex'
  return 'plain'
}

// String literal with one nesting level (PDF allows balanced unescaped parens)
const STR_LIT_SRC = String.raw`\((?:\\.|[^()\\]|\((?:\\.|[^()\\])*\))*\)`
// Hex string; the spec allows interior whitespace
const HEX_LIT_SRC = String.raw`<[0-9A-Fa-f\s]*>`

/**
 * Decode all text from a BT block IN STREAM ORDER, handling hex-encoded CID
 * fonts, plain WinAnsi/MacRoman strings, nested parens, hex whitespace, and
 * every show operator (Tj, ', ", TJ arrays) uniformly by walking the string
 * and hex literals sequentially.
 */
function decodeBtBlockText(
  block: string,
  encoding: { glyphToUnicode: Map<number, number>; glyphToText?: Map<number, string>; codeBytes?: number } | null,
  simpleInfo?: SimpleFontInfo | null,
  /**
   * Resolves a font name mid-block. One BT can switch fonts several times —
   * WeasyPrint emits three Tf per block — and decoding the whole thing with the
   * first font's CMap turns every run in the other fonts into '?'.
   */
  resolveFont?: (name: string) => { encoding: ReturnType<typeof getFontEncoding>; simpleInfo: SimpleFontInfo | null }
): string {
  let text = ''
  let stride = (encoding?.codeBytes === 1 ? 1 : 2) * 2

  // Map raw plain-string bytes through the font's own encoding.
  //
  // /Differences comes FIRST, because it overrides the base table code by code
  // — that is the entire point of it. LaTeX remaps the low codes to ligatures
  // and Greek capitals, so reading byte 12 out of a WinAnsi table gives a form
  // feed where the page plainly shows "fi".
  function mapPlainBytes(s: string): string {
    const diffs = simpleInfo?.differences ?? null
    if (!simpleInfo || (simpleInfo.encodingName === 'Unknown' && !diffs)) return s
    let out = ''
    for (let i = 0; i < s.length; i++) {
      const byte = s.charCodeAt(i)
      const name = diffs?.get(byte)
      if (name !== undefined) {
        const cp = glyphNameToUnicode(name)
        // A name this table does not know is not a licence to emit rubbish:
        // '?' is what every other unmapped glyph decodes to, and the fuzzy
        // matcher already knows to discount it.
        out += cp >= 0 ? String.fromCodePoint(cp) : '?'
        continue
      }
      if (simpleInfo.encodingName === 'Unknown') { out += s[i]; continue }
      out += String.fromCodePoint(byteToUnicode(byte, simpleInfo.encodingName))
    }
    return out
  }

  function decodeGlyph(glyphId: number): string {
    if (encoding) {
      const unicode = encoding.glyphToUnicode.get(glyphId)
      if (unicode !== undefined && unicode >= 0 && unicode <= 0x10FFFF) {
        return String.fromCodePoint(unicode)
      }
      // A multi-character destination ("ffi", or the Latin runs this signed
      // order's CMaps map CJK glyphs to). Extraction expands these, so the
      // decode must too or the two can never be compared.
      const text = encoding.glyphToText?.get(glyphId)
      if (text !== undefined) return text
      return '?'
    }
    if (glyphId >= 0 && glyphId <= 0x10FFFF) {
      return String.fromCodePoint(glyphId)
    }
    return '?'
  }

  // Glyph-coded fonts (symbolic subsets with a ToUnicode CMap but no simple
  // encoding — Ghostscript output) draw PLAIN strings whose bytes are CMap
  // codes, not ASCII: route those through the CMap too.
  let glyphCodedPlain = !!encoding && (!simpleInfo || simpleInfo.encodingName === 'Unknown')
  let plainCodeBytes = encoding?.codeBytes === 2 ? 2 : 1

  // Walk literals AND Tf operators in order, so a font switch inside the block
  // takes effect for the runs that follow it.
  //
  // TJ arrays are consumed WHOLE, ahead of the bare-literal alternatives, so
  // the kerns between their pieces can be read. TeX writes an inter-word space
  // as a kern jump and not as a space character — `[(This)-333(is)]TJ` — so
  // without this a LaTeX paragraph decodes as "Thisis...", disagrees with the
  // text the page shows, and can never be matched against it.
  const litRe = new RegExp(
    `(\\[(?:${STR_LIT_SRC}|${HEX_LIT_SRC}|[^\\]])*\\]\\s*TJ)` + '|' +
    `(${STR_LIT_SRC})|(${HEX_LIT_SRC})|\\/([^\\s<>\\[\\]()/%]+)\\s+[\\d.-]+\\s+Tf`, 'g')
  const innerRe = new RegExp(`(${STR_LIT_SRC})|(${HEX_LIT_SRC})|(-?[\\d.]+)`, 'g')

  /** One piece of a show operation, plain or hex. */
  const takePlain = (raw: string): string => {
    if (glyphCodedPlain) {
      let out = ''
      for (let i = 0; i + plainCodeBytes - 1 < raw.length; i += plainCodeBytes) {
        let code = 0
        for (let k = 0; k < plainCodeBytes; k++) code = (code << 8) | raw.charCodeAt(i + k)
        out += decodeGlyph(code)
      }
      return out
    }
    return mapPlainBytes(raw)
  }
  const takeHex = (hex: string): string => {
    // A simple font with no ToUnicode draws hex strings whose PAIRS are the
    // same byte codes its plain strings use — pdf-lib writes every show string
    // as hex, so <46445341> is "FDSA" through the font's own encoding. The
    // 2-byte default here turned it into CJK garbage that matched nothing and
    // made the whole document uneditable.
    if (!encoding && simpleInfo) {
      let raw = ''
      for (let i = 0; i + 1 < hex.length; i += 2) {
        raw += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16))
      }
      return mapPlainBytes(raw)
    }
    let out = ''
    for (let i = 0; i + stride - 1 < hex.length; i += stride) {
      out += decodeGlyph(parseInt(hex.substring(i, i + stride), 16))
    }
    return out
  }

  let m: RegExpExecArray | null
  while ((m = litRe.exec(block)) !== null) {
    if (m[1] !== undefined) {
      // A TJ array: its pieces in order, with wide kerns turned into spaces.
      innerRe.lastIndex = 0
      let im: RegExpExecArray | null
      while ((im = innerRe.exec(m[1])) !== null) {
        if (im[1] !== undefined) text += takePlain(unescapePdfString(im[1].slice(1, -1)))
        else if (im[2] !== undefined) text += takeHex(im[2].slice(1, -1).replace(/\s+/g, ''))
        else {
          // Thousandths of an em, negative meaning a gap. Ordinary kerning
          // pairs live well under a tenth of an em; anything past KERN_SPACE is
          // a word gap, which is how TeX and several other engines set spaces.
          const kern = parseFloat(im[3])
          if (kern <= -KERN_SPACE && text.length > 0 && !/\s$/.test(text)) text += ' '
        }
      }
      continue
    }
    if (m[4] !== undefined) {
      if (resolveFont) {
        const next = resolveFont(m[4])
        encoding = next.encoding
        simpleInfo = next.simpleInfo
        stride = (encoding?.codeBytes === 1 ? 1 : 2) * 2
        glyphCodedPlain = !!encoding && (!simpleInfo || simpleInfo.encodingName === 'Unknown')
        plainCodeBytes = encoding?.codeBytes === 2 ? 2 : 1
      }
      continue
    }
    if (m[2] !== undefined) text += takePlain(unescapePdfString(m[2].slice(1, -1)))
    else text += takeHex(m[3].slice(1, -1).replace(/\s+/g, ''))
  }

  return text
}

interface ShowOpInfo {
  start: number
  end: number
  raw: string
  decoded: string
  kind: 'Tj' | 'quote' | 'dquote' | 'TJ'
  isHex: boolean
  /** Text-space position where this op draws (tracked via Tm/Td/TD/T*) */
  x: number
  y: number
  /** Font in force at this op, when it differs from the block's first (Tf tracked). */
  fontRef: string | null
}

/**
 * Scan every show-text operation (Tj, ', ", TJ) in a BT block's content, in
 * order, tracking the text-space position of each op so callers can pick the
 * RIGHT occurrence when identical strings repeat (e.g. "16:00" in 8 table rows).
 */
function scanShowOps(
  content: string,
  encoding: ReturnType<typeof getFontEncoding>,
  simpleInfo?: SimpleFontInfo | null,
  /**
   * Follow mid-block Tf switches, decoding each op with the font in force AT
   * that op. Ghostscript draws a whole table with one BT that switches fonts
   * per cell run; decoding every op with the block's first font turned the
   * other fonts' cells into garbage that matched nothing.
   */
  resolveFont?: (name: string) => { encoding: ReturnType<typeof getFontEncoding>; simpleInfo: SimpleFontInfo | null }
): ShowOpInfo[] {
  const re = new RegExp(
    // positioning operators (tracked, not collected)
    `(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+Tm` + '|' +
    `(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(Td|TD)` + '|' +
    `(-?[\\d.]+)\\s+TL` + '|' +
    `T\\*` + '|' +
    // show-text operators (collected)
    `(\\[(?:${STR_LIT_SRC}|${HEX_LIT_SRC}|[^\\]])*\\]\\s*TJ)` + '|' +
    `((?:-?[\\d.]+\\s+-?[\\d.]+\\s+)?(?:${STR_LIT_SRC}|${HEX_LIT_SRC})\\s*")` + '|' +
    `((?:${STR_LIT_SRC}|${HEX_LIT_SRC})\\s*(?:Tj|'))` + '|' +
    // font switches (tracked, not collected)
    `\\/([^\\s<>\\[\\]()/%]+)\\s+[\\d.-]+\\s+Tf`,
    'g'
  )

  const ops: ShowOpInfo[] = []
  // Td translates the LINE matrix, so its operands live in the space the Tm
  // MATRIX defines — adding them straight onto the translation is only right
  // while that matrix is the identity. This bilingual form sets
  // `0 1.00124 -1 0 e f Tm` (a quarter turn) and then steps between table
  // rows with `-713 -20.76 Td`: raw addition put every op in a frame no other
  // measurement uses, the clicked position could not be compared against
  // anything, and editing a cell landed one ROW off — the wrong block won the
  // ranking and nothing downstream could tell. Accumulate Td/T* in line space
  // and push them through the matrix; for an identity Tm this is byte-for-byte
  // the old arithmetic.
  let ma = 1, mb = 0, mc = 0, md = 1 // Tm matrix in force
  let ex = 0, ey = 0                 // Tm translation
  let ux = 0, uy = 0                 // accumulated line-space Td offsets
  let leading = 0
  let curFont: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) { // Tm — matrix AND translation
      ma = parseFloat(m[1]); mb = parseFloat(m[2])
      mc = parseFloat(m[3]); md = parseFloat(m[4])
      ex = parseFloat(m[5]); ey = parseFloat(m[6])
      ux = 0; uy = 0
      continue
    }
    if (m[7] !== undefined) { // Td / TD
      ux += parseFloat(m[7]); uy += parseFloat(m[8])
      if (m[9] === 'TD') leading = -parseFloat(m[8])
      continue
    }
    if (m[10] !== undefined) { leading = parseFloat(m[10]); continue } // TL
    if (m[0] === 'T*') { uy -= leading; continue }
    if (m[14] !== undefined) { // Tf
      curFont = m[14]
      if (resolveFont) {
        const next = resolveFont(m[14])
        encoding = next.encoding
        simpleInfo = next.simpleInfo
      }
      continue
    }

    const raw = m[0]
    const kind: ShowOpInfo['kind'] =
      m[11] !== undefined ? 'TJ'
      : m[12] !== undefined ? 'dquote'
      : raw.trimEnd().endsWith("'") ? 'quote' : 'Tj'
    if (kind === 'quote' || kind === 'dquote') { uy -= leading } // implicit T*
    ops.push({
      start: m.index,
      end: m.index + raw.length,
      raw,
      decoded: decodeBtBlockText(raw, encoding, simpleInfo),
      kind,
      isHex: /<[0-9A-Fa-f\s]*[0-9A-Fa-f]/.test(raw),
      x: ex + ma * ux + mc * uy,
      y: ey + mb * ux + md * uy,
      fontRef: curFont
    })
  }
  return ops
}

/** Split a hex string into CMap codes. */
function hexToCodes(hex: string, codeBytes: number): number[] {
  const stride = codeBytes * 2
  const codes: number[] = []
  for (let i = 0; i + stride - 1 < hex.length; i += stride) {
    codes.push(parseInt(hex.substring(i, i + stride), 16))
  }
  return codes
}

interface TjItem {
  start: number  // offset within op.raw
  end: number
  isLiteral: boolean
  decoded: string       // literals only
  codes: number[]       // literals only — CMap/byte codes
  value?: number        // numbers only — kern value
}

/** Parse a TJ array op's items (literals + kern numbers) with offsets into op.raw. */
function parseTjItems(
  raw: string,
  encoding: ReturnType<typeof getFontEncoding>,
  simpleInfo?: SimpleFontInfo | null
): TjItem[] {
  const open = raw.indexOf('[')
  const close = raw.lastIndexOf(']')
  if (open < 0 || close < 0) return []
  const items: TjItem[] = []
  const re = new RegExp(`(${STR_LIT_SRC})|(${HEX_LIT_SRC})|(-?[\\d.]+)`, 'g')
  const inner = raw.slice(open + 1, close)
  let m: RegExpExecArray | null
  const codeBytes = encoding?.codeBytes === 1 ? 1 : (encoding ? 2 : 1)
  const glyphCodedPlain = !!encoding && (!simpleInfo || simpleInfo.encodingName === 'Unknown')
  while ((m = re.exec(inner)) !== null) {
    const start = open + 1 + m.index
    const end = start + m[0].length
    if (m[3] !== undefined) {
      items.push({ start, end, isLiteral: false, decoded: '', codes: [], value: parseFloat(m[3]) })
      continue
    }
    // literal → decode + extract codes
    const codes: number[] = []
    if (m[2] !== undefined) {
      const hex = m[2].slice(1, -1).replace(/\s+/g, '')
      // No ToUnicode + a simple font = hex pairs are byte codes (pdf-lib).
      const stride = (encoding ? (encoding.codeBytes === 1 ? 1 : 2) : (simpleInfo ? 1 : 2)) * 2
      for (let i = 0; i + stride - 1 < hex.length; i += stride) codes.push(parseInt(hex.substring(i, i + stride), 16))
    } else {
      const rawBytes = unescapePdfString(m[1].slice(1, -1))
      if (glyphCodedPlain && codeBytes === 2) {
        for (let i = 0; i + 1 < rawBytes.length; i += 2) codes.push((rawBytes.charCodeAt(i) << 8) | rawBytes.charCodeAt(i + 1))
      } else {
        for (let i = 0; i < rawBytes.length; i++) codes.push(rawBytes.charCodeAt(i))
      }
    }
    items.push({
      start, end, isLiteral: true,
      decoded: decodeBtBlockText(raw.slice(start, end) + ' Tj', encoding, simpleInfo),
      codes
    })
  }
  return items
}

/**
 * Replace target text INSIDE a single TJ array (Ghostscript merges a whole
 * table row into one array, jumping between cells with kern numbers). Keeps
 * every other item verbatim and appends a compensating kern so the following
 * cells don't shift when the new text is wider/narrower.
 */
/**
 * Replace `needle` inside `hay` ignoring every space on both sides — the
 * spacing extraction reports and the spacing a stream draws routinely
 * disagree (kern-drawn gaps, spaces invented inside re-encoded runs), so a
 * space-sensitive replace can silently do nothing.
 */
function looseReplace(hay: string, needle: string, repl: string): string {
  const nFree = needle.replace(/\s+/g, '')
  if (!nFree) return hay
  const idx: number[] = []
  let proj = ''
  for (let i = 0; i < hay.length; i++) {
    if (!/\s/.test(hay[i])) { proj += hay[i]; idx.push(i) }
  }
  const p = proj.indexOf(nFree)
  if (p === -1) return hay
  return hay.slice(0, idx[p]) + repl + hay.slice(idx[p + nFree.length - 1] + 1)
}

function replaceInsideTjArray(
  op: ShowOpInfo,
  targetText: string,
  newLiteral: { literal: string; codes: number[] },
  encoding: ReturnType<typeof getFontEncoding>,
  simpleInfo: SimpleFontInfo | null,
  targetLocalX: number | null,
  tfSize: number,
  /**
   * Substitute a different font for the replaced run. A subsetted cell font
   * often lacks the replacement's glyphs, and refusing outright left whole
   * Ghostscript tables uneditable. The array is SPLIT around the target —
   * `[pre] TJ /Fsub size Tf (new) Tj /Forig size Tf [comp post] TJ` — so every
   * other cell keeps its font and its position. `newWidthKu` is the new run's
   * width in thousandths of the drawn size, measured on the substitute face.
   */
  subst?: { fontRef: string; origFontRef: string | null; sizeStr: string; newWidthKu: number }
): string | null {
  if (op.kind !== 'TJ') return null
  const items = parseTjItems(op.raw, encoding, simpleInfo)
  if (!items.length) return null

  // char-position map over concatenated literal text
  const charItem: { item: number; charInItem: number }[] = []
  let full = ''
  items.forEach((it, idx) => {
    for (let c = 0; c < it.decoded.length; c++) charItem.push({ item: idx, charInItem: c })
    full += it.decoded
  })

  // Matched on a SPACE-FREE projection of the array, mapped back to raw
  // positions. `full` is the array's literal items concatenated, and the gaps
  // between a Ghostscript row's cells are KERNS, not space glyphs — so the
  // run's own spacing does not have to match the spacing the extractor
  // reported. A collapsed projection is not enough either: extraction can
  // invent a space INSIDE a run this engine re-encoded ("Cab rera" out of a
  // contiguous hex literal), and the second edit of such a row then found no
  // occurrence at all. Spaces identify nothing here — the glyphs do.
  const target = targetText.replace(/\s+/g, '')
  if (!target) return null
  const projIdx: number[] = []
  let proj = ''
  for (let i = 0; i < full.length; i++) {
    if (!/\s/.test(full[i])) { proj += full[i]; projIdx.push(i) }
  }
  // Raw [start, end) of every occurrence. The bounds land on non-space chars,
  // so boundary spaces that live INSIDE the boundary literals are re-absorbed —
  // an occurrence beginning at the second char of "( Ingeniero…)" only because
  // char one is a space still starts at that literal's first character, and the
  // alignment guards below must see it that way.
  const occ: { start: number; end: number }[] = []
  let p = proj.indexOf(target)
  while (p !== -1) {
    let s = projIdx[p]
    let e = projIdx[p + target.length - 1] + 1
    while (s > 0 && charItem[s - 1].item === charItem[s].item && /\s/.test(full[s - 1])) s--
    while (e < full.length && charItem[e].item === charItem[e - 1].item && /\s/.test(full[e])) e++
    occ.push({ start: s, end: e })
    p = proj.indexOf(target, p + 1)
  }
  if (!occ.length) return null

  /**
   * Only occurrences that start at a literal's first character and end at a
   * literal's last are usable — anything else splits a literal in half, and the
   * guard further down rejects it. Filtering them out HERE rather than there is
   * what makes a one-character target work: every `A` inside "Alberto" and
   * "Activos" sits mid-literal, so dropping them first leaves the standalone
   * `(A)` the click actually meant. Choosing first and rejecting afterwards
   * gave up on the whole array instead.
   */
  const aligned = occ.filter(o => {
    const f = charItem[o.start]
    const l = charItem[o.end - 1]
    return f && l && f.charInItem === 0 && l.charInItem === items[l.item].decoded.length - 1
  })
  if (aligned.length) occ.length = 0, occ.push(...aligned)

  // Pick the occurrence nearest the clicked x when we can estimate positions
  // (identical values repeat across table columns)
  let chosen = occ[0]
  if (occ.length > 1 && targetLocalX !== null && simpleInfo?.widths && tfSize > 0) {
    const w = simpleInfo.widths
    const fc = simpleInfo.firstChar
    const xAt: number[] = []  // x offset of each char, in 1000-unit width space
    let acc = 0
    let ci = 0
    for (const it of items) {
      if (it.isLiteral) {
        for (const code of it.codes) {
          xAt[ci++] = acc
          acc += (w[code - fc] || 500)
        }
      } else {
        acc -= (it.value || 0)
      }
    }
    const clickedRel = (targetLocalX - op.x) * 1000 / tfSize
    let bestD = Infinity
    for (const o of occ) {
      const d = Math.abs(clickedRel - (xAt[o.start] ?? 0))
      if (d < bestD) { bestD = d; chosen = o }
    }
  }

  const startC = chosen.start
  const endC = chosen.end
  const first = charItem[startC]
  const last = charItem[endC - 1]
  if (!first || !last) return null

  // Require boundary alignment: the range must start at a literal's first
  // char and end at a literal's last char (true for Ghostscript's per-glyph
  // literals; bail otherwise rather than corrupt)
  if (first.charInItem !== 0) return null
  if (last.charInItem !== items[last.item].decoded.length - 1) return null

  // Absorb the SPACE-only literals that immediately follow the range (kerns
  // between them included). The compensation below deliberately keeps every
  // later item at its ORIGINAL pen position — that is what holds the row's
  // other cells in their columns — but a trailing space glyph's original
  // position is INSIDE a replacement that grew: an invisible glyph stranded
  // mid-run, which extraction then interleaves into the text as a phantom
  // space ("Cabrera" read back as "Cab rera", measured at x=358.9 between the
  // b at 353.6 and the r at 360.3). The next edit's target carries the
  // phantom, and committing it draws a REAL gap — each round trip adding one
  // more. A space is the one glyph that is safe to move: nothing visible
  // marks where it was, and the replacement text carries its own. Widths must
  // be known for what is absorbed, or the compensation would misplace every
  // cell after it — an unknown width just means the space stays, exactly as
  // before.
  let lastItem = last.item
  if (simpleInfo?.widths) {
    const w = simpleInfo.widths
    const fc = simpleInfo.firstChar
    let k = last.item + 1
    let cand = last.item
    while (k < items.length) {
      const it = items[k]
      if (!it.isLiteral) { k++; continue }
      if (it.decoded.length && /^\s+$/.test(it.decoded) &&
          it.codes.every(c => w[c - fc] !== undefined)) { cand = k; k++; continue }
      break
    }
    lastItem = cand
  }

  // width compensation
  let oldW = 0, oldKnown = true, oldGlyphs = 0
  if (simpleInfo?.widths) {
    const w = simpleInfo.widths
    const fc = simpleInfo.firstChar
    for (let k = first.item; k <= lastItem; k++) {
      const it = items[k]
      if (it.isLiteral) for (const code of it.codes) {
        oldGlyphs++
        const cw = w[code - fc]
        if (cw === undefined) { oldKnown = false } else oldW += cw
      } else {
        oldW -= (it.value || 0) // keep kerns' displacement accounted
      }
    }
  } else oldKnown = false

  const spliceStart = items[first.item].start
  const spliceEnd = items[lastItem].end

  if (subst) {
    // A substitute face has different advances, so the pen lands somewhere
    // else after the new run — without a compensating kern every later cell
    // in the array shifts. The compensation is only trusted for a plain
    // byte-coded simple font with a KNOWN encoding, where
    // Widths[code − FirstChar] provably means something: a glyph-coded
    // subset's CMap codes can index that array as numbers that are garbage —
    // plausible-looking averages included — and one such array sheared a
    // timesheet by 53 blocks while reporting success. Losing the edit is
    // recoverable; shifting every later cell of a table is not.
    if (!oldKnown || oldGlyphs === 0) return null
    if (!simpleInfo || simpleInfo.encodingName === 'Unknown' || simpleInfo.isType0) return null
    const avgAdvance = oldW / oldGlyphs
    if (!(avgAdvance >= 150 && avgAdvance <= 1500)) return null
    // Split the array around the run and draw the run in the substitute font.
    const pre = op.raw.slice(0, spliceStart).trimEnd()   // "[ …items-before"
    const post = op.raw.slice(spliceEnd).replace(/^\s*/, '') // "items-after… ] TJ"
    const comp = `${fmtNum(subst.newWidthKu - oldW)} `
    const restore = subst.origFontRef ? `/${subst.origFontRef} ${subst.sizeStr} Tf ` : ''
    return `${pre}] TJ /${subst.fontRef} ${subst.sizeStr} Tf ${newLiteral.literal} Tj ${restore}[${comp}${post}`
  }

  let comp = ''
  if (oldKnown && simpleInfo?.widths) {
    const w = simpleInfo.widths
    const fc = simpleInfo.firstChar
    let newW = 0, known = true
    for (const code of newLiteral.codes) {
      const cw = w[code - fc]
      if (cw === undefined) { known = false } else newW += cw
    }
    if (known) comp = ` ${fmtNum(newW - oldW)} `
  }
  return op.raw.slice(0, spliceStart) + newLiteral.literal + comp + ' ' + op.raw.slice(spliceEnd)
}

/**
 * The clicked block's position expressed in ONE BT block's own text space.
 *
 * Repeated strings — "16:00" in eight table rows, a rule under each of three
 * signatures — are told apart by where they are, and "where" only means
 * anything once the page-space bbox has been pushed back through the CTM the
 * block draws under.
 */
function blockLocalPoint(
  stream: string,
  block: BtInfo,
  targetBlock: TextBlock,
  pageHeight?: number
): { x: number; y: number; xEnd: number; yLo: number; yHi: number; unitScale: number } | null {
  if (pageHeight === undefined) return null
  const ctm = getFullCtmAtOffset(stream, block.start)
  const det = ctm[0] * ctm[3] - ctm[1] * ctm[2]
  if (Math.abs(det) < 1e-9) return null
  const map = (pageX: number, pageY: number) => {
    const ax = pageX - ctm[4], ay = pageY - ctm[5]
    return { x: (ax * ctm[3] - ay * ctm[2]) / det, y: (ay * ctm[0] - ax * ctm[1]) / det }
  }
  // The whole BOX, not one point. A run is judged by whether it overlaps the
  // clicked text, and neither a width nor a line height in page points is a
  // width or a height in the block's own space. The vertical span matters as
  // much as the horizontal: a baseline sits a few points below the middle of
  // the box it draws, and treating that as displacement rejects the very run
  // that drew it.
  //
  // ALL FOUR corners, because the CTM can swap the axes. On a /Rotate page the
  // invocation CTM is a quarter turn, and probing only y-varied points at
  // bbox[0] collapsed the local box to a single point (xEnd === x,
  // yLo === yHi) — every overlap test then compared against nothing.
  const xs: number[] = []
  const ys: number[] = []
  for (const px of [targetBlock.bbox[0], targetBlock.bbox[2]]) {
    for (const py of [pageHeight - targetBlock.bbox[1], pageHeight - targetBlock.bbox[3]]) {
      const p = map(px, py)
      xs.push(p.x); ys.push(p.y)
    }
  }
  const xLo = Math.min(...xs), xHi = Math.max(...xs)
  return {
    x: xLo, y: (Math.min(...ys) + Math.max(...ys)) / 2, xEnd: xHi,
    yLo: Math.min(...ys), yHi: Math.max(...ys),
    // One local unit in PAGE points — multiply a local-frame distance by this
    // before comparing it against page-frame ones (a 0.12-scaled stream's
    // local distances are 8x the page's).
    unitScale: Math.sqrt(Math.abs(det))
  }
}

/**
 * Distance (page points) from the clicked box to the nearest show op in
 * `block` whose own decoded text carries the target (or a substantial piece
 * of it) — or null when no op does.
 *
 * A block's ORIGIN is a lie on this producer: one BT straddles table rows, so
 * the block nearest-by-origin to the clicked cell is routinely the one that
 * draws the NEXT row's copy of the same value — every row repeats
 * "MSP-SIST-CS-2024-003-002", and ranking the containment candidates by
 * origin edited the row below the one clicked. The op that draws the value
 * has a real position (Tm-matrix composed, see scanShowOps); measure THAT.
 */
function opRunDistanceToTarget(
  block: BtInfo,
  targetNorm: string,
  pageIndex: number,
  stream: string,
  targetBlock: TextBlock,
  pageHeight?: number
): number | null {
  const tFree = targetNorm.replace(/\s+/g, '')
  if (!tFree) return null
  const local = blockLocalPoint(stream, block, targetBlock, pageHeight)
  if (!local) return null
  const ops = scanShowOps(block.content, block.encoding, getSimpleFontInfo(pageIndex, block.fontRef),
    (name) => ({ encoding: getFontEncoding(pageIndex, name), simpleInfo: getSimpleFontInfo(pageIndex, name) }))
  let best: number | null = null
  for (const op of ops) {
    const of = op.decoded.replace(/\s+/g, '')
    if (!of) continue
    if (!(of.includes(tFree) || (of.length >= 3 && tFree.includes(of)))) continue
    const dx = op.x < local.x ? local.x - op.x : (op.x > local.xEnd ? op.x - local.xEnd : 0)
    const dy = op.y < local.yLo ? local.yLo - op.y : (op.y > local.yHi ? op.y - local.yHi : 0)
    const d = Math.hypot(dx, dy) * local.unitScale
    if (best === null || d < best) best = d
  }
  return best
}

/** Horizontal advance of one Tj/TJ op, in text-space units, or null if unknown. */
function showOpAdvance(
  op: ShowOpInfo,
  encoding: ReturnType<typeof getFontEncoding>,
  simpleInfo: SimpleFontInfo | null,
  tfSize: number,
  tc: number,
  tw: number
): number | null {
  const widths = simpleInfo?.widths
  if (!widths || !(tfSize > 0)) return null
  const fc = simpleInfo!.firstChar
  // A bare Tj is measured as a one-item array — parseTjItems only looks for
  // literals and numbers between the brackets, and `Tj` is neither.
  const items = parseTjItems(op.kind === 'TJ' ? op.raw : `[${op.raw}]`, encoding, simpleInfo)
  // An EMPTY array advances by nothing — it is not an unknown. Splitting a run
  // out of the front of an array leaves exactly that, `[] TJ`, and calling it
  // unknown made the whole line's pen position unknowable with it.
  if (!items.length) return op.kind === 'TJ' ? 0 : null
  let sum = 0
  for (const it of items) {
    if (!it.isLiteral) { sum -= (it.value ?? 0) / 1000 * tfSize; continue }
    for (const code of it.codes) {
      const cw = widths[code - fc]
      if (cw === undefined) return null
      sum += cw / 1000 * tfSize + tc + (code === 32 ? tw : 0)
    }
  }
  return sum
}

/**
 * Where the pen REALLY is when op `index` starts drawing, plus the text state
 * in force there.
 *
 * `scanShowOps` tracks x only through Tm/Td/TD/T*, so every op after the first
 * of a line reports the LINE's origin rather than the pen. That is enough to
 * rank whole ops against a click and not enough to locate a glyph inside one —
 * and it goes badly wrong once an array has been split, because the part
 * holding the rest of the line still claims to begin where the line began, a
 * hundred points to its left.
 *
 * Null when the answer cannot be trusted: a width missing from the font, a
 * horizontal scale other than 100, or a ' / " in the way. A wrong number here
 * does not fail — it picks the wrong copy of a repeated string and moves that.
 */
function textStateAtOp(
  block: BtInfo,
  ops: ShowOpInfo[],
  index: number,
  pageIndex: number
): { penX: number; tfSize: number; ts: number } | null {
  const masked = maskStreamLiterals(block.content)
  const at = ops[index].start

  /** Last operand of a single-operand text-state operator at or before `off`. */
  const lastOperand = (op: string, dflt: number, off: number): number => {
    const re = new RegExp(`(-?[\\d.]+)\\s+${op}(?![A-Za-z0-9])`, 'g')
    let v = dflt
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      if (m.index > off) break
      v = parseFloat(m[1])
    }
    return v
  }
  if (Math.abs(lastOperand('Tz', 100, at) - 100) > 1e-6) return null
  const tc = lastOperand('Tc', 0, at)
  const tw = lastOperand('Tw', 0, at)
  const ts = lastOperand('Ts', 0, at)

  // A fontless block takes its size from the Tf it inherited — the same rule
  // `rebuildBtContent` follows, and for the same reason: guessing 12 here is a
  // wrong advance for every glyph.
  const inherited = parseFloat(block.inheritedTf?.match(/([\d.]+)\s+Tf\s*$/)?.[1] ?? '')
  const tfAt = (off: number): number => {
    // The NAME is blanked by the mask, so the operand is all that is left to
    // match on — `/TT1 11.04 Tf` masks to `/    11.04 Tf`. Asking for the name
    // here matches nothing at all, which read as "no font size" and refused
    // every block that has one.
    const re = /\/\s+(-?[\d.]+)\s+Tf(?![A-Za-z0-9])/g
    let v = inherited
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      if (m.index > off) break
      v = parseFloat(m[1])
    }
    return v
  }
  const tfSize = tfAt(at)
  if (!Number.isFinite(tfSize) || tfSize <= 0) return null

  // Everything drawn since the pen was last put at a line origin.
  let reset = 0
  const posRe = /(?:-?[\d.]+\s+){6}Tm(?![A-Za-z0-9])|(?:-?[\d.]+\s+){2}T[dD](?![A-Za-z0-9])|T\*(?![A-Za-z0-9])/g
  let pm: RegExpExecArray | null
  while ((pm = posRe.exec(masked)) !== null) {
    if (pm.index > at) break
    reset = pm.index + pm[0].length
  }

  let adv = 0
  for (let i = 0; i < index; i++) {
    const op = ops[i]
    if (op.start < reset) continue
    // ' and " carry an implicit T* and " rewrites Tw/Tc. Refusing is cheaper
    // than modelling them, and they do not appear in the generators this path
    // exists for.
    if (op.kind === 'quote' || op.kind === 'dquote') return null
    const fr = op.fontRef && op.fontRef !== block.fontRef
      ? { encoding: getFontEncoding(pageIndex, op.fontRef), simpleInfo: getSimpleFontInfo(pageIndex, op.fontRef) }
      : { encoding: block.encoding, simpleInfo: getSimpleFontInfo(pageIndex, block.fontRef) }
    const w = showOpAdvance(op, fr.encoding, fr.simpleInfo, tfAt(op.start), tc, tw)
    if (w === null) return null
    adv += w
  }

  return { penX: ops[index].x + adv, tfSize, ts }
}

/**
 * How far the run `ops[from..to]` sits from the clicked text, in points —
 * zero when it is on it — or null when it cannot be measured.
 *
 * y is weighted because two rows of a form are twelve points apart vertically
 * and hundreds horizontally, and it is measured to the BOX, not to its centre:
 * a baseline sits a few points below the middle of the box it draws.
 */
function runGapToTarget(
  block: BtInfo,
  ops: ShowOpInfo[],
  from: number,
  to: number,
  pageIndex: number,
  local: { x: number; xEnd: number; yLo: number; yHi: number }
): number | null {
  const state = textStateAtOp(block, ops, from, pageIndex)
  if (!state) return null
  let width = 0
  for (let k = from; k <= to; k++) {
    const op = ops[k]
    const fr = op.fontRef && op.fontRef !== block.fontRef
      ? { encoding: getFontEncoding(pageIndex, op.fontRef), simpleInfo: getSimpleFontInfo(pageIndex, op.fontRef) }
      : { encoding: block.encoding, simpleInfo: getSimpleFontInfo(pageIndex, block.fontRef) }
    const w = showOpAdvance(op, fr.encoding, fr.simpleInfo ?? null, state.tfSize, 0, 0)
    if (w === null) return null
    width += w
  }
  const lo = Math.min(local.x, local.xEnd), hi = Math.max(local.x, local.xEnd)
  const x0 = state.penX, x1 = state.penX + width
  const xGap = x1 < lo ? lo - x1 : (x0 > hi ? x0 - hi : 0)
  const y = ops[from].y
  const yGap = y < local.yLo ? local.yLo - y : (y > local.yHi ? y - local.yHi : 0)
  return xGap + yGap * 3
}

/**
 * How far the clicked text is from the nearest RUN inside `block` that actually
 * draws it — measured on real glyph advances — or null when the block draws it
 * nowhere near.
 *
 * A block's own ORIGIN is useless for this. The one BT that draws a memo's
 * whole header starts at its top-left corner, so every row inside it scores the
 * same distance, and a ONE-character label was therefore unreachable: `A`
 * cannot be told from the `A` in "Alberto" by its text, the block-level ranking
 * had nothing else to offer, and admitting it rewrote a signature line 500pt
 * away — "PARA" interleaved into "Alberto" as "PAlbReArto". This is the
 * per-RUN position that case always needed.
 *
 * y is weighted, as it is everywhere else here: two rows of a form are a few
 * points apart vertically and hundreds horizontally, so a small y error means
 * far more than a small x one.
 */
function runDistanceToTarget(
  block: BtInfo,
  targetText: string,
  pageIndex: number,
  stream: string,
  targetBlock: TextBlock,
  pageHeight?: number
): number | null {
  const targetNorm = targetText.replace(/\s+/g, ' ').trim()
  if (!targetNorm) return null
  const local = blockLocalPoint(stream, block, targetBlock, pageHeight)
  if (!local) return null
  const ops = scanShowOps(block.content, block.encoding, getSimpleFontInfo(pageIndex, block.fontRef),
    (name) => ({ encoding: getFontEncoding(pageIndex, name), simpleInfo: getSimpleFontInfo(pageIndex, name) }))

  const lo = Math.min(local.x, local.xEnd)
  const hi = Math.max(local.x, local.xEnd)
  /** Gap between a run's x span and the clicked one — zero when they overlap. */
  const gap = (x0: number, x1: number) => x1 < lo ? lo - x1 : (x0 > hi ? x0 - hi : 0)
  /**
   * How far the baseline falls OUTSIDE the clicked box, weighted.
   *
   * Not the distance to its centre: a baseline sits a few points below the
   * middle of the box it draws, and counting that as displacement rejected the
   * very run that drew the text — measured, 3.2pt of ordinary descender slack
   * became 13 against a 10pt budget. Outside the box it is weighted, because
   * two rows of a form are twelve points apart vertically and hundreds
   * horizontally.
   */
  const yGap = (y: number) => (y < local.yLo ? local.yLo - y : (y > local.yHi ? y - local.yHi : 0)) * 3

  let best: number | null = null
  const keep = (d: number) => { if (best === null || d < best) best = d }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (!op.decoded.includes(targetNorm)) continue
    const dy = yGap(op.y)
    const state = textStateAtOp(block, ops, i, pageIndex)
    if (!state) { keep(dy); continue }   // position known only to the line

    const fr = op.fontRef && op.fontRef !== block.fontRef
      ? { encoding: getFontEncoding(pageIndex, op.fontRef), simpleInfo: getSimpleFontInfo(pageIndex, op.fontRef) }
      : { encoding: block.encoding, simpleInfo: getSimpleFontInfo(pageIndex, block.fontRef) }
    const widths = fr.simpleInfo?.widths

    // Inside a TJ array the target can be one cell of a row, so the run is
    // located glyph by glyph rather than taken as the whole op.
    if (op.kind === 'TJ' && widths) {
      const fc = fr.simpleInfo!.firstChar
      const items = parseTjItems(op.raw, fr.encoding, fr.simpleInfo)
      let full = '', acc = 0, usable = true
      const xAt: number[] = []
      for (const it of items) {
        if (!it.isLiteral) { acc -= (it.value ?? 0); continue }
        if (it.decoded.length !== it.codes.length) { usable = false; break }
        for (let c = 0; c < it.decoded.length; c++) {
          const cw = widths[it.codes[c] - fc]
          if (cw === undefined) { usable = false; break }
          xAt.push(acc); acc += cw; full += it.decoded[c]
        }
        if (!usable) break
      }
      if (usable) {
        let p = full.indexOf(targetNorm)
        while (p !== -1) {
          const x0 = state.penX + xAt[p] * state.tfSize / 1000
          const x1 = state.penX + (xAt[p + targetNorm.length - 1] ?? xAt[p]) * state.tfSize / 1000
          keep(gap(x0, x1) + dy)
          p = full.indexOf(targetNorm, p + 1)
        }
        continue
      }
    }

    const w = showOpAdvance(op, fr.encoding, fr.simpleInfo ?? null, state.tfSize, 0, 0)
    keep(gap(state.penX, state.penX + (w ?? 0)) + dy)
  }
  return best
}

interface TjSegmentHit {
  op: ShowOpInfo
  /** Byte range of the run INSIDE op.raw. */
  spliceStart: number
  spliceEnd: number
  tfSize: number
  /** Text rise in force before the op, restored after the shifted run. */
  ts: number
  /** How far the chosen occurrence sits from the click, in points. */
  err: number
}

/**
 * The target text as a run of glyphs INSIDE one TJ array.
 *
 * Word draws the three rules above a signature block as ONE array whose columns
 * are kern jumps — `[(__)…(__) -1796 ( ) (_)…]TJ` — and Ghostscript does the
 * same with a whole table row. Every matcher in the move path works at
 * show-OPERATOR granularity, so the smallest thing it can address is that whole
 * array: 68 characters against a 20-character target, which the run scan
 * rejects on length before it ever looks at the text. The result was a drag
 * that reported "Could not find matching text in content stream" while the
 * names on the lines above and below moved perfectly well.
 *
 * The occurrence is chosen by POSITION, exactly as `replaceInsideTjArray` does
 * it: 20 consecutive underscores also occur inside the 24- and 22-underscore
 * runs beside them, so text alone identifies nothing.
 */
function findTargetSegment(
  block: BtInfo,
  targetBlock: TextBlock,
  pageIndex: number,
  stream: string,
  pageHeight?: number
): TjSegmentHit | null {
  const targetNorm = targetBlock.text.replace(/\s+/g, ' ').trim()
  if (targetNorm.length < 2) return null

  const local = blockLocalPoint(stream, block, targetBlock, pageHeight)
  const ops = scanShowOps(block.content, block.encoding, getSimpleFontInfo(pageIndex, block.fontRef),
    (name) => ({ encoding: getFontEncoding(pageIndex, name), simpleInfo: getSimpleFontInfo(pageIndex, name) }))

  let best: TjSegmentHit | null = null
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op.kind !== 'TJ') continue
    if (!op.decoded.includes(targetNorm)) continue

    const fr = op.fontRef && op.fontRef !== block.fontRef
      ? { encoding: getFontEncoding(pageIndex, op.fontRef), simpleInfo: getSimpleFontInfo(pageIndex, op.fontRef) }
      : { encoding: block.encoding, simpleInfo: getSimpleFontInfo(pageIndex, block.fontRef) }
    const widths = fr.simpleInfo?.widths
    if (!widths) continue
    const fc = fr.simpleInfo!.firstChar

    const items = parseTjItems(op.raw, fr.encoding, fr.simpleInfo)
    if (!items.length) continue

    // Per-character x inside the array, in thousandths of the drawn size —
    // the same table `replaceInsideTjArray` builds to pick its occurrence.
    const charItem: { item: number; charInItem: number }[] = []
    const xAt: number[] = []
    let full = ''
    let acc = 0
    let usable = true
    for (let idx = 0; idx < items.length && usable; idx++) {
      const it = items[idx]
      if (!it.isLiteral) { acc -= (it.value ?? 0); continue }
      // One code per character, or the x table does not line up with the text.
      if (it.decoded.length !== it.codes.length) { usable = false; break }
      for (let c = 0; c < it.decoded.length; c++) {
        const cw = widths[it.codes[c] - fc]
        if (cw === undefined) { usable = false; break }
        charItem.push({ item: idx, charInItem: c })
        xAt.push(acc)
        acc += cw
        full += it.decoded[c]
      }
    }
    if (!usable) continue

    const occ: number[] = []
    let p = full.indexOf(targetNorm)
    while (p !== -1) { occ.push(p); p = full.indexOf(targetNorm, p + 1) }
    // Boundary-aligned only: the run must start at a literal's first character
    // and end at a literal's last. Anything else splits a literal in half, and
    // the array would be corrupt rather than merely wrong.
    const aligned = occ.filter(o => {
      const a = charItem[o]
      const b = charItem[o + targetNorm.length - 1]
      return a && b && a.charInItem === 0 && b.charInItem === items[b.item].decoded.length - 1
    })
    if (!aligned.length) continue

    const state = textStateAtOp(block, ops, i, pageIndex)
    if (!state) continue

    let chosen = aligned[0]
    let err = 0
    if (local) {
      const clickedRel = (local.x - state.penX) * 1000 / state.tfSize
      let bestD = Infinity
      for (const o of aligned) {
        const d = Math.abs(clickedRel - xAt[o])
        if (d < bestD) { bestD = d; chosen = o }
      }
      err = bestD * state.tfSize / 1000
      // Never move a copy the user did not point at. Half the run's own width
      // is the widest a click can miss by and still plainly mean this one.
      const runW = (xAt[chosen + targetNorm.length - 1] - xAt[chosen]) * state.tfSize / 1000
      if (err > Math.max(12, runW * 0.5)) continue
    } else if (aligned.length > 1) {
      // Repeated text and no position to tell the copies apart.
      continue
    }

    const first = charItem[chosen]
    const last = charItem[chosen + targetNorm.length - 1]
    const hit: TjSegmentHit = {
      op,
      spliceStart: items[first.item].start,
      spliceEnd: items[last.item].end,
      tfSize: state.tfSize,
      ts: state.ts,
      err
    }
    if (!best || hit.err < best.err) best = hit
  }
  return best
}

/**
 * Displace a run of glyphs inside a TJ array by (tdx, tdy), in text space.
 *
 * `Td` cannot be used here: it moves the LINE matrix, so a Td in front of a
 * mid-line run resets the pen to the start of the line and scrambles
 * everything after it. The two displacements that are safe mid-line are a kern
 * for x — with its exact negation afterwards, so the pen lands where it always
 * did — and `Ts` (text rise) for y, restored to whatever was in force.
 *
 * The array is split into up to three ops around the run, the same shape
 * `replaceInsideTjArray`'s substitution branch already emits. An empty array is
 * legal and draws nothing, so a run at either end needs no special case.
 */
function shiftInsideTjArray(hit: TjSegmentHit, tdx: number, tdy: number): string | null {
  if (!Number.isFinite(hit.tfSize) || hit.tfSize <= 0) return null
  if (!Number.isFinite(tdx) || !Number.isFinite(tdy)) return null

  const raw = hit.op.raw
  const pre = raw.slice(0, hit.spliceStart).trimEnd()      // "[ …items-before"
  const mid = raw.slice(hit.spliceStart, hit.spliceEnd)    // the run itself
  const post = raw.slice(hit.spliceEnd).replace(/^\s*/, '') // "items-after… ] TJ"

  // A kern k displaces the pen by −k/1000 × size, so advancing it by tdx needs
  // −tdx, and putting it back needs the same number with the other sign.
  const kern = -tdx * 1000 / hit.tfSize
  const lead = Math.abs(kern) > 1e-4 ? `${fmtNum(kern)} ` : ''
  const trail = Math.abs(kern) > 1e-4 ? `${fmtNum(-kern)} ` : ''
  const rise = Math.abs(tdy) > 1e-4
  if (!lead && !rise) return null

  const parts = [`${pre}] TJ`]
  if (rise) parts.push(`${fmtNum(hit.ts + tdy)} Ts`)
  parts.push(`[${lead}${mid}] TJ`)
  if (rise) parts.push(`${fmtNum(hit.ts)} Ts`)
  parts.push(`[${trail}${post}`)
  return parts.join(' ')
}

/** Rebuild a show op with a new literal, PRESERVING its operator (so the
 *  line advances of ' and " and the structure of TJ stay intact). */
function buildShowOp(kind: ShowOpInfo['kind'], literal: string, rawOld: string): string {
  switch (kind) {
    case 'Tj': return `${literal} Tj`
    case 'quote': return `${literal} '`
    case 'dquote': {
      const nums = rawOld.match(/^(-?[\d.]+\s+-?[\d.]+\s+)/)
      return `${nums ? nums[1] : '0 0 '}${literal} "`
    }
    case 'TJ': return `[${literal}] TJ`
  }
}

/**
 * Shrink a matched op run to the part the edit actually changed, by dropping
 * leading show ops whose glyphs the new text still begins with. Returns null
 * when nothing can be dropped.
 *
 * This exists because a replacement is encoded in ONE font, and a line is not
 * obliged to be drawable in one: these reports start every bullet with a "✓"
 * that its own font draws (a CJK or dingbat subset) and set the sentence in
 * another. Re-encoding the whole line therefore had to find a single face
 * holding both, failed, fell through to WinAnsi — which has no U+2713 — and
 * reported "Cannot encode characters: ✓". Every bullet on every page was
 * uneditable, while erasing the line and retyping it worked, because that
 * dropped the ✓.
 *
 * Dropping the op that draws the ✓ is not a workaround for the encoder, it is
 * the more faithful edit: the character is UNCHANGED, so the right thing is to
 * leave the operator that drew it exactly as it was, in its own font, rather
 * than re-encode it into a substitute that would not look the same.
 *
 * Whole ops only — an op is the smallest unit whose font is known, so a symbol
 * left in the MIDDLE of a run still has to be re-encoded with everything
 * around it.
 *
 * **From the FRONT only.** Trimming the tail as well is the obvious symmetry
 * and it is wrong: a run's later ops are placed by their own `Td`, an offset
 * computed for the width of the text that USED to precede them. Leaving them
 * untouched while the text before them changes length strands them at the old
 * offset — a gap when the replacement is shorter, and the two drawn through
 * each other when it is longer, which is how "✓Fecha de garantía: … (Según
 * fabricante)." came back as one line printed over another. A leading op has
 * no such dependency: it is drawn BEFORE the replacement, so its position
 * cannot depend on the replacement's width.
 */
function narrowToChangedOps(
  ops: ShowOpInfo[],
  i: number,
  j: number,
  newText: string
): { i: number; j: number; text: string } | null {
  let lo = i, text = newText
  while (lo < j) {
    // Space-FREE, like every other stream-vs-extraction compare: the op's
    // spaces are glyphs at stream positions, the target's are synthesised by
    // the extractor, and they routinely disagree inside the very runs this
    // narrowing exists for (a garbled CJK label decodes "fHi:l El" while
    // extraction reports "fHi :lEl"). An exact startsWith stopped the walk at
    // the first such disagreement and the unchanged ops were re-encoded anyway.
    const dFree = ops[lo].decoded.replace(/\s+/g, '')
    if (dFree) {
      const consumed = consumePrefixFree(text, dFree)
      if (consumed === null) break
      text = text.slice(consumed)
    }
    lo++
  }
  return lo !== i ? { i: lo, j, text: text.replace(/^\s+/, '') } : null
}

/**
 * Glyph codes this block ACTUALLY draws for each character, in the font in
 * force at `like`. A subset's ToUnicode routinely claims one character for
 * several glyph ids, so the reverse map has to guess which id to write — and
 * on a garbled CMap the guess can name a glyph that DRAWS a different
 * character than it claims ("al" re-encoded through such a map rendered "a1").
 * A code the block already uses for a character is not a guess: it provably
 * drew that character on this page. Only single-character mappings are
 * collected — a multi-character destination has no one code point to key on.
 */
function preferredGlyphCodes(
  ops: ShowOpInfo[],
  like: ShowOpInfo,
  block: BtInfo,
  encoding: ReturnType<typeof getFontEncoding>
): Map<number, number> | undefined {
  if (!encoding) return undefined
  const want = like.fontRef ?? block.fontRef
  const prefer = new Map<number, number>()
  const stride = encoding.codeBytes === 1 ? 1 : 2
  const litRe = new RegExp(`(${STR_LIT_SRC})|(${HEX_LIT_SRC})`, 'g')
  for (const op of ops) {
    if ((op.fontRef ?? block.fontRef) !== want) continue
    litRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = litRe.exec(op.raw)) !== null) {
      const codes: number[] = []
      if (m[2] !== undefined) {
        codes.push(...hexToCodes(m[2].slice(1, -1).replace(/\s+/g, ''), stride))
      } else {
        // A plain literal only carries CMap codes when the font is glyph-coded
        // (it has a ToUnicode and draws its codes as raw bytes) — which is the
        // only case this map is consulted in, since encodeTextForFont is the
        // encoder for exactly those fonts.
        const s = unescapePdfString(m[1].slice(1, -1))
        for (let i = 0; i + stride - 1 < s.length; i += stride) {
          let c = 0
          for (let k = 0; k < stride; k++) c = (c << 8) | s.charCodeAt(i + k)
          codes.push(c)
        }
      }
      for (const c of codes) {
        const u = encoding.glyphToUnicode.get(c)
        if (u !== undefined && u >= 0 && u <= 0x10FFFF && !prefer.has(u)) prefer.set(u, c)
      }
    }
  }
  return prefer.size ? prefer : undefined
}

/**
 * Replace only the show-ops matching the target text INSIDE a BT block that
 * contains more text than the target (a single BT holding several Td/'-
 * positioned lines — e.g. a 4-line header box). Whole-block replacement in
 * that situation would wipe the sibling lines.
 */
function applyPartialBlockReplacement(
  stream: string,
  block: BtInfo,
  newText: string,
  pageIndex: number,
  targetBlock: TextBlock,
  pageHeight?: number
): { stream: string; substitutedFont?: string; strategy?: string; anchorOffset?: number; lines?: number; retags?: SpanRetag[]; applied?: AppliedEdit[] } | { error: string } | null {
  const simpleInfo = getSimpleFontInfo(pageIndex, block.fontRef)
  const ops = scanShowOps(block.content, block.encoding, simpleInfo,
    (name) => ({ encoding: getFontEncoding(pageIndex, name), simpleInfo: getSimpleFontInfo(pageIndex, name) }))
  if (ops.length < 1) return null

  const targetNorm = targetBlock.text.replace(/\s+/g, ' ').trim()
  if (!targetNorm) return null

  // The run being replaced may sit under a mid-block Tf — encode the new text
  // for the font in force AT the run, not the block's first font.
  const encodingFor = (op: ShowOpInfo) => {
    if (!op.fontRef || op.fontRef === block.fontRef) {
      return { fontRef: block.fontRef, encoding: block.encoding, simpleInfo }
    }
    return {
      fontRef: op.fontRef,
      encoding: getFontEncoding(pageIndex, op.fontRef),
      simpleInfo: getSimpleFontInfo(pageIndex, op.fontRef)
    }
  }

  // Map the clicked block's page position into this BT block's local text
  // space so repeated identical strings ("16:00" in every table row) resolve
  // to the occurrence the user actually clicked.
  const targetLocal = blockLocalPoint(stream, block, targetBlock, pageHeight)

  // Best contiguous run of ops whose concatenated text matches the target;
  // ties broken by distance to the clicked position
  let best: { i: number; j: number; score: number; dist: number } | null = null
  for (let i = 0; i < ops.length; i++) {
    let acc = ''
    for (let j = i; j < ops.length; j++) {
      acc += ops[j].decoded
      const norm = acc.replace(/\s+/g, ' ').trim()
      if (norm.length > targetNorm.length * 1.5 + 8) break
      if (!norm) continue
      const ratio = matchRatio(norm, targetNorm)
      if (ratio < 0.7) continue
      let score = 0
      if (norm === targetNorm) score = 2
      else if (fuzzyTextMatch(norm, targetNorm)) score = ratio
      if (score <= 0) continue
      const dist = targetLocal
        ? Math.abs(ops[i].x - targetLocal.x) + Math.abs(ops[i].y - targetLocal.y) * 4
        : 0
      if (!best || score > best.score + 0.05 ||
          (Math.abs(score - best.score) <= 0.05 && dist < best.dist)) {
        best = { i, j, score, dist }
      }
    }
  }

  /**
   * A SHORT target's winning window has to sit on the clicked text.
   *
   * Distance is only a tie-break above, and a stray match can win on score
   * outright. Asked to change this memo's `A` label, the op scan found a
   * lone-glyph `a` at the end of "Tecnología" — a perfect ratio against a
   * one-character target — 350pt away and a line down, while the label itself
   * lives inside a big TJ array and is never scored at op level at all
   * (the array breaks the length guard immediately). The replacement went
   * there: "Tecnología" came back "Tecnologírrrr" and the label was untouched.
   *
   * Measured on real advances, so it is only asked where every width is known;
   * where it cannot be answered the window stands. Restricted to targets of
   * three characters or fewer — below that length the text carries almost no
   * identification, and above it the op scan has a corpus behind it.
   */
  if (best && targetLocal && targetNorm.length <= 3) {
    const gap = runGapToTarget(block, ops, best.i, best.j, pageIndex, targetLocal)
    if (gap !== null && gap > Math.max(6, targetBlock.height || 0)) best = null
  }

  /**
   * The matched op carries materially MORE text than the target.
   *
   * That is the Ghostscript table row: ONE TJ array holding every cell of the
   * line, the columns separated by kern jumps rather than by separate ops. The
   * op-level replacement writes the new text into the op and blanks the rest of
   * the window, so applying it here draws the replacement at the START of the
   * row and deletes every other cell — editing a memo's addressee took its "A"
   * label with it and moved the name to the label's column.
   *
   * The array has to be edited from the inside instead, which is exactly what
   * `replaceInsideTjArray` exists for; it was only ever reached when NO op
   * matched, and here one does, because the row CONTAINS the target and so
   * fuzzy-matches it.
   */
  const bestHoldsMoreThanTarget = best !== null && best.i === best.j &&
    ops[best.i].kind === 'TJ' && (() => {
      // Not a length ratio — the leftover is what matters. A memo's addressee
      // row is one array reading "A :  Ing. Matías …" against a target of
      // ":  Ing. Matías …": only two characters longer, and those two are the
      // label the replacement would delete.
      //
      // Compared with every space REMOVED, not collapsed. The extracted target
      // and the decoded stream disagree on spaces routinely — extraction
      // synthesises one from a kern, or invents one inside a run this engine
      // re-encoded (the "Cab rera" artifact) — and a collapsed `includes` then
      // fails on the very row it exists to protect. That is how the SECOND
      // edit of this memo's addressee fell through to the op-level rewrite the
      // first edit was saved from: the whole array was replaced, the "A" label
      // and its column kern with it, and the row redrew starting in the label's
      // column.
      const dFree = ops[best!.i].decoded.replace(/\s+/g, '')
      const tFree = targetNorm.replace(/\s+/g, '')
      if (!tFree || dFree === tFree || !dFree.includes(tFree)) return false
      return dFree.replace(tFree, '').length > 0
    })()

  // No op-level window matched — the target may live INSIDE a single TJ
  // array (Ghostscript merges a whole table row into one array, jumping
  // between cells with kern numbers). Replace just those glyphs.
  if (!best || bestHoldsMoreThanTarget) {
    const tfMatch = block.content.match(/\/(?:[^\s<>[\]()/%]+)\s+([\d.]+)\s+Tf/)
    // A fontless block takes its size from the Tf it inherited, not from a flat
    // 12: this size is written back out with the restore, so guessing it
    // re-sizes the inherited font for everything drawn after the array.
    const inheritedSize2 = parseFloat(block.inheritedTf?.match(/([\d.]+)\s+Tf\s*$/)?.[1] ?? '')
    const tfSize = tfMatch
      ? parseFloat(tfMatch[1])
      : (Number.isFinite(inheritedSize2) ? inheritedSize2 : 12)

    // Candidate arrays containing the target, nearest clicked position first
    const candidates = ops
      // Space-FREE on both sides: the gap between two cells is a KERN, so the
      // array's own spacing need not match the spacing the extractor reported —
      // and extraction can also invent a space inside a run this engine
      // re-encoded, which a merely collapsed comparison still trips over.
      .filter(o => o.kind === 'TJ' &&
        o.decoded.replace(/\s+/g, '').includes(targetNorm.replace(/\s+/g, '')))
      .sort((a, b) => {
        if (!targetLocal) return 0
        const da = Math.abs(a.x - targetLocal.x) + Math.abs(a.y - targetLocal.y) * 4
        const db = Math.abs(b.x - targetLocal.x) + Math.abs(b.y - targetLocal.y) * 4
        return da - db
      })

    for (const op of candidates) {
      // Encode for the font in force AT this array, not the block's first.
      const fr = encodingFor(op)
      const plan = planTextEncoding(pageIndex,
        { mode: op.isHex ? 'hex' : 'plain', fontRef: fr.fontRef, encoding: fr.encoding,
          preferCodes: preferredGlyphCodes(ops, op, block, fr.encoding) },
        [newText], targetBlock)
      // Only fatal when the array is the ONLY hope; with an op window still in
      // hand, an unencodable cell just means this route is not the one.
      if (plan.kind === 'error') { if (!best) return { error: plan.error }; break }

      let newRaw: string | null = null
      let substFont: string | undefined
      if (plan.kind === 'subst') {
        // The cell's subsetted font lacks the replacement's glyphs. Split the
        // array and draw just this run in the substitute face.
        const newLit = { literal: substLiteral(plan), codes: [] as number[] }
        newRaw = replaceInsideTjArray(op, targetNorm, newLit, fr.encoding, fr.simpleInfo, targetLocal?.x ?? null, tfSize, {
          fontRef: plan.fontRef,
          origFontRef: op.fontRef ?? block.fontRef,
          sizeStr: fmtNum(tfSize),
          newWidthKu: Math.round(measureEm(newText, plan.fontName) * 1000)
        })
        if (newRaw) substFont = plan.fontName
      } else {
        const newLit = plan.kind === 'keep-hex'
          ? { literal: `<${plan.hexLines[0]}>`, codes: hexToCodes(plan.hexLines[0], fr.encoding ? (fr.encoding.codeBytes === 1 ? 1 : 2) : 1) }
          : { literal: `(${escapePdfString(plan.byteLines[0])})`, codes: [...plan.byteLines[0]].map(c => c.charCodeAt(0)) }
        newRaw = replaceInsideTjArray(op, targetNorm, newLit, fr.encoding, fr.simpleInfo, targetLocal?.x ?? null, tfSize)
      }

      if (newRaw) {
        const content = block.content.slice(0, op.start) + newRaw + block.content.slice(op.end)
        // On a tagged page the span still claims the OLD words — override it
        // with the block's text as it now reads (only this array changed).
        // The splice is space-insensitive for the same reason the match is:
        // a plain .replace silently no-ops when the extractor's spacing
        // disagrees with the stream's, and the span then keeps the old words.
        const spanText = ops.map(o => o === op ? looseReplace(o.decoded, targetNorm, newText) : o.decoded).join('')
        const tag = retagSpanActualText(stream, block.start, spanText.trim())
        return {
          stream: stream.slice(0, block.start) + 'BT' + content + 'ET' + stream.slice(block.end),
          substitutedFont: substFont,
          retags: tag ? [tag] : []
        }
      }
    }
    // Refuse rather than fall through to the op-level replacement: this array
    // holds cells the edit never named, and losing the edit is recoverable
    // where silently deleting the rest of the row is not.
    return null
  }

  const planFor = (at: number, text: string) => {
    const fr = encodingFor(ops[at])
    return planTextEncoding(pageIndex,
      { mode: ops[at].isHex ? 'hex' : 'plain', fontRef: fr.fontRef, encoding: fr.encoding,
        preferCodes: preferredGlyphCodes(ops, ops[at], block, fr.encoding) },
      [text], targetBlock)
  }

  let winI = best.i, winJ = best.j, winText = newText
  let plan = planFor(winI, winText)
  if (plan.kind === 'error' || plan.kind === 'subst') {
    // The run as a whole is not encodable in any one face — or only in a
    // SUBSTITUTE one. Before accepting either, stop trying to re-encode the
    // ops the edit never touched — see narrowToChangedOps. A substitution is
    // as much a reason to narrow as an error: re-encoding an unchanged head
    // into the substitute redraws glyphs the user never touched, and where
    // that head is a CJK label whose ToUnicode maps to Latin garbage
    // ("fHi :lEl M:" for 开始日期), the substitution DRAWS that garbage in
    // place of the ideographs. Where the run already encodes in its own font,
    // nothing is trimmed and the rewrite stays exactly as wide as it was.
    const narrowed = narrowToChangedOps(ops, winI, winJ, winText)
    if (narrowed) {
      const retry = planFor(narrowed.i, narrowed.text)
      if (retry.kind !== 'error') {
        winI = narrowed.i; winJ = narrowed.j; winText = narrowed.text; plan = retry
      }
    }
    if (plan.kind === 'error') return { error: plan.error }
  }

  let content = block.content
  let substitutedFont: string | undefined
  for (let k = winJ; k >= winI; k--) {
    const op = ops[k]
    let repl: string
    if (k === winI) {
      if (plan.kind === 'keep-hex') {
        repl = buildShowOp(op.kind, `<${plan.hexLines[0]}>`, op.raw)
      } else if (plan.kind === 'keep-plain') {
        repl = buildShowOp(op.kind, `(${escapePdfString(plan.byteLines[0])})`, op.raw)
      } else {
        // Substituted font applies to THIS op only — afterwards, restore the
        // font the ops AFTER the window actually inherit: the one in force at
        // the window's END, not the block's first Tf. A bilingual form draws
        // one cell as three lines in a single BT — two Latin lines under a
        // font inherited from BEFORE the block, then a CJK line set by the
        // block's only in-content Tf. Restoring "the block's first Tf" put
        // the CJK font over the untouched Latin lines the moment line one was
        // edited: they rendered as garbage and extracted as U+FFFD, reported
        // as the edit corrupting the rest of the cell.
        //
        // op.fontRef carries the last in-block Tf before the op; null means
        // the window ran under the block's ENTERING font — the inherited
        // operator verbatim when recorded, else the resolved name in
        // block.fontRef. Sizes come from the text state at the window, not
        // from whatever Tf happens to appear first in the content.
        const tfMatch = block.content.match(/\/([^\s<>[\]()/%]+)\s+([\d.]+)\s+Tf/)
        const inheritedSize = block.inheritedTf?.match(/([\d.]+)\s+Tf\s*$/)?.[1]
        const fallbackSize = tfMatch ? tfMatch[2] : (inheritedSize ?? '12')
        const stateIn = textStateAtOp(block, ops, winI, pageIndex)
        const stateOut = winJ === winI ? stateIn : textStateAtOp(block, ops, winJ, pageIndex)
        const drawSize = stateIn?.tfSize ? fmtNum(stateIn.tfSize) : fallbackSize
        const endSize = stateOut?.tfSize ? fmtNum(stateOut.tfSize) : fallbackSize
        const endFont = ops[winJ].fontRef
        const restore = endFont
          ? ` /${endFont} ${endSize} Tf`
          : block.inheritedTf
            ? ` ${block.inheritedTf}`
            : block.fontRef
              ? ` /${block.fontRef} ${endSize} Tf`
              : (tfMatch ? ` /${tfMatch[1]} ${fallbackSize} Tf` : '')
        repl = `/${plan.fontRef} ${drawSize} Tf ${buildShowOp(op.kind, substLiteral(plan), op.raw)}${restore}`
        substitutedFont = plan.fontName
      }
    } else {
      // Blank the other ops in the range, keeping their operators so
      // subsequent line advances stay correct
      repl = buildShowOp(op.kind, op.isHex ? '<>' : '()', op.raw)
    }
    content = content.slice(0, op.start) + repl + content.slice(op.end)
  }

  // A partial rewrite on a TAGGED page leaves the span claiming the old words
  // for the WHOLE block — extraction (including this engine's own next read)
  // then reports the old text and a second edit has nothing to match. Override
  // with the block's text as it now reads: the replaced run's new text plus
  // every untouched op's own.
  const spanText = ops.map((o, k) =>
    k === winI ? winText : (k > winI && k <= winJ ? '' : o.decoded)).join('')
  const tag = retagSpanActualText(stream, block.start, spanText.trim())

  return {
    stream: stream.slice(0, block.start) + 'BT' + content + 'ET' + stream.slice(block.end),
    substitutedFont,
    retags: tag ? [tag] : []
  }
}

/**
 * Replace text in a BT block.
 * For hex-encoded fonts: replaces with hex-encoded glyph IDs.
 * For plain text fonts: replaces with escaped PDF strings.
 */
function replaceTjInBlock(block: string, newText: string, mode: 'hex' | 'plain', newHex?: string): string {
  // Single sequential pass over ALL show-text operations (Tj, ', ", TJ) in
  // stream order: the new text goes into the FIRST one, every other one is
  // blanked — regardless of literal type. This handles nested parens, ']'
  // inside array strings, hex whitespace, and the quote operators that the
  // previous per-operator regexes missed (leaving old text on the page).
  const showRe = new RegExp(
    // [ ...strings/hex/numbers... ] TJ
    String.raw`\[(?:${STR_LIT_SRC}|${HEX_LIT_SRC}|[^\]])*\]\s*TJ` + '|' +
    // aw ac (string) "  — strip the two numeric operands too
    String.raw`(?:-?[\d.]+\s+-?[\d.]+\s+)?(?:${STR_LIT_SRC}|${HEX_LIT_SRC})\s*"` + '|' +
    // (string) Tj   (string) '
    String.raw`(?:${STR_LIT_SRC}|${HEX_LIT_SRC})\s*(?:Tj|')`,
    'g'
  )

  let first = true
  const firstOp = mode === 'hex' && newHex !== undefined
    ? `<${newHex}> Tj`
    : `(${escapePdfString(newText)}) Tj`
  const blankOp = mode === 'hex' ? '<> Tj' : '() Tj'

  let result = block.replace(showRe, () => {
    const r = first ? firstOp : blankOp
    first = false
    return r
  })

  // Strip leftover Td operators from previous line wrapping
  // (remove "0 -X.X Td" lines that precede blanked Tj operators)
  result = result.replace(/[\d.-]+\s+[\d.-]+\s+Td\s*\n?\s*(?:<>\s*Tj|\(\)\s*Tj)/g, '')

  return result
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

function unescapePdfString(s: string): string {
  // Single pass — sequential .replace() calls mis-decode sequences like
  // "\\n" (escaped backslash + n, e.g. a Windows path), turning them into
  // backslash + linefeed and corrupting block matching.
  return s.replace(/\\(\d{1,3}|\r\n|[\s\S])/g, (_, esc: string) => {
    if (/^\d/.test(esc)) return String.fromCharCode(parseInt(esc, 8) & 0xFF)
    switch (esc) {
      case 'n': return '\n'
      case 'r': return '\r'
      case 't': return '\t'
      case 'b': return '\b'
      case 'f': return '\f'
      case '\r\n': case '\r': case '\n': return '' // line continuation
      default: return esc // \\ \( \) and any other escaped char → literal
    }
  })
}

function escapePdfString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

// ==========================================
// DEBUG
// ==========================================

function debugPageFonts(pageIndex: number): any {
  if (!pdfDoc) return { error: 'No document' }

  const page = pdfDoc.loadPage(pageIndex)
  const pageObj = page.getObject()

  // Debug: check what's in the page object
  const pageObjStr = pageObj.toString()

  const resources = pageObj.get('Resources')
  const resourcesStr = resources ? resources.toString() : 'null'

  // Try resolving resources
  const resolvedRes = resources?.resolve?.() || resources
  const resStr2 = resolvedRes ? resolvedRes.toString() : 'null after resolve'

  const fontDict = resolvedRes?.get?.('Font')
  const fontDictStr = fontDict ? fontDict.toString() : 'null'

  // Try resolving font dict
  const resolvedFontDict = fontDict?.resolve?.() || fontDict
  const fontDictStr2 = resolvedFontDict ? resolvedFontDict.toString() : 'null after resolve'

  const fonts: any[] = []
  const len = resolvedFontDict?.length || 0

  const debugInfo = {
    pageObjPreview: pageObjStr.substring(0, 300),
    resourcesStr: resourcesStr.substring(0, 200),
    resourcesResolved: resStr2.substring(0, 200),
    fontDictStr: fontDictStr.substring(0, 200),
    fontDictResolved: fontDictStr2.substring(0, 300),
    fontDictLen: len
  }

  for (let i = 0; i < len; i++) {
    const key = fontDict.getKey(i)
    const val = fontDict.getVal(i).resolve()

    const info: any = {
      ref: key,
      baseFont: val.get('BaseFont')?.toString?.() || 'unknown',
      subtype: val.get('Subtype')?.toString?.() || 'unknown'
    }

    // Check ToUnicode
    const toUnicode = val.get('ToUnicode')
    if (toUnicode && !toUnicode.isNull?.()) {
      const resolved = toUnicode.resolve()
      if (resolved.isStream()) {
        const buf = resolved.readStream()
        const cmapText = buf.asString()
        buf.destroy()
        info.hasToUnicode = true
        info.cmapLength = cmapText.length
        info.cmapPreview = cmapText.substring(0, 200)

        // Try parsing it
        const encoding = parseToUnicodeCMap(cmapText)
        info.mappings = encoding.unicodeToGlyph.size
        // Show sample mappings
        const samples: any[] = []
        let count = 0
        for (const [unicode, glyph] of encoding.unicodeToGlyph) {
          if (count++ >= 10) break
          samples.push({
            unicode: `U+${unicode.toString(16).toUpperCase().padStart(4, '0')}`,
            char: String.fromCodePoint(unicode),
            glyph: `0x${glyph.toString(16).toUpperCase().padStart(4, '0')}`
          })
        }
        info.sampleMappings = samples
      } else {
        info.hasToUnicode = false
        info.toUnicodeType = typeof resolved
      }
    } else {
      info.hasToUnicode = false
    }

    // Check DescendantFonts for Type0
    const descendants = val.get('DescendantFonts')
    if (descendants && descendants.isArray?.() && descendants.length > 0) {
      info.isType0 = true
      const desc = descendants.get(0).resolve()
      const descTU = desc.get('ToUnicode')
      if (descTU && !descTU.isNull?.()) {
        info.descendantHasToUnicode = true
      }
    }

    fonts.push(info)
  }

  page.destroy()
  return { pageIndex, fontCount: len, fonts, debug: debugInfo }
}

// ==========================================
// PAGE GEOMETRY
// ==========================================

function getPageSize(pageIndex: number): { width: number; height: number; rotation: number } {
  const page = pdfDoc.loadPage(pageIndex)
  try {
    const b = page.getBounds()
    let rotation = 0
    try {
      const r = page.getObject().get('Rotate')
      if (r && r.toString() !== 'null') rotation = ((r.asNumber?.() ?? parseInt(r.toString(), 10)) % 360 + 360) % 360
    } catch (_) {}
    return { width: b[2] - b[0], height: b[3] - b[1], rotation }
  } finally {
    page.destroy()
  }
}

// ==========================================
// ANNOTATIONS (MuPDF native PDFAnnotation API)
// ==========================================

/** Coerce an AnnotColor (possibly empty) into a plain number[] (0-1). */
function colorArr(c: any): number[] {
  if (!c || !Array.isArray(c)) return []
  return c.map((n: any) => Number(n))
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

/**
 * Annotations AND widgets, as ONE list.
 *
 * MuPDF's getAnnotations() deliberately excludes /Widget annotations — form
 * fields, which is what an e-signing service (Intellisign) stamps its
 * signature images through: a /Sig widget whose appearance form draws the
 * handwritten scribble. A signed memo's three signatures therefore had no
 * entry anywhere in this layer — no hit target, not selectable, not movable —
 * while the page's own logo dragged fine, reported as "I can move the logo
 * but not the signatures".
 *
 * Widgets are appended AFTER the plain annotations, so every index that
 * worked before is unchanged, and a freshly created annotation's index
 * (`getAnnotations().length - 1`) still names the same entry in this list.
 * Hidden and no-view widgets are left out on BOTH the listing and the
 * resolving side — the two must agree on indices, and a hit target over
 * something that draws nothing invites deleting the invisible.
 */
function getAnnotsAndWidgets(page: any): any[] {
  const annots = page.getAnnotations()
  let widgets: any[] = []
  try {
    widgets = (page.getWidgets() || []).filter((w: any) => {
      const f = safe(() => Number(String(w.getObject().get('F') ?? 0)) || 0, 0)
      return !(f & 2) && !(f & 32) // Hidden, NoView
    })
  } catch (_) { /* no widget support — annotations alone */ }
  return widgets.length ? [...annots, ...widgets] : annots
}

function listAnnotations(pageIndex: number): any[] {
  const page = pdfDoc.loadPage(pageIndex)
  const annots = getAnnotsAndWidgets(page)
  const out: any[] = []
  annots.forEach((annot: any, index: number) => {
    let type = safe(() => annot.getType(), 'Unknown')
    if (type === 'Widget') {
      type = safe(() => String(annot.getObject().get('FT')) === '/Sig' ? 'Signature' : 'Widget', 'Widget')
    }
    // Some annotation types (Ink, Line) may throw on getRect — fall back to getBounds.
    let rect = safe<number[] | null>(() => annot.getRect(), null)
    if (!rect) rect = safe<number[] | null>(() => annot.getBounds(), null)
    if (!rect) rect = [0, 0, 0, 0]
    out.push({
      index,
      type,
      rect: [rect[0], rect[1], rect[2], rect[3]],
      color: colorArr(safe(() => annot.getColor(), [])),
      interiorColor: colorArr(safe(() => annot.getInteriorColor(), [])),
      opacity: safe(() => annot.getOpacity(), 1),
      borderWidth: safe(() => annot.getBorderWidth(), 1),
      contents: safe(() => annot.getContents(), ''),
      author: safe(() => annot.getAuthor(), ''),
      hasQuadPoints: safe(() => annot.hasQuadPoints(), false)
    })
  })
  page.destroy()
  return out
}

function addTextMarkup(
  pageIndex: number,
  markupType: string,
  quads: number[][],
  color: [number, number, number],
  opacity = 1
): { success: boolean; index?: number; error?: string } {
  try {
    const page = pdfDoc.loadPage(pageIndex)
    const annot = page.createAnnotation(markupType as any)
    annot.setQuadPoints(quads as any)
    annot.setColor(color as any)
    try { annot.setOpacity(opacity) } catch (_) {}
    annot.update()
    const index = page.getAnnotations().length - 1
    page.destroy()
    return { success: true, index }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

function addShape(
  pageIndex: number,
  shapeType: string,
  rect: number[] | undefined,
  points: number[][] | undefined,
  color: [number, number, number],
  interiorColor: [number, number, number] | null | undefined,
  width: number,
  opacity = 1
): { success: boolean; index?: number; error?: string } {
  try {
    const page = pdfDoc.loadPage(pageIndex)
    const annot = page.createAnnotation(shapeType as any)

    if (shapeType === 'Line' && points && points.length === 2) {
      // Line annotations derive their Rect from the endpoints — calling setRect throws.
      annot.setLine(points[0] as any, points[1] as any)
    } else if (rect) {
      annot.setRect(rect as any)
    }

    annot.setColor(color as any)
    if (interiorColor && (shapeType === 'Square' || shapeType === 'Circle')) {
      try { annot.setInteriorColor(interiorColor as any) } catch (_) {}
    }
    try { annot.setBorderWidth(width) } catch (_) {}
    try { annot.setOpacity(opacity) } catch (_) {}
    annot.update()
    const index = page.getAnnotations().length - 1
    page.destroy()
    return { success: true, index }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

function addInk(
  pageIndex: number,
  strokes: number[][][],
  color: [number, number, number],
  width: number,
  opacity = 1
): { success: boolean; index?: number; error?: string } {
  try {
    const page = pdfDoc.loadPage(pageIndex)
    const annot = page.createAnnotation('Ink')
    annot.setInkList(strokes as any)
    annot.setColor(color as any)
    try { annot.setBorderWidth(width) } catch (_) {}
    try { annot.setOpacity(opacity) } catch (_) {}
    annot.update()
    const index = page.getAnnotations().length - 1
    page.destroy()
    return { success: true, index }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

function addFreeText(
  pageIndex: number,
  rect: number[],
  text: string,
  fontSize: number,
  color: [number, number, number],
  fontName = 'Helv'
): { success: boolean; index?: number; error?: string } {
  try {
    const page = pdfDoc.loadPage(pageIndex)
    const annot = page.createAnnotation('FreeText')
    annot.setRect(rect as any)
    annot.setContents(text)
    try { annot.setDefaultAppearance(fontName, fontSize, color as any) } catch (_) {}
    annot.update()
    const index = page.getAnnotations().length - 1
    page.destroy()
    return { success: true, index }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

function addStickyNote(
  pageIndex: number,
  x: number,
  y: number,
  text: string,
  color: [number, number, number]
): { success: boolean; index?: number; error?: string } {
  try {
    const page = pdfDoc.loadPage(pageIndex)
    const annot = page.createAnnotation('Text')
    annot.setRect([x, y, x + 20, y + 20] as any)
    annot.setContents(text)
    try { annot.setColor(color as any) } catch (_) {}
    try { annot.setIcon('Note') } catch (_) {}
    annot.update()
    const index = page.getAnnotations().length - 1
    page.destroy()
    return { success: true, index }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Draw an image into the page's CONTENT STREAM rather than as an annotation.
 *
 * An annotation is always painted above every bit of page content, whatever
 * order things were created in — the same rule that made the OCR patch cover
 * its own replacement text. So a picture added as a Stamp can only ever sit in
 * FRONT of the text, which is why "behind the text" was not available at all.
 *
 * Content is painted in the order it appears, so where the operators go decides
 * what covers what: prepended, the image is behind everything on the page;
 * appended, it is over everything.
 *
 * The cost of being content rather than an annotation is that it is part of the
 * page afterwards — there is no annotation left to select, drag or resize. The
 * caller says so rather than leaving the user hunting for handles.
 */
/**
 * Move an annotation into the page CONTENT, behind everything already there.
 *
 * This is how a picture already on the page becomes a picture BEHIND the text.
 * It cannot be done by reordering anything: an annotation is painted above all
 * page content whatever order it was made in, so the only way under the text is
 * to stop being an annotation.
 *
 * The annotation's own appearance stream is reused rather than the original
 * image being hunted down and re-embedded. /AP /N is a Form XObject that
 * already draws the thing correctly inside its own BBox, so invoking it with
 * `Do` gives exactly what was on screen — and works for any annotation, not
 * just images.
 *
 * The matrix is the one PDF 32000-1 12.5.5 specifies for appearance streams:
 * transform the BBox by the form's Matrix, then map that box onto the
 * annotation's Rect. Getting this wrong does not fail loudly — it puts the
 * picture somewhere else on the page at the wrong size.
 */
/** The /AP /N form of an annotation, resolved, or null. Handles state dicts. */
function apFormOf(annot: any): any | null {
  try {
    const aobj = annot.getObject()
    const apDict = aobj.get('AP')
    if (!apDict || String(apDict) === 'null') return null
    const isStreamAp = (o: any) => typeof o?.isStream === 'function' && o.isStream()
    let form = apDict.resolve().get('N')
    if (!form || String(form) === 'null') return null
    if (!isStreamAp(form)) {
      const states = form.resolve()
      let chosen: any = null
      try {
        states.forEach((_key: any, value: any) => { if (!chosen && isStreamAp(value)) chosen = value })
      } catch (_) { /* not walkable */ }
      if (!chosen) return null
      form = chosen
    }
    return form.resolve()
  } catch (_) { return null }
}

/** The appearance form's /Matrix, or null when absent/unreadable. */
function readApMatrix(annot: any): Mat6 | null {
  const form = apFormOf(annot)
  if (!form) return null
  const mtx = form.get('Matrix')
  if (!mtx || String(mtx) === 'null') return null
  const arr = mtx.resolve ? mtx.resolve() : mtx
  const v = [0, 1, 2, 3, 4, 5].map(i => Number(String(arr.get(i))))
  return v.every(n => Number.isFinite(n)) ? (v as Mat6) : null
}

function writeApMatrix(annot: any, m: Mat6): void {
  const form = apFormOf(annot)
  if (!form) return
  const out = pdfDoc.newArray()
  for (const n of m) out.push(pdfDoc.newReal(n))
  form.put('Matrix', out)
}

/**
 * Turn a Stamp image a quarter turn clockwise ON SCREEN.
 *
 * No pixels are touched: a 90° rotation is composed into the appearance
 * form's /Matrix and the annotation's /Rect is swapped around its own centre.
 * The viewer maps the Matrix-transformed BBox onto /Rect (PDF 32000 12.5.5),
 * so the rotated content fills the swapped rectangle exactly — lossless, and
 * the same for a JPEG as for a PNG. Four clicks bring it back to the start.
 *
 * annot.update() is deliberately NOT called afterwards: MuPDF regenerating
 * the appearance is exactly what would discard the matrix just written.
 */
function rotateStampImage(
  pageIndex: number,
  annotIndex: number
): { success: boolean; error?: string } {
  if (!pdfDoc) return { success: false, error: 'No document' }
  let page: any = null
  try {
    page = pdfDoc.loadPage(pageIndex)
    const annot = getAnnotsAndWidgets(page)[annotIndex]
    if (!annot) return { success: false, error: `Annotation ${annotIndex} not found` }

    const aobj = annot.getObject()
    const apDict = aobj.get('AP')
    if (!apDict || String(apDict) === 'null') {
      return { success: false, error: 'That annotation has no appearance to rotate' }
    }
    // Same MuPDF quirk as everywhere: isStream() must be asked of the
    // INDIRECT reference, never of the resolved object.
    const isStreamAp = (o: any) => typeof o?.isStream === 'function' && o.isStream()
    let form = apDict.resolve().get('N')
    if (!form || String(form) === 'null') {
      return { success: false, error: 'That annotation has no appearance to rotate' }
    }
    if (!isStreamAp(form)) {
      const states = form.resolve()
      let chosen: any = null
      try {
        states.forEach((_key: any, value: any) => { if (!chosen && isStreamAp(value)) chosen = value })
      } catch (_) { /* not walkable */ }
      if (!chosen) return { success: false, error: 'That annotation has no appearance this can rotate' }
      form = chosen
    }
    const resolvedForm = form.resolve()

    // Compose a clockwise quarter turn into the form's /Matrix.
    let m: Mat6 = [1, 0, 0, 1, 0, 0]
    const mtx = resolvedForm.get('Matrix')
    if (mtx && String(mtx) !== 'null') {
      const arr = mtx.resolve ? mtx.resolve() : mtx
      const v = [0, 1, 2, 3, 4, 5].map(i => Number(String(arr.get(i))))
      if (v.every(n => Number.isFinite(n))) m = v as Mat6
    }
    const turned = matConcat(m, [0, -1, 1, 0, 0, 0])
    const mOut = pdfDoc.newArray()
    for (const n of turned) mOut.push(pdfDoc.newReal(n))
    resolvedForm.put('Matrix', mOut)

    // Swap the rectangle around its centre so the turned image keeps its size
    // on the page instead of being squeezed back into the old proportions.
    const rectArr = aobj.get('Rect')
    if (rectArr && String(rectArr) !== 'null') {
      const r = rectArr.resolve ? rectArr.resolve() : rectArr
      const v = [0, 1, 2, 3].map(i => Number(String(r.get(i))))
      if (v.every(n => Number.isFinite(n))) {
        const x0 = Math.min(v[0], v[2]), x1 = Math.max(v[0], v[2])
        const y0 = Math.min(v[1], v[3]), y1 = Math.max(v[1], v[3])
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
        const halfW = (x1 - x0) / 2, halfH = (y1 - y0) / 2
        const out = pdfDoc.newArray()
        out.push(pdfDoc.newReal(cx - halfH))
        out.push(pdfDoc.newReal(cy - halfW))
        out.push(pdfDoc.newReal(cx + halfH))
        out.push(pdfDoc.newReal(cy + halfW))
        aobj.put('Rect', out)
      }
    }
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  } finally {
    try { page?.destroy() } catch (_) { /* already gone */ }
  }
}

/** Names in a source's XObject dict whose target is an /Image. */
function imageNamesOf(src: ContentSource, pageIndex: number): Set<string> {
  const names = new Set<string>()
  let page: any = null
  try {
    let resources: any = src.resources
    if (!resources) {
      page = pdfDoc.loadPage(pageIndex)
      resources = page.getObject().get('Resources')
    }
    const xo = resources?.resolve?.()?.get?.('XObject') ?? resources?.get?.('XObject')
    if (!xo || String(xo) === 'null') return names
    const dict = xo.resolve ? xo.resolve() : xo
    // mupdf.js calls the callback as (value, key) — reading them the other way
    // round resolves the KEY and silently yields an empty set.
    dict.forEach((value: any, key: any) => {
      try {
        const sub = String(value.resolve().get('Subtype') || '')
        if (sub === '/Image') names.add(String(key).replace(/^\//, ''))
      } catch (_) { /* not resolvable — skip */ }
    })
  } catch (_) { /* no resources — empty set */ }
  finally { try { page?.destroy() } catch (_) {} }
  return names
}

/**
 * Every image the page CONTENT draws — the logos, photos and scans that are
 * part of the page rather than stamped on it — with the rectangle each one
 * occupies in visible page space. Acrobat lets you grab these; before this,
 * only annotation images were reachable and a document's own logo was not.
 */
function listContentImages(pageIndex: number): ContentImageInfo[] {
  const out: ContentImageInfo[] = []
  if (!pdfDoc) return out
  let pageH = 0
  try { pageH = getPageSize(pageIndex).height } catch (_) { return out }

  let id = 0
  for (const src of getContentSources(pageIndex)) {
    const images = imageNamesOf(src, pageIndex)
    if (!images.size) continue
    const masked = maskStreamLiterals(src.stream)
    const re = /\/[ ]*\s+Do(?![A-Za-z0-9])/g
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      const nameMatch = src.stream.slice(m.index).match(/^\/([^\s<>[\]()/%]+)/)
      if (!nameMatch || !images.has(nameMatch[1])) continue
      const ctm = withSource(src, () => getFullCtmAtOffset(src.stream, m!.index))
      // The image fills the unit square through the CTM in force at its Do.
      const xs: number[] = [], ys: number[] = []
      for (const [ux, uy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        xs.push(ux * ctm[0] + uy * ctm[2] + ctm[4])
        ys.push(ux * ctm[1] + uy * ctm[3] + ctm[5])
      }
      const x0 = Math.min(...xs), x1 = Math.max(...xs)
      const y0 = Math.min(...ys), y1 = Math.max(...ys)
      if (!(x1 - x0 > 1 && y1 - y0 > 1)) continue // degenerate
      out.push({
        id: id++, sourceKey: src.key, doOffset: m.index, name: nameMatch[1],
        rect: [x0, pageH - y1, x1, pageH - y0]
      })
    }
  }
  return out
}

/**
 * Move/resize an image the page content draws, to `rect` (page space, y-down).
 *
 * The CTM chain that places the image can be arbitrarily deep, so it is not
 * edited — a correction matrix is INJECTED around the Do instead:
 * `q M cm /Name Do Q` with M = F·T·F⁻¹, where F is the full CTM in force at
 * the Do and T the visible-space map from the old rectangle to the new one.
 * Wrapping in q/Q keeps the correction from leaking into anything after it.
 */
function transformContentImage(
  pageIndex: number,
  sourceKey: string,
  doOffset: number,
  name: string,
  rect: number[]
): { success: boolean; error?: string } {
  if (!pdfDoc) return { success: false, error: 'No document' }
  try {
    const src = getContentSources(pageIndex).find(s => s.key === sourceKey)
    if (!src) return { success: false, error: `Source ${sourceKey} not found` }
    // The offset must still point at this image's Do — the stream may have
    // been rewritten since the caller listed it.
    const at = src.stream.slice(doOffset)
    const nm = at.match(/^\/([^\s<>[\]()/%]+)(\s+)Do(?![A-Za-z0-9])/)
    if (!nm || nm[1] !== name) {
      return { success: false, error: 'The image is no longer where it was listed — reload and try again' }
    }
    const doEnd = doOffset + nm[0].length

    const F = withSource(src, () => getFullCtmAtOffset(src.stream, doOffset))
    const Finv = matInvert(F)
    if (!Finv) return { success: false, error: 'The image is drawn under a degenerate matrix' }

    const pageH = getPageSize(pageIndex).height
    const xs: number[] = [], ys: number[] = []
    for (const [ux, uy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      xs.push(ux * F[0] + uy * F[2] + F[4])
      ys.push(ux * F[1] + uy * F[3] + F[5])
    }
    const ox0 = Math.min(...xs), ox1 = Math.max(...xs)
    const oy0 = Math.min(...ys), oy1 = Math.max(...ys)
    if (!(ox1 - ox0 > 0.01 && oy1 - oy0 > 0.01)) {
      return { success: false, error: 'The image is drawn degenerate' }
    }

    // Target in bottom-up user space.
    const nx0 = rect[0], nx1 = rect[2]
    const ny0 = pageH - rect[3], ny1 = pageH - rect[1]
    const sx = (nx1 - nx0) / (ox1 - ox0)
    const sy = (ny1 - ny0) / (oy1 - oy0)
    const T: Mat6 = [sx, 0, 0, sy, nx0 - ox0 * sx, ny0 - oy0 * sy]
    const M = matConcat(matConcat(F, T), Finv)

    const inject = `q ${M.map(fmtNum).join(' ')} cm /${name} Do Q`
    const splices: { start: number; end: number; text: string }[] = [
      { start: doOffset, end: doEnd, text: inject }
    ]

    // Carry the clip window along, exactly as moving TEXT does.
    //
    // A picture in a Word table cell is bounded by that cell's `re W* n`, and
    // the band is barely bigger than the picture. Dragging it a couple of
    // centimetres therefore pushes it outside its own window and the part that
    // left is not merely misplaced, it is invisible — measured on the reported
    // document, a photo moved 120pt right came back with two thirds of it cut
    // off and nothing on screen to say why.
    //
    // Anchored at the user-space origin, since T maps p -> p·[sx,sy] + (e,f)
    // about that origin. The union can only ever REVEAL more of the group the
    // clip bounds, which is the safe direction: hiding content is the failure
    // being fixed.
    for (const clip of withSource(src, () => getActiveClipsAtOffset(src.stream, doOffset))) {
      const grown = withSource(src, () =>
        expandClipForTransform(src.stream, clip, T[4], T[5], T[0], T[3], 0, 0))
      if (grown) splices.push({ start: clip.index, end: clip.index + clip.length, text: grown })
    }

    // Highest offset first: a clip sits BELOW the Do it bounds, so splicing
    // forwards would apply every later edit at an offset the earlier one moved.
    let newStream = src.stream
    for (const sp of splices.sort((a, b) => b.start - a.start)) {
      newStream = newStream.slice(0, sp.start) + sp.text + newStream.slice(sp.end)
    }
    const bytes = new Uint8Array(newStream.length)
    for (let i = 0; i < newStream.length; i++) bytes[i] = newStream.charCodeAt(i) & 0xFF
    src.write(bytes)
    invalidateContentSources(pageIndex)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Remove an image the page content draws.
 *
 * Only the `/Name Do` invocation goes; the XObject itself is left in
 * /Resources. Unpicking the resource dictionary would be wrong whenever the
 * same image is drawn more than once — this document draws one table border
 * three times on a page — and an unreferenced XObject costs bytes, not
 * correctness. The graphics state around the Do is untouched for the same
 * reason: the q/Q and cm that placed it may well be positioning what comes
 * after it too.
 *
 * The invocation is BLANKED, not cut out: every other image on the page was
 * listed against offsets into this same stream, and shortening it would move
 * all of them. Deleting a multi-image selection would then address the wrong
 * `Do` from the second one on.
 */
function deleteContentImage(
  pageIndex: number,
  sourceKey: string,
  doOffset: number,
  name: string
): { success: boolean; error?: string } {
  if (!pdfDoc) return { success: false, error: 'No document' }
  try {
    const src = getContentSources(pageIndex).find(s => s.key === sourceKey)
    if (!src) return { success: false, error: `Source ${sourceKey} not found` }
    const nm = src.stream.slice(doOffset).match(/^\/([^\s<>[\]()/%]+)(\s+)Do(?![A-Za-z0-9])/)
    if (!nm || nm[1] !== name) {
      return { success: false, error: 'The image is no longer where it was listed — reload and try again' }
    }
    const newStream = src.stream.slice(0, doOffset) + ' '.repeat(nm[0].length) + src.stream.slice(doOffset + nm[0].length)
    const bytes = new Uint8Array(newStream.length)
    for (let i = 0; i < newStream.length; i++) bytes[i] = newStream.charCodeAt(i) & 0xFF
    src.write(bytes)
    invalidateContentSources(pageIndex)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Reparent an annotation onto ANOTHER page — dragging an image past the foot
 * of the sheet in continuous scroll drops it on the page below.
 *
 * The annotation's indirect reference is moved from the source page's /Annots
 * into the target's, so the object itself — appearance stream, stamp image,
 * rotation matrix — travels untouched. Only /Rect is rewritten, in the TARGET
 * page's coordinates, through MuPDF's setRect so page rotation is honoured.
 * The stale /P back-pointer is dropped rather than rewritten (it is optional,
 * and naming the OLD page would be worse than naming none).
 */
function moveAnnotationToPage(
  pageIndex: number,
  annotIndex: number,
  targetPage: number,
  rect: number[]
): { success: boolean; index?: number; error?: string } {
  if (!pdfDoc) return { success: false, error: 'No document' }
  if (targetPage === pageIndex) return { success: false, error: 'Same page' }
  let src: any = null
  let dst: any = null
  try {
    src = pdfDoc.loadPage(pageIndex)
    const annot = getAnnotsAndWidgets(src)[annotIndex]
    if (!annot) return { success: false, error: `Annotation ${annotIndex} not found` }
    const wasWidget = safe(() => String(annot.getObject().get('Subtype')) === '/Widget', false)

    // The appearance matrix carries the image's rotation; keep it across the trip.
    const savedMatrix = readApMatrix(annot)

    const srcObj = src.getObject()
    let srcAnnots = srcObj.get('Annots')
    if (!srcAnnots || String(srcAnnots) === 'null') return { success: false, error: 'Page has no annotations' }
    srcAnnots = srcAnnots.resolve ? srcAnnots.resolve() : srcAnnots

    // The entry has to be FOUND in /Annots, not indexed into it: the combined
    // list here appends widgets after the plain annotations, while /Annots
    // interleaves them in whatever order the producer wrote — so a widget's
    // list index is not its /Annots index on any page holding both kinds.
    // /Rect plus /Subtype is as good an identity as is reachable from both
    // sides; a page with two annotations of the same kind on the same rect
    // moves whichever comes first, which draw identically anyway.
    const annotRect = String(annot.getObject().get('Rect') ?? '')
    const annotSubtype = String(annot.getObject().get('Subtype') ?? '')
    let refIdx = -1
    const srcLen = srcAnnots.length ?? 0
    for (let i = 0; i < srcLen; i++) {
      const cand = srcAnnots.get(i)
      const r = cand?.resolve?.()
      if (String(r?.get?.('Rect') ?? '') === annotRect && String(r?.get?.('Subtype') ?? '') === annotSubtype) {
        refIdx = i
        break
      }
    }
    if (refIdx < 0) {
      return { success: false, error: 'Annotation list and /Annots disagree — refusing to move' }
    }
    const ref = srcAnnots.get(refIdx)

    dst = pdfDoc.loadPage(targetPage)
    const dstObj = dst.getObject()
    let dstAnnots = dstObj.get('Annots')
    if (!dstAnnots || String(dstAnnots) === 'null') {
      dstAnnots = pdfDoc.newArray()
      dstObj.put('Annots', dstAnnots)
    } else {
      dstAnnots = dstAnnots.resolve ? dstAnnots.resolve() : dstAnnots
    }
    dstAnnots.push(ref)
    srcAnnots.delete(refIdx)
    try {
      const r = ref.resolve()
      if (r.get('P') && String(r.get('P')) !== 'null') r.delete('P')
    } catch (_) { /* no /P — fine */ }

    // A fresh page handle sees the annotation it now owns; the old handles are
    // stale. setRect converts through the target page's own rotation.
    //
    // The arrival is the NEWEST entry of its own kind — getAnnotations() and
    // getWidgets() each follow /Annots order, and the ref was pushed at the
    // end, so a moved widget is the last widget and a moved annotation the
    // last annotation. The combined index reported back counts annotations
    // first, the same order listAnnotations hands the UI.
    try { dst.destroy() } catch (_) {}
    dst = pdfDoc.loadPage(targetPage)
    const dstPlain = dst.getAnnotations()
    const dstAll = getAnnotsAndWidgets(dst)
    const moved = wasWidget ? dstAll[dstAll.length - 1] : dstPlain[dstPlain.length - 1]
    const newIdx = wasWidget ? dstAll.length - 1 : dstPlain.length - 1
    if (moved) {
      try { moved.setRect(rect as any) } catch (_) { /* keep the old rect */ }
      if (savedMatrix && savedMatrix.some((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) > 1e-9)) {
        writeApMatrix(moved, savedMatrix)
      }
    }
    return { success: true, index: newIdx }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  } finally {
    try { src?.destroy() } catch (_) {}
    try { dst?.destroy() } catch (_) {}
  }
}

function flattenAnnotationBehind(
  pageIndex: number,
  annotIndex: number
): { success: boolean; error?: string } {
  if (!pdfDoc) return { success: false, error: 'No document' }
  let page: any = null
  try {
    page = pdfDoc.loadPage(pageIndex)
    const annots = getAnnotsAndWidgets(page)
    const annot = annots[annotIndex]
    if (!annot) { page.destroy(); return { success: false, error: `Annotation ${annotIndex} not found` } }

    // Make sure the appearance is up to date before it is borrowed. Not for a
    // widget: regenerating a form field's appearance would replace the signing
    // service's scribble with MuPDF's own idea of the field, and the stream as
    // stored IS what is on screen.
    const flattenIsWidget = safe(() => String(annot.getObject().get('Subtype')) === '/Widget', false)
    if (!flattenIsWidget) { try { annot.update() } catch (_) {} }

    const aobj = annot.getObject()
    const apDict = aobj.get('AP')
    if (!apDict || String(apDict) === 'null') {
      page.destroy()
      return { success: false, error: 'That annotation has no appearance to move' }
    }
    let form = apDict.resolve().get('N')
    if (!form || String(form) === 'null') {
      page.destroy()
      return { success: false, error: 'That annotation has no appearance to move' }
    }
    // `isStream()` has to be asked of the INDIRECT reference. MuPDF answers
    // false once the object is resolved — the same quirk that makes a ToUnicode
    // stream unreadable if you resolve it first — so checking the resolved form
    // reported every appearance as "not a stream" and nothing could be moved.
    const isStreamAp = (o: any) => typeof o?.isStream === 'function' && o.isStream()
    if (!isStreamAp(form)) {
      // /N may be a dictionary of appearance STATES rather than one stream.
      // /AS names the one in force; failing that, the first stream in it will
      // do, since an annotation with states normally has only one that draws.
      const states = form.resolve()
      const as = aobj.get('AS')
      let chosen: any = null
      if (as && String(as) !== 'null') {
        const key = String(as).replace(/^\//, '')
        const candidate = states.get(key)
        if (isStreamAp(candidate)) chosen = candidate
      }
      if (!chosen) {
        try {
          states.forEach((_key: any, value: any) => {
            if (!chosen && isStreamAp(value)) chosen = value
          })
        } catch (_) { /* not a dictionary we can walk */ }
      }
      if (!chosen) {
        page.destroy()
        return { success: false, error: 'That annotation has no appearance this can move' }
      }
      form = chosen
    }
    const formRef = form
    const resolvedForm = form.resolve()

    const num = (v: any, fallback: number) => {
      const n = Number(String(v))
      return Number.isFinite(n) ? n : fallback
    }
    // The annotation's OWN /Rect, not `annot.getRect()`. MuPDF answers that one
    // in its page space, which counts down from the top, while the `cm` written
    // below lives in PDF user space, which counts up from the bottom. Using it
    // raw flipped the picture to `pageHeight - top` — on a US Letter page an
    // image sitting under the first line of text landed at the foot of it.
    // /Rect is already in the space `Do` is invoked in, so no page height and
    // no /Rotate guesswork is needed. It is only stored normalised by
    // convention, so the corners are sorted here.
    const rectArr = aobj.get('Rect')
    if (!rectArr || String(rectArr) === 'null') {
      page.destroy()
      return { success: false, error: 'That annotation has no rectangle' }
    }
    const r = [0, 1, 2, 3].map(i => num(rectArr.get(i), 0))
    const rect = [
      Math.min(r[0], r[2]), Math.min(r[1], r[3]),
      Math.max(r[0], r[2]), Math.max(r[1], r[3])
    ]
    const bboxArr = resolvedForm.get('BBox')
    if (!bboxArr || String(bboxArr) === 'null') {
      page.destroy()
      return { success: false, error: 'That annotation has no bounding box' }
    }
    const bb = [0, 1, 2, 3].map(i => num(bboxArr.get(i), 0))
    const mtxArr = resolvedForm.get('Matrix')
    const mtx = mtxArr && String(mtxArr) !== 'null'
      ? [0, 1, 2, 3, 4, 5].map(i => num(mtxArr.get(i), i === 0 || i === 3 ? 1 : 0))
      : [1, 0, 0, 1, 0, 0]

    // The BBox's four corners through the form's own Matrix, then their bounds.
    const xs: number[] = []
    const ys: number[] = []
    for (const [cx, cy] of [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]]) {
      xs.push(mtx[0] * cx + mtx[2] * cy + mtx[4])
      ys.push(mtx[1] * cx + mtx[3] * cy + mtx[5])
    }
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs)
    const by0 = Math.min(...ys), by1 = Math.max(...ys)
    const sx = (bx1 - bx0) > 1e-6 ? (rect[2] - rect[0]) / (bx1 - bx0) : 1
    const sy = (by1 - by0) > 1e-6 ? (rect[3] - rect[1]) / (by1 - by0) : 1
    const tx = rect[0] - bx0 * sx
    const ty = rect[1] - by0 * sy

    const pageObj = page.getObject()
    let resources = pageObj.get('Resources')
    if (!resources || String(resources) === 'null') {
      resources = pdfDoc.newDictionary()
      pageObj.put('Resources', resources)
    }
    resources = resources.resolve()
    let xobjects = resources.get('XObject')
    if (!xobjects || String(xobjects) === 'null') {
      xobjects = pdfDoc.newDictionary()
      resources.put('XObject', xobjects)
    }
    xobjects = xobjects.resolve()

    let name = ''
    for (let i = 0; i < 500; i++) {
      const candidate = `ImEd${i}`
      const existing = xobjects.get(candidate)
      if (!existing || String(existing) === 'null') { name = candidate; break }
    }
    if (!name) { page.destroy(); return { success: false, error: 'No free image slot on this page' } }
    xobjects.put(name, formRef)

    const op = `\nq ${fmtNum(sx)} 0 0 ${fmtNum(sy)} ${fmtNum(tx)} ${fmtNum(ty)} cm /${name} Do Q\n`
    const existing = readContentStream(pageIndex)
    const combined = op + existing
    const bytes = new Uint8Array(combined.length)
    for (let i = 0; i < combined.length; i++) bytes[i] = combined.charCodeAt(i) & 0xFF

    const contents = pageObj.get('Contents')
    const isStream = !!contents && String(contents) !== 'null' &&
      typeof contents.isStream === 'function' && contents.isStream()
    if (isStream) contents.writeStream(bytes)
    else pageObj.put('Contents', pdfDoc.addStream(bytes, {}))

    page.deleteAnnotation(annot)
    invalidateContentSources(pageIndex)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  } finally {
    try { page?.destroy() } catch (_) {}
  }
}

function drawImageInContent(
  pageIndex: number,
  rect: number[],
  imageBytes: Uint8Array,
  behind: boolean
): { success: boolean; name?: string; error?: string } {
  if (!pdfDoc || !mupdf) return { success: false, error: 'No document' }
  let page: any = null
  let image: any = null
  try {
    page = pdfDoc.loadPage(pageIndex)
    const pageObj = page.getObject()
    const bounds = page.getBounds()
    const pageHeight = bounds[3] - bounds[1]

    image = new mupdf.Image(imageBytes)
    const imgRef = pdfDoc.addImage(image)

    let resources = pageObj.get('Resources')
    if (!resources || String(resources) === 'null') {
      resources = pdfDoc.newDictionary()
      pageObj.put('Resources', resources)
    }
    resources = resources.resolve()
    let xobjects = resources.get('XObject')
    if (!xobjects || String(xobjects) === 'null') {
      xobjects = pdfDoc.newDictionary()
      resources.put('XObject', xobjects)
    }
    xobjects = xobjects.resolve()

    // A name nothing else on the page is using. Reusing one would silently
    // replace whatever it pointed at — a logo, a scan, the whole background.
    let name = ''
    for (let i = 0; i < 500; i++) {
      const candidate = `ImEd${i}`
      const existing = xobjects.get(candidate)
      if (!existing || String(existing) === 'null') { name = candidate; break }
    }
    if (!name) { page.destroy(); return { success: false, error: 'No free image slot on this page' } }
    xobjects.put(name, imgRef)

    const x = Math.min(rect[0], rect[2])
    const w = Math.abs(rect[2] - rect[0])
    const top = Math.min(rect[1], rect[3])
    const h = Math.abs(rect[3] - rect[1])
    // The UI works top-left down; PDF user space is bottom-left up.
    const y = pageHeight - top - h
    const op = `\nq ${fmtNum(w)} 0 0 ${fmtNum(h)} ${fmtNum(x)} ${fmtNum(y)} cm /${name} Do Q\n`

    const existing = readContentStream(pageIndex)
    // Prepended, everything already on the page paints over it; appended, it
    // paints over everything.
    const combined = behind ? op + existing : existing + op
    const bytes = new Uint8Array(combined.length)
    for (let i = 0; i < combined.length; i++) bytes[i] = combined.charCodeAt(i) & 0xFF

    const contents = pageObj.get('Contents')
    const isStream = !!contents && String(contents) !== 'null' &&
      typeof contents.isStream === 'function' && contents.isStream()
    if (isStream) contents.writeStream(bytes)
    else pageObj.put('Contents', pdfDoc.addStream(bytes, {}))

    invalidateContentSources(pageIndex)
    return { success: true, name }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  } finally {
    try { image?.destroy() } catch (_) {}
    try { page?.destroy() } catch (_) {}
  }
}

/* ───────────────────────── Object operations on page images ─────────────────
 *
 * Acrobat's "OBJETOS" panel — flip, rotate, crop, align, arrange, replace —
 * for the pictures the CONTENT STREAM draws (not annotations).
 *
 * Every one of them works the way `transformContentImage` established: the CTM
 * chain that places an image can be arbitrarily deep and is shared with
 * whatever else that `q` bracket covers, so it is never edited. A correction is
 * INJECTED around the `Do` instead — `q M cm /Name Do Q` with M = F·T·F⁻¹,
 * where F is the full CTM in force at the Do and T is the change expressed in
 * plain user space. Wrapping in q/Q keeps the correction from leaking onto
 * anything drawn afterwards, and because each call re-reads F, the operations
 * compose: rotating twice really is 180°.
 */

interface ImageSite {
  src: ContentSource
  /** Full CTM in force at the Do, and its inverse. */
  F: Mat6
  Finv: Mat6
  /** End offset of the `/Name Do` token. */
  doEnd: number
  /** Axis-aligned footprint in bottom-up USER space. */
  x0: number; x1: number; y0: number; y1: number
}

/**
 * Resolve an image listed by `listContentImages` back to its place in the
 * stream, re-checking that the `Do` is still there.
 *
 * The offset is re-validated on every call because the stream may have been
 * rewritten since the caller listed it — by another op, or by the same one.
 * Applying a matrix at a stale offset does not fail loudly, it transforms
 * whatever moved into that position.
 */
function locateContentImage(
  pageIndex: number,
  sourceKey: string,
  doOffset: number,
  name: string
): ImageSite | { error: string } {
  const src = getContentSources(pageIndex).find(s => s.key === sourceKey)
  if (!src) return { error: `Source ${sourceKey} not found` }
  const nm = src.stream.slice(doOffset).match(/^\/([^\s<>[\]()/%]+)(\s+)Do(?![A-Za-z0-9])/)
  if (!nm || nm[1] !== name) {
    return { error: 'The image is no longer where it was listed — reload and try again' }
  }
  const F = withSource(src, () => getFullCtmAtOffset(src.stream, doOffset))
  const Finv = matInvert(F)
  if (!Finv) return { error: 'The image is drawn under a degenerate matrix' }

  const xs: number[] = [], ys: number[] = []
  for (const [ux, uy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    xs.push(ux * F[0] + uy * F[2] + F[4])
    ys.push(ux * F[1] + uy * F[3] + F[5])
  }
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const y0 = Math.min(...ys), y1 = Math.max(...ys)
  if (!(x1 - x0 > 0.01 && y1 - y0 > 0.01)) return { error: 'The image is drawn degenerate' }
  return { src, F, Finv, doEnd: doOffset + nm[0].length, x0, x1, y0, y1 }
}

/** Apply splices to a content source, highest offset first, and invalidate. */
function writeContentSource(
  src: ContentSource,
  splices: { start: number; end: number; text: string }[],
  pageIndex: number
): void {
  let out = src.stream
  for (const sp of [...splices].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, sp.start) + sp.text + out.slice(sp.end)
  }
  const bytes = new Uint8Array(out.length)
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xFF
  src.write(bytes)
  invalidateContentSources(pageIndex)
}

/**
 * Flip or rotate an image in place, about the centre of its own footprint.
 *
 * A flip keeps the axis-aligned footprint exactly, so no clip can start cutting
 * the picture and none is touched. A quarter turn SWAPS width and height, and a
 * picture in a Word table cell is bounded by that cell's `re W* n` — turning a
 * wide photo upright inside a wide band would push the ends of it outside the
 * clip, where it is not merely misplaced but invisible. The clips in force are
 * therefore grown, and only ever grown (`Math.max(1, …)`, and the helper takes
 * the union with the original): revealing more of the group a clip bounds is
 * safe, hiding part of it is the failure being avoided.
 */
function orientContentImage(
  pageIndex: number,
  sourceKey: string,
  doOffset: number,
  name: string,
  op: ImageOrient
): { success: boolean; error?: string } {
  if (!pdfDoc) return { success: false, error: 'No document' }
  try {
    const site = locateContentImage(pageIndex, sourceKey, doOffset, name)
    if ('error' in site) return { success: false, error: site.error }
    const { src, F, Finv, doEnd, x0, x1, y0, y1 } = site

    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
    // User space is y-UP and is rendered y-up, so a turn that reads clockwise
    // on screen is clockwise here — no handedness flip to undo.
    const R: Mat6 =
      op === 'flip-h' ? [-1, 0, 0, 1, 0, 0]
      : op === 'flip-v' ? [1, 0, 0, -1, 0, 0]
      : op === 'rotate-cw' ? [0, -1, 1, 0, 0, 0]
      : [0, 1, -1, 0, 0, 0]
    const T = matConcat(matConcat([1, 0, 0, 1, -cx, -cy], R), [1, 0, 0, 1, cx, cy])
    const M = matConcat(matConcat(F, T), Finv)

    const splices = [{
      start: doOffset, end: doEnd,
      text: `q ${M.map(fmtNum).join(' ')} cm /${name} Do Q`
    }]

    if (op === 'rotate-cw' || op === 'rotate-ccw') {
      const w = x1 - x0, h = y1 - y0
      const sx = Math.max(1, h / w), sy = Math.max(1, w / h)
      for (const clip of withSource(src, () => getActiveClipsAtOffset(src.stream, doOffset))) {
        const grown = withSource(src, () =>
          expandClipForTransform(src.stream, clip, 0, 0, sx, sy, cx, cy))
        if (grown) splices.push({ start: clip.index, end: clip.index + clip.length, text: grown })
      }
    }

    writeContentSource(src, splices, pageIndex)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Crop an image to `rect` (page space, y-down) — the part to KEEP.
 *
 * The picture is CLIPPED, not resampled: the image data is left exactly as it
 * was, so nothing is lost, the crop can be undone with Ctrl+Z, and a second
 * crop simply intersects with the first (which is what clips do, and what
 * cropping twice should mean).
 *
 * The clip rectangle has to be written in the space the `re` will be read in,
 * and at the Do that is F — an arbitrary chain, possibly rotated. Rather than
 * push the rectangle through F⁻¹ and hope it stays axis-aligned, the injection
 * switches to user space (`Finv cm` makes the CTM the identity), states the
 * rectangle there, and switches back (`F cm`) for the Do itself.
 */
function cropContentImage(
  pageIndex: number,
  sourceKey: string,
  doOffset: number,
  name: string,
  rect: number[]
): { success: boolean; error?: string } {
  if (!pdfDoc) return { success: false, error: 'No document' }
  try {
    const site = locateContentImage(pageIndex, sourceKey, doOffset, name)
    if ('error' in site) return { success: false, error: site.error }
    const { src, F, Finv, doEnd } = site

    const pageH = getPageSize(pageIndex).height
    const ux0 = Math.min(rect[0], rect[2]), ux1 = Math.max(rect[0], rect[2])
    const uy0 = pageH - Math.max(rect[1], rect[3])
    const uy1 = pageH - Math.min(rect[1], rect[3])
    if (!(ux1 - ux0 > 0.5 && uy1 - uy0 > 0.5)) {
      return { success: false, error: 'The crop area is empty' }
    }

    const inject =
      `q ${Finv.map(fmtNum).join(' ')} cm ` +
      `${fmtNum(ux0)} ${fmtNum(uy0)} ${fmtNum(ux1 - ux0)} ${fmtNum(uy1 - uy0)} re W n ` +
      `${F.map(fmtNum).join(' ')} cm /${name} Do Q`

    writeContentSource(src, [{ start: doOffset, end: doEnd, text: inject }], pageIndex)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Align an image to the page, keeping its size.
 *
 * A pure translation, so it goes through the same F·T·F⁻¹ injection and grows
 * whatever clips it is under exactly as a drag does — an image aligned to the
 * left margin out of a table cell would otherwise vanish into the cell's clip.
 */
function alignContentImage(
  pageIndex: number,
  sourceKey: string,
  doOffset: number,
  name: string,
  mode: ImageAlign,
  margin = 0
): { success: boolean; error?: string } {
  if (!pdfDoc) return { success: false, error: 'No document' }
  try {
    const site = locateContentImage(pageIndex, sourceKey, doOffset, name)
    if ('error' in site) return { success: false, error: site.error }
    const { src, F, Finv, doEnd, x0, x1, y0, y1 } = site

    const size = getPageSize(pageIndex)
    const w = x1 - x0, h = y1 - y0
    let nx0 = x0, ny0 = y0
    switch (mode) {
      case 'left':   nx0 = margin; break
      case 'right':  nx0 = size.width - margin - w; break
      case 'center': nx0 = (size.width - w) / 2; break
      // User space counts UP, so the top of the page is the HIGH y.
      case 'top':    ny0 = size.height - margin - h; break
      case 'bottom': ny0 = margin; break
      case 'middle': ny0 = (size.height - h) / 2; break
    }
    const dx = nx0 - x0, dy = ny0 - y0
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return { success: true }

    const T: Mat6 = [1, 0, 0, 1, dx, dy]
    const M = matConcat(matConcat(F, T), Finv)
    const splices = [{
      start: doOffset, end: doEnd,
      text: `q ${M.map(fmtNum).join(' ')} cm /${name} Do Q`
    }]
    for (const clip of withSource(src, () => getActiveClipsAtOffset(src.stream, doOffset))) {
      const grown = withSource(src, () =>
        expandClipForTransform(src.stream, clip, dx, dy, 1, 1, 0, 0))
      if (grown) splices.push({ start: clip.index, end: clip.index + clip.length, text: grown })
    }
    writeContentSource(src, splices, pageIndex)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Bring an image to the front of the page, or send it behind everything.
 *
 * Paint order in a content stream IS document order, so this is a move: the
 * original invocation is blanked where it stands and a fresh one, carrying the
 * image's absolute placement, is written at the top or the bottom of the page
 * stream. The old one is BLANKED rather than cut so that the offsets of every
 * other image the caller listed stay where they were.
 *
 * Only for images the PAGE draws. An XObject's `/Name` resolves against that
 * form's own resources, so hoisting one into the page stream would name a
 * picture the page has never heard of and draw nothing at all.
 *
 * The absolute placement assumes the CTM is the identity at the ends of the
 * page stream, which holds for balanced q/Q — the same assumption
 * `drawImageInContent` already makes when it appends or prepends a picture.
 */
function reorderContentImage(
  pageIndex: number,
  sourceKey: string,
  doOffset: number,
  name: string,
  where: 'front' | 'back'
): { success: boolean; error?: string } {
  if (!pdfDoc) return { success: false, error: 'No document' }
  try {
    if (sourceKey !== 'page') {
      return { success: false, error: 'Only an image the page itself draws can be reordered' }
    }
    const site = locateContentImage(pageIndex, sourceKey, doOffset, name)
    if ('error' in site) return { success: false, error: site.error }
    const { src, F, doEnd } = site

    const draw = `\nq ${F.map(fmtNum).join(' ')} cm /${name} Do Q\n`
    const blanked = src.stream.slice(0, doOffset) +
                    ' '.repeat(doEnd - doOffset) +
                    src.stream.slice(doEnd)
    const out = where === 'back' ? draw + blanked : blanked + draw

    const bytes = new Uint8Array(out.length)
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xFF
    src.write(bytes)
    invalidateContentSources(pageIndex)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Swap the picture an invocation draws for a different image file, leaving the
 * placement — position, size, any flip or rotation already applied — alone.
 *
 * A NEW XObject under a name nothing is using, never an overwrite of the old
 * one: the same image is very often drawn more than once (a logo in a header,
 * a rule repeated down a table), and replacing the resource in place would
 * change every one of those at once. Only this invocation is repointed.
 */
function replaceContentImage(
  pageIndex: number,
  sourceKey: string,
  doOffset: number,
  name: string,
  imageBytes: Uint8Array
): { success: boolean; name?: string; error?: string } {
  if (!pdfDoc || !mupdf) return { success: false, error: 'No document' }
  let page: any = null
  let image: any = null
  try {
    const site = locateContentImage(pageIndex, sourceKey, doOffset, name)
    if ('error' in site) return { success: false, error: site.error }
    const { src, doEnd } = site

    page = pdfDoc.loadPage(pageIndex)
    let resources: any = src.resources
    if (!resources) resources = page.getObject().get('Resources')
    resources = resources?.resolve ? resources.resolve() : resources
    if (!resources || String(resources) === 'null') {
      return { success: false, error: 'That image lives in a source with no resources' }
    }
    let xobjects = resources.get('XObject')
    if (!xobjects || String(xobjects) === 'null') {
      return { success: false, error: 'That source draws no images' }
    }
    xobjects = xobjects.resolve()

    image = new mupdf.Image(imageBytes)
    const imgRef = pdfDoc.addImage(image)

    let fresh = ''
    for (let i = 0; i < 500; i++) {
      const candidate = `ImRp${i}`
      const existing = xobjects.get(candidate)
      if (!existing || String(existing) === 'null') { fresh = candidate; break }
    }
    if (!fresh) return { success: false, error: 'No free image slot on this page' }
    xobjects.put(fresh, imgRef)

    writeContentSource(src, [{ start: doOffset, end: doEnd, text: `/${fresh} Do` }], pageIndex)
    return { success: true, name: fresh }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  } finally {
    try { image?.destroy() } catch (_) {}
    try { page?.destroy() } catch (_) {}
  }
}

function addImageStamp(
  pageIndex: number,
  rect: number[],
  imageBytes: Uint8Array
): { success: boolean; index?: number; error?: string } {
  if (!mupdf) return { success: false, error: 'No engine' }
  let page: any = null
  let image: any = null
  try {
    page = pdfDoc.loadPage(pageIndex)
    image = new mupdf.Image(imageBytes)
    const annot = page.createAnnotation('Stamp')
    annot.setRect(rect as any)
    annot.setStampImage(image)
    annot.update()
    const index = page.getAnnotations().length - 1
    return { success: true, index }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  } finally {
    // mupdf.Image and PDFPage are WASM-heap objects; free deterministically.
    try { image?.destroy() } catch (_) {}
    try { page?.destroy() } catch (_) {}
  }
}

function deleteAnnotationAt(pageIndex: number, annotIndex: number): { success: boolean; error?: string } {
  try {
    const page = pdfDoc.loadPage(pageIndex)
    const annots = getAnnotsAndWidgets(page)
    if (annotIndex < 0 || annotIndex >= annots.length) {
      page.destroy()
      return { success: false, error: `Annotation ${annotIndex} not found` }
    }
    page.deleteAnnotation(annots[annotIndex])
    page.destroy()
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

function updateAnnotationAt(d: {
  pageIndex: number; annotIndex: number
  rect?: number[]; color?: [number, number, number]; interiorColor?: [number, number, number] | null
  opacity?: number; width?: number; contents?: string
}): { success: boolean; error?: string } {
  try {
    const page = pdfDoc.loadPage(d.pageIndex)
    const annots = getAnnotsAndWidgets(page)
    const annot = annots[d.annotIndex]
    if (!annot) { page.destroy(); return { success: false, error: 'Annotation not found' } }
    if (d.rect) { try { annot.setRect(d.rect as any) } catch (_) {} }
    if (d.color) { try { annot.setColor(d.color as any) } catch (_) {} }
    if (d.interiorColor !== undefined) { try { annot.setInteriorColor((d.interiorColor || []) as any) } catch (_) {} }
    if (d.opacity !== undefined) { try { annot.setOpacity(d.opacity) } catch (_) {} }
    if (d.width !== undefined) { try { annot.setBorderWidth(d.width) } catch (_) {} }
    if (d.contents !== undefined) { try { annot.setContents(d.contents) } catch (_) {} }
    // update() regenerates the appearance with the IDENTITY matrix, and for a
    // rotated Stamp the matrix IS the rotation — moving or resizing the image
    // snapped it back upright. Capture it, let update() do its work, put it
    // back. Restoring an identity is a no-op, so unrotated annotations lose
    // nothing.
    //
    // A WIDGET is never updated: its appearance is not MuPDF's to regenerate —
    // for a signed /Sig field it is the signing service's own scribble, and a
    // resynthesised one would replace it with whatever MuPDF draws for a form
    // field. The viewer maps the appearance BBox onto /Rect (PDF 32000
    // 12.5.5), so setRect alone is a complete move or resize.
    const isWidget = safe(() => String(annot.getObject().get('Subtype')) === '/Widget', false)
    if (!isWidget) {
      const savedMatrix = readApMatrix(annot)
      annot.update()
      if (savedMatrix && savedMatrix.some((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) > 1e-9)) {
        writeApMatrix(annot, savedMatrix)
      }
    }
    page.destroy()
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

// ==========================================
// PAGE MANAGEMENT
// ==========================================

function rotatePage(pageIndex: number, degrees: number): {
  success: boolean; rotation?: number; error?: string } {
  invalidateContentSources() // page indices shift
  try {
    const page = pdfDoc.loadPage(pageIndex)
    const pageObj = page.getObject()
    let cur = 0
    const r = pageObj.get('Rotate')
    if (r && r.toString() !== 'null') cur = (r.asNumber?.() ?? parseInt(r.toString(), 10)) || 0
    const next = ((cur + degrees) % 360 + 360) % 360
    pageObj.put('Rotate', pdfDoc.newInteger(next))
    page.destroy()
    return { success: true, rotation: next }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Splice every page of ANOTHER PDF into this one at `atIndex`.
 *
 * `graftPage` copies the page together with the objects it depends on — fonts,
 * images, colour spaces — into this document's object graph. Appending the raw
 * bytes, or copying the page dictionary alone, produces a page whose resources
 * point at objects that do not exist here: a blank sheet, or a viewer error.
 *
 * Each grafted page keeps its own size, so merging an A4 form into a Letter
 * document leaves both correct rather than cropping one to the other.
 */
function mergePages(bytes: ArrayBuffer, atIndex: number): {
  success: boolean; pageCount?: number; added?: number; error?: string } {
  if (!pdfDoc || !mupdf) return { success: false, error: 'No document' }
  let src: any = null
  try {
    src = new mupdf.PDFDocument(new Uint8Array(bytes))
    const n = src.countPages()
    if (n === 0) return { success: false, error: 'That file has no pages' }

    invalidateContentSources() // page indices shift
    const at = Math.max(0, Math.min(atIndex, pdfDoc.countPages()))
    for (let i = 0; i < n; i++) pdfDoc.graftPage(at + i, src, i)

    return { success: true, pageCount: pdfDoc.countPages(), added: n }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  } finally {
    try { src?.destroy() } catch (_) { /* already gone */ }
  }
}

/**
 * Paint a filled rectangle into the page's CONTENT STREAM.
 *
 * Not an annotation. Annotations are drawn on top of page content whatever
 * order they were created in, so a patch made with `addShape` covered the very
 * text it was supposed to sit behind — the replacement came out with its first
 * half missing. Content is drawn in the order it appears, so a rectangle
 * appended before the text is behind it, which is the whole point of a patch.
 *
 * `rect` is in PDF page space (top-left origin, y down), like everything else
 * the UI works in; the flip to PDF's bottom-left origin happens here.
 */
function fillRect(
  pageIndex: number,
  rect: [number, number, number, number],
  color: [number, number, number]
): { success: boolean; error?: string } {
  if (!pdfDoc) return { success: false, error: 'No document' }
  try {
    const page = pdfDoc.loadPage(pageIndex)
    const pageObj = page.getObject()
    const bounds = page.getBounds()
    const pageHeight = bounds[3] - bounds[1]

    const x = Math.min(rect[0], rect[2])
    const w = Math.abs(rect[2] - rect[0])
    const top = Math.min(rect[1], rect[3])
    const h = Math.abs(rect[3] - rect[1])
    const y = pageHeight - top - h

    const r = color[0] ?? 1, g = color[1] ?? 1, b = color[2] ?? 1
    const existing = readContentStream(pageIndex)

    // The patch is APPENDED, so it is drawn under whatever CTM the stream
    // leaves in force at its end. A scanned letter opens with an unbracketed
    // `0.36 0 0 0.36 0 0 cm` for its image and never restores it, so a patch
    // written in page units landed at a third of its size in the corner while
    // the replacement text — which already undoes the end CTM — sat over the
    // old ink. Same compensation as `addTextToPage`.
    const endCtm = getCtmAtOffset(existing, existing.length)
    let undo = ''
    if (endCtm.some((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) > 1e-9)) {
      const inv = matInvert(endCtm)
      if (inv) undo = `${inv.map(v => fmtNum(v)).join(' ')} cm `
    }
    // q/Q so the fill colour does not leak into whatever is drawn next.
    const op = `
q ${undo}${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} rg ` +
               `${fmtNum(x)} ${fmtNum(y)} ${fmtNum(w)} ${fmtNum(h)} re f Q
`

    const combined = existing + op
    const bytes = new Uint8Array(combined.length)
    for (let i = 0; i < combined.length; i++) bytes[i] = combined.charCodeAt(i) & 0xFF

    const contents = pageObj.get('Contents')
    const isStream = !!contents && String(contents) !== 'null' &&
      typeof contents.isStream === 'function' && contents.isStream()
    if (isStream) contents.writeStream(bytes)
    else pageObj.put('Contents', pdfDoc.addStream(bytes, {}))

    page.destroy()
    invalidateContentSources(pageIndex)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Move the page's DRAWN geometry — rules, boxes, shaded cells — with the text.
 *
 * Reflow moves text and nothing else, which is fine until the page holds a
 * table. Every cell's words then slide down while the rules they sit inside
 * stay put, and a document that only needed a longer sentence comes back with
 * its table in pieces: headers printed across their own borders, the data row
 * fallen out of the box. Acrobat does not move them either — it declines to
 * reflow at all. Moving them is the point of this.
 *
 * Three rules keep it from doing harm:
 *
 *  - A PATH moves whole or not at all. Points are collected until the path is
 *    painted, and the shift is applied only if EVERY one of them is below the
 *    line the text grew at. Judging points one at a time would shear a vertical
 *    rule that straddles it, and a sheared table is worse than an unmoved one.
 *  - Only under an upright CTM. A rotated or skewed transform has no single
 *    "down", so those paths are counted and left exactly as they are.
 *  - Nothing inside BT/ET or an inline image is touched. Text has its own
 *    mover, and an inline image's bytes are not operators however much a run of
 *    them may look like one.
 *
 * `thresholdY` and `dy` are PDF user space (y-up), the space the text
 * transforms already use: a push DOWN is a negative `dy`.
 */
function shiftGraphicsBelow(
  pageIndex: number,
  thresholdY: number,
  dy: number
): { success: boolean; moved: number; skipped: number; error?: string } {
  if (!pdfDoc) return { success: false, moved: 0, skipped: 0, error: 'No document' }
  if (!(Math.abs(dy) > 0.05)) return { success: true, moved: 0, skipped: 0 }

  // operand count and the indices of the Y operands within it
  const PATH_OPS: Record<string, { n: number; ys: number[] }> = {
    m: { n: 2, ys: [1] },
    l: { n: 2, ys: [1] },
    c: { n: 6, ys: [1, 3, 5] },
    v: { n: 4, ys: [1, 3] },
    y: { n: 4, ys: [1, 3] },
    re: { n: 4, ys: [1] }
  }
  const PAINT_OPS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'])

  let moved = 0
  let skipped = 0

  try {
    for (const src of getContentSources(pageIndex)) {
      const stream = src.stream
      const masked = maskStreamLiterals(stream)

      interface Operand { start: number; end: number; value: number }
      /** One Y operand of the path being built, and where it sits on the page. */
      interface Pending { operand: Operand; pageY: number; scaleY: number }

      const splices: { start: number; end: number; text: string }[] = []
      const ctmStack: Mat6[] = []
      let ctm: Mat6 = [1, 0, 0, 1, 0, 0]
      let textDepth = 0
      let operands: Operand[] = []
      let pending: Pending[] = []
      let pathBelow = true
      let pathUpright = true
      let pathHasPoints = false
      let pathIsClip = false

      const endPath = () => {
        if (pathHasPoints && !pathIsClip) {
          if (pathBelow && pathUpright) {
            for (const p of pending) {
              splices.push({
                start: p.operand.start,
                end: p.operand.end,
                text: fmtNum(p.operand.value + dy / p.scaleY)
              })
            }
            moved++
          } else if (!pathBelow && pending.some(p => p.pageY < thresholdY)) {
            // Straddles the line: left alone on purpose, and counted so the
            // caller can say so rather than quietly present a broken page.
            skipped++
          } else if (!pathUpright) {
            skipped++
          }
        }
        pending = []
        pathBelow = true
        pathUpright = true
        pathHasPoints = false
        pathIsClip = false
      }

      const tok = /([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([A-Za-z*'"]+)/g
      let t: RegExpExecArray | null
      while ((t = tok.exec(masked)) !== null) {
        if (t[1] !== undefined) {
          operands.push({ start: t.index, end: t.index + t[1].length, value: parseFloat(t[1]) })
          if (operands.length > 8) operands.shift()
          continue
        }
        const op = t[2]

        // An inline image's data is raw bytes. Skip from ID to the EI that ends
        // it, or the scan will read the pixels as a very long path.
        if (op === 'BI') {
          const ei = masked.indexOf('EI', t.index)
          tok.lastIndex = ei < 0 ? masked.length : ei + 2
          operands = []
          continue
        }

        if (op === 'q') { ctmStack.push([...ctm] as Mat6); operands = []; continue }
        if (op === 'Q') { ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0]; operands = []; continue }
        if (op === 'cm') {
          if (operands.length >= 6) {
            const o = operands.slice(-6).map(x => x.value) as Mat6
            ctm = matConcat(o, ctm)
          }
          operands = []
          continue
        }
        if (op === 'BT') { textDepth++; operands = []; continue }
        if (op === 'ET') { textDepth = Math.max(0, textDepth - 1); operands = []; continue }

        if (textDepth === 0) {
          const spec = PATH_OPS[op]
          if (spec && operands.length >= spec.n) {
            const args = operands.slice(-spec.n)
            const upright = Math.abs(ctm[1]) < 1e-6 && Math.abs(ctm[2]) < 1e-6 && Math.abs(ctm[3]) > 1e-9
            pathHasPoints = true
            if (!upright) {
              pathUpright = false
            } else {
              const toPage = (yLocal: number) => ctm[3] * yLocal + ctm[5]
              for (const yi of spec.ys) {
                const operand = args[yi]
                const pageY = toPage(operand.value)
                if (!(pageY < thresholdY)) pathBelow = false
                pending.push({ operand, pageY, scaleY: ctm[3] })
              }
              // A rectangle's far edge counts too: `re` names only its lower
              // corner, and a box whose top pokes above the line straddles it.
              if (op === 're') {
                const topY = toPage(args[1].value + args[3].value)
                if (!(topY < thresholdY)) pathBelow = false
              }
            }
          } else if (op === 'W' || op === 'W*') {
            // A CLIP, not a drawing. Moving the window without moving what it
            // holds is how a page loses its text: one file in the corpus builds
            // 477 `re W* n` boxes around its paragraphs, and sliding those down
            // clipped three quarters of the words off the page — silently, since
            // the text objects themselves were untouched and still there.
            //
            // Not counted as skipped: the text mover already widens the clip
            // around anything IT moves (`expandClipForTransform`), so the
            // window is looked after, just not from here.
            pathIsClip = true
          } else if (PAINT_OPS.has(op)) {
            endPath()
          }
        }
        operands = []
      }
      endPath()

      if (splices.length === 0) continue

      let out = stream
      for (const sp of splices.sort((a, b) => b.start - a.start)) {
        out = out.slice(0, sp.start) + sp.text + out.slice(sp.end)
      }
      const bytes = new Uint8Array(out.length)
      for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xFF
      src.write(bytes)
    }

    invalidateContentSources(pageIndex)
    return { success: true, moved, skipped }
  } catch (err: any) {
    return { success: false, moved, skipped, error: err.message || String(err) }
  }
}

function insertBlankPage(atIndex: number, width: number, height: number): {
  success: boolean; pageCount?: number; error?: string } {
  invalidateContentSources() // page indices shift
  try {
    const mediabox: [number, number, number, number] = [0, 0, width, height]
    const resources = pdfDoc.newDictionary()
    const contents = new Uint8Array(0)
    const pageObj = pdfDoc.addPage(mediabox, 0, resources, contents)
    const at = Math.max(0, Math.min(atIndex, pdfDoc.countPages()))
    pdfDoc.insertPage(at, pageObj)
    return { success: true, pageCount: pdfDoc.countPages() }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

function deletePageOp(pageIndex: number): {
  success: boolean; pageCount?: number; error?: string } {
  invalidateContentSources() // page indices shift
  try {
    if (pdfDoc.countPages() <= 1) return { success: false, error: 'Cannot delete the last page' }
    pdfDoc.deletePage(pageIndex)
    return { success: true, pageCount: pdfDoc.countPages() }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

function duplicatePage(pageIndex: number): {
  success: boolean; pageCount?: number; error?: string } {
  invalidateContentSources() // page indices shift
  try {
    // graftPage(to, srcDoc, srcPage): copy srcPage and insert it at position `to`
    pdfDoc.graftPage(pageIndex + 1, pdfDoc, pageIndex)
    return { success: true, pageCount: pdfDoc.countPages() }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

function movePage(from: number, to: number): {
  success: boolean; pageCount?: number; error?: string } {
  invalidateContentSources() // page indices shift
  try {
    const n = pdfDoc.countPages()
    if (from < 0 || from >= n || to < 0 || to >= n) return { success: false, error: 'Index out of range' }
    const order: number[] = []
    for (let i = 0; i < n; i++) order.push(i)
    const [moved] = order.splice(from, 1)
    order.splice(to, 0, moved)
    pdfDoc.rearrangePages(order)
    return { success: true, pageCount: pdfDoc.countPages() }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

// ==========================================
// SEARCH
// ==========================================

function searchPage(pageIndex: number, needle: string, maxHits = 100): any[] {
  if (!needle) return []
  const page = pdfDoc.loadPage(pageIndex)
  const results = page.search(needle, maxHits) as number[][][] // Quad[][]
  page.destroy()
  return results.map((quads) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const q of quads) {
      for (let i = 0; i < q.length; i += 2) {
        x0 = Math.min(x0, q[i]); x1 = Math.max(x1, q[i])
        y0 = Math.min(y0, q[i + 1]); y1 = Math.max(y1, q[i + 1])
      }
    }
    return { pageIndex, quads, rect: [x0, y0, x1, y1] }
  })
}

function searchDocument(needle: string, maxHitsPerPage = 100): any[] {
  if (!needle) return []
  const all: any[] = []
  const n = pdfDoc.countPages()
  for (let i = 0; i < n; i++) {
    all.push(...searchPage(i, needle, maxHitsPerPage))
  }
  return all
}
