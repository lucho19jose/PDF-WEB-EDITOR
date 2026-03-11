import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useDocumentStore = defineStore('document', () => {
  const loaded = ref(false)
  const fileName = ref<string | null>(null)
  const totalPages = ref(0)
  const currentPage = ref(1)
  const scale = ref(1.5)
  const isModified = ref(false)
  const pdfBytes = ref<Uint8Array | null>(null)
  const renderVersion = ref(0)

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
  }

  /** Reload bytes without resetting page/state — used after in-place editing */
  function reloadBytes(bytes: Uint8Array, pages?: number) {
    pdfBytes.value = bytes
    if (pages !== undefined) totalPages.value = pages
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
  }

  return {
    loaded, fileName, totalPages, currentPage, scale,
    isModified, pdfBytes, fileSizeFormatted, renderVersion,
    setDocument, reloadBytes, setPage, setScale, markModified, markSaved, reset
  }
})
