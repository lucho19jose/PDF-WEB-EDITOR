<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="v => !running && emit('update:modelValue', v)">
    <q-card class="acro-card" style="min-width: 460px">
      <q-card-section>
        <div class="text-subtitle1">Reconocer texto en este archivo</div>
        <div class="text-caption text-grey-5">
          Lee cada página digitalizada y le añade una capa de texto invisible, para que el
          archivo se pueda buscar, copiar y leer en voz alta. La página conserva sus propios
          píxeles: no cambia nada de lo que se ve.
        </div>
      </q-card-section>

      <q-card-section v-if="!running" class="q-pt-none q-gutter-y-sm">
        <div class="text-caption text-grey-4">Páginas</div>
        <q-option-group
          v-model="pages" dense inline color="primary"
          :options="[
            { label: `Todas (${totalPages})`, value: 'all' },
            { label: `Actual (${currentPage})`, value: 'current' },
            { label: 'Intervalo', value: 'range' }
          ]"
        />
        <q-input
          v-if="pages === 'range'"
          v-model="range" dense outlined
          label="Páginas, p. ej. 3-5, 8"
          :error="!!range && parseRange(range, totalPages).length === 0"
          error-message="No hay ninguna página en ese intervalo"
        />
        <q-select
          v-model="lang" dense outlined emit-value map-options
          label="Idioma"
          :options="languages"
        />
        <q-toggle v-model="replaceExisting" dense color="primary"
          label="También las páginas que ya tienen una capa de texto (reemplazarla)" />
        <div class="text-caption text-grey-6">
          Motor: {{ engineLabel }}. Las páginas con texto real se omiten. Entre 10 y 40 segundos por página.
        </div>
      </q-card-section>

      <q-card-section v-else class="q-pt-none">
        <div class="text-body2 q-mb-xs">{{ progress.stage || 'Reconociendo…' }}</div>
        <q-linear-progress :value="progress.total ? progress.done / progress.total : 0" color="primary" rounded size="10px" />
        <div class="text-caption text-grey-5 q-mt-xs">
          Página {{ progress.page }}: {{ progress.done }} de {{ progress.total }} hechas,
          {{ progress.layered }} reconocidas, {{ progress.skipped }} omitidas
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <template v-if="!running">
          <q-btn flat label="Cancelar" color="grey-4" @click="emit('update:modelValue', false)" />
          <q-btn unelevated label="Reconocer" color="primary" :disable="!canRun" @click="run" />
        </template>
        <q-btn v-else flat label="Detener tras esta página" color="grey-4" @click="emit('cancel')" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script lang="ts">
export interface RecognizeDocumentOptions {
  /** Zero-based page indices to recognise. */
  pageIndices: number[]
  lang: string
  /** Also pages that already carry an invisible text layer (Acrobat's, or ours): the old layer is blanked first. */
  replaceExisting: boolean
}

export interface RecognizeProgress {
  running: boolean
  /** 1-based page being worked on. */
  page: number
  total: number
  done: number
  layered: number
  skipped: number
  stage: string
}

/** "3-5, 8" -> zero-based indices, clamped to the document, in order, without repeats. */
export function parseRange(text: string, total: number): number[] {
  const out = new Set<number>()
  for (const part of text.split(/[,;\s]+/)) {
    if (!part) continue
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) continue
    const a = Math.max(1, parseInt(m[1], 10)), b = Math.min(total, m[2] ? parseInt(m[2], 10) : a)
    for (let p = a; p <= b; p++) out.add(p - 1)
  }
  return [...out].sort((x, y) => x - y)
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { OCR_DEFAULT_LANG } from '@/composables/useOCR'
import { ENGINE_LABELS } from '@/utils/ocr/ocrEngine'

const props = defineProps<{ modelValue: boolean; progress: RecognizeProgress }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean]; run: [opts: RecognizeDocumentOptions]; cancel: [] }>()
const docStore = useDocumentStore()
const editorStore = useEditorStore()

const pages = ref<'all' | 'current' | 'range'>('all')
const range = ref('')
const lang = ref(OCR_DEFAULT_LANG)
const replaceExisting = ref(false)
const running = computed(() => props.progress.running)
const totalPages = computed(() => docStore.totalPages)
const currentPage = computed(() => docStore.currentPage)
const engineLabel = computed(() => ENGINE_LABELS[editorStore.ocrEngine])

/** Tesseract language packs shipped under public/tessdata; PaddleOCR reads Chinese and Latin whatever is chosen. */
const languages = [
  { label: 'Español + chino (simplificado)', value: 'spa+chi_sim' },
  { label: 'Español', value: 'spa' },
  { label: 'Inglés', value: 'eng' },
  { label: 'Español + inglés', value: 'spa+eng' },
  { label: 'Chino (simplificado)', value: 'chi_sim' },
  { label: 'Inglés + chino (simplificado)', value: 'eng+chi_sim' }
]

watch(() => props.modelValue, open => { if (open && !running.value) { pages.value = 'all'; range.value = '' } })

const pageIndices = computed(() => {
  if (pages.value === 'all') return Array.from({ length: totalPages.value }, (_, i) => i)
  if (pages.value === 'current') return [currentPage.value - 1]
  return parseRange(range.value, totalPages.value)
})
const canRun = computed(() => pageIndices.value.length > 0)

function run() {
  emit('run', { pageIndices: pageIndices.value, lang: lang.value, replaceExisting: replaceExisting.value })
}
</script>
