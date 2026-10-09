import { makeZip } from './zip'

/**
 * "Exportar a Microsoft Word" — a .docx built from MuPDF's structured text.
 *
 * The WASM build of MuPDF has no DOCX writer ("DOCX/ODT writer not enabled"),
 * so the document is assembled here: every text BLOCK becomes a paragraph,
 * every line in it a run carrying the line's size, weight and slant, and each
 * PDF page a Word section of the same paper size, so page breaks land where
 * they were. What a flowing word processor cannot hold — absolute positions,
 * columns, vector art — is not attempted; the text and its styling are what a
 * user exporting to Word is after, and they come across editable.
 */

interface StLine { bbox: { x: number; y: number; w: number; h: number }; font: { name: string; family?: string; weight?: string; style?: string; size: number }; text: string }
interface StBlock { type: string; bbox: { x: number; y: number; w: number; h: number }; lines?: StLine[] }
export interface StPage { width: number; height: number; blocks: StBlock[] }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // XML 1.0 forbids most control characters, and a PDF's text can carry them.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

/** The family Word should ask for: the PDF name without its subset tag and style suffix. */
function familyOf(name: string): string {
  const base = name.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0]
  const spaced = base.replace(/(MT|PS|Std)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim()
  return spaced || 'Calibri'
}

function isBold(f: StLine['font']): boolean {
  return f.weight === 'bold' || /bold|black|heavy|semibold/i.test(f.name)
}
function isItalic(f: StLine['font']): boolean {
  return f.style === 'italic' || /italic|oblique/i.test(f.name)
}

function run(line: StLine, text: string): string {
  const f = line.font
  const size = Math.max(2, Math.round((f.size || 11) * 2))
  const fam = esc(familyOf(f.name || ''))
  const props = [
    `<w:rFonts w:ascii="${fam}" w:hAnsi="${fam}" w:cs="${fam}" w:eastAsia="${fam}"/>`,
    isBold(f) ? '<w:b/>' : '',
    isItalic(f) ? '<w:i/>' : '',
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`
  ].join('')
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
}

function paragraph(block: StBlock, spaceAfterPt: number, leftIndentPt: number): string {
  const lines = (block.lines ?? []).filter(l => l.text.length)
  if (!lines.length) return ''
  const runs: string[] = []
  lines.forEach((l, i) => {
    let text = l.text
    const next = lines[i + 1]
    if (next) {
      // A hyphen at the end of a line is the line break's, not the word's.
      if (/[A-Za-zÀ-ÿ]-$/.test(text) && /^[a-zà-ÿ]/.test(next.text)) text = text.slice(0, -1)
      else if (!/\s$/.test(text)) text += ' '
    }
    runs.push(run(l, text))
  })
  const after = Math.max(0, Math.min(48, Math.round(spaceAfterPt))) * 20
  const ind = Math.max(0, Math.round(leftIndentPt * 20))
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="${after}"/>${ind ? `<w:ind w:left="${ind}"/>` : ''}</w:pPr>${runs.join('')}</w:p>`
}

function sectionProps(page: StPage, margins: { top: number; left: number; right: number; bottom: number }, last: boolean): string {
  const tw = (pt: number) => Math.max(0, Math.round(pt * 20))
  const orient = page.width > page.height ? ' w:orient="landscape"' : ''
  const sect = `<w:sectPr><w:pgSz w:w="${tw(page.width)}" w:h="${tw(page.height)}"${orient}/>` +
    `<w:pgMar w:top="${tw(margins.top)}" w:right="${tw(margins.right)}" w:bottom="${tw(margins.bottom)}" w:left="${tw(margins.left)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`
  // A section's properties end it: inside the last paragraph of the section,
  // or as the body's last child for the final one.
  return last ? sect : `<w:p><w:pPr>${sect}</w:pPr></w:p>`
}

export function buildDocx(pages: StPage[], title = 'Documento'): Blob {
  const body: string[] = []
  pages.forEach((page, pi) => {
    const texts = (page.blocks ?? []).filter(b => b.type === 'text' && b.lines?.length)
      .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
    const left = texts.length ? Math.min(...texts.map(b => b.bbox.x)) : 72
    const right = texts.length ? Math.max(0, page.width - Math.max(...texts.map(b => b.bbox.x + b.bbox.w))) : 72
    const top = texts.length ? Math.min(...texts.map(b => b.bbox.y)) : 72
    const margins = { top: Math.min(top, 144), left: Math.min(left, 144), right: Math.min(Math.max(right, 18), 144), bottom: 36 }
    texts.forEach((b, i) => {
      const next = texts[i + 1]
      const gap = next ? next.bbox.y - (b.bbox.y + b.bbox.h) : 0
      body.push(paragraph(b, gap, b.bbox.x - margins.left))
    })
    if (!texts.length) body.push('<w:p/>')
    body.push(sectionProps(page, margins, pi === pages.length - 1))
  })
  if (!pages.length) body.push('<w:p/>')

  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body.join('')}</w:body></w:document>`
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="es-ES"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  return makeZip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>` }
  ])
}
