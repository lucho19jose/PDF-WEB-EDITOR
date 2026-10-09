import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { persistedRef } from '@/utils/persist'

/**
 * The Acrobat-style shell: which of the three top-level tabs is showing
 * (Inicio, Herramientas, the document), which tool from the right-hand rail
 * is open, which side panes are out, and which dialog is up.
 *
 * Kept apart from the editor store on purpose: the editor store is what the
 * editing layers read (the active drawing/editing tool, styles), and those
 * were written long before this shell. A "tool" here is an Acrobat TOOL —
 * Editar PDF, Organizar páginas, Comentar — which selects a set of editor
 * tools and panels, not one of them.
 */
export type AcroView = 'home' | 'tools' | 'document'

export type AcroTool =
  | 'edit' | 'organize' | 'comment' | 'fillsign' | 'protect' | 'redact'
  | 'ocr' | 'export' | 'combine' | 'create' | 'stamp' | 'measure'

export type AcroDialog =
  | 'headerFooter' | 'watermark' | 'background' | 'crop' | 'protect' | 'properties'
  | 'combine' | 'create' | 'export' | 'link' | 'signature' | 'about' | 'shortcuts'
  | 'split' | 'extract' | 'pageNumbers' | 'unlock' | 'insertPages' | null

export type LeftPanel = 'thumbs' | 'bookmarks' | 'attachments' | 'layers'

export interface AcroToolInfo {
  id: AcroTool
  label: string
  /** Acrobat's colour for the tool's icon and its accent on the bar. */
  color: string
  icon: string
  /** Section on the Herramientas page. */
  group: 'create' | 'review' | 'forms' | 'protect'
  action: 'Abrir' | 'Agregar'
  /** Opens a dialog instead of a tool bar. */
  dialog?: AcroDialog
  /** Has no document to work on: available from Inicio and Herramientas without one. */
  noDocument?: boolean
}

/** The tools, in the order Acrobat lists them. */
export const ACRO_TOOLS: AcroToolInfo[] = [
  { id: 'create', label: 'Crear archivo PDF', color: '#ff7b82', icon: 'create', group: 'create', action: 'Abrir', dialog: 'create', noDocument: true },
  { id: 'combine', label: 'Combinar archivos', color: '#9090fa', icon: 'combine', group: 'create', action: 'Abrir', dialog: 'combine', noDocument: true },
  { id: 'organize', label: 'Organizar páginas', color: '#a3f858', icon: 'organize', group: 'create', action: 'Abrir' },
  { id: 'edit', label: 'Editar PDF', color: '#f56bb7', icon: 'edit', group: 'create', action: 'Abrir' },
  { id: 'export', label: 'Exportar archivo PDF', color: '#26c0c7', icon: 'export', group: 'create', action: 'Abrir', dialog: 'export' },
  { id: 'ocr', label: 'Digitalizar y OCR', color: '#58e06f', icon: 'ocr', group: 'create', action: 'Abrir' },
  { id: 'comment', label: 'Comentar', color: '#ffe22e', icon: 'comment', group: 'review', action: 'Abrir' },
  { id: 'stamp', label: 'Sello', color: '#b483f0', icon: 'stamp', group: 'review', action: 'Agregar' },
  { id: 'measure', label: 'Medir', color: '#e366ef', icon: 'measure', group: 'review', action: 'Agregar' },
  { id: 'fillsign', label: 'Rellenar y firmar', color: '#b483f0', icon: 'fillsign', group: 'forms', action: 'Abrir' },
  { id: 'protect', label: 'Proteger', color: '#9090fa', icon: 'protect', group: 'protect', action: 'Abrir' },
  { id: 'redact', label: 'Redactar', color: '#ff7b82', icon: 'redact', group: 'protect', action: 'Agregar' }
]

export const TOOL_GROUPS: { id: AcroToolInfo['group']; label: string }[] = [
  { id: 'create', label: 'Crear y editar' },
  { id: 'review', label: 'Compartir y revisar' },
  { id: 'forms', label: 'Formularios y firmas' },
  { id: 'protect', label: 'Proteger y estandarizar' }
]

/** The tools pinned to the right-hand rail, top to bottom. */
export const RAIL_TOOLS: AcroTool[] = ['create', 'combine', 'edit', 'export', 'organize', 'comment', 'fillsign', 'ocr', 'protect']

export function toolInfo(id: AcroTool | null | undefined): AcroToolInfo | undefined {
  return ACRO_TOOLS.find(t => t.id === id)
}

export const useUiStore = defineStore('ui', () => {
  const view = ref<AcroView>('home')
  const activeTool = ref<AcroTool | null>(null)
  const dialog = ref<AcroDialog>(null)
  /** Whatever the open dialog was opened with (a crop rectangle, a link area…). */
  const dialogArgs = ref<any>(null)

  const leftPaneOpen = persistedRef<boolean>('ui.leftPaneOpen', false)
  const leftPanel = ref<LeftPanel>('thumbs')
  /** Acrobat's right-hand pane: the tool's panel, or the tool list when no tool is open. */
  const rightPaneOpen = persistedRef<boolean>('ui.rightPaneOpen', true)
  /** "Mostrar cuadros delimitadores": outline every text block and image while editing. */
  const showBoundingBoxes = persistedRef<boolean>('ui.showBoundingBoxes', true)
  /** "Restringir la edición": the edit tool edits text only and leaves the pictures alone. */
  const restrictEditing = persistedRef<boolean>('ui.restrictEditing', false)
  /** Read mode (Ctrl+H): the bars go and the page fills the window. */
  const readMode = ref(false)
  /** The page-thumbnail size in Organizar páginas, in CSS pixels of width. */
  const organizeThumbWidth = persistedRef<number>('ui.organizeThumbWidth', 150)
  /** Pages selected in Organizar páginas and in the thumbnail pane (0-based). */
  const selectedPages = ref<number[]>([])
  /** The signature last drawn or typed in Rellenar y firmar, as a PNG data URL. */
  const signatureImage = persistedRef<string>('ui.signature', '')
  const initialsImage = persistedRef<string>('ui.initials', '')
  /** A messages log for the bell: the status line forgets, this does not. */
  const notifications = ref<{ at: number; text: string }[]>([])
  const unreadNotifications = ref(0)
  /** Password protection to apply when the file is next saved. */
  const protection = ref<null | { userPassword: string; ownerPassword: string; permissions: { print: boolean; copy: boolean; modify: boolean; annotate: boolean } }>(null)

  const toolMeta = computed(() => toolInfo(activeTool.value))

  function openDialog(d: AcroDialog, args: any = null) {
    dialogArgs.value = args
    dialog.value = d
  }
  function closeDialog() {
    dialog.value = null
    dialogArgs.value = null
  }

  function notify(text: string) {
    notifications.value.unshift({ at: Date.now(), text })
    if (notifications.value.length > 50) notifications.value.length = 50
    unreadNotifications.value++
  }

  return {
    view, activeTool, dialog, dialogArgs, leftPaneOpen, leftPanel, rightPaneOpen,
    showBoundingBoxes, restrictEditing, readMode, organizeThumbWidth, selectedPages,
    signatureImage, initialsImage, notifications, unreadNotifications, protection, toolMeta,
    openDialog, closeDialog, notify
  }
})
