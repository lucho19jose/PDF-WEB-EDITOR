<template>
  <div class="row items-center full-height text-caption text-grey-5" style="font-size: 11px">
    <span>{{ editorStore.statusMessage }}</span>
    <!--
      The moment to ask for a failing document is the moment the edit failed:
      every engine fix so far began with one real PDF someone could not edit.
      The button shows only on a refusal, next to the line explaining it, and
      opens a pre-filled email — the user attaches the file, nothing from the
      document's content leaves the browser on its own.
    -->
    <q-btn
      v-if="showReport"
      flat dense no-caps size="xs" color="amber-4" icon="mail" label="Report this document"
      class="q-ml-sm" :href="reportHref" target="_blank"
    >
      <q-tooltip>Send this file to {{ SUPPORT_EMAIL }} so the problem can be fixed</q-tooltip>
    </q-btn>
    <q-space />
    <q-btn flat dense round size="xs" icon="help_outline" :href="reportHref" target="_blank" class="q-mr-sm">
      <q-tooltip>Report a problem — {{ SUPPORT_EMAIL }}</q-tooltip>
    </q-btn>
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
import { computed } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { SUPPORT_EMAIL, isRefusal, buildReportMailto } from '@/utils/reportProblem'

const docStore = useDocumentStore()
const editorStore = useEditorStore()

const showReport = computed(() => docStore.loaded && isRefusal(editorStore.statusMessage))
const reportHref = computed(() => buildReportMailto({
  status: editorStore.statusMessage,
  fileName: docStore.fileName,
  page: docStore.currentPage,
  pages: docStore.totalPages
}))

function prevPage() {
  if (docStore.currentPage > 1) docStore.setPage(docStore.currentPage - 1)
}
function nextPage() {
  if (docStore.currentPage < docStore.totalPages) docStore.setPage(docStore.currentPage + 1)
}
</script>
