/**
 * Open documents.
 *
 * A session is one PDF: its bytes, the engine thread holding it, an undo
 * stack, and the references (anchors) the model was shown. Every edit runs
 * the app's own sequence — engine op, save, reload (`syncAfterEdit`) — so the
 * engine always holds exactly `bytes`, the undo snapshot is simply the bytes
 * from before, and block ids (extraction indices, renumbered by every reload)
 * are never kept: a reference is re-found by its text and centre.
 *
 * Calls on one session are serialised: Claude may call tools in parallel.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineClient } from './engine/client'
import { ToolError } from './util'
import type { TextBlock, AnnotationInfo, ContentImageInfo } from '../../src/engine/types'
import { findByAnchor } from '../../src/utils/assistant/anchors'

export const THREAD_FILE = process.env.PDF_MCP_THREAD || path.join(path.dirname(fileURLToPath(import.meta.url)), 'engine-thread.mjs')
/** Engine threads kept alive at once; a session past the cap reloads on its next use. */
const MAX_LIVE_ENGINES = 3
/** Undo history per document, by bytes (signed files grow with every incremental save). */
const UNDO_BYTES = 300 * 1024 * 1024

export type Anchor =
  | { kind: 'block'; page: number; text: string; cx: number; cy: number }
  | { kind: 'annot'; page: number; type: string; cx: number; cy: number; contents: string }
  | { kind: 'image'; page: number; name: string; cx: number; cy: number }

export class DocumentSession {
  readonly id: string
  /** Where it came from / was last saved, or null for a new document. */
  path: string | null
  name: string
  bytes: ArrayBuffer
  pageCount = 0
  dirty = false
  private engine: EngineClient | null = null
  private undo: ArrayBuffer[] = []
  private redo: ArrayBuffer[] = []
  private anchors = new Map<string, Anchor>()
  private chain: Promise<unknown> = Promise.resolve()
  private disk: { mtimeMs: number; size: number } | null = null
  lastUsed = Date.now()
  /** Calls running now; a busy session's engine is never suspended under it. */
  busy = 0

  constructor(id: string, name: string, bytes: ArrayBuffer, filePath: string | null, private readonly mgr: SessionManager) {
    this.id = id
    this.name = name
    this.bytes = bytes
    this.path = filePath
    if (filePath) this.stampDisk()
  }

  /** Run `fn` with this document to itself. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      this.lastUsed = Date.now()
      this.busy++
      try { return await fn() } finally { this.busy--; this.lastUsed = Date.now() }
    })
    this.chain = next.catch(() => {})
    return next
  }

  /** The engine holding `bytes`, started (or restarted) as needed. */
  async eng(): Promise<EngineClient> {
    if (!this.engine) {
      await this.mgr.makeRoom(this)
      const e = new EngineClient(THREAD_FILE)
      const r = await e.load(this.bytes.slice(0))
      this.pageCount = r.pageCount
      this.engine = e
    }
    return this.engine
  }

  get live(): boolean { return !!this.engine }

  async suspend(): Promise<void> {
    const e = this.engine
    this.engine = null
    if (e) await e.close()
  }

  /**
   * One change: `fn` edits the engine's document; on success the result is
   * saved, reloaded, and the bytes before go on the undo stack. `fn` returns
   * false (or throws) to say nothing changed — then the engine is put back to
   * `bytes`, since a refused edit may still have touched the document.
   */
  async mutate<T>(fn: (e: EngineClient) => Promise<{ ok: boolean; value: T }>): Promise<T> {
    const e = await this.eng()
    let res: { ok: boolean; value: T }
    try {
      res = await fn(e)
    } catch (err) {
      await this.restoreEngine()
      throw err
    }
    if (!res.ok) {
      await this.restoreEngine()
      return res.value
    }
    const saved = await e.send<{ bytes: ArrayBuffer }>('saveDocument')
    this.pushUndo(this.bytes)
    this.redo = []
    await this.adopt(saved.bytes)
    this.dirty = true
    return res.value
  }

  /** Replace the whole document (a page merge, an unlock…) as one undoable change. */
  async replaceBytes(bytes: ArrayBuffer): Promise<void> {
    this.pushUndo(this.bytes)
    this.redo = []
    await this.adopt(bytes)
    this.dirty = true
  }

  async undoOnce(): Promise<boolean> {
    const prev = this.undo.pop()
    if (!prev) return false
    this.redo.push(this.bytes)
    await this.adopt(prev)
    this.dirty = true
    return true
  }

  async redoOnce(): Promise<boolean> {
    const next = this.redo.pop()
    if (!next) return false
    this.undo.push(this.bytes)
    await this.adopt(next)
    this.dirty = true
    return true
  }

  get history() { return { undo: this.undo.length, redo: this.redo.length } }

  private pushUndo(b: ArrayBuffer) {
    this.undo.push(b)
    let total = this.undo.reduce((n, x) => n + x.byteLength, 0)
    while (this.undo.length > 1 && total > UNDO_BYTES) total -= this.undo.shift()!.byteLength
  }

  private async adopt(bytes: ArrayBuffer) {
    this.bytes = bytes
    const e = await this.eng()
    const r = await e.load(bytes.slice(0))
    this.pageCount = r.pageCount
  }

  private async restoreEngine() {
    try {
      const e = await this.eng()
      const r = await e.load(this.bytes.slice(0))
      this.pageCount = r.pageCount
    } catch (_) { await this.suspend() }
  }

  // ───────── The file on disk ─────────

  stampDisk() {
    if (!this.path) return
    try { const s = fs.statSync(this.path); this.disk = { mtimeMs: s.mtimeMs, size: s.size } } catch (_) { this.disk = null }
  }

  /**
   * Has the file changed on disk since it was opened or saved (edited in the
   * app after `open_in_editor`, or by anything else)? With no unsaved changes
   * here it is reloaded; with some, the caller is told.
   */
  async syncWithDisk(): Promise<string | undefined> {
    if (!this.path || !this.disk) return
    let s: fs.Stats
    try { s = fs.statSync(this.path) } catch (_) { return }
    if (s.mtimeMs === this.disk.mtimeMs && s.size === this.disk.size) return
    if (this.dirty) {
      return `Note: ${this.path} changed on disk after it was opened here, and this session also has unsaved changes. Saving here will not include the changes made on disk; close_pdf with discard_changes and open it again to work on the disk version.`
    }
    const b = fs.readFileSync(this.path)
    await this.replaceBytes(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
    this.dirty = false
    this.stampDisk()
    this.anchors.clear()
    return `Note: ${path.basename(this.path)} changed on disk (edited elsewhere, e.g. in PDF Editor Pro) and was reloaded; earlier references were cleared.`
  }

  // ───────── References ─────────

  setAnchor(ref: string, a: Anchor) { this.anchors.set(ref, a) }
  clearPageAnchors(page: number, kind: Anchor['kind']) {
    for (const [k, a] of this.anchors) if (a.page === page && a.kind === kind) this.anchors.delete(k)
  }
  clearAnchors() { this.anchors.clear() }
  anchor(ref: string): Anchor {
    const a = this.anchors.get(String(ref).trim())
    if (!a) throw new ToolError(`Unknown reference "${ref}". List the page first (list_page_text, list_annotations or list_images) and use the references it returns.`)
    return a
  }
  moveAnchor(ref: string, dx: number, dy: number) {
    const a = this.anchors.get(ref)
    if (a) { a.cx += dx; a.cy += dy }
  }

  async visibleBlocks(page: number): Promise<TextBlock[]> {
    const e = await this.eng()
    const t = await e.send<{ blocks: TextBlock[] }>('getPageText', { pageIndex: page })
    return t.blocks.filter(b => !b.invisible)
  }

  /** A block reference → the live block it names, or a clear error. */
  async resolveBlock(ref: string): Promise<{ anchor: Extract<Anchor, { kind: 'block' }>; block: TextBlock }> {
    const a = this.anchor(ref)
    if (a.kind !== 'block') throw new ToolError(`${ref} is not a text reference`)
    const block = findByAnchor(a, await this.visibleBlocks(a.page))
    if (!block) throw new ToolError(`The text of ${ref} could not be found on page ${a.page + 1} any more (it may have changed). Call list_page_text and use a fresh reference.`)
    return { anchor: a, block }
  }

  /** An annotation reference → its current index (indices shift when one is deleted). */
  async resolveAnnot(ref: string): Promise<{ anchor: Extract<Anchor, { kind: 'annot' }>; annot: AnnotationInfo }> {
    const a = this.anchor(ref)
    if (a.kind !== 'annot') throw new ToolError(`${ref} is not an annotation reference`)
    const e = await this.eng()
    const { annotations } = await e.send<{ annotations: AnnotationInfo[] }>('getAnnotations', { pageIndex: a.page })
    let best: AnnotationInfo | null = null, dist = Infinity
    for (const x of annotations) {
      if (x.type !== a.type) continue
      const d = Math.hypot((x.rect[0] + x.rect[2]) / 2 - a.cx, (x.rect[1] + x.rect[3]) / 2 - a.cy)
      if (d < dist) { best = x; dist = d }
    }
    if (!best || dist > 24) throw new ToolError(`The annotation ${ref} is no longer on page ${a.page + 1}. Call list_annotations again.`)
    return { anchor: a, annot: best }
  }

  /** An image reference → the live content image (its Do offset moves with every edit). */
  async resolveImage(ref: string): Promise<{ anchor: Extract<Anchor, { kind: 'image' }>; image: ContentImageInfo }> {
    const a = this.anchor(ref)
    if (a.kind !== 'image') throw new ToolError(`${ref} is not an image reference`)
    const e = await this.eng()
    const images = await e.send<ContentImageInfo[]>('listContentImages', { pageIndex: a.page })
    let best: ContentImageInfo | null = null, dist = Infinity
    for (const x of images) {
      if (x.name !== a.name) continue
      const d = Math.hypot((x.rect[0] + x.rect[2]) / 2 - a.cx, (x.rect[1] + x.rect[3]) / 2 - a.cy)
      if (d < dist) { best = x; dist = d }
    }
    if (!best || dist > 24) throw new ToolError(`The image ${ref} is no longer on page ${a.page + 1}. Call list_images again.`)
    return { anchor: a, image: best }
  }
}

export class SessionManager {
  private sessions = new Map<string, DocumentSession>()
  private next = 1

  open(name: string, bytes: ArrayBuffer, filePath: string | null): DocumentSession {
    const s = new DocumentSession(`d${this.next++}`, name, bytes, filePath, this)
    this.sessions.set(s.id, s)
    return s
  }

  /** The session a tool names; with no id, the only open document. */
  get(id?: string): DocumentSession {
    if (id) {
      const s = this.sessions.get(String(id).trim())
      if (!s) throw new ToolError(`No open document "${id}". Open documents: ${this.list().map(x => x.id).join(', ') || 'none'} (use open_pdf).`)
      return s
    }
    if (this.sessions.size === 1) return [...this.sessions.values()][0]
    if (this.sessions.size === 0) throw new ToolError('No document is open. Call open_pdf with the file path first.')
    throw new ToolError(`Several documents are open (${this.list().map(x => `${x.id} ${x.name}`).join(', ')}): pass doc_id.`)
  }

  /** Already open at this path? */
  byPath(p: string): DocumentSession | undefined {
    const low = p.toLowerCase()
    return [...this.sessions.values()].find(s => s.path?.toLowerCase() === low)
  }

  list(): DocumentSession[] { return [...this.sessions.values()] }

  async close(s: DocumentSession) {
    this.sessions.delete(s.id)
    await s.suspend()
  }

  async closeAll() {
    await Promise.all(this.list().map(s => s.suspend()))
    this.sessions.clear()
  }

  /** Keep at most MAX_LIVE_ENGINES threads: suspend the least recently used other one. */
  async makeRoom(forSession: DocumentSession) {
    const live = this.list().filter(s => s !== forSession && s.live)
    const idle = live.filter(s => s.busy === 0).sort((a, b) => a.lastUsed - b.lastUsed)
    let count = live.length
    while (count >= MAX_LIVE_ENGINES && idle.length) { await idle.shift()!.suspend(); count-- }
  }
}
