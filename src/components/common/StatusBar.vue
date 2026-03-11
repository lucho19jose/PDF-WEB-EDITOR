<template>
  <div class="row items-center full-height text-caption text-grey-5" style="font-size: 11px">
    <span>{{ editorStore.statusMessage }}</span>
    <q-space />
    <template v-if="docStore.loaded">
      <q-btn flat dense icon="chevron_left" size="xs" :disable="docStore.currentPage <= 1" @click="prevPage" />
      <span class="q-mx-xs">
        {{ docStore.currentPage }} / {{ docStore.totalPages }}
      </span>
      <q-btn flat dense icon="chevron_right" size="xs" :disable="docStore.currentPage >= docStore.totalPages" @click="nextPage" />
      <q-separator vertical inset class="q-mx-sm" />
      <span>{{ docStore.fileSizeFormatted }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'

const docStore = useDocumentStore()
const editorStore = useEditorStore()

function prevPage() {
  if (docStore.currentPage > 1) docStore.setPage(docStore.currentPage - 1)
}
function nextPage() {
  if (docStore.currentPage < docStore.totalPages) docStore.setPage(docStore.currentPage + 1)
}
</script>
