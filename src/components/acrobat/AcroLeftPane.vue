<template>
  <div class="acro-leftpane" :class="{ open: ui.leftPaneOpen }">
    <!-- The strip of panel icons, and the arrow that opens and closes the pane. -->
    <div class="strip">
      <template v-if="ui.leftPaneOpen">
        <button class="strip-btn" :class="{ active: ui.leftPanel === 'thumbs' }" @click="ui.leftPanel = 'thumbs'">
          <q-icon name="sym_o_auto_stories" size="20px" /><q-tooltip anchor="center right" self="center left">Miniaturas de página</q-tooltip>
        </button>
        <button class="strip-btn" :class="{ active: ui.leftPanel === 'bookmarks' }" @click="ui.leftPanel = 'bookmarks'">
          <q-icon name="sym_o_bookmark" size="20px" /><q-tooltip anchor="center right" self="center left">Marcadores</q-tooltip>
        </button>
      </template>
      <button class="toggle" :class="{ open: ui.leftPaneOpen }" @click="ui.leftPaneOpen = !ui.leftPaneOpen">
        <q-icon name="arrow_right" size="20px" />
        <q-tooltip anchor="center right" self="center left">{{ ui.leftPaneOpen ? 'Ocultar el panel de navegación' : 'Mostrar el panel de navegación' }}</q-tooltip>
      </button>
    </div>

    <div v-if="ui.leftPaneOpen" class="panel">
      <!-- ═════ Miniaturas de página ═════ -->
      <template v-if="ui.leftPanel === 'thumbs'">
        <div class="panel-head">
          <span>Miniaturas de página</span>
          <q-space />
          <button class="acro-ibtn small" title="Opciones">
            <q-icon name="sym_o_more_horiz" />
            <q-menu class="acro-menu" auto-close>
              <q-list dense style="min-width: 230px">
                <q-item clickable @click="ui.openDialog('insertPages', { mode: 'file' })"><q-item-section>Insertar páginas desde archivo…</q-item-section></q-item>
                <q-item clickable @click="commands.insertBlank(docStore.currentPage)"><q-item-section>Insertar página en blanco</q-item-section></q-item>
                <q-item clickable @click="ui.openDialog('extract')"><q-item-section>Extraer páginas…</q-item-section></q-item>
                <q-item clickable :disable="!sel.length" @click="commands.deletePages(sel)"><q-item-section>Eliminar páginas…</q-item-section></q-item>
                <q-item clickable :disable="!sel.length" @click="commands.rotatePages(sel, 90)"><q-item-section>Girar páginas</q-item-section></q-item>
                <q-item clickable @click="ui.openDialog('crop', { pages: sel.length ? sel : [docStore.currentPage - 1] })"><q-item-section>Recortar páginas…</q-item-section></q-item>
                <q-separator />
                <q-item clickable @click="thumbSize = Math.min(240, thumbSize + 30)"><q-item-section>Ampliar miniaturas de página</q-item-section></q-item>
                <q-item clickable @click="thumbSize = Math.max(80, thumbSize - 30)"><q-item-section>Reducir miniaturas de página</q-item-section></q-item>
              </q-list>
            </q-menu>
          </button>
        </div>
        <div class="tool-row">
          <button class="acro-ibtn small" :disabled="!docStore.loaded" title="Eliminar páginas" @click="commands.deletePages(sel.length ? sel : [docStore.currentPage - 1])"><q-icon name="sym_o_delete" /></button>
          <button class="acro-ibtn small" :disabled="!docStore.loaded" title="Girar a la derecha" @click="commands.rotatePages(sel.length ? sel : [docStore.currentPage - 1], 90)"><q-icon name="sym_o_rotate_right" /></button>
          <button class="acro-ibtn small" :disabled="!docStore.loaded" title="Insertar página en blanco" @click="commands.insertBlank(docStore.currentPage)"><q-icon name="sym_o_note_add" /></button>
        </div>
        <div ref="listRef" class="thumb-list">
          <div
            v-for="p in docStore.totalPages" :key="p"
            :ref="el => setItem(el, p)"
            class="thumb-item"
            :class="{ current: p === docStore.currentPage, selected: ui.selectedPages.includes(p - 1), dropBefore: dropAt === p - 1, dropAfter: dropAt === p && p === docStore.totalPages }"
            draggable="true"
            @click="onClick($event, p)"
            @contextmenu.prevent="onContext(p)"
            @dragstart="onDragStart($event, p)"
            @dragover.prevent="onDragOver($event, p)"
            @dragleave="dropAt = null"
            @drop.prevent="onDrop"
          >
            <div class="thumb-frame">
              <ThumbImage :page="p" :width="thumbSize" />
            </div>
            <div class="thumb-label">{{ p }}</div>
          </div>
          <q-menu touch-position context-menu class="acro-menu" auto-close>
            <q-list dense style="min-width: 220px">
              <q-item clickable @click="ui.openDialog('insertPages', { mode: 'file', at: ctxPage })"><q-item-section>Insertar páginas…</q-item-section></q-item>
              <q-item clickable @click="commands.insertBlank(ctxPage)"><q-item-section>Insertar página en blanco</q-item-section></q-item>
              <q-item clickable @click="commands.extractPages(ctxSel())"><q-item-section>Extraer páginas</q-item-section></q-item>
              <q-item clickable @click="commands.duplicatePages(ctxSel())"><q-item-section>Duplicar páginas</q-item-section></q-item>
              <q-item clickable @click="commands.rotatePages(ctxSel(), 90)"><q-item-section>Girar páginas</q-item-section></q-item>
              <q-item clickable @click="commands.deletePages(ctxSel())"><q-item-section>Eliminar páginas…</q-item-section></q-item>
              <q-separator />
              <q-item clickable @click="shell.print()"><q-item-section>Imprimir…</q-item-section></q-item>
            </q-list>
          </q-menu>
        </div>
      </template>

      <!-- ═════ Marcadores ═════ -->
      <template v-else-if="ui.leftPanel === 'bookmarks'">
        <div class="panel-head"><span>Marcadores</span></div>
        <div class="bm-list">
          <div v-if="!bookmarks.length" class="empty">Este documento no tiene marcadores.</div>
          <BookmarkNode v-for="(b, i) in bookmarks" :key="i" :node="b" :depth="0" @go="goBookmark" />
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, watch, nextTick, defineComponent, h, type PropType } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useUiStore } from '@/stores/ui'
import { persistedRef } from '@/utils/persist'
import ThumbImage from './ThumbImage.vue'
import type { AcroShell } from './acroShell'

const docStore = useDocumentStore()
const ui = useUiStore()
const shell = inject<AcroShell>('acroShell')!
const commands = shell.commands
const thumbSize = persistedRef<number>('ui.leftThumbSize', 110)
const sel = computed(() => [...ui.selectedPages].sort((a, b) => a - b))

// ── selection ──
let anchor = 0
function onClick(e: MouseEvent, p: number) {
  const i = p - 1
  if (e.shiftKey) {
    const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)]
    ui.selectedPages = Array.from({ length: b - a + 1 }, (_, k) => a + k)
  } else if (e.ctrlKey || e.metaKey) {
    ui.selectedPages = ui.selectedPages.includes(i) ? ui.selectedPages.filter(x => x !== i) : [...ui.selectedPages, i]
    anchor = i
  } else {
    ui.selectedPages = [i]
    anchor = i
  }
  docStore.setPage(p)
}

// ── keep the current page in view ──
const items = new Map<number, HTMLElement>()
const listRef = ref<HTMLElement | null>(null)
function setItem(el: any, p: number) { if (el) items.set(p, el); else items.delete(p) }
watch(() => docStore.currentPage, p => nextTick(() => {
  const el = items.get(p), list = listRef.value
  if (!el || !list) return
  const top = el.offsetTop - list.offsetTop, bottom = top + el.offsetHeight
  if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) list.scrollTo({ top: top - list.clientHeight / 2 + el.offsetHeight / 2, behavior: 'smooth' })
}))

// ── drag to reorder ──
const dropAt = ref<number | null>(null)
let dragging: number[] = []
function onDragStart(e: DragEvent, p: number) {
  dragging = ui.selectedPages.includes(p - 1) ? [...ui.selectedPages] : [p - 1]
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(p)) }
}
function onDragOver(e: DragEvent, p: number) {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  dropAt.value = e.clientY < r.top + r.height / 2 ? p - 1 : p
}
async function onDrop() {
  const at = dropAt.value
  dropAt.value = null
  if (at === null || !dragging.length) return
  await commands.movePages(dragging, at)
  dragging = []
}

// ── context menu ──
const ctxPage = ref(1)
function onContext(p: number) {
  ctxPage.value = p
  if (!ui.selectedPages.includes(p - 1)) ui.selectedPages = [p - 1]
}
function ctxSel() { return sel.value.length ? sel.value : [ctxPage.value - 1] }

// ── bookmarks ──
interface Bm { title: string; page: number | null; uri: string | null; open: boolean; children: Bm[] }
const bookmarks = ref<Bm[]>([])
async function loadBookmarks() {
  if (!docStore.loaded) { bookmarks.value = []; return }
  bookmarks.value = await commands.outline().catch(() => [])
}
watch(() => [ui.leftPaneOpen, ui.leftPanel, docStore.fileName, docStore.loaded] as const, () => {
  if (ui.leftPaneOpen && ui.leftPanel === 'bookmarks') loadBookmarks()
}, { immediate: true })
function goBookmark(b: Bm) {
  if (b.page !== null) docStore.setPage(b.page + 1)
  else if (b.uri && /^https?:/i.test(b.uri)) window.open(b.uri, '_blank', 'noopener')
}

const BookmarkNode: any = defineComponent({
  name: 'BookmarkNode',
  props: { node: { type: Object as PropType<Bm>, required: true }, depth: { type: Number, default: 0 } },
  emits: ['go'],
  setup(props, { emit }) {
    const open = ref(props.node.open)
    return () => h('div', { class: 'bm-node' }, [
      h('div', { class: 'bm-row', style: { paddingLeft: `${8 + props.depth * 14}px` }, onClick: () => emit('go', props.node) }, [
        props.node.children.length
          ? h('span', { class: 'bm-tw', onClick: (e: Event) => { e.stopPropagation(); open.value = !open.value } }, open.value ? '▾' : '▸')
          : h('span', { class: 'bm-tw' }, ''),
        h('span', { class: 'bm-title' }, props.node.title || '(sin título)')
      ]),
      open.value ? props.node.children.map((c, i) => h(BookmarkNode, { key: i, node: c, depth: props.depth + 1, onGo: (n: Bm) => emit('go', n) })) : null
    ])
  }
})
</script>

<style scoped>
.acro-leftpane { display: flex; height: 100%; flex: none; background: var(--acro-pane); border-right: 1px solid var(--acro-rule); }
.strip { width: 18px; display: flex; flex-direction: column; align-items: center; position: relative; }
.acro-leftpane.open .strip { width: 36px; padding-top: 8px; gap: 4px; border-right: 1px solid var(--acro-rule); }
.strip-btn { width: 30px; height: 30px; border: 0; border-radius: 3px; background: transparent; color: #cfcfcf; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.strip-btn:hover { background: var(--acro-hover); }
.strip-btn.active { color: var(--acro-blue-text); background: #3a3a3a; }
.toggle {
  position: absolute; top: 50%; transform: translateY(-50%); width: 18px; height: 40px; border: 0; background: transparent;
  color: #c2c2c2; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center;
}
.toggle:hover { color: #fff; }
.acro-leftpane.open .toggle { width: 36px; }
.toggle.open .q-icon { transform: rotate(180deg); }
.panel { width: 210px; display: flex; flex-direction: column; min-height: 0; }
.panel-head { display: flex; align-items: center; height: 38px; padding: 0 6px 0 12px; font-weight: 700; font-size: 13px; color: #f0f0f0; border-bottom: 1px solid var(--acro-rule); }
.tool-row { display: flex; gap: 2px; padding: 4px 8px; border-bottom: 1px solid var(--acro-rule); }
.thumb-list { flex: 1; overflow-y: auto; padding: 12px 0 24px; }
.thumb-item { display: flex; flex-direction: column; align-items: center; padding: 6px 0; cursor: pointer; position: relative; }
.thumb-frame { padding: 4px; border: 2px solid transparent; border-radius: 2px; }
.thumb-item:hover .thumb-frame { border-color: #777; }
.thumb-item.selected .thumb-frame { border-color: var(--acro-select-border); background: rgba(33, 117, 200, 0.25); }
.thumb-item.current .thumb-frame { border-color: var(--acro-blue); }
.thumb-label { font-size: 12px; color: #d0d0d0; margin-top: 4px; }
.thumb-item.current .thumb-label { color: #fff; font-weight: 700; }
.thumb-item.dropBefore::before, .thumb-item.dropAfter::after {
  content: ''; position: absolute; left: 20px; right: 20px; height: 3px; background: var(--acro-blue); border-radius: 2px;
}
.thumb-item.dropBefore::before { top: -1px; }
.thumb-item.dropAfter::after { bottom: -1px; }
.bm-list { flex: 1; overflow-y: auto; padding: 6px 0; }
.empty { color: #9a9a9a; font-size: 12px; padding: 14px; }
:deep(.bm-row) { display: flex; align-items: center; gap: 4px; padding: 4px 8px; cursor: pointer; color: #e6e6e6; font-size: 13px; }
:deep(.bm-row:hover) { background: var(--acro-hover); }
:deep(.bm-tw) { width: 12px; color: #aaa; font-size: 11px; flex: none; }
:deep(.bm-title) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
