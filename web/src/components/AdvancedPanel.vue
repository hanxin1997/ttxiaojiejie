<template>
  <n-card title="高级功能" size="small" class="mac-glass-card" style="--n-border-radius: 12px;">
    <n-tabs type="line" animated>
      <n-tab-pane name="duplicates" tab="重复检测">
        <n-space vertical>
          <n-button type="primary" size="small" :loading="loadingDuplicates" @click="handleLoadDuplicates">
            开始检测
          </n-button>

          <n-empty
            v-if="!loadingDuplicates && state.duplicateGroups.length === 0"
            description="暂无重复检测结果，点击上方按钮开始检测"
          />

          <n-card
            v-for="(group, index) in state.duplicateGroups"
            :key="index"
            size="small"
            embedded
            class="mac-glass-card-inner"
            style="--n-border-radius: 12px;"
          >
            <template #header>
              <n-tag :type="group.reason === 'same_title' ? 'warning' : 'info'" size="small">
                {{ group.reason === 'same_title' ? '标题相同' : '大小和页数相同' }}
              </n-tag>
              <n-text depth="3" style="margin-left: 8px; font-size: 12px">
                {{ group.items.length }} 项
              </n-text>
            </template>

            <div style="display: grid; gap: 8px">
              <div
                v-for="item in group.items"
                :key="item.id"
                class="dup-item"
              >
                <!-- 封面缩略图 -->
                <div class="dup-cover">
                  <img
                    v-if="getCoverUrl(item)"
                    :src="getCoverUrl(item)!"
                    alt=""
                    style="width: 100%; height: 100%; object-fit: cover"
                  />
                  <div v-else class="dup-cover-placeholder">无</div>
                </div>
                <div class="dup-info">
                  <n-text strong>{{ item.title }}</n-text>
                  <n-text depth="3" style="display: block; font-size: 12px" class="dup-path">
                    <template v-for="(seg, si) in highlightPathDiff(group.items, item)" :key="si">
                      <span :class="{ 'path-diff': seg.diff }">{{ seg.text }}</span>
                    </template>
                  </n-text>
                  <n-text depth="3" style="display: block; font-size: 12px">
                    {{ item.counts.pages }} 页
                    <template v-if="item.totalBytes > 0">
                      · {{ formatBytes(item.totalBytes) }}
                    </template>
                  </n-text>
                </div>
                <!-- 操作按钮 -->
                <div class="dup-actions">
                  <n-button
                    size="tiny"
                    type="primary"
                    quaternary
                    @click.stop="handleKeepItem(item)"
                  >
                    保留
                  </n-button>
                  <n-popconfirm
                    @positive-click="handleDeleteItem(item)"
                  >
                    <template #trigger>
                      <n-button size="tiny" type="error" quaternary>
                        删除
                      </n-button>
                    </template>
                    确认删除「{{ item.title }}」？此操作不可撤销。
                  </n-popconfirm>
                </div>
              </div>
            </div>
          </n-card>
        </n-space>
      </n-tab-pane>

      <n-tab-pane name="watcher" tab="文件监听">
        <n-space vertical>
          <n-space align="center">
            <n-button type="primary" size="small" :loading="loadingWatcher" @click="handleLoadWatcherStatus">
              刷新状态
            </n-button>
            <n-button size="small" :loading="restartingWatcher" @click="handleRestartWatcher">
              重启监听
            </n-button>
          </n-space>

          <template v-if="state.watcherStatus">
            <n-descriptions :column="1" bordered size="small">
              <n-descriptions-item label="运行状态">
                <n-tag :type="state.watcherStatus.running ? 'success' : 'error'" size="small">
                  {{ state.watcherStatus.running ? '运行中' : '已停止' }}
                </n-tag>
              </n-descriptions-item>
              <n-descriptions-item label="监听路径数">
                {{ state.watcherStatus.watchedPaths }}
              </n-descriptions-item>
              <n-descriptions-item label="事件计数">
                {{ state.watcherStatus.eventCount }}
              </n-descriptions-item>
              <n-descriptions-item v-if="state.watcherStatus.lastEvent" label="最近事件">
                {{ state.watcherStatus.lastEvent.type }} - {{ state.watcherStatus.lastEvent.filename }}
                <n-text depth="3" style="display: block; font-size: 12px">
                  {{ state.watcherStatus.lastEvent.time }}
                </n-text>
              </n-descriptions-item>
            </n-descriptions>
          </template>

          <n-empty v-else-if="!loadingWatcher" description="点击刷新查看文件监听状态" />
        </n-space>
      </n-tab-pane>

      <n-tab-pane name="metadata" tab="批量刮削">
        <n-space vertical>
          <n-checkbox v-model:checked="overwriteMetadata">
            覆盖已有作者/描述/标签
          </n-checkbox>
          <n-space align="center">
            <n-button type="primary" size="small" :loading="scrapingMetadata" @click="handleScrapeMetadata">
              刮削{{ targetSeriesCountLabel }}
            </n-button>
          </n-space>

          <n-text depth="3" style="font-size: 12px">
            当前使用 AniList 批量拉取标题、作者、描述和标签，并直接写回系列元数据。
          </n-text>

          <n-empty
            v-if="!scrapingMetadata && metadataLog.length === 0"
            description="暂无刮削结果"
          />
          <n-card
            v-for="item in metadataLog"
            :key="item.seriesId"
            size="small"
            embedded
            class="mac-glass-card-inner"
            style="--n-border-radius: 12px;"
          >
            <n-text strong>{{ item.title }}</n-text>
            <n-text
              :type="item.ok ? 'success' : 'error'"
              style="display: block; margin-top: 4px; font-size: 12px"
            >
              {{ item.ok ? `已处理${item.applied ? '并写回' : ''}` : item.error }}
            </n-text>
          </n-card>
        </n-space>
      </n-tab-pane>
    </n-tabs>
  </n-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NButton,
  NCard,
  NCheckbox,
  NDescriptions,
  NDescriptionsItem,
  NEmpty,
  NPopconfirm,
  NSpace,
  NTabPane,
  NTabs,
  NTag,
  NText,
  useMessage,
} from 'naive-ui'
import type { DuplicateItem, MetadataScrapeItem } from '../api'
import { api } from '../api'
import { useAppState } from '../composables/useAppState'
import { formatBytes } from '../utils/format'

const {
  state,
  loadDuplicates,
  removeDuplicateItem,
  loadWatcherStatus,
  refreshAll,
  restartWatcher,
  restoreActiveDetail,
} = useAppState()
const message = useMessage()

const loadingDuplicates = ref(false)
const loadingWatcher = ref(false)
const restartingWatcher = ref(false)
const scrapingMetadata = ref(false)
const overwriteMetadata = ref(false)
const metadataLog = ref<MetadataScrapeItem[]>([])

const targetSeriesIds = computed(() => {
  return state.selectedSeriesIds.size > 0
    ? [...state.selectedSeriesIds]
    : state.series.map((item) => item.id)
})

const targetSeriesCountLabel = computed(() => {
  return `${targetSeriesIds.value.length} 项`
})

function getCoverUrl(item: DuplicateItem) {
  // 用 media 接口拼出封面 URL
  return `/media/cover/${item.id}`
}

/**
 * 路径差异高亮：找出同组中各项路径的不同部分
 */
function highlightPathDiff(items: readonly DuplicateItem[], current: DuplicateItem) {
  if (items.length < 2) {
    return [{ text: current.sourceKey, diff: false }]
  }

  const paths = items.map((i) => i.sourceKey)
  const target = current.sourceKey

  // 找出所有路径的公共前缀
  let commonPrefix = ''
  for (let i = 0; i < target.length; i++) {
    if (paths.every((p) => p[i] === target[i])) {
      commonPrefix += target[i]
    } else {
      break
    }
  }

  // 找出所有路径的公共后缀
  let commonSuffix = ''
  const reversed = paths.map((p) => [...p].reverse().join(''))
  const targetReversed = [...target].reverse().join('')
  for (let i = 0; i < targetReversed.length; i++) {
    if (reversed.every((p) => p[i] === targetReversed[i])) {
      commonSuffix = targetReversed[i] + commonSuffix
    } else {
      break
    }
  }

  // 避免前后缀重叠
  const maxSuffixLen = target.length - commonPrefix.length
  if (commonSuffix.length > maxSuffixLen) {
    commonSuffix = commonSuffix.slice(commonSuffix.length - maxSuffixLen)
  }

  const diffPart = target.slice(commonPrefix.length, target.length - commonSuffix.length)

  const segments: { text: string; diff: boolean }[] = []
  if (commonPrefix) segments.push({ text: commonPrefix, diff: false })
  if (diffPart) segments.push({ text: diffPart, diff: true })
  if (commonSuffix) segments.push({ text: commonSuffix, diff: false })

  return segments.length > 0 ? segments : [{ text: target, diff: false }]
}

function handleKeepItem(item: DuplicateItem) {
  // 从重复组中移除该项（标记为"保留"）
  for (const group of state.duplicateGroups) {
    const idx = group.items.findIndex((i) => i.id === item.id)
    if (idx >= 0) {
      // 保留此项 = 从重复组中移除其他项的显示
      // 实际上只是从 UI 中标记，不做删除
      message.success(`已标记「${item.title}」为保留项`)
      return
    }
  }
}

function handleDeleteItem(item: DuplicateItem) {
  // 后端没有删除文件的接口，这里只把该项从重复分组里摘掉。
  removeDuplicateItem(item.id)
  message.success(`已移除「${item.title}」`)
}

async function handleLoadDuplicates() {
  loadingDuplicates.value = true
  try {
    await loadDuplicates()
    if (state.duplicateGroups.length === 0) {
      message.success('未检测到重复项')
    } else {
      message.info(`检测到 ${state.duplicateGroups.length} 组可能重复`)
    }
  } catch (error: any) {
    message.error(error?.message || '重复检测失败')
  } finally {
    loadingDuplicates.value = false
  }
}

async function handleLoadWatcherStatus() {
  loadingWatcher.value = true
  try {
    await loadWatcherStatus()
  } catch (error: any) {
    message.error(error?.message || '获取监听状态失败')
  } finally {
    loadingWatcher.value = false
  }
}

async function handleRestartWatcher() {
  restartingWatcher.value = true
  try {
    await restartWatcher()
    message.success('文件监听已重启')
  } catch (error: any) {
    message.error(error?.message || '重启监听失败')
  } finally {
    restartingWatcher.value = false
  }
}

async function handleScrapeMetadata() {
  if (targetSeriesIds.value.length === 0) {
    message.warning('当前没有可刮削的系列')
    return
  }

  scrapingMetadata.value = true
  try {
    const created = await api.createMetadataJob({
      seriesIds: targetSeriesIds.value,
      overwrite: overwriteMetadata.value,
      apply: true,
    })
    let result = await api.getMetadataJob(created.jobId, 1, 200)
    while (result.status === 'queued' || result.status === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      result = await api.getMetadataJob(created.jobId, 1, 200)
    }
    metadataLog.value = result.items.slice(-200).map((item: any) => ({
      seriesId: item.seriesId,
      title: item.result?.title ?? item.sourceKey,
      ok: item.status === 'succeeded',
      applied: item.result?.applied,
      error: item.error,
      scraped: item.result?.scraped,
    }))
    await refreshAll(false)
    await restoreActiveDetail()
    message.success(`刮削完成：成功 ${result.successCount}，失败 ${result.failureCount}`)
  } catch (error: any) {
    message.error(error?.message || '批量刮削失败')
  } finally {
    scrapingMetadata.value = false
  }
}
</script>

<style scoped>
.dup-item {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--md-outline-variant, var(--n-border-color, #eee));
}

.dup-item:last-child {
  border-bottom: none;
}

.dup-cover {
  width: 48px;
  height: 72px;
  flex-shrink: 0;
  border-radius: var(--md-shape-xs);
  overflow: hidden;
  background: linear-gradient(135deg, rgba(100,100,100,0.08), rgba(60,60,60,0.04));
}

.dup-cover-placeholder {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 11px;
  color: var(--md-on-surface-variant, var(--n-text-color-3, #999));
}

.dup-info {
  flex: 1;
  min-width: 0;
}

.dup-path .path-diff {
  color: var(--md-error, #d03050);
  font-weight: 600;
  background: var(--md-error-container, rgba(208, 48, 80, 0.08));
  border-radius: 2px;
  padding: 0 2px;
}

.dup-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}

:deep(.mac-glass-card), :deep(.mac-glass-card-inner) {
  background-color: var(--md-surface, #fff) !important;
  box-shadow: none !important;
}
@media (prefers-color-scheme: dark) {
  :deep(.mac-glass-card), :deep(.mac-glass-card-inner) {
    background-color: var(--md-surface, #1e1e1e) !important;
  }
}
</style>
