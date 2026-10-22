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

// ===== Files opened from Windows (Open with…, double-click, a second launch) =====
let mainWindow = null
let rendererReady = false
const pendingFiles = []

function pdfArgs(argv) {
  return argv.slice(1).filter(a => !a.startsWith('-') && /\.pdf$/i.test(a) && fs.existsSync(a))
}

function sendFile(filePath) {
  if (!mainWindow || !rendererReady) { pendingFiles.push(filePath); return }
  fs.promises.readFile(filePath).then(buf => {
    mainWindow.webContents.send('desktop:open-file', {
      name: path.basename(filePath),
      bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    })
  }).catch(err => {
    dialog.showErrorBox('PDF Editor Pro', `No se pudo abrir ${filePath}:\n${err.message}`)
  })
}

ipcMain.on('desktop:ready', () => {
  rendererReady = true
  while (pendingFiles.length) sendFile(pendingFiles.shift())
})

function createWindow() {
  mainWindow = new BrowserWindow({
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
  mainWindow.maximize()
  mainWindow.once('ready-to-show', () => mainWindow.show())

  const allowed = DEV_URL ? new URL(DEV_URL).origin : ORIGIN
  // Links to the web open in the user's browser; the app's own popups (the
  // print fallback's "open in new tab", blob: previews) stay in the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(allowed)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(allowed)) e.preventDefault()
  })

  // The app blocks unload while the document has unsaved changes. A browser
  // asks the user; Electron simply refuses to close. Ask here instead.
  mainWindow.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Salir sin guardar', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'PDF Editor Pro',
      message: 'El documento tiene cambios sin guardar.',
      detail: 'Si sale ahora, los cambios se perderán.'
    })
    if (choice === 0) e.preventDefault() // ignore the unload block and close
  })

  // F12 still opens DevTools for diagnosis, with the menu bar hidden.
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWindow.webContents.toggleDevTools()
  })

  mainWindow.on('closed', () => { mainWindow = null; rendererReady = false })
  mainWindow.loadURL(DEV_URL || `${ORIGIN}/`)
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
    if (!mainWindow) return
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'info',
      buttons: ['Reiniciar y actualizar', 'Más tarde'],
      defaultId: 0,
      cancelId: 1,
      title: 'Actualización disponible',
      message: `La versión ${info.version} de PDF Editor Pro está lista.`,
      detail: 'Guarde su trabajo antes de reiniciar. Si elige "Más tarde", se instalará al cerrar la aplicación.'
    })
    if (choice === 0) autoUpdater.quitAndInstall()
  })
  autoUpdater.on('error', () => { /* offline, or no release yet: try next launch */ })
  autoUpdater.checkForUpdates().catch(() => {})
}

// ===== Startup =====
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    for (const f of pdfArgs(argv)) sendFile(f)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    registerAppProtocol()
    for (const f of pdfArgs(process.argv)) pendingFiles.push(f)
    createWindow()
    setupUpdates()
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
  })

  app.on('window-all-closed', () => app.quit())
}
