<template>
  <div class="acro-tabbar">
    <button class="tab" :class="{ active: ui.view === 'home' }" @click="ui.view = 'home'">Inicio</button>
    <button class="tab" :class="{ active: ui.view === 'tools' }" @click="ui.view = 'tools'">Herramientas</button>
    <button v-if="overflow" class="strip-arrow" title="Pestañas anteriores" @click="scrollStrip(-1)">
      <q-icon name="chevron_left" size="18px" />
    </button>
    <div ref="stripRef" class="doc-strip" @wheel.passive="onWheel" @scroll="measure">
      <div
        v-for="t in docTabs" :key="t.id"
        class="doc-tab" :class="{ active: t.id === ownId && ui.view === 'document', dragging: dragId === t.id }"
        :data-tab="t.id"
        :title="t.name"
        :draggable="embedded"
        @click="pick(t.id)"
        @auxclick.prevent="e => { if (e.button === 1) close(t.id) }"
        @mousedown.middle.prevent
        @dragstart="e => onDragStart(e, t.id)"
        @dragover="e => onDragOver(e, t.id)"
        @drop="e => onDropTab(e, t.id)"
        @dragend="dragId = null"
      >
        <span class="doc-name">{{ label(t) }}</span>
        <button class="doc-close" title="Cerrar" @click.stop="close(t.id)">
          <q-icon name="close" size="14px" />
        </button>
      </div>
    </div>
    <button v-if="overflow" class="strip-arrow" title="Pestañas siguientes" @click="scrollStrip(1)">
      <q-icon name="chevron_right" size="18px" />
    </button>
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
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useUiStore } from '@/stores/ui'
import { isEmbedded, frameId, tabList, activateTab, closeTab, reorderTabs } from '@/tabs/frameClient'
import type { TabInfo } from '@/tabs/protocol'
import type { AcroShell } from './acroShell'

const docStore = useDocumentStore()
const ui = useUiStore()
const shell = inject<AcroShell>('acroShell')!

/**
 * The document tabs. As one tab of the window (src/tabs) this page lists every
 * tab the host reports, its own from its live store (the host's copy lags a
 * message behind); without tabs (`?single`) it shows its one document.
 */
const embedded = isEmbedded()
const OWN = '__own__'
const ownId = embedded ? frameId! : OWN
const docTabs = computed<TabInfo[]>(() => {
  const own: TabInfo = { id: ownId, name: docStore.fileName ?? '', modified: docStore.isModified }
  if (!embedded) return docStore.loaded ? [own] : []
  const list = tabList.value.map(t => t.id === ownId ? own : t)
  if (docStore.loaded && !list.some(t => t.id === ownId)) list.push(own)
  if (!docStore.loaded) return list.filter(t => t.id !== ownId)
  return list
})

/** Acrobat truncates the tab's file name around 20 characters, with an ellipsis. */
function label(t: TabInfo): string {
  const n = t.name.replace(/\.pdf$/i, '') + (t.modified ? ' *' : '')
  return n.length > 22 ? n.slice(0, 20) + '...' : n
}

function pick(id: string) {
  if (id === ownId) ui.view = 'document'
  else activateTab(id)
}

function close(id: string) {
  // This tab closes itself (its save prompt is here); another is asked to.
  if (id === ownId) shell.closeDocument()
  else closeTab(id)
}

// ===== Reordering by drag =====
const dragId = ref<string | null>(null)
const TAB_TYPE = 'application/x-pdf-editor-tab'
function onDragStart(e: DragEvent, id: string) {
  if (!embedded) return
  dragId.value = id
  e.dataTransfer?.setData(TAB_TYPE, id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onDragOver(e: DragEvent, _id: string) {
  // Only a tab being dragged; a FILE dropped on the bar opens as usual.
  if (!dragId.value) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
}
function onDropTab(e: DragEvent, onto: string) {
  const id = dragId.value
  if (!id) return
  e.preventDefault()
  e.stopPropagation()
  dragId.value = null
  if (id === onto) return
  const ids = docTabs.value.map(t => t.id).filter(t => t !== id)
  const at = ids.indexOf(onto)
  const from = docTabs.value.findIndex(t => t.id === id)
  const to = docTabs.value.findIndex(t => t.id === onto)
  ids.splice(from < to ? at + 1 : at, 0, id)
  reorderTabs(ids)
}

// ===== Many tabs: they shrink to a minimum, then the strip scrolls =====
const stripRef = ref<HTMLElement | null>(null)
const overflow = ref(false)
function measure() {
  const el = stripRef.value
  overflow.value = !!el && el.scrollWidth > el.clientWidth + 1
}
function scrollStrip(dir: number) {
  stripRef.value?.scrollBy({ left: dir * 200, behavior: 'smooth' })
}
function onWheel(e: WheelEvent) {
  const el = stripRef.value
  if (el && overflow.value && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY
}
/** The shown tab is kept in view when tabs come and go. */
function revealOwn() {
  const el = stripRef.value?.querySelector<HTMLElement>(`[data-tab="${ownId}"]`)
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
watch(() => docTabs.value.map(t => t.id).join(), () => nextTick(() => { measure(); revealOwn() }))
let ro: ResizeObserver | null = null
onMounted(() => {
  measure()
  if (stripRef.value) { ro = new ResizeObserver(measure); ro.observe(stripRef.value) }
})
onUnmounted(() => ro?.disconnect())
</script>

<style scoped>
.acro-tabbar {
  height: 36px; display: flex; align-items: stretch; background: var(--acro-tabbar);
  border-bottom: 1px solid var(--acro-rule-dark); user-select: none;
}
.tab {
  position: relative; border: 0; background: transparent; color: var(--acro-text); font: inherit; font-size: 15px;
  padding: 0 17px; cursor: pointer;
}
.tab:hover { color: var(--acro-text-strong); }
.tab.active { color: var(--acro-text-strong); }
.tab.active::after { content: ''; position: absolute; left: 17px; right: 17px; bottom: 1px; height: 2px; background: var(--acro-text-strong); }
.doc-strip {
  display: flex; align-items: stretch; flex: 0 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden;
  scrollbar-width: none;
}
.doc-strip::-webkit-scrollbar { display: none; }
.strip-arrow {
  flex: none; border: 0; background: transparent; color: var(--acro-text); width: 22px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; padding: 0;
}
.strip-arrow:hover { background: var(--acro-hover); color: var(--acro-text-strong); }
.doc-tab {
  display: flex; align-items: center; gap: 10px; flex: 0 1 220px; min-width: 110px; max-width: 220px; padding: 0 10px 0 24px;
  background: transparent; color: var(--acro-text); font-size: 13px; cursor: pointer; border-left: 1px solid var(--acro-border); border-right: 1px solid var(--acro-border);
}
.doc-tab + .doc-tab { border-left: 0; }
.doc-tab.dragging { opacity: 0.5; }
.doc-tab.active { background: var(--acro-bar); color: var(--acro-text-strong); }
.doc-name { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.doc-close { border: 0; background: transparent; color: var(--acro-text); width: 18px; height: 18px; border-radius: 3px; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; }
.doc-close:hover { background: var(--acro-hover); color: var(--acro-text-strong); }
.round-btn {
  position: relative; align-self: center; width: 32px; height: 32px; border-radius: 50%; border: 0; background: transparent;
  color: var(--acro-text); cursor: pointer; display: flex; align-items: center; justify-content: center; margin-right: 6px;
}
.round-btn:hover { background: var(--acro-hover); color: var(--acro-text-strong); }
.badge {
  position: absolute; top: 3px; right: 2px; min-width: 15px; height: 15px; border-radius: 8px; background: var(--acro-blue);
  color: #fff; font-size: 10px; line-height: 15px; padding: 0 3px;
}
.signin { border: 0; background: transparent; color: var(--acro-text-strong); font: inherit; font-size: 15px; font-weight: 700; padding: 0 20px 0 12px; cursor: pointer; }
.signin:hover { color: var(--acro-text-strong); }
</style>
