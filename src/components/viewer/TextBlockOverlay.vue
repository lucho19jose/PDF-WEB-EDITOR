<template>
  <div ref="hostRef" class="text-overlay-container" v-if="showOverlay">
    <!-- Marquee capture layer: sits UNDER the blocks so a click on text still
         reaches the text, but empty page area starts a rubber-band selection. -->
    <div
      v-if="marqueeEnabled"
      class="marquee-target"
      @mousedown="onMarqueeStart"
    />

    <!-- Clickable text blocks (edit + select modes) -->
    <div
      v-for="block in scaledBlocks"
      :key="block.id"
      class="text-block"
      :class="{
        selected: block.selected,
        movable: block.selected && ['select', 'edit'].includes(editorStore.currentTool)
      }"
      :style="block.style"
      @mousedown.stop="onBlockMouseDown($event, block.id)"
    />

    <!-- Rubber band -->
    <div v-if="marqueeStyle" class="marquee" :style="marqueeStyle" />

    <!-- Selection handles around the whole selection (not one block) -->
    <template v-if="hasSelection && ['select', 'edit'].includes(editorStore.currentTool) && !editingBlock">
      <!-- Outline of the selection as a whole, so a multi-block pick reads as
           one object rather than several unrelated dashed boxes. -->
      <div class="selection-outline" :style="selectionOutlineStyle" />
      <div
        v-for="handle in selectionHandles"
        :key="handle.pos"
        class="selection-handle"
        :style="handle.style"
        @mousedown.stop.prevent="onHandleMouseDown($event, handle.pos)"
      />
    </template>

    <!-- Floating action bar for the selection.
         Always clamped inside the page: anchored to the block's right edge it
         fell off the canvas for anything near the right margin, and an action
         you cannot see is an action you do not have. -->
    <div
      v-if="hasSelection && !editingBlock && !isAddingText && ['select', 'edit'].includes(editorStore.currentTool) && !dragState?.isDragging"
      class="selection-actions"
      :style="actionBarStyle"
      @mousedown.stop.prevent
    >
      <q-icon name="open_with" size="14px" class="text-blue-4" />
      <span class="actions-count">{{ selectedIds.length }}</span>
      <!-- A multi-line selection has no other way in: in edit mode a plain click
           opens the editor for the one block under the cursor, which collapses
           the very selection the user just built. -->
      <q-btn dense flat size="xs" color="grey-4" icon="edit_note" @click.stop="editSelection">
        <q-tooltip>{{ selectedIds.length > 1 ? `Edit these ${selectedIds.length} lines as one text` : 'Edit this text' }}</q-tooltip>
      </q-btn>
      <q-btn dense flat size="xs" color="grey-4" icon="select_all" @click.stop="selectAllBlocks">
        <q-tooltip>Select every block on the page (Ctrl+A)</q-tooltip>
      </q-btn>
      <q-btn dense flat size="xs" color="red-4" icon="delete" @click.stop="deleteSelectedBlocks">
        <q-tooltip>Delete selection (Del)</q-tooltip>
      </q-btn>
    </div>

    <!-- In-place editor (contenteditable div exactly over the text block) -->
    <div
      v-if="editingBlock"
      ref="editorRef"
      class="inline-editor"
      :style="editorStyle"
      contenteditable="true"
      @keydown.escape.prevent="cancelEdit"
      @blur="onBlur"
    />

    <!-- Add text click target (addText mode) -->
    <div
      v-if="editorStore.currentTool === 'addText' && !isAddingText"
      class="add-text-target"
      @click.stop="onAddTextClick"
    />

    <!-- Add text inline editor -->
    <div
      v-if="isAddingText"
      class="inline-editor-wrapper"
      :style="addTextEditorStyle"
    >
      <textarea
        ref="addTextEditorRef"
        v-model="addTextValue"
        class="inline-editor add-text-editor"
        placeholder="Type new text..."
        @keydown.enter.ctrl="commitAddText"
        @keydown.escape="cancelAddText"
      />
      <div class="editor-actions" @mousedown.prevent>
        <q-btn dense flat size="xs" color="positive" icon="check" @click.stop="commitAddText" />
        <q-btn dense flat size="xs" color="negative" icon="close" @click.stop="cancelAddText" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, inject, onMounted, onBeforeUnmount } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import { enqueueOp } from '@/utils/opQueue'
import { groupIntoRows, resolveCollisions, planReflow, planPushDown, type Rect } from '@/utils/layoutCollision'
import { hexToRgb01, rgb01ToHex } from '@/utils/color'
import type { usePDFEngine } from '@/composables/usePDFEngine'
import type { TextBlock, BlockTransformOp, BlockStyleOp } from '@/engine/types'

type HandlePosition = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

interface ScreenRect { left: number; top: number; width: number; height: number }

interface DragState {
  mode: 'move' | 'resize'
  handle?: HandlePosition
  startMouseX: number
  startMouseY: number
  currentDeltaX: number
  currentDeltaY: number
  /** Union of the whole selection at drag start, in screen px. */
  origScreenBbox: ScreenRect
  /** Per-block starting rects, keyed by id — a group drag moves all of them. */
  origBlockRects: Map<string, ScreenRect>
  isDragging: boolean
}

/** Where a selected block came from, so it can be re-found after a reload. */
interface Anchor { text: string; cx: number; cy: number }

/** Clearance left between displaced text and the text that displaced it. */
const COLLISION_GAP = 2
/** Upper bound on how much of a page one drag may rearrange. */
const MAX_PUSHED_ROWS = 40

const props = defineProps<{
  pageWidth: number
  pageHeight: number
  pdfWidth: number
  pdfHeight: number
}>()

const emit = defineEmits<{
  textChanged: []
}>()

const docStore = useDocumentStore()
const editorStore = useEditorStore()
const historyStore = useHistoryStore()
const pdfEngine = inject<ReturnType<typeof usePDFEngine>>('pdfEngine')!

const hostRef = ref<HTMLDivElement | null>(null)
const blocks = ref<TextBlock[]>([])

/**
 * The selection is a SET, not a single id.
 *
 * Text extraction splits a paragraph into one block per line — and splits each
 * line again at every wide gap, so "Label:" and its value are two blocks. "The
 * field I want to move" is therefore almost never one block, and dragging a
 * rubber band over several of them and moving the lot is what makes moving a
 * real field possible at all.
 */
const selectedIds = ref<string[]>([])

/**
 * Block ids are "page:extractionIndex" and are NOT stable: a save→reload cycle
 * (every edit) re-extracts the page, and moving a block changes its position in
 * MuPDF's extraction order. Remembering what was selected — its text and where
 * it sat — lets the selection be re-resolved after each reload instead of being
 * dropped (or, worse, left pointing at somebody else's paragraph).
 */
const selectionAnchors = ref<Anchor[]>([])

const editingBlock = ref<TextBlock | null>(null)

/**
 * The blocks a multi-line edit covers, in the order their text is shown.
 *
 * Captured when the editor opens rather than recomputed on commit: line N of
 * what the user typed means block N of what they were shown, and re-deriving
 * the order from a selection that a reload may have re-resolved would quietly
 * write each line into the wrong place.
 */
const editingGroup = ref<TextBlock[]>([])
const editorRef = ref<HTMLDivElement | null>(null)
let isCommitting = false
/** The editor has been given its text. A blur before that must not commit. */
let editorPopulated = false

// Add text state
const isAddingText = ref(false)
const addTextValue = ref('')
const addTextScreenX = ref(0)
const addTextScreenY = ref(0)
const addTextPdfX = ref(0)
const addTextPdfY = ref(0)
const addTextEditorRef = ref<HTMLTextAreaElement | null>(null)

// Drag state for move/resize
const dragState = ref<DragState | null>(null)

// Rubber-band selection state (screen px, relative to the page)
const marquee = ref<{ x0: number; y0: number; x1: number; y1: number; additive: boolean } | null>(null)
const marqueeMoved = ref(false)

// Show overlay for edit, select, and addText modes
const showOverlay = computed(() =>
  ['edit', 'select', 'addText'].includes(editorStore.currentTool)
)

const marqueeEnabled = computed(() =>
  ['select', 'edit'].includes(editorStore.currentTool) && !editingBlock.value && !isAddingText.value
)

const hasSelection = computed(() => selectedIds.value.length > 0)

// Scale factor: rendered canvas size / PDF user-space size
const scaleX = computed(() => props.pageWidth / props.pdfWidth)
const scaleY = computed(() => props.pageHeight / props.pdfHeight)

const selectedSet = computed(() => new Set(selectedIds.value))

/** Selected blocks, skipping ids that no longer resolve after a reload. */
const selectedBlocks = computed(() =>
  selectedIds.value
    .map(id => blocks.value.find(b => b.id === id))
    .filter((b): b is TextBlock => !!b)
)

function baseRect(block: TextBlock): ScreenRect {
  return {
    left: block.bbox[0] * scaleX.value,
    top: block.bbox[1] * scaleY.value,
    width: (block.bbox[2] - block.bbox[0]) * scaleX.value,
    height: (block.bbox[3] - block.bbox[1]) * scaleY.value
  }
}

/**
 * Screen rect for a block, including the live drag preview.
 *
 * A resize scales every selected block about the SAME anchor rather than
 * resizing each one in place: the group has to behave like a single object, or
 * the gaps between its lines would stay fixed while the glyphs grew.
 */
function getScreenBbox(block: TextBlock): ScreenRect {
  const rect = baseRect(block)
  const ds = dragState.value
  if (!ds?.isDragging || !selectedSet.value.has(block.id)) return rect

  const orig = ds.origBlockRects.get(block.id) ?? rect

  if (ds.mode === 'move') {
    return { ...orig, left: orig.left + ds.currentDeltaX, top: orig.top + ds.currentDeltaY }
  }

  if (ds.mode === 'resize' && ds.handle) {
    const union = ds.origScreenBbox
    const resized = computeResizedBbox(union, ds.handle, ds.currentDeltaX, ds.currentDeltaY)
    const sx = union.width > 0.01 ? resized.width / union.width : 1
    const sy = union.height > 0.01 ? resized.height / union.height : 1
    return {
      left: resized.left + (orig.left - union.left) * sx,
      top: resized.top + (orig.top - union.top) * sy,
      width: orig.width * sx,
      height: orig.height * sy
    }
  }

  return rect
}

// Transform blocks from PDF coords to screen coords
const scaledBlocks = computed(() =>
  blocks.value.map(block => {
    const bbox = getScreenBbox(block)
    return {
      id: block.id,
      selected: selectedSet.value.has(block.id),
      style: {
        left: `${bbox.left}px`,
        top: `${bbox.top}px`,
        width: `${bbox.width}px`,
        height: `${bbox.height}px`
      }
    }
  })
)

/** Union of the selection in screen px, drag preview included. */
const selectionRect = computed<ScreenRect | null>(() => {
  const sel = selectedBlocks.value
  if (sel.length === 0) return null
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
  for (const block of sel) {
    const s = getScreenBbox(block)
    l = Math.min(l, s.left); t = Math.min(t, s.top)
    r = Math.max(r, s.left + s.width); b = Math.max(b, s.top + s.height)
  }
  return { left: l, top: t, width: r - l, height: b - t }
})

const selectionOutlineStyle = computed(() => {
  const rect = selectionRect.value
  if (!rect) return { display: 'none' }
  return {
    left: `${rect.left - 2}px`,
    top: `${rect.top - 2}px`,
    width: `${rect.width + 4}px`,
    height: `${rect.height + 4}px`
  }
})

// Selection handles around the selection as a whole
const selectionHandles = computed(() => {
  const rect = selectionRect.value
  if (!rect) return []

  const { left, top, width, height } = rect
  const hs = 8 // handle size
  const ho = hs / 2

  const handles: { pos: HandlePosition; cursor: string }[] = [
    { pos: 'nw', cursor: 'nwse-resize' },
    { pos: 'n', cursor: 'ns-resize' },
    { pos: 'ne', cursor: 'nesw-resize' },
    { pos: 'e', cursor: 'ew-resize' },
    { pos: 'se', cursor: 'nwse-resize' },
    { pos: 's', cursor: 'ns-resize' },
    { pos: 'sw', cursor: 'nesw-resize' },
    { pos: 'w', cursor: 'ew-resize' },
  ]

  const posMap: Record<HandlePosition, { x: number; y: number }> = {
    nw: { x: left, y: top },
    n: { x: left + width / 2, y: top },
    ne: { x: left + width, y: top },
    e: { x: left + width, y: top + height / 2 },
    se: { x: left + width, y: top + height },
    s: { x: left + width / 2, y: top + height },
    sw: { x: left, y: top + height },
    w: { x: left, y: top + height / 2 },
  }

  return handles.map(h => ({
    pos: h.pos,
    style: {
      left: `${posMap[h.pos].x - ho}px`,
      top: `${posMap[h.pos].y - ho}px`,
      width: `${hs}px`,
      height: `${hs}px`,
      cursor: h.cursor,
      position: 'absolute' as const,
      pointerEvents: 'auto' as const,
      zIndex: 20
    }
  }))
})

/**
 * Put the action bar where it can actually be seen.
 *
 * It used to hang off the block's right edge, which put it past the canvas for
 * anything in the right margin and under the toolbar for anything on the first
 * line — the delete button existed but could not be reached or even seen. It
 * now floats above the selection, flips below when there is no room above, and
 * is clamped to the page on both axes.
 */
const ACTION_BAR_W = 96
const ACTION_BAR_H = 26

const actionBarStyle = computed(() => {
  const rect = selectionRect.value
  if (!rect) return { display: 'none' }

  const above = rect.top - ACTION_BAR_H - 4
  const below = rect.top + rect.height + 4
  const top = above >= 0
    ? above
    : Math.max(0, Math.min(below, props.pageHeight - ACTION_BAR_H))
  const left = Math.max(0, Math.min(rect.left, props.pageWidth - ACTION_BAR_W))

  return {
    left: `${left}px`,
    top: `${top}px`,
    position: 'absolute' as const,
    pointerEvents: 'auto' as const,
    zIndex: 21
  }
})

const marqueeStyle = computed(() => {
  const m = marquee.value
  if (!m || !marqueeMoved.value) return null
  return {
    left: `${Math.min(m.x0, m.x1)}px`,
    top: `${Math.min(m.y0, m.y1)}px`,
    width: `${Math.abs(m.x1 - m.x0)}px`,
    height: `${Math.abs(m.y1 - m.y0)}px`
  }
})

const editorStyle = computed(() => {
  if (!editingBlock.value) return {}
  const block = editingBlock.value
  // A multi-line edit is one box over the whole group, so the lines line up with
  // the text they replace instead of the caret sitting over the first line only.
  const group = editingGroup.value.length > 1 ? editingGroup.value : [block]
  const bx0 = Math.min(...group.map(b => b.bbox[0]))
  const by0 = Math.min(...group.map(b => b.bbox[1]))
  const bx1 = Math.max(...group.map(b => b.bbox[2]))
  const by1 = Math.max(...group.map(b => b.bbox[3]))
  const x = bx0 * scaleX.value
  const y = by0 * scaleY.value
  const w = (bx1 - bx0) * scaleX.value
  const h = (by1 - by0) * scaleY.value
  const fs = block.fontSize * scaleY.value

  // Extend editor width to page right edge so text stays on one line
  const availableW = props.pageWidth - x
  return {
    left: `${x - 1}px`,
    top: `${y - 1}px`,
    minWidth: `${Math.max(w + 2, 60)}px`,
    maxWidth: `${Math.max(availableW, w + 2)}px`,
    minHeight: `${Math.max(h + 2, fs + 4)}px`,
    fontSize: `${fs}px`,
    fontWeight: block.isBold ? 'bold' : 'normal',
    fontStyle: block.isItalic ? 'italic' : 'normal',
    color: `rgb(${Math.round(block.color[0] * 255)}, ${Math.round(block.color[1] * 255)}, ${Math.round(block.color[2] * 255)})`,
    lineHeight: '1.15'
  }
})

const addTextEditorStyle = computed(() => ({
  left: `${addTextScreenX.value}px`,
  top: `${addTextScreenY.value}px`,
  width: '250px',
  minHeight: '30px'
}))

// ── Block loading ──

const pageRotated = ref(false)

/**
 * @param announce say how many blocks were found.
 *
 * Off by default: every edit ends with a reload, and announcing there overwrote
 * the line that had just explained what the edit did — the wrap, the blocks
 * moved, the foot of the page that could not move. Only entering the tool and
 * opening a document have nothing better to say.
 */
async function loadBlocks(announce = false) {
  if (!showOverlay.value || !pdfEngine.isReady.value || !pdfEngine.docLoaded.value) return

  try {
    const pageIndex = docStore.currentPage - 1

    // Rotated pages: MuPDF extraction splits rotated glyph runs into
    // per-character blocks (thousands of useless hitboxes) and the Tm-space
    // math in move/add-text assumes an unrotated page. Disable text editing
    // there instead of corrupting the layout.
    const size = await pdfEngine.getPageSize(pageIndex).catch(() => null)
    pageRotated.value = !!size && size.rotation % 360 !== 0
    if (pageRotated.value) {
      blocks.value = []
      clearSelection()
      if (editorStore.currentTool === 'edit' || editorStore.currentTool === 'addText') {
        editorStore.setStatus('Text editing is disabled on rotated pages — rotate back to 0° first')
      }
      return
    }

    const data = await pdfEngine.getTextBlocks(pageIndex)
    blocks.value = data
    resolveSelection()
    if (announce && editorStore.currentTool === 'edit') {
      editorStore.setStatus(`Edit mode: ${data.length} text blocks found`)
    }
  } catch (err: any) {
    console.error('Failed to load text blocks:', err)
    blocks.value = []
    clearSelection()
  }
}

function anchorOf(block: TextBlock): Anchor {
  return {
    text: block.text,
    cx: (block.bbox[0] + block.bbox[2]) / 2,
    cy: (block.bbox[1] + block.bbox[3]) / 2
  }
}

/** Replace the selection wholesale and remember it for post-reload resolution. */
function setSelection(sel: TextBlock[]) {
  selectedIds.value = sel.map(b => b.id)
  selectionAnchors.value = sel.map(anchorOf)
}

function clearSelection() {
  selectedIds.value = []
  selectionAnchors.value = []
}

/** Add or remove one block (Shift/Ctrl+click). */
function toggleSelection(block: TextBlock) {
  const at = selectedIds.value.indexOf(block.id)
  if (at >= 0) {
    selectedIds.value.splice(at, 1)
    selectionAnchors.value.splice(at, 1)
  } else {
    selectedIds.value.push(block.id)
    selectionAnchors.value.push(anchorOf(block))
  }
}

/**
 * Find the block an anchor refers to in the freshly loaded set.
 *
 * Text alone does not identify it — a running header or a repeated table value
 * appears many times — so identical text is disambiguated by position, and a
 * twin on the far side of the page is rejected rather than adopted: adopting it
 * would move somebody else's paragraph on the next drag. `taken` keeps two
 * anchors with the same text from both resolving to the same block.
 */
function findByAnchor(anchor: Anchor, taken: Set<string>): TextBlock | null {
  let candidates = blocks.value.filter(b => b.text === anchor.text && !taken.has(b.id))
  if (candidates.length === 0) {
    // Scaling text up can push its tail past the page edge, so re-extraction
    // returns a clipped string — match on the surviving prefix instead.
    const prefix = anchor.text.slice(0, 3)
    candidates = prefix.length === 3
      ? blocks.value.filter(b => !taken.has(b.id) && b.text.startsWith(prefix) &&
          (b.text.startsWith(anchor.text) || anchor.text.startsWith(b.text)))
      : []
  }
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  let best: { block: TextBlock; dist: number } | null = null
  for (const b of candidates) {
    const dist = Math.hypot(
      (b.bbox[0] + b.bbox[2]) / 2 - anchor.cx,
      (b.bbox[1] + b.bbox[3]) / 2 - anchor.cy
    )
    if (!best || dist < best.dist) best = { block: b, dist }
  }
  return best && best.dist < 24 ? best.block : null
}

/** Re-point every selected id at its anchored block in the new extraction. */
function resolveSelection() {
  if (selectionAnchors.value.length === 0) { selectedIds.value = []; return }

  const ids: string[] = []
  const anchors: Anchor[] = []
  const taken = new Set<string>()

  for (const anchor of selectionAnchors.value) {
    const block = findByAnchor(anchor, taken)
    if (!block) continue
    taken.add(block.id)
    ids.push(block.id)
    anchors.push(anchorOf(block))
  }

  selectedIds.value = ids
  selectionAnchors.value = anchors
}

// ── Block selection & editing ──

/**
 * Open the editor over one block, or over a whole selection.
 *
 * A multi-block selection is edited as ONE piece of text, one line per block, in
 * reading order — which is what a selection of several lines means to the person
 * who made it. On commit the whole thing goes back into the FIRST block and the
 * others are emptied; the engine re-wraps it and the page reflows to whatever
 * line count comes out. The alternative, mapping line N back onto block N, falls
 * apart the moment the user adds or removes a line in the middle.
 *
 * The cost is that the group takes the first block's font, size and colour. For
 * the lines of one paragraph — what a multi-line selection nearly always is —
 * they were already the same.
 */
/** The nearest ancestor that actually scrolls, or the document. */
function scrollAncestor(from: HTMLElement | null): HTMLElement | null {
  let el: HTMLElement | null = from
  while (el && el !== document.body) {
    const style = getComputedStyle(el)
    if (/(auto|scroll)/.test(style.overflowY + style.overflowX) &&
        (el.scrollHeight - el.clientHeight > 2 || el.scrollWidth - el.clientWidth > 2)) return el
    el = el.parentElement
  }
  return document.scrollingElement as HTMLElement | null
}

function openInlineEditor(block: TextBlock, group: TextBlock[] = []) {
  editingGroup.value = group.length > 1 ? group : []
  editingBlock.value = block
  editorPopulated = false
  nextTick(() => {
    // The element never mounted — the edit was cancelled underneath us. Leaving
    // an unpopulated editor open is how a blank one gets committed over real
    // text, so close it instead of leaving it there empty.
    if (!editorRef.value) { cancelEdit(); return }
    editorRef.value.textContent = ''
    const texts = editingGroup.value.length > 1
      ? editingGroup.value.map(b => b.text)
      : [block.text]
    texts.forEach((t, i) => {
      if (i > 0) editorRef.value!.appendChild(document.createElement('br'))
      editorRef.value!.appendChild(document.createTextNode(t))
    })
    editorPopulated = true

    // Opening an editor must not move the page under the user.
    //
    // A selection is scrolled to its FOCUS end, and the obvious way to select
    // everything puts that end after the last word — so opening a line that is
    // wider than the window threw the view to the right and the start of the
    // line, which is where anyone begins reading and editing, went off-screen.
    //
    // The whole line is still selected, so typing still replaces it; the
    // selection is just made BACKWARDS, with its focus at the first character.
    // `preventScroll` stops the focus itself from scrolling, and the scroller's
    // position is put back afterwards for anything that slips past both.
    const scroller = scrollAncestor(editorRef.value)
    const keepLeft = scroller?.scrollLeft ?? 0
    const keepTop = scroller?.scrollTop ?? 0

    editorRef.value.focus({ preventScroll: true })
    const range = document.createRange()
    range.selectNodeContents(editorRef.value)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    sel?.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset)

    editorRef.value.scrollLeft = 0
    if (scroller) { scroller.scrollLeft = keepLeft; scroller.scrollTop = keepTop }
  })
}

/**
 * Read what the editor holds, line breaks included.
 *
 * `textContent` concatenates the div-per-line a contenteditable produces with
 * nothing between them, so "one
two" came back as "onetwo" — the break the
 * user typed was destroyed before the engine ever saw it. `innerText` is the
 * rendered text and keeps them. The trailing blank lines a contenteditable
 * leaves behind are dropped; an empty last line is not an instruction.
 */
function readEditor(el: HTMLElement | null): string {
  if (!el) return ''
  const parts: string[] = []
  const walk = (node: Node) => {
    node.childNodes.forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) { parts.push(child.textContent ?? ''); return }
      if (!(child instanceof HTMLElement)) return
      if (child.tagName === 'BR') { parts.push('\n'); return }
      // A contenteditable wraps every line after the first in its own block.
      if (child.tagName === 'DIV' || child.tagName === 'P') parts.push('\n')
      walk(child)
    })
  }
  walk(el)
  return parts.join('').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
}

/**
 * A block's place in the page's extraction.
 *
 * `TextBlock.id` is `page:index` and the index is exactly that place, which is
 * what makes deleting back-to-front safe: emptying a block can only renumber
 * the ones AFTER it.
 */
function extractionIndex(block: TextBlock): number {
  const n = Number(String(block.id).split(':').pop())
  return Number.isFinite(n) ? n : 0
}

/** Whitespace-only differences are not edits worth rewriting a page for. */
function sameText(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
}

function onBlur() {
  // Capture WHICH block and WHAT text at blur time — reading live state when
  // the timer fires can commit block A's text under block B's id (or silently
  // drop the edit) if the user quick-clicks another block within 150 ms.
  const block = editingBlock.value
  const text = readEditor(editorRef.value)
  if (!block) return

  // The editor is filled a tick after it opens. A blur that lands in that
  // window reads an EMPTY editor, and committing that empties the block —
  // clicking through several lines quickly silently deleted one of them.
  if (!editorPopulated) { cancelEdit(); return }
  setTimeout(() => {
    if (!isCommitting) {
      commitEdit(block, text)
    }
  }, 150)
}

/**
 * Say what actually happened, including the two things the user did not ask for
 * but can see: text the margin forced onto extra lines, and blocks moved out of
 * the way to fit it.
 */
function describeEdit(
  result: { lines?: number; substitutedFont?: string },
  askedLines: number,
  moved: number,
  capped = false
): string {
  const parts = ['Text replaced']
  if ((result.lines ?? 1) > askedLines) parts.push('wrapped to fit the margin')
  if (result.substitutedFont) parts.push(`substituted ${result.substitutedFont} (the original font lacks some characters)`)
  if (moved > 0) parts.push(`${moved} block(s) moved to keep the layout`)
  if (capped) parts.push('the foot of the page could not move down without running off it, so it overlaps')
  if (!editorStore.reflowOnEdit && (result.lines ?? 1) !== askedLines) {
    parts.push('the rest of the page was left as it was (turn on Reflow to move it)')
  }
  return parts.join(' — ')
}

/**
 * Leading `rebuildBtContent` gives the lines it emits, in points.
 *
 * Must match LINE_LEADING in the worker: this is how much room is made for each
 * line gained, and the engine decides how much each one takes.
 */
function lineStep(fontSize: number): number {
  return Math.max(fontSize, 1) * 1.4
}

/** Lines the text occupies before the engine adds any of its own wrapping. */
function countLines(text: string): number {
  return text.split('\n').length
}

function pushUndoSnapshot() {
  const currentBytes = docStore.pdfBytes
  if (currentBytes) {
    historyStore.pushSnapshot(new Uint8Array(currentBytes))
  }
}

/**
 * Reading order: top to bottom, then left to right within a line.
 *
 * The order the blocks are SHOWN in is the order their lines mean, so it is
 * fixed once here and used for both filling the editor and writing back.
 */
function orderedForEditing(sel: TextBlock[]): TextBlock[] {
  return [...sel].sort((a, b) => {
    const ay = (a.bbox[1] + a.bbox[3]) / 2
    const by = (b.bbox[1] + b.bbox[3]) / 2
    const lineHeight = Math.max(2, Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1]) * 0.6)
    if (Math.abs(ay - by) > lineHeight) return ay - by
    return a.bbox[0] - b.bbox[0]
  })
}

/**
 * Commit a multi-block edit: all of the text into the first block, the rest
 * emptied, then one reflow for however many lines actually came out.
 *
 * The trailing blocks are emptied FIRST. Each `replaceText` re-extracts the
 * page and renumbers everything after the block it rewrote, so every target is
 * re-found by anchor immediately before it is written — a list of ids collected
 * up front addresses the page as it was, not as it is.
 */
async function commitGroupEdit(group: TextBlock[], newText: string) {
  const pageIndex = docStore.currentPage - 1
  const first = group[0]
  const restAnchors = group.slice(1).map(anchorOf)
  const firstAnchor = anchorOf(first)

  editorStore.setStatus(`Applying text change to ${group.length} lines...`)

  // Planned while the page still looks the way the user saw it.
  const guess = countLines(newText) - group.length
  const plannedFor = planReplacementShift(first, guess + group.length, group.length, first.fontSize)

  try {
    await enqueueOp(async () => {
      let snapshotTaken = false

      for (const anchor of restAnchors) {
        blocks.value = await pdfEngine.getTextBlocks(pageIndex)
        const b = findByAnchor(anchor, new Set())
        if (!b) continue
        const cleared = await pdfEngine.replaceText(pageIndex, b.id, '')
        if (cleared.success && !snapshotTaken) { pushUndoSnapshot(); snapshotTaken = true }
      }

      blocks.value = await pdfEngine.getTextBlocks(pageIndex)
      const target = findByAnchor(firstAnchor, new Set())
      if (!target) {
        editorStore.setStatus('Edit failed: the selected text could not be matched')
        return
      }

      const result = await pdfEngine.replaceText(pageIndex, target.id, newText)
      if (!result.success) {
        editorStore.setStatus(`Edit failed: ${pdfEngine.error.value || 'unknown error'}`)
        return
      }
      if (!snapshotTaken) pushUndoSnapshot()
      docStore.markModified()

      const delta = (result.lines ?? 1) - group.length
      const shift = delta === guess ? plannedFor : planReplacementShift(first, (result.lines ?? 1), group.length, first.fontSize)
      // A line the user ADDED has to be given room, toggle or no toggle.
      //
      // This is the same distinction the drag makes: rearranging a page as a
      // side effect of an edit is what the toggle governs, but pressing Enter
      // IS a request for another line, and a content stream has no flow to make
      // room by itself. Gated, the new line was drawn on top of the one below
      // it — or, inside a one-line clip, not visibly drawn at all.
      const moved = delta !== 0 ? await applyReflow(pageIndex, shift) : 0

      emit('textChanged')
      await loadBlocks()
      editorStore.setStatus(describeEdit(result, countLines(newText), moved, delta !== 0 && shift.capped))
    })
  } catch (err: any) {
    editorStore.setStatus(`Error: ${err.message}`)
  }
}

async function commitEdit(block: TextBlock, newText: string) {
  if (isCommitting) return

  const group = editingGroup.value
  if (group.length > 1) {
    if (sameText(newText, group.map(b => b.text).join('\n'))) {
      cancelEdit()
      return
    }
    isCommitting = true
    await commitGroupEdit(group, newText)
    closeEditorIfStill(block)
    isCommitting = false
    return
  }

  if (sameText(newText, block.text)) {
    cancelEdit()
    return
  }

  isCommitting = true
  const pageIndex = docStore.currentPage - 1

  editorStore.setStatus('Applying text change...')

  try {
    // Serialized: guarantees the previous edit's save→reload finished, so
    // pushUndoSnapshot reads the true pre-edit bytes.
    await enqueueOp(async () => {
      // Planned against the page as it stands: once the block is rewritten its
      // neighbours have new ids and this one has new geometry. The engine
      // decides the final count — the user's own breaks plus whatever the right
      // margin forced — so the plan is remade if it disagreed with the guess.
      const guess = countLines(newText) - 1
      const plannedFor = planReplacementShift(block, guess + 1, 1, block.fontSize)

      const result = await pdfEngine.replaceText(pageIndex, block.id, newText)
      if (result.success) {
        pushUndoSnapshot() // snapshot pre-edit bytes only on success (before re-render)
        docStore.markModified()

        const delta = (result.lines ?? 1) - 1
        const shift = delta === guess ? plannedFor : planReplacementShift(block, (result.lines ?? 1), 1, block.fontSize)
        // A line the user ADDED has to be given room, toggle or no toggle.
      //
      // This is the same distinction the drag makes: rearranging a page as a
      // side effect of an edit is what the toggle governs, but pressing Enter
      // IS a request for another line, and a content stream has no flow to make
      // room by itself. Gated, the new line was drawn on top of the one below
      // it — or, inside a one-line clip, not visibly drawn at all.
      const moved = delta !== 0 ? await applyReflow(pageIndex, shift) : 0

        emit('textChanged')
        await loadBlocks()
        editorStore.setStatus(describeEdit(result, countLines(newText), moved, delta !== 0 && shift.capped))
      } else {
        editorStore.setStatus(`Edit failed: ${pdfEngine.error.value || 'unknown error'}`)
      }
    })
  } catch (err: any) {
    editorStore.setStatus(`Error: ${err.message}`)
  }

  closeEditorIfStill(block)
  isCommitting = false
}

/**
 * Close the editor only if it is still the one that was being committed.
 *
 * A commit takes a save→reload; by the time it finishes the user may have
 * opened another line. Clearing `editingBlock` unconditionally shut THAT editor
 * — leaving it unpopulated and one blur away from writing a blank over the text
 * under it.
 */
function closeEditorIfStill(block: TextBlock) {
  if (editingBlock.value !== block) return
  editorPopulated = false
  editingBlock.value = null
  editingGroup.value = []
  clearSelection()
}

function cancelEdit() {
  isCommitting = false
  editorPopulated = false
  editingBlock.value = null
  editingGroup.value = []
  // Keep the selection so handles remain visible for move/resize
}

/**
 * Pull the planned rows up, once the deletes have landed.
 *
 * The plan was built against the pre-delete page, so each entry is re-matched
 * by text and position against a fresh extraction; anything that cannot be
 * matched is left where it is rather than guessed at, which costs a closed gap
 * but never moves the wrong paragraph.
 */
async function applyReflow(
  pageIndex: number,
  plan: RowShiftPlan
): Promise<number> {
  if (plan.moves.length === 0) return 0

  blocks.value = await pdfEngine.getTextBlocks(pageIndex)

  const taken = new Set<string>()
  const ops: BlockTransformOp[] = []
  for (const { anchor, shift } of plan.moves) {
    const block = findByAnchor(anchor, taken)
    if (!block) continue
    taken.add(block.id)
    // Page space is y-down, Tm space is y-up, so a POSITIVE shift here pulls the
    // row up and a negative one pushes it down.
    ops.push({ blockId: block.id, dx: 0, dy: shift, sx: 1, sy: 1, anchorX: 0, anchorY: 0 })
  }
  if (ops.length === 0) return 0

  const result = await pdfEngine.transformTextBlocks(pageIndex, ops)
  return result.results.filter(r => r.success).length
}

/**
 * Work out what has to move so an edit that changed a run's line count fits.
 *
 * `amount` is the vertical room to make, in points: positive pushes the rows
 * below down, negative pulls them up. A content stream has no flow, so a run
 * that grew paints straight over the next paragraph and one that shrank leaves
 * a hole; either way everything below has to move.
 *
 * Planned BEFORE the edit and returned as anchors, like the delete reflow: the
 * replacement re-extracts the page and renumbers every block after the one it
 * rewrote. Callers size `amount` off the leading `rebuildBtContent` uses for the
 * lines it emits — the NEW font size, not the old one, or a run that grew both
 * taller and longer gets a hole sized for the text it used to be.
 */
interface RowShiftPlan {
  moves: { anchor: Anchor; shift: number }[]
  /**
   * True when rows at the foot of the page were left where they are.
   *
   * Pushing them further would run them off the paper, where they would be
   * destroyed silently — so they are refused, and the caller says so. An
   * overlap at the bottom of a page is visible and fixable; vanished text is
   * neither.
   */
  capped: boolean
}

/**
 * Room to make for a replacement, measured rather than counted.
 *
 * The rows being replaced sit at the DOCUMENT's leading (15pt for 12pt text in
 * a typical file); the lines this engine emits sit at `lineStep`. Counting rows
 * gained and multiplying by the step ignores that difference, and it compounds:
 * a two-row group edit came up 3pt short, a five-row one would be nearly 10.
 * What the run needs is `drawnLines × lineStep`; what it has is the span those
 * rows occupy today. The difference is the answer.
 *
 * @param spans how many rows the replacement consumed (1 for a single line).
 */
function planReplacementShift(
  block: TextBlock,
  drawnLines: number,
  spans: number,
  fontSize: number
): RowShiftPlan {
  const all = blocks.value.map(b => ({ id: b.id, bbox: [...b.bbox] as Rect }))
  const rows = groupIntoRows(all)
  const at = rows.findIndex(r => r.blockIds.includes(block.id))
  if (at < 0) return { moves: [], capped: false }

  const end = Math.min(at + Math.max(spans, 1), rows.length)
  const after = rows[end]

  // What the replaced rows OCCUPIED — their own leading, not the whitespace
  // that happens to follow them.
  //
  // Measuring "occupied" as the distance to the next row is right only when
  // that next row is the following LINE. When it is the next paragraph, or the
  // row under a heading, that distance is mostly deliberate white space, and
  // charging it to the rows being replaced makes two new lines look like they
  // need less room than the one they came from: a cell 60pt above its
  // neighbour gained a line and the whole page below it was pulled UP 26pt.
  //
  // With two or more rows the leading can be measured from the rows themselves.
  // With one there is nothing to measure it against, so it is the gap capped at
  // what a single line can plausibly occupy — beyond that is white space, and
  // white space is not the edit's to spend.
  const gapBelow = after
    ? after.rect[1] - rows[at].rect[1]
    : rows[end - 1].rect[3] - rows[at].rect[1]
  const pitch = spans >= 2
    ? (rows[end - 1].rect[1] - rows[at].rect[1]) / (spans - 1)
    : Math.min(gapBelow, fontSize * 1.6)
  const occupied = Math.max(spans, 1) * pitch

  // Anchored on the LAST row being replaced, because what has to move is
  // everything below the group, not everything below its first line.
  const lastId = rows[end - 1].blockIds[0]
  const anchorBlock = blocks.value.find(b => b.id === lastId) ?? block

  return planRowShift(anchorBlock, drawnLines * lineStep(fontSize) - occupied)
}

function planRowShift(block: TextBlock, amount: number): RowShiftPlan {
  // Under a point of movement is not worth a content-stream rewrite: every one
  // is a chance to match the wrong block, and nobody can see it.
  if (Math.abs(amount) < 1) return { moves: [], capped: false }

  const all = blocks.value.map(b => ({ id: b.id, bbox: [...b.bbox] as Rect }))
  const rows = groupIntoRows(all)
  const at = rows.findIndex(r => r.blockIds.includes(block.id))
  if (at < 0) return { moves: [], capped: false }

  const { shifts, capped } = planPushDown(rows, at, Math.abs(amount), {
    // The bottom-of-page guard only makes sense when pushing text down; pulling
    // it up can never run off the page. The margin keeps text off the paper edge.
    pageHeight: amount > 0 ? props.pdfHeight - PAGE_BOTTOM_MARGIN : Infinity,
    maxRows: MAX_PUSHED_ROWS
  })

  const byId = new Map(blocks.value.map(b => [b.id, b]))
  // Tm space is y-up: a push DOWN is a negative dy, a pull UP a positive one.
  const sign = amount > 0 ? -1 : 1
  const moves: { anchor: Anchor; shift: number }[] = []
  for (const [rowIndex, dy] of shifts) {
    for (const id of rows[rowIndex].blockIds) {
      const b = byId.get(id)
      if (b) moves.push({ anchor: anchorOf(b), shift: sign * dy })
    }
  }
  return { moves, capped }
}

// ── Text style: reflect the selection, and apply changes back to it ──

/** Which of the three offered families a block's font belongs to. */
function familyOf(block: TextBlock): string {
  const name = (block.fontName || '').replace(/^[A-Z]{6}\+/, '')
  if (/courier|mono/i.test(name)) return 'Courier'
  if (/times|georgia|garamond|book|palatino|serif|roman/i.test(name)) return 'Times-Roman'
  return 'Helvetica'
}

/**
 * True while the property controls are being loaded FROM the selection.
 *
 * Without it the two watchers below chase each other: showing the clicked
 * block's 11pt in the size box looks exactly like the user typing 11pt, so
 * selecting anything would rewrite the content stream with the values it had
 * just read out of it.
 */
let syncingStyle = false

watch(selectedBlocks, (sel) => {
  const first = sel[0]
  if (!first) return
  syncingStyle = true
  editorStore.fontFamily = familyOf(first)
  editorStore.fontSize = Math.max(1, Math.round(first.fontSize))
  editorStore.textColor = rgb01ToHex(first.color)
  // Released a tick later, once the watcher below has seen — and ignored — the
  // change these three assignments queue.
  nextTick(() => { syncingStyle = false })
})

/**
 * Style changes are coalesced before they reach the engine.
 *
 * The size box is a free-text number input that emits on every keystroke, so
 * typing "24" passes through 2 and clearing it passes through NaN — and every
 * one of those would otherwise be a full content-stream rewrite plus a
 * save→reload. One rewrite per intent, not one per character.
 */
let stylePending: Omit<BlockStyleOp, 'blockId'> = {}
let styleTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => [editorStore.fontFamily, editorStore.fontSize, editorStore.textColor] as const,
  (now, prev) => {
    if (syncingStyle || !prev) return
    if (!hasSelection.value) return
    if (now[0] !== prev[0]) stylePending.fontName = now[0]
    if (now[1] !== prev[1] && Number.isFinite(now[1]) && now[1] >= 4 && now[1] <= 200) stylePending.fontSize = now[1]
    if (now[2] !== prev[2]) stylePending.color = hexToRgb01(now[2])
    if (Object.keys(stylePending).length === 0) return

    if (styleTimer) clearTimeout(styleTimer)
    styleTimer = setTimeout(() => {
      styleTimer = null
      const style = stylePending
      stylePending = {}
      applyTextStyle(style)
    }, 400)
  }
)

/**
 * Push a style change onto every selected block.
 *
 * The ops are resolved from ANCHORS inside the queued operation, not from the
 * ids the selection happens to hold when the control changed: committing the
 * inline editor first (below) re-extracts the page and renumbers every block on
 * it, so ids captured beforehand would address someone else's text.
 */
async function applyTextStyle(style: Omit<BlockStyleOp, 'blockId'>) {
  if (!hasSelection.value) return
  const pageIndex = docStore.currentPage - 1
  const anchors = [...selectionAnchors.value]
  if (anchors.length === 0) return

  // A change made while the inline editor is open has to land AFTER the text it
  // is holding — restyling first would rewrite a block the commit then replaces,
  // throwing the restyle away. Blur commits it and queues its own engine op.
  if (editingBlock.value) {
    editorRef.value?.blur()
    await new Promise(r => setTimeout(r, 250))
  }

  const what = [
    style.fontName ? style.fontName : null,
    style.fontSize !== undefined ? `${style.fontSize}pt` : null,
    style.color ? 'colour' : null
  ].filter(Boolean).join(', ')

  editorStore.setStatus(`Applying ${what}...`)

  try {
    await enqueueOp(async () => {
      blocks.value = await pdfEngine.getTextBlocks(pageIndex)

      const taken = new Set<string>()
      const ops: BlockStyleOp[] = []
      const targets: TextBlock[] = []
      for (const anchor of anchors) {
        const block = findByAnchor(anchor, taken)
        if (!block) continue
        taken.add(block.id)
        targets.push(block)
        ops.push({ blockId: block.id, ...style })
      }
      if (ops.length === 0) {
        editorStore.setStatus('Restyle failed: the selected text could not be matched')
        return
      }

      // The bottom-most block is the one whose row the page has to move away
      // from: rows BELOW it are what a wrap would land on.
      const bottom = [...targets].sort((a, b) => b.bbox[3] - a.bbox[3])[0]
      const result = await pdfEngine.restyleTextBlocks(pageIndex, ops)
      if (result.applied === 0) {
        editorStore.setStatus(`Restyle failed: ${pdfEngine.error.value || 'text not found in content stream'}`)
        return
      }

      // Snapshot the PRE-edit bytes, which docStore still holds until the
      // save→reload that emit('textChanged') queues behind this.
      pushUndoSnapshot()
      docStore.markModified()
      selectionAnchors.value = anchors

      // A bigger font can no longer fit between the block's left edge and the
      // right margin; the engine wraps it rather than draw off the paper, and
      // the lines it gained have to come from somewhere.
      const gained = result.results
        .filter(r => r.success)
        .reduce((n, r) => n + Math.max(0, (r.lines ?? 1) - 1), 0)

      // Room needed = however far the engine had to drop the run's own baseline
      // to keep it out of the line ABOVE, plus one line step for each line it
      // gained below. Sizing this off the old font size is what left the
      // wrapped 22pt line sitting on top of the paragraph under it.
      const newSize = style.fontSize ?? bottom?.fontSize ?? 0
      const drop = Math.max(...result.results.map(r => r.baselineDrop ?? 0), 0)
      // The engine dropped the run by the whole em it grew, to keep it out of the
      // line above. Below it, that same growth costs a full LINE BOX — the em
      // times the 1.2 leading used everywhere else, since the run's descender
      // grew too — plus a line step for every line it gained.
      const room = drop * 1.2 + gained * lineStep(newSize)
      const shift = room >= 1 && bottom && editorStore.reflowOnEdit
        ? planRowShift(bottom, room)
        : { moves: [], capped: false }
      const moved = await applyReflow(pageIndex, shift)

      editorStore.setStatus([
        result.applied === anchors.length
          ? `Applied ${what} to ${result.applied} block(s)`
          : `Applied ${what} to ${result.applied} of ${anchors.length} — the rest could not be matched (Ctrl+Z to undo)`,
        gained > 0 ? 'wrapped to fit the margin' : null,
        moved > 0 ? `${moved} block(s) moved to keep the layout` : null,
        shift.capped ? 'the foot of the page could not move down without running off it, so it overlaps' : null
      ].filter(Boolean).join(' — '))

      emit('textChanged')
    })
    await loadBlocks()
  } catch (err: any) {
    editorStore.setStatus(`Error: ${err.message}`)
  }
}

/**
 * Work out what has to come up to close the hole the delete is about to leave.
 *
 * Planned BEFORE anything is removed, because once the blocks are gone their
 * geometry is gone with them — and returned as anchors rather than ids, because
 * emptying a run renumbers every block after it in the extraction order.
 */
function planDeleteReflow(): { anchor: Anchor; shift: number }[] {
  const selected = selectedSet.value
  const rows = groupIntoRows(blocks.value.map(b => ({ id: b.id, bbox: [...b.bbox] as Rect })))

  const deletedRows = new Set<number>()
  rows.forEach((row, i) => {
    if (row.blockIds.every(id => selected.has(id))) deletedRows.add(i)
  })
  if (deletedRows.size === 0) return []

  const { shifts } = planReflow(rows, deletedRows, { maxRows: MAX_PUSHED_ROWS })

  const byId = new Map(blocks.value.map(b => [b.id, b]))
  const plan: { anchor: Anchor; shift: number }[] = []
  for (const [rowIndex, shift] of shifts) {
    for (const id of rows[rowIndex].blockIds) {
      const block = byId.get(id)
      if (block) plan.push({ anchor: anchorOf(block), shift })
    }
  }
  return plan
}

/**
 * Delete every selected block.
 *
 * One engine call per block, re-extracting between them: `replaceText` takes an
 * extraction index, and emptying a block renumbers everything after it, so a
 * list of ids collected up front would delete the wrong text from the second
 * one onwards.
 */
async function deleteSelectedBlocks() {
  if (!hasSelection.value) return
  const pageIndex = docStore.currentPage - 1
  const anchors = [...selectionAnchors.value]

  editorStore.setStatus(anchors.length > 1
    ? `Deleting ${anchors.length} text blocks...`
    : 'Deleting text block...')

  // Planned against the page as it stands: after the first delete the
  // surviving blocks have new ids and the deleted ones have no geometry left.
  const reflowPlan = planDeleteReflow()

  let deleted = 0
  let failed = 0
  let pulledUp = 0

  try {
    await enqueueOp(async () => {
      let snapshotTaken = false
      // One extraction for the whole set, deleted back to front — see the note
      // in the spill above for why that is enough.
      blocks.value = await pdfEngine.getTextBlocks(pageIndex)
      const taken = new Set<string>()
      const targets: TextBlock[] = []
      for (const anchor of anchors) {
        const block = findByAnchor(anchor, taken)
        if (!block) { failed++; continue }
        taken.add(block.id)
        targets.push(block)
      }
      targets.sort((a, b) => extractionIndex(b) - extractionIndex(a))

      let done = 0
      for (const block of targets) {
        if (targets.length > 3) {
          editorStore.setStatus(`Deleting ${++done} of ${targets.length}...`)
        }
        const result = await pdfEngine.replaceText(pageIndex, block.id, '')
        if (result.success) {
          if (!snapshotTaken) { pushUndoSnapshot(); snapshotTaken = true }
          deleted++
        } else {
          failed++
        }
      }

      if (deleted > 0) {
        pulledUp = editorStore.reflowOnEdit ? await applyReflow(pageIndex, { moves: reflowPlan, capped: false }) : 0
        docStore.markModified()
        emit('textChanged')
      }
      await loadBlocks()
    })
  } catch (err: any) {
    editorStore.setStatus(`Error: ${err.message}`)
    clearSelection()
    editingBlock.value = null
    return
  }

  const outcome = failed === 0
    ? (deleted === 1 ? 'Text block deleted' : `${deleted} text blocks deleted`)
    : `Deleted ${deleted} of ${deleted + failed} — ${failed} could not be matched in the content stream`
  editorStore.setStatus(
    pulledUp > 0 ? `${outcome} — ${pulledUp} block(s) pulled up to close the gap` : outcome
  )

  clearSelection()
  editingBlock.value = null
}

/** Open the editor over whatever is selected, however many blocks that is. */
function editSelection() {
  const sel = selectedBlocks.value
  if (sel.length === 0) return
  const group = orderedForEditing(sel)
  openInlineEditor(group[0], group)
}

/**
 * Open vertical space in the text at `pdfY`, and report the column it occupies.
 *
 * This is what lets something that is NOT text — an image — sit in the flow
 * instead of on top of it. The caller gets back the column so it can centre
 * itself in the text rather than on the paper, and the Y where the space
 * actually opened, which is the top or bottom of a whole line, never the middle
 * of one.
 *
 * @param below   true to open the space UNDER the line at `pdfY`, false to open
 *                it above (the line itself then moves down with the rest).
 */
/**
 * Open — or close — a gap in the text at a given height on the page.
 *
 * @param amount points to open (positive) or give back (negative)
 */
async function makeRoomAt(pdfY: number, amount: number, below = true): Promise<{
  column: { left: number; right: number } | null
  y: number
  moved: number
  spilled: number
  capped: boolean
}> {
  const pageIndex = docStore.currentPage - 1
  if (blocks.value.length === 0) {
    blocks.value = await pdfEngine.getTextBlocks(pageIndex)
  }
  const all = blocks.value.map(b => ({ id: b.id, bbox: [...b.bbox] as Rect }))
  const rows = groupIntoRows(all)
  if (rows.length === 0) return { column: null, y: pdfY, moved: 0, spilled: 0, capped: false }

  const column = {
    left: Math.min(...rows.map(r => r.rect[0])),
    right: Math.max(...rows.map(r => r.rect[2]))
  }

  // The row the click landed on, or the last one above it.
  let at = rows.findIndex(r => pdfY >= r.rect[1] && pdfY <= r.rect[3])
  if (at < 0) at = rows.reduce((best, r, i) => (r.rect[3] <= pdfY ? i : best), -1)
  const from = below ? at : at - 1
  const y = below
    ? (rows[at] ? rows[at].rect[3] : pdfY)
    : (rows[at] ? rows[at].rect[1] : pdfY)

  if (Math.abs(amount) <= 0.05) return { column, y, moved: 0, spilled: 0, capped: false }

  // A NEGATIVE amount gives room back — the rows below come up.
  //
  // Only growing was handled before, so an image made smaller, or dragged
  // somewhere else, left the gap it used to need sitting empty in the middle of
  // the text: "once I shrink the image or move it, the text no longer adjusts".
  // Pulling up can never run text off the paper, so it has no bottom limit.
  const opening = amount > 0
  const span = [column.left, 0, column.right, props.pdfHeight] as Rect
  const { shifts, capped } = planPushDown(rows, Math.max(from, 0), Math.abs(amount), {
    // Not the paper edge: text pushed to the very bottom reads as broken and is
    // one point from being lost entirely.
    pageHeight: opening ? props.pdfHeight - PAGE_BOTTOM_MARGIN : Infinity,
    maxRows: MAX_PUSHED_ROWS,
    span
  })
  // `planPushDown` starts below `from`; inserting above the first line has to
  // move that line too, which a `from` of -1 cannot express.
  if (!below && at === 0) shifts.set(0, Math.abs(amount))

  const byId = new Map(blocks.value.map(b => [b.id, b]))
  // Tm space is y-up: opening a gap is a negative dy, closing one a positive.
  const sign = opening ? -1 : 1
  const moves: { anchor: Anchor; shift: number }[] = []
  for (const [rowIndex, dy] of shifts) {
    for (const id of rows[rowIndex].blockIds) {
      const b = byId.get(id)
      if (b) moves.push({ anchor: anchorOf(b), shift: sign * dy })
    }
  }

  // Rows below the insertion that the push could NOT take with it: they would
  // have left the paper. Captured BEFORE anything moves, because that is the
  // only moment their geometry is still true.
  const leftBehind = capped && opening
    ? rows
        .map((r, i) => ({ r, i }))
        .filter(({ i }) => i > Math.max(from, 0) && !shifts.has(i))
    : []

  const spillLines: SpillLine[] = []
  const spillAnchors: { anchor: Anchor; lineText: string }[] = []
  for (const { r } of leftBehind) {
    const rowBlocks = r.blockIds.map(id => byId.get(id)).filter((b): b is TextBlock => !!b)
    if (rowBlocks.length === 0) continue
    const text = rowBlocks.map(b => b.text).join(' ').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const c = rowBlocks[0].color
    spillLines.push({
      text,
      x: r.rect[0],
      yTop: r.rect[1],
      fontSize: Math.max(rowBlocks[0].fontSize, 1),
      // Plain array: `block.color` is a Vue reactive proxy, and a proxy cannot
      // be structured-cloned across postMessage — the same trap the ink tool
      // documents. It fails as DataCloneError halfway through the spill.
      color: [c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0]
    })
    for (const b of rowBlocks) spillAnchors.push({ anchor: anchorOf(b), lineText: text })
  }

  let moved = 0
  let spilled = 0
  await enqueueOp(async () => {
    moved = await applyReflow(pageIndex, { moves, capped })

    if (spillLines.length > 0) {
      // DRAW FIRST, then delete — and only what actually landed. The other way
      // round, a redraw that fails (a blank page has no /Contents, which used to
      // throw) leaves the lines deleted from this page and absent from the next:
      // the text is simply gone, with the status bar reporting success.
      const result = await spillChain(pageIndex, spillLines)
      spilled = result.landed.length

      const landedText = new Set(result.landed.map(l => l.text))
      const toClear = spillAnchors.filter(a => landedText.has(a.lineText))
      if (toClear.length > 0) {
        // Resolve every anchor against ONE extraction, then delete from the
        // LAST block to the FIRST.
        //
        // A block id is its index in the extraction, so emptying one either
        // leaves it there or removes it and shifts every LATER index down.
        // Working backwards, the ids still to be used are all lower than the
        // one just deleted and cannot have moved — which is what makes a single
        // extraction enough. Re-extracting per line cost 112ms each on a full
        // page, and a page-filling image spills thirty of them.
        blocks.value = await pdfEngine.getTextBlocks(pageIndex)
        const taken = new Set<string>()
        const targets: TextBlock[] = []
        for (const { anchor } of toClear) {
          const b = findByAnchor(anchor, taken)
          if (!b) continue
          taken.add(b.id)
          targets.push(b)
        }
        targets.sort((a, b) => extractionIndex(b) - extractionIndex(a))
        let done = 0
        for (const b of targets) {
          editorStore.setStatus(`Making room — clearing line ${++done} of ${targets.length}...`)
          await pdfEngine.replaceText(pageIndex, b.id, '')
        }
      }
    }
  })

  if (moved > 0 || spilled > 0) {
    docStore.markModified()
    emit('textChanged')
    await loadBlocks()
  }
  return { column, y, moved, spilled, capped }
}

/**
 * Clear space between text that arrives on a page and the text already there.
 *
 * Without it the two sets meet exactly, and a descender from one line sits in
 * the ascenders of the next — legible, but plainly wrong.
 */
const SPILL_GAP = 8

/** Margins kept on a page that gives or receives spilled text, in points. */
const SPILL_TOP_MARGIN = 56
const PAGE_BOTTOM_MARGIN = 56
/** A spill may not run away across the whole document. */
const MAX_SPILL_PAGES = 20

interface SpillLine { text: string; x: number; yTop: number; fontSize: number; color: [number, number, number] }

/**
 * Push a text run onto the next page, and let what no longer fits there carry
 * on to the one after that.
 *
 * The first version pushed the target page's content down blindly and stopped.
 * On a document whose next page already had text, its last lines were shoved
 * past the bottom of the paper — still in the file, drawn off the page, gone as
 * far as anyone reading it is concerned. Text displaced off a page has to keep
 * going, which is what makes this a chain rather than a single hop.
 *
 * The lines are REDRAWN, not moved: a content-stream run cannot be relocated to
 * another page without carrying its font resources with it. They come back in a
 * standard base-14 face at their original size, colour and left edge. That is a
 * real loss of fidelity, and the caller reports it.
 */
async function spillChain(fromPage: number, lines: SpillLine[]): Promise<{ landed: SpillLine[]; pages: number }> {
  const firstBatch = [...lines].sort((a, b) => a.yTop - b.yTop)
  if (firstBatch.length === 0) return { landed: [], pages: 0 }

  const landed: SpillLine[] = []
  let batch = firstBatch
  let target = fromPage + 1
  let pagesTouched = 0

  while (batch.length > 0 && pagesTouched < MAX_SPILL_PAGES) {
    if (target >= docStore.totalPages) {
      const count = await pdfEngine.insertBlankPage(target, props.pdfWidth, props.pdfHeight)
      if (count === false) break
      docStore.totalPages = count
    }

    const arriving = batch.reduce((h, l) => h + lineStep(l.fontSize), 0)
    const limit = props.pdfHeight - PAGE_BOTTOM_MARGIN

    // What is already there, and what of it will not survive the push.
    const existing = await pdfEngine.getTextBlocks(target)
    const rows = groupIntoRows(existing.map(b => ({ id: b.id, bbox: [...b.bbox] as Rect })))
    const byId = new Map(existing.map(b => [b.id, b]))

    // How far this page's own text has to move, measured from where it STARTS.
    //
    // Pushing it by the height of what is arriving is not enough, and that was
    // the bug: the arriving lines are drawn from the top MARGIN downwards, so
    // they end at `SPILL_TOP_MARGIN + arriving`, while text that began at the
    // top of the page ends up at `itsTop + arriving`. The difference is the
    // margin, and the two sets of lines were printed through each other for
    // exactly that many points — "the letters all mix together" when text moves
    // to the next page.
    //
    // The shift is therefore whatever it takes to put the first existing row
    // clear of the arriving block, and zero when the page already starts low
    // enough to have room.
    const existingTop = rows.length > 0
      ? Math.min(...rows.map(r => r.rect[1]))
      : props.pdfHeight
    const shift = Math.max(0, SPILL_TOP_MARGIN + arriving + SPILL_GAP - existingTop)

    const staying: typeof rows = []
    const displaced: SpillLine[] = []
    const displacedAnchors: Anchor[] = []
    for (const row of rows) {
      if (row.rect[3] + shift <= limit) { staying.push(row); continue }
      const rowBlocks = row.blockIds.map(id => byId.get(id)).filter((b): b is TextBlock => !!b)
      const text = rowBlocks.map(b => b.text).join(' ').replace(/\s+/g, ' ').trim()
      if (!text) continue
      const c = rowBlocks[0].color
      displaced.push({
        text, x: row.rect[0], yTop: row.rect[1],
        fontSize: Math.max(rowBlocks[0].fontSize, 1),
        color: [c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0]
      })
      for (const b of rowBlocks) displacedAnchors.push(anchorOf(b))
    }

    // Draw the arriving lines at the top margin.
    let y = SPILL_TOP_MARGIN
    const arrivedHere: SpillLine[] = []
    for (const line of batch) {
      const baseline = props.pdfHeight - y - line.fontSize * 0.8
      const ok = await pdfEngine.addText(target, line.x, baseline, line.text, line.fontSize, 'Helvetica', line.color)
      if (ok) arrivedHere.push(line)
      else console.warn('[spill] line not redrawn:', pdfEngine.error.value, JSON.stringify(line.text.slice(0, 40)))
      y += lineStep(line.fontSize)
    }
    landed.push(...arrivedHere)
    if (arrivedHere.length === 0) break

    // Move what stays out of the way of what just arrived.
    if (staying.length > 0 && shift > 0.5) {
      const ops: BlockTransformOp[] = []
      for (const row of staying) {
        for (const id of row.blockIds) {
          ops.push({ blockId: id, dx: 0, dy: -shift, sx: 1, sy: 1, anchorX: 0, anchorY: 0 })
        }
      }
      if (ops.length > 0) await pdfEngine.transformTextBlocks(target, ops)
    }

    // Clear the rows that no longer fit, so they can be redrawn on the next page.
    for (const anchor of displacedAnchors) {
      const fresh = await pdfEngine.getTextBlocks(target)
      const b = findByAnchorIn(fresh, anchor)
      if (b) await pdfEngine.replaceText(target, b.id, '')
    }

    pagesTouched++
    batch = displaced
    target++
  }

  return { landed, pages: pagesTouched }
}

/** `findByAnchor` against an explicit block list — the overlay's own is this page's. */
function findByAnchorIn(list: TextBlock[], anchor: Anchor): TextBlock | null {
  const exact = list.filter(b => b.text === anchor.text)
  const pool = exact.length > 0 ? exact : list.filter(b => b.text.startsWith(anchor.text.slice(0, 3)))
  if (pool.length === 0) return null
  if (pool.length === 1) return pool[0]
  let best: { b: TextBlock; d: number } | null = null
  for (const b of pool) {
    const d = Math.hypot((b.bbox[0] + b.bbox[2]) / 2 - anchor.cx, (b.bbox[1] + b.bbox[3]) / 2 - anchor.cy)
    if (!best || d < best.d) best = { b, d }
  }
  return best && best.d < 24 ? best.b : null
}

function selectAllBlocks() {
  setSelection([...blocks.value])
  editorStore.setStatus(`${selectedIds.value.length} text block(s) selected`)
}

// ── Rubber-band selection ──

function localPoint(event: MouseEvent, el: HTMLElement) {
  const rect = el.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function onMarqueeStart(event: MouseEvent) {
  if (pageRotated.value) return
  const { x, y } = localPoint(event, event.currentTarget as HTMLElement)
  marquee.value = {
    x0: x, y0: y, x1: x, y1: y,
    additive: event.shiftKey || event.ctrlKey || event.metaKey
  }
  marqueeMoved.value = false
  document.addEventListener('mousemove', onMarqueeMove)
  document.addEventListener('mouseup', onMarqueeEnd)
}

function onMarqueeMove(event: MouseEvent) {
  const m = marquee.value
  if (!m || !hostRef.value) return
  const { x, y } = localPoint(event, hostRef.value)
  m.x1 = x
  m.y1 = y
  if (!marqueeMoved.value && (Math.abs(m.x1 - m.x0) > 3 || Math.abs(m.y1 - m.y0) > 3)) {
    marqueeMoved.value = true
  }
}

function onMarqueeEnd() {
  document.removeEventListener('mousemove', onMarqueeMove)
  document.removeEventListener('mouseup', onMarqueeEnd)

  const m = marquee.value
  const dragged = marqueeMoved.value
  marquee.value = null
  marqueeMoved.value = false
  if (!m) return

  // A click on empty page with no drag just clears the selection.
  if (!dragged) {
    if (!m.additive) clearSelection()
    return
  }

  const box = {
    left: Math.min(m.x0, m.x1),
    top: Math.min(m.y0, m.y1),
    right: Math.max(m.x0, m.x1),
    bottom: Math.max(m.y0, m.y1)
  }

  // Anything the band TOUCHES is in. Requiring full containment means stopping
  // the band a point short of a descender silently drops that line, and there
  // is no way for the user to tell why part of their field stayed behind.
  const hit = blocks.value.filter(block => {
    const r = baseRect(block)
    return r.left < box.right && box.left < r.left + r.width &&
           r.top < box.bottom && box.top < r.top + r.height
  })

  if (m.additive) {
    const already = new Set(selectedIds.value)
    for (const block of hit) {
      if (already.has(block.id)) continue
      already.add(block.id)
      selectedIds.value.push(block.id)
      selectionAnchors.value.push(anchorOf(block))
    }
  } else {
    setSelection(hit)
  }

  editorStore.setStatus(selectedIds.value.length === 0
    ? 'Nothing selected'
    : `${selectedIds.value.length} text block(s) selected — drag to move them together`)
}

// ── Move / Resize drag ──

function onBlockMouseDown(event: MouseEvent, blockId: string) {
  if (!['select', 'edit'].includes(editorStore.currentTool)) return
  const block = blocks.value.find(b => b.id === blockId)
  if (!block) return

  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    toggleSelection(block)
    return
  }

  // Dragging any member of a multi-block selection drags the WHOLE selection —
  // re-selecting just that block would silently discard the group the user
  // built with the rubber band.
  if (!selectedSet.value.has(blockId)) setSelection([block])

  startDrag(event, 'move')
}

function onHandleMouseDown(event: MouseEvent, handle: HandlePosition) {
  if (!hasSelection.value) return
  startDrag(event, 'resize', handle)
}

function startDrag(event: MouseEvent, mode: 'move' | 'resize', handle?: HandlePosition) {
  const sel = selectedBlocks.value
  if (sel.length === 0) return

  const origBlockRects = new Map<string, ScreenRect>()
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
  for (const block of sel) {
    const rect = baseRect(block)
    origBlockRects.set(block.id, rect)
    l = Math.min(l, rect.left); t = Math.min(t, rect.top)
    r = Math.max(r, rect.left + rect.width); b = Math.max(b, rect.top + rect.height)
  }

  dragState.value = {
    mode,
    handle,
    startMouseX: event.clientX,
    startMouseY: event.clientY,
    currentDeltaX: 0,
    currentDeltaY: 0,
    origScreenBbox: { left: l, top: t, width: r - l, height: b - t },
    origBlockRects,
    isDragging: false
  }

  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup', onDragEnd)
}

function onDragMove(event: MouseEvent) {
  if (!dragState.value) return

  const dx = event.clientX - dragState.value.startMouseX
  const dy = event.clientY - dragState.value.startMouseY

  dragState.value.currentDeltaX = dx
  dragState.value.currentDeltaY = dy

  if (!dragState.value.isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
    dragState.value.isDragging = true
  }
}

/**
 * Work out what has to move out of the way, as engine ops.
 *
 * `destRects` is where the dragged blocks are GOING. Everything else on the page
 * is clustered into baseline rows — a visual line is several blocks, and moving
 * only the half that happened to overlap would tear the line apart — and each
 * colliding row is displaced along Y until it is clear.
 */
function buildCollisionOps(destRects: Rect[]): {
  ops: BlockTransformOp[]
  rowsPushed: number
  blocked: number
  capped: boolean
} {
  const others = blocks.value
    .filter(b => !selectedSet.value.has(b.id))
    .map(b => ({ id: b.id, bbox: [...b.bbox] as Rect }))

  const rows = groupIntoRows(others)
  const { shifts, blocked, capped } = resolveCollisions(destRects, rows, {
    gap: COLLISION_GAP,
    pageHeight: props.pdfHeight,
    maxRows: MAX_PUSHED_ROWS
  })

  const ops: BlockTransformOp[] = []
  for (const [rowIndex, dy] of shifts) {
    for (const blockId of rows[rowIndex].blockIds) {
      // Page space is y-down, Tm space is y-up.
      ops.push({ blockId, dx: 0, dy: -dy, sx: 1, sy: 1, anchorX: 0, anchorY: 0 })
    }
  }

  return { ops, rowsPushed: shifts.size, blocked, capped }
}

async function onDragEnd() {
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)

  const ds = dragState.value

  if (!ds || !ds.isDragging) {
    dragState.value = null
    // A click with no drag opens the inline editor, but only for a lone block:
    // opening it for one member of a group would edit that line and quietly
    // drop the rest of the selection.
    if (ds && editorStore.currentTool === 'edit' && selectedBlocks.value.length >= 1) {
      const group = orderedForEditing(selectedBlocks.value)
      openInlineEditor(group[0], group)
    }
    return
  }

  const sel = selectedBlocks.value
  if (sel.length === 0) { dragState.value = null; return }

  const pageIndex = docStore.currentPage - 1
  const isMove = ds.mode === 'move'

  editorStore.setStatus(isMove
    ? (sel.length > 1 ? `Moving ${sel.length} text blocks...` : 'Moving text block...')
    : 'Resizing selection...')

  // ── Geometry, in PDF page space (top-left origin, y down) ──
  let dxP = 0, dyP = 0, sx = 1, sy = 1
  let anchorTmX = 0, anchorTmY = 0

  if (isMove) {
    dxP = ds.currentDeltaX / scaleX.value
    dyP = ds.currentDeltaY / scaleY.value
  } else if (ds.handle) {
    const union = ds.origScreenBbox
    const resized = computeResizedBbox(union, ds.handle, ds.currentDeltaX, ds.currentDeltaY)
    // A zero-extent selection would make the scale factor Infinity and corrupt
    // the text matrix — leave it unscaled on that axis instead.
    sx = union.width > 0.01 ? resized.width / union.width : 1
    sy = union.height > 0.01 ? resized.height / union.height : 1

    const unionPdf: Rect = [
      union.left / scaleX.value, union.top / scaleY.value,
      (union.left + union.width) / scaleX.value, (union.top + union.height) / scaleY.value
    ]
    // Every block scales about the SAME anchor, so the group keeps its shape.
    const anchor = getAnchorPoint(ds.handle, unionPdf)
    anchorTmX = anchor.x
    anchorTmY = props.pdfHeight - anchor.y
  }

  // Where each dragged block lands, in page space — used both for collision
  // detection and to re-anchor the selection after the reload. Taken from the
  // live preview rects so what the engine is asked for is exactly what the user
  // saw under the cursor.
  const destRects: Rect[] = sel.map(block => {
    const screen = getScreenBbox(block)
    return [
      screen.left / scaleX.value,
      screen.top / scaleY.value,
      (screen.left + screen.width) / scaleX.value,
      (screen.top + screen.height) / scaleY.value
    ]
  })

  // A DRAG always displaces what it lands on, whatever the Reflow toggle says.
  //
  // The toggle exists because an EDIT should not rearrange a page: someone
  // typing into a form wants that field changed and nothing else, and pushing
  // every row below it tears labels away from their values. Dropping a
  // paragraph on top of another one is not that. The user aimed at that spot,
  // there is no flow in a content stream to make room by itself, and leaving
  // the two overlaid is not a conservative outcome — it is an unreadable one.
  // Ctrl+Z takes back the whole move, displacements included.
  const collision = buildCollisionOps(destRects)

  const selOps: BlockTransformOp[] = sel.map(block => ({
    blockId: block.id,
    dx: isMove ? dxP : 0,
    dy: isMove ? -dyP : 0,   // Tm coords are bottom-left origin, y up
    sx,
    sy,
    anchorX: anchorTmX,
    anchorY: anchorTmY
  }))

  // Displacements go FIRST so the obstacles have vacated their old coordinates
  // before the dragged text is matched — two runs with the same text sitting on
  // top of each other is exactly what defeats position-based matching.
  const ops = [...collision.ops, ...selOps]

  try {
    await enqueueOp(async () => {
      const result = await pdfEngine.transformTextBlocks(pageIndex, ops)

      if (result.applied === 0) {
        editorStore.setStatus(`Transform failed: ${pdfEngine.error.value || 'unknown error'}`)
        return
      }

      pushUndoSnapshot() // snapshot pre-edit bytes only on success (before re-render)
      docStore.markModified()

      // Re-anchor to where the blocks land so the selection survives this
      // reload AND the save→reload that emit('textChanged') queues behind it.
      selectionAnchors.value = sel.map((block, i) => ({
        text: block.text,
        cx: (destRects[i][0] + destRects[i][2]) / 2,
        cy: (destRects[i][1] + destRects[i][3]) / 2
      }))

      // The ops were sent as [displacements..., selection...], so the tail of
      // the results array is what happened to the text the user actually
      // dragged. Reporting on the whole batch instead would call a failed move
      // a partial success just because the displacements landed.
      const selResults = result.results.slice(collision.ops.length)
      const selApplied = selResults.filter(r => r.success).length

      editorStore.setStatus(describeTransform(selApplied, sel.length, collision, isMove))
      emit('textChanged')
      await loadBlocks()
    })
  } catch (err: any) {
    editorStore.setStatus(`Error: ${err.message}`)
  }

  dragState.value = null
}

/**
 * Say what actually happened, including the parts that did not.
 *
 * The displacements are applied before the move, so a move that fails leaves the
 * page rearranged around text that never went anywhere. That has to be stated
 * plainly — it is exactly the case where the user needs to reach for Ctrl+Z.
 */
function describeTransform(
  selApplied: number,
  selCount: number,
  collision: { rowsPushed: number; blocked: number; capped: boolean },
  isMove: boolean
): string {
  const verb = isMove ? 'moved' : 'resized'
  const parts: string[] = []

  if (selApplied === 0) {
    parts.push(`Could not be ${verb} — no matching text found in the content stream`)
    if (collision.rowsPushed > 0) {
      parts.push(`${collision.rowsPushed} line(s) were already shifted aside; press Ctrl+Z to undo`)
    }
    return parts.join(' — ')
  }

  parts.push(selApplied === selCount
    ? `${selCount === 1 ? 'Text block' : `${selCount} text blocks`} ${verb}`
    : `Partially ${verb} — ${selApplied} of ${selCount} blocks`)

  if (collision.rowsPushed > 0) {
    parts.push(`${collision.rowsPushed} line(s) shifted to make room`)
  }
  if (collision.blocked > 0) {
    parts.push(`${collision.blocked} line(s) could not be shifted (page edge) and may still overlap`)
  }
  if (collision.capped) {
    parts.push(`stopped after ${MAX_PUSHED_ROWS} lines — some text may still overlap`)
  }

  return parts.join(' — ')
}

function computeResizedBbox(
  orig: ScreenRect,
  handle: HandlePosition,
  dx: number,
  dy: number
): ScreenRect {
  let { left, top, width, height } = orig

  switch (handle) {
    case 'nw': left += dx; top += dy; width -= dx; height -= dy; break
    case 'n': top += dy; height -= dy; break
    case 'ne': top += dy; width += dx; height -= dy; break
    case 'e': width += dx; break
    case 'se': width += dx; height += dy; break
    case 's': height += dy; break
    case 'sw': left += dx; width -= dx; height += dy; break
    case 'w': left += dx; width -= dx; break
  }

  // Enforce minimum size
  if (width < 20) { width = 20 }
  if (height < 10) { height = 10 }

  return { left, top, width, height }
}

function getAnchorPoint(handle: HandlePosition, pdfBbox: Rect): { x: number; y: number } {
  const [x0, y0, x1, y1] = pdfBbox
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2

  // Returns the anchor in PDF top-left coords (the corner opposite to the handle)
  switch (handle) {
    case 'nw': return { x: x1, y: y1 }
    case 'n': return { x: cx, y: y1 }
    case 'ne': return { x: x0, y: y1 }
    case 'e': return { x: x0, y: cy }
    case 'se': return { x: x0, y: y0 }
    case 's': return { x: cx, y: y0 }
    case 'sw': return { x: x1, y: y0 }
    case 'w': return { x: x1, y: cy }
  }
}

// ── Add text ──

function onAddTextClick(event: MouseEvent) {
  if (pageRotated.value) {
    editorStore.setStatus('Text editing is disabled on rotated pages — rotate back to 0° first')
    return
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const screenX = event.clientX - rect.left
  const screenY = event.clientY - rect.top

  addTextScreenX.value = screenX
  addTextScreenY.value = screenY
  addTextPdfX.value = screenX / scaleX.value
  // Tm Y is the text BASELINE (bottom of the glyph box). The user clicks where they
  // expect the TOP of the text, so drop the baseline by ~one ascent (0.8em) below
  // the click point, matching the inline preview which grows downward.
  addTextPdfY.value = props.pdfHeight - (screenY / scaleY.value) - editorStore.fontSize * 0.8

  isAddingText.value = true
  addTextValue.value = ''
  nextTick(() => addTextEditorRef.value?.focus())
}

async function commitAddText() {
  if (!addTextValue.value.trim()) {
    cancelAddText()
    return
  }

  const pageIndex = docStore.currentPage - 1
  editorStore.setStatus('Adding text...')

  try {
    await enqueueOp(async () => {
      const success = await pdfEngine.addText(
        pageIndex,
        addTextPdfX.value,
        addTextPdfY.value,
        addTextValue.value,
        editorStore.fontSize,
        'Helvetica'
      )

      if (success) {
        pushUndoSnapshot() // snapshot pre-edit bytes only on success (before re-render)
        docStore.markModified()
        editorStore.setStatus('Text added successfully')
        emit('textChanged')
        await loadBlocks()
      } else {
        editorStore.setStatus(`Add text failed: ${pdfEngine.error.value || 'unknown error'}`)
      }
    })
  } catch (err: any) {
    editorStore.setStatus(`Error: ${err.message}`)
  }

  isAddingText.value = false
  addTextValue.value = ''
}

function cancelAddText() {
  isAddingText.value = false
  addTextValue.value = ''
}

// ── Cleanup ──

function cleanupDrag() {
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
  document.removeEventListener('mousemove', onMarqueeMove)
  document.removeEventListener('mouseup', onMarqueeEnd)
  dragState.value = null
  marquee.value = null
  marqueeMoved.value = false
}

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented) return // another layer already handled this keypress
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
  if (!['select', 'edit'].includes(editorStore.currentTool)) return

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && blocks.value.length > 0) {
    e.preventDefault()
    selectAllBlocks()
    return
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && hasSelection.value && !editingBlock.value) {
    e.preventDefault()
    deleteSelectedBlocks()
  }
}
window.addEventListener('keydown', onKeyDown)

onBeforeUnmount(() => {
  cleanupDrag()
  window.removeEventListener('keydown', onKeyDown)
})

// ── Watchers ──

/**
 * Load on MOUNT, not only when something changes.
 *
 * Every one of the watchers below fires on a CHANGE, which was enough while
 * this overlay was created once and lived for the whole session. Continuous
 * scrolling moves it: it is destroyed on the page being left and built again on
 * the page arrived at, and a fresh instance has missed every change that ever
 * happened. Nothing loaded, so the editing layer was empty on every page except
 * the one that happened to be current when the tool was picked — the text was
 * on the paper and simply could not be touched.
 */
onMounted(() => {
  if (showOverlay.value && pdfEngine.docLoaded.value) loadBlocks()
})

watch(() => editorStore.currentTool, (tool) => {
  if (['edit', 'select', 'addText'].includes(tool)) {
    loadBlocks(true)
  } else {
    blocks.value = []
    cancelEdit()
  }
  if (tool !== 'addText') {
    cancelAddText()
  }
  if (!['select', 'edit'].includes(tool)) {
    clearSelection()
    cleanupDrag()
  }
})

/**
 * A document arriving is the one case the tool watcher cannot cover: 'select'
 * is the tool the app starts on, so opening a PDF never changes it and the
 * blocks were never fetched — the page looked as if it held no selectable text
 * until you round-tripped through another tool.
 */
watch(() => pdfEngine.docLoaded.value, (loaded) => {
  if (loaded) loadBlocks(true)
})

watch(() => docStore.currentPage, () => {
  cancelEdit()
  cancelAddText()
  cleanupDrag()
  clearSelection() // the anchored blocks live on the page we just left
  loadBlocks()
})

// Document bytes changed outside this overlay (rotate, page ops, undo/redo) —
// cached block geometry is stale, so reload it. The selection is NOT dropped
// here: loadBlocks re-resolves it from selectionAnchors, so moved blocks stay
// selected through the save→reload cycle that every edit triggers.
watch(() => docStore.renderVersion, () => {
  cancelEdit()
  cleanupDrag()
  loadBlocks()
})

defineExpose({ loadBlocks, deleteSelectedBlocks, selectAllBlocks, makeRoomAt })
</script>

<style scoped>
.text-overlay-container {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

/* Full-page capture layer for the rubber band. Below the blocks (z-index 0), so
   a click that lands on text still selects that text. */
.marquee-target {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: auto;
  cursor: crosshair;
  z-index: 0;
}

.text-block {
  position: absolute;
  border: 1px dashed transparent;
  cursor: text;
  pointer-events: auto;
  transition: border-color 0.15s;
  z-index: 1;
}

.text-block:hover {
  border-color: rgba(66, 133, 244, 0.5);
}

.text-block.selected {
  border: 1.5px dashed #4285f4;
  background-color: rgba(66, 133, 244, 0.12);
}

.text-block.movable {
  cursor: move;
}

.marquee {
  position: absolute;
  border: 1px solid #4285f4;
  background: rgba(66, 133, 244, 0.12);
  pointer-events: none;
  z-index: 15;
}

.selection-outline {
  position: absolute;
  border: 1px solid rgba(66, 133, 244, 0.9);
  border-radius: 2px;
  pointer-events: none;
  z-index: 14;
}

.selection-handle {
  background: #4285f4;
  border: 1px solid #1a73e8;
  border-radius: 1px;
  box-sizing: border-box;
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.3);
}

/* Solid chip so the controls stay readable over any page content — over white
   paper a bare icon button is all but invisible. */
.selection-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 26px;
  padding: 0 5px;
  background: rgba(32, 33, 36, 0.95);
  border: 1px solid rgba(66, 133, 244, 0.85);
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
  white-space: nowrap;
}

.actions-count {
  font-size: 11px;
  font-weight: 600;
  color: #e8eaed;
  min-width: 10px;
  text-align: center;
}

.inline-editor {
  position: absolute;
  pointer-events: auto;
  z-index: 30;
  border: 1px solid #4285f4;
  background: rgba(255, 255, 255, 0.97);
  padding: 1px 1px;
  outline: none;
  font-family: inherit;
  box-sizing: border-box;
  white-space: nowrap;
  cursor: text;
  overflow: visible;
}

.inline-editor:focus {
  border-color: #1a73e8;
  background: rgba(255, 255, 255, 1);
}

.inline-editor-wrapper {
  position: absolute;
  pointer-events: auto;
  z-index: 30;
  display: flex;
  flex-direction: column;
}

.add-text-editor {
  width: 100%;
  min-height: 40px;
  border: 1.5px solid #34a853;
  background: rgba(255, 255, 255, 0.97);
  padding: 3px 4px;
  resize: both;
  outline: none;
  font-family: Helvetica, Arial, sans-serif;
  font-size: 12px;
  line-height: 1.3;
  box-sizing: border-box;
}

.editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  background: rgba(50, 50, 50, 0.9);
  border-radius: 0 0 4px 4px;
  padding: 1px;
}

.add-text-target {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: auto;
  cursor: crosshair;
  z-index: 2;
}
</style>
