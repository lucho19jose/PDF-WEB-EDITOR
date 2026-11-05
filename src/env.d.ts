/// <reference types="vite/client" />

/** Present only in the Windows (Electron) app — see electron/preload.cjs. */
interface DesktopBridge {
  isDesktop: true
  /** `printed`: a job from the "PDF Editor Pro" printer, never saved by the user. */
  onOpenFile(callback: (file: { name: string; bytes: Uint8Array; printed?: boolean; separate?: boolean }) => void): void
  ready(): void
  setHasDocument(hasDoc: boolean): void
  /** This window collects print jobs: new ones join its Combinar list. */
  setCollecting?(collecting: boolean): void
  /** Opens print jobs (file names in the print folder) each in a window of its own. */
  openPrintJobs?(names: string[]): void
  /** Where the MCP server for Claude is (Ayuda ▸ Conectar con Claude). */
  mcpInfo?(): Promise<{ exe: string; server: string; serverExists: boolean; mcpb: string; mcpbExists: boolean; packaged: boolean }>
  /** Shows the Claude Desktop extension (.mcpb) selected in Explorer. */
  revealMcpb?(): void
  /**
   * Drags a PDF out of the app as a real file (Explorer, the desktop, a mail):
   * written to a temporary folder and handed to Windows' drag. Resolves when
   * the drag ends — dropped anywhere, or cancelled with Esc.
   */
  dragOut?(file: { name: string; bytes: Uint8Array; icon?: Uint8Array; scale?: number }): Promise<boolean>
}
/** The build this bundle belongs to (vite.config.ts), compared with /version.json. */
declare const __BUILD_ID__: string

interface Window {
  desktop?: DesktopBridge
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
