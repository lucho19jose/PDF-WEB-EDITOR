<template>
  <div class="acro-toolbar">
    <!-- File -->
    <div class="group">
      <button class="acro-ibtn" :disabled="!docStore.loaded" @click="shell.save()">
        <q-icon name="sym_o_save" /><q-tooltip>Guardar archivo (Ctrl+S)</q-tooltip>
      </button>
      <button class="acro-ibtn" :class="{ active: starred }" :disabled="!docStore.loaded" @click="toggleStar">
        <q-icon :name="starred ? 'star' : 'sym_o_star'" /><q-tooltip>{{ starred ? 'Quitar de destacados' : 'Destacar este archivo' }}</q-tooltip>
      </button>
      <button class="acro-ibtn" :disabled="!docStore.loaded" @click="shell.saveAs()">
        <q-icon name="sym_o_cloud_upload" /><q-tooltip>Guardar una copia como…</q-tooltip>
      </button>
      <button class="acro-ibtn" :disabled="!docStore.loaded" @click="shell.print()">
        <q-icon name="sym_o_print" /><q-tooltip>Imprimir archivo (Ctrl+P)</q-tooltip>
      </button>
      <button class="acro-ibtn" :disabled="!docStore.loaded" @click="share(true)">
        <q-icon name="sym_o_mail" /><q-tooltip>Enviar archivo por correo electrónico</q-tooltip>
      </button>
      <button class="acro-ibtn" :disabled="!docStore.loaded" @click="shell.find()">
        <q-icon name="sym_o_search" /><q-tooltip>Buscar texto (Ctrl+F)</q-tooltip>
      </button>
    </div>

    <q-space />

    <!-- Navigation, selection, zoom -->
    <div class="group center">
      <button class="acro-ibtn" :disabled="!docStore.loaded || docStore.currentPage <= 1" @click="docStore.setPage(docStore.currentPage - 1)">
        <q-icon name="sym_o_arrow_circle_up" /><q-tooltip>Mostrar página anterior</q-tooltip>
      </button>
      <button class="acro-ibtn" :disabled="!docStore.loaded || docStore.currentPage >= docStore.totalPages" @click="docStore.setPage(docStore.currentPage + 1)">
        <q-icon name="sym_o_arrow_circle_down" /><q-tooltip>Mostrar página siguiente</q-tooltip>
      </button>
      <div class="page-box" :class="{ disabled: !docStore.loaded }">
        <input
          v-model="pageInput" class="page-input acro-input underline" :disabled="!docStore.loaded"
          @keydown.enter="goPage" @blur="pageInput = String(docStore.currentPage)" @focus="($event.target as HTMLInputElement).select()"
        />
        <span class="page-total">/ {{ docStore.totalPages || 0 }}</span>
      </div>

      <div class="acro-vsep" />

      <button class="acro-ibtn" :class="{ active: editorStore.currentTool === 'select' }" :disabled="!docStore.loaded" @click="selectTool('select')">
        <q-icon name="sym_o_arrow_selector_tool" /><q-tooltip>Seleccionar texto, imágenes o anotaciones</q-tooltip>
      </button>
      <button class="acro-ibtn" :class="{ active: editorStore.currentTool === 'hand' }" :disabled="!docStore.loaded" @click="selectTool('hand')">
        <q-icon name="sym_o_pan_tool" /><q-tooltip>Desplazar páginas (barra espaciadora)</q-tooltip>
      </button>
      <button class="acro-ibtn" :disabled="!docStore.loaded" @click="shell.zoomOut()">
        <q-icon name="sym_o_do_not_disturb_on" /><q-tooltip>Alejar (Ctrl+-)</q-tooltip>
      </button>
      <button class="acro-ibtn" :disabled="!docStore.loaded" @click="shell.zoomIn()">
        <q-icon name="sym_o_add_circle" /><q-tooltip>Acercar (Ctrl++)</q-tooltip>
      </button>
      <div class="zoom-box" :class="{ disabled: !docStore.loaded }">
        <input
          v-model="zoomInput" class="zoom-input acro-input underline" :disabled="!docStore.loaded"
          @keydown.enter="applyZoomInput" @blur="zoomInput = zoomLabel" @focus="($event.target as HTMLInputElement).select()"
        />
        <button class="zoom-caret" :disabled="!docStore.loaded">
          <q-icon name="arrow_drop_down" size="20px" />
          <q-menu class="acro-menu" anchor="bottom right" self="top right" auto-close>
            <q-list dense style="min-width: 150px">
              <q-item v-for="z in [0.5, 0.75, 1, 1.25, 1.5, 2, 4]" :key="z" clickable @click="shell.setZoom(z)">
                <q-item-section avatar><q-icon v-if="Math.abs(docStore.scale - z) < 0.001" name="check" /></q-item-section>
                <q-item-section>{{ Math.round(z * 100) }} %</q-item-section>
              </q-item>
              <q-separator />
              <q-item clickable @click="shell.fitPage()"><q-item-section avatar /><q-item-section>Ajustar página</q-item-section></q-item>
              <q-item clickable @click="shell.fitWidth()"><q-item-section avatar /><q-item-section>Ajustar anchura</q-item-section></q-item>
              <q-item clickable @click="shell.setZoom(1)"><q-item-section avatar /><q-item-section>Tamaño real</q-item-section></q-item>
            </q-list>
          </q-menu>
        </button>
      </div>
      <button class="acro-ibtn" :disabled="!docStore.loaded">
        <q-icon name="sym_o_fit_page" class="blue" /><q-icon name="arrow_drop_down" class="caret" />
        <q-tooltip>Ajustar a la página y modo de desplazamiento</q-tooltip>
        <q-menu class="acro-menu" anchor="bottom left" self="top left" auto-close>
          <q-list dense style="min-width: 260px">
            <q-item clickable @click="shell.fitPage()"><q-item-section avatar><q-icon name="sym_o_fit_page" /></q-item-section><q-item-section>Ajustar página</q-item-section><q-item-section side class="shortcut">Ctrl+0</q-item-section></q-item>
            <q-item clickable @click="shell.fitWidth()"><q-item-section avatar><q-icon name="sym_o_fit_width" /></q-item-section><q-item-section>Ajustar anchura</q-item-section><q-item-section side class="shortcut">Ctrl+2</q-item-section></q-item>
            <q-separator />
            <q-item clickable @click="docStore.continuousScroll = false"><q-item-section avatar><q-icon :name="docStore.continuousScroll ? 'sym_o_crop_portrait' : 'check'" /></q-item-section><q-item-section>Vista de una sola página</q-item-section></q-item>
            <q-item clickable @click="docStore.continuousScroll = true"><q-item-section avatar><q-icon :name="docStore.continuousScroll ? 'check' : 'sym_o_view_day'" /></q-item-section><q-item-section>Habilitar desplazamiento</q-item-section></q-item>
          </q-list>
        </q-menu>
      </button>
      <button class="acro-ibtn" :class="{ active: ui.readMode }" :disabled="!docStore.loaded" @click="ui.readMode = !ui.readMode">
        <q-icon name="sym_o_chrome_reader_mode" /><q-tooltip>Modo de lectura (Ctrl+H)</q-tooltip>
      </button>

      <div class="acro-vsep" />

      <button class="acro-ibtn" :class="{ active: editorStore.currentTool === 'note' }" :disabled="!docStore.loaded" @click="quick('note')">
        <q-icon name="sym_o_chat" /><q-tooltip>Agregar un comentario de nota adhesiva</q-tooltip>
      </button>
      <button class="acro-ibtn" :class="{ active: editorStore.currentTool === 'highlight' }" :disabled="!docStore.loaded" @click="quick('highlight')">
        <q-icon name="sym_o_ink_highlighter" /><q-tooltip>Resaltar texto</q-tooltip>
      </button>
      <button class="acro-ibtn" :class="{ active: editorStore.currentTool === 'draw' }" :disabled="!docStore.loaded" @click="quick('draw')">
        <q-icon name="sym_o_draw" /><q-tooltip>Dibujar a mano alzada</q-tooltip>
      </button>
      <button class="acro-ibtn" :disabled="!docStore.loaded" @click="shell.openTool('fillsign')">
        <q-icon name="sym_o_signature" /><q-tooltip>Rellenar y firmar el documento</q-tooltip>
      </button>
    </div>

    <q-space />

    <div class="group right">
      <button class="acro-ibtn" :class="{ active: editorStore.assistantOpen }" @click="shell.toggleAssistant()">
        <q-icon name="sym_o_smart_toy" /><q-tooltip>Asistente: dígale qué cambiar y lo edita</q-tooltip>
      </button>
      <button class="acro-pill primary" :disabled="!docStore.loaded" @click="share(false)">
        <AcroIcon name="share" color="#fff" :size="18" />
        Compartir
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, inject } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore, type Tool } from '@/stores/editor'
import { useUiStore } from '@/stores/ui'
import { persistedRef } from '@/utils/persist'
import AcroIcon from './AcroIcon.vue'
import type { AcroShell } from './acroShell'
import type { usePDFEngine } from '@/composables/usePDFEngine'

const docStore = useDocumentStore()
const editorStore = useEditorStore()
const ui = useUiStore()
const shell = inject<AcroShell>('acroShell')!
const pdfEngine = inject<ReturnType<typeof usePDFEngine>>('pdfEngine')!
const bakeOcrEdits = inject<() => Promise<number>>('bakeOcrEdits', async () => 0)

const pageInput = ref('1')
watch(() => docStore.currentPage, p => { pageInput.value = String(p) }, { immediate: true })
function goPage() {
  const n = parseInt(pageInput.value, 10)
  if (Number.isFinite(n)) docStore.setPage(n)
  pageInput.value = String(docStore.currentPage)
}

const zoomLabel = computed(() => `${Math.round(docStore.scale * 100)}%`)
const zoomInput = ref(zoomLabel.value)
watch(zoomLabel, z => { zoomInput.value = z })
function applyZoomInput() {
  const n = parseFloat(zoomInput.value.replace(',', '.'))
  if (Number.isFinite(n) && n > 0) shell.setZoom(n / 100)
  zoomInput.value = zoomLabel.value
}

function selectTool(t: Tool) {
  editorStore.setTool(t)
}

/** Quick tools on the bar open the Comment tool around them, as Acrobat does. */
function quick(t: Tool) {
  if (ui.activeTool !== 'comment' && ui.activeTool !== 'edit') shell.openTool('comment')
  editorStore.setTool(editorStore.currentTool === t ? 'select' : t)
}

const starredFiles = persistedRef<string[]>('ui.starred', [])
const starred = computed(() => !!docStore.fileName && starredFiles.value.includes(docStore.fileName))
function toggleStar() {
  const n = docStore.fileName
  if (!n) return
  starredFiles.value = starred.value ? starredFiles.value.filter(f => f !== n) : [...starredFiles.value, n]
}

/**
 * "Compartir" / "Enviar por correo": the system share sheet with the PDF
 * attached where the browser has one (Windows and Android do), otherwise a
 * download plus a pre-addressed e-mail the user attaches the file to.
 */
async function share(email: boolean) {
  if (!docStore.loaded) return
  await bakeOcrEdits()
  const name = (docStore.fileName || 'documento.pdf').replace(/ \*$/, '')
  const bytes = await pdfEngine.saveDocument()
  const file = new File([bytes], name, { type: 'application/pdf' })
  const nav = navigator as any
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name })
      editorStore.setStatus(`${name} compartido`)
      return
    } catch (err: any) {
      if (err?.name === 'AbortError') return
    }
  }
  shell.commands.download(file, name)
  if (email) window.location.href = `mailto:?subject=${encodeURIComponent(name)}&body=${encodeURIComponent('Le adjunto el documento ' + name + '.')}`
  else editorStore.setStatus(`${name} descargado — adjúntelo donde quiera compartirlo`)
}
</script>

<style scoped>
.acro-toolbar {
  height: 46px; display: flex; align-items: center; background: var(--acro-bar); padding: 0 10px;
  border-bottom: 1px solid var(--acro-rule); gap: 2px; user-select: none;
}
.group { display: flex; align-items: center; gap: 4px; }
.group.right { gap: 10px; }
.page-box, .zoom-box { display: flex; align-items: center; gap: 6px; margin: 0 4px; color: #d8d8d8; }
.page-box.disabled, .zoom-box.disabled { opacity: 0.4; }
.page-input { width: 40px; text-align: center; height: 24px; }
.page-total { font-size: 13px; color: #cfcfcf; }
.zoom-box { gap: 0; }
.zoom-input { width: 54px; text-align: center; height: 24px; }
.zoom-caret { border: 0; background: transparent; color: #ccc; cursor: pointer; padding: 0; display: flex; }
.zoom-caret:hover { color: #fff; }
.blue { color: var(--acro-blue-text) !important; }
</style>
