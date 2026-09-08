import { ref, type Ref } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { useOcrStore } from '@/stores/ocr'
import type { usePDFEngine } from '@/composables/usePDFEngine'
import type { useOCR } from '@/composables/useOCR'
import type { TextBlock, BlockTransformOp, BlockStyleOp, Quad } from '@/engine/types'
import type { OcrTextItem } from '@/utils/ocr/ocrTypes'
import { enqueueOp, beginTransaction } from '@/utils/opQueue'
import { hexToRgb01 } from '@/utils/color'
import { chatCompletion, type ChatMessage, type ToolCall } from '@/utils/assistant/openaiClient'
import { ASSISTANT_TOOLS, ASSISTANT_SYSTEM_PROMPT } from '@/utils/assistant/assistantTools'

/**
 * The editing assistant: a chat whose replies are tool calls against the
 * engine.
 *
 * It is created ONCE by EditorLayout with the layout's own plumbing —
 * `syncAfterEdit`, `pushUndo`, the page operations, the OCR controller —
 * because those are the functions every mutation in this app already goes
 * through, and a second copy of the save→reload dance would drift from the
 * first. The panel only renders `messages` and calls `send`.
 *
 * Three invariants the executor keeps, each learned elsewhere in this app:
 *
 * - A block reference the model was shown is an ANCHOR (text + centre), never
 *   a block id: ids are extraction indices and are renumbered by every
 *   save→reload, and an edit that lands on a renumbered id silently rewrites
 *   the wrong paragraph. `resolveRef` re-fetches and matches the way
 *   TextBlockOverlay's `findByAnchor` does.
 * - Every mutation is one queued op: engine call, THEN the undo snapshot
 *   (docStore.pdfBytes still holds the pre-edit bytes until the reload), then
 *   `syncAfterEdit`. A whole user request holds a transaction so a Ctrl+Z
 *   cannot swap the document out between two of its tool calls.
 * - Coordinates shown to the model are page space (top-left, y down, points),
 *   the space `TextBlock.bbox`, `SearchHit.rect` and every annotation rect
 *   already use; `addText` (y up) and `transformTextBlocks` (Tm space, y up)
 *   are converted here, at the one place that knows both conventions.
 */
export interface AssistantDeps {
  pdfEngine: ReturnType<typeof usePDFEngine>
  ocr: ReturnType<typeof useOCR>
  syncAfterEdit: () => Promise<void>
  pushUndo: () => void
  forgetOcr: () => void
  recognise: (pageIndex: number) => Promise<void>
  isScanLike: (pageIndex: number) => Promise<boolean>
  undo: () => Promise<void>
  rotatePage: (degrees: number) => Promise<void>
  deletePage: () => Promise<void>
  duplicatePage: () => Promise<void>
  insertBlankPage: () => Promise<void>
  movePage: (from: number, to: number) => Promise<void>
  /** Ask once per session whether the page text may be sent to OpenAI. */
  confirmCloud: () => Promise<boolean>
}

export interface AssistantMessage {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'error'
  text: string
  /** For tool lines: whether the call succeeded. */
  ok?: boolean
}

interface Anchor {
  kind: 'block' | 'ocr'
  pageIndex: number
  text: string
  cx: number
  cy: number
  /** OCR runs keep a stable id; blocks do not. */
  ocrId?: string
}

/** Rounds of tool calls one user message may take before the loop stops. */
const MAX_ROUNDS = 8
/** Characters of page listing sent per turn. */
const LISTING_CAP = 12000
/** Conversation kept for the model (user/assistant/tool entries). */
const HISTORY_CAP = 40

let msgSeq = 0

export function createAssistant(deps: AssistantDeps) {
  const docStore = useDocumentStore()
  const editorStore = useEditorStore()
  const ocrStore = useOcrStore()

  const messages: Ref<AssistantMessage[]> = ref([])
  const busy = ref(false)
  const lastError = ref<string | null>(null)
  let history: ChatMessage[] = []
  const anchors = new Map<string, Anchor>()
  let consentGiven = false
  let abort: AbortController | null = null

  function push(role: AssistantMessage['role'], text: string, ok?: boolean) {
    messages.value.push({ id: ++msgSeq, role, text, ok })
  }

  function clear() {
    messages.value = []
    history = []
    anchors.clear()
    lastError.value = null
  }

  function cancel() {
    abort?.abort()
  }

  // ── Listing: what the model is shown ──

  function refFor(kind: Anchor['kind'], pageIndex: number, index: number) {
    return `p${pageIndex + 1}${kind === 'block' ? 'b' : 'r'}${index}`
  }

  function fmt(n: number) { return Math.round(n) }

  /** Register the page's blocks (or OCR runs) as references and render the listing. */
  /**
   * How a page's text can be edited.
   *
   * - `ocr`: the page has recognised OCR runs in the store — edit those.
   * - `scan`: the words the user sees are a SCANNED IMAGE. A searchable OCR
   *   layer (Acrobat's "Reconocer texto", or this app's own) draws them as
   *   INVISIBLE text that `replaceText` cannot change into view, and a bare
   *   image has no text at all. Either way the only way to edit what is seen
   *   is the OCR flow: recognise, edit the runs, bake on save.
   * - `text`: genuine editable content-stream text.
   *
   * `isScanLike` alone is not enough: on an Intellisign-signed contract a few
   * visible stamp blocks ("Intellisign ID…") give the page enough characters
   * and coverage to be judged a text page, while its whole body is an
   * invisible layer. The ratio of invisible to visible text is the signal
   * that survives that — measured, page 3 of contrato111 has ~2000 invisible
   * characters against ~120 visible.
   */
  async function pageMode(pageIndex: number): Promise<{ mode: 'ocr' | 'scan' | 'text'; runs?: OcrTextItem[]; visible?: TextBlock[] }> {
    const runs = ocrStore.itemsFor(pageIndex).filter(i => !i.removed)
    if (runs.length) return { mode: 'ocr', runs }
    const all = await deps.pdfEngine.getTextBlocks(pageIndex)
    const visible = all.filter(b => !b.invisible && b.text.trim())
    const visChars = visible.reduce((n, b) => n + b.text.trim().length, 0)
    const invChars = all.reduce((n, b) => n + (b.invisible ? b.text.trim().length : 0), 0)
    if (invChars > Math.max(visChars, 40)) return { mode: 'scan', visible }
    if (visChars === 0 && await deps.isScanLike(pageIndex).catch(() => false)) return { mode: 'scan', visible }
    return { mode: 'text', visible }
  }

  async function listPage(pageIndex: number): Promise<string> {
    for (const [k, a] of anchors) if (a.pageIndex === pageIndex) anchors.delete(k)
    const lines: string[] = []
    const m = await pageMode(pageIndex)
    if (m.mode === 'ocr') {
      m.runs!.forEach((item, i) => {
        const ref = refFor('ocr', pageIndex, i)
        anchors.set(ref, {
          kind: 'ocr', pageIndex, text: item.text, ocrId: item.id,
          cx: item.rect.x + item.rect.width / 2, cy: item.rect.y + item.rect.height / 2
        })
        lines.push(`[${ref}] (x=${fmt(item.rect.x)},y=${fmt(item.rect.y)},w=${fmt(item.rect.width)},h=${fmt(item.rect.height)},${fmt(item.fontSize)}pt) ${JSON.stringify(item.text)}`)
      })
      return `Page ${pageIndex + 1} is a scanned page, recognised (${m.runs!.length} lines you can replace, delete, move or restyle; changes are written when the file is saved):\n` + capped(lines)
    }
    if (m.mode === 'scan') {
      return `Page ${pageIndex + 1} is a SCANNED page: the text you see is part of the image, not editable text, so it cannot be changed directly. To read and edit it, call recognize_page(${pageIndex + 1}) — afterwards its lines are listed as r-references you can replace, delete, move or restyle, and the changes are written into the file when it is saved.`
    }
    const blocks = m.visible!
    if (blocks.length === 0) return `Page ${pageIndex + 1} has no editable text.`
    blocks.forEach((b, i) => {
      const ref = refFor('block', pageIndex, i)
      anchors.set(ref, {
        kind: 'block', pageIndex, text: b.text,
        cx: (b.bbox[0] + b.bbox[2]) / 2, cy: (b.bbox[1] + b.bbox[3]) / 2
      })
      lines.push(`[${ref}] (x=${fmt(b.bbox[0])},y=${fmt(b.bbox[1])},w=${fmt(b.bbox[2] - b.bbox[0])},h=${fmt(b.bbox[3] - b.bbox[1])},${fmt(b.fontSize)}pt) ${JSON.stringify(b.text)}`)
    })
    return `Page ${pageIndex + 1} text (${blocks.length} blocks, positions in points from the top-left corner):\n` + capped(lines)
  }

  function capped(lines: string[]): string {
    let out = ''
    for (let i = 0; i < lines.length; i++) {
      if (out.length + lines[i].length + 1 > LISTING_CAP) {
        return out + `\n… ${lines.length - i} more blocks not shown (use find_text to locate text further down)`
      }
      out += (i ? '\n' : '') + lines[i]
    }
    return out
  }

  async function buildContext(): Promise<string> {
    const pageIndex = docStore.currentPage - 1
    const head = `Document: ${docStore.fileName || 'untitled'}, ${docStore.totalPages} page(s). The user is looking at page ${docStore.currentPage}.`
    const listing = await listPage(pageIndex)
    return `${head}\n\n${listing}`
  }

  // ── Anchors → live blocks ──

  async function resolveRef(ref: string): Promise<{ anchor: Anchor; block?: TextBlock; item?: OcrTextItem } | { error: string }> {
    const anchor = anchors.get(ref.trim())
    if (!anchor) return { error: `Unknown reference "${ref}". Call list_page_text to get current references.` }
    if (anchor.kind === 'ocr') {
      const item = ocrStore.itemsFor(anchor.pageIndex).find(i => i.id === anchor.ocrId)
      if (!item || item.removed) return { error: `The OCR line ${ref} no longer exists.` }
      return { anchor, item }
    }
    const blocks = (await deps.pdfEngine.getTextBlocks(anchor.pageIndex)).filter(b => !b.invisible)
    const block = findByAnchor(anchor, blocks)
    if (!block) return { error: `The text of ${ref} could not be found on page ${anchor.pageIndex + 1} any more (it may have changed). Call list_page_text and use a fresh reference.` }
    return { anchor, block }
  }

  /** Same rule as TextBlockOverlay.findByAnchor: identical text, nearest centre, twins far away rejected. */
  function findByAnchor(anchor: Anchor, blocks: TextBlock[]): TextBlock | null {
    let candidates = blocks.filter(b => b.text === anchor.text)
    if (candidates.length === 0) {
      const prefix = anchor.text.slice(0, 3)
      candidates = prefix.length === 3
        ? blocks.filter(b => b.text.startsWith(prefix) && (b.text.startsWith(anchor.text) || anchor.text.startsWith(b.text)))
        : []
    }
    if (candidates.length === 0) return null
    if (candidates.length === 1) return candidates[0]
    let best: { block: TextBlock; dist: number } | null = null
    for (const b of candidates) {
      const dist = Math.hypot((b.bbox[0] + b.bbox[2]) / 2 - anchor.cx, (b.bbox[1] + b.bbox[3]) / 2 - anchor.cy)
      if (!best || dist < best.dist) best = { block: b, dist }
    }
    return best && best.dist < 24 ? best.block : null
  }

  function extractionIndex(id: string): number {
    const n = Number(id.split(':').pop())
    return Number.isFinite(n) ? n : 0
  }

  // ── Mutation plumbing ──

  /** One queued engine mutation with the undo snapshot and the save→reload the layout does. */
  async function mutate(status: string, fn: () => Promise<boolean>): Promise<boolean> {
    return enqueueOp(async () => {
      const ok = await fn()
      if (ok) {
        deps.pushUndo()
        await deps.syncAfterEdit()
        editorStore.setStatus(status)
      }
      return ok
    })
  }

  function pageArg(args: any, key = 'page'): number | { error: string } {
    const p = Number(args?.[key])
    if (!Number.isInteger(p) || p < 1 || p > docStore.totalPages) return { error: `Page ${args?.[key]} does not exist (the document has ${docStore.totalPages}).` }
    return p - 1
  }

  function refsArg(args: any): string[] {
    if (Array.isArray(args?.refs)) return args.refs.map(String)
    if (typeof args?.ref === 'string') return [args.ref]
    return []
  }

  function colorArg(v: unknown, fallback: string): [number, number, number] {
    const hex = typeof v === 'string' && /^#?[0-9a-fA-F]{6}$/.test(v) ? (v.startsWith('#') ? v : `#${v}`) : fallback
    return hexToRgb01(hex)
  }

  /** Bring the page into view: the page ops in the layout act on the CURRENT page. */
  function showPage(pageIndex: number) {
    if (docStore.currentPage !== pageIndex + 1) docStore.setPage(pageIndex + 1)
  }

  // ── The tools ──

  async function runTool(name: string, args: any): Promise<{ ok: boolean; result: string }> {
    const fail = (msg: string) => ({ ok: false, result: JSON.stringify({ error: msg }) })
    const done = (data: Record<string, unknown>) => ({ ok: true, result: JSON.stringify({ ok: true, ...data }) })
    if (!docStore.loaded) return fail('No document is open.')

    switch (name) {
      case 'list_page_text': {
        const p = pageArg(args); if (typeof p !== 'number') return fail(p.error)
        return { ok: true, result: await listPage(p) }
      }

      case 'find_text': {
        const q = String(args?.query ?? '').trim()
        if (!q) return fail('query is empty')
        const hits = await deps.pdfEngine.searchDocument(q, 20)
        const seen = new Set<string>()
        const matches: { page: number; ref: string; text: string }[] = []
        const scanned = new Set<number>()
        // MuPDF's search finds the text of a scanned page's INVISIBLE OCR layer
        // too, but those blocks cannot be edited into view. Group hits by page,
        // and for a scanned page report it as needing recognition rather than
        // offering a block reference that would fail.
        const byPage = new Map<number, typeof hits>()
        for (const hit of hits) {
          const arr = byPage.get(hit.pageIndex) ?? []
          arr.push(hit); byPage.set(hit.pageIndex, arr)
        }
        for (const [pi, pageHits] of byPage) {
          const m = await pageMode(pi)
          if (m.mode === 'scan') { scanned.add(pi); continue }
          if (m.mode === 'ocr') {
            const needle = q.toLowerCase()
            m.runs!.forEach((item, i) => {
              if (item.removed || !item.text.toLowerCase().includes(needle)) return
              const ref = refFor('ocr', pi, i)
              anchors.set(ref, { kind: 'ocr', pageIndex: pi, text: item.text, ocrId: item.id, cx: item.rect.x + item.rect.width / 2, cy: item.rect.y + item.rect.height / 2 })
              if (!seen.has(ref)) { seen.add(ref); matches.push({ page: pi + 1, ref, text: item.text }) }
            })
            continue
          }
          const blocks = m.visible!
          for (const [k, a] of anchors) if (a.pageIndex === pi && a.kind === 'block') anchors.delete(k)
          blocks.forEach((b, i) => anchors.set(refFor('block', pi, i), {
            kind: 'block', pageIndex: pi, text: b.text,
            cx: (b.bbox[0] + b.bbox[2]) / 2, cy: (b.bbox[1] + b.bbox[3]) / 2
          }))
          for (const hit of pageHits) {
            const [hx0, hy0, hx1, hy1] = hit.rect
            blocks.forEach((b, i) => {
              const [x0, y0, x1, y1] = b.bbox
              if (!(hx0 < x1 && hx1 > x0 && hy0 < y1 && hy1 > y0)) return
              const ref = refFor('block', pi, i)
              if (seen.has(ref)) return
              seen.add(ref)
              matches.push({ page: pi + 1, ref, text: b.text })
            })
          }
        }
        // OCR runs already recognised on pages that had no search hits (rare).
        const needle = q.toLowerCase()
        for (const [pi, res] of ocrStore.pages) {
          if (byPage.has(pi)) continue
          res.items.forEach((item, i) => {
            if (item.removed || !item.text.toLowerCase().includes(needle)) return
            const ref = refFor('ocr', pi, i)
            anchors.set(ref, { kind: 'ocr', pageIndex: pi, text: item.text, ocrId: item.id, cx: item.rect.x + item.rect.width / 2, cy: item.rect.y + item.rect.height / 2 })
            if (!seen.has(ref)) { seen.add(ref); matches.push({ page: pi + 1, ref, text: item.text }) }
          })
        }
        if (matches.length === 0 && scanned.size === 0) return done({ matches: [], note: `"${q}" was not found in the document` })
        const out: Record<string, unknown> = { matches: matches.slice(0, 30) }
        if (scanned.size) {
          const pgs = [...scanned].map(p => p + 1).sort((a, b) => a - b)
          out.scanned_pages_needing_recognition = pgs
          out.note = `The text also appears on scanned page(s) ${pgs.join(', ')}. To edit those, call recognize_page(N) yourself for the page(s) you need, then edit the r-references. Do not ask the user to do it.`
        }
        return done(out)
      }

      case 'replace_text': {
        const newText = String(args?.new_text ?? '')
        const r = await resolveRef(String(args?.ref ?? ''))
        if ('error' in r) return fail(r.error)
        if (r.item) {
          const norm = newText.replace(/\s+/g, ' ').trim()
          // A rewrite that equals the current text changes nothing and would
          // report a false success; tell the model so it can correct the run
          // it actually meant.
          if (norm === (r.item.text || '').replace(/\s+/g, ' ').trim()) {
            return done({ replaced: r.anchor.text, note: 'no change: the new text is identical to this line — did you mean a different reference?' })
          }
          ocrStore.updateItem(r.item.id, { text: norm })
          const after = ocrStore.itemsFor(r.anchor.pageIndex).find(i => i.id === r.item!.id)
          if (after?.edited) void deps.ocr.traceItem(after)
          editorStore.setStatus('OCR line edited — written into the file when you save')
          return done({ replaced: r.anchor.text, with: norm, note: 'OCR edit; shown now, written into the file when the user saves' })
        }
        const block = r.block!
        // A whole-block replace whose new text still contains the rest of a
        // phrase that spilled onto the next line is a common miss; but here the
        // model asked to rewrite one specific listed block, so honour it.
        let res: Awaited<ReturnType<typeof deps.pdfEngine.replaceText>> | null = null
        const ok = await mutate('Text replaced by the assistant', async () => {
          res = await deps.pdfEngine.replaceText(r.anchor.pageIndex, block.id, newText)
          return res.success
        })
        if (!ok) return fail(`Could not replace the text: ${deps.pdfEngine.error.value || 'no matching text in the content stream'}`)
        const out: Record<string, unknown> = { replaced: block.text, with: newText }
        if (res!.substitutedFont) out.note = `the original font lacked some glyphs, so the text was drawn in ${res!.substitutedFont}`
        if ((res!.lines ?? 1) > 1) out.lines = res!.lines
        return done(out)
      }

      case 'replace_in_page': {
        const p = pageArg(args); if (typeof p !== 'number') return fail(p.error)
        const find = String(args?.find ?? '')
        const replace = String(args?.replace ?? '')
        if (!find.trim()) return fail('find is empty')
        // Every occurrence by default — "change X to Y" on a repeated name or
        // date means all of them; the model asks for "first" when the user
        // singled one out.
        const max = String(args?.occurrence ?? 'all') === 'first' ? 1 : Infinity
        const m = await pageMode(p)
        if (m.mode === 'scan') return fail(`Page ${p + 1} is scanned — call recognize_page(${p + 1}) first, then use replace_in_page.`)

        if (m.mode === 'ocr') {
          const runs = m.runs!
          const { edits, count } = replaceAllSpans(runs.map(r => r.text), find, replace, max)
          if (count === 0) return fail(`"${find}" was not found on page ${p + 1}. Check the exact words with list_page_text.`)
          let changed = 0
          for (const e of edits) {
            const item = runs[e.unit]
            const norm = e.newText.replace(/\s+/g, ' ').trim()
            if (norm === (item.text || '').replace(/\s+/g, ' ').trim()) continue
            if (!norm) ocrStore.removeItem(item.id)
            else {
              ocrStore.updateItem(item.id, { text: norm })
              const after = ocrStore.itemsFor(p).find(i => i.id === item.id)
              if (after?.edited) void deps.ocr.traceItem(after)
            }
            changed++
          }
          if (!changed) return done({ note: 'no change: the phrase already reads as requested' })
          editorStore.setStatus(`Replaced "${find}" (${count}×) — written into the file when you save`)
          return done({ replaced: find, with: replace, occurrences: count, lines: changed, note: 'OCR edit; shown now, written into the file when the user saves' })
        }

        // Genuine text: resolve fresh blocks, find every occurrence, edit each
        // affected block in ONE save→reload cycle, back to front so emptied
        // blocks do not renumber the ones still to be edited.
        const blocks = (await deps.pdfEngine.getTextBlocks(p)).filter(b => !b.invisible && b.text.trim())
        const { edits: raw, count } = replaceAllSpans(blocks.map(b => b.text), find, replace, max)
        if (count === 0) return fail(`"${find}" was not found on page ${p + 1}. Check the exact words with list_page_text (the phrase must appear as drawn).`)
        const edits = raw
          .map(e => ({ block: blocks[e.unit], newText: e.newText }))
          .filter(e => e.newText.replace(/\s+/g, ' ').trim() !== (e.block.text || '').replace(/\s+/g, ' ').trim())
        if (edits.length === 0) return done({ note: 'no change: the phrase already reads as requested' })
        edits.sort((a, b) => extractionIndex(b.block.id) - extractionIndex(a.block.id))
        let applied = 0
        const ok = await mutate(`Replaced "${find}" (${count}×) by the assistant`, async () => {
          for (const e of edits) {
            const r = await deps.pdfEngine.replaceText(p, e.block.id, e.newText.trim())
            if (r.success) applied++
          }
          return applied > 0
        })
        if (!ok) return fail(`Could not replace "${find}": ${deps.pdfEngine.error.value || 'no matching text in the content stream'}`)
        showPage(p)
        if (applied < edits.length) return done({ replaced: find, with: replace, occurrences: count, blocks_edited: applied, note: `${edits.length - applied} block(s) could not be edited` })
        return done({ replaced: find, with: replace, occurrences: count })
      }

      case 'replace_in_document': {
        const find = String(args?.find ?? '')
        const replace = String(args?.replace ?? '')
        if (!find.trim()) return fail('find is empty')
        // Every page at once, so "in the whole document" is one call and cannot
        // be left half-done by running out of tool rounds — the failure the
        // model showed doing it by hand (it edited some pages, recognised
        // another, then declared it finished without editing that one).
        const hits = await deps.pdfEngine.searchDocument(find, 50)
        const pages = new Set<number>(hits.map(h => h.pageIndex))
        for (const [pi, res] of ocrStore.pages) if (res.items.some(i => !i.removed && i.text.toLowerCase().includes(find.toLowerCase()))) pages.add(pi)
        if (pages.size === 0) return fail(`"${find}" was not found in the document.`)
        // Every text page is edited (fast); scanned pages are recognised on the
        // fly, and each recognition is 15-40s, so the number done per call is
        // capped to stay responsive — a phrase on a whole scanned bundle would
        // otherwise run for many minutes with no feedback (measured: it blew
        // past a 5-minute wait). Already-recognised pages don't re-scan, so
        // "continue" picks up the next batch.
        const MAX_SCAN = 6
        let scans = 0
        let capped = false
        const report: { page: number; occurrences?: number; note?: string }[] = []
        let totalOcc = 0
        for (const pi of [...pages].sort((a, b) => a - b)) {
          let mode = await pageMode(pi)
          if (mode.mode === 'scan') {
            if (scans >= MAX_SCAN) { capped = true; report.push({ page: pi + 1, note: 'scanned — not recognised (limit reached)' }); continue }
            await deps.recognise(pi); scans++
            mode = await pageMode(pi)
            if (mode.mode !== 'ocr') { report.push({ page: pi + 1, note: 'scanned — OCR found nothing to change' }); continue }
          }
          if (mode.mode === 'ocr') {
            const { edits, count } = replaceAllSpans(mode.runs!.map(r => r.text), find, replace)
            let changed = 0
            for (const e of edits) {
              const item = mode.runs![e.unit]
              const norm = e.newText.replace(/\s+/g, ' ').trim()
              if (norm === (item.text || '').replace(/\s+/g, ' ').trim()) continue
              if (!norm) ocrStore.removeItem(item.id)
              else { ocrStore.updateItem(item.id, { text: norm }); const after = ocrStore.itemsFor(pi).find(i => i.id === item.id); if (after?.edited) void deps.ocr.traceItem(after) }
              changed++
            }
            if (count) { totalOcc += count; report.push({ page: pi + 1, occurrences: count }) }
            continue
          }
          const blocks = (await deps.pdfEngine.getTextBlocks(pi)).filter(b => !b.invisible && b.text.trim())
          const { edits: raw, count } = replaceAllSpans(blocks.map(b => b.text), find, replace)
          if (!count) continue
          const edits = raw.map(e => ({ block: blocks[e.unit], newText: e.newText })).filter(e => e.newText.replace(/\s+/g, ' ').trim() !== (e.block.text || '').replace(/\s+/g, ' ').trim())
          if (!edits.length) { report.push({ page: pi + 1, occurrences: count, note: 'already as requested' }); continue }
          edits.sort((a, b) => extractionIndex(b.block.id) - extractionIndex(a.block.id))
          let applied = 0
          const ok = await mutate(`Replaced "${find}" on page ${pi + 1}`, async () => { for (const e of edits) { const r = await deps.pdfEngine.replaceText(pi, e.block.id, e.newText.trim()); if (r.success) applied++ } return applied > 0 })
          if (ok) { totalOcc += count; report.push({ page: pi + 1, occurrences: count }) }
          else report.push({ page: pi + 1, note: `could not edit (${deps.pdfEngine.error.value || 'no match'})` })
        }
        const changedPages = report.filter(r => r.occurrences).length
        editorStore.setStatus(`Replaced "${find}" → "${replace}" on ${changedPages} page(s), ${totalOcc}×`)
        const out: Record<string, unknown> = { replaced: find, with: replace, pages_changed: changedPages, total_occurrences: totalOcc, report }
        if (capped) out.note = `Text pages are done, and ${MAX_SCAN} scanned pages were changed. More scanned pages still contain it (OCR is slow, so only a few run per call) — tell the user how many remain and offer to continue; running replace_in_document again does the next batch.`
        return done(out)
      }

      case 'delete_text': {
        const refs = refsArg(args)
        if (!refs.length) return fail('refs is empty')
        const resolved = await Promise.all(refs.map(resolveRef))
        const errors = resolved.filter((x): x is { error: string } => 'error' in x).map(x => x.error)
        if (errors.length) return fail(errors.join(' '))
        const items = resolved.filter(x => 'item' in x && x.item).map(x => (x as any).item as OcrTextItem)
        for (const item of items) ocrStore.removeItem(item.id)
        const blocks = resolved.filter(x => 'block' in x && x.block).map(x => ({ block: (x as any).block as TextBlock, page: (x as any).anchor.pageIndex as number }))
        let removed = items.length
        if (blocks.length) {
          // Back to front: emptying a block renumbers only the ones after it,
          // so every id still to be used stays valid on one extraction.
          blocks.sort((a, b) => extractionIndex(b.block.id) - extractionIndex(a.block.id))
          let n = 0
          const ok = await mutate(`${blocks.length} text block(s) deleted by the assistant`, async () => {
            for (const { block, page } of blocks) {
              const r = await deps.pdfEngine.replaceText(page, block.id, '')
              if (r.success) n++
            }
            return n > 0
          })
          removed += n
          if (!ok) return fail(`Could not delete: ${deps.pdfEngine.error.value || 'no matching text'}`)
          if (n < blocks.length) return done({ removed, note: `${blocks.length - n} block(s) could not be removed` })
        }
        return done({ removed })
      }

      case 'move_text': {
        const refs = refsArg(args)
        const dx = Number(args?.dx) || 0, dy = Number(args?.dy) || 0
        if (!refs.length) return fail('refs is empty')
        if (!dx && !dy) return fail('dx and dy are both 0')
        const resolved = await Promise.all(refs.map(resolveRef))
        const errors = resolved.filter((x): x is { error: string } => 'error' in x).map(x => x.error)
        if (errors.length) return fail(errors.join(' '))
        const items = resolved.filter(x => 'item' in x && x.item).map(x => (x as any).item as OcrTextItem)
        for (const item of items) ocrStore.updateItem(item.id, { rect: { ...item.rect, x: item.rect.x + dx, y: item.rect.y + dy } })
        const blocks = resolved.filter(x => 'block' in x && x.block) as { anchor: Anchor; block: TextBlock }[]
        if (blocks.length) {
          const pages = new Set(blocks.map(b => b.anchor.pageIndex))
          if (pages.size > 1) return fail('move_text can only move blocks of one page at a time')
          const pageIndex = blocks[0].anchor.pageIndex
          // One call for the whole set: ids are extraction indices and a move
          // changes where a block sorts, so a second call would address a
          // renumbered page.
          const ops: BlockTransformOp[] = blocks.map(({ block }) => ({ blockId: block.id, dx, dy: -dy, sx: 1, sy: 1, anchorX: 0, anchorY: 0 }))
          let applied = 0
          const ok = await mutate(`${blocks.length} text block(s) moved by the assistant`, async () => {
            const r = await deps.pdfEngine.transformTextBlocks(pageIndex, ops)
            applied = r.applied
            return r.applied > 0
          })
          if (!ok) return fail(`Could not move the text: ${deps.pdfEngine.error.value || 'no matching text in the content stream'}`)
          for (const b of blocks) { b.anchor.cx += dx; b.anchor.cy += dy }
          if (applied < blocks.length) return done({ moved: applied + items.length, note: `${blocks.length - applied} block(s) could not be moved` })
        }
        return done({ moved: blocks.length + items.length, dx, dy })
      }

      case 'restyle_text': {
        const refs = refsArg(args)
        if (!refs.length) return fail('refs is empty')
        const style: Omit<BlockStyleOp, 'blockId'> = {}
        if (args?.font_size != null) {
          const s = Number(args.font_size)
          if (!(s >= 2 && s <= 300)) return fail('font_size must be between 2 and 300')
          style.fontSize = s
        }
        if (args?.color != null) style.color = colorArg(args.color, '#000000')
        if (args?.font != null) {
          const f = String(args.font)
          if (!['Helvetica', 'Times-Roman', 'Courier'].includes(f)) return fail('font must be Helvetica, Times-Roman or Courier')
          style.fontName = f as BlockStyleOp['fontName']
        }
        if (!Object.keys(style).length) return fail('nothing to change: give font_size, color or font')
        const resolved = await Promise.all(refs.map(resolveRef))
        const errors = resolved.filter((x): x is { error: string } => 'error' in x).map(x => x.error)
        if (errors.length) return fail(errors.join(' '))
        const items = resolved.filter(x => 'item' in x && x.item).map(x => (x as any).item as OcrTextItem)
        for (const item of items) {
          const patch: Partial<OcrTextItem> = {}
          if (style.fontSize) patch.fontSize = style.fontSize
          if (style.color) patch.color = style.color
          if (style.fontName) patch.fontFamily = style.fontName
          ocrStore.updateItem(item.id, patch)
        }
        const blocks = resolved.filter(x => 'block' in x && x.block) as { anchor: Anchor; block: TextBlock }[]
        if (blocks.length) {
          const pages = new Set(blocks.map(b => b.anchor.pageIndex))
          if (pages.size > 1) return fail('restyle_text can only restyle blocks of one page at a time')
          const pageIndex = blocks[0].anchor.pageIndex
          const ops: BlockStyleOp[] = blocks.map(({ block }) => ({ blockId: block.id, ...style }))
          let applied = 0
          const ok = await mutate(`${blocks.length} text block(s) restyled by the assistant`, async () => {
            const r = await deps.pdfEngine.restyleTextBlocks(pageIndex, ops)
            applied = r.applied
            return r.applied > 0
          })
          if (!ok) return fail(`Could not restyle the text: ${deps.pdfEngine.error.value || 'the block holds more than the target'}`)
          if (applied < blocks.length) return done({ restyled: applied + items.length, note: `${blocks.length - applied} block(s) could not be restyled` })
        }
        return done({ restyled: blocks.length + items.length })
      }

      case 'add_text': {
        const p = pageArg(args); if (typeof p !== 'number') return fail(p.error)
        const text = String(args?.text ?? '')
        if (!text.trim()) return fail('text is empty')
        const x = Number(args?.x), y = Number(args?.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('x and y must be numbers')
        const size = Number(args?.font_size) > 0 ? Number(args.font_size) : 11
        const color = colorArg(args?.color, '#000000')
        const font = args?.bold ? 'Helvetica-Bold' : 'Helvetica'
        const page = await deps.pdfEngine.getPageSize(p).catch(() => ({ width: 612, height: 792 }))
        // addText takes PDF user space (y up) and a BASELINE; the model gave the top edge.
        const baseline = page.height - y - size * 0.8
        const ok = await mutate('Text added by the assistant', () => deps.pdfEngine.addText(p, x, baseline, text, size, font, color))
        if (!ok) return fail(`Could not add the text: ${deps.pdfEngine.error.value || 'unknown error'}`)
        showPage(p)
        return done({ added: text, page: p + 1, x, y })
      }

      case 'highlight_text': {
        const p = pageArg(args); if (typeof p !== 'number') return fail(p.error)
        const text = String(args?.text ?? '').trim()
        if (!text) return fail('text is empty')
        let hits = await deps.pdfEngine.searchPage(p, text, 200)
        if (hits.length === 0) return fail(`"${text}" was not found on page ${p + 1}`)
        // PDF search matches substrings, so "RUC" also hits "INFRAESTRUCTURA".
        // For a single alphanumeric word, keep only matches that sit in a block
        // where the word appears with non-letter/digit boundaries — the field,
        // not a fragment of a longer word.
        if (/^[\p{L}\p{N}]+$/u.test(text)) {
          const bounded = new RegExp(`(^|[^\\p{L}\\p{N}])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu')
          const blocks = (await deps.pdfEngine.getTextBlocks(p)).filter(b => !b.invisible && b.text.trim())
          const kept = hits.filter(h => {
            const [hx0, hy0, hx1, hy1] = h.rect
            const over = blocks.filter(b => { const [x0, y0, x1, y1] = b.bbox; return hx0 < x1 && hx1 > x0 && hy0 < y1 && hy1 > y0 })
            return over.length === 0 ? true : over.some(b => bounded.test(b.text))
          })
          if (kept.length) hits = kept
        }
        const quads: Quad[] = hits.flatMap(h => h.quads)
        const color = colorArg(args?.color, '#ffeb3b')
        const ok = await mutate(`${hits.length} occurrence(s) highlighted by the assistant`, () => deps.pdfEngine.addTextMarkup(p, 'Highlight', quads, color, 1))
        if (!ok) return fail(`Could not highlight: ${deps.pdfEngine.error.value || 'unknown error'}`)
        showPage(p)
        return done({ highlighted: hits.length })
      }

      case 'add_note': {
        const p = pageArg(args); if (typeof p !== 'number') return fail(p.error)
        const text = String(args?.text ?? '')
        const x = Number(args?.x), y = Number(args?.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('x and y must be numbers')
        const ok = await mutate('Note added by the assistant', () => deps.pdfEngine.addStickyNote(p, x, y, text, hexToRgb01(editorStore.highlightColor)))
        if (!ok) return fail(`Could not add the note: ${deps.pdfEngine.error.value || 'unknown error'}`)
        showPage(p)
        return done({ note: text, page: p + 1 })
      }

      case 'rotate_page': {
        const p = pageArg(args); if (typeof p !== 'number') return fail(p.error)
        const deg = Number(args?.degrees)
        if (![90, -90, 180].includes(deg)) return fail('degrees must be 90, -90 or 180')
        showPage(p)
        await deps.rotatePage(deg)
        return done({ rotated: p + 1, degrees: deg })
      }

      case 'delete_page': {
        const p = pageArg(args); if (typeof p !== 'number') return fail(p.error)
        if (docStore.totalPages <= 1) return fail('The document has only one page.')
        showPage(p)
        const before = docStore.totalPages
        await deps.deletePage()
        if (docStore.totalPages === before) return fail(`Could not delete page ${p + 1}: ${deps.pdfEngine.error.value || 'unknown error'}`)
        anchors.clear()
        return done({ deleted: p + 1, pages: docStore.totalPages })
      }

      case 'duplicate_page': {
        const p = pageArg(args); if (typeof p !== 'number') return fail(p.error)
        showPage(p)
        const before = docStore.totalPages
        await deps.duplicatePage()
        if (docStore.totalPages === before) return fail(`Could not duplicate page ${p + 1}: ${deps.pdfEngine.error.value || 'unknown error'}`)
        anchors.clear()
        return done({ duplicated: p + 1, pages: docStore.totalPages })
      }

      case 'insert_blank_page': {
        const p = pageArg(args, 'after_page'); if (typeof p !== 'number') return fail(p.error)
        showPage(p)
        const before = docStore.totalPages
        await deps.insertBlankPage()
        if (docStore.totalPages === before) return fail(`Could not insert a page: ${deps.pdfEngine.error.value || 'unknown error'}`)
        anchors.clear()
        return done({ inserted_at: p + 2, pages: docStore.totalPages })
      }

      case 'move_page': {
        const p = pageArg(args); if (typeof p !== 'number') return fail(p.error)
        const to = pageArg(args, 'to'); if (typeof to !== 'number') return fail(to.error)
        if (p === to) return done({ note: 'the page is already there' })
        await deps.movePage(p, to)
        anchors.clear()
        return done({ moved: p + 1, to: to + 1 })
      }

      case 'go_to_page': {
        const p = pageArg(args); if (typeof p !== 'number') return fail(p.error)
        showPage(p)
        return done({ page: p + 1 })
      }

      case 'recognize_page': {
        const p = pageArg(args); if (typeof p !== 'number') return fail(p.error)
        showPage(p)
        await deps.recognise(p)
        const n = ocrStore.itemsFor(p).length
        if (!n) return fail(`OCR found no text on page ${p + 1}${deps.ocr.error.value ? ` (${deps.ocr.error.value})` : ''}`)
        return { ok: true, result: await listPage(p) }
      }

      case 'undo':
        return { ok: true, result: 'UNDO' }

      default:
        return fail(`Unknown tool ${name}`)
    }
  }

  // ── The conversation ──

  async function send(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || busy.value) return
    if (!docStore.loaded) { push('error', 'Open a document first.'); return }
    if (!editorStore.openaiApiKey) {
      push('error', 'The assistant needs an OpenAI API key — open its settings with the gear icon.')
      return
    }
    if (!consentGiven) {
      const ok = await deps.confirmCloud()
      if (!ok) { push('error', 'Cancelled — nothing was sent.'); return }
      consentGiven = true
    }

    busy.value = true
    lastError.value = null
    abort = new AbortController()
    push('user', trimmed)
    history.push({ role: 'user', content: trimmed })

    let endTransaction = beginTransaction()
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const context = await buildContext()
        const reply = await chatCompletion({
          apiKey: editorStore.openaiApiKey,
          model: editorStore.openaiModel || 'gpt-4o-mini',
          endpoint: editorStore.openaiEndpoint || undefined,
          messages: [
            { role: 'system', content: ASSISTANT_SYSTEM_PROMPT },
            { role: 'system', content: context },
            ...history
          ],
          tools: ASSISTANT_TOOLS,
          signal: abort.signal
        })
        history.push(reply.message)
        const calls = reply.message.tool_calls
        if (!calls || calls.length === 0) {
          push('assistant', reply.message.content?.trim() || '(no answer)')
          break
        }
        if (reply.message.content?.trim()) push('assistant', reply.message.content.trim())
        for (const call of calls) {
          const outcome = await execute(call, () => { endTransaction(); }, () => { endTransaction = beginTransaction() })
          history.push({ role: 'tool', tool_call_id: call.id, content: outcome.result })
        }
        if (round === MAX_ROUNDS - 1) push('error', 'Stopped after too many steps; ask again for what is still missing.')
      }
    } catch (err: any) {
      const msg = err?.name === 'AbortError' ? 'Cancelled.' : (err?.message || String(err))
      lastError.value = msg
      push('error', msg)
      // A reply the model never finished must not sit in the history as the
      // last turn, or the next request is sent with a dangling tool call.
      while (history.length && history[history.length - 1].role !== 'user' && history[history.length - 1].role !== 'assistant') history.pop()
      if (history.length && history[history.length - 1].role === 'assistant' && (history[history.length - 1] as any).tool_calls) history.pop()
    } finally {
      endTransaction()
      abort = null
      busy.value = false
      if (history.length > HISTORY_CAP) history = trimHistory(history)
    }
  }

  async function execute(call: ToolCall, release: () => void, reacquire: () => void): Promise<{ ok: boolean; result: string }> {
    let args: any = {}
    try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {} }
    catch (_) { return { ok: false, result: JSON.stringify({ error: 'arguments were not valid JSON' }) } }
    const label = describeCall(call.function.name, args)
    try {
      let out = await runTool(call.function.name, args)
      if (out.ok && out.result === 'UNDO') {
        // undo waits for open transactions to settle — ours included.
        release()
        try { await deps.undo() } finally { reacquire() }
        anchors.clear()
        out = { ok: true, result: JSON.stringify({ ok: true, note: 'last change undone' }) }
      }
      push('tool', out.ok ? label : `${label} — ${safeError(out.result)}`, out.ok)
      return out
    } catch (err: any) {
      const msg = err?.message || String(err)
      push('tool', `${label} — ${msg}`, false)
      return { ok: false, result: JSON.stringify({ error: msg }) }
    }
  }

  function safeError(result: string): string {
    try { return JSON.parse(result)?.error || result } catch (_) { return result }
  }

  function describeCall(name: string, args: any): string {
    const short = (s: unknown, n = 40) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t }
    switch (name) {
      case 'list_page_text': return `Reading page ${args.page}`
      case 'find_text': return `Searching "${short(args.query)}"`
      case 'replace_text': return `Replacing ${args.ref} → "${short(args.new_text)}"`
      case 'replace_in_page': return `Replacing "${short(args.find)}" → "${short(args.replace)}" on page ${args.page}`
      case 'replace_in_document': return `Replacing "${short(args.find)}" → "${short(args.replace)}" in the whole document`
      case 'delete_text': return `Deleting ${refsArg(args).join(', ')}`
      case 'move_text': return `Moving ${refsArg(args).join(', ')} by (${args.dx}, ${args.dy})`
      case 'restyle_text': return `Restyling ${refsArg(args).join(', ')}`
      case 'add_text': return `Adding "${short(args.text)}" on page ${args.page}`
      case 'highlight_text': return `Highlighting "${short(args.text)}" on page ${args.page}`
      case 'add_note': return `Adding a note on page ${args.page}`
      case 'rotate_page': return `Rotating page ${args.page} by ${args.degrees}°`
      case 'delete_page': return `Deleting page ${args.page}`
      case 'duplicate_page': return `Duplicating page ${args.page}`
      case 'insert_blank_page': return `Inserting a blank page after ${args.after_page}`
      case 'move_page': return `Moving page ${args.page} to ${args.to}`
      case 'go_to_page': return `Going to page ${args.page}`
      case 'recognize_page': return `Recognising page ${args.page} (OCR)`
      case 'undo': return 'Undoing the last change'
      default: return name
    }
  }

  /** Keep the tail, but never cut between an assistant tool call and its tool results. */
  function trimHistory(h: ChatMessage[]): ChatMessage[] {
    let start = h.length - HISTORY_CAP
    while (start > 0 && start < h.length && h[start].role !== 'user') start++
    return start < h.length ? h.slice(start) : []
  }

  return { messages, busy, lastError, send, clear, cancel, runTool, listPage }
}

export type Assistant = ReturnType<typeof createAssistant>

/**
 * Locate a phrase across an ordered list of text units (extraction blocks or
 * OCR runs), whitespace-insensitively, and say which units it spans.
 *
 * Extraction splits a paragraph or a table cell into one block PER LINE, so a
 * phrase the user names ("MEJORAMIENTO DE LA SALA DE COMUNICACIONES") routinely
 * begins in one block and ends inside the next. A per-block replace edits only
 * the first and strands the rest ("…COMUNICACIONES" left behind). This finds
 * the whole span so the edit can be spread across the units it really covers.
 *
 * Units are joined by a single virtual space and whitespace is collapsed, so
 * the invented spaces extraction adds between cells do not defeat the match.
 * Returns the first occurrence only.
 */
export function findSpanInTexts(texts: string[], find: string): { firstUnit: number; startPos: number; lastUnit: number; endPos: number } | null {
  const stream: { u: number; c: number; ch: string }[] = []
  texts.forEach((t, u) => {
    for (let c = 0; c < t.length; c++) stream.push({ u, c, ch: t[c] })
    if (u < texts.length - 1) stream.push({ u: -1, c: -1, ch: ' ' })
  })
  let norm = ''
  const map: number[] = []
  let prevWs = false
  for (let i = 0; i < stream.length; i++) {
    const ch = stream[i].ch
    if (/\s/.test(ch)) { if (prevWs) continue; norm += ' '; map.push(i); prevWs = true }
    else { norm += ch.toLowerCase(); map.push(i); prevWs = false }
  }
  const nfind = find.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!nfind) return null
  const at = norm.indexOf(nfind)
  if (at < 0) return null
  let s = map[at]
  let e = map[at + nfind.length - 1]
  while (s < stream.length && stream[s].u === -1) s++          // skip a leading separator
  while (e > 0 && stream[e].u === -1) e--                       // skip a trailing separator
  if (stream[s].u === -1 || stream[e].u === -1) return null
  return { firstUnit: stream[s].u, startPos: stream[s].c, lastUnit: stream[e].u, endPos: stream[e].c }
}

/**
 * Given the span, the new text for every unit it touches. The replacement goes
 * wholly into the first unit; the last keeps only what followed the match;
 * units fully inside the span are emptied. Each result is trimmed at its edges
 * (a slice can leave a stray boundary space), never collapsed internally.
 */
export function planSpanEdits(texts: string[], span: { firstUnit: number; startPos: number; lastUnit: number; endPos: number }, replace: string): { unit: number; newText: string }[] {
  const out: { unit: number; newText: string }[] = []
  for (let i = span.firstUnit; i <= span.lastUnit; i++) {
    const t = texts[i]
    let nt: string
    if (i === span.firstUnit && i === span.lastUnit) nt = t.slice(0, span.startPos) + replace + t.slice(span.endPos + 1)
    else if (i === span.firstUnit) nt = t.slice(0, span.startPos) + replace
    else if (i === span.lastUnit) nt = t.slice(span.endPos + 1)
    else nt = ''
    out.push({ unit: i, newText: nt.trim() })
  }
  return out
}

/**
 * Replace EVERY occurrence of a phrase across the ordered units (or just the
 * first, when `max` is 1), whitespace-insensitively and across unit
 * boundaries, and return the new text of each unit that changed plus how many
 * occurrences were replaced.
 *
 * "Change X to Y" on a document where X repeats — a project name through a
 * form, a date in several cells — means all of them; replacing one and
 * reporting success is the completeness bug this fixes. Occurrences are found
 * once on the original text (so a replacement that contains the search text
 * cannot loop) and applied right to left (so earlier positions stay valid).
 */
export function replaceAllSpans(texts: string[], find: string, replace: string, max = Infinity): { edits: { unit: number; newText: string }[]; count: number } {
  const stream: { u: number; c: number; ch: string }[] = []
  texts.forEach((t, u) => {
    for (let c = 0; c < t.length; c++) stream.push({ u, c, ch: t[c] })
    if (u < texts.length - 1) stream.push({ u: -1, c: -1, ch: ' ' })
  })
  let norm = ''
  const map: number[] = []
  let prevWs = false
  for (let i = 0; i < stream.length; i++) {
    const ch = stream[i].ch
    if (/\s/.test(ch)) { if (prevWs) continue; norm += ' '; map.push(i); prevWs = true }
    else { norm += ch.toLowerCase(); map.push(i); prevWs = false }
  }
  const nfind = find.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!nfind) return { edits: [], count: 0 }

  const matches: { s: number; e: number }[] = []
  let from = 0
  while (matches.length < max) {
    const at = norm.indexOf(nfind, from)
    if (at < 0) break
    let s = map[at]
    let e = map[at + nfind.length - 1]
    while (s < e && stream[s].u === -1) s++
    while (e > s && stream[e].u === -1) e--
    if (stream[s].u !== -1 && stream[e].u !== -1) matches.push({ s, e })
    from = at + nfind.length
  }
  if (matches.length === 0) return { edits: [], count: 0 }

  const arr = texts.map(t => t.split(''))
  const touched = new Set<number>()
  matches.sort((a, b) => b.s - a.s)                                  // right to left
  for (const m of matches) {
    const covered: { u: number; c: number }[] = []
    for (let i = m.s; i <= m.e; i++) if (stream[i].u !== -1) covered.push({ u: stream[i].u, c: stream[i].c })
    if (!covered.length) continue
    const firstU = covered[0].u
    const insertPos = covered[0].c
    const byUnit = new Map<number, number[]>()
    for (const cv of covered) { if (!byUnit.has(cv.u)) byUnit.set(cv.u, []); byUnit.get(cv.u)!.push(cv.c); touched.add(cv.u) }
    for (const [u, cs] of byUnit) { cs.sort((a, b) => b - a); for (const c of cs) arr[u].splice(c, 1) }
    arr[firstU].splice(insertPos, 0, ...replace.split(''))
  }
  // A deletion (empty replacement) leaves the spaces that flanked the phrase
  // touching; collapse only that, and only for a deletion, so padded table
  // columns keep their intentional runs of spaces.
  const collapse = replace.trim() === ''
  const edits: { unit: number; newText: string }[] = []
  for (const u of touched) {
    let nt = arr[u].join('').trim()
    if (collapse) nt = nt.replace(/[ \t]{2,}/g, ' ')
    edits.push({ unit: u, newText: nt })
  }
  return { edits, count: matches.length }
}
