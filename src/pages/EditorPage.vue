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
    <PDFViewer v-else />
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { usePDFViewer } from '@/composables/usePDFViewer'
import { usePDFEngine } from '@/composables/usePDFEngine'
import { provide } from 'vue'
import PDFViewer from '@/components/viewer/PDFViewer.vue'

const docStore = useDocumentStore()
const editorStore = useEditorStore()
const pdfViewer = usePDFViewer()
const pdfEngine = usePDFEngine()

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
})

onUnmounted(() => {
  pdfEngine.destroyEngine()
})

async function openFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.pdf'
  input.onchange = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return

    const bytes = new Uint8Array(await file.arrayBuffer())

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

// Expose for toolbar
provide('openFile', openFile)
provide('saveFile', saveFile)

// Drag and drop
function handleDragOver(e: DragEvent) {
  e.preventDefault()
}

async function handleDrop(e: DragEvent) {
  e.preventDefault()
  const file = e.dataTransfer?.files[0]
  if (file?.type === 'application/pdf') {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await pdfViewer.loadDocument(bytes, file.name)

    try {
      const pageCount = await pdfEngine.loadDocument(bytes.buffer)
      editorStore.setStatus(`${file.name} — ${pageCount} pages (MuPDF ready)`)
    } catch (err: any) {
      editorStore.setStatus(`MuPDF load error: ${err.message}`)
    }
  }
}

// Setup drag/drop on body
if (typeof document !== 'undefined') {
  document.body.addEventListener('dragover', handleDragOver)
  document.body.addEventListener('drop', handleDrop)
}
</script>
