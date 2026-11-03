import { makeZipAsync } from './zip'
import { detectConventions, parseCellValue, looksNumericText, type ValueConventions } from './cellValue'
import type { XSheet, XCell, XBorder } from './sheetLayout'

/**
 * A SpreadsheetML workbook (.xlsx) written by hand, as the Word export is:
 * the parts are a handful of XML files in a zip, and a library would add far
 * more than it saves. What Excel insists on, and every one of them has been
 * seen to make it offer to "repair" the file:
 *
 *  - the worksheet's children in SCHEMA order (sheetPr, dimension, sheetViews,
 *    sheetFormatPr, cols, sheetData, mergeCells, pageMargins, pageSetup,
 *    ignoredErrors);
 *  - fills 0 and 1 being "none" and "gray125", whatever the sheet uses;
 *  - merged ranges that never overlap;
 *  - sheet names of 31 characters at most, unique, without : \ / ? * [ ];
 *  - no XML-illegal control characters in any string.
 */

export interface XlsxOptions {
  /** Turn number-like text into numbers and dates (default true). */
  convertValues?: boolean
  title?: string
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
}

export function colName(c: number): string {
  let s = ''
  c += 1
  while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26) }
  return s
}

const hex = (rgb: number) => 'FF' + (rgb & 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase()

function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[:\\/?*[\]]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Hoja'
  let n = base, k = 2
  while (used.has(n.toLowerCase())) { const suf = ` (${k++})`; n = base.slice(0, 31 - suf.length) + suf }
  used.add(n.toLowerCase())
  return n
}

class Styles {
  fonts: string[] = ['<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>']
  fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']
  borders: string[] = ['<border><left/><right/><top/><bottom/><diagonal/></border>']
  numFmts: string[] = []
  xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>']
  private fontIx = new Map<string, number>()
  private fillIx = new Map<number, number>()
  private borderIx = new Map<string, number>()
  private fmtIx = new Map<string, number>()
  private xfIx = new Map<string, number>()

  font(c: XCell): number {
    const name = c.font || 'Calibri', size = c.size ?? 11
    if (name === 'Calibri' && size === 11 && !c.bold && !c.italic && !c.color) return 0
    const key = `${name}|${size}|${c.bold ? 1 : 0}|${c.italic ? 1 : 0}|${c.color ?? 0}`
    let i = this.fontIx.get(key)
    if (i === undefined) {
      i = this.fonts.length
      this.fonts.push(`<font>${c.bold ? '<b/>' : ''}${c.italic ? '<i/>' : ''}<sz val="${size}"/><color rgb="${hex(c.color ?? 0)}"/><name val="${esc(name)}"/></font>`)
      this.fontIx.set(key, i)
    }
    return i
  }

  fill(color: number | undefined): number {
    if (color === undefined) return 0
    let i = this.fillIx.get(color)
    if (i === undefined) {
      i = this.fills.length
      this.fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${hex(color)}"/><bgColor indexed="64"/></patternFill></fill>`)
      this.fillIx.set(color, i)
    }
    return i
  }

  border(b: XCell['border']): number {
    if (!b || !(b.left || b.right || b.top || b.bottom)) return 0
    const side = (tag: string, s?: XBorder) => s ? `<${tag} style="${s.style}"><color rgb="${hex(s.color)}"/></${tag}>` : `<${tag}/>`
    const xml = `<border>${side('left', b.left)}${side('right', b.right)}${side('top', b.top)}${side('bottom', b.bottom)}<diagonal/></border>`
    let i = this.borderIx.get(xml)
    if (i === undefined) { i = this.borders.length; this.borders.push(xml); this.borderIx.set(xml, i) }
    return i
  }

  numFmt(code: string | undefined): number {
    if (!code) return 0
    const builtin: Record<string, number> = { '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10 }
    if (builtin[code] !== undefined) return builtin[code]
    let i = this.fmtIx.get(code)
    if (i === undefined) {
      i = 164 + this.numFmts.length
      this.numFmts.push(`<numFmt numFmtId="${i}" formatCode="${esc(code)}"/>`)
      this.fmtIx.set(code, i)
    }
    return i
  }

  xf(c: XCell, fmt: string | undefined): number {
    const fontId = this.font(c), fillId = this.fill(c.fill), borderId = this.border(c.border), numFmtId = this.numFmt(fmt)
    const align = (c.ha || c.va || c.wrap || c.rotation)
      ? `<alignment${c.ha ? ` horizontal="${c.ha}"` : ''}${c.va ? ` vertical="${c.va}"` : ''}${c.wrap ? ' wrapText="1"' : ''}${c.rotation ? ` textRotation="${c.rotation}"` : ''}/>`
      : ''
    const key = `${numFmtId}|${fontId}|${fillId}|${borderId}|${align}`
    if (key === '0|0|0|0|') return 0
    let i = this.xfIx.get(key)
    if (i === undefined) {
      i = this.xfs.length
      const flags = `${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${align ? ' applyAlignment="1"' : ''}`
      const open = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${flags}`
      this.xfs.push(align ? `${open}>${align}</xf>` : `${open}/>`)
      this.xfIx.set(key, i)
    }
    return i
  }

  xml(): string {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (this.numFmts.length ? `<numFmts count="${this.numFmts.length}">${this.numFmts.join('')}</numFmts>` : '') +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
      '</styleSheet>'
  }
}

class SharedStrings {
  list: string[] = []
  private ix = new Map<string, number>()
  count = 0
  add(s: string): number {
    this.count++
    let i = this.ix.get(s)
    if (i === undefined) { i = this.list.length; this.list.push(s); this.ix.set(s, i) }
    return i
  }
  xml(): string {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.count}" uniqueCount="${this.list.length}">` +
      this.list.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') + '</sst>'
  }
}

function numStr(n: number): string {
  if (Object.is(n, -0)) return '0'
  const s = String(n)
  return /e/i.test(s) ? n.toPrecision(15).replace(/\.?0+(e|$)/i, '$1') : s
}

function sheetXml(sheet: XSheet, styles: Styles, sst: SharedStrings, conv: ValueConventions, convert: boolean, first: boolean): string {
  const byRow = new Map<number, XCell[]>()
  let maxR = 0, maxC = 0
  const merges: string[] = []
  let numbersAsText = false
  for (const c of sheet.cells) {
    if (c.r > 1048575 || c.c > 16383) continue
    let a = byRow.get(c.r)
    if (!a) byRow.set(c.r, a = [])
    a.push(c)
    const r1 = c.r + (c.rows ?? 1) - 1, c1 = c.c + (c.cols ?? 1) - 1
    maxR = Math.max(maxR, r1); maxC = Math.max(maxC, c1)
    if ((c.rows ?? 1) > 1 || (c.cols ?? 1) > 1) merges.push(`${colName(c.c)}${c.r + 1}:${colName(c1)}${r1 + 1}`)
  }
  if (sheet.note) {
    const a = byRow.get(0) ?? []
    if (!a.some(c => c.c === 0)) { a.push({ r: 0, c: 0, text: sheet.note, italic: true, color: 0x7F7F7F }); byRow.set(0, a) }
  }
  const rowsXml: string[] = []
  const rowIdx = [...new Set([...byRow.keys(), ...sheet.rowHeights.keys()])].sort((a, b) => a - b)
  for (const r of rowIdx) {
    const cs = (byRow.get(r) ?? []).sort((a, b) => a.c - b.c)
    const seen = new Set<number>()
    const out: string[] = []
    for (const c of cs) {
      if (seen.has(c.c)) continue
      seen.add(c.c)
      const ref = `${colName(c.c)}${r + 1}`
      const text = c.text.length > 32767 ? c.text.slice(0, 32767) : c.text
      if (!text) {
        const s = styles.xf(c, undefined)
        if (s) out.push(`<c r="${ref}" s="${s}"/>`)
        continue
      }
      const v = convert && !c.keepText && !text.includes('\n') ? parseCellValue(text, conv) : { value: text, kind: 'text' as const }
      if (v.kind !== 'text' && typeof v.value === 'number') {
        // A number is right-aligned by Excel itself; an alignment the cell
        // inherited from its text would fight that only when it is "left".
        const cell = c.ha === 'left' ? { ...c, ha: undefined } : c
        const s = styles.xf(cell, v.fmt)
        out.push(`<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${numStr(v.value)}</v></c>`)
      } else {
        if (looksNumericText(text)) numbersAsText = true
        const s = styles.xf(c, undefined)
        out.push(`<c r="${ref}"${s ? ` s="${s}"` : ''} t="s"><v>${sst.add(text)}</v></c>`)
      }
    }
    const h = sheet.rowHeights.get(r)
    const ht = h !== undefined ? ` ht="${Math.min(409, Math.max(0, h))}" customHeight="1"` : ''
    if (out.length || ht) rowsXml.push(`<row r="${r + 1}"${ht}>${out.join('')}</row>`)
  }
  const cols = sheet.colWidths.map((w, i) => w ? `<col min="${i + 1}" max="${i + 1}" width="${Math.min(255, Math.max(0.08, w)).toFixed(2)}" customWidth="1"/>` : '').join('')
  const dim = `A1:${colName(maxC)}${maxR + 1}`
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    `<dimension ref="${dim}"/>` +
    `<sheetViews><sheetView${first ? ' tabSelected="1"' : ''}${sheet.gridLines ? '' : ' showGridLines="0"'} workbookViewId="0"/></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${rowsXml.join('')}</sheetData>` +
    (merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '') +
    '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
    `<pageSetup paperSize="${sheet.paper}" orientation="${sheet.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>` +
    (numbersAsText ? `<ignoredErrors><ignoredError sqref="${dim}" numberStoredAsText="1"/></ignoredErrors>` : '') +
    '</worksheet>'
}

export async function buildXlsx(sheets: XSheet[], opts: XlsxOptions = {}): Promise<Blob> {
  const convert = opts.convertValues !== false
  const conv = detectConventions(sheets.flatMap(s => s.cells.map(c => c.text)).filter(Boolean))
  const styles = new Styles()
  const sst = new SharedStrings()
  const used = new Set<string>()
  const names = sheets.map(s => safeSheetName(s.name, used))
  const sheetFiles = sheets.map((s, i) => sheetXml(s, styles, sst, conv, convert, i === 0))
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const NS = 'http://schemas.openxmlformats.org'
  const entries = [
    {
      name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'
    },
    {
      name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `<Relationship Id="rId2" Type="${NS}/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
        `<Relationship Id="rId3" Type="${NS}/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
    },
    {
      name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><workbookPr/>` +
        '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000"/></bookViews><sheets>' +
        names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<Relationships xmlns="${NS}/package/2006/relationships">` +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId${sheets.length + 2}" Type="${NS}/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
    },
    ...sheetFiles.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
    { name: 'xl/styles.xml', data: styles.xml() },
    { name: 'xl/sharedStrings.xml', data: sst.xml() },
    {
      name: 'docProps/core.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<cp:coreProperties xmlns:cp="${NS}/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        `<dc:title>${esc(opts.title ?? '')}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
    },
    {
      name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<Properties xmlns="${NS}/officeDocument/2006/extended-properties"><Application>PDF Editor Pro</Application></Properties>`
    }
  ]
  const blob = await makeZipAsync(entries)
  return new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
