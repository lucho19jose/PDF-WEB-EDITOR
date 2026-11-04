/**
 * Editing the page's own text (the content stream, as Acrobat's "Editar PDF"
 * does). The rules are the in-app assistant's, each learned on real files:
 * a phrase can span several extraction blocks (`replaceAllSpans`); "change X
 * to Y" means every occurrence unless the user singled one out; edits on one
 * page go back to front, since a block id is its extraction index; and a
 * scanned page is refused, because invisible OCR text changed is a change
 * nobody can see.
 */
import { z } from 'zod'
import type { Registrar } from './registrar'
import type { BlockTransformOp, BlockStyleOp, TextBlock } from '../../../src/engine/types'
import type { DocumentSession } from '../session'
import { replaceAllSpans } from '../../../src/utils/assistant/spanEdits'
import { extractionIndex } from '../../../src/utils/assistant/anchors'
import { ok, fail, colorOf, pageIndexOf, pagesOf, base14, ToolError } from '../util'
import { kindOf, pageSize } from '../pageInfo'

const docId = z.string().optional().describe('Document id from open_pdf. Optional when only one document is open.')
const refs = z.array(z.string()).min(1).describe('Text references from list_page_text or find_text, e.g. ["p1b3","p1b4"]')

type ReplaceResult = { success: boolean; error?: string; substitutedFont?: string; lines?: number }

/** Every block reference, resolved and checked to be on one page. */
async function blocksOnOnePage(s: DocumentSession, list: string[], tool: string) {
  const resolved = []
  for (const r of list) resolved.push({ ref: r, ...(await s.resolveBlock(r)) })
  const pages = new Set(resolved.map(r => r.anchor.page))
  if (pages.size > 1) throw new ToolError(`${tool} works on one page at a time: call it once per page`)
  return { page: resolved[0].anchor.page, resolved }
}

export function registerTextTools(t: Registrar) {
  t.add('replace_text', {
    title: 'Replace text',
    description: 'Find a phrase and replace it — on one page, or in the whole document when page is omitted. Matching ignores case and line breaks, and a phrase split across lines or table cells is still found. Replaces EVERY occurrence unless occurrence is "first". An empty replacement deletes the phrase. The text keeps its font where the font has the glyphs; otherwise a standard font is substituted (reported). Scanned pages are skipped and listed.',
    input: {
      doc_id: docId,
      find: z.string().min(1).describe('The words to find, as they appear on the page'),
      replace: z.string().describe('The new words (empty to delete)'),
      page: z.number().int().min(1).optional().describe('Only this page; omit for the whole document'),
      occurrence: z.enum(['all', 'first']).optional().describe('Default "all"')
    }
  }, (args) => t.doc(args, async (s) => {
    const max = args.occurrence === 'first' ? 1 : Infinity
    const pages = args.page ? [pageIndexOf(args.page, s.pageCount)] : pagesOf('all', s.pageCount)
    const report: Record<string, unknown>[] = []
    const scanned: number[] = []
    const notes = new Set<string>()
    let total = 0
    let remaining = max
    await s.mutate(async (e) => {
      for (const p of pages) {
        if (remaining <= 0) break
        const k = await kindOf(s, p)
        const blocks = k.blocks.filter(b => !b.invisible && b.text.trim())
        if (k.kind === 'scan') {
          if (k.invisibleChars && (k.blocks.some(b => b.invisible && b.text.toLowerCase().includes(args.find.toLowerCase().trim())))) scanned.push(p + 1)
          continue
        }
        const { edits: raw, count } = replaceAllSpans(blocks.map(b => b.text), args.find, args.replace, remaining)
        if (!count) continue
        const edits = raw
          .map(x => ({ block: blocks[x.unit], newText: x.newText }))
          .filter(x => x.newText.replace(/\s+/g, ' ').trim() !== x.block.text.replace(/\s+/g, ' ').trim())
          .sort((a, b) => extractionIndex(b.block.id) - extractionIndex(a.block.id))
        let applied = 0
        const failed: string[] = []
        for (const x of edits) {
          const r = await e.send<ReplaceResult>('replaceText', { pageIndex: p, blockId: x.block.id, newText: x.newText.trim() })
          if (r.success) { applied++; if (r.substitutedFont) notes.add(`the original font lacked some characters, so ${r.substitutedFont} was used`) }
          else failed.push(`${JSON.stringify(x.block.text.slice(0, 60))}: ${r.error || 'no matching text in the content stream'}`)
        }
        if (applied || failed.length) report.push({ page: p + 1, occurrences: count, blocks_edited: applied, ...(failed.length ? { failed } : {}) })
        if (applied) { total += count; remaining -= count }
      }
      return { ok: report.some(r => (r.blocks_edited as number) > 0), value: null }
    })
    if (!report.length) {
      if (scanned.length) return fail(`"${args.find}" appears only on scanned page(s) ${scanned.join(', ')}, which cannot be edited as text here. Use open_in_editor to edit them in PDF Editor Pro (OCR).`)
      return fail(`"${args.find}" was not found${args.page ? ` on page ${args.page}` : ''}. Check the exact words with find_text or list_page_text.`)
    }
    const out: Record<string, unknown> = { replaced: args.find, with: args.replace, occurrences: total, pages: report }
    if (notes.size) out.note = [...notes].join('; ')
    if (scanned.length) out.not_changed_scanned_pages = scanned
    return ok(out)
  }))

  t.add('edit_text_block', {
    title: 'Edit text block',
    description: 'Rewrite one whole text block (a line or cell from list_page_text) with new text. Use "\\n" for a line break. Prefer replace_text to change a few words.',
    input: { doc_id: docId, ref: z.string().describe('Reference like "p1b12"'), new_text: z.string() }
  }, (args) => t.doc(args, async (s) => {
    const { anchor, block } = await s.resolveBlock(args.ref)
    let res: ReplaceResult | null = null
    await s.mutate(async (e) => {
      res = await e.send<ReplaceResult>('replaceText', { pageIndex: anchor.page, blockId: block.id, newText: args.new_text })
      return { ok: res.success, value: null }
    })
    const r = res as ReplaceResult | null
    if (!r?.success) return fail(`Could not edit ${args.ref}: ${r?.error || 'no matching text in the content stream'}`)
    anchor.text = (args.new_text as string).split('\n')[0]
    const out: Record<string, unknown> = { edited: args.ref, was: block.text, now: args.new_text }
    if (r.substitutedFont) out.note = `the original font lacked some characters, so ${r.substitutedFont} was used`
    if ((r.lines ?? 1) > 1) out.lines = r.lines
    return ok(out)
  }))

  t.add('delete_text', {
    title: 'Delete text',
    description: 'Remove whole text blocks from the page content.',
    input: { doc_id: docId, refs },
    destructive: true
  }, (args) => t.doc(args, async (s) => {
    const resolved: { page: number; block: TextBlock }[] = []
    for (const r of args.refs as string[]) { const x = await s.resolveBlock(r); resolved.push({ page: x.anchor.page, block: x.block }) }
    resolved.sort((a, b) => a.page - b.page || extractionIndex(b.block.id) - extractionIndex(a.block.id))
    let removed = 0
    const failed: string[] = []
    await s.mutate(async (e) => {
      for (const x of resolved) {
        const r = await e.send<ReplaceResult>('replaceText', { pageIndex: x.page, blockId: x.block.id, newText: '' })
        if (r.success) removed++; else failed.push(`${JSON.stringify(x.block.text.slice(0, 60))}: ${r.error}`)
      }
      return { ok: removed > 0, value: null }
    })
    if (!removed) return fail(`Could not delete: ${failed.join('; ')}`)
    return ok({ removed, ...(failed.length ? { failed } : {}) })
  }))

  t.add('transform_text', {
    title: 'Move or resize text',
    description: 'Move text blocks by dx, dy points (positive dy moves DOWN), and/or scale them (scale 1.2 = 20% larger, about their top-left corner). All refs must be on one page; they move together.',
    input: {
      doc_id: docId, refs,
      dx: z.number().optional(), dy: z.number().optional(),
      scale: z.number().min(0.1).max(10).optional()
    }
  }, (args) => t.doc(args, async (s) => {
    const dx = Number(args.dx) || 0, dy = Number(args.dy) || 0, sc = Number(args.scale) || 1
    if (!dx && !dy && sc === 1) return fail('Nothing to do: give dx, dy or scale.')
    const { page, resolved } = await blocksOnOnePage(s, args.refs, 'transform_text')
    const size = await pageSize(s, page)
    const x0 = Math.min(...resolved.map(r => r.block.bbox[0]))
    const y0 = Math.min(...resolved.map(r => r.block.bbox[1]))
    // Engine space is y-up: a move DOWN on the page is a negative dy there,
    // and the scale anchor (the selection's top-left) is pageHeight - top.
    const ops: BlockTransformOp[] = resolved.map(r => ({ blockId: r.block.id, dx, dy: -dy, sx: sc, sy: sc, anchorX: x0, anchorY: size.height - y0 }))
    let res: { results: { success: boolean; error?: string }[]; applied: number } = { results: [], applied: 0 }
    await s.mutate(async (e) => {
      res = await e.send('transformTextBlocks', { pageIndex: page, ops })
      return { ok: res.applied > 0, value: null }
    })
    if (!res.applied) return fail(`Could not move the text: ${res.results.map(r => r.error).filter(Boolean).join('; ') || 'no matching text in the content stream'}`)
    for (const r of resolved) {
      r.anchor.cx = x0 + (r.anchor.cx - x0) * sc + dx
      r.anchor.cy = y0 + (r.anchor.cy - y0) * sc + dy
    }
    const failed = res.results.map((r, i) => r.success ? null : `${resolved[i].ref}: ${r.error}`).filter(Boolean)
    return ok({ transformed: res.applied, dx, dy, scale: sc, ...(failed.length ? { failed } : {}) })
  }))

  t.add('restyle_text', {
    title: 'Restyle text',
    description: 'Change the font size, colour or font family of text blocks (one page at a time). Size and colour keep the original font and spacing; a family change redraws the text in a standard font.',
    input: {
      doc_id: docId, refs,
      font_size: z.number().min(2).max(300).optional(),
      color: z.string().optional().describe('Hex colour, e.g. #c00000'),
      font: z.enum(['Helvetica', 'Times-Roman', 'Courier']).optional()
    }
  }, (args) => t.doc(args, async (s) => {
    const style: Omit<BlockStyleOp, 'blockId'> = {}
    if (args.font_size != null) style.fontSize = args.font_size
    if (args.color != null) style.color = colorOf(args.color, '#000000')
    if (args.font != null) style.fontName = args.font
    if (!Object.keys(style).length) return fail('Nothing to change: give font_size, color or font.')
    const { page, resolved } = await blocksOnOnePage(s, args.refs, 'restyle_text')
    let res: { results: { success: boolean; error?: string }[]; applied: number } = { results: [], applied: 0 }
    await s.mutate(async (e) => {
      res = await e.send('restyleTextBlocks', { pageIndex: page, ops: resolved.map(r => ({ blockId: r.block.id, ...style })) })
      return { ok: res.applied > 0, value: null }
    })
    if (!res.applied) return fail(`Could not restyle: ${res.results.map(r => r.error).filter(Boolean).join('; ') || 'the block holds more than the target'}`)
    const failed = res.results.map((r, i) => r.success ? null : `${resolved[i].ref}: ${r.error}`).filter(Boolean)
    return ok({ restyled: res.applied, ...(failed.length ? { failed } : {}) })
  }))

  t.add('add_text', {
    title: 'Add text',
    description: 'Write new text into the page content at x, y (points from the top-left corner; y is the TOP of the text). Use "\\n" for more lines. Works on scanned pages too (drawn over the image). For a movable text box use add_free_text instead.',
    input: {
      doc_id: docId,
      page: z.number().int().min(1),
      x: z.number(), y: z.number(),
      text: z.string().min(1),
      font_size: z.number().min(2).max(300).optional().describe('Default 11'),
      color: z.string().optional().describe('Hex colour, default #000000'),
      font: z.enum(['Helvetica', 'Times', 'Courier']).optional(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional()
    }
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    const size = args.font_size ?? 11
    const color = colorOf(args.color, '#000000')
    const font = base14(args.font, !!args.bold, !!args.italic)
    const h = (await pageSize(s, p)).height
    const lines = String(args.text).split(/\r?\n/)
    let error = ''
    await s.mutate(async (e) => {
      for (const [i, line] of lines.entries()) {
        if (!line.trim()) continue
        // The engine takes PDF space (y up) and a BASELINE; y given is the top of the first line.
        const baseline = h - args.y - size * 0.8 - i * size * 1.25
        const r = await e.send<{ success: boolean; error?: string }>('addText', { pageIndex: p, x: args.x, y: baseline, text: line, fontSize: size, fontName: font, color })
        if (!r.success) { error = r.error || 'unknown error'; return { ok: false, value: null } }
      }
      return { ok: true, value: null }
    })
    if (error) return fail(`Could not add the text: ${error}`)
    return ok({ added: args.text, page: p + 1, x: args.x, y: args.y, font, font_size: size })
  }))
}
