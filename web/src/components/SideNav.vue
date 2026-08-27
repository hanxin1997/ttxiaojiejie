<template>
  <!-- 桌面端：标准侧边栏 -->
  <n-layout-sider
    v-if="!isMobile"
    bordered
    :collapsed="state.sidebarCollapsed"
    :collapsed-width="64"
    :width="220"
    collapse-mode="width"
    show-trigger="bar"
    :native-scrollbar="false"
    @update:collapsed="toggleSidebar"
    class="app-sider"
  >
    <SideNavContent :collapsed="state.sidebarCollapsed" @navigate="handleMenuSelect" />
  </n-layout-sider>

  <!-- 移动端：抽屉模式 -->
  <n-drawer
    v-else
    :show="mobileDrawerOpen"
    :width="260"
    placement="left"
    :native-scrollbar="false"
    @update:show="mobileDrawerOpen = $event"
  >
    <n-drawer-content :body-content-style="{ padding: 0 }">
      <SideNavContent :collapsed="false" @navigate="handleMobileNavigate" />
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { h, computed, ref, onMounted, onUnmounted } from 'vue'
import { NLayoutSider, NDrawer, NDrawerContent, NMenu, NIcon, NText } from 'naive-ui'
import {
  LibraryOutline,
  ImagesOutline,
  StarOutline,
  SettingsOutline,
} from '@vicons/ionicons5'
import { useAppState } from '../composables/useAppState'

const { state, navigateTo, toggleSidebar, setFavoritesOnly } = useAppState()

const MOBILE_BREAKPOINT = 768
const isMobile = ref(false)
const mobileDrawerOpen = ref(false)

function checkMobile() {
  isMobile.value = window.innerWidth <= MOBILE_BREAKPOINT
}

onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
})

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile)
})

/** 暴露给 AppHeader 的汉堡按钮 */
defineExpose({ isMobile, mobileDrawerOpen })

async function handleMenuSelect(key: string) {
  if (key === 'favorites') {
    setFavoritesOnly(true)
    await navigateTo('library')
  } else if (key === 'library') {
    setFavoritesOnly(false)
    await navigateTo('library')
  } else if (key === 'settings') {
    await navigateTo('settings')
  }
}

async function handleMobileNavigate(key: string) {
  mobileDrawerOpen.value = false
  await handleMenuSelect(key)
}
</script>

<!-- 侧边栏内容子组件（桌面/移动共用） -->
<script lang="ts">
import { defineComponent, type PropType } from 'vue'

const SideNavContent = defineComponent({
  name: 'SideNavContent',
  props: {
    collapsed: { type: Boolean, default: false },
  },
  emits: ['navigate'],
  setup(props, { emit }) {
    const { state } = useAppState()

    function renderIcon(icon: any) {
      return () => h(NIcon, null, { default: () => h(icon) })
    }

    const menuOptions = computed(() => [
      { label: '图库', key: 'library', icon: renderIcon(ImagesOutline) },
      { label: '收藏', key: 'favorites', icon: renderIcon(StarOutline) },
      { type: 'divider', key: 'd1' },
      { label: '设置', key: 'settings', icon: renderIcon(SettingsOutline) },
    ])

    const selectedKey = computed(() => {
      if (state.currentView === 'settings') return 'settings'
      if (state.favoritesOnly) return 'favorites'
      return 'library'
    })

    return () =>
      h('div', { class: 'sider-inner' }, [
        h('div', { class: ['sider-brand', { collapsed: props.collapsed }] }, [
          h('div', { class: 'brand-icon' }, [
            h(NIcon, { size: 28, color: 'var(--n-text-color)' }, { default: () => h(LibraryOutline) }),
          ]),
          !props.collapsed
            ? h('span', { class: 'brand-text' }, 'TPAP')
            : null,
        ]),
        h(NMenu, {
          value: selectedKey.value,
          collapsed: props.collapsed,
          collapsedWidth: 64,
          collapsedIconSize: 22,
          options: menuOptions.value,
          'onUpdate:value': (key: string) => emit('navigate', key),
        }),
        !props.collapsed
          ? h('div', { class: 'sider-footer' }, [
              h(NText, { depth: 3, style: 'font-size: 11px' }, {
                default: () =>
                  `${state.meta?.summary?.seriesCount ?? 0} 系列 · ${state.meta?.summary?.pageCount ?? 0} 图片`,
              }),
            ])
          : null,
      ])
  },
})
</script>

<style scoped>
.app-sider {
  position: sticky;
  top: 0;
  height: 100vh;
}

.sider-inner {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.sider-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px 20px 16px;
  border-bottom: 1px solid var(--md-outline-variant, var(--n-border-color, var(--tpap-border-color)));
  margin-bottom: 8px;
}

.sider-brand.collapsed {
  justify-content: center;
  padding: 20px 0 16px;
}

.brand-icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: var(--md-shape-sm);
  background: linear-gradient(135deg, var(--md-primary, #6750A4), var(--md-secondary, #00897B));
}

.brand-icon :deep(.n-icon) {
  color: #fff !important;
}

.brand-text {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--md-on-surface, inherit);
}

.sider-footer {
  margin-top: auto;
  padding: 12px 20px;
  border-top: 1px solid var(--md-outline-variant, var(--n-border-color, var(--tpap-border-color)));
  text-align: center;
}
</style>
