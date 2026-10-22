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
  }
})
