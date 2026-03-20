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

    <!-- Inline editor (edit mode only) -->
    <div
      v-if="editingBlock"
      class="inline-editor-wrapper"
      :style="editorStyle"
    >
      <textarea
        ref="editorRef"
        v-model="editText"
        class="inline-editor"
        :style="editorTextStyle"
        @keydown.enter.ctrl="commitEdit"
        @keydown.escape="cancelEdit"
        @blur="onBlur"
      />
      <div class="editor-actions" @mousedown.prevent>
        <q-btn dense flat size="xs" color="positive" icon="check" @click.stop="commitEdit" />
        <q-btn dense flat size="xs" color="negative" icon="close" @click.stop="cancelEdit" />
      </div>
    </div>

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
const editingBlock = ref<TextBlock | null>(null)
const editText = ref('')
const editorRef = ref<HTMLTextAreaElement | null>(null)
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
  const w = Math.max((block.bbox[2] - block.bbox[0]) * scaleX.value, 200)
  const h = Math.max((block.bbox[3] - block.bbox[1]) * scaleY.value, 30)

  return {
    left: `${x}px`,
    top: `${y}px`,
    width: `${w + 20}px`,
    minHeight: `${h}px`
  }
})

const editorTextStyle = computed(() => {
  if (!editingBlock.value) return {}
  const block = editingBlock.value
  return {
    fontSize: `${block.fontSize * scaleY.value}px`,
    fontWeight: block.isBold ? 'bold' : 'normal',
    fontStyle: block.isItalic ? 'italic' : 'normal',
    color: `rgb(${Math.round(block.color[0] * 255)}, ${Math.round(block.color[1] * 255)}, ${Math.round(block.color[2] * 255)})`
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

async function loadBlocks() {
  if (!showOverlay.value || !pdfEngine.isReady.value) return

  try {
    const pageIndex = docStore.currentPage - 1
    const data = await pdfEngine.getTextBlocks(pageIndex)
    blocks.value = data
    if (editorStore.currentTool === 'edit') {
      editorStore.setStatus(`Edit mode: ${data.length} text blocks found`)
    }
  } catch (err: any) {
    console.error('Failed to load text blocks:', err)
    blocks.value = []
  }
}

// ── Block selection & editing ──

function selectBlock(id: string) {
  const block = blocks.value.find(b => b.id === id)
  if (!block) return

  selectedBlockId.value = id

  if (editorStore.currentTool === 'edit') {
    editingBlock.value = block
    editText.value = block.text
    nextTick(() => {
      editorRef.value?.focus()
      editorRef.value?.select()
    })
  }
}

function onBlur() {
  setTimeout(() => {
    if (editingBlock.value && !isCommitting) {
      commitEdit()
    }
  }, 150)
}

function pushUndoSnapshot() {
  const currentBytes = docStore.pdfBytes
  if (currentBytes) {
    historyStore.pushSnapshot(new Uint8Array(currentBytes))
  }
}

async function commitEdit() {
  if (isCommitting) return
  if (!editingBlock.value || editText.value === editingBlock.value.text) {
    cancelEdit()
    return
  }

  isCommitting = true
  const pageIndex = docStore.currentPage - 1
  const blockId = editingBlock.value.id
  const newText = editText.value

  pushUndoSnapshot()
  editorStore.setStatus('Applying text change...')

  try {
    const success = await pdfEngine.replaceText(pageIndex, blockId, newText)
    if (success) {
      docStore.markModified()
      editorStore.setStatus('Text replaced successfully')
      emit('textChanged')
      await loadBlocks()
    } else {
      editorStore.setStatus(`Edit failed: ${pdfEngine.error.value || 'unknown error'}`)
    }
  } catch (err: any) {
    editorStore.setStatus(`Error: ${err.message}`)
  }

  editingBlock.value = null
  selectedBlockId.value = null
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

  pushUndoSnapshot()
  const pageIndex = docStore.currentPage - 1
  editorStore.setStatus('Deleting text block...')

  try {
    const success = await pdfEngine.replaceText(pageIndex, block.id, '')
    if (success) {
      docStore.markModified()
      editorStore.setStatus('Text block deleted')
      emit('textChanged')
      await loadBlocks()
    } else {
      editorStore.setStatus(`Delete failed: ${pdfEngine.error.value || 'unknown error'}`)
    }
  } catch (err: any) {
    editorStore.setStatus(`Error: ${err.message}`)
  }

  selectedBlockId.value = null
  editingBlock.value = null
}

// ── Move / Resize drag ──

function onBlockMouseDown(event: MouseEvent, blockId: string) {
  // In select or edit mode, select and start potential drag for move
  if (['select', 'edit'].includes(editorStore.currentTool)) {
    selectedBlockId.value = blockId
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

  pushUndoSnapshot()
  editorStore.setStatus(ds.mode === 'move' ? 'Moving text block...' : 'Resizing text block...')

  try {
    let success = false

    if (ds.mode === 'move') {
      // Convert screen delta to PDF Tm coords (bottom-left origin, y up)
      const dxTm = ds.currentDeltaX / scaleX.value
      const dyTm = -ds.currentDeltaY / scaleY.value

      success = await pdfEngine.transformTextBlock(
        pageIndex, ds.blockId,
        dxTm, dyTm, 1, 1, 0, 0
      )
    } else if (ds.mode === 'resize' && ds.handle) {
      const newBbox = computeResizedBbox(ds.origScreenBbox, ds.handle, ds.currentDeltaX, ds.currentDeltaY)
      const sx = newBbox.width / ds.origScreenBbox.width
      const sy = newBbox.height / ds.origScreenBbox.height

      // Compute anchor in PDF Tm coords (bottom-left origin)
      const anchor = getAnchorPoint(ds.handle, ds.origPdfBbox)
      const anchorTmX = anchor.x
      const anchorTmY = props.pdfHeight - anchor.y

      success = await pdfEngine.transformTextBlock(
        pageIndex, ds.blockId,
        0, 0, sx, sy, anchorTmX, anchorTmY
      )
    }

    if (success) {
      docStore.markModified()
      editorStore.setStatus(ds.mode === 'move' ? 'Text block moved' : 'Text block resized')
      emit('textChanged')
      await loadBlocks()
    } else {
      editorStore.setStatus(`Transform failed: ${pdfEngine.error.value || 'unknown error'}`)
    }
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
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const screenX = event.clientX - rect.left
  const screenY = event.clientY - rect.top

  addTextScreenX.value = screenX
  addTextScreenY.value = screenY
  addTextPdfX.value = screenX / scaleX.value
  addTextPdfY.value = props.pdfHeight - (screenY / scaleY.value)

  isAddingText.value = true
  addTextValue.value = ''
  nextTick(() => addTextEditorRef.value?.focus())
}

async function commitAddText() {
  if (!addTextValue.value.trim()) {
    cancelAddText()
    return
  }

  pushUndoSnapshot()
  const pageIndex = docStore.currentPage - 1
  editorStore.setStatus('Adding text...')

  try {
    const success = await pdfEngine.addText(
      pageIndex,
      addTextPdfX.value,
      addTextPdfY.value,
      addTextValue.value,
      editorStore.fontSize,
      'Helvetica'
    )

    if (success) {
      docStore.markModified()
      editorStore.setStatus('Text added successfully')
      emit('textChanged')
      await loadBlocks()
    } else {
      editorStore.setStatus(`Add text failed: ${pdfEngine.error.value || 'unknown error'}`)
    }
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

onBeforeUnmount(cleanupDrag)

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
    selectedBlockId.value = null
    cleanupDrag()
  }
})

watch(() => docStore.currentPage, () => {
  cancelEdit()
  cancelAddText()
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
  border: 1px solid transparent;
  cursor: text;
  pointer-events: auto;
  transition: border-color 0.15s, background-color 0.15s;
}

.text-block:hover {
  border-color: rgba(33, 150, 243, 0.6);
  background-color: rgba(33, 150, 243, 0.08);
}

.text-block.selected {
  border-color: #2196f3;
  background-color: rgba(33, 150, 243, 0.15);
}

.text-block.movable {
  cursor: move;
}

.selection-handle {
  background: #2196f3;
  border: 1px solid #1565c0;
  box-sizing: border-box;
}

.inline-editor-wrapper {
  position: absolute;
  pointer-events: auto;
  z-index: 10;
  display: flex;
  flex-direction: column;
}

.inline-editor {
  width: 100%;
  min-height: 100%;
  border: 2px solid #2196f3;
  background: rgba(255, 255, 255, 0.95);
  padding: 2px 4px;
  resize: both;
  outline: none;
  font-family: inherit;
  line-height: 1.2;
  box-sizing: border-box;
}

.add-text-editor {
  border-color: #4caf50;
  font-family: Helvetica, Arial, sans-serif;
  font-size: 12px;
  min-height: 40px;
}

.editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  background: #333;
  border-radius: 0 0 4px 4px;
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
