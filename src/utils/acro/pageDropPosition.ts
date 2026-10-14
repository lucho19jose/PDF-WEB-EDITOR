type PageRect = { left: number; right: number; top: number; bottom: number }

/** Cells are in row order. Hit-test gaps as well as paper, using O(log n) measurements. */
export function pageDropPosition(count: number, rectAt: (i: number) => PageRect, x: number, y: number): number {
  function first(test: (i: number) => boolean, low = 0, high = count) {
    while (low < high) {
      const mid = (low + high) >>> 1
      if (test(mid)) high = mid
      else low = mid + 1
    }
    return low
  }
  if (!count) return 0
  let row = first(i => rectAt(i).bottom >= y)
  if (row === count) return count
  const next = rectAt(row)
  if (row && y < next.top && y - rectAt(row - 1).bottom < next.top - y) row--
  const top = rectAt(row).top
  const start = first(i => rectAt(i).top >= top)
  const end = first(i => rectAt(i).top > top, start)
  return first(i => { const r = rectAt(i); return x < (r.left + r.right) / 2 }, start, end)
}
