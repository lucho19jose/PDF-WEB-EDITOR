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
      <ColorSwatch v-model="editorStore.textColor" />
      <select v-model.number="editorStore.fontSize" class="acro-input size">
        <option v-for="s in [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48]" :key="s" :value="s">{{ s }}</option>
      </select>
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
</script>

<style scoped>
.style-controls { display: flex; align-items: center; gap: 8px; }
.lbl { color: #c8c8c8; font-size: 12px; }
.size { width: 54px; }
.width { width: 64px; }
.op { width: 64px; }
</style>
