<template>
  <div class="acro-rightpane">
    <!-- ═══════════ Editar PDF: Formato · Objetos · Documentos digitalizados ═══════════ -->
    <div v-if="ui.activeTool === 'edit' || ui.activeTool === 'ocr'" class="pane-scroll">
      <section>
        <h6>Formato</h6>
        <template v-if="editorStore.ocrMode && ocrStore.selected">
          <!-- A recognised run of a scanned page is styled here, as text is. -->
          <div class="row-line">
            <select class="acro-input grow" :value="ocrStore.selected.fontFamily" @change="patchOcr({ fontFamily: ($event.target as HTMLSelectElement).value })">
              <option v-for="f in families" :key="f" :value="f">{{ f }}</option>
            </select>
          </div>
          <div class="row-line">
            <input class="acro-input size" type="number" min="4" max="200" :value="ocrStore.selected.fontSize" @change="patchOcr({ fontSize: Number(($event.target as HTMLInputElement).value) || 4 })" />
            <ColorSwatch :model-value="ocrHex" @update:model-value="(v: string) => patchOcr({ color: hexToRgb01(v) })" />
          </div>
          <div class="row-line">
            <button class="fmt-btn" :class="{ on: ocrStore.selected.bold }" title="Negrita" @click="patchOcr({ bold: !ocrStore.selected!.bold })"><b>T</b></button>
            <button class="fmt-btn" :class="{ on: ocrStore.selected.italic }" title="Cursiva" @click="patchOcr({ italic: !ocrStore.selected!.italic })"><i>T</i></button>
            <span class="gap" />
            <button v-for="a in aligns" :key="a.v" class="fmt-btn" :class="{ on: ocrStore.selected.align === a.v }" :title="a.label" @click="patchOcr({ align: a.v })"><q-icon :name="a.icon" size="20px" /></button>
          </div>
          <div class="row-line">
            <button class="link-btn" @click="ocrStore.revertItem(ocrStore.selected!.id)"><q-icon name="restart_alt" size="16px" /> Volver al texto reconocido</button>
            <button class="link-btn danger" @click="ocrStore.removeItem(ocrStore.selected!.id)"><q-icon name="delete" size="16px" /> Eliminar</button>
          </div>
        </template>
        <template v-else>
          <div class="row-line">
            <select v-model="family" class="acro-input grow" title="Fuente">
              <option v-for="f in families" :key="f" :value="f">{{ f }}</option>
            </select>
          </div>
          <div class="row-line">
            <select v-model.number="editorStore.fontSize" class="acro-input size" title="Tamaño de fuente">
              <option v-for="s in sizeOptions" :key="s" :value="s">{{ s }}</option>
            </select>
            <ColorSwatch v-model="editorStore.textColor" />
            <q-tooltip>Tamaño y color del texto seleccionado</q-tooltip>
          </div>
          <div class="row-line">
            <button class="fmt-btn" :class="{ on: bold }" title="Negrita" @click="bold = !bold"><span class="t b">T</span></button>
            <button class="fmt-btn" :class="{ on: italic }" title="Cursiva" @click="italic = !italic"><span class="t i">T</span></button>
            <button class="fmt-btn" disabled title="Subrayado"><span class="t u">T</span></button>
            <button class="fmt-btn" disabled title="Superíndice"><span class="t">T<sup>1</sup></span></button>
            <button class="fmt-btn" disabled title="Subíndice"><span class="t">T<sub>1</sub></span></button>
          </div>
          <div class="row-line">
            <button v-for="a in aligns" :key="a.v" class="fmt-btn" disabled :title="a.label"><q-icon :name="a.icon" size="20px" /></button>
          </div>
          <label class="acro-check small-gap">
            <input v-model="editorStore.reflowOnEdit" type="checkbox" />
            Redistribuir el texto (mover el resto de la página)
          </label>
        </template>
      </section>

      <section>
        <h6>Objetos</h6>
        <div class="row-line">
          <button class="fmt-btn" :disabled="!imgSel" title="Voltear verticalmente" @click="objectAction('flip-v')"><q-icon name="sym_o_flip" size="20px" style="transform: rotate(90deg)" /></button>
          <button class="fmt-btn" :disabled="!imgSel" title="Voltear horizontalmente" @click="objectAction('flip-h')"><q-icon name="sym_o_flip" size="20px" /></button>
          <button class="fmt-btn" :disabled="!imgSel" title="Recortar imagen" @click="objectAction('crop')"><q-icon name="sym_o_crop" size="20px" /></button>
          <button class="fmt-btn" :disabled="!imgSel" title="Alinear objetos">
            <q-icon name="sym_o_align_horizontal_left" size="20px" /><q-icon name="arrow_drop_down" size="14px" />
            <q-menu class="acro-menu" auto-close>
              <q-list dense>
                <q-item v-for="a in alignMenu" :key="a.v" clickable @click="objectAction(a.v)"><q-item-section avatar><q-icon :name="a.icon" /></q-item-section><q-item-section>{{ a.label }}</q-item-section></q-item>
              </q-list>
            </q-menu>
          </button>
        </div>
        <div class="row-line">
          <button class="fmt-btn" :disabled="!objSel" title="Girar a la izquierda" @click="objectAction('rotate-ccw')"><q-icon name="sym_o_rotate_left" size="20px" /></button>
          <button class="fmt-btn" :disabled="!objSel" title="Girar a la derecha" @click="objectAction('rotate-cw')"><q-icon name="sym_o_rotate_right" size="20px" /></button>
          <button class="fmt-btn" :disabled="!imgSel" title="Reemplazar imagen" @click="objectAction('replace')"><q-icon name="sym_o_imagesmode" size="20px" /></button>
          <button class="fmt-btn" :disabled="!imgSel" title="Organizar objetos">
            <q-icon name="sym_o_flip_to_front" size="20px" /><q-icon name="arrow_drop_down" size="14px" />
            <q-menu class="acro-menu" auto-close>
              <q-list dense>
                <q-item clickable @click="objectAction('front')"><q-item-section avatar><q-icon name="sym_o_flip_to_front" /></q-item-section><q-item-section>Traer al frente</q-item-section></q-item>
                <q-item clickable @click="objectAction('back')"><q-item-section avatar><q-icon name="sym_o_flip_to_back" /></q-item-section><q-item-section>Enviar al fondo</q-item-section></q-item>
              </q-list>
            </q-menu>
          </button>
          <button class="fmt-btn" :disabled="!objSel" title="Eliminar objeto" @click="objectAction('delete')"><q-icon name="sym_o_delete" size="20px" /></button>
        </div>
        <div class="edit-using"><q-icon name="sym_o_edit" size="16px" /> Editar usando... <q-space /><q-icon name="arrow_drop_down" size="16px" /></div>
      </section>

      <section>
        <h6>Documentos digitalizados</h6>
        <button class="link-btn plain" @click="ocrSettingsOpen = true"><q-icon name="settings" size="18px" /> Configuración</button>
        <label class="acro-check">
          <input type="checkbox" :checked="ocrStore.layerVisible" @change="toggleRecognise(($event.target as HTMLInputElement).checked)" />
          Reconocer texto
        </label>
      </section>

      <section class="last">
        <label class="acro-check"><input v-model="ui.showBoundingBoxes" type="checkbox" /> Mostrar cuadros delimitadores</label>
        <label class="acro-check"><input type="checkbox" :checked="!!ui.protection?.ownerPassword" @click.prevent="ui.openDialog('protect', { restrict: true })" /> Restringir la edición</label>
      </section>
      <OcrSettingsDialog v-model="ocrSettingsOpen" />
    </div>

    <!-- ═══════════ Comentar: the comment list ═══════════ -->
    <div v-else-if="ui.activeTool === 'comment'" class="pane-scroll">
      <div class="comments-head">
        <span>Comentarios ({{ comments.length }})</span>
        <q-space />
        <button class="acro-ibtn small" title="Actualizar" @click="loadComments"><q-icon name="sym_o_refresh" /></button>
      </div>
      <input v-model="commentFilter" class="acro-input search" placeholder="Buscar en los comentarios" />
      <div v-if="loadingComments" class="empty"><q-spinner size="20px" /></div>
      <div v-else-if="!filteredComments.length" class="empty">
        <q-icon name="sym_o_chat" size="40px" />
        <div>{{ comments.length ? 'Ningún comentario coincide' : 'Este documento no tiene comentarios.' }}</div>
        <div class="faint">Agregue uno con las herramientas de la barra superior.</div>
      </div>
      <div
        v-for="c in filteredComments" :key="c.page + ':' + c.index"
        class="comment-card" :class="{ current: c.page === docStore.currentPage - 1 }"
        @click="docStore.setPage(c.page + 1)"
      >
        <div class="c-head">
          <span class="c-dot" :style="{ background: c.color }" />
          <span class="c-type">{{ c.label }}</span>
          <q-space />
          <span class="c-page">Página {{ c.page + 1 }}</span>
        </div>
        <div v-if="c.author" class="c-author">{{ c.author }}</div>
        <div v-if="c.contents" class="c-text">{{ c.contents }}</div>
      </div>
    </div>

    <!-- ═══════════ No tool: Acrobat's list of tools ═══════════ -->
    <div v-else class="pane-scroll tool-list">
      <button v-for="t in listTools" :key="t.id" class="tool-row" @click="shell.openTool(t.id)">
        <AcroIcon :name="t.icon" :color="t.color" :size="22" />
        <span>{{ t.label }}</span>
      </button>
      <div class="acro-hsep" />
      <button class="tool-row" @click="ui.view = 'tools'">
        <AcroIcon name="moretools" color="#d0d0d0" :size="22" />
        <span>Más herramientas</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { useUiStore, ACRO_TOOLS } from '@/stores/ui'
import { useOcrStore } from '@/stores/ocr'
import { hexToRgb01, rgb01ToHex } from '@/utils/color'
import { objectSelection, objectAction, type ObjectAction } from '@/utils/acro/objectBus'
import { OCR_DEFAULT_LANG } from '@/composables/useOCR'
import ColorSwatch from '@/components/toolbar/ColorSwatch.vue'
import OcrSettingsDialog from '@/components/dialogs/OcrSettingsDialog.vue'
import AcroIcon from './AcroIcon.vue'
import type { AcroShell } from './acroShell'
import type { usePDFEngine } from '@/composables/usePDFEngine'

const docStore = useDocumentStore()
const editorStore = useEditorStore()
const ui = useUiStore()
const ocrStore = useOcrStore()
const shell = inject<AcroShell>('acroShell')!
const pdfEngine = inject<ReturnType<typeof usePDFEngine>>('pdfEngine')!
const runOcrOnPage = inject<(lang: string) => Promise<void>>('runOcrOnPage', async () => {})

// ── Formato ──
/**
 * The engine restyles into the base-14 faces (a family change re-encodes the
 * run as WinAnsi in a standard font), so those are what the list offers.
 */
const families = ['Helvetica', 'Times-Roman', 'Courier']
const sizeOptions = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 72]
const STYLE = /-(Bold|Oblique|Italic|BoldOblique|BoldItalic)$/

/** "Times-BoldItalic" → its family, and whether it is bold / italic. */
function split(name: string) {
  const fam = name.replace(STYLE, '').replace(/^Times$/, 'Times-Roman')
  const base = families.includes(fam) ? fam : 'Helvetica'
  return { base, bold: /Bold/.test(name), italic: /Italic|Oblique/.test(name) }
}
function join(base: string, bold: boolean, italic: boolean): string {
  if (!bold && !italic) return base
  const root = base === 'Times-Roman' ? 'Times' : base
  const slant = base === 'Times-Roman' ? 'Italic' : 'Oblique'
  return `${root}-${bold ? 'Bold' : ''}${italic ? slant : ''}`
}
const family = computed({
  get: () => split(editorStore.fontFamily).base,
  set: (v: string) => { const s = split(editorStore.fontFamily); editorStore.fontFamily = join(v, s.bold, s.italic) }
})
const bold = computed({
  get: () => split(editorStore.fontFamily).bold,
  set: (v: boolean) => { const s = split(editorStore.fontFamily); editorStore.fontFamily = join(s.base, v, s.italic) }
})
const italic = computed({
  get: () => split(editorStore.fontFamily).italic,
  set: (v: boolean) => { const s = split(editorStore.fontFamily); editorStore.fontFamily = join(s.base, s.bold, v) }
})
const aligns = [
  { v: 'left', icon: 'format_align_left', label: 'Alinear a la izquierda' },
  { v: 'center', icon: 'format_align_center', label: 'Centrar' },
  { v: 'right', icon: 'format_align_right', label: 'Alinear a la derecha' }
] as const

const ocrHex = computed(() => rgb01ToHex(ocrStore.selected?.color ?? [0, 0, 0]))
function patchOcr(patch: Record<string, unknown>) {
  const id = ocrStore.selectedId
  if (id) ocrStore.updateItem(id, patch as any)
}

// ── Objetos ──
const objSel = computed(() => !!objectSelection.value)
const imgSel = computed(() => objectSelection.value?.kind === 'content-image')
const alignMenu: { v: ObjectAction; icon: string; label: string }[] = [
  { v: 'align-left', icon: 'sym_o_align_horizontal_left', label: 'Alinear a la izquierda' },
  { v: 'align-center', icon: 'sym_o_align_horizontal_center', label: 'Centrar horizontalmente' },
  { v: 'align-right', icon: 'sym_o_align_horizontal_right', label: 'Alinear a la derecha' },
  { v: 'align-top', icon: 'sym_o_align_vertical_top', label: 'Alinear arriba' },
  { v: 'align-middle', icon: 'sym_o_align_vertical_center', label: 'Centrar verticalmente' },
  { v: 'align-bottom', icon: 'sym_o_align_vertical_bottom', label: 'Alinear abajo' }
]

// ── Documentos digitalizados ──
const ocrSettingsOpen = ref(false)
function toggleRecognise(on: boolean) {
  if (on && !ocrStore.itemsFor(docStore.currentPage - 1).length) runOcrOnPage(OCR_DEFAULT_LANG)
  ocrStore.layerVisible = on
}

// ── Comentarios ──
const TYPE_LABEL: Record<string, string> = {
  Text: 'Nota adhesiva', FreeText: 'Cuadro de texto', Highlight: 'Resaltado', Underline: 'Subrayado',
  StrikeOut: 'Tachado', Square: 'Rectángulo', Circle: 'Óvalo', Line: 'Línea', Ink: 'Lápiz',
  Stamp: 'Sello', Redact: 'Redacción', Squiggly: 'Subrayado ondulado', Polygon: 'Polígono', PolyLine: 'Polilínea'
}
const comments = ref<{ page: number; index: number; label: string; contents: string; author: string; color: string }[]>([])
const loadingComments = ref(false)
const commentFilter = ref('')
const filteredComments = computed(() => {
  const q = commentFilter.value.trim().toLowerCase()
  return q ? comments.value.filter(c => `${c.label} ${c.contents} ${c.author}`.toLowerCase().includes(q)) : comments.value
})
let loadSeq = 0
async function loadComments() {
  if (!docStore.loaded) { comments.value = []; return }
  const seq = ++loadSeq
  loadingComments.value = !comments.value.length
  const out: typeof comments.value = []
  for (let p = 0; p < docStore.totalPages; p++) {
    const list = await pdfEngine.getAnnotations(p).catch(() => [])
    if (seq !== loadSeq) return
    for (const a of list) {
      if (a.type === 'Widget' || a.type === 'Link' || a.type === 'Popup') continue
      out.push({ page: p, index: a.index, label: TYPE_LABEL[a.type] ?? a.type, contents: a.contents || '', author: a.author || '', color: rgb01ToHex(a.color?.length ? a.color : [1, 0.85, 0]) })
    }
  }
  comments.value = out
  loadingComments.value = false
}
let commentTimer: ReturnType<typeof setTimeout> | null = null
watch(() => [ui.activeTool, docStore.renderVersion] as const, ([t]) => {
  if (t !== 'comment') return
  if (commentTimer) clearTimeout(commentTimer)
  commentTimer = setTimeout(loadComments, 400)
}, { immediate: true })

// ── Tool list ──
const listTools = computed(() => ACRO_TOOLS.filter(t => ['create', 'combine', 'edit', 'export', 'organize', 'comment', 'fillsign', 'ocr', 'protect', 'redact', 'stamp'].includes(t.id)))
</script>

<style scoped>
.acro-rightpane { width: 100%; height: 100%; background: var(--acro-panel); color: var(--acro-text); display: flex; flex-direction: column; }
.pane-scroll { flex: 1; overflow-y: auto; padding: 8px 14px 20px; }
section { border-bottom: 1px solid #5c5c5c; padding: 10px 0 14px; }
section.last { border-bottom: 0; display: flex; flex-direction: column; gap: 10px; }
h6 { margin: 8px 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; color: #f0f0f0; line-height: 1; }
.row-line { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.grow { flex: 1; }
.size { width: 72px; }
.gap { width: 10px; }
.fmt-btn {
  display: inline-flex; align-items: center; justify-content: center; min-width: 32px; height: 30px; padding: 0 4px;
  border: 0; border-radius: 3px; background: transparent; color: #d4d4d4; cursor: pointer; font: inherit;
}
.fmt-btn:hover:not(:disabled) { background: var(--acro-hover); }
.fmt-btn.on { background: #6a6a6a; color: #fff; }
.fmt-btn:disabled { opacity: 0.35; cursor: default; }
.t { font-family: 'Times New Roman', serif; font-size: 20px; line-height: 1; }
.t.b { font-weight: 700; }
.t.i { font-style: italic; }
.t.u { text-decoration: underline; }
.t sup, .t sub { font-size: 10px; }
.edit-using { display: flex; align-items: center; gap: 6px; color: #8f8f8f; font-size: 13px; border-bottom: 1px solid #6a6a6a; padding: 4px 0; margin-top: 2px; }
.link-btn { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; color: #4b9cf5; cursor: pointer; font: inherit; font-size: 13px; padding: 2px 0; }
.link-btn.plain { color: #e6e6e6; margin-bottom: 10px; display: flex; }
.link-btn.danger { color: #ff8a8a; margin-left: 12px; }
.small-gap { font-size: 12px; color: #c8c8c8; }

.comments-head { display: flex; align-items: center; font-weight: 700; font-size: 14px; padding: 6px 0 8px; }
.search { width: 100%; height: 28px; margin-bottom: 10px; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; color: #bdbdbd; padding: 30px 10px; text-align: center; }
.faint { color: #8a8a8a; font-size: 12px; }
.comment-card { background: #3d3d3d; border: 1px solid #555; border-radius: 4px; padding: 8px 10px; margin-bottom: 8px; cursor: pointer; }
.comment-card:hover { border-color: #888; }
.comment-card.current { border-color: var(--acro-blue); }
.c-head { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.c-dot { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.c-type { font-weight: 700; color: #f0f0f0; }
.c-page { color: #9a9a9a; }
.c-author { color: #b8b8b8; font-size: 12px; margin-top: 4px; }
.c-text { margin-top: 6px; font-size: 13px; color: #e8e8e8; white-space: pre-wrap; word-break: break-word; }

.tool-list { padding: 18px 10px; }
.tool-row {
  display: flex; align-items: center; gap: 12px; width: 100%; height: 46px; padding: 0 14px; border: 0; border-radius: 4px;
  background: transparent; color: #ececec; font: inherit; font-size: 15px; cursor: pointer; text-align: left;
}
.tool-row:hover { background: var(--acro-hover); }
</style>
