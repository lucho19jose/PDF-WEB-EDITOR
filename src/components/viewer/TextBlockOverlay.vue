<template>
  <div class="text-overlay-container" v-if="showOverlay">
    <!-- Clickable text blocks (edit + select modes) -->
    <div
      v-for="block in scaledBlocks"
      :key="block.id"
      class="text-block"
      :class="{
        selected: selectedBlockId === block.id,
        movable: selectedBlockId === block.id && ['select', 'edit'].includes(editorStore.currentTool)
      }"
      :style="block.style"
      @mousedown.stop="onBlockMouseDown($event, block.id)"
    />

    <!-- Selection handles (select or edit mode, block selected, not editing inline) -->
    <template v-if="selectedBlockId && ['select', 'edit'].includes(editorStore.currentTool) && !editingBlock">
      <div
        v-for="handle in selectionHandles"
        :key="handle.pos"
        class="selection-handle"
        :style="handle.style"
        @mousedown.stop.prevent="onHandleMouseDown($event, handle.pos)"
      />
    </template>

    <!-- Delete hint when block selected (not editing inline) -->
    <div
      v-if="selectedBlockId && !editingBlock && !isAddingText && ['select', 'edit'].includes(editorStore.currentTool) && !dragState?.isDragging"
      class="delete-hint"
      :style="deleteHintStyle"
      @mousedown.prevent
    >
      <q-btn dense flat size="xs" color="negative" icon="delete" @click.stop="deleteSelectedBlock">
        <q-tooltip>Delete (Del)</q-tooltip>
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
import { ref, computed, watch, nextTick, inject, onBeforeUnmount } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import { enqueueOp } from '@/utils/opQueue'
import type { usePDFEngine } from '@/composables/usePDFEngine'
import type { TextBlock } from '@/engine/types'

type HandlePosition = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

interface DragState {
  mode: 'move' | 'resize'
  blockId: string
  handle?: HandlePosition
  startMouseX: number
  startMouseY: number
  currentDeltaX: number
  currentDeltaY: number
  origScreenBbox: { left: number; top: number; width: number; height: number }
  origPdfBbox: [number, number, number, number]
  isDragging: boolean
}

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

const blocks = ref<TextBlock[]>([])
const selectedBlockId = ref<string | null>(null)
/**
 * Block ids are "page:extractionIndex" and are NOT stable: a save→reload cycle
 * (every edit) re-extracts the page, and moving a block changes its position in
 * MuPDF's extraction order. Remembering what was selected — its text and where
 * it sits — lets the selection be re-resolved after each reload instead of
 * being dropped (or, worse, left pointing at somebody else's paragraph).
 */
const selectionAnchor = ref<{ text: string; cx: number; cy: number } | null>(null)
const editingBlock = ref<TextBlock | null>(null)
const editText = ref('')
const editorRef = ref<HTMLDivElement | null>(null)
let isCommitting = false

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

// Show overlay for edit, select, and addText modes
const showOverlay = computed(() =>
  ['edit', 'select', 'addText'].includes(editorStore.currentTool)
)

// Scale factor: rendered canvas size / PDF user-space size
const scaleX = computed(() => props.pageWidth / props.pdfWidth)
const scaleY = computed(() => props.pageHeight / props.pdfHeight)

/** Get screen bbox for a block, accounting for active drag */
function getScreenBbox(block: TextBlock) {
  const left = block.bbox[0] * scaleX.value
  const top = block.bbox[1] * scaleY.value
  const width = (block.bbox[2] - block.bbox[0]) * scaleX.value
  const height = (block.bbox[3] - block.bbox[1]) * scaleY.value

  if (dragState.value?.isDragging && dragState.value.blockId === block.id) {
    const ds = dragState.value
    if (ds.mode === 'move') {
      return {
        left: ds.origScreenBbox.left + ds.currentDeltaX,
        top: ds.origScreenBbox.top + ds.currentDeltaY,
        width: ds.origScreenBbox.width,
        height: ds.origScreenBbox.height
      }
    } else if (ds.mode === 'resize' && ds.handle) {
      return computeResizedBbox(ds.origScreenBbox, ds.handle, ds.currentDeltaX, ds.currentDeltaY)
    }
  }

  return { left, top, width, height }
}

// Transform blocks from PDF coords to screen coords
const scaledBlocks = computed(() => {
  return blocks.value.map(block => {
    const bbox = getScreenBbox(block)
    return {
      id: block.id,
      style: {
        left: `${bbox.left}px`,
        top: `${bbox.top}px`,
        width: `${bbox.width}px`,
        height: `${bbox.height}px`
      }
    }
  })
})

// Selection handles around the selected block
const selectionHandles = computed(() => {
  if (!selectedBlockId.value || !['select', 'edit'].includes(editorStore.currentTool)) return []

  const block = blocks.value.find(b => b.id === selectedBlockId.value)
  if (!block) return []

  const { left, top, width, height } = getScreenBbox(block)
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

const editorStyle = computed(() => {
  if (!editingBlock.value) return {}
  const block = editingBlock.value
  const x = block.bbox[0] * scaleX.value
  const y = block.bbox[1] * scaleY.value
  const w = (block.bbox[2] - block.bbox[0]) * scaleX.value
  const h = (block.bbox[3] - block.bbox[1]) * scaleY.value
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

const deleteHintStyle = computed(() => {
  if (!selectedBlockId.value) return {}
  const block = blocks.value.find(b => b.id === selectedBlockId.value)
  if (!block) return {}
  const bbox = getScreenBbox(block)
  return {
    left: `${bbox.left + bbox.width + 4}px`,
    top: `${bbox.top}px`,
    position: 'absolute' as const,
    pointerEvents: 'auto' as const,
    zIndex: 10
  }
})

// ── Block loading ──

const pageRotated = ref(false)

async function loadBlocks() {
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
    if (editorStore.currentTool === 'edit') {
      editorStore.setStatus(`Edit mode: ${data.length} text blocks found`)
    }
  } catch (err: any) {
    console.error('Failed to load text blocks:', err)
    blocks.value = []
    clearSelection()
  }
}

/** Select a block (or nothing) and remember it for post-reload re-resolution. */
function setSelection(block: TextBlock | null) {
  selectedBlockId.value = block?.id ?? null
  selectionAnchor.value = block
    ? {
        text: block.text,
        cx: (block.bbox[0] + block.bbox[2]) / 2,
        cy: (block.bbox[1] + block.bbox[3]) / 2
      }
    : null
}

function clearSelection() {
  selectedBlockId.value = null
  selectionAnchor.value = null
}

/** Re-point selectedBlockId at the anchored block in the freshly loaded set. */
function resolveSelection() {
  const anchor = selectionAnchor.value
  if (!anchor) { selectedBlockId.value = null; return }

  let candidates = blocks.value.filter(b => b.text === anchor.text)
  if (candidates.length === 0) {
    // Scaling text up can push its tail past the page edge, so re-extraction
    // returns a clipped string — match on the surviving prefix instead.
    const prefix = anchor.text.slice(0, 3)
    candidates = prefix.length === 3
      ? blocks.value.filter(b => b.text.startsWith(prefix) &&
          (b.text.startsWith(anchor.text) || anchor.text.startsWith(b.text)))
      : []
  }
  if (candidates.length === 0) { clearSelection(); return }

  // Unambiguous text wins outright — a resize can move the centre a long way,
  // so a distance cutoff would drop the selection on big drags.
  if (candidates.length === 1) {
    selectedBlockId.value = candidates[0].id
    return
  }

  // Repeated text (table cells, signature lines): disambiguate by position,
  // and rather lose the selection than adopt a twin on the far side of the
  // page — that would move the wrong text on the next drag.
  let best: { id: string; dist: number } | null = null
  for (const b of candidates) {
    const dist = Math.hypot(
      (b.bbox[0] + b.bbox[2]) / 2 - anchor.cx,
      (b.bbox[1] + b.bbox[3]) / 2 - anchor.cy
    )
    if (!best || dist < best.dist) best = { id: b.id, dist }
  }
  if (best && best.dist < 24) selectedBlockId.value = best.id
  else clearSelection()
}

// ── Block selection & editing ──

function selectBlock(id: string) {
  const block = blocks.value.find(b => b.id === id)
  if (!block) return

  setSelection(block)

  if (editorStore.currentTool === 'edit') {
    editingBlock.value = block
    editText.value = block.text
    nextTick(() => {
      if (editorRef.value) {
        editorRef.value.textContent = block.text
        editorRef.value.focus()
        // Select all text
        const range = document.createRange()
        range.selectNodeContents(editorRef.value)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
    })
  }
}

function onBlur() {
  // Capture WHICH block and WHAT text at blur time — reading live state when
  // the timer fires can commit block A's text under block B's id (or silently
  // drop the edit) if the user quick-clicks another block within 150 ms.
  const block = editingBlock.value
  const text = editorRef.value?.textContent ?? ''
  if (!block) return
  setTimeout(() => {
    if (!isCommitting) {
      commitEdit(block, text)
    }
  }, 150)
}

function pushUndoSnapshot() {
  const currentBytes = docStore.pdfBytes
  if (currentBytes) {
    historyStore.pushSnapshot(new Uint8Array(currentBytes))
  }
}

async function commitEdit(block: TextBlock, newText: string) {
  if (isCommitting) return
  if (newText === block.text) {
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
      const result = await pdfEngine.replaceText(pageIndex, block.id, newText)
      if (result.success) {
        pushUndoSnapshot() // snapshot pre-edit bytes only on success (before re-render)
        docStore.markModified()
        emit('textChanged')
        await loadBlocks()
        editorStore.setStatus(result.substitutedFont
          ? `Text replaced — original font lacks some characters, substituted ${result.substitutedFont}`
          : 'Text replaced successfully')
      } else {
        editorStore.setStatus(`Edit failed: ${pdfEngine.error.value || 'unknown error'}`)
      }
    })
  } catch (err: any) {
    editorStore.setStatus(`Error: ${err.message}`)
  }

  editingBlock.value = null
  clearSelection()
  isCommitting = false
}

function cancelEdit() {
  isCommitting = false
  editingBlock.value = null
  // Keep selectedBlockId so handles remain visible for move/resize
}

async function deleteSelectedBlock() {
  if (!selectedBlockId.value) return
  const block = blocks.value.find(b => b.id === selectedBlockId.value)
  if (!block) return

  const pageIndex = docStore.currentPage - 1
  editorStore.setStatus('Deleting text block...')

  try {
    await enqueueOp(async () => {
      const result = await pdfEngine.replaceText(pageIndex, block.id, '')
      if (result.success) {
        pushUndoSnapshot() // snapshot pre-edit bytes only on success (before re-render)
        docStore.markModified()
        emit('textChanged')
        await loadBlocks()
        editorStore.setStatus('Text block deleted')
      } else {
        editorStore.setStatus(`Delete failed: ${pdfEngine.error.value || 'unknown error'}`)
      }
    })
  } catch (err: any) {
    editorStore.setStatus(`Error: ${err.message}`)
  }

  clearSelection()
  editingBlock.value = null
}

// ── Move / Resize drag ──

function onBlockMouseDown(event: MouseEvent, blockId: string) {
  // In select or edit mode, select and start potential drag for move
  if (['select', 'edit'].includes(editorStore.currentTool)) {
    setSelection(blocks.value.find(b => b.id === blockId) ?? null)
    startDrag(event, blockId, 'move')
  }
}

function onHandleMouseDown(event: MouseEvent, handle: HandlePosition) {
  if (!selectedBlockId.value) return
  startDrag(event, selectedBlockId.value, 'resize', handle)
}

function startDrag(event: MouseEvent, blockId: string, mode: 'move' | 'resize', handle?: HandlePosition) {
  const block = blocks.value.find(b => b.id === blockId)
  if (!block) return

  const left = block.bbox[0] * scaleX.value
  const top = block.bbox[1] * scaleY.value
  const width = (block.bbox[2] - block.bbox[0]) * scaleX.value
  const height = (block.bbox[3] - block.bbox[1]) * scaleY.value

  dragState.value = {
    mode,
    blockId,
    handle,
    startMouseX: event.clientX,
    startMouseY: event.clientY,
    currentDeltaX: 0,
    currentDeltaY: 0,
    origScreenBbox: { left, top, width, height },
    origPdfBbox: [...block.bbox] as [number, number, number, number],
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

async function onDragEnd() {
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)

  if (!dragState.value || !dragState.value.isDragging) {
    // No drag happened — it was a click
    const blockId = dragState.value?.blockId
    dragState.value = null
    // In edit mode, a click (no drag) opens the inline editor
    if (blockId && editorStore.currentTool === 'edit') {
      selectBlock(blockId)
    }
    return
  }

  const ds = dragState.value
  const pageIndex = docStore.currentPage - 1
  const dragged = blocks.value.find(b => b.id === ds.blockId) || null

  editorStore.setStatus(ds.mode === 'move' ? 'Moving text block...' : 'Resizing text block...')

  try {
    await enqueueOp(async () => {
      let success = false
      // Where the block should land, in PDF page coords (top-left origin) —
      // used to re-find it afterwards.
      let expectedBbox: [number, number, number, number] | null = null

      if (ds.mode === 'move') {
        // Screen delta in PDF page units (top-left origin, y down)
        const dxP = ds.currentDeltaX / scaleX.value
        const dyP = ds.currentDeltaY / scaleY.value

        if (dragged) {
          expectedBbox = [
            dragged.bbox[0] + dxP, dragged.bbox[1] + dyP,
            dragged.bbox[2] + dxP, dragged.bbox[3] + dyP
          ]
        }

        // Tm coords are bottom-left origin, y up — flip dy
        success = await pdfEngine.transformTextBlock(
          pageIndex, ds.blockId,
          dxP, -dyP, 1, 1, 0, 0
        )
      } else if (ds.mode === 'resize' && ds.handle) {
        const newBbox = computeResizedBbox(ds.origScreenBbox, ds.handle, ds.currentDeltaX, ds.currentDeltaY)
        // A zero-extent block would make the scale factor Infinity and corrupt
        // the text matrix — leave it unscaled on that axis instead.
        const sx = ds.origScreenBbox.width > 0.01 ? newBbox.width / ds.origScreenBbox.width : 1
        const sy = ds.origScreenBbox.height > 0.01 ? newBbox.height / ds.origScreenBbox.height : 1

        // Compute anchor in PDF Tm coords (bottom-left origin)
        const anchor = getAnchorPoint(ds.handle, ds.origPdfBbox)
        const anchorTmX = anchor.x
        const anchorTmY = props.pdfHeight - anchor.y

        expectedBbox = [
          newBbox.left / scaleX.value, newBbox.top / scaleY.value,
          (newBbox.left + newBbox.width) / scaleX.value,
          (newBbox.top + newBbox.height) / scaleY.value
        ]

        success = await pdfEngine.transformTextBlock(
          pageIndex, ds.blockId,
          0, 0, sx, sy, anchorTmX, anchorTmY
        )
      }

      if (success) {
        pushUndoSnapshot() // snapshot pre-edit bytes only on success (before re-render)
        docStore.markModified()
        editorStore.setStatus(ds.mode === 'move' ? 'Text block moved' : 'Text block resized')
        // Re-anchor to where the block lands so the selection survives this
        // reload AND the save→reload that emit('textChanged') queues behind it.
        if (dragged && expectedBbox) {
          selectionAnchor.value = {
            text: dragged.text,
            cx: (expectedBbox[0] + expectedBbox[2]) / 2,
            cy: (expectedBbox[1] + expectedBbox[3]) / 2
          }
        }
        emit('textChanged')
        await loadBlocks()
      } else {
        editorStore.setStatus(`Transform failed: ${pdfEngine.error.value || 'unknown error'}`)
      }
    })
  } catch (err: any) {
    editorStore.setStatus(`Error: ${err.message}`)
  }

  dragState.value = null
}

function computeResizedBbox(
  orig: { left: number; top: number; width: number; height: number },
  handle: HandlePosition,
  dx: number,
  dy: number
): { left: number; top: number; width: number; height: number } {
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

function getAnchorPoint(handle: HandlePosition, pdfBbox: [number, number, number, number]): { x: number; y: number } {
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
  dragState.value = null
}

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented) return // another layer already handled this keypress
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
  if ((e.key === 'Delete' || e.key === 'Backspace')
      && selectedBlockId.value && !editingBlock.value
      && ['select', 'edit'].includes(editorStore.currentTool)) {
    e.preventDefault()
    deleteSelectedBlock()
  }
}
window.addEventListener('keydown', onKeyDown)

onBeforeUnmount(() => {
  cleanupDrag()
  window.removeEventListener('keydown', onKeyDown)
})

// ── Watchers ──

watch(() => editorStore.currentTool, (tool) => {
  if (['edit', 'select', 'addText'].includes(tool)) {
    loadBlocks()
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

watch(() => docStore.currentPage, () => {
  cancelEdit()
  cancelAddText()
  cleanupDrag()
  clearSelection() // the anchored block lives on the page we just left
  loadBlocks()
})

// Document bytes changed outside this overlay (rotate, page ops, undo/redo) —
// cached block geometry is stale, so reload it. The selection is NOT dropped
// here: loadBlocks re-resolves it from selectionAnchor, so a moved block stays
// selected through the save→reload cycle that every edit triggers.
watch(() => docStore.renderVersion, () => {
  cancelEdit()
  cleanupDrag()
  loadBlocks()
})

defineExpose({ loadBlocks, deleteSelectedBlock })
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

.text-block {
  position: absolute;
  border: 1px dashed transparent;
  cursor: text;
  pointer-events: auto;
  transition: border-color 0.15s;
}

.text-block:hover {
  border-color: rgba(66, 133, 244, 0.5);
}

.text-block.selected {
  border: 1.5px dashed #4285f4;
  background-color: rgba(66, 133, 244, 0.06);
}

.text-block.movable {
  cursor: move;
}

.selection-handle {
  background: #4285f4;
  border: 1px solid #1a73e8;
  border-radius: 1px;
  box-sizing: border-box;
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.3);
}

.inline-editor {
  position: absolute;
  pointer-events: auto;
  z-index: 10;
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
  z-index: 10;
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
}

.delete-hint {
  pointer-events: auto;
  z-index: 10;
}
</style>
