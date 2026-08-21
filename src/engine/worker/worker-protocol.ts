import type { PageTextData, Quad, Pt, RectT, AnnotationInfo, MarkupType, ShapeType, SearchHit } from '../types'

// Messages from main thread -> worker
export type WorkerRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'loadDocument'; data: { bytes: ArrayBuffer } }
  | { id: number; type: 'getPageText'; data: { pageIndex: number } }
  | { id: number; type: 'getPageCount' }
  | { id: number; type: 'getPageSize'; data: { pageIndex: number } }
  | { id: number; type: 'readContentStream'; data: { pageIndex: number } }
  | { id: number; type: 'writeContentStream'; data: { pageIndex: number; streamBytes: ArrayBuffer } }
  | { id: number; type: 'replaceText'; data: { pageIndex: number; blockId: string; newText: string } }
  | { id: number; type: 'addText'; data: { pageIndex: number; x: number; y: number; text: string; fontSize: number; fontName: string; color?: [number, number, number] } }
  | { id: number; type: 'transformTextBlock'; data: { pageIndex: number; blockId: string; dx: number; dy: number; sx: number; sy: number; anchorX: number; anchorY: number } }
  | { id: number; type: 'debugFonts'; data: { pageIndex: number } }
  // --- Annotations ---
  | { id: number; type: 'getAnnotations'; data: { pageIndex: number } }
  | { id: number; type: 'addTextMarkup'; data: { pageIndex: number; markupType: MarkupType; quads: Quad[]; color: [number, number, number]; opacity?: number } }
  | { id: number; type: 'addShape'; data: { pageIndex: number; shapeType: ShapeType; rect?: RectT; points?: [Pt, Pt]; color: [number, number, number]; interiorColor?: [number, number, number] | null; width: number; opacity?: number } }
  | { id: number; type: 'addInk'; data: { pageIndex: number; strokes: Pt[][]; color: [number, number, number]; width: number; opacity?: number } }
  | { id: number; type: 'addFreeText'; data: { pageIndex: number; rect: RectT; text: string; fontSize: number; color: [number, number, number]; fontName?: string } }
  | { id: number; type: 'addStickyNote'; data: { pageIndex: number; x: number; y: number; text: string; color: [number, number, number] } }
  | { id: number; type: 'addImageStamp'; data: { pageIndex: number; rect: RectT; imageBytes: ArrayBuffer } }
  | { id: number; type: 'deleteAnnotation'; data: { pageIndex: number; annotIndex: number } }
  | { id: number; type: 'updateAnnotation'; data: { pageIndex: number; annotIndex: number; rect?: RectT; color?: [number, number, number]; interiorColor?: [number, number, number] | null; opacity?: number; width?: number; contents?: string } }
  // --- Page management ---
  | { id: number; type: 'rotatePage'; data: { pageIndex: number; degrees: number } }
  | { id: number; type: 'insertBlankPage'; data: { atIndex: number; width: number; height: number } }
  | { id: number; type: 'deletePageOp'; data: { pageIndex: number } }
  | { id: number; type: 'duplicatePage'; data: { pageIndex: number } }
  | { id: number; type: 'movePage'; data: { from: number; to: number } }
  // --- Search ---
  | { id: number; type: 'searchPage'; data: { pageIndex: number; needle: string; maxHits?: number } }
  | { id: number; type: 'searchDocument'; data: { needle: string; maxHitsPerPage?: number } }
  | { id: number; type: 'saveDocument' }
  | { id: number; type: 'destroy' }

// Messages from worker -> main thread
export type WorkerResponse =
  | { id: number; type: 'success'; data: any }
  | { id: number; type: 'error'; error: string }
  | { id: number; type: 'progress'; progress: number }

export type { PageTextData, Quad, Pt, RectT, AnnotationInfo, SearchHit }
