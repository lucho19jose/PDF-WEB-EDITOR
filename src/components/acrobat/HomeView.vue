<template>
  <div class="home" @dragover.prevent @drop.prevent="onDrop">
    <!-- Left navigation, as Acrobat's Inicio -->
    <nav class="home-nav">
      <button class="nav-item" :class="{ active: section === 'recent' }" @click="section = 'recent'">Recientes</button>
      <button class="nav-item" :class="{ active: section === 'starred' }" @click="section = 'starred'">Destacados</button>
      <div class="nav-head">Almacenamiento</div>
      <button class="nav-item" @click="shell.openFile()"><q-icon name="sym_o_computer" size="18px" /> Mi PC</button>
      <div class="nav-head">Otros archivos</div>
      <button class="nav-item" @click="shell.openTool('combine')"><q-icon name="sym_o_library_add" size="18px" /> Combinar archivos</button>
      <button class="nav-item" @click="shell.openTool('create')"><q-icon name="sym_o_add_photo_alternate" size="18px" /> Crear desde imágenes</button>
    </nav>

    <main class="home-main">
      <section class="welcome">
        <div class="welcome-text">
          <h1>Bienvenido a PDF Editor Pro.</h1>
          <p>Edite el texto y las imágenes de sus PDF, organice las páginas, comente, firme y proteja sus documentos. Todo ocurre en su equipo: los archivos no se envían a ningún servidor.</p>
        </div>
        <div class="welcome-actions">
          <button class="acro-pill primary" @click="shell.openFile()"><q-icon name="sym_o_folder_open" size="18px" /> Abrir archivo</button>
          <button class="acro-pill outline" @click="ui.view = 'tools'">Ver todas las herramientas</button>
        </div>
      </section>

      <div class="rec-title">Herramientas recomendadas para usted</div>
      <div class="rec-tools">
        <button v-for="t in recommended" :key="t.id" class="rec-card" @click="shell.openTool(t.id)">
          <AcroIcon :name="t.icon" :color="t.color" :size="34" />
          <div class="rec-name">{{ t.label }}</div>
          <div class="rec-desc">{{ descriptions[t.id] }}</div>
          <span class="rec-use">Usar ahora</span>
        </button>
      </div>

      <div class="list-head">
        <h2>{{ section === 'recent' ? 'Recientes' : 'Destacados' }}</h2>
        <q-space />
        <button v-if="section === 'recent' && files.length" class="clear-btn" @click="clearAll">Borrar recientes</button>
      </div>
      <table class="recent">
        <thead>
          <tr><th class="c-name">NOMBRE</th><th>ABIERTO</th><th>PÁGINAS</th><th>TAMAÑO</th><th class="c-act" /></tr>
        </thead>
        <tbody>
          <tr v-for="f in shown" :key="f.id" @dblclick="open(f)" @click="open(f)">
            <td class="c-name"><div class="name-cell">
              <img v-if="f.thumb" :src="f.thumb" class="mini" alt="" />
              <q-icon v-else name="picture_as_pdf" size="26px" color="red-5" class="mini-icon" />
              <span class="fname">{{ f.name }}</span>
              <q-icon v-if="starred.includes(f.name)" name="star" size="14px" color="amber-5" />
            </div></td>
            <td>{{ when(f.openedAt) }}</td>
            <td>{{ f.pages }}</td>
            <td>{{ size(f.size) }}</td>
            <td class="c-act">
              <button class="row-btn" title="Quitar de la lista" @click.stop="forget(f.id)"><q-icon name="sym_o_close" size="16px" /></button>
            </td>
          </tr>
          <tr v-if="!shown.length" class="empty-row">
            <td colspan="5">
              <div class="empty">
                <q-icon name="sym_o_draft" size="44px" />
                <div>{{ section === 'recent' ? 'Aún no ha abierto ningún archivo.' : 'No tiene archivos destacados.' }}</div>
                <div class="faint">Arrastre un PDF aquí o use "Abrir archivo".</div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, watch, onMounted } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useUiStore, toolInfo, type AcroTool } from '@/stores/ui'
import { listRecent, loadRecent, forgetRecent, clearRecent, type RecentFile } from '@/utils/acro/recentFiles'
import { persistedRef } from '@/utils/persist'
import AcroIcon from './AcroIcon.vue'
import type { AcroShell } from './acroShell'

const docStore = useDocumentStore()
const ui = useUiStore()
const shell = inject<AcroShell>('acroShell')!
const openPdfFile = inject<(f: File) => Promise<void>>('openPdfFile')!

const section = ref<'recent' | 'starred'>('recent')
const files = ref<RecentFile[]>([])
const starred = persistedRef<string[]>('ui.starred', [])
const shown = computed(() => section.value === 'starred' ? files.value.filter(f => starred.value.includes(f.name)) : files.value)

const recommended = (['edit', 'organize', 'combine', 'fillsign', 'export', 'protect'] as AcroTool[]).map(id => toolInfo(id)!)
const descriptions: Partial<Record<AcroTool, string>> = {
  edit: 'Edite el texto y las imágenes directamente en la página.',
  organize: 'Reordene, gire, inserte, extraiga y elimine páginas.',
  combine: 'Combine varios archivos en un único PDF.',
  fillsign: 'Rellene formularios y agregue su firma.',
  export: 'Convierta su PDF a Word, imágenes o texto.',
  protect: 'Proteja el archivo con contraseña o redacte información.'
}

async function refresh() { files.value = await listRecent() }
onMounted(refresh)
watch(() => [ui.view, docStore.fileName] as const, ([v]) => { if (v === 'home') refresh() })

async function open(f: RecentFile) {
  const bytes = await loadRecent(f.id)
  if (!bytes) { shell.commands.say(`${f.name} ya no está disponible`); await forget(f.id); return }
  await openPdfFile(new File([bytes as BlobPart], f.name, { type: 'application/pdf' }))
}
async function forget(id: string) { await forgetRecent(id); await refresh() }
async function clearAll() { await clearRecent(); await refresh() }
async function onDrop(e: DragEvent) {
  const f = e.dataTransfer?.files?.[0]
  if (f && /pdf$/i.test(f.type || f.name)) await openPdfFile(f)
  else if (e.dataTransfer?.files?.length) await shell.commands.createPdf([...e.dataTransfer.files].filter(shell.commands.isImage))
}

function when(t: number) {
  const d = new Date(t), now = new Date()
  const same = d.toDateString() === now.toDateString()
  return same ? `Hoy, ${d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}` : d.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' })
}
function size(b: number) {
  return b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`
}
</script>

<style scoped>
.home { display: flex; height: 100%; background: var(--acro-bar); color: var(--acro-text); }
.home-nav { width: 230px; flex: none; background: var(--acro-pane); border-right: 1px solid var(--acro-rule); padding: 18px 0; display: flex; flex-direction: column; }
.nav-item { display: flex; align-items: center; gap: 8px; text-align: left; border: 0; background: transparent; color: #e0e0e0; font: inherit; font-size: 14px; padding: 9px 24px; cursor: pointer; }
.nav-item:hover { background: var(--acro-hover); }
.nav-item.active { background: #5d5d5d; color: #fff; font-weight: 700; }
.nav-head { color: #9a9a9a; font-size: 12px; font-weight: 700; text-transform: uppercase; padding: 20px 24px 6px; }
.home-main { flex: 1; overflow-y: auto; padding: 28px 44px 60px; }
.welcome {
  display: flex; align-items: center; gap: 30px; padding: 26px 30px; border-radius: 6px;
  background: linear-gradient(100deg, #3b3f4a 0%, #464646 60%, #4d4d4d 100%); border: 1px solid #5a5a5a;
}
.welcome-text { flex: 1; }
.welcome h1 { font-size: 26px; font-weight: 700; margin: 0 0 8px; line-height: 1.2; color: #fff; }
.welcome p { margin: 0; color: #cfcfcf; font-size: 14px; max-width: 640px; line-height: 1.5; }
.welcome-actions { display: flex; flex-direction: column; gap: 10px; }
.rec-title { margin: 30px 0 14px; font-size: 16px; font-weight: 700; color: #f0f0f0; }
.rec-tools { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 14px; }
.rec-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 8px; text-align: left; padding: 18px 16px 14px;
  background: #424242; border: 1px solid #5a5a5a; border-radius: 6px; color: inherit; font: inherit; cursor: pointer;
}
.rec-card:hover { background: #484848; border-color: #7a7a7a; }
.rec-name { font-weight: 700; font-size: 14px; color: #fff; }
.rec-desc { font-size: 12px; color: #bdbdbd; line-height: 1.4; flex: 1; }
.rec-use { color: var(--acro-blue-text); font-size: 13px; font-weight: 700; }
.list-head { display: flex; align-items: center; margin: 34px 0 8px; }
.list-head h2 { font-size: 18px; margin: 0; font-weight: 700; color: #fff; line-height: 1.2; }
.clear-btn { border: 0; background: transparent; color: var(--acro-blue-text); cursor: pointer; font: inherit; }
.recent { width: 100%; border-collapse: collapse; font-size: 13px; }
.recent th { text-align: left; color: #a8a8a8; font-size: 11px; font-weight: 700; padding: 8px 10px; border-bottom: 1px solid #5c5c5c; }
.recent td { padding: 7px 10px; border-bottom: 1px solid #555; color: #dcdcdc; }
.recent tbody tr:not(.empty-row) { cursor: pointer; }
.recent tbody tr:not(.empty-row):hover td { background: #555; }
.c-name { width: 50%; }
.name-cell { display: flex; align-items: center; gap: 12px; }
.mini { width: 28px; height: 36px; object-fit: cover; object-position: top; background: #fff; border: 1px solid #666; }
.mini-icon { width: 28px; }
.fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #f0f0f0; }
.c-act { width: 40px; text-align: right; }
.row-btn { border: 0; background: transparent; color: #aaa; cursor: pointer; border-radius: 3px; display: inline-flex; padding: 2px; }
.row-btn:hover { background: #666; color: #fff; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px; color: #c8c8c8; }
.faint { color: #8a8a8a; font-size: 12px; }
</style>
