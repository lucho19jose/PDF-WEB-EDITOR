<template>
  <div class="row items-center full-height text-caption text-grey-5" style="font-size: 11px">
    <span>{{ editorStore.statusMessage }}</span>
    <!--
      The moment to ask for a failing document is the moment the edit failed:
      every engine fix so far began with one real PDF someone could not edit.
      The button shows only on a refusal, next to the line explaining it, and
      opens a pre-filled email — the user attaches the file, nothing from the
      document's content leaves the browser on its own.
    -->
    <q-btn
      v-if="showReport"
      flat dense no-caps size="xs" color="amber-4" icon="mail" label="Report this document"
      class="q-ml-sm" :href="reportHref" target="_blank"
    >
      <q-tooltip>Send this file to {{ SUPPORT_EMAIL }} so the problem can be fixed</q-tooltip>
    </q-btn>
    <q-space />
    <q-btn flat dense round size="xs" icon="help_outline" :href="reportHref" target="_blank" class="q-mr-sm">
      <q-tooltip>Report a problem — {{ SUPPORT_EMAIL }}</q-tooltip>
    </q-btn>
    <template v-if="docStore.loaded">
      <q-btn flat dense icon="chevron_left" size="xs" :disable="docStore.currentPage <= 1" @click="prevPage" />
      <span class="q-mx-xs">
        {{ docStore.currentPage }} / {{ docStore.totalPages }}
      </span>
      <q-btn flat dense icon="chevron_right" size="xs" :disable="docStore.currentPage >= docStore.totalPages" @click="nextPage" />
      <q-separator vertical inset class="q-mx-sm" />
      <span>{{ docStore.fileSizeFormatted }}</span>
      <!--
        The document's digital signatures. A signed contract says nothing about
        being signed anywhere else in this UI, and an edit breaks the signature
        silently — so the chip states both: that the file is signed, and, once
        `isModified`, that the edits have invalidated it. The list is as of the
        open (see the store); the modified flag is what changes the chip.
      -->
      <template v-if="signatures.length">
        <q-separator vertical inset class="q-mx-sm" />
        <q-chip
          dense square outline size="sm"
          class="sig-chip q-ma-none"
          :color="docStore.isModified ? 'amber-5' : 'teal-4'"
          :icon="docStore.isModified ? 'gpp_bad' : 'verified_user'"
          :label="sigLabel"
          data-testid="signature-chip"
        >
          <q-tooltip anchor="top right" self="bottom right" max-width="360px" class="sig-tooltip">
            <div class="text-weight-medium q-mb-xs">
              {{ signatures.length }} digital signature{{ signatures.length === 1 ? '' : 's' }}
              <span v-if="signers.length > 1"> · {{ signers.length }} signers</span>
            </div>
            <div v-for="(s, i) in tooltipRows" :key="i" class="sig-row">
              <span>{{ s.name || 'Signer not stated' }}</span>
              <span v-if="s.date" class="text-grey-5"> · {{ s.date }}</span>
              <span v-if="s.reason" class="text-grey-5"> · {{ s.reason }}</span>
              <span v-if="s.page >= 0" class="text-grey-5"> · p. {{ s.page + 1 }}</span>
            </div>
            <div v-if="signatures.length > tooltipRows.length" class="text-grey-5">
              … and {{ signatures.length - tooltipRows.length }} more
            </div>
            <div class="q-mt-xs" :class="docStore.isModified ? 'text-amber-5' : 'text-grey-4'">
              {{ docStore.isModified
                ? 'The document has been edited: its digital signatures are no longer valid.'
                : 'Editing the document will invalidate its digital signatures.' }}
            </div>
          </q-tooltip>
        </q-chip>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { SUPPORT_EMAIL, isRefusal, buildReportMailto } from '@/utils/reportProblem'

const docStore = useDocumentStore()
const editorStore = useEditorStore()

const showReport = computed(() => docStore.loaded && isRefusal(editorStore.statusMessage))
const reportHref = computed(() => buildReportMailto({
  status: editorStore.statusMessage,
  fileName: docStore.fileName,
  page: docStore.currentPage,
  pages: docStore.totalPages
}))

function prevPage() {
  if (docStore.currentPage > 1) docStore.setPage(docStore.currentPage - 1)
}
function nextPage() {
  if (docStore.currentPage < docStore.totalPages) docStore.setPage(docStore.currentPage + 1)
}

// ---- digital signatures ----

const signatures = computed(() => docStore.signatures)

/** Distinct signer names — an Intellisign contract holds one /Sig per signer PER PAGE. */
const signers = computed(() => {
  const names = new Set<string>()
  for (const s of signatures.value) if (s.name) names.add(s.name)
  return [...names]
})

/** Short and honest: the one signer's name when there is exactly one, else a count. */
const sigLabel = computed(() => {
  if (docStore.isModified) return 'Signature invalidated by edits'
  const n = signatures.value.length
  if (signers.value.length === 1) return `Signed by ${signers.value[0]}`
  return `Signed · ${n} signature${n === 1 ? '' : 's'}`
})

/** Newest first, capped: a 42-entry tooltip is a wall, not information. */
const TOOLTIP_ROWS = 8
const tooltipRows = computed(() => {
  const rows = signatures.value.map(s => ({ ...s, date: s.date ? s.date.replace('T', ' ').replace(/[+-]\d\d:\d\d$|Z$/, '') : undefined }))
  rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  return rows.slice(0, TOOLTIP_ROWS)
})
</script>

<style scoped>
.sig-chip {
  font-size: 11px;
  height: 18px;
  cursor: default;
}
.sig-row {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
