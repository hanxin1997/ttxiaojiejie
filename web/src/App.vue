<template>
  <n-config-provider :theme="currentTheme" :theme-overrides="zenIosThemeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <n-dialog-provider>
        <n-notification-provider>
          <div v-if="hasError" style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; gap: 16px">
            <n-text style="font-size: 18px; font-weight: 600">页面出错了</n-text>
            <n-text depth="3">发生了意外错误，请尝试刷新页面</n-text>
            <n-button type="primary" @click="handleReload">刷新页面</n-button>
          </div>
          <router-view v-else />
        </n-notification-provider>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { computed, onErrorCaptured, onMounted, onUnmounted, ref, watchEffect } from 'vue'
import {
  NButton,
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NNotificationProvider,
  NText,
  darkTheme,
  zhCN,
  dateZhCN,
} from 'naive-ui'
import type { GlobalThemeOverrides } from 'naive-ui'
import { useAppState } from './composables/useAppState'

const { state, initDarkMode } = useAppState()

const hasError = ref(false)

onErrorCaptured((err) => {
  console.error('[App ErrorBoundary]', err)
  hasError.value = true
  return false
})

function handleReload() {
  window.location.reload()
}

const systemDark = ref(
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
)

let mediaQuery: MediaQueryList | null = null
function onSystemThemeChange(e: MediaQueryListEvent) {
  systemDark.value = e.matches
}

onMounted(() => {
  initDarkMode()
  if (typeof window !== 'undefined') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    mediaQuery.addEventListener('change', onSystemThemeChange)
  }
})

onUnmounted(() => {
  mediaQuery?.removeEventListener('change', onSystemThemeChange)
})

const currentTheme = computed(() => {
  if (state.darkMode === true) return darkTheme
  if (state.darkMode === false) return null
  // 跟随系统
  return systemDark.value ? darkTheme : null
})

/**
 * Zen-iOS Hybrid 设计语言主题覆盖
 * 追求极致的物理触感、光学模糊效果和高对比度的冷灰调设计。
 */
const zenIosThemeOverrides = computed<GlobalThemeOverrides>(() => {
  const isDark = currentTheme.value === darkTheme
  return {
    common: {
      primaryColor: isDark ? '#FFFFFF' : '#1C1C1E',
      primaryColorHover: isDark ? '#E5E5EA' : '#3A3A3C',
      primaryColorPressed: isDark ? '#D1D1D6' : '#000000',
      primaryColorSuppl: isDark ? '#FFFFFF' : '#1C1C1E',
      infoColor: isDark ? '#0A84FF' : '#007AFF',
      infoColorHover: isDark ? '#409CFF' : '#0066CC',
      infoColorPressed: isDark ? '#0055B3' : '#004080',
      successColor: isDark ? '#32D74B' : '#34C759',
      successColorHover: isDark ? '#5EE06F' : '#28A745',
      successColorPressed: isDark ? '#249E3A' : '#1E7E34',
      warningColor: isDark ? '#FF9F0A' : '#FF9500',
      warningColorHover: isDark ? '#FFB340' : '#E68600',
      warningColorPressed: isDark ? '#E68A00' : '#CC7A00',
      errorColor: isDark ? '#FF453A' : '#FF3B30',
      errorColorHover: isDark ? '#FF6961' : '#E6352B',
      errorColorPressed: isDark ? '#E63027' : '#CC2922',
      borderRadius: '16px',
      borderRadiusSmall: '8px',
      bodyColor: isDark ? '#000000' : '#F2F2F7',
      cardColor: isDark ? 'rgba(28, 28, 30, 0.6)' : 'rgba(255, 255, 255, 0.6)',
      modalColor: isDark ? 'rgba(44, 44, 46, 0.8)' : 'rgba(255, 255, 255, 0.8)',
      popoverColor: isDark ? 'rgba(44, 44, 46, 0.8)' : 'rgba(255, 255, 255, 0.8)',
      tableColor: isDark ? 'rgba(28, 28, 30, 0.6)' : 'rgba(255, 255, 255, 0.6)',
      inputColor: isDark ? 'rgba(118, 118, 128, 0.24)' : 'rgba(118, 118, 128, 0.12)',
      actionColor: isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.02)',
      textColorBase: isDark ? '#FFFFFF' : '#1C1C1E',
      textColor1: isDark ? '#FFFFFF' : '#1C1C1E',
      textColor2: isDark ? '#EBEBF5' : '#3A3A3C',
      textColor3: isDark ? 'rgba(235, 235, 245, 0.6)' : '#8E8E93',
      dividerColor: isDark ? 'rgba(235, 235, 245, 0.15)' : 'rgba(60, 60, 67, 0.1)',
      borderColor: isDark ? 'rgba(235, 235, 245, 0.15)' : 'rgba(60, 60, 67, 0.1)',
      boxShadow1: '0 4px 12px -4px rgba(0,0,0,0.08)',
      boxShadow2: '0 12px 24px -8px rgba(0,0,0,0.08)',
      boxShadow3: '0 24px 48px -12px rgba(0,0,0,0.08)',
    },
    Button: {
      borderRadiusMedium: '12px',
      borderRadiusSmall: '8px',
      borderRadiusTiny: '6px',
      fontWeight: '600',
    },
    Card: {
      borderRadius: '28px',
      boxShadow: '0 24px 48px -12px rgba(0,0,0,0.08)',
    },
    Dialog: {
      borderRadius: '40px',
      boxShadow: '0 24px 48px -12px rgba(0,0,0,0.08)',
    },
    Tag: {
      borderRadius: '8px',
    },
    Input: {
      borderRadius: '12px',
      boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.05)',
    },
  }
})

// 同步 html.dark 类，让 global.css 中的暗色 CSS 变量生效
watchEffect(() => {
  if (currentTheme.value === darkTheme) {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }
  document.documentElement.classList.toggle('performance-lite', state.meta?.resourceProfile.name === 'lite')
})
</script>

<style>
/* Zen-iOS Hybrid Global Styles */
:root {
  font-family: 'SF Pro Display', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}

/* 默认使用实色表面，减少低端 GPU 的离屏模糊与大面积重绘。 */
.n-card, .n-dialog, .n-drawer, .n-modal {
  border: 1px solid rgba(255, 255, 255, 0.6) !important;
  box-shadow: 0 2px 8px rgba(0,0,0,0.06) !important;
}

html.dark .n-card, html.dark .n-dialog, html.dark .n-drawer, html.dark .n-modal {
  border: 1px solid rgba(255, 255, 255, 0.1) !important;
  box-shadow: 0 2px 8px rgba(0,0,0,0.16) !important;
}

/* 触觉感: 按钮及可交互项物理回弹 */
.n-button, .series-card {
  transition: transform 0.2s cubic-bezier(0.25, 1, 0.5, 1), box-shadow 0.2s ease, background 0.2s ease !important;
}
.n-button:active, .series-card:active {
  transform: scale(0.96) !important;
}

/* 强制呼吸感留白排版 */
.n-layout-content {
  padding: 24px !important;
}

html.performance-lite .n-card,
html.performance-lite .n-dialog,
html.performance-lite .n-drawer,
html.performance-lite .n-modal {
  box-shadow: none !important;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
</style>
