/**
 * A rectangle of a canvas as a PNG, for transplanting the scan's own pixels.
 *
 * PNG, not JPEG: the crops are small (a tail of a line) and a second lossy
 * encoding of a scan's JPEG shows as ringing at the letter edges.
 */
export async function cropToPng(
  canvas: HTMLCanvasElement,
  px: { x: number; y: number; width: number; height: number }
): Promise<ArrayBuffer | null> {
  const x = Math.max(0, Math.floor(px.x)), y = Math.max(0, Math.floor(px.y))
  const w = Math.min(canvas.width - x, Math.ceil(px.width)), h = Math.min(canvas.height - y, Math.ceil(px.height))
  if (w < 1 || h < 1) return null
  const out = document.createElement('canvas')
  out.width = w; out.height = h
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h)
  const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'))
  return blob ? blob.arrayBuffer() : null
}
