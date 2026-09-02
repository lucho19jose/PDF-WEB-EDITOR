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
import { planOcrExport } from '@/utils/ocr/ocrExport'
import { usePDFViewer } from '@/composables/usePDFViewer'
import { usePDFEngine } from '@/composables/usePDFEngine'
import { getMuPDFBridge } from '@/engine/bridge'
import { enqueueOp, settleTransactions, transactionOpen } from '@/utils/opQueue'
import MainToolbar from '@/components/toolbar/MainToolbar.vue'
import PageThumbnails from '@/components/sidebar/PageThumbnails.vue'
import StatusBar from '@/components/common/StatusBar.vue'
import FindBar from '@/components/toolbar/FindBar.vue'

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
  let chars = 0
  try {
    const blocks = await pdfEngine.getTextBlocks(pageIndex)
    chars = blocks.reduce((n, b) => n + b.text.trim().length, 0)
  } catch (_) { /* unreadable text layer counts as none */ }

  const verdict = ocr.judgeScanned(chars)
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
async function isScanLikePage(pageIndex: number): Promise<boolean> {
  const cached = ocrStore.scanVerdicts.get(pageIndex)
  if (cached !== undefined) return cached
  let verdict = false
  try {
    const blocks = await pdfEngine.getTextBlocks(pageIndex)
    const chars = blocks.reduce((n, b) => n + b.text.trim().length, 0)
    if (ocr.judgeScanned(chars).scanned) {
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
 * What the editing layers need in order to recognise a scan on a click:
 * the verdict, the runner (no "already has text" dialog — the caller has
 * proved the page is a scan) and whether one is already running.
 */
provide('ocrController', {
  isScanLike: isScanLikePage,
  recognise: (pageIndex: number) => runOcrNow(pageIndex, OCR_DEFAULT_LANG),
  busy: ocr.busy
})

async function runOcrNow(pageIndex: number, lang: string) {
  const size = await pdfEngine.getPageSize(pageIndex).catch(() => ({ width: 612, height: 792 }))
  editorStore.setStatus('Recognising text on this page...')

  // OCR reads its own render of THIS page at its own resolution. The visible
  // canvas will not do: in continuous scroll the first `canvas.pdf-canvas` in
  // the document is page 1's whatever page is current, and page 2's OCR came
  // back reading page 1.
  const canvas = await pdfViewer.renderPageToCanvas(pageIndex + 1, OCR_RENDER_SCALE).catch(() => null)
  if (!canvas) { editorStore.setStatus('The page could not be rendered for recognition'); return }

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
  try {
    result = await ocr.recognizePage(canvas, pageIndex, size.width, size.height, lang, true, engineId)
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
    : `${result.items.length} text areas detected${by}${sideways} — ${result.confidence}% average confidence${note}. Click one to select it, click again to edit, drag to move.`)
}

/**
 * Write the edited OCR runs into the document.
 *
 * Run just before saving, so what is exported matches what is on screen. Each
 * edited area becomes a filled rectangle in the colour of its surrounding paper
 * plus the new text on top; everything else on the page is left completely
 * alone, which is what preserves the scan.
 */
async function bakeOcrEdits(): Promise<number> {
  if (!ocrStore.hasEdits) return 0
  let written = 0

  for (const [pageIndex, page] of ocrStore.pages) {
    // The page's traced scan faces — one per style — embedded once per bake
    // so the runs that name them draw with the document's own glyphs.
    const registered = new Set<string>()
    for (const face of ocr.facesOf(pageIndex)) {
      if (!face.bytes) continue
      const ok = await pdfEngine.registerFace(face.familyName, face.bytes.slice(0)).catch(() => false)
      if (ok) registered.add(face.familyName)
    }
    const plan = planOcrExport(page.items, item => {
      const face = ocr.faceOf(pageIndex, styleKeyOf(item))
      return face && registered.has(face.familyName) ? face.familyName : undefined
    })
    if (plan.patches.length === 0 && plan.texts.length === 0) continue

    await exclusiveOp(async () => {
      // Into the content stream, not as an annotation: annotations paint over
      // page content whatever order they were made in, so a patch drawn as one
      // covered the replacement text and it came out with its start missing.
      for (const patch of plan.patches) {
        await pdfEngine.fillRect(pageIndex, patch.rect, patch.color)
      }
      for (const t of plan.texts) {
        // addText takes a bottom-left origin baseline; OCR works top-left.
        await pdfEngine.addText(pageIndex, t.x, page.pageHeight - t.y, t.text, t.fontSize, t.fontName, t.color, t.rotation, t.faceId)
        written++
      }
    })
  }

  if (written > 0 || ocrStore.hasEdits) {
    docStore.markModified()
    await syncAfterEdit()
    // The runs are in the document now; drawing them again on the next save
    // would stack a second copy on the first.
    for (const [, page] of ocrStore.pages) {
      for (const item of page.items) { item.edited = false; item.removed = false; item.originalText = item.text }
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
    editorStore.setStatus(`${name} — ${pageCount} pages (ready)`)
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
  if (docStore.pdfBytes) historyStore.pushSnapshot(new Uint8Array(docStore.pdfBytes))
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
    if (docStore.pdfBytes) historyStore.pushRedo(new Uint8Array(docStore.pdfBytes))
    const snapshot = historyStore.popUndo()!
    // ENGINE first, viewer second. reloadDocument bumps renderVersion (via
    // reloadBytes), and that bump is the ONLY signal the overlays get — undo
    // has no explicit re-fetch the way annotOp does. With the viewer first,
    // every overlay watcher fetched from a worker still holding the pre-undo
    // document and kept the stale answer forever: the canvas showed the
    // signature back in place while its hit target stayed where the undone
    // move had put it.
    await pdfEngine.loadDocument(snapshot.buffer.slice(0) as ArrayBuffer)
    await pdfViewer.reloadDocument(snapshot)
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
    if (docStore.pdfBytes) historyStore.pushUndoNoClear(new Uint8Array(docStore.pdfBytes))
    const snapshot = historyStore.popRedo()!
    // Engine before viewer — same reason as undo above.
    await pdfEngine.loadDocument(snapshot.buffer.slice(0) as ArrayBuffer)
    await pdfViewer.reloadDocument(snapshot)
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
provide('bakeOcrEdits', bakeOcrEdits)
// For the sweep drivers (public/_sweep/*.js): a production build strips the
// Vue internals they used to walk to these, so they are put on window like
// __pdfEngine and __pdfViewer already are.
;(window as any).__pdfHooks = {
  ocrController: { isScanLike: isScanLikePage, recognise: (pageIndex: number) => runOcrNow(pageIndex, OCR_DEFAULT_LANG), busy: ocr.busy },
  bakeOcrEdits, runOcrOnPage, undo, redo, ocr
}
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
