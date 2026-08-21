<template>
  <div class="thumb-panel column no-wrap full-height">
    <!-- Page op toolbar -->
    <div class="row items-center q-px-sm q-py-xs bg-grey-9">
      <span class="text-caption text-grey-4">Pages</span>
      <q-space />
      <q-btn flat dense round size="sm" icon="note_add" :disable="!docStore.loaded" @click="insertBlankPage">
        <q-tooltip>Insert blank page</q-tooltip>
      </q-btn>
      <q-btn flat dense round size="sm" icon="content_copy" :disable="!docStore.loaded" @click="duplicatePage">
        <q-tooltip>Duplicate current page</q-tooltip>
      </q-btn>
      <q-btn flat dense round size="sm" icon="delete" :disable="!docStore.loaded || docStore.totalPages <= 1" @click="deletePage">
        <q-tooltip>Delete current page</q-tooltip>
      </q-btn>
    </div>

    <q-scroll-area class="col">
      <div class="q-pa-sm">
        <div
          v-for="page in docStore.totalPages"
          :key="page + ':' + docStore.renderVersion"
          class="thumb-item q-mb-sm"
          :class="{ active: page === docStore.currentPage, dragover: dragOverPage === page }"
          draggable="true"
          @click="docStore.setPage(page)"
          @dragstart="onDragStart($event, page)"
          @dragover.prevent="dragOverPage = page"
          @dragleave="dragOverPage === page && (dragOverPage = null)"
          @drop.prevent="onDrop(page)"
        >
          <div class="thumb-canvas-wrap">
            <canvas :ref="el => setCanvasRef(el, page)" class="thumb-canvas" />
          </div>
          <div class="text-caption text-center text-grey-5 q-mt-xs">{{ page }}</div>
        </div>
        <div v-if="!docStore.loaded" class="text-caption text-grey-7 text-center q-mt-md">No document loaded</div>
      </div>
    </q-scroll-area>
  </div>
</template>

<script setup lang="ts">
import { ref, inject, watch, nextTick, onBeforeUnmount } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
import { useDocumentStore } from '@/stores/document'

const docStore = useDocumentStore()
const insertBlankPage = inject<() => void>('insertBlankPage', () => {})
const duplicatePage = inject<() => void>('duplicatePage', () => {})
const deletePage = inject<() => void>('deletePage', () => {})
const movePage = inject<(from: number, to: number) => void>('movePage', () => {})

const canvases = new Map<number, HTMLCanvasElement>()
const dragOverPage = ref<number | null>(null)
let thumbDoc: pdfjsLib.PDFDocumentProxy | null = null
let renderToken = 0

function setCanvasRef(el: any, page: number) {
  if (el) canvases.set(page, el as HTMLCanvasElement)
  else canvases.delete(page)
}

async function renderThumbnails() {
  if (!docStore.pdfBytes) return
  const token = ++renderToken
  try {
    if (thumbDoc) { await thumbDoc.destroy().catch(() => {}); thumbDoc = null }
    const task = pdfjsLib.getDocument({ data: docStore.pdfBytes.slice() })
    const doc = await task.promise
    if (token !== renderToken) { await doc.destroy().catch(() => {}); return }
    thumbDoc = doc
    await nextTick()
    for (let p = 1; p <= doc.numPages; p++) {
      if (token !== renderToken) return
      const canvas = canvases.get(p)
      if (!canvas) continue
      const pdfPage = await doc.getPage(p)
      const baseVp = pdfPage.getViewport({ scale: 1 })
      const scale = 150 / baseVp.width
      const vp = pdfPage.getViewport({ scale })
      canvas.width = vp.width
      canvas.height = vp.height
      const ctx = canvas.getContext('2d')!
      await pdfPage.render({ canvasContext: ctx, viewport: vp, canvas } as any).promise
    }
  } catch (err) {
    console.error('[Thumbnails] render error', err)
  }
}

// HTML5 drag reorder
const draggedPage = ref<number | null>(null)
function onDragStart(e: DragEvent, page: number) {
  draggedPage.value = page
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onDrop(targetPage: number) {
  dragOverPage.value = null
  if (draggedPage.value !== null && draggedPage.value !== targetPage) {
    movePage(draggedPage.value - 1, targetPage - 1)
  }
  draggedPage.value = null
}

watch(() => docStore.renderVersion, renderThumbnails)
watch(() => docStore.loaded, (l) => { if (l) renderThumbnails() })
watch(() => docStore.totalPages, () => nextTick(renderThumbnails))

onBeforeUnmount(() => { renderToken++; if (thumbDoc) thumbDoc.destroy().catch(() => {}) })
</script>

<style scoped>
.thumb-panel { background: #1d1d1d; }
.thumb-item {
  border: 2px solid transparent; border-radius: 4px; padding: 4px; cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.thumb-item:hover { background: rgba(255,255,255,0.05); }
.thumb-item.active { border-color: var(--q-primary); }
.thumb-item.dragover { border-color: #fdd835; background: rgba(253,216,53,0.08); }
.thumb-canvas-wrap {
  display: flex; align-items: center; justify-content: center;
  background: #fff; border-radius: 2px; overflow: hidden; min-height: 40px;
}
.thumb-canvas { display: block; max-width: 100%; height: auto; }
</style>
