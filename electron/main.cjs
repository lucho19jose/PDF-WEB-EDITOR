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
const os = require('node:os')
const { spawn } = require('node:child_process')

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

// ===== The "PDF Editor Pro" printer =====
// A Windows printer like PDF24's: "Imprimir" in any program (SAP, Excel, a
// browser) makes a PDF and opens it here. The printer is Windows' own
// "Microsoft Print To PDF" driver on a named-pipe port, installed by the
// installer (build/installer.nsh, electron/printer/*.ps1); the pipe is served
// by electron/print-listener.cjs, this executable run as plain Node. Windows
// HOLDS a job printed while nothing listens and sends it again once the
// listener is up, so a job is late at worst, never lost.
const PRINTER_NAME = 'PDF Editor Pro'
const PRINT_PIPE = 'PDFEditorPro' // PIPE in print-listener.cjs, $PortName in install-printer.ps1
const LISTENER_FLAG = '--print-listener'
// The logon entry's name under HKCU\…\Run. build/installer.nsh deletes it on uninstall.
const LOGIN_ITEM = 'PDF Editor Pro - Impresora'
// Where the listener keeps the jobs (OUT in print-listener.cjs). A file opened
// from here is a print job: never saved by the user yet.
const PRINT_JOBS = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'PDF Editor Pro', 'Impresiones')

function isPrintJob(filePath) {
  return path.dirname(path.resolve(filePath)).toLowerCase() === PRINT_JOBS.toLowerCase()
}

function listenerRunning() {
  // Listing pipes does not connect to one: connecting would read as a print job.
  try { return fs.readdirSync('\\\\.\\pipe\\').includes(PRINT_PIPE) } catch { return false }
}

/** Starts the listener unless one already serves the pipe. */
function startPrintListener() {
  if (listenerRunning()) return
  // asarUnpack puts the script on disk; plain Node does not read the archive.
  const script = path.join(__dirname, 'print-listener.cjs')
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  // In development the executable is electron.exe, which needs the app first.
  if (!app.isPackaged) env.PDF_EDITOR_APP_ARGS = JSON.stringify([app.getAppPath()])
  try {
    const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore', windowsHide: true, env })
    child.on('error', () => { /* the next launch tries again */ })
    child.unref()
  } catch { /* the next launch tries again */ }
}

let printerChecked = false
/**
 * Once per run: when the printer is installed, make sure its listener runs now
 * and at every logon. When it is gone (removed from Windows' settings), drop
 * the logon entry. Asked of Chromium's printer list, not of PowerShell —
 * Sophos would block the app from starting PowerShell.
 */
function checkPrinter(win) {
  if (printerChecked || process.platform !== 'win32') return
  printerChecked = true
  win.webContents.getPrintersAsync().then(printers => {
    // An empty list means the spooler could not be asked, not that the printer is gone.
    if (!printers.length) return
    const installed = printers.some(p => p.name === PRINTER_NAME)
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: installed, path: process.execPath, args: [LISTENER_FLAG], name: LOGIN_ITEM })
    }
    // A development run's listener would outlive it and keep the pipe, sending
    // later jobs to a dev server that is gone: opt in with PDF_EDITOR_DEV_PRINTER=1.
    if (installed && (app.isPackaged || process.env.PDF_EDITOR_DEV_PRINTER)) startPrintListener()
  }).catch(() => {})
}

// ===== Windows and the files opened in them =====
// A window holds DOCUMENT TABS, as Acrobat does: its top page is the tab host
// (src/tabs/host.ts), which opens each file it is sent in a tab of its own (or
// in the shown tab when that one is empty). So a PDF opened from Explorer goes
// to the focused window, else the last one used; a window is made only when
// there is none, or for "Nueva ventana".
//
// Each editor window's state, keyed by webContents id:
//   ready      — the host registered its open-file listener
//   hasDoc     — some tab holds a document
//   collecting — some tab's document is print jobs not saved yet
//   pending    — files waiting for `ready`
const editors = new Map()
/** The editor window used last (webContents id): files go there when none is focused. */
let lastFocused = null

function pdfArgs(argv) {
  return argv.slice(1).filter(a => !a.startsWith('-') && /\.pdf$/i.test(a) && fs.existsSync(a))
}

/**
 * Send a file to a window. One window's files go out IN ORDER: read in
 * parallel, the smaller file arrived first and Explorer's "uno, dos, tres"
 * opened as the tabs "dos, uno, tres".
 */
function deliver(state, filePath, separate = false) {
  state.sending = (state.sending || Promise.resolve()).then(() => fs.promises.readFile(filePath).then(buf => {
    if (state.win.isDestroyed()) return
    state.win.webContents.send('desktop:open-file', {
      name: path.basename(filePath),
      bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      printed: isPrintJob(filePath),
      separate
    })
  }).catch(err => {
    dialog.showErrorBox('PDF Editor Pro', `No se pudo abrir ${filePath}:\n${err.message}`)
  }))
}

function focus(win) {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Brings a window in front of the program the user is in. A print job reaches
 * the app from a background process, and Windows does not let such a process
 * take the foreground: plain focus() left the document behind SAP. A window may
 * always go topmost, and on leaving topmost it stays above the others — where
 * PDF24's assistant appears. Toggled in one go the window was not shown yet and
 * still landed behind, so it stays topmost for a moment. The taskbar button
 * flashes until the window is clicked.
 */
function raise(win) {
  win.setAlwaysOnTop(true)
  focus(win)
  win.moveTop()
  setTimeout(() => {
    if (win.isDestroyed()) return
    win.setAlwaysOnTop(false)
    if (!win.isFocused()) {
      win.flashFrame(true)
      win.once('focus', () => win.flashFrame(false))
    }
  }, 1500)
}

/**
 * Open a PDF as a tab: in the focused window, else the one used last, else a
 * new one. A print job goes first to a window COLLECTING print jobs (one of its
 * tabs is print jobs not saved yet), where it joins that tab's Combinar list —
 * unless `separate` (the list's "open apart" button, which names its window).
 */
function openFile(filePath, { separate = false, into = null } = {}) {
  const printed = isPrintJob(filePath)
  const live = [...editors.values()].filter(s => !s.win.isDestroyed())
  const focused = BrowserWindow.getFocusedWindow()
  let target = into && !into.win.isDestroyed() ? into : null
  if (!target && printed && !separate) {
    const collecting = live.filter(s => s.ready && s.collecting)
    target = collecting.find(s => s.win === focused) || collecting[collecting.length - 1] || null
  }
  if (!target) {
    target = live.find(s => s.win === focused) ||
      live.find(s => s.win.webContents.id === lastFocused) ||
      live[live.length - 1] || null
  }
  if (!target) {
    const state = createWindow({ raise: printed })
    state.pending.push({ filePath, separate })
    return
  }
  if (target.ready) deliver(target, filePath, separate)
  else target.pending.push({ filePath, separate })
  if (printed) raise(target.win)
  else focus(target.win)
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
  s.collecting = false
  while (s.pending.length) { const p = s.pending.shift(); deliver(s, p.filePath, p.separate) }
})

ipcMain.on('desktop:has-document', (e, hasDoc) => {
  const s = stateOf(e)
  if (!s) return
  s.hasDoc = !!hasDoc
})

ipcMain.on('desktop:collecting', (e, collecting) => {
  const s = stateOf(e)
  if (s) s.collecting = !!collecting
})

ipcMain.on('desktop:open-print-jobs', (e, names) => {
  if (!Array.isArray(names)) return
  const into = stateOf(e) || null
  for (const name of names) {
    // A name, never a path: only files the listener wrote can be opened this way.
    const file = path.join(PRINT_JOBS, path.basename(String(name)))
    if (/\.pdf$/i.test(file) && fs.existsSync(file)) openFile(file, { separate: true, into })
  }
})

// "Conectar con Claude" (Ayuda): where the MCP server and the Claude Desktop
// extension are, so the dialog can show the command that runs the server on
// this exe (ELECTRON_RUN_AS_NODE) and reveal the .mcpb for a double-click.
function mcpPaths() {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
  return {
    server: app.isPackaged ? path.join(base, 'mcp', 'server.mjs') : path.join(base, 'dist-mcp', 'server.mjs'),
    mcpb: app.isPackaged ? path.join(base, 'pdf-editor-pro.mcpb') : path.join(base, 'release', 'pdf-editor-pro.mcpb')
  }
}

ipcMain.handle('desktop:mcp-info', () => {
  const { server, mcpb } = mcpPaths()
  return { exe: process.execPath, server, serverExists: fs.existsSync(server), mcpb, mcpbExists: fs.existsSync(mcpb), packaged: app.isPackaged }
})

// Explorer, with the extension selected: the user double-clicks it, so the
// app never launches Claude itself (Sophos blocks the app from starting programs).
ipcMain.on('desktop:reveal-mcpb', () => {
  const { mcpb } = mcpPaths()
  if (fs.existsSync(mcpb)) shell.showItemInFolder(mcpb)
})

function createWindow({ raise: raiseOnShow = false } = {}) {
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
      sandbox: true,
      // Chromium's PDF viewer. Printing loads the saved document into a hidden
      // iframe and prints THAT (vector, not the screen canvas); without the
      // viewer the iframe never loads and the print button did nothing.
      plugins: true
    }
  })
  const state = { win, ready: false, hasDoc: false, collecting: false, pending: [] }
  const id = win.webContents.id
  editors.set(id, state)
  lastFocused = id
  win.on('focus', () => { lastFocused = id })

  // The first window fills the screen; later ones open cascaded over it so it
  // is plain that a new window appeared rather than the document changing.
  if (others.length === 0) win.maximize()
  else {
    const [x, y] = others[others.length - 1].getPosition()
    win.setPosition(x + 32, y + 32)
  }
  win.once('ready-to-show', () => { if (raiseOnShow) raise(win); else win.show() })
  win.webContents.once('did-finish-load', () => checkPrinter(win))

  const allowed = DEV_URL ? new URL(DEV_URL).origin : ORIGIN
  // Links to the web open in the user's browser; the app's own popups (the
  // print fallback's "open in new tab", blob: previews) stay in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // "Nueva ventana": the app's root becomes an editor window of its own, one
    // the files opened from Explorer can be sent to.
    if (url.split('#')[0] === `${allowed}/`) {
      createWindow()
      return { action: 'deny' }
    }
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

  win.on('closed', () => {
    editors.delete(id)
    if (lastFocused === id) lastFocused = null
  })
  win.loadURL(DEV_URL || `${ORIGIN}/`)
  return state
}

// ===== Updates from GitHub Releases =====
/** The focused window, or any visible one; waits for one to be shown. Null on timeout. */
function visibleWindow(timeoutMs) {
  const pick = () => {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && focused.isVisible()) return focused
    return BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible()) || null
  }
  const now = pick()
  if (now) return Promise.resolve(now)
  return new Promise(resolve => {
    const started = Date.now()
    const timer = setInterval(() => {
      const w = pick()
      if (w || Date.now() - started > timeoutMs) { clearInterval(timer); resolve(w) }
    }, 500)
  })
}

function setupUpdates() {
  if (!app.isPackaged) return
  let autoUpdater
  try { ({ autoUpdater } = require('electron-updater')) } catch { return }
  // Its default logger prints a stack trace to stderr whenever there is no
  // release to read (offline, or before the first one is published).
  // PDF_EDITOR_UPDATE_LOG=1 brings it back, for diagnosing an update.
  autoUpdater.logger = process.env.PDF_EDITOR_UPDATE_LOG ? console : null
  // NOTIFY ONLY: never download, never run the installer from here.
  //
  // Endpoint protection (Sophos's "Lockdown" exploit mitigation) treats this
  // app as a PDF READER — it is the default .pdf handler — and a PDF reader
  // launching an executable is exactly what a malicious PDF does. Every
  // in-app install (quitAndInstall, and install-on-quit) was blocked with
  // "Comportamiento malicioso 'Lockdown' evitado", while the same installer
  // run by the user installed fine. So the app only says a version exists and
  // opens its download in the browser; the user runs it.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('update-available', async (info) => {
    const version = info.version
    const url = `https://github.com/lucho19jose/PDF-WEB-EDITOR/releases/download/v${version}/PDF-Editor-Pro-Setup-${version}.exe`
    // The check usually answers before the first window is SHOWN, and a
    // message box owned by a hidden window closes at once as "cancel" — the
    // offer flashed by unseen. Wait for a visible window (up to a minute).
    const parent = await visibleWindow(60000)
    const options = {
      type: 'info',
      buttons: ['Descargar', 'Más tarde'],
      defaultId: 0,
      cancelId: 1,
      title: 'Actualización disponible',
      message: `Hay una nueva versión de PDF Editor Pro: ${version} (tiene la ${app.getVersion()}).`,
      detail: 'Al elegir "Descargar" se abre la descarga del instalador en el navegador. ' +
        'Cuando termine, cierre PDF Editor Pro y ejecute el instalador: se instala encima de esta versión.'
    }
    if (!parent) return // no window ever appeared: offer again at the next launch
    autoUpdater.logger?.info?.(`Offering ${version} (download page: ${url})`)
    const { response } = await dialog.showMessageBox(parent, options)
    autoUpdater.logger?.info?.(`Offer answered: ${response === 0 ? 'download' : 'later'}`)
    if (response === 0) shell.openExternal(url).catch(() => {})
  })
  autoUpdater.on('error', () => { /* offline, or no release yet: try next launch */ })
  autoUpdater.checkForUpdates().catch(() => {})
}

// ===== Startup =====
if (process.argv.includes(LISTENER_FLAG)) {
  // The logon entry, or the installer: start the printer's listener as plain
  // Node and leave. Never takes the single-instance lock — a running app would
  // otherwise receive this launch as a second instance.
  startPrintListener()
  app.exit(0)
} else if (!app.requestSingleInstanceLock()) {
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
