/** Opening, creating, combining, saving and closing documents; undo; the editor hand-off. */
import path from 'node:path'
import { z } from 'zod'
import type { Registrar } from './registrar'
import type { DocumentSession } from '../session'
import { ok, fail, resolvePath, readFileBytes, writeFileAtomic, editedPathFor, isImagePath, ToolError } from '../util'
import { kindOf } from '../pageInfo'
import { openInApp } from '../openInEditor'

const docId = z.string().optional().describe('Document id from open_pdf (e.g. "d1"). Optional when only one document is open.')

const PAPER: Record<string, [number, number]> = { A4: [595.28, 841.89], Letter: [612, 792], Legal: [612, 1008], A3: [841.89, 1190.55], A5: [419.53, 595.28] }

function isPdf(b: ArrayBuffer): boolean {
  const head = Buffer.from(b.slice(0, 1024)).toString('latin1')
  return head.includes('%PDF-')
}

/** What a model needs to know about a document right after opening it. */
export async function summary(s: DocumentSession, kinds = true) {
  const e = await s.eng()
  const first = await e.send<{ width: number; height: number; rotation: number }>('getPageSize', { pageIndex: 0 })
  const sigs = await e.send<{ signatures: unknown[] }>('getSignatures').catch(() => ({ signatures: [] }))
  const out: Record<string, unknown> = {
    doc_id: s.id,
    name: s.name,
    path: s.path,
    pages: s.pageCount,
    page_size: `${Math.round(first.width)} x ${Math.round(first.height)} pt`,
    unsaved_changes: s.dirty
  }
  if (sigs.signatures.length) out.digital_signatures = `${sigs.signatures.length} (edits are saved incrementally so the signed revision stays verifiable, but readers will report changes after signing)`
  if (kinds) {
    const scanned: number[] = []
    const n = Math.min(s.pageCount, 60)
    for (let p = 0; p < n; p++) if ((await kindOf(s, p)).kind === 'scan') scanned.push(p + 1)
    if (scanned.length) out.scanned_pages = scanned.length === n && n === s.pageCount ? 'all' : scanned
    if (s.pageCount > n) out.note = `only the first ${n} pages were checked for scans`
  }
  return out
}

async function pdfBytesFor(t: Registrar, file: string): Promise<ArrayBuffer> {
  const raw = readFileBytes(file)
  if (isImagePath(file)) {
    const r = await t.scratch().acro<{ success: boolean; bytes?: ArrayBuffer; error?: string }>('createPdf', { images: [raw] })
    if (!r.success || !r.bytes) throw new ToolError(`${path.basename(file)}: ${r.error || 'could not make a page from this image'}`)
    return r.bytes
  }
  if (!isPdf(raw)) throw new ToolError(`${file} is not a PDF or an image (PNG, JPEG, GIF, BMP, TIFF)`)
  if (await t.scratch().acro<boolean>('needsPassword', { bytes: raw })) throw new ToolError(`${path.basename(file)} is password-protected: open it with open_pdf and its password first, save it, and use that copy.`)
  return raw
}

export function registerDocumentTools(t: Registrar) {
  t.add('open_pdf', {
    title: 'Open PDF',
    description: 'Open a PDF file from disk to read or edit it. Returns a doc_id used by every other tool, the page count, and which pages are scans (images of text, which cannot be edited as text here). Opening the same path again returns the already-open document.',
    input: {
      path: z.string().describe('Absolute path of the PDF, e.g. C:\\Users\\me\\Documents\\contrato.pdf'),
      password: z.string().optional().describe('Password, if the PDF is protected')
    }
  }, async ({ path: p, password }) => {
    const file = resolvePath(p)
    const open = t.mgr.byPath(file)
    if (open) return ok({ already_open: true, ...(await open.run(() => summary(open))) })
    let bytes = readFileBytes(file)
    if (isImagePath(file)) return fail(`${file} is an image, not a PDF. Use create_pdf with images: ["${file}"] to make a PDF from it.`)
    if (!isPdf(bytes)) return fail(`${file} is not a PDF file.`)
    let unlocked = false
    if (await t.scratch().acro<boolean>('needsPassword', { bytes })) {
      if (!password) return fail(`${path.basename(file)} is password-protected. Ask the user for the password and call open_pdf again with it.`)
      const r = await t.scratch().acro<{ success: boolean; bytes?: ArrayBuffer; error?: string }>('unlock', { bytes, password })
      if (!r.success || !r.bytes) return fail(`Wrong password for ${path.basename(file)}.`)
      bytes = r.bytes
      unlocked = true
    }
    const s = t.mgr.open(path.basename(file), bytes, file)
    try {
      const info = await s.run(() => summary(s))
      if (unlocked) info.protection = 'opened with its password; saving writes it WITHOUT protection unless save_pdf is given a password again'
      return ok(info)
    } catch (err) {
      await t.mgr.close(s)
      throw err
    }
  })

  t.add('list_documents', {
    title: 'List open documents',
    description: 'The documents open in this session, with their ids, paths and whether they have unsaved changes.',
    input: {},
    readOnly: true
  }, async () => ok({
    documents: t.mgr.list().map(s => ({ doc_id: s.id, name: s.name, path: s.path, pages: s.pageCount, unsaved_changes: s.dirty }))
  }))

  t.add('create_pdf', {
    title: 'Create PDF',
    description: 'Create a new PDF from images (one page per image, in order) or as blank pages. The new document is open but not saved: give output_path to save it at once, or call save_pdf later.',
    input: {
      images: z.array(z.string()).optional().describe('Absolute paths of images (PNG, JPEG, GIF, BMP, TIFF), one page each'),
      blank_pages: z.number().int().min(1).max(500).optional().describe('Number of blank pages, when not making it from images'),
      size: z.enum(['A4', 'Letter', 'Legal', 'A3', 'A5']).optional().describe('Paper size of blank pages (default A4)'),
      landscape: z.boolean().optional(),
      output_path: z.string().optional().describe('Absolute path to save the new PDF to')
    }
  }, async ({ images, blank_pages, size, landscape, output_path }) => {
    const scratch = t.scratch()
    let r: { success: boolean; bytes?: ArrayBuffer; error?: string }
    if (images?.length) {
      const bufs = images.map((p: string) => readFileBytes(resolvePath(p, 'image path')))
      r = await scratch.acro('createPdf', { images: bufs })
    } else {
      let [w, h] = PAPER[size || 'A4']
      if (landscape) [w, h] = [h, w]
      r = await scratch.acro('createPdf', { images: [], blank: { width: w, height: h } })
      if (r.success && r.bytes && (blank_pages ?? 1) > 1) {
        const tmp = t.mgr.open('new', r.bytes, null)
        try {
          await tmp.run(async () => {
            await tmp.mutate(async e => {
              for (let i = 1; i < blank_pages!; i++) await e.send('insertBlankPage', { atIndex: i, width: w, height: h })
              return { ok: true, value: null }
            })
          })
          r = { success: true, bytes: tmp.bytes }
        } finally { await t.mgr.close(tmp) }
      }
    }
    if (!r.success || !r.bytes) return fail(`Could not create the PDF: ${r.error || 'unknown error'}`)
    const name = output_path ? path.basename(output_path) : 'Nuevo documento.pdf'
    const s = t.mgr.open(name, r.bytes, null)
    s.dirty = true
    if (output_path) {
      const out = resolvePath(output_path, 'output_path')
      writeFileAtomic(out, r.bytes, false)
      s.path = out; s.dirty = false; s.stampDisk()
    }
    return ok(await s.run(() => summary(s, false)))
  })

  t.add('combine_files', {
    title: 'Combine files',
    description: 'Combine several PDFs and images into ONE new PDF, in the order given (Acrobat\'s "Combinar archivos"). Each image becomes a page. The result opens as a new document; give output_path to save it at once.',
    input: {
      paths: z.array(z.string()).min(2).describe('Absolute paths of the PDFs and images, in order'),
      output_path: z.string().optional().describe('Absolute path to save the combined PDF to')
    }
  }, async ({ paths, output_path }) => {
    const files: ArrayBuffer[] = []
    for (const p of paths as string[]) files.push(await pdfBytesFor(t, resolvePath(p)))
    const r = await t.scratch().acro<{ success: boolean; bytes?: ArrayBuffer; error?: string; fileIndex?: number }>('combinePdf', { files })
    if (!r.success || !r.bytes) return fail(`Could not combine: ${r.error || 'unknown error'}${r.fileIndex !== undefined ? ` (file ${r.fileIndex + 1}: ${paths[r.fileIndex]})` : ''}`)
    const name = output_path ? path.basename(output_path) : 'Combinados.pdf'
    const s = t.mgr.open(name, r.bytes, null)
    s.dirty = true
    if (output_path) {
      const out = resolvePath(output_path, 'output_path')
      writeFileAtomic(out, r.bytes, false)
      s.path = out; s.dirty = false; s.stampDisk()
    }
    return ok({ combined: paths.length, ...(await s.run(() => summary(s, false))) })
  })

  t.add('save_pdf', {
    title: 'Save PDF',
    description: 'Save the document. With no path it is written NEXT TO the original as "<name> (editado).pdf" — the original is only replaced with overwrite: true. Optionally protect it with a password (AES-256) and restrict printing, copying, editing or commenting.',
    input: {
      doc_id: docId,
      path: z.string().optional().describe('Absolute path to write to. Default: "<original name> (editado).pdf" beside the original'),
      overwrite: z.boolean().optional().describe('Allow replacing an existing file (including the original)'),
      password: z.string().optional().describe('Password needed to open the saved file'),
      owner_password: z.string().optional().describe('Password that lifts the restrictions'),
      allow_print: z.boolean().optional(),
      allow_copy: z.boolean().optional(),
      allow_modify: z.boolean().optional(),
      allow_annotate: z.boolean().optional()
    },
    destructive: true
  }, (args) => t.doc(args, async (s) => {
    let target: string
    if (args.path) target = resolvePath(args.path)
    else if (s.path) target = editedPathFor(s.path)
    else return fail('This document has never been saved: give path (an absolute path ending in .pdf).')
    if (!/\.pdf$/i.test(target)) target += '.pdf'
    const protect = args.password || args.owner_password || [args.allow_print, args.allow_copy, args.allow_modify, args.allow_annotate].some((v: unknown) => v === false)
    let bytes: ArrayBuffer = s.bytes
    if (protect) {
      const e = await s.eng()
      bytes = await e.acro<ArrayBuffer>('saveProtected', {
        userPassword: args.password || undefined,
        ownerPassword: args.owner_password || args.password || undefined,
        permissions: { print: args.allow_print !== false, copy: args.allow_copy !== false, modify: args.allow_modify !== false, annotate: args.allow_annotate !== false }
      })
    }
    writeFileAtomic(target, bytes, !!args.overwrite)
    s.path = target
    s.name = path.basename(target)
    s.dirty = false
    s.stampDisk()
    return ok({ saved: target, bytes: bytes.byteLength, pages: s.pageCount, protected: !!protect })
  }))

  t.add('close_pdf', {
    title: 'Close PDF',
    description: 'Close a document. Refuses when it has unsaved changes unless discard_changes is true.',
    input: { doc_id: docId, discard_changes: z.boolean().optional() },
    destructive: true
  }, async (args) => {
    const s = t.mgr.get(args.doc_id)
    if (s.dirty && !args.discard_changes) return fail(`${s.name} has unsaved changes. Save it with save_pdf, or pass discard_changes: true to close it anyway.`)
    await t.mgr.close(s)
    return ok({ closed: s.id, name: s.name })
  })

  t.add('undo', {
    title: 'Undo',
    description: 'Undo the last change(s) to a document (every edit tool call is one step).',
    input: { doc_id: docId, steps: z.number().int().min(1).max(50).optional() }
  }, (args) => t.doc(args, async (s) => {
    let n = 0
    for (let i = 0; i < (args.steps ?? 1); i++) if (await s.undoOnce()) n++; else break
    s.clearAnchors()
    if (!n) return fail('Nothing to undo.')
    return ok({ undone: n, ...s.history, note: 'references were cleared; list the page again' })
  }))

  t.add('redo', {
    title: 'Redo',
    description: 'Redo change(s) undone with undo.',
    input: { doc_id: docId, steps: z.number().int().min(1).max(50).optional() }
  }, (args) => t.doc(args, async (s) => {
    let n = 0
    for (let i = 0; i < (args.steps ?? 1); i++) if (await s.redoOnce()) n++; else break
    s.clearAnchors()
    if (!n) return fail('Nothing to redo.')
    return ok({ redone: n, ...s.history })
  }))

  t.add('open_in_editor', {
    title: 'Open in PDF Editor Pro',
    description: 'Show the document to the user in the PDF Editor Pro app, as a new tab. Unsaved changes are saved first (to path, or beside the original as "(editado)"). Use it for what only the editor can do — recognising and editing SCANNED pages (OCR), drawing, signing by hand — or so the user can review the result. Changes the user saves in the app over this file are picked up by the next tool call.',
    input: {
      doc_id: docId,
      path: z.string().optional().describe('Where to save before opening, when there are unsaved changes (absolute path)')
    }
  }, (args) => t.doc(args, async (s) => {
    let file = s.path
    if (s.dirty || !file) {
      const target = args.path ? resolvePath(args.path) : file ? editedPathFor(file) : null
      if (!target) return fail('This document has never been saved: give path, where to save it before opening.')
      // Never overwrites: to replace a file, the model calls save_pdf with overwrite first.
      writeFileAtomic(target, s.bytes, false)
      s.path = target; s.name = path.basename(target); s.dirty = false; s.stampDisk()
      file = target
    }
    const r = openInApp(file!)
    if (!r.ok) return fail(r.error)
    return ok({ opened_in_editor: file, note: 'The document opens as a tab in PDF Editor Pro. If the user edits it there, they should save it over this same file so the next tool call here picks the changes up.' })
  }))
}
