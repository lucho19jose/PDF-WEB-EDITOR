/** Organizar páginas: rotate, delete, move, reorder, duplicate, insert, replace, extract, split, crop. */
import path from 'node:path'
import fs from 'node:fs'
import { z } from 'zod'
import type { Registrar } from './registrar'
import type { DocumentSession } from '../session'
import { ok, fail, pagesOf, resolvePath, readFileBytes, writeFileAtomic, isImagePath, ToolError } from '../util'
import { pageRangeLabel } from '../../../src/utils/acro/pageRange'
import { pageSize } from '../pageInfo'

const docId = z.string().optional().describe('Document id from open_pdf. Optional when only one document is open.')
const pages = z.union([z.string(), z.array(z.number().int().min(1))]).describe('Pages: "1-3,5", "all", or a list of page numbers')
type Res = { success: boolean; error?: string; pageCount?: number; added?: number; replaced?: number; bytes?: ArrayBuffer; parts?: ArrayBuffer[] }

/** Page structure changed: every page reference is stale. */
function structureChanged(s: DocumentSession) { s.clearAnchors() }

/** A PDF's bytes, an image made into a page, or `from_pages` of a PDF only. */
async function sourceBytes(t: Registrar, file: string, fromPages?: unknown): Promise<ArrayBuffer> {
  const raw = readFileBytes(file)
  const scratch = t.scratch()
  if (isImagePath(file)) {
    const r = await scratch.acro<Res>('createPdf', { images: [raw] })
    if (!r.success || !r.bytes) throw new ToolError(`${path.basename(file)}: ${r.error || 'could not make a page from this image'}`)
    return r.bytes
  }
  if (await scratch.acro<boolean>('needsPassword', { bytes: raw })) throw new ToolError(`${path.basename(file)} is password-protected: open it with open_pdf and its password, save an unprotected copy, and use that.`)
  if (fromPages === undefined || fromPages === null || fromPages === '') return raw
  const { pageCount } = await scratch.load(raw)
  const r = await scratch.acro<Res>('extractPages', { indices: pagesOf(fromPages, pageCount) })
  if (!r.success || !r.bytes) throw new ToolError(`Could not take those pages from ${path.basename(file)}: ${r.error}`)
  return r.bytes
}

export function registerPageTools(t: Registrar) {
  t.add('rotate_pages', {
    title: 'Rotate pages',
    description: 'Turn pages by 90 (clockwise), -90 (counter-clockwise) or 180 degrees.',
    input: { doc_id: docId, pages, degrees: z.union([z.literal(90), z.literal(-90), z.literal(180)]) }
  }, (args) => t.doc(args, async (s) => {
    const indices = pagesOf(args.pages, s.pageCount, false)
    const r = await s.pageOp(async e => { const x = await e.acro<Res>('rotatePages', { indices, degrees: args.degrees }); return { ok: x.success, value: x } })
    if (!r.success) return fail(`Could not rotate: ${r.error}`)
    structureChanged(s)
    return ok({ rotated: pageRangeLabel(indices), degrees: args.degrees })
  }))

  t.add('delete_pages', {
    title: 'Delete pages',
    description: 'Remove pages from the document. Ask the user to confirm first unless they named the pages to delete.',
    input: { doc_id: docId, pages },
    destructive: true
  }, (args) => t.doc(args, async (s) => {
    const indices = pagesOf(args.pages, s.pageCount, false)
    if (indices.length >= s.pageCount) return fail('A document cannot lose all of its pages.')
    const r = await s.pageOp(async e => { const x = await e.acro<Res>('deletePages', { indices }); return { ok: x.success, value: x } })
    if (!r.success) return fail(`Could not delete: ${r.error}`)
    structureChanged(s)
    return ok({ deleted: pageRangeLabel(indices), pages_now: s.pageCount })
  }))

  t.add('move_pages', {
    title: 'Move pages',
    description: 'Move pages (kept in their order) so they land before page `before`; before = page count + 1 moves them to the end.',
    input: { doc_id: docId, pages, before: z.number().int().min(1) }
  }, (args) => t.doc(args, async (s) => {
    const n = s.pageCount
    const moving = pagesOf(args.pages, n, false)
    const before = args.before - 1
    if (before < 0 || before > n) return fail(`before must be from 1 to ${n + 1}`)
    const set = new Set(moving)
    const rest = Array.from({ length: n }, (_, i) => i).filter(i => !set.has(i))
    const at = rest.filter(i => i < before).length
    const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)]
    if (order.every((v, i) => v === i)) return ok({ note: 'the pages are already there' })
    const r = await s.pageOp(async e => { const x = await e.acro<Res>('rearrange', { order }); return { ok: x.success, value: x } })
    if (!r.success) return fail(`Could not move: ${r.error}`)
    structureChanged(s)
    return ok({ moved: pageRangeLabel(moving), now_at: `${at + 1}${moving.length > 1 ? `-${at + moving.length}` : ''}` })
  }))

  t.add('reorder_pages', {
    title: 'Reorder pages',
    description: 'Put every page in a new order: `order` lists ALL page numbers once each, in the order wanted (e.g. [3,1,2]). For reverse order pass the numbers backwards.',
    input: { doc_id: docId, order: z.array(z.number().int().min(1)).min(1) }
  }, (args) => t.doc(args, async (s) => {
    const n = s.pageCount
    const order = (args.order as number[]).map(p => p - 1)
    if (order.length !== n || new Set(order).size !== n || order.some(i => i < 0 || i >= n)) return fail(`order must list each of the ${n} page numbers exactly once (use delete_pages to remove pages).`)
    const r = await s.pageOp(async e => { const x = await e.acro<Res>('rearrange', { order }); return { ok: x.success, value: x } })
    if (!r.success) return fail(`Could not reorder: ${r.error}`)
    structureChanged(s)
    return ok({ reordered: n })
  }))

  t.add('duplicate_pages', {
    title: 'Duplicate pages',
    description: 'Insert a copy of each page right after it.',
    input: { doc_id: docId, pages }
  }, (args) => t.doc(args, async (s) => {
    const indices = pagesOf(args.pages, s.pageCount, false).sort((a, b) => b - a)
    let error = ''
    await s.pageOp(async e => {
      for (const i of indices) { const x = await e.send<Res>('duplicatePage', { pageIndex: i }); if (!x.success) { error = x.error || 'duplicate failed'; return { ok: false, value: null } } }
      return { ok: true, value: null }
    })
    if (error) return fail(`Could not duplicate: ${error}`)
    structureChanged(s)
    return ok({ duplicated: indices.length, pages_now: s.pageCount })
  }))

  t.add('insert_pages', {
    title: 'Insert pages',
    description: 'Insert pages before page `before` (page count + 1 = at the end): blank pages (the size of the page beside them), or the pages of another PDF or image file — all of them, or `from_pages` of it.',
    input: {
      doc_id: docId,
      before: z.number().int().min(1),
      file_path: z.string().optional().describe('Absolute path of a PDF or image to insert'),
      from_pages: z.string().optional().describe('Pages of that file, e.g. "2-4"; default all'),
      blank_pages: z.number().int().min(1).max(200).optional().describe('Insert this many blank pages instead')
    }
  }, (args) => t.doc(args, async (s) => {
    const at = args.before - 1
    if (at < 0 || at > s.pageCount) return fail(`before must be from 1 to ${s.pageCount + 1}`)
    if (args.file_path) {
      const bytes = await sourceBytes(t, resolvePath(args.file_path, 'file_path'), args.from_pages)
      const r = await s.pageOp(async e => { const x = await e.send<Res>('mergePages', { bytes, atIndex: at }); return { ok: x.success, value: x } })
      if (!r.success) return fail(`Could not insert: ${r.error}`)
      structureChanged(s)
      return ok({ inserted: r.added, at: at + 1, pages_now: s.pageCount })
    }
    const count = args.blank_pages ?? 1
    const ref = await pageSize(s, Math.max(0, Math.min(at, s.pageCount) - 1))
    let error = ''
    await s.pageOp(async e => {
      for (let k = 0; k < count; k++) { const x = await e.send<Res>('insertBlankPage', { atIndex: at + k, width: ref.width, height: ref.height }); if (!x.success) { error = x.error || 'insert failed'; return { ok: false, value: null } } }
      return { ok: true, value: null }
    })
    if (error) return fail(`Could not insert: ${error}`)
    structureChanged(s)
    return ok({ inserted_blank: count, at: at + 1, pages_now: s.pageCount })
  }))

  t.add('replace_pages', {
    title: 'Replace pages',
    description: 'Replace pages with the pages of another PDF, one for one, each landing where the page it replaces was.',
    input: { doc_id: docId, pages, file_path: z.string(), from_pages: z.string().optional().describe('Pages of that file to use, e.g. "1-2"; default from its first page') },
    destructive: true
  }, (args) => t.doc(args, async (s) => {
    const indices = pagesOf(args.pages, s.pageCount, false)
    const bytes = await sourceBytes(t, resolvePath(args.file_path, 'file_path'), args.from_pages)
    const r = await s.pageOp(async e => { const x = await e.acro<Res>('replacePages', { indices, bytes }); return { ok: x.success, value: x } })
    if (!r.success) return fail(`Could not replace: ${r.error}`)
    structureChanged(s)
    return ok({ replaced: r.replaced, pages_now: s.pageCount })
  }))

  t.add('extract_pages', {
    title: 'Extract pages',
    description: 'Write some pages to a new PDF file (or one file per page with separate_files). Optionally delete them from this document afterwards.',
    input: {
      doc_id: docId, pages,
      output_path: z.string().describe('Absolute path of the new PDF; with separate_files, the folder (or a path whose folder is used)'),
      separate_files: z.boolean().optional(),
      delete_after: z.boolean().optional(),
      overwrite: z.boolean().optional()
    }
  }, (args) => t.doc(args, async (s) => {
    const indices = pagesOf(args.pages, s.pageCount, false)
    const out = resolvePath(args.output_path, 'output_path')
    const e = await s.eng()
    const written: string[] = []
    if (args.separate_files) {
      const dir = /\.pdf$/i.test(out) ? path.dirname(out) : out
      const base = path.basename(s.name, path.extname(s.name))
      for (const i of indices) {
        const r = await e.acro<Res>('extractPages', { indices: [i] })
        if (!r.success || !r.bytes) return fail(`Could not extract page ${i + 1}: ${r.error}`)
        const f = path.join(dir, `${base} - página ${i + 1}.pdf`)
        writeFileAtomic(f, r.bytes, !!args.overwrite)
        written.push(f)
      }
    } else {
      const r = await e.acro<Res>('extractPages', { indices })
      if (!r.success || !r.bytes) return fail(`Could not extract: ${r.error}`)
      const f = /\.pdf$/i.test(out) ? out : out + '.pdf'
      writeFileAtomic(f, r.bytes, !!args.overwrite)
      written.push(f)
    }
    let deleted = false
    if (args.delete_after) {
      if (indices.length >= s.pageCount) return ok({ written, note: 'all pages were extracted, so none were deleted from this document' })
      const r = await s.pageOp(async eng => { const x = await eng.acro<Res>('deletePages', { indices }); return { ok: x.success, value: x } })
      deleted = r.success
      structureChanged(s)
    }
    return ok({ extracted: pageRangeLabel(indices), written, ...(args.delete_after ? { deleted_from_document: deleted } : {}) })
  }))

  t.add('split_pdf', {
    title: 'Split PDF',
    description: 'Split the document into several PDF files: every N pages, or before given page numbers. The document itself is not changed.',
    input: {
      doc_id: docId,
      every: z.number().int().min(1).optional().describe('A new file every N pages'),
      before_pages: z.array(z.number().int().min(2)).optional().describe('Start a new file at each of these page numbers'),
      output_dir: z.string().describe('Absolute folder for the parts'),
      overwrite: z.boolean().optional()
    }
  }, (args) => t.doc(args, async (s) => {
    if (!args.every && !args.before_pages?.length) return fail('Give every or before_pages.')
    const dir = resolvePath(args.output_dir, 'output_dir')
    const e = await s.eng()
    const r = await e.acro<Res>('split', { every: args.every, at: (args.before_pages ?? []).map((p: number) => p - 1) })
    if (!r.success || !r.parts) return fail(`Could not split: ${r.error}`)
    fs.mkdirSync(dir, { recursive: true })
    const base = path.basename(s.name, path.extname(s.name))
    const written = r.parts.map((b, k) => {
      const f = path.join(dir, `${base} - parte ${k + 1}.pdf`)
      writeFileAtomic(f, b, !!args.overwrite)
      return f
    })
    return ok({ parts: written.length, written })
  }))

  t.add('crop_pages', {
    title: 'Crop pages',
    description: 'Trim margins off pages (in points; 1 cm ≈ 28.35 pt). The content outside is hidden, not deleted.',
    input: {
      doc_id: docId, pages,
      top: z.number().min(0).optional(), right: z.number().min(0).optional(),
      bottom: z.number().min(0).optional(), left: z.number().min(0).optional()
    }
  }, (args) => t.doc(args, async (s) => {
    const indices = pagesOf(args.pages, s.pageCount)
    const margins = { top: args.top ?? 0, right: args.right ?? 0, bottom: args.bottom ?? 0, left: args.left ?? 0 }
    if (!margins.top && !margins.right && !margins.bottom && !margins.left) return fail('Give at least one margin to crop.')
    const r = await s.pageOp(async e => { const x = await e.acro<Res>('cropPages', { indices, margins }); return { ok: x.success, value: x } })
    if (!r.success) return fail(`Could not crop: ${r.error}`)
    structureChanged(s)
    return ok({ cropped: pageRangeLabel(indices), margins })
  }))
}
