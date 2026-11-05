import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { quasar, transformAssetUrls } from '@quasar/vite-plugin'
import { fileURLToPath } from 'node:url'

/**
 * Which build this is. Baked into the bundle as `__BUILD_ID__` and written to
 * `version.json`, which every page fetches uncached on load (src/main.ts): a
 * page whose bundle disagrees was served stale by some cache and reloads
 * itself once, so F5 after a deploy is enough.
 */
const BUILD_ID = Date.now().toString(36)

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID)
  },
  plugins: [
    vue({ template: { transformAssetUrls } }),
    quasar({ sassVariables: false }),
    {
      name: 'build-version',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) })
      }
    }
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 9000,
    headers: {
      // Required for SharedArrayBuffer (needed by some WASM modules)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless'
    }
  },
  preview: {
    port: 9000,
    headers: {
      // The same isolation as the dev server: without it `vite preview` has no
      // SharedArrayBuffer, so MuPDF and ONNX Runtime lose their threads.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless'
    }
  },
  optimizeDeps: {
    // Don't pre-bundle mupdf — it has WASM and top-level await. ONNX Runtime
    // and the PaddleOCR SDK locate their WASM and workers by URL, which
    // pre-bundling rewrites out from under them.
    exclude: ['mupdf', 'onnxruntime-web', 'ppu-paddle-ocr', 'ppu-ocv']
  },
  worker: {
    format: 'es'
  }
})
