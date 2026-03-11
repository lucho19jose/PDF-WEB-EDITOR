<template>
  <div class="text-overlay-container" v-if="showOverlay">
    <!-- Clickable text blocks (edit + select modes) -->
    <div
      v-for="block in scaledBlocks"
      :key="block.id"
      class="text-block"
      :class="{ selected: selectedBlockId === block.id }"
      :style="block.style"
      @click.stop="selectBlock(block.id)"
    />

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

    <!-- Delete hint when block selected in select mode -->
    <div
      v-if="selectedBlockId && !editingBlock && !isAddingText && editorStore.currentTool !== 'edit'"
      class="delete-hint"
      :style="deleteHintStyle"
      @mousedown.prevent
    >
      <q-btn dense flat size="xs" color="negative" icon="delete" @click.stop="deleteSelectedBlock">
        <q-tooltip>Delete (Del)</q-tooltip>
      </q-btn>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, inject } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import type { usePDFEngine } from '@/composables/usePDFEngine'
import type { TextBlock } from '@/engine/types'

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

// Show overlay for edit, select, and addText modes
const showOverlay = computed(() =>
  ['edit', 'select', 'addText'].includes(editorStore.currentTool)
)

// Scale factor: rendered canvas size / PDF user-space size
const scaleX = computed(() => props.pageWidth / props.pdfWidth)
const scaleY = computed(() => props.pageHeight / props.pdfHeight)

// Transform blocks from PDF coords to screen coords
const scaledBlocks = computed(() => {
  return blocks.value.map(block => {
    const x = block.bbox[0] * scaleX.value
    const y = block.bbox[1] * scaleY.value
    const w = (block.bbox[2] - block.bbox[0]) * scaleX.value
    const h = (block.bbox[3] - block.bbox[1]) * scaleY.value

    return {
      id: block.id,
      style: {
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`
      }
    }
  })
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
  const x = block.bbox[2] * scaleX.value + 4
  const y = block.bbox[1] * scaleY.value
  return {
    left: `${x}px`,
    top: `${y}px`,
    position: 'absolute',
    pointerEvents: 'auto',
    zIndex: 10
  }
})

// Load text blocks when page changes or tool changes
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

function selectBlock(id: string) {
  const block = blocks.value.find(b => b.id === id)
  if (!block) return

  selectedBlockId.value = id

  // Only open inline editor in edit mode
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

/** Push undo snapshot of current PDF bytes */
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

  // Snapshot for undo BEFORE mutation
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
  selectedBlockId.value = null
}

async function deleteSelectedBlock() {
  if (!selectedBlockId.value) return
  const block = blocks.value.find(b => b.id === selectedBlockId.value)
  if (!block) return

  // Snapshot for undo
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

function onAddTextClick(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const screenX = event.clientX - rect.left
  const screenY = event.clientY - rect.top

  addTextScreenX.value = screenX
  addTextScreenY.value = screenY

  // Convert to PDF coordinates (content stream uses bottom-left origin)
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

  // Snapshot for undo
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

watch(() => editorStore.currentTool, (tool) => {
  if (['edit', 'select', 'addText'].includes(tool)) {
    loadBlocks()
  } else {
    blocks.value = []
    cancelEdit()
  }
  // Cancel any in-progress add-text when switching tools
  if (tool !== 'addText') {
    cancelAddText()
  }
  // Deselect when switching tools
  if (tool !== 'select') {
    selectedBlockId.value = null
  }
})

watch(() => docStore.currentPage, () => {
  cancelEdit()
  cancelAddText()
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
