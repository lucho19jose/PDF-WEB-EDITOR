<template>
  <div class="search-hl-container" v-if="searchStore.open && pageHits.length">
    <div
      v-for="(box, i) in boxes"
      :key="i"
      class="search-hl"
      :class="{ current: box.current }"
      :style="box.style"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useSearchStore } from '@/stores/search'

const props = defineProps<{ pageWidth: number; pageHeight: number; pdfWidth: number; pdfHeight: number }>()

const docStore = useDocumentStore()
const searchStore = useSearchStore()

const scaleX = computed(() => props.pageWidth / props.pdfWidth)
const scaleY = computed(() => props.pageHeight / props.pdfHeight)

const pageHits = computed(() => searchStore.hitsOnPage(docStore.currentPage - 1))

const boxes = computed(() => {
  const cur = searchStore.current
  const out: { style: Record<string, string>; current: boolean }[] = []
  for (const hit of pageHits.value) {
    const isCurrent = cur === hit
    for (const q of hit.quads) {
      const xs = [q[0], q[2], q[4], q[6]]
      const ys = [q[1], q[3], q[5], q[7]]
      const x0 = Math.min(...xs), x1 = Math.max(...xs)
      const y0 = Math.min(...ys), y1 = Math.max(...ys)
      out.push({
        current: isCurrent,
        style: {
          left: `${x0 * scaleX.value}px`,
          top: `${y0 * scaleY.value}px`,
          width: `${(x1 - x0) * scaleX.value}px`,
          height: `${(y1 - y0) * scaleY.value}px`
        }
      })
    }
  }
  return out
})
</script>

<style scoped>
.search-hl-container { position: absolute; inset: 0; pointer-events: none; z-index: 18; }
.search-hl {
  position: absolute; background: rgba(255, 200, 0, 0.4);
  border: 1px solid rgba(255, 160, 0, 0.7); border-radius: 1px;
}
.search-hl.current { background: rgba(255, 120, 0, 0.55); border-color: #ff6d00; box-shadow: 0 0 4px rgba(255,109,0,0.8); }
</style>
