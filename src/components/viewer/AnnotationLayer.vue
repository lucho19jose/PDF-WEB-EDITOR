<template>
  <div class="annot-layer-container" v-if="showLayer">
    <!-- Existing annotations and page images: selectable / movable hit-targets.
         Live in the EDIT tool as well as in select — Acrobat's "Editar PDF" is
         one mode in which a click on text edits the text and a click on a
         picture picks the picture up, and splitting that across two tools meant
         the images on the page you were editing could not be touched at all. -->
    <template v-if="objectsSelectable">
      <!-- Images drawn by the page content (logos, photos, scans). UNDER the
           annotation hits: an annotation stamped over a scan must still win
           the click. -->
      <div
        v-for="img in scaledContentImgs"
        :key="'ci' + img.id"
        class="cimg-hit"
        :class="{ selected: selectedImgId === img.id || multiImgs.has(img.id) }"
        :style="img.style"
        title="Image in the page — drag to move, handles to resize, Del to remove"
        @mousedown.stop="onImgMouseDown($event, img.id)"
      />
      <div
        v-for="a in scaledAnnots"
        :key="a.index"
        class="annot-hit"
        :class="{ selected: selectedIndex === a.index || multiAnnots.has(a.index) }"
        :style="a.style"
        :title="a.title"
        @mousedown.stop="onAnnotMouseDown($event, a.index)"
      />
      <!-- Resize handles for the selected annotation -->
      <div
        v-for="h in annotHandles"
        :key="h.pos"
        class="annot-handle"
        :style="h.style"
        @mousedown.stop.prevent="onAnnotResizeDown($event, h.pos)"
      />
      <!--
        Layout options, ON the picture — where Word puts them.

        How an image sits with the text is a property OF THAT IMAGE, so the
        control belongs beside it and not in a toolbar at the top of the window:
        up there it applies to the next insertion rather than to the thing you
        are looking at, which is the wrong mental model and a long way from the
        picture you are trying to arrange.
      -->
      <!-- Rotate, under the layout button: a property of THIS image too. -->
      <div v-if="selectedIsImage" class="annot-rotate" :style="rotateBtnStyle" @mousedown.stop.prevent>
        <q-btn dense round size="sm" color="primary" icon="rotate_90_degrees_cw" @click.stop="rotateSelectedImage">
          <q-tooltip>Rotate 90°</q-tooltip>
        </q-btn>
      </div>

      <div v-if="selectedIsImage" class="annot-layout" :style="layoutBtnStyle" @mousedown.stop.prevent>
        <q-btn dense round size="sm" color="primary" icon="wrap_text" @click.stop>
          <q-tooltip>How this image sits with the text</q-tooltip>
          <q-menu anchor="bottom right" self="top right" class="bg-grey-10">
            <q-list dense style="min-width: 230px">
              <q-item-label header class="text-grey-5 q-py-xs">Position of this image</q-item-label>
              <q-item clickable v-close-popup @click="applyWrap('front')">
                <q-item-section avatar><q-icon name="flip_to_front" size="20px" /></q-item-section>
                <q-item-section>
                  <q-item-label>In front of the text</q-item-label>
                  <q-item-label caption class="text-grey-6">Over it. Stays selectable</q-item-label>
                </q-item-section>
              </q-item>
              <q-item clickable v-close-popup @click="applyWrap('inline')">
                <q-item-section avatar><q-icon name="vertical_align_center" size="20px" /></q-item-section>
                <q-item-section>
                  <q-item-label>In the text</q-item-label>
                  <q-item-label caption class="text-grey-6">The text moves aside to make room</q-item-label>
                </q-item-section>
              </q-item>
              <q-item clickable v-close-popup @click="applyWrap('behind')">
                <q-item-section avatar><q-icon name="flip_to_back" size="20px" /></q-item-section>
                <q-item-section>
                  <q-item-label>Behind the text</q-item-label>
                  <q-item-label caption class="text-grey-6">Like a watermark. Becomes part of the page</q-item-label>
                </q-item-section>
              </q-item>
            </q-list>
          </q-menu>
        </q-btn>
      </div>

      <!-- Delete button for whatever is selected — an annotation or one of the
           page's own images. An object you can pick up and move but not remove
           is a half-finished object. -->
      <div v-if="selectedRect" class="annot-delete" :style="deleteBtnStyle" @mousedown.prevent>
        <q-btn dense round size="xs" color="negative" icon="delete" @click.stop="deleteSelected">
          <q-tooltip>{{ selectedImg ? 'Delete this image (Del)' : 'Delete annotation (Del)' }}</q-tooltip>
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

    <!-- Off-screen, NOT display:none: a hidden input is the one some browsers
         refuse to open a chooser for — the same trap `openFile` documents. -->
    <input
      ref="imgInputRef"
      type="file"
      accept="image/png,image/jpeg,image/jpg"
      class="offscreen-input"
      @change="onImagePicked"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, inject, onMounted, onBeforeUnmount } from 'vue'
import { useQuasar } from 'quasar'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore, MARKUP_TOOLS, type Tool } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import type { usePDFEngine } from '@/composables/usePDFEngine'
import type { AnnotationInfo, ContentImageInfo, Quad, Pt, RectT, MarkupType, ShapeType, TextChar } from '@/engine/types'
import { hexToRgb01, rgb01ToCss } from '@/utils/color'
import { enqueueOp, beginTransaction } from '@/utils/opQueue'

const props = defineProps<{ pageWidth: number; pageHeight: number; pdfWidth: number; pdfHeight: number }>()
const emit = defineEmits<{ changed: []; objectPicked: [] }>()

const $q = useQuasar()
const docStore = useDocumentStore()
const editorStore = useEditorStore()
const historyStore = useHistoryStore()
const pdfEngine = inject<ReturnType<typeof usePDFEngine>>('pdfEngine')!

const annotations = ref<AnnotationInfo[]>([])
const selectedIndex = ref<number | null>(null)

/**
 * Images the page CONTENT draws — the document's own logos, photos and scans.
 * Acrobat lets you grab these; here they were untouchable while only
 * annotation images had handles. Selecting one deselects any annotation and
 * vice versa: two selections with two behaviours under one set of handles is
 * how the wrong thing gets dragged.
 */
const contentImages = ref<ContentImageInfo[]>([])
const selectedImgId = ref<number | null>(null)
const selectedImg = computed(() => contentImages.value.find(i => i.id === selectedImgId.value) || null)

/**
 * MULTI-selection across content images and annotations: Shift/Ctrl+click
 * toggles a member, the rubber band (forwarded from the text overlay, which
 * owns the empty-paper surface) sweeps them in, and dragging any member moves
 * the whole group as one undo point. The single "primary" selection keeps the
 * resize handles and the per-image buttons; a group is move-only.
 */
const multiImgs = ref<Set<number>>(new Set())
const multiAnnots = ref<Set<number>>(new Set())
const multiCount = computed(() => multiImgs.value.size + multiAnnots.value.size)

function clearMultiSelection() {
  if (multiImgs.value.size) multiImgs.value = new Set()
  if (multiAnnots.value.size) multiAnnots.value = new Set()
}

/**
 * Drop every object selection — called when the TEXT overlay takes a click.
 *
 * The two layers keep their own selections, and in the edit tool they are now
 * both live at once. Without this, clicking a line of text left the image you
 * had picked up still selected and still wearing its handles, and Delete had
 * two answers to the question of what it was going to remove.
 */
function clearObjectSelection() {
  selectedIndex.value = null
  selectedImgId.value = null
  clearMultiSelection()
}

/** A Shift+click on a second element turns the primary into a group member. */
function foldPrimaryIntoMulti() {
  if (selectedImgId.value !== null) {
    const s = new Set(multiImgs.value); s.add(selectedImgId.value)
    multiImgs.value = s; selectedImgId.value = null
  }
  if (selectedIndex.value !== null) {
    const s = new Set(multiAnnots.value); s.add(selectedIndex.value)
    multiAnnots.value = s; selectedIndex.value = null
  }
}

/**
 * Sweep everything the band TOUCHES into the selection (same rule as the text
 * overlay: full containment silently drops the element whose edge the band
 * stopped a point short of). `rect` arrives in page space, y-down.
 */
function selectInBand(rect: number[], additive: boolean) {
  if (!objectsSelectable.value) return
  if (additive) foldPrimaryIntoMulti()
  else { selectedIndex.value = null; selectedImgId.value = null }
  const touches = (r: RectT) =>
    r[0] < rect[2] && rect[0] < r[2] && r[1] < rect[3] && rect[1] < r[3]
  const imgs = new Set<number>(additive ? multiImgs.value : [])
  const anns = new Set<number>(additive ? multiAnnots.value : [])
  for (const img of contentImages.value) if (touches(img.rect)) imgs.add(img.id)
  for (const a of annotations.value) if (touches(a.rect)) anns.add(a.index)

  // One element alone is a PRIMARY selection — it keeps its handles.
  if (imgs.size + anns.size === 1) {
    clearMultiSelection()
    if (imgs.size) selectedImgId.value = [...imgs][0]
    else selectedIndex.value = [...anns][0]
    return
  }
  multiImgs.value = imgs
  multiAnnots.value = anns
  if (imgs.size + anns.size > 0) {
    editorStore.setStatus(`${imgs.size + anns.size} element(s) selected — drag any of them to move the group`)
  }
}

interface DragState {
  tool: Tool
  startSx: number; startSy: number   // screen (relative to layer)
  curSx: number; curSy: number
  inkPts: Pt[]                        // page-space ink points
  moved: boolean
}
const drag = ref<DragState | null>(null)

// Move-existing-annotation (or content-image, or the multi-selection) drag
interface MoveState { kind: 'annot' | 'cimg' | 'multi'; index: number; startX: number; startY: number; dx: number; dy: number; moved: boolean; rect: RectT }
const moveState = ref<MoveState | null>(null)

// FreeText editing
const freeTextEditing = ref(false)
const freeTextValue = ref('')
const ftRect = ref<RectT>([0, 0, 0, 0])
const ftRef = ref<HTMLTextAreaElement | null>(null)
const imgInputRef = ref<HTMLInputElement | null>(null)
/** Page-space Y of the click that started an image insertion. */
const imageDropY = ref<number | null>(null)

/** Provided by PDFViewer — the text layer is a sibling, not a child. */
const makeRoomInText = inject<(y: number, amount: number, below: boolean) => Promise<{
  column: { left: number; right: number } | null; y: number; moved: number; spilled: number; capped: boolean
}>>('makeRoomInText', async (y: number) => ({ column: null, y, moved: 0, spilled: 0, capped: false }))

const scaleX = computed(() => props.pageWidth / props.pdfWidth)
const scaleY = computed(() => props.pageHeight / props.pdfHeight)
/**
 * The tools in which the page's OBJECTS — annotations and the images the
 * content draws — are selectable, movable and resizable.
 *
 * `edit` is in the list because that is the tool people are in when they are
 * working on a document: Acrobat's "Editar PDF" hands you text and pictures at
 * once, and here the picture layer simply was not rendered, so every image on
 * the page being edited was inert. Switching to `select` first is not a
 * discoverable step, and it is not one Acrobat asks for.
 */
const objectsSelectable = computed(() => ['select', 'edit'].includes(editorStore.currentTool))
const showLayer = computed(() => editorStore.isAnnotationTool || objectsSelectable.value)
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
  const r = liveAnnotRect(a)
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

type AnnotHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

interface AnnotResize { kind: 'annot' | 'cimg'; index: number; handle: AnnotHandle; startX: number; startY: number; rect: RectT; moved: boolean }
const annotResize = ref<AnnotResize | null>(null)

/**
 * Eight grips around the selected annotation — or the selected content image,
 * which resizes through the same hands.
 *
 * Without them an image could be placed and moved but never sized, and the only
 * way to change one was to delete it and insert again at a different width.
 */
const annotHandles = computed(() => {
  if (!objectsSelectable.value) return []
  const a = selectedAnnot.value
  const img = selectedImg.value
  if (!a && !img) return []
  const r = a ? liveAnnotRect(a) : liveImgRect(img!)
  const x0 = r[0] * scaleX.value, y0 = r[1] * scaleY.value
  const x1 = r[2] * scaleX.value, y1 = r[3] * scaleY.value
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2
  const spots: [AnnotHandle, number, number, string][] = [
    ['nw', x0, y0, 'nwse-resize'], ['n', mx, y0, 'ns-resize'], ['ne', x1, y0, 'nesw-resize'],
    ['e', x1, my, 'ew-resize'], ['se', x1, y1, 'nwse-resize'], ['s', mx, y1, 'ns-resize'],
    ['sw', x0, y1, 'nesw-resize'], ['w', x0, my, 'ew-resize']
  ]
  return spots.map(([pos, x, y, cursor]) => ({
    pos,
    style: { left: `${x - 5}px`, top: `${y - 5}px`, cursor }
  }))
})

/** Shift `r` by the drag in progress, in page units. */
function draggedRect(r: RectT, m: MoveState): RectT {
  return [r[0] + m.dx / scaleX.value, r[1] + m.dy / scaleY.value,
          r[2] + m.dx / scaleX.value, r[3] + m.dy / scaleY.value]
}

/** The annotation's rect including any drag or resize in progress. */
function liveAnnotRect(a: AnnotationInfo): RectT {
  const rz = annotResize.value
  if (rz?.kind === 'annot' && rz.index === a.index && rz.moved) return resizedRect(rz)
  const m = moveState.value
  if (m?.moved && ((m.kind === 'annot' && m.index === a.index) ||
      (m.kind === 'multi' && multiAnnots.value.has(a.index)))) {
    return draggedRect(m.kind === 'annot' ? m.rect : a.rect, m)
  }
  return a.rect
}

/** Same, for a content-drawn image. */
function liveImgRect(img: ContentImageInfo): RectT {
  const rz = annotResize.value
  if (rz?.kind === 'cimg' && rz.index === img.id && rz.moved) return resizedRect(rz)
  const m = moveState.value
  if (m?.moved && ((m.kind === 'cimg' && m.index === img.id) ||
      (m.kind === 'multi' && multiImgs.value.has(img.id)))) {
    return draggedRect(m.kind === 'cimg' ? m.rect : img.rect, m)
  }
  return img.rect
}

/**
 * Content-image hit targets, scaled to the canvas — BIGGEST FIRST.
 *
 * They all share one z-index, so the last one in the DOM takes the click, and
 * the order they are listed in is the order the stream draws them: a Word
 * export draws the frame around a table cell before the photograph inside it,
 * which put the frame on top and made the photograph — the only one of the two
 * anybody wants to grab — unclickable. Sorting by area means the smallest
 * target under the cursor always wins, which is the rule that keeps a large
 * object from swallowing everything it contains.
 */
const scaledContentImgs = computed(() => contentImages.value
  .map(img => {
    const r = liveImgRect(img)
    return {
      id: img.id,
      area: Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]),
      style: {
        left: `${r[0] * scaleX.value}px`,
        top: `${r[1] * scaleY.value}px`,
        width: `${Math.max(2, (r[2] - r[0]) * scaleX.value)}px`,
        height: `${Math.max(2, (r[3] - r[1]) * scaleY.value)}px`
      }
    }
  })
  .sort((a, b) => b.area - a.area))

/** Apply a resize drag to its starting rect, keeping it at least a few points wide. */
function resizedRect(rz: AnnotResize): RectT {
  const dx = rz.startX === 0 && rz.startY === 0 ? 0 : (annotResizeDelta.value.dx) / scaleX.value
  const dy = (annotResizeDelta.value.dy) / scaleY.value
  let [x0, y0, x1, y1] = rz.rect
  if (rz.handle.includes('w')) x0 += dx
  if (rz.handle.includes('e')) x1 += dx
  if (rz.handle.includes('n')) y0 += dy
  if (rz.handle.includes('s')) y1 += dy
  if (x1 - x0 < 8) { if (rz.handle.includes('w')) x0 = x1 - 8; else x1 = x0 + 8 }
  if (y1 - y0 < 8) { if (rz.handle.includes('n')) y0 = y1 - 8; else y1 = y0 + 8 }
  return [x0, y0, x1, y1]
}

const annotResizeDelta = ref({ dx: 0, dy: 0 })

function onAnnotResizeDown(e: MouseEvent, handle: AnnotHandle) {
  const a = selectedAnnot.value
  const img = selectedImg.value
  if (!a && !img) return
  annotResizeDelta.value = { dx: 0, dy: 0 }
  annotResize.value = a
    ? { kind: 'annot', index: a.index, handle, startX: e.clientX, startY: e.clientY, rect: [...a.rect] as RectT, moved: false }
    : { kind: 'cimg', index: img!.id, handle, startX: e.clientX, startY: e.clientY, rect: [...img!.rect] as RectT, moved: false }
  window.addEventListener('mousemove', onAnnotResizeMove)
  window.addEventListener('mouseup', onAnnotResizeUp)
}
function onAnnotResizeMove(e: MouseEvent) {
  const rz = annotResize.value
  if (!rz) return
  annotResizeDelta.value = { dx: e.clientX - rz.startX, dy: e.clientY - rz.startY }
  if (Math.abs(annotResizeDelta.value.dx) > 2 || Math.abs(annotResizeDelta.value.dy) > 2) rz.moved = true
}
async function onAnnotResizeUp() {
  window.removeEventListener('mousemove', onAnnotResizeMove)
  window.removeEventListener('mouseup', onAnnotResizeUp)
  const rz = annotResize.value
  annotResize.value = null
  if (!rz || !rz.moved) return
  const rect = resizedRect({ ...rz, moved: true })

  if (rz.kind === 'cimg') {
    await commitImgRect(rz.index, rect, 'Image resized')
    return
  }
  await commitRectChange(rz.index, rz.rect as RectT, rect, 'Annotation resized')
}

/**
 * Move every member of the multi-selection by the same delta, as one engine
 * pass and one undo point. Content images of the SAME source are transformed
 * from the highest Do offset down — each injection lengthens the stream, so
 * only offsets BELOW an already-spliced one stay valid.
 */
async function commitMultiMove(dxP: number, dyP: number) {
  const imgs = contentImages.value
    .filter(i => multiImgs.value.has(i.id))
    .sort((a, b) => a.sourceKey === b.sourceKey
      ? b.doOffset - a.doOffset
      : (a.sourceKey < b.sourceKey ? -1 : 1))
  const anns = annotations.value.filter(a => multiAnnots.value.has(a.index))
  const total = imgs.length + anns.length
  if (!total) return
  const pageIndex = docStore.currentPage - 1
  const shift = (r: RectT): RectT => [r[0] + dxP, r[1] + dyP, r[2] + dxP, r[3] + dyP]

  let ok = 0
  await annotOp(`${total} element(s) moved`, async () => {
    for (const img of imgs) {
      if (await pdfEngine.transformContentImage(pageIndex, img.sourceKey, img.doOffset, img.name, shift(img.rect))) ok++
    }
    for (const a of anns) {
      if (await pdfEngine.updateAnnotation(pageIndex, a.index, { rect: shift(a.rect) })) ok++
    }
    return ok > 0
  })
  if (ok < total) editorStore.setStatus(`Moved ${ok} of ${total} — Ctrl+Z takes the whole move back`)
}

/** Apply a new rectangle to a content-drawn image, clamped onto the page. */
async function commitImgRect(id: number, rect: RectT, verb: string) {
  const img = contentImages.value.find(i => i.id === id)
  if (!img) return
  const w = rect[2] - rect[0], h = rect[3] - rect[1]
  const x0 = Math.max(-w * 0.9, Math.min(rect[0], props.pdfWidth - w * 0.1))
  const y0 = Math.max(-h * 0.9, Math.min(rect[1], props.pdfHeight - h * 0.1))
  const target: RectT = [x0, y0, x0 + w, y0 + h]
  await annotOp(verb, () => pdfEngine.transformContentImage(
    docStore.currentPage - 1, img.sourceKey, img.doOffset, img.name, target))
}

/**
 * Push the text clear of a picture that is ALREADY in place.
 *
 * Not the same sum as making room for one about to be inserted. There the gap
 * is opened at the foot of a line and the picture is dropped INTO it, so its
 * own height is exactly the room wanted. Here the picture is fixed and the
 * first line that has to move starts wherever it starts — usually some way
 * above the picture's top edge — so pushing it down by the height alone left it
 * printed across the bottom of the image, half a line inside the ink. What it
 * needs is the distance from where it is to just below the picture, and every
 * line under it moves by that same amount so the spacing between them holds.
 */
async function pushTextClearOf(rect: RectT) {
  const top = Math.min(rect[1], rect[3])
  const bottom = Math.max(rect[1], rect[3])
  // `y` comes back as the TOP of the first row that would move — the only
  // number this sum can be built on, and it is not knowable until asked.
  const probe = await makeRoomInText(top, 0, false)
  const amount = Math.max(0, bottom + IMAGE_GAP - probe.y)
  return amount > 0.5 ? await makeRoomInText(top, amount, false) : probe
}

/**
 * Apply a new rectangle to an annotation, and let the text follow it.
 *
 * Both directions, and both kinds of change. Only GROWING was handled before —
 * so an image made smaller left the gap it no longer needed sitting empty, and
 * one dragged elsewhere left its old gap behind and landed on whatever was at
 * the new place. Neither is something a person would call adjusted.
 *
 * A change of height in place is one operation for the difference, which is
 * both cheaper and steadier than closing the old gap and opening a new one:
 * every reflow is a chance to match the wrong paragraph, so the fewer the
 * better. A move has to be the two.
 */
async function commitRectChange(index: number, oldRect: RectT, newRect: RectT, verb: string) {
  const apply = () => pdfEngine.updateAnnotation(docStore.currentPage - 1, index, { rect: newRect })
  const isImage = selectedIsImage.value
  if (!isImage || !editorStore.reflowOnEdit) {
    await annotOp(verb, apply)
    return
  }

  const oldH = oldRect[3] - oldRect[1]
  const newH = newRect[3] - newRect[1]
  const inPlace = Math.abs(newRect[0] - oldRect[0]) < 1 && Math.abs(newRect[1] - oldRect[1]) < 1

  pushUndo()   // one undo point covering the reflow and the change itself
  let moved = 0
  let spilled = 0

  if (inPlace) {
    const delta = newH - oldH
    if (Math.abs(delta) > 1) {
      const room = await makeRoomInText(oldRect[3], delta, true)
      moved += room.moved
      spilled += room.spilled
    }
  } else {
    // Give back what the old position was holding, then take what the new one
    // needs. In that order: the rows have to be where they belong before the
    // second plan is built against them.
    const gave = await makeRoomInText(oldRect[3], -(oldH + IMAGE_GAP * 2), true)
    moved += gave.moved
    const took = await pushTextClearOf(newRect)
    moved += took.moved
    spilled += took.spilled
  }

  const note = moved > 0 || spilled > 0
    ? [
        `${verb} — ${moved} block(s) moved`,
        spilled > 0 ? `${spilled} line(s) moved to the next page` : null
      ].filter(Boolean).join(' — ')
    : verb
  await annotOp(note, apply, false)
}

/** The rect of the single selected object, whichever kind it is. */
const selectedRect = computed<RectT | null>(() => {
  const a = selectedAnnot.value
  if (a) return liveAnnotRect(a)
  const img = selectedImg.value
  return img ? liveImgRect(img) : null
})

const deleteBtnStyle = computed(() => {
  const r = selectedRect.value
  if (!r) return {}
  // Clamped onto the page: anchored past the right edge it lands off the canvas
  // for anything in the right margin, and a button you cannot see is a button
  // you do not have.
  return {
    left: `${Math.min(r[2] * scaleX.value + 4, props.pageWidth - 26)}px`,
    top: `${Math.max(2, r[1] * scaleY.value - 4)}px`,
    position: 'absolute' as const, zIndex: 30, pointerEvents: 'auto' as const
  }
})

/** Only a picture has a layout to choose; a highlight or a note does not. */
const selectedIsImage = computed(() => {
  const a = selectedAnnot.value
  if (!a) return false
  const kind = String((a as any).type || (a as any).subtype || '').toLowerCase()
  return kind.includes('stamp')
})

/**
 * Just outside the picture's top-left corner, clamped onto the page.
 *
 * Word puts it at the top RIGHT; here the right-hand side already carries the
 * delete button and the resize handles, and two controls fighting over one
 * corner is how a button ends up unclickable.
 */
const layoutBtnStyle = computed(() => {
  const a = selectedAnnot.value
  if (!a) return {}
  const left = Math.max(2, a.rect[0] * scaleX.value - 34)
  const top = Math.max(2, a.rect[1] * scaleY.value - 4)
  return {
    left: `${left}px`,
    top: `${top}px`,
    position: 'absolute' as const, zIndex: 31, pointerEvents: 'auto' as const
  }
})

/** Just below the layout button, same left edge — the corner column of image controls. */
const rotateBtnStyle = computed(() => {
  const a = selectedAnnot.value
  if (!a) return {}
  const left = Math.max(2, a.rect[0] * scaleX.value - 34)
  const top = Math.max(2, a.rect[1] * scaleY.value - 4) + 32
  return {
    left: `${left}px`,
    top: `${top}px`,
    position: 'absolute' as const, zIndex: 31, pointerEvents: 'auto' as const
  }
})

/**
 * Turn the selected image a quarter turn clockwise. Lossless: the appearance
 * matrix rotates and the rectangle swaps around its centre — no pixels are
 * re-encoded, so four clicks bring it back exactly. One undo point per turn.
 */
async function rotateSelectedImage() {
  const a = selectedAnnot.value
  if (!a) return
  const pageIndex = docStore.currentPage - 1
  const index = a.index
  await annotOp('Image rotated 90°', () => pdfEngine.rotateStampImage(pageIndex, index))
}

/**
 * Change how the picture already on the page sits with the text.
 *
 * "Behind" is the one that costs something: an annotation is painted above all
 * page content whatever order it was made in, so the only way under the text is
 * to stop being an annotation. It becomes part of the page and there is nothing
 * left to select — said plainly, with Ctrl+Z as the way back.
 */
async function applyWrap(mode: 'front' | 'inline' | 'behind') {
  const a = selectedAnnot.value
  if (!a) return
  const pageIndex = docStore.currentPage - 1

  if (mode === 'front') {
    editorStore.setStatus('This image is in front of the text — drag its handles to move or resize it')
    return
  }

  if (mode === 'inline') {
    pushUndo()
    const room = await pushTextClearOf(a.rect)
    editorStore.setStatus(room.moved > 0
      ? `The text moved aside — ${room.moved} block(s) shifted around the image`
      : 'There was nothing under the image to move aside')
    return
  }

  const index = a.index
  selectedIndex.value = null
  await annotOp(
    'This image is behind the text now — it is part of the page, so Ctrl+Z to change it',
    () => pdfEngine.flattenAnnotationBehind(pageIndex, index),
    true
  )
}

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
  if (!pdfEngine.isReady.value || !pdfEngine.docLoaded.value || !docStore.loaded) {
    annotations.value = []
    contentImages.value = []
    return
  }
  try {
    annotations.value = await pdfEngine.getAnnotations(docStore.currentPage - 1)
  } catch { annotations.value = [] }
  try {
    contentImages.value = await pdfEngine.listContentImages(docStore.currentPage - 1)
  } catch { contentImages.value = [] }
  if (selectedImgId.value !== null && !contentImages.value.some(i => i.id === selectedImgId.value)) {
    selectedImgId.value = null
  }
  // Prune group members that no longer exist after a reload.
  if (multiImgs.value.size) {
    const ids = new Set(contentImages.value.map(i => i.id))
    multiImgs.value = new Set([...multiImgs.value].filter(id => ids.has(id)))
  }
  if (multiAnnots.value.size) {
    const idxs = new Set(annotations.value.map(a => a.index))
    multiAnnots.value = new Set([...multiAnnots.value].filter(i => idxs.has(i)))
  }
}

// --- creation ---
function onCaptureDown(e: MouseEvent) {
  const tool = editorStore.currentTool
  const { sx, sy, px, py } = pageCoords(e)

  if (tool === 'image') { imageDropY.value = py; imgInputRef.value?.click(); return }
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
/** Clearance left between an inserted image and the text it sits between. */
const IMAGE_GAP = 8

/**
 * Insert an image INTO the flow of the text rather than on top of it.
 *
 * A PDF has no flow, so "make room" is a real edit: the lines below (or, for an
 * "above" placement, from that line down) are moved out of the way first, and
 * only then is the image stamped into the gap. Doing it the other way round
 * would put the picture on the page and then slide the text out from under it,
 * which flickers and — if the reflow fails — leaves the image on top of the
 * text with no way to tell.
 *
 * It is centred on the TEXT COLUMN, not the paper: an image centred on the page
 * looks off-centre on any document whose margins are not symmetric.
 */
async function onImagePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    await insertImage(file)
  } catch (err: any) {
    // An async handler that throws rejects a promise nobody is holding, so the
    // failure is completely silent — the user clicks, picks a file, and nothing
    // happens with nothing to explain it. That is how a broken ref went
    // unnoticed. Anything that goes wrong here is reported.
    console.error('[Image] insert failed', err)
    editorStore.setStatus(`Could not insert the image: ${err?.message || err}`)
  }
}

async function insertImage(file: File) {
  // Held for the WHOLE sequence — making room, the save that follows it, and
  // the stamp — so an undo cannot land between two of its steps.
  const endTransaction = beginTransaction()
  try {
    await insertImageSteps(file)
  } finally {
    endTransaction()
  }
}

async function insertImageSteps(file: File) {

  const buf = await file.arrayBuffer()
  const aspect = await imgAspect(file)
  const below = editorStore.imagePlacement === 'below'
  const wrap = editorStore.imageWrap
  const inFlow = wrap === 'inline'

  // One undo point for the whole insertion: making room mutates the document
  // too, so the snapshot has to be taken before ANY of it.
  pushUndo()
  const dropY = imageDropY.value ?? props.pdfHeight * 0.2
  imageDropY.value = null

  // Ask the text where its column is before sizing anything to it.
  const probe = await makeRoomInText(dropY, 0, below)
  const column = probe.column ?? { left: props.pdfWidth * 0.1, right: props.pdfWidth * 0.9 }
  const columnWidth = Math.max(column.right - column.left, 1)

  let w = Math.max(columnWidth * (editorStore.imageWidthPct / 100), 8)
  let h = Math.max(w / (aspect || 1), 8)

  // The width was chosen; the HEIGHT follows from the picture's own shape, and
  // nothing was checking it against the paper.
  //
  // A portrait photograph — a phone snap of a document, which is the common
  // case — is two or three times taller than it is wide, so 60% of the column
  // came out taller than the page: on a Letter sheet it ran 462 points past the
  // bottom edge, where it cannot be seen, printed or dragged back. Scaled to
  // fit, the same picture lands whole and can be made bigger by its handles.
  const usableH = Math.max(props.pdfHeight - IMAGE_GAP * 2, 16)
  let shrunk = false
  if (h > usableH) {
    const fit = usableH / h
    w *= fit
    h *= fit
    shrunk = true
  }
  const x = column.left + (columnWidth - w) / 2

  // Only an in-flow image asks the text to move. Over or under it, the picture
  // is meant to overlap what is there — that is the whole point of the mode —
  // so pushing the text away would defeat it.
  const room = inFlow && editorStore.reflowOnEdit
    ? await makeRoomInText(dropY, h + IMAGE_GAP * 2, below)
    : probe
  // Placed where it was asked for, then slid back onto the page if that would
  // hang it over an edge. Moving it beats shrinking it further: the size the
  // user chose is respected wherever there is room for it anywhere on the sheet.
  const wanted = below ? room.y + IMAGE_GAP : Math.max(room.y - IMAGE_GAP - h, 0)
  const top = Math.max(IMAGE_GAP, Math.min(wanted, props.pdfHeight - IMAGE_GAP - h))
  const nudged = Math.abs(top - wanted) > 0.5
  // Declared before the `behind` branch below, which returns early and needs it.
  const fitNote = shrunk
    ? ' — scaled down to fit the page'
    : nudged ? ' — moved up to keep it on the page' : ''

  const rect: RectT = [x, top, x + w, top + h]
  const pageIndex = docStore.currentPage - 1

  if (wrap === 'behind') {
    // Behind the text it CANNOT be an annotation: annotations paint above all
    // page content whatever order they were made in. It goes into the content
    // stream instead, and so becomes part of the page — there is no annotation
    // left to select or resize, which the message says rather than leaving the
    // user looking for handles that are not there.
    const behindNote = `Image inserted behind the text${fitNote} — it is part of the page now, so Ctrl+Z to change it`
    await annotOp(behindNote, () => pdfEngine.drawImageInContent(pageIndex, rect, buf, true), false)
    // Switching tool writes its own status line, so the note is put back after
    // it — otherwise the only explanation of what just happened is replaced by
    // "Tool: select" before the user can read it.
    editorStore.setTool('select')
    editorStore.setStatus(behindNote)
    return
  }

  const note = wrap === 'front'
    ? `Image inserted in front of the text${fitNote} — drag its handles to move or resize it`
    : editorStore.reflowOnEdit
      ? [
          `Image inserted in the text${fitNote} — ${room.moved} block(s) moved to make room`,
          room.spilled > 0 ? `${room.spilled} line(s) moved to the next page` : null
        ].filter(Boolean).join(' — ')
      : `Image inserted${fitNote} — the text was left as it was (turn on Reflow to move it aside)`
  await annotOp(note, () => pdfEngine.addImageStamp(pageIndex, rect, buf), false)

  // Hand the user the select tool: staying on 'image' means the next click on
  // the page opens the file chooser again, so the image they just placed can
  // never be picked up and resized.
  editorStore.setTool('select')
  await nextTick()
  await loadAnnotations()
  const placed = annotations.value.find(a => Math.abs(a.rect[0] - rect[0]) < 1 && Math.abs(a.rect[1] - rect[1]) < 1)
  if (placed) selectedIndex.value = placed.index
  // Last word, for the same reason as above: `setTool` overwrote the only
  // account of what the insertion actually did to the page.
  editorStore.setStatus(note)
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
async function annotOp(msg: string, mutate: () => Promise<boolean>, pushSnapshot = true) {
  await enqueueOp(async () => {
    const ok = await mutate()
    if (ok) {
      // Snapshot the pre-edit bytes ONLY on success (docStore.pdfBytes is still the
      // pre-edit state until emit('changed') -> onTextChanged reloads it). This avoids
      // polluting undo/redo history when an annotation op fails.
      //
      // A caller that already changed the document before getting here (the
      // image tool moves text out of the way first) owns the undo point and
      // passes false: snapshotting again here would capture the half-done state
      // and make one action take two Ctrl+Z, the first of which leaves the page
      // rearranged around an image that is no longer there.
      if (pushSnapshot) pushUndo()
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
function startMultiMove(e: MouseEvent) {
  moveState.value = { kind: 'multi', index: -1, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, moved: false, rect: [0, 0, 0, 0] }
  window.addEventListener('mousemove', onMoveMove)
  window.addEventListener('mouseup', onMoveUp)
}

function onAnnotMouseDown(e: MouseEvent, index: number) {
  emit('objectPicked')
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    foldPrimaryIntoMulti()
    const s = new Set(multiAnnots.value)
    if (s.has(index)) s.delete(index); else s.add(index)
    multiAnnots.value = s
    return
  }
  if (multiAnnots.value.has(index) && multiCount.value > 1) { startMultiMove(e); return }
  clearMultiSelection()
  selectedIndex.value = index
  selectedImgId.value = null
  const a = annotations.value.find(x => x.index === index)
  if (!a) return
  moveState.value = { kind: 'annot', index, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, moved: false, rect: a.rect }
  window.addEventListener('mousemove', onMoveMove)
  window.addEventListener('mouseup', onMoveUp)
}

function onImgMouseDown(e: MouseEvent, id: number) {
  emit('objectPicked')
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    foldPrimaryIntoMulti()
    const s = new Set(multiImgs.value)
    if (s.has(id)) s.delete(id); else s.add(id)
    multiImgs.value = s
    return
  }
  if (multiImgs.value.has(id) && multiCount.value > 1) { startMultiMove(e); return }
  clearMultiSelection()
  selectedImgId.value = id
  selectedIndex.value = null
  const img = contentImages.value.find(i => i.id === id)
  if (!img) return
  editorStore.setStatus('Image selected — drag to move it, the handles to resize, Del to remove it')
  moveState.value = { kind: 'cimg', index: id, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, moved: false, rect: img.rect }
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

  // A content-drawn image moves within its page: it lives in THIS page's
  // content stream, so crossing to another sheet would mean re-embedding, not
  // moving. Clamped instead.
  if (m.kind === 'cimg') {
    await commitImgRect(m.index, newRect, 'Image moved')
    return
  }

  // The multi-selection travels as one operation and ONE undo point.
  if (m.kind === 'multi') {
    await commitMultiMove(dxP, dyP)
    return
  }

  // Dragged past the foot (or head) of the sheet in continuous scroll: the
  // user is aiming at the NEXT page, not at the margin of this one. Decide by
  // the rect's centre — half-way across is where "still on this page" stops
  // being what the gesture means.
  const centerY = (newRect[1] + newRect[3]) / 2
  const pageIdx = docStore.currentPage - 1
  if (centerY > props.pdfHeight && pageIdx + 1 < docStore.totalPages) {
    await transferToPage(m.index, newRect, pageIdx, pageIdx + 1)
    return
  }
  if (centerY < 0 && pageIdx > 0) {
    await transferToPage(m.index, newRect, pageIdx, pageIdx - 1)
    return
  }

  await commitRectChange(m.index, m.rect as RectT, newRect, 'Annotation moved')
}

/**
 * Carry an annotation onto the page above or below, continuing the drag: how
 * far the rect crossed this page's edge is where it enters the next one. The
 * engine reparents the same object — appearance, image and rotation travel
 * untouched — and the view then follows it, because a drop you have to go
 * hunting for reads as a disappearance.
 */
async function transferToPage(index: number, rect: RectT, from: number, to: number) {
  const w = rect[2] - rect[0]
  const h = rect[3] - rect[1]
  const size = await pdfEngine.getPageSize(to).catch(() => null)
  const tw = size?.width ?? props.pdfWidth
  const th = size?.height ?? props.pdfHeight

  let y0 = to > from
    ? rect[1] - props.pdfHeight   // downward: overflow past this page's foot
    : th + rect[1]                // upward: rect[1] is negative past the head
  y0 = Math.max(4, Math.min(y0, th - h - 4))
  const x0 = Math.max(2, Math.min(rect[0], tw - w - 2))
  const target: RectT = [x0, y0, x0 + w, y0 + h]

  selectedIndex.value = null
  await annotOp(`Moved to page ${to + 1}`, () => pdfEngine.moveAnnotationToPage(from, index, to, target))
  // Follow the annotation: the editing layers live on the current page, so
  // staying behind would leave it unselectable until the user scrolled.
  docStore.setPage(to + 1)
}

/**
 * Remove whatever is selected — an annotation, one of the page's own images, or
 * the whole group.
 *
 * A multi-selection is deleted as ONE operation and one undo point, images
 * first: annotation indices shift when an annotation is removed, so the
 * annotations go from the highest index down, exactly as the multi-move sorts
 * its images by offset.
 */
async function deleteSelected() {
  const pageIndex = docStore.currentPage - 1

  if (multiCount.value > 0) {
    const imgs = contentImages.value.filter(i => multiImgs.value.has(i.id))
    const anns = annotations.value
      .filter(a => multiAnnots.value.has(a.index))
      .sort((a, b) => b.index - a.index)
    const total = imgs.length + anns.length
    if (!total) return
    clearMultiSelection()
    let ok = 0
    await annotOp(`${total} element(s) deleted`, async () => {
      for (const img of imgs) {
        if (await pdfEngine.deleteContentImage(pageIndex, img.sourceKey, img.doOffset, img.name)) ok++
      }
      for (const a of anns) {
        if (await pdfEngine.deleteAnnotation(pageIndex, a.index)) ok++
      }
      return ok > 0
    })
    if (ok < total) editorStore.setStatus(`Deleted ${ok} of ${total} — Ctrl+Z takes the whole deletion back`)
    return
  }

  if (selectedImgId.value !== null) {
    const img = contentImages.value.find(i => i.id === selectedImgId.value)
    if (!img) return
    selectedImgId.value = null
    await annotOp('Image deleted', () => pdfEngine.deleteContentImage(pageIndex, img.sourceKey, img.doOffset, img.name))
    return
  }

  if (selectedIndex.value === null) return
  const idx = selectedIndex.value
  selectedIndex.value = null
  await annotOp('Annotation deleted', () => pdfEngine.deleteAnnotation(pageIndex, idx))
}

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented) return // TextBlockOverlay already consumed this Delete
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
  const hasSelection = selectedIndex.value !== null || selectedImgId.value !== null || multiCount.value > 0
  if ((e.key === 'Delete' || e.key === 'Backspace') && hasSelection && objectsSelectable.value) {
    e.preventDefault()
    deleteSelected()
  }
}

// --- lifecycle ---
watch(() => editorStore.currentTool, () => {
  selectedIndex.value = null
  selectedImgId.value = null
  clearMultiSelection()
  cancelFreeText()
  if (showLayer.value) loadAnnotations()
})
/**
 * Load on MOUNT — same reason as the text overlay.
 *
 * Under continuous scrolling this layer is rebuilt on whichever page is being
 * looked at, and a new instance has missed every change its watchers listen
 * for. Its annotations were simply absent: nothing to select, nothing to
 * resize, nothing to delete.
 */
onMounted(() => { loadAnnotations() })

watch(() => docStore.currentPage, () => {
  // The image ids are per page, so a selection carried across pages points at
  // whatever happens to hold that id on the new one.
  clearObjectSelection()
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
  window.removeEventListener('mousemove', onAnnotResizeMove)
  window.removeEventListener('mouseup', onAnnotResizeUp)
})

defineExpose({ loadAnnotations, deleteSelected, selectInBand, clearMultiSelection, clearObjectSelection })
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
/*
  Content-drawn images: below annotations — an annotation stamped over a scan
  must still win the click — and below the TEXT blocks (z-index 4 in the text
  overlay, which is a sibling layer sharing this stacking context).

  Under the text, because a page's own images are routinely the size of the
  region they decorate: table borders, cell backgrounds, a frame around a
  photograph. At z-index 15 they covered the text drawn inside them, and on a
  Word export that is most of the page.
*/
.cimg-hit {
  position: absolute; pointer-events: auto; z-index: 3;
  border: 1px dashed transparent; box-sizing: border-box; cursor: move;
}
.cimg-hit:hover { border-color: rgba(52,168,83,0.7); background: rgba(52,168,83,0.05); }
.cimg-hit.selected { border: 1.5px dashed #34a853; background: rgba(52,168,83,0.08); }
.annot-preview {
  position: absolute; border: 2px solid; box-sizing: border-box; z-index: 17; pointer-events: none;
}
.annot-preview.circle { border-radius: 50%; }
.annot-preview.markup { border-style: none; }
.annot-svg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 17; pointer-events: none; overflow: visible; }
.annot-layout {
  /* On the picture, not in a toolbar — see the template. */
  display: flex;
}
.annot-rotate { display: flex; }
.annot-delete { }
.annot-handle {
  position: absolute; width: 10px; height: 10px; z-index: 22;
  background: #4285f4; border: 1.5px solid #fff; border-radius: 2px;
  pointer-events: auto; box-shadow: 0 0 0 1px rgba(0,0,0,0.35);
}
.offscreen-input {
  position: fixed; left: -9999px; top: 0;
}
.ft-editor-wrap { position: absolute; z-index: 20; pointer-events: auto; display: flex; flex-direction: column; }
.ft-editor {
  width: 100%; border: 1.5px solid #e53935; background: rgba(255,255,255,0.97);
  padding: 2px 4px; outline: none; resize: both; font-family: Helvetica, Arial, sans-serif; line-height: 1.2;
}
.ft-actions { display: flex; justify-content: flex-end; gap: 2px; background: rgba(50,50,50,0.9); border-radius: 0 0 4px 4px; padding: 1px; }
</style>
