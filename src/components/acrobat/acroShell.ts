import { watch } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore, type Tool } from '@/stores/editor'
import { useUiStore, toolInfo, type AcroTool } from '@/stores/ui'
import type { AcroCommands } from '@/composables/useAcroCommands'
import type { usePDFEngine } from '@/composables/usePDFEngine'

/**
 * What the Acrobat shell's controls DO — one object, provided by the layout
 * as `acroShell`, so the menu bar, the tool bar, the tool rail, the Tools page
 * and the keyboard all reach the same action the same way. The document work
 * itself stays where it always was (the layout's save, print, undo; the
 * commands composable for the new tools); this is the switchboard.
 */
export interface AcroShellDeps {
  pdfEngine: ReturnType<typeof usePDFEngine>
  commands: AcroCommands
  openFile: () => void
  saveFile: (opts?: { saveAs?: boolean }) => Promise<void>
  printFile: () => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  openFind: () => void
  rotatePage: (deg: number) => Promise<void>
  closeDocument: () => Promise<void>
  toggleAssistant: () => void
  reportProblem: () => void
}

/** The editor tool each Acrobat tool starts with. */
const EDITOR_TOOL_FOR: Partial<Record<AcroTool, Tool>> = {
  edit: 'edit',
  ocr: 'edit',
  redact: 'redact',
  stamp: 'stamp',
  measure: 'measure',
  comment: 'select',
  fillsign: 'select',
  protect: 'select',
  organize: 'select'
}

export function createAcroShell(deps: AcroShellDeps) {
  const docStore = useDocumentStore()
  const editorStore = useEditorStore()
  const ui = useUiStore()
  /** A tool asked for before a document was open: opened once one is. */
  let pendingTool: AcroTool | null = null

  function openTool(id: AcroTool) {
    const info = toolInfo(id)
    if (info?.dialog) {
      if (!info.noDocument && !docStore.loaded) { pendingTool = id; deps.openFile(); return }
      ui.openDialog(info.dialog)
      return
    }
    if (!docStore.loaded) {
      pendingTool = id
      editorStore.setStatus(`Abra un archivo PDF para usar "${info?.label ?? id}"`)
      deps.openFile()
      return
    }
    ui.activeTool = id
    ui.view = 'document'
    // Fill & Sign writes in black, as on paper; the comment tools' red default is for markup.
    if (id === 'fillsign' && editorStore.strokeColor === '#e53935') editorStore.strokeColor = '#000000'
    ui.rightPaneOpen = ui.rightPaneOpen || ['edit', 'comment'].includes(id)
    editorStore.setTool(EDITOR_TOOL_FOR[id] ?? 'select')
    editorStore.setStatus(info?.label ?? id)
  }

  function closeTool() {
    ui.activeTool = null
    editorStore.setTool('select')
  }

  watch(() => [docStore.loaded, docStore.fileName] as const, ([loaded]) => {
    if (!loaded) return
    ui.view = 'document'
    if (pendingTool) { const t = pendingTool; pendingTool = null; openTool(t) }
  })

  // ── zoom ──
  function viewerBox(): { w: number; h: number } {
    const el = document.querySelector('.pdf-viewer-container') as HTMLElement | null
    return { w: el?.clientWidth ?? window.innerWidth - 400, h: el?.clientHeight ?? window.innerHeight - 200 }
  }
  async function pageSize() {
    return deps.pdfEngine.getPageSize(docStore.currentPage - 1).catch(() => ({ width: 612, height: 792 }))
  }
  const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5]
  function zoomIn() { docStore.setScale(ZOOM_STEPS.find(z => z > docStore.scale + 0.001) ?? 5) }
  function zoomOut() { docStore.setScale([...ZOOM_STEPS].reverse().find(z => z < docStore.scale - 0.001) ?? 0.25) }
  function setZoom(s: number) { docStore.setScale(s) }
  async function fitWidth() {
    const s = await pageSize()
    docStore.setScale((viewerBox().w - 48) / s.width)
  }
  async function fitPage() {
    const s = await pageSize()
    const b = viewerBox()
    docStore.setScale(Math.min((b.w - 48) / s.width, (b.h - 32) / s.height))
  }

  function fullScreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else document.documentElement.requestFullscreen().catch(() => {})
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText()
      document.execCommand('insertText', false, text)
    } catch (_) {
      editorStore.setStatus('El navegador no permite pegar desde aquí: use Ctrl+V')
    }
  }

  return {
    commands: deps.commands,
    openFile: deps.openFile,
    save: () => deps.saveFile(),
    saveAs: () => deps.saveFile({ saveAs: true }),
    print: deps.printFile,
    closeDocument: deps.closeDocument,
    undo: deps.undo,
    redo: deps.redo,
    find: deps.openFind,
    paste,
    zoomIn, zoomOut, setZoom, fitPage, fitWidth,
    rotateCurrent: (deg: number) => deps.rotatePage(deg),
    openTool, closeTool,
    fullScreen,
    toggleAssistant: deps.toggleAssistant,
    reportProblem: deps.reportProblem,
    ZOOM_STEPS
  }
}

export type AcroShell = ReturnType<typeof createAcroShell>
