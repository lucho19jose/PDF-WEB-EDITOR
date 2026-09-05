<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="v => !running && emit('update:modelValue', v)">
    <q-card dark class="bg-grey-9" style="min-width: 460px">
      <q-card-section>
        <div class="text-subtitle1">Reconocer texto en este archivo</div>
        <div class="text-caption text-grey-5">
          Reads every scanned page and adds an invisible text layer, so the file can be
          searched, copied and read aloud — the way Acrobat's "Reconocer texto" does.
          The page keeps its own pixels; nothing visible changes.
        </div>
      </q-card-section>

      <q-card-section v-if="!running" class="q-pt-none q-gutter-y-sm">
        <div class="text-caption text-grey-4">Pages</div>
        <q-option-group
          v-model="pages" dark dense inline color="primary"
          :options="[
            { label: `All (${totalPages})`, value: 'all' },
            { label: `Current (${currentPage})`, value: 'current' },
            { label: 'Range', value: 'range' }
          ]"
        />
        <q-input
          v-if="pages === 'range'"
          v-model="range" dark dense outlined
          label="Pages, e.g. 3-5, 8"
          :error="!!range && parseRange(range, totalPages).length === 0"
          error-message="No page in that range"
        />
        <q-select
          v-model="lang" dark dense outlined emit-value map-options
          label="Language"
          :options="languages"
        />
        <q-toggle v-model="replaceExisting" dark dense color="primary"
          label="Also pages that already have a text layer (replace it)" />
        <div class="text-caption text-grey-6">
          Engine: {{ engineLabel }}. Pages with real text are skipped. About 10–40 seconds per page.
        </div>
      </q-card-section>

      <q-card-section v-else class="q-pt-none">
        <div class="text-body2 q-mb-xs">{{ progress.stage || 'Recognising…' }}</div>
        <q-linear-progress :value="progress.total ? progress.done / progress.total : 0" color="primary" dark rounded size="10px" />
        <div class="text-caption text-grey-5 q-mt-xs">
          Page {{ progress.page }} — {{ progress.done }} of {{ progress.total }} done,
          {{ progress.layered }} recognised, {{ progress.skipped }} skipped
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <template v-if="!running">
          <q-btn flat label="Cancel" color="grey-4" @click="emit('update:modelValue', false)" />
          <q-btn unelevated label="Recognise" color="primary" :disable="!canRun" @click="run" />
        </template>
        <q-btn v-else flat label="Stop after this page" color="grey-4" @click="emit('cancel')" />
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
  { label: 'Spanish + Chinese (simplified)', value: 'spa+chi_sim' },
  { label: 'Spanish', value: 'spa' },
  { label: 'English', value: 'eng' },
  { label: 'Spanish + English', value: 'spa+eng' },
  { label: 'Chinese (simplified)', value: 'chi_sim' },
  { label: 'English + Chinese (simplified)', value: 'eng+chi_sim' }
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
