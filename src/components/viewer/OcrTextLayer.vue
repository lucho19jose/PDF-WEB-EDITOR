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
      <!-- Painted over the scan only where the user changed something. -->
      <div v-if="item.edited || item.removed" class="ocr-patch" :style="item.patchStyle" />
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
import type { OcrTextItem } from '@/utils/ocr/ocrTypes'

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
function styleFor(item: OcrTextItem) {
  if (item.vertical) {
    return {
      left: `${item.rect.x * scaleX.value}px`,
      top: `${(item.rect.y + item.rect.height) * scaleY.value}px`,
      width: `${item.rect.height * scaleY.value}px`,
      height: `${item.rect.width * scaleX.value}px`,
      transform: 'rotate(-90deg)',
      transformOrigin: 'left top'
    }
  }
  return {
    left: `${item.rect.x * scaleX.value}px`,
    top: `${item.rect.y * scaleY.value}px`,
    width: `${item.rect.width * scaleX.value}px`,
    height: `${item.rect.height * scaleY.value}px`,
    transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined,
    transformOrigin: 'left top'
  }
}

/** The size of a run ACROSS its reading direction — its line height. */
function acrossPx(item: OcrTextItem): number {
  return item.vertical ? item.rect.width * scaleX.value : item.rect.height * scaleY.value
}

const scaled = computed(() =>
  ocrStore.itemsFor(pageIndex.value).map(item => ({
    id: item.id,
    text: item.text,
    edited: item.edited,
    removed: item.removed,
    vertical: item.vertical,
    confidence: item.confidence,
    boxStyle: styleFor(item),
    // The patch is grown slightly: anti-aliased glyph edges reach a little past
    // the box OCR reports, and a patch flush with it leaves a grey fringe. The
    // padding is in the ELEMENT's frame, so it follows a rotated run round.
    patchStyle: {
      background: rgb01ToCss(item.background),
      inset: `${-Math.max(1, acrossPx(item) * 0.08)}px ${-2 * scaleX.value}px`
    },
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
        `${item.vertical ? ' · sideways' : ''} · double-click to edit`
  }))
)

/** The base-14 names the model uses, mapped to something a browser can render. */
function cssFamily(family: string): string {
  if (family.startsWith('Times')) return 'Times New Roman, Times, serif'
  if (family.startsWith('Courier')) return 'Courier New, Courier, monospace'
  return 'Helvetica, Arial, sans-serif'
}

const editorStyle = computed(() => {
  const item = ocrStore.itemsFor(pageIndex.value).find(i => i.id === editing.value)
  if (!item) return {}
  return {
    ...styleFor(item),
    fontSize: `${item.fontSize * scaleY.value}px`,
    fontFamily: cssFamily(item.fontFamily),
    fontWeight: item.bold ? '700' : '400',
    fontStyle: item.italic ? 'italic' : 'normal',
    color: rgb01ToCss(item.color),
    textAlign: item.align,
    background: rgb01ToCss(item.background)
  }
})

function onDown(e: MouseEvent, id: string) {
  ocrStore.selectedId = id
  startDrag(e, id)
}

// ── Moving a run ──
interface DragState { id: string; startX: number; startY: number; ox: number; oy: number; moved: boolean }
let drag: DragState | null = null

function startDrag(e: MouseEvent, id: string) {
  const item = ocrStore.itemsFor(pageIndex.value).find(i => i.id === id)
  if (!item) return
  drag = { id, startX: e.clientX, startY: e.clientY, ox: item.rect.x, oy: item.rect.y, moved: false }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
}

function onDragMove(e: MouseEvent) {
  if (!drag) return
  const dx = (e.clientX - drag.startX) / scaleX.value
  const dy = (e.clientY - drag.startY) / scaleY.value
  if (!drag.moved && Math.abs(dx) * scaleX.value < 3 && Math.abs(dy) * scaleY.value < 3) return
  drag.moved = true
  const item = ocrStore.itemsFor(pageIndex.value).find(i => i.id === drag!.id)
  if (!item) return
  ocrStore.updateItem(drag.id, { rect: { ...item.rect, x: drag.ox + dx, y: drag.oy + dy } })
}

function onDragEnd() {
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  drag = null
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
.ocr-patch { position: absolute; z-index: 0; }
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
