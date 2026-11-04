/**
 * Scanned pages, edited the way the app edits them: recognised (PaddleOCR,
 * the app's models), then changed ON the scan — the letters a line keeps
 * stay the scan's pixels, the ones it gains are the page's own letters or a
 * face fitted to the scan — with the new words as invisible text so the page
 * still searches and copies. Painting a white box over a scan and typing on
 * it is what this replaces: the result shows a foreign face and cuts through
 * whatever rule or frame the box covers.
 *
 * The OCR runtime (mcp/src/ocr/runtime.ts → dist-mcp/ocr/ocr.mjs) is loaded
 * on first use.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { Registrar } from './registrar'
import type { DocumentSession } from '../session'
import type { ScanDoc, ApplyOutcome } from '../ocr/runtime'
import { replaceAllSpans } from '../../../src/utils/assistant/spanEdits'
import { ok, fail, pageIndexOf, ToolError } from '../util'

const docId = z.string().optional().describe('Document id from open_pdf. Optional when only one document is open.')

type Runtime = typeof import('../ocr/runtime')
let runtime: Promise<Runtime> | null = null
/** The OCR bundle beside server.mjs (PDF_MCP_OCR overrides, for tests). */
export function loadOcr(): Promise<Runtime> {
  runtime ??= (async () => {
    const file = process.env.PDF_MCP_OCR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'ocr', 'ocr.mjs')
    try {
      return await import(/* @vite-ignore */ pathToFileURL(file).href) as Runtime
    } catch (err: any) {
      runtime = null
      throw new ToolError(`Text recognition is not available in this installation (${err?.message || err}). Use open_in_editor to edit scanned pages in PDF Editor Pro.`)
    }
  })()
  return runtime
}

/** The document's scan state, attached on first use (its undo entries carry it from then on). */
export async function scanDocOf(s: DocumentSession): Promise<ScanDoc> {
  if (s.scanDoc) return s.scanDoc as ScanDoc
  const rt = await loadOcr()
  const doc = new rt.ScanDoc(() => s.eng())
  s.scanDoc = doc
  s.extra = { capture: () => doc.capture(), restore: v => doc.restore(v as any), reset: () => doc.forget() }
  return doc
}

/** The page recognised (once; again with `force`). */
export async function ensureRecognized(s: DocumentSession, page: number, force = false) {
  const doc = await scanDocOf(s)
  if (doc.has(page) && !force) return { doc, fresh: null }
  const fresh = await doc.recognize(page, msg => console.error(`[pdf-editor-mcp] page ${page + 1}: ${msg}`))
  return { doc, fresh }
}

/** One undoable change: the runs' new texts drawn on the page's scan. */
export async function applyScanEdits(s: DocumentSession, page: number, changes: { ref: string; text: string }[]): Promise<ApplyOutcome[]> {
  const doc = await scanDocOf(s)
  let outcomes: ApplyOutcome[] = []
  let drew = false
  await s.mutate(async () => {
    const r = await doc.edit(page, changes)
    outcomes = r.outcomes
    drew = r.ok
    return { ok: r.ok, value: null }
  })
  if (drew) await doc.recordHash(page)
  return outcomes
}

/** Outcomes for the model: what was drawn on the scan, what could not be and why. */
export function describeOutcomes(outcomes: ApplyOutcome[]) {
  const drawn = outcomes.filter(o => o.drawn).map(o => ({ ref: o.ref, now: o.text || '(removed)', how: o.how }))
  const notDrawn = outcomes.filter(o => !o.drawn).map(o => ({ ref: o.ref, wanted: o.text || '(remove)', why: o.how }))
  return { drawn, notDrawn }
}

export function registerScanTools(t: Registrar) {
  t.add('recognize_page', {
    title: 'Recognise a scanned page',
    description: 'Read the words of a SCANNED page (OCR, on this computer) so they can be edited with edit_scanned_text or replace_text. Returns the page\'s text runs (lines or table cells) with references like "p1r4", their text, confidence (0-100) and box in points from the top-left corner. Takes a few seconds per page. Readings are checked against the page\'s own letters, but a low-confidence run may still be misread: compare with render_page before editing it.',
    input: { doc_id: docId, page: z.number().int().min(1), again: z.boolean().optional().describe('Recognise again even if already done') },
    readOnly: true
  }, (args) => t.doc(args, async (s) => {
    const page = pageIndexOf(args.page, s.pageCount)
    const { doc, fresh } = await ensureRecognized(s, page, !!args.again)
    // One line per run — "p1r4 | 98% | 39,153,104,159 | text" — a page holds a hundred of them.
    const runs = doc.runs(page).map(r => `${r.ref} | ${r.confidence}% | ${r.box.map(Math.round).join(',')} | ${r.text}${r.edited ? ' (edited)' : ''}${r.editable ? ` (cannot be edited on the scan: ${r.editable})` : ''}`)
    const out: Record<string, unknown> = { page: args.page, format: 'ref | confidence | box x0,y0,x1,y1 in points from the top-left | text', runs }
    if (fresh) {
      out.recognised_in_s = Math.round(fresh.ms / 100) / 10
      if (fresh.repaired) out.note = `${fresh.repaired} line(s) were re-read from the page's own letters (the recogniser had dropped spaces or letters).`
      if (fresh.scan) out.warning = `${fresh.scan}: the words can be read, but edits cannot be drawn on this page's scan.`
    }
    if (!runs.length) out.note = 'No text was found on this page.'
    return ok(out)
  }))

  t.add('edit_scanned_text', {
    title: 'Edit scanned text',
    description: 'Change, rewrite or delete runs of a SCANNED page (references from recognize_page). The edit is made on the scan itself, as PDF Editor Pro does it: letters that stay are the scan\'s own pixels, new letters are copied from the page\'s own letters (or drawn in a face fitted to the scan), and the new words are added as invisible text so the page still searches and copies. Give each run\'s complete new text; "" deletes the run. Runs the scan edit cannot draw are left unchanged and reported with the reason. Check the result with render_page.',
    input: {
      doc_id: docId,
      page: z.number().int().min(1),
      edits: z.array(z.object({ ref: z.string().describe('Run reference like "p1r4"'), text: z.string().describe('The run\'s complete new text; "" deletes it') })).min(1)
    },
    destructive: false
  }, (args) => t.doc(args, async (s) => {
    const page = pageIndexOf(args.page, s.pageCount)
    const doc = await scanDocOf(s)
    if (!doc.has(page)) throw new ToolError(`Page ${args.page} has not been recognised: call recognize_page first and use its references.`)
    for (const e of args.edits) {
      if (!String(e.ref).startsWith(`p${page + 1}r`)) throw new ToolError(`${e.ref} is not a run of page ${args.page}`)
      if (!doc.item(page, e.ref)) throw new ToolError(`Unknown run ${e.ref} on page ${args.page}. Call recognize_page and use the references it returns.`)
    }
    const { drawn, notDrawn } = describeOutcomes(await applyScanEdits(s, page, args.edits))
    if (!drawn.length) return fail(`Nothing could be drawn on the scan: ${notDrawn.map(n => `${n.ref}: ${n.why}`).join('; ')}. The page is unchanged.`)
    return ok({ page: args.page, drawn, ...(notDrawn.length ? { not_drawn: notDrawn } : {}), next: 'Check it with render_page (a region around the edit at 150 dpi shows the letters).' })
  }))
}

/**
 * `replace_text` on a scanned page: recognised if needed, the phrase found
 * across its runs (`replaceAllSpans`, as on a text page), drawn on the scan.
 */
export async function replaceOnScan(s: DocumentSession, page: number, find: string, replace: string, max: number) {
  const { doc } = await ensureRecognized(s, page)
  const runs = doc.runs(page)
  const { edits, count } = replaceAllSpans(runs.map(r => r.text), find, replace, max)
  if (!count) return { count: 0, outcomes: [] as ApplyOutcome[] }
  const changes = edits
    .map(x => ({ ref: runs[x.unit].ref, text: x.newText.replace(/\s+/g, ' ').trim() }))
    .filter(c => c.text !== runs.find(r => r.ref === c.ref)!.text)
  if (!changes.length) return { count, outcomes: [] as ApplyOutcome[] }
  return { count, outcomes: await applyScanEdits(s, page, changes) }
}
