<template>
  <div
    ref="containerRef"
    class="pdf-viewer-container"
    :style="{ overflow: 'auto', width: '100%', height: '100%' }"
  >
    <div
      v-for="page in pageList"
      :key="page"
      :ref="el => setWrapperRef(el, page)"
      class="pdf-page-wrapper"
      :class="{ current: continuous && page === docStore.currentPage }"
      :style="wrapperStyle(page)"
      @mousedown="onPageMouseDown(page)"
    >
      <canvas :ref="el => setCanvasRef(el, page)" class="pdf-canvas" />

      <!--
        The editing layers live on ONE page: the one being looked at.

        They are written against "the current page" throughout — the overlay
        alone is some 1800 lines of it — and giving every page its own set would
        mean N text extractions, N annotation loads and N sets of selection
        state for no gain, since a person edits one page at a time. Scrolling
        moves the current page, so the tools follow the reader without either
        having to know about the other.
      -->
      <template v-if="page === docStore.currentPage">
        <TextBlockOverlay
          :ref="setTextOverlay"
          :page-width="pageWidth"
          :page-height="pageHeight"
          :pdf-width="pdfPageWidth"
          :pdf-height="pdfPageHeight"
          @text-changed="onTextChanged"
        />
        <AnnotationLayer
          :ref="setAnnotLayer"
          :page-width="pageWidth"
          :page-height="pageHeight"
          :pdf-width="pdfPageWidth"
          :pdf-height="pdfPageHeight"
          @changed="onTextChanged"
        />
        <!--
          Over the scan, under nothing: the OCR layer only appears for pages
          that were recognised, and never replaces the rendered page beneath it.
        -->
        <OcrTextLayer
          :page-width="pageWidth"
          :page-height="pageHeight"
          :pdf-width="pdfPageWidth"
          :pdf-height="pdfPageHeight"
        />
        <SearchHighlights
          :page-width="pageWidth"
          :page-height="pageHeight"
          :pdf-width="pdfPageWidth"
          :pdf-height="pdfPageHeight"
        />
      </template>

      <div v-if="continuous && docStore.totalPages > 1" class="page-badge">{{ page }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, inject, nextTick, provide } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import type { usePDFViewer } from '@/composables/usePDFViewer'
import type { usePDFEngine } from '@/composables/usePDFEngine'
import TextBlockOverlay from './TextBlockOverlay.vue'
import AnnotationLayer from './AnnotationLayer.vue'
import SearchHighlights from './SearchHighlights.vue'
import OcrTextLayer from './OcrTextLayer.vue'
import { enqueueOp } from '@/utils/opQueue'

const docStore = useDocumentStore()
const editorStore = useEditorStore()

/**
 * The annotation layer needs the text layer to open space for an image, but the
 * two are siblings. PDFViewer owns both refs, so it is the only place that can
 * hand one to the other.
 */
provide('makeRoomInText', (pdfY: number, amount: number, below: boolean) =>
  textBlockOverlayRef.value?.makeRoomAt(pdfY, amount, below)
    ?? Promise.resolve({ column: null, y: pdfY, moved: 0, spilled: 0, capped: false }))
const pdfViewer = inject<ReturnType<typeof usePDFViewer>>('pdfViewer')!
const pdfEngine = inject<ReturnType<typeof usePDFEngine>>('pdfEngine')!

const containerRef = ref<HTMLDivElement | null>(null)
const textBlockOverlayRef = ref<InstanceType<typeof TextBlockOverlay> | null>(null)
const annotationLayerRef = ref<InstanceType<typeof AnnotationLayer> | null>(null)

/** The CURRENT page's geometry — what every overlay is laid out against. */
const pageWidth = ref(0)
const pageHeight = ref(0)
const pdfPageWidth = ref(612) // default letter size
const pdfPageHeight = ref(792)

const continuous = computed(() => docStore.continuousScroll)
const pageList = computed(() =>
  continuous.value
    ? Array.from({ length: docStore.totalPages }, (_, i) => i + 1)
    : [docStore.currentPage]
)

const canvases = new Map<number, HTMLCanvasElement>()
const wrappers = new Map<number, HTMLElement>()
function setCanvasRef(el: any, page: number) {
  if (el) canvases.set(page, el as HTMLCanvasElement)
  else canvases.delete(page)
}
function setWrapperRef(el: any, page: number) {
  if (el) wrappers.set(page, el as HTMLElement)
  else wrappers.delete(page)
}

/**
 * The overlays are addressed by FUNCTION refs, not by name.
 *
 * A `ref="name"` written inside a `v-for` collects into an ARRAY, even when the
 * loop renders exactly one of them. `makeRoomInText` then called `makeRoomAt`
 * on an array, threw inside an async event handler, and the whole image
 * insertion vanished without a message: the picture simply never appeared.
 */
function setTextOverlay(el: any) {
  textBlockOverlayRef.value = el || null
}
function setAnnotLayer(el: any) {
  annotationLayerRef.value = el || null
}

/**
 * Page sizes in CSS pixels, so a page that has not been painted yet still
 * occupies the right amount of the scroll bar.
 *
 * Measuring every page up front would mean one `getPage` per page before
 * anything appears, which on a long document is a visible stall for a number
 * that is the same on nearly every page. Page 1 is measured and stands in for
 * the rest; each page corrects its own entry as it is painted, so a document of
 * mixed sizes — a merged A4 into Letter — settles as the reader reaches it.
 */
const sizes = ref(new Map<number, { w: number; h: number }>())
const fallbackSize = ref({ w: 612, h: 792 })

function sizeOf(page: number): { w: number; h: number } {
  return sizes.value.get(page) ?? fallbackSize.value
}

function wrapperStyle(page: number) {
  const s = sizeOf(page)
  return {
    width: `${s.w}px`,
    height: `${s.h}px`,
    margin: continuous.value ? '0 auto 16px' : '20px auto',
    position: 'relative' as const,
    boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
    background: '#fff'
  }
}

// ── Rendering ──
//
// One page at a time. `renderPage` supersedes any render already running — it
// has to, or a stale page paints over the latest — so firing several at once
// would leave all but the last blank.
const painted = new Set<number>()
let renderQueue: number[] = []
let renderBusy = false

async function pump() {
  if (renderBusy) return
  renderBusy = true
  try {
    while (renderQueue.length) {
      const page = renderQueue.shift()!
      const canvas = canvases.get(page)
      if (!canvas || painted.has(page)) continue
      const result = await pdfViewer.renderPage(canvas, page)
      if (!result) continue
      painted.add(page)
      const next = new Map(sizes.value)
      next.set(page, { w: result.width, h: result.height })
      sizes.value = next
      if (page === 1) fallbackSize.value = { w: result.width, h: result.height }
      if (page === docStore.currentPage) adoptCurrentGeometry(result)
    }
  } finally {
    renderBusy = false
  }
}

function adoptCurrentGeometry(result: { width: number; height: number; viewport: any }) {
  pageWidth.value = result.width
  pageHeight.value = result.height
  pdfPageWidth.value = result.viewport.width / docStore.scale
  pdfPageHeight.value = result.viewport.height / docStore.scale
}

/** Queue the current page first, then whatever is on or near the screen. */
function requestVisible() {
  if (!docStore.loaded) return
  const wanted = new Set<number>()
  if (pageList.value.includes(docStore.currentPage)) wanted.add(docStore.currentPage)

  const viewH = window.innerHeight
  for (const page of pageList.value) {
    const el = wrappers.get(page)
    if (!el) continue
    const r = el.getBoundingClientRect()
    // One screen of margin either way, so scrolling meets painted pages.
    if (r.bottom > -viewH && r.top < viewH * 2) wanted.add(page)
  }
  for (const page of wanted) {
    if (!painted.has(page) && !renderQueue.includes(page)) renderQueue.push(page)
  }
  pump()
}

/** Everything on screen is stale — the document or the scale changed. */
async function repaintAll() {
  painted.clear()
  renderQueue = []
  await nextTick()
  requestVisible()
}

// ── Which page is being looked at ──
//
// The current page follows the scroll, which is what makes the editing tools
// appear on the page the reader is actually on without them having to click it.
let syncingFromScroll = false
/** Set while scrolling TO a page, so arriving does not re-decide where we are. */
let scrollingToPage = 0

function pageInView(): number {
  const middle = window.innerHeight / 2
  let best = docStore.currentPage
  let bestDist = Infinity
  for (const page of pageList.value) {
    const el = wrappers.get(page)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.bottom < 0 || r.top > window.innerHeight) continue
    // Distance from the page's own middle to the middle of the screen; a page
    // taller than the window scores by its nearest edge instead.
    const centre = (r.top + r.bottom) / 2
    const dist = r.top <= middle && r.bottom >= middle ? 0 : Math.abs(centre - middle)
    if (dist < bestDist) { bestDist = dist; best = page }
  }
  return best
}

let scrollFrame = 0
function onScroll() {
  if (scrollFrame) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    requestVisible()
    if (!continuous.value || scrollingToPage) return
    const page = pageInView()
    if (page !== docStore.currentPage) {
      // An open editor belongs to the page it was opened on; committing it
      // against another page is how an edit lands in the wrong place.
      syncingFromScroll = true
      docStore.setPage(page)
      syncingFromScroll = false
    }
  })
}

/** Bring a page to the top of the screen — for the thumbnails and the keyboard. */
function scrollToPage(page: number) {
  const el = wrappers.get(page)
  if (!el) return
  scrollingToPage = page
  el.scrollIntoView({ block: 'start', behavior: 'auto' })
  // The scroll settles over a frame or two; until it does, the handler above
  // would read the old position and set the page straight back.
  setTimeout(() => { if (scrollingToPage === page) scrollingToPage = 0 }, 250)
}

async function onTextChanged() {
  // After text is modified in the content stream:
  // 1. Save modified PDF from MuPDF
  // 2. Reload into PDF.js (without resetting page/state)
  // 3. Re-render to show changes
  // Serialized through the global op queue: another op landing between the
  // save and the reload would be applied to a document that is about to be
  // replaced (silently lost).
  await enqueueOp(async () => {
    try {
      const savedBytes = await pdfEngine.saveDocument()
      const bytes = new Uint8Array(savedBytes)
      // Reload PDF.js without resetting page/tool state
      await pdfViewer.reloadDocument(bytes)
      // Also reload into MuPDF with the saved bytes
      await pdfEngine.loadDocument(savedBytes)
      docStore.markModified()
      await repaintAll()
    } catch (err: any) {
      console.error('Failed to re-render after edit:', err)
      await repaintAll()
    }
  })
}

function onPageMouseDown(page: number) {
  // Clicking a page makes it the one being edited. Without this, a tool used on
  // a page the scroll detector has not caught up with would act on another one.
  if (page !== docStore.currentPage) {
    syncingFromScroll = true
    docStore.setPage(page)
    syncingFromScroll = false
  }
}

watch(() => docStore.currentPage, async (page) => {
  await nextTick()
  // A page reached by scrolling is already where it should be; one chosen from
  // the thumbnails or the keyboard has to be brought into view.
  if (continuous.value && !syncingFromScroll) scrollToPage(page)
  const size = sizes.value.get(page)
  if (size) { pageWidth.value = size.w; pageHeight.value = size.h }
  requestVisible()
})

watch(() => docStore.scale, repaintAll)
watch(() => docStore.renderVersion, repaintAll)
watch(() => docStore.totalPages, repaintAll)
watch(continuous, repaintAll)

watch(() => docStore.loaded, async (loaded) => {
  if (loaded) {
    painted.clear()
    renderQueue = []
    sizes.value = new Map()
    await nextTick()
    requestVisible()
  }
})

onMounted(() => {
  // Capture, so a scroll on any inner container is seen as well as the window's.
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
  if (docStore.loaded) requestVisible()
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onScroll)
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
})

defineExpose({ textBlockOverlayRef, annotationLayerRef })
</script>

<style scoped>
.pdf-viewer-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  background: #2a2a2a;
  padding: 20px 0;
}
.pdf-canvas {
  display: block;
}
/* Which page the tools are on is worth seeing — it is decided by the scroll,
   so without a mark there is nothing to tell you where an edit will land. */
.pdf-page-wrapper.current {
  outline: 2px solid rgba(66, 133, 244, 0.55);
  outline-offset: 2px;
}
.page-badge {
  position: absolute;
  left: 50%;
  bottom: -14px;
  transform: translateX(-50%);
  font-size: 11px;
  color: #9e9e9e;
  pointer-events: none;
}
</style>
