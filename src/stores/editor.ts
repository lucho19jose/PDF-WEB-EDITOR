import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { persistedRef } from '@/utils/persist'
import type { OcrEngineId } from '@/utils/ocr/ocrEngine'

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

  /**
   * Which recogniser reads a scanned page. PaddleOCR by default (better on
   * Chinese and mixed scripts, faster); Tesseract as the fallback it drops to
   * on its own when it cannot start; Mistral only when the user has pasted a
   * key and accepted that the page image leaves the machine. Remembered
   * across reloads — the first persisted settings in the app.
   */
  const ocrEngine = persistedRef<OcrEngineId>('ocrEngine', 'paddle')
  const mistralApiKey = persistedRef<string>('mistralApiKey', '')

  const imagePlacement = ref<'above' | 'below'>('below')
  /**
   * How an inserted image sits with the text around it.
   *
   * `inline` puts it in the flow — the text is pushed aside to make room, as
   * Word's "top and bottom" does. `front` lays it over the text and `behind`
   * under it, neither moving anything.
   *
   * Word's "square" and "tight" — text flowing around the SIDES of a picture —
   * are deliberately absent. A content stream has no flow: every line is drawn
   * at an absolute position, so wrapping text around a shape means re-breaking
   * and re-justifying every affected paragraph, which cannot be done to a table
   * or a form without destroying it. Offering it and doing it badly would be
   * worse than not offering it.
   */
  const imageWrap = ref<'inline' | 'front' | 'behind'>('inline')
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
  /** Set while the OCR layer owns the properties row. */
  const ocrMode = ref(false)

  const propertyContext = computed<'text' | 'markup' | 'shape' | 'draw' | 'image' | 'ocr' | 'none'>(() => {
    // OCR wins: while a scanned page's recognised text is on screen, the row
    // has to act on THAT, not on whatever tool happens to be selected.
    if (ocrMode.value) return 'ocr'
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
    imagePlacement, imageWrap, imageWidthPct, reflowOnEdit, ocrMode, ocrEngine, mistralApiKey,
    highlightColor, strokeColor, fillColor, fillEnabled, strokeWidth, opacity,
    isAnnotationTool, isMarkupTool, propertyContext,
    setTool, setStatus
  }
})
