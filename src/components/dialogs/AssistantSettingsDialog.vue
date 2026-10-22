<template>
  <q-dialog :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)">
    <q-card class="acro-card" style="min-width: 440px">
      <q-card-section>
        <div class="text-subtitle1">Configuración del asistente</div>
        <div class="text-caption text-grey-5">
          El asistente envía a OpenAI, con su propia clave de API, el texto de la página en la
          que está y sus mensajes. No se envía nada hasta que usted le escribe.
        </div>
      </q-card-section>
      <q-card-section class="q-pt-none">
        <q-input
          v-model="key"
          dense outlined
          label="Clave de API de OpenAI"
          :type="reveal ? 'text' : 'password'"
          autocomplete="off"
          spellcheck="false"
        >
          <template #append>
            <q-icon :name="reveal ? 'visibility_off' : 'visibility'" class="cursor-pointer" @click="reveal = !reveal" />
          </template>
        </q-input>
        <div class="text-caption text-grey-6 q-mt-xs q-mb-md">
          Se guarda solo en este navegador (localStorage). Vacíe el campo para olvidarla.
        </div>
        <q-input v-model="model" dense outlined label="Modelo" placeholder="gpt-4o-mini" spellcheck="false" />
        <div class="text-caption text-grey-6 q-mt-xs q-mb-md">
          Cualquier modelo de chat con llamadas a herramientas, p. ej. gpt-4o-mini (económico) o gpt-4o.
        </div>
        <q-input v-model="endpoint" dense outlined label="Endpoint (opcional)" placeholder="https://api.openai.com/v1/chat/completions" spellcheck="false" />
        <div class="text-caption text-grey-6 q-mt-xs">
          Déjelo vacío para usar la API pública. Indique la URL de un proxy del mismo origen si la API rechaza este navegador.
        </div>
      </q-card-section>
      <q-card-actions align="right">
        <q-btn flat label="Cancelar" color="grey-4" @click="emit('update:modelValue', false)" />
        <q-btn unelevated label="Guardar" color="primary" @click="save" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useEditorStore } from '@/stores/editor'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()
const editorStore = useEditorStore()

const key = ref(editorStore.openaiApiKey)
const model = ref(editorStore.openaiModel)
const endpoint = ref(editorStore.openaiEndpoint)
const reveal = ref(false)
watch(() => props.modelValue, open => {
  if (open) {
    key.value = editorStore.openaiApiKey
    model.value = editorStore.openaiModel
    endpoint.value = editorStore.openaiEndpoint
    reveal.value = false
  }
})

function save() {
  editorStore.openaiApiKey = key.value.trim()
  editorStore.openaiModel = model.value.trim() || 'gpt-4o-mini'
  editorStore.openaiEndpoint = endpoint.value.trim()
  emit('update:modelValue', false)
}
</script>
