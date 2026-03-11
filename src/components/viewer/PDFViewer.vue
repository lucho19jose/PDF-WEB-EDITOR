<template>
  <div
    ref="containerRef"
    class="pdf-viewer-container"
    :style="{ overflow: 'auto', width: '100%', height: '100%' }"
  >
    <div class="pdf-page-wrapper" :style="pageWrapperStyle">
      <canvas ref="canvasRef" class="pdf-canvas" />
      <TextBlockOverlay
        ref="textBlockOverlayRef"
        :page-width="pageWidth"
        :page-height="pageHeight"
        :pdf-width="pdfPageWidth"
        :pdf-height="pdfPageHeight"
        @text-changed="onTextChanged"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, inject, nextTick } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import type { usePDFViewer } from '@/composables/usePDFViewer'
import type { usePDFEngine } from '@/composables/usePDFEngine'
import TextBlockOverlay from './TextBlockOverlay.vue'

const docStore = useDocumentStore()
const editorStore = useEditorStore()
const pdfViewer = inject<ReturnType<typeof usePDFViewer>>('pdfViewer')!
const pdfEngine = inject<ReturnType<typeof usePDFEngine>>('pdfEngine')!

const containerRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const textBlockOverlayRef = ref<InstanceType<typeof TextBlockOverlay> | null>(null)
const pageWidth = ref(0)
const pageHeight = ref(0)
const pdfPageWidth = ref(612) // default letter size
const pdfPageHeight = ref(792)

const pageWrapperStyle = computed(() => ({
  width: `${pageWidth.value}px`,
  height: `${pageHeight.value}px`,
  margin: '20px auto',
  position: 'relative' as const,
  boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
  background: '#fff'
}))

async function render() {
  if (!canvasRef.value || !docStore.loaded) return

  const result = await pdfViewer.renderPage(canvasRef.value, docStore.currentPage)
  if (result) {
    pageWidth.value = result.width
    pageHeight.value = result.height
    // Get the unscaled PDF page dimensions
    const vp = result.viewport
    pdfPageWidth.value = vp.width / docStore.scale
    pdfPageHeight.value = vp.height / docStore.scale
  }
}

async function onTextChanged() {
  // After text is modified in the content stream:
  // 1. Save modified PDF from MuPDF
  // 2. Reload into PDF.js (without resetting page/state)
  // 3. Re-render to show changes
  try {
    const savedBytes = await pdfEngine.saveDocument()
    const bytes = new Uint8Array(savedBytes)
    // Reload PDF.js without resetting page/tool state
    await pdfViewer.reloadDocument(bytes)
    // Also reload into MuPDF with the saved bytes
    await pdfEngine.loadDocument(savedBytes)
    docStore.markModified()
    await nextTick()
    await render()
  } catch (err: any) {
    console.error('Failed to re-render after edit:', err)
    await render()
  }
}

watch(() => docStore.currentPage, render)
watch(() => docStore.scale, render)
watch(() => docStore.renderVersion, render)

watch(() => docStore.loaded, async (loaded) => {
  if (loaded) {
    await nextTick()
    render()
  }
})

onMounted(() => {
  if (docStore.loaded) render()
})

defineExpose({ textBlockOverlayRef })
</script>

<style scoped>
.pdf-viewer-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  background: #2a2a2a;
}
.pdf-canvas {
  display: block;
}
</style>
