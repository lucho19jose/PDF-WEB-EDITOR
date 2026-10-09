<template>
  <div class="acro-tabbar">
    <button class="tab" :class="{ active: ui.view === 'home' }" @click="ui.view = 'home'">Inicio</button>
    <button class="tab" :class="{ active: ui.view === 'tools' }" @click="ui.view = 'tools'">Herramientas</button>
    <div
      v-if="docStore.loaded"
      class="doc-tab" :class="{ active: ui.view === 'document' }"
      :title="docStore.fileName ?? ''"
      @click="ui.view = 'document'"
    >
      <span class="doc-name">{{ shortName }}</span>
      <button class="doc-close" title="Cerrar" @click.stop="shell.closeDocument()">
        <q-icon name="close" size="14px" />
      </button>
    </div>
    <q-space />
    <button class="round-btn" @click="ui.openDialog('shortcuts')">
      <q-icon name="sym_o_help" size="22px" />
      <q-tooltip>Ayuda</q-tooltip>
    </button>
    <button class="round-btn bell" @click="ui.unreadNotifications = 0">
      <q-icon name="notifications" size="20px" />
      <span v-if="ui.unreadNotifications" class="badge">{{ Math.min(ui.unreadNotifications, 99) }}</span>
      <q-tooltip>Notificaciones</q-tooltip>
      <q-menu class="acro-menu" anchor="bottom right" self="top right" max-width="420px" @show="ui.unreadNotifications = 0">
        <q-list dense style="min-width: 320px; max-height: 420px">
          <q-item-label header>Notificaciones</q-item-label>
          <q-item v-for="(n, i) in ui.notifications" :key="i">
            <q-item-section>
              <q-item-label style="white-space: normal">{{ n.text }}</q-item-label>
              <q-item-label caption style="color: #8a8a8a">{{ new Date(n.at).toLocaleTimeString() }}</q-item-label>
            </q-item-section>
          </q-item>
          <q-item v-if="!ui.notifications.length"><q-item-section class="text-grey-6">No hay notificaciones</q-item-section></q-item>
        </q-list>
      </q-menu>
    </button>
    <button class="signin" @click="ui.openDialog('about')">Iniciar sesión</button>
  </div>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useUiStore } from '@/stores/ui'
import type { AcroShell } from './acroShell'

const docStore = useDocumentStore()
const ui = useUiStore()
const shell = inject<AcroShell>('acroShell')!

/** Acrobat truncates the tab's file name around 20 characters, with an ellipsis. */
const shortName = computed(() => {
  const n = (docStore.fileName ?? '').replace(/\.pdf$/i, '') + (docStore.isModified ? ' *' : '')
  return n.length > 22 ? n.slice(0, 20) + '...' : n
})
</script>

<style scoped>
.acro-tabbar {
  height: 36px; display: flex; align-items: stretch; background: var(--acro-tabbar);
  border-bottom: 1px solid var(--acro-rule-dark); user-select: none;
}
.tab {
  position: relative; border: 0; background: transparent; color: #c8c8c8; font: inherit; font-size: 15px;
  padding: 0 17px; cursor: pointer;
}
.tab:hover { color: #fff; }
.tab.active { color: #fff; }
.tab.active::after { content: ''; position: absolute; left: 17px; right: 17px; bottom: 1px; height: 2px; background: #fff; }
.doc-tab {
  display: flex; align-items: center; gap: 10px; min-width: 150px; max-width: 220px; padding: 0 10px 0 24px;
  background: transparent; color: #d8d8d8; font-size: 13px; cursor: pointer; border-left: 1px solid #383838; border-right: 1px solid #383838;
}
.doc-tab.active { background: var(--acro-bar); color: #fff; }
.doc-name { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.doc-close { border: 0; background: transparent; color: #cfcfcf; width: 18px; height: 18px; border-radius: 3px; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; }
.doc-close:hover { background: #6a6a6a; color: #fff; }
.round-btn {
  position: relative; align-self: center; width: 32px; height: 32px; border-radius: 50%; border: 0; background: transparent;
  color: #d0d0d0; cursor: pointer; display: flex; align-items: center; justify-content: center; margin-right: 6px;
}
.round-btn:hover { background: #555; color: #fff; }
.badge {
  position: absolute; top: 3px; right: 2px; min-width: 15px; height: 15px; border-radius: 8px; background: var(--acro-blue);
  color: #fff; font-size: 10px; line-height: 15px; padding: 0 3px;
}
.signin { border: 0; background: transparent; color: #f2f2f2; font: inherit; font-size: 15px; font-weight: 700; padding: 0 20px 0 12px; cursor: pointer; }
.signin:hover { color: #fff; }
</style>
