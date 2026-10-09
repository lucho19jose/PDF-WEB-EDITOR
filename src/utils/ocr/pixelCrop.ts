/**
 * A rectangle of a canvas as a PNG, for transplanting the scan's own pixels.
 *
 * PNG, not JPEG: the crops are small (a tail of a line) and a second lossy
 * encoding of a scan's JPEG shows as ringing at the letter edges.
 */
export async function cropToPng(
  canvas: HTMLCanvasElement,
  px: { x: number; y: number; width: number; height: number },
  /**
   * Paint the crop's first `clearLeft` columns with `paper` (0–1 RGB): the
   * margin left of the moved words' own ink. The crop takes a hair of paper
   * before the first letter, and a letter that was DELETED next to it reached
   * into that hair — "PERU S.A.C." with the U deleted carried a sliver of the
   * U's stem along with the moved tail, a grey bar in front of "S.A.C.".
   */
  opts?: { clearLeft?: number; paper?: readonly number[] }
): Promise<ArrayBuffer | null> {
  const x = Math.max(0, Math.floor(px.x)), y = Math.max(0, Math.floor(px.y))
  const w = Math.min(canvas.width - x, Math.ceil(px.width)), h = Math.min(canvas.height - y, Math.ceil(px.height))
  if (w < 1 || h < 1) return null
  const out = document.createElement('canvas')
  out.width = w; out.height = h
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h)
  // `clearLeft` counts from the requested left edge; the crop starts at its floor.
  const clear = Math.min(w, Math.floor((opts?.clearLeft ?? 0) + (px.x - x)))
  if (clear >= 1 && opts?.paper) {
    const [r, g, b] = opts.paper.map(v => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255))
    ctx.fillStyle = `rgb(${r},${g},${b})`
    ctx.fillRect(0, 0, clear, h)
  }
  const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'))
  return blob ? blob.arrayBuffer() : null
}
