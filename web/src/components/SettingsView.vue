<template>
  <div class="settings-view">
    <SettingsPanel />
    <CategoryManager style="margin-top: 20px" />
    <AdvancedPanel style="margin-top: 20px" />
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue'

const SettingsPanel = defineAsyncComponent(() => import('./SettingsPanel.vue'))
const CategoryManager = defineAsyncComponent(() => import('./CategoryManager.vue'))
const AdvancedPanel = defineAsyncComponent(() => import('./AdvancedPanel.vue'))
</script>
