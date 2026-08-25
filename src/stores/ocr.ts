import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { OcrPageResult, OcrTextItem } from '@/utils/ocr/ocrTypes'

/**
 * What OCR found, and what the user has since done to it.
 *
 * Kept OUT of the document until the user exports. A scanned page is a picture;
 * recognising text on it changes nothing about the file, and it should not —
 * the recognition is a guess, and a guess must not rewrite anyone's document
 * just by being made. Only the runs the user actually edits are ever drawn, and
 * only at export.
 *
 * Results are per page and survive moving between pages, so a long document can
 * be recognised page by page without losing what came before.
 */
export const useOcrStore = defineStore('ocr', () => {
  /** pageIndex -> what OCR read there. */
  const pages = ref<Map<number, OcrPageResult>>(new Map())
  const selectedId = ref<string | null>(null)
  /** The layer is shown only when the user asked for it. */
  const layerVisible = ref(false)

  function resultFor(pageIndex: number): OcrPageResult | null {
    return pages.value.get(pageIndex) ?? null
  }

  function itemsFor(pageIndex: number): OcrTextItem[] {
    return pages.value.get(pageIndex)?.items ?? []
  }

  const selected = computed<OcrTextItem | null>(() => {
    if (!selectedId.value) return null
    for (const page of pages.value.values()) {
      const hit = page.items.find(i => i.id === selectedId.value)
      if (hit) return hit
    }
    return null
  })

  /** Every run the user changed or deleted — the only ones export has to draw. */
  function editedItems(pageIndex: number): OcrTextItem[] {
    return itemsFor(pageIndex).filter(i => i.edited || i.removed)
  }

  const hasEdits = computed(() => {
    for (const page of pages.value.values()) {
      if (page.items.some(i => i.edited || i.removed)) return true
    }
    return false
  })

  function setResult(result: OcrPageResult) {
    // A new Map so Vue sees the change: a Map mutated in place is not reactive.
    const next = new Map(pages.value)
    next.set(result.pageIndex, result)
    pages.value = next
    layerVisible.value = true
  }

  /**
   * Apply a change to one run.
   *
   * `edited` is set from what actually differs rather than by the caller, so a
   * click that changes nothing never marks the page as needing a rewrite.
   */
  function updateItem(id: string, patch: Partial<OcrTextItem>) {
    const next = new Map(pages.value)
    for (const [key, page] of next) {
      const idx = page.items.findIndex(i => i.id === id)
      if (idx < 0) continue
      const before = page.items[idx]
      const after: OcrTextItem = { ...before, ...patch }
      // An explicit `edited: false` is a RESET, and has to win over the "was it
      // edited before" term below — otherwise reverting a run puts its words
      // back but leaves it marked as changed, and export still paints over it.
      after.edited = patch.edited === false
        ? false
        : after.removed
        ? false
        : after.text !== after.originalText ||
          after.fontSize !== before.fontSize && patch.fontSize !== undefined ||
          before.edited ||
          patch.fontFamily !== undefined ||
          patch.bold !== undefined ||
          patch.italic !== undefined ||
          patch.color !== undefined ||
          patch.align !== undefined ||
          patch.rect !== undefined
      const items = [...page.items]
      items[idx] = after
      next.set(key, { ...page, items })
      pages.value = next
      return
    }
  }

  function removeItem(id: string) {
    updateItem(id, { removed: true, edited: false })
  }

  /** Undo a deletion, an edit or a move, putting the run back to what OCR read. */
  function revertItem(id: string) {
    const item = selectedIn(id)
    if (!item) return
    updateItem(id, {
      text: item.originalText,
      // Back onto its own ink, or a run that was dragged reverts its words and
      // stays where it was dropped.
      rect: { ...(item.inkRect ?? item.rect) },
      removed: false,
      edited: false
    })
  }

  function selectedIn(id: string): OcrTextItem | null {
    for (const page of pages.value.values()) {
      const hit = page.items.find(i => i.id === id)
      if (hit) return hit
    }
    return null
  }

  /** Dropped when a different document is loaded — results belong to a file. */
  function clear() {
    pages.value = new Map()
    selectedId.value = null
    layerVisible.value = false
  }

  return {
    pages, selectedId, layerVisible, selected, hasEdits,
    resultFor, itemsFor, editedItems, setResult, updateItem, removeItem, revertItem, clear
  }
})
