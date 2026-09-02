/// <reference lib="webworker" />
/**
 * PaddleOCR (PP-OCRv6) in a Web Worker, on ONNX Runtime Web.
 *
 * ORT's WASM lives in node_modules and is served by Vite through `?url`
 * imports — NOT the jsDelivr CDN the SDK falls back to, which the app's
 * `Cross-Origin-Embedder-Policy: require-corp` would refuse anyway and which
 * would break offline use. The env must be set BEFORE the SDK module
 * evaluates, because the SDK fills `wasmPaths` on import when it is empty;
 * hence the dynamic import below.
 *
 * Model files (~31 MB) are fetched once through the Cache Storage API and
 * handed to the SDK as ArrayBuffers, so a second visit costs no download.
 */
// Relative URLs, not package subpaths: onnxruntime-web's `exports` map does
// not expose `dist/*.wasm`, so a bare specifier fails to resolve. Vite turns
// these into served files in dev and emitted assets in a build.
const ortWasmUrl = new URL('../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', import.meta.url).href
const ortMjsUrl = new URL('../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', import.meta.url).href

const MODEL_FILES = {
  detection: '/paddle/PP-OCRv6_small_det.ort',
  recognition: '/paddle/PP-OCRv6_small_rec.ort',
  charactersDictionary: '/paddle/ppocrv6_dict.txt'
}
const CACHE_NAME = 'ocr-models-v1'

type Req =
  | { id: number; type: 'init' }
  | { id: number; type: 'recognize'; bitmap: ImageBitmap }
  | { id: number; type: 'destroy' }

let service: any = null
let initPromise: Promise<void> | null = null

function post(msg: any) { (self as any).postMessage(msg) }

async function cachedBuffer(url: string, label: string, id: number): Promise<ArrayBuffer> {
  let cache: Cache | null = null
  try { cache = await caches.open(CACHE_NAME) } catch (_) { cache = null }
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined
  if (hit) return hit.arrayBuffer()
  post({ id, type: 'progress', stage: `Downloading ${label}...`, percent: 0 })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} for ${url}`)
  const buf = await res.arrayBuffer()
  if (cache) { try { await cache.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })) } catch (_) { /* quota */ } }
  return buf
}

async function init(id: number): Promise<void> {
  if (service) return
  if (!initPromise) {
    initPromise = (async () => {
      const ort = await import('onnxruntime-web')
      ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl } as any
      // Threads need cross-origin isolation, which the app has; leave the count
      // to the runtime when it does not.
      if (!(self as any).crossOriginIsolated) ort.env.wasm.numThreads = 1
      const sdk = await import('ppu-paddle-ocr/web')
      post({ id, type: 'progress', stage: 'Loading the recogniser...', percent: 0 })
      const [detection, recognition, charactersDictionary] = await Promise.all([
        cachedBuffer(MODEL_FILES.detection, 'detection model', id),
        cachedBuffer(MODEL_FILES.recognition, 'recognition model', id),
        cachedBuffer(MODEL_FILES.charactersDictionary, 'dictionary', id)
      ])
      const svc = new sdk.PaddleOcrService({
        model: { detection, recognition, charactersDictionary },
        // No OpenCV: the canvas processor has no 10 MB WASM to load and is
        // enough for scanned pages.
        processing: { engine: 'canvas-native' },
        recognition: { strategy: 'per-box', minimumConfidence: 0.3, mainThreadYieldMs: 0 } as any
      })
      await svc.initialize()
      // Warm the pipeline: the first inference compiles the WebGPU shaders
      // and cost 11.6 s against 5.1 s for the second on the same page. A tiny
      // blank canvas pays that while the user is still looking at the page.
      try {
        const warm = new OffscreenCanvas(96, 48)
        const wctx = warm.getContext('2d')
        if (wctx) { wctx.fillStyle = '#fff'; wctx.fillRect(0, 0, 96, 48); wctx.fillStyle = '#000'; wctx.font = '24px sans-serif'; wctx.fillText('ab', 10, 32) }
        await svc.recognize(warm as any, { flatten: true, noCache: true })
      } catch (_) { /* warm-up only */ }
      service = svc
    })().catch(err => { initPromise = null; throw err })
  }
  await initPromise
}

async function recognize(id: number, bitmap: ImageBitmap) {
  await init(id)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  post({ id, type: 'progress', stage: 'Recognising text...', percent: 10 })
  const result = await service.recognize(canvas as any, { flatten: true })
  const items = (result.results ?? []).map((r: any) => ({
    text: String(r.text ?? ''),
    confidence: Number(r.confidence ?? 0),
    box: { x: r.box.x, y: r.box.y, width: r.box.width, height: r.box.height }
  }))
  return { items, confidence: Number(result.confidence ?? 0) }
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data
  try {
    if (req.type === 'init') { await init(req.id); post({ id: req.id, type: 'ok', data: null }); return }
    if (req.type === 'recognize') { post({ id: req.id, type: 'ok', data: await recognize(req.id, req.bitmap) }); return }
    if (req.type === 'destroy') {
      try { await service?.destroy?.() } catch (_) { /* nothing to free */ }
      service = null; initPromise = null
      post({ id: req.id, type: 'ok', data: null })
      return
    }
  } catch (err: any) {
    post({ id: (req as any).id, type: 'error', error: err?.message || String(err) })
  }
}
