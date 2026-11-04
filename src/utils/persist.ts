import { ref, watch, getCurrentScope, onScopeDispose, type Ref } from 'vue'

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
  let written = ''
  watch(r, (v) => {
    try {
      written = JSON.stringify(v)
      if (localStorage.getItem(storageKey) !== written) localStorage.setItem(storageKey, written)
    } catch (_) { /* full or refused */ }
  }, { deep: true })
  // Another tab or window changed it: every open document tab is its own
  // page (src/tabs), and a setting chosen in one must hold in the others.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== storageKey || e.newValue === null || e.newValue === written) return
    try { r.value = JSON.parse(e.newValue) as T } catch (_) { /* unreadable — keep ours */ }
  }
  window.addEventListener('storage', onStorage)
  if (getCurrentScope()) onScopeDispose(() => window.removeEventListener('storage', onStorage))
  return r
}
