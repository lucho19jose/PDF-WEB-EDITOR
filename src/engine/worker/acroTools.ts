/**
 * ACROBAT TOOLS — Organize pages, Crop, Header & footer, Watermark,
 * Background, Redact, Links, Bookmarks, Properties, Protect, Export, Create.
 *
 * Everything here is reached through ONE worker message, `acro`, with an `op`
 * name: the Acrobat-style shell adds many small document-level operations, and
 * threading each through its own case would bury the worker's switch. Every
 * mutation still arrives through the bridge, so the main thread keeps routing
 * them through `enqueueOp` like any other edit.
 *
 * The module owns no document state. The worker hands it the helpers it needs
 * (`AcroContext`) — the same content-stream readers and writers every other
 * edit uses, so a header written here is a block the editor's own matchers can
 * see, and a watermark is removed by the same nesting-aware marked-content
 * walk the OCR layer uses.
 */

type Mat6 = [number, number, number, number, number, number]

export interface AcroTextPart {
  x: number
  y: number
  text: string
  fontSize: number
  fontName: string
  color?: [number, number, number]
}

export interface AcroContext {
  mupdf: () => any
  doc: () => any
  readContentStream: (pageIndex: number) => string
  removeMarkedContent: (pageIndex: number, tag: string) => { removed: number }
  hasMarkedContent: (pageIndex: number, tag: string) => boolean
  invalidateContentSources: (pageIndex?: number) => void
  getPageSize: (pageIndex: number) => { width: number; height: number; rotation: number }
  rotatePage: (pageIndex: number, degrees: number) => { success: boolean; error?: string }
  measureRunWidth: (text: string, fontSize: number, fontName: string) => { width: number; exact: boolean }
  addTextRunToPage: (pageIndex: number, parts: AcroTextPart[], rotation: number, tag?: string) => { success: boolean; error?: string }
  buildShowOps: (pageObj: any, text: string, fontSize: number, fontName: string) => { ops: string } | { error: string }
  pageRotationCtm: (pageIndex: number) => Mat6 | null
  matInvert: (m: Mat6) => Mat6 | null
  matConcat: (a: Mat6, b: Mat6) => Mat6
  getCtmAtOffset: (stream: string, offset: number) => Mat6
  ownPageResources: (pageObj: any) => any
  isNullObj: (o: any) => boolean
  fmtNum: (n: number) => string
}

export const HF_TAG = 'AcroHeaderFooter'
export const WM_TAG = 'AcroWatermark'
export const BG_TAG = 'AcroBackground'
/** Page-dictionary key recording a watermark's text, so extraction can leave it out (see `isWatermarkBlock`). */
const WM_KEY = 'AcroWatermarkText'

export function createAcroTools(ctx: AcroContext) {
  const doc = () => ctx.doc()
  const count = () => doc().countPages()

  /** Raw bytes of a stream string (latin-1, one char per byte). */
  function bytesOf(s: string): Uint8Array {
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF
    return out
  }

  /** A document saved into a fresh, transferable buffer. */
  function save(d: any, options = 'compress,garbage=compact'): ArrayBuffer {
    const buf = d.saveToBuffer(options)
    const bytes = buf.asUint8Array().slice()
    buf.destroy()
    return bytes.buffer
  }

  /** Unique, in-range, ascending page indices. */
  function indicesOf(indices: number[]): number[] {
    const n = count()
    return [...new Set((indices ?? []).filter(i => Number.isInteger(i) && i >= 0 && i < n))].sort((a, b) => a - b)
  }

  function errorOf(err: any): string { return err?.message || String(err) }

  // ───────────────────────── Organize pages ─────────────────────────

  /**
   * Put the pages in a new order. `order` may also be a SUBSET — the pages it
   * leaves out are deleted — which is how several pages go in one step.
   */
  function rearrange(order: number[]): { success: boolean; pageCount?: number; error?: string } {
    const n = count()
    if (!order.length) return { success: false, error: 'A document needs at least one page' }
    if (order.some(i => !Number.isInteger(i) || i < 0 || i >= n)) return { success: false, error: 'Page index out of range' }
    ctx.invalidateContentSources()
    doc().rearrangePages(order)
    return { success: true, pageCount: count() }
  }

  function deletePages(indices: number[]) {
    const drop = new Set(indicesOf(indices))
    const keep: number[] = []
    for (let i = 0; i < count(); i++) if (!drop.has(i)) keep.push(i)
    if (!keep.length) return { success: false, error: 'You cannot delete every page of the document' }
    return rearrange(keep)
  }

  function rotatePages(indices: number[], degrees: number): { success: boolean; error?: string } {
    for (const i of indicesOf(indices)) {
      const r = ctx.rotatePage(i, degrees)
      if (!r.success) return { success: false, error: r.error }
    }
    return { success: true }
  }

  /** Copy the given pages, in this order, into a new document. */
  function extractPages(indices: number[]): { success: boolean; bytes?: ArrayBuffer; error?: string } {
    const list = (indices ?? []).filter(i => i >= 0 && i < count())
    if (!list.length) return { success: false, error: 'No pages selected' }
    const out = new (ctx.mupdf().PDFDocument)()
    try {
      for (const i of list) out.graftPage(out.countPages(), doc(), i)
      return { success: true, bytes: save(out) }
    } catch (err) {
      return { success: false, error: errorOf(err) }
    } finally {
      out.destroy()
    }
  }

  /**
   * Split into documents of `every` pages, or at the given page indices (each
   * index STARTS a new part). One byte buffer per part.
   */
  function split(opts: { every?: number; at?: number[] }): { success: boolean; parts?: ArrayBuffer[]; error?: string } {
    const n = count()
    const starts = new Set<number>([0])
    if (opts.every && opts.every > 0) for (let i = opts.every; i < n; i += opts.every) starts.add(i)
    for (const a of opts.at ?? []) if (a > 0 && a < n) starts.add(a)
    const bounds = [...starts].sort((a, b) => a - b)
    if (bounds.length < 2) return { success: false, error: 'That would produce a single file — nothing to split' }
    const parts: ArrayBuffer[] = []
    for (let k = 0; k < bounds.length; k++) {
      const from = bounds[k], to = k + 1 < bounds.length ? bounds[k + 1] : n
      const r = extractPages(Array.from({ length: to - from }, (_, j) => from + j))
      if (!r.success || !r.bytes) return { success: false, error: r.error }
      parts.push(r.bytes)
    }
    return { success: true, parts }
  }

  /**
   * Replace the selected pages with the first pages of another PDF, one for
   * one, each landing where the page it replaces was.
   */
  function replacePages(indices: number[], bytes: ArrayBuffer): { success: boolean; replaced?: number; pageCount?: number; error?: string } {
    const list = indicesOf(indices)
    if (!list.length) return { success: false, error: 'No pages selected' }
    const src = new (ctx.mupdf().PDFDocument)(new Uint8Array(bytes))
    try {
      const n = Math.min(list.length, src.countPages())
      if (!n) return { success: false, error: 'That file has no pages' }
      ctx.invalidateContentSources()
      for (let k = 0; k < n; k++) {
        doc().deletePage(list[k])
        doc().graftPage(list[k], src, k)
      }
      return { success: true, replaced: n, pageCount: count() }
    } catch (err) {
      return { success: false, error: errorOf(err) }
    } finally {
      src.destroy()
    }
  }

  // ───────────────────────── Crop ─────────────────────────

  function boxOf(pageObj: any, key: string): [number, number, number, number] | null {
    try {
      const box = pageObj.getInheritable(key)
      if (ctx.isNullObj(box)) return null
      const b = box.resolve?.() ?? box
      const v = [0, 1, 2, 3].map(i => b.get(i).asNumber())
      return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])]
    } catch (_) {
      return null
    }
  }

  /**
   * Crop pages by margins measured from the edges of the paper AS SEEN (after
   * /Rotate), in points. All zeros removes the crop. The margins are mapped
   * onto the unrotated MediaBox, because that is the space a CropBox is stated
   * in: on a page turned a quarter clockwise the visible TOP is the raw page's
   * LEFT edge.
   */
  function cropPages(indices: number[], m: { top: number; right: number; bottom: number; left: number }): { success: boolean; error?: string } {
    for (const i of indicesOf(indices)) {
      const page = doc().loadPage(i)
      try {
        const pageObj = page.getObject()
        const media = boxOf(pageObj, 'MediaBox')
        if (!media) continue
        const rot = ctx.getPageSize(i).rotation
        let L = m.left, B = m.bottom, R = m.right, T = m.top
        if (rot === 90) { L = m.bottom; B = m.right; R = m.top; T = m.left }
        else if (rot === 180) { L = m.right; B = m.top; R = m.left; T = m.bottom }
        else if (rot === 270) { L = m.top; B = m.left; R = m.bottom; T = m.right }
        if (L === 0 && B === 0 && R === 0 && T === 0) {
          try { pageObj.delete('CropBox') } catch (_) { /* none */ }
        } else {
          const box = [media[0] + L, media[1] + B, media[2] - R, media[3] - T]
          if (box[2] - box[0] < 18 || box[3] - box[1] < 18) {
            return { success: false, error: 'Those margins leave less than a quarter of an inch of the page' }
          }
          const arr = doc().newArray()
          for (const v of box) arr.push(doc().newReal(v))
          pageObj.put('CropBox', arr)
        }
      } catch (err) {
        return { success: false, error: errorOf(err) }
      } finally {
        page.destroy()
      }
      ctx.invalidateContentSources(i)
    }
    return { success: true }
  }

  /** The visible margins the current crop leaves on a page, in points. */
  function cropOf(pageIndex: number): { top: number; right: number; bottom: number; left: number } {
    const page = doc().loadPage(pageIndex)
    try {
      const pageObj = page.getObject()
      const media = boxOf(pageObj, 'MediaBox')
      const crop = boxOf(pageObj, 'CropBox')
      if (!media || !crop) return { top: 0, right: 0, bottom: 0, left: 0 }
      const L = crop[0] - media[0], B = crop[1] - media[1], R = media[2] - crop[2], T = media[3] - crop[3]
      const rot = ctx.getPageSize(pageIndex).rotation
      if (rot === 90) return { bottom: L, right: B, top: R, left: T }
      if (rot === 180) return { right: L, top: B, left: R, bottom: T }
      if (rot === 270) return { top: L, left: B, bottom: R, right: T }
      return { left: L, bottom: B, right: R, top: T }
    } finally {
      page.destroy()
    }
  }

  // ───────────────────────── Tagged page content ─────────────────────────

  /** A tagged block of content, prepended (behind everything) or appended. */
  function writeTagged(pageIndex: number, tag: string, body: string, behind: boolean): void {
    const page = doc().loadPage(pageIndex)
    try {
      const pageObj = page.getObject()
      const existing = ctx.readContentStream(pageIndex)
      const block = `\n/${tag} BMC\n${body}\nEMC\n`
      const bytes = bytesOf(behind ? block + existing : existing + block)
      const contents = pageObj.get('Contents')
      const isStream = !!contents && String(contents) !== 'null' && typeof contents.isStream === 'function' && contents.isStream()
      if (isStream) contents.writeStream(bytes)
      else pageObj.put('Contents', doc().addStream(bytes, {}))
    } finally {
      page.destroy()
    }
    ctx.invalidateContentSources(pageIndex)
  }

  /** An ExtGState with this fill/stroke opacity in the page's own resources. */
  function opacityState(pageObj: any, opacity: number): string {
    const d = doc()
    const res = ctx.ownPageResources(pageObj).resolve()
    let gs = res.get('ExtGState')
    if (ctx.isNullObj(gs)) { gs = d.newDictionary(); res.put('ExtGState', gs) }
    gs = gs.resolve()
    const name = `GSAcro${Math.round(opacity * 100)}`
    if (ctx.isNullObj(gs.get(name))) {
      const st = d.newDictionary()
      st.put('Type', d.newName('ExtGState'))
      st.put('ca', d.newReal(opacity))
      st.put('CA', d.newReal(opacity))
      gs.put(name, d.addObject(st))
    }
    return name
  }

  /** Text with Acrobat's header/footer tokens filled in. */
  function expand(text: string, page: number, total: number, date: string): string {
    return text
      .replace(/<<n>>/g, String(total))
      .replace(/<<1>>/g, String(page))
      .replace(/<<fecha>>/g, date)
  }

  interface HeaderFooterOpts {
    pages: number[]
    header: { left: string; center: string; right: string }
    footer: { left: string; center: string; right: string }
    fontName: string
    fontSize: number
    color: [number, number, number]
    margins: { top: number; bottom: number; left: number; right: number }
    startNumber: number
    date: string
  }

  /**
   * Acrobat's "Encabezado y pie de página": up to six runs of text per page,
   * tagged so the next "Actualizar" or "Quitar" finds and replaces them
   * rather than stacking a second header on the first.
   */
  function headerFooter(o: HeaderFooterOpts): { success: boolean; pages?: number; error?: string } {
    const list = indicesOf(o.pages)
    const total = count()
    let done = 0
    for (const [k, i] of list.entries()) {
      ctx.removeMarkedContent(i, HF_TAG)
      const size = ctx.getPageSize(i)
      const parts: AcroTextPart[] = []
      const place = (raw: string, where: 'left' | 'center' | 'right', baseline: number) => {
        const text = expand(raw ?? '', (o.startNumber ?? 1) + k, total, o.date ?? '')
        if (!text.trim()) return
        const w = ctx.measureRunWidth(text, o.fontSize, o.fontName).width
        const x = where === 'left' ? o.margins.left
          : where === 'right' ? size.width - o.margins.right - w
          : (size.width - w) / 2
        parts.push({ x, y: baseline, text, fontSize: o.fontSize, fontName: o.fontName, color: o.color })
      }
      const top = size.height - o.margins.top - o.fontSize * 0.8
      const bottom = o.margins.bottom
      place(o.header.left, 'left', top); place(o.header.center, 'center', top); place(o.header.right, 'right', top)
      place(o.footer.left, 'left', bottom); place(o.footer.center, 'center', bottom); place(o.footer.right, 'right', bottom)
      ctx.invalidateContentSources(i)
      if (!parts.length) continue
      const r = ctx.addTextRunToPage(i, parts, 0, HF_TAG)
      if (!r.success) return { success: false, error: r.error }
      ctx.invalidateContentSources(i)
      done++
    }
    return { success: true, pages: done }
  }

  interface WatermarkOpts {
    pages: number[]
    text: string
    fontName: string
    /** Share of the page's width the text should span, 0..1; overrides fontSize when set. */
    widthFraction?: number
    fontSize: number
    color: [number, number, number]
    opacity: number
    rotation: number
    behind: boolean
    vAlign: 'top' | 'middle' | 'bottom'
  }

  /**
   * Acrobat's "Marca de agua": one run of text across the page, turned and
   * translucent, written into the content stream (behind or in front of the
   * page) inside a tagged section so it can be updated or removed.
   */
  function watermark(o: WatermarkOpts): { success: boolean; pages?: number; error?: string } {
    if (!o.text?.trim()) return { success: false, error: 'The watermark has no text' }
    let done = 0
    for (const i of indicesOf(o.pages)) {
      ctx.removeMarkedContent(i, WM_TAG)
      ctx.invalidateContentSources(i)
      const size = ctx.getPageSize(i)
      let body = ''
      const page = doc().loadPage(i)
      try {
        const pageObj = page.getObject()
        let fontSize = o.fontSize
        const at10 = ctx.measureRunWidth(o.text, 10, o.fontName).width
        if (o.widthFraction && at10 > 0) fontSize = Math.max(6, Math.min(400, (size.width * o.widthFraction) / at10 * 10))
        const built = ctx.buildShowOps(pageObj, o.text, fontSize, o.fontName)
        if ('error' in built) return { success: false, error: built.error }
        const w = ctx.measureRunWidth(o.text, fontSize, o.fontName).width
        const rad = (o.rotation * Math.PI) / 180
        const ca = Math.cos(rad), sa = Math.sin(rad)
        const cy = o.vAlign === 'top' ? size.height * 0.8 : o.vAlign === 'bottom' ? size.height * 0.2 : size.height / 2
        const cx = size.width / 2
        // Start the baseline so the run's CENTRE lands on (cx, cy).
        const hx = w / 2, hy = fontSize * 0.35
        const x = cx - (ca * hx - sa * hy)
        const y = cy - (sa * hx + ca * hy)
        let tm: Mat6 = [ca, sa, -sa, ca, x, y]
        const pageRot = ctx.pageRotationCtm(i)
        if (pageRot) { const inv = ctx.matInvert(pageRot); if (inv) tm = ctx.matConcat(tm, inv) }
        if (!o.behind) {
          // Appended after whatever the stream leaves in force: undo it.
          const existing = ctx.readContentStream(i)
          const endCtm = ctx.getCtmAtOffset(existing, existing.length)
          if (endCtm.some((v, j) => Math.abs(v - [1, 0, 0, 1, 0, 0][j]) > 1e-9)) {
            const endInv = ctx.matInvert(endCtm)
            if (endInv) tm = ctx.matConcat(tm, endInv)
          }
        }
        const gs = opacityState(pageObj, Math.max(0.02, Math.min(1, o.opacity)))
        const [r, g, b] = o.color
        body = `q\n/${gs} gs\nBT\n0 Tc 0 Tw 0 Ts 0 Tr 100 Tz\n${r} ${g} ${b} rg\n` +
          `${tm.map(v => ctx.fmtNum(v)).join(' ')} Tm\n${built.ops}\nET\nQ`
      } catch (err) {
        return { success: false, error: errorOf(err) }
      } finally {
        page.destroy()
      }
      writeTagged(i, WM_TAG, body, o.behind)
      const pg = doc().loadPage(i)
      try { pg.getObject().put(WM_KEY, doc().newString(o.text)) } finally { pg.destroy() }
      done++
    }
    return { success: true, pages: done }
  }

  /** Acrobat's "Fondo": a page-sized fill behind everything, tagged for removal. */
  function background(o: { pages: number[]; color: [number, number, number]; opacity: number }): { success: boolean; pages?: number; error?: string } {
    let done = 0
    for (const i of indicesOf(o.pages)) {
      ctx.removeMarkedContent(i, BG_TAG)
      ctx.invalidateContentSources(i)
      let body = ''
      const page = doc().loadPage(i)
      try {
        const pageObj = page.getObject()
        const box = boxOf(pageObj, 'MediaBox')
        if (!box) continue
        const gs = opacityState(pageObj, Math.max(0.02, Math.min(1, o.opacity)))
        const [r, g, b] = o.color
        const f = ctx.fmtNum
        body = `q\n/${gs} gs\n${r} ${g} ${b} rg\n${f(box[0])} ${f(box[1])} ${f(box[2] - box[0])} ${f(box[3] - box[1])} re f\nQ`
      } catch (err) {
        return { success: false, error: errorOf(err) }
      } finally {
        page.destroy()
      }
      writeTagged(i, BG_TAG, body, true)
      done++
    }
    return { success: true, pages: done }
  }

  /** Remove what a tool wrote (header/footer, watermark, background) from every page. */
  function removeTagged(kind: 'headerFooter' | 'watermark' | 'background'): { success: boolean; removed: number } {
    const tag = kind === 'headerFooter' ? HF_TAG : kind === 'watermark' ? WM_TAG : BG_TAG
    let removed = 0
    for (let i = 0; i < count(); i++) {
      const r = ctx.removeMarkedContent(i, tag)
      if (r.removed) { removed += r.removed; ctx.invalidateContentSources(i) }
      if (kind === 'watermark') {
        const pg = doc().loadPage(i)
        try { pg.getObject().delete(WM_KEY) } catch (_) { /* none */ } finally { pg.destroy() }
      }
    }
    return { success: true, removed }
  }

  /** The watermark text this editor wrote on a page, or ''. */
  function watermarkTextOf(pageIndex: number): string {
    const pg = doc().loadPage(pageIndex)
    try {
      const v = pg.getObject().get(WM_KEY)
      return ctx.isNullObj(v) ? '' : String(v.asString?.() ?? '')
    } catch (_) {
      return ''
    } finally {
      pg.destroy()
    }
  }

  /**
   * Is this extracted block a piece of the page's watermark? A watermark is
   * an artifact, the way Acrobat treats one: it is not text to click and edit
   * (it is updated or removed from its own menu), and a turned watermark
   * extracts as a scatter of one-letter blocks over the body text that would
   * otherwise catch every click. A block qualifies when its text is part of
   * the watermark's AND it is turned — or, upright, when it IS the watermark.
   */
  function filterWatermark<B extends { text: string; chars: { quad: number[] }[] }>(pageIndex: number, blocks: B[]): B[] {
    const wm = watermarkTextOf(pageIndex).replace(/\s+/g, '')
    if (!wm) return blocks
    return blocks.filter(b => {
      const t = b.text.replace(/\s+/g, '')
      if (!t || !wm.includes(t)) return true
      if (t === wm) return false
      const q = b.chars[0]?.quad
      const turned = !!q && Math.abs(q[3] - q[1]) > Math.abs(q[2] - q[0]) * 0.2
      return !turned
    })
  }

  function hasTagged(): { headerFooter: boolean; watermark: boolean; background: boolean } {
    const out = { headerFooter: false, watermark: false, background: false }
    for (let i = 0; i < count(); i++) {
      out.headerFooter ||= ctx.hasMarkedContent(i, HF_TAG)
      out.watermark ||= ctx.hasMarkedContent(i, WM_TAG)
      out.background ||= ctx.hasMarkedContent(i, BG_TAG)
      if (out.headerFooter && out.watermark && out.background) break
    }
    return out
  }

  // ───────────────────────── Redact ─────────────────────────

  /** Mark an area for redaction (a Redact annotation, applied later). */
  function addRedaction(pageIndex: number, rect: [number, number, number, number]): { success: boolean; error?: string } {
    const page = doc().loadPage(pageIndex)
    try {
      const annot = page.createAnnotation('Redact')
      annot.setRect(rect as any)
      annot.update()
      return { success: true }
    } catch (err) {
      return { success: false, error: errorOf(err) }
    } finally {
      page.destroy()
    }
  }

  /**
   * Apply every Redact annotation in the document: the text, images and
   * vector art beneath each are REMOVED from the file (not covered), and a
   * black box is drawn where they were.
   */
  function applyRedactions(): { success: boolean; pages: number; error?: string } {
    let pages = 0
    try {
      for (let i = 0; i < count(); i++) {
        const page = doc().loadPage(i)
        try {
          const has = page.getAnnotations().some((a: any) => a.getType() === 'Redact')
          if (has) { page.applyRedactions(true, 2); pages++; ctx.invalidateContentSources(i) }
        } finally {
          page.destroy()
        }
      }
      return { success: true, pages }
    } catch (err) {
      return { success: false, pages, error: errorOf(err) }
    }
  }

  function countRedactions(): number {
    let n = 0
    for (let i = 0; i < count(); i++) {
      const page = doc().loadPage(i)
      try { n += page.getAnnotations().filter((a: any) => a.getType() === 'Redact').length } finally { page.destroy() }
    }
    return n
  }

  // ───────────────────────── Stamps ─────────────────────────

  /**
   * One of Acrobat's standard stamps ("Approved", "Draft", "Confidential"…) as
   * a Stamp annotation: MuPDF draws the standard appearance for the name, so
   * the stamp looks the same in every viewer, and it stays movable.
   */
  function addStamp(pageIndex: number, rect: [number, number, number, number], icon: string): { success: boolean; error?: string } {
    const page = doc().loadPage(pageIndex)
    try {
      const annot = page.createAnnotation('Stamp')
      annot.setRect(rect as any)
      try { annot.setIcon(icon) } catch (_) { /* unknown name: the default stamp */ }
      annot.update()
      return { success: true }
    } catch (err) {
      return { success: false, error: errorOf(err) }
    } finally {
      page.destroy()
    }
  }

  // ───────────────────────── Links ─────────────────────────

  /** A link to a web address, or to a page of this document (1-based). */
  function addLink(pageIndex: number, rect: [number, number, number, number], target: { uri?: string; page?: number }): { success: boolean; error?: string } {
    const page = doc().loadPage(pageIndex)
    try {
      const uri = target.uri
        ? target.uri
        : doc().formatLinkURI({ type: 'Fit', page: Math.max(0, (target.page ?? 1) - 1) })
      page.createLink(rect as any, uri)
      return { success: true }
    } catch (err) {
      return { success: false, error: errorOf(err) }
    } finally {
      page.destroy()
    }
  }

  function listLinks(pageIndex: number): { rect: number[]; uri: string; external: boolean; page: number | null }[] {
    const page = doc().loadPage(pageIndex)
    try {
      return page.getLinks().map((l: any) => {
        const uri = l.getURI() as string
        const m = /#page=(\d+)/.exec(uri || '')
        return { rect: Array.from(l.getBounds()) as number[], uri, external: l.isExternal(), page: m ? Number(m[1]) : null }
      })
    } finally {
      page.destroy()
    }
  }

  function deleteLink(pageIndex: number, index: number): { success: boolean; error?: string } {
    const page = doc().loadPage(pageIndex)
    try {
      const links = page.getLinks()
      if (!links[index]) return { success: false, error: 'No such link' }
      page.deleteLink(links[index])
      return { success: true }
    } catch (err) {
      return { success: false, error: errorOf(err) }
    } finally {
      page.destroy()
    }
  }

  // ───────────────────────── Bookmarks, properties ─────────────────────────

  /** The document's bookmarks, as a tree. */
  function outline(): any[] {
    try {
      const walk = (items: any[] | null | undefined): any[] => (items ?? []).map(it => ({
        title: it.title ?? '',
        page: typeof it.page === 'number' ? it.page : null,
        uri: it.uri ?? null,
        open: !!it.open,
        children: walk(it.down)
      }))
      return walk(doc().loadOutline())
    } catch (_) {
      return []
    }
  }

  const META_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate']

  function getMetadata(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const k of META_KEYS) out[k] = doc().getMetaData(`info:${k}`) ?? ''
    out.format = doc().getMetaData('format') ?? ''
    out.encryption = doc().getMetaData('encryption') ?? ''
    out.pageCount = String(count())
    try {
      const s = ctx.getPageSize(0)
      out.pageSize = `${(s.width / 72 * 25.4).toFixed(0)} × ${(s.height / 72 * 25.4).toFixed(0)} mm (${s.width.toFixed(0)} × ${s.height.toFixed(0)} pt)`
    } catch (_) { out.pageSize = '' }
    return out
  }

  function setMetadata(meta: Record<string, string>): { success: boolean } {
    for (const k of ['Title', 'Author', 'Subject', 'Keywords']) {
      if (typeof meta[k] === 'string') doc().setMetaData(`info:${k}`, meta[k])
    }
    return { success: true }
  }

  // ───────────────────────── Export ─────────────────────────

  /** Plain text of every page, pages separated by a form feed. */
  function exportText(): string {
    const parts: string[] = []
    for (let i = 0; i < count(); i++) {
      const page = doc().loadPage(i)
      try { parts.push(page.toStructuredText('preserve-whitespace').asText()) } finally { page.destroy() }
    }
    return parts.join('\n\f\n')
  }

  /** Every page as positioned HTML. */
  function exportHtml(): string {
    const parts: string[] = []
    for (let i = 0; i < count(); i++) {
      const page = doc().loadPage(i)
      try { parts.push(page.toStructuredText('preserve-whitespace').asHTML(i)) } finally { page.destroy() }
    }
    return parts.join('\n')
  }

  /** Structured text of every page (blocks → lines → font and text), for the Word export. */
  function exportStructured(): any[] {
    const out: any[] = []
    for (let i = 0; i < count(); i++) {
      const page = doc().loadPage(i)
      try {
        const b = page.getBounds()
        out.push({ width: b[2] - b[0], height: b[3] - b[1], ...JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) })
      } finally {
        page.destroy()
      }
    }
    return out
  }

  /** One page as an encoded image. */
  function renderImage(pageIndex: number, scale: number, format: 'png' | 'jpeg', quality = 90): ArrayBuffer {
    const mupdf = ctx.mupdf()
    const page = doc().loadPage(pageIndex)
    try {
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
      try {
        const enc = format === 'jpeg' ? pix.asJPEG(quality, false) : pix.asPNG()
        return (enc as Uint8Array).slice().buffer
      } finally {
        pix.destroy()
      }
    } finally {
      page.destroy()
    }
  }

  // ───────────────────────── Create ─────────────────────────

  /**
   * Acrobat's "Crear PDF" from pictures: one page per image, each the size the
   * image prints at (its own resolution, 96 DPI when it states none) — or a
   * single blank page when there are none.
   */
  function createPdf(images: ArrayBuffer[], blank?: { width: number; height: number }): { success: boolean; bytes?: ArrayBuffer; pages?: number; error?: string } {
    const mupdf = ctx.mupdf()
    const out = new mupdf.PDFDocument()
    try {
      if (!images.length) {
        const w = blank?.width ?? 595.28, h = blank?.height ?? 841.89
        out.insertPage(-1, out.addPage([0, 0, w, h], 0, out.newDictionary(), ''))
      }
      for (const bytes of images) {
        const img = new mupdf.Image(new Uint8Array(bytes))
        try {
          const xres = img.getXResolution?.() || 96
          const yres = img.getYResolution?.() || 96
          const w = img.getWidth() * 72 / xres
          const h = img.getHeight() * 72 / yres
          const res = out.newDictionary()
          const xo = out.newDictionary()
          xo.put('Im0', out.addImage(img))
          res.put('XObject', xo)
          out.insertPage(-1, out.addPage([0, 0, w, h], 0, res, `q ${ctx.fmtNum(w)} 0 0 ${ctx.fmtNum(h)} 0 0 cm /Im0 Do Q`))
        } finally {
          img.destroy()
        }
      }
      const pages = out.countPages()
      return { success: true, bytes: save(out), pages }
    } catch (err) {
      return { success: false, error: errorOf(err) }
    } finally {
      out.destroy()
    }
  }

  /** Burn annotations and form fields into the page content ("Acoplar"). */
  function flatten(): { success: boolean; error?: string } {
    try {
      doc().bake(true, true)
      ctx.invalidateContentSources()
      return { success: true }
    } catch (err) {
      return { success: false, error: errorOf(err) }
    }
  }

  // ───────────────────────── Protect ─────────────────────────

  /**
   * The PDF permission word (ISO 32000-1 Table 22): bits 1–2 must be 0, bits
   * 7–8 and 13–32 must be 1, the rest are what is granted.
   */
  function permissionsWord(p: { print?: boolean; copy?: boolean; modify?: boolean; annotate?: boolean }): number {
    let bits = -3904 // every permission off
    if (p.print) bits |= 4 | 2048
    if (p.modify) bits |= 8 | 1024
    if (p.copy) bits |= 16 | 512
    if (p.annotate) bits |= 32 | 256
    return bits
  }

  /** Save with password protection (AES-256). The engine's own copy stays unencrypted. */
  function saveProtected(o: { userPassword?: string; ownerPassword?: string; permissions?: { print?: boolean; copy?: boolean; modify?: boolean; annotate?: boolean } }): ArrayBuffer {
    // MuPDF's option string is comma- and equals-separated: neither can be
    // part of a password written through it.
    const clean = (s: string) => (s ?? '').replace(/[,=\s]/g, '')
    const opts = ['compress', 'garbage=compact', 'encrypt=aes-256']
    const user = clean(o.userPassword ?? '')
    const owner = clean(o.ownerPassword ?? '') || user || Math.random().toString(36).slice(2)
    if (user) opts.push(`user-password=${user}`)
    opts.push(`owner-password=${owner}`)
    opts.push(`permissions=${permissionsWord(o.permissions ?? { print: true, copy: true, modify: true, annotate: true })}`)
    return save(doc(), opts.join(','))
  }

  function needsPassword(bytes: ArrayBuffer): boolean {
    const d = ctx.mupdf().Document.openDocument(new Uint8Array(bytes), 'application/pdf')
    try { return d.needsPassword() } finally { d.destroy() }
  }

  /** Open a protected file with its password and hand back the plain document. */
  function unlock(bytes: ArrayBuffer, password: string): { success: boolean; bytes?: ArrayBuffer; error?: string } {
    const d = ctx.mupdf().Document.openDocument(new Uint8Array(bytes), 'application/pdf')
    try {
      if (d.needsPassword() && !d.authenticatePassword(password)) return { success: false, error: 'Incorrect password' }
      return { success: true, bytes: save(d.asPDF(), 'compress,garbage=compact,decrypt') }
    } catch (err) {
      return { success: false, error: errorOf(err) }
    } finally {
      d.destroy()
    }
  }

  // ───────────────────────── Dispatch ─────────────────────────

  const dispatch = function dispatch(op: string, a: any): { data: any; transfer?: Transferable[] } {
    switch (op) {
      case 'rearrange': return { data: rearrange(a.order) }
      case 'deletePages': return { data: deletePages(a.indices) }
      case 'rotatePages': return { data: rotatePages(a.indices, a.degrees) }
      case 'extractPages': { const r = extractPages(a.indices); return { data: r, transfer: r.bytes ? [r.bytes] : [] } }
      case 'split': { const r = split(a); return { data: r, transfer: r.parts ?? [] } }
      case 'replacePages': return { data: replacePages(a.indices, a.bytes) }
      case 'cropPages': return { data: cropPages(a.indices, a.margins) }
      case 'cropOf': return { data: cropOf(a.pageIndex) }
      case 'headerFooter': return { data: headerFooter(a) }
      case 'watermark': return { data: watermark(a) }
      case 'background': return { data: background(a) }
      case 'removeTagged': return { data: removeTagged(a.kind) }
      case 'hasTagged': return { data: hasTagged() }
      case 'addRedaction': return { data: addRedaction(a.pageIndex, a.rect) }
      case 'applyRedactions': return { data: applyRedactions() }
      case 'countRedactions': return { data: countRedactions() }
      case 'addStamp': return { data: addStamp(a.pageIndex, a.rect, a.icon) }
      case 'addLink': return { data: addLink(a.pageIndex, a.rect, a.target) }
      case 'listLinks': return { data: listLinks(a.pageIndex) }
      case 'deleteLink': return { data: deleteLink(a.pageIndex, a.index) }
      case 'outline': return { data: outline() }
      case 'getMetadata': return { data: getMetadata() }
      case 'setMetadata': return { data: setMetadata(a.meta) }
      case 'exportText': return { data: exportText() }
      case 'exportHtml': return { data: exportHtml() }
      case 'exportStructured': return { data: exportStructured() }
      case 'renderImage': { const b = renderImage(a.pageIndex, a.scale, a.format, a.quality); return { data: b, transfer: [b] } }
      case 'createPdf': { const r = createPdf(a.images ?? [], a.blank); return { data: r, transfer: r.bytes ? [r.bytes] : [] } }
      case 'flatten': return { data: flatten() }
      case 'saveProtected': { const b = saveProtected(a); return { data: b, transfer: [b] } }
      case 'needsPassword': return { data: needsPassword(a.bytes) }
      case 'unlock': { const r = unlock(a.bytes, a.password); return { data: r, transfer: r.bytes ? [r.bytes] : [] } }
      default: throw new Error(`Unknown Acrobat operation: ${op}`)
    }
  }
  return Object.assign(dispatch, { filterWatermark })
}

/** Operations that change the document (the rest only read it or make new ones). */
export const ACRO_MUTATING_OPS = new Set([
  'rearrange', 'deletePages', 'rotatePages', 'replacePages', 'cropPages',
  'headerFooter', 'watermark', 'background', 'removeTagged',
  'addRedaction', 'applyRedactions', 'addStamp', 'addLink', 'deleteLink', 'setMetadata', 'flatten'
])
