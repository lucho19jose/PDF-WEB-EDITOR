<template>
  <div class="annot-layer-container" v-if="showLayer">
    <!-- Existing annotations: selectable / movable hit-targets (select mode) -->
    <template v-if="editorStore.currentTool === 'select'">
      <div
        v-for="a in scaledAnnots"
        :key="a.index"
        class="annot-hit"
        :class="{ selected: selectedIndex === a.index }"
        :style="a.style"
        :title="a.title"
        @mousedown.stop="onAnnotMouseDown($event, a.index)"
      />
      <!-- Delete button for selected annotation -->
      <div v-if="selectedAnnot" class="annot-delete" :style="deleteBtnStyle" @mousedown.prevent>
        <q-btn dense round size="xs" color="negative" icon="delete" @click.stop="deleteSelected">
          <q-tooltip>Delete annotation (Del)</q-tooltip>
        </q-btn>
      </div>
    </template>

    <!-- Capture surface for creating annotations -->
    <div
      v-if="editorStore.isAnnotationTool && !freeTextEditing"
      class="annot-capture"
      :style="{ cursor: captureCursor }"
      @mousedown.stop="onCaptureDown"
    />

    <!-- Rubber-band preview for rect/circle/markup -->
    <div v-if="drag && ['rectangle','circle','highlight','underline','strikeout'].includes(drag.tool)"
         class="annot-preview" :class="{ circle: drag.tool === 'circle', markup: isMarkupPreview }"
         :style="previewBoxStyle" />

    <!-- SVG preview for line + ink -->
    <svg v-if="drag && (drag.tool === 'line' || drag.tool === 'draw')" class="annot-svg">
      <line v-if="drag.tool === 'line'"
            :x1="drag.startSx" :y1="drag.startSy" :x2="drag.curSx" :y2="drag.curSy"
            :stroke="editorStore.strokeColor" :stroke-width="editorStore.strokeWidth" />
      <polyline v-if="drag.tool === 'draw'"
            :points="inkPreviewPoints" fill="none"
            :stroke="editorStore.strokeColor" :stroke-width="editorStore.strokeWidth"
            stroke-linecap="round" stroke-linejoin="round" />
    </svg>

    <!-- FreeText inline editor -->
    <div v-if="freeTextEditing" class="ft-editor-wrap" :style="freeTextStyle">
      <textarea
        ref="ftRef"
        v-model="freeTextValue"
        class="ft-editor"
        placeholder="Type text…"
        :style="{ color: editorStore.textColor, fontSize: ftFontPx + 'px' }"
        @keydown.escape.prevent="cancelFreeText"
        @keydown.enter.ctrl.prevent="commitFreeText"
      />
      <div class="ft-actions" @mousedown.prevent>
        <q-btn dense flat size="xs" color="positive" icon="check" @click.stop="commitFreeText" />
        <q-btn dense flat size="xs" color="negative" icon="close" @click.stop="cancelFreeText" />
      </div>
    </div>

    <input ref="imgInputRef" type="file" accept="image/png,image/jpeg,image/jpg" style="display:none" @change="onImagePicked" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, inject, onBeforeUnmount } from 'vue'
import { useQuasar } from 'quasar'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore, MARKUP_TOOLS, type Tool } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import type { usePDFEngine } from '@/composables/usePDFEngine'
import type { AnnotationInfo, Quad, Pt, RectT, MarkupType, ShapeType, TextChar } from '@/engine/types'
import { hexToRgb01, rgb01ToCss } from '@/utils/color'
import { enqueueOp } from '@/utils/opQueue'

const props = defineProps<{ pageWidth: number; pageHeight: number; pdfWidth: number; pdfHeight: number }>()
const emit = defineEmits<{ changed: [] }>()

const $q = useQuasar()
const docStore = useDocumentStore()
const editorStore = useEditorStore()
const historyStore = useHistoryStore()
const pdfEngine = inject<ReturnType<typeof usePDFEngine>>('pdfEngine')!

const annotations = ref<AnnotationInfo[]>([])
const selectedIndex = ref<number | null>(null)

interface DragState {
  tool: Tool
  startSx: number; startSy: number   // screen (relative to layer)
  curSx: number; curSy: number
  inkPts: Pt[]                        // page-space ink points
  moved: boolean
}
const drag = ref<DragState | null>(null)

// Move-existing-annotation drag
interface MoveState { index: number; startX: number; startY: number; dx: number; dy: number; moved: boolean; rect: RectT }
const moveState = ref<MoveState | null>(null)

// FreeText editing
const freeTextEditing = ref(false)
const freeTextValue = ref('')
const ftRect = ref<RectT>([0, 0, 0, 0])
const ftRef = ref<HTMLTextAreaElement | null>(null)
const imgInputRef = ref<HTMLInputElement | null>(null)

const scaleX = computed(() => props.pageWidth / props.pdfWidth)
const scaleY = computed(() => props.pageHeight / props.pdfHeight)
const showLayer = computed(() => editorStore.isAnnotationTool || editorStore.currentTool === 'select')
const isMarkupPreview = computed(() => !!drag.value && MARKUP_TOOLS.includes(drag.value.tool))
const ftFontPx = computed(() => editorStore.fontSize * scaleY.value)

const captureCursor = computed(() => {
  if (editorStore.currentTool === 'note') return 'pointer'
  if (editorStore.currentTool === 'image') return 'copy'
  return 'crosshair'
})

const selectedAnnot = computed(() => annotations.value.find(a => a.index === selectedIndex.value) || null)

// --- existing annotation rendering ---
const scaledAnnots = computed(() => annotations.value.map(a => {
  let r = a.rect
  if (moveState.value?.index === a.index && moveState.value.moved) {
    r = [r[0] + moveState.value.dx / scaleX.value, r[1] + moveState.value.dy / scaleY.value,
         r[2] + moveState.value.dx / scaleX.value, r[3] + moveState.value.dy / scaleY.value]
  }
  return {
    index: a.index,
    title: `${a.type}${a.contents ? ': ' + a.contents : ''}`,
    style: {
      left: `${r[0] * scaleX.value}px`,
      top: `${r[1] * scaleY.value}px`,
      width: `${Math.max(2, (r[2] - r[0]) * scaleX.value)}px`,
      height: `${Math.max(2, (r[3] - r[1]) * scaleY.value)}px`
    }
  }
}))

const deleteBtnStyle = computed(() => {
  const a = selectedAnnot.value
  if (!a) return {}
  return {
    left: `${a.rect[2] * scaleX.value + 4}px`,
    top: `${a.rect[1] * scaleY.value - 4}px`,
    position: 'absolute' as const, zIndex: 30, pointerEvents: 'auto' as const
  }
})

const previewBoxStyle = computed(() => {
  if (!drag.value) return {}
  const d = drag.value
  const left = Math.min(d.startSx, d.curSx)
  const top = Math.min(d.startSy, d.curSy)
  const w = Math.abs(d.curSx - d.startSx)
  const h = Math.abs(d.curSy - d.startSy)
  const color = isMarkupPreview.value ? editorStore.highlightColor : editorStore.strokeColor
  return {
    left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px`,
    borderColor: color,
    background: isMarkupPreview.value ? rgb01ToCss(hexToRgb01(color), 0.35) : 'transparent'
  }
})

const inkPreviewPoints = computed(() => {
  if (!drag.value) return ''
  return drag.value.inkPts.map(p => `${p[0] * scaleX.value},${p[1] * scaleY.value}`).join(' ')
})

const freeTextStyle = computed(() => ({
  left: `${ftRect.value[0] * scaleX.value}px`,
  top: `${ftRect.value[1] * scaleY.value}px`,
  width: `${Math.max(120, (ftRect.value[2] - ftRect.value[0]) * scaleX.value)}px`,
  minHeight: `${Math.max(30, (ftRect.value[3] - ftRect.value[1]) * scaleY.value)}px`
}))

// --- helpers ---
function pageCoords(e: MouseEvent): { sx: number; sy: number; px: number; py: number } {
  const layer = (e.currentTarget as HTMLElement).closest('.annot-layer-container') as HTMLElement
  const rect = layer.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  return { sx, sy, px: sx / scaleX.value, py: sy / scaleY.value }
}

function pushUndo() {
  if (docStore.pdfBytes) historyStore.pushSnapshot(new Uint8Array(docStore.pdfBytes))
}

async function loadAnnotations() {
  if (!pdfEngine.isReady.value || !pdfEngine.docLoaded.value || !docStore.loaded) { annotations.value = []; return }
  try {
    annotations.value = await pdfEngine.getAnnotations(docStore.currentPage - 1)
  } catch { annotations.value = [] }
}

// --- creation ---
function onCaptureDown(e: MouseEvent) {
  const tool = editorStore.currentTool
  const { sx, sy, px, py } = pageCoords(e)

  if (tool === 'image') { imgInputRef.value?.click(); return }
  if (tool === 'note') { placeNote(px, py); return }

  drag.value = { tool, startSx: sx, startSy: sy, curSx: sx, curSy: sy, inkPts: [[px, py]], moved: false }
  window.addEventListener('mousemove', onCaptureMove)
  window.addEventListener('mouseup', onCaptureUp)
}

function onCaptureMove(e: MouseEvent) {
  if (!drag.value) return
  const layer = document.querySelector('.annot-layer-container') as HTMLElement
  if (!layer) return
  const rect = layer.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  drag.value.curSx = sx
  drag.value.curSy = sy
  if (Math.abs(sx - drag.value.startSx) > 2 || Math.abs(sy - drag.value.startSy) > 2) drag.value.moved = true
  if (drag.value.tool === 'draw') drag.value.inkPts.push([sx / scaleX.value, sy / scaleY.value])
}

async function onCaptureUp() {
  window.removeEventListener('mousemove', onCaptureMove)
  window.removeEventListener('mouseup', onCaptureUp)
  const d = drag.value
  if (!d) return
  drag.value = null

  const pageIndex = docStore.currentPage - 1
  const x0 = Math.min(d.startSx, d.curSx) / scaleX.value
  const y0 = Math.min(d.startSy, d.curSy) / scaleY.value
  const x1 = Math.max(d.startSx, d.curSx) / scaleX.value
  const y1 = Math.max(d.startSy, d.curSy) / scaleY.value
  const rectPage: RectT = [x0, y0, x1, y1]

  // Ignore tiny accidental drags (except draw/note)
  if (d.tool !== 'draw' && (x1 - x0 < 3 && y1 - y0 < 3)) {
    if (d.tool === 'freetext') { openFreeText([x0, y0, x0 + 180 / scaleX.value, y0 + 40 / scaleY.value]) }
    return
  }

  try {
    if (MARKUP_TOOLS.includes(d.tool)) {
      const markupMap: Record<string, MarkupType> = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut' }
      await applyMarkup(pageIndex, markupMap[d.tool] || 'Highlight', rectPage)
    } else if (d.tool === 'rectangle' || d.tool === 'circle') {
      const shape: ShapeType = d.tool === 'rectangle' ? 'Square' : 'Circle'
      await annotOp(`${shape} added`, () => pdfEngine.addShape(pageIndex, shape, {
        rect: rectPage,
        color: hexToRgb01(editorStore.strokeColor),
        interiorColor: editorStore.fillEnabled ? hexToRgb01(editorStore.fillColor) : null,
        width: editorStore.strokeWidth,
        opacity: editorStore.opacity
      }))
    } else if (d.tool === 'line') {
      const a: Pt = [d.startSx / scaleX.value, d.startSy / scaleY.value]
      const b: Pt = [d.curSx / scaleX.value, d.curSy / scaleY.value]
      await annotOp('Line added', () => pdfEngine.addShape(pageIndex, 'Line', {
        points: [a, b], color: hexToRgb01(editorStore.strokeColor),
        width: editorStore.strokeWidth, opacity: editorStore.opacity
      }))
    } else if (d.tool === 'draw') {
      if (d.inkPts.length < 2) return
      // Deep-clone to plain arrays — d.inkPts is a Vue reactive proxy that cannot be postMessage-cloned.
      const stroke: Pt[] = d.inkPts.map(p => [p[0], p[1]] as Pt)
      await annotOp('Drawing added', () => pdfEngine.addInk(pageIndex, [stroke], hexToRgb01(editorStore.strokeColor), editorStore.strokeWidth, editorStore.opacity))
    } else if (d.tool === 'freetext') {
      openFreeText(rectPage)
    }
  } catch (err: any) {
    editorStore.setStatus(`Error: ${err.message}`)
  }
}

async function applyMarkup(pageIndex: number, markup: MarkupType, rectPage: RectT) {
  const blocks = await pdfEngine.getTextBlocks(pageIndex)
  const chars: TextChar[] = []
  for (const b of blocks) chars.push(...b.chars)
  const quads = computeMarkupQuads(rectPage, chars)
  if (quads.length === 0) {
    editorStore.setStatus('No text found in selection')
    return
  }
  const color = hexToRgb01(markup === 'Highlight' ? editorStore.highlightColor : editorStore.strokeColor)
  await annotOp(`${markup} added`, () => pdfEngine.addTextMarkup(pageIndex, markup, quads, color, editorStore.opacity))
}

/** Select chars whose center is inside the drag rect, group into per-line quads. */
function computeMarkupQuads(rect: RectT, chars: TextChar[]): Quad[] {
  const [rx0, ry0, rx1, ry1] = rect
  const pad = 3
  const inside = chars.filter(c => {
    const cx = (c.quad[0] + c.quad[2]) / 2
    const top = Math.min(c.quad[1], c.quad[3])
    const bot = Math.max(c.quad[5], c.quad[7])
    // char's vertical span overlaps the (padded) drag band, and its center-x is within the drag
    const vOverlap = bot >= ry0 - pad && top <= ry1 + pad
    return cx >= rx0 && cx <= rx1 && vOverlap && c.c.trim().length > 0
  })
  if (inside.length === 0) return []
  // group by line (rounded baseline / top)
  const lines = new Map<number, TextChar[]>()
  for (const c of inside) {
    const key = Math.round(c.origin[1])
    if (!lines.has(key)) lines.set(key, [])
    lines.get(key)!.push(c)
  }
  const quads: Quad[] = []
  for (const lineChars of lines.values()) {
    let minX = Infinity, maxX = -Infinity, top = Infinity, bottom = -Infinity
    for (const c of lineChars) {
      minX = Math.min(minX, c.quad[0], c.quad[4])
      maxX = Math.max(maxX, c.quad[2], c.quad[6])
      top = Math.min(top, c.quad[1], c.quad[3])
      bottom = Math.max(bottom, c.quad[5], c.quad[7])
    }
    quads.push([minX, top, maxX, top, minX, bottom, maxX, bottom])
  }
  return quads
}

function placeNote(px: number, py: number) {
  $q.dialog({
    title: 'Sticky note',
    message: 'Note text:',
    prompt: { model: '', type: 'textarea' },
    cancel: true,
    dark: true
  }).onOk(async (text: string) => {
    await annotOp('Note added', () => pdfEngine.addStickyNote(docStore.currentPage - 1, px, py, text || '', hexToRgb01(editorStore.highlightColor)))
  })
}

// --- FreeText ---
function openFreeText(rect: RectT) {
  ftRect.value = rect
  freeTextValue.value = ''
  freeTextEditing.value = true
  nextTick(() => ftRef.value?.focus())
}
async function commitFreeText() {
  // Read from the DOM element directly (source of truth) to avoid v-model sync edge cases.
  const text = ftRef.value?.value ?? freeTextValue.value
  freeTextEditing.value = false
  if (!text.trim()) return
  const pageIndex = docStore.currentPage - 1
  const rect = [...ftRect.value] as RectT
  await annotOp('Text box added', () => pdfEngine.addFreeText(pageIndex, rect, text, editorStore.fontSize, hexToRgb01(editorStore.textColor)))
}
function cancelFreeText() { freeTextEditing.value = false; freeTextValue.value = '' }

// --- Image ---
async function onImagePicked(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const buf = await file.arrayBuffer()
  // place a default-sized image near top-left of the visible page
  const w = Math.min(props.pdfWidth * 0.4, 250)
  const aspect = await imgAspect(file)
  const h = w / aspect
  const x = props.pdfWidth * 0.1
  const y = props.pdfHeight * 0.1
  await annotOp('Image inserted', () => pdfEngine.addImageStamp(docStore.currentPage - 1, [x, y, x + w, y + h], buf))
  ;(e.target as HTMLInputElement).value = ''
}
function imgAspect(file: File): Promise<number> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { resolve(img.width / img.height || 1); URL.revokeObjectURL(url) }
    img.onerror = () => { resolve(1); URL.revokeObjectURL(url) }
    img.src = url
  })
}

/**
 * Run an annotation mutation through the global op queue: the engine call and
 * the undo snapshot execute only after any in-flight save→reload cycle has
 * finished, so the op can't be silently discarded by a concurrent document
 * reload and the snapshot reads the true pre-edit bytes.
 */
async function annotOp(msg: string, mutate: () => Promise<boolean>) {
  await enqueueOp(async () => {
    const ok = await mutate()
    if (ok) {
      // Snapshot the pre-edit bytes ONLY on success (docStore.pdfBytes is still the
      // pre-edit state until emit('changed') -> onTextChanged reloads it). This avoids
      // polluting undo/redo history when an annotation op fails.
      pushUndo()
      docStore.markModified()
      editorStore.setStatus(msg)
      emit('changed')
      await loadAnnotations()
    } else {
      editorStore.setStatus(`Failed: ${pdfEngine.error.value || 'unknown error'}`)
    }
  })
}

// --- select / move / delete existing annotations ---
function onAnnotMouseDown(e: MouseEvent, index: number) {
  selectedIndex.value = index
  const a = annotations.value.find(x => x.index === index)
  if (!a) return
  moveState.value = { index, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, moved: false, rect: a.rect }
  window.addEventListener('mousemove', onMoveMove)
  window.addEventListener('mouseup', onMoveUp)
}
function onMoveMove(e: MouseEvent) {
  if (!moveState.value) return
  moveState.value.dx = e.clientX - moveState.value.startX
  moveState.value.dy = e.clientY - moveState.value.startY
  if (Math.abs(moveState.value.dx) > 2 || Math.abs(moveState.value.dy) > 2) moveState.value.moved = true
}
async function onMoveUp() {
  window.removeEventListener('mousemove', onMoveMove)
  window.removeEventListener('mouseup', onMoveUp)
  const m = moveState.value
  moveState.value = null
  if (!m || !m.moved) return
  const dxP = m.dx / scaleX.value
  const dyP = m.dy / scaleY.value
  const newRect: RectT = [m.rect[0] + dxP, m.rect[1] + dyP, m.rect[2] + dxP, m.rect[3] + dyP]
  await annotOp('Annotation moved', () => pdfEngine.updateAnnotation(docStore.currentPage - 1, m.index, { rect: newRect }))
}

async function deleteSelected() {
  if (selectedIndex.value === null) return
  const idx = selectedIndex.value
  selectedIndex.value = null
  await annotOp('Annotation deleted', () => pdfEngine.deleteAnnotation(docStore.currentPage - 1, idx))
}

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented) return // TextBlockOverlay already consumed this Delete
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIndex.value !== null && editorStore.currentTool === 'select') {
    e.preventDefault()
    deleteSelected()
  }
}

// --- lifecycle ---
watch(() => editorStore.currentTool, () => {
  selectedIndex.value = null
  cancelFreeText()
  if (showLayer.value) loadAnnotations()
})
watch(() => docStore.currentPage, () => {
  selectedIndex.value = null
  cancelFreeText() // an open freetext editor must not commit onto the NEW page
  loadAnnotations()
})
watch(() => docStore.renderVersion, () => loadAnnotations())
watch(showLayer, (v) => { if (v) loadAnnotations() }, { immediate: true })

window.addEventListener('keydown', onKeyDown)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('mousemove', onCaptureMove)
  window.removeEventListener('mouseup', onCaptureUp)
  window.removeEventListener('mousemove', onMoveMove)
  window.removeEventListener('mouseup', onMoveUp)
})

defineExpose({ loadAnnotations, deleteSelected })
</script>

<style scoped>
.annot-layer-container {
  position: absolute; inset: 0; width: 100%; height: 100%;
  pointer-events: none;
}
.annot-capture {
  position: absolute; inset: 0; pointer-events: auto; z-index: 15;
}
.annot-hit {
  position: absolute; pointer-events: auto; z-index: 16;
  border: 1px solid transparent; box-sizing: border-box; cursor: move;
}
.annot-hit:hover { border-color: rgba(66,133,244,0.6); background: rgba(66,133,244,0.05); }
.annot-hit.selected { border: 1.5px solid #4285f4; background: rgba(66,133,244,0.08); }
.annot-preview {
  position: absolute; border: 2px solid; box-sizing: border-box; z-index: 17; pointer-events: none;
}
.annot-preview.circle { border-radius: 50%; }
.annot-preview.markup { border-style: none; }
.annot-svg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 17; pointer-events: none; overflow: visible; }
.annot-delete { }
.ft-editor-wrap { position: absolute; z-index: 20; pointer-events: auto; display: flex; flex-direction: column; }
.ft-editor {
  width: 100%; border: 1.5px solid #e53935; background: rgba(255,255,255,0.97);
  padding: 2px 4px; outline: none; resize: both; font-family: Helvetica, Arial, sans-serif; line-height: 1.2;
}
.ft-actions { display: flex; justify-content: flex-end; gap: 2px; background: rgba(50,50,50,0.9); border-radius: 0 0 4px 4px; padding: 1px; }
</style>
