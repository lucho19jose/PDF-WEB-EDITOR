<template>
  <div class="thumb-panel column no-wrap full-height">
    <!-- Page op toolbar -->
    <div class="row items-center q-px-sm q-py-xs bg-grey-9">
      <span class="text-caption text-grey-4">Pages</span>
      <q-space />
      <q-btn flat dense round size="sm" icon="note_add" :disable="!docStore.loaded" @click="insertBlankPage">
        <q-tooltip>Insert blank page</q-tooltip>
      </q-btn>
      <span style="position:relative;display:inline-flex">
        <q-btn flat dense round size="sm" icon="library_add" :disable="!docStore.loaded" @click="mergeViaInput">
          <q-tooltip>Insert another PDF after this page — drag the thumbnails to reorder</q-tooltip>
        </q-btn>
        <input v-if="docStore.loaded" ref="mergePickRef" type="file" accept="application/pdf,.pdf" style="position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;cursor:pointer;z-index:1" @change="onMergePicked" />
      </span>
      <q-btn flat dense round size="sm" icon="content_copy" :disable="!docStore.loaded" @click="duplicatePage">
        <q-tooltip>Duplicate current page</q-tooltip>
      </q-btn>
      <q-btn flat dense round size="sm" icon="delete" :disable="!docStore.loaded || docStore.totalPages <= 1" @click="deletePage">
        <q-tooltip>Delete current page</q-tooltip>
      </q-btn>
    </div>

    <q-scroll-area ref="scrollRef" class="col" @scroll="scheduleVisible">
      <div class="q-pa-sm">
        <div
          v-for="page in docStore.totalPages"
          :key="page + ':' + docStore.renderVersion"
          :ref="el => setItemRef(el, page)"
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
const mergePdfFile = inject<(f: File) => void>('mergePdfFile', () => {})

const mergePickRef = ref<HTMLInputElement | null>(null)
function mergeViaInput() { mergePickRef.value?.click() }

function onMergePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) mergePdfFile(file)
}
const insertBlankPage = inject<() => void>('insertBlankPage', () => {})
const duplicatePage = inject<() => void>('duplicatePage', () => {})
const deletePage = inject<() => void>('deletePage', () => {})
const movePage = inject<(from: number, to: number) => void>('movePage', () => {})

const canvases = new Map<number, HTMLCanvasElement>()
const items = new Map<number, HTMLElement>()
const scrollRef = ref<any>(null)
const dragOverPage = ref<number | null>(null)
let thumbDoc: pdfjsLib.PDFDocumentProxy | null = null
let renderToken = 0

function setCanvasRef(el: any, page: number) {
  if (el) canvases.set(page, el as HTMLCanvasElement)
  else canvases.delete(page)
}

function setItemRef(el: any, page: number) {
  if (el) items.set(page, el as HTMLElement)
  else items.delete(page)
}

/**
 * Keep the page you are on visible in the list.
 *
 * Without this the panel simply never moves: on a document of any length the
 * highlighted thumbnail is somewhere below the fold and the only way to see
 * which page you are on is to scroll the list by hand, every time. The panel
 * is meant to say where you are, and it cannot do that off-screen.
 *
 * Nothing happens when the thumbnail is already visible — scrolling the list
 * under someone who is browsing it is its own annoyance.
 */
function revealCurrent() {
  const el = items.get(docStore.currentPage)
  const area = scrollRef.value
  if (!el || !area) return
  const target = area.getScrollTarget?.() as HTMLElement | undefined
  if (!target) return
  const top = el.offsetTop
  const bottom = top + el.offsetHeight
  const viewTop = target.scrollTop
  const viewBottom = viewTop + target.clientHeight
  if (top >= viewTop && bottom <= viewBottom) return
  // Centre it, clamped by the scroll area itself.
  area.setScrollPosition('vertical', Math.max(0, top - target.clientHeight / 2 + el.offsetHeight / 2), 150)
}

/**
 * Thumbnails are drawn only when they can be SEEN.
 *
 * Every edit bumps `renderVersion`, and this used to answer by re-parsing the
 * whole PDF and re-rendering every page in the panel. On a forty-page document
 * that is forty rasterisations per keystroke-level edit, all but two of them
 * for pictures nobody is looking at — and the byte array is COPIED for the
 * parse, so a large document pays for that too, every time.
 *
 * Now an edit only invalidates: what is on screen is redrawn at once, and the
 * rest as they are scrolled to.
 */
const painted = new Set<number>()

async function ensureDoc(): Promise<any | null> {
  if (thumbDoc) return thumbDoc
  if (!docStore.pdfBytes) return null
  const token = renderToken
  const task = pdfjsLib.getDocument({ data: docStore.pdfBytes.slice() })
  const doc = await task.promise
  if (token !== renderToken) { await doc.destroy().catch(() => {}); return null }
  thumbDoc = doc
  return doc
}

/** Everything on screen is stale — the document changed under us. */
async function renderThumbnails() {
  renderToken++
  painted.clear()
  if (thumbDoc) { await thumbDoc.destroy().catch(() => {}); thumbDoc = null }
  await nextTick()
  scheduleVisible()
}

/**
 * Check again once the panel has finished moving.
 *
 * `revealCurrent` scrolls with an animation, so asking what is visible in the
 * same tick measures where the list USED to be: every thumbnail below the fold
 * stayed blank however far you scrolled. Checking now and again shortly after
 * covers both the immediate case and the animated one.
 */
let settleTimer: any = null
function scheduleVisible() {
  renderVisible()
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => { settleTimer = null; renderVisible() }, 300)
}

let visibleBusy = false
async function renderVisible() {
  if (visibleBusy) return
  visibleBusy = true
  try {
    const token = renderToken
    const wanted: number[] = []
    for (const [page, el] of items) {
      if (painted.has(page)) continue
      const r = el.getBoundingClientRect()
      // One panel-height of margin, so scrolling meets drawn thumbnails.
      if (r.bottom > -window.innerHeight && r.top < window.innerHeight * 2) wanted.push(page)
    }
    if (!wanted.length) return
    const doc = await ensureDoc()
    if (!doc || token !== renderToken) return

    for (const p of wanted.sort((a, b) => a - b)) {
      if (token !== renderToken) return
      const canvas = canvases.get(p)
      if (!canvas || painted.has(p)) continue
      const pdfPage = await doc.getPage(p)
      const baseVp = pdfPage.getViewport({ scale: 1 })
      const scale = 150 / baseVp.width
      const vp = pdfPage.getViewport({ scale })
      canvas.width = vp.width
      canvas.height = vp.height
      const ctx = canvas.getContext('2d')!
      await pdfPage.render({ canvasContext: ctx, viewport: vp, canvas } as any).promise
      painted.add(p)
    }
  } catch (err) {
    console.error('[Thumbnails] render error', err)
  } finally {
    visibleBusy = false
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

watch(() => docStore.currentPage, () => nextTick(() => { revealCurrent(); scheduleVisible() }))
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
