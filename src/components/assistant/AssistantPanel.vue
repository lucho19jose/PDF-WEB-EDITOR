<template>
  <div class="assistant column full-height">
    <div class="row items-center q-px-sm q-py-xs assistant-head">
      <q-icon name="smart_toy" size="xs" color="primary" class="q-mr-xs" />
      <span class="text-caption text-weight-bold text-grey-3">Asistente</span>
      <q-space />
      <q-btn flat dense round icon="delete_sweep" size="sm" :disable="!assistant.messages.value.length" @click="assistant.clear()">
        <q-tooltip>Clear the conversation</q-tooltip>
      </q-btn>
      <q-btn flat dense round icon="settings" size="sm" @click="settingsOpen = true">
        <q-tooltip>API key and model</q-tooltip>
      </q-btn>
      <q-btn flat dense round icon="close" size="sm" @click="editorStore.assistantOpen = false">
        <q-tooltip>Close</q-tooltip>
      </q-btn>
    </div>

    <div ref="listRef" class="col scroll q-px-sm q-py-xs assistant-list">
      <div v-if="!assistant.messages.value.length" class="text-caption text-grey-6 q-pa-sm">
        <div class="q-mb-sm">Dime qué quieres cambiar en el PDF y lo hago. Por ejemplo:</div>
        <div v-for="ex in examples" :key="ex" class="example q-mb-xs" @click="draft = ex">“{{ ex }}”</div>
        <div v-if="!editorStore.openaiApiKey" class="q-mt-md text-warning">
          Falta la clave de OpenAI — ábrela con el engranaje de arriba.
        </div>
      </div>
      <div v-for="m in assistant.messages.value" :key="m.id" :class="['msg', `msg-${m.role}`]">
        <template v-if="m.role === 'tool'">
          <q-icon :name="m.ok ? 'check_circle' : 'error'" size="14px" :color="m.ok ? 'positive' : 'negative'" class="q-mr-xs" />
          <span>{{ m.text }}</span>
        </template>
        <template v-else>{{ m.text }}</template>
      </div>
      <div v-if="assistant.busy.value" class="msg msg-tool">
        <q-spinner-dots size="16px" color="primary" class="q-mr-xs" />
        <span>Trabajando…</span>
        <q-btn flat dense size="xs" label="Cancelar" class="q-ml-sm" @click="assistant.cancel()" />
      </div>
    </div>

    <div class="q-pa-sm assistant-input">
      <q-input
        v-model="draft"
        dark dense outlined autogrow
        type="textarea"
        :placeholder="docStore.loaded ? 'Escribe qué cambiar… (Enter para enviar)' : 'Abre un PDF primero'"
        :disable="!docStore.loaded || assistant.busy.value"
        @keydown.enter.exact.prevent="submit"
      >
        <template #append>
          <q-btn flat dense round icon="send" size="sm" :disable="!draft.trim() || assistant.busy.value || !docStore.loaded" @click="submit" />
        </template>
      </q-input>
    </div>

    <AssistantSettingsDialog v-model="settingsOpen" />
  </div>
</template>

<script setup lang="ts">
import { inject, nextTick, ref, watch } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import type { Assistant } from '@/composables/useAssistant'
import AssistantSettingsDialog from '@/components/dialogs/AssistantSettingsDialog.vue'

const docStore = useDocumentStore()
const editorStore = useEditorStore()
const assistant = inject<Assistant>('assistant')!

const draft = ref('')
const settingsOpen = ref(false)
const listRef = ref<HTMLElement | null>(null)

const examples = [
  'Cambia la fecha 05/09/2026 por 12/09/2026',
  'Borra la línea del teléfono',
  'Resalta en amarillo la palabra TOTAL',
  'Escribe "ANULADO" en rojo arriba del título'
]

async function submit() {
  const text = draft.value
  if (!text.trim() || assistant.busy.value) return
  draft.value = ''
  await assistant.send(text)
}

// Keep the newest line in view as the conversation grows.
watch(() => assistant.messages.value.length + (assistant.busy.value ? 1 : 0), async () => {
  await nextTick()
  const el = listRef.value
  if (el) el.scrollTop = el.scrollHeight
})
</script>

<style scoped>
.assistant { background: #1d1d1d; }
.assistant-head { border-bottom: 1px solid #333; }
.assistant-input { border-top: 1px solid #333; }
.assistant-list { font-size: 13px; }
.msg {
  border-radius: 8px;
  padding: 6px 10px;
  margin: 4px 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.35;
}
.msg-user { background: #2a3f5f; color: #e8eef7; margin-left: 24px; }
.msg-assistant { background: #2c2c2c; color: #eee; margin-right: 24px; }
.msg-tool { color: #9aa; font-size: 12px; padding: 2px 6px; display: flex; align-items: center; }
.msg-error { background: #4a2020; color: #ffb4b4; }
.example { cursor: pointer; color: #9cc4ff; }
.example:hover { text-decoration: underline; }
</style>
