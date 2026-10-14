/** One immutable image shared across page overlays; repeated pastes reuse it. */
export interface CopiedImage { blob: Blob; width: number; height: number }
export const IMAGE_CLIPBOARD_MARKER = 'pdf-editor:image'
let copied: Promise<CopiedImage> | null = null
let pasteHandler: ((image: CopiedImage) => Promise<void>) | null = null
export function rememberImage(image: Promise<CopiedImage>) { copied = image; image.catch(() => { if (copied === image) copied = null }) }
export function copiedImage() { return copied }
export function setImagePasteHandler(handler: typeof pasteHandler) { pasteHandler = handler }
export async function pasteImageFromMenu(): Promise<boolean> {
  if (!pasteHandler) return false
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const type = item.types.find(t => t.startsWith('image/'))
      if (type) {
        const marker = item.types.includes('text/plain') ? await (await item.getType('text/plain')).text() : ''
        const image = marker === IMAGE_CLIPBOARD_MARKER && copied ? await copied : { blob: await item.getType(type), width: 0, height: 0 }
        await pasteHandler(image)
        return true
      }
      if (item.types.includes('text/plain') && await (await item.getType('text/plain')).text() === IMAGE_CLIPBOARD_MARKER && copied) {
        await pasteHandler(await copied)
        return true
      }
    }
  } catch {
    // A text copied after an image must not accidentally paste the old image.
    try {
      if (await navigator.clipboard.readText() === IMAGE_CLIPBOARD_MARKER && copied) {
        await pasteHandler(await copied)
        return true
      }
    } catch { /* Keyboard paste still works without clipboard-read permission. */ }
  }
  return false
}
