// Electron main process: PDF Editor Pro as a Windows app.
//
// The web build (dist/) is served through a custom `app://` protocol, not
// file://. Two reasons, both hard requirements of the app:
//  - it fetches its models, fonts and WASM by ABSOLUTE path (/paddle/…,
//    /fonts/…, /pdfjs/…), which file:// would resolve against the drive root;
//  - MuPDF and ONNX Runtime need SharedArrayBuffer, which Chromium only
//    exposes to a cross-origin-isolated page — and isolation comes from the
//    COOP/COEP response headers this handler adds (Netlify's _headers and
//    Apache's .htaccess do the same job on the web).

const { app, BrowserWindow, protocol, shell, dialog, ipcMain, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const SCHEME = 'app'
const HOST = 'pdf-editor'
const ORIGIN = `${SCHEME}://${HOST}`
const DEV_URL = process.env.ELECTRON_DEV_URL || ''
const DIST = path.join(__dirname, '..', 'dist')

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ort': 'application/octet-stream',
  // tesseract.js inflates the .gz itself: it must arrive as raw bytes, never
  // with Content-Encoding: gzip.
  '.gz': 'application/octet-stream'
}

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  // require-corp, not credentialless: the desktop app loads nothing
  // cross-origin (no analytics), so the stricter value costs nothing and is
  // supported everywhere.
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin'
}

function registerAppProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== HOST) return new Response('Not found', { status: 404 })
    let rel = decodeURIComponent(url.pathname)
    if (rel === '/' || rel === '') rel = '/index.html'
    let file = path.normalize(path.join(DIST, rel))
    // Never serve outside dist/.
    if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 })
    let stat = null
    try { stat = await fs.promises.stat(file) } catch { /* missing */ }
    if (!stat || !stat.isFile()) {
      // The SPA fallback (Netlify's `/* /index.html 200`), but only for
      // page-like paths: a missing asset must stay a 404, or a worker that
      // asks for a model gets HTML back and fails far from the cause.
      if (path.extname(rel)) return new Response('Not found', { status: 404, headers: ISOLATION })
      file = path.join(DIST, 'index.html')
    }
    const body = await fs.promises.readFile(file)
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
    return new Response(body, { status: 200, headers: { 'Content-Type': type, ...ISOLATION } })
  })
}

// ===== Windows and the files opened in them =====
// The editor holds ONE document per page (one engine, one document store), so
// a PDF opened from Explorer while a window already shows a document must get
// a window of its own — loaded into the open one it would replace that
// document, and lose whatever was unsaved in it. Acrobat with tabs off does
// the same: one document, one window.
//
// Each editor window's state, keyed by webContents id:
//   ready   — the page registered its open-file listener (engine is up)
//   hasDoc  — the page reports a document is loaded
//   pending — files waiting for `ready`
//   claimed — a file was routed here and has not loaded yet, so a second file
//             arriving in the same burst does not take this window too
const editors = new Map()

function pdfArgs(argv) {
  return argv.slice(1).filter(a => !a.startsWith('-') && /\.pdf$/i.test(a) && fs.existsSync(a))
}

function deliver(state, filePath) {
  fs.promises.readFile(filePath).then(buf => {
    if (state.win.isDestroyed()) return
    state.win.webContents.send('desktop:open-file', {
      name: path.basename(filePath),
      bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    })
  }).catch(err => {
    state.claimed = false
    dialog.showErrorBox('PDF Editor Pro', `No se pudo abrir ${filePath}:\n${err.message}`)
  })
}

function focus(win) {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Open a PDF: in an empty window if there is one, otherwise in a new one. */
function openFile(filePath) {
  const free = [...editors.values()].filter(s => !s.win.isDestroyed() && !s.hasDoc && !s.claimed)
  const focused = BrowserWindow.getFocusedWindow()
  const target = free.find(s => s.win === focused) || free[0]
  if (target) {
    target.claimed = true
    if (target.ready) deliver(target, filePath)
    else target.pending.push(filePath)
    focus(target.win)
    return
  }
  const state = createWindow()
  state.claimed = true
  state.pending.push(filePath)
}

function stateOf(event) {
  return editors.get(event.sender.id)
}

ipcMain.on('desktop:ready', (e) => {
  const s = stateOf(e)
  if (!s) return
  // A page that just (re)loaded holds no document, whatever it held before.
  s.ready = true
  s.hasDoc = false
  while (s.pending.length) deliver(s, s.pending.shift())
})

ipcMain.on('desktop:has-document', (e, hasDoc) => {
  const s = stateOf(e)
  if (!s) return
  s.hasDoc = !!hasDoc
  // Loaded (or the load failed and the window is still empty): either way the
  // claim is settled.
  s.claimed = false
})

function createWindow() {
  const others = BrowserWindow.getAllWindows().filter(w => editors.has(w.webContents.id))
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1e1e1e',
    title: 'PDF Editor Pro',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const state = { win, ready: false, hasDoc: false, claimed: false, pending: [] }
  const id = win.webContents.id
  editors.set(id, state)

  // The first window fills the screen; later ones open cascaded over it so it
  // is plain that a new window appeared rather than the document changing.
  if (others.length === 0) win.maximize()
  else {
    const [x, y] = others[others.length - 1].getPosition()
    win.setPosition(x + 32, y + 32)
  }
  win.once('ready-to-show', () => win.show())

  const allowed = DEV_URL ? new URL(DEV_URL).origin : ORIGIN
  // Links to the web open in the user's browser; the app's own popups (the
  // print fallback's "open in new tab", blob: previews) stay in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(allowed)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(allowed)) e.preventDefault()
  })

  // The app blocks unload while the document has unsaved changes. A browser
  // asks the user; Electron simply refuses to close. Ask here instead.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Salir sin guardar', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'PDF Editor Pro',
      message: 'El documento tiene cambios sin guardar.',
      detail: 'Si cierra esta ventana ahora, los cambios se perderán.'
    })
    if (choice === 0) e.preventDefault() // ignore the unload block and close
  })

  // Right-click. Electron shows no context menu of its own, so text selected
  // with the arrow could be copied only by keyboard. Offered only where there
  // is something to do; the app's own menus (q-menu) handle everything else.
  win.webContents.on('context-menu', (_e, params) => {
    const items = []
    if (params.isEditable) {
      items.push({ label: 'Cortar', role: 'cut', enabled: params.editFlags.canCut })
      items.push({ label: 'Copiar', role: 'copy', enabled: params.editFlags.canCopy })
      items.push({ label: 'Pegar', role: 'paste', enabled: params.editFlags.canPaste })
      items.push({ type: 'separator' }, { label: 'Seleccionar todo', role: 'selectAll' })
    } else if (params.selectionText && params.selectionText.trim()) {
      items.push({ label: 'Copiar', role: 'copy' })
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })

  // F12 still opens DevTools for diagnosis, with the menu bar hidden.
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
  })

  win.on('closed', () => editors.delete(id))
  win.loadURL(DEV_URL || `${ORIGIN}/`)
  return state
}

// ===== Updates from GitHub Releases =====
function setupUpdates() {
  if (!app.isPackaged) return
  let autoUpdater
  try { ({ autoUpdater } = require('electron-updater')) } catch { return }
  // Its default logger prints a stack trace to stderr whenever there is no
  // release to read (offline, or before the first one is published).
  autoUpdater.logger = null
  autoUpdater.autoDownload = true
  autoUpdater.on('update-downloaded', (info) => {
    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const options = {
      type: 'info',
      buttons: ['Reiniciar y actualizar', 'Más tarde'],
      defaultId: 0,
      cancelId: 1,
      title: 'Actualización disponible',
      message: `La versión ${info.version} de PDF Editor Pro está lista.`,
      detail: 'Guarde su trabajo antes de reiniciar. Si elige "Más tarde", se instalará al cerrar la aplicación.'
    }
    const choice = parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options)
    if (choice === 0) autoUpdater.quitAndInstall()
  })
  autoUpdater.on('error', () => { /* offline, or no release yet: try next launch */ })
  autoUpdater.checkForUpdates().catch(() => {})
}

// ===== Startup =====
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // A second launch: from Explorer with files, or from the Start menu without.
  app.on('second-instance', (_e, argv) => {
    const files = pdfArgs(argv)
    if (files.length) { for (const f of files) openFile(f); return }
    const any = BrowserWindow.getAllWindows().find(w => editors.has(w.webContents.id))
    if (any) focus(any)
    else createWindow()
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    registerAppProtocol()
    const files = pdfArgs(process.argv)
    if (files.length) for (const f of files) openFile(f)
    else createWindow()
    setupUpdates()
    app.on('activate', () => { if (!editors.size) createWindow() })
  })

  app.on('window-all-closed', () => app.quit())
}
