import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { quasar, transformAssetUrls } from '@quasar/vite-plugin'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [
    vue({ template: { transformAssetUrls } }),
    quasar({ sassVariables: false })
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
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  preview: {
    port: 9000,
    headers: {
      // The same isolation as the dev server: without it `vite preview` has no
      // SharedArrayBuffer, so MuPDF and ONNX Runtime lose their threads.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
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
