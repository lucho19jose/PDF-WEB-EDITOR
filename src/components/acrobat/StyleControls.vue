<template>
  <!-- The properties of what the CURRENT comment tool will draw, the way
       Acrobat's comment bar shows a colour well, a line width and an opacity
       beside the tools. -->
  <div class="style-controls">
    <template v-if="isMarkup">
      <ColorSwatch v-model="editorStore.highlightColor" />
      <q-tooltip>Color</q-tooltip>
    </template>
    <template v-else-if="isText">
      <select v-model="family" class="acro-input fam" title="Fuente">
        <option value="Helvetica">Helvetica</option>
        <option value="Times-Roman">Times Roman</option>
        <option value="Courier">Courier</option>
      </select>
      <select v-model.number="editorStore.fontSize" class="acro-input size" title="Tamaño de fuente">
        <option v-if="!SIZES.includes(editorStore.fontSize)" :value="editorStore.fontSize">{{ editorStore.fontSize }}</option>
        <option v-for="s in SIZES" :key="s" :value="s">{{ s }}</option>
      </select>
      <ColorSwatch v-model="editorStore.textColor" />
      <q-tooltip>Fuente, tamaño y color del texto</q-tooltip>
    </template>
    <template v-else>
      <ColorSwatch v-model="editorStore.strokeColor" />
      <select v-if="!compact || isShape" v-model.number="editorStore.strokeWidth" class="acro-input width" title="Grosor de línea">
        <option v-for="w in [0.5, 1, 2, 3, 4, 6, 8, 12]" :key="w" :value="w">{{ w }} pt</option>
      </select>
      <template v-if="isShape">
        <label class="acro-check"><input v-model="editorStore.fillEnabled" type="checkbox" /> Relleno</label>
        <ColorSwatch v-if="editorStore.fillEnabled" v-model="editorStore.fillColor" />
      </template>
    </template>
    <template v-if="!compact">
      <span class="lbl">Opacidad</span>
      <select v-model.number="editorStore.opacity" class="acro-input op">
        <option v-for="o in [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]" :key="o" :value="o">{{ Math.round(o * 100) }}%</option>
      </select>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore, MARKUP_TOOLS } from '@/stores/editor'
import ColorSwatch from '@/components/toolbar/ColorSwatch.vue'

defineProps<{ compact?: boolean }>()
const editorStore = useEditorStore()
const isMarkup = computed(() => MARKUP_TOOLS.includes(editorStore.currentTool) || editorStore.currentTool === 'note')
const isText = computed(() => ['freetext', 'addText'].includes(editorStore.currentTool))
const isShape = computed(() => ['rectangle', 'circle'].includes(editorStore.currentTool))
const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72]
/**
 * A text comment is drawn by MuPDF in Helvetica, Times or Courier and never
 * their bold or italic, so those are the three offered; a family carrying a
 * style (set in Editar PDF's Formato) shows as its plain face.
 */
const family = computed({
  get: () => {
    const n = editorStore.fontFamily.toLowerCase()
    return n.startsWith('times') ? 'Times-Roman' : n.startsWith('cour') ? 'Courier' : 'Helvetica'
  },
  set: (v: string) => { editorStore.fontFamily = v }
})
</script>

<style scoped>
.style-controls { display: flex; align-items: center; gap: 8px; }
.lbl { color: var(--acro-text); font-size: 12px; }
.size { width: 64px; }
.fam { width: 118px; }
.width { width: 64px; }
.op { width: 64px; }
</style>
