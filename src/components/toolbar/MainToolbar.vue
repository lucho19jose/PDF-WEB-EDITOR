<template>
  <q-toolbar class="bg-grey-9 q-px-sm" style="min-height: 42px">
    <!-- File Operations -->
    <q-btn flat dense icon="folder_open" label="Open" @click="openFile" size="sm" />
    <q-btn flat dense icon="save" label="Save" :disable="!docStore.loaded" @click="saveFile" size="sm" />

    <q-separator vertical inset class="q-mx-xs" />

    <!-- Edit Tools -->
    <q-btn-group flat>
      <q-btn
        v-for="tool in tools"
        :key="tool.name"
        flat dense
        :icon="tool.icon"
        :color="editorStore.currentTool === tool.name ? 'primary' : undefined"
        :disable="!docStore.loaded"
        @click="editorStore.setTool(tool.name)"
        size="sm"
      >
        <q-tooltip>{{ tool.label }} {{ tool.shortcut ? `(${tool.shortcut})` : '' }}</q-tooltip>
      </q-btn>
    </q-btn-group>

    <q-separator vertical inset class="q-mx-xs" />

    <!-- Zoom -->
    <q-btn flat dense icon="remove" @click="zoomOut" size="sm" />
    <span class="text-caption q-mx-xs" style="min-width: 40px; text-align: center">
      {{ zoomPercent }}%
    </span>
    <q-btn flat dense icon="add" @click="zoomIn" size="sm" />
    <q-btn flat dense icon="fit_screen" @click="fitPage" size="sm">
      <q-tooltip>Fit Page</q-tooltip>
    </q-btn>

    <q-separator vertical inset class="q-mx-xs" />

    <!-- Page Operations -->
    <q-btn flat dense icon="rotate_left" :disable="!docStore.loaded" @click="$emit('rotate-left')" size="sm">
      <q-tooltip>Rotate Left</q-tooltip>
    </q-btn>
    <q-btn flat dense icon="rotate_right" :disable="!docStore.loaded" @click="$emit('rotate-right')" size="sm">
      <q-tooltip>Rotate Right</q-tooltip>
    </q-btn>
  </q-toolbar>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore, type Tool } from '@/stores/editor'

const docStore = useDocumentStore()
const editorStore = useEditorStore()

const openFile = inject<() => void>('openFile', () => {})

const tools: { name: Tool; label: string; icon: string; shortcut?: string }[] = [
  { name: 'select', label: 'Select', icon: 'arrow_selector_tool', shortcut: 'V' },
  { name: 'edit', label: 'Edit Text', icon: 'edit', shortcut: 'E' },
  { name: 'addText', label: 'Add Text', icon: 'title', shortcut: 'T' },
  { name: 'highlight', label: 'Highlight', icon: 'highlight', shortcut: 'H' },
  { name: 'line', label: 'Line', icon: 'horizontal_rule', shortcut: 'L' },
  { name: 'rectangle', label: 'Rectangle', icon: 'crop_square', shortcut: 'R' },
  { name: 'circle', label: 'Circle', icon: 'circle', shortcut: 'O' },
]

const zoomPercent = computed(() => Math.round(docStore.scale * 100))

function zoomIn() {
  docStore.setScale(docStore.scale + 0.25)
}
function zoomOut() {
  docStore.setScale(docStore.scale - 0.25)
}
function fitPage() {
  docStore.setScale(1.0)
}

const saveFile = inject<() => void>('saveFile', () => {})

defineEmits(['rotate-left', 'rotate-right'])
</script>
