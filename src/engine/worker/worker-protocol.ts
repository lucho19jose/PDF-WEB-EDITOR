import type { PageTextData, Quad, Pt, RectT, AnnotationInfo, MarkupType, ShapeType, SearchHit, BlockTransformOp, BlockStyleOp, ImageOrient, ImageAlign } from '../types'

// Messages from main thread -> worker
/** One run of an `addTextRun` text object: its own pen (bottom-left origin baseline), size, face and visibility. */
export interface TextRunPart {
  x: number
  y: number
  text: string
  fontSize: number
  fontName: string
  color?: [number, number, number]
  faceId?: string
  invisible?: boolean
  /** Stretch the run horizontally (`Tz`) so its advance equals this many points — an invisible run set over the scan's own ink. */
  fitWidth?: number
}

export type WorkerRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'loadDocument'; data: { bytes: ArrayBuffer } }
  | { id: number; type: 'getPageText'; data: { pageIndex: number } }
  | { id: number; type: 'getPageCount' }
  | { id: number; type: 'getPageSize'; data: { pageIndex: number } }
  | { id: number; type: 'readContentStream'; data: { pageIndex: number } }
  | { id: number; type: 'writeContentStream'; data: { pageIndex: number; streamBytes: ArrayBuffer } }
  | { id: number; type: 'replaceText'; data: { pageIndex: number; blockId: string; newText: string } }
  | { id: number; type: 'addText'; data: { pageIndex: number; x: number; y: number; text: string; fontSize: number; fontName: string; color?: [number, number, number]; rotation?: number; faceId?: string; invisible?: boolean } }
  /** Several runs in ONE text object — the invisible head, the visible stretch and the invisible tail of a partial redraw — so extraction reads them as one line. */
  | { id: number; type: 'addTextRun'; data: { pageIndex: number; rotation?: number; parts: TextRunPart[] } }
  /** A traced scan face (OpenType bytes) the worker keeps by id for `addText` runs that name it. */
  | { id: number; type: 'registerFace'; data: { faceId: string; bytes: ArrayBuffer } }
  /** The exact pen advance `addText` would give each run, in points — measured with the fonts that will draw it. */
  | { id: number; type: 'measureRuns'; data: { runs: { text: string; fontSize: number; fontName: string; faceId?: string }[] } }
  | { id: number; type: 'transformTextBlock'; data: { pageIndex: number; blockId: string; dx: number; dy: number; sx: number; sy: number; anchorX: number; anchorY: number } }
  | { id: number; type: 'transformTextBlocks'; data: { pageIndex: number; ops: BlockTransformOp[] } }
  | { id: number; type: 'restyleTextBlocks'; data: { pageIndex: number; ops: BlockStyleOp[] } }
  | { id: number; type: 'mergePages'; data: { bytes: ArrayBuffer; atIndex: number } }
  | { id: number; type: 'flattenAnnotationBehind'; data: { pageIndex: number; annotIndex: number } }
  | { id: number; type: 'rotateStampImage'; data: { pageIndex: number; annotIndex: number } }
  | { id: number; type: 'moveAnnotationToPage'; data: { pageIndex: number; annotIndex: number; targetPage: number; rect: RectT } }
  | { id: number; type: 'listContentImages'; data: { pageIndex: number } }
  | { id: number; type: 'transformContentImage'; data: { pageIndex: number; sourceKey: string; doOffset: number; name: string; rect: RectT } }
  | { id: number; type: 'deleteContentImage'; data: { pageIndex: number; sourceKey: string; doOffset: number; name: string } }
  | { id: number; type: 'orientContentImage'; data: { pageIndex: number; sourceKey: string; doOffset: number; name: string; op: ImageOrient } }
  | { id: number; type: 'cropContentImage'; data: { pageIndex: number; sourceKey: string; doOffset: number; name: string; rect: RectT } }
  | { id: number; type: 'alignContentImage'; data: { pageIndex: number; sourceKey: string; doOffset: number; name: string; mode: ImageAlign; margin?: number } }
  | { id: number; type: 'reorderContentImage'; data: { pageIndex: number; sourceKey: string; doOffset: number; name: string; where: 'front' | 'back' } }
  | { id: number; type: 'replaceContentImage'; data: { pageIndex: number; sourceKey: string; doOffset: number; name: string; imageBytes: Uint8Array } }
  | { id: number; type: 'drawImageInContent'; data: { pageIndex: number; rect: RectT; bytes: ArrayBuffer; behind: boolean } }
  | { id: number; type: 'fillRect'; data: { pageIndex: number; rect: RectT; color: [number, number, number] } }
  | { id: number; type: 'shiftGraphicsBelow'; data: { pageIndex: number; thresholdY: number; dy: number } }
  | { id: number; type: 'debugFonts'; data: { pageIndex: number } }
  | { id: number; type: 'debugBtBlocks'; data: { pageIndex: number; maxLen?: number } }
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
  /** Render a page through MuPDF at `scale` (1 = 72 DPI), /Rotate applied, as RGBA — for OCR rasters, where pdf.js takes minutes on some fax-encoded scans. */
  | { id: number; type: 'renderPixmap'; data: { pageIndex: number; scale: number } }
  | { id: number; type: 'destroy' }

// Messages from worker -> main thread
export type WorkerResponse =
  | { id: number; type: 'success'; data: any }
  | { id: number; type: 'error'; error: string; fatal?: boolean }
  | { id: number; type: 'progress'; progress: number }

export type { PageTextData, Quad, Pt, RectT, AnnotationInfo, SearchHit, BlockTransformOp }
