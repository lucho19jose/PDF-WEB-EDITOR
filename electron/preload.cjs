// The only bridge between the page and Windows: files opened from Explorer.
// The page never gets Node or Electron APIs of its own.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  /**
   * Called with { name, bytes, printed } for each PDF opened from Windows;
   * `printed` marks a job from the "PDF Editor Pro" printer.
   */
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
  },
  /** This window holds unsaved print jobs: the next job joins its list. */
  setCollecting(collecting) {
    ipcRenderer.send('desktop:collecting', !!collecting)
  },
  /** Opens print jobs, by file name in the print folder, each in its own window. */
  openPrintJobs(names) {
    ipcRenderer.send('desktop:open-print-jobs', Array.isArray(names) ? names.map(String) : [])
  },
  /** Where the MCP server for Claude is: { exe, server, serverExists, mcpb, mcpbExists, packaged }. */
  mcpInfo() {
    return ipcRenderer.invoke('desktop:mcp-info')
  },
  /** Shows the Claude Desktop extension (.mcpb) selected in Explorer. */
  revealMcpb() {
    ipcRenderer.send('desktop:reveal-mcpb')
  }
})
