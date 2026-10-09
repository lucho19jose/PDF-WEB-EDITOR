<template>
  <div class="acro-toolopts" :style="{ '--accent': tool?.color ?? '#888' }">
    <div class="accent" />
    <div class="tool-name">{{ tool?.label }}</div>

    <div class="opts">
      <!-- ═══════════ Editar PDF ═══════════ -->
      <template v-if="ui.activeTool === 'edit'">
        <button class="acro-ibtn" :class="{ active: et === 'edit' }" @click="setTool('edit')">
          <q-icon name="sym_o_edit_document" /> Editar
        </button>
        <button class="acro-ibtn" :class="{ active: et === 'addText' }" @click="setTool('addText')">
          <q-icon name="sym_o_title" /> Agregar texto
        </button>
        <button class="acro-ibtn" :class="{ active: et === 'image' }" @click="setTool('image')">
          <q-icon name="sym_o_image" /> Agregar imagen
        </button>
        <button class="acro-ibtn" :class="{ active: et === 'link' }">
          <q-icon name="sym_o_link" /> Vínculo <q-icon name="arrow_drop_down" class="caret" />
          <q-menu class="acro-menu" auto-close>
            <q-list dense>
              <q-item clickable @click="setTool('link')"><q-item-section avatar><q-icon name="sym_o_add_link" /></q-item-section><q-item-section>Agregar o editar</q-item-section></q-item>
              <q-item clickable @click="ui.openDialog('link', { list: true })"><q-item-section avatar><q-icon name="sym_o_list" /></q-item-section><q-item-section>Vínculos de esta página…</q-item-section></q-item>
            </q-list>
          </q-menu>
        </button>
        <button class="acro-ibtn" :class="{ active: et === 'crop' }" @click="setTool('crop')">
          <q-icon name="sym_o_crop" /> Recortar páginas
        </button>
        <button class="acro-ibtn">
          <q-icon name="sym_o_call_to_action" /> Encabezado y pie de página <q-icon name="arrow_drop_down" class="caret" />
          <q-menu class="acro-menu" auto-close>
            <q-list dense>
              <q-item clickable @click="ui.openDialog('headerFooter')"><q-item-section>Agregar…</q-item-section></q-item>
              <q-item clickable @click="ui.openDialog('headerFooter', { update: true })"><q-item-section>Actualizar…</q-item-section></q-item>
              <q-item clickable @click="shell.commands.removeTagged('headerFooter')"><q-item-section>Quitar</q-item-section></q-item>
            </q-list>
          </q-menu>
        </button>
        <button class="acro-ibtn">
          <q-icon name="sym_o_branding_watermark" /> Marca de agua <q-icon name="arrow_drop_down" class="caret" />
          <q-menu class="acro-menu" auto-close>
            <q-list dense>
              <q-item clickable @click="ui.openDialog('watermark')"><q-item-section>Agregar…</q-item-section></q-item>
              <q-item clickable @click="ui.openDialog('watermark', { update: true })"><q-item-section>Actualizar…</q-item-section></q-item>
              <q-item clickable @click="shell.commands.removeTagged('watermark')"><q-item-section>Quitar</q-item-section></q-item>
            </q-list>
          </q-menu>
        </button>
        <button class="acro-ibtn">
          <q-icon name="sym_o_more_horiz" /> Más <q-icon name="arrow_drop_down" class="caret" />
          <q-menu class="acro-menu" auto-close>
            <q-list dense style="min-width: 240px">
              <q-item-label header>Fondo</q-item-label>
              <q-item clickable @click="ui.openDialog('background')"><q-item-section avatar><q-icon name="sym_o_format_color_fill" /></q-item-section><q-item-section>Agregar fondo…</q-item-section></q-item>
              <q-item clickable @click="shell.commands.removeTagged('background')"><q-item-section avatar /><q-item-section>Quitar fondo</q-item-section></q-item>
              <q-separator />
              <q-item clickable @click="ui.openDialog('headerFooter', { pageNumbers: true })"><q-item-section avatar><q-icon name="sym_o_format_list_numbered" /></q-item-section><q-item-section>Agregar números de página…</q-item-section></q-item>
              <q-item clickable @click="editorStore.reflowOnEdit = !editorStore.reflowOnEdit">
                <q-item-section avatar><q-icon :name="editorStore.reflowOnEdit ? 'check_box' : 'check_box_outline_blank'" /></q-item-section>
                <q-item-section>Redistribuir el texto al editar</q-item-section>
              </q-item>
              <q-separator />
              <q-item clickable @click="shell.commands.flatten()"><q-item-section avatar><q-icon name="sym_o_layers_clear" /></q-item-section><q-item-section>Acoplar comentarios y campos</q-item-section></q-item>
            </q-list>
          </q-menu>
        </button>
      </template>

      <!-- ═══════════ Organizar páginas ═══════════ -->
      <template v-else-if="ui.activeTool === 'organize'">
        <select class="acro-input range-select" :value="rangeChoice" @change="pickRange(($event.target as HTMLSelectElement).value)">
          <option value="" disabled>Introduzca el intervalo de páginas</option>
          <option value="all">Todas las páginas</option>
          <option value="even">Páginas pares</option>
          <option value="odd">Páginas impares</option>
          <option value="landscape">Páginas horizontales</option>
          <option value="portrait">Páginas verticales</option>
          <option value="none">Ninguna</option>
        </select>
        <button class="acro-ibtn" :disabled="!sel.length" @click="shell.commands.rotatePages(sel, -90)">
          <q-icon name="sym_o_rotate_left" /><q-tooltip>Girar 90 grados a la izquierda</q-tooltip>
        </button>
        <button class="acro-ibtn" :disabled="!sel.length" @click="shell.commands.rotatePages(sel, 90)">
          <q-icon name="sym_o_rotate_right" /><q-tooltip>Girar 90 grados a la derecha</q-tooltip>
        </button>
        <button class="acro-ibtn" :disabled="!sel.length" @click="shell.commands.deletePages(sel)">
          <q-icon name="sym_o_delete" /><q-tooltip>Eliminar páginas</q-tooltip>
        </button>
        <div class="acro-vsep" />
        <button class="acro-ibtn" @click="ui.openDialog('extract')">
          <q-icon name="sym_o_move_up" /> Extraer
        </button>
        <button class="acro-ibtn">
          <q-icon name="sym_o_note_add" /> Insertar <q-icon name="arrow_drop_down" class="caret" />
          <q-menu class="acro-menu" auto-close>
            <q-list dense>
              <q-item clickable @click="ui.openDialog('insertPages', { mode: 'file' })"><q-item-section avatar><q-icon name="sym_o_upload_file" /></q-item-section><q-item-section>Desde archivo…</q-item-section></q-item>
              <q-item clickable @click="ui.openDialog('insertPages', { mode: 'blank' })"><q-item-section avatar><q-icon name="sym_o_note" /></q-item-section><q-item-section>Página en blanco…</q-item-section></q-item>
              <q-item clickable @click="pasteImagePage"><q-item-section avatar><q-icon name="sym_o_content_paste" /></q-item-section><q-item-section>Desde el portapapeles</q-item-section></q-item>
            </q-list>
          </q-menu>
        </button>
        <button class="acro-ibtn" :disabled="!sel.length" @click="replaceSelected">
          <q-icon name="sym_o_find_replace" /> Reemplazar
        </button>
        <button class="acro-ibtn" @click="ui.openDialog('split')">
          <q-icon name="sym_o_content_cut" /> Dividir
        </button>
        <button class="acro-ibtn">
          <q-icon name="sym_o_more_horiz" /> Más <q-icon name="arrow_drop_down" class="caret" />
          <q-menu class="acro-menu" auto-close>
            <q-list dense style="min-width: 220px">
              <q-item clickable :disable="!sel.length" @click="shell.commands.duplicatePages(sel)"><q-item-section avatar><q-icon name="sym_o_content_copy" /></q-item-section><q-item-section>Duplicar páginas</q-item-section></q-item>
              <q-item clickable @click="shell.commands.reverseOrder()"><q-item-section avatar><q-icon name="sym_o_swap_vert" /></q-item-section><q-item-section>Invertir el orden</q-item-section></q-item>
              <q-item clickable :disable="!sel.length" @click="ui.openDialog('crop', { pages: sel })"><q-item-section avatar><q-icon name="sym_o_crop" /></q-item-section><q-item-section>Recortar páginas…</q-item-section></q-item>
              <q-item clickable @click="ui.openDialog('headerFooter', { pageNumbers: true })"><q-item-section avatar><q-icon name="sym_o_format_list_numbered" /></q-item-section><q-item-section>Numeración de páginas…</q-item-section></q-item>
            </q-list>
          </q-menu>
        </button>
      </template>

      <!-- ═══════════ Comentar ═══════════ -->
      <template v-else-if="ui.activeTool === 'comment'">
        <button v-for="b in commentTools" :key="b.tool" class="acro-ibtn" :class="{ active: et === b.tool }" @click="toggleTool(b.tool)">
          <q-icon :name="b.icon" /><q-tooltip>{{ b.label }}</q-tooltip>
        </button>
        <button class="acro-ibtn" :class="{ active: ['rectangle', 'circle', 'line'].includes(et) }">
          <q-icon :name="shapeIcon" /><q-icon name="arrow_drop_down" class="caret" />
          <q-tooltip>Herramientas de dibujo</q-tooltip>
          <q-menu class="acro-menu" auto-close>
            <q-list dense>
              <q-item clickable @click="setTool('rectangle')"><q-item-section avatar><q-icon name="sym_o_rectangle" /></q-item-section><q-item-section>Dibujar rectángulo</q-item-section></q-item>
              <q-item clickable @click="setTool('circle')"><q-item-section avatar><q-icon name="sym_o_circle" /></q-item-section><q-item-section>Dibujar óvalo</q-item-section></q-item>
              <q-item clickable @click="setTool('line')"><q-item-section avatar><q-icon name="sym_o_pen_size_2" /></q-item-section><q-item-section>Dibujar línea</q-item-section></q-item>
            </q-list>
          </q-menu>
        </button>
        <button class="acro-ibtn" :class="{ active: et === 'stamp' }">
          <q-icon name="sym_o_approval" /><q-icon name="arrow_drop_down" class="caret" />
          <q-tooltip>Agregar sello</q-tooltip>
          <q-menu class="acro-menu" auto-close>
            <q-list dense style="min-width: 200px">
              <q-item v-for="s in STAMP_NAMES" :key="s.name" clickable @click="useStamp(s.name)">
                <q-item-section>{{ s.label }}</q-item-section>
              </q-item>
            </q-list>
          </q-menu>
        </button>
        <div class="acro-vsep" />
        <StyleControls />
      </template>

      <!-- ═══════════ Rellenar y firmar ═══════════ -->
      <template v-else-if="ui.activeTool === 'fillsign'">
        <button class="acro-ibtn" :class="{ active: et === 'freetext' }" @click="setTool('freetext')">
          <span class="ab">Ab|</span><q-tooltip>Agregar texto</q-tooltip>
        </button>
        <button v-for="s in symbols" :key="s.kind" class="acro-ibtn" :class="{ active: et === 'symbol' && editorStore.symbolKind === s.kind }" @click="useSymbol(s.kind)">
          <q-icon :name="s.icon" /><q-tooltip>{{ s.label }}</q-tooltip>
        </button>
        <button class="acro-ibtn" @click="useDate">
          <q-icon name="sym_o_calendar_today" /><q-tooltip>Agregar la fecha de hoy</q-tooltip>
        </button>
        <div class="acro-vsep" />
        <button class="acro-ibtn sign-btn" :class="{ active: et === 'sign' }">
          <q-icon name="sym_o_signature" /> Firmar <q-icon name="arrow_drop_down" class="caret" />
          <q-menu class="acro-menu" auto-close>
            <q-list dense style="min-width: 240px">
              <q-item v-if="ui.signatureImage" clickable @click="useSignature('signature')">
                <q-item-section><img :src="ui.signatureImage" class="sig-preview" alt="Firma" /></q-item-section>
              </q-item>
              <q-item clickable @click="ui.openDialog('signature', { kind: 'signature' })"><q-item-section avatar><q-icon name="sym_o_add" /></q-item-section><q-item-section>{{ ui.signatureImage ? 'Cambiar firma' : 'Agregar firma' }}</q-item-section></q-item>
              <q-separator />
              <q-item v-if="ui.initialsImage" clickable @click="useSignature('initials')">
                <q-item-section><img :src="ui.initialsImage" class="sig-preview small" alt="Iniciales" /></q-item-section>
              </q-item>
              <q-item clickable @click="ui.openDialog('signature', { kind: 'initials' })"><q-item-section avatar><q-icon name="sym_o_add" /></q-item-section><q-item-section>{{ ui.initialsImage ? 'Cambiar iniciales' : 'Agregar iniciales' }}</q-item-section></q-item>
            </q-list>
          </q-menu>
        </button>
        <div class="acro-vsep" />
        <StyleControls compact />
      </template>

      <!-- ═══════════ Proteger / Redactar ═══════════ -->
      <template v-else-if="ui.activeTool === 'protect' || ui.activeTool === 'redact'">
        <button v-if="ui.activeTool === 'protect'" class="acro-ibtn">
          <q-icon name="sym_o_lock" /> Cifrar <q-icon name="arrow_drop_down" class="caret" />
          <q-menu class="acro-menu" auto-close>
            <q-list dense>
              <q-item clickable @click="ui.openDialog('protect')"><q-item-section>Cifrar con contraseña…</q-item-section></q-item>
              <q-item clickable :disable="!ui.protection" @click="removeProtection"><q-item-section>Quitar seguridad</q-item-section></q-item>
            </q-list>
          </q-menu>
        </button>
        <button class="acro-ibtn" :class="{ active: et === 'redact' }" @click="toggleTool('redact')">
          <AcroIcon name="redact" :size="20" color="#d0d0d0" /> Redactar texto e imágenes
        </button>
        <button class="acro-ibtn" @click="shell.commands.applyRedactions()">
          <q-icon name="sym_o_check_circle" /> Aplicar
        </button>
        <button v-if="ui.activeTool === 'protect'" class="acro-ibtn" @click="ui.openDialog('properties', { sanitize: true })">
          <q-icon name="sym_o_cleaning_services" /> Quitar información oculta
        </button>
        <span v-if="ui.protection" class="prot-note"><q-icon name="lock" size="14px" /> Se aplicará una contraseña al guardar</span>
      </template>

      <!-- ═══════════ Digitalizar y OCR ═══════════ -->
      <template v-else-if="ui.activeTool === 'ocr'">
        <button class="acro-ibtn">
          <q-icon name="sym_o_document_scanner" /> Reconocer texto <q-icon name="arrow_drop_down" class="caret" />
          <q-menu class="acro-menu" auto-close>
            <q-list dense style="min-width: 220px">
              <q-item clickable @click="recognizeOpen = true"><q-item-section>En este archivo…</q-item-section></q-item>
              <q-item clickable @click="runOcrOnPage(OCR_DEFAULT_LANG)"><q-item-section>En esta página</q-item-section></q-item>
            </q-list>
          </q-menu>
        </button>
        <button class="acro-ibtn" :class="{ active: et === 'edit' }" @click="setTool('edit')">
          <q-icon name="sym_o_spellcheck" /> Corregir texto reconocido
        </button>
        <button class="acro-ibtn">
          <q-icon name="sym_o_memory" /> Motor: {{ engineLabel }} <q-icon name="arrow_drop_down" class="caret" />
          <q-menu class="acro-menu" auto-close>
            <q-list dense style="min-width: 300px">
              <q-item v-for="o in engineOptions" :key="o.value" clickable @click="editorStore.ocrEngine = o.value">
                <q-item-section avatar><q-icon :name="editorStore.ocrEngine === o.value ? 'radio_button_checked' : 'radio_button_unchecked'" /></q-item-section>
                <q-item-section><q-item-label>{{ o.label }}</q-item-label><q-item-label caption style="color: #9a9a9a">{{ o.caption }}</q-item-label></q-item-section>
              </q-item>
            </q-list>
          </q-menu>
        </button>
        <button class="acro-ibtn" @click="ocrSettingsOpen = true">
          <q-icon name="sym_o_settings" /> Configuración
        </button>
        <label class="acro-check q-ml-sm"><input v-model="ocrStore.layerVisible" type="checkbox" /> Mostrar cuadros reconocidos</label>
        <q-spinner v-if="ocr.busy.value" size="18px" color="white" class="q-ml-sm" />
      </template>

      <!-- ═══════════ Sello ═══════════ -->
      <template v-else-if="ui.activeTool === 'stamp'">
        <span class="hint">Elija un sello y haga clic en la página:</span>
        <select class="acro-input" :value="editorStore.stampName" @change="useStamp(($event.target as HTMLSelectElement).value)">
          <option v-for="s in STAMP_NAMES" :key="s.name" :value="s.name">{{ s.label }}</option>
        </select>
        <button class="acro-ibtn" :class="{ active: et === 'stamp' }" @click="useStamp(editorStore.stampName)">
          <q-icon name="sym_o_approval" /> Colocar sello
        </button>
      </template>

      <!-- ═══════════ Medir ═══════════ -->
      <template v-else-if="ui.activeTool === 'measure'">
        <button class="acro-ibtn" :class="{ active: et === 'measure' }" @click="setTool('measure')">
          <q-icon name="sym_o_straighten" /> Distancia
        </button>
        <span class="hint">Unidades</span>
        <select v-model="editorStore.measureUnit" class="acro-input">
          <option value="mm">Milímetros</option>
          <option value="cm">Centímetros</option>
          <option value="in">Pulgadas</option>
          <option value="pt">Puntos</option>
        </select>
        <div class="acro-vsep" />
        <StyleControls compact />
      </template>
    </div>

    <button class="acro-pill outline close-pill" @click="shell.closeTool()">Cerrar</button>

    <OcrSettingsDialog v-model="ocrSettingsOpen" />
    <OcrRecognizeDialog v-model="recognizeOpen" :progress="recognizeProgress" @run="onRecognizeRun" @cancel="cancelRecognizeDocument()" />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref, type Ref } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore, STAMP_NAMES, type Tool } from '@/stores/editor'
import { useUiStore } from '@/stores/ui'
import { useOcrStore } from '@/stores/ocr'
import { useOCR, OCR_DEFAULT_LANG } from '@/composables/useOCR'
import type { OcrEngineId } from '@/utils/ocr/ocrEngine'
import OcrSettingsDialog from '@/components/dialogs/OcrSettingsDialog.vue'
import OcrRecognizeDialog, { type RecognizeDocumentOptions, type RecognizeProgress } from '@/components/dialogs/OcrRecognizeDialog.vue'
import AcroIcon from './AcroIcon.vue'
import StyleControls from './StyleControls.vue'
import type { AcroShell } from './acroShell'

const docStore = useDocumentStore()
const editorStore = useEditorStore()
const ui = useUiStore()
const ocrStore = useOcrStore()
const ocr = useOCR()
const shell = inject<AcroShell>('acroShell')!
const pdfEngine = inject<any>('pdfEngine')!
const pickFiles = inject<(accept: string, multiple: boolean) => Promise<File[]>>('pickFiles')!

const tool = computed(() => ui.toolMeta)
const et = computed(() => editorStore.currentTool)
const sel = computed(() => [...ui.selectedPages].sort((a, b) => a - b))

function setTool(t: Tool) { editorStore.setTool(t) }
function toggleTool(t: Tool) { editorStore.setTool(et.value === t ? 'select' : t) }

// ── Organize ──
const rangeChoice = ref('')
async function pickRange(v: string) {
  rangeChoice.value = ''
  const n = docStore.totalPages
  const all = Array.from({ length: n }, (_, i) => i)
  if (v === 'all') ui.selectedPages = all
  else if (v === 'none') ui.selectedPages = []
  else if (v === 'even') ui.selectedPages = all.filter(i => (i + 1) % 2 === 0)
  else if (v === 'odd') ui.selectedPages = all.filter(i => (i + 1) % 2 === 1)
  else {
    const out: number[] = []
    for (const i of all) {
      const s = await pdfEngine.getPageSize(i).catch(() => null)
      if (!s) continue
      if ((v === 'landscape') === (s.width > s.height)) out.push(i)
    }
    ui.selectedPages = out
  }
}

async function replaceSelected() {
  const [file] = await pickFiles('application/pdf,.pdf,image/*', false)
  if (file) await shell.commands.replacePages(sel.value, file)
}

/** "Insertar desde el portapapeles": an image on the clipboard becomes a page after the selection. */
async function pasteImagePage() {
  try {
    const items = await (navigator.clipboard as any).read()
    for (const it of items) {
      const type = it.types.find((t: string) => t.startsWith('image/'))
      if (!type) continue
      const blob = await it.getType(type)
      const at = sel.value.length ? sel.value[sel.value.length - 1] + 1 : docStore.totalPages
      await shell.commands.insertFile(new File([blob], 'Portapapeles.png', { type }), at)
      return
    }
    shell.commands.say('No hay ninguna imagen en el portapapeles')
  } catch (_) {
    shell.commands.say('El navegador no permite leer el portapapeles aquí')
  }
}

// ── Comment ──
const commentTools: { tool: Tool; icon: string; label: string }[] = [
  { tool: 'note', icon: 'sym_o_chat', label: 'Agregar nota adhesiva' },
  { tool: 'highlight', icon: 'sym_o_ink_highlighter', label: 'Resaltar texto' },
  { tool: 'underline', icon: 'sym_o_format_underlined', label: 'Subrayar texto' },
  { tool: 'strikeout', icon: 'sym_o_strikethrough_s', label: 'Tachar texto' },
  { tool: 'freetext', icon: 'sym_o_text_fields', label: 'Agregar comentario de texto' },
  { tool: 'draw', icon: 'sym_o_draw', label: 'Dibujar a mano alzada' }
]
const shapeIcon = computed(() => et.value === 'circle' ? 'sym_o_circle' : et.value === 'line' ? 'sym_o_pen_size_2' : 'sym_o_rectangle')
function useStamp(name: string) {
  editorStore.stampName = name
  setTool('stamp')
}

// ── Fill & sign ──
const symbols = [
  { kind: 'cross' as const, icon: 'sym_o_close', label: 'Agregar una cruz' },
  { kind: 'check' as const, icon: 'sym_o_check', label: 'Agregar una marca de verificación' },
  { kind: 'dot' as const, icon: 'sym_o_fiber_manual_record', label: 'Agregar un punto' },
  { kind: 'line' as const, icon: 'sym_o_remove', label: 'Agregar una línea' },
  { kind: 'box' as const, icon: 'sym_o_check_box_outline_blank', label: 'Agregar un rectángulo' }
]
function useSymbol(kind: typeof symbols[number]['kind']) {
  editorStore.symbolKind = kind
  setTool('symbol')
}
function useDate() {
  editorStore.freeTextPreset = new Date().toLocaleDateString('es-PE')
  setTool('freetext')
}
function useSignature(kind: 'signature' | 'initials') {
  editorStore.signKind = kind
  setTool('sign')
  editorStore.setStatus('Haga clic en la página donde desea colocar la firma')
}

// ── Protect ──
function removeProtection() {
  ui.protection = null
  shell.commands.say('Se quitó la contraseña: el archivo se guardará sin protección')
}

// ── OCR ──
const runOcrOnPage = inject<(lang: string) => Promise<void>>('runOcrOnPage', async () => {})
const ocrSettingsOpen = ref(false)
const recognizeOpen = ref(false)
const recognizeDocument = inject<(opts: RecognizeDocumentOptions) => Promise<void>>('recognizeDocument', async () => {})
const cancelRecognizeDocument = inject<() => void>('cancelRecognizeDocument', () => {})
const recognizeProgress = inject<Ref<RecognizeProgress>>('recognizeProgress', ref({ running: false, page: 0, total: 0, done: 0, layered: 0, skipped: 0, stage: '' }))
async function onRecognizeRun(opts: RecognizeDocumentOptions) {
  await recognizeDocument(opts)
  recognizeOpen.value = false
}
const engineOptions: { value: OcrEngineId; label: string; caption: string }[] = [
  { value: 'paddle', label: 'PaddleOCR', caption: 'En el navegador, sin conexión. El mejor para chino y texto mixto.' },
  { value: 'tesseract', label: 'Tesseract', caption: 'En el navegador, sin conexión. Modelos de español y chino.' },
  { value: 'mistral', label: 'Mistral OCR (nube)', caption: 'Envía la imagen de la página a Mistral. Necesita una clave API.' }
]
const engineLabel = computed(() => engineOptions.find(o => o.value === editorStore.ocrEngine)?.label ?? '')
</script>

<style scoped>
.acro-toolopts {
  position: relative; height: 46px; display: flex; align-items: center; background: var(--acro-bar);
  border-bottom: 1px solid var(--acro-rule); padding: 0 10px 0 20px; user-select: none;
}
.accent { position: absolute; left: 0; top: 0; bottom: 0; width: 8px; background: var(--accent); }
.tool-name { font-size: 15px; font-weight: 700; color: #fff; white-space: nowrap; min-width: 160px; }
.opts { flex: 1; display: flex; align-items: center; justify-content: center; gap: 4px; overflow: hidden; }
.opts .acro-ibtn { font-size: 14px; color: #ececec; }
.close-pill { margin-left: 12px; }
.range-select { width: 220px; height: 26px; margin-right: 6px; }
.ab { font-family: 'Times New Roman', serif; font-size: 17px; font-weight: 700; color: #ddd; }
.sig-preview { max-width: 200px; max-height: 48px; background: #fff; border-radius: 2px; }
.sig-preview.small { max-height: 32px; }
.hint { color: #c8c8c8; font-size: 13px; margin: 0 6px; }
.prot-note { color: #f5c46b; font-size: 12px; margin-left: 10px; display: inline-flex; align-items: center; gap: 4px; }
</style>
