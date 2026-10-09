import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useHistoryStore = defineStore('history', () => {
  const undoStack = ref<Uint8Array[]>([])
  const redoStack = ref<Uint8Array[]>([])
  const maxSnapshots = 20
  /**
   * Snapshots are whole documents. Twenty of a 30 MB, 260-page fund request
   * (every scanned-page edit takes one) held 600 MB in undo alone, and as
   * much again in redo — enough to take a browser tab down on a smaller
   * machine. Past this budget the oldest go, but a few always stay so a
   * large document can still undo its last edits.
   */
  const maxBytes = 512 * 1024 * 1024
  const minSnapshots = 3

  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)

  function trim(stack: Uint8Array[]) {
    while (stack.length > maxSnapshots) stack.shift()
    let total = stack.reduce((n, s) => n + s.byteLength, 0)
    while (stack.length > minSnapshots && total > maxBytes) total -= stack.shift()!.byteLength
  }

  /** Push a snapshot before an edit. Clears redo stack. */
  function pushSnapshot(bytes: Uint8Array) {
    undoStack.value.push(bytes)
    trim(undoStack.value)
    redoStack.value = [] // new edit invalidates redo
  }

  /** Push an undo snapshot WITHOUT clearing redo — used by redo() itself. */
  function pushUndoNoClear(bytes: Uint8Array) {
    undoStack.value.push(bytes)
    trim(undoStack.value)
  }

  /** Pop the most recent undo snapshot. */
  function popUndo(): Uint8Array | null {
    return undoStack.value.pop() ?? null
  }

  /** Push current state to redo stack. */
  function pushRedo(bytes: Uint8Array) {
    redoStack.value.push(bytes)
    trim(redoStack.value)
  }

  /** Pop from redo stack. */
  function popRedo(): Uint8Array | null {
    return redoStack.value.pop() ?? null
  }

  /** Clear all history (on new document load). */
  function clear() {
    undoStack.value = []
    redoStack.value = []
  }

  return { undoStack, redoStack, canUndo, canRedo, pushSnapshot, pushUndoNoClear, popUndo, pushRedo, popRedo, clear }
})
