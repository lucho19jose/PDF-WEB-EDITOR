import { ref, watch, type Ref } from 'vue'

/**
 * A ref that remembers itself in localStorage.
 *
 * The first persistence in this app: every setting used to be a plain Pinia
 * ref that reset on reload, which is fine for a colour and wrong for "which
 * OCR engine" or an API key the user pasted. Storage can be absent, full or
 * refused (private windows, blocked site data), so every access is guarded and
 * the ref simply behaves as an ordinary one when it is.
 */
export function persistedRef<T>(key: string, initial: T): Ref<T> {
  const storageKey = `pdf-editor:${key}`
  let start = initial
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw !== null) start = JSON.parse(raw) as T
  } catch (_) { /* no storage, or unreadable — keep the default */ }
  const r = ref(start) as Ref<T>
  watch(r, (v) => {
    try { localStorage.setItem(storageKey, JSON.stringify(v)) } catch (_) { /* full or refused */ }
  }, { deep: true })
  return r
}
