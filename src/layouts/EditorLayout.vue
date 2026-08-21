<template>
  <q-layout view="hHh lpR fFf" class="bg-dark">
    <!-- Header: Title + Toolbar -->
    <q-header class="bg-grey-10">
      <div class="title-bar q-px-md q-py-xs row items-center text-grey-4">
        <q-icon name="picture_as_pdf" size="sm" color="primary" class="q-mr-sm" />
        <span class="text-weight-bold">PDF Editor Pro v2</span>
        <span v-if="docStore.fileName" class="q-ml-md text-grey-6">
          {{ docStore.fileName }}{{ docStore.isModified ? ' *' : '' }}
        </span>
        <q-space />
        <q-btn flat dense icon="menu" size="sm" @click="sidebarOpen = !sidebarOpen">
          <q-tooltip>Toggle page panel</q-tooltip>
        </q-btn>
      </div>
      <MainToolbar />
    </q-header>

    <!-- Left Sidebar: Page Thumbnails -->
    <q-drawer v-model="sidebarOpen" side="left" :width="200" bordered class="bg-grey-10">
      <PageThumbnails />
    </q-drawer>

    <!-- Main Content -->
    <q-page-container>
      <router-view />
      <FindBar />
    </q-page-container>

    <!-- Footer: Status Bar -->
    <q-footer class="bg-grey-10 q-px-md" style="height: 28px">
      <StatusBar />
    </q-footer>
  </q-layout>
</template>

<script setup lang="ts">
import { ref, provide, watch, onMounted, onUnmounted } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import { useSearchStore } from '@/stores/search'
import { usePDFViewer } from '@/composables/usePDFViewer'
import { usePDFEngine } from '@/composables/usePDFEngine'
import { enqueueOp } from '@/utils/opQueue'
import MainToolbar from '@/components/toolbar/MainToolbar.vue'
import PageThumbnails from '@/components/sidebar/PageThumbnails.vue'
import StatusBar from '@/components/common/StatusBar.vue'
import FindBar from '@/components/toolbar/FindBar.vue'

const docStore = useDocumentStore()
const editorStore = useEditorStore()
const historyStore = useHistoryStore()
const searchStore = useSearchStore()
const pdfViewer = usePDFViewer()
const pdfEngine = usePDFEngine()
const sidebarOpen = ref(true)

// Provide composables to the whole tree (header, drawer, page)
provide('pdfViewer', pdfViewer)
provide('pdfEngine', pdfEngine)
;(window as any).__pdfEngine = pdfEngine
;(window as any).__pdfViewer = pdfViewer

function handleBeforeUnload(e: BeforeUnloadEvent) {
  if (docStore.isModified) {
    e.preventDefault()
    e.returnValue = ''
  }
}

onMounted(async () => {
  editorStore.setStatus('Initializing MuPDF WASM engine...')
  const ok = await pdfEngine.initEngine()
  editorStore.setStatus(ok ? 'MuPDF engine ready. Open a PDF to begin.' : 'Failed to initialize MuPDF engine')
  document.addEventListener('keydown', handleKeyDown)
  document.body.addEventListener('dragover', handleDragOver)
  document.body.addEventListener('drop', handleDrop)
  window.addEventListener('beforeunload', handleBeforeUnload)
})
onUnmounted(() => {
  pdfEngine.destroyEngine()
  document.removeEventListener('keydown', handleKeyDown)
  document.body.removeEventListener('dragover', handleDragOver)
  document.body.removeEventListener('drop', handleDrop)
  window.removeEventListener('beforeunload', handleBeforeUnload)
})

// ===== FILE =====
async function loadBytes(bytes: Uint8Array, name: string) {
  historyStore.clear()
  searchStore.clear()
  await pdfViewer.loadDocument(bytes, name)
  try {
    const pageCount = await pdfEngine.loadDocument(bytes.buffer.slice(0) as ArrayBuffer)
    editorStore.setStatus(`${name} — ${pageCount} pages (ready)`)
  } catch (err: any) {
    editorStore.setStatus(`MuPDF load error: ${err.message}`)
  }
}

async function openFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.pdf'
  input.onchange = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    await loadBytes(new Uint8Array(await file.arrayBuffer()), file.name)
  }
  input.click()
}

async function saveFile() {
  if (!docStore.loaded) return
  // Flush any open inline editor: blur triggers its commit (150 ms timer),
  // so wait for it to land before snapshotting the document.
  const active = document.activeElement as HTMLElement | null
  if (active && (active.isContentEditable || active.tagName === 'TEXTAREA')) {
    active.blur()
    await new Promise(r => setTimeout(r, 250))
  }
  editorStore.setStatus('Saving PDF...')
  try {
    const bytes = await enqueueOp(() => pdfEngine.saveDocument())
    const blob = new Blob([bytes], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = (docStore.fileName || 'document.pdf').replace(/ \*$/, '')
    a.click()
    URL.revokeObjectURL(url)
    docStore.markSaved()
    editorStore.setStatus('PDF saved successfully')
  } catch (err: any) {
    editorStore.setStatus(`Save error: ${err.message}`)
  }
}

// ===== shared re-render after a document-level edit =====
async function syncAfterEdit() {
  const saved = await pdfEngine.saveDocument()
  const bytes = new Uint8Array(saved)
  await pdfViewer.reloadDocument(bytes)
  await pdfEngine.loadDocument(saved)
  if (docStore.currentPage > docStore.totalPages) docStore.setPage(docStore.totalPages)
  docStore.markModified()
}

/**
 * Serialize document-level operations. An op arriving between another op's
 * saveDocument and loadDocument would mutate the in-worker doc that is about
 * to be replaced (silently lost), and undo snapshots would read stale bytes.
 */
function exclusiveOp(fn: () => Promise<void>) {
  return enqueueOp(fn)
}

function pushUndo() {
  if (docStore.pdfBytes) historyStore.pushSnapshot(new Uint8Array(docStore.pdfBytes))
}

// ===== UNDO / REDO =====
async function undo() {
  if (!historyStore.canUndo || !docStore.loaded) return
  await exclusiveOp(async () => {
    editorStore.setStatus('Undoing...')
    if (docStore.pdfBytes) historyStore.pushRedo(new Uint8Array(docStore.pdfBytes))
    const snapshot = historyStore.popUndo()!
    await pdfViewer.reloadDocument(snapshot)
    await pdfEngine.loadDocument(snapshot.buffer.slice(0) as ArrayBuffer)
    docStore.markModified()
    editorStore.setStatus('Undo applied')
  })
}
async function redo() {
  if (!historyStore.canRedo || !docStore.loaded) return
  await exclusiveOp(async () => {
    editorStore.setStatus('Redoing...')
    if (docStore.pdfBytes) historyStore.pushUndoNoClear(new Uint8Array(docStore.pdfBytes))
    const snapshot = historyStore.popRedo()!
    await pdfViewer.reloadDocument(snapshot)
    await pdfEngine.loadDocument(snapshot.buffer.slice(0) as ArrayBuffer)
    docStore.markModified()
    editorStore.setStatus('Redo applied')
  })
}

// ===== PAGE OPERATIONS =====
// pushUndo() captures the pre-edit bytes (docStore.pdfBytes is only replaced by
// syncAfterEdit), so calling it AFTER the op succeeds — before syncAfterEdit —
// records the correct snapshot and avoids polluting undo/redo when the op fails.
async function rotatePage(degrees: number) {
  if (!docStore.loaded) return
  await exclusiveOp(async () => {
    const ok = await pdfEngine.rotatePage(docStore.currentPage - 1, degrees)
    if (ok) { pushUndo(); await syncAfterEdit(); editorStore.setStatus(`Page rotated ${degrees > 0 ? 'right' : 'left'}`) }
    else editorStore.setStatus(`Rotate failed: ${pdfEngine.error.value}`)
  })
}
async function insertBlankPage() {
  if (!docStore.loaded) return
  await exclusiveOp(async () => {
    const size = await pdfEngine.getPageSize(docStore.currentPage - 1).catch(() => ({ width: 612, height: 792 }))
    const r = await pdfEngine.insertBlankPage(docStore.currentPage, size.width, size.height)
    if (r !== false) { pushUndo(); await syncAfterEdit(); docStore.setPage(docStore.currentPage + 1); editorStore.setStatus('Blank page inserted') }
    else editorStore.setStatus(`Insert failed: ${pdfEngine.error.value}`)
  })
}
async function deletePage() {
  if (!docStore.loaded) return
  await exclusiveOp(async () => {
    const r = await pdfEngine.deletePage(docStore.currentPage - 1)
    if (r !== false) { pushUndo(); await syncAfterEdit(); editorStore.setStatus('Page deleted') }
    else editorStore.setStatus(`Delete failed: ${pdfEngine.error.value}`)
  })
}
async function duplicatePage() {
  if (!docStore.loaded) return
  await exclusiveOp(async () => {
    const r = await pdfEngine.duplicatePage(docStore.currentPage - 1)
    if (r !== false) { pushUndo(); await syncAfterEdit(); editorStore.setStatus('Page duplicated') }
    else editorStore.setStatus(`Duplicate failed: ${pdfEngine.error.value}`)
  })
}
async function movePage(from: number, to: number) {
  if (!docStore.loaded || from === to) return
  await exclusiveOp(async () => {
    const r = await pdfEngine.movePage(from, to)
    if (r !== false) { pushUndo(); await syncAfterEdit(); docStore.setPage(to + 1); editorStore.setStatus('Page moved') }
    else editorStore.setStatus(`Move failed: ${pdfEngine.error.value}`)
  })
}

// ===== SEARCH =====
let searchSeq = 0
async function runSearch(query: string) {
  if (!docStore.loaded) return
  searchStore.query = query
  if (!query.trim()) { searchStore.setResults([]); return }
  const seq = ++searchSeq
  searchStore.searching = true
  try {
    const hits = await pdfEngine.searchDocument(query.trim(), 200)
    if (seq !== searchSeq) return // a newer search superseded this one
    searchStore.setResults(hits)
    editorStore.setStatus(`${hits.length} match(es) for "${query}"`)
    gotoCurrentHit()
  } finally {
    if (seq === searchSeq) searchStore.searching = false
  }
}

/** Re-run the active search after a document edit so highlights/pages stay valid,
 *  preserving the user's current match position and NOT navigating. */
async function refreshSearch() {
  if (!searchStore.open || !searchStore.query.trim() || !docStore.loaded) return
  const seq = ++searchSeq
  const prevIndex = searchStore.currentIndex
  const hits = await pdfEngine.searchDocument(searchStore.query.trim(), 200)
  if (seq !== searchSeq) return
  searchStore.hits = hits
  searchStore.currentIndex = hits.length ? Math.min(Math.max(prevIndex, 0), hits.length - 1) : -1
}
watch(() => docStore.renderVersion, refreshSearch)
function gotoCurrentHit() {
  const hit = searchStore.current
  if (hit) docStore.setPage(hit.pageIndex + 1)
}
function searchNext() { searchStore.next(); gotoCurrentHit() }
function searchPrev() { searchStore.prev(); gotoCurrentHit() }
function openFind() { searchStore.open = true }
function closeFind() { searchStore.open = false }

// ===== KEYBOARD =====
function handleKeyDown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable

  if (e.ctrlKey || e.metaKey) {
    // While typing, Ctrl+Z must stay the browser's TEXT undo — never roll
    // back the whole document underneath an open editor.
    if (e.key === 'z' && !e.shiftKey) { if (isTyping) return; e.preventDefault(); undo(); return }
    if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { if (isTyping) return; e.preventDefault(); redo(); return }
    if (e.key === 's') { e.preventDefault(); saveFile(); return }
    if (e.key === 'o') { e.preventDefault(); openFile(); return }
    if (e.key === 'f') { e.preventDefault(); openFind(); return }
  }
  // Escape inside an editor/input cancels THAT editor (handled locally),
  // not the find bar — the find input closes itself on Escape.
  if (e.key === 'Escape') { if (!isTyping) closeFind(); return }
  if (isTyping || !docStore.loaded) return

  switch (e.key.toLowerCase()) {
    case 'v': editorStore.setTool('select'); break
    case 'e': editorStore.setTool('edit'); break
    case 't': editorStore.setTool('addText'); break
    case 'h': editorStore.setTool('highlight'); break
    case 'd': editorStore.setTool('draw'); break
    case 'r': editorStore.setTool('rectangle'); break
    case 'o': editorStore.setTool('circle'); break
  }
}

// ===== DRAG & DROP =====
function handleDragOver(e: DragEvent) { e.preventDefault() }
async function handleDrop(e: DragEvent) {
  e.preventDefault()
  const file = e.dataTransfer?.files[0]
  if (file?.type === 'application/pdf') {
    await loadBytes(new Uint8Array(await file.arrayBuffer()), file.name)
  }
}

// ===== PROVIDE to whole tree =====
provide('openFile', openFile)
provide('saveFile', saveFile)
provide('undo', undo)
provide('redo', redo)
provide('rotatePage', rotatePage)
provide('insertBlankPage', insertBlankPage)
provide('deletePage', deletePage)
provide('duplicatePage', duplicatePage)
provide('movePage', movePage)
provide('runSearch', runSearch)
provide('searchNext', searchNext)
provide('searchPrev', searchPrev)
provide('openFind', openFind)
provide('closeFind', closeFind)
</script>
