import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type Tool =
  | 'select' | 'edit' | 'addText'
  | 'highlight' | 'underline' | 'strikeout'
  | 'draw' | 'line' | 'rectangle' | 'circle'
  | 'freetext' | 'note' | 'image'

/** Tools that create/select MuPDF annotations (handled by AnnotationLayer). */
export const ANNOTATION_TOOLS: Tool[] = [
  'highlight', 'underline', 'strikeout',
  'draw', 'line', 'rectangle', 'circle',
  'freetext', 'note', 'image'
]

/** Text-markup tools that operate by dragging over existing text. */
export const MARKUP_TOOLS: Tool[] = ['highlight', 'underline', 'strikeout']

export const useEditorStore = defineStore('editor', () => {
  const currentTool = ref<Tool>('select')
  const statusMessage = ref('Ready')

  // Text styling (for addText / edit)
  const fontFamily = ref('Helvetica')
  const fontSize = ref(14)
  const textColor = ref('#000000')

  // Annotation styling
  const highlightColor = ref('#ffeb3b')
  const strokeColor = ref('#e53935')
  const fillColor = ref('#ffffff')
  const fillEnabled = ref(false)
  const strokeWidth = ref(2)
  const opacity = ref(1)

  const isAnnotationTool = computed(() => ANNOTATION_TOOLS.includes(currentTool.value))
  const isMarkupTool = computed(() => MARKUP_TOOLS.includes(currentTool.value))

  /** Which property controls to show in the properties bar for the active tool. */
  const propertyContext = computed<'text' | 'markup' | 'shape' | 'draw' | 'none'>(() => {
    const t = currentTool.value
    if (t === 'addText' || t === 'edit' || t === 'freetext') return 'text'
    if (MARKUP_TOOLS.includes(t)) return 'markup'
    if (t === 'rectangle' || t === 'circle' || t === 'line') return 'shape'
    if (t === 'draw') return 'draw'
    return 'none'
  })

  function setTool(tool: Tool) {
    currentTool.value = tool
    setStatus(`Tool: ${tool}`)
  }

  function setStatus(msg: string) {
    statusMessage.value = msg
  }

  return {
    currentTool, statusMessage, fontFamily, fontSize, textColor,
    highlightColor, strokeColor, fillColor, fillEnabled, strokeWidth, opacity,
    isAnnotationTool, isMarkupTool, propertyContext,
    setTool, setStatus
  }
})
