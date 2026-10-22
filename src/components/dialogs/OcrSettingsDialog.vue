<template>
  <q-dialog :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)">
    <q-card class="acro-card" style="min-width: 420px">
      <q-card-section>
        <div class="text-subtitle1">Configuración de OCR</div>
        <div class="text-caption text-grey-5">
          PaddleOCR y Tesseract funcionan dentro del navegador y no envían nada a ninguna parte.
          Mistral OCR sube la imagen de la página al servicio de Mistral y necesita su propia clave de API.
        </div>
      </q-card-section>
      <q-card-section class="q-pt-none">
        <q-input
          v-model="key"
          dense outlined
          label="Clave de API de Mistral"
          :type="reveal ? 'text' : 'password'"
          autocomplete="off"
          spellcheck="false"
        >
          <template #append>
            <q-icon :name="reveal ? 'visibility_off' : 'visibility'" class="cursor-pointer" @click="reveal = !reveal" />
          </template>
        </q-input>
        <div class="text-caption text-grey-6 q-mt-xs">
          Se guarda solo en este navegador (localStorage). Vacíe el campo para olvidarla.
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

const key = ref(editorStore.mistralApiKey)
const reveal = ref(false)
watch(() => props.modelValue, open => { if (open) { key.value = editorStore.mistralApiKey; reveal.value = false } })

function save() {
  editorStore.mistralApiKey = key.value.trim()
  emit('update:modelValue', false)
}
</script>
