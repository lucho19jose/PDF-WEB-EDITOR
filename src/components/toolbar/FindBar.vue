<template>
  <transition name="slide-down">
    <div v-if="searchStore.open" class="find-bar row items-center no-wrap">
      <q-icon name="search" size="18px" class="q-mr-sm text-grey-5" />
      <input
        ref="inputRef"
        v-model="localQuery"
        class="find-input"
        placeholder="Find in document…"
        @keydown.enter.exact.prevent="onEnter"
        @keydown.enter.shift.prevent="searchPrev"
        @keydown.escape.prevent="close"
      />
      <span class="text-caption text-grey-5 q-mx-sm" style="min-width: 56px; text-align: center">
        <template v-if="searchStore.searching">…</template>
        <template v-else-if="searchStore.total">{{ searchStore.currentIndex + 1 }} / {{ searchStore.total }}</template>
        <template v-else-if="localQuery">0 / 0</template>
      </span>
      <q-btn flat dense round size="sm" icon="keyboard_arrow_up" :disable="!searchStore.total" @click="searchPrev">
        <q-tooltip>Previous (Shift+Enter)</q-tooltip>
      </q-btn>
      <q-btn flat dense round size="sm" icon="keyboard_arrow_down" :disable="!searchStore.total" @click="searchNext">
        <q-tooltip>Next (Enter)</q-tooltip>
      </q-btn>
      <q-separator vertical inset class="q-mx-xs" />
      <q-btn flat dense round size="sm" icon="close" @click="close"><q-tooltip>Close (Esc)</q-tooltip></q-btn>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, inject, watch, nextTick } from 'vue'
import { useSearchStore } from '@/stores/search'

const searchStore = useSearchStore()
const runSearch = inject<(q: string) => void>('runSearch', () => {})
const searchNext = inject<() => void>('searchNext', () => {})
const searchPrev = inject<() => void>('searchPrev', () => {})
const closeFind = inject<() => void>('closeFind', () => {})

const localQuery = ref(searchStore.query)
const inputRef = ref<HTMLInputElement | null>(null)

let debounce: ReturnType<typeof setTimeout> | null = null
watch(localQuery, (q) => {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => runSearch(q), 250)
})

watch(() => searchStore.open, (open) => {
  if (open) nextTick(() => { inputRef.value?.focus(); inputRef.value?.select() })
})

function onEnter() {
  if (searchStore.total > 0) searchNext()
  else runSearch(localQuery.value)
}
function close() {
  if (debounce) { clearTimeout(debounce); debounce = null }
  searchStore.open = false
  closeFind()
}
</script>

<style scoped>
.find-bar {
  position: absolute; top: 12px; right: 24px; z-index: 1000;
  background: #2d2d2d; border: 1px solid #444; border-radius: 8px;
  padding: 6px 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.5);
}
.find-input {
  background: transparent; border: none; outline: none; color: #eee;
  font-size: 13px; width: 200px;
}
.slide-down-enter-active, .slide-down-leave-active { transition: all 0.15s ease; }
.slide-down-enter-from, .slide-down-leave-to { opacity: 0; transform: translateY(-8px); }
</style>
