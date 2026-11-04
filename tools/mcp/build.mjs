// Builds the MCP server into dist-mcp/:
//   server.mjs         the stdio server (SDK, tools, sessions)
//   engine-thread.mjs  the app's own MuPDF worker, made to run in worker_threads
//   vendor/mupdf/      mupdf's Node-capable module and its wasm (~10 MB)
//   assets/fonts/      the CJK fallback and metric-compatible faces the worker fetches
//
// Two Vite builds with NO config file: the app's config would bring the vue
// and quasar plugins, and an SSR build still copies `public/` — 1.5 GB here,
// the user's own documents under public/_sweep included. `publicDir: false`.
//
// `mupdf` stays external and its import is rewritten to ./vendor/mupdf/…, so
// the bundle never finds the repo's node_modules by walking up — tests from
// inside the repo would otherwise pass with a broken package.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = path.join(ROOT, 'dist-mcp')
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const { build } = await import(pathToFileURL(path.join(ROOT, 'node_modules/vite/dist/node/index.js')).href)

function config(entry, fileName, emptyOutDir) {
  return {
    configFile: false,
    root: ROOT,
    publicDir: false,
    logLevel: 'warn',
    define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
    resolve: { alias: { '@': path.join(ROOT, 'src') } },
    ssr: { target: 'node', noExternal: true, external: ['mupdf'] },
    build: {
      ssr: entry,
      target: 'node20',
      outDir: OUT,
      emptyOutDir,
      copyPublicDir: false,
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
      rollupOptions: {
        external: ['mupdf'],
        output: {
          format: 'es',
          entryFileNames: fileName,
          inlineDynamicImports: true,
          paths: { mupdf: './vendor/mupdf/dist/mupdf.js' }
        }
      }
    }
  }
}

const t0 = Date.now()
await build(config(path.join(ROOT, 'mcp/src/engine/thread.ts'), 'engine-thread.mjs', true))
await build(config(path.join(ROOT, 'mcp/src/server.ts'), 'server.mjs', false))

// mupdf: package.json (it declares "type": "module") and the three files it loads.
const mu = path.join(ROOT, 'node_modules/mupdf')
const vendor = path.join(OUT, 'vendor/mupdf')
fs.mkdirSync(path.join(vendor, 'dist'), { recursive: true })
const pkg = JSON.parse(fs.readFileSync(path.join(mu, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({ name: 'mupdf', version: pkg.version, type: 'module', license: pkg.license }, null, 2))
for (const f of ['mupdf.js', 'mupdf-wasm.js', 'mupdf-wasm.wasm']) fs.copyFileSync(path.join(mu, 'dist', f), path.join(vendor, 'dist', f))
for (const f of ['LICENSE', 'COPYING', 'LICENSE.txt']) if (fs.existsSync(path.join(mu, f))) fs.copyFileSync(path.join(mu, f), path.join(vendor, f))

// Fonts the worker fetches by URL.
fs.cpSync(path.join(ROOT, 'public/fonts'), path.join(OUT, 'assets/fonts'), { recursive: true })

// The OCR runtime (scanned pages): its own bundle, ocr/ocr.mjs, loaded on first
// use, beside an ocr/node_modules holding the recogniser and its native parts.
// A node_modules folder NESTED in dist-mcp is kept by electron-builder's
// extraResources (only one at the root of the copied folder is dropped —
// app-builder-lib/out/util/filter.js), so plain Node resolution works there.
{
  const c = config(path.join(ROOT, 'mcp/src/ocr/runtime.ts'), 'ocr.mjs', false)
  const external = ['ppu-paddle-ocr', 'ppu-ocv']
  c.ssr.external = external
  c.build.outDir = path.join(OUT, 'ocr')
  c.build.rollupOptions.external = external
  c.build.rollupOptions.output.paths = {}
  await build(c)
  const nm = path.join(OUT, 'ocr/node_modules')
  const src = path.join(ROOT, 'node_modules')
  const copy = (from, to, filter) => fs.cpSync(path.join(src, from), path.join(nm, to ?? from), { recursive: true, filter })
  copy('ppu-paddle-ocr', undefined, f => !/[\\/](cli|mobile)([\\/]|$)/.test(f.slice(src.length)))
  copy('@techstark/opencv-js')
  copy('onnxruntime-common')
  // onnxruntime-node: its loader and the Windows x64 binaries only (the rest is 200 MB of other platforms).
  copy('onnxruntime-node', undefined, f => {
    const rel = path.relative(path.join(src, 'onnxruntime-node'), f).replace(/\\/g, '/')
    if (rel.startsWith('bin/')) return rel === 'bin' || 'bin/napi-v6/win32/x64'.startsWith(rel) || rel.startsWith('bin/napi-v6/win32/x64/')
    return !rel.startsWith('script') && !rel.startsWith('lib')
  })
  // ppu-ocv with ITS @napi-rs/canvas (1.0.8; the repo root has another) and only the Windows x64 binary.
  copy('ppu-ocv', undefined, f => {
    const rel = path.relative(path.join(src, 'ppu-ocv'), f).replace(/\\/g, '/')
    const m = rel.match(/^node_modules\/@napi-rs\/canvas-([^/]+)/)
    return !m || m[1] === 'win32-x64-msvc'
  })
  // The recogniser's models (the app's own, from public/paddle).
  fs.cpSync(path.join(ROOT, 'public/paddle'), path.join(OUT, 'assets/paddle'), { recursive: true })
}

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter(e => e.isFile()).reduce((n, e) => n + fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size, 0)
console.log(`dist-mcp built in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${(size(OUT) / 1048576).toFixed(1)} MB`)
