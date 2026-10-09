import { ref } from 'vue'

/**
 * The selected page OBJECT, shared between the annotation layer (which owns
 * the selection, on the page) and Acrobat's "OBJETOS" panel (which acts on it,
 * in the right pane). The two are far apart in the component tree and the
 * layer is rebuilt on every page, so it registers its handler on mount and the
 * panel calls through this module.
 */
export type ObjectAction =
  | 'flip-h' | 'flip-v' | 'rotate-cw' | 'rotate-ccw'
  | 'align-left' | 'align-center' | 'align-right' | 'align-top' | 'align-middle' | 'align-bottom'
  | 'front' | 'back' | 'crop' | 'replace' | 'delete'

export interface ObjectSelectionInfo {
  /** A picture the page content draws, or an annotation. */
  kind: 'content-image' | 'annotation'
  /** An annotation that is a picture (a Stamp with an image appearance). */
  isImage: boolean
  pageIndex: number
}

export const objectSelection = ref<ObjectSelectionInfo | null>(null)

let handler: ((action: ObjectAction) => Promise<void>) | null = null

export function setObjectHandler(fn: ((action: ObjectAction) => Promise<void>) | null) {
  handler = fn
}

export async function objectAction(action: ObjectAction): Promise<void> {
  await handler?.(action)
}
