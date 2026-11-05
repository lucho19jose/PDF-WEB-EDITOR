/**
 * Copying pages into a document WITH what sits on them.
 *
 * MuPDF's `graftPage` copies a page's contents, resources and boxes and
 * nothing else: no /Annots, no form fields, no transparency /Group. A digital
 * signature (Intellisign, DocuSign, Acrobat) is a /Widget annotation of a /Sig
 * field, so every page that went through a bare `graftPage` arrived unsigned.
 * Inserting a signed service order into an invoice in Organizar páginas showed
 * the order without its three signatures or the note written over it; Extraer,
 * Reemplazar, Duplicar and a page dragged out of the app lost them the same way.
 *
 * `graftPagesWithAnnotations` grafts the pages and then copies their
 * annotations by hand, because a plain graft of an annotation follows its /P
 * back to the source page, that page's /Parent to the source page tree, and
 * from there copies the whole source document into this one. The walk stops
 * at pages (mapped onto the copies, or dropped), page trees, catalogs and
 * annotations that are not being copied. A signature dictionary's
 * /Reference /Data names the source catalog, and that is where this matters.
 *
 * Widgets keep their FIELDS: the part of each field tree that leads to a
 * copied widget is copied, and its root is added to this document's /AcroForm.
 * A root whose name is already taken here is renamed with "+1", as the tool
 * that assembled the user's earlier expedientes did ("Signature1+1",
 * "Signature3+1+1"). Two fields of one name are ONE field to a PDF reader, and
 * two signatures sharing a field is not something any reader handles.
 * Signature values (/V) are kept: the signatures look and list exactly as they
 * did. They cannot verify in a file assembled from them, which is equally true
 * of every merge tool, and a signing service treats them as already signed
 * rather than as empty fields it may sign into.
 *
 * The source is only ever read, so the open document can be a source
 * (Extraer). `dst === src` copies inside one document (Duplicar): a reference
 * to something that is NOT being copied is then still valid and is kept.
 */

const ANNOTATION_SUBTYPES = new Set([
  'Text', 'Link', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight',
  'Underline', 'Squiggly', 'StrikeOut', 'Redact', 'Stamp', 'Caret', 'Ink', 'Popup',
  'FileAttachment', 'Sound', 'Movie', 'RichMedia', 'Widget', 'Screen', 'PrinterMark', 'TrapNet',
  'Watermark', '3D', 'Projection'
])
/** Dictionaries that never lead back to a page: shared with the pages' own resources through the graft map. */
const RESOURCE_TYPES = new Set(['Font', 'FontDescriptor', 'Encoding', 'ExtGState', 'OCG', 'OCMD', 'Pattern'])

const DROP = Symbol('drop')
type Copy = any | typeof DROP

export interface GraftPlanItem {
  /** Page index in the source. */
  from: number
  /** Index the copy is inserted at in the destination; -1 appends. */
  at: number
}

export interface GraftResult {
  pages: number
  annotations: number
  fields: number
  /** Fields renamed because their name was already taken. */
  renamed: number
}

function isNull(o: any): boolean {
  return !o || o.isNull()
}

function nameOf(o: any): string | null {
  try { return o && o.isName() ? o.asName() : null } catch { return null }
}

function pageIndexOf(doc: any, num: number): number {
  const n = doc.countPages()
  for (let i = 0; i < n; i++) {
    const ref = doc.findPage(i)
    if (ref.isIndirect() && ref.asIndirect() === num) return i
  }
  return -1
}

/**
 * Graft `plan`'s pages from `src` into `dst`, in order, each with its
 * annotations, its widgets' form fields and its /Group.
 */
export function graftPagesWithAnnotations(dst: any, src: any, plan: GraftPlanItem[]): GraftResult {
  const same = dst === src
  const result: GraftResult = { pages: 0, annotations: 0, fields: 0, renamed: 0 }
  const map = dst.newGraftMap()
  try {
    // ── 1. The pages. All of them first, so a link to a page copied later
    // still finds its copy.
    const sources = plan.map(p => src.findPage(p.from))
    const pairs: { from: any; to: any; annots: Map<number, any> }[] = []
    const pageCopies = new Map<number, any>()
    for (let k = 0; k < plan.length; k++) {
      const from = sources[k]
      const num = from.isIndirect() ? from.asIndirect() : -1
      // Inside one document an earlier insertion may have moved the source.
      const index = same && num > 0 ? pageIndexOf(src, num) : plan[k].from
      if (index < 0) continue
      map.graftPage(plan[k].at, src, index)
      const to = dst.findPage(plan[k].at < 0 ? dst.countPages() - 1 : plan[k].at)
      pairs.push({ from, to, annots: new Map() })
      if (num > 0) pageCopies.set(num, to)
      result.pages++
    }

    const handCopies = new Map<number, any>() // indirect dicts and arrays copied by `copyValue`
    const fieldCopies = new Map<number, any>()
    /** Each source annotation's FIRST copy: what a reference from another page means. */
    const firstAnnotCopies = new Map<number, any>()
    const roots: any[] = []
    let signed = 0

    const isAnnotation = (d: any): boolean =>
      ANNOTATION_SUBTYPES.has(nameOf(d.get('Subtype')) ?? '') && !isNull(d.get('Rect'))
    const isField = (d: any): boolean =>
      !isNull(d.get('FT')) || (!isNull(d.get('T')) && !isNull(d.get('Kids')))
    const isStructural = (d: any): boolean => {
      const t = nameOf(d.get('Type'))
      return t === 'Page' || t === 'Pages' || t === 'Catalog'
    }

    /**
     * A copy of `v` in `dst`, or DROP when it leads somewhere that is not
     * being copied. `scope` is the annotations of the page being filled.
     */
    const copyValue = (v: any, scope: Map<number, any>, depth = 0): Copy => {
      if (isNull(v)) return v
      if (depth > 48) return DROP
      if (v.isIndirect()) {
        const num = v.asIndirect()
        const known = scope.get(num) ?? firstAnnotCopies.get(num) ?? pageCopies.get(num)
          ?? fieldCopies.get(num) ?? handCopies.get(num)
        if (known) return known
        // `isStream` answers false once resolved (MuPDF), so ask the reference.
        if (v.isStream()) return map.graftObject(v)
        const obj = v.resolve()
        if (obj.isDictionary()) {
          if (isStructural(obj) || isAnnotation(obj) || isField(obj)) return same ? v : DROP
          if (RESOURCE_TYPES.has(nameOf(obj.get('Type')) ?? '')) return map.graftObject(v)
          const out = dst.addObject(dst.newDictionary())
          handCopies.set(num, out)
          fillDict(obj, out, scope, depth)
          return out
        }
        if (obj.isArray()) {
          const out = dst.addObject(dst.newArray())
          handCopies.set(num, out)
          fillArray(obj, out, scope, depth)
          return out
        }
        return map.graftObject(v)
      }
      if (v.isDictionary()) {
        const out = dst.newDictionary()
        fillDict(v, out, scope, depth)
        return out
      }
      if (v.isArray()) {
        const out = dst.newArray()
        fillArray(v, out, scope, depth)
        return out
      }
      return map.graftObject(v)
    }
    const fillDict = (from: any, out: any, scope: Map<number, any>, depth: number) => {
      from.forEach((val: any, key: number | string) => {
        const c = copyValue(val, scope, depth + 1)
        if (c !== DROP) out.put(key, c)
      })
    }
    const fillArray = (from: any, out: any, scope: Map<number, any>, depth: number) => {
      for (let i = 0; i < from.length; i++) {
        const c = copyValue(from.get(i), scope, depth + 1)
        out.push(c === DROP ? dst.newNull() : c)
      }
    }

    /** The copy of a field node and every ancestor it hangs from. */
    const fieldCopyOf = (ref: any, scope: Map<number, any>, depth = 0): any => {
      const num = ref.asIndirect()
      const known = fieldCopies.get(num)
      if (known) return known
      const node = ref.resolve()
      const out = dst.addObject(dst.newDictionary())
      fieldCopies.set(num, out)
      node.forEach((val: any, key: number | string) => {
        if (key === 'Kids' || key === 'Parent' || key === 'P') return
        const c = copyValue(val, scope)
        if (c !== DROP) out.put(key, c)
      })
      out.put('Kids', dst.newArray())
      const parent = node.get('Parent')
      if (!isNull(parent) && parent.isIndirect() && depth < 32) {
        const up = fieldCopyOf(parent, scope, depth + 1)
        out.put('Parent', up)
        up.get('Kids').push(out)
      } else {
        roots.push(out)
      }
      return out
    }

    /** Explicit destination of a link: the page it points at, when it is a page. */
    const linkTargetPage = (annot: any): any => {
      let dest = annot.get('Dest')
      const action = annot.get('A')
      if (isNull(dest) && !isNull(action) && nameOf(action.get('S')) === 'GoTo') dest = action.get('D')
      if (isNull(dest)) return null
      const arr = dest.isIndirect() ? dest.resolve() : dest
      if (!arr.isArray() || !arr.length) return null
      const first = arr.get(0)
      return first.isIndirect() ? first : null
    }

    // ── 2. A copy for every annotation that comes along, made before any is
    // filled: a markup's /Popup and its popup's /Parent point at each other.
    const onCopiedPages = new Set<number>()
    for (const { from } of pairs) {
      const annots = from.get('Annots')
      if (isNull(annots) || !annots.isArray()) continue
      for (let i = 0; i < annots.length; i++) {
        const ref = annots.get(i)
        if (ref.isIndirect()) onCopiedPages.add(ref.asIndirect())
      }
    }
    const jobs: { dict: any; copy: any; page: any; scope: Map<number, any> }[] = []
    for (const pair of pairs) {
      const annots = pair.from.get('Annots')
      if (isNull(annots) || !annots.isArray()) continue
      const list = dst.newArray()
      for (let i = 0; i < annots.length; i++) {
        const ref = annots.get(i)
        const dict = ref.resolve()
        if (isNull(dict) || !dict.isDictionary()) continue
        const num = ref.isIndirect() ? ref.asIndirect() : -1
        const subtype = nameOf(dict.get('Subtype'))
        if (!same) {
          // A link into a page left behind would point at nothing.
          if (subtype === 'Link') {
            const target = linkTargetPage(dict)
            if (target && !pageCopies.has(target.asIndirect())) continue
          }
          // A popup whose note stays behind has nothing to show.
          if (subtype === 'Popup') {
            const parent = dict.get('Parent')
            if (!isNull(parent) && parent.isIndirect() && !onCopiedPages.has(parent.asIndirect())) continue
          }
        }
        if (num > 0 && pair.annots.has(num)) continue // listed twice on one page
        const copy = dst.addObject(dst.newDictionary())
        if (num > 0) {
          pair.annots.set(num, copy)
          if (!firstAnnotCopies.has(num)) firstAnnotCopies.set(num, copy)
        }
        jobs.push({ dict, copy, page: pair.to, scope: pair.annots })
        list.push(copy)
      }
      if (list.length) pair.to.put('Annots', list)
      else if (!isNull(pair.to.get('Annots'))) pair.to.delete('Annots')
    }

    // ── 3. Fill them, and hang every widget back on its field.
    for (const { dict, copy, page, scope } of jobs) {
      const widget = nameOf(dict.get('Subtype')) === 'Widget'
      dict.forEach((val: any, key: number | string) => {
        // /StructParent is a key into the SOURCE's structure tree.
        if (key === 'P' || key === 'StructParent') return
        if (widget && (key === 'Parent' || key === 'Kids')) return
        const c = copyValue(val, scope)
        if (c !== DROP) copy.put(key, c)
      })
      copy.put('P', page)
      result.annotations++
      if (!widget) continue
      if (nameOf(dict.getInheritable('FT')) === 'Sig' && !isNull(dict.getInheritable('V'))) signed++
      const parent = dict.get('Parent')
      if (!isNull(parent) && parent.isIndirect()) {
        const up = fieldCopyOf(parent, scope)
        copy.put('Parent', up)
        up.get('Kids').push(copy)
      } else if (!isNull(dict.get('FT')) || !isNull(dict.get('T'))) {
        roots.push(copy) // a widget that is its own field (how signing services write them)
      }
    }

    // ── 4. Register the fields, under names of their own.
    if (roots.length) {
      const catalog = dst.getTrailer().get('Root')
      let form = catalog.get('AcroForm')
      if (isNull(form)) {
        form = dst.addObject(dst.newDictionary())
        catalog.put('AcroForm', form)
      }
      let fields = form.get('Fields')
      if (isNull(fields) || !fields.isArray()) {
        fields = dst.newArray()
        form.put('Fields', fields)
      }
      const taken = new Set<string>()
      for (let i = 0; i < fields.length; i++) {
        const t = fields.get(i).resolve().get('T')
        if (!isNull(t) && t.isString()) taken.add(t.asString())
      }
      for (const root of roots) {
        const t = root.get('T')
        if (!isNull(t) && t.isString()) {
          let name = t.asString()
          if (taken.has(name)) {
            do name += '+1'; while (taken.has(name))
            root.put('T', dst.newString(name))
            result.renamed++
          }
          taken.add(name)
        }
        fields.push(root)
        result.fields++
      }
      // The source form's defaults: a text field without its own /DA, or a
      // font its appearance would be rebuilt with, is resolved through them.
      const srcForm = same ? null : src.getTrailer().get('Root').get('AcroForm')
      if (srcForm && !isNull(srcForm)) {
        const none = new Map<number, any>()
        if (isNull(form.get('DA')) && !isNull(srcForm.get('DA'))) form.put('DA', copyValue(srcForm.get('DA'), none))
        const srcDR = srcForm.get('DR')
        if (!isNull(srcDR)) {
          const dr = form.get('DR')
          if (isNull(dr)) {
            const c = copyValue(srcDR, none)
            if (c !== DROP) form.put('DR', c)
          } else {
            const srcFonts = srcDR.get('Font')
            if (!isNull(srcFonts) && srcFonts.isDictionary()) {
              let fonts = dr.get('Font')
              if (isNull(fonts)) { fonts = dst.newDictionary(); dr.put('Font', fonts) }
              srcFonts.forEach((val: any, key: number | string) => {
                if (!isNull(fonts.get(key))) return
                const c = copyValue(val, none)
                if (c !== DROP) fonts.put(key, c)
              })
            }
          }
        }
      }
      if (signed) {
        const flags = form.get('SigFlags')
        const n = !isNull(flags) && flags.isNumber() ? flags.asNumber() : 0
        if (!(n & 1)) form.put('SigFlags', dst.newInteger(n | 1)) // SignaturesExist
      }
    }

    // ── 5. The transparency group the page was composited in.
    for (const { from, to } of pairs) {
      const group = from.get('Group')
      if (isNull(group) || !isNull(to.get('Group'))) continue
      const c = copyValue(group, new Map())
      if (c !== DROP) to.put('Group', c)
    }
    return result
  } finally {
    map.destroy()
  }
}
