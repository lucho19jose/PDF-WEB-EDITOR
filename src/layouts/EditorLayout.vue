<template>
  <q-layout view="hHh lpR fFf" class="bg-dark">
    <!-- Header: Title + Toolbar -->
    <q-header class="bg-grey-10">
      <div class="title-bar q-px-md q-py-xs row items-center text-grey-4">
        <q-icon name="picture_as_pdf" size="sm" color="primary" class="q-mr-sm" />
        <span class="text-weight-bold">PDF Editor Pro v2</span>
        <span v-if="docStore.fileName" class="q-ml-md text-grey-6">
          {{ docStore.fileName }}{{ docStore.isModified ? ' *' : '' }}
        </span>
      </div>
      <MainToolbar />
    </q-header>

    <!-- Left Sidebar: Page Thumbnails -->
    <q-drawer
      v-model="sidebarOpen"
      side="left"
      :width="180"
      bordered
      class="bg-grey-10"
    >
      <PageThumbnails />
    </q-drawer>

    <!-- Main Content -->
    <q-page-container>
      <router-view />
    </q-page-container>

    <!-- Footer: Status Bar -->
    <q-footer class="bg-grey-10 q-px-md" style="height: 28px">
      <StatusBar />
    </q-footer>
  </q-layout>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useDocumentStore } from '@/stores/document'
import MainToolbar from '@/components/toolbar/MainToolbar.vue'
import PageThumbnails from '@/components/sidebar/PageThumbnails.vue'
import StatusBar from '@/components/common/StatusBar.vue'

const docStore = useDocumentStore()
const sidebarOpen = ref(true)
</script>
