<template>
  <q-page class="flex flex-center" style="overflow: auto">
    <!-- Welcome Screen -->
    <div v-if="!docStore.loaded" class="text-center text-grey-5">
      <q-icon name="picture_as_pdf" size="80px" color="grey-7" />
      <div class="text-h5 q-mt-lg">Welcome to PDF Editor Pro v2</div>
      <div class="text-body1 q-mt-sm text-grey-6">Open a PDF file to start editing</div>
      <q-btn color="primary" icon="folder_open" label="Open PDF File" class="q-mt-lg" size="lg" @click="openFile" />
      <div class="text-caption q-mt-md text-grey-7">or drag and drop a PDF here</div>
    </div>

    <!-- PDF Viewer -->
    <PDFViewer v-else ref="pdfViewerRef" />
  </q-page>
</template>

<script setup lang="ts">
import { ref, inject } from 'vue'
import { useDocumentStore } from '@/stores/document'
import PDFViewer from '@/components/viewer/PDFViewer.vue'

const docStore = useDocumentStore()
const openFile = inject<() => void>('openFile', () => {})
const pdfViewerRef = ref<InstanceType<typeof PDFViewer> | null>(null)
</script>
