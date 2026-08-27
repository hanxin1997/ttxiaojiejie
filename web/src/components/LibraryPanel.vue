<template>
  <div class="library-panel">
    <div v-if="statItems.length" class="stat-grid">
      <n-card v-for="(item, index) in statItems" :key="index" size="small" embedded class="mac-glass-card" style="--n-border-radius: 12px;">
        <n-statistic :label="item.label" :value="item.value" />
      </n-card>
    </div>

    <!-- 工具栏 -->
    <div class="filter-bar">
      <n-input
        v-model:value="searchValue"
        placeholder="搜索标题 / 路径 / 标签..."
        clearable
        style="max-width: 320px; flex: 1"
        @update:value="handleSearch"
      >
        <template #prefix>
          <n-icon><SearchOutline /></n-icon>
        </template>
      </n-input>
      <n-select
        v-model:value="categoryValue"
        :options="categoryOptions"
        placeholder="全部分类"
        clearable
        style="width: 160px"
        @update:value="handleCategoryChange"
      />
      <n-select
        v-model:value="sortValue"
        :options="sortOptions"
        style="width: 120px"
        @update:value="handleSortChange"
      />
      <n-button
        quaternary
        size="small"
        :type="sortOrderValue === 'asc' ? 'default' : 'primary'"
        @click="toggleSortOrder"
      >
        {{ sortOrderValue === 'asc' ? '升序' : '降序' }}
      </n-button>

      <!-- 高级过滤 -->
      <n-button quaternary size="small" :type="hasActiveFilters ? 'warning' : 'default'" @click="showAdvancedFilter = true">
        <template #icon><n-icon><FunnelOutline /></n-icon></template>
        {{ hasActiveFilters ? '过滤中' : '过滤' }}
      </n-button>

      <!-- 布局切换 -->
      <n-button-group size="small">
        <n-button :type="state.layoutMode === 'grid' ? 'primary' : 'default'" quaternary @click="setLayoutMode('grid')">
          <template #icon><n-icon><GridOutline /></n-icon></template>
        </n-button>
        <n-button :type="state.layoutMode === 'list' ? 'primary' : 'default'" quaternary @click="setLayoutMode('list')">
          <template #icon><n-icon><ListOutline /></n-icon></template>
        </n-button>
        <n-button :type="state.layoutMode === 'waterfall' ? 'primary' : 'default'" quaternary @click="setLayoutMode('waterfall')">
          <template #icon><n-icon><AppsOutline /></n-icon></template>
        </n-button>
      </n-button-group>

      <!-- 选择模式 -->
      <n-button
        quaternary
        size="small"
        :type="state.selectionMode ? 'primary' : 'default'"
        @click="toggleSelectionMode"
      >
        {{ state.selectionMode ? '退出选择' : '选择' }}
      </n-button>
    </div>

    <!-- 选择操作栏 -->
    <n-space v-if="state.selectedSeriesIds.size > 0" style="margin-bottom: 16px" align="center">
      <n-tag type="info" round>已选 {{ state.selectedSeriesIds.size }} 项</n-tag>
      <n-button size="small" @click="selectAll">全选当前页</n-button>
      <n-button size="small" @click="clearSelection">取消</n-button>
      <n-button size="small" type="primary" @click="showBatchCategoryDialog = true">
        批量分类
      </n-button>
      <n-button size="small" type="info" @click="showBatchTagDialog = true">
        批量标签
      </n-button>
    </n-space>

    <n-spin :show="state.loadingList">
      <n-empty
        v-if="!state.loadingList && state.series.length === 0"
        description="暂无内容"
        style="padding: 60px 0"
      />

      <!-- 网格布局 -->
      <div v-else-if="state.layoutMode === 'grid'" ref="viewportRef" class="virtual-viewport" @scroll="handleScroll">
        <div class="virtual-spacer" :style="{ height: `${totalHeight}px` }">
          <div class="series-grid virtual-grid" :style="gridStyle">
            <SeriesCard
              v-for="item in visibleSeries"
              :key="item.id"
              :series="item"
              :active="item.id === state.activeSeriesId"
              :selected="state.selectedSeriesIds.has(item.id)"
              :selectable="state.selectionMode || state.selectedSeriesIds.size > 0"
              @click="handleCardClick(item.id)"
              @toggle-select="toggleSeriesSelection(item.id)"
              @toggle-favorite="handleToggleFavorite(item.id)"
            />
          </div>
        </div>
      </div>

      <!-- 列表布局 -->
      <div v-else-if="state.layoutMode === 'list'" class="list-layout">
        <SeriesListItemVue
          v-for="item in state.series"
          :key="item.id"
          :series="item"
          :active="item.id === state.activeSeriesId"
          :selected="state.selectedSeriesIds.has(item.id)"
          :selectable="state.selectionMode || state.selectedSeriesIds.size > 0"
          @click="handleCardClick(item.id)"
          @toggle-select="toggleSeriesSelection(item.id)"
          @toggle-favorite="handleToggleFavorite(item.id)"
        />
      </div>

      <!-- 瀑布流布局 -->
      <div v-else class="waterfall-layout" :style="waterfallColumns">
        <SeriesCard
          v-for="item in state.series"
          :key="item.id"
          :series="item"
          :active="item.id === state.activeSeriesId"
          :selected="state.selectedSeriesIds.has(item.id)"
          :selectable="state.selectionMode || state.selectedSeriesIds.size > 0"
          class="waterfall-item"
          @click="handleCardClick(item.id)"
          @toggle-select="toggleSeriesSelection(item.id)"
          @toggle-favorite="handleToggleFavorite(item.id)"
        />
      </div>
    </n-spin>

    <div v-if="state.totalPages > 1" style="display: flex; justify-content: center; margin-top: 24px">
      <n-pagination
        :page="state.page"
        :page-count="state.totalPages"
        :page-size="state.pageSize"
        show-quick-jumper
        @update:page="handlePageChange"
      />
    </div>

    <!-- 批量分类弹窗 -->
    <n-modal v-model:show="showBatchCategoryDialog" preset="dialog" title="批量设置分类">
      <n-input v-model:value="batchCategoryInput" placeholder="多个分类用逗号分隔" />
      <template #action>
        <n-button @click="showBatchCategoryDialog = false">取消</n-button>
        <n-button type="primary" :loading="batchSaving" @click="handleBatchSetCategories">
          应用到 {{ state.selectedSeriesIds.size }} 项
        </n-button>
      </template>
    </n-modal>

    <!-- 批量标签弹窗 -->
    <n-modal v-model:show="showBatchTagDialog" preset="dialog" title="批量设置标签">
      <n-select
        v-model:value="batchTagValues"
        :options="knownTagOptions"
        multiple
        filterable
        tag
        clearable
        placeholder="选择或输入标签..."
        style="margin-bottom: 12px"
      />
      <n-radio-group v-model:value="batchTagMode" size="small">
        <n-radio-button value="merge">追加合并</n-radio-button>
        <n-radio-button value="replace">替换全部</n-radio-button>
      </n-radio-group>
      <template #action>
        <n-button @click="showBatchTagDialog = false">取消</n-button>
        <n-button type="primary" :loading="batchTagSaving" @click="handleBatchSetTags">
          应用到 {{ state.selectedSeriesIds.size }} 项
        </n-button>
      </template>
    </n-modal>

    <!-- 高级过滤面板 -->
    <AdvancedFilterPanel
      :show="showAdvancedFilter"
      :known-tags="state.meta?.knownTags ?? []"
      :filters="state.advancedFilters"
      @update:show="showAdvancedFilter = $event"
      @apply="handleApplyAdvancedFilters"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  NButton,
  NButtonGroup,
  NCard,
  NEmpty,
  NIcon,
  NInput,
  NModal,
  NPagination,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NSpin,
  NStatistic,
  NTag,
  useMessage,
} from 'naive-ui'
import { AppsOutline, FunnelOutline, GridOutline, ListOutline, SearchOutline } from '@vicons/ionicons5'
import SeriesCard from './SeriesCard.vue'
import SeriesListItemVue from './SeriesListItem.vue'
import AdvancedFilterPanel from './AdvancedFilterPanel.vue'
import type { AdvancedFilters } from './AdvancedFilterPanel.vue'
import { useAppState } from '../composables/useAppState'
import { formatBytes } from '../utils/format'

const {
  state,
  batchSetCategories,
  batchSetTags,
  clearSelection,
  exitSelectionMode,
  loadSeriesList,
  openSeriesDetail,
  selectAll,
  setAdvancedFilters,
  setCategory,
  setLayoutMode,
  setPage,
  setSearch,
  setSortBy,
  setSortOrder,
  toggleFavorite,
  toggleSelectionMode,
  toggleSeriesSelection,
} = useAppState()

const message = useMessage()

const searchValue = ref('')
const categoryValue = ref<string | null>(null)
const sortValue = ref('title')
const sortOrderValue = ref('asc')
const showBatchCategoryDialog = ref(false)
const showBatchTagDialog = ref(false)
const showAdvancedFilter = ref(false)
const batchCategoryInput = ref('')
const batchSaving = ref(false)
const batchTagValues = ref<string[]>([])
const batchTagMode = ref<'merge' | 'replace'>('merge')
const batchTagSaving = ref(false)

const viewportRef = ref<HTMLElement | null>(null)
const viewportWidth = ref(1200)
const viewportHeight = ref(720)
const scrollTop = ref(0)

let searchTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null
let scrollFrame: number | null = null

watch(() => state.search, (value) => { searchValue.value = value }, { immediate: true })
watch(() => state.category, (value) => { categoryValue.value = value || null }, { immediate: true })
watch(() => state.sortBy, (value) => { sortValue.value = value }, { immediate: true })
watch(() => state.sortOrder, (value) => { sortOrderValue.value = value }, { immediate: true })
watch(
  () => state.series.map((item) => item.id).join(','),
  () => {
    scrollTop.value = 0
    if (viewportRef.value) {
      viewportRef.value.scrollTop = 0
    }
  },
)

const sortOptions = [
  { label: '标题', value: 'title' },
  { label: '页数', value: 'pages' },
  { label: '章节', value: 'chapters' },
  { label: '卷数', value: 'volumes' },
  { label: '大小', value: 'size' },
]

const statItems = computed(() => {
  if (!state.meta) return []
  const summary = state.meta.summary
  const items: { label: string; value: string | number }[] = [
    { label: '系列', value: summary.seriesCount },
    { label: '卷', value: summary.volumeCount },
    { label: '章节', value: summary.chapterCount },
    { label: '图片', value: summary.pageCount },
  ]
  if (summary.totalBytes > 0) {
    items.push({ label: '总大小', value: formatBytes(summary.totalBytes) })
  }
  return items
})

const categoryOptions = computed(() => {
  if (!state.meta) return []
  return state.meta.knownCategories.map((category) => ({ label: category, value: category }))
})

const knownTagOptions = computed(() => {
  if (!state.meta) return []
  return state.meta.knownTags.map((tag) => ({ label: tag, value: tag }))
})

const hasActiveFilters = computed(() => {
  const af = state.advancedFilters
  return af.tags.length > 0 || af.minPages != null || af.maxPages != null || af.minSize != null || af.maxSize != null || af.readStatus != null
})

// 瀑布流列数样式
const waterfallColumns = computed(() => {
  const cols = viewportWidth.value <= 480 ? 2 : viewportWidth.value <= 768 ? 3 : viewportWidth.value <= 1024 ? 4 : 5
  return { columnCount: cols, columnGap: '16px' }
})

// ===== 虚拟滚动（网格模式） =====
const columnCount = computed(() => {
  const minWidth =
    viewportWidth.value <= 480 ? 130 :
      viewportWidth.value <= 768 ? 150 :
        180
  return Math.max(1, Math.floor((viewportWidth.value + 20) / (minWidth + 20)))
})

const rowHeight = computed(() => {
  const gap = viewportWidth.value <= 480 ? 10 : viewportWidth.value <= 768 ? 12 : 20
  const colWidth = (viewportWidth.value - gap * (columnCount.value - 1)) / columnCount.value
  const coverHeight = colWidth * 1.5
  const infoHeight = 80
  return Math.round(coverHeight + infoHeight + gap)
})

const totalRows = computed(() => Math.ceil(state.series.length / columnCount.value))
const totalHeight = computed(() => totalRows.value * rowHeight.value)

const visibleRange = computed(() => {
  const overscan = Math.max(2, Math.ceil(viewportHeight.value / rowHeight.value / 2))
  const startRow = Math.max(0, Math.floor(scrollTop.value / rowHeight.value) - overscan)
  const endRow = Math.min(
    totalRows.value,
    Math.ceil((scrollTop.value + viewportHeight.value) / rowHeight.value) + overscan,
  )
  return {
    startRow,
    endRow,
    startIndex: startRow * columnCount.value,
    endIndex: Math.min(state.series.length, endRow * columnCount.value),
  }
})

const visibleSeries = computed(() => {
  return state.series.slice(visibleRange.value.startIndex, visibleRange.value.endIndex)
})

const gridStyle = computed(() => ({
  position: 'absolute',
  top: `${visibleRange.value.startRow * rowHeight.value}px`,
  left: '0',
  right: '0',
  gridTemplateColumns: `repeat(${columnCount.value}, minmax(0, 1fr))`,
}))

function updateViewportMetrics() {
  if (!viewportRef.value) return
  viewportWidth.value = viewportRef.value.clientWidth
  viewportHeight.value = viewportRef.value.clientHeight
}

function handleScroll(event: Event) {
  const target = event.target as HTMLElement
  if (scrollFrame !== null) return
  scrollFrame = requestAnimationFrame(() => {
    scrollTop.value = target.scrollTop
    scrollFrame = null
  })
}

function handleSearch(value: string) {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    setSearch(value.trim())
    try {
      await loadSeriesList()
    } catch (error: any) {
      message.error(error?.message || '搜索失败')
    }
  }, 300)
}

async function handleCategoryChange(value: string | null) {
  setCategory(value ?? '')
  try {
    await loadSeriesList()
  } catch (error: any) {
    message.error(error?.message || '筛选失败')
  }
}

async function handleSortChange(value: string) {
  setSortBy(value)
  try {
    await loadSeriesList()
  } catch (error: any) {
    message.error(error?.message || '排序失败')
  }
}

async function toggleSortOrder() {
  setSortOrder(sortOrderValue.value === 'asc' ? 'desc' : 'asc')
  try {
    await loadSeriesList()
  } catch (error: any) {
    message.error(error?.message || '排序失败')
  }
}

async function handlePageChange(page: number) {
  setPage(page)
  try {
    await loadSeriesList()
  } catch (error: any) {
    message.error(error?.message || '翻页失败')
  }
}

async function handleCardClick(id: string) {
  if (state.selectionMode || state.selectedSeriesIds.size > 0) {
    toggleSeriesSelection(id)
    return
  }

  try {
    await openSeriesDetail(id)
  } catch (error: any) {
    message.error(error?.message || '加载详情失败')
  }
}

async function handleToggleFavorite(id: string) {
  try {
    await toggleFavorite(id)
  } catch (error: any) {
    message.error(error?.message || '收藏失败')
  }
}

async function handleBatchSetCategories() {
  batchSaving.value = true
  try {
    const categories = batchCategoryInput.value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    await batchSetCategories(categories)
    showBatchCategoryDialog.value = false
    batchCategoryInput.value = ''
    message.success('批量分类已更新')
  } catch (error: any) {
    message.error(error?.message || '批量分类失败')
  } finally {
    batchSaving.value = false
  }
}

async function handleBatchSetTags() {
  batchTagSaving.value = true
  try {
    await batchSetTags(batchTagValues.value, batchTagMode.value)
    showBatchTagDialog.value = false
    batchTagValues.value = []
    message.success('批量标签已更新')
  } catch (error: any) {
    message.error(error?.message || '批量标签失败')
  } finally {
    batchTagSaving.value = false
  }
}

async function handleApplyAdvancedFilters(filters: AdvancedFilters) {
  setAdvancedFilters(filters)
  try {
    await loadSeriesList()
  } catch (error: any) {
    message.error(error?.message || '过滤失败')
  }
}

onMounted(() => {
  updateViewportMetrics()
  if (viewportRef.value) {
    resizeObserver = new ResizeObserver(() => updateViewportMetrics())
    resizeObserver.observe(viewportRef.value)
  }
  // 也监听窗口大小变化（用于瀑布流等非 viewport 模式）
  window.addEventListener('resize', updateWindowWidth)
  updateWindowWidth()
})

function updateWindowWidth() {
  if (!viewportRef.value) {
    viewportWidth.value = window.innerWidth - 280 // 减去侧边栏宽度估算
  }
}

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
  resizeObserver?.disconnect()
  window.removeEventListener('resize', updateWindowWidth)
})
</script>

<style scoped>
.library-panel {
  width: 100%;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.virtual-viewport {
  height: min(72vh, 980px);
  overflow: auto;
}

.virtual-spacer {
  position: relative;
  width: 100%;
}

.virtual-grid {
  position: absolute;
}

/* 列表布局 */
.list-layout {
  display: grid;
  gap: 12px;
}

/* 瀑布流布局 */
.waterfall-layout {
  column-fill: balance;
}

.waterfall-layout :deep(.series-card) {
  break-inside: avoid;
  margin-bottom: 16px;
}

@media (max-width: 768px) {
  .filter-bar {
    gap: 6px;
  }
}

:deep(.mac-glass-card) {
  background-color: var(--md-surface, #fff) !important;
  box-shadow: none !important;
}
@media (prefers-color-scheme: dark) {
  :deep(.mac-glass-card) {
    background-color: var(--md-surface, #1e1e1e) !important;
  }
}
</style>
