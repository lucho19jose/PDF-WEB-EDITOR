<template>
  <!-- Acrobat's tool rail: one coloured icon per pinned tool, the open tool's
       square filled with the tool's colour, "Más herramientas" at the foot. -->
  <div class="acro-rail">
    <button
      v-for="t in tools" :key="t.id"
      class="rail-btn" :class="{ active: ui.activeTool === t.id }"
      :style="ui.activeTool === t.id ? { background: t.color } : undefined"
      @click="toggle(t.id)"
    >
      <AcroIcon :name="t.icon" :color="ui.activeTool === t.id ? '#fff' : t.color" :size="24" />
      <q-tooltip anchor="center left" self="center right">{{ t.label }}</q-tooltip>
    </button>
    <button class="rail-btn" @click="ui.view = 'tools'">
      <AcroIcon name="moretools" color="#d6d6d6" :size="24" />
      <q-tooltip anchor="center left" self="center right">Más herramientas</q-tooltip>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import { useUiStore, RAIL_TOOLS, toolInfo, type AcroTool } from '@/stores/ui'
import AcroIcon from './AcroIcon.vue'
import type { AcroShell } from './acroShell'

const ui = useUiStore()
const shell = inject<AcroShell>('acroShell')!
const tools = computed(() => RAIL_TOOLS.map(id => toolInfo(id)!).filter(Boolean))

function toggle(id: AcroTool) {
  if (ui.activeTool === id) shell.closeTool()
  else shell.openTool(id)
}
</script>

<style scoped>
.acro-rail {
  width: 40px; height: 100%; background: var(--acro-rail); border-left: 1px solid var(--acro-rule);
  display: flex; flex-direction: column; align-items: stretch; padding-top: 10px; gap: 2px; flex: none;
}
.rail-btn {
  height: 44px; border: 0; background: transparent; display: flex; align-items: center; justify-content: center;
  cursor: pointer; padding: 0;
}
.rail-btn:hover:not(.active) { background: var(--acro-hover); }
</style>
