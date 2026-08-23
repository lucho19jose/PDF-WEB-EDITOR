<template>
  <!--
    The page is exactly the height left over by the header and the footer, and
    it does not scroll: the viewer inside it does.

    Letting the WINDOW scroll instead is what a continuous document does by
    default, and it breaks the shell around it. The left drawer sizes itself to
    the layout, so on a forty-page document it became forty pages TALL — its
    thumbnails scrolled away with the paper and the panel could no longer show
    you where you were. Bounding the page keeps the drawer a screen high with a
    scroll of its own, which is what it was written against.
  -->
  <q-page class="flex flex-center" :style-fn="pageHeight" style="overflow: hidden">
    <!-- Welcome Screen -->
    <div v-if="!docStore.loaded" class="text-center text-grey-5">
      <q-icon name="picture_as_pdf" size="80px" color="grey-7" />
      <div class="text-h5 q-mt-lg">Welcome to PDF Editor Pro v2</div>
      <div class="text-body1 q-mt-sm text-grey-6">Open a PDF file to start editing</div>
      <!--
        The input is laid OVER the button so the click lands on it and the
        browser opens the chooser natively.

        Styled INLINE, not through a scoped class: a scoped stylesheet can go out
        of sync with its template across a hot reload, and if the overlay loses
        its positioning the input stops covering the button. The button then had
        nothing behind it and went dead until a full reload — which is exactly
        what "it breaks every time you make a change" was.

        `@click` is the belt to that braces. The two can never both fire: either
        the overlay is covering the button, so the click never reaches it, or it
        is not, and then the click is the only thing that opens the chooser.
      -->
      <span class="q-mt-lg" style="position:relative;display:inline-flex">
        <q-btn color="primary" icon="folder_open" label="Open PDF File" size="lg" @click="openViaInput" />
        <input ref="pickRef" type="file" accept="application/pdf,.pdf" style="position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;cursor:pointer;z-index:1" @change="onPicked" />
      </span>
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

/** Quasar hands us the space the header and footer already take. */
function pageHeight(offset: number) {
  return { height: offset ? `calc(100vh - ${offset}px)` : '100vh' }
}
const openPdfFile = inject<(f: File) => void>('openPdfFile', () => {})
const pickRef = ref<HTMLInputElement | null>(null)

/** Fallback for when the overlay is not covering the button. */
function openViaInput() {
  pickRef.value?.click()
}

function onPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''   // so the same document can be opened again
  if (file) openPdfFile(file)
}
const pdfViewerRef = ref<InstanceType<typeof PDFViewer> | null>(null)
</script>
