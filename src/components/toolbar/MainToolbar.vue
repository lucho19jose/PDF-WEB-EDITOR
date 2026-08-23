<template>
  <div>
    <!-- Main tool row -->
    <q-toolbar class="bg-grey-9 q-px-sm" style="min-height: 42px">
      <!-- File -->
      <span style="position:relative;display:inline-flex">
        <q-btn flat dense icon="folder_open" size="sm" @click="openViaInput"><q-tooltip>Open (Ctrl+O)</q-tooltip></q-btn>
        <input ref="openPickRef" type="file" accept="application/pdf,.pdf" style="position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;cursor:pointer;z-index:1" @change="onOpenPicked" />
      </span>
      <q-btn flat dense icon="save" :disable="!docStore.loaded" @click="saveFile" size="sm"><q-tooltip>Save (Ctrl+S)</q-tooltip></q-btn>
      <q-btn flat dense icon="print" :disable="!docStore.loaded" @click="printFile" size="sm"><q-tooltip>Print (Ctrl+P)</q-tooltip></q-btn>

      <q-separator vertical inset class="q-mx-xs" />

      <!-- Undo / Redo -->
      <q-btn flat dense icon="undo" :disable="!historyStore.canUndo" @click="undo" size="sm"><q-tooltip>Undo (Ctrl+Z)</q-tooltip></q-btn>
      <q-btn flat dense icon="redo" :disable="!historyStore.canRedo" @click="redo" size="sm"><q-tooltip>Redo (Ctrl+Shift+Z)</q-tooltip></q-btn>

      <q-separator vertical inset class="q-mx-xs" />

      <!-- Tools -->
      <template v-for="group in toolGroups" :key="group.label">
        <q-btn
          v-for="tool in group.tools"
          :key="tool.name"
          flat dense
          :icon="tool.icon"
          :color="editorStore.currentTool === tool.name ? 'primary' : undefined"
          :disable="!docStore.loaded"
          @click="editorStore.setTool(tool.name)"
          size="sm"
        >
          <q-tooltip>{{ tool.label }}{{ tool.shortcut ? ` (${tool.shortcut})` : '' }}</q-tooltip>
        </q-btn>
        <q-separator vertical inset class="q-mx-xs" />
      </template>

      <!-- Scanned pages: recover the text before any of the tools above can touch it -->
      <q-btn
        flat dense no-caps
        icon="document_scanner"
        label="Detectar texto (OCR)"
        size="sm"
        :loading="ocr.busy.value"
        :disable="!docStore.loaded || ocr.busy.value"
        @click="runOcr"
      >
        <q-tooltip>Recognise the text on a scanned page and make it editable</q-tooltip>
      </q-btn>

      <q-separator vertical inset class="q-mx-xs" />

      <!-- Zoom -->
      <q-btn flat dense icon="remove" @click="zoomOut" size="sm" :disable="!docStore.loaded" />
      <span class="text-caption q-mx-xs" style="min-width: 40px; text-align: center">{{ zoomPercent }}%</span>
      <q-btn flat dense icon="add" @click="zoomIn" size="sm" :disable="!docStore.loaded" />
      <q-btn flat dense icon="fit_screen" @click="fitPage" size="sm" :disable="!docStore.loaded"><q-tooltip>Reset zoom</q-tooltip></q-btn>

      <q-separator vertical inset class="q-mx-xs" />

      <!-- Page ops -->
      <q-btn flat dense icon="rotate_left" :disable="!docStore.loaded" @click="rotatePage(-90)" size="sm"><q-tooltip>Rotate left</q-tooltip></q-btn>
      <q-btn flat dense icon="rotate_right" :disable="!docStore.loaded" @click="rotatePage(90)" size="sm"><q-tooltip>Rotate right</q-tooltip></q-btn>

      <q-space />

      <q-btn flat dense icon="search" :disable="!docStore.loaded" @click="openFind" size="sm"><q-tooltip>Find (Ctrl+F)</q-tooltip></q-btn>
    </q-toolbar>

    <!-- Context-sensitive properties row -->
    <q-toolbar v-if="ctx !== 'none' && docStore.loaded" class="bg-grey-8 q-px-md" style="min-height: 36px">
      <!-- Text -->
      <template v-if="ctx === 'text'">
        <q-select v-model="editorStore.fontFamily" :options="fonts" dense options-dense borderless
                  class="font-select" style="min-width: 120px" />
        <q-separator vertical inset class="q-mx-sm" />
        <span class="text-caption q-mr-xs">Size</span>
        <q-input v-model.number="editorStore.fontSize" type="number" dense borderless style="width: 56px" :min="4" :max="200" />
        <q-separator vertical inset class="q-mx-sm" />
        <ColorSwatch v-model="editorStore.textColor" label="Text" />
        <q-separator vertical inset class="q-mx-sm" />
        <q-toggle v-model="editorStore.reflowOnEdit" label="Reflow" dense size="sm" color="primary">
          <q-tooltip>
            Move the rest of the page when an edit changes how many lines the text takes.
            Leave it off for forms and tables — it pulls labels away from their values.
          </q-tooltip>
        </q-toggle>
      </template>

      <!-- Markup -->
      <template v-else-if="ctx === 'markup'">
        <ColorSwatch v-model="editorStore.highlightColor" label="Color" />
        <q-separator vertical inset class="q-mx-sm" />
        <span class="text-caption q-mr-sm">Opacity</span>
        <q-slider v-model="editorStore.opacity" :min="0.1" :max="1" :step="0.1" style="width: 100px" dense />
      </template>

      <!-- Shapes -->
      <template v-else-if="ctx === 'shape'">
        <ColorSwatch v-model="editorStore.strokeColor" label="Stroke" />
        <q-separator vertical inset class="q-mx-sm" />
        <span class="text-caption q-mr-xs">Width</span>
        <q-input v-model.number="editorStore.strokeWidth" type="number" dense borderless style="width: 50px" :min="0.5" :max="20" :step="0.5" />
        <q-separator vertical inset class="q-mx-sm" />
        <q-toggle v-model="editorStore.fillEnabled" label="Fill" dense size="sm" />
        <ColorSwatch v-if="editorStore.fillEnabled" v-model="editorStore.fillColor" label="" class="q-ml-sm" />
        <q-separator vertical inset class="q-mx-sm" />
        <span class="text-caption q-mr-sm">Opacity</span>
        <q-slider v-model="editorStore.opacity" :min="0.1" :max="1" :step="0.1" style="width: 90px" dense />
      </template>

      <!-- OCR: what to do with the recognised run that is selected -->
      <template v-if="ctx === 'ocr'">
        <span class="text-caption q-mr-sm">{{ ocrStore.selected ? 'Selected text' : 'Click a detected box' }}</span>
        <template v-if="ocrStore.selected">
          <q-separator vertical inset class="q-mx-sm" />
          <q-select :model-value="ocrStore.selected.fontFamily" :options="fonts" dense options-dense borderless
                    class="font-select" style="min-width: 110px"
                    @update:model-value="(v: string) => patchOcr({ fontFamily: v })" />
          <q-separator vertical inset class="q-mx-sm" />
          <span class="text-caption q-mr-xs">Size</span>
          <q-input :model-value="ocrStore.selected.fontSize" type="number" dense borderless style="width: 56px"
                   :min="4" :max="200" @update:model-value="(v: any) => patchOcr({ fontSize: Number(v) || 4 })" />
          <q-separator vertical inset class="q-mx-sm" />
          <q-btn flat dense size="sm" icon="format_bold" :color="ocrStore.selected.bold ? 'primary' : undefined"
                 @click="patchOcr({ bold: !ocrStore.selected!.bold })"><q-tooltip>Bold</q-tooltip></q-btn>
          <q-btn flat dense size="sm" icon="format_italic" :color="ocrStore.selected.italic ? 'primary' : undefined"
                 @click="patchOcr({ italic: !ocrStore.selected!.italic })"><q-tooltip>Italic</q-tooltip></q-btn>
          <q-separator vertical inset class="q-mx-sm" />
          <ColorSwatch :model-value="ocrHex" label="Text" @update:model-value="(v: string) => patchOcr({ color: hexToRgb01(v) })" />
          <q-separator vertical inset class="q-mx-sm" />
          <q-btn-toggle
            :model-value="ocrStore.selected.align"
            :options="[{ value:'left', icon:'format_align_left' }, { value:'center', icon:'format_align_center' }, { value:'right', icon:'format_align_right' }]"
            dense unelevated size="sm" toggle-color="primary" color="grey-9" text-color="grey-4"
            @update:model-value="(v: any) => patchOcr({ align: v })"
          />
          <q-separator vertical inset class="q-mx-sm" />
          <q-btn flat dense size="sm" color="red-4" icon="delete" @click="ocrStore.removeItem(ocrStore.selected!.id)">
            <q-tooltip>Delete this text — the area is painted out on export</q-tooltip>
          </q-btn>
          <q-btn flat dense size="sm" color="grey-4" icon="restart_alt" @click="ocrStore.revertItem(ocrStore.selected!.id)">
            <q-tooltip>Back to what OCR read</q-tooltip>
          </q-btn>
        </template>
        <q-space />
        <q-toggle v-model="ocrStore.layerVisible" label="Show boxes" dense size="sm" color="primary" />
      </template>

      <!-- Image: how it sits in the text -->
      <template v-else-if="ctx === 'image'">
        <span class="text-caption q-mr-sm">Place</span>
        <q-btn-toggle
          v-model="editorStore.imagePlacement"
          :options="[{ label: 'Above the line', value: 'above' }, { label: 'Below the line', value: 'below' }]"
          dense unelevated no-caps size="sm" toggle-color="primary" color="grey-9" text-color="grey-4"
        />
        <q-separator vertical inset class="q-mx-sm" />
        <span class="text-caption q-mr-sm">Width</span>
        <q-slider v-model="editorStore.imageWidthPct" :min="10" :max="100" :step="5" style="width: 110px" dense />
        <span class="text-caption q-ml-xs" style="min-width: 34px">{{ editorStore.imageWidthPct }}%</span>
        <q-separator vertical inset class="q-mx-sm" />
        <span class="text-caption text-grey-5">click a line to place it, centred on the text</span>
      </template>

      <!-- Draw -->
      <template v-else-if="ctx === 'draw'">
        <ColorSwatch v-model="editorStore.strokeColor" label="Color" />
        <q-separator vertical inset class="q-mx-sm" />
        <span class="text-caption q-mr-xs">Width</span>
        <q-input v-model.number="editorStore.strokeWidth" type="number" dense borderless style="width: 50px" :min="0.5" :max="20" :step="0.5" />
        <q-separator vertical inset class="q-mx-sm" />
        <span class="text-caption q-mr-sm">Opacity</span>
        <q-slider v-model="editorStore.opacity" :min="0.1" :max="1" :step="0.1" style="width: 100px" dense />
      </template>
    </q-toolbar>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { useOcrStore } from '@/stores/ocr'
import { useOCR } from '@/composables/useOCR'
import { hexToRgb01, rgb01ToHex } from '@/utils/color'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore, type Tool } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import ColorSwatch from './ColorSwatch.vue'

const docStore = useDocumentStore()
const editorStore = useEditorStore()
const historyStore = useHistoryStore()

const openPdfFile = inject<(f: File) => void>('openPdfFile', () => {})

const openPickRef = ref<HTMLInputElement | null>(null)
function openViaInput() { openPickRef.value?.click() }

function onOpenPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) openPdfFile(file)
}
const saveFile = inject<() => void>('saveFile', () => {})
const printFile = inject<() => void>('printFile', () => {})
const undo = inject<() => void>('undo', () => {})
const redo = inject<() => void>('redo', () => {})
const rotatePage = inject<(d: number) => void>('rotatePage', () => {})
const openFind = inject<() => void>('openFind', () => {})

const ctx = computed(() => editorStore.propertyContext)

// ── Scanned pages ──
const ocrStore = useOcrStore()
const ocr = useOCR()
const runOcrOnPage = inject<(lang: string) => Promise<void>>('runOcrOnPage', async () => {})

/** The OCR row owns the properties bar while a recognised page is on screen. */
watch(() => ocrStore.layerVisible, v => { editorStore.ocrMode = v }, { immediate: true })

const ocrHex = computed(() => rgb01ToHex(ocrStore.selected?.color ?? [0, 0, 0]))

function patchOcr(patch: Record<string, unknown>) {
  const id = ocrStore.selectedId
  if (id) ocrStore.updateItem(id, patch as any)
}

async function runOcr() {
  await runOcrOnPage('spa')
}
const fonts = ['Helvetica', 'Times-Roman', 'Courier']

const toolGroups: { label: string; tools: { name: Tool; label: string; icon: string; shortcut?: string }[] }[] = [
  { label: 'select', tools: [
    { name: 'select', label: 'Select', icon: 'near_me', shortcut: 'V' },
    { name: 'edit', label: 'Edit Text', icon: 'edit', shortcut: 'E' },
    { name: 'addText', label: 'Add Text', icon: 'text_fields', shortcut: 'T' },
  ]},
  { label: 'markup', tools: [
    { name: 'highlight', label: 'Highlight', icon: 'border_color', shortcut: 'H' },
    { name: 'underline', label: 'Underline', icon: 'format_underlined' },
    { name: 'strikeout', label: 'Strikethrough', icon: 'format_strikethrough' },
  ]},
  { label: 'draw', tools: [
    { name: 'draw', label: 'Draw (freehand)', icon: 'gesture', shortcut: 'D' },
    { name: 'line', label: 'Line', icon: 'horizontal_rule' },
    { name: 'rectangle', label: 'Rectangle', icon: 'crop_square', shortcut: 'R' },
    { name: 'circle', label: 'Ellipse', icon: 'circle', shortcut: 'O' },
  ]},
  { label: 'insert', tools: [
    { name: 'freetext', label: 'Text Box', icon: 'rtt' },
    { name: 'note', label: 'Sticky Note', icon: 'sticky_note_2' },
    { name: 'image', label: 'Insert Image', icon: 'image' },
  ]},
]

const zoomPercent = computed(() => Math.round(docStore.scale * 100))
function zoomIn() { docStore.setScale(docStore.scale + 0.25) }
function zoomOut() { docStore.setScale(docStore.scale - 0.25) }
function fitPage() { docStore.setScale(1.5) }
</script>

<style scoped>

.font-select :deep(.q-field__native) { font-size: 12px; }

/*
 * A Material Icons ligature the bundled font does not carry renders as literal
 * text — ~170px of it — which overflows the 17px icon box and, because the
 * overflow still takes hit-tests, swallows clicks meant for the buttons to its
 * left. `pointer-events: none` keeps every hit on the button itself, so a bad
 * icon name can only ever look wrong, never steal a neighbour's click.
 */
:deep(.q-btn .q-icon) { pointer-events: none; }
</style>
