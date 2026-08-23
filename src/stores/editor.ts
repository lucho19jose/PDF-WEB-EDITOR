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

  /**
   * Where an inserted image goes relative to the line it is dropped on, and how
   * wide it is as a share of the TEXT column — not the paper, so it lines up
   * with the text it belongs to.
   */
  /**
   * Whether editing text rearranges the rest of the page.
   *
   * OFF by default, because most documents people edit are NOT flowing prose.
   * On a form or a table — labels and values drawn at fixed coordinates in
   * columns — "push everything below down" tears labels away from their values
   * and leaves the page unusable. Prose is the case where it helps, and there
   * it is one click away.
   */
  const reflowOnEdit = ref(false)

  const imagePlacement = ref<'above' | 'below'>('below')
  const imageWidthPct = ref(60)

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
  const propertyContext = computed<'text' | 'markup' | 'shape' | 'draw' | 'image' | 'none'>(() => {
    const t = currentTool.value
    // 'select' too: restyling text you have selected is a text operation, and
    // it is the only tool where clicking a block selects it without opening the
    // inline editor over it.
    if (t === 'addText' || t === 'edit' || t === 'freetext' || t === 'select') return 'text'
    if (MARKUP_TOOLS.includes(t)) return 'markup'
    if (t === 'image') return 'image'
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
    imagePlacement, imageWidthPct, reflowOnEdit,
    highlightColor, strokeColor, fillColor, fillEnabled, strokeWidth, opacity,
    isAnnotationTool, isMarkupTool, propertyContext,
    setTool, setStatus
  }
})
