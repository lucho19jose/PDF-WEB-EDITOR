<template>
  <div class="acro-menubar">
    <div v-for="m in menus" :key="m.label" class="menu-title" :class="{ open: openMenu === m.label }">
      <span><u>{{ m.label[0] }}</u>{{ m.label.slice(1) }}</span>
      <q-menu
        class="acro-menu" anchor="bottom left" self="top left" :offset="[0, 0]" auto-close
        @show="openMenu = m.label" @hide="openMenu === m.label && (openMenu = '')"
      >
        <q-list dense>
          <template v-for="(it, i) in m.items" :key="i">
            <q-separator v-if="it.sep" />
            <q-item v-else clickable :disable="it.disabled?.()" @click="it.run?.()">
              <q-item-section avatar>
                <q-icon v-if="it.icon" :name="it.icon" />
                <q-icon v-else-if="it.checked" name="check" />
              </q-item-section>
              <q-item-section>{{ it.label }}</q-item-section>
              <q-item-section v-if="it.key" side class="shortcut">{{ it.key }}</q-item-section>
            </q-item>
          </template>
        </q-list>
      </q-menu>
    </div>
    <q-space />
    <span class="app-name">{{ docStore.fileName ? `${docStore.fileName}${docStore.isModified ? ' *' : ''} - ` : '' }}PDF Editor Pro</span>
  </div>
</template>

<script setup lang="ts">
import { ref, inject } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useHistoryStore } from '@/stores/history'
import { useUiStore } from '@/stores/ui'
import type { AcroShell } from './acroShell'

const docStore = useDocumentStore()
const historyStore = useHistoryStore()
const ui = useUiStore()
const shell = inject<AcroShell>('acroShell')!
const openMenu = ref('')

interface Item { label?: string; icon?: string; key?: string; run?: () => void; disabled?: () => boolean; checked?: boolean; sep?: boolean }
const noDoc = () => !docStore.loaded
const sep: Item = { sep: true }

const menus: { label: string; items: Item[] }[] = [
  {
    label: 'Archivo',
    items: [
      { label: 'Abrir...', icon: 'sym_o_folder_open', key: 'Ctrl+O', run: shell.openFile },
      { label: 'Crear PDF...', icon: 'sym_o_note_add', run: () => shell.openTool('create') },
      { label: 'Combinar archivos...', icon: 'sym_o_library_add', run: () => shell.openTool('combine') },
      sep,
      { label: 'Guardar', icon: 'sym_o_save', key: 'Ctrl+S', run: shell.save, disabled: noDoc },
      { label: 'Guardar como...', key: 'Mayús+Ctrl+S', run: shell.saveAs, disabled: noDoc },
      { label: 'Guardar como otro ▸ Word (.docx)', run: () => shell.commands.exportAs('docx'), disabled: noDoc },
      { label: 'Guardar como otro ▸ Texto (.txt)', run: () => shell.commands.exportAs('txt'), disabled: noDoc },
      { label: 'Exportar a ▸ Imagen (PNG)...', run: () => ui.openDialog('export', { format: 'png' }), disabled: noDoc },
      sep,
      { label: 'Proteger mediante contraseña...', icon: 'sym_o_lock', run: () => ui.openDialog('protect'), disabled: noDoc },
      { label: 'Imprimir...', icon: 'sym_o_print', key: 'Ctrl+P', run: shell.print, disabled: noDoc },
      sep,
      { label: 'Propiedades...', key: 'Ctrl+D', run: () => ui.openDialog('properties'), disabled: noDoc },
      sep,
      { label: 'Cerrar archivo', key: 'Ctrl+W', run: shell.closeDocument, disabled: noDoc }
    ]
  },
  {
    label: 'Edición',
    items: [
      { label: 'Deshacer', icon: 'sym_o_undo', key: 'Ctrl+Z', run: shell.undo, disabled: () => !historyStore.canUndo },
      { label: 'Rehacer', icon: 'sym_o_redo', key: 'Mayús+Ctrl+Z', run: shell.redo, disabled: () => !historyStore.canRedo },
      sep,
      { label: 'Cortar', key: 'Ctrl+X', run: () => document.execCommand('cut') },
      { label: 'Copiar', key: 'Ctrl+C', run: () => document.execCommand('copy') },
      { label: 'Pegar', key: 'Ctrl+V', run: () => shell.paste() },
      sep,
      { label: 'Editar texto e imágenes', icon: 'sym_o_edit_document', run: () => shell.openTool('edit'), disabled: noDoc },
      { label: 'Redactar texto e imágenes', run: () => shell.openTool('redact'), disabled: noDoc },
      sep,
      { label: 'Buscar', icon: 'sym_o_search', key: 'Ctrl+F', run: shell.find, disabled: noDoc },
      sep,
      { label: 'Herramientas de administración', run: () => (ui.view = 'tools') },
      { label: 'Preferencias...', key: 'Ctrl+K', run: () => ui.openDialog('shortcuts') }
    ]
  },
  {
    label: 'Ver',
    items: [
      { label: 'Girar vista a la derecha', key: 'Mayús+Ctrl++', run: () => shell.rotateCurrent(90), disabled: noDoc },
      { label: 'Girar vista a la izquierda', key: 'Mayús+Ctrl+-', run: () => shell.rotateCurrent(-90), disabled: noDoc },
      sep,
      { label: 'Primera página', key: 'Inicio', run: () => docStore.setPage(1), disabled: noDoc },
      { label: 'Página anterior', key: 'Re Pág', run: () => docStore.setPage(docStore.currentPage - 1), disabled: noDoc },
      { label: 'Página siguiente', key: 'Av Pág', run: () => docStore.setPage(docStore.currentPage + 1), disabled: noDoc },
      { label: 'Última página', key: 'Fin', run: () => docStore.setPage(docStore.totalPages), disabled: noDoc },
      sep,
      { label: 'Acercar', icon: 'sym_o_zoom_in', key: 'Ctrl++', run: shell.zoomIn, disabled: noDoc },
      { label: 'Alejar', icon: 'sym_o_zoom_out', key: 'Ctrl+-', run: shell.zoomOut, disabled: noDoc },
      { label: 'Tamaño real', key: 'Ctrl+1', run: () => shell.setZoom(1), disabled: noDoc },
      { label: 'Ajustar página', key: 'Ctrl+0', run: shell.fitPage, disabled: noDoc },
      { label: 'Ajustar anchura', key: 'Ctrl+2', run: shell.fitWidth, disabled: noDoc },
      sep,
      { label: 'Visualización de página ▸ Desplazamiento continuo', run: () => (docStore.continuousScroll = true), disabled: noDoc },
      { label: 'Visualización de página ▸ Una sola página', run: () => (docStore.continuousScroll = false), disabled: noDoc },
      sep,
      { label: 'Mostrar/Ocultar ▸ Panel de navegación', key: 'F4', run: () => (ui.leftPaneOpen = !ui.leftPaneOpen) },
      { label: 'Mostrar/Ocultar ▸ Panel derecho', key: 'Mayús+F4', run: () => (ui.rightPaneOpen = !ui.rightPaneOpen) },
      { label: 'Modo de lectura', key: 'Ctrl+H', run: () => (ui.readMode = !ui.readMode), disabled: noDoc },
      { label: 'Modo de pantalla completa', key: 'Ctrl+L', run: shell.fullScreen }
    ]
  },
  {
    label: 'Ventana',
    items: [
      { label: 'Nueva ventana', run: () => window.open(location.href, '_blank') },
      sep,
      { label: 'Inicio', run: () => (ui.view = 'home') },
      { label: 'Herramientas', run: () => (ui.view = 'tools') },
      { label: 'Documento', run: () => (ui.view = 'document'), disabled: noDoc },
      sep,
      { label: 'Asistente de edición', icon: 'sym_o_smart_toy', run: shell.toggleAssistant }
    ]
  },
  {
    label: 'Ayuda',
    items: [
      { label: 'Ayuda de PDF Editor Pro', icon: 'sym_o_help', key: 'F1', run: () => ui.openDialog('shortcuts') },
      { label: 'Métodos abreviados de teclado', run: () => ui.openDialog('shortcuts') },
      sep,
      { label: 'Informar de un problema...', run: shell.reportProblem },
      sep,
      { label: 'Acerca de PDF Editor Pro...', run: () => ui.openDialog('about') }
    ]
  }
]
</script>

<style scoped>
.acro-menubar {
  height: 21px; display: flex; align-items: center; background: var(--acro-menubar);
  border-bottom: 1px solid var(--acro-rule-dark); padding: 0 4px; font-size: 12px; color: #e8e8e8;
  user-select: none;
}
.menu-title { padding: 1px 7px; cursor: default; border-radius: 2px; line-height: 17px; }
.menu-title:hover, .menu-title.open { background: #5a5a5a; }
.menu-title u { text-decoration: underline; text-underline-offset: 2px; }
.app-name { color: #9a9a9a; font-size: 12px; padding-right: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 50%; }
</style>
