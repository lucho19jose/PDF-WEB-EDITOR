/** Small helpers shared by the tools: results, colours, pages, paths, fonts. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parsePageRange } from '../../src/utils/acro/pageRange'

export type ToolResult = { content: any[]; isError?: boolean; structuredContent?: Record<string, unknown> }

/** A tool's answer: a JSON object the model reads, plus an optional summary line. */
export function ok(data: Record<string, unknown>, extra: any[] = []): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }, ...extra] }
}

export function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

/** An error the tool handler turns into an isError result. */
export class ToolError extends Error {}

/** "#rrggbb" / "rrggbb" / "#rgb" / a few names → [r,g,b] in 0..1. */
export function colorOf(value: unknown, fallback: string): [number, number, number] {
  const named: Record<string, string> = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
    yellow: '#ffeb3b', orange: '#ff9800', gray: '#808080', grey: '#808080', purple: '#800080'
  }
  let s = String(value ?? '').trim().toLowerCase() || fallback
  if (named[s]) s = named[s]
  s = s.replace(/^#/, '')
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map(c => c + c).join('')
  if (!/^[0-9a-f]{6}$/.test(s)) {
    if (value === undefined || value === null || value === '') return colorOf(fallback, '#000000')
    throw new ToolError(`"${value}" is not a colour: use a hex value such as #1a73e8`)
  }
  return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255]
}

export function hexOf(c: number[] | undefined | null): string | null {
  if (!c || !c.length) return null
  const [r, g, b] = c.length === 1 ? [c[0], c[0], c[0]] : c
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** A 1-based page number → 0-based index, checked against the document. */
export function pageIndexOf(page: unknown, pageCount: number): number {
  const p = Number(page)
  if (!Number.isInteger(p) || p < 1 || p > pageCount) throw new ToolError(`page must be a page number from 1 to ${pageCount}`)
  return p - 1
}

/** "all" (or empty) / "1-3,5" / [1,2] → sorted 0-based indices. */
export function pagesOf(pages: unknown, pageCount: number, emptyMeansAll = true): number[] {
  if (Array.isArray(pages)) {
    const out = [...new Set(pages.map(p => pageIndexOf(p, pageCount)))].sort((a, b) => a - b)
    if (!out.length) throw new ToolError('pages is empty')
    return out
  }
  const s = String(pages ?? '').trim().toLowerCase()
  if (!s || s === 'all' || s === 'todas') {
    if (!emptyMeansAll) throw new ToolError('pages is required')
    return Array.from({ length: pageCount }, (_, i) => i)
  }
  const out = parsePageRange(s, pageCount)
  if (!out.length) throw new ToolError(`"${pages}" names no page of this ${pageCount}-page document (use e.g. "1-3,5" or "all")`)
  return out
}

/** Base-14 face for a family + weight + slant. */
export function base14(family: string | undefined, bold = false, italic = false): string {
  const f = String(family || 'Helvetica').toLowerCase()
  if (f.startsWith('times')) return bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman'
  if (f.startsWith('courier')) return bold && italic ? 'Courier-BoldOblique' : bold ? 'Courier-Bold' : italic ? 'Courier-Oblique' : 'Courier'
  return bold && italic ? 'Helvetica-BoldOblique' : bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica'
}

// ───────────────────────── Paths ─────────────────────────

/**
 * Folders the server may read and write. `PDF_MCP_ROOTS` lists them
 * (separated by `;` on Windows, `:` elsewhere); `*` allows any folder.
 * Default: the user's profile and the temp folder.
 */
function allowedRoots(): string[] | null {
  // `--roots <dir> <dir>…` on the command line (how a Claude Desktop extension
  // passes its "allowed folders" setting) wins over PDF_MCP_ROOTS.
  const argv = process.argv
  const at = argv.indexOf('--roots')
  const fromArgs = at >= 0 ? argv.slice(at + 1).filter(a => !a.startsWith('--')).map(s => s.trim()).filter(Boolean) : []
  const raw = process.env.PDF_MCP_ROOTS?.trim()
  if (fromArgs.includes('*') || (!fromArgs.length && raw === '*')) return null
  const list = fromArgs.length ? fromArgs : raw ? raw.split(path.delimiter).map(s => s.trim()).filter(Boolean) : [os.homedir(), os.tmpdir()]
  return list.map(p => canonical(path.resolve(expandHome(p))).toLowerCase())
}

/**
 * The path as the file system spells it: Windows names one folder two ways
 * (C:\Users\JOSELU~1 and C:\Users\Jose Luis Barboza), and a containment test
 * on strings would refuse one form against a root given in the other. For a
 * file not written yet, the nearest existing folder is resolved and the rest
 * appended.
 */
function canonical(p: string): string {
  let head = p
  const tail: string[] = []
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), ...tail) } catch (_) { /* not there yet */ }
    const up = path.dirname(head)
    if (up === head) return p
    tail.unshift(path.basename(head))
    head = up
  }
}

export function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p
}

/** An absolute, allowed path. Relative paths are refused: the server has no meaningful working folder. */
export function resolvePath(p: unknown, what = 'path'): string {
  const s = String(p ?? '').trim().replace(/^"(.*)"$/, '$1')
  if (!s) throw new ToolError(`${what} is required`)
  const abs = expandHome(s)
  if (!path.isAbsolute(abs)) throw new ToolError(`${what} must be an absolute path (got "${s}")`)
  const full = canonical(path.resolve(abs))
  const roots = allowedRoots()
  if (roots) {
    const low = full.toLowerCase()
    if (!roots.some(r => low === r || low.startsWith(r.endsWith(path.sep) ? r : r + path.sep))) {
      throw new ToolError(`${full} is outside the folders this server may use (${roots.join(', ')}). Set PDF_MCP_ROOTS to allow it.`)
    }
  }
  return full
}

export function readFileBytes(p: string): ArrayBuffer {
  let b: Buffer
  try { b = fs.readFileSync(p) } catch (err: any) {
    throw new ToolError(err?.code === 'ENOENT' ? `File not found: ${p}` : `Could not read ${p}: ${err?.message || err}`)
  }
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

/** Write via a temp file and a rename, so a failed write never leaves half a file. */
export function writeFileAtomic(p: string, bytes: ArrayBuffer | Uint8Array, overwrite: boolean): void {
  if (!overwrite && fs.existsSync(p)) throw new ToolError(`${p} already exists. Pass overwrite: true to replace it, or choose another path.`)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    fs.renameSync(tmp, p)
  } catch (err: any) {
    try { fs.unlinkSync(tmp) } catch (_) {}
    if (err?.code === 'EBUSY' || err?.code === 'EPERM') throw new ToolError(`${p} is open in another program (${err.code}). Close it there, or save to another path.`)
    throw new ToolError(`Could not write ${p}: ${err?.message || err}`)
  }
}

/** "<dir>/<name> (editado).pdf", numbered when taken. */
export function editedPathFor(source: string, suffix = 'editado', ext = '.pdf'): string {
  const dir = path.dirname(source)
  const base = path.basename(source, path.extname(source))
  for (let n = 1; ; n++) {
    const p = path.join(dir, `${base} (${suffix}${n > 1 ? ' ' + n : ''})${ext}`)
    if (!fs.existsSync(p)) return p
  }
}

export function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|bmp|tiff?)$/i.test(p)
}
