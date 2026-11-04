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
            <button class="fmt-btn" @mousedown.prevent :class="{ on: bold }" title="Negrita" @click="bold = !bold"><span class="t b">T</span></button>
            <button class="fmt-btn" @mousedown.prevent :class="{ on: italic }" title="Cursiva" @click="italic = !italic"><span class="t i">T</span></button>
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

      <!-- Agregar imagen: where the next picture goes and how wide it is. -->
      <section v-if="editorStore.currentTool === 'image'">
        <h6>Imagen</h6>
        <div class="row-line">
          <span class="lbl">Colocar</span>
          <select v-model="editorStore.imagePlacement" class="acro-input grow">
            <option value="below">Debajo de la línea</option>
            <option value="above">Encima de la línea</option>
          </select>
        </div>
        <div class="row-line">
          <span class="lbl">Ajuste</span>
          <select v-model="editorStore.imageWrap" class="acro-input grow">
            <option value="inline">En línea con el texto</option>
            <option value="front">Delante del texto</option>
            <option value="behind">Detrás del texto</option>
          </select>
        </div>
        <div class="row-line">
          <span class="lbl">Ancho</span>
          <input v-model.number="editorStore.imageWidthPct" type="range" min="10" max="100" step="5" class="grow" />
          <span class="lbl">{{ editorStore.imageWidthPct }}%</span>
        </div>
        <div class="faint">Haga clic en una línea de la página para colocar la imagen.</div>
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
          <input type="checkbox" :checked="ui.autoRecognize" @change="toggleRecognise(($event.target as HTMLInputElement).checked)" />
          Reconocer texto
        </label>
      </section>

      <section class="last">
        <label class="acro-check"><input v-model="ui.showBoundingBoxes" type="checkbox" /> Mostrar cuadros delimitadores</label>
        <label class="acro-check"><input type="checkbox" :checked="!!ui.protection?.ownerPassword" @click.prevent="ui.openDialog('protect', { restrict: true })" /> Restringir la edición</label>
      </section>
      <OcrSettingsDialog v-model="ocrSettingsOpen" />
    </div>

    <!-- ═══════════ Comentar: the comment list, as Acrobat's ═══════════ -->
    <div v-else-if="ui.activeTool === 'comment'" ref="commentsRef" class="pane-scroll comments-pane">
      <div class="comments-head">
        <span>{{ countLabel }}</span>
        <q-space />
        <button class="acro-ibtn small" :class="{ active: searchOpen }" title="Buscar en los comentarios" @click="toggleSearch"><q-icon name="sym_o_search" /></button>
        <button class="acro-ibtn small" title="Actualizar" @click="loadComments"><q-icon name="sym_o_refresh" /></button>
        <button class="acro-ibtn small" title="Más opciones">
          <q-icon name="sym_o_more_horiz" />
          <q-menu class="acro-menu" anchor="bottom right" self="top right" auto-close>
            <q-list dense style="min-width: 220px">
              <q-item clickable @click="askAuthor"><q-item-section avatar><q-icon name="sym_o_person" /></q-item-section><q-item-section>Nombre del autor…</q-item-section></q-item>
            </q-list>
          </q-menu>
        </button>
      </div>
      <input v-if="searchOpen || commentFilter" ref="searchRef" v-model="commentFilter" class="acro-input search" placeholder="Buscar en los comentarios" @keydown.esc="commentFilter = ''; searchOpen = false" />

      <!-- The sticky note just placed: written here, published with Publicar. -->
      <div v-if="noteDraft" class="comment-card draft current">
        <div class="c-head">
          <span class="c-avatar note"><NoteIcon :color="draftHex" size="16" /></span>
          <input v-model="ui.authorName" class="c-author-input" placeholder="Su nombre" title="Su nombre, como autor de los comentarios" @keydown.enter.prevent="draftRef?.focus()" />
          <span class="c-time">{{ timeLabel(Date.now()) }}</span>
        </div>
        <textarea
          ref="draftRef" v-model="noteDraft.text" class="c-edit" rows="3" placeholder="Agregar un comentario..."
          @focus="draftFocusId = noteDraft?.id ?? 0" @blur="onDraftBlur"
          @keydown.ctrl.enter.prevent="publishDraft" @keydown.meta.enter.prevent="publishDraft" @keydown.esc.prevent="discardDraft"
        />
        <div class="c-actions">
          <button class="pill ghost" @mousedown.prevent @click="discardDraft">Cancelar</button>
          <button class="pill primary" :disabled="!noteDraft.text.trim()" @mousedown.prevent @click="publishDraft">Publicar</button>
        </div>
      </div>

      <div v-if="loadingComments && !comments.length" class="empty"><q-spinner size="20px" /></div>
      <div v-else-if="!filteredComments.length && !noteDraft" class="empty">
        <q-icon name="sym_o_chat" size="40px" />
        <div>{{ comments.length ? 'Ningún comentario coincide' : 'Este documento no tiene comentarios.' }}</div>
        <div class="faint">Agregue uno con las herramientas de la barra superior.</div>
      </div>
      <template v-for="g in commentGroups" :key="g.page">
        <div class="page-head" @click="docStore.setPage(g.page + 1)">
          <span>PÁGINA {{ g.page + 1 }}</span><q-space /><span>{{ g.items.length }}</span>
        </div>
        <div
          v-for="c in g.items" :key="keyOf(c)" :data-comment="keyOf(c)"
          class="comment-card" :class="{ current: isFocused(c) }"
          @click="pickComment(c)" @dblclick="startEdit(c)"
        >
          <div class="c-head">
            <span v-if="c.type === 'Text'" class="c-avatar note"><NoteIcon :color="c.color" size="16" /></span>
            <span v-else class="c-avatar"><q-icon :name="c.icon" size="15px" /></span>
            <span class="c-author">{{ c.author || c.label }}</span>
            <span class="c-time">{{ timeLabel(c.modified) }}</span>
            <q-space />
            <button class="c-more" title="Más opciones" @click.stop>
              <q-icon name="sym_o_more_horiz" size="18px" />
              <q-menu class="acro-menu" anchor="bottom right" self="top right" auto-close>
                <q-list dense style="min-width: 160px">
                  <q-item v-if="c.type === 'Text' || c.type === 'FreeText'" clickable @click="startEdit(c)"><q-item-section avatar><q-icon name="sym_o_edit" /></q-item-section><q-item-section>Editar</q-item-section></q-item>
                  <q-item clickable @click="deleteComment(c)"><q-item-section avatar><q-icon name="sym_o_delete" /></q-item-section><q-item-section>Eliminar</q-item-section></q-item>
                </q-list>
              </q-menu>
            </button>
          </div>
          <template v-if="editingKey === keyOf(c)">
            <textarea
              ref="editRef" v-model="editText" class="c-edit" rows="3" @click.stop @dblclick.stop
              @keydown.ctrl.enter.prevent="saveEdit(c)" @keydown.meta.enter.prevent="saveEdit(c)" @keydown.esc.prevent="editingKey = ''"
            />
            <div class="c-actions" @click.stop>
              <button class="pill ghost" @mousedown.prevent @click="editingKey = ''">Cancelar</button>
              <button class="pill primary" @mousedown.prevent @click="saveEdit(c)">Guardar</button>
            </div>
          </template>
          <div v-else-if="c.contents" class="c-text">{{ c.contents }}</div>
          <div v-else-if="c.author" class="c-kind"><q-icon :name="c.icon" size="15px" /> {{ c.label }}</div>
        </div>
      </template>
    </div>

    <!-- ═══════════ No tool: Acrobat's list of tools ═══════════ -->
    <div v-else class="pane-scroll tool-list">
      <button v-for="t in listTools" :key="t.id" class="tool-row" @click="shell.openTool(t.id)">
        <AcroIcon :name="t.icon" :color="t.color" :size="22" />
        <span>{{ t.label }}</span>
      </button>
      <div class="acro-hsep" />
      <button class="tool-row" @click="ui.view = 'tools'">
        <AcroIcon name="moretools" color="#4b4b4b" :size="22" />
        <span>Más herramientas</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { useUiStore, ACRO_TOOLS } from '@/stores/ui'
import { useOcrStore } from '@/stores/ocr'
import {
  noteDraft, focusedComment, selectOnPage, editFreeText, editNoteText, answered, request,
  setNotePublisher, settleNoteDraft, type NoteDraft
} from '@/utils/acro/comments'
import NoteIcon from './NoteIcon.vue'
import { hexToRgb01, rgb01ToHex } from '@/utils/color'
import { objectSelection, objectAction, type ObjectAction } from '@/utils/acro/objectBus'
import ColorSwatch from '@/components/toolbar/ColorSwatch.vue'
import OcrSettingsDialog from '@/components/dialogs/OcrSettingsDialog.vue'
import AcroIcon from './AcroIcon.vue'
import type { AcroShell } from './acroShell'
import type { usePDFEngine } from '@/composables/usePDFEngine'

const $q = useQuasar()
const docStore = useDocumentStore()
const editorStore = useEditorStore()
const ui = useUiStore()
const ocrStore = useOcrStore()
const shell = inject<AcroShell>('acroShell')!
const pdfEngine = inject<ReturnType<typeof usePDFEngine>>('pdfEngine')!
const ocrController = inject<{ autoRecognise?: (pageIndex: number) => Promise<void> } | null>('ocrController', null)

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
/**
 * Acrobat's "Reconocer texto": checked, a scanned page converts to editable
 * text as soon as Editar PDF shows it; unchecked, the scan stays a picture
 * (the recognised runs are hidden, not discarded).
 */
function toggleRecognise(on: boolean) {
  ui.autoRecognize = on
  ocrStore.layerVisible = on
  if (on) void ocrController?.autoRecognise?.(docStore.currentPage - 1)
}

// ── Comentarios ──
const TYPE_LABEL: Record<string, string> = {
  Text: 'Nota adhesiva', FreeText: 'Comentario de texto', Highlight: 'Resaltado', Underline: 'Subrayado',
  StrikeOut: 'Tachado', Square: 'Rectángulo', Circle: 'Óvalo', Line: 'Línea', Ink: 'Lápiz',
  Stamp: 'Sello', Redact: 'Redacción', Squiggly: 'Subrayado ondulado', Polygon: 'Polígono', PolyLine: 'Polilínea',
  Caret: 'Insertar texto', FileAttachment: 'Archivo adjunto'
}
const TYPE_ICON: Record<string, string> = {
  Text: 'sym_o_chat', FreeText: 'sym_o_title', Highlight: 'sym_o_ink_highlighter', Underline: 'sym_o_format_underlined',
  StrikeOut: 'sym_o_strikethrough_s', Squiggly: 'sym_o_format_underlined_squiggle', Square: 'sym_o_rectangle',
  Circle: 'sym_o_circle', Line: 'sym_o_pen_size_2', Ink: 'sym_o_draw', Stamp: 'sym_o_approval', Redact: 'sym_o_ink_eraser',
  Polygon: 'sym_o_pentagon', PolyLine: 'sym_o_polyline', FileAttachment: 'sym_o_attach_file'
}
/** Form fields (a signature included) and links are not comments: Acrobat does not list them. */
const NOT_COMMENTS = new Set(['Widget', 'Signature', 'Link', 'Popup'])

interface CommentRow {
  page: number; index: number; type: string; label: string; icon: string
  contents: string; author: string; color: string; modified: number | null; rect: number[]
}
const comments = ref<CommentRow[]>([])
const loadingComments = ref(false)
const commentFilter = ref('')
const searchOpen = ref(false)
const searchRef = ref<HTMLInputElement | null>(null)
const commentsRef = ref<HTMLElement | null>(null)
const filteredComments = computed(() => {
  const q = commentFilter.value.trim().toLowerCase()
  return q ? comments.value.filter(c => `${c.label} ${c.contents} ${c.author}`.toLowerCase().includes(q)) : comments.value
})
/** Page by page, top to bottom, as Acrobat lists them. */
const commentGroups = computed(() => {
  const groups: { page: number; items: CommentRow[] }[] = []
  for (const c of filteredComments.value) {
    const g = groups[groups.length - 1]
    if (g && g.page === c.page) g.items.push(c); else groups.push({ page: c.page, items: [c] })
  }
  return groups
})
const countLabel = computed(() => comments.value.length === 1 ? '1 comentario' : `${comments.value.length} comentarios`)
const keyOf = (c: { page: number; index: number }) => `${c.page}:${c.index}`
const isFocused = (c: CommentRow) => focusedComment.value?.page === c.page && focusedComment.value?.index === c.index

function timeLabel(ms: number | null | undefined): string {
  if (!ms) return ''
  const d = new Date(ms), now = new Date()
  const hm = d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return hm
  const date = d.toLocaleDateString('es-PE', d.getFullYear() === now.getFullYear()
    ? { day: '2-digit', month: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' })
  return `${date} ${hm}`
}

/** The note just published: its card is selected once the list has it. */
let justPublished: { page: number; x: number; y: number } | null = null
let loadSeq = 0
async function loadComments() {
  if (!docStore.loaded) { comments.value = []; return }
  const seq = ++loadSeq
  loadingComments.value = !comments.value.length
  const out: CommentRow[] = []
  for (let p = 0; p < docStore.totalPages; p++) {
    const list = await pdfEngine.getAnnotations(p).catch(() => [])
    if (seq !== loadSeq) return
    const rows: CommentRow[] = list.filter(a => !NOT_COMMENTS.has(a.type)).map(a => ({
      page: p, index: a.index, type: a.type, label: TYPE_LABEL[a.type] ?? a.type, icon: TYPE_ICON[a.type] ?? 'sym_o_chat_bubble',
      contents: a.contents || '', author: a.author || '', modified: a.modified ?? null, rect: [...a.rect],
      color: rgb01ToHex((a.color?.length ? a.color : [1, 0.82, 0]) as [number, number, number])
    }))
    rows.sort((x, y) => (x.rect[1] - y.rect[1]) || (x.rect[0] - y.rect[0]))
    out.push(...rows)
  }
  comments.value = out
  loadingComments.value = false
  if (justPublished) {
    const j = justPublished
    const c = out.find(r => r.page === j.page && r.type === 'Text' && Math.abs(r.rect[0] - j.x) < 1 && Math.abs(r.rect[1] - j.y) < 1)
    if (c) { justPublished = null; focusedComment.value = { page: c.page, index: c.index } }
  }
  answerNoteEdit()
}
let commentTimer: ReturnType<typeof setTimeout> | null = null
watch(() => [ui.activeTool, docStore.renderVersion, docStore.documentId] as const, ([t]) => {
  if (t !== 'comment') return
  if (commentTimer) clearTimeout(commentTimer)
  commentTimer = setTimeout(loadComments, 250)
}, { immediate: true })

// The card of the comment selected on the page comes into view.
watch(focusedComment, (f) => {
  if (!f) return
  nextTick(() => commentsRef.value?.querySelector(`[data-comment="${f.page}:${f.index}"]`)?.scrollIntoView({ block: 'nearest' }))
})

function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value) nextTick(() => searchRef.value?.focus())
  else commentFilter.value = ''
}

/**
 * A comment change is a document change like any other (the shell's
 * `change`): the engine call through the op queue, the undo point, one
 * save→reload. The viewer's own re-sync (`syncDocumentEdit`) is provided
 * inside the page, below this pane, and is out of its reach: injected here it
 * was undefined, and a published note stayed in the engine, unsaved and
 * undrawn.
 */
async function commentOp(msg: string, mutate: () => Promise<boolean>) {
  const r = await shell.commands.change(msg, async () => ({ success: await mutate() }))
  if (r.success) editorStore.setStatus(msg)
}

// ── The sticky note being written ──
const draftRef = ref<HTMLTextAreaElement | null>(null)
const draftFocusId = ref(0)
const draftHex = computed(() => noteDraft.value ? rgb01ToHex(noteDraft.value.color) : '#ffd200')
async function publishNote(d: NoteDraft) {
  justPublished = { page: d.pageIndex, x: d.x, y: d.y }
  await commentOp('Comentario publicado', () => pdfEngine.addStickyNote(d.pageIndex, d.x, d.y, d.text, d.color))
}
setNotePublisher(publishNote, publishNote)
onBeforeUnmount(() => {
  // The pane closed with a note written in it: it is published, not lost.
  if (noteDraft.value?.text.trim()) void settleNoteDraft()
  setNotePublisher(null, publishNote)
})
function publishDraft() {
  if (noteDraft.value?.text.trim()) void settleNoteDraft()
}
function discardDraft() {
  noteDraft.value = null
  editorStore.setStatus('Nota descartada')
}
/** Leaving the card with text in it publishes it; an empty one stays until Cancelar or the next note. */
function onDraftBlur(e: FocusEvent) {
  const id = draftFocusId.value
  if ((e.relatedTarget as HTMLElement | null)?.closest?.('.comment-card.draft')) return
  setTimeout(() => {
    const d = noteDraft.value
    if (!d || d.id !== id || document.activeElement === draftRef.value) return
    if (d.text.trim()) void settleNoteDraft()
  }, 0)
}
watch(() => noteDraft.value?.id, (id) => {
  if (!id) return
  nextTick(() => {
    draftRef.value?.focus({ preventScroll: true })
    draftRef.value?.scrollIntoView({ block: 'nearest' })
  })
}, { immediate: true })

// ── Selecting, editing, deleting ──
const editingKey = ref('')
const editText = ref('')
const editRef = ref<HTMLTextAreaElement[] | HTMLTextAreaElement | null>(null)
function pickComment(c: CommentRow) {
  if (editingKey.value === keyOf(c)) return
  if (editorStore.isAnnotationTool) editorStore.setTool('select')
  focusedComment.value = { page: c.page, index: c.index }
  if (docStore.currentPage !== c.page + 1) docStore.setPage(c.page + 1)
  selectOnPage.value = request(c.page, c.index)
}
function startEdit(c: CommentRow) {
  if (c.type === 'FreeText') {
    // A text comment is edited where it is drawn, on the page.
    if (editorStore.isAnnotationTool) editorStore.setTool('select')
    if (docStore.currentPage !== c.page + 1) docStore.setPage(c.page + 1)
    editFreeText.value = request(c.page, c.index)
    return
  }
  if (c.type !== 'Text') return
  focusedComment.value = { page: c.page, index: c.index }
  editingKey.value = keyOf(c)
  editText.value = c.contents
  nextTick(() => {
    const el = Array.isArray(editRef.value) ? editRef.value[0] : editRef.value
    el?.focus()
    el?.setSelectionRange(el.value.length, el.value.length)
  })
}
async function saveEdit(c: CommentRow) {
  const text = editText.value
  editingKey.value = ''
  if (text === c.contents) return
  await commentOp('Comentario actualizado', () => pdfEngine.updateAnnotation(c.page, c.index, { contents: text }))
}
async function deleteComment(c: CommentRow) {
  if (isFocused(c)) focusedComment.value = null
  if (editingKey.value === keyOf(c)) editingKey.value = ''
  await commentOp('Comentario eliminado', () => pdfEngine.deleteAnnotation(c.page, c.index))
}
/** A double click on a note's icon edits it here. */
function answerNoteEdit() {
  const r = editNoteText.value
  if (!r || r.seq <= answered.note) return
  const c = comments.value.find(x => x.page === r.page && x.index === r.index)
  if (!c) return
  answered.note = r.seq
  startEdit(c)
}
watch(editNoteText, answerNoteEdit)

function askAuthor() {
  $q.dialog({
    title: 'Nombre del autor',
    message: 'Aparece en los comentarios que agregue.',
    prompt: { model: ui.authorName, type: 'text' },
    ok: { label: 'Aceptar', unelevated: true },
    cancel: { label: 'Cancelar', flat: true }
  }).onOk((v: string) => { ui.authorName = (v || '').trim() })
}

// ── Tool list ──
const listTools = computed(() => ACRO_TOOLS.filter(t => ['create', 'combine', 'edit', 'export', 'organize', 'comment', 'fillsign', 'ocr', 'protect', 'redact', 'stamp'].includes(t.id)))
</script>

<style scoped>
.acro-rightpane { width: 100%; height: 100%; background: var(--acro-panel); color: var(--acro-text); display: flex; flex-direction: column; }
.pane-scroll { flex: 1; overflow-y: auto; padding: 8px 14px 20px; }
section { border-bottom: 1px solid var(--acro-border); padding: 10px 0 14px; }
section.last { border-bottom: 0; display: flex; flex-direction: column; gap: 10px; }
h6 { margin: 8px 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; color: var(--acro-text-strong); line-height: 1; }
.row-line { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.grow { flex: 1; }
.size { width: 72px; }
.gap { width: 10px; }
.fmt-btn {
  display: inline-flex; align-items: center; justify-content: center; min-width: 32px; height: 30px; padding: 0 4px;
  border: 0; border-radius: 3px; background: transparent; color: var(--acro-text); cursor: pointer; font: inherit;
}
.fmt-btn:hover:not(:disabled) { background: var(--acro-hover); }
.fmt-btn.on { background: var(--acro-pressed); color: var(--acro-text-strong); }
.fmt-btn:disabled { opacity: 0.35; cursor: default; }
.t { font-family: 'Times New Roman', serif; font-size: 20px; line-height: 1; }
.t.b { font-weight: 700; }
.t.i { font-style: italic; }
.t.u { text-decoration: underline; }
.t sup, .t sub { font-size: 10px; }
.edit-using { display: flex; align-items: center; gap: 6px; color: var(--acro-text-faint); font-size: 13px; border-bottom: 1px solid var(--acro-border); padding: 4px 0; margin-top: 2px; }
.link-btn { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--acro-blue-text); cursor: pointer; font: inherit; font-size: 13px; padding: 2px 0; }
.link-btn.plain { color: var(--acro-text); margin-bottom: 10px; display: flex; }
.link-btn.danger { color: var(--acro-danger); margin-left: 12px; }
.small-gap { font-size: 12px; color: var(--acro-text); }
.lbl { font-size: 12px; color: var(--acro-text); min-width: 48px; }

.comments-head { display: flex; align-items: center; gap: 2px; font-weight: 700; font-size: 14px; color: var(--acro-text-strong); padding: 6px 0 8px; }
.comments-head .acro-ibtn.active { background: var(--acro-pressed); }
.search { width: 100%; height: 28px; margin-bottom: 10px; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--acro-text-dim); padding: 30px 10px; text-align: center; }
.faint { color: var(--acro-text-faint); font-size: 12px; }
.page-head {
  display: flex; align-items: center; margin: 10px -14px 6px; padding: 6px 14px; cursor: pointer;
  background: var(--acro-surface-2, #f0f0f0); color: var(--acro-text-dim); font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
}
.comment-card {
  background: #fff; border: 1px solid var(--acro-border); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.comment-card:hover { border-color: var(--acro-border-strong); }
.comment-card.current { border-color: var(--acro-blue); box-shadow: 0 0 0 1px var(--acro-blue); }
.comment-card.draft { cursor: default; }
.c-head { display: flex; align-items: center; gap: 8px; font-size: 12px; min-height: 22px; }
.c-avatar {
  flex: none; width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  background: #6e6e6e; color: #fff;
}
.c-avatar.note { background: transparent; }
.c-author { font-weight: 700; color: var(--acro-text-strong); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.c-author-input {
  flex: 1; min-width: 0; border: 0; border-bottom: 1px dashed transparent; background: transparent; padding: 1px 0;
  font: inherit; font-weight: 700; font-size: 13px; color: var(--acro-text-strong); outline: none;
}
.c-author-input:hover, .c-author-input:focus { border-bottom-color: var(--acro-border-strong); }
.c-author-input::placeholder { color: var(--acro-text-faint); font-weight: 400; }
.c-time { color: var(--acro-text-dim); font-size: 11px; white-space: nowrap; flex: none; }
.c-more {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 22px;
  border: 0; border-radius: 3px; background: transparent; color: var(--acro-text-dim); cursor: pointer; opacity: 0;
}
.comment-card:hover .c-more, .comment-card.current .c-more { opacity: 1; }
.c-more:hover { background: var(--acro-hover); }
.c-text { margin: 6px 0 0 30px; font-size: 13px; color: var(--acro-text); white-space: pre-wrap; word-break: break-word; }
.c-kind { margin: 6px 0 0 30px; font-size: 12px; font-style: italic; color: var(--acro-text-dim); display: flex; align-items: center; gap: 6px; }
.c-edit {
  display: block; width: 100%; margin-top: 8px; padding: 6px 8px; resize: vertical; min-height: 60px;
  border: 1px solid var(--acro-border-strong); border-radius: 4px; font: inherit; font-size: 13px;
  color: var(--acro-text); background: #fff; outline: none;
}
.c-edit:focus { border-color: var(--acro-blue); box-shadow: 0 0 0 1px var(--acro-blue); }
.c-edit::placeholder { color: var(--acro-text-faint); }
.c-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.pill {
  height: 28px; padding: 0 14px; border-radius: 14px; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
}
.pill.ghost { background: #fff; color: var(--acro-text); border: 1.5px solid #4b4b4b; }
.pill.ghost:hover { background: var(--acro-hover); }
.pill.primary { background: var(--acro-blue); color: #fff; border: 1.5px solid var(--acro-blue); }
.pill.primary:disabled { background: #e8e8e8; border-color: #e8e8e8; color: #9a9a9a; cursor: default; }

.tool-list { padding: 18px 10px; }
.tool-row {
  display: flex; align-items: center; gap: 12px; width: 100%; height: 46px; padding: 0 14px; border: 0; border-radius: 4px;
  background: transparent; color: var(--acro-text); font: inherit; font-size: 15px; cursor: pointer; text-align: left;
}
.tool-row:hover { background: var(--acro-hover); }
</style>
