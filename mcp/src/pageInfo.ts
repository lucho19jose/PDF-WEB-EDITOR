/** Per-page facts the tools need: size, and whether the page is text or a scan. */
import type { DocumentSession } from './session'
import type { TextBlock, ContentImageInfo } from '../../src/engine/types'
import { pageKind, type PageKind } from '../../src/utils/pageKind'
import { ToolError } from './util'

export async function pageSize(s: DocumentSession, page: number): Promise<{ width: number; height: number; rotation: number }> {
  const e = await s.eng()
  return e.send('getPageSize', { pageIndex: page })
}

export async function kindOf(s: DocumentSession, page: number): Promise<PageKind & { blocks: TextBlock[] }> {
  const e = await s.eng()
  const [{ blocks }, size, images] = await Promise.all([
    e.send<{ blocks: TextBlock[] }>('getPageText', { pageIndex: page }),
    e.send<{ width: number; height: number }>('getPageSize', { pageIndex: page }),
    e.send<ContentImageInfo[]>('listContentImages', { pageIndex: page }).catch(() => [] as ContentImageInfo[])
  ])
  return { ...pageKind(blocks, size, images.map(i => i.rect)), blocks }
}

/** Text edits on a scan change nothing anyone can see: refuse, and say what to do instead. */
export function scanRefusal(page: number, why: string): ToolError {
  return new ToolError(`Page ${page + 1} is a SCANNED page (${why}): the words you see are part of an image, so text-block tools do not apply. Call recognize_page(${page + 1}) and change its words with edit_scanned_text or replace_text — the edit is made on the scan in its own letters. Never paint a white box over scanned words to retype them.`)
}

export async function requireTextPage(s: DocumentSession, page: number): Promise<TextBlock[]> {
  const k = await kindOf(s, page)
  if (k.kind === 'scan') throw scanRefusal(page, k.reason)
  return k.blocks.filter(b => !b.invisible)
}
