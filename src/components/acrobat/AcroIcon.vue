<template>
  <svg
    class="acro-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    :stroke="color"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- Crear archivo PDF: a page with the Acrobat swirl and a plus badge -->
    <template v-if="name === 'create'">
      <path d="M5 3.5h8.5l4 4V13" />
      <path d="M13.5 3.5v4h4" />
      <path d="M5 3.5v16h7" />
      <path d="M8.2 15.2c1.3-2.1 2.6-4.6 3.1-7 .2-1-.9-1.2-1 0-.2 1.9 1.4 4.6 3.2 5.6.9.5.5 1.2-.4 1-2-.3-4.4.2-6 1.2-.8.5-.3 1.3.4.6" stroke-width="1.1" />
      <circle cx="17.5" cy="17.5" r="4" :fill="color" stroke="none" />
      <path d="M17.5 15.3v4.4M15.3 17.5h4.4" stroke="#fff" stroke-width="1.4" />
    </template>

    <!-- Combinar archivos: two pages joining into one -->
    <template v-else-if="name === 'combine'">
      <path d="M3.5 4.5h7v9h-7z" />
      <path d="M5.5 7.5c.6-.9 1.2-2 1.4-3" stroke-width="1" />
      <path d="M13.5 4.5h7v9h-7z" />
      <path d="M7 13.5v3.5h10v-3.5" />
      <path d="M12 17v4M10 19l2 2 2-2" />
    </template>

    <!-- Organizar páginas: a page and a dashed page, an arrow between -->
    <template v-else-if="name === 'organize'">
      <path d="M13.5 4h6.5v15h-6.5z" />
      <path d="M4 9h6.5v10H4z" stroke-dasharray="1.6 1.6" />
      <path d="M5 6c1-2 3-3 6-2.6" />
      <path d="M9.6 1.8l1.6 1.6-1.6 1.6" />
    </template>

    <!-- Editar PDF: blocks of a page layout -->
    <template v-else-if="name === 'edit'">
      <path d="M4 4h16v5H4z" />
      <path d="M4 12h6v8H4z" />
      <path d="M13 13h7M13 16.5h7M13 20h7" />
    </template>

    <!-- Exportar archivo PDF: a page with an arrow leaving it -->
    <template v-else-if="name === 'export'">
      <path d="M5 3.5h8.5l4 4V11" />
      <path d="M13.5 3.5v4h4" />
      <path d="M5 3.5v16h6" />
      <path d="M8.2 14.5c1.2-2 2.4-4.2 2.9-6.4.2-1-.8-1.1-.9 0-.2 1.7 1.3 4.2 2.9 5.1" stroke-width="1.1" />
      <circle cx="17.5" cy="17.5" r="4" :fill="color" stroke="none" />
      <path d="M15.5 17.5h4M18 15.6l1.9 1.9-1.9 1.9" stroke="#fff" stroke-width="1.3" />
    </template>

    <!-- Digitalizar y OCR: a scanner with sparkles -->
    <template v-else-if="name === 'ocr'">
      <path d="M6.5 9V4h8l3 3v2" />
      <path d="M3.5 9h17v8h-17z" />
      <path d="M6.5 17v3.5h11V17" stroke-dasharray="1.5 1.5" />
      <path d="M17 12h1.5" />
      <path d="M20 2.5v2.5M18.75 3.75h2.5" stroke-width="1.1" />
      <path d="M3 2.8v2M2 3.8h2" stroke-width="1.1" />
    </template>

    <!-- Comentar: a speech balloon with lines -->
    <template v-else-if="name === 'comment'">
      <path d="M3.5 4.5h17v11h-9l-4.5 4v-4h-3.5z" />
      <path d="M7 8.5h10M7 11.5h7" />
    </template>

    <!-- Enviar para comentarios -->
    <template v-else-if="name === 'sendcomments'">
      <path d="M5 3.5h8.5l4 4V10" />
      <path d="M13.5 3.5v4h4" />
      <path d="M5 3.5v16h5" />
      <path d="M12 12h9v6h-4.5L14 20.5V18h-2z" />
    </template>

    <!-- Rellenar y firmar: a pen over a signature -->
    <template v-else-if="name === 'fillsign'">
      <path d="M14.5 4.5l4 4L9 18H5v-4z" />
      <path d="M12.5 6.5l4 4" />
      <path d="M3 21c2.5-1.5 4-1.5 5 0s2.5 1.5 4 0 3-1.5 4.5 0" stroke-width="1.1" />
    </template>

    <!-- Proteger: a shield -->
    <template v-else-if="name === 'protect'">
      <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z" />
    </template>

    <!-- Redactar: a marker and a black bar -->
    <template v-else-if="name === 'redact'">
      <path d="M4 15h11v4H4z" :fill="color" />
      <path d="M13 11l5.5-5.5 2 2L15 13h-2z" />
      <path d="M4 7.5h6M4 10.5h4" />
    </template>

    <!-- Sello: a rubber stamp -->
    <template v-else-if="name === 'stamp'">
      <circle cx="12" cy="6" r="2.8" />
      <path d="M10.6 8.5l-.6 4.5h4l-.6-4.5" />
      <path d="M5 13h14v3.5H5z" />
      <path d="M6.5 19.5h11" />
    </template>

    <!-- Medir: a ruler -->
    <template v-else-if="name === 'measure'">
      <path d="M3.5 9h17v6h-17z" />
      <path d="M7 15v-2.5M10 15v-3.5M13 15v-2.5M16 15v-3.5" stroke-width="1.1" />
    </template>

    <!-- Compartir -->
    <template v-else-if="name === 'share'">
      <path d="M9 9H5.5v11.5h13V9H15" />
      <path d="M12 15V3M8.5 6.5L12 3l3.5 3.5" />
    </template>

    <!-- Más herramientas: a wrench with a plus -->
    <template v-else-if="name === 'moretools'">
      <path d="M14.8 4.2a4 4 0 0 0-4.9 5.3L3.8 15.6a1.7 1.7 0 0 0 2.4 2.4l6.1-6.1a4 4 0 0 0 5.3-4.9l-2.4 2.4-2.1-.3-.3-2.1z" />
      <circle cx="18" cy="18" r="3.6" :fill="color" stroke="none" />
      <path d="M18 16.2v3.6M16.2 18h3.6" stroke="#fff" stroke-width="1.3" />
    </template>

    <!-- Medios enriquecidos / anything else: a page -->
    <template v-else>
      <path d="M6 3.5h8.5l3.5 3.5v13.5H6z" />
      <path d="M14.5 3.5V7H18" />
    </template>
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ name: string; color?: string; size?: number | string }>(), {
  color: 'currentColor',
  size: 24
})
</script>

<style scoped>
.acro-icon { display: block; flex: none; }
</style>
