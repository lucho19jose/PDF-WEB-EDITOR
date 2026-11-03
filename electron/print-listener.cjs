// The other end of the "PDF Editor Pro" printer.
//
// The printer is an ordinary Windows printer: Windows' own "Microsoft Print To
// PDF" driver writing to a LOCAL PORT that is a named pipe — the arrangement
// PDF24 uses for its printer (`\\.\pipe\PDFPrint`). Each print job is one
// connection to the pipe: the spooler connects, writes the finished PDF and
// closes. This process serves the pipe, keeps each job as a file named after
// the document, and opens it in the editor.
//
// It runs as plain Node — the app's own executable with ELECTRON_RUN_AS_NODE —
// started at logon and whenever the app starts (electron/main.cjs). A few tens
// of MB, no window, and it never needs Chromium. It launches only the app's
// own executable: Sophos treats this app as a PDF reader and blocks it from
// starting anything else.
//
// Known limitation: the pipe is global to the machine, so on a PC shared by
// several signed-in users the first user's listener receives everyone's jobs.
// PDF24 avoids that with a SYSTEM service relaying to a per-session pipe.

'use strict'

const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const PIPE = '\\\\.\\pipe\\PDFEditorPro'
// Shared with electron/main.cjs, which recognises a file from here as a print job.
const BASE = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'PDF Editor Pro')
const OUT = path.join(BASE, 'Impresiones')
const LOG = path.join(BASE, 'impresora.log')
// A printed document lives only here until the user saves it, so it is kept a
// while: closing the window by mistake must not be the end of it.
const KEEP_MS = 7 * 24 * 3600 * 1000
const PART_MAX_AGE_MS = 24 * 3600 * 1000
// The executable to open a job with: the app itself. In development the
// executable is electron.exe and needs the app directory first.
const APP_EXE = process.env.PDF_EDITOR_APP_EXE || process.execPath
let APP_ARGS = []
try { APP_ARGS = JSON.parse(process.env.PDF_EDITOR_APP_ARGS || '[]') } catch { /* none */ }

function log(message) {
  try {
    fs.mkdirSync(BASE, { recursive: true })
    try {
      if (fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, LOG + '.old')
    } catch { /* no log yet */ }
    fs.appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${message}\n`)
  } catch { /* logging must never stop a job */ }
}

// ===== The document's name: the PDF's /Title =====
// Microsoft Print To PDF records the job's document name as /Title ("CONSTANCIA
// DEL RNP", "Crystal Reports - CHECK LIST"), in an uncompressed Info dictionary.

/** Reads the PDF string starting at `i` ("(" or "<"); returns its bytes. */
function readPdfString(buf, i) {
  if (buf[i] === 0x28) { // ( literal, parentheses may nest unescaped
    const out = []
    let depth = 1
    for (i++; i < buf.length; i++) {
      const c = buf[i]
      if (c === 0x5c) { // backslash
        const n = buf[++i]
        if (n === undefined) break
        const simple = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c }
        if (n in simple) out.push(simple[n])
        else if (n >= 0x30 && n <= 0x37) { // up to three octal digits
          let v = n - 0x30
          for (let k = 0; k < 2 && buf[i + 1] >= 0x30 && buf[i + 1] <= 0x37; k++) v = v * 8 + (buf[++i] - 0x30)
          out.push(v & 0xff)
        } else if (n === 0x0d) { if (buf[i + 1] === 0x0a) i++ } // line continuation
        else if (n !== 0x0a) out.push(n)
        continue
      }
      if (c === 0x28) depth++
      else if (c === 0x29 && --depth === 0) return Buffer.from(out)
      out.push(c)
    }
    return null
  }
  if (buf[i] === 0x3c) { // <hex>
    const end = buf.indexOf(0x3e, i)
    if (end < 0) return null
    let hex = buf.toString('latin1', i + 1, end).replace(/[^0-9a-f]/gi, '')
    if (hex.length % 2) hex += '0'
    return Buffer.from(hex, 'hex')
  }
  return null
}

function decodeTextString(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE: swap to the little-endian Node can decode (an odd byte is dropped).
    const body = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)))
    return body.swap16().toString('utf16le')
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8')
  return bytes.toString('latin1') // PDFDocEncoding, close enough for a file name
}

function pdfTitle(buf) {
  const text = buf.toString('latin1')
  // Prefer the dictionary the trailer names as /Info; a stray "/Title" elsewhere
  // (an outline, an annotation) is not the document's.
  let from = -1
  const info = /\/Info\s+(\d+)\s+(\d+)\s+R/g
  let m, last = null
  while ((m = info.exec(text))) last = m
  if (last) {
    const obj = new RegExp(`(^|[^0-9])${last[1]}\\s+${last[2]}\\s+obj`, 'm').exec(text)
    if (obj) from = obj.index
  }
  const at = text.indexOf('/Title', from < 0 ? 0 : from)
  if (at < 0) return ''
  let i = at + 6
  while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i++
  const bytes = readPdfString(buf, i)
  return bytes ? decodeTextString(bytes).trim() : ''
}

function fileNameFor(title) {
  let name = (title || '')
    .replace(/\.pdf$/i, '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (name.length > 120) name = name.slice(0, 120).trim()
  if (!name) {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    name = `Impresión ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`
  }
  let candidate = path.join(OUT, `${name}.pdf`)
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(OUT, `${name} (${n}).pdf`)
  return candidate
}

// ===== Jobs =====
function openInApp(file) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    // A second launch of the app: its single-instance lock hands the file to the
    // running copy (a new window), or it starts and opens the file itself.
    const child = spawn(APP_EXE, [...APP_ARGS, file], { detached: true, stdio: 'ignore', env })
    child.on('error', err => log(`could not start the app: ${err.message}`))
    child.unref()
  } catch (err) {
    log(`could not start the app: ${err.message}`)
  }
}

function finishJob(part, size) {
  let buf
  try { buf = fs.readFileSync(part) } catch (err) { log(`job lost: ${err.message}`); return }
  // A cancelled job ends early; a job from a printer whose driver was changed
  // is not a PDF at all. Either way there is nothing to open.
  const head = buf.toString('latin1', 0, Math.min(buf.length, 1024))
  const tail = buf.toString('latin1', Math.max(0, buf.length - 2048))
  if (!head.includes('%PDF-') || !tail.includes('%%EOF')) {
    log(`discarded a job of ${size} bytes: not a complete PDF`)
    fs.rm(part, { force: true }, () => {})
    return
  }
  let title = ''
  try { title = pdfTitle(buf) } catch { /* unnamed */ }
  const file = fileNameFor(title)
  try {
    fs.renameSync(part, file)
  } catch (err) {
    log(`could not name the job "${title}": ${err.message}`)
    return
  }
  log(`job "${title}" (${size} bytes) -> ${file}`)
  openInApp(file)
}

let jobs = 0
function onConnection(socket) {
  const part = path.join(OUT, `.trabajo-${Date.now()}-${process.pid}-${++jobs}.part`)
  let size = 0
  let failed = false
  const out = fs.createWriteStream(part)
  socket.on('data', chunk => { size += chunk.length })
  socket.pipe(out)
  out.on('finish', () => { if (!failed) finishJob(part, size) })
  const fail = (what) => (err) => {
    if (failed) return
    failed = true
    log(`job failed (${what}): ${err.message}`)
    socket.destroy()
    out.destroy()
    fs.rm(part, { force: true }, () => {})
  }
  socket.on('error', fail('pipe'))
  out.on('error', fail('disk'))
}

function sweepOld() {
  let names = []
  try { names = fs.readdirSync(OUT) } catch { return }
  const now = Date.now()
  for (const name of names) {
    const file = path.join(OUT, name)
    try {
      const age = now - fs.statSync(file).mtimeMs
      if (age > KEEP_MS || (name.endsWith('.part') && age > PART_MAX_AGE_MS)) fs.rmSync(file, { force: true })
    } catch { /* gone, or in use */ }
  }
}

function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const server = net.createServer(onConnection)
  server.on('error', (err) => {
    // The pipe is taken: another listener already serves the printer. Exactly
    // what a second start (logon + app launch) should find.
    if (err.code === 'EADDRINUSE') process.exit(0)
    log(`listener stopped: ${err.message}`)
    process.exit(1)
  })
  server.listen(PIPE, () => {
    log(`listening on ${PIPE}`)
    sweepOld()
    setInterval(sweepOld, 6 * 3600 * 1000).unref()
  })
}

module.exports = { pdfTitle, fileNameFor, PIPE, OUT }

if (require.main === module) main()
