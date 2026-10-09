<template>
  <div class="tools-view">
    <div class="tools-main">
      <div class="search-bar">
        <q-icon name="search" size="22px" color="grey-5" />
        <input v-model="query" class="search" placeholder="Búsqueda de herramientas" />
      </div>
      <div class="tools-scroll">
        <section v-for="g in groups" :key="g.id">
          <h2>{{ g.label }}</h2>
          <div class="grid">
            <div v-for="t in g.tools" :key="t.id" class="tool">
              <button class="tool-icon" @click="shell.openTool(t.id)">
                <span v-if="t.id === 'stamp'" class="nueva">NUEVA</span>
                <AcroIcon :name="t.icon" :color="t.color" :size="50" />
              </button>
              <div class="tool-label" @click="shell.openTool(t.id)">{{ t.label }}</div>
              <div class="acro-split">
                <button @click="shell.openTool(t.id)">{{ t.action }}</button>
                <button>
                  <q-icon name="arrow_drop_down" size="16px" />
                  <q-menu class="acro-menu" auto-close>
                    <q-list dense>
                      <q-item clickable @click="shell.openTool(t.id)"><q-item-section>Abrir</q-item-section></q-item>
                      <q-item clickable @click="pin(t.id)"><q-item-section>{{ pinned.includes(t.id) ? 'Quitar de accesos directos' : 'Agregar a accesos directos' }}</q-item-section></q-item>
                    </q-list>
                  </q-menu>
                </button>
              </div>
            </div>
          </div>
        </section>
        <div v-if="!groups.length" class="none">No se encontró ninguna herramienta para "{{ query }}".</div>
      </div>
    </div>

    <!-- Acrobat's right-hand list of tools beside the Tools page -->
    <aside class="tools-side">
      <button v-for="t in sideTools" :key="t.id" class="side-row" @click="shell.openTool(t.id)">
        <AcroIcon :name="t.icon" :color="t.color" :size="22" />
        <span>{{ t.label }}</span>
      </button>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject } from 'vue'
import { ACRO_TOOLS, TOOL_GROUPS, toolInfo, type AcroTool } from '@/stores/ui'
import { persistedRef } from '@/utils/persist'
import AcroIcon from './AcroIcon.vue'
import type { AcroShell } from './acroShell'

const shell = inject<AcroShell>('acroShell')!
const query = ref('')

const groups = computed(() => {
  const q = query.value.trim().toLowerCase()
  return TOOL_GROUPS
    .map(g => ({ ...g, tools: ACRO_TOOLS.filter(t => t.group === g.id && (!q || t.label.toLowerCase().includes(q))) }))
    .filter(g => g.tools.length)
})

const pinned = persistedRef<AcroTool[]>('ui.pinnedTools', ['create', 'combine', 'edit', 'export', 'organize', 'comment', 'fillsign', 'ocr', 'protect'])
const sideTools = computed(() => pinned.value.map(id => toolInfo(id)).filter(Boolean) as NonNullable<ReturnType<typeof toolInfo>>[])
function pin(id: AcroTool) {
  pinned.value = pinned.value.includes(id) ? pinned.value.filter(x => x !== id) : [...pinned.value, id]
}
</script>

<style scoped>
.tools-view { display: flex; height: 100%; background: var(--acro-bar); }
.tools-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.search-bar { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 14px; border-bottom: 1px solid var(--acro-rule); }
.search { flex: 1; border: 0; outline: 0; background: transparent; color: #eee; font: inherit; font-size: 13px; }
.search::placeholder { color: #a0a0a0; }
.tools-scroll { flex: 1; overflow-y: auto; padding: 30px 0 60px 196px; }
section { margin-bottom: 34px; }
h2 { font-size: 21px; font-weight: 400; color: #f2f2f2; margin: 0 0 30px; line-height: 1.2; }
.grid { display: flex; flex-wrap: wrap; gap: 30px 0; }
.tool { width: 170px; display: flex; flex-direction: column; align-items: center; gap: 0; }
.tool-icon { position: relative; border: 0; background: transparent; cursor: pointer; height: 66px; display: flex; align-items: center; justify-content: center; padding: 0; }
.nueva { position: absolute; top: -8px; left: 50%; transform: translateX(-50%); background: #2d6cc4; color: #fff; font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 2px; letter-spacing: .03em; }
.tool-label { margin: 6px 0 14px; color: #ececec; font-size: 15px; text-align: center; cursor: pointer; min-height: 20px; }
.tool-label:hover { color: #fff; }
.none { color: #bbb; padding: 20px 0; }
.tools-side { width: 300px; flex: none; border-left: 1px solid var(--acro-rule); background: var(--acro-bar); padding: 16px 12px; overflow-y: auto; }
.side-row { display: flex; align-items: center; gap: 12px; width: 100%; height: 46px; padding: 0 12px; border: 0; background: transparent; color: #ececec; font: inherit; font-size: 15px; cursor: pointer; text-align: left; border-radius: 4px; }
.side-row:hover { background: var(--acro-hover); }
@media (max-width: 1200px) { .tools-scroll { padding-left: 40px; } }
</style>
