/**
 * Hand a PDF on disk to PDF Editor Pro: the app's single-instance lock opens
 * it as a tab of the running window (or starts the app with it). This is the
 * launch the print listener already makes — the app's own exe, detached,
 * with no stdio — which Sophos lets through.
 *
 * The app receives the file's BYTES, not its path (electron/main.cjs), so
 * whatever the user saves there is written where they choose; the session
 * then notices the file changing on disk (`syncWithDisk`).
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const EXE_NAME = 'PDF Editor Pro.exe'

/** Where the app is: an override, the exe running this server, the uninstall entry, the default folder. */
export function findAppExe(): { exe: string; args: string[] } | null {
  let args: string[] = []
  try { args = JSON.parse(process.env.PDF_EDITOR_APP_ARGS || '[]') } catch (_) { /* none */ }
  const override = process.env.PDF_EDITOR_APP_EXE
  if (override && fs.existsSync(override)) return { exe: override, args }
  if (path.basename(process.execPath).toLowerCase() === EXE_NAME.toLowerCase()) return { exe: process.execPath, args: [] }
  if (process.platform !== 'win32') return null
  const fromRegistry = registryInstallLocation()
  const candidates = [
    fromRegistry && path.join(fromRegistry, EXE_NAME),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'PDF Editor Pro', EXE_NAME),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'PDF Editor Pro', EXE_NAME)
  ].filter(Boolean) as string[]
  const exe = candidates.find(c => fs.existsSync(c))
  return exe ? { exe, args: [] } : null
}

function registryInstallLocation(): string | null {
  try {
    const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'PDF Editor Pro', '/d'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    const key = r.stdout?.split(/\r?\n/).find(l => l.startsWith('HKEY_'))
    if (!key) return null
    const v = spawnSync('reg', ['query', key, '/v', 'InstallLocation'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    const m = /InstallLocation\s+REG_\w+\s+(.+)/.exec(v.stdout || '')
    return m ? m[1].trim() : null
  } catch (_) { return null }
}

export function openInApp(file: string): { ok: true; exe: string } | { ok: false; error: string } {
  const app = findAppExe()
  if (!app) return { ok: false, error: `PDF Editor Pro is not installed on this computer (looked for ${EXE_NAME}). The file was saved at ${file}; open it with PDF Editor Pro when it is installed.` }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    // stdio 'ignore': inheriting would hand the app this server's JSON-RPC pipe.
    const child = spawn(app.exe, [...app.args, file], { detached: true, stdio: 'ignore', env, windowsHide: false })
    child.on('error', err => console.error(`[pdf-editor-mcp] could not start PDF Editor Pro: ${err.message}`))
    child.unref()
    return { ok: true, exe: app.exe }
  } catch (err: any) {
    return { ok: false, error: `Could not start PDF Editor Pro: ${err?.message || err}` }
  }
}
