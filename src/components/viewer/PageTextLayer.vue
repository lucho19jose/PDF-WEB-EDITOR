<template>
  <!--
    The page's text as transparent letters over the canvas, so the arrow tool
    selects and copies it the way Acrobat's does. Built by pdf.js — the same
    parser that drew the canvas, so every span sits on its own glyphs — and only
    live in the select tool: in Editar PDF the text block overlay owns the
    clicks.
  -->
  <div
    ref="hostRef"
    class="page-text-host"
    :class="{ active }"
    :data-page="page"
    @mousedown="onDown"
  />
</template>

<script setup lang="ts">
import { ref, computed, watch, inject, onMounted, onBeforeUnmount } from 'vue'
import { useEditorStore } from '@/stores/editor'
import type { usePDFViewer } from '@/composables/usePDFViewer'

const props = defineProps<{
  page: number
  /** Bumped by the viewer each time this page is painted: the text is rebuilt with it. */
  paintStamp: number
}>()

const editorStore = useEditorStore()
const pdfViewer = inject<ReturnType<typeof usePDFViewer>>('pdfViewer')!
const hostRef = ref<HTMLDivElement | null>(null)

const active = computed(() => editorStore.currentTool === 'select')

/** The stamp the current layer was built for; a newer paint means rebuild. */
let builtFor = -1
let building = 0

async function build() {
  if (!active.value || !props.paintStamp || builtFor === props.paintStamp) return
  const stamp = props.paintStamp
  const token = ++building
  const result = await pdfViewer.buildTextLayer(props.page)
  // Superseded by a newer paint, or the host went away while building.
  if (token !== building || !result || !hostRef.value) return
  // Keep a selection the user is holding: swapping the layer out from under it
  // would silently drop what they were about to copy.
  if (selectionInside()) { builtFor = -1; return }
  hostRef.value.replaceChildren(result.el)
  builtFor = stamp
}

function selectionInside(): boolean {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !hostRef.value) return false
  return hostRef.value.contains(sel.anchorNode) || hostRef.value.contains(sel.focusNode)
}

watch(() => props.paintStamp, () => { void build() })
watch(active, on => {
  if (on) { void build(); return }
  // Leaving the arrow: a highlighted selection would otherwise stay on the page
  // under a tool that cannot do anything with it.
  if (selectionInside()) window.getSelection()?.removeAllRanges()
})
onMounted(() => { void build() })

// ── Dragging across the gaps between spans ──
// While a selection is being dragged, pdf.js's end-of-content element covers
// the layer (`.selecting`), so moving the pointer over blank paper between two
// lines extends the selection instead of jumping it to the end of the page.
function onDown(e: MouseEvent) {
  if (e.button !== 0) return
  const layer = hostRef.value?.querySelector('.textLayer')
  if (!layer) return
  layer.classList.add('selecting')
  const up = () => {
    layer.classList.remove('selecting')
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mouseup', up)
}

onBeforeUnmount(() => { building++ })
</script>

<style>
/*
 * Unscoped: pdf.js creates the spans itself, so scoped attributes never reach
 * them. These are the `.textLayer` rules of pdfjs-dist/web/pdf_viewer.css that
 * place the spans (pdf.js 5), plus the page-rotation transforms it expects.
 */
.page-text-host {
  position: absolute; inset: 0;
  /* Over the canvas and the content images (z 3), under the annotation
     hit-targets (z 14+), so a click on a stamp or a link still reaches it. */
  z-index: 4;
  pointer-events: none;
  display: none;
  --scale-round-x: 1px;
  --scale-round-y: 1px;
}
.page-text-host.active { display: block; }

.page-text-host .textLayer {
  position: absolute; text-align: initial; inset: 0; overflow: clip; opacity: 1;
  line-height: 1; text-size-adjust: none; -webkit-text-size-adjust: none;
  forced-color-adjust: none; transform-origin: 0 0; caret-color: CanvasText; z-index: 0;
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
  pointer-events: none;
}
.page-text-host .textLayer[data-main-rotation="90"] { transform: rotate(90deg) translateY(-100%); }
.page-text-host .textLayer[data-main-rotation="180"] { transform: rotate(180deg) translate(-100%, -100%); }
.page-text-host .textLayer[data-main-rotation="270"] { transform: rotate(270deg) translateX(-100%); }

.page-text-host .textLayer :is(span, br) {
  color: transparent; position: absolute; white-space: pre; cursor: text;
  transform-origin: 0% 0%; pointer-events: auto;
}
.page-text-host .textLayer > :not(.markedContent),
.page-text-host .textLayer .markedContent span:not(.markedContent) {
  z-index: 1;
  --font-height: 0;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1;
  --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}
.page-text-host .textLayer .markedContent { display: contents; }
.page-text-host .textLayer span[role="img"] { user-select: none; cursor: default; }

/* Acrobat's selection colour: a translucent blue over the printed letters. */
.page-text-host .textLayer ::selection { background: rgba(0, 100, 255, 0.3); }
.page-text-host .textLayer br::selection { background: transparent; }

.page-text-host .textLayer .endOfContent {
  display: block; position: absolute; inset: 100% 0 0; z-index: 0;
  cursor: default; user-select: none;
}
.page-text-host .textLayer.selecting { pointer-events: auto; }
.page-text-host .textLayer.selecting .endOfContent { top: 0; pointer-events: auto; }
</style>
