<template>
  <n-layout :has-sider="!isMobileView" style="min-height: 100vh">
    <!-- 侧边栏 -->
    <SideNav ref="sideNavRef" />

    <!-- 主内容区 -->
    <n-layout-content class="app-main">
      <AppHeader :show-menu-btn="isMobileView" @toggle-menu="toggleMobileMenu" />
      <div class="app-content">
        <router-view />
      </div>
    </n-layout-content>
  </n-layout>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { NLayout, NLayoutContent } from 'naive-ui'
import SideNav from './SideNav.vue'
import AppHeader from './AppHeader.vue'
import { usePolling } from '../composables/usePolling'
import { useRealtime } from '../composables/useRealtime'
import { useRouteSync } from '../composables/useRouteSync'

const sideNavRef = ref<InstanceType<typeof SideNav> | null>(null)

/** 从 SideNav 同步 isMobile 状态，避免 has-sider 在移动端留空白 */
const isMobileView = computed(() => sideNavRef.value?.isMobile ?? false)

function toggleMobileMenu() {
  if (sideNavRef.value) {
    sideNavRef.value.mobileDrawerOpen = !sideNavRef.value.mobileDrawerOpen
  }
}

usePolling()
useRealtime()
useRouteSync()
</script>
