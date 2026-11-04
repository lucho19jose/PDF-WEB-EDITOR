/**
 * The frame's side of the document tabs: this page is one tab, the host (the
 * window's top page) holds the list. Every function is a no-op when the page
 * is not a tab — `?single`, the test drivers, a browser that opened a frame
 * URL by itself — so the editor behaves exactly as it always did there.
 */
import { ref } from 'vue'
import { TAG, type FrameState, type FrameToHost, type HostToFrame, type IncomingFile, type TabInfo } from './protocol'

const params = new URLSearchParams(location.search)

/** This tab's id, or null when the page is not a tab. */
export const frameId: string | null = window.parent !== window && params.get('frame') ? params.get('frame') : null

export function isEmbedded(): boolean {
  return frameId !== null
}

/** Every tab with a document, in the host's order, and which one is shown. */
export const tabList = ref<TabInfo[]>([])
export const activeTabId = ref<string | null>(null)

function post(msg: FrameToHost, transfer: Transferable[] = []): void {
  if (!frameId) return
  window.parent.postMessage({ ...msg, [TAG]: 1, from: frameId }, location.origin, transfer)
}

let onOpen: ((file: IncomingFile) => Promise<void>) | null = null
let onClose: (() => Promise<boolean>) | null = null
let onActivated: ((showDocument: boolean) => void) | null = null
const early: HostToFrame[] = []

function handle(msg: HostToFrame): void {
  switch (msg.type) {
    case 'tabs':
      tabList.value = msg.tabs
      activeTabId.value = msg.active
      return
    case 'open':
      if (!onOpen) { early.push(msg); return }
      // Acknowledged whatever the outcome, so the host stops holding this
      // frame for the file: a file that would not open leaves it empty.
      onOpen(msg.file).catch(() => {}).finally(() => post({ type: 'opened' }))
      return
    case 'requestClose':
      onClose?.().catch(() => false)
      return
    case 'activated':
      onActivated?.(msg.showDocument)
      return
  }
}

if (frameId) {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent || e.origin !== location.origin) return
    const data = e.data
    if (!data || data[TAG] !== 1) return
    handle(data as HostToFrame)
  })
}

/**
 * Register the frame's handlers and tell the host it can take files. Called
 * once the engine is up, as the Windows app's `desktop.ready()` is: a file is
 * never loaded into a dead engine.
 */
export function connectFrame(handlers: {
  open: (file: IncomingFile) => Promise<void>
  close: () => Promise<boolean>
  activated: (showDocument: boolean) => void
}): void {
  if (!frameId) return
  onOpen = handlers.open
  onClose = handlers.close
  onActivated = handlers.activated
  post({ type: 'ready' })
  for (const msg of early.splice(0)) handle(msg)
}

export function reportState(state: FrameState): void {
  post({ type: 'state', state })
}

/** Open files as new tabs; the bytes are transferred to the host. */
export async function openInNewTabs(files: (File | IncomingFile)[]): Promise<void> {
  const out: IncomingFile[] = []
  for (const f of files) {
    if (f instanceof File) out.push({ name: f.name, bytes: await f.arrayBuffer() })
    else out.push(f)
  }
  if (out.length) post({ type: 'openInNewTabs', files: out }, out.map(f => f.bytes))
}

export function activateTab(id: string): void { post({ type: 'activate', id }) }
export function closeTab(id: string): void { post({ type: 'closeTab', id }) }
export function switchTab(delta: number): void { post({ type: 'switchTab', delta }) }
export function reorderTabs(order: string[]): void { post({ type: 'reorder', order }) }

/**
 * The Windows app's bridge. The preload runs in the window's top frame only,
 * so a tab reaches it through the host; the host itself owns `onOpenFile`.
 */
export function desktopApi(): DesktopBridge | undefined {
  if (window.desktop) return window.desktop
  if (!frameId) return undefined
  try { return (window.top as (Window & { desktop?: DesktopBridge }) | null)?.desktop } catch (_) { return undefined }
}
