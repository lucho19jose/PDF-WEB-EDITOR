/// <reference lib="webworker" />

import type { WorkerRequest, WorkerResponse } from './worker-protocol'
import type { TextBlock, TextChar, TextLine, PageTextData } from '../types'

// MuPDF module — loaded dynamically to catch errors
let mupdf: typeof import('mupdf') | null = null
let pdfDoc: any = null // mupdf.PDFDocument

// Font encoding cache: fontName → { unicodeToGlyph, glyphToUnicode }
const fontEncodingCache = new Map<string, {
  unicodeToGlyph: Map<number, number>
  glyphToUnicode: Map<number, number>
}>()

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

      case 'debugFonts': {
        if (!pdfDoc) throw new Error('No document loaded')
        const debugInfo = debugPageFonts(req.data.pageIndex)
        respond({ id: req.id, type: 'success', data: debugInfo })
        break
      }

      case 'saveDocument': {
        if (!pdfDoc) throw new Error('No document loaded')
        const buf = pdfDoc.saveToBuffer('compress')
        const savedBytes = buf.asUint8Array().slice()
        buf.destroy()
        respond({
          id: req.id,
          type: 'success',
          data: { bytes: savedBytes.buffer }
        })
        break
      }

      case 'destroy': {
        if (pdfDoc) {
          pdfDoc.destroy()
          pdfDoc = null
        }
        fontEncodingCache.clear()
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
        fontName: font.getName()
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

  stext.destroy()
  page.destroy()

  return { pageIndex, blocks, lines }
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

  if (contents.isArray()) {
    for (let i = 0; i < contents.length; i++) {
      const streamObj = contents.get(i).resolve()
      if (streamObj.isStream()) {
        const buf = streamObj.readStream()
        chunks.push(buf.asUint8Array().slice())
        buf.destroy()
      }
    }
  } else if (contents.isStream()) {
    const buf = contents.readStream()
    chunks.push(buf.asUint8Array().slice())
    buf.destroy()
  }

  page.destroy()

  // Convert bytes to string using Latin-1 (byte-transparent: each byte maps 1:1 to a char)
  // This preserves raw bytes like 0xF1 (ñ) as char code 241
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0)
  const allBytes = new Uint8Array(totalLen)
  let offset = 0
  for (const chunk of chunks) {
    allBytes.set(chunk, offset)
    offset += chunk.length
  }

  // Latin-1 decode: each byte becomes its corresponding code point
  let streamText = ''
  for (let i = 0; i < allBytes.length; i += 4096) {
    const slice = allBytes.subarray(i, Math.min(i + 4096, allBytes.length))
    streamText += String.fromCharCode(...slice)
  }

  return streamText
}

function writeContentStream(pageIndex: number, bytes: Uint8Array): void {
  if (!pdfDoc) throw new Error('No document')

  const page = pdfDoc.loadPage(pageIndex)
  const pageObj = page.getObject()
  const contents = pageObj.get('Contents')

  if (contents.isArray()) {
    const firstStream = contents.get(0).resolve()
    firstStream.writeStream(bytes)
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
} {
  const unicodeToGlyph = new Map<number, number>()
  const glyphToUnicode = new Map<number, number>()

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
      glyphToUnicode.set(glyphId, unicode)
      unicodeToGlyph.set(unicode, glyphId)
    }
  }

  // Parse bfrange entries: <startGlyph> <endGlyph> <startUnicode>
  const bfrangeRegex = /beginbfrange\s([\s\S]*?)endbfrange/g
  while ((m = bfrangeRegex.exec(cmapText)) !== null) {
    const entries = m[1]
    const rangeRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g
    let range: RegExpExecArray | null
    while ((range = rangeRegex.exec(entries)) !== null) {
      const startGlyph = parseInt(range[1], 16)
      const endGlyph = parseInt(range[2], 16)
      const startUnicode = parseInt(range[3], 16)

      for (let g = startGlyph; g <= endGlyph; g++) {
        const u = startUnicode + (g - startGlyph)
        glyphToUnicode.set(g, u)
        unicodeToGlyph.set(u, g)
      }
    }
  }

  return { unicodeToGlyph, glyphToUnicode }
}

/**
 * Get font encoding for a font name (e.g., "F48") from the page's Resources.
 * Reads the ToUnicode CMap and caches the result.
 */
function getFontEncoding(pageIndex: number, fontRefName: string): {
  unicodeToGlyph: Map<number, number>
  glyphToUnicode: Map<number, number>
} | null {
  const cacheKey = `${pageIndex}:${fontRefName}`
  if (fontEncodingCache.has(cacheKey)) {
    return fontEncodingCache.get(cacheKey)!
  }

  if (!pdfDoc) return null

  try {
    const page = pdfDoc.loadPage(pageIndex)
    const pageObj = page.getObject()
    const resources = pageObj.get('Resources')
    if (!resources) { page.destroy(); return null }

    const fontDict = resources.get('Font')
    if (!fontDict) { page.destroy(); return null }

    // Access font by name directly (fontDict.length doesn't work reliably)
    const fontObj = fontDict.get(fontRefName)
    if (!fontObj) {
      console.warn(`[MuPDF Worker] Font ${fontRefName} not found in Resources`)
      page.destroy()
      return null
    }

    const resolved = fontObj.resolve()

    // Try reading ToUnicode CMap — check both the font itself and as a stream reference
    const encoding = tryReadToUnicode(resolved)
    if (encoding) {
      fontEncodingCache.set(cacheKey, encoding)
      // Font encoding parsed
      page.destroy()
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
          // Descendant font encoding parsed
          page.destroy()
          return descEncoding
        }
      }
    }

    console.warn(`[MuPDF Worker] No ToUnicode CMap found for font ${fontRefName}`)
    page.destroy()
    return null
  } catch (err) {
    console.error(`[MuPDF Worker] Error reading font encoding for ${fontRefName}:`, err)
    return null
  }
}

/**
 * Try to read a ToUnicode CMap from a font dictionary.
 */
function tryReadToUnicode(fontObj: any): {
  unicodeToGlyph: Map<number, number>
  glyphToUnicode: Map<number, number>
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
  encoding: { unicodeToGlyph: Map<number, number> }
): { hex: string } | { error: string; missingChars: string[] } {
  let hex = ''
  const missingChars: string[] = []
  for (let i = 0; i < text.length; i++) {
    const codePoint = text.codePointAt(i)!
    const glyphId = encoding.unicodeToGlyph.get(codePoint)
    if (glyphId === undefined) {
      missingChars.push(text[i])
    } else {
      hex += glyphId.toString(16).padStart(4, '0').toUpperCase()
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

    // 3. Build new BT block
    const r = color?.[0] ?? 0
    const g = color?.[1] ?? 0
    const b = color?.[2] ?? 0
    const escaped = escapePdfString(text)

    const newBlock = `\nBT\n${r} ${g} ${b} rg\n/${fontRefName} ${fontSize} Tf\n1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm\n(${escaped}) Tj\nET\n`

    // 4. Append to content stream
    const combined = existingStream + newBlock
    const streamBytes = new Uint8Array(combined.length)
    for (let i = 0; i < combined.length; i++) {
      streamBytes[i] = combined.charCodeAt(i) & 0xFF
    }

    // 5. Write back
    const contents = pageObj.get('Contents')
    if (contents.isArray()) {
      const newStreamObj = pdfDoc.addStream(streamBytes, {})
      pageObj.put('Contents', newStreamObj)
    } else if (contents.isStream()) {
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

  // Check existing font references for our target font
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
          const baseFontStr = baseFont.asName?.() || baseFont.toString() || ''
          if (baseFontStr.includes(fontName)) {
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
): { success: boolean; error?: string } {
  if (!pdfDoc) return { success: false, error: 'No document' }

  try {
    const pageData = extractPageText(pageIndex)
    const targetBlock = pageData.blocks.find(b => b.id === blockId)
    if (!targetBlock) {
      return { success: false, error: `Block ${blockId} not found` }
    }

    const stream = readContentStream(pageIndex)

    // Build font ref name → baseFont mapping and parse encodings
    const fontRefs = [...new Set((stream.match(/\/(F\d+)/g) || []).map(s => s.slice(1)))]
    const fontRefToBaseName = new Map<string, string>()
    for (const fontRef of fontRefs) {
      getFontEncoding(pageIndex, fontRef)
      // Get the BaseFont name for matching with MuPDF's font name
      try {
        const page2 = pdfDoc.loadPage(pageIndex)
        const pObj = page2.getObject()
        const fDict = pObj.get('Resources').get('Font').get(fontRef)
        if (fDict) {
          const baseFontStr = fDict.resolve().get('BaseFont')?.toString?.() || ''
          // e.g., "/CAAAAA+Calibri" → "CAAAAA+Calibri"
          fontRefToBaseName.set(fontRef, baseFontStr.replace(/^\//, ''))
        }
        page2.destroy()
      } catch (_) {}
    }

    // Find which font ref matches the target block's font
    const targetFontRef = findMatchingFontRef(targetBlock.fontName, fontRefToBaseName)
    // Font matched

    // Find and replace the text in the content stream
    const replaceResult = replaceTextInContentStreamFontAware(
      stream, pageIndex, targetBlock, newText, targetFontRef
    )

    if (!replaceResult) {
      return { success: false, error: 'Could not find matching text in content stream' }
    }
    if ('error' in replaceResult) {
      return { success: false, error: replaceResult.error }
    }

    // Write modified stream back — use Latin-1 encoding (byte-transparent)
    // to preserve raw bytes like 0xF1 (ñ in WinAnsi)
    const streamStr = replaceResult.stream
    const streamBytes = new Uint8Array(streamStr.length)
    for (let i = 0; i < streamStr.length; i++) {
      streamBytes[i] = streamStr.charCodeAt(i) & 0xFF
    }

    const page = pdfDoc.loadPage(pageIndex)
    const pageObj = page.getObject()
    const contents = pageObj.get('Contents')

    if (contents.isArray()) {
      // Replace with single merged stream
      const newStreamObj = pdfDoc.addStream(streamBytes, {})
      pageObj.put('Contents', newStreamObj)
    } else if (contents.isStream()) {
      contents.writeStream(streamBytes)
    }

    page.destroy()
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

interface BtInfo {
  content: string
  start: number
  end: number
  fontRef: string
  yPos: number
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
function replaceTextInContentStreamFontAware(
  stream: string,
  pageIndex: number,
  targetBlock: TextBlock,
  newText: string,
  targetFontRef: string | null
): { stream: string } | { error: string } | null {
  // Step 1: Parse all BT blocks with position and text info
  const btEtRegex = /BT\b([\s\S]*?)ET\b/g
  let match: RegExpExecArray | null
  const allBlocks: BtInfo[] = []

  while ((match = btEtRegex.exec(stream)) !== null) {
    const content = match[1]
    const fontMatch = content.match(/\/(F\d+)\s+[\d.]+\s+Tf/)
    if (!fontMatch) continue

    const fontRef = fontMatch[1]

    // Extract Y position from Tm: "1 0 0 1 <x> <y> Tm"
    const tmMatch = content.match(/[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+([\d.]+)\s+Tm/)
    const yPos = tmMatch ? parseFloat(tmMatch[1]) : -1

    const encoding = getFontEncoding(pageIndex, fontRef)
    const mode = detectBlockEncoding(content)
    const decodedText = decodeBtBlockText(content, encoding)

    allBlocks.push({
      content,
      start: match.index,
      end: match.index + match[0].length,
      fontRef,
      yPos,
      decodedText,
      mode,
      encoding,
      hasSubstantialText: decodedText.trim().length > 1
    })
  }

  // Step 2: Group blocks by Y position and try line-grouped matching FIRST
  // (MuPDF often groups multiple BT blocks into one TextBlock)
  const normalizedTarget = targetBlock.text.replace(/\s+/g, ' ').trim()

  const lineGroups = new Map<number, BtInfo[]>()
  for (const block of allBlocks) {
    if (block.yPos < 0) continue
    // Round Y to nearest 0.5 to group same-line blocks
    const yKey = Math.round(block.yPos * 2) / 2
    if (!lineGroups.has(yKey)) lineGroups.set(yKey, [])
    lineGroups.get(yKey)!.push(block)
  }

  for (const [, lineBlocks] of lineGroups) {
    if (lineBlocks.length < 2) continue

    // Concatenate all text on this line
    const lineText = lineBlocks.map(b => b.decodedText).join('')
    const normalizedLine = lineText.replace(/\s+/g, ' ').trim()
    if (!normalizedLine || normalizedLine.length < 2) continue

    if (normalizedLine === normalizedTarget || fuzzyTextMatch(normalizedLine, normalizedTarget)) {
      // Use all line blocks for replacement (handles blanking sibling blocks)
      const targetBlocks = lineBlocks
      if (targetBlocks.length === 0) continue

      const replaceResult = applyLineReplacement(stream, targetBlocks, newText, pageIndex)
      if (replaceResult) return replaceResult
    }
  }

  // Step 3: Fallback — try single-block matching (for PDFs where each text block is one BT)
  for (const block of allBlocks) {
    if (targetFontRef && block.fontRef !== targetFontRef) continue
    const normalizedDecoded = block.decodedText.replace(/\s+/g, ' ').trim()
    if (!normalizedDecoded || normalizedDecoded.length < 2) continue

    if (normalizedDecoded === normalizedTarget || fuzzyTextMatch(normalizedDecoded, normalizedTarget)) {
      const replaceResult = applyBlockReplacement(stream, [block], newText, pageIndex)
      if (replaceResult) return replaceResult
    }
  }

  return null
}

/**
 * Apply replacement to a single matched BT block.
 */
function applyBlockReplacement(
  stream: string,
  blocks: BtInfo[],
  newText: string,
  pageIndex: number
): { stream: string } | { error: string } | null {
  const block = blocks[0]

  if (block.mode === 'hex') {
    if (!block.encoding) return null
    const encodeResult = encodeTextForFont(newText, block.encoding)
    if ('error' in encodeResult) return { error: encodeResult.error }
    const newContent = replaceTjInBlock(block.content, newText, 'hex', encodeResult.hex)
    if (newContent !== block.content) {
      const result = stream.substring(0, block.start) + 'BT' + newContent + 'ET' +
                     stream.substring(block.end)
      return { stream: result }
    }
  } else {
    const newContent = replaceTjInBlock(block.content, newText, 'plain')
    if (newContent !== block.content) {
      const result = stream.substring(0, block.start) + 'BT' + newContent + 'ET' +
                     stream.substring(block.end)
      return { stream: result }
    }
  }
  return null
}

/**
 * Apply replacement across multiple BT blocks on the same line.
 * Put new text in the first substantial block, blank text in all others.
 */
function applyLineReplacement(
  stream: string,
  lineBlocks: BtInfo[],
  newText: string,
  pageIndex: number
): { stream: string } | { error: string } | null {
  // Sort by position in stream (ascending)
  const sorted = [...lineBlocks].sort((a, b) => a.start - b.start)

  // Find the first block with substantial text to put replacement in
  const primaryIdx = sorted.findIndex(b => b.hasSubstantialText)
  if (primaryIdx === -1) return null
  const primary = sorted[primaryIdx]

  // Build replacements (process from end to start to preserve offsets)
  const replacements: { start: number; end: number; newContent: string }[] = []

  for (let i = sorted.length - 1; i >= 0; i--) {
    const block = sorted[i]
    let newContent: string

    if (i === primaryIdx) {
      // Primary block: insert the new text
      if (block.mode === 'hex') {
        if (!block.encoding) return null
        const encodeResult = encodeTextForFont(newText, block.encoding)
        if ('error' in encodeResult) return { error: encodeResult.error }
        newContent = replaceTjInBlock(block.content, newText, 'hex', encodeResult.hex)
      } else {
        newContent = replaceTjInBlock(block.content, newText, 'plain')
      }
    } else if (block.hasSubstantialText) {
      // Other blocks with text: blank them
      newContent = replaceTjInBlock(block.content, '', block.mode, block.mode === 'hex' ? '' : undefined)
    } else {
      continue // Skip space-only blocks
    }

    replacements.push({ start: block.start, end: block.end, newContent })
  }

  // Apply replacements from end to start
  let result = stream
  for (const rep of replacements) {
    result = result.substring(0, rep.start) + 'BT' + rep.newContent + 'ET' + result.substring(rep.end)
  }

  return result !== stream ? { stream: result } : null
}

/**
 * Fuzzy text match that accounts for '?' placeholders in decoded text
 * (from missing CMap entries). Also handles substring matching.
 */
function fuzzyTextMatch(decoded: string, target: string): boolean {
  // Exact match
  if (decoded === target) return true

  // Strip '?' from decoded and compare known characters
  const knownChars = decoded.replace(/\?/g, '')
  if (knownChars.length < 3) return false

  // Check if decoded is a substantial substring of target (or vice versa)
  // This handles cases where MuPDF groups multiple BT blocks into one text block
  if (target.includes(decoded) && decoded.length > 5) return true
  if (decoded.includes(target) && target.length > 5) return true

  // Check if target length is similar (within 40% tolerance)
  const lenRatio = Math.min(decoded.length, target.length) / Math.max(decoded.length, target.length)
  if (lenRatio < 0.6) return false

  // Check if known (non-?) characters appear in order in the target
  let targetIdx = 0
  let matchCount = 0
  for (let i = 0; i < knownChars.length && targetIdx < target.length; i++) {
    const found = target.indexOf(knownChars[i], targetIdx)
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
  if (/<[0-9A-Fa-f]+>\s*Tj/i.test(block)) return 'hex'
  // TJ arrays with hex inside
  if (/\[[^\]]*<[0-9A-Fa-f]+>[^\]]*\]\s*TJ/i.test(block)) return 'hex'
  return 'plain'
}

/**
 * Decode all text from a BT block, handling both hex-encoded CID fonts
 * and plain text (WinAnsi/standard encoding).
 */
function decodeBtBlockText(
  block: string,
  encoding: { glyphToUnicode: Map<number, number> } | null
): string {
  let text = ''

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

  function decodeHexString(hex: string) {
    for (let i = 0; i + 3 < hex.length; i += 4) {
      text += decodeGlyph(parseInt(hex.substring(i, i + 4), 16))
    }
  }

  let m: RegExpExecArray | null

  // Match hex string Tj: <hexdata> Tj
  const hexTjRegex = /<([0-9A-Fa-f]+)>\s*Tj/g
  while ((m = hexTjRegex.exec(block)) !== null) {
    decodeHexString(m[1])
  }

  // Plain text Tj: (string) Tj
  const plainTjRegex = /\(([^)]*)\)\s*Tj/g
  while ((m = plainTjRegex.exec(block)) !== null) {
    text += unescapePdfString(m[1])
  }

  // TJ arrays: [<hex> num (text) num ...] TJ
  const tjArrayRegex = /\[([^\]]*)\]\s*TJ/g
  while ((m = tjArrayRegex.exec(block)) !== null) {
    const inner = m[1]
    // Extract hex strings
    const hexInArray = /<([0-9A-Fa-f]+)>/g
    let hm: RegExpExecArray | null
    while ((hm = hexInArray.exec(inner)) !== null) {
      decodeHexString(hm[1])
    }
    // Extract parenthesized strings
    const plainInArray = /\(([^)]*)\)/g
    let pm: RegExpExecArray | null
    while ((pm = plainInArray.exec(inner)) !== null) {
      text += unescapePdfString(pm[1])
    }
  }

  return text
}

/**
 * Replace text in a BT block.
 * For hex-encoded fonts: replaces with hex-encoded glyph IDs.
 * For plain text fonts: replaces with escaped PDF strings.
 */
function replaceTjInBlock(block: string, newText: string, mode: 'hex' | 'plain', newHex?: string): string {
  let result = block
  let m: RegExpExecArray | null

  if (mode === 'hex' && newHex) {
    // Replace hex Tj operands
    const hexTjRegex = /<([0-9A-Fa-f]+)>\s*Tj/g
    const matches: string[] = []
    while ((m = hexTjRegex.exec(block)) !== null) {
      matches.push(m[0])
    }
    if (matches.length > 0) {
      result = result.replace(matches[0], `<${newHex}> Tj`)
      for (let i = 1; i < matches.length; i++) {
        result = result.replace(matches[i], '<> Tj')
      }
    }
    // Replace hex in TJ arrays
    const tjArrayRegex = /\[([^\]]*<[0-9A-Fa-f]+>[^\]]*)\]\s*TJ/g
    while ((m = tjArrayRegex.exec(block)) !== null) {
      result = result.replace(m[0], `<${newHex}> Tj`)
    }
  } else {
    // Plain text mode: replace all TJ arrays and Tj operands with a single plain Tj
    const escaped = escapePdfString(newText)

    // Replace TJ arrays first (they contain the main text)
    const tjArrayRegex = /\[([^\]]*)\]\s*TJ/g
    let first = true
    const tjArrayMatches: string[] = []
    while ((m = tjArrayRegex.exec(block)) !== null) {
      tjArrayMatches.push(m[0])
    }
    for (const match of tjArrayMatches) {
      if (first) {
        result = result.replace(match, `(${escaped}) Tj`)
        first = false
      } else {
        result = result.replace(match, `() Tj`)
      }
    }

    // Replace plain Tj operands
    const plainTjRegex = /\(([^)]*)\)\s*Tj/g
    const plainMatches: string[] = []
    while ((m = plainTjRegex.exec(block)) !== null) {
      plainMatches.push(m[0])
    }
    for (const match of plainMatches) {
      if (first) {
        result = result.replace(match, `(${escaped}) Tj`)
        first = false
      } else {
        result = result.replace(match, `() Tj`)
      }
    }
  }

  return result
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

function unescapePdfString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
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
