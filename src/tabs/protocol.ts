/**
 * Document tabs: the messages between the HOST (the top page, one per window)
 * and each FRAME (a same-origin iframe running the whole editor on one
 * document). See CLAUDE.md, "Document tabs are iframes".
 *
 * Every message carries `__pdfTabs: 1` so nothing else posted to a window
 * (pdf.js, a print iframe, a browser extension) is taken for one.
 */

/** A file handed to a frame: the bytes travel transferred, not copied. */
export interface IncomingFile {
  name: string
  bytes: ArrayBuffer
  /** A job from the "PDF Editor Pro" printer (Windows app). */
  printed?: boolean
  /** The Combinar list's "open apart": never joins a collecting tab. */
  separate?: boolean
}

/** What the tab bar shows for one tab. */
export interface TabInfo {
  id: string
  name: string
  modified: boolean
}

/** What a frame reports about itself. */
export interface FrameState {
  loaded: boolean
  name: string | null
  modified: boolean
  /** Its document is print jobs not saved yet: the next job joins its list. */
  collecting: boolean
  /** A file is being opened in it: it is spoken for, however empty it looks. */
  opening: boolean
}

export type HostToFrame =
  | { type: 'tabs'; tabs: TabInfo[]; active: string | null }
  | { type: 'open'; file: IncomingFile }
  | { type: 'requestClose' }
  | { type: 'activated'; showDocument: boolean }

export type FrameToHost =
  | { type: 'ready' }
  | { type: 'state'; state: FrameState }
  | { type: 'opened' }
  | { type: 'openInNewTabs'; files: IncomingFile[] }
  | { type: 'activate'; id: string }
  | { type: 'closeTab'; id: string }
  | { type: 'switchTab'; delta: number }
  | { type: 'reorder'; order: string[] }

export const TAG = '__pdfTabs'
