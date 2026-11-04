/**
 * PDF Editor Pro as an MCP server (stdio): the editor's engine — the same
 * MuPDF worker the app runs — exposed as tools for Claude Desktop and Claude
 * Code. Documents are files on disk; `open_in_editor` hands one to the app.
 *
 * Environment:
 *   PDF_MCP_ROOTS   folders the tools may read and write (';'-separated on
 *                   Windows; '*' = any). Default: the user's profile and temp.
 *   PDF_MCP_AUTHOR  author name written on new annotations.
 *   PDF_EDITOR_APP_EXE / PDF_EDITOR_APP_ARGS  the app to open files in (dev).
 */
import './stdioGuard'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SessionManager, THREAD_FILE } from './session'
import { Registrar } from './tools/registrar'
import { registerDocumentTools } from './tools/document'
import { registerReadTools } from './tools/read'
import { registerTextTools } from './tools/text'
import { registerAnnotateTools } from './tools/annotate'
import { registerPageTools } from './tools/pages'
import { registerExtraTools } from './tools/extras'
import { registerExportTools } from './tools/export'
import { registerScanTools } from './tools/scan'

declare const __APP_VERSION__: string

const INSTRUCTIONS = `PDF Editor Pro edits PDF files on this computer the way Acrobat Pro does: it changes the page's real text (not an overlay), and adds comments, stamps, signatures, page operations, headers/footers, watermarks, redaction, protection and export to Word/Excel.

Workflow:
1. open_pdf with the file's absolute path. Note which pages are scans.
2. Read: list_page_text (text blocks with references like "p1b12" and positions in points from the top-left corner), find_text, get_text, render_page (look at the page — do this to check layout and results).
3. Edit. To change words use replace_text (handles phrases split across lines; every occurrence unless occurrence:"first"). Use edit_text_block / delete_text / transform_text / restyle_text with references from a listing. References survive edits; refresh with list_page_text if one is reported missing.
4. Check the result with render_page, then save_pdf. With no path it writes "<name> (editado).pdf" beside the original; the original is replaced only with overwrite:true and when the user asked for it.

Scanned pages: their words are part of an image. To change them call recognize_page (OCR on this computer, a few seconds) and then edit_scanned_text with the run references it returns, or replace_text: the edit is made ON the scan — kept letters stay the scan's pixels, new letters come from the page's own — so the result looks like the original document. NEVER cover scanned words with a white rectangle and new text (add_shape + add_text/add_free_text): that shows a different typeface and cuts through lines and frames. If a run cannot be drawn on the scan, tell the user why and offer open_in_editor. Filling in a form's blanks (writing where nothing was printed) is still add_free_text / add_mark.
Ask the user before deleting pages, redacting, flattening, or overwriting a file. Every edit can be undone with undo until the document is closed.
Reply in the user's language; the app's own names for tools are in Spanish (Editar PDF, Organizar páginas, Comentar, Rellenar y firmar, Proteger, Exportar).`

async function main() {
  const server = new McpServer(
    { name: 'pdf-editor-pro', title: 'PDF Editor Pro', version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0' },
    { instructions: INSTRUCTIONS }
  )
  const mgr = new SessionManager()
  const reg = new Registrar(server, mgr, THREAD_FILE)
  registerDocumentTools(reg)
  registerReadTools(reg)
  registerTextTools(reg)
  registerAnnotateTools(reg)
  registerPageTools(reg)
  registerExtraTools(reg)
  registerExportTools(reg)
  registerScanTools(reg)

  // Engine threads keep the process alive: exit when the client goes away,
  // or an orphaned "PDF Editor Pro.exe" stays behind for every session.
  let closing = false
  const shutdown = async (code = 0) => {
    if (closing) return
    closing = true
    await Promise.race([Promise.all([mgr.closeAll(), reg.close()]), new Promise(r => setTimeout(r, 2000))])
    process.exit(code)
  }
  process.stdin.on('end', () => void shutdown())
  process.stdin.on('close', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  const transport = new StdioServerTransport()
  transport.onclose = () => void shutdown()
  await server.connect(transport)
  console.error(`[pdf-editor-mcp] ready (engine: ${THREAD_FILE})`)
}

main().catch(err => {
  console.error('[pdf-editor-mcp] failed to start:', err)
  process.exit(1)
})
