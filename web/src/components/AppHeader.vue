<template>
  <div class="app-topbar">
    <div class="topbar-left">
      <!-- 移动端汉堡菜单按钮 -->
      <n-button
        v-if="showMenuBtn"
        quaternary
        circle
        size="small"
        style="margin-right: 4px"
        @click="$emit('toggle-menu')"
      >
        <template #icon>
          <n-icon><MenuOutline /></n-icon>
        </template>
      </n-button>

      <n-button
        v-if="state.currentView === 'detail'"
        quaternary
        style="margin-right: 8px"
        @click="backToLibrary"
      >
        <template #icon>
          <n-icon><ArrowBackOutline /></n-icon>
        </template>
        返回图库
      </n-button>

      <n-h3 v-if="state.currentView === 'library'" style="margin: 0">
        {{ state.favoritesOnly ? '收藏' : '图库' }}
      </n-h3>
      <n-h3 v-else-if="state.currentView === 'detail'" style="margin: 0">
        {{ state.activeSeries?.title ?? '详情' }}
      </n-h3>
      <n-h3 v-else style="margin: 0">
        设置
      </n-h3>
    </div>

    <div class="topbar-right">
      <div v-if="effectiveScanProgress" class="scan-progress-inline">
        <n-text depth="3" style="font-size: 12px; white-space: nowrap">
          <template v-if="effectiveScanProgress.phase === 'collecting'">收集目录...</template>
          <template v-else-if="effectiveScanProgress.phase === 'scanning'">
            {{ effectiveScanProgress.currentDir }} ({{ effectiveScanProgress.current }}/{{ effectiveScanProgress.total }})
          </template>
          <template v-else>整理结果...</template>
        </n-text>
        <n-progress
          type="line"
          :percentage="progressPercentage"
          :show-indicator="false"
          :height="3"
          :processing="true"
          style="width: 100px"
        />
      </div>

      <n-button
        quaternary
        circle
        size="small"
        :title="darkModeTitle"
        @click="cycleDarkMode"
      >
        <template #icon>
          <n-icon>
            <MoonOutline v-if="state.darkMode === null" />
            <SunnyOutline v-else-if="state.darkMode === true" />
            <DesktopOutline v-else />
          </n-icon>
        </template>
      </n-button>

      <n-button
        type="primary"
        size="small"
        :loading="state.scanning"
        :disabled="state.scanning"
        @click="handleScan"
      >
        {{ state.scanning ? '扫描中' : '扫描' }}
      </n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NButton, NH3, NIcon, NProgress, NText, useMessage } from 'naive-ui'
import { ArrowBackOutline, DesktopOutline, MenuOutline, MoonOutline, SunnyOutline } from '@vicons/ionicons5'
import type { ScanProgress } from '../api'
import { api } from '../api'
import { useAppState } from '../composables/useAppState'

const { state, backToLibrary, runScan, setDarkMode } = useAppState()
const message = useMessage()

defineProps<{
  showMenuBtn?: boolean
}>()

defineEmits<{
  'toggle-menu': []
}>()

const fallbackScanProgress = ref<ScanProgress | null>(null)
let progressTimer: ReturnType<typeof setInterval> | null = null

const effectiveScanProgress = computed(() => state.liveScanProgress ?? fallbackScanProgress.value)

const progressPercentage = computed(() => {
  if (!effectiveScanProgress.value) return 0
  if (effectiveScanProgress.value.phase === 'collecting') return 0
  if (effectiveScanProgress.value.phase === 'finalizing') return 99
  if (effectiveScanProgress.value.total === 0) return 0
  return Math.round((effectiveScanProgress.value.current / effectiveScanProgress.value.total) * 100)
})

const darkModeTitle = computed(() => {
  if (state.darkMode === null) return '跟随系统 -> 深色'
  if (state.darkMode === true) return '深色 -> 浅色'
  return '浅色 -> 跟随系统'
})

function cycleDarkMode() {
  if (state.darkMode === null) setDarkMode(true)
  else if (state.darkMode === true) setDarkMode(false)
  else setDarkMode(null)
}

function stopProgressPolling() {
  if (!progressTimer) return
  clearInterval(progressTimer)
  progressTimer = null
}

function startProgressPolling() {
  stopProgressPolling()
  progressTimer = setInterval(async () => {
    try {
      const result = await api.getScanProgress()
      if (result.status.running) {
        fallbackScanProgress.value = result.progress
      } else {
        fallbackScanProgress.value = null
        stopProgressPolling()
      }
    } catch {
      // ignore polling errors
    }
  }, 1000)
}

onMounted(() => {
  if (state.meta?.scanStatus?.running && !state.realtimeConnected) {
    startProgressPolling()
  }
})

onUnmounted(() => {
  stopProgressPolling()
})

async function handleScan() {
  try {
    if (!state.realtimeConnected) {
      startProgressPolling()
    }
    await runScan()
    fallbackScanProgress.value = null
    stopProgressPolling()
    message.success('扫描完成')
  } catch (error: any) {
    fallbackScanProgress.value = null
    stopProgressPolling()
    message.error(error?.message || '扫描失败')
  }
}
</script>

<style scoped>
.app-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 32px;
  background: var(--md-surface, var(--n-color, #fff));
  box-shadow: var(--md-elevation-2);
  position: sticky;
  top: 0;
  z-index: 10;
  gap: 16px;
}

.topbar-left {
  display: flex;
  align-items: center;
  min-width: 0;
}

.topbar-left .n-h3 {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--md-on-surface, inherit);
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.scan-progress-inline {
  display: flex;
  align-items: center;
  gap: 8px;
}

@media (max-width: 768px) {
  .app-topbar {
    padding: 10px 12px;
    gap: 8px;
  }

  .topbar-left .n-h3 {
    font-size: 16px !important;
  }

  .scan-progress-inline {
    display: none;
  }

  .topbar-right {
    gap: 6px;
  }
}
</style>
