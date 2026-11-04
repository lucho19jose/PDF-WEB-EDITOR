/**
 * Comentar, Sello and Rellenar y firmar: annotations placed over the page,
 * plus the images the page content draws ("Objetos"). Coordinates are points
 * from the top-left corner, the space list_page_text reports.
 */
import fs from 'node:fs'
import { z } from 'zod'
import type { Registrar } from './registrar'
import type { Quad, SearchHit, TextBlock } from '../../../src/engine/types'
import { STAMP_NAMES } from '../../../src/utils/acro/stamps'
import { ok, fail, colorOf, pageIndexOf, resolvePath, readFileBytes, ToolError } from '../util'
import { pageSize } from '../pageInfo'

const docId = z.string().optional().describe('Document id from open_pdf. Optional when only one document is open.')
const page = z.number().int().min(1).describe('Page number, starting at 1')
type Res = { success: boolean; error?: string; index?: number }

/** Pixel size of a PNG, JPEG, GIF or BMP, to keep an image's shape. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const u32 = (o: number) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0
  if (b[0] === 0x89 && b[1] === 0x50) return { width: u32(16), height: u32(20) }
  if (b[0] === 0x47 && b[1] === 0x49) return { width: b[6] | b[7] << 8, height: b[8] | b[9] << 8 }
  if (b[0] === 0x42 && b[1] === 0x4d) return { width: Math.abs(b[18] | b[19] << 8 | b[20] << 16 | b[21] << 24), height: Math.abs(b[22] | b[23] << 8 | b[24] << 16 | b[25] << 24) }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue }
      const m = b[o + 1]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b[o + 7] << 8 | b[o + 8], height: b[o + 5] << 8 | b[o + 6] }
      o += 2 + (b[o + 2] << 8 | b[o + 3])
    }
  }
  return null
}

function rectQuad(x0: number, y0: number, x1: number, y1: number): Quad {
  return [x0, y0, x1, y0, x0, y1, x1, y1]
}

export function registerAnnotateTools(t: Registrar) {
  t.add('add_text_markup', {
    title: 'Highlight, underline or strike out',
    description: 'Highlight (or underline, strike out, squiggle) words on a page: every occurrence of `text` (a single word only matches whole words, so "RUC" does not mark "INFRAESTRUCTURA"), or one rectangle.',
    input: {
      doc_id: docId, page,
      text: z.string().optional().describe('The words to mark'),
      rect: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).optional().describe('Or a rectangle, in points'),
      kind: z.enum(['highlight', 'underline', 'strikeout', 'squiggly']).optional().describe('Default highlight'),
      color: z.string().optional().describe('Hex colour; default yellow for a highlight, red otherwise'),
      occurrence: z.enum(['all', 'first']).optional()
    }
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    const kind = args.kind ?? 'highlight'
    const type = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', squiggly: 'Squiggly' }[kind as string]
    const color = colorOf(args.color, kind === 'highlight' ? '#ffeb3b' : '#e53935')
    let quads: Quad[] = []
    let count = 0
    const e = await s.eng()
    if (args.text?.trim()) {
      const text = args.text.trim()
      let { hits } = await e.send<{ hits: SearchHit[] }>('searchPage', { pageIndex: p, needle: text, maxHits: 500 })
      if (!hits.length) return fail(`"${text}" was not found on page ${p + 1}.`)
      if (/^[\p{L}\p{N}]+$/u.test(text)) {
        const bounded = new RegExp(`(^|[^\\p{L}\\p{N}])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu')
        const blocks = (await e.send<{ blocks: TextBlock[] }>('getPageText', { pageIndex: p })).blocks.filter(b => !b.invisible && b.text.trim())
        const kept = hits.filter(h => {
          const [hx0, hy0, hx1, hy1] = h.rect
          const over = blocks.filter(b => { const [x0, y0, x1, y1] = b.bbox; return hx0 < x1 && hx1 > x0 && hy0 < y1 && hy1 > y0 })
          return over.length === 0 || over.some(b => bounded.test(b.text))
        })
        if (kept.length) hits = kept
      }
      if (args.occurrence === 'first') hits = hits.slice(0, 1)
      quads = hits.flatMap(h => h.quads)
      count = hits.length
    } else if (args.rect) {
      const r = args.rect
      quads = [rectQuad(r.x, r.y, r.x + r.width, r.y + r.height)]
      count = 1
    } else return fail('Give text (the words to mark) or rect.')
    let res: Res = { success: false }
    await s.mutate(async (eng) => {
      res = await eng.send<Res>('addTextMarkup', { pageIndex: p, markupType: type, quads, color, opacity: 1, author: t.author })
      return { ok: res.success, value: null }
    })
    if (!res.success) return fail(`Could not add the ${kind}: ${res.error || 'unknown error'}`)
    return ok({ marked: count, kind, page: p + 1 })
  }))

  t.add('add_note', {
    title: 'Add sticky note',
    description: 'A comment ("nota") pinned at x, y on a page, shown as an icon that opens to its text.',
    input: { doc_id: docId, page, x: z.number(), y: z.number(), text: z.string(), color: z.string().optional().describe('Default yellow') }
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    let res: Res = { success: false }
    await s.mutate(async (e) => {
      res = await e.send<Res>('addStickyNote', { pageIndex: p, x: args.x, y: args.y, text: args.text, color: colorOf(args.color, '#ffeb3b'), author: t.author })
      return { ok: res.success, value: null }
    })
    if (!res.success) return fail(`Could not add the note: ${res.error || 'unknown error'}`)
    return ok({ note: args.text, page: p + 1 })
  }))

  t.add('add_free_text', {
    title: 'Add text box',
    description: 'A text box over the page (Rellenar y firmar / comment text): fill in a form, write on a scan, add a remark. x, y is its top-left corner in points. The box is sized to its text; give width to wrap it. It stays movable and editable in PDF Editor Pro.',
    input: {
      doc_id: docId, page, x: z.number(), y: z.number(), text: z.string().min(1),
      width: z.number().positive().optional().describe('Box width in points; default fits the text'),
      font_size: z.number().min(4).max(144).optional().describe('Default 11'),
      color: z.string().optional().describe('Text colour, default #000000'),
      font: z.enum(['Helvetica', 'Times-Roman', 'Courier']).optional()
    }
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    const size = args.font_size ?? 11
    const font = args.font ?? 'Helvetica'
    const e = await s.eng()
    const pg = await pageSize(s, p)
    const lines = String(args.text).split(/\r?\n/)
    const { widths } = await e.send<{ widths: { width: number }[] }>('measureRuns', { runs: lines.map(l => ({ text: l || ' ', fontSize: size, fontName: font })) })
    const pad = 4
    const room = Math.max(30, pg.width - args.x - 6)
    const w = args.width ?? Math.min(room, Math.max(30, Math.max(...widths.map(x => x.width)) * 1.05 + pad * 2))
    const inner = Math.max(10, w - pad * 2)
    const count = widths.reduce((n, x) => n + Math.max(1, Math.ceil(x.width * 1.05 / inner)), 0)
    const h = count * size * 1.25 + pad * 2
    const rect = [args.x, args.y, args.x + w, Math.min(pg.height, args.y + h)]
    let res: Res = { success: false }
    await s.mutate(async (eng) => {
      res = await eng.send<Res>('addFreeText', { pageIndex: p, rect, text: args.text, fontSize: size, color: colorOf(args.color, '#000000'), fontName: font, author: t.author })
      return { ok: res.success, value: null }
    })
    if (!res.success) return fail(`Could not add the text box: ${res.error || 'unknown error'}`)
    return ok({ added: args.text, page: p + 1, box: { x: Math.round(rect[0]), y: Math.round(rect[1]), w: Math.round(w), h: Math.round(rect[3] - rect[1]) } })
  }))

  t.add('add_shape', {
    title: 'Add shape',
    description: 'A rectangle, ellipse or line drawn over the page (comment shapes). Rectangle/ellipse take x, y, width, height; a line goes from (x, y) to (x2, y2).',
    input: {
      doc_id: docId, page,
      shape: z.enum(['rectangle', 'ellipse', 'line']),
      x: z.number(), y: z.number(),
      width: z.number().positive().optional(), height: z.number().positive().optional(),
      x2: z.number().optional(), y2: z.number().optional(),
      color: z.string().optional().describe('Line colour, default red'),
      fill_color: z.string().optional().describe('Fill, for rectangle/ellipse; default none'),
      line_width: z.number().min(0.1).max(50).optional().describe('Default 1.5'),
      opacity: z.number().min(0.05).max(1).optional()
    }
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    const color = colorOf(args.color, '#e53935')
    const base = { pageIndex: p, color, width: args.line_width ?? 1.5, opacity: args.opacity ?? 1, author: t.author }
    let msg: Record<string, unknown>
    if (args.shape === 'line') {
      if (args.x2 === undefined || args.y2 === undefined) return fail('A line needs x2 and y2.')
      msg = { ...base, shapeType: 'Line', points: [[args.x, args.y], [args.x2, args.y2]] }
    } else {
      if (!args.width || !args.height) return fail(`A ${args.shape} needs width and height.`)
      msg = { ...base, shapeType: args.shape === 'rectangle' ? 'Square' : 'Circle', rect: [args.x, args.y, args.x + args.width, args.y + args.height], interiorColor: args.fill_color ? colorOf(args.fill_color, '#ffffff') : null }
    }
    let res: Res = { success: false }
    await s.mutate(async (e) => { res = await e.send<Res>('addShape', msg); return { ok: res.success, value: null } })
    if (!res.success) return fail(`Could not add the ${args.shape}: ${res.error || 'unknown error'}`)
    return ok({ added: args.shape, page: p + 1 })
  }))

  t.add('add_drawing', {
    title: 'Add freehand drawing',
    description: 'Ink strokes over the page: each stroke is a list of [x, y] points in points from the top-left corner.',
    input: {
      doc_id: docId, page,
      strokes: z.array(z.array(z.tuple([z.number(), z.number()])).min(2)).min(1),
      color: z.string().optional().describe('Default #1a237e'),
      line_width: z.number().min(0.1).max(50).optional().describe('Default 2')
    }
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    let res: Res = { success: false }
    await s.mutate(async (e) => {
      res = await e.send<Res>('addInk', { pageIndex: p, strokes: args.strokes, color: colorOf(args.color, '#1a237e'), width: args.line_width ?? 2, opacity: 1, author: t.author })
      return { ok: res.success, value: null }
    })
    if (!res.success) return fail(`Could not add the drawing: ${res.error || 'unknown error'}`)
    return ok({ strokes: args.strokes.length, page: p + 1 })
  }))

  t.add('add_stamp', {
    title: 'Add stamp',
    description: `A standard stamp (Sello) at x, y: ${STAMP_NAMES.map(s => `${s.name} ("${s.label}")`).join(', ')}.`,
    input: {
      doc_id: docId, page,
      stamp: z.enum(STAMP_NAMES.map(s => s.name) as [string, ...string[]]),
      x: z.number(), y: z.number(),
      width: z.number().positive().optional().describe('Default 150 pt')
    }
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    const w = args.width ?? 150
    const rect = [args.x, args.y, args.x + w, args.y + w * 0.32]
    let res: Res = { success: false }
    await s.mutate(async (e) => { res = await e.acro<Res>('addStamp', { pageIndex: p, rect, icon: args.stamp }); return { ok: !!res?.success, value: null } })
    if (!res?.success) return fail(`Could not add the stamp: ${res?.error || 'unknown error'}`)
    return ok({ stamp: args.stamp, page: p + 1 })
  }))

  t.add('add_mark', {
    title: 'Add form mark',
    description: 'A Fill & Sign mark — check (✓), cross (✗), dot, line or box — with its top-left corner at x, y, e.g. to tick a checkbox on a form or a scan.',
    input: {
      doc_id: docId, page,
      mark: z.enum(['check', 'cross', 'dot', 'line', 'box']),
      x: z.number(), y: z.number(),
      size: z.number().min(3).max(200).optional().describe('Side in points, default 10'),
      color: z.string().optional().describe('Default #000000')
    }
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    const sz = args.size ?? 10
    const [x0, y0, x1, y1] = [args.x, args.y, args.x + sz, args.y + sz]
    const w = x1 - x0, h = y1 - y0
    const color = colorOf(args.color, '#000000')
    const width = Math.max(1, Math.min(w, h) / 7)
    const a = { pageIndex: p, color, opacity: 1, author: t.author }
    // The same strokes as AnnotationLayer.placeSymbol.
    const msg: [string, Record<string, unknown>] =
      args.mark === 'check' ? ['addInk', { ...a, width, strokes: [[[x0, y0 + h * 0.55], [x0 + w * 0.38, y1], [x1, y0]]] }]
      : args.mark === 'cross' ? ['addInk', { ...a, width, strokes: [[[x0, y0], [x1, y1]], [[x1, y0], [x0, y1]]] }]
      : args.mark === 'dot' ? ['addShape', { ...a, shapeType: 'Circle', rect: [x0, y0, x1, y1], interiorColor: color, width: 0.5 }]
      : args.mark === 'line' ? ['addShape', { ...a, shapeType: 'Line', points: [[x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2]], width: 1.5 }]
      : ['addShape', { ...a, shapeType: 'Square', rect: [x0, y0, x1, y1], interiorColor: null, width: 1.5 }]
    let res: Res = { success: false }
    await s.mutate(async (e) => { res = await e.send<Res>(msg[0], msg[1]); return { ok: res.success, value: null } })
    if (!res.success) return fail(`Could not add the mark: ${res.error || 'unknown error'}`)
    return ok({ mark: args.mark, page: p + 1 })
  }))

  t.add('add_image', {
    title: 'Add image or signature',
    description: 'Place an image file (a logo, a photo, a signature or initials) on a page with its top-left corner at x, y. Give width or height (the other follows the image\'s shape). placement "front" keeps it movable over the page (default); "behind" draws it into the page, under the text.',
    input: {
      doc_id: docId, page,
      image_path: z.string().describe('Absolute path of a PNG or JPEG (PNG keeps a signature\'s transparency)'),
      x: z.number(), y: z.number(),
      width: z.number().positive().optional(), height: z.number().positive().optional(),
      placement: z.enum(['front', 'behind']).optional()
    }
  }, (args) => t.doc(args, async (s) => {
    const p = pageIndexOf(args.page, s.pageCount)
    const file = resolvePath(args.image_path, 'image_path')
    const bytes = readFileBytes(file)
    const dim = imageSize(new Uint8Array(bytes)) ?? { width: 1, height: 1 }
    const aspect = dim.height / Math.max(1, dim.width)
    const pg = await pageSize(s, p)
    let w = args.width, h = args.height
    if (!w && !h) w = Math.min(200, pg.width - args.x - 10)
    if (w && !h) h = w * aspect
    if (h && !w) w = h / aspect
    const rect = [args.x, args.y, args.x + w!, args.y + h!]
    let res: Res = { success: false }
    await s.mutate(async (e) => {
      res = args.placement === 'behind'
        ? await e.send<Res>('drawImageInContent', { pageIndex: p, rect, bytes, behind: true })
        : await e.send<Res>('addImageStamp', { pageIndex: p, rect, imageBytes: bytes })
      return { ok: res.success, value: null }
    })
    if (!res.success) return fail(`Could not add the image: ${res.error || 'unknown error'}`)
    return ok({ added: file, page: p + 1, box: { x: Math.round(rect[0]), y: Math.round(rect[1]), w: Math.round(w!), h: Math.round(h!) }, placement: args.placement ?? 'front' })
  }))

  t.add('update_annotation', {
    title: 'Update annotation',
    description: 'Move, resize, recolour or re-word an annotation from list_annotations. Form fields and signatures can only be moved or resized.',
    input: {
      doc_id: docId,
      ref: z.string().describe('Annotation reference like "p1a3"'),
      x: z.number().optional(), y: z.number().optional(),
      width: z.number().positive().optional(), height: z.number().positive().optional(),
      text: z.string().optional().describe('New text (notes, text boxes)'),
      color: z.string().optional(), fill_color: z.string().optional(),
      opacity: z.number().min(0.05).max(1).optional(),
      line_width: z.number().min(0.1).max(50).optional(),
      font_size: z.number().min(4).max(144).optional().describe('Text boxes'),
      text_color: z.string().optional().describe('Text boxes')
    }
  }, (args) => t.doc(args, async (s) => {
    const { anchor, annot } = await s.resolveAnnot(args.ref)
    const r = annot.rect
    const changes: Record<string, unknown> = {}
    if ([args.x, args.y, args.width, args.height].some(v => v !== undefined)) {
      const x = args.x ?? r[0], y = args.y ?? r[1]
      changes.rect = [x, y, x + (args.width ?? r[2] - r[0]), y + (args.height ?? r[3] - r[1])]
    }
    const widget = annot.type === 'Widget' || annot.type === 'Signature'
    if (!widget) {
      if (args.text !== undefined) changes.contents = args.text
      if (args.color) changes.color = colorOf(args.color, '#000000')
      if (args.fill_color) changes.interiorColor = colorOf(args.fill_color, '#ffffff')
      if (args.opacity !== undefined) changes.opacity = args.opacity
      if (args.line_width !== undefined) changes.width = args.line_width
      if (args.font_size !== undefined) changes.fontSize = args.font_size
      if (args.text_color) changes.textColor = colorOf(args.text_color, '#000000')
    } else if (Object.keys(changes).length === 0) return fail('A form field or signature can only be moved or resized here (give x, y, width or height).')
    if (!Object.keys(changes).length) return fail('Nothing to change.')
    let res: Res = { success: false }
    await s.mutate(async (e) => { res = await e.send<Res>('updateAnnotation', { pageIndex: anchor.page, annotIndex: annot.index, ...changes }); return { ok: res.success, value: null } })
    if (!res.success) return fail(`Could not update ${args.ref}: ${res.error || 'unknown error'}`)
    if (changes.rect) { const nr = changes.rect as number[]; anchor.cx = (nr[0] + nr[2]) / 2; anchor.cy = (nr[1] + nr[3]) / 2 }
    if (changes.contents !== undefined) anchor.contents = changes.contents as string
    return ok({ updated: args.ref, changes: Object.keys(changes) })
  }))

  t.add('delete_annotations', {
    title: 'Delete annotations',
    description: 'Remove comments, highlights, stamps, drawings or inserted images (references from list_annotations). Form fields and digital signatures are not deleted here.',
    input: { doc_id: docId, refs: z.array(z.string()).min(1) },
    destructive: true
  }, (args) => t.doc(args, async (s) => {
    const list: { ref: string; page: number; index: number }[] = []
    for (const r of args.refs as string[]) {
      const x = await s.resolveAnnot(r)
      if (x.annot.type === 'Widget' || x.annot.type === 'Signature') throw new ToolError(`${r} is a form field or a digital signature; it is not deleted here.`)
      list.push({ ref: r, page: x.anchor.page, index: x.annot.index })
    }
    // Highest index first on each page: deleting one shifts the indices after it.
    list.sort((a, b) => a.page - b.page || b.index - a.index)
    let removed = 0
    await s.mutate(async (e) => {
      for (const x of list) { const r = await e.send<Res>('deleteAnnotation', { pageIndex: x.page, annotIndex: x.index }); if (r.success) removed++ }
      return { ok: removed > 0, value: null }
    })
    for (const x of list) s.clearPageAnchors(x.page, 'annot')
    if (!removed) return fail('Could not delete the annotations.')
    return ok({ removed, note: 'annotation references on these pages were cleared; list them again before further changes' })
  }))

  t.add('edit_image', {
    title: 'Edit image',
    description: 'Change an image the page content draws (reference from list_images): move it (x, y), resize it (width/height), delete it, flip or rotate it, crop it to a region (x, y, width, height of the part to keep), bring it to the front or send it behind, or replace it with another image file.',
    input: {
      doc_id: docId,
      ref: z.string().describe('Image reference like "p1i0"'),
      action: z.enum(['move', 'resize', 'delete', 'flip_horizontal', 'flip_vertical', 'rotate_clockwise', 'rotate_counterclockwise', 'crop', 'bring_to_front', 'send_to_back', 'replace']),
      x: z.number().optional(), y: z.number().optional(),
      width: z.number().positive().optional(), height: z.number().positive().optional(),
      image_path: z.string().optional().describe('For replace: absolute path of the new image')
    },
    destructive: true
  }, (args) => t.doc(args, async (s) => {
    const { anchor, image } = await s.resolveImage(args.ref)
    const id = { pageIndex: anchor.page, sourceKey: image.sourceKey, doOffset: image.doOffset, name: image.name }
    const r = image.rect
    let msg: [string, Record<string, unknown>]
    switch (args.action) {
      case 'move': case 'resize': {
        const x = args.x ?? r[0], y = args.y ?? r[1]
        let w = args.width ?? r[2] - r[0], h = args.height ?? r[3] - r[1]
        if (args.action === 'resize' && args.width && !args.height) h = w * (r[3] - r[1]) / Math.max(1, r[2] - r[0])
        if (args.action === 'resize' && args.height && !args.width) w = h * (r[2] - r[0]) / Math.max(1, r[3] - r[1])
        msg = ['transformContentImage', { ...id, rect: [x, y, x + w, y + h] }]
        break
      }
      case 'delete': msg = ['deleteContentImage', id]; break
      case 'flip_horizontal': msg = ['orientContentImage', { ...id, op: 'flip-h' }]; break
      case 'flip_vertical': msg = ['orientContentImage', { ...id, op: 'flip-v' }]; break
      case 'rotate_clockwise': msg = ['orientContentImage', { ...id, op: 'rotate-cw' }]; break
      case 'rotate_counterclockwise': msg = ['orientContentImage', { ...id, op: 'rotate-ccw' }]; break
      case 'crop': {
        if ([args.x, args.y, args.width, args.height].some(v => v === undefined)) return fail('crop needs x, y, width and height of the part to keep.')
        msg = ['cropContentImage', { ...id, rect: [args.x, args.y, args.x + args.width, args.y + args.height] }]
        break
      }
      case 'bring_to_front': msg = ['reorderContentImage', { ...id, where: 'front' }]; break
      case 'send_to_back': msg = ['reorderContentImage', { ...id, where: 'back' }]; break
      case 'replace': {
        if (!args.image_path) return fail('replace needs image_path.')
        const file = resolvePath(args.image_path, 'image_path')
        if (!fs.existsSync(file)) return fail(`File not found: ${file}`)
        msg = ['replaceContentImage', { ...id, imageBytes: new Uint8Array(readFileBytes(file)) }]
        break
      }
      default: return fail(`Unknown action ${args.action}`)
    }
    let res: Res = { success: false }
    await s.mutate(async (e) => { res = await e.send<Res>(msg[0], msg[1]); return { ok: res.success, value: null } })
    if (!res.success) return fail(`Could not ${args.action.replace(/_/g, ' ')} the image: ${res.error || 'unknown error'}`)
    if (msg[0] === 'transformContentImage') { const nr = msg[1].rect as number[]; anchor.cx = (nr[0] + nr[2]) / 2; anchor.cy = (nr[1] + nr[3]) / 2 }
    else s.clearPageAnchors(anchor.page, 'image')
    return ok({ done: args.action, image: args.ref })
  }))
}
