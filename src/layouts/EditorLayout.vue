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
      <!--
        Inside the header, not the page container: the header is the only
        element in the layout that is guaranteed to sit above the page, and
        anchoring to it means the bar follows the toolbar down when the
        context-sensitive properties row appears instead of needing a height
        hardcoded here and kept in sync by hand.
      -->
      <FindBar />
    </q-header>

    <!-- Left Sidebar: Page Thumbnails -->
    <q-drawer v-model="sidebarOpen" side="left" :width="200" bordered class="bg-grey-10">
      <PageThumbnails />
    </q-drawer>

    <!-- Right Sidebar: the editing assistant (chat) -->
    <q-drawer v-model="editorStore.assistantOpen" side="right" :width="380" bordered class="bg-grey-10">
      <AssistantPanel />
    </q-drawer>

    <!-- Main Content -->
    <q-page-container>
      <router-view />
    </q-page-container>

    <!--
      Permanent file inputs, rendered by Vue and living for the whole session.

      They replace inputs that were created, appended and removed on every
      click. That worked in every test here and still failed for the user, and
      the created-per-click design is the part with failure modes that cannot be
      ruled out from the outside: an element that has just been inserted, a
      listener whose only reference is the closure that made it, and one orphan
      left behind per cancelled dialog. A permanent element has none of them —
      it is in the document before any click, it survives hot reloads, and its
      handler is bound by the framework, not by hand.
    -->
    <input
      id="app-open-pdf"
      ref="openInputRef"
      type="file"
      accept="application/pdf,.pdf"
      class="offscreen-file-input"
      @change="onOpenPicked"
    />
    <input
      id="app-merge-pdf"
      ref="mergeInputRef"
      type="file"
      accept="application/pdf,.pdf"
      class="offscreen-file-input"
      @change="onMergePicked"
    />

    <!-- Footer: Status Bar -->
    <q-footer class="bg-grey-10 q-px-md" style="height: 28px">
      <StatusBar />
    </q-footer>
  </q-layout>
</template>

<script setup lang="ts">
import { ref, provide, watch, onMounted, onUnmounted } from 'vue'
import { useQuasar } from 'quasar'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import { useSearchStore } from '@/stores/search'
import { useOcrStore } from '@/stores/ocr'
import { useOCR, OCR_DEFAULT_LANG } from '@/composables/useOCR'

import { ENGINE_LABELS } from '@/utils/ocr/ocrEngine'
import { styleKeyOf } from '@/utils/ocr/scanFace'

/** OCR reads the page at 220 DPI; PDF user space is 72 to the inch. */
const OCR_RENDER_SCALE = 220 / 72
/** The user said yes to sending a page image to the cloud, this session. */
let cloudConsentGiven = false
import { planOcrExport, base14 } from '@/utils/ocr/ocrExport'
import { stretchOf, sizeOf, weightPlan } from '@/utils/ocr/partialRedraw'
import { cropToPng } from '@/utils/ocr/pixelCrop'
import { measureHalo } from '@/utils/ocr/ocrSampling'
import { detectFace } from '@/utils/ocr/ocrFontDetect'
import type { OcrTextItem } from '@/utils/ocr/ocrTypes'
import { snapItemsToTextLayer, dropRunsOnVisibleText } from '@/utils/ocr/snapToLayer'
import type { RecognizeDocumentOptions, RecognizeProgress } from '@/components/dialogs/OcrRecognizeDialog.vue'
import { usePDFViewer } from '@/composables/usePDFViewer'
import { usePDFEngine } from '@/composables/usePDFEngine'
import { getMuPDFBridge } from '@/engine/bridge'
import { enqueueOp, settleTransactions, transactionOpen, beginTransaction } from '@/utils/opQueue'
import MainToolbar from '@/components/toolbar/MainToolbar.vue'
import PageThumbnails from '@/components/sidebar/PageThumbnails.vue'
import StatusBar from '@/components/common/StatusBar.vue'
import FindBar from '@/components/toolbar/FindBar.vue'
import AssistantPanel from '@/components/assistant/AssistantPanel.vue'
import { createAssistant } from '@/composables/useAssistant'

const $q = useQuasar()
const docStore = useDocumentStore()
const editorStore = useEditorStore()
const historyStore = useHistoryStore()
const searchStore = useSearchStore()
const ocrStore = useOcrStore()
const ocr = useOCR()
const pdfViewer = usePDFViewer()
const pdfEngine = usePDFEngine()
const sidebarOpen = ref(true)

// Provide composables to the whole tree (header, drawer, page)
provide('pdfViewer', pdfViewer)
provide('pdfEngine', pdfEngine)
;(window as any).__pdfEngine = pdfEngine
;(window as any).__pdfViewer = pdfViewer
// A crashed engine worker is respawned by the bridge with the document it
// had; the user still deserves to know, and to know the unsaved edits made
// since the last save→reload are in the document the bridge reloaded.
getMuPDFBridge().onCrash = (reason: string) => {
  editorStore.setStatus(`The PDF engine stopped (${reason}) and was restarted — check the last edit`)
}

function handleBeforeUnload(e: BeforeUnloadEvent) {
  // The test drivers (public/_sweep) set this: the prompt otherwise blocks
  // every automation call after a hot reload of an edited document.
  if (import.meta.env.DEV && (window as any).__noUnloadPrompt) return
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
  printCleanup?.()
  pdfEngine.destroyEngine()
  document.removeEventListener('keydown', handleKeyDown)
  document.body.removeEventListener('dragover', handleDragOver)
  document.body.removeEventListener('drop', handleDrop)
  window.removeEventListener('beforeunload', handleBeforeUnload)
})

// ===== SCANNED PAGES (OCR) =====
/**
 * Recognise the text on the page being viewed.
 *
 * Reads the page the viewer has ALREADY rendered rather than rasterising it
 * again: that canvas is the same pixels the user is looking at, so the boxes
 * that come back line up with what they see.
 *
 * Nothing is written to the document. Recognition is a guess, and a guess must
 * not rewrite anyone's file just by being made — only the runs the user then
 * edits are ever drawn, and only at export.
 */
async function runOcrOnPage(lang = OCR_DEFAULT_LANG) {
  if (!docStore.loaded || ocr.busy.value) return
  const pageIndex = docStore.currentPage - 1

  // Say plainly when the page does not need this.
  const layer = await textLayerOf(pageIndex)
  const verdict = ocr.judgeScanned(layer.chars, layer.coverage)
  if (!verdict.scanned) {
    $q.dialog({
      title: 'This page already has text',
      message: `${verdict.reason}. Running OCR would add a second, guessed copy on top of it. Recognise it anyway?`,
      cancel: true, persistent: true, dark: true
    }).onOk(() => runOcrNow(pageIndex, lang))
    return
  }
  await runOcrNow(pageIndex, lang)
}

/**
 * Is this page a picture of a document?
 *
 * Two things have to hold: the page's own text layer is (as good as) absent,
 * and something is actually drawn — an image covering at least half the paper.
 * A blank page has no text either and recognising it is a wasted five seconds.
 * The verdict is cached per page; it cannot change until the document does,
 * and the store's `clear()` on a new file drops the cache with the results.
 */
/**
 * The page's own text layer: how many characters, and how much of the paper
 * they cover. Coverage is the share of a coarse grid the text blocks touch —
 * a union, so a stamp drawn 34 times over itself counts once — because the
 * character count alone cannot tell a text page from a scan carrying a
 * signing service's ID strip (see `judgeScanned`). An unreadable layer
 * counts as none.
 */
async function textLayerOf(pageIndex: number): Promise<{ chars: number; coverage: number }> {
  try {
    // A searchable OCR layer (Acrobat's "Reconocer texto", or this editor's
    // own) is text drawn INVISIBLY over a scan: it is not the page's own text
    // and must not make the page count as a text page — the words the user
    // sees are the scan's pixels, and only the OCR flow can change those.
    const blocks = (await pdfEngine.getTextBlocks(pageIndex)).filter(b => !b.invisible)
    const chars = blocks.reduce((n, b) => n + b.text.trim().length, 0)
    const size = await pdfEngine.getPageSize(pageIndex)
    const G = 64
    const grid = new Uint8Array(G * G)
    for (const b of blocks) {
      if (!b.text.trim()) continue
      const x0 = Math.max(0, Math.floor(Math.min(b.bbox[0], b.bbox[2]) / size.width * G))
      const x1 = Math.min(G - 1, Math.floor(Math.max(b.bbox[0], b.bbox[2]) / size.width * G))
      const y0 = Math.max(0, Math.floor(Math.min(b.bbox[1], b.bbox[3]) / size.height * G))
      const y1 = Math.min(G - 1, Math.floor(Math.max(b.bbox[1], b.bbox[3]) / size.height * G))
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y * G + x] = 1
    }
    let touched = 0
    for (const v of grid) touched += v
    return { chars, coverage: touched / (G * G) }
  } catch (_) { return { chars: 0, coverage: 0 } }
}

async function isScanLikePage(pageIndex: number): Promise<boolean> {
  const cached = ocrStore.scanVerdicts.get(pageIndex)
  if (cached !== undefined) return cached
  let verdict = false
  try {
    const layer = await textLayerOf(pageIndex)
    if (ocr.judgeScanned(layer.chars, layer.coverage).scanned) {
      const size = await pdfEngine.getPageSize(pageIndex)
      const paper = Math.max(1, size.width * size.height)
      // Summed, not "any one image": the supplier survey is one scan TILED
      // into nine images of a ninth of the page each, and no single tile
      // covers half of anything. Each tile is clipped to the paper first so an
      // image hanging off the edge cannot count for more than it shows.
      const images = await pdfEngine.listContentImages(pageIndex)
      let covered = 0
      for (const img of images) {
        const x0 = Math.max(0, Math.min(img.rect[0], img.rect[2]))
        const x1 = Math.min(size.width, Math.max(img.rect[0], img.rect[2]))
        const y0 = Math.max(0, Math.min(img.rect[1], img.rect[3]))
        const y1 = Math.min(size.height, Math.max(img.rect[1], img.rect[3]))
        if (x1 > x0 && y1 > y0) covered += (x1 - x0) * (y1 - y0)
      }
      verdict = covered >= paper * 0.5
    }
  } catch (_) { verdict = false }
  ocrStore.scanVerdicts.set(pageIndex, verdict)
  return verdict
}

/**
 * OCR results and scan verdicts are keyed by PAGE INDEX and measured on a
 * page's geometry. A page inserted, deleted, moved, duplicated, merged or
 * rotated makes every index and every box after it a lie — boxes would sit
 * on the wrong page. They are dropped; recognising again costs seconds,
 * editing the wrong page costs a document. Unbaked edits go with them, so
 * the status says so when there were any.
 */
function forgetOcr() {
  // Edits the live bake has applied are in the document already; only the
  // ones still pending are lost.
  const hadEdits = pagesNeedingLive().length > 0
  ocrStore.clear()
  ocr.reset()
  livePages.clear()
  if (hadEdits) editorStore.setStatus('Page structure changed — unsaved OCR edits were discarded; recognise the page again')
}

/**
 * What the editing layers need in order to recognise a scan on a click:
 * the verdict, the runner (no "already has text" dialog — the caller has
 * proved the page is a scan) and whether one is already running.
 */
/**
 * The page's scan moved or changed under its recognised runs.
 *
 * A page-covering image dragged in the select tool takes its words with it:
 * the runs are shifted by the same delta (their glyph cuts and the tracing
 * raster are measured on the page and are dropped, to be made again on the
 * next edit). Any other change to that image — resize, crop, a turn, a
 * deletion — leaves nothing for the runs to describe, so the page's results
 * go, and the status says so when unbaked edits went with them. Before this,
 * a scan nudged by a few pixels kept its runs where they were, and every
 * edited line was then patched and redrawn BESIDE its photographed words:
 * the page showed each of them twice.
 */
function ocrScanMoved(pageIndex: number, dx: number, dy: number) {
  if (!ocrStore.resultFor(pageIndex)) return
  ocrStore.shiftPage(pageIndex, dx, dy)
  ocr.forgetTraceRaster(pageIndex)
  for (const item of ocrStore.itemsFor(pageIndex)) ocr.forgetSpanCut(item.id)
}
function ocrScanChanged(pageIndex: number) {
  const hadEdits = ocrStore.clearPage(pageIndex)
  ocr.forgetTraceRaster(pageIndex)
  if (hadEdits) editorStore.setStatus('The scan changed — unsaved OCR edits on this page were discarded; recognise it again')
}

provide('ocrController', {
  isScanLike: isScanLikePage,
  // The assistant reads runs by their text: it waits for the re-read to settle.
  recognise: async (pageIndex: number) => { await runOcrNow(pageIndex, OCR_DEFAULT_LANG); await ocr.settleRepairs() },
  busy: ocr.busy,
  scanMoved: ocrScanMoved,
  scanChanged: ocrScanChanged
})

async function runOcrNow(pageIndex: number, lang: string) {
  editorStore.setStatus('Recognising text on this page...')

  // OCR reads its own render of THIS page at its own resolution. The visible
  // canvas will not do: in continuous scroll the first `canvas.pdf-canvas` in
  // the document is page 1's whatever page is current, and page 2's OCR came
  // back reading page 1.
  // MuPDF first: pdf.js took over 90 s on one page of a fax-encoded scan
  // (CCITT images through iLovePDF/PDF24) where MuPDF takes 32 ms, and the
  // button appeared to do nothing. pdf.js stays as the fallback.
  const canvas = await renderForOcr(pageIndex, OCR_RENDER_SCALE)
  if (!canvas) { editorStore.setStatus('The page could not be rendered for recognition'); return }
  // The page's size is the RENDER's whenever the engine cannot say, or says
  // something of another shape. It used to fall back to a Letter page: an A4
  // scan recognised while the worker was busy was stretched into a Letter-
  // shaped raster, and every box came back at 0.94 of its height down the
  // page — a box a whole table row above its text, and an edit planned on
  // the row above.
  const rendered = { width: canvas.width / OCR_RENDER_SCALE, height: canvas.height / OCR_RENDER_SCALE, rotation: 0 }
  let size = await pdfEngine.getPageSize(pageIndex).catch(() => null)
  if (!size || Math.abs(size.width / size.height - rendered.width / rendered.height) > 0.005) size = rendered

  // Progress in the status bar: a page of Chinese and Spanish takes long
  // enough that silence reads as a hang.
  const stopProgress = watch([ocr.stage, ocr.progress], ([stage, pct]) => {
    if (!ocr.busy.value) return
    const label = stage === 'recognizing text' || stage === 'Recognising text...'
      ? `Recognising text on this page... ${pct}%`
      : stage ? `${stage[0].toUpperCase()}${stage.slice(1)}` : 'Recognising text on this page...'
    editorStore.setStatus(label)
  })
  // The engine the user chose. A cloud engine sends the page image away, so
  // it needs a key and, once per session, an explicit yes.
  const engineId = editorStore.ocrEngine
  if (engineId === 'mistral') {
    const mistral = ocr.engineFor('mistral') as any
    mistral.apiKey = editorStore.mistralApiKey
    if (!editorStore.mistralApiKey) {
      stopProgress()
      editorStore.setStatus('Mistral OCR needs an API key — open OCR settings from the OCR menu')
      return
    }
    if (!cloudConsentGiven) {
      const ok = await new Promise<boolean>(resolve => {
        $q.dialog({
          title: 'Send this page to Mistral?',
          message: 'The page image will be uploaded to Mistral\'s OCR service to be read. Nothing is sent for any other engine.',
          ok: 'Send', cancel: true, persistent: true, dark: true
        }).onOk(() => resolve(true)).onCancel(() => resolve(false)).onDismiss(() => resolve(false))
      })
      if (!ok) { stopProgress(); editorStore.setStatus('Cloud recognition cancelled'); return }
      cloudConsentGiven = true
    }
  }

  let result: Awaited<ReturnType<typeof ocr.recognizePage>> = null
  let textLines = 0
  try {
    result = await ocr.recognizePage(canvas, pageIndex, size.width, size.height, lang, true, engineId)
    // The page's own text layer (Acrobat's, or this editor's bake) knows
    // where the word gaps are; the recogniser only guesses, and on bold
    // capitals it guessed "CONTRATODEOBRAMAESTRA". Where the two agree letter
    // for letter, the run takes the layer's spacing.
    if (result && result.items.length) {
      const blocks = await pdfEngine.getTextBlocks(pageIndex).catch(() => [])
      result = { ...result, items: snapItemsToTextLayer(result.items, blocks).items }
      // Lines the page draws as real text (a translation banner over a scan)
      // stay with the text tool: edited as OCR runs they were redrawn as scan
      // pixels over text that was never in the scan.
      const kept = dropRunsOnVisibleText(result.items, blocks)
      if (kept.dropped) {
        result = { ...result, items: kept.items }
        textLines = kept.dropped
      }
    }
  } finally {
    stopProgress()
  }
  if (!result) {
    editorStore.setStatus(`OCR failed: ${ocr.error.value || 'unknown error'}`)
    return
  }
  ocrStore.setResult(result)
  const sideways = result.verticalCount
    ? `, ${result.verticalCount} of them sideways`
    : ''
  const by = result.engine ? ` by ${ENGINE_LABELS[result.engine]}` : ''
  const note = result.fallbackNote ? ` (${result.fallbackNote})` : ''
  editorStore.setStatus(result.items.length === 0
    ? `No text was recognised on this page${by}${note}`
    : `${result.items.length} text areas detected${by}${sideways} — ${result.confidence}% average confidence${note}${textLines ? `; ${textLines} line${textLines > 1 ? 's are' : ' is'} real text, edited with the text tool` : ''}. Click one to select it, click again to edit, drag to move.`)
  // The runs re-read from the page's own letters, in the background, so the
  // editor opens on what the page says (see `repairReadings`). Whatever reads
  // the runs by their text waits for it (`ocr.settleRepairs`).
  if (result.items.length) {
    const said = editorStore.statusMessage
    void ocr.repairReadings(pageIndex).then(n => {
      if (!n) return
      // The bytes did not change, so the state they match now carries the new
      // readings — or an undo would hand the old, garbled ones back. Not while
      // an edit is still waiting for its bake: the bytes do not match that yet.
      if (!pagesNeedingLive().length) appliedMeta = captureOcrMeta()
      if (editorStore.statusMessage === said) {
        editorStore.setStatus(`${said} ${n} misread line${n > 1 ? 's were' : ' was'} read again from the page's own letters.`)
      }
    }).catch(() => {})
  }
}

/**
 * Write the edited OCR runs into the document.
 *
 * Run just before saving, so what is exported matches what is on screen. Each
 * edited area becomes a filled rectangle in the colour of its surrounding paper
 * plus the new text on top; everything else on the page is left completely
 * alone, which is what preserves the scan.
 */
// ===== LIVE OCR BAKE =====
/**
 * A scanned page's edits are APPLIED as they are committed, the way Acrobat
 * does it, so what is on screen is the file.
 *
 * Until now an edited run was shown as a stand-in the layer drew over a paper
 * patch — the WHOLE line retyped from the recogniser's reading — and only the
 * save baked it. The bake is the faithful one (only the changed letters
 * redrawn, the rest the scan's own pixels); the stand-in showed every OCR
 * misreading the user never touched ("MARIAcon RUCN"), and a line whose cut
 * refused as big grey Helvetica off the edge of the page. The user judged the
 * edit by the stand-in.
 *
 * Baking on commit alone would lose the second edit of a line: a baked run's
 * glyph cut is gone and its "original" is the first edit. So each page keeps
 * its PRISTINE content — the scan as recognised — and every live bake restores
 * it and re-applies ALL of the page's edits, each still measured against its
 * original ink. The bake's objects from the previous pass are pruned from the
 * page's resources on the way (`setPageContent` with `keep`).
 *
 * The page's content hash after each live bake is remembered; content that
 * no longer matches means something else wrote to the page (a searchable
 * layer, a text edit, an image behind), and the page is ADOPTED: its applied
 * runs are finalised the old way and the current content is the new pristine.
 */
interface LivePage { pristine: { bytes: Uint8Array; xobjects: string[]; fonts: string[] }; pristineHash: number; hash: number }
const livePages = new Map<number, LivePage>()
let liveChain: Promise<void> = Promise.resolve()
let liveTimer: ReturnType<typeof setTimeout> | null = null
let liveSuppressed = false
/** The OCR state that matches the document's bytes — what an undo point before a live bake has to restore. */
let appliedMeta: OcrUndoMeta | null = null

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0 }
  return (h ^ bytes.length) >>> 0
}

/** Pages whose edits are not on the page yet, or that must go back to the scan (every edit reverted). */
function pagesNeedingLive(): number[] {
  const out: number[] = []
  for (const [pageIndex, page] of ocrStore.pages) {
    const pending = page.items.some(i => (i.edited || i.removed) && !i.applied && !i.baked)
    const st = livePages.get(pageIndex)
    const reverted = !!st && st.hash !== st.pristineHash && !page.items.some(i => (i.edited || i.removed) && !i.baked)
    if (pending || reverted) out.push(pageIndex)
  }
  return out
}

function scheduleLive() {
  if (liveTimer) clearTimeout(liveTimer)
  liveTimer = setTimeout(() => {
    liveTimer = null
    if (liveSuppressed || !docStore.loaded) return
    for (const p of pagesNeedingLive()) void applyOcrLive(p)
  }, 300)
}
watch(() => ocrStore.pages, () => { if (!liveSuppressed && pagesNeedingLive().length) scheduleLive() })
// A fresh recognition describes the page as it is NOW (edits included), so
// its pristine is gone; and the state it leaves is one the bytes agree with.
ocrStore.$onAction(({ name, args, after }) => {
  if (name === 'setResult') after(() => { livePages.delete((args[0] as any)?.pageIndex); appliedMeta = captureOcrMeta() })
  if (name === 'clearPage') after(() => { livePages.delete(args[0] as number) })
})

/** Apply a page's OCR edits to the document now. Serialised: one live bake at a time. */
function applyOcrLive(pageIndex: number): Promise<void> {
  const run = liveChain
    .then(() => applyOcrLiveNow(pageIndex))
    .catch(err => {
      console.warn('[OCR] live bake failed:', err)
      editorStore.setStatus(`The edit could not be applied to the page: ${err?.message ?? err}`)
    })
  liveChain = run
  return run
}

async function applyOcrLiveNow(pageIndex: number) {
  if (!docStore.loaded || !pagesNeedingLive().includes(pageIndex)) return
  const end = beginTransaction()
  const t0 = performance.now()
  try {
    editorStore.setStatus('Applying edit...')
    await ocr.settleTraces()
    const tTraces = performance.now()
    // One undo point per live bake, carrying the OCR state the CURRENT bytes
    // match — not the store as it is now, which already holds the new edit.
    if (docStore.pdfBytes) {
      const snap = new Uint8Array(docStore.pdfBytes)
      undoMeta.set(snap, appliedMeta ?? captureOcrMeta())
      historyStore.pushSnapshot(snap)
    }
    let st = livePages.get(pageIndex)
    const cur = await enqueueOp(() => pdfEngine.getPageContent(pageIndex))
    if (st && fnv1a(cur.bytes) !== st.hash) { adoptLivePage(pageIndex); st = undefined }
    if (!st) {
      const h = fnv1a(cur.bytes)
      st = { pristine: cur, pristineHash: h, hash: h }
      livePages.set(pageIndex, st)
    } else {
      const p = st.pristine
      await enqueueOp(() => pdfEngine.setPageContent(pageIndex, p.bytes, { xobjects: p.xobjects, fonts: p.fonts }))
    }
    const edits = ocrStore.itemsFor(pageIndex).some(i => (i.edited || i.removed) && !i.baked)
    if (edits) await bakeOcrEdits({ live: true, pages: [pageIndex] })
    else { docStore.markModified(); await syncAfterEdit() }
    const after = await enqueueOp(() => pdfEngine.getPageContent(pageIndex))
    st.hash = fnv1a(after.bytes)
    appliedMeta = captureOcrMeta()
    if (import.meta.env.DEV) ((window as any).__liveBakeTimes ??= []).push({ page: pageIndex, traces: Math.round(tTraces - t0), total: Math.round(performance.now() - t0) })
    editorStore.setStatus(edits ? 'Edit applied to the page' : 'Page restored to the scan')
  } finally {
    end()
  }
}

/** Something else wrote to the page: its applied runs become part of it (the pre-live behaviour), and the page as it is becomes the new pristine. */
function adoptLivePage(pageIndex: number) {
  for (const item of ocrStore.itemsFor(pageIndex)) {
    if (!item.applied || !(item.edited || item.removed)) continue
    ocrStore.updateItem(item.id, { baked: true, edited: false, removed: false, restyled: false, originalText: item.text, applied: true })
    ocr.forgetSpanCut(item.id)
  }
  ocr.forgetTraceRaster(pageIndex)
  livePages.delete(pageIndex)
}

/**
 * The page as the SCAN has it, for tracing: a page with live edits is
 * swapped back to its pristine content for the render and put back after,
 * in one queued step. The 440 DPI tracing raster read from the edited page
 * would trace the edits' own glyphs as the scan's.
 */
async function renderPristine(pageIndex: number, scale: number): Promise<HTMLCanvasElement | null> {
  const st = livePages.get(pageIndex)
  if (!st || st.hash === st.pristineHash) return renderForOcr(pageIndex, scale)
  let canvas: HTMLCanvasElement | null = null
  await enqueueOp(async () => {
    const cur = await pdfEngine.getPageContent(pageIndex)
    await pdfEngine.setPageContent(pageIndex, st.pristine.bytes)
    try { canvas = await pdfEngine.renderPageBitmap(pageIndex, scale).catch(() => null) }
    finally { await pdfEngine.setPageContent(pageIndex, cur.bytes) }
  })
  return canvas
}

async function bakeOcrEdits(opts: { live?: boolean; pages?: number[] } = {}): Promise<number> {
  // Outside a live bake (save, print, the assistant) every edit is normally
  // on the page already: the live bake applies each one as it is committed.
  // What is still pending — an edit a second old — is applied the same way.
  if (!opts.live) {
    await liveChain
    let n = 0
    for (const pageIndex of pagesNeedingLive()) { await applyOcrLive(pageIndex); n++ }
    return n
  }
  if (!ocrStore.hasEdits) return 0
  // The trace an edit started may still be running (a save a second after the
  // edit): consulting the faces before it finishes bakes the run in Helvetica.
  const settled = ocr.settleTraces()
  const slow = setTimeout(() => editorStore.setStatus("Finishing the scan's letterforms..."), 800)
  try { await settled } finally { clearTimeout(slow) }
  // The bake is an edit of the document like any other and gets its own undo
  // point. It had none: Ctrl+Z after a save that baked a scanned page's edits
  // either did nothing or — with an earlier text edit on the stack — jumped
  // PAST the bake to that edit's snapshot, taking both away in one press.
  // `docStore.pdfBytes` is still the pre-bake document here (it is only
  // replaced by `syncAfterEdit` at the end), so one snapshot covers every
  // page baked in this pass. A live bake pushed its own before restoring.
  if (!opts.live) pushUndo()
  let written = 0
  /** Per page, per edited item: how it was drawn — for the sweep (`window.__ocrBakeReport`). */
  const modes: Record<number, Record<string, string>> = {}
  /** Per page, per item: the union of the patches painted for it — what its ink box becomes after the bake. */
  const grownByPage = new Map<number, Map<string, [number, number, number, number]>>()

  /** Per page, the item objects the plan was made from: a run the user changed DURING the bake is not marked applied. */
  const plannedByPage = new Map<number, Set<OcrTextItem>>()
  for (const [pageIndex, page] of ocrStore.pages) {
    if (opts.pages && !opts.pages.includes(pageIndex)) continue
    // The page's traced scan faces — one per style — embedded once per bake
    // so the runs that name them draw with the document's own glyphs.
    const registered = new Set<string>()
    for (const face of ocr.facesOf(pageIndex)) {
      if (!face.bytes) continue
      const ok = await pdfEngine.registerFace(face.familyName, face.bytes.slice(0)).catch(() => false)
      if (ok) registered.add(face.familyName)
    }
    const faceIdFor = (item: OcrTextItem) => {
      const face = ocr.faceOf(pageIndex, styleKeyOf(item))
      return face && registered.has(face.familyName) ? face.familyName : undefined
    }
    // FIRST, the edits the scan itself can make (scanEditPage.ts): every line
    // it handles keeps the scan's pixels for the letters it keeps and takes
    // the page's own letters for the ones it adds, drawn back over exactly the
    // scan's pixel grid. Only the lines it declines go on to the vector
    // redraw below, which is unchanged.
    const scanPlan = await ocr.planScanEditsFor(pageIndex, page.items).catch(err => {
      console.warn('[OCR] scan edit planning failed:', err)
      return null
    })
    const scanHandled = scanPlan?.handled ?? new Set<string>()
    // Only the CHANGED stretch of a run is redrawn when its letters' positions
    // are known (the glyph cut made at commit time) and the engine can say
    // exactly how wide the new stretch will be with the fonts that will draw
    // it; the untouched words keep the scan's own pixels. The widths are
    // measured in one batched call per page.
    const candidates = page.items.filter(i => i.edited && !i.removed && !i.vertical && !i.baked && !scanHandled.has(i.id) && ocr.spanCutFor(i))
    // Which weight the changed stretch should have is what its neighbours
    // say (`weightPlan`): a face glyph traced from the other half of a line
    // that changes weight midway is skipped, and the skip has to be known
    // BEFORE the stretch is measured, or the width is that of the wrong glyph.
    // One 220 DPI raster of the page as it is now serves the weight windows
    // below and the ink halos further down.
    const touched = page.items.filter(i => (i.edited || i.removed) && !i.baked && !scanHandled.has(i.id))
    const rasterCanvas = touched.length ? await renderForOcr(pageIndex, 220 / 72) : null
    const hctx = rasterCanvas?.getContext('2d', { willReadFrequently: true }) ?? null
    const k = rasterCanvas ? rasterCanvas.width / page.pageWidth : 0
    const plans = new Map(candidates.map(item => {
      const face = ocr.faceOf(pageIndex, styleKeyOf(item))
      const cut = ocr.spanCutFor(item)!
      const measureRatio = hctx ? (x0: number, x1: number) => {
        const r = item.inkRect
        const emPx = sizeOf(item, cut) * k
        const cues = detectFace(hctx, { x: x0 * k, y: r.y * k, width: (x1 - x0) * k, height: r.height * k }, emPx, (r.y + r.height * 0.8) * k)
        return cues.measured && cues.strokeRatio > 0 ? cues.strokeRatio : null
      } : undefined
      return [item.id, weightPlan(item, cut, ch => face?.glyphs.get(ch)?.weight, measureRatio)]
    }))
    if (import.meta.env.DEV) (window as any).__ocrWeightPlans = Object.fromEntries(plans)
    const localFont = (item: OcrTextItem) => base14(item.fontFamily, plans.get(item.id)?.bold ?? item.bold, item.italic)
    const measured = await pdfEngine.measureRuns(candidates.map(item => {
      const cut = ocr.spanCutFor(item)!
      return { text: stretchOf(item, cut)?.text ?? '', fontSize: sizeOf(item, cut), fontName: localFont(item), faceId: faceIdFor(item), faceSkip: plans.get(item.id)?.faceSkip || undefined }
    }))
    const partialCtx = new Map(candidates.map((item, i) => [item.id, {
      cut: ocr.spanCutFor(item)!,
      stretchWidthPt: measured[i]?.exact ? measured[i].width : null,
      allowShift: true,
      faceSkip: plans.get(item.id)?.faceSkip || undefined,
      weightScale: plans.get(item.id)?.weightScale,
      localFontName: localFont(item),
      tracedStrokeRatio: plans.get(item.id)?.tracedRatio ?? undefined
    }]))
    // The whole-run redraw's traced glyphs are stroked up to the scan too:
    // the median measured weight of the face glyphs the item's text will use.
    const tracedRatioFor = (item: OcrTextItem): number | null => {
      const face = ocr.faceOf(pageIndex, styleKeyOf(item))
      if (!face) return null
      const ws: number[] = []
      for (const ch of new Set([...item.text])) { const w = face.glyphs.get(ch)?.weight; if (w) ws.push(w) }
      if (!ws.length) return null
      return [...ws].sort((a, b) => a - b)[Math.floor(ws.length / 2)]
    }
    // And every edited run's FULL text, at 10pt, in the fonts that will draw
    // it — the whole-run redraw fits its size to the paper and to the run
    // beside it by this width, where an estimate of half an em per character
    // let a traced calligraphic "中國銀行 X" run across its neighbour.
    const wholeItems = page.items.filter(i => i.edited && !i.removed && !i.vertical && !scanHandled.has(i.id))
    const wholeMeasured = await pdfEngine.measureRuns([
      ...wholeItems.map(item => ({ text: item.text, fontSize: 10, fontName: base14(item.fontFamily, item.bold, item.italic), faceId: faceIdFor(item) })),
      ...wholeItems.map(item => ({ text: item.originalText, fontSize: 10, fontName: base14(item.fontFamily, item.bold, item.italic), faceId: faceIdFor(item) }))
    ])
    const widthAt10 = new Map(wholeItems.map((item, i) => [item.id, wholeMeasured[i]?.exact ? wholeMeasured[i].width : null]))
    const originalWidthAt10 = new Map(wholeItems.map((item, i) => [item.id, wholeMeasured[i + wholeItems.length]?.exact ? wholeMeasured[i + wholeItems.length].width : null]))
    // How far each edited run's ink reaches OUTSIDE its box — an accent over
    // the caps, a bold letter's blurred fringe — read from the page as it is
    // now, so the patch covers it. Cut at the box, a deleted "PERÚ" left its
    // accent on the page as two grey rows above a clean rectangle.
    const haloItems = touched.filter(i => !i.halo)
    if (haloItems.length && hctx && k > 0) {
      const lum = (c: [number, number, number]) => 255 * (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])
      for (const item of haloItems) {
        const r = item.inkRect
        const h = measureHalo(hctx, { x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k }, lum(item.background), lum(item.color))
        ocrStore.updateItem(item.id, { halo: { top: h.top / k, bottom: h.bottom / k, left: h.left / k, right: h.right / k } })
      }
    }
    // `updateItem` replaces the page's item objects; plan from the fresh ones —
    // but in the state the bake STARTED from. A run the user changed while it
    // ran (the scan planner above already saw the old state) is planned as it
    // was and not marked applied: the next live bake takes it whole. Planned
    // from the fresh store instead, a line committed a second into a page's
    // first scan bake was drawn by the vector redraw behind the scan edit's back.
    const snapById = new Map(page.items.map(i => [i.id, i]))
    const changedDuring = (i: OcrTextItem) => { const o = snapById.get(i.id); return !o || o.text !== i.text || o.edited !== i.edited || o.removed !== i.removed || o.restyled !== i.restyled }
    const fresh = ocrStore.pages.get(pageIndex)?.items ?? page.items
    const planItems = fresh.map(i => changedDuring(i) ? (snapById.get(i.id) ?? i) : i)
    plannedByPage.set(pageIndex, new Set(fresh.filter(i => !changedDuring(i))))
    // The lines the scan edit drew stay on the page as NEIGHBOURS of the
    // vector redraw (a replacement must not run into them), unedited.
    const vectorItems = scanHandled.size ? planItems.map(i => scanHandled.has(i.id) ? { ...i, edited: false, removed: false } : i) : planItems
    const plan = planOcrExport(vectorItems, faceIdFor, page.pageWidth, item => partialCtx.get(item.id) ?? null, item => widthAt10.get(item.id) ?? null, tracedRatioFor, item => originalWidthAt10.get(item.id) ?? null)
    // Where the page's scan was read, the vector redraw's paper patches and
    // moved tails are made on its pixels instead: only the edited run's own
    // letters are erased or moved (`inkAwareFallback`). A rectangle of paper
    // colour took whatever fell inside it — the tops of the next line, under
    // a tilted one — and a tail's crop carried its neighbours' descenders.
    const inkAware = scanPlan ? ocr.inkAwareFallbackFor(pageIndex, { patches: plan.patches, modes: plan.modes, items: vectorItems, images: plan.images }) : null
    const pageModes: Record<string, string> = { ...plan.modes }
    for (const [id, m] of Object.entries(scanPlan?.modes ?? {})) pageModes[id] = scanHandled.has(id) ? m : `${plan.modes[id] ?? 'whole'} [${m}]`
    if (inkAware) for (const id of new Set(inkAware.overlays.map(o => o.item))) if (pageModes[id] && !scanHandled.has(id)) pageModes[id] += inkAware.grounded.has(id) ? ' {ground}' : ' {ink-aware}'
    modes[pageIndex] = pageModes
    // What this bake is ALLOWED to change, for the fidelity harness
    // (public/_sweep/fidelity-driver.js): any pixel that moves outside these
    // rectangles is damage to something the user never edited.
    if (import.meta.env.DEV) {
      ;((window as any).__ocrBakePlans ??= {})[pageIndex] = JSON.parse(JSON.stringify({
        // A scan edit's overlays are where it was allowed to change pixels.
        patches: [...plan.patches, ...[...(scanPlan?.overlays ?? []), ...(inkAware?.overlays ?? [])].map(o => ({ rect: o.rect, item: o.item, overlay: true }))],
        images: plan.images,
        texts: [...plan.texts, ...(scanPlan?.texts ?? [])].map(t => ({ text: t.text, x: t.x, y: t.y, fontSize: t.fontSize, invisible: !!t.invisible, group: t.group })),
        modes: pageModes
      }))
    }
    // What each run's ink box becomes: a stretch appended past the old ink,
    // or a shifted tail, is painted OUTSIDE the box the recogniser read, and
    // a second edit of the run has to patch and blank all of it — cut at the
    // old box, the first bake's "MAESTRA" stayed on the page beside the new
    // title, on screen and in every extractor.
    const grown = new Map<string, [number, number, number, number]>()
    for (const patch of plan.patches) {
      if (!patch.item) continue
      const [x0, y0, x1, y1] = patch.rect
      const g = grown.get(patch.item)
      grown.set(patch.item, g
        ? [Math.min(g[0], x0), Math.min(g[1], y0), Math.max(g[2], x1), Math.max(g[3], y1)]
        : [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)])
    }
    grownByPage.set(pageIndex, grown)
    if (plan.patches.length === 0 && plan.texts.length === 0 && plan.images.length === 0 && !scanPlan?.overlays.length && !scanPlan?.texts.length && !inkAware?.overlays.length) continue

    // The scan's pixels for any tail that moves, read from a fresh render of
    // the page BEFORE anything is drawn on it: PDF.js still holds the
    // pre-bake document until `syncAfterEdit`, whatever the OCR raster LRU has.
    // A tail moved on the scan's own pixels (`inkAware`) needs no crop.
    const crops: (ArrayBuffer | null)[] = []
    if (plan.images.some((_, i) => !inkAware?.images.has(i))) {
      const canvas = await renderForOcr(pageIndex, 300 / 72)
      const k = canvas ? canvas.width / page.pageWidth : 0
      for (const [i, img] of plan.images.entries()) {
        if (inkAware?.images.has(i)) { crops.push(null); continue }
        const [x0, y0, x1, y1] = img.srcRect
        crops.push(canvas ? await cropToPng(canvas, { x: x0 * k, y: y0 * k, width: (x1 - x0) * k, height: (y1 - y0) * k }) : null)
      }
    }

    await exclusiveOp(async () => {
      // A page that already carries a searchable layer (Acrobat's) has the OLD
      // words under every edited run as invisible text; the bake writes the
      // new words (visible, plus their own invisible copy where the redraw is
      // partial), so the old ones would be found by search a second time.
      // Blank the layer's ops under each edited run first.
      const inkOf = (i: OcrTextItem) => [i.inkRect.x, i.inkRect.y, i.inkRect.x + i.inkRect.width, i.inkRect.y + i.inkRect.height] as [number, number, number, number]
      const touched = page.items.filter(i => i.edited || i.removed)
      // Under a run edited for the first time only the invisible layer goes.
      // VISIBLE text there is the page's own — a translation service draws its
      // title as real text over the scan — and blanking it deleted "HORMOZI"
      // from "ALEX HORMOZI" when only "ALEX" was being redrawn. (A live bake
      // starts from the page's pristine content, so no earlier bake of ours is
      // under a run that was not finalised.)
      const editedRects = touched.filter(i => !i.baked).map(inkOf)
      if (editedRects.length) await pdfEngine.blankInvisibleText(pageIndex, editedRects, false).catch(() => 0)
      // `all`: a run baked once and edited again has its FIRST bake's words
      // under the new patch — visible ops that no reader should still find.
      const bakedRects = touched.filter(i => i.baked).map(inkOf)
      if (bakedRects.length) await pdfEngine.blankInvisibleText(pageIndex, bakedRects, true).catch(() => 0)
      // Into the content stream, not as an annotation: annotations paint over
      // page content whatever order they were made in, so a patch drawn as one
      // covered the replacement text and it came out with its start missing.
      for (const [n, patch] of plan.patches.entries()) {
        if (patch.paint === false || inkAware?.patches.has(n)) continue
        await pdfEngine.fillRect(pageIndex, patch.rect, patch.color)
      }
      // The patches and tails made on the scan's own pixels, where the
      // painted ones would have gone: before the images and the new text.
      if (inkAware?.overlays.length) {
        await pdfEngine.drawPixelOverlays(pageIndex, inkAware.overlays.map(o => ({
          rect: o.rect, width: o.width, height: o.height, rgb: o.rgb.buffer as ArrayBuffer, alpha: o.alpha.buffer as ArrayBuffer
        })))
      }
      for (const [i, img] of plan.images.entries()) {
        if (inkAware?.images.has(i)) continue
        const png = crops[i]
        if (png) await pdfEngine.drawImageInContent(pageIndex, img.dstRect, png, false)
      }
      // The scan edits' pixels, all in one rewrite, then each edited line's
      // words as one invisible text object (fitted to the ink they stand for).
      if (scanPlan?.overlays.length) {
        await pdfEngine.drawPixelOverlays(pageIndex, scanPlan.overlays.map(o => ({
          rect: o.rect, width: o.width, height: o.height, rgb: o.rgb.buffer as ArrayBuffer, alpha: o.alpha.buffer as ArrayBuffer
        })))
      }
      if (scanPlan?.texts.length) {
        const byItem = new Map<string, typeof scanPlan.texts>()
        for (const t of scanPlan.texts) { const list = byItem.get(t.group!) ?? []; list.push(t); byItem.set(t.group!, list) }
        for (const run of byItem.values()) {
          await pdfEngine.addTextRun(pageIndex, run.map(o => ({
            x: o.x, y: page.pageHeight - o.y, text: o.text, fontSize: o.fontSize, fontName: o.fontName,
            color: o.color, invisible: true, fitWidth: o.fitWidth
          })), run[0].rotation)
        }
      }
      written += scanHandled.size
      // Ops of one GROUP — a partial redraw's invisible head, visible stretch
      // and invisible tail — go into one text object, or MuPDF lists the
      // stretch before its own head and the line stops copying in order.
      for (let i = 0; i < plan.texts.length; ) {
        const t = plan.texts[i]
        let j = i + 1
        while (t.group && j < plan.texts.length && plan.texts[j].group === t.group) j++
        const run = plan.texts.slice(i, j)
        // addText takes a bottom-left origin baseline; OCR works top-left.
        if (run.length > 1) {
          await pdfEngine.addTextRun(pageIndex, run.map(o => ({
            x: o.x, y: page.pageHeight - o.y, text: o.text, fontSize: o.fontSize, fontName: o.fontName,
            color: o.color, faceId: o.faceId, invisible: o.invisible, fitWidth: o.fitWidth, strokeWidth: o.strokeWidth, faceSkip: o.faceSkip, tracedStrokeWidth: o.tracedStrokeWidth
          })), t.rotation)
        } else {
          await pdfEngine.addText(pageIndex, t.x, page.pageHeight - t.y, t.text, t.fontSize, t.fontName, t.color, t.rotation, t.faceId, t.invisible, t.strokeWidth, t.faceSkip, t.tracedStrokeWidth)
        }
        for (const o of run) if (!o.invisible) written++
        i = j
      }
    })
  }
  ;(window as any).__ocrBakeReport = modes

  if (opts.live) {
    // Live: the page now shows every edit, drawn from its pristine scan. The
    // runs stay EDITED against their original text and keep their glyph cuts,
    // so the next edit of any of them redraws from the original ink again.
    docStore.markModified()
    await syncAfterEdit()
    for (const [pageIndex, planned] of plannedByPage) {
      for (const item of ocrStore.itemsFor(pageIndex)) {
        if ((item.edited || item.removed) && planned.has(item)) ocrStore.updateItem(item.id, { applied: true })
      }
    }
    return written
  }

  if (written > 0 || ocrStore.hasEdits) {
    docStore.markModified()
    await syncAfterEdit()
    // The runs are in the document now; drawing them again on the next save
    // would stack a second copy on the first. A drawn run is also marked
    // `baked`: the raster under it no longer shows its original ink, so its
    // glyph cut is forgotten and neither a partial redraw nor a trace is made
    // from it again until the page is recognised afresh.
    for (const [pageIndex, page] of ocrStore.pages) {
      if (page.items.some(i => i.edited || i.removed)) ocr.forgetTraceRaster(pageIndex)
      for (const item of page.items) {
        if (item.edited || item.removed) {
          const g = grownByPage.get(pageIndex)?.get(item.id)
          if (g) {
            // Horizontally only, and net of the patch's own pad: a run's
            // height never changes, and taking the padded rectangle as the
            // box would grow it by a pad on every bake until it reached the
            // lines above and below.
            const r = item.inkRect
            const pad = Math.max(1, r.height * 0.15)
            const x0 = Math.min(r.x, g[0] + pad), x1 = Math.max(r.x + r.width, g[2] - pad)
            item.inkRect = { x: x0, y: r.y, width: x1 - x0, height: r.height }
            // The run's box follows its ink where the two still agreed; a run
            // the user dragged keeps its own place.
            if (Math.abs(item.rect.x - r.x) < 0.5 && Math.abs(item.rect.y - r.y) < 0.5) item.rect = { ...item.inkRect }
          }
          item.baked = true
          ocr.forgetSpanCut(item.id)
        }
        item.edited = false; item.removed = false; item.restyled = false; item.originalText = item.text
        item.originalStyle = undefined
      }
    }
  }
  return written
}

// ===== FILE =====
/**
 * Load a document into BOTH engines, and report the truth if either refuses.
 *
 * `pdfViewer.loadDocument` swallows its own errors and returns `{success:false}`
 * — which used to be ignored here, so a PDF that PDF.js could not render was
 * announced as "N pages (ready)" over a blank canvas, with the real error
 * already overwritten in the status bar. A file that does not open has to say
 * so, and it has to leave the previous document alone rather than half-replace
 * it: the old bytes are put back so the app is never left showing one document
 * and holding another.
 */
async function loadBytes(bytes: Uint8Array, name: string) {
  const previous = docStore.pdfBytes ? new Uint8Array(docStore.pdfBytes) : null
  const previousName = docStore.fileName ?? 'document.pdf'

  historyStore.clear()
  searchStore.clear()
  ocrStore.clear()
  ocr.reset()
  livePages.clear()

  const rendered = await pdfViewer.loadDocument(bytes, name)
  if (!rendered?.success) {
    const why = rendered?.error || 'the file is not a readable PDF'
    // Put the old document back FIRST — its own load writes a status line, so
    // saying why the new one failed before that would be overwritten by it, and
    // the user would be told the file loaded when it did not.
    if (previous) await pdfViewer.loadDocument(previous, previousName).catch(() => {})
    editorStore.setStatus(
      previous
        ? `Could not open ${name}: ${why} — ${previousName} is still open`
        : `Could not open ${name}: ${why}`
    )
    return
  }

  try {
    // A copy: the bridge transfers this buffer to the worker, and `bytes` is
    // what docStore now holds for saving and undo.
    const pageCount = await pdfEngine.loadDocument(bytes.buffer.slice(0) as ArrayBuffer)
    // The overlays (text blocks, annotations, page images) fetch on the
    // renderVersion bump, and the bump inside pdfViewer.loadDocument fired
    // while the ENGINE was still empty — their guard answered "no document"
    // and nothing ever asked again, so a freshly opened file had no clickable
    // objects until the tool was toggled. Bump again now the engine is ready.
    docStore.reloadBytes(bytes)
    // The document's digital signatures, as of the open. Read once here, not
    // after each edit: every edit breaks all of them, and the status bar pairs
    // this list with `isModified` to say so. An Intellisign contract carries
    // one /Sig widget per signer per page, so the count can run to dozens.
    const signatures = await pdfEngine.getSignatures()
    docStore.setSignatures(signatures)
    const signed = signatures.length
      ? ` · ${signatures.length} digital signature${signatures.length === 1 ? '' : 's'} — editing will invalidate them`
      : ''
    editorStore.setStatus(`${name} — ${pageCount} pages (ready)${signed}`)
  } catch (err: any) {
    // It renders but cannot be edited — say exactly that instead of a bare
    // error, because the pages ARE on screen and the user can still print/save.
    editorStore.setStatus(`${name} opened for viewing — editing unavailable: ${err.message}`)
  }
}

const openInputRef = ref<HTMLInputElement | null>(null)
const mergeInputRef = ref<HTMLInputElement | null>(null)

/**
 * Open the chooser on the permanent input.
 *
 * The value is cleared FIRST: a file input fires `change` only when the
 * selection actually changes, so re-opening the same document twice in a row
 * would be silently ignored on a persistent element.
 */
function openFile() {
  const input = openInputRef.value
  if (!input) { editorStore.setStatus('Cannot open the file chooser — please reload the page'); return }
  input.click()
}

/**
 * Open a File the user picked. Takes the File, not a click.
 *
 * Every button site owns its own <input type=file> laid over the control, so
 * the user's click lands ON the input and the browser opens the chooser itself.
 * Nothing here has to reach an element, keep user activation alive across a
 * handler chain, or be wired through provide/inject in time.
 */
async function openPdfFile(file: File) {
  try {
    editorStore.setStatus(`Opening ${file.name}...`)
    await loadBytes(new Uint8Array(await file.arrayBuffer()), file.name)
  } catch (err: any) {
    // A file that cannot be read is not a silent no-op.
    editorStore.setStatus(`Could not open ${file.name}: ${err?.message || err}`)
  }
}

async function onOpenPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  // Cleared straight after the File is captured, so the SAME document can be
  // opened again: a file input fires `change` only when the selection changes.
  input.value = ''
  if (file) await openPdfFile(file)
}

/** Commit whatever the inline editor is holding before the document is read. */
async function flushOpenEditor() {
  const active = document.activeElement as HTMLElement | null
  if (active && (active.isContentEditable || active.tagName === 'TEXTAREA')) {
    active.blur()
    // blur triggers the editor's commit on a 150 ms timer.
    await new Promise(r => setTimeout(r, 250))
  }
}

/**
 * Ask the browser where to put the file — BEFORE the engine save, not after.
 *
 * `showSaveFilePicker` needs transient user activation just like a programmatic
 * download does, and that activation expires about five seconds after the click.
 * Saving a real document routinely takes longer than that (the op queue may
 * still be finishing an edit's save→reload), so asking afterwards throws
 * NotAllowedError and the file silently never lands. Asking first spends the
 * activation while it is still fresh, and the handle stays valid for as long as
 * the save needs.
 *
 * Returns null when the API is unavailable (Firefox) — the caller falls back to
 * a download — and 'cancelled' when the user dismissed the dialog.
 */
async function pickSaveTarget(suggestedName: string): Promise<FileSystemFileHandle | null | 'cancelled'> {
  const picker = (window as any).showSaveFilePicker as
    | ((opts: any) => Promise<FileSystemFileHandle>)
    | undefined
  if (typeof picker !== 'function') return null

  try {
    return await picker({
      suggestedName,
      types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }]
    })
  } catch (err: any) {
    if (err?.name === 'AbortError') return 'cancelled'
    // SecurityError/NotAllowedError (activation gone, cross-origin frame, policy):
    // fall back to a download rather than failing the save outright.
    console.warn('[Save] File picker unavailable, falling back to download:', err)
    return null
  }
}

async function saveFile() {
  if (!docStore.loaded) return
  await flushOpenEditor()
  // What is on screen for a scanned page is only a preview until this runs.
  await bakeOcrEdits()

  const name = (docStore.fileName || 'document.pdf').replace(/ \*$/, '')
  const target = await pickSaveTarget(name)
  if (target === 'cancelled') {
    editorStore.setStatus('Save cancelled — the document is still open and unsaved')
    return
  }

  editorStore.setStatus('Saving PDF...')
  try {
    const bytes = await enqueueOp(() => pdfEngine.saveDocument())
    if (!bytes || bytes.byteLength === 0) {
      editorStore.setStatus('Save failed: the engine produced an empty document')
      return
    }
    const blob = new Blob([bytes], { type: 'application/pdf' })

    if (target) {
      // The write is awaited to completion, so "saved" is a fact here, not a
      // hope — unlike a download, which the browser can drop without telling us.
      const writable = await target.createWritable()
      await writable.write(blob)
      await writable.close()
      docStore.markSaved()
      editorStore.setStatus(`Saved ${target.name} — ${(blob.size / 1024).toFixed(0)} KB`)
      return
    }

    offerDownload(blob, name)
  } catch (err: any) {
    editorStore.setStatus(`Save error: ${err.message}`)
    $q.notify({
      message: 'The PDF could not be written.',
      caption: err.message,
      color: 'negative',
      icon: 'error',
      timeout: 8000,
      multiLine: true
    })
  }
}

/** Click a temporary anchor to start a download. */
function triggerDownload(url: string, fileName: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  a.style.display = 'none'
  // Firefox ignores a click on an anchor that is not in the document.
  document.body.appendChild(a)
  a.click()
  // Removing the anchor in the same tick as the click has been observed to
  // cancel the transfer in Chromium; let the current task finish first.
  setTimeout(() => a.remove(), 0)
}

/**
 * Hand the saved bytes to the browser.
 *
 * Three things have to be right here, and all three used to fail silently
 * while the status bar still reported "PDF saved successfully":
 *
 * 1. The anchor must be attached to the document before it is clicked.
 * 2. The object URL has to outlive the click — revoking it on the next line
 *    cancels the transfer, which bites hardest on the multi-megabyte files
 *    this editor produces.
 * 3. A programmatic download needs TRANSIENT USER ACTIVATION, and that expires
 *    about five seconds after the click that granted it. Saving can outlast
 *    that (the op queue may still be finishing an edit's save->reload on a
 *    large document), and the browser then drops the download without firing
 *    any event. When the activation is gone, ask for a fresh click instead of
 *    claiming a success that never happened.
 */
function offerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  // Keep the URL alive well past the click, then release it.
  const scheduleRevoke = () => setTimeout(() => URL.revokeObjectURL(url), 60_000)

  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  if (activation && !activation.isActive) {
    editorStore.setStatus('PDF ready — confirm the download')
    $q.notify({
      message: `"${fileName}" is ready.`,
      caption: 'Saving took long enough that the browser needs a fresh click to start the download.',
      color: 'primary',
      icon: 'save',
      timeout: 0,
      multiLine: true,
      actions: [
        {
          label: 'Download',
          color: 'white',
          handler: () => {
            triggerDownload(url, fileName)
            scheduleRevoke()
            docStore.markSaved()
            editorStore.setStatus('PDF saved successfully')
          }
        },
        {
          label: 'Cancel',
          color: 'white',
          handler: () => {
            URL.revokeObjectURL(url)
            editorStore.setStatus('Save cancelled — the document is still open and unsaved')
          }
        }
      ]
    })
    return
  }

  triggerDownload(url, fileName)
  scheduleRevoke()
  docStore.markSaved()
  // A download is fire-and-forget: the browser reports nothing back, so this
  // says what was handed over rather than claiming the file is on disk.
  editorStore.setStatus(`Download started: ${fileName} — check your Downloads folder`)
}

// ===== PRINT =====

/** Keeps the print frame and its object URL alive until printing is done. */
let printCleanup: (() => void) | null = null

/**
 * Print the document as it stands, edits included.
 *
 * The bytes come from the engine rather than from the on-screen canvas, so what
 * prints is the real PDF at full resolution — printing the rendered canvas would
 * output a screen-resolution bitmap.
 *
 * A hidden same-origin iframe is used because `iframe.contentWindow.print()`
 * needs no user activation, and the save can easily outlive the ~5s activation
 * window that `window.open` would require. When the embedded viewer refuses to
 * load (some COEP/plugin configurations block PDF embedding), the fallback is a
 * new tab — offered as a BUTTON, so the click that opens it supplies its own
 * fresh activation.
 */
async function printFile() {
  if (!docStore.loaded) return
  await flushOpenEditor()
  // Printing goes through the engine bytes, and a scanned page's OCR edits are
  // only a preview until they are baked — without this the print lacked them
  // while the save had them.
  await bakeOcrEdits()

  editorStore.setStatus('Preparing document for printing...')
  let blob: Blob
  try {
    const bytes = await enqueueOp(() => pdfEngine.saveDocument())
    if (!bytes || bytes.byteLength === 0) {
      editorStore.setStatus('Print failed: the engine produced an empty document')
      return
    }
    blob = new Blob([bytes], { type: 'application/pdf' })
  } catch (err: any) {
    editorStore.setStatus(`Print error: ${err.message}`)
    return
  }

  printCleanup?.()

  const url = URL.createObjectURL(blob)
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0'

  let settled = false
  const cleanup = () => {
    if (printCleanup !== cleanup) return
    printCleanup = null
    clearTimeout(watchdog)
    frame.remove()
    URL.revokeObjectURL(url)
  }
  printCleanup = cleanup

  function offerNewTab(reason: string) {
    if (settled) return
    settled = true
    editorStore.setStatus(`Could not open the print dialog (${reason})`)
    $q.notify({
      message: 'The print dialog could not be opened here.',
      caption: 'Open the PDF in a new tab and print it from there.',
      color: 'warning',
      icon: 'print_disabled',
      timeout: 0,
      multiLine: true,
      actions: [
        {
          label: 'Open in new tab',
          color: 'white',
          handler: () => {
            // This handler runs from a real click, so the popup is allowed.
            const tab = window.open(url, '_blank')
            if (!tab) {
              editorStore.setStatus('The browser blocked the new tab — allow pop-ups for this site')
              return
            }
            editorStore.setStatus('PDF opened in a new tab — press Ctrl+P there to print')
            // The tab now owns the URL; give it time to load before releasing.
            setTimeout(cleanup, 60_000)
          }
        },
        { label: 'Dismiss', color: 'white', handler: cleanup }
      ]
    })
  }

  // The viewer can fail to load without firing `error` — a timer is the only
  // signal that nothing is going to happen.
  const watchdog = setTimeout(() => offerNewTab('the embedded viewer did not load'), 10_000)

  frame.onerror = () => offerNewTab('the embedded viewer refused to load')
  frame.onload = () => {
    clearTimeout(watchdog)
    try {
      const win = frame.contentWindow
      if (!win) { offerNewTab('no print context'); return }
      win.focus()
      win.print()
      settled = true
      editorStore.setStatus('Print dialog opened')
      // The dialog is modal in most browsers but not guaranteed to be, so the
      // frame is kept alive well past it rather than pulled out from under it.
      setTimeout(cleanup, 120_000)
    } catch (err: any) {
      offerNewTab(err?.message || 'print() was refused')
    }
  }

  frame.src = url
  document.body.appendChild(frame)
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
  if (!docStore.pdfBytes) return
  const snap = new Uint8Array(docStore.pdfBytes)
  undoMeta.set(snap, captureOcrMeta())
  historyStore.pushSnapshot(snap)
}

/**
 * What a document snapshot cannot hold: the recognised runs and what the live
 * bake last left on each page. A live bake applies an OCR edit to the BYTES,
 * so undoing it brings back bytes without the edit — and the store, left
 * alone, would go on claiming the edit (and the next live bake would put it
 * straight back). Kept beside the snapshot, keyed by it.
 */
interface OcrUndoMeta { pages: Map<number, any>; hashes: Map<number, number> }
const undoMeta = new WeakMap<Uint8Array, OcrUndoMeta>()
function captureOcrMeta(): OcrUndoMeta {
  const pages = new Map<number, any>()
  for (const [k, v] of ocrStore.pages) pages.set(k, { ...v, items: v.items.map(i => ({ ...i })) })
  const hashes = new Map<number, number>()
  for (const [k, v] of livePages) hashes.set(k, v.hash)
  return { pages, hashes }
}
function restoreOcrMeta(meta: OcrUndoMeta | undefined) {
  if (!meta) return
  ocrStore.pages = new Map(meta.pages)
  for (const [k, v] of livePages) v.hash = meta.hashes.get(k) ?? v.pristineHash
  appliedMeta = meta
}

// ===== UNDO / REDO =====
async function undo() {
  if (!historyStore.canUndo || !docStore.loaded) return
  // Anything that replaces the whole document has to wait for a multi-step
  // operation to finish. The queue only serialises single steps, and an undo
  // between two of them swaps the document out from under the one still
  // running — which is how a blank page and a third of the bytes went missing.
  if (transactionOpen()) editorStore.setStatus('Waiting for the current operation to finish...')
  await settleTransactions()
  await exclusiveOp(async () => {
    editorStore.setStatus('Undoing...')
    if (docStore.pdfBytes) {
      const cur = new Uint8Array(docStore.pdfBytes)
      undoMeta.set(cur, captureOcrMeta())
      historyStore.pushRedo(cur)
    }
    const snapshot = historyStore.popUndo()!
    liveSuppressed = true
    // ENGINE first, viewer second. reloadDocument bumps renderVersion (via
    // reloadBytes), and that bump is the ONLY signal the overlays get — undo
    // has no explicit re-fetch the way annotOp does. With the viewer first,
    // every overlay watcher fetched from a worker still holding the pre-undo
    // document and kept the stale answer forever: the canvas showed the
    // signature back in place while its hit target stayed where the undone
    // move had put it.
    await pdfEngine.loadDocument(snapshot.buffer.slice(0) as ArrayBuffer)
    await pdfViewer.reloadDocument(snapshot)
    restoreOcrMeta(undoMeta.get(snapshot))
    liveSuppressed = false
    docStore.markModified()
    editorStore.setStatus('Undo applied')
  })
}
async function redo() {
  if (!historyStore.canRedo || !docStore.loaded) return
  if (transactionOpen()) editorStore.setStatus('Waiting for the current operation to finish...')
  await settleTransactions()
  await exclusiveOp(async () => {
    editorStore.setStatus('Redoing...')
    if (docStore.pdfBytes) {
      const cur = new Uint8Array(docStore.pdfBytes)
      undoMeta.set(cur, captureOcrMeta())
      historyStore.pushUndoNoClear(cur)
    }
    const snapshot = historyStore.popRedo()!
    liveSuppressed = true
    // Engine before viewer — same reason as undo above.
    await pdfEngine.loadDocument(snapshot.buffer.slice(0) as ArrayBuffer)
    await pdfViewer.reloadDocument(snapshot)
    restoreOcrMeta(undoMeta.get(snapshot))
    liveSuppressed = false
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
    if (ok) { pushUndo(); forgetOcr(); await syncAfterEdit(); editorStore.setStatus(`Page rotated ${degrees > 0 ? 'right' : 'left'}`) }
    else editorStore.setStatus(`Rotate failed: ${pdfEngine.error.value}`)
  })
}
/**
 * Merge another PDF into this one, after the page being viewed.
 *
 * Same permanent-input reasoning as `openFile`.
 */
function insertFile() {
  if (!docStore.loaded) return
  const input = mergeInputRef.value
  if (!input) { editorStore.setStatus('Cannot open the file chooser — please reload the page'); return }
  input.click()
}

async function onMergePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) await mergePdfFile(file)
}

/** Merge a File the user picked into this document, after the current page. */
async function mergePdfFile(file: File) {
  if (!docStore.loaded) return
  const at = docStore.currentPage      // insert AFTER the current page
  try {
    editorStore.setStatus(`Merging ${file.name}...`)
    const bytes = await file.arrayBuffer()
    await exclusiveOp(async () => {
      const r = await pdfEngine.mergePages(bytes, at)
      if (r === false) {
        editorStore.setStatus(`Could not merge ${file.name}: ${pdfEngine.error.value || 'unreadable PDF'}`)
        return
      }
      pushUndo()
      forgetOcr()
      await syncAfterEdit()
      docStore.setPage(at + 1)
      editorStore.setStatus(`${file.name} merged — ${r.added} page(s) added after page ${at}, ${r.pages} in total`)
    })
  } catch (err: any) {
    editorStore.setStatus(`Could not merge ${file.name}: ${err?.message || err}`)
  }
}

async function insertBlankPage() {
  if (!docStore.loaded) return
  await exclusiveOp(async () => {
    const size = await pdfEngine.getPageSize(docStore.currentPage - 1).catch(() => ({ width: 612, height: 792 }))
    const r = await pdfEngine.insertBlankPage(docStore.currentPage, size.width, size.height)
    if (r !== false) { pushUndo(); forgetOcr(); await syncAfterEdit(); docStore.setPage(docStore.currentPage + 1); editorStore.setStatus('Blank page inserted') }
    else editorStore.setStatus(`Insert failed: ${pdfEngine.error.value}`)
  })
}
async function deletePage() {
  if (!docStore.loaded) return
  await exclusiveOp(async () => {
    const r = await pdfEngine.deletePage(docStore.currentPage - 1)
    if (r !== false) { pushUndo(); forgetOcr(); await syncAfterEdit(); editorStore.setStatus('Page deleted') }
    else editorStore.setStatus(`Delete failed: ${pdfEngine.error.value}`)
  })
}
async function duplicatePage() {
  if (!docStore.loaded) return
  await exclusiveOp(async () => {
    const r = await pdfEngine.duplicatePage(docStore.currentPage - 1)
    if (r !== false) { pushUndo(); forgetOcr(); await syncAfterEdit(); editorStore.setStatus('Page duplicated') }
    else editorStore.setStatus(`Duplicate failed: ${pdfEngine.error.value}`)
  })
}
async function movePage(from: number, to: number) {
  if (!docStore.loaded || from === to) return
  await exclusiveOp(async () => {
    const r = await pdfEngine.movePage(from, to)
    if (r !== false) { pushUndo(); forgetOcr(); await syncAfterEdit(); docStore.setPage(to + 1); editorStore.setStatus('Page moved') }
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
/**
 * Whatever is actually scrolling the page right now.
 *
 * Not `.pdf-viewer-container`: it declares `overflow: auto` but the Quasar
 * layout above it lets the WINDOW scroll instead, so the viewer's own
 * scrollHeight equals its clientHeight and it always looks like there is
 * nowhere to scroll. Reading that, Down turned the page on the first press even
 * on a document zoomed to three times the height of the window.
 *
 * The element that scrolls therefore has to be found rather than named: walk up
 * from the canvas to the first ancestor that both allows overflow and has room
 * in it, and fall back to the document.
 */
function pageScroller(): HTMLElement | null {
  let el = document.querySelector('.pdf-canvas') as HTMLElement | null
  while (el && el !== document.body) {
    const style = getComputedStyle(el)
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight - el.clientHeight > 2) return el
    el = el.parentElement
  }
  return (document.scrollingElement as HTMLElement | null)
}

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
    // Ctrl+P must print the EDITED document, not the browser's view of the app
    // shell — the default would print the toolbar and a screen-resolution page.
    if (e.key === 'p') { e.preventDefault(); printFile(); return }
  }
  // Escape inside an editor/input cancels THAT editor (handled locally),
  // not the find bar — the find input closes itself on Escape.
  if (e.key === 'Escape') { if (!isTyping) closeFind(); return }
  if (isTyping || !docStore.loaded) return

  // Paging.
  //
  // Up and down scroll the page they are on FIRST and only turn the page once
  // there is nowhere left to scroll, which is what every PDF reader does: on a
  // document zoomed past the height of the window, turning the page on the
  // first press would skip most of what the user was reading. PageUp/PageDown
  // and the horizontal arrows always turn, because that is all they mean.
  const viewer = pageScroller()
  const atTop = !viewer || viewer.scrollTop <= 1
  const atBottom = !viewer || viewer.scrollTop + viewer.clientHeight >= viewer.scrollHeight - 1

  const turn = (delta: number) => {
    e.preventDefault()
    const next = docStore.currentPage + delta
    if (next >= 1 && next <= docStore.totalPages) {
      docStore.setPage(next)
      // Land at the top of a page turned forwards and the foot of one turned
      // back, so reading carries on from where it left off either way.
      if (viewer) viewer.scrollTop = delta > 0 ? 0 : viewer.scrollHeight
    }
  }

  switch (e.key) {
    case 'ArrowDown': if (atBottom) turn(1); return
    case 'ArrowUp': if (atTop) turn(-1); return
    case 'PageDown': case 'ArrowRight': turn(1); return
    case 'PageUp': case 'ArrowLeft': turn(-1); return
    case 'Home': e.preventDefault(); docStore.setPage(1); return
    case 'End': e.preventDefault(); docStore.setPage(docStore.totalPages); return
  }

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
provide('runOcrOnPage', runOcrOnPage)
// The recogniser has no viewer of its own; lend it ours so it can render a
// page again at tracing resolution (see `traceRasterFor`).
ocr.setPageRenderer((pageIndex, scale) => renderPristine(pageIndex, scale))
// The scan at its own resolution, for edits made on its pixels. The scan
// image itself is never rewritten by a bake (overlays are new objects), so
// reading it from the page as it now stands gives the pristine pixels.
// The scan a page's edits are made on: its one upright scan image, at its own
// pixels — or, when the page is not that (an office scanner's layered "compact
// PDF", whose letters are masks over a background image; a /Rotate page whose
// image is turned; a scan in tiles), a render of the page's CONTENT at up to
// 300 DPI, on whose grid the edits' overlays are then drawn. Without it such
// a page never reached the scan edit at all.
ocr.setScanLoader(pageIndex => enqueueOp(async () => {
  const img = await pdfEngine.getScanImage(pageIndex)
  if (img && Math.abs(img.ctm[1]) < 1e-6 && Math.abs(img.ctm[2]) < 1e-6 && img.ctm[0] > 0 && img.ctm[3] > 0) return img
  const size = await pdfEngine.getPageSize(pageIndex).catch(() => null)
  if (!size) return null
  const scale = Math.min(300 / 72, Math.sqrt(16e6 / (size.width * size.height)))
  const r = await pdfEngine.renderPageRgba(pageIndex, scale)
  if (!r) return null
  const pageWidth = r.width / scale, pageHeight = r.height / scale
  return { width: r.width, height: r.height, rgba: r.rgba, ctm: [pageWidth, 0, 0, pageHeight, 0, 0] as [number, number, number, number, number, number], pageWidth, pageHeight, name: '' }
}))
// Letters the scan never printed are drawn from bundled faces the engine
// rasterises; nothing in the document is read or written, so no queue.
ocr.setGlyphRasterizer((file, chars, emPx) => pdfEngine.rasterGlyphs(file, chars, emPx))

/** The page as a raster for recognition: MuPDF, and pdf.js when MuPDF cannot. */
async function renderForOcr(pageIndex: number, scale: number): Promise<HTMLCanvasElement | null> {
  const viaMupdf = await pdfEngine.renderPageBitmap(pageIndex, scale).catch(() => null)
  if (viaMupdf) return viaMupdf
  return pdfViewer.renderPageToCanvas(pageIndex + 1, scale).catch(() => null)
}
provide('bakeOcrEdits', bakeOcrEdits)

// ===== RECOGNISE TEXT IN THIS FILE (Acrobat's "Reconocer texto → En este archivo") =====
/**
 * The marked-content tag on the searchable layer this editor writes, so a
 * later run finds and replaces its own layer rather than stacking a second.
 */
const OCR_LAYER_TAG = 'OCRLayer'
const recognizeProgress = ref<RecognizeProgress>({ running: false, page: 0, total: 0, done: 0, layered: 0, skipped: 0, stage: '' })
let recognizeCancel = false

/**
 * Recognise every scanned page asked for and give each an INVISIBLE text
 * layer — `3 Tr`, one run per recognised line, stretched with `Tz` to the
 * width of the ink it stands for — so the file searches, copies and reads
 * aloud while the page keeps its own pixels. Acrobat calls the result a
 * "searchable image". Pages with real text are skipped; pages that already
 * carry a layer (Acrobat's, or ours) are skipped unless asked to replace it,
 * in which case the old layer is blanked first. The recognised runs stay in
 * the OCR store, so any of them can be edited afterwards exactly as a page
 * recognised by hand — and the bake blanks the layer's words under a run it
 * redraws. One undo point for the whole run.
 */
async function recognizeDocument(opts: RecognizeDocumentOptions): Promise<void> {
  if (!docStore.loaded || recognizeProgress.value.running || ocr.busy.value) return
  recognizeCancel = false
  const p = recognizeProgress.value
  Object.assign(p, { running: true, page: 0, total: opts.pageIndices.length, done: 0, layered: 0, skipped: 0, stage: '' })
  const why = { text: 0, layer: 0, blank: 0, nothing: 0 }
  let changed = false
  // Progress inside the dialog: a page of Chinese and Spanish takes long
  // enough that a still bar reads as a hang.
  const stopProgress = watch([ocr.stage, ocr.progress], ([stage, pct]) => {
    if (!ocr.busy.value) return
    p.stage = `Recognising page ${p.page}… ${stage && stage !== 'recognizing text' && stage !== 'Recognising text...' ? stage : `${pct}%`}`
  })
  try {
    for (const pi of opts.pageIndices) {
      if (recognizeCancel) break
      p.page = pi + 1
      p.stage = `Checking page ${pi + 1}…`
      const blocks = await pdfEngine.getTextBlocks(pi).catch(() => [])
      const hasLayer = blocks.some(b => b.invisible)
      if (!(await isScanLikePage(pi))) {
        // Real text, or a blank sheet: the text judge said so.
        if (blocks.some(b => !b.invisible && b.text.trim())) why.text++; else why.blank++
        p.skipped++; p.done++
        continue
      }
      if (hasLayer && !opts.replaceExisting) { why.layer++; p.skipped++; p.done++; continue }

      p.stage = `Recognising page ${pi + 1}…`
      await runOcrNow(pi, opts.lang)
      // The layer is written from the runs: from the readings the page's own
      // letters give, not the recogniser's ("Lostérminos queenel").
      p.stage = `Reading page ${pi + 1} again from its own letters…`
      await ocr.settleRepairs()
      const items = ocrStore.itemsFor(pi).filter(i => i.text.trim() && !i.removed)
      if (!items.length) { why.nothing++; p.skipped++; p.done++; continue }

      p.stage = `Writing the text layer of page ${pi + 1}…`
      const size = await pdfEngine.getPageSize(pi)
      await exclusiveOp(async () => {
        await pdfEngine.removeMarkedContent(pi, OCR_LAYER_TAG)
        if (hasLayer) await pdfEngine.blankInvisibleText(pi, [[0, 0, size.width, size.height]])
        // addTextRun takes a bottom-left baseline; OCR boxes are top-left. The
        // baseline sits about four fifths of the way down the box, as the
        // export planner places visible replacements.
        const horizontal = items.filter(i => !i.vertical).map(i => ({
          x: i.rect.x,
          y: size.height - (i.rect.y + i.rect.height - Math.max(1, i.rect.height * 0.2)),
          text: i.text, fontSize: i.fontSize, fontName: 'Helvetica',
          invisible: true, fitWidth: i.rect.width
        }))
        if (horizontal.length) await pdfEngine.addTextRun(pi, horizontal, 0, OCR_LAYER_TAG)
        // A sideways run reads UP its box: it starts at the foot, baseline down
        // the right-hand side, the same geometry the visible bake uses.
        for (const v of items.filter(i => i.vertical)) {
          await pdfEngine.addTextRun(pi, [{
            x: v.rect.x + v.rect.width * 0.8, y: size.height - (v.rect.y + v.rect.height),
            text: v.text, fontSize: v.fontSize, fontName: 'Helvetica', invisible: true, fitWidth: v.rect.height
          }], 90, OCR_LAYER_TAG)
        }
      })
      changed = true
      p.layered++; p.done++
    }
    if (changed) {
      p.stage = 'Saving the document…'
      // The snapshot is the PRE-run bytes: the worker's document has changed,
      // the store's bytes have not until the sync below.
      pushUndo()
      docStore.markModified()
      await syncAfterEdit()
    }
  } catch (err: any) {
    editorStore.setStatus(`Recognition stopped: ${err?.message || err}`)
  } finally {
    stopProgress()
    p.running = false
  }
  const skipped: string[] = []
  if (why.text) skipped.push(`${why.text} with text already`)
  if (why.layer) skipped.push(`${why.layer} with a text layer already`)
  if (why.blank) skipped.push(`${why.blank} blank`)
  if (why.nothing) skipped.push(`${why.nothing} where nothing was read`)
  const tail = skipped.length ? ` — skipped ${skipped.join(', ')}` : ''
  editorStore.setStatus(p.layered
    ? `Text recognised on ${p.layered} page${p.layered === 1 ? '' : 's'}${recognizeCancel ? ' (stopped)' : ''}: the file is now searchable${tail}. Click a recognised line to edit it; Ctrl+Z undoes the whole run.`
    : `No page was recognised${tail}`)
}
function cancelRecognizeDocument() { recognizeCancel = true }
provide('recognizeDocument', recognizeDocument)
provide('cancelRecognizeDocument', cancelRecognizeDocument)
provide('recognizeProgress', recognizeProgress)
// For the sweep drivers (public/_sweep/*.js): a production build strips the
// Vue internals they used to walk to these, so they are put on window like
// __pdfEngine and __pdfViewer already are.
;(window as any).__pdfHooks = {
  ocrController: { isScanLike: isScanLikePage, recognise: (pageIndex: number) => runOcrNow(pageIndex, OCR_DEFAULT_LANG), busy: ocr.busy, settleRepairs: ocr.settleRepairs },
  bakeOcrEdits, runOcrOnPage, undo, redo, ocr, recognizeDocument, recognizeProgress
}
// The editing assistant is built HERE because every mutation it makes has to
// go through this layout's own plumbing (undo snapshot, save→reload, the
// page ops that act on the current page). The panel only renders it.
const assistant = createAssistant({
  pdfEngine, ocr,
  syncAfterEdit, pushUndo, forgetOcr,
  // The assistant reads runs by their text: it waits for the re-read to settle.
  recognise: async (pageIndex: number) => { await runOcrNow(pageIndex, OCR_DEFAULT_LANG); await ocr.settleRepairs() },
  isScanLike: isScanLikePage,
  undo, rotatePage, deletePage, duplicatePage, insertBlankPage, movePage,
  confirmCloud: () => new Promise<boolean>(resolve => {
    $q.dialog({
      title: 'Send the page text to OpenAI?',
      message: 'The assistant sends the text of the page you are on and your messages to OpenAI, using your API key. Nothing else leaves the machine.',
      ok: 'Send', cancel: true, persistent: true, dark: true
    }).onOk(() => resolve(true)).onCancel(() => resolve(false)).onDismiss(() => resolve(false))
  })
})
provide('assistant', assistant)
;(window as any).__pdfHooks.assistant = assistant
provide('openFile', openFile)
provide('openPdfFile', openPdfFile)
provide('mergePdfFile', mergePdfFile)
provide('saveFile', saveFile)
provide('printFile', printFile)
provide('undo', undo)
provide('redo', redo)
provide('rotatePage', rotatePage)
provide('insertFile', insertFile)
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

<style scoped>
/*
 * Off-screen, NOT hidden. `display:none`, `visibility:hidden` and a zero-size
 * box are the states a browser can refuse to open a file chooser from.
 */
.offscreen-file-input {
  position: fixed;
  left: -9999px;
  top: 0;
}
</style>
