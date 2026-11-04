<template>
  <!-- Acrobat's sticky-note icon, drawn exactly as the engine writes it into
       the note's appearance (noteAppearance in mupdf.worker.ts), so the note
       being written looks like the note it becomes. -->
  <svg class="note-icon" viewBox="0 0 20 20" :width="size" :height="size" aria-hidden="true">
    <rect x="0.3" y="0.3" width="19.4" height="19.4" rx="3" :fill="color" :stroke="darker(color)" stroke-width="0.6" />
    <path
      d="M6 13 L4.4 16.2 L9.4 13 L14 13 C15.105 13 16 12.105 16 11 L16 6.5 C16 5.395 15.105 4.5 14 4.5 L6 4.5 C4.895 4.5 4 5.395 4 6.5 L4 11 C4 12.105 4.895 13 6 13"
      fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
    />
    <path d="M6.9 7.3 L13.1 7.3 M6.9 10 L11.4 10" stroke="#fff" stroke-width="1.4" stroke-linecap="round" />
  </svg>
</template>

<script setup lang="ts">
import { darker } from '@/utils/acro/comments'

withDefaults(defineProps<{ color?: string; size?: number | string }>(), { color: '#ffd200', size: 20 })
</script>

<style scoped>
.note-icon { display: block; }
</style>
