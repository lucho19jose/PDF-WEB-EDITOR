/**
 * Editar PDF's page decorations (header/footer, page numbers, watermark,
 * background — all tagged, so a second call replaces rather than stacks),
 * links, metadata, flatten, and Proteger's redaction.
 */
import { z } from 'zod'
import type { Registrar } from './registrar'
import type { SearchHit } from '../../../src/engine/types'
import { ok, fail, colorOf, pageIndexOf, pagesOf, base14 } from '../util'

const docId = z.string().optional().describe('Document id from open_pdf. Optional when only one document is open.')
const pages = z.union([z.string(), z.array(z.number().int().min(1))]).optional().describe('Pages: "1-3,5" or a list; default all')
type Res = { success: boolean; error?: string; pages?: number; removed?: number }
const CM = 72 / 2.54
const today = () => new Date().toLocaleDateString('es')

const triple = z.object({ left: z.string().optional(), center: z.string().optional(), right: z.string().optional() }).optional()

export function registerExtraTools(t: Registrar) {
  t.add('set_header_footer', {
    title: 'Header and footer',
    description: 'Add (or replace) a header and/or footer on pages: up to three texts each (left, center, right). Tokens: <<1>> page number, <<n>> page count, <<fecha>> today\'s date — e.g. "Página <<1>> de <<n>>". Replaces any header/footer added earlier by this editor.',
    input: {
      doc_id: docId, pages,
      header: triple, footer: triple,
      font: z.enum(['Helvetica', 'Times', 'Courier']).optional(), bold: z.boolean().optional(),
      font_size: z.number().min(4).max(72).optional().describe('Default 10'),
      color: z.string().optional(),
      margin_cm: z.object({ top: z.number().optional(), bottom: z.number().optional(), left: z.number().optional(), right: z.number().optional() }).optional().describe('Default 1.3 top/bottom, 2.5 left/right'),
      start_number: z.number().int().min(0).optional().describe('Number of the first page counted, default 1')
    }
  }, (args) => t.doc(args, async (s) => {
    const h = args.header ?? {}, f = args.footer ?? {}
    if (![h.left, h.center, h.right, f.left, f.center, f.right].some(x => x?.trim())) return fail('Give at least one header or footer text.')
    const m = args.margin_cm ?? {}
    const opts = {
      pages: pagesOf(args.pages, s.pageCount),
      header: { left: h.left ?? '', center: h.center ?? '', right: h.right ?? '' },
      footer: { left: f.left ?? '', center: f.center ?? '', right: f.right ?? '' },
      fontName: base14(args.font, !!args.bold), fontSize: args.font_size ?? 10, color: colorOf(args.color, '#000000'),
      margins: { top: (m.top ?? 1.3) * CM, bottom: (m.bottom ?? 1.3) * CM, left: (m.left ?? 2.5) * CM, right: (m.right ?? 2.5) * CM },
      startNumber: args.start_number ?? 1, date: today()
    }
    const r = await s.mutate(async e => { const x = await e.acro<Res>('headerFooter', opts); return { ok: x.success, value: x } })
    if (!r.success) return fail(`Could not add the header/footer: ${r.error}`)
    return ok({ pages: r.pages })
  }))

  t.add('add_page_numbers', {
    title: 'Add page numbers',
    description: 'Number the pages (a footer or header, replacing any header/footer added earlier by this editor). format uses <<1>> for the number and <<n>> for the count; default "Página <<1>> de <<n>>".',
    input: {
      doc_id: docId, pages,
      position: z.enum(['bottom-right', 'bottom-center', 'bottom-left', 'top-right', 'top-center', 'top-left']).optional().describe('Default bottom-right'),
      format: z.string().optional(),
      font_size: z.number().min(4).max(72).optional(),
      start_number: z.number().int().min(0).optional()
    }
  }, (args) => t.doc(args, async (s) => {
    const [where, side] = (args.position ?? 'bottom-right').split('-')
    const text = args.format ?? 'Página <<1>> de <<n>>'
    const slot = { left: '', center: '', right: '', [side]: text }
    const opts = {
      pages: pagesOf(args.pages, s.pageCount),
      header: where === 'top' ? slot : { left: '', center: '', right: '' },
      footer: where === 'bottom' ? slot : { left: '', center: '', right: '' },
      fontName: 'Helvetica', fontSize: args.font_size ?? 10, color: [0, 0, 0],
      margins: { top: 1.3 * CM, bottom: 1.3 * CM, left: 2.5 * CM, right: 2.5 * CM },
      startNumber: args.start_number ?? 1, date: today()
    }
    const r = await s.mutate(async e => { const x = await e.acro<Res>('headerFooter', opts); return { ok: x.success, value: x } })
    if (!r.success) return fail(`Could not number the pages: ${r.error}`)
    return ok({ numbered: r.pages, format: text, position: args.position ?? 'bottom-right' })
  }))

  t.add('add_watermark', {
    title: 'Add watermark',
    description: 'A text watermark across pages (e.g. "CONFIDENCIAL", "BORRADOR"), turned and translucent. Replaces any watermark added earlier by this editor.',
    input: {
      doc_id: docId, pages,
      text: z.string().min(1),
      font: z.enum(['Helvetica', 'Times', 'Courier']).optional(), bold: z.boolean().optional().describe('Default true'),
      width_percent: z.number().min(5).max(100).optional().describe('Share of the page width the text spans; default 70. Ignored when font_size is given'),
      font_size: z.number().min(6).max(400).optional(),
      color: z.string().optional().describe('Default #ff0000'),
      opacity: z.number().min(0.05).max(1).optional().describe('Default 0.3'),
      rotation: z.number().min(-180).max(180).optional().describe('Degrees, default 45'),
      behind: z.boolean().optional().describe('Under the page content instead of over it'),
      position: z.enum(['top', 'middle', 'bottom']).optional()
    }
  }, (args) => t.doc(args, async (s) => {
    const opts = {
      pages: pagesOf(args.pages, s.pageCount), text: args.text, fontName: base14(args.font, args.bold !== false),
      widthFraction: args.font_size ? undefined : (args.width_percent ?? 70) / 100, fontSize: args.font_size ?? 72,
      color: colorOf(args.color, '#ff0000'), opacity: args.opacity ?? 0.3, rotation: args.rotation ?? 45,
      behind: !!args.behind, vAlign: args.position ?? 'middle'
    }
    const r = await s.mutate(async e => { const x = await e.acro<Res>('watermark', opts); return { ok: x.success, value: x } })
    if (!r.success) return fail(`Could not add the watermark: ${r.error}`)
    return ok({ watermark: args.text, pages: r.pages })
  }))

  t.add('set_background', {
    title: 'Set background colour',
    description: 'Fill the page background with a colour, behind the content. Replaces any background added earlier by this editor.',
    input: { doc_id: docId, pages, color: z.string(), opacity: z.number().min(0.05).max(1).optional() }
  }, (args) => t.doc(args, async (s) => {
    const opts = { pages: pagesOf(args.pages, s.pageCount), color: colorOf(args.color, '#fff8dc'), opacity: args.opacity ?? 1 }
    const r = await s.mutate(async e => { const x = await e.acro<Res>('background', opts); return { ok: x.success, value: x } })
    if (!r.success) return fail(`Could not set the background: ${r.error}`)
    return ok({ background: args.color, pages: r.pages })
  }))

  t.add('remove_page_decoration', {
    title: 'Remove header/footer, watermark or background',
    description: 'Remove the header/footer (and page numbers), the watermark or the background that this editor added (or Acrobat-style tagged ones).',
    input: { doc_id: docId, kind: z.enum(['header_footer', 'watermark', 'background']) },
    destructive: true
  }, (args) => t.doc(args, async (s) => {
    const kind = { header_footer: 'headerFooter', watermark: 'watermark', background: 'background' }[args.kind as string]
    const r = await s.mutate(async e => { const x = await e.acro<Res>('removeTagged', { kind }); return { ok: (x.removed ?? 0) > 0, value: x } })
    if (!r.removed) return fail(`No ${args.kind.replace('_', '/')} added by this editor was found.`)
    return ok({ removed: args.kind, places: r.removed })
  }))

  t.add('add_link', {
    title: 'Add link',
    description: 'Make a rectangle of a page a link — to a web address (url) or to a page of this document (to_page).',
    input: {
      doc_id: docId, page: z.number().int().min(1),
      x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(),
      url: z.string().optional(), to_page: z.number().int().min(1).optional(),
      visible_border: z.boolean().optional()
    }
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    if (!args.url && !args.to_page) return fail('Give url or to_page.')
    if (args.to_page) pageIndexOf(args.to_page, s.pageCount)
    const target: Record<string, unknown> = args.url ? { uri: args.url } : { page: args.to_page }
    if (args.visible_border) target.appearance = { visible: true, width: 1, dashed: false, color: [0, 0, 1] }
    const r = await s.mutate(async e => { const x = await e.acro<Res>('addLink', { pageIndex: p, rect: [args.x, args.y, args.x + args.width, args.y + args.height], target }); return { ok: x.success, value: x } })
    if (!r.success) return fail(`Could not add the link: ${r.error}`)
    return ok({ link: args.url ?? `page ${args.to_page}`, page: p + 1 })
  }))

  t.add('delete_link', {
    title: 'Delete link',
    description: 'Remove a link of a page by its index from list_links.',
    input: { doc_id: docId, page: z.number().int().min(1), index: z.number().int().min(0) },
    destructive: true
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    const r = await s.mutate(async e => { const x = await e.acro<Res>('deleteLink', { pageIndex: p, index: args.index }); return { ok: x.success, value: x } })
    if (!r.success) return fail(`Could not delete the link: ${r.error}`)
    return ok({ deleted_link: args.index, page: p + 1 })
  }))

  t.add('set_metadata', {
    title: 'Set document properties',
    description: 'Set the document\'s title, author, subject or keywords (Propiedades del documento).',
    input: { doc_id: docId, title: z.string().optional(), author: z.string().optional(), subject: z.string().optional(), keywords: z.string().optional() }
  }, (args) => t.doc(args, async (s) => {
    const meta: Record<string, string> = {}
    if (args.title !== undefined) meta.Title = args.title
    if (args.author !== undefined) meta.Author = args.author
    if (args.subject !== undefined) meta.Subject = args.subject
    if (args.keywords !== undefined) meta.Keywords = args.keywords
    if (!Object.keys(meta).length) return fail('Give title, author, subject or keywords.')
    const r = await s.mutate(async e => { const x = await e.acro<Res>('setMetadata', { meta }); return { ok: x.success, value: x } })
    if (!r.success) return fail('Could not set the properties.')
    return ok({ set: meta })
  }))

  t.add('flatten', {
    title: 'Flatten',
    description: 'Merge every annotation and form field into the page content, so they can no longer be moved or edited (and print exactly as shown). Ask before doing this.',
    input: { doc_id: docId },
    destructive: true
  }, (args) => t.doc(args, async (s) => {
    const r = await s.mutate(async e => { const x = await e.acro<Res>('flatten'); return { ok: x.success, value: x } })
    if (!r.success) return fail(`Could not flatten: ${r.error}`)
    s.clearAnchors()
    return ok({ flattened: true })
  }))

  t.add('redact', {
    title: 'Redact',
    description: 'Black out and PERMANENTLY remove text or areas (Proteger ▸ Redactar): every occurrence of `text` (on one page or the whole document), and/or rectangles. The content underneath is deleted from the file, not just covered. Ask before doing this.',
    input: {
      doc_id: docId,
      text: z.string().optional().describe('Words to remove wherever they appear'),
      page: z.number().int().min(1).optional().describe('Limit `text` to this page; required for `areas`'),
      areas: z.array(z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })).optional()
    },
    destructive: true
  }, (args) => t.doc(args, async (s) => {
    const marks: { page: number; rect: number[] }[] = []
    const e = await s.eng()
    if (args.text?.trim()) {
      const hits = args.page
        ? (await e.send<{ hits: SearchHit[] }>('searchPage', { pageIndex: pageIndexOf(args.page, s.pageCount), needle: args.text, maxHits: 500 })).hits
        : (await e.send<{ hits: SearchHit[] }>('searchDocument', { needle: args.text, maxHitsPerPage: 500 })).hits
      for (const h of hits) for (const q of h.quads) {
        const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]]
        marks.push({ page: h.pageIndex, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] })
      }
      if (!hits.length && !args.areas?.length) return fail(`"${args.text}" was not found.`)
    }
    if (args.areas?.length) {
      if (!args.page) return fail('areas need page.')
      const p = pageIndexOf(args.page, s.pageCount)
      for (const a of args.areas) marks.push({ page: p, rect: [a.x, a.y, a.x + a.width, a.y + a.height] })
    }
    if (!marks.length) return fail('Give text or areas to redact.')
    const r = await s.mutate(async eng => {
      for (const m of marks) { const x = await eng.acro<Res>('addRedaction', { pageIndex: m.page, rect: m.rect }); if (!x.success) return { ok: false, value: x } }
      const x = await eng.acro<Res>('applyRedactions')
      return { ok: x.success, value: x }
    })
    if (!r.success) return fail(`Could not redact: ${r.error}`)
    s.clearAnchors()
    return ok({ redacted_areas: marks.length, pages: [...new Set(marks.map(m => m.page + 1))] })
  }))
}
