/// <reference types="vite/client" />

/** Present only in the Windows (Electron) app — see electron/preload.cjs. */
interface DesktopBridge {
  isDesktop: true
  onOpenFile(callback: (file: { name: string; bytes: Uint8Array }) => void): void
  ready(): void
}
interface Window {
  desktop?: DesktopBridge
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
