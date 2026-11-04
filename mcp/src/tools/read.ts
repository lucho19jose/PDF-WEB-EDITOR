/** Reading a document: info, text with references, search, page images, annotations, images, links. */
import { z } from 'zod'
import type { Registrar } from './registrar'
import type { AnnotationInfo, ContentImageInfo, SearchHit } from '../../../src/engine/types'
import { ok, hexOf, pageIndexOf, pagesOf } from '../util'
import { kindOf, pageSize } from '../pageInfo'
import { summary } from './document'

const docId = z.string().optional().describe('Document id from open_pdf. Optional when only one document is open.')
const page = z.number().int().min(1).describe('Page number, starting at 1')

/** Listings are capped so one dense page cannot blow a tool result. */
const LISTING_CAP = 12000
const fmt = (n: number) => Math.round(n)

function capped(lines: string[], what: string): string {
  let out = ''
  for (let i = 0; i < lines.length; i++) {
    if (out.length + lines[i].length + 1 > LISTING_CAP) return out + `\n… ${lines.length - i} more ${what} not shown (use find_text to locate text further down)`
    out += (i ? '\n' : '') + lines[i]
  }
  return out
}

/** The longest side of a rendered image, in pixels: larger is resized by the client anyway. */
const MAX_EDGE = 1568

export function registerReadTools(t: Registrar) {
  t.add('get_document_info', {
    title: 'Document info',
    description: 'Metadata (title, author…), page count and sizes, which pages are scans, bookmarks, digital signatures, and whether a header/footer, watermark or background added by this editor is present.',
    input: { doc_id: docId },
    readOnly: true
  }, (args) => t.doc(args, async (s) => {
    const e = await s.eng()
    const info: Record<string, unknown> = await summary(s)
    info.metadata = await e.acro('getMetadata').catch(() => ({}))
    const outline = await e.acro<any[]>('outline').catch(() => [])
    const flat = (items: any[], depth = 0): string[] => items.flatMap(it => [`${'  '.repeat(depth)}${it.title}${it.page ? ` → page ${it.page}` : ''}`, ...flat(it.children || [], depth + 1)])
    const bm = flat(outline)
    if (bm.length) info.bookmarks = bm.slice(0, 80).concat(bm.length > 80 ? [`… ${bm.length - 80} more`] : [])
    const sigs = await e.send<{ signatures: any[] }>('getSignatures').catch(() => ({ signatures: [] }))
    if (sigs.signatures.length) info.signatures = sigs.signatures.map(x => ({ name: x.name, organisation: x.organisation, reason: x.reason, date: x.date }))
    info.added_by_editor = await e.acro('hasTagged').catch(() => ({}))
    const sizes: string[] = []
    for (let p = 0; p < Math.min(s.pageCount, 200); p++) {
      const z = await pageSize(s, p)
      sizes.push(`${p + 1}: ${fmt(z.width)}x${fmt(z.height)}${z.rotation ? ` rot ${z.rotation}` : ''}`)
    }
    info.page_sizes = sizes
    info.history = s.history
    return ok(info)
  }))

  t.add('list_page_text', {
    title: 'List page text',
    description: 'The text blocks of a page, each with a reference like "p1b12" and its position (points from the top-left corner), size and font. Use the references with edit_text_block, delete_text, transform_text and restyle_text. A scanned page has no editable text: the result says so.',
    input: { doc_id: docId, page },
    readOnly: true
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    const k = await kindOf(s, p)
    s.clearPageAnchors(p, 'block')
    if (k.kind === 'scan') {
      return ok({ page: p + 1, scanned: true, why: k.reason, note: 'The text on this page is part of a scanned image and cannot be edited as text here. Read it with render_page; recognise and edit it in PDF Editor Pro with open_in_editor, or annotate on top (add_free_text, add_text).' })
    }
    const blocks = k.blocks.filter(b => !b.invisible && b.text.trim())
    if (!blocks.length) return ok({ page: p + 1, blocks: 0, note: 'This page has no text.' })
    const lines = blocks.map((b, i) => {
      const ref = `p${p + 1}b${i}`
      s.setAnchor(ref, { kind: 'block', page: p, text: b.text, cx: (b.bbox[0] + b.bbox[2]) / 2, cy: (b.bbox[1] + b.bbox[3]) / 2 })
      const style = [b.fontName.replace(/^[A-Z]{6}\+/, ''), `${Math.round(b.fontSize * 10) / 10}pt`, b.isBold ? 'bold' : '', b.isItalic ? 'italic' : '', hexOf(b.color) !== '#000000' ? hexOf(b.color) : ''].filter(Boolean).join(' ')
      return `[${ref}] (x=${fmt(b.bbox[0])},y=${fmt(b.bbox[1])},w=${fmt(b.bbox[2] - b.bbox[0])},h=${fmt(b.bbox[3] - b.bbox[1])}; ${style}) ${JSON.stringify(b.text)}`
    })
    const size = await pageSize(s, p)
    return { content: [{ type: 'text', text: `Page ${p + 1} of ${s.pageCount} (${fmt(size.width)}x${fmt(size.height)} pt), ${blocks.length} text blocks:\n` + capped(lines, 'blocks') }] }
  }))

  t.add('find_text', {
    title: 'Find text',
    description: 'Search the whole document for words (case-insensitive). Returns the pages and the text blocks holding them, with references usable by the edit tools. To change every occurrence, use replace_text instead.',
    input: { doc_id: docId, query: z.string().min(1), max_results: z.number().int().min(1).max(200).optional() },
    readOnly: true
  }, (args) => t.doc(args, async (s) => {
    const e = await s.eng()
    const { hits } = await e.send<{ hits: SearchHit[] }>('searchDocument', { needle: args.query, maxHitsPerPage: 50 })
    if (!hits.length) return ok({ matches: [], note: `"${args.query}" was not found in the document` })
    const byPage = new Map<number, SearchHit[]>()
    for (const h of hits) (byPage.get(h.pageIndex) ?? byPage.set(h.pageIndex, []).get(h.pageIndex)!).push(h)
    const max = args.max_results ?? 40
    const matches: Record<string, unknown>[] = []
    const scanned: number[] = []
    for (const [p, list] of [...byPage].sort((a, b) => a[0] - b[0])) {
      const k = await kindOf(s, p)
      if (k.kind === 'scan') { scanned.push(p + 1); continue }
      const blocks = k.blocks.filter(b => !b.invisible && b.text.trim())
      const seen = new Set<number>()
      for (const h of list) {
        const [hx0, hy0, hx1, hy1] = h.rect
        blocks.forEach((b, i) => {
          if (seen.has(i)) return
          const [x0, y0, x1, y1] = b.bbox
          if (hx0 < x1 && hx1 > x0 && hy0 < y1 && hy1 > y0) {
            seen.add(i)
            const ref = `p${p + 1}b${i}`
            s.setAnchor(ref, { kind: 'block', page: p, text: b.text, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 })
            matches.push({ page: p + 1, ref, text: b.text })
          }
        })
      }
    }
    const out: Record<string, unknown> = { total_hits: hits.length, matches: matches.slice(0, max) }
    if (matches.length > max) out.note = `${matches.length - max} more blocks not shown`
    if (scanned.length) out.scanned_pages_with_hits = { pages: scanned, note: 'found in the invisible OCR text of scanned pages: those words are part of an image and cannot be edited as text here (use open_in_editor)' }
    return ok(out)
  }))

  t.add('get_text', {
    title: 'Get text',
    description: 'The plain text of the document or of some pages, page by page — for reading, summarising or checking. Scanned pages give their OCR text when they have a searchable layer, else nothing.',
    input: {
      doc_id: docId,
      pages: z.string().optional().describe('Pages, e.g. "1-3,5"; default all'),
      offset: z.number().int().min(0).optional().describe('Character offset to continue from (from a previous truncated result)'),
      max_chars: z.number().int().min(1000).max(100000).optional().describe('Default 40000')
    },
    readOnly: true
  }, (args) => t.doc(args, async (s) => {
    const e = await s.eng()
    const all = (await e.acro<string>('exportText')).split('\n\f\n')
    const list = pagesOf(args.pages, s.pageCount)
    let text = list.map(p => `=== Page ${p + 1} ===\n${(all[p] ?? '').trim()}`).join('\n\n')
    const from = args.offset ?? 0
    const max = args.max_chars ?? 40000
    const slice = text.slice(from, from + max)
    const res: Record<string, unknown> = { text: slice }
    if (from + max < text.length) { res.truncated = true; res.next_offset = from + max; res.total_chars = text.length }
    text = ''
    return ok(res)
  }))

  t.add('render_page', {
    title: 'Render page',
    description: 'A picture of a page (or of a region of it), to see the layout, read a scan, or check an edit. Region coordinates are points from the top-left corner, as list_page_text reports them.',
    input: {
      doc_id: docId,
      page,
      dpi: z.number().min(20).max(400).optional().describe('Resolution; default 110 for a page, 200 for a region. Large renders are scaled down to 1568 px'),
      region: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).optional().describe('Only this part of the page, in points'),
      format: z.enum(['png', 'jpeg']).optional().describe('Default: jpeg for a whole page, png for a region')
    },
    readOnly: true,
    idempotent: true
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    const e = await s.eng()
    const size = await pageSize(s, p)
    const w = args.region ? args.region.width : size.width
    const h = args.region ? args.region.height : size.height
    let scale = (args.dpi ?? (args.region ? 200 : 110)) / 72
    scale = Math.min(scale, MAX_EDGE / Math.max(w, h))
    const format = args.format ?? (args.region ? 'png' : 'jpeg')
    const bytes = args.region
      ? await e.acro<ArrayBuffer>('renderRegion', { pageIndex: p, rect: [args.region.x, args.region.y, args.region.x + args.region.width, args.region.y + args.region.height], scale, format, quality: 85 })
      : await e.acro<ArrayBuffer>('renderImage', { pageIndex: p, scale, format, quality: 85 })
    return {
      content: [
        { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: format === 'png' ? 'image/png' : 'image/jpeg' },
        { type: 'text', text: `Page ${p + 1}${args.region ? ` region (${fmt(args.region.x)},${fmt(args.region.y)}) ${fmt(w)}x${fmt(h)} pt` : ` (${fmt(size.width)}x${fmt(size.height)} pt)`} at ${Math.round(scale * 72)} dpi: ${Math.round(w * scale)}x${Math.round(h * scale)} px. 1 pt = ${(scale).toFixed(2)} px.` }
      ]
    }
  }))

  t.add('list_annotations', {
    title: 'List annotations',
    description: 'Comments, highlights, notes, stamps, drawings, inserted images and form fields of a page, each with a reference like "p1a3" for update_annotation and delete_annotations. Form fields and digital signatures are listed but cannot be changed here.',
    input: { doc_id: docId, page },
    readOnly: true
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    const e = await s.eng()
    const { annotations } = await e.send<{ annotations: AnnotationInfo[] }>('getAnnotations', { pageIndex: p })
    s.clearPageAnchors(p, 'annot')
    const list = annotations.map((a, i) => {
      const ref = `p${p + 1}a${i}`
      s.setAnchor(ref, { kind: 'annot', page: p, type: a.type, cx: (a.rect[0] + a.rect[2]) / 2, cy: (a.rect[1] + a.rect[3]) / 2, contents: a.contents })
      const r: Record<string, unknown> = { ref, type: a.type, x: fmt(a.rect[0]), y: fmt(a.rect[1]), w: fmt(a.rect[2] - a.rect[0]), h: fmt(a.rect[3] - a.rect[1]) }
      if (a.contents) r.text = a.contents.slice(0, 500)
      if (a.author) r.author = a.author
      if (a.color?.length) r.color = hexOf(a.color)
      if (a.type === 'Widget' || a.type === 'Signature') r.read_only = true
      return r
    })
    return ok({ page: p + 1, annotations: list })
  }))

  t.add('list_images', {
    title: 'List images',
    description: 'Images drawn in the page content (logos, photos, signatures pasted into the document), each with a reference like "p1i0" for edit_image. A scanned page shows its scan here as one large image.',
    input: { doc_id: docId, page },
    readOnly: true
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    const e = await s.eng()
    const images = await e.send<ContentImageInfo[]>('listContentImages', { pageIndex: p })
    s.clearPageAnchors(p, 'image')
    return ok({
      page: p + 1,
      images: images.map((im, i) => {
        const ref = `p${p + 1}i${i}`
        s.setAnchor(ref, { kind: 'image', page: p, name: im.name, cx: (im.rect[0] + im.rect[2]) / 2, cy: (im.rect[1] + im.rect[3]) / 2 })
        return { ref, x: fmt(im.rect[0]), y: fmt(im.rect[1]), w: fmt(im.rect[2] - im.rect[0]), h: fmt(im.rect[3] - im.rect[1]) }
      })
    })
  }))

  t.add('list_links', {
    title: 'List links',
    description: 'The links of a page: web addresses and jumps to other pages, by index (for delete_link).',
    input: { doc_id: docId, page },
    readOnly: true
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    const e = await s.eng()
    const links = await e.acro<{ rect: number[]; uri: string; external: boolean; page: number | null }[]>('listLinks', { pageIndex: p })
    return ok({ page: p + 1, links: links.map((l, i) => ({ index: i, x: fmt(l.rect[0]), y: fmt(l.rect[1]), w: fmt(l.rect[2] - l.rect[0]), h: fmt(l.rect[3] - l.rect[1]), ...(l.external ? { url: l.uri } : { to_page: l.page }) })) })
  }))
}
