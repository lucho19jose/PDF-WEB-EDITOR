<template>
  <div class="sig-pad">
    <div class="tabs">
      <button :class="{ on: mode === 'type' }" @click="mode = 'type'">Escribir</button>
      <button :class="{ on: mode === 'draw' }" @click="mode = 'draw'">Dibujar</button>
      <button :class="{ on: mode === 'image' }" @click="mode = 'image'">Imagen</button>
    </div>

    <div class="area">
      <template v-if="mode === 'type'">
        <input v-model="typed" class="type-input" :style="{ fontFamily: fontStack }" :placeholder="kind === 'initials' ? 'Sus iniciales' : 'Su nombre'" />
        <div class="styles">
          <button v-for="f in fonts" :key="f" :class="{ on: font === f }" :style="{ fontFamily: `'${f}', cursive` }" @click="font = f">{{ typed || 'Firma' }}</button>
        </div>
      </template>
      <template v-else-if="mode === 'draw'">
        <canvas
          ref="canvasRef" class="draw" width="560" height="180"
          @pointerdown="down" @pointermove="move" @pointerup="up" @pointerleave="up"
        />
        <button class="clear" @click="clearCanvas">Borrar</button>
      </template>
      <template v-else>
        <div class="img-drop" @click="pickImage">
          <img v-if="imageUrl" :src="imageUrl" alt="" />
          <span v-else>Haga clic para seleccionar una imagen de su firma</span>
        </div>
      </template>
      <div class="line" />
    </div>

    <div class="colors">
      <span>Color</span>
      <button v-for="c in ['#000000', '#1a3d8f', '#b00020']" :key="c" class="dot" :class="{ on: color === c }" :style="{ background: c }" @click="color = c" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, watch, nextTick } from 'vue'

const props = defineProps<{ kind: 'signature' | 'initials' }>()
const pickFiles = inject<(accept: string, multiple: boolean) => Promise<File[]>>('pickFiles')!

const mode = ref<'type' | 'draw' | 'image'>('type')
const typed = ref('')
const fonts = ['Brush Script MT', 'Segoe Script', 'Lucida Handwriting', 'Freestyle Script', 'Edwardian Script ITC']
const font = ref(fonts[0])
const fontStack = computed(() => `'${font.value}', 'Segoe Script', cursive`)
const color = ref('#000000')

// ── draw ──
const canvasRef = ref<HTMLCanvasElement | null>(null)
let drawing = false
let drawn = false
let last: [number, number] | null = null
function pos(e: PointerEvent): [number, number] {
  const c = canvasRef.value!, r = c.getBoundingClientRect()
  return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]
}
function down(e: PointerEvent) { drawing = true; last = pos(e); (e.target as HTMLElement).setPointerCapture?.(e.pointerId) }
function move(e: PointerEvent) {
  if (!drawing || !canvasRef.value || !last) return
  const ctx = canvasRef.value.getContext('2d')!
  const p = pos(e)
  ctx.strokeStyle = color.value
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke()
  last = p
  drawn = true
}
function up() { drawing = false; last = null }
function clearCanvas() {
  const c = canvasRef.value
  if (c) c.getContext('2d')!.clearRect(0, 0, c.width, c.height)
  drawn = false
}
watch(mode, m => { if (m === 'draw') nextTick(clearCanvas) })

// ── image ──
const imageUrl = ref('')
async function pickImage() {
  const [f] = await pickFiles('image/png,image/jpeg', false)
  if (!f) return
  imageUrl.value = await new Promise<string>(res => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(f) })
}

/** Crop a canvas to its ink, with a small margin. */
function trimmed(src: HTMLCanvasElement): string {
  const ctx = src.getContext('2d')!
  const { width: w, height: h } = src
  const data = ctx.getImageData(0, 0, w, h).data
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  }
  if (x1 < 0) return ''
  const m = 6
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m)
  const out = document.createElement('canvas')
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1
  out.getContext('2d')!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height)
  return out.toDataURL('image/png')
}

/** The signature as a transparent PNG data URL, or '' when there is nothing yet. */
async function result(): Promise<string> {
  if (mode.value === 'draw') return drawn && canvasRef.value ? trimmed(canvasRef.value) : ''
  if (mode.value === 'image') return imageUrl.value
  if (!typed.value.trim()) return ''
  const c = document.createElement('canvas')
  c.width = 900; c.height = 240
  const ctx = c.getContext('2d')!
  ctx.fillStyle = color.value
  ctx.font = `${props.kind === 'initials' ? 120 : 110}px ${fontStack.value}`
  ctx.textBaseline = 'middle'
  ctx.fillText(typed.value, 20, 120, 860)
  return trimmed(c)
}

defineExpose({ result })
</script>

<style scoped>
.sig-pad { width: 600px; max-width: 100%; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid #5a5a5a; margin-bottom: 12px; }
.tabs button { border: 0; background: transparent; color: #cfcfcf; font: inherit; font-size: 14px; padding: 8px 14px; cursor: pointer; border-bottom: 2px solid transparent; }
.tabs button.on { color: #fff; border-bottom-color: #fff; }
.area { position: relative; background: #fff; border-radius: 3px; min-height: 200px; padding: 12px; color: #111; }
.type-input { width: 100%; border: 0; outline: 0; font-size: 46px; color: #111; background: transparent; height: 90px; }
.styles { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.styles button { border: 1px solid #ccc; background: #fafafa; border-radius: 3px; padding: 4px 10px; font-size: 20px; cursor: pointer; color: #222; max-width: 180px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.styles button.on { border-color: var(--acro-blue); background: #e8f1fc; }
.draw { width: 100%; height: 180px; cursor: crosshair; touch-action: none; display: block; }
.clear { position: absolute; top: 8px; right: 10px; border: 0; background: transparent; color: var(--acro-blue); cursor: pointer; font: inherit; }
.img-drop { height: 176px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #666; border: 1px dashed #aaa; border-radius: 3px; }
.img-drop img { max-width: 100%; max-height: 170px; }
.line { position: absolute; left: 24px; right: 24px; bottom: 34px; border-bottom: 1px solid #bbb; pointer-events: none; }
.colors { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 13px; color: #cfcfcf; }
.dot { width: 20px; height: 20px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
.dot.on { border-color: #fff; }
</style>
