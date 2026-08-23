/// <reference lib="webworker" />

import type { WorkerRequest, WorkerResponse } from './worker-protocol'
import type {
  TextBlock, TextChar, TextLine, PageTextData,
  BlockTransformOp, BlockStyleOp, BlockTransformResult
} from '../types'

// MuPDF module — loaded dynamically to catch errors
let mupdf: typeof import('mupdf') | null = null
let pdfDoc: any = null // mupdf.PDFDocument

// Font encoding cache: fontName → { unicodeToGlyph, glyphToUnicode, codeBytes } (null = no ToUnicode CMap)
const fontEncodingCache = new Map<string, {
  unicodeToGlyph: Map<number, number>
  glyphToUnicode: Map<number, number>
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
        const result = replaceTextInStream(req.data.pageIndex, req.data.blockId, req.data.newText)
        respond({ id: req.id, type: 'success', data: result })
        break
      }

      case 'addText': {
        if (!pdfDoc) throw new Error('No document loaded')
        const addResult = addTextToPage(
          req.data.pageIndex, req.data.x, req.data.y,
          req.data.text, req.data.fontSize, req.data.fontName, req.data.color
        )
        respond({ id: req.id, type: 'success', data: addResult })
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
      case 'fillRect': {
        if (!pdfDoc) throw new Error('No document loaded')
        respond({ id: req.id, type: 'success', data: fillRect(req.data.pageIndex, req.data.rect, req.data.color) })
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
    respond({ id: req.id, type: 'error', error: err.message || String(err) })
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

  // Split blocks at significant horizontal gaps so each text segment
  // becomes its own clickable/movable element (e.g., "Label:" and "Value"
  // on the same line become separate blocks instead of one big block)
  const splitBlocks = splitBlocksAtGaps(blocks, pageIndex)

  return { pageIndex, blocks: splitBlocks, lines }
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

      // Find horizontal split points
      const segments: TextChar[][] = []
      let segStart = 0
      for (let i = 1; i < lineChars.length; i++) {
        const prev = lineChars[i - 1]
        const curr = lineChars[i]
        const prevEnd = Math.max(prev.quad[2], prev.quad[6])
        const currStart = Math.min(curr.quad[0], curr.quad[4])
        const gap = currStart - prevEnd

        if (gap > gapThreshold) {
          segments.push(lineChars.slice(segStart, i))
          segStart = i
        }
      }
      segments.push(lineChars.slice(segStart))

      // Create a block for each segment
      for (const seg of segments) {
        if (seg.length === 0) continue
        result.push(makeBlock(seg, block))
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
function invalidateContentSources(pageIndex?: number) {
  if (pageIndex === undefined) contentSourceCache = new Map()
  else contentSourceCache.delete(pageIndex)
}

function getContentSources(pageIndex: number): ContentSource[] {
  if (!pdfDoc) return []
  const cached = contentSourceCache.get(pageIndex)
  if (cached) return cached
  const sources: ContentSource[] = []

  const pageStream = readContentStream(pageIndex)
  sources.push({
    key: 'page',
    stream: pageStream,
    resources: null, // null => the page's own Resources
    write: (bytes) => writeContentStream(pageIndex, bytes)
  })

  let page: any = null
  try {
    page = pdfDoc.loadPage(pageIndex)
    const pageRes = page.getObject().get('Resources')
    const seen = new Set<string>()

    const walk = (stream: string, resources: any, path: string, depth: number) => {
      if (depth > MAX_XOBJECT_DEPTH) return
      const xobjects = resources?.get?.('XObject')
      if (!xobjects || String(xobjects) === 'null') return

      // Only the forms this stream actually invokes.
      const invoked = [...new Set(
        [...stream.matchAll(/\/([A-Za-z0-9_.+-]+)\s+Do(?![A-Za-z0-9])/g)].map(m => m[1])
      )]

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

        const key = path + '/' + name
        if (/(?<![A-Za-z0-9])BT(?![A-Za-z0-9])/.test(text)) {
          const target = ref
          sources.push({
            key: 'xobj:' + key,
            stream: text,
            resources: childRes ?? pageRes,
            write: (bytes) => { target.writeStream(bytes) },
            formDict: resolved
          })
        }
        walk(text, childRes ?? pageRes, key, depth + 1)
      }
    }

    walk(pageStream, pageRes, '', 1)
  } catch (_) { /* fall back to the page stream alone */ }
  finally { try { page?.destroy() } catch (_) { /* already gone */ } }

  if (sources.length > MAX_XOBJECT_SOURCES + 1) {
    console.warn(`[MuPDF Worker] page ${pageIndex} has ${sources.length - 1} text-bearing ` +
      `Form XObjects; searching the first ${MAX_XOBJECT_SOURCES}`)
    sources.length = MAX_XOBJECT_SOURCES + 1
  }
  contentSourceCache.set(pageIndex, sources)
  return sources
}

/** Run `fn` with font lookups scoped to a content source. */
function withSource<T>(src: ContentSource, fn: () => T): T {
  activeResources = src.resources ? { key: src.key, dict: src.resources } : null
  try { return fn() } finally { activeResources = null }
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
  codeBytes: number
} {
  const unicodeToGlyph = new Map<number, number>()
  const glyphToUnicode = new Map<number, number>()
  // Track the code width: fonts with 1-byte codes write <41> keys; decoding
  // them with a fixed 2-byte stride turns "Hello" into CJK garbage.
  let maxKeyHexLen = 0

  // Parse bfchar entries: <glyphHex> <unicodeHex>
  const bfcharRegex = /beginbfchar\s([\s\S]*?)endbfchar/g
  let m: RegExpExecArray | null
  while ((m = bfcharRegex.exec(cmapText)) !== null) {
    const entries = m[1]
    const pairRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g
    let pair: RegExpExecArray | null
    while ((pair = pairRegex.exec(entries)) !== null) {
      const glyphId = parseInt(pair[1], 16)
      const unicode = parseInt(pair[2], 16)
      maxKeyHexLen = Math.max(maxKeyHexLen, pair[1].length)
      glyphToUnicode.set(glyphId, unicode)
      unicodeToGlyph.set(unicode, glyphId)
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
      dst.forEach((d, i) => {
        const u = firstCodePoint(d)
        glyphToUnicode.set(start + i, u)
        if (!unicodeToGlyph.has(u)) unicodeToGlyph.set(u, start + i)
      })
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

  return { unicodeToGlyph, glyphToUnicode, codeBytes: maxKeyHexLen > 0 && maxKeyHexLen <= 2 ? 1 : 2 }
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
  encoding: { unicodeToGlyph: Map<number, number>; codeBytes?: number }
): { hex: string } | { error: string; missingChars: string[] } {
  let hex = ''
  const missingChars: string[] = []
  const pad = (encoding.codeBytes === 1 ? 1 : 2) * 2
  for (let i = 0; i < text.length; i++) {
    const codePoint = text.codePointAt(i)!
    const glyphId = encoding.unicodeToGlyph.get(codePoint)
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
        } catch (_) { /* keep Unknown */ }
      } else if (encStr === 'null' && subtype !== '/Type0') {
        // No /Encoding: only NON-symbolic fonts default to StandardEncoding.
        // Symbolic embedded subsets (Ghostscript output: byte codes are raw
        // glyph indices 1..N) must NOT be treated as ASCII — flagged below
        // once Flags is read.
        encodingName = 'Standard'
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
      if (encodingName === 'Standard' && (flags & 4) !== 0) {
        encodingName = 'Unknown'
      }

      info = {
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
 * Rebuild a BT block's inner content to draw the given pre-encoded lines,
 * optionally switching to a different font resource. Preserves the original
 * text matrix, color operators and Tf size.
 */
function rebuildBtContent(
  content: string,
  encodedLines: string[],
  newFontRef: string | null,
  hex = false,
  overrideSize?: number,
  overrideColorOp?: string | null
): string {
  const tfMatch = content.match(/\/([A-Za-z0-9_.+-]+)\s+([\d.]+)\s+Tf/)
  const tfSize = overrideSize !== undefined ? fmtNum(overrideSize) : (tfMatch ? tfMatch[2] : '12')
  const tfPart = newFontRef
    ? `/${newFontRef} ${tfSize} Tf`
    : (tfMatch
        ? (overrideSize !== undefined ? `/${tfMatch[1]} ${tfSize} Tf` : tfMatch[0])
        : '')

  const tmMatch = content.match(/(-?[\d.]+\s+){5}-?[\d.]+\s+Tm/)
  const tmPart = tmMatch ? tmMatch[0] : ''

  // Preserve Td offsets that precede the first show-text op — some generators
  // position every line via "Tm 0 -N Td"; dropping them would move the text
  // back to the Tm origin.
  const preShow = content.split(/[(<[]/)[0]
  const tdMatches = preShow.match(/-?[\d.]+\s+-?[\d.]+\s+Td/g)
  const tdPart = tdMatches ? tdMatches.join('\n') : ''

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
  const restoreTf = (newFontRef && tfMatch) ? `\n${tfMatch[0]}` : ''

  return `\n${colorPart ? colorPart + '\n' : ''}${tfPart}\n${tmPart}\n${tdPart ? tdPart + '\n' : ''}${tjParts.join('\n')}${restoreTf}\n`
}

type EncodingPlan =
  | { kind: 'keep-hex'; hexLines: string[] }
  | { kind: 'keep-plain'; byteLines: string[] }
  | { kind: 'subst'; fontRef: string; fontName: string; byteLines: string[] }
  | { kind: 'error'; error: string }

/**
 * Decide how to encode replacement text for a BT block:
 * 1. Re-encode with the original font when every character is available.
 * 2. Otherwise substitute a matching standard font (Acrobat-style fallback).
 */
function planTextEncoding(
  pageIndex: number,
  block: { mode: 'hex' | 'plain'; fontRef: string; encoding: ReturnType<typeof getFontEncoding> },
  lines: string[],
  targetBlock?: TextBlock
): EncodingPlan {
  // Empty replacement (deletion) never needs substitution
  const isEmpty = lines.every(l => l.length === 0)

  if (block.mode === 'hex' && block.encoding) {
    const hexLines: string[] = []
    let ok = true
    for (const line of lines) {
      const res = encodeTextForFont(line, block.encoding)
      if ('error' in res) { ok = false; break }
      hexLines.push(res.hex)
    }
    if (ok) return { kind: 'keep-hex', hexLines }
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
        const res = encodeTextForFont(line, block.encoding)
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
  for (const line of lines) {
    const res = encodeWinAnsiText(line)
    if ('missing' in res) {
      return { kind: 'error', error: `Cannot encode characters: ${res.missing.join(', ')} (not supported by fallback font)` }
    }
    byteLines.push(res.bytes)
  }

  const info = getSimpleFontInfo(pageIndex, block.fontRef)
  const fontName = pickSubstituteFont(info, targetBlock)

  try {
    const page = pdfDoc.loadPage(pageIndex)
    const pageObj = page.getObject()
    const fontRef = ensureStandardFont(pageObj, fontName)
    page.destroy()
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
  color?: [number, number, number]
): { success: boolean; error?: string } {
  if (!pdfDoc || !mupdf) return { success: false, error: 'No document' }

  try {
    const page = pdfDoc.loadPage(pageIndex)
    const pageObj = page.getObject()

    // 1. Ensure the standard font is in page Resources
    const fontRefName = ensureStandardFont(pageObj, fontName)

    // 2. Read existing content stream
    const existingStream = readContentStream(pageIndex)

    // 3. Build new BT block. Encode to WinAnsi bytes first — serializing raw
    // Unicode with "& 0xFF" would silently mangle €, smart quotes, dashes…
    const winAnsi = encodeWinAnsiText(text)
    if ('missing' in winAnsi) {
      page.destroy()
      return { success: false, error: `Characters not supported by ${fontName}: ${winAnsi.missing.join(', ')}` }
    }
    const r = color?.[0] ?? 0
    const g = color?.[1] ?? 0
    const b = color?.[2] ?? 0
    const escaped = escapePdfString(winAnsi.bytes)

    const newBlock = `\nBT\n${r} ${g} ${b} rg\n/${fontRefName} ${fontSize} Tf\n1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm\n(${escaped}) Tj\nET\n`

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
function ensureStandardFont(pageObj: any, fontName: string): string {
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
    const targetBlock = pageData.blocks.find(b => b.id === blockId)
    if (!targetBlock) {
      return { success: false, error: `Block ${blockId} not found` }
    }

    // Get page size for line wrapping + position-aware matching
    const pageBounds = pdfDoc.loadPage(pageIndex)
    const boundsRect = pageBounds.getBounds()
    const pageWidth = boundsRect[2] - boundsRect[0]
    const pageHeight = boundsRect[3] - boundsRect[1]
    pageBounds.destroy()

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
          stream, pageIndex, targetBlock, newText, targetFontRef, pageWidth, pageHeight
        )
      })

      if (!outcome) continue
      if ('error' in outcome) { lastError = outcome.error; continue }

      // Longer text needs a wider window, or the tail is clipped away and lost.
      // The clip sits at a LOWER offset than the block it bounds, and the
      // replacement only rewrote bytes at/after that block, so the offset found
      // in the original stream is still valid in the rewritten one.
      let streamStr = outcome.stream
      if (outcome.anchorOffset !== undefined && newText.length > 0) {
        const oldLen = Math.max(targetBlock.text.trim().length, 1)
        const avgCharWidth = targetBlock.width / oldLen
        // Deliberately generous. The average is taken over the ORIGINAL glyphs,
        // and a substituted base-14 face is usually wider — sizing the window to
        // the old average left "SWEEPMARK2" clipped to "SWEEP M". Over-widening
        // only reveals more of the group the clip bounds, which is the text run
        // itself, so erring high is free.
        const needed = avgCharWidth * newText.length * 1.6 + 8
        // Every clip in force, highest offset first so each splice leaves the
        // earlier offsets valid.
        const clips = getActiveClipsAtOffset(src.stream, outcome.anchorOffset)
          .filter(c => c.index < outcome.anchorOffset!)
          .sort((a, b) => b.index - a.index)
        for (const clip of clips) {
          const widened = widenClipForText(src.stream, clip, targetBlock, needed, pageHeight)
          if (widened) {
            streamStr = streamStr.slice(0, clip.index) + widened +
                        streamStr.slice(clip.index + clip.length)
          }
        }

        // A Form XObject is clipped to its own /BBox even without a `re W n`.
        // Canva nests its text two forms deep in a box sized to the original
        // string, so a wider replacement was cut off there instead —
        // "Plataforma" came back as "SWEEPMA".
        //
        // The BBox lives in the form's coordinate space, and the chain that maps
        // that to the page is not tracked here, so the box is grown by the same
        // RATIO the text grew by. Widening a form's BBox can only reveal more of
        // that form's own content, so a generous, capped factor is safe.
        if (src.formDict && needed > targetBlock.width) {
          widenFormBBox(src.formDict, Math.min(needed / Math.max(targetBlock.width, 1), 3))
        }
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
      const ctm = getCtmAtOffset(stream, block.start)
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
      const run = (holdsMoreThanTarget && pureTranslate)
        ? findTargetRun(block, targetBlock.text, pageIndex)
        : null

      let newContent: string
      if (run && run.startsLine) {
        // Td operands are multiplied by the TEXT matrix, so the delta has to be
        // expressed in Tm space — feeding it the CTM-space value moved this
        // block 5.9x too far on a page whose Tm scales by 0.17.
        let tdx = dxL, tdy = dyL
        if (tmMatch) {
          const a = parseFloat(tmMatch[1]), b2 = parseFloat(tmMatch[2])
          const c2 = parseFloat(tmMatch[3]), d2 = parseFloat(tmMatch[4])
          const det = a * d2 - b2 * c2
          if (Math.abs(det) > 1e-9) {
            tdx = (dxL * d2 - dyL * c2) / det
            tdy = (dyL * a - dxL * b2) / det
          }
        }
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
  const ctm = getCtmAtOffset(stream, blockStart)
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
            : rebuildBtContent(block.content, plan.byteLines, plan.fontRef, false, sizeOverride, colorOp)

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
        inner = rebuildBtContent(block.content, [enc.bytes], newFontRef, false, sizeOverride, colorOp)
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
  pageIndex: number
): { start: number; end: number; startsLine: boolean } | null {
  const targetNorm = targetText.replace(/\s+/g, ' ').trim()
  if (!targetNorm) return null
  const ops = scanShowOps(block.content, block.encoding, getSimpleFontInfo(pageIndex, block.fontRef))
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

  const ops = scanShowOps(block.content, block.encoding, getSimpleFontInfo(pageIndex, block.fontRef))
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

  const ctm = getCtmAtOffset(stream, block.start)
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

  const re = /((-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re)\s+W\*?\s+n\b|(?:^|[\s\]>])([qQ])(?=[\s(<\[/%]|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    if (m[6] === 'q') { depths.push(current.length); continue }
    if (m[6] === 'Q') { current.length = depths.length > 0 ? depths.pop()! : 0; continue }
    // Clips INTERSECT, they do not replace one another. Word nests the SAME
    // rectangle twice around a table cell, so widening only the innermost left
    // the outer one still cutting the text off.
    current.push({ index: m.index, length: m[1].length, rect: [+m[2], +m[3], +m[4], +m[5]] })
  }
  return current
}

/** Grow a Form XObject's /BBox to the right by `ratio`, so wider text still shows. */
function widenFormBBox(formDict: any, ratio: number): void {
  if (!pdfDoc || !(ratio > 1)) return
  try {
    const bbox = formDict.get('BBox')
    if (!bbox || String(bbox) === 'null') return
    const arr = bbox.resolve ? bbox.resolve() : bbox
    if (arr.length !== 4) return
    const v = [0, 1, 2, 3].map(i => Number(String(arr.get(i))))
    if (v.some(n => !Number.isFinite(n))) return
    const x0 = Math.min(v[0], v[2]), x1 = Math.max(v[0], v[2])
    const grown = x0 + (x1 - x0) * ratio
    if (!(grown > x1)) return
    const out = pdfDoc.newArray()
    out.push(pdfDoc.newReal(x0))
    out.push(pdfDoc.newReal(Math.min(v[1], v[3])))
    out.push(pdfDoc.newReal(grown))
    out.push(pdfDoc.newReal(Math.max(v[1], v[3])))
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
 */
function widenClipForText(
  stream: string,
  clip: { index: number; length: number; rect: [number, number, number, number] },
  targetBlock: TextBlock,
  newWidthPage: number,
  pageHeight: number
): string | null {
  const ctm = getCtmAtOffset(stream, clip.index)
  const det = ctm[0] * ctm[3] - ctm[1] * ctm[2]
  if (Math.abs(det) < 1e-9) return null
  const ia = ctm[3] / det, ib = -ctm[1] / det
  const ic = -ctm[2] / det, id = ctm[0] / det

  // Required right edge, page space (top-left) -> user space -> clip space.
  const ux = targetBlock.bbox[0] + newWidthPage
  const uy = pageHeight - (targetBlock.bbox[1] + targetBlock.bbox[3]) / 2
  const ax = ux - ctm[4], ay = uy - ctm[5]
  const lx = ax * ia + ay * ic
  const ly = ax * ib + ay * id
  void ly

  const [rx, ry, rw, rh] = clip.rect
  const x0 = Math.min(rx, rx + rw), x1 = Math.max(rx, rx + rw)
  if (!Number.isFinite(lx) || lx <= x1 + 0.5) return null
  return `${fmtNum(x0)} ${fmtNum(ry)} ${fmtNum(lx - x0)} ${fmtNum(rh)} re`
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
  const ctm = getCtmAtOffset(stream, clip.index)
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
  const tfBefore: { at: number; name: string }[] = []
  const tfRe = /\/([^\s<>[\]()/%]+)\s+[\d.-]+\s+Tf/g
  {
    let t: RegExpExecArray | null
    const maskedTf = /\/[ ]*\s+[\d.-]+\s+Tf/g
    while ((t = maskedTf.exec(masked)) !== null) {
      const nameMatch = stream.slice(t.index).match(/^\/([^\s<>[\]()/%]+)/)
      if (nameMatch) tfBefore.push({ at: t.index, name: nameMatch[1] })
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
    // No Tf inside: inherit whatever was in force when the block opened.
    if (!fontRef) fontRef = fontAt(start)
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
    if (targetFontRef && block.fontRef !== targetFontRef) continue
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
  const lineGroups = new Map<number, BtInfo[]>()
  for (const block of allBlocks) {
    const yKey = Math.round(block.yPos * 2) / 2
    if (!lineGroups.has(yKey)) lineGroups.set(yKey, [])
    lineGroups.get(yKey)!.push(block)
  }

  for (const [, lineBlocks] of lineGroups) {
    const normalizedLine = lineBlocks.map(b => b.decodedText).join('').replace(/\s+/g, ' ').trim()
    const exact = normalizedLine === normalizedTarget
    const foldedLine = foldForMatch(normalizedLine)
    const foldedTarget = foldForMatch(normalizedTarget)
    const isMatch = exact ||
                    fuzzyTextMatch(normalizedLine, normalizedTarget) ||
                    (foldedLine.length > 5 && foldedTarget.length > 5 &&
                     (foldedLine.includes(foldedTarget) || foldedTarget.includes(foldedLine)))
    if (!isMatch) continue

    // Keep only the blocks sitting on the clicked text. A line group can hold
    // unrelated runs (a label and its value); transforming the whole group
    // would drag the label along.
    const near = lineBlocks.filter(b => distOf(b) <= onTarget)
    const picked = near.length > 0 ? near : lineBlocks
    candidates.push({
      blocks: picked,
      score: exact ? 2 : 1,
      dist: Math.min(...picked.map(distOf)),
      order: candidates.length
    })
  }

  // Single blocks
  for (const block of allBlocks) {
    if (targetFontRef && block.fontRef !== targetFontRef) continue
    const nd = block.decodedText.replace(/\s+/g, ' ').trim()
    if (!nd || nd.length < 2) continue
    const exact = nd === normalizedTarget
    if (exact || fuzzyTextMatch(nd, normalizedTarget)) {
      candidates.push({ blocks: [block], score: exact ? 2 : 1, dist: distOf(block), order: candidates.length })
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

function replaceTextInContentStreamFontAware(
  stream: string,
  pageIndex: number,
  targetBlock: TextBlock,
  newText: string,
  targetFontRef: string | null,
  pageWidth?: number,
  pageHeight?: number
): { stream: string; substitutedFont?: string; strategy?: string; anchorOffset?: number; lines?: number } | { error: string } | null {
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
  interface Candidate { blocks: BtInfo[]; score: number; dist: number; line: boolean; order: number }
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

  // Step 2: Group blocks by Y position and try line-grouped matching FIRST
  // (MuPDF often groups multiple BT blocks into one TextBlock)
  const lineGroups = new Map<number, BtInfo[]>()
  for (const block of allBlocks) {
    if (!block.hasPos) continue
    // Round Y to nearest 0.5 to group same-line blocks
    const yKey = Math.round(block.yPos * 2) / 2
    if (!lineGroups.has(yKey)) lineGroups.set(yKey, [])
    lineGroups.get(yKey)!.push(block)
  }

  for (const [, lineBlocks] of lineGroups) {
    if (lineBlocks.length < 2) continue

    // Find the best CONTIGUOUS run of blocks whose concatenated text matches
    // the target — never treat the whole group as the match. Some generators
    // give EVERY block on a page the same Tm y and position lines via Td;
    // whole-group matching then blanks the entire page on a single edit.
    const sorted = [...lineBlocks].sort((a, b) => a.start - b.start)
    let best: { blocks: BtInfo[]; score: number } | null = null
    for (let i = 0; i < sorted.length; i++) {
      let acc = ''
      for (let j = i; j < sorted.length; j++) {
        acc += sorted[j].decodedText
        const norm = acc.replace(/\s+/g, ' ').trim()
        if (norm.length > normalizedTarget.length * 1.5 + 8) break // overshot the target
        if (!norm) continue
        const ratio = matchRatio(norm, normalizedTarget)
        if (ratio < 0.7) continue
        let score = 0
        if (norm === normalizedTarget) score = 2
        else if (fuzzyTextMatch(norm, normalizedTarget)) score = ratio
        if (score > 0 && (!best || score > best.score)) {
          best = { blocks: sorted.slice(i, j + 1), score }
        }
      }
    }

    if (best) {
      candidates.push({
        blocks: best.blocks, score: best.score,
        dist: distOf(best.blocks[0]), line: true, order: candidates.length
      })
    }
  }

  // Step 3: single-block matching (for PDFs where each text block is one BT)
  for (const block of allBlocks) {
    if (targetFontRef && block.fontRef !== targetFontRef) continue
    const normalizedDecoded = block.decodedText.replace(/\s+/g, ' ').trim()
    if (!normalizedDecoded || normalizedDecoded.length < 2) continue

    const exact = normalizedDecoded === normalizedTarget
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
    const result = c.line
      ? applyLineReplacement(stream, c.blocks, newText, pageIndex, targetBlock, pageWidth)
      : applyBlockReplacement(stream, c.blocks, newText, pageIndex, targetBlock, pageWidth, pageHeight)
    if (result) {
      if (!('error' in result)) {
        result.strategy = c.line ? 'line_group' : 'single_block'
        result.anchorOffset = c.blocks[0].start
      }
      return result
    }
  }

  // Step 4: Target CONTAINED inside a larger BT block (Ghostscript draws a
  // whole table column as one BT with each cell its own show-op — a short
  // cell like "16:00" never fuzzy-matches the whole block). Replace just the
  // matching show-ops, picking the occurrence nearest the clicked position.
  const targetCompact = foldForMatch(normalizedTarget).replace(/\s+/g, '')
  if (targetCompact.length >= 2) {
    for (const fontFiltered of [true, false]) {
      const containing = allBlocks.filter(block => {
        if (fontFiltered && targetFontRef && block.fontRef !== targetFontRef) return false
        if (!fontFiltered && targetFontRef && block.fontRef === targetFontRef) return false
        const decodedCompact = foldForMatch(block.decodedText).replace(/\s+/g, '')
        return decodedCompact.length > targetCompact.length && decodedCompact.includes(targetCompact)
      })
      // Same reasoning as above: a repeated string must resolve to the copy the
      // user clicked, not to whichever block comes first in the stream.
      containing.sort((a, b) => distOf(a) - distOf(b))
      for (const block of containing) {
        const partial = applyPartialBlockReplacement(stream, block, newText, pageIndex, targetBlock, pageHeight)
        if (partial) {
          if (!('error' in partial)) {
            partial.strategy = 'partial_block'
            partial.anchorOffset = block.start
          }
          return partial
        }
      }
      if (!targetFontRef) break // second pass is identical when no font filter exists
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
): { stream: string; substitutedFont?: string; strategy?: string; anchorOffset?: number; lines?: number } | { error: string } | null {
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
    if (targetNorm && blockGlyphs > targetNorm.length * 1.4) {
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
  if (plan.kind === 'error') return { error: plan.error }

  let newContent: string
  let substitutedFont: string | undefined
  if (plan.kind === 'keep-hex') {
    newContent = replaceTjInBlock(block.content, newText, 'hex', plan.hexLines[0])
  } else if (plan.kind === 'keep-plain') {
    newContent = replaceTjInBlock(block.content, plan.byteLines[0], 'plain')
  } else {
    newContent = rebuildBtContent(block.content, plan.byteLines, plan.fontRef)
    substitutedFont = plan.fontName
  }

  if (newContent !== block.content) {
    // The whole block was rewritten, so any /ActualText describing the old
    // glyphs is now a lie that extraction would report instead of the new text.
    newContent = stripActualText(newContent)
    const result = stream.substring(0, block.start) + 'BT' + newContent + 'ET' +
                   stream.substring(block.end)
    return { stream: result, substitutedFont, lines: 1 }
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
): { stream: string; substitutedFont?: string; strategy?: string; anchorOffset?: number; lines?: number } | { error: string } | null {
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
    newContent = rebuildBtContent(block.content, plan.byteLines, plan.fontRef)
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
  pageWidth?: number
): { stream: string; substitutedFont?: string; strategy?: string; anchorOffset?: number; lines?: number } | { error: string } | null {
  // Sort by position in stream (ascending)
  const sorted = [...lineBlocks].sort((a, b) => a.start - b.start)

  // Any block carrying a visible glyph counts, NOT just those with >1 character.
  // Small-caps exports put a single letter in each BT block ("L", ".", ","), and
  // treating those as noise left them undeleted next to the replacement — the
  // line came out as "LZZZ." instead of "ZZZ".
  const contributes = (b: BtInfo) => b.decodedText.trim().length > 0

  // Find the first block with visible text to put the replacement in
  const primaryIdx = sorted.findIndex(contributes)
  if (primaryIdx === -1) return null
  const primary = sorted[primaryIdx]

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
  }

  // Build replacements (process from end to start to preserve offsets)
  const replacements: { start: number; end: number; newContent: string }[] = []
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
      if (plan.kind === 'error') return { error: plan.error }
      if (plan.kind === 'subst') {
        newContent = rebuildBtContent(block.content, plan.byteLines, plan.fontRef)
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
  }

  // Apply replacements from end to start
  let result = stream
  for (const rep of replacements) {
    result = result.substring(0, rep.start) + 'BT' + rep.newContent + 'ET' + result.substring(rep.end)
  }

  return result !== stream ? { stream: result, substitutedFont, lines: drawnLines } : null
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
  encoding: { glyphToUnicode: Map<number, number>; codeBytes?: number } | null,
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

  // Map raw plain-string bytes through the font's simple encoding (MacRoman/WinAnsi)
  function mapPlainBytes(s: string): string {
    if (!simpleInfo || simpleInfo.encodingName === 'Unknown') return s
    let out = ''
    for (let i = 0; i < s.length; i++) {
      out += String.fromCodePoint(byteToUnicode(s.charCodeAt(i), simpleInfo.encodingName))
    }
    return out
  }

  function decodeGlyph(glyphId: number): string {
    if (encoding) {
      const unicode = encoding.glyphToUnicode.get(glyphId)
      if (unicode !== undefined && unicode >= 0 && unicode <= 0x10FFFF) {
        return String.fromCodePoint(unicode)
      }
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
  const litRe = new RegExp(
    `(${STR_LIT_SRC})|(${HEX_LIT_SRC})|\/([^\s<>\[\]()/%]+)\s+[\d.-]+\s+Tf`, 'g')
  let m: RegExpExecArray | null
  while ((m = litRe.exec(block)) !== null) {
    if (m[3] !== undefined) {
      if (resolveFont) {
        const next = resolveFont(m[3])
        encoding = next.encoding
        simpleInfo = next.simpleInfo
        stride = (encoding?.codeBytes === 1 ? 1 : 2) * 2
        glyphCodedPlain = !!encoding && (!simpleInfo || simpleInfo.encodingName === 'Unknown')
        plainCodeBytes = encoding?.codeBytes === 2 ? 2 : 1
      }
      continue
    }
    if (m[1] !== undefined) {
      const raw = unescapePdfString(m[1].slice(1, -1))
      if (glyphCodedPlain) {
        for (let i = 0; i + plainCodeBytes - 1 < raw.length; i += plainCodeBytes) {
          let code = 0
          for (let k = 0; k < plainCodeBytes; k++) code = (code << 8) | raw.charCodeAt(i + k)
          text += decodeGlyph(code)
        }
      } else {
        text += mapPlainBytes(raw)
      }
    } else {
      const hex = m[2].slice(1, -1).replace(/\s+/g, '')
      for (let i = 0; i + stride - 1 < hex.length; i += stride) {
        text += decodeGlyph(parseInt(hex.substring(i, i + stride), 16))
      }
    }
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
}

/**
 * Scan every show-text operation (Tj, ', ", TJ) in a BT block's content, in
 * order, tracking the text-space position of each op so callers can pick the
 * RIGHT occurrence when identical strings repeat (e.g. "16:00" in 8 table rows).
 */
function scanShowOps(
  content: string,
  encoding: ReturnType<typeof getFontEncoding>,
  simpleInfo?: SimpleFontInfo | null
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
    `((?:${STR_LIT_SRC}|${HEX_LIT_SRC})\\s*(?:Tj|'))`,
    'g'
  )

  const ops: ShowOpInfo[] = []
  let x = 0, y = 0, leading = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) { // Tm — take translation part
      x = parseFloat(m[5]); y = parseFloat(m[6])
      continue
    }
    if (m[7] !== undefined) { // Td / TD
      x += parseFloat(m[7]); y += parseFloat(m[8])
      if (m[9] === 'TD') leading = -parseFloat(m[8])
      continue
    }
    if (m[10] !== undefined) { leading = parseFloat(m[10]); continue } // TL
    if (m[0] === 'T*') { y -= leading; continue }

    const raw = m[0]
    const kind: ShowOpInfo['kind'] =
      m[11] !== undefined ? 'TJ'
      : m[12] !== undefined ? 'dquote'
      : raw.trimEnd().endsWith("'") ? 'quote' : 'Tj'
    if (kind === 'quote' || kind === 'dquote') { y -= leading } // implicit T*
    ops.push({
      start: m.index,
      end: m.index + raw.length,
      raw,
      decoded: decodeBtBlockText(raw, encoding, simpleInfo),
      kind,
      isHex: /<[0-9A-Fa-f\s]*[0-9A-Fa-f]/.test(raw),
      x, y
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
      const stride = (encoding?.codeBytes === 1 ? 1 : 2) * 2
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
function replaceInsideTjArray(
  op: ShowOpInfo,
  targetText: string,
  newLiteral: { literal: string; codes: number[] },
  encoding: ReturnType<typeof getFontEncoding>,
  simpleInfo: SimpleFontInfo | null,
  targetLocalX: number | null,
  tfSize: number
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

  const target = targetText.trim()
  if (!target) return null
  // all occurrences
  const occ: number[] = []
  let p = full.indexOf(target)
  while (p !== -1) { occ.push(p); p = full.indexOf(target, p + 1) }
  if (!occ.length) return null

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
      const d = Math.abs(clickedRel - (xAt[o] ?? 0))
      if (d < bestD) { bestD = d; chosen = o }
    }
  }

  const startC = chosen
  const endC = chosen + target.length
  const first = charItem[startC]
  const last = charItem[endC - 1]
  if (!first || !last) return null

  // Require boundary alignment: the range must start at a literal's first
  // char and end at a literal's last char (true for Ghostscript's per-glyph
  // literals; bail otherwise rather than corrupt)
  if (first.charInItem !== 0) return null
  if (last.charInItem !== items[last.item].decoded.length - 1) return null

  // width compensation
  let comp = ''
  if (simpleInfo?.widths) {
    const w = simpleInfo.widths
    const fc = simpleInfo.firstChar
    let oldW = 0, newW = 0, known = true
    for (let k = first.item; k <= last.item; k++) {
      const it = items[k]
      if (it.isLiteral) for (const code of it.codes) {
        const cw = w[code - fc]
        if (cw === undefined) { known = false } else oldW += cw
      } else {
        oldW -= (it.value || 0) // keep kerns' displacement accounted
      }
    }
    for (const code of newLiteral.codes) {
      const cw = w[code - fc]
      if (cw === undefined) { known = false } else newW += cw
    }
    if (known) comp = ` ${fmtNum(newW - oldW)} `
  }

  const spliceStart = items[first.item].start
  const spliceEnd = items[last.item].end
  return op.raw.slice(0, spliceStart) + newLiteral.literal + comp + ' ' + op.raw.slice(spliceEnd)
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
): { stream: string; substitutedFont?: string; strategy?: string; anchorOffset?: number; lines?: number } | { error: string } | null {
  const simpleInfo = getSimpleFontInfo(pageIndex, block.fontRef)
  const ops = scanShowOps(block.content, block.encoding, simpleInfo)
  if (ops.length < 1) return null

  const targetNorm = targetBlock.text.replace(/\s+/g, ' ').trim()
  if (!targetNorm) return null

  // Map the clicked block's page position into this BT block's local text
  // space so repeated identical strings ("16:00" in every table row) resolve
  // to the occurrence the user actually clicked.
  let targetLocal: { x: number; y: number } | null = null
  if (pageHeight !== undefined) {
    const ctm = getCtmAtOffset(stream, block.start)
    const det = ctm[0] * ctm[3] - ctm[1] * ctm[2]
    if (Math.abs(det) > 1e-9) {
      const pageX = targetBlock.bbox[0]
      const pageY = pageHeight - (targetBlock.bbox[1] + targetBlock.bbox[3]) / 2 // bottom-up
      const ax = pageX - ctm[4], ay = pageY - ctm[5]
      targetLocal = {
        x: (ax * ctm[3] - ay * ctm[2]) / det,
        y: (ay * ctm[0] - ax * ctm[1]) / det
      }
    }
  }

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

  // No op-level window matched — the target may live INSIDE a single TJ
  // array (Ghostscript merges a whole table row into one array, jumping
  // between cells with kern numbers). Replace just those glyphs.
  if (!best) {
    const plan = planTextEncoding(pageIndex, block, [newText], targetBlock)
    if (plan.kind === 'error') return { error: plan.error }
    if (plan.kind === 'subst') return null // can't switch fonts inside an array

    const newLit = plan.kind === 'keep-hex'
      ? { literal: `<${plan.hexLines[0]}>`, codes: hexToCodes(plan.hexLines[0], block.encoding?.codeBytes === 1 ? 1 : 2) }
      : { literal: `(${escapePdfString(plan.byteLines[0])})`, codes: [...plan.byteLines[0]].map(c => c.charCodeAt(0)) }

    const tfMatch = block.content.match(/\/(?:[^\s<>[\]()/%]+)\s+([\d.]+)\s+Tf/)
    const tfSize = tfMatch ? parseFloat(tfMatch[1]) : 12

    // Candidate arrays containing the target, nearest clicked position first
    const candidates = ops
      .filter(o => o.kind === 'TJ' && o.decoded.includes(targetNorm))
      .sort((a, b) => {
        if (!targetLocal) return 0
        const da = Math.abs(a.x - targetLocal.x) + Math.abs(a.y - targetLocal.y) * 4
        const db = Math.abs(b.x - targetLocal.x) + Math.abs(b.y - targetLocal.y) * 4
        return da - db
      })

    for (const op of candidates) {
      const newRaw = replaceInsideTjArray(op, targetNorm, newLit, block.encoding, simpleInfo, targetLocal?.x ?? null, tfSize)
      if (newRaw) {
        const content = block.content.slice(0, op.start) + newRaw + block.content.slice(op.end)
        return {
          stream: stream.slice(0, block.start) + 'BT' + content + 'ET' + stream.slice(block.end)
        }
      }
    }
    return null
  }

  const plan = planTextEncoding(pageIndex, block, [newText], targetBlock)
  if (plan.kind === 'error') return { error: plan.error }

  let content = block.content
  let substitutedFont: string | undefined
  for (let k = best.j; k >= best.i; k--) {
    const op = ops[k]
    let repl: string
    if (k === best.i) {
      if (plan.kind === 'keep-hex') {
        repl = buildShowOp(op.kind, `<${plan.hexLines[0]}>`, op.raw)
      } else if (plan.kind === 'keep-plain') {
        repl = buildShowOp(op.kind, `(${escapePdfString(plan.byteLines[0])})`, op.raw)
      } else {
        // Substituted font applies to THIS op only — restore the block's
        // original font afterwards so the untouched lines keep theirs.
        const tfMatch = block.content.match(/\/([^\s<>[\]()/%]+)\s+([\d.]+)\s+Tf/)
        const size = tfMatch ? tfMatch[2] : '12'
        const restore = tfMatch ? ` /${tfMatch[1]} ${size} Tf` : ''
        repl = `/${plan.fontRef} ${size} Tf ${buildShowOp(op.kind, `(${escapePdfString(plan.byteLines[0])})`, op.raw)}${restore}`
        substitutedFont = plan.fontName
      }
    } else {
      // Blank the other ops in the range, keeping their operators so
      // subsequent line advances stay correct
      repl = buildShowOp(op.kind, op.isHex ? '<>' : '()', op.raw)
    }
    content = content.slice(0, op.start) + repl + content.slice(op.end)
  }

  return {
    stream: stream.slice(0, block.start) + 'BT' + content + 'ET' + stream.slice(block.end),
    substitutedFont
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

function listAnnotations(pageIndex: number): any[] {
  const page = pdfDoc.loadPage(pageIndex)
  const annots = page.getAnnotations()
  const out: any[] = []
  annots.forEach((annot: any, index: number) => {
    const type = safe(() => annot.getType(), 'Unknown')
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
    const annots = page.getAnnotations()
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
    const annots = page.getAnnotations()
    const annot = annots[d.annotIndex]
    if (!annot) { page.destroy(); return { success: false, error: 'Annotation not found' } }
    if (d.rect) { try { annot.setRect(d.rect as any) } catch (_) {} }
    if (d.color) { try { annot.setColor(d.color as any) } catch (_) {} }
    if (d.interiorColor !== undefined) { try { annot.setInteriorColor((d.interiorColor || []) as any) } catch (_) {} }
    if (d.opacity !== undefined) { try { annot.setOpacity(d.opacity) } catch (_) {} }
    if (d.width !== undefined) { try { annot.setBorderWidth(d.width) } catch (_) {} }
    if (d.contents !== undefined) { try { annot.setContents(d.contents) } catch (_) {} }
    annot.update()
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
    // q/Q so the fill colour does not leak into whatever is drawn next.
    const op = `
q ${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} rg ` +
               `${fmtNum(x)} ${fmtNum(y)} ${fmtNum(w)} ${fmtNum(h)} re f Q
`

    const existing = readContentStream(pageIndex)
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
