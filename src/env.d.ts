/// <reference types="vite/client" />

/** Present only in the Windows (Electron) app — see electron/preload.cjs. */
interface DesktopBridge {
  isDesktop: true
  /** `printed`: a job from the "PDF Editor Pro" printer, never saved by the user. */
  onOpenFile(callback: (file: { name: string; bytes: Uint8Array; printed?: boolean }) => void): void
  ready(): void
  setHasDocument(hasDoc: boolean): void
  /** This window collects print jobs: new ones join its Combinar list. */
  setCollecting?(collecting: boolean): void
  /** Opens print jobs (file names in the print folder) each in a window of its own. */
  openPrintJobs?(names: string[]): void
}
interface Window {
  desktop?: DesktopBridge
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
