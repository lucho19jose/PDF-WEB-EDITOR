<template>
  <!-- One page thumbnail, drawn when it comes into view and redrawn after
       every edit (the cache is keyed by document revision). -->
  <div ref="el" class="thumb-image" :style="{ width: width + 'px', minHeight: placeholderH + 'px' }">
    <img v-if="url" :src="url" :style="{ width: width + 'px' }" draggable="false" alt="" @load="onLoad" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useThumbnails } from '@/composables/useThumbnails'

const props = withDefaults(defineProps<{ page: number; width: number; aspect?: number }>(), { aspect: 1.294 })
const emit = defineEmits<{ ratio: [number] }>()
const thumbs = useThumbnails()
const el = ref<HTMLElement | null>(null)
const url = ref<string | null>(null)
const placeholderH = ref(Math.round(props.width * props.aspect))
let visible = false
let observer: IntersectionObserver | null = null

async function load() {
  if (!visible) return
  const want = thumbs.version.value
  const u = await thumbs.request(props.page, props.width)
  if (want === thumbs.version.value && u) url.value = u
}

function onLoad(e: Event) {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth) {
    const r = img.naturalHeight / img.naturalWidth
    placeholderH.value = Math.round(props.width * r)
    emit('ratio', r)
  }
}

watch(() => [thumbs.version.value, props.page, props.width] as const, () => {
  // Keep the old picture until the new one is ready: a blank flash on every edit reads as a glitch.
  const c = thumbs.cached(props.page, props.width)
  if (c) url.value = c
  load()
})

onMounted(() => {
  observer = new IntersectionObserver(entries => {
    visible = entries.some(e => e.isIntersecting)
    if (visible) load()
  }, { rootMargin: '400px' })
  if (el.value) observer.observe(el.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<style scoped>
.thumb-image { background: #fff; display: block; line-height: 0; }
.thumb-image img { display: block; height: auto; }
</style>
