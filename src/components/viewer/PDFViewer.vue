<template>
  <div
    ref="containerRef"
    class="pdf-viewer-container"
    :style="{ overflow: 'auto', width: '100%', height: '100%', overflowAnchor: 'none' }"
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
          @scan-clicked="onScanClicked"
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
          :ref="setOcrLayer"
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

/**
 * The text overlay crops the rendered page to show glyphs whose font cannot
 * name them. The canvases are owned here, one per page in continuous mode.
 */
provide('getPageCanvas', (page: number) => canvases.get(page))

const containerRef = ref<HTMLDivElement | null>(null)
const textBlockOverlayRef = ref<InstanceType<typeof TextBlockOverlay> | null>(null)
const annotationLayerRef = ref<InstanceType<typeof AnnotationLayer> | null>(null)
const ocrLayerRef = ref<InstanceType<typeof OcrTextLayer> | null>(null)
const ocrController = inject<{ recognise: (pageIndex: number) => Promise<void> } | null>('ocrController', null)

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
function setOcrLayer(el: any) {
  ocrLayerRef.value = el || null
}

/**
 * A click on an unrecognised scan, in the edit tool: recognise the page and
 * open the run under the click, as Acrobat does. The text overlay asks (it
 * owns the empty-paper surface), the layout recognises, the OCR layer edits —
 * three siblings, so the hand-off lives here.
 */
async function onScanClicked(x: number, y: number) {
  if (!ocrController) return
  const pageIndex = docStore.currentPage - 1
  await ocrController.recognise(pageIndex)
  if (docStore.currentPage - 1 !== pageIndex) return
  await nextTick()
  ocrLayerRef.value?.editAt?.(x, y)
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
 * Each page's size in PDF POINTS — rotation applied, as pdf.js's viewport
 * applies it — and the slot every page occupies is that size times the zoom.
 *
 * The slots used to be kept in CSS PIXELS at whatever zoom each page happened
 * to be painted at, with page 1's size standing in for every page not painted
 * yet. Both moved the page being read. A page painted before a zoom kept its
 * old size until it was painted again, and an unpainted A4 or landscape page
 * in a Letter document changed size the moment it was drawn — each time ABOVE
 * the reader, so the view slid and the scroll detector handed the tools to the
 * page before (the YOFC compilation: Letter, A4, landscape and a 3931pt CAD
 * sheet, where an OCR click on page 5 came back to page 4). Now every page is
 * measured in the background once the document is open (`measurePages`, a
 * `getPage` each, well under a second for 260 pages), slots follow the zoom
 * all together, and what the reader is looking at is held in place whenever
 * sizes change (`holdView`).
 */
const pdfSizes = ref(new Map<number, { w: number; h: number }>())
const fallbackPt = ref({ w: 612, h: 792 })

function pointsOf(page: number): { w: number; h: number } {
  return pdfSizes.value.get(page) ?? fallbackPt.value
}

function sizeOf(page: number): { w: number; h: number } {
  const pt = pointsOf(page)
  return { w: pt.w * docStore.scale, h: pt.h * docStore.scale }
}

/**
 * Change page sizes without moving what is on screen.
 *
 * The current page is the anchor: the share of it scrolled past the top of
 * the viewer is the same before and after, so a size correction above it
 * leaves the view where it was and a zoom keeps the same line at the top. The
 * browser's own scroll anchoring is switched off on the container so the two
 * do not both correct the same change.
 */
async function holdView(change: () => void | Promise<void>) {
  const el = containerRef.value
  const page = docStore.currentPage
  const wrapper = wrappers.get(page)
  let share: number | null = null
  if (el && wrapper && continuous.value) {
    const v = el.getBoundingClientRect(), r = wrapper.getBoundingClientRect()
    share = (v.top - r.top) / Math.max(1, r.height)
  }
  await change()
  await nextTick()
  const after = wrappers.get(page)
  if (share === null || !el || !after || docStore.currentPage !== page) return
  const v = el.getBoundingClientRect(), r = after.getBoundingClientRect()
  const delta = r.top + share * r.height - v.top
  if (Math.abs(delta) > 0.5) {
    // The scroll this causes must not re-decide the page: it is the same view.
    scrollingToPage = page
    el.scrollTop += delta
    setTimeout(() => { if (scrollingToPage === page) scrollingToPage = 0 }, 250)
  }
}

/** Measure every page of the document as it is now, and lay them out at their real sizes. */
let measureGen = 0
async function measureAll() {
  const gen = ++measureGen
  const measured = await pdfViewer.measurePages()
  if (!measured || gen !== measureGen) return
  const first = measured.get(1)
  await holdView(() => {
    pdfSizes.value = new Map([...pdfSizes.value, ...measured])
    if (first) fallbackPt.value = first
  })
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
      // page's style. A measured page is already the size it paints at, so
      // only a page that was still a guess (or that a rotation changed) pays
      // for it — and the view is held while it does.
      const pt = { w: result.viewport.width / docStore.scale, h: result.viewport.height / docStore.scale }
      const known = pdfSizes.value.get(page)
      if (!known || Math.abs(known.w - pt.w) > 0.25 || Math.abs(known.h - pt.h) > 0.25) {
        await holdView(() => {
          const next = new Map(pdfSizes.value)
          next.set(page, pt)
          pdfSizes.value = next
          if (page === 1) fallbackPt.value = pt
        })
      }
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
/**
 * The page the scroll (or a click on it) just made current, so the watcher
 * does not scroll to a page that is already in view. It names the page rather
 * than being a flag set and cleared around `setPage`: the watcher runs a flush
 * later, by when such a flag is always false again — every page reached by
 * scrolling was then "scrolled to", its top snapped to the top of the view
 * half a screen early, and pressing the mouse on a page not current yet pulled
 * that page up under the pointer before the button came back up.
 */
let arrivedInView = 0
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
        arrivedInView = page
        docStore.setPage(page)
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
    arrivedInView = page
    docStore.setPage(page)
  }
}

watch(() => docStore.currentPage, async (page) => {
  const inView = arrivedInView === page
  arrivedInView = 0
  await nextTick()
  // A page reached by scrolling is already where it should be; one chosen from
  // the thumbnails or the keyboard has to be brought into view.
  if (continuous.value && !inView) scrollToPage(page)
  // BOTH geometries, or the overlays scale the new page's blocks by the old
  // page's paper. adoptCurrentGeometry only runs when a page is RENDERED, and
  // a page already painted is not re-rendered on arrival — so every overlay
  // kept the previous page's pdf dimensions. Nobody notices while a document
  // is one paper size; on a file whose page 1 is portrait 595x842 and page 2
  // landscape 842x595 the two are exactly swapped, and every clickable text
  // box on page 2 landed somewhere else (x scaled by 1263/595, y by 892/842).
  // Clicking a line opened the editor on a DIFFERENT line, which reads as
  // "I still can't edit this page" however well the engine matches.
  const pdfSize = pdfSizes.value.get(page)
  if (pdfSize) {
    pdfPageWidth.value = pdfSize.w; pdfPageHeight.value = pdfSize.h
    pageWidth.value = pdfSize.w * docStore.scale; pageHeight.value = pdfSize.h * docStore.scale
  }
  requestVisible()
})

// Every slot follows the zoom at once (they are points times the scale), so
// the line at the top of the view is held there while the pages resize.
watch(() => docStore.scale, () => holdView(() => {
  const pt = pdfSizes.value.get(docStore.currentPage)
  if (pt) { pageWidth.value = pt.w * docStore.scale; pageHeight.value = pt.h * docStore.scale }
}).then(repaintAll))
// A version bump is nearly always one page being rewritten. Page inserts,
// deletions and reorders change the COUNT, and that watcher repaints the lot.
watch(() => docStore.renderVersion, () => repaintAround(docStore.currentPage))
watch(() => docStore.totalPages, () => { void repaintAll(); void measureAll() })
watch(continuous, repaintAll)

// A document OPENED — the first, or another over it. Nothing known about the
// previous one's pages (sizes, what each canvas holds) describes this one.
watch(() => docStore.openCount, async () => {
  if (!docStore.loaded) return
  painted.clear()
  attempts.clear()
  renderQueue = []
  pdfSizes.value = new Map()
  fallbackPt.value = { w: 612, h: 792 }
  measureGen++
  await nextTick()
  // Not chained behind the paint: a page pdf.js draws slowly (a heavy scan,
  // or any page while the window is covered and animation frames stall)
  // would hold every slot at the guessed size for as long as it takes.
  void requestVisible()
  void measureAll()
})

onMounted(() => {
  // Capture, so a scroll on any inner container is seen as well as the window's.
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
  // The viewer is created BY the first document's opening, after the
  // `openCount` bump its watcher would have answered — so it measures here.
  if (docStore.loaded) { void requestVisible(); void measureAll() }
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onScroll)
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
})

defineExpose({ textBlockOverlayRef, annotationLayerRef })
</script>

<style scoped>
/*
  Pages are centred by their own auto margins, not by `align-items: center`.
  A centred flex item WIDER than the column overflows on both sides, and the
  left overflow can never be scrolled to: the YOFC compilation's 3931pt CAD
  sheet showed its middle and right only. Auto margins centre what fits and
  fall to zero for what does not, so a wide page starts at the left edge.
*/
.pdf-viewer-container {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
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
