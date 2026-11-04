/**
 * Phrase location and replacement across ordered text units (extraction
 * blocks or OCR runs). Pure: used by the in-app assistant and the MCP server.
 */

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
