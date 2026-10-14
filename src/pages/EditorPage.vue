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
          <!-- Hidden, never unmounted, while Organizar páginas is open: a
               double-click on a page there sets the page and closes the tool
               in one go, and a viewer built afresh at that moment missed the
               page change and opened at page 1. Kept alive it scrolls to the
               page like any other page change, and its rendered pages and
               scroll position survive the trip. -->
          <PDFViewer v-show="ui.activeTool !== 'organize'" ref="pdfViewerRef" :hidden="ui.activeTool === 'organize'" :class="{ 'hand-tool': editorStore.currentTool === 'hand' }" />
          <!-- Acrobat's conversion toast: bottom right of the document, a bar
               and one line saying which page is being made editable. -->
          <div v-if="ui.scanConversion && !ui.scanConversion.hidden" class="scan-toast" role="status">
            <div class="scan-toast-bar"><div class="scan-toast-fill" :style="{ width: ui.scanConversion.pct + '%' }" /></div>
            <button class="scan-toast-close" title="Cerrar" @click="ui.scanConversion.hidden = true"><q-icon name="close" size="18px" /></button>
            <div class="scan-toast-text">Página {{ ui.scanConversion.page }}: Conversión de la página digitalizada en texto e imágenes editables</div>
          </div>
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
      <div v-else class="no-doc" :class="{ 'tool-wait': !!ui.toolMeta?.headline }">
        <!-- A tool opened before a document: Acrobat's headline for it, then the button. -->
        <template v-if="ui.toolMeta?.headline">
          <div class="headline">{{ ui.toolMeta.headline }}</div>
        </template>
        <template v-else>
          <AcroIcon name="create" color="#e34850" :size="72" />
          <div class="t1">Abra un archivo PDF para empezar</div>
          <div class="t2">O arrástrelo y suéltelo aquí</div>
        </template>
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
.scan-toast {
  position: absolute; right: 20px; bottom: 20px; z-index: 40; width: 540px; max-width: calc(100% - 40px);
  background: #1e1e1e; color: #fff; border-radius: 2px; padding: 22px 52px 16px 20px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3); font-size: 13px; font-weight: 700;
}
.scan-toast-bar { height: 4px; background: #4a4a4a; border-radius: 2px; overflow: hidden; margin-bottom: 18px; }
.scan-toast-fill { height: 100%; background: var(--acro-blue); transition: width 0.4s ease; }
.scan-toast-close {
  position: absolute; top: 12px; right: 12px; border: 0; background: transparent; color: #c8c8c8;
  cursor: pointer; padding: 2px; display: flex; border-radius: 2px;
}
.scan-toast-close:hover { color: #fff; background: #3a3a3a; }
.center { flex: 1; min-width: 0; height: 100%; position: relative; background: var(--acro-canvas); }
.center :deep(.pdf-viewer-container) { background: var(--acro-canvas) !important; }
.center :deep(.hand-tool), .center :deep(.hand-tool *) { cursor: grab !important; }
.pane-handle {
  width: 18px; flex: none; border: 0; background: var(--acro-pane); color: var(--acro-text-dim); cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center; border-left: 1px solid var(--acro-rule);
}
.pane-handle:hover { color: var(--acro-text-strong); background: var(--acro-hover); }
.pane-handle .flip { transform: rotate(180deg); }
.right-pane { width: 340px; flex: none; height: 100%; border-left: 1px solid var(--acro-rule); }
.no-doc { flex: 1; background: var(--acro-pane); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--acro-text); }
.no-doc.tool-wait { justify-content: flex-start; padding-top: 110px; gap: 40px; }
.no-doc .headline { font-size: 27px; font-weight: 400; color: var(--acro-text); text-align: center; padding: 0 20px; }
.no-doc .t1 { font-size: 20px; color: var(--acro-text-strong); }
.no-doc .t2 { font-size: 13px; color: var(--acro-text-dim); margin-bottom: 8px; }
</style>
