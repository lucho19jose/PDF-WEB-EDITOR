/** Convert a hex color (#rrggbb) to normalized [r,g,b] 0-1 for MuPDF. */
export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const r = parseInt(h.substring(0, 2), 16) / 255
  const g = parseInt(h.substring(2, 4), 16) / 255
  const b = parseInt(h.substring(4, 6), 16) / 255
  return [r, g, b]
}

/** Convert normalized [r,g,b] 0-1 (or grayscale [v]) to a CSS hex string. */
export function rgb01ToHex(c: number[]): string {
  if (!c || c.length === 0) return '#000000'
  let r: number, g: number, b: number
  if (c.length === 1) { r = g = b = c[0] }
  else { [r, g, b] = c }
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** Convert normalized [r,g,b] to a CSS rgba() string with alpha. */
export function rgb01ToCss(c: number[], alpha = 1): string {
  if (!c || c.length === 0) return `rgba(0,0,0,${alpha})`
  let r: number, g: number, b: number
  if (c.length === 1) { r = g = b = c[0] }
  else { [r, g, b] = c }
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255)
  return `rgba(${to(r)},${to(g)},${to(b)},${alpha})`
}
