/**
 * Reading colour off the scan.
 *
 * OCR reports where the ink is and what it says; it says nothing about what
 * colour it is, or what colour the paper behind it is. Both are needed: the ink
 * colour so replacement text looks like the text it replaces, and the paper
 * colour so the patch that hides the original does not show as a grey rectangle
 * on a cream scan.
 *
 * Both are read from the rendered canvas, which is the only place that
 * information exists.
 */

export type Rgb01 = [number, number, number]

/** Luminance, for separating ink from paper. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/**
 * Ink and paper colour for one line of recognised text.
 *
 * The pixels inside a line box are bimodal — mostly paper, some ink — so the
 * split is made at the midpoint between the darkest and lightest samples rather
 * than at a fixed threshold: a faint grey scan and a crisp black one both have
 * ink, just at different levels.
 *
 * The ink colour is the mean of the DARKEST fifth rather than of everything
 * below the threshold, because anti-aliased edge pixels are a blend of ink and
 * paper and would wash a black letter out to grey.
 *
 * @param rect box in CANVAS pixels
 */
export function sampleLineColors(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number }
): { color: Rgb01; background: Rgb01 } {
  const fallback = { color: [0, 0, 0] as Rgb01, background: [1, 1, 1] as Rgb01 }

  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const w = Math.min(Math.ceil(rect.width), ctx.canvas.width - x)
  const h = Math.min(Math.ceil(rect.height), ctx.canvas.height - y)
  if (w < 1 || h < 1) return fallback

  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(x, y, w, h).data
  } catch (_) {
    // A tainted canvas cannot be read. Better a sane default than a crash.
    return fallback
  }

  const px: { r: number; g: number; b: number; l: number }[] = []
  // Every pixel of a full page is millions of samples for no extra accuracy;
  // a stride keeps this at a few thousand per line.
  const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 2000)))
  for (let row = 0; row < h; row += stride) {
    for (let col = 0; col < w; col += stride) {
      const i = (row * w + col) * 4
      const r = data[i], g = data[i + 1], b = data[i + 2]
      px.push({ r, g, b, l: luma(r, g, b) })
    }
  }
  if (px.length === 0) return fallback

  px.sort((a, b) => a.l - b.l)
  const darkest = px[0].l
  const lightest = px[px.length - 1].l

  // Nothing but paper here — no ink to measure.
  if (lightest - darkest < 24) {
    const mean = px[Math.floor(px.length / 2)]
    return { color: [0, 0, 0], background: [mean.r / 255, mean.g / 255, mean.b / 255] }
  }

  const inkCount = Math.max(1, Math.floor(px.length * 0.2))
  const ink = px.slice(0, inkCount)
  // Paper is read from the lightest fifth for the same reason ink is read from
  // the darkest: the middle of the distribution is edge pixels, which are both.
  const paper = px.slice(px.length - inkCount)

  const mean = (list: typeof px): Rgb01 => {
    let r = 0, g = 0, b = 0
    for (const p of list) { r += p.r; g += p.g; b += p.b }
    return [r / list.length / 255, g / list.length / 255, b / list.length / 255]
  }

  return { color: mean(ink), background: mean(paper) }
}

/**
 * Paper colour just OUTSIDE a line box.
 *
 * Used for the patch that hides replaced text: sampling inside the box would
 * average in the ink about to be covered, and the patch would come out darker
 * than the page it sits on.
 */
export function samplePatchColor(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number }
): Rgb01 {
  const pad = Math.max(2, Math.round(rect.height * 0.3))
  const bands = [
    { x: rect.x, y: rect.y - pad, width: rect.width, height: pad },        // above
    { x: rect.x, y: rect.y + rect.height, width: rect.width, height: pad } // below
  ]
  const samples: Rgb01[] = []
  for (const b of bands) {
    if (b.y < 0 || b.y + b.height > ctx.canvas.height) continue
    samples.push(sampleLineColors(ctx, b).background)
  }
  if (samples.length === 0) return sampleLineColors(ctx, rect).background
  const r = samples.reduce((s, c) => s + c[0], 0) / samples.length
  const g = samples.reduce((s, c) => s + c[1], 0) / samples.length
  const b = samples.reduce((s, c) => s + c[2], 0) / samples.length
  return [r, g, b]
}
