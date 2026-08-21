<template>
  <div class="row items-center no-wrap cursor-pointer color-swatch" @click.stop>
    <span v-if="label" class="text-caption q-mr-xs">{{ label }}</span>
    <div class="swatch" :style="{ background: modelValue }">
      <q-popup-proxy transition-show="scale" transition-hide="scale">
        <q-color
          :model-value="modelValue"
          @update:model-value="(v: string | null) => { if (v) emit('update:modelValue', v) }"
          no-header-tabs
          default-view="palette"
          format-model="hex"
          :palette="palette"
        />
      </q-popup-proxy>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ modelValue: string; label?: string }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const palette = [
  '#000000', '#5f6368', '#9aa0a6', '#ffffff',
  '#e53935', '#fb8c00', '#fdd835', '#ffeb3b',
  '#43a047', '#00897b', '#1e88e5', '#3949ab',
  '#8e24aa', '#d81b60', '#6d4c41', '#00acc1'
]
</script>

<style scoped>
.swatch {
  width: 22px; height: 22px; border-radius: 4px;
  border: 1.5px solid rgba(255,255,255,0.5);
  box-shadow: 0 0 0 1px rgba(0,0,0,0.3) inset;
}
</style>
