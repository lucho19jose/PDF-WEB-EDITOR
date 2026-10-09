/**
 * Acrobat's "Recientes" list, for real: the files themselves are kept in
 * IndexedDB, so a recent file reopens with a click instead of a trip back to
 * the file chooser. localStorage could not hold them (a few MB in total).
 *
 * Bounded both ways — the newest MAX_FILES, and nothing over MAX_BYTES — and
 * every call is guarded: storage can be refused (private windows, blocked site
 * data), and then the list is simply empty.
 */

export interface RecentFile {
  id: string
  name: string
  size: number
  pages: number
  openedAt: number
  /** A small JPEG of page 1, as a data URL. */
  thumb?: string
}

const DB_NAME = 'pdf-editor-recent'
const MAX_FILES = 12
const MAX_BYTES = 40 * 1024 * 1024

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('bytes')) db.createObjectStore('bytes')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function listRecent(): Promise<RecentFile[]> {
  try {
    const db = await open()
    const tx = db.transaction('meta', 'readonly')
    const req = tx.objectStore('meta').getAll()
    const all = await new Promise<RecentFile[]>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as RecentFile[])
      req.onerror = () => reject(req.error)
    })
    db.close()
    return all.sort((a, b) => b.openedAt - a.openedAt)
  } catch (_) {
    return []
  }
}

/** Remember a file that was just opened (the same name and size counts as the same file). */
export async function rememberRecent(name: string, bytes: Uint8Array, pages: number, thumb?: string): Promise<void> {
  if (bytes.length > MAX_BYTES) return
  try {
    const id = `${name}::${bytes.length}`
    const db = await open()
    const tx = db.transaction(['meta', 'bytes'], 'readwrite')
    tx.objectStore('meta').put({ id, name, size: bytes.length, pages, openedAt: Date.now(), thumb } satisfies RecentFile)
    tx.objectStore('bytes').put(bytes.slice(), id)
    await done(tx)
    db.close()
    // Keep the newest few.
    const all = await listRecent()
    for (const old of all.slice(MAX_FILES)) await forgetRecent(old.id)
  } catch (_) { /* storage refused — the list just stays as it was */ }
}

export async function loadRecent(id: string): Promise<Uint8Array | null> {
  try {
    const db = await open()
    const tx = db.transaction('bytes', 'readonly')
    const req = tx.objectStore('bytes').get(id)
    const bytes = await new Promise<Uint8Array | null>((resolve, reject) => {
      req.onsuccess = () => resolve((req.result as Uint8Array) ?? null)
      req.onerror = () => reject(req.error)
    })
    db.close()
    return bytes
  } catch (_) {
    return null
  }
}

export async function forgetRecent(id: string): Promise<void> {
  try {
    const db = await open()
    const tx = db.transaction(['meta', 'bytes'], 'readwrite')
    tx.objectStore('meta').delete(id)
    tx.objectStore('bytes').delete(id)
    await done(tx)
    db.close()
  } catch (_) { /* nothing to forget */ }
}

export async function clearRecent(): Promise<void> {
  for (const f of await listRecent()) await forgetRecent(f.id)
}
