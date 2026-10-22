/**
 * Filling holes in a picture from what surrounds them — push-pull.
 *
 * Erasing a scanned letter is not painting a rectangle the colour of the paper:
 * the paper is not one colour (a scan has a tint, a gradient, the shadow of a
 * fold), and a flat patch shows as a box exactly where the eye is looking. The
 * letter's own pixels are instead filled from the paper AROUND them: the image
 * is pulled down a pyramid, each coarser level averaging only the pixels that
 * are known, until every pixel has a value; pushed back up, each unknown pixel
 * takes the smooth estimate from the level below. A hole a few pixels wide
 * fills from its immediate neighbours; a large one fills with a smooth blend of
 * its whole surround.
 *
 * DOM-free. Channels are planar Float32Arrays of w × h.
 */

/**
 * Fill `known === 0` pixels of every channel in place. `known` is 0..1 (a
 * soft weight is allowed). Returns false when nothing at all is known.
 */
export function pushPull(channels: Float32Array[], known: Float32Array, w: number, h: number): boolean {
  let anyKnown = false
  for (let i = 0; i < known.length; i++) if (known[i] > 0) { anyKnown = true; break }
  if (!anyKnown) return false
  let allKnown = true
  for (let i = 0; i < known.length; i++) if (known[i] < 1) { allKnown = false; break }
  if (allKnown) return true

  // Pull: build the pyramid of weighted averages. The caller's weights are
  // not touched; its channels are filled in place.
  const levels: { w: number; h: number; ch: Float32Array[]; wt: Float32Array }[] = [{ w, h, ch: channels, wt: known.slice() }]
  while (true) {
    const top = levels[levels.length - 1]
    if (top.w <= 1 && top.h <= 1) break
    let full = true
    for (let i = 0; i < top.wt.length; i++) if (top.wt[i] <= 0) { full = false; break }
    if (full && levels.length > 1) break
    const nw = Math.max(1, Math.ceil(top.w / 2)), nh = Math.max(1, Math.ceil(top.h / 2))
    const wt = new Float32Array(nw * nh)
    const ch = top.ch.map(() => new Float32Array(nw * nh))
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let sw = 0
      const acc = new Float64Array(ch.length)
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = x * 2 + dx, sy = y * 2 + dy
        if (sx >= top.w || sy >= top.h) continue
        const p = sy * top.w + sx
        const k = top.wt[p]
        if (k <= 0) continue
        sw += k
        for (let c = 0; c < ch.length; c++) acc[c] += top.ch[c][p] * k
      }
      const q = y * nw + x
      if (sw > 0) for (let c = 0; c < ch.length; c++) ch[c][q] = acc[c] / sw
      wt[q] = Math.min(1, sw)
    }
    levels.push({ w: nw, h: nh, ch, wt })
  }

  // Push: every level's unknown share takes the coarser level's estimate,
  // sampled bilinearly at the pixel's centre.
  for (let L = levels.length - 2; L >= 0; L--) {
    const fine = levels[L], coarse = levels[L + 1]
    for (let y = 0; y < fine.h; y++) for (let x = 0; x < fine.w; x++) {
      const p = y * fine.w + x
      const k = fine.wt[p]
      if (k >= 1) continue
      // Centre of the fine pixel in coarse pixel coordinates.
      const cx = Math.min(coarse.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5))
      const cy = Math.min(coarse.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5))
      const x0 = Math.floor(cx), y0 = Math.floor(cy)
      const x1 = Math.min(coarse.w - 1, x0 + 1), y1 = Math.min(coarse.h - 1, y0 + 1)
      const fx = cx - x0, fy = cy - y0
      for (let c = 0; c < fine.ch.length; c++) {
        const C = coarse.ch[c]
        const v = (C[y0 * coarse.w + x0] * (1 - fx) + C[y0 * coarse.w + x1] * fx) * (1 - fy) +
          (C[y1 * coarse.w + x0] * (1 - fx) + C[y1 * coarse.w + x1] * fx) * fy
        fine.ch[c][p] = fine.ch[c][p] * k + v * (1 - k)
      }
      fine.wt[p] = 1
    }
  }
  return true
}
