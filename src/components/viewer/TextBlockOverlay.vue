<template>
  <div class="text-overlay-container" v-if="editorStore.currentTool === 'edit'">
    <!-- Clickable text blocks -->
    <div
      v-for="block in scaledBlocks"
      :key="block.id"
      class="text-block"
      :class="{ selected: selectedBlockId === block.id }"
      :style="block.style"
      @click.stop="selectBlock(block.id)"
    />

    <!-- Inline editor -->
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, inject } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
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
const pdfEngine = inject<ReturnType<typeof usePDFEngine>>('pdfEngine')!

const blocks = ref<TextBlock[]>([])
const selectedBlockId = ref<string | null>(null)
const editingBlock = ref<TextBlock | null>(null)
const editText = ref('')
const editorRef = ref<HTMLTextAreaElement | null>(null)
let isCommitting = false

// Scale factor: rendered canvas size / PDF user-space size
const scaleX = computed(() => props.pageWidth / props.pdfWidth)
const scaleY = computed(() => props.pageHeight / props.pdfHeight)

// Transform blocks from PDF coords to screen coords
const scaledBlocks = computed(() => {
  return blocks.value.map(block => {
    // PDF coords are bottom-left origin; canvas is top-left.
    // bbox is [x0, y0, x1, y1] where y0 < y1 in PDF space (y increases upward).
    // In the rendered canvas, y is inverted: top of page = 0.
    const x = block.bbox[0] * scaleX.value
    const y = block.bbox[1] * scaleY.value  // MuPDF already returns top-left origin coords
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

// Load text blocks when page changes or tool becomes 'edit'
async function loadBlocks() {
  if (editorStore.currentTool !== 'edit' || !pdfEngine.isReady.value) return

  try {
    const pageIndex = docStore.currentPage - 1
    const data = await pdfEngine.getTextBlocks(pageIndex)
    blocks.value = data
    editorStore.setStatus(`Edit mode: ${data.length} text blocks found`)
  } catch (err: any) {
    console.error('Failed to load text blocks:', err)
    blocks.value = []
  }
}

function selectBlock(id: string) {
  const block = blocks.value.find(b => b.id === id)
  if (!block) return

  selectedBlockId.value = id
  editingBlock.value = block
  editText.value = block.text

  nextTick(() => {
    editorRef.value?.focus()
    editorRef.value?.select()
  })
}

function onBlur() {
  // Delay blur handling — if user clicked a button, @mousedown.prevent
  // keeps focus so this only fires on actual outside clicks
  setTimeout(() => {
    if (editingBlock.value && !isCommitting) {
      commitEdit()
    }
  }, 150)
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

watch(() => editorStore.currentTool, (tool) => {
  if (tool === 'edit') {
    loadBlocks()
  } else {
    blocks.value = []
    cancelEdit()
  }
})

watch(() => docStore.currentPage, () => {
  cancelEdit()
  loadBlocks()
})

defineExpose({ loadBlocks })
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

.editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  background: #333;
  border-radius: 0 0 4px 4px;
}
</style>
