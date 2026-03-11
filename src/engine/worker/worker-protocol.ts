import type { PageTextData } from '../types'

// Messages from main thread -> worker
export type WorkerRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'loadDocument'; data: { bytes: ArrayBuffer } }
  | { id: number; type: 'getPageText'; data: { pageIndex: number } }
  | { id: number; type: 'getPageCount' }
  | { id: number; type: 'readContentStream'; data: { pageIndex: number } }
  | { id: number; type: 'writeContentStream'; data: { pageIndex: number; streamBytes: ArrayBuffer } }
  | { id: number; type: 'replaceText'; data: { pageIndex: number; blockId: string; newText: string } }
  | { id: number; type: 'debugFonts'; data: { pageIndex: number } }
  | { id: number; type: 'saveDocument' }
  | { id: number; type: 'destroy' }

// Messages from worker -> main thread
export type WorkerResponse =
  | { id: number; type: 'success'; data: any }
  | { id: number; type: 'error'; error: string }
  | { id: number; type: 'progress'; progress: number }
