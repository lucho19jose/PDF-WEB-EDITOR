// Packs dist-mcp/ as a Claude Desktop extension: release/pdf-editor-pro.mcpb.
//
// The manifest's tool list is read from the BUILT server (started over stdio
// and asked), so the install screen always shows what the bundle really has.
// Run after tools/mcp/build.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = path.join(ROOT, 'dist-mcp')
const OUT = path.join(ROOT, 'release', 'pdf-editor-pro.mcpb')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
if (!fs.existsSync(path.join(DIST, 'server.mjs'))) throw new Error('dist-mcp/server.mjs is missing: run tools/mcp/build.mjs first')

const imp = (p) => import(pathToFileURL(path.join(ROOT, 'node_modules', p)).href)
const { Client } = await imp('@modelcontextprotocol/sdk/dist/esm/client/index.js')
const { StdioClientTransport } = await imp('@modelcontextprotocol/sdk/dist/esm/client/stdio.js')
const client = new Client({ name: 'package', version: '1.0.0' })
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(DIST, 'server.mjs')], stderr: 'ignore' }))
const { tools } = await client.listTools()
await client.close()

fs.copyFileSync(path.join(ROOT, 'build', 'icon.png'), path.join(DIST, 'icon.png'))

const manifest = {
  manifest_version: '0.3',
  name: 'pdf-editor-pro',
  display_name: 'PDF Editor Pro',
  version: pkg.version,
  description: 'Edit PDFs on your computer: change their real text, comment, sign, organise pages, add headers, watermarks and page numbers, redact, protect, and export to Word or Excel.',
  long_description: 'PDF Editor Pro edits the PDF content itself, the way Acrobat Pro does — not an overlay. Claude can open a PDF by its path, read and search it, replace words (also across lines and table cells), move and restyle text, add highlights, notes, text boxes, stamps, checkmarks, images and signatures, rotate, reorder, insert, extract, split and combine pages, add headers/footers, page numbers, watermarks and backgrounds, redact, protect with a password, and export to Word, Excel, text, HTML or images. Every change can be undone; files are saved next to the original unless you ask to replace it. Scanned pages are opened in the PDF Editor Pro app for OCR. Everything runs locally: no document leaves this computer.',
  author: { name: 'Jose Luis Barboza' },
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'server.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server.mjs', '--roots', '${user_config.allowed_directories}'],
      env: { PDF_MCP_AUTHOR: '${user_config.author}' }
    }
  },
  tools: tools.map(t => ({ name: t.name, description: t.description.split(/(?<=\.)\s/)[0] })),
  keywords: ['pdf', 'edit', 'acrobat', 'sign', 'ocr', 'redact', 'merge', 'excel', 'word'],
  license: 'AGPL-3.0',
  compatibility: { platforms: ['win32', 'darwin', 'linux'], runtimes: { node: '>=20.0.0' } },
  user_config: {
    allowed_directories: {
      type: 'directory',
      title: 'Allowed folders',
      description: 'Folders whose PDFs Claude may open and where it may save (subfolders included). Default: your user folder.',
      multiple: true,
      required: true,
      default: ['${HOME}']
    },
    author: {
      type: 'string',
      title: 'Author name',
      description: 'Written as the author of comments and highlights.',
      required: false,
      default: ''
    }
  }
}
fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2))

const cli = path.join(ROOT, 'node_modules/@anthropic-ai/mcpb/dist/cli/cli.js')
const run = (...args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`mcpb ${args[0]} failed`)
}
run('validate', path.join(DIST, 'manifest.json'))
fs.mkdirSync(path.dirname(OUT), { recursive: true })
run('pack', DIST, OUT)
console.log(`${OUT}: ${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB, ${tools.length} tools`)
