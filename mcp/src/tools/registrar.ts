/**
 * How every tool is registered: one error policy (ToolError and engine errors
 * become an isError result the model can read and act on, never a protocol
 * error), one way to reach a document (serialised, synced with the file on
 * disk), and MCP annotations so clients can tell reads from destructive edits.
 */
import os from 'node:os'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZodRawShape } from 'zod'
import { SessionManager, type DocumentSession } from '../session'
import { EngineClient, EngineError } from '../engine/client'
import { fail, ToolError, type ToolResult } from '../util'

export interface ToolSpec {
  title: string
  description: string
  input: ZodRawShape
  readOnly?: boolean
  destructive?: boolean
  idempotent?: boolean
}

export class Registrar {
  private scratchEngine: EngineClient | null = null
  /** Written as the author of new annotations: PDF_MCP_AUTHOR, else the Windows user name. */
  readonly author: string = (() => {
    if (process.env.PDF_MCP_AUTHOR) return process.env.PDF_MCP_AUTHOR
    try { return os.userInfo().username } catch (_) { return 'PDF Editor Pro' }
  })()

  constructor(private readonly server: McpServer, readonly mgr: SessionManager, private readonly threadFile: string) {}

  add(name: string, spec: ToolSpec, fn: (args: any) => Promise<ToolResult>) {
    this.server.registerTool(name, {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      annotations: {
        title: spec.title,
        readOnlyHint: !!spec.readOnly,
        destructiveHint: !!spec.destructive,
        idempotentHint: !!spec.idempotent,
        openWorldHint: false
      }
    }, async (args: any) => {
      try {
        return await fn(args ?? {})
      } catch (err: any) {
        if (err instanceof ToolError || err instanceof EngineError) return fail(err.message)
        console.error(`[pdf-editor-mcp] ${name} failed:`, err)
        return fail(`${name} failed: ${err?.message || err}`)
      }
    })
  }

  /**
   * Run `fn` on the document a tool names (`doc_id`, or the only open one),
   * after checking whether its file changed on disk; a note about that is
   * appended to the result.
   */
  async doc(args: { doc_id?: string }, fn: (s: DocumentSession) => Promise<ToolResult>): Promise<ToolResult> {
    const s = this.mgr.get(args.doc_id)
    return s.run(async () => {
      const note = await s.syncWithDisk()
      const res = await fn(s)
      if (note) res.content.push({ type: 'text', text: note })
      return res
    })
  }

  /** An engine with no document, for operations that make new documents or read bytes. */
  scratch(): EngineClient {
    this.scratchEngine ??= new EngineClient(this.threadFile)
    return this.scratchEngine
  }

  async close() {
    await this.scratchEngine?.close()
    this.scratchEngine = null
  }
}
