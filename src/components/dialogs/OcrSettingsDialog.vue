<template>
  <q-dialog :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)">
    <q-card dark class="bg-grey-9" style="min-width: 420px">
      <q-card-section>
        <div class="text-subtitle1">OCR settings</div>
        <div class="text-caption text-grey-5">
          PaddleOCR and Tesseract run inside the browser and never send anything anywhere.
          Mistral OCR uploads the page image to Mistral's service and needs your own API key.
        </div>
      </q-card-section>
      <q-card-section class="q-pt-none">
        <q-input
          v-model="key"
          dark dense outlined
          label="Mistral API key"
          :type="reveal ? 'text' : 'password'"
          autocomplete="off"
          spellcheck="false"
        >
          <template #append>
            <q-icon :name="reveal ? 'visibility_off' : 'visibility'" class="cursor-pointer" @click="reveal = !reveal" />
          </template>
        </q-input>
        <div class="text-caption text-grey-6 q-mt-xs">
          Stored only in this browser (localStorage). Clear the field to forget it.
        </div>
      </q-card-section>
      <q-card-actions align="right">
        <q-btn flat label="Cancel" color="grey-4" @click="emit('update:modelValue', false)" />
        <q-btn unelevated label="Save" color="primary" @click="save" />
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
