<template>
  <!--
    The editable layer for a scanned page.

    It sits OVER the rendered scan and never replaces it. The page underneath
    keeps its tables, rules, signatures, stamps, logos and letterhead exactly as
    they were photographed — rebuilding a page from what OCR recognised would
    throw all of that away, and OCR only ever recognises the words.

    A run the user has edited is drawn here on an opaque patch the colour of the
    paper around it, so what is on screen is what export will produce.
  -->
  <div v-if="visible" class="ocr-layer">
    <!--
      The paper patch sits where the INK is, which stops being where the run is
      the moment it is dragged. Drawn as its own element in the layer for that
      reason: nested inside the run's box it travelled with it, covering the
      paper the words had moved ONTO and leaving the photographed words showing
      — so they appeared twice, once in the scan and once as the replacement.
    -->
    <div
      v-for="p in patches"
      :key="p.id"
      class="ocr-patch-holder"
      :style="p.holderStyle"
    >
      <div class="ocr-patch" :style="p.patchStyle" />
    </div>

    <div
      v-for="item in scaled"
      :key="item.id"
      class="ocr-item"
      :class="{
        selected: item.id === ocrStore.selectedId,
        edited: item.edited,
        removed: item.removed,
        unsure: item.confidence < 70,
        vertical: item.vertical
      }"
      :style="item.boxStyle"
      :title="item.tooltip"
      @mousedown.stop="onDown($event, item.id)"
      @dblclick.stop="beginEdit(item.id)"
    >
      <div v-if="item.edited" class="ocr-replacement" :style="item.textStyle">{{ item.text }}</div>
    </div>

    <!-- In-place editor, positioned and turned the same way as its run. -->
    <textarea
      v-if="editing"
      ref="editorRef"
      v-model="draft"
      class="ocr-editor"
      :style="editorStyle"
      @keydown.escape.prevent="cancelEdit"
      @keydown.enter.exact.prevent="commitEdit"
      @blur="commitEdit"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useOcrStore } from '@/stores/ocr'
import { rgb01ToCss } from '@/utils/color'
import type { OcrTextItem, OcrRect } from '@/utils/ocr/ocrTypes'

const props = defineProps<{
  pageWidth: number
  pageHeight: number
  pdfWidth: number
  pdfHeight: number
}>()

const docStore = useDocumentStore()
const ocrStore = useOcrStore()

const scaleX = computed(() => props.pageWidth / props.pdfWidth)
const scaleY = computed(() => props.pageHeight / props.pdfHeight)
const pageIndex = computed(() => docStore.currentPage - 1)
const visible = computed(() => ocrStore.layerVisible && ocrStore.itemsFor(pageIndex.value).length > 0)

const editing = ref<string | null>(null)
const draft = ref('')
const editorRef = ref<HTMLTextAreaElement | null>(null)

/**
 * CSS for one run, in screen pixels.
 *
 * A vertical run is laid out in its OWN frame and then turned, rather than
 * being drawn upright inside a tall box: the text has to read up the page, and
 * a rotated element is the only way the letters, the caret and the selection
 * all follow it. The element is anchored at the FOOT of the box because a
 * quarter turn anti-clockwise about the top-left corner sends it upwards from
 * there, which lands it exactly over the box it belongs to.
 */
function styleFor(item: OcrTextItem, box: OcrRect = item.rect) {
  if (item.vertical) {
    return {
      left: `${box.x * scaleX.value}px`,
      top: `${(box.y + box.height) * scaleY.value}px`,
      width: `${box.height * scaleY.value}px`,
      height: `${box.width * scaleX.value}px`,
      transform: 'rotate(-90deg)',
      transformOrigin: 'left top'
    }
  }
  return {
    left: `${box.x * scaleX.value}px`,
    top: `${box.y * scaleY.value}px`,
    width: `${box.width * scaleX.value}px`,
    height: `${box.height * scaleY.value}px`,
    transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined,
    transformOrigin: 'left top'
  }
}

/** The size of a run ACROSS its reading direction — its line height. */
function acrossPx(item: OcrTextItem, box: OcrRect = item.rect): number {
  return item.vertical ? box.width * scaleX.value : box.height * scaleY.value
}

/**
 * Where the paper has to be painted, for every run the user changed.
 *
 * Built from `inkRect` — where the scan's own words are — and never from the
 * run's current box, which follows a drag.
 */
const patches = computed(() =>
  ocrStore.itemsFor(pageIndex.value)
    .filter(item => item.edited || item.removed)
    .map(item => {
      const ink = item.inkRect ?? item.rect
      return {
        id: item.id,
        holderStyle: styleFor(item, ink),
        // Grown slightly: anti-aliased glyph edges reach a little past the box
        // OCR reports, and a patch flush with it leaves a grey fringe. The
        // padding is in the ELEMENT's frame, so it follows a rotated run round.
        patchStyle: {
          background: rgb01ToCss(item.background),
          inset: `${-Math.max(1, acrossPx(item, ink) * 0.08)}px ${-2 * scaleX.value}px`
        }
      }
    })
)

const scaled = computed(() =>
  ocrStore.itemsFor(pageIndex.value).map(item => ({
    id: item.id,
    text: item.text,
    edited: item.edited,
    removed: item.removed,
    vertical: item.vertical,
    confidence: item.confidence,
    boxStyle: styleFor(item),
    textStyle: {
      fontSize: `${item.fontSize * scaleY.value}px`,
      fontFamily: cssFamily(item.fontFamily),
      fontWeight: item.bold ? '700' : '400',
      fontStyle: item.italic ? 'italic' : 'normal',
      color: rgb01ToCss(item.color),
      textAlign: item.align,
      justifyContent: item.align === 'center' ? 'center' : item.align === 'right' ? 'flex-end' : 'flex-start'
    },
    tooltip: item.removed
      ? 'Deleted — it will be painted out on export'
      : `${item.confidence}% confident · ${item.fontSize}pt` +
        `${item.bold ? ' · bold' : ''}${item.italic ? ' · italic' : ''}` +
        `${item.vertical ? ' · sideways' : ''} · click again to edit, drag to move`
  }))
)

/** The base-14 names the model uses, mapped to something a browser can render. */
function cssFamily(family: string): string {
  if (family.startsWith('Times')) return 'Times New Roman, Times, serif'
  if (family.startsWith('Courier')) return 'Courier New, Courier, monospace'
  return 'Helvetica, Arial, sans-serif'
}

/**
 * The editor is given room to be READ IN, not just the box OCR measured.
 *
 * A recognition box hugs the ink, so a short cell is a few pixels high: a run
 * set at 17px arrived in a 13px slot, its own text clipped top and bottom, with
 * nowhere to put another word. The box is the right PLACE to edit, not the right
 * size. It keeps its origin, its type and its colours — so it still reads as
 * editing in place — and grows to at least a comfortable line, along the
 * reading direction and across it. The element's `width` is always the reading
 * direction, sideways runs included, so one pair of minimums covers both.
 */
const editorStyle = computed(() => {
  const item = ocrStore.itemsFor(pageIndex.value).find(i => i.id === editing.value)
  if (!item) return {}
  const base = styleFor(item)
  const fs = item.fontSize * scaleY.value
  const minAlong = Math.max(160, fs * 10, draft.value.length * fs * 0.62)
  const minAcross = fs * 1.6 + 8
  return {
    ...base,
    width: `max(${base.width}, ${Math.round(minAlong)}px)`,
    height: `max(${base.height}, ${Math.round(minAcross)}px)`,
    fontSize: `${item.fontSize * scaleY.value}px`,
    fontFamily: cssFamily(item.fontFamily),
    fontWeight: item.bold ? '700' : '400',
    fontStyle: item.italic ? 'italic' : 'normal',
    color: rgb01ToCss(item.color),
    textAlign: item.align,
    background: rgb01ToCss(item.background)
  }
})

/**
 * Click to select; click the SELECTED run again to edit it.
 *
 * Double-click still works and is still the tooltip's advice, but it should not
 * be the only way in: it makes the reader hit a target a few pixels high twice
 * inside the system's double-click time, and the wait for the second click is
 * felt as the editor being slow to open — it is not, it opens in about ten
 * milliseconds once asked. Editing on the second single click asks it sooner and
 * costs nothing: a drag still moves the run, because the editor only opens when
 * the mouse came back up without having moved.
 */
function onDown(e: MouseEvent, id: string) {
  const wasSelected = ocrStore.selectedId === id && editing.value !== id
  ocrStore.selectedId = id
  startDrag(e, id, wasSelected)
}

// ── Moving a run ──
interface DragState {
  id: string; startX: number; startY: number; ox: number; oy: number
  moved: boolean
  /** Open the editor if this press turns out to be a click, not a drag. */
  editOnClick: boolean
}
let drag: DragState | null = null

function startDrag(e: MouseEvent, id: string, editOnClick = false) {
  const item = ocrStore.itemsFor(pageIndex.value).find(i => i.id === id)
  if (!item) return
  drag = {
    id, startX: e.clientX, startY: e.clientY,
    ox: item.rect.x, oy: item.rect.y, moved: false, editOnClick
  }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
}

function onDragMove(e: MouseEvent) {
  if (!drag) return
  const dx = (e.clientX - drag.startX) / scaleX.value
  const dy = (e.clientY - drag.startY) / scaleY.value
  // A page not yet measured gives a zero scale and a delta of Infinity or NaN.
  // Writing that into the rect loses the run for good: it has no position left
  // to draw at, to patch out, or to drag back.
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
  if (!drag.moved && Math.abs(dx) * scaleX.value < 3 && Math.abs(dy) * scaleY.value < 3) return
  drag.moved = true
  const item = ocrStore.itemsFor(pageIndex.value).find(i => i.id === drag!.id)
  if (!item) return
  ocrStore.updateItem(drag.id, { rect: { ...item.rect, x: drag.ox + dx, y: drag.oy + dy } })
}

function onDragEnd() {
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  const finished = drag
  drag = null
  if (finished && !finished.moved && finished.editOnClick) beginEdit(finished.id)
}

// ── Editing the words ──
function beginEdit(id: string) {
  const item = ocrStore.itemsFor(pageIndex.value).find(i => i.id === id)
  if (!item || item.removed) return
  ocrStore.selectedId = id
  editing.value = id
  draft.value = item.text
  nextTick(() => {
    const el = editorRef.value
    if (!el) return
    // Selected backwards, so the view lands on the START of the run rather than
    // on its last word — see the same fix in TextBlockOverlay.
    el.focus({ preventScroll: true })
    el.setSelectionRange(0, el.value.length, 'backward')
    el.scrollLeft = 0
    el.scrollTop = 0
  })
}

function commitEdit() {
  if (!editing.value) return
  const id = editing.value
  editing.value = null
  ocrStore.updateItem(id, { text: draft.value.replace(/\s+/g, ' ').trim() })
}

function cancelEdit() {
  editing.value = null
}

/** An open editor must not follow the user to another page. */
watch(pageIndex, () => { editing.value = null })

defineExpose({ beginEdit })
</script>

<style scoped>
.ocr-layer {
  position: absolute; inset: 0; width: 100%; height: 100%;
  pointer-events: none; z-index: 12;
}
.ocr-item {
  position: absolute; pointer-events: auto; cursor: text;
  border: 1px dashed rgba(66, 133, 244, 0.45);
  box-sizing: border-box;
}
.ocr-item:hover { border-color: rgba(66, 133, 244, 0.9); background: rgba(66, 133, 244, 0.07); }
.ocr-item.selected { border: 1.5px solid #4285f4; background: rgba(66, 133, 244, 0.10); }
/* Low confidence is worth seeing: it is where a reader should check the words. */
.ocr-item.unsure { border-color: rgba(251, 140, 0, 0.75); }
.ocr-item.removed { border-style: dotted; border-color: rgba(229, 57, 53, 0.8); }
/* Sideways runs are worth telling apart at a glance — they were read by a
   separate, more speculative pass and are the ones most worth checking. */
.ocr-item.vertical { border-color: rgba(156, 39, 176, 0.65); border-style: dashed; }
.ocr-item.vertical.selected { border-color: #9c27b0; }
.ocr-patch-holder { position: absolute; pointer-events: none; z-index: 0; }
.ocr-patch { position: absolute; inset: 0; }
.ocr-replacement {
  position: absolute; inset: 0; z-index: 1;
  display: flex; align-items: center;
  white-space: pre; line-height: 1;
  overflow: visible;
}
.ocr-editor {
  position: absolute; z-index: 25; pointer-events: auto;
  border: 1.5px solid #4285f4; outline: none; resize: none;
  padding: 0 1px; line-height: 1.05; overflow: hidden;
}
</style>
