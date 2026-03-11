import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type Tool = 'select' | 'edit' | 'addText' | 'highlight' | 'underline' | 'strikeout'
  | 'line' | 'rectangle' | 'circle' | 'comment'

export const useEditorStore = defineStore('editor', () => {
  const currentTool = ref<Tool>('select')
  const statusMessage = ref('Ready')

  // Text editing state
  const fontFamily = ref('Helvetica')
  const fontSize = ref(12)
  const textColor = ref('#000000')
  const highlightColor = ref('#ffff00')
  const strokeColor = ref('#ff0000')
  const strokeWidth = ref(2)
  const opacity = ref(1)

  const showEditToolbar = computed(() => {
    return ['edit', 'addText', 'highlight', 'underline', 'strikeout'].includes(currentTool.value)
  })

  function setTool(tool: Tool) {
    currentTool.value = tool
    setStatus(`Tool: ${tool}`)
  }

  function setStatus(msg: string) {
    statusMessage.value = msg
  }

  return {
    currentTool, statusMessage, fontFamily, fontSize,
    textColor, highlightColor, strokeColor, strokeWidth, opacity,
    showEditToolbar,
    setTool, setStatus
  }
})
