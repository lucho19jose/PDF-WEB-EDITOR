import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SignatureInfo } from '@/engine/types'

export const useDocumentStore = defineStore('document', () => {
  const loaded = ref(false)
  const fileName = ref<string | null>(null)
  const totalPages = ref(0)
  const currentPage = ref(1)
  const scale = ref(1.5)
  /**
   * Show the whole document as one scrolling column, rather than a page at a
   * time. On by default: a reader scrolls, and having to click the next
   * thumbnail to see what comes after the line they are reading is not how any
   * PDF is read.
   *
   * The single-page mode is kept because it renders exactly one page — on a
   * very long document that is the difference between paging instantly and
   * waiting for a rasteriser.
   */
  const continuousScroll = ref(true)
  const isModified = ref(false)
  const pdfBytes = ref<Uint8Array | null>(null)
  const renderVersion = ref(0)
  /**
   * The digital signatures the document carried WHEN IT WAS OPENED (read by
   * the engine, never verified). Kept as of the open, not re-read after each
   * edit: an edit breaks every one of them, and that is what `isModified`
   * already says — the status bar pairs the two.
   */
  const signatures = ref<SignatureInfo[]>([])

  const fileSizeFormatted = computed(() => {
    if (!pdfBytes.value) return '0 KB'
    const kb = Math.round(pdfBytes.value.length / 1024)
    return kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`
  })

  function setDocument(name: string, pages: number, bytes: Uint8Array) {
    loaded.value = true
    fileName.value = name
    totalPages.value = pages
    pdfBytes.value = bytes
    currentPage.value = 1
    isModified.value = false
    // The previous document's signatures must not describe this one for the
    // moment before the engine has read its own.
    signatures.value = []
    // A new document invalidates every overlay's cached geometry even when
    // currentPage/tool don't change (e.g. opening a 2nd PDF while on page 1)
    renderVersion.value++
  }

  function setSignatures(list: SignatureInfo[]) {
    signatures.value = list
  }

  /** Reload bytes without resetting page/state — used after in-place editing */
  function reloadBytes(bytes: Uint8Array, pages?: number) {
    pdfBytes.value = bytes
    if (pages !== undefined) {
      totalPages.value = pages
      // Clamp BEFORE bumping renderVersion so the re-render never requests an
      // out-of-range page (e.g. after deleting the last page).
      if (currentPage.value > pages) currentPage.value = Math.max(1, pages)
    }
    renderVersion.value++
  }

  function setPage(page: number) {
    currentPage.value = Math.max(1, Math.min(page, totalPages.value))
  }

  function setScale(newScale: number) {
    scale.value = Math.max(0.25, Math.min(5, newScale))
  }

  function markModified() {
    isModified.value = true
  }

  function markSaved() {
    isModified.value = false
  }

  function reset() {
    loaded.value = false
    fileName.value = null
    totalPages.value = 0
    currentPage.value = 1
    scale.value = 1.5
    isModified.value = false
    pdfBytes.value = null
    signatures.value = []
  }

  return {
    continuousScroll,
    loaded, fileName, totalPages, currentPage, scale,
    isModified, pdfBytes, fileSizeFormatted, renderVersion, signatures,
    setDocument, reloadBytes, setPage, setScale, markModified, markSaved, reset, setSignatures
  }
})
