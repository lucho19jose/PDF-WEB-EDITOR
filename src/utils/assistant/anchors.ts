/**
 * Text-block anchors: a block the model (or the user) was shown is found
 * again by its TEXT and CENTRE, never by its id — ids are extraction indices
 * and every save→reload renumbers them. Pure: shared by the in-app assistant
 * and the MCP server. Same rule as TextBlockOverlay.findByAnchor.
 */

export interface TextAnchor { text: string; cx: number; cy: number }
interface BlockLike { text: string; bbox: number[] }

/** Identical text (else a 3-character prefix one side of the other), nearest centre, twins over 24pt away rejected. */
export function findByAnchor<B extends BlockLike>(anchor: TextAnchor, blocks: B[]): B | null {
  let candidates = blocks.filter(b => b.text === anchor.text)
  if (candidates.length === 0) {
    const prefix = anchor.text.slice(0, 3)
    candidates = prefix.length === 3
      ? blocks.filter(b => b.text.startsWith(prefix) && (b.text.startsWith(anchor.text) || anchor.text.startsWith(b.text)))
      : []
  }
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]
  let best: { block: B; dist: number } | null = null
  for (const b of candidates) {
    const dist = Math.hypot((b.bbox[0] + b.bbox[2]) / 2 - anchor.cx, (b.bbox[1] + b.bbox[3]) / 2 - anchor.cy)
    if (!best || dist < best.dist) best = { block: b, dist }
  }
  return best && best.dist < 24 ? best.block : null
}

/** The extraction index of a block id "page:index" (edits are applied back to front by it). */
export function extractionIndex(id: string): number {
  const n = Number(id.split(':').pop())
  return Number.isFinite(n) ? n : 0
}
