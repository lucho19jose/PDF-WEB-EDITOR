<template>
  <q-dialog :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)">
    <q-card dark class="bg-grey-9" style="min-width: 440px">
      <q-card-section>
        <div class="text-subtitle1">Assistant settings</div>
        <div class="text-caption text-grey-5">
          The assistant sends the text of the page you are on, and your messages, to OpenAI
          with your own API key. Nothing is sent until you write to it.
        </div>
      </q-card-section>
      <q-card-section class="q-pt-none">
        <q-input
          v-model="key"
          dark dense outlined
          label="OpenAI API key"
          :type="reveal ? 'text' : 'password'"
          autocomplete="off"
          spellcheck="false"
        >
          <template #append>
            <q-icon :name="reveal ? 'visibility_off' : 'visibility'" class="cursor-pointer" @click="reveal = !reveal" />
          </template>
        </q-input>
        <div class="text-caption text-grey-6 q-mt-xs q-mb-md">
          Stored only in this browser (localStorage). Clear the field to forget it.
        </div>
        <q-input v-model="model" dark dense outlined label="Model" placeholder="gpt-4o-mini" spellcheck="false" />
        <div class="text-caption text-grey-6 q-mt-xs q-mb-md">
          Any chat model with tool calling, e.g. gpt-4o-mini (cheap) or gpt-4o.
        </div>
        <q-input v-model="endpoint" dark dense outlined label="Endpoint (optional)" placeholder="https://api.openai.com/v1/chat/completions" spellcheck="false" />
        <div class="text-caption text-grey-6 q-mt-xs">
          Leave empty for the public API. Set a same-origin proxy URL if the API refuses this browser.
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
