<template>
  <div class="q-pa-sm">
    <div class="text-caption text-grey-5 q-mb-sm q-px-xs">Pages</div>
    <div
      v-for="page in docStore.totalPages"
      :key="page"
      class="thumbnail-item q-mb-sm cursor-pointer"
      :class="{ active: page === docStore.currentPage }"
      @click="docStore.setPage(page)"
    >
      <div class="thumbnail-placeholder">
        <span class="text-h6 text-grey-6">{{ page }}</span>
      </div>
      <div class="text-caption text-center text-grey-5 q-mt-xs">Page {{ page }}</div>
    </div>
    <div v-if="!docStore.loaded" class="text-caption text-grey-7 text-center q-mt-md">
      No document loaded
    </div>
  </div>
</template>

<script setup lang="ts">
import { useDocumentStore } from '@/stores/document'
const docStore = useDocumentStore()
</script>

<style scoped>
.thumbnail-item {
  border: 2px solid transparent;
  border-radius: 4px;
  padding: 4px;
  transition: border-color 0.2s;
}
.thumbnail-item.active {
  border-color: var(--q-primary);
}
.thumbnail-item:hover {
  border-color: rgba(255, 255, 255, 0.3);
}
.thumbnail-placeholder {
  width: 100%;
  aspect-ratio: 0.707;
  background: #3a3a3a;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
}
</style>
