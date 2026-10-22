// The only bridge between the page and Windows: files opened from Explorer.
// The page never gets Node or Electron APIs of its own.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  /** Called with { name, bytes } for each PDF opened from Windows. */
  onOpenFile(callback) {
    ipcRenderer.on('desktop:open-file', (_e, file) => callback(file))
  },
  /** The page is ready to receive files: flushes any queued at launch. */
  ready() {
    ipcRenderer.send('desktop:ready')
  },
  /**
   * Whether this window shows a document. A PDF opened from Windows goes to a
   * window without one, or to a new window — never over an open document.
   */
  setHasDocument(hasDoc) {
    ipcRenderer.send('desktop:has-document', !!hasDoc)
  }
})
