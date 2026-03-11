<template>
  <q-page class="flex flex-center" style="overflow: auto">
    <!-- Welcome Screen -->
    <div v-if="!docStore.loaded" class="text-center text-grey-5">
      <q-icon name="picture_as_pdf" size="80px" color="grey-7" />
      <div class="text-h5 q-mt-lg">Welcome to PDF Editor Pro v2</div>
      <div class="text-body1 q-mt-sm text-grey-6">Open a PDF file to start editing</div>
      <q-btn
        color="primary"
        icon="folder_open"
        label="Open PDF File"
        class="q-mt-lg"
        size="lg"
        @click="openFile"
      />
      <div class="text-caption q-mt-md text-grey-7">or drag and drop a PDF here</div>
    </div>

    <!-- PDF Viewer -->
    <PDFViewer v-else ref="pdfViewerRef" />
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import { usePDFViewer } from '@/composables/usePDFViewer'
import { usePDFEngine } from '@/composables/usePDFEngine'
import { provide } from 'vue'
import PDFViewer from '@/components/viewer/PDFViewer.vue'

const docStore = useDocumentStore()
const editorStore = useEditorStore()
const historyStore = useHistoryStore()
const pdfViewer = usePDFViewer()
const pdfEngine = usePDFEngine()
const pdfViewerRef = ref<InstanceType<typeof PDFViewer> | null>(null)

// Provide composables to child components
provide('pdfViewer', pdfViewer)
provide('pdfEngine', pdfEngine)

// Debug: expose on window for console access
;(window as any).__pdfEngine = pdfEngine
;(window as any).__pdfViewer = pdfViewer

// Initialize MuPDF engine on mount
onMounted(async () => {
  editorStore.setStatus('Initializing MuPDF WASM engine...')
  const ok = await pdfEngine.initEngine()
  if (ok) {
    editorStore.setStatus('MuPDF engine ready. Open a PDF to begin.')
  } else {
    editorStore.setStatus('Failed to initialize MuPDF engine')
  }

  document.addEventListener('keydown', handleKeyDown)
  document.body.addEventListener('dragover', handleDragOver)
  document.body.addEventListener('drop', handleDrop)
})

onUnmounted(() => {
  pdfEngine.destroyEngine()
  document.removeEventListener('keydown', handleKeyDown)
  document.body.removeEventListener('dragover', handleDragOver)
  document.body.removeEventListener('drop', handleDrop)
})

// ==========================================
// FILE OPERATIONS
// ==========================================

async function openFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.pdf'
  input.onchange = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return

    const bytes = new Uint8Array(await file.arrayBuffer())

    // Clear history on new document
    historyStore.clear()

    // Load into PDF.js for rendering
    await pdfViewer.loadDocument(bytes, file.name)

    // Also load into MuPDF for editing
    editorStore.setStatus('Loading document into MuPDF engine...')
    try {
      const pageCount = await pdfEngine.loadDocument(bytes.buffer)
      editorStore.setStatus(`${file.name} — ${pageCount} pages (MuPDF ready)`)
    } catch (err: any) {
      editorStore.setStatus(`MuPDF load error: ${err.message}`)
    }
  }
  input.click()
}

async function saveFile() {
  if (!docStore.loaded) return
  editorStore.setStatus('Saving PDF...')
  try {
    const bytes = await pdfEngine.saveDocument()
    const blob = new Blob([bytes], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = docStore.fileName?.replace(/ \*$/, '') || 'document.pdf'
    a.click()
    URL.revokeObjectURL(url)
    docStore.markSaved()
    editorStore.setStatus('PDF saved successfully')
  } catch (err: any) {
    editorStore.setStatus(`Save error: ${err.message}`)
  }
}

// ==========================================
// UNDO / REDO
// ==========================================

async function undo() {
  if (!historyStore.canUndo || !docStore.loaded) return

  editorStore.setStatus('Undoing...')

  // Save current state to redo stack
  const currentBytes = docStore.pdfBytes
  if (currentBytes) {
    historyStore.pushRedo(new Uint8Array(currentBytes))
  }

  // Pop previous state
  const snapshot = historyStore.popUndo()!

  // Reload both engines
  await pdfViewer.reloadDocument(snapshot)
  await pdfEngine.loadDocument(snapshot.buffer.slice(0))
  docStore.markModified()
  editorStore.setStatus('Undo applied')
}

async function redo() {
  if (!historyStore.canRedo || !docStore.loaded) return

  editorStore.setStatus('Redoing...')

  // Save current state to undo stack (without clearing redo)
  const currentBytes = docStore.pdfBytes
  if (currentBytes) {
    historyStore.undoStack.push(new Uint8Array(currentBytes))
  }

  // Pop redo state
  const snapshot = historyStore.popRedo()!

  await pdfViewer.reloadDocument(snapshot)
  await pdfEngine.loadDocument(snapshot.buffer.slice(0))
  docStore.markModified()
  editorStore.setStatus('Redo applied')
}

// ==========================================
// KEYBOARD SHORTCUTS
// ==========================================

function handleKeyDown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable

  // Ctrl/Cmd shortcuts (work even when typing)
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      undo()
      return
    }
    if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
      e.preventDefault()
      redo()
      return
    }
    if (e.key === 's') {
      e.preventDefault()
      saveFile()
      return
    }
    if (e.key === 'o') {
      e.preventDefault()
      openFile()
      return
    }
  }

  // Tool shortcuts — only when not typing in an input
  if (isTyping) return
  if (!docStore.loaded) return

  switch (e.key.toLowerCase()) {
    case 'v':
      editorStore.setTool('select')
      break
    case 'e':
      editorStore.setTool('edit')
      break
    case 't':
      editorStore.setTool('addText')
      break
    case 'delete':
    case 'backspace':
      deleteSelected()
      break
    case 'escape':
      editorStore.setTool('select')
      break
  }
}

function deleteSelected() {
  // Access the TextBlockOverlay through the PDFViewer component ref
  const overlay = (pdfViewerRef.value as any)?.textBlockOverlayRef
  if (overlay?.deleteSelectedBlock) {
    overlay.deleteSelectedBlock()
  }
}

// ==========================================
// DRAG AND DROP
// ==========================================

function handleDragOver(e: DragEvent) {
  e.preventDefault()
}

async function handleDrop(e: DragEvent) {
  e.preventDefault()
  const file = e.dataTransfer?.files[0]
  if (file?.type === 'application/pdf') {
    const bytes = new Uint8Array(await file.arrayBuffer())
    historyStore.clear()
    await pdfViewer.loadDocument(bytes, file.name)

    try {
      const pageCount = await pdfEngine.loadDocument(bytes.buffer)
      editorStore.setStatus(`${file.name} — ${pageCount} pages (MuPDF ready)`)
    } catch (err: any) {
      editorStore.setStatus(`MuPDF load error: ${err.message}`)
    }
  }
}

// ==========================================
// PROVIDE TO CHILDREN
// ==========================================

provide('openFile', openFile)
provide('saveFile', saveFile)
provide('undo', undo)
provide('redo', redo)
</script>
