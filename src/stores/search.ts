import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SearchHit } from '@/engine/types'

export const useSearchStore = defineStore('search', () => {
  const open = ref(false)
  const query = ref('')
  const hits = ref<SearchHit[]>([])
  const currentIndex = ref(-1)
  const searching = ref(false)

  const total = computed(() => hits.value.length)
  const current = computed(() => (currentIndex.value >= 0 ? hits.value[currentIndex.value] : null))

  /** Hits located on a given 0-based page index. */
  function hitsOnPage(pageIndex: number): SearchHit[] {
    return hits.value.filter(h => h.pageIndex === pageIndex)
  }

  function setResults(results: SearchHit[]) {
    hits.value = results
    currentIndex.value = results.length > 0 ? 0 : -1
  }

  function clear() {
    hits.value = []
    currentIndex.value = -1
    query.value = ''
  }

  function next() {
    if (hits.value.length === 0) return
    currentIndex.value = (currentIndex.value + 1) % hits.value.length
  }

  function prev() {
    if (hits.value.length === 0) return
    currentIndex.value = (currentIndex.value - 1 + hits.value.length) % hits.value.length
  }

  return {
    open, query, hits, currentIndex, searching,
    total, current,
    hitsOnPage, setResults, clear, next, prev
  }
})
