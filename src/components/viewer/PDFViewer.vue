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
          @band-selected="onBandSelected"
          @band-cleared="onBandCleared"
          @blocks-picked="onBlocksPicked"
        />
        <AnnotationLayer
          :ref="setAnnotLayer"
          :page-width="pageWidth"
          :page-height="pageHeight"
          :pdf-width="pdfPageWidth"
          :pdf-height="pdfPageHeight"
          @changed="onTextChanged"
          @object-picked="onObjectPicked"
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
 * The rubber band lives in the TEXT overlay (it owns the empty-paper surface),
 * but images and annotations live in the ANNOTATION layer. The two are
 * siblings, so the band is forwarded here — same wiring reason as
 * makeRoomInText, in the other direction.
 */
function onBandSelected(rect: [number, number, number, number], additive: boolean) {
  annotationLayerRef.value?.selectInBand?.(rect, additive)
}
function onBandCleared() {
  annotationLayerRef.value?.clearMultiSelection?.()
}

/**
 * One selection at a time across the two layers.
 *
 * In the edit tool both are live — a click on text edits the text, a click on a
 * picture picks the picture up — and each keeps its own selection. Whichever
 * takes the click clears the other's, or the page shows two selections wearing
 * handles and Delete has two answers to what it is about to remove.
 */
function onBlocksPicked() {
  annotationLayerRef.value?.clearObjectSelection?.()
}
function onObjectPicked() {
  textBlockOverlayRef.value?.clearSelection?.()
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

/**
 * Each page's size in PDF POINTS — scale divided out, and rotation already
 * applied by PDF.js's viewport.
 *
 * Kept separately from `sizes` (which is CSS pixels at whatever scale the page
 * was painted at) so that arriving on a page can hand the overlays a paper size
 * that does not depend on the zoom being unchanged since that page was drawn.
 */
const pdfSizes = ref(new Map<number, { w: number; h: number }>())

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

/**
 * How many times a page may fail to render before it is left alone.
 *
 * A render returns nothing when it was superseded or when the document was
 * reloaded under it — both of which happen in the ordinary course of editing,
 * and neither of which means the page cannot be drawn. Dropping it silently
 * left a page unpainted with nothing scheduled to try again.
 */
const MAX_RENDER_ATTEMPTS = 3
const attempts = new Map<number, number>()

async function pump() {
  if (renderBusy) return
  renderBusy = true
  try {
    while (renderQueue.length) {
      const page = renderQueue.shift()!
      const canvas = canvases.get(page)
      if (!canvas || painted.has(page)) continue
      const result = await pdfViewer.renderPage(canvas, page)
      if (!result) {
        const tried = (attempts.get(page) ?? 0) + 1
        attempts.set(page, tried)
        // Back of the queue, so the pages that CAN be drawn are not held up.
        if (tried < MAX_RENDER_ATTEMPTS) renderQueue.push(page)
        continue
      }
      attempts.delete(page)
      painted.add(page)
      // Replacing the Map is what makes Vue notice, and that re-runs every
      // page's style. Nearly every page in a document is the same size as the
      // last, so only a page that is actually a different size pays for it.
      const known = sizes.value.get(page)
      if (!known || Math.abs(known.w - result.width) > 0.5 || Math.abs(known.h - result.height) > 0.5) {
        const next = new Map(sizes.value)
        next.set(page, { w: result.width, h: result.height })
        sizes.value = next
      }
      if (page === 1) fallbackSize.value = { w: result.width, h: result.height }
      pdfSizes.value.set(page, {
        w: result.viewport.width / docStore.scale,
        h: result.viewport.height / docStore.scale
      })
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

/** The pages worth measuring: the current one and its neighbours. */
const NEIGHBOURHOOD = 6
function neighbourhood(): number[] {
  const first = Math.max(1, docStore.currentPage - NEIGHBOURHOOD)
  const last = Math.min(docStore.totalPages, docStore.currentPage + NEIGHBOURHOOD)
  const out: number[] = []
  for (let p = first; p <= last; p++) out.push(p)
  return out
}

/** Queue the current page first, then whatever is on or near the screen. */
async function requestVisible(): Promise<void> {
  if (!docStore.loaded) return
  const wanted = new Set<number>()
  // eslint-disable-next-line prefer-const
  if (pageList.value.includes(docStore.currentPage)) wanted.add(docStore.currentPage)

  // Only the pages AROUND the current one are measured. The current page
  // follows the scroll, so the window always contains the viewport, and the
  // work per frame stops depending on how long the document is — a scroll
  // handler that measures three hundred pages measures them every frame.
  const view = viewportBox()
  const viewH = view.height
  for (const page of neighbourhood()) {
    const el = wrappers.get(page)
    if (!el) continue
    const r = el.getBoundingClientRect()
    // One screen of margin either way, so scrolling meets painted pages.
    if (r.bottom > view.top - viewH && r.top < view.bottom + viewH) wanted.add(page)
  }
  for (const page of wanted) {
    if (!painted.has(page) && !renderQueue.includes(page)) renderQueue.push(page)
  }
  await pump()
}

/** Everything on screen is stale — the document or the scale changed. */
async function repaintAll() {
  painted.clear()
  attempts.clear()
  renderQueue = []
  await nextTick()
  await requestVisible()
}

/**
 * Repaint the pages an EDIT could have changed, and leave the rest alone.
 *
 * An edit rewrites one page's content stream. Every other page's pixels are
 * still correct, so clearing them all and re-rasterising whatever is on screen
 * is work with no result — and on a long document at a wide zoom, several
 * pages are on screen.
 *
 * The neighbours go too, because text pushed off the foot of a page is redrawn
 * on the next one, and an undo can put it back on the previous.
 */
async function repaintAround(page: number) {
  for (const p of [page - 1, page, page + 1]) { painted.delete(p); attempts.delete(p) }
  renderQueue = renderQueue.filter(p => p < page - 1 || p > page + 1)
  await nextTick()
  // AWAITED, so the queue slot this runs in is held until the page is actually
  // on screen. Returning early let the next operation reload the document
  // while the render was still going, which cancelled it.
  await requestVisible()
}

// ── Which page is being looked at ──
//
// The current page follows the scroll, which is what makes the editing tools
// appear on the page the reader is actually on without them having to click it.
let syncingFromScroll = false
/** Set while scrolling TO a page, so arriving does not re-decide where we are. */
let scrollingToPage = 0

/**
 * The box the pages are seen through.
 *
 * The viewer's own rectangle, not the window's: it sits under a header and
 * over a footer, and measuring against the window puts the middle of "the
 * screen" a good sixty pixels off — enough to hand the current page to the
 * wrong one when two meet near the centre.
 */
function viewportBox(): { top: number; bottom: number; height: number } {
  const el = containerRef.value
  if (!el) return { top: 0, bottom: window.innerHeight, height: window.innerHeight }
  const r = el.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, height: r.height || window.innerHeight }
}

function pageInView(): number {
  const near = scanForPage(neighbourhood())
  // Nothing nearby is on screen, so the scroll JUMPED — dragging the bar, or
  // landing from a link. The neighbourhood cannot walk to the new position on
  // its own: it is centred on the current page, and the current page is decided
  // by what is on screen, so each waits for the other and the panel sticks on
  // page 1 however far you scroll. One full scan re-anchors it, which costs
  // nothing because a jump is not something that happens every frame.
  return near ?? scanForPage(pageList.value) ?? docStore.currentPage
}

function scanForPage(pages: number[]): number | null {
  const view = viewportBox()
  const middle = (view.top + view.bottom) / 2
  let best: number | null = null
  let bestDist = Infinity
  for (const page of pages) {
    const el = wrappers.get(page)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.bottom < view.top || r.top > view.bottom) continue
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
    // The page first, then what to paint: the paint window is centred on the
    // current page, so asking in the other order paints where we just left.
    if (continuous.value && !scrollingToPage) {
      const page = pageInView()
      if (page !== docStore.currentPage) {
      // An open editor belongs to the page it was opened on; committing it
      // against another page is how an edit lands in the wrong place.
        syncingFromScroll = true
        docStore.setPage(page)
        syncingFromScroll = false
      }
    }
    requestVisible()
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
      await repaintAround(docStore.currentPage)
    } catch (err: any) {
      console.error('Failed to re-render after edit:', err)
      await repaintAround(docStore.currentPage)
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
  // BOTH geometries, or the overlays scale the new page's blocks by the old
  // page's paper. adoptCurrentGeometry only runs when a page is RENDERED, and
  // a page already painted is not re-rendered on arrival — so every overlay
  // kept the previous page's pdf dimensions. Nobody notices while a document
  // is one paper size; on a file whose page 1 is portrait 595x842 and page 2
  // landscape 842x595 the two are exactly swapped, and every clickable text
  // box on page 2 landed somewhere else (x scaled by 1263/595, y by 892/842).
  // Clicking a line opened the editor on a DIFFERENT line, which reads as
  // "I still can't edit this page" however well the engine matches.
  const size = sizes.value.get(page)
  if (size) { pageWidth.value = size.w; pageHeight.value = size.h }
  const pdfSize = pdfSizes.value.get(page)
  if (pdfSize) { pdfPageWidth.value = pdfSize.w; pdfPageHeight.value = pdfSize.h }
  requestVisible()
})

watch(() => docStore.scale, repaintAll)
// A version bump is nearly always one page being rewritten. Page inserts,
// deletions and reorders change the COUNT, and that watcher repaints the lot.
watch(() => docStore.renderVersion, () => repaintAround(docStore.currentPage))
watch(() => docStore.totalPages, repaintAll)
watch(continuous, repaintAll)

watch(() => docStore.loaded, async (loaded) => {
  if (loaded) {
    painted.clear()
    attempts.clear()
    renderQueue = []
    sizes.value = new Map()
    pdfSizes.value = new Map()
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
/*
  A flex item shrinks to fit by default, and the container is now a bounded
  height — so forty pages were squeezed into one screen's worth between them.
  The height set on each wrapper is the page's real size and must be kept.
*/
.pdf-page-wrapper {
  flex: 0 0 auto;
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
