<template>
  <!-- Acrobat's "Intervalo de páginas" block, shared by every dialog that acts on pages. -->
  <fieldset class="range-picker">
    <legend>Intervalo de páginas</legend>
    <label class="acro-check"><input v-model="mode" type="radio" value="all" /> Todas las páginas ({{ docStore.totalPages }})</label>
    <label class="acro-check"><input v-model="mode" type="radio" value="current" /> Página actual ({{ docStore.currentPage }})</label>
    <label v-if="ui.selectedPages.length" class="acro-check"><input v-model="mode" type="radio" value="selected" /> Páginas seleccionadas ({{ ui.selectedPages.length }})</label>
    <label class="acro-check range-row">
      <input v-model="mode" type="radio" value="range" /> Páginas:
      <input v-model="text" class="acro-input" placeholder="p. ej. 1-3, 5" @focus="mode = 'range'" />
    </label>
    <label v-if="subset" class="acro-check sub">
      Aplicar a:
      <select v-model="parity" class="acro-input">
        <option value="all">Todas las páginas del intervalo</option>
        <option value="odd">Solo páginas impares</option>
        <option value="even">Solo páginas pares</option>
      </select>
    </label>
  </fieldset>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useUiStore } from '@/stores/ui'
import { parsePageRange } from '@/composables/useAcroCommands'

const props = withDefaults(defineProps<{ modelValue: number[]; initial?: 'all' | 'current' | 'selected'; subset?: boolean }>(), { initial: 'all', subset: false })
const emit = defineEmits<{ 'update:modelValue': [number[]] }>()
const docStore = useDocumentStore()
const ui = useUiStore()

const mode = ref<'all' | 'current' | 'selected' | 'range'>(props.initial === 'selected' && !ui.selectedPages.length ? 'all' : props.initial)
const text = ref(`1-${docStore.totalPages}`)
const parity = ref<'all' | 'odd' | 'even'>('all')

function compute(): number[] {
  const n = docStore.totalPages
  let list: number[]
  if (mode.value === 'all') list = Array.from({ length: n }, (_, i) => i)
  else if (mode.value === 'current') list = [docStore.currentPage - 1]
  else if (mode.value === 'selected') list = [...ui.selectedPages].sort((a, b) => a - b)
  else list = parsePageRange(text.value, n)
  if (parity.value === 'odd') list = list.filter(i => i % 2 === 0)
  if (parity.value === 'even') list = list.filter(i => i % 2 === 1)
  return list
}
watch([mode, text, parity], () => emit('update:modelValue', compute()))
onMounted(() => emit('update:modelValue', compute()))
</script>

<style scoped>
.range-picker { display: flex; flex-direction: column; gap: 8px; }
.range-row .acro-input { width: 160px; margin-left: 4px; }
.sub { margin-top: 4px; }
.sub .acro-input { margin-left: 6px; }
</style>
