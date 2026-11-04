/**
 * Page-range text ⇄ 0-based page indices. Pure: shared by the Acrobat
 * commands and the MCP server.
 */

/** "1-3, 5" for a sorted list of 0-based indices. */
export function pageRangeLabel(list: number[]): string {
  const out: string[] = []
  for (let i = 0; i < list.length; i++) {
    let j = i
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++
    out.push(i === j ? `${list[i] + 1}` : `${list[i] + 1}-${list[j] + 1}`)
    i = j
  }
  return out.length === 1 && !out[0].includes('-') ? `página ${out[0]}` : `páginas ${out.join(', ')}`
}

/** Parse "1-3, 5, 8-" style ranges into 0-based indices. */
export function parsePageRange(text: string, total: number): number[] {
  const out = new Set<number>()
  for (const part of text.split(/[,;]/)) {
    const m = /^\s*(\d*)\s*(?:-\s*(\d*))?\s*$/.exec(part)
    if (!m || (!m[1] && !m[2])) continue
    const a = m[1] ? parseInt(m[1], 10) : 1
    const b = part.includes('-') ? (m[2] ? parseInt(m[2], 10) : total) : a
    for (let p = Math.max(1, Math.min(a, b)); p <= Math.min(total, Math.max(a, b)); p++) out.add(p - 1)
  }
  return [...out].sort((x, y) => x - y)
}
