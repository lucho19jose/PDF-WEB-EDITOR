<template>
  <!--
    The page is exactly the height left over by the header and the footer, and
    it does not scroll: the viewer inside it does.

    Letting the WINDOW scroll instead is what a continuous document does by
    default, and it breaks the shell around it. The side panes size themselves
    to the layout, so on a forty-page document they became forty pages TALL —
    the thumbnails scrolled away with the paper and the panel could no longer
    show you where you were. Bounding the page keeps every pane a screen high
    with a scroll of its own.
  -->
  <q-page :style-fn="pageHeight" class="acro-page" style="overflow: hidden">
    <HomeView v-if="ui.view === 'home'" />
    <ToolsView v-else-if="ui.view === 'tools'" />

    <!-- The document tab. Kept mounted across tab switches, so coming back
         from Herramientas finds the page and the scroll where they were. -->
    <div v-show="ui.view === 'document'" class="workspace">
      <template v-if="docStore.loaded">
        <AcroLeftPane v-if="!ui.readMode && ui.activeTool !== 'organize'" />
        <div class="center">
          <OrganizePages v-if="ui.activeTool === 'organize'" />
          <PDFViewer v-else ref="pdfViewerRef" :class="{ 'hand-tool': editorStore.currentTool === 'hand' }" />
        </div>
        <template v-if="!ui.readMode">
          <template v-if="ui.activeTool !== 'organize'">
            <button class="pane-handle" @click="ui.rightPaneOpen = !ui.rightPaneOpen">
              <q-icon name="arrow_right" size="20px" :class="{ flip: !ui.rightPaneOpen }" />
              <q-tooltip anchor="center left" self="center right">{{ ui.rightPaneOpen ? 'Ocultar el panel' : 'Mostrar el panel' }}</q-tooltip>
            </button>
            <div v-if="ui.rightPaneOpen" class="right-pane"><AcroRightPane /></div>
          </template>
          <AcroToolRail />
        </template>
      </template>

      <!-- No document: what the old welcome screen offered, in Acrobat's dress. -->
      <div v-else class="no-doc">
        <AcroIcon name="create" color="#ff7b82" :size="72" />
        <div class="t1">Abra un archivo PDF para empezar</div>
        <div class="t2">O arrástrelo y suéltelo aquí</div>
        <!--
          The input is laid OVER the button so the click lands on it and the
          browser opens the chooser natively; styled inline, with a click
          fallback (see CLAUDE.md, "The file input sits ON the button").
        -->
        <span style="position:relative;display:inline-flex">
          <button class="acro-pill primary" @click="openViaInput">Seleccionar un archivo</button>
          <input ref="pickRef" type="file" accept="application/pdf,.pdf" style="position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;cursor:pointer;z-index:1" @change="onPicked" />
        </span>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { ref, inject } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { useUiStore } from '@/stores/ui'
import PDFViewer from '@/components/viewer/PDFViewer.vue'
import HomeView from '@/components/acrobat/HomeView.vue'
import ToolsView from '@/components/acrobat/ToolsView.vue'
import OrganizePages from '@/components/acrobat/OrganizePages.vue'
import AcroLeftPane from '@/components/acrobat/AcroLeftPane.vue'
import AcroRightPane from '@/components/acrobat/AcroRightPane.vue'
import AcroToolRail from '@/components/acrobat/AcroToolRail.vue'
import AcroIcon from '@/components/acrobat/AcroIcon.vue'

const docStore = useDocumentStore()
const editorStore = useEditorStore()
const ui = useUiStore()

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

<style scoped>
.acro-page { background: var(--acro-canvas); }
.workspace { display: flex; height: 100%; width: 100%; }
.center { flex: 1; min-width: 0; height: 100%; position: relative; background: var(--acro-canvas); }
.center :deep(.pdf-viewer-container) { background: var(--acro-canvas) !important; }
.center :deep(.hand-tool), .center :deep(.hand-tool *) { cursor: grab !important; }
.pane-handle {
  width: 18px; flex: none; border: 0; background: var(--acro-pane); color: #c2c2c2; cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center; border-left: 1px solid var(--acro-rule);
}
.pane-handle:hover { color: #fff; background: #4a4a4a; }
.pane-handle .flip { transform: rotate(180deg); }
.right-pane { width: 340px; flex: none; height: 100%; border-left: 1px solid var(--acro-rule); }
.no-doc { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #d0d0d0; }
.no-doc .t1 { font-size: 20px; color: #fff; }
.no-doc .t2 { font-size: 13px; color: #a0a0a0; margin-bottom: 8px; }
</style>
