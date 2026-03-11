import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useHistoryStore = defineStore('history', () => {
  const undoStack = ref<Uint8Array[]>([])
  const redoStack = ref<Uint8Array[]>([])
  const maxSnapshots = 20

  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)

  /** Push a snapshot before an edit. Clears redo stack. */
  function pushSnapshot(bytes: Uint8Array) {
    undoStack.value.push(bytes)
    if (undoStack.value.length > maxSnapshots) {
      undoStack.value.shift()
    }
    redoStack.value = [] // new edit invalidates redo
  }

  /** Pop the most recent undo snapshot. */
  function popUndo(): Uint8Array | null {
    return undoStack.value.pop() ?? null
  }

  /** Push current state to redo stack. */
  function pushRedo(bytes: Uint8Array) {
    redoStack.value.push(bytes)
    if (redoStack.value.length > maxSnapshots) {
      redoStack.value.shift()
    }
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

  return { undoStack, redoStack, canUndo, canRedo, pushSnapshot, popUndo, pushRedo, popRedo, clear }
})
