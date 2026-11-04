/**
 * The window's top page when document tabs are on: a stack of same-origin
 * iframes, one per tab, each running the whole editor on ONE document. The
 * host draws nothing — every frame draws the full shell, its tab bar listing
 * the tabs the host broadcasts, and only the active frame is visible. See
 * CLAUDE.md, "Document tabs are iframes".
 *
 * Plain DOM, no Vue or Quasar: the outer page stays light, and nothing of the
 * editor is loaded twice.
 */
import { TAG, type FrameState, type FrameToHost, type HostToFrame, type IncomingFile, type TabInfo } from './protocol'

interface Frame {
  id: string
  el: HTMLIFrameElement
  ready: boolean
  state: FrameState
  /** Messages waiting for `ready`, with what they transfer. */
  queue: [HostToFrame, Transferable[]][]
  /** Files sent and not yet acknowledged: the frame is spoken for. */
  opening: number
}

const EMPTY: FrameState = { loaded: false, name: null, modified: false, collecting: false, opening: false }
const BASE_TITLE = document.title || 'PDF Editor Pro'
/** A new tab gets a frame that is already booted; a fresh one takes a second or two. */
const SPARE_DELAY_MS = 4000

const frames = new Map<string, Frame>()
/** Every frame that is a tab (shown in the list once it has a document), in tab order. */
let order: string[] = []
let active = ''
let spare: string | null = null
let spareTimer: ReturnType<typeof setTimeout> | null = null
let seq = 0

const root = document.getElementById('app') ?? document.body
document.documentElement.style.cssText = 'height:100%;overflow:hidden'
document.body.style.cssText = 'margin:0;height:100%;overflow:hidden;background:#1b1b1b'
root.style.cssText = 'position:fixed;inset:0'

function makeFrame(): Frame {
  const id = `t${++seq}`
  const el = document.createElement('iframe')
  el.src = `/?frame=${id}`
  el.title = 'PDF Editor Pro'
  el.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen; cross-origin-isolated')
  el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;visibility:hidden'
  el.inert = true
  root.appendChild(el)
  const f: Frame = { id, el, ready: false, state: { ...EMPTY }, queue: [], opening: 0 }
  frames.set(id, f)
  return f
}

function send(f: Frame, msg: HostToFrame, transfer: Transferable[] = []): void {
  if (!f.ready || !f.el.contentWindow) { f.queue.push([msg, transfer]); return }
  f.el.contentWindow.postMessage({ ...msg, [TAG]: 1 }, location.origin, transfer)
}

/** The tabs the bar shows: frames with a document, in order. */
function tabs(): TabInfo[] {
  return order.map(id => frames.get(id)!).filter(f => f.state.loaded)
    .map(f => ({ id: f.id, name: f.state.name ?? '', modified: f.state.modified }))
}

function broadcast(): void {
  const list = tabs()
  for (const f of frames.values()) send(f, { type: 'tabs', tabs: list, active })
  const a = frames.get(active)
  document.title = a?.state.loaded && a.state.name ? `${a.state.name} - PDF Editor Pro` : BASE_TITLE
  reportDesktop()
}

/** An empty frame that is not the shown one has no reason to stay: it becomes the spare, or goes. */
function recycle(id: string): void {
  const f = frames.get(id)
  if (!f || f.state.loaded || f.state.opening || f.opening || id === active) return
  order = order.filter(o => o !== id)
  if (!spare && f.ready) { spare = id; return }
  removeFrame(id)
}

function removeFrame(id: string): void {
  const f = frames.get(id)
  if (!f) return
  f.el.remove()
  frames.delete(id)
  order = order.filter(o => o !== id)
  if (spare === id) spare = null
}

function show(id: string, showDocument = false): void {
  const f = frames.get(id)
  if (!f) return
  const previous = active
  active = id
  for (const g of frames.values()) {
    const on = g.id === id
    g.el.style.visibility = on ? 'visible' : 'hidden'
    g.el.style.zIndex = on ? '1' : '0'
    g.el.inert = !on
  }
  send(f, { type: 'activated', showDocument })
  try { f.el.contentWindow?.focus() } catch (_) { /* not loaded yet */ }
  if (previous && previous !== id) recycle(previous)
  broadcast()
}

function scheduleSpare(): void {
  if (spare || spareTimer) return
  spareTimer = setTimeout(() => {
    spareTimer = null
    if (!spare) spare = makeFrame().id
  }, SPARE_DELAY_MS)
}

/**
 * A frame to open a file in: the shown one when it is empty, else a new tab
 * after it. Never `exclude` — the tab that asked for new tabs while opening a
 * file of its own.
 */
function frameForFile(exclude?: string): Frame {
  const a = frames.get(active)
  if (a && a.id !== exclude && !a.state.loaded && !a.state.opening && !a.opening) return a
  let f: Frame
  if (spare && spare !== exclude && frames.has(spare)) { f = frames.get(spare)!; spare = null }
  else f = makeFrame()
  const at = order.indexOf(active)
  order.splice(at < 0 ? order.length : at + 1, 0, f.id)
  scheduleSpare()
  return f
}

function openFile(file: IncomingFile, exclude?: string): void {
  // A print job joins the tab collecting print jobs, as PDF24's assistant
  // collects them — unless the list's "open apart" asked for its own tab.
  if (file.printed && !file.separate) {
    const collecting = [frames.get(active), ...order.map(id => frames.get(id))]
      .find(f => f && f.state.loaded && f.state.collecting)
    if (collecting) {
      send(collecting, { type: 'open', file }, [file.bytes])
      show(collecting.id)
      return
    }
  }
  const f = frameForFile(exclude)
  f.opening++
  send(f, { type: 'open', file }, [file.bytes])
  show(f.id)
}

/** The tab to show once `id` goes: the one to its right, else to its left. */
function neighbourOf(id: string): string | null {
  const list = tabs().map(t => t.id)
  const i = list.indexOf(id)
  const rest = list.filter(t => t !== id)
  if (!rest.length) return null
  return i < 0 ? rest[0] : (list[i + 1] ?? list[i - 1] ?? rest[0])
}

function onState(f: Frame, state: FrameState): void {
  const wasLoaded = f.state.loaded
  f.state = state
  if (state.loaded && !spare) scheduleSpare()
  // Its document was closed. With other tabs open the frame goes, and its
  // neighbour is shown; the last tab's frame stays and shows Inicio.
  if (wasLoaded && !state.loaded && !f.opening && !state.opening) {
    const next = neighbourOf(f.id)
    if (next) {
      const wasActive = active === f.id
      removeFrame(f.id)
      if (wasActive) { show(next, true); return }
    }
  }
  broadcast()
}

function onMessage(e: MessageEvent): void {
  if (e.origin !== location.origin) return
  const data = e.data
  if (!data || data[TAG] !== 1) return
  const f = [...frames.values()].find(g => g.el.contentWindow === e.source)
  if (!f) return
  const msg = data as FrameToHost
  switch (msg.type) {
    case 'ready': {
      f.ready = true
      f.state = { ...EMPTY }
      for (const [m, t] of f.queue.splice(0)) send(f, m, t)
      send(f, { type: 'tabs', tabs: tabs(), active })
      if (f.id === active) show(f.id)
      return
    }
    case 'state': onState(f, msg.state); return
    case 'opened':
      f.opening = Math.max(0, f.opening - 1)
      // It would not open: an empty tab that is not shown goes.
      if (!f.opening && !f.state.loaded && f.id !== active) recycle(f.id)
      broadcast()
      return
    case 'openInNewTabs':
      for (const file of msg.files) openFile(file, f.id)
      return
    case 'activate':
      if (frames.has(msg.id)) show(msg.id, true)
      return
    case 'closeTab': {
      const t = frames.get(msg.id)
      if (!t) return
      // Its save prompt has to be seen: a tab with unsaved changes is shown first.
      if (t.state.modified && active !== t.id) show(t.id, true)
      send(t, { type: 'requestClose' })
      return
    }
    case 'switchTab': {
      const list = tabs().map(t => t.id)
      if (list.length < 2) return
      const i = list.indexOf(active)
      const next = list[((i < 0 ? 0 : i) + msg.delta + list.length * 4) % list.length]
      show(next, true)
      return
    }
    case 'reorder': {
      const known = msg.order.filter(id => frames.has(id) && order.includes(id))
      order = [...known, ...order.filter(id => !known.includes(id))]
      broadcast()
      return
    }
  }
}

// ===== The Windows app =====
// The preload runs in this top frame only: the host owns the open-file
// listener and hands each file to a tab, and tells the main process whether
// any tab holds a document or is collecting print jobs.
let lastDesktop = ''
function reportDesktop(): void {
  const desktop = window.desktop
  if (!desktop) return
  const all = [...frames.values()]
  const hasDoc = all.some(f => f.state.loaded)
  const collecting = all.some(f => f.state.loaded && f.state.collecting)
  const key = `${hasDoc}|${collecting}`
  if (key === lastDesktop) return
  lastDesktop = key
  desktop.setHasDocument(hasDoc)
  desktop.setCollecting?.(collecting)
}

function connectDesktop(): void {
  const desktop = window.desktop
  if (!desktop) return
  desktop.onOpenFile(({ name, bytes, printed, separate }) => {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    openFile({ name, bytes: copy, printed, separate })
  })
  desktop.ready()
}

// ===== Leaving =====
// A frame removed from the page never asks; the host asks for all of them.
window.addEventListener('beforeunload', (e) => {
  if (import.meta.env.DEV && (window as any).__noUnloadPrompt) return
  if ([...frames.values()].some(f => f.state.modified)) {
    e.preventDefault()
    e.returnValue = ''
  }
})

window.addEventListener('message', onMessage)
// A click on the empty host (it is covered by the shown frame) never happens;
// keep the shown frame focused when the window regains focus.
window.addEventListener('focus', () => { try { frames.get(active)?.el.contentWindow?.focus() } catch (_) { /* gone */ } })

const first = makeFrame()
order.push(first.id)
show(first.id)
connectDesktop()

if (import.meta.env.DEV) {
  ;(window as any).__tabHost = {
    get active() { return active },
    get order() { return [...order] },
    get spare() { return spare },
    frames,
    frameOf: (id: string) => frames.get(id)?.el.contentWindow ?? null,
    activeWindow: () => frames.get(active)?.el.contentWindow ?? null
  }
}
