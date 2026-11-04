/** Exportar archivo PDF: Word, Excel, text, HTML, or page images — the app's own converters. */
import path from 'node:path'
import { z } from 'zod'
import type { Registrar } from './registrar'
import type { SheetPageData } from '../../../src/engine/worker/sheetExtract'
import { buildDocx, type StPage } from '../../../src/utils/acro/docx'
import { buildXlsx } from '../../../src/utils/acro/xlsx'
import { sheetsFor, scannedNote } from '../../../src/utils/acro/sheetExport'
import { ok, pagesOf, resolvePath, writeFileAtomic } from '../util'

const docId = z.string().optional().describe('Document id from open_pdf. Optional when only one document is open.')
const EXT: Record<string, string> = { docx: '.docx', xlsx: '.xlsx', txt: '.txt', html: '.html', png: '.png', jpeg: '.jpg' }

export function registerExportTools(t: Registrar) {
  t.add('export_pdf', {
    title: 'Export PDF',
    description: 'Convert the document to Microsoft Word (docx), Microsoft Excel (xlsx — tables rebuilt from the page\'s words and rules), plain text, HTML, or PNG/JPEG images (one file per page). Scanned pages hold no text to convert: run OCR in PDF Editor Pro first (open_in_editor).',
    input: {
      doc_id: docId,
      format: z.enum(['docx', 'xlsx', 'txt', 'html', 'png', 'jpeg']),
      output_path: z.string().describe('Absolute path of the file to write (for images: the first file, or a folder)'),
      pages: z.string().optional().describe('Pages for xlsx/png/jpeg, e.g. "1-3"; default all'),
      dpi: z.number().min(36).max(600).optional().describe('Images: resolution, default 150'),
      sheet_mode: z.enum(['page', 'single']).optional().describe('Excel: one worksheet per page (default) or one for the whole document'),
      convert_values: z.boolean().optional().describe('Excel: turn amounts, percentages and dates into numbers (default true)'),
      overwrite: z.boolean().optional()
    }
  }, (args) => t.doc(args, async (s) => {
    const e = await s.eng()
    const fmt = args.format as string
    let out = resolvePath(args.output_path, 'output_path')
    const base = path.basename(s.name, path.extname(s.name))
    const imageFolder = (fmt === 'png' || fmt === 'jpeg') && !/\.(png|jpe?g)$/i.test(out)
    if (!imageFolder && path.extname(out).toLowerCase() !== EXT[fmt] && !(fmt === 'jpeg' && /\.jpe?g$/i.test(out))) out += EXT[fmt]
    const write = (p: string, b: ArrayBuffer | Uint8Array) => writeFileAtomic(p, b, !!args.overwrite)
    const res: Record<string, unknown> = { format: fmt }

    if (fmt === 'docx') {
      const pages = await e.acro<StPage[]>('exportStructured')
      write(out, new Uint8Array(await buildDocx(pages, base).arrayBuffer()))
    } else if (fmt === 'xlsx') {
      const list = pagesOf(args.pages, s.pageCount)
      const data: SheetPageData[] = []
      for (const i of list) data.push(await e.acro<SheetPageData>('sheetPage', { pageIndex: i }))
      const { sheets, still } = sheetsFor(data, list, base, args.sheet_mode ?? 'page')
      const blob = await buildXlsx(sheets, { convertValues: args.convert_values !== false, title: base })
      write(out, new Uint8Array(await blob.arrayBuffer()))
      if (still.length) res.note = scannedNote(still)
    } else if (fmt === 'txt') {
      const text = await e.acro<string>('exportText')
      write(out, new TextEncoder().encode('﻿' + text))
    } else if (fmt === 'html') {
      const html = await e.acro<string>('exportHtml')
      const esc = base.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
      const doc = `<!DOCTYPE html>\n<html lang="es"><head><meta charset="utf-8"><title>${esc}</title>` +
        `<style>body{background:#525659;margin:0;padding:24px}div[id^=page]{position:relative;background:#fff;margin:0 auto 24px;box-shadow:0 2px 8px rgba(0,0,0,.4)}p{position:absolute;margin:0;white-space:pre}</style></head><body>\n${html}\n</body></html>`
      write(out, new TextEncoder().encode(doc))
    } else {
      const list = pagesOf(args.pages, s.pageCount)
      const scale = (args.dpi ?? 150) / 72
      const ext = fmt === 'png' ? 'png' : 'jpg'
      const written: string[] = []
      for (const i of list) {
        const bytes = await e.acro<ArrayBuffer>('renderImage', { pageIndex: i, scale, format: fmt, quality: 90 })
        const f = imageFolder
          ? path.join(out, `${base}_Página_${i + 1}.${ext}`)
          : list.length === 1 ? out : path.join(path.dirname(out), `${path.basename(out, path.extname(out))}_${i + 1}.${ext}`)
        write(f, bytes)
        written.push(f)
      }
      res.written = written
      return ok(res)
    }
    res.written = out
    return ok(res)
  }))
}
