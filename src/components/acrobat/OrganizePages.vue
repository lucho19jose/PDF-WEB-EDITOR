<template>
  <div
    class="organize" tabindex="0"
    @keydown="onKey"
    @click.self="ui.selectedPages = []"
    @dragover.prevent="onAreaDragOver"
    @drop.prevent="onAreaDrop"
  >
    <div ref="gridRef" class="grid" :style="{ '--tw': thumbW + 'px' }" @click.self="ui.selectedPages = []">
      <div
        v-for="p in docStore.totalPages" :key="p"
        class="cell"
        :class="{ selected: isSel(p - 1), dropBefore: dropAt === p - 1, dropAfter: dropAt === p && p === docStore.totalPages, dragging: draggingSet.has(p - 1) }"
        draggable="true"
        @click.stop="onClick($event, p - 1)"
        @dblclick.stop="openPage(p)"
        @dragstart="onDragStart($event, p - 1)"
        @dragend="onDragEnd"
        @dragover.prevent.stop="onCellDragOver($event, p - 1)"
        @drop.prevent.stop="onDrop($event)"
        @contextmenu.prevent="onContext(p - 1)"
      >
        <div class="card">
          <div class="frame">
            <ThumbImage :page="p" :width="thumbW" />
          </div>
          <!-- The hover column Acrobat shows beside a page -->
          <div class="hover-bar" @click.stop>
            <button title="Girar a la izquierda" @click="commands.rotatePages(targets(p - 1), -90)"><q-icon name="sym_o_rotate_left" /></button>
            <button title="Girar a la derecha" @click="commands.rotatePages(targets(p - 1), 90)"><q-icon name="sym_o_rotate_right" /></button>
            <button title="Eliminar páginas" @click="commands.deletePages(targets(p - 1))"><q-icon name="sym_o_delete" /></button>
            <button title="Insertar páginas">
              <q-icon name="sym_o_add_circle" />
              <q-menu class="acro-menu" anchor="bottom right" self="top left" auto-close>
                <q-list dense style="min-width: 210px">
                  <q-item clickable @click="insertFileAt(p)"><q-item-section avatar><q-icon name="sym_o_upload_file" /></q-item-section><q-item-section>Insertar desde archivo…</q-item-section></q-item>
                  <q-item clickable @click="commands.insertBlank(p)"><q-item-section avatar><q-icon name="sym_o_note" /></q-item-section><q-item-section>Página en blanco</q-item-section></q-item>
                </q-list>
              </q-menu>
            </button>
          </div>
          <div class="label">{{ p }}</div>
        </div>
      </div>
      <q-menu touch-position context-menu class="acro-menu" auto-close>
        <q-list dense style="min-width: 230px">
          <q-item clickable @click="commands.rotatePages(sel, -90)"><q-item-section avatar><q-icon name="sym_o_rotate_left" /></q-item-section><q-item-section>Girar a la izquierda</q-item-section></q-item>
          <q-item clickable @click="commands.rotatePages(sel, 90)"><q-item-section avatar><q-icon name="sym_o_rotate_right" /></q-item-section><q-item-section>Girar a la derecha</q-item-section></q-item>
          <q-item clickable @click="commands.duplicatePages(sel)"><q-item-section avatar><q-icon name="sym_o_content_copy" /></q-item-section><q-item-section>Duplicar</q-item-section></q-item>
          <q-item clickable @click="commands.extractPages(sel)"><q-item-section avatar><q-icon name="sym_o_move_up" /></q-item-section><q-item-section>Extraer</q-item-section></q-item>
          <q-item clickable @click="replaceSel"><q-item-section avatar><q-icon name="sym_o_find_replace" /></q-item-section><q-item-section>Reemplazar…</q-item-section></q-item>
          <q-item clickable @click="ui.openDialog('crop', { pages: sel })"><q-item-section avatar><q-icon name="sym_o_crop" /></q-item-section><q-item-section>Recortar…</q-item-section></q-item>
          <q-separator />
          <q-item clickable @click="commands.deletePages(sel)"><q-item-section avatar><q-icon name="sym_o_delete" /></q-item-section><q-item-section>Eliminar</q-item-section></q-item>
        </q-list>
      </q-menu>
    </div>

    <!-- Thumbnail size, bottom right, as in Acrobat -->
    <div class="zoom">
      <span v-if="sel.length" class="count">{{ sel.length }} de {{ docStore.totalPages }} seleccionadas</span>
      <button title="Reducir miniaturas" @click="thumbW = Math.max(70, thumbW - 30)"><q-icon name="sym_o_zoom_out" /></button>
      <input v-model.number="thumbW" type="range" min="70" max="420" step="10" />
      <button title="Ampliar miniaturas" @click="thumbW = Math.min(420, thumbW + 30)"><q-icon name="sym_o_zoom_in" /></button>
    </div>

    <div v-if="fileDrop" class="file-drop">Suelte los archivos para insertarlos en la posición {{ (dropAt ?? docStore.totalPages) + 1 }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, onMounted } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useUiStore } from '@/stores/ui'
import ThumbImage from './ThumbImage.vue'
import type { AcroShell } from './acroShell'

const docStore = useDocumentStore()
const ui = useUiStore()
const shell = inject<AcroShell>('acroShell')!
const pickFiles = inject<(accept: string, multiple: boolean) => Promise<File[]>>('pickFiles')!
const commands = shell.commands
const gridRef = ref<HTMLElement | null>(null)

const thumbW = computed({ get: () => ui.organizeThumbWidth, set: v => { ui.organizeThumbWidth = v } })
const sel = computed(() => [...ui.selectedPages].sort((a, b) => a - b))
const isSel = (i: number) => ui.selectedPages.includes(i)
/** A hover button acts on the selection when the page is part of it, else on that page alone. */
const targets = (i: number) => (isSel(i) && ui.selectedPages.length > 1 ? sel.value : [i])

let anchor = 0
function onClick(e: MouseEvent, i: number) {
  if (e.shiftKey) {
    const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)]
    ui.selectedPages = Array.from({ length: b - a + 1 }, (_, k) => a + k)
  } else if (e.ctrlKey || e.metaKey) {
    ui.selectedPages = isSel(i) ? ui.selectedPages.filter(x => x !== i) : [...ui.selectedPages, i]
    anchor = i
  } else {
    ui.selectedPages = [i]
    anchor = i
  }
}
function onContext(i: number) {
  if (!isSel(i)) { ui.selectedPages = [i]; anchor = i }
}

/** Double-click a page: back to the document, on that page — what Acrobat does. */
function openPage(p: number) {
  shell.closeTool()
  docStore.setPage(p)
}

async function insertFileAt(at: number) {
  const files = await pickFiles('application/pdf,.pdf,image/*', true)
  let pos = at
  for (const f of files) {
    const before = docStore.totalPages
    await commands.insertFile(f, pos)
    pos += docStore.totalPages - before
  }
}
async function replaceSel() {
  const [f] = await pickFiles('application/pdf,.pdf,image/*', false)
  if (f) await commands.replacePages(sel.value, f)
}

// ── drag to reorder (and files dropped from the desktop) ──
const dropAt = ref<number | null>(null)
const draggingSet = ref(new Set<number>())
const fileDrop = ref(false)
function onDragStart(e: DragEvent, i: number) {
  if (!isSel(i)) { ui.selectedPages = [i]; anchor = i }
  draggingSet.value = new Set(ui.selectedPages)
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-acro-pages', '1') }
}
function onDragEnd() { draggingSet.value = new Set(); dropAt.value = null }
function isFileDrag(e: DragEvent) { return !!e.dataTransfer && [...e.dataTransfer.types].includes('Files') }
function onCellDragOver(e: DragEvent, i: number) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropAt.value = e.clientX < r.left + r.width / 2 ? i : i + 1
  fileDrop.value = isFileDrag(e)
}
function onAreaDragOver(e: DragEvent) {
  fileDrop.value = isFileDrag(e)
  if (dropAt.value === null) dropAt.value = docStore.totalPages
}
async function onDrop(e: DragEvent) {
  const at = dropAt.value ?? docStore.totalPages
  dropAt.value = null
  fileDrop.value = false
  if (isFileDrag(e)) {
    let pos = at
    for (const f of [...e.dataTransfer!.files]) {
      const before = docStore.totalPages
      await commands.insertFile(f, pos)
      pos += docStore.totalPages - before
    }
    return
  }
  const moving = [...draggingSet.value]
  draggingSet.value = new Set()
  if (moving.length) await commands.movePages(moving, at)
}
const onAreaDrop = onDrop

// ── keyboard ──
function onKey(e: KeyboardEvent) {
  if ((e.target as HTMLElement).tagName === 'INPUT') return
  const n = docStore.totalPages
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); ui.selectedPages = Array.from({ length: n }, (_, k) => k); return }
  if (e.key === 'Delete' && sel.value.length) { e.preventDefault(); commands.deletePages(sel.value); return }
  if (e.key === 'Enter' && sel.value.length) { e.preventDefault(); openPage(sel.value[0] + 1); return }
  const cur = sel.value.length ? (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? sel.value[0] : sel.value[sel.value.length - 1]) : -1
  const perRow = Math.max(1, Math.floor((gridRef.value?.clientWidth ?? 800) / (thumbW.value + 90)))
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -perRow, ArrowDown: perRow } as Record<string, number>
  if (e.key in step) {
    e.preventDefault()
    const next = Math.max(0, Math.min(n - 1, cur < 0 ? 0 : cur + step[e.key]))
    if (e.shiftKey) {
      const [a, b] = [Math.min(anchor, next), Math.max(anchor, next)]
      ui.selectedPages = Array.from({ length: b - a + 1 }, (_, k) => a + k)
    } else { ui.selectedPages = [next]; anchor = next }
  }
}

onMounted(() => {
  if (!ui.selectedPages.length) ui.selectedPages = [docStore.currentPage - 1]
  ;(gridRef.value?.parentElement as HTMLElement | null)?.focus()
})
</script>

<style scoped>
.organize { position: relative; height: 100%; overflow: auto; background: var(--acro-bar); outline: none; }
.grid { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 28px 16px; padding: 44px 40px 90px; min-height: 100%; }
.cell { position: relative; padding: 0 10px; }
.card {
  position: relative; display: flex; flex-direction: column; align-items: center; padding: 30px 40px 6px 40px;
  border: 2px solid transparent; border-radius: 2px;
}
.cell.selected .card { background: var(--acro-select); border-color: var(--acro-select-border); }
.cell.dragging .card { opacity: 0.4; }
.frame { box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6); background: #fff; line-height: 0; }
.label { margin-top: 14px; font-size: 13px; color: #e6e6e6; }
.cell.selected .label { color: #1e5a96; }
.hover-bar {
  position: absolute; right: -8px; top: 26px; display: none; flex-direction: column; gap: 8px;
  background: #323232; border-radius: 3px; padding: 6px 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45); z-index: 2;
}
.cell:hover .hover-bar { display: flex; }
.hover-bar button { width: 36px; height: 36px; border: 0; background: transparent; color: #f0f0f0; border-radius: 3px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.hover-bar button:hover { background: #4f4f4f; }
.hover-bar .q-icon { font-size: 24px; }
.cell.dropBefore::before, .cell.dropAfter::after {
  content: ''; position: absolute; top: 20px; bottom: 20px; width: 3px; background: var(--acro-blue); border-radius: 2px;
}
.cell.dropBefore::before { left: -10px; }
.cell.dropAfter::after { right: -10px; }
.zoom {
  position: sticky; bottom: 12px; float: right; margin: -60px 18px 0 0; display: flex; align-items: center; gap: 6px;
  background: #323232; border-radius: 16px; padding: 4px 10px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5); z-index: 3;
}
.zoom button { border: 0; background: transparent; color: #ddd; cursor: pointer; display: flex; padding: 2px; border-radius: 50%; }
.zoom button:hover { background: #555; }
.zoom input[type=range] { width: 120px; accent-color: #ccc; }
.zoom .count { color: #cfcfcf; font-size: 12px; margin-right: 8px; }
.file-drop {
  position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); background: var(--acro-blue); color: #fff;
  padding: 8px 18px; border-radius: 18px; font-weight: 700; pointer-events: none; z-index: 5;
}
</style>
