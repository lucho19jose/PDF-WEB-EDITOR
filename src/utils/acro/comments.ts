/**
 * Comments, as Acrobat's Comentar tool works them: a sticky note is placed on
 * the page and its text is written in the comment list beside it, not in a
 * dialog; a click on a comment's card selects it on the page and a click on
 * the page selects its card.
 *
 * The page (AnnotationLayer, one per current page) and the list
 * (AcroRightPane) are siblings far apart in the tree, so what they share
 * lives here.
 */
import { ref } from 'vue'

export interface NoteDraft {
  id: number
  pageIndex: number
  /** Top-left of the icon, in page points (top-left origin). */
  x: number
  y: number
  color: [number, number, number]
  text: string
}

/** The sticky note placed and not yet published: its icon on the page, its card in the list. */
export const noteDraft = ref<NoteDraft | null>(null)
let draftSeq = 0
export function newDraftId(): number { return ++draftSeq }

/** The comment selected, on the page or in the list. */
export const focusedComment = ref<{ page: number; index: number } | null>(null)

/** A request the other side answers when it can: `seq` makes a repeat of the same one a change. */
export interface CommentRequest { page: number; index: number; seq: number }
let requestSeq = 0
export function request(page: number, index: number): CommentRequest { return { page, index, seq: ++requestSeq } }
/** Select this comment on the page (a click on its card). */
export const selectOnPage = ref<CommentRequest | null>(null)
/** Open this text box's editor on the page ("Editar" on its card). */
export const editFreeText = ref<CommentRequest | null>(null)
/** The last request of each kind already answered: a page rebuilt later must not answer it again. */
export const answered = { select: 0, freeText: 0, note: 0 }
/** Edit this note's text in its card (a double click on its icon). */
export const editNoteText = ref<CommentRequest | null>(null)

/**
 * Publishing a note is the page layer's job (it owns the op that writes
 * annotations); the list and the layer both ask for it through here.
 */
let publisher: ((d: NoteDraft) => Promise<void>) | null = null
export function setNotePublisher(fn: ((d: NoteDraft) => Promise<void>) | null, owner?: unknown) {
  if (fn) { publisher = fn; publisherOwner = owner }
  else if (publisherOwner === owner) { publisher = null; publisherOwner = undefined }
}
let publisherOwner: unknown

/**
 * Settle the open draft: published when it has text, dropped when it has
 * none. Called on Publicar, when another note is placed, when the tool
 * changes, and when the draft's editor loses focus with text in it.
 */
export async function settleNoteDraft(): Promise<void> {
  const d = noteDraft.value
  if (!d) return
  noteDraft.value = null
  if (!d.text.trim() || !publisher) return
  await publisher({ ...d, text: d.text.trim(), color: [...d.color] as [number, number, number] })
}

/** "#ffeb3b" → a darker shade of it, for the icon's rim. */
export function darker(hex: string, k = 0.72): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return '#9a7d00'
  const n = parseInt(m[1], 16)
  const c = (v: number) => Math.round(v * k).toString(16).padStart(2, '0')
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`
}
